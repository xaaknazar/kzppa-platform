import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import mammoth from "mammoth";
import { sha256Hex } from "@/domain/hash";
import { qrPngBytes } from "./qr";

/**
 * DOC-03, DOC-04, DOC-05, DOC-12. Финальный PDF заключения с постоянным QR проверки.
 *
 *  - Источник — утверждённая редакция (PDF или DOCX). Для PDF страницы источника не
 *    перевёрстываются: QR дописывается поверх (под последней строкой) либо на одну новую страницу.
 *  - DOC-04: в конце заключения только QR — без заголовка «Сведения о заключении и электронной
 *    подписи» и без какого-либо текста между текстом заключения и кодом. QR не уменьшается
 *    ниже проверенной читаемости (28 мм).
 *  - DOC-03: проверки — нет пустых страниц, весь текст источника присутствует в PDF
 *    в исходном порядке, текст не выходит за поля. Результат возвращается в textCheck.
 *  - Детерминизм: одинаковый вход → одинаковые байты (нет текущего времени и случайных
 *    значений; даты метаданных — только из явно переданного значения).
 *
 * Модуль также экспортирует простой типографский движок (Typesetter), которым пользуется
 * протокол голосования (FLOW-07).
 */

/* ───────────────────────── Константы ───────────────────────── */

export const MM = 72 / 25.4;
export const A4: [number, number] = [595.28, 841.89];
export const PRODUCER = "КЗППА РКА платформа";

/** DOC-04: минимальный проверенный размер QR при печати. */
export const QR_MIN_MM = 28;
/** Предпочтительный размер QR. Между предпочтительным и минимальным допускается небольшое уменьшение. */
export const QR_PREFERRED_MM = 30;
/** Нижнее поле, которое QR не нарушает. */
export const QR_BOTTOM_MARGIN_MM = 20;
/** Отступ от последней строки текста до QR (без какого-либо текста между ними). */
export const QR_GAP_MM = 5;

/**
 * Поля вёрстки DOCX → PDF: «25/15/20/20 мм» трактуются как левое/правое/верхнее/нижнее
 * (левое шире — под подшивку, как принято в делопроизводстве РК).
 */
export const DOCX_MARGINS_MM = { left: 25, right: 15, top: 20, bottom: 20 } as const;

const GENERATOR_TOOL = "kzppa-docs/conclusion-pdf";
const GENERATOR_VERSION = "1.0.0 (pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, mammoth 1.13.0, pdfjs-dist 4.10.38, qrcode 1.5.4)";

/* ───────────────────────── Шрифты ───────────────────────── */

export interface FontBytes {
  regular: Uint8Array;
  bold: Uint8Array;
  sans: Uint8Array;
}

let fontBytesP: Promise<FontBytes> | null = null;

/**
 * Шрифты лежат в репозитории (src/server/docs/fonts). На Vercel их нужно включить в трассировку
 * функции: next.config → outputFileTracingIncludes.
 */
export function loadFontBytes(): Promise<FontBytes> {
  fontBytesP ??= (async () => {
    const dir = path.join(process.cwd(), "src/server/docs/fonts");
    const [regular, bold, sans] = await Promise.all(
      ["PT_Serif-Web-Regular.ttf", "PT_Serif-Web-Bold.ttf", "GolosText.ttf"].map((f) => fs.readFile(path.join(dir, f))),
    );
    return { regular: new Uint8Array(regular), bold: new Uint8Array(bold), sans: new Uint8Array(sans) };
  })().catch((e) => {
    fontBytesP = null;
    throw new Error(`Не удалось загрузить шрифты документов: ${(e as Error).message}`);
  });
  return fontBytesP;
}

/* ───────────────────────── Типографский движок ───────────────────────── */

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  sup?: boolean;
  /** Служебный шрифт без засечек (хеши, номера). */
  sans?: boolean;
}

export interface Run extends RunStyle {
  /** "\n" — разрыв строки, "\f" — разрыв страницы, "\t" — табуляция. */
  text: string;
}

export type Align = "left" | "center" | "right" | "justify";

export interface ParaOptions {
  align?: Align;
  firstLine?: number; // pt, может быть отрицательным (висячий отступ)
  indentLeft?: number; // pt
  indentRight?: number; // pt
  spaceBefore?: number; // pt
  spaceAfter?: number; // pt
  keepWithNext?: boolean;
  size?: number;
  bold?: boolean;
}

export interface TableCell {
  paras: { runs: Run[]; opts?: ParaOptions }[];
  span?: number;
  shade?: boolean;
}

export interface TableOptions {
  /** Относительные ширины колонок. */
  colWidths?: number[];
  /** Сколько первых строк повторять на новой странице. */
  headerRows?: number;
  size?: number;
  padding?: number;
}

interface Piece {
  text: string;
  font: PDFFont;
  size: number;
  italic: boolean;
  underline: boolean;
  rise: number;
  width: number;
}

interface Word {
  pieces: Piece[];
  width: number;
  spaceAfter: number;
}

type Tok = { k: "word"; w: Word } | { k: "br" } | { k: "page" } | { k: "tab" };

type LineItem = { k: "word"; w: Word; gap: number } | { k: "tab"; width: number };

interface Line {
  items: LineItem[];
  width: number;
  gaps: number;
  hasTab: boolean;
  forced: boolean;
  pageBreakAfter: boolean;
  size: number;
  indent: number;
  avail: number;
  last: boolean;
}

const BLACK = rgb(0, 0, 0);
const TAB_STOP = 12.5 * MM;
const ITALIC_SKEW = degrees(11); // синтетический наклон: курсивного начертания PT Serif в комплекте нет

export interface TypesetterOptions {
  lang: "ru" | "kk";
  title: string;
  margins: Margins;
  baseSize?: number;
  lineHeight?: number;
  pageSize?: [number, number];
  fixedDate?: Date | null;
}

export class Typesetter {
  readonly doc: PDFDocument;
  readonly pages: PDFPage[] = [];
  readonly issues: string[] = [];
  /** Страницы, на которых нарисованы изображения (для проверки пустых страниц). */
  readonly pagesWithImages = new Set<number>();
  page!: PDFPage;
  y = 0;
  readonly margins: Margins;
  readonly baseSize: number;
  readonly lineFactor: number;
  readonly pageSize: [number, number];
  private fonts!: { regular: PDFFont; bold: PDFFont; sans: PDFFont };
  private charsets = new Map<PDFFont, Set<number>>();
  private missing = new Set<string>();

  private constructor(doc: PDFDocument, o: TypesetterOptions) {
    this.doc = doc;
    this.margins = o.margins;
    this.baseSize = o.baseSize ?? 12;
    this.lineFactor = o.lineHeight ?? 1.15;
    this.pageSize = o.pageSize ?? A4;
  }

  static async create(o: TypesetterOptions): Promise<Typesetter> {
    // updateMetadata:false — pdf-lib не подставляет текущее время (детерминизм).
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const fb = await loadFontBytes();
    const opts = { subset: true, features: { liga: false } };
    const ts = new Typesetter(doc, o);
    ts.fonts = {
      regular: await doc.embedFont(fb.regular, opts),
      bold: await doc.embedFont(fb.bold, opts),
      sans: await doc.embedFont(fb.sans, opts),
    };
    setMetadata(doc, { title: o.title, lang: o.lang, fixedDate: o.fixedDate ?? null });
    ts.newPage();
    return ts;
  }

  get pageWidth() {
    return this.pageSize[0];
  }
  get pageHeight() {
    return this.pageSize[1];
  }
  get colWidth() {
    return this.pageWidth - this.margins.left - this.margins.right;
  }
  get bodyHeight() {
    return this.pageHeight - this.margins.top - this.margins.bottom;
  }
  get atTop() {
    return Math.abs(this.y - (this.pageHeight - this.margins.top)) < 0.01;
  }
  get pageIndex() {
    return this.pages.length - 1;
  }

  newPage() {
    this.page = this.doc.addPage(this.pageSize);
    this.pages.push(this.page);
    this.y = this.pageHeight - this.margins.top;
  }

  lineHeight(size = this.baseSize) {
    return size * this.lineFactor;
  }

  space(h: number) {
    if (this.atTop) return;
    if (this.y - h < this.margins.bottom) this.newPage();
    else this.y -= h;
  }

  /** Пустой абзац: строка вертикального пространства (не в начале страницы). */
  blank(size = this.baseSize) {
    this.space(this.lineHeight(size));
  }

  /* ── шрифты и измерения ── */

  private has(font: PDFFont, cp: number) {
    let set = this.charsets.get(font);
    if (!set) {
      set = new Set(font.getCharacterSet());
      this.charsets.set(font, set);
    }
    return set.has(cp);
  }

  private fontFor(style: RunStyle): PDFFont {
    if (style.sans) return this.fonts.sans;
    return style.bold ? this.fonts.bold : this.fonts.regular;
  }

  measure(text: string, style: RunStyle = {}) {
    const size = style.size ?? this.baseSize;
    return this.piecesFor(text, style, size).reduce((s, p) => s + p.width, 0);
  }

  /** Разбить текст на куски по шрифту: основной, при отсутствии глифа — Golos Text. */
  private piecesFor(text: string, style: RunStyle, baseSize: number): Piece[] {
    const primary = this.fontFor(style);
    const size = style.sup ? baseSize * 0.65 : baseSize;
    const rise = style.sup ? baseSize * 0.33 : 0;
    const out: Piece[] = [];
    let curFont: PDFFont | null = null;
    let buf = "";
    const flush = () => {
      if (!buf || !curFont) return;
      out.push({ text: buf, font: curFont, size, italic: !!style.italic, underline: !!style.underline, rise, width: curFont.widthOfTextAtSize(buf, size) });
      buf = "";
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let f = primary;
      if (!this.has(primary, cp)) {
        if (this.has(this.fonts.sans, cp)) f = this.fonts.sans;
        else if (!this.missing.has(ch)) {
          this.missing.add(ch);
          this.issues.push(`Символ «${ch}» (U+${cp.toString(16).toUpperCase().padStart(4, "0")}) отсутствует в шрифтах документа`);
        }
      }
      if (f !== curFont) {
        flush();
        curFont = f;
      }
      buf += ch;
    }
    flush();
    return out;
  }

  /* ── разбиение на строки ── */

  private tokenize(runs: Run[], o: ParaOptions): Tok[] {
    const toks: Tok[] = [];
    let cur: Piece[] = [];
    const pushWord = (spaceAfter: number) => {
      if (!cur.length) return;
      toks.push({ k: "word", w: { pieces: cur, width: cur.reduce((s, p) => s + p.width, 0), spaceAfter } });
      cur = [];
    };
    for (const r of runs) {
      const style: RunStyle = { ...r, bold: r.bold ?? o.bold };
      const size = r.size ?? o.size ?? this.baseSize;
      const text = cleanText(r.text);
      const re = /\n|\f|\t|[ ]+|[^\n\f\t ]+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const t = m[0];
        if (t === "\n") {
          pushWord(0);
          toks.push({ k: "br" });
        } else if (t === "\f") {
          pushWord(0);
          toks.push({ k: "page" });
        } else if (t === "\t") {
          pushWord(0);
          toks.push({ k: "tab" });
        } else if (t[0] === " ") {
          pushWord(this.fontFor(style).widthOfTextAtSize(" ", size));
        } else {
          cur.push(...this.piecesFor(t, style, size));
        }
      }
    }
    pushWord(0);
    return toks;
  }

  private splitWord(w: Word, avail: number): Word[] {
    const parts: Word[] = [];
    let pieces: Piece[] = [];
    let width = 0;
    const flush = () => {
      if (pieces.length) parts.push({ pieces, width, spaceAfter: 0 });
      pieces = [];
      width = 0;
    };
    for (const p of w.pieces) {
      let buf = "";
      for (const ch of p.text) {
        const cw = p.font.widthOfTextAtSize(ch, p.size);
        if (width + cw > avail && (width > 0 || buf)) {
          if (buf) pieces.push({ ...p, text: buf, width: p.font.widthOfTextAtSize(buf, p.size) });
          buf = "";
          flush();
        }
        buf += ch;
        width += cw;
      }
      if (buf) pieces.push({ ...p, text: buf, width: p.font.widthOfTextAtSize(buf, p.size) });
    }
    flush();
    if (parts.length) parts[parts.length - 1].spaceAfter = w.spaceAfter;
    return parts;
  }

  layout(runs: Run[], width: number, o: ParaOptions = {}): Line[] {
    const L = o.indentLeft ?? 0;
    const R = o.indentRight ?? 0;
    const F = o.firstLine ?? 0;
    const baseSize = o.size ?? this.baseSize;
    const lines: Line[] = [];
    const mk = (first: boolean): Line => {
      const indent = first ? L + F : L;
      return { items: [], width: 0, gaps: 0, hasTab: false, forced: false, pageBreakAfter: false, size: baseSize, indent, avail: Math.max(20, width - indent - R), last: false };
    };
    let line = mk(true);
    let pendingGap = 0;
    const push = () => {
      lines.push(line);
      line = mk(false);
      pendingGap = 0;
    };
    const addWord = (w: Word) => {
      const gap = line.items.length ? pendingGap : 0;
      if (line.items.length && line.width + gap + w.width > line.avail + 0.01) {
        push();
        return addWord(w);
      }
      line.items.push({ k: "word", w, gap });
      line.width += gap + w.width;
      if (gap > 0) line.gaps++;
      for (const p of w.pieces) line.size = Math.max(line.size, p.rise ? p.size / 0.65 : p.size);
      pendingGap = w.spaceAfter;
    };
    for (const t of this.tokenize(runs, o)) {
      if (t.k === "word") {
        if (t.w.width > line.avail && !line.items.length) {
          const parts = this.splitWord(t.w, line.avail);
          parts.forEach((p, i) => {
            addWord(p);
            if (i < parts.length - 1) push();
          });
        } else if (t.w.width > mk(false).avail) {
          push();
          const parts = this.splitWord(t.w, line.avail);
          parts.forEach((p, i) => {
            addWord(p);
            if (i < parts.length - 1) push();
          });
        } else addWord(t.w);
      } else if (t.k === "tab") {
        let tw = Math.ceil((line.width + 0.5) / TAB_STOP) * TAB_STOP - line.width;
        if (line.width + tw > line.avail) {
          push();
          tw = TAB_STOP;
        }
        line.items.push({ k: "tab", width: tw });
        line.width += tw;
        line.hasTab = true;
        pendingGap = 0;
      } else if (t.k === "br") {
        line.forced = true;
        push();
      } else {
        line.forced = true;
        line.pageBreakAfter = true;
        push();
      }
    }
    if (line.items.length || !lines.length || lines[lines.length - 1].forced) lines.push(line);
    lines[lines.length - 1].last = true;
    return lines;
  }

  /** Нарисовать строку; yTop — верх строки. */
  drawLine(page: PDFPage, line: Line, xLeft: number, yTop: number, align: Align) {
    let x = xLeft + line.indent;
    let extra = 0;
    const free = line.avail - line.width;
    if (align === "center") x += free / 2;
    else if (align === "right") x += free;
    else if (align === "justify" && !line.last && !line.forced && !line.hasTab && line.gaps > 0 && free > 0) extra = free / line.gaps;
    const h = this.lineHeight(line.size);
    const baseline = yTop - (h - line.size) / 2 - line.size * 0.8;
    for (const it of line.items) {
      if (it.k === "tab") {
        x += it.width;
        continue;
      }
      if (it.gap > 0) x += it.gap + extra;
      for (const p of it.w.pieces) {
        page.drawText(p.text, { x, y: baseline + p.rise, size: p.size, font: p.font, color: BLACK, ...(p.italic ? { ySkew: ITALIC_SKEW } : {}) });
        if (p.underline) page.drawLine({ start: { x, y: baseline - 1.6 }, end: { x: x + p.width, y: baseline - 1.6 }, thickness: 0.6, color: BLACK });
        x += p.width;
      }
    }
  }

  linesHeight(lines: Line[]) {
    return lines.reduce((s, l) => s + this.lineHeight(l.size), 0);
  }

  paragraph(runs: Run[], o: ParaOptions = {}) {
    const lines = this.layout(runs, this.colWidth, o);
    if (o.spaceBefore) this.space(o.spaceBefore);
    if (o.keepWithNext) {
      // Заголовок не остаётся последней строкой страницы: нужно место ещё на 2 строки текста.
      const need = this.linesHeight(lines) + 2 * this.lineHeight();
      if (this.y - need < this.margins.bottom && !this.atTop) this.newPage();
    }
    for (const line of lines) {
      const h = this.lineHeight(line.size);
      if (this.y - h < this.margins.bottom) this.newPage();
      this.drawLine(this.page, line, this.margins.left, this.y, o.align ?? "left");
      this.y -= h;
      if (line.pageBreakAfter) this.newPage();
    }
    if (o.spaceAfter) this.space(o.spaceAfter);
  }

  hrule(width = this.colWidth, thickness = 0.5) {
    this.space(4);
    this.page.drawLine({ start: { x: this.margins.left, y: this.y }, end: { x: this.margins.left + width, y: this.y }, thickness, color: BLACK });
    this.space(6);
  }

  async image(bytes: Uint8Array, kind: "png" | "jpg", align: Align = "left") {
    let img: PDFImage;
    try {
      img = kind === "png" ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    } catch (e) {
      this.issues.push(`Изображение не перенесено: ${(e as Error).message}`);
      return;
    }
    // 96 dpi → pt; не шире колонки и не выше половины страницы.
    let w = img.width * 0.75;
    let h = img.height * 0.75;
    const k = Math.min(1, this.colWidth / w, (this.bodyHeight / 2) / h);
    w *= k;
    h *= k;
    if (this.y - h < this.margins.bottom) this.newPage();
    const x = align === "center" ? this.margins.left + (this.colWidth - w) / 2 : align === "right" ? this.margins.left + this.colWidth - w : this.margins.left;
    this.page.drawImage(img, { x, y: this.y - h, width: w, height: h });
    this.pagesWithImages.add(this.pageIndex);
    this.y -= h + 4;
  }

  /** Таблица с рамками. Строки, не помещающиеся на страницу, переносятся целиком. */
  table(rows: TableCell[][], o: TableOptions = {}) {
    if (!rows.length) return;
    const pad = o.padding ?? 3;
    const size = o.size ?? this.baseSize;
    const ncols = Math.max(1, ...rows.map((r) => r.reduce((s, c) => s + (c.span ?? 1), 0)));
    const rel = o.colWidths && o.colWidths.length === ncols ? o.colWidths : Array.from({ length: ncols }, () => 1);
    const sum = rel.reduce((a, b) => a + b, 0);
    const widths = rel.map((r) => (r / sum) * this.colWidth);
    const headerRows = Math.min(o.headerRows ?? 0, rows.length);

    type Laid = { x: number; w: number; cell: TableCell; paras: { lines: Line[]; opts: ParaOptions }[]; h: number };
    const layRow = (row: TableCell[]) => {
      let col = 0;
      const cells: Laid[] = [];
      for (const cell of row) {
        const span = Math.min(cell.span ?? 1, ncols - col);
        const x = this.margins.left + widths.slice(0, col).reduce((a, b) => a + b, 0);
        const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        col += span;
        const paras = cell.paras.map((p) => {
          const opts: ParaOptions = { size, ...p.opts };
          return { lines: this.layout(p.runs, w - 2 * pad, opts), opts };
        });
        const h = paras.reduce((s, p, i) => s + this.linesHeight(p.lines) + (i < paras.length - 1 ? (p.opts.spaceAfter ?? 2) : 0), 0) + 2 * pad;
        cells.push({ x, w, cell, paras, h });
      }
      // Недостающие ячейки — пустые, чтобы рамка была замкнута.
      if (col < ncols) {
        const x = this.margins.left + widths.slice(0, col).reduce((a, b) => a + b, 0);
        cells.push({ x, w: widths.slice(col).reduce((a, b) => a + b, 0), cell: { paras: [] }, paras: [], h: 2 * pad });
      }
      return { cells, h: Math.max(...cells.map((c) => c.h)) };
    };
    const drawRow = (laid: ReturnType<typeof layRow>) => {
      const top = this.y;
      for (const c of laid.cells) {
        if (c.cell.shade) this.page.drawRectangle({ x: c.x, y: top - laid.h, width: c.w, height: laid.h, color: rgb(0.93, 0.93, 0.93) });
        this.page.drawRectangle({ x: c.x, y: top - laid.h, width: c.w, height: laid.h, borderColor: BLACK, borderWidth: 0.5 });
        let y = top - pad;
        c.paras.forEach((p, i) => {
          for (const line of p.lines) {
            this.drawLine(this.page, line, c.x + pad, y, p.opts.align ?? "left");
            y -= this.lineHeight(line.size);
          }
          if (i < c.paras.length - 1) y -= p.opts.spaceAfter ?? 2;
        });
      }
      this.y -= laid.h;
    };
    const header = rows.slice(0, headerRows).map(layRow);
    const headerH = header.reduce((s, r) => s + r.h, 0);
    rows.forEach((row, i) => {
      const laid = i < headerRows ? header[i] : layRow(row);
      if (laid.h > this.bodyHeight - headerH) {
        // Строка выше страницы — выводим содержимое ячеек абзацами (текст не теряется).
        for (const c of row) for (const p of c.paras) this.paragraph(p.runs, { size, ...p.opts });
        return;
      }
      if (this.y - laid.h < this.margins.bottom) {
        this.newPage();
        if (i >= headerRows) header.forEach(drawRow);
      }
      drawRow(laid);
    });
  }

  /**
   * DOC-04: QR после последней строки. Если на текущей странице хватает места при нижнем поле
   * 20 мм и размере не меньше 28 мм — QR ставится здесь, выровненный по левому краю колонки.
   * Иначе добавляется одна новая страница, на которой есть только QR у верхнего поля.
   */
  async placeQrAtEnd(png: Uint8Array): Promise<"same_page" | "new_page"> {
    const img = await this.doc.embedPng(png);
    const pref = QR_PREFERRED_MM * MM;
    const min = QR_MIN_MM * MM;
    const gap = QR_GAP_MM * MM;
    const bottom = Math.max(this.margins.bottom, QR_BOTTOM_MARGIN_MM * MM);
    const avail = this.atTop ? this.y - bottom : this.y - gap - bottom;
    const size = avail >= pref ? pref : avail >= min ? avail : 0;
    if (size > 0) {
      const top = this.atTop ? this.y : this.y - gap;
      this.page.drawImage(img, { x: this.margins.left, y: top - size, width: size, height: size });
      this.y = top - size;
      return this.atTop ? "new_page" : "same_page";
    }
    this.newPage();
    this.page.drawImage(img, { x: this.margins.left, y: this.y - pref, width: pref, height: pref });
    this.y -= pref;
    return "new_page";
  }

  /** Номера страниц внизу по центру, мелко. */
  numberPages(size = 9) {
    if (this.pages.length < 2) return;
    this.pages.forEach((p, i) => {
      const t = String(i + 1);
      const w = this.fonts.regular.widthOfTextAtSize(t, size);
      p.drawText(t, { x: (this.pageWidth - w) / 2, y: Math.min(10 * MM, this.margins.bottom / 2), size, font: this.fonts.regular, color: BLACK });
    });
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save({ useObjectStreams: true });
  }
}

function setMetadata(doc: PDFDocument, m: { title: string; lang: "ru" | "kk"; fixedDate: Date | null }) {
  doc.setTitle(m.title);
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setLanguage(m.lang === "kk" ? "kk-KZ" : "ru-RU");
  if (m.fixedDate && !Number.isNaN(m.fixedDate.getTime())) {
    doc.setCreationDate(m.fixedDate);
    doc.setModificationDate(m.fixedDate);
  }
}

/** Удаляет мягкие переносы и невидимые символы; CR → LF. */
function cleanText(s: string) {
  return s.replace(/\r\n?/g, "\n").replace(/[­​-‍⁠﻿]/g, "").replace(/[\u0000-\u0008\u000B\u000E-\u001F]/g, "");
}

/** Нормализация для сверки текста: NFC, без пробельных и невидимых символов. */
export function normForCheck(s: string) {
  return cleanText(s).normalize("NFC").replace(/[\s  -   　]+/g, "");
}

/* ───────────────────────── pdf.js (анализ и извлечение текста) ───────────────────────── */

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsP: Promise<PdfjsModule> | null = null;

/** pdf.js в Node: «фейковый» воркер в том же потоке (без отдельного файла воркера). */
async function pdfjs(): Promise<PdfjsModule> {
  pdfjsP ??= (async () => {
    const g = globalThis as { pdfjsWorker?: unknown };
    if (!g.pdfjsWorker) {
      // @ts-expect-error -- у pdf.worker.mjs нет деклараций типов
      g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    }
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })().catch((e) => {
    pdfjsP = null;
    throw e;
  });
  return pdfjsP;
}

interface TextBox {
  str: string;
  x: number;
  y: number; // базовая линия
  w: number;
  h: number; // высота шрифта
}

interface PageInfo {
  view: [number, number, number, number];
  rotate: number;
  texts: TextBox[];
  /** Прямоугольники нарисованной графики и изображений [x0,y0,x1,y1] в координатах страницы. */
  paints: [number, number, number, number][];
}

type Mat = [number, number, number, number, number, number];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function boxOf(m: Mat, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

async function analyzePdf(bytes: Uint8Array, opts: { paints: boolean }): Promise<PageInfo[]> {
  const lib = await pdfjs();
  const OPS = lib.OPS;
  // Копия: pdf.js передаёт буфер «воркеру» и делает исходный массив непригодным.
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  try {
    const out: PageInfo[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent({ disableNormalization: true });
      const texts: TextBox[] = [];
      for (const it of tc.items) {
        if (!("str" in it)) continue;
        const t = it.transform as number[];
        texts.push({ str: it.str, x: t[4], y: t[5], w: it.width, h: Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || it.height });
      }
      const paints: [number, number, number, number][] = [];
      if (opts.paints) {
        const ol = await page.getOperatorList();
        const [vx0, vy0, vx1, vy1] = page.view;
        const pageArea = (vx1 - vx0) * (vy1 - vy0);
        const paintAfterPath = new Set<number>([OPS.fill, OPS.eoFill, OPS.stroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
        const imageOps = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup]);
        let ctm: Mat = [1, 0, 0, 1, 0, 0];
        const stack: Mat[] = [];
        for (let k = 0; k < ol.fnArray.length; k++) {
          const fn = ol.fnArray[k];
          const args = ol.argsArray[k] as unknown[] | null;
          if (fn === OPS.save) stack.push(ctm);
          else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
          else if (fn === OPS.transform && args) ctm = mul(ctm, args as Mat);
          else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm);
            const m = args?.[0];
            if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m as Mat);
          } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
          else if (fn === OPS.constructPath && args) {
            const mm = args[2] as number[] | undefined;
            if (!mm || !paintAfterPath.has(ol.fnArray[k + 1]) || !mm.every(Number.isFinite)) continue;
            const b = boxOf(ctm, mm[0], mm[1], mm[2], mm[3]);
            // Фон на всю страницу не считается содержимым.
            if ((b[2] - b[0]) * (b[3] - b[1]) >= 0.85 * pageArea) continue;
            paints.push(b);
          } else if (imageOps.has(fn)) paints.push(boxOf(ctm, 0, 0, 1, 1));
        }
      }
      out.push({ view: page.view as [number, number, number, number], rotate: page.rotate, texts, paints });
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/* ───────────────────────── Публичный API ───────────────────────── */

export interface FinalConclusionInput {
  source: { bytes: Uint8Array; format: "pdf" | "docx"; filename: string };
  /** Адрес постоянного QR (DOC-12: уже содержит хеш манифеста). */
  qrUrl: string;
  lang: "ru" | "kk";
  /** Дата для метаданных PDF. Без неё дата в метаданные не пишется (детерминизм). */
  fixedDate?: Date | string | null;
}

export interface FinalConclusionResult {
  bytes: Uint8Array;
  pages: number;
  qrPlacement: "same_page" | "new_page";
  generator: { tool: string; version: string; sourceSha256: string; template: string };
  textCheck: { ok: boolean; issues: string[] };
}

export async function buildFinalConclusionPdf(input: FinalConclusionInput): Promise<FinalConclusionResult> {
  const sourceSha256 = await sha256Hex(input.source.bytes);
  const fixedDate = input.fixedDate ? new Date(input.fixedDate) : null;
  const png = await qrPngBytes(input.qrUrl, 600);
  const generator = { tool: GENERATOR_TOOL, version: GENERATOR_VERSION, sourceSha256, template: `conclusion-final-qr-v1:${input.lang}:${input.source.format}` };
  const title = input.source.filename.replace(/\.(pdf|docx)$/i, "");
  const r = input.source.format === "pdf" ? await fromPdf(input.source.bytes, png, { title, lang: input.lang, fixedDate }) : await fromDocx(input.source.bytes, png, { title, lang: input.lang, fixedDate });
  const issues = [...new Set(r.issues)].slice(0, 30);
  return { bytes: r.bytes, pages: r.pages, qrPlacement: r.qrPlacement, generator, textCheck: { ok: issues.length === 0, issues } };
}

interface BuildResult {
  bytes: Uint8Array;
  pages: number;
  qrPlacement: "same_page" | "new_page";
  issues: string[];
}

/* ── PDF-источник ── */

async function fromPdf(src: Uint8Array, png: Uint8Array, m: { title: string; lang: "ru" | "kk"; fixedDate: Date | null }): Promise<BuildResult> {
  const issues: string[] = [];
  let info: PageInfo[] | null = null;
  try {
    info = await analyzePdf(src, { paints: true });
  } catch (e) {
    issues.push(`Не удалось проанализировать исходный PDF: ${(e as Error).message}`);
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(src, { updateMetadata: false });
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/encrypt/i.test(msg) ? "Исходный PDF зашифрован — нужен файл без защиты" : `Исходный PDF не читается: ${msg}`);
  }
  setMetadata(doc, { title: m.title, lang: m.lang, fixedDate: m.fixedDate });
  const n = doc.getPageCount();
  if (!n) throw new Error("В исходном PDF нет страниц");

  // DOC-03: пустые страницы и текст за пределами страницы в источнике.
  if (info) {
    info.forEach((p, i) => {
      if (!p.texts.some((t) => t.str.trim()) && !p.paints.length) issues.push(`Пустая страница ${i + 1} в исходном PDF`);
      const [x0, y0, x1, y1] = p.view;
      if (p.texts.some((t) => t.str.trim() && (t.x < x0 - 1 || t.x + t.w > x1 + 1 || t.y < y0 - 1 || t.y > y1 + 1))) issues.push(`Текст выходит за границы страницы ${i + 1}`);
    });
  }

  const img = await doc.embedPng(png);
  const last = doc.getPage(n - 1);
  const crop = last.getCropBox();
  const pref = QR_PREFERRED_MM * MM;
  const min = QR_MIN_MM * MM;
  const gap = QR_GAP_MM * MM;
  const bottom = crop.y + QR_BOTTOM_MARGIN_MM * MM;
  const lp = info?.[n - 1];

  // Левый край текстовой колонки — по самому левому тексту документа (одинаково для всех случаев).
  const allTexts = (info ?? []).flatMap((p) => p.texts.filter((t) => t.str.trim()));
  const leftEdge = allTexts.length ? Math.max(crop.x + 8 * MM, Math.min(...allTexts.map((t) => t.x))) : crop.x + DOCX_MARGINS_MM.left * MM;

  let placement: "same_page" | "new_page" = "new_page";
  let size = 0;
  let top = 0;
  if (lp && lp.rotate % 360 === 0) {
    // Нижняя граница содержимого основной части страницы. Колонтитул целиком в нижнем
    // поле (например, номер страницы) не мешает: QR в нижнее поле не заходит.
    const boxes: [number, number, number, number][] = [
      ...lp.texts.filter((t) => t.str.trim()).map((t) => [t.x, t.y - 0.25 * t.h, t.x + t.w, t.y + 0.85 * t.h] as [number, number, number, number]),
      ...lp.paints,
    ].filter((b) => b[3] >= bottom);
    const lowest = boxes.length ? Math.min(...boxes.map((b) => b[1])) : null;
    if (lowest !== null) {
      const avail = lowest - gap - bottom;
      size = avail >= pref ? pref : avail >= min ? avail : 0;
      top = lowest - gap;
      if (size > 0) {
        // Не перекрывать содержимое справа/слева на уровне QR (защита от двухколоночных макетов).
        const qrBox: [number, number, number, number] = [leftEdge, top - size, leftEdge + size, top];
        const overlap = [...boxes, ...lp.paints].some((b) => b[0] < qrBox[2] && b[2] > qrBox[0] && b[1] < qrBox[3] && b[3] > qrBox[1]);
        if (overlap) size = 0;
      }
    }
  }
  if (size > 0) {
    last.drawImage(img, { x: leftEdge, y: top - size, width: size, height: size });
    placement = "same_page";
  } else {
    const { width, height } = last.getSize();
    const p = doc.addPage([width, height]);
    if (crop.x || crop.y || crop.width !== width || crop.height !== height) p.setCropBox(crop.x, crop.y, crop.width, crop.height);
    p.drawImage(img, { x: leftEdge, y: crop.y + crop.height - QR_BOTTOM_MARGIN_MM * MM - pref, width: pref, height: pref });
    placement = "new_page";
  }

  const bytes = await doc.save({ useObjectStreams: true });

  // DOC-03: текст страниц источника в итоговом PDF не изменился.
  if (info) {
    try {
      const outInfo = await analyzePdf(bytes, { paints: false });
      const expectedPages = n + (placement === "new_page" ? 1 : 0);
      if (outInfo.length !== expectedPages) issues.push(`Число страниц ${outInfo.length}, ожидалось ${expectedPages}`);
      for (let i = 0; i < n; i++) {
        const a = normForCheck(info[i].texts.map((t) => t.str).join(""));
        const b = normForCheck((outInfo[i]?.texts ?? []).map((t) => t.str).join(""));
        if (a !== b) issues.push(`Текст страницы ${i + 1} изменился при добавлении QR`);
      }
    } catch (e) {
      issues.push(`Не удалось проверить итоговый PDF: ${(e as Error).message}`);
    }
  }
  return { bytes, pages: doc.getPageCount(), qrPlacement: placement, issues };
}

/* ── DOCX-источник ── */

/** Узлы документной модели mammoth (используемые поля). */
interface MNode {
  type: string;
  children?: MNode[];
  value?: string;
  styleId?: string | null;
  styleName?: string | null;
  alignment?: string | null;
  numbering?: { level: string | number; isOrdered: boolean } | null;
  indent?: { start?: string | null; end?: string | null; firstLine?: string | null; hanging?: string | null };
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  verticalAlignment?: string;
  breakType?: string;
  noteType?: string;
  noteId?: string;
  checked?: boolean;
  colSpan?: number;
  contentType?: string;
  readAsArrayBuffer?: () => Promise<ArrayBuffer>;
  read?: () => Promise<Buffer>;
  notes?: { findNoteByKey?: (k: string) => MNode | null; _notes?: Record<string, MNode> };
  body?: MNode[];
}

const twip = (v: string | null | undefined) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(-200, Math.min(300, n / 20)) : 0;
};

const ALIGN: Record<string, Align> = { center: "center", right: "right", end: "right", both: "justify", justify: "justify", distribute: "justify", left: "left", start: "left" };

async function fromDocx(src: Uint8Array, png: Uint8Array, m: { title: string; lang: "ru" | "kk"; fixedDate: Date | null }): Promise<BuildResult> {
  let root: MNode | null = null;
  try {
    await mammoth.convertToHtml(
      { buffer: Buffer.from(src.buffer, src.byteOffset, src.byteLength) },
      {
        transformDocument: (d: MNode) => {
          root = d;
          return d;
        },
      },
    );
  } catch (e) {
    throw new Error(`Файл Word не читается: ${(e as Error).message}`);
  }
  const docNode = root as MNode | null;
  if (!docNode) throw new Error("Файл Word не содержит документа");

  const mg = DOCX_MARGINS_MM;
  const ts = await Typesetter.create({ lang: m.lang, title: m.title, margins: { top: mg.top * MM, right: mg.right * MM, bottom: mg.bottom * MM, left: mg.left * MM }, baseSize: 12, lineHeight: 1.15, fixedDate: m.fixedDate });
  const expected: string[] = [];
  const notes: MNode[] = [];
  const noteNo = new Map<string, number>();
  const counters: number[] = [];

  const ctx = {
    noteNumber(n: MNode) {
      const key = `${n.noteType}-${n.noteId}`;
      let no = noteNo.get(key);
      if (!no) {
        no = noteNo.size + 1;
        noteNo.set(key, no);
        const note = docNode.notes?.findNoteByKey?.(key) ?? docNode.notes?._notes?.[key] ?? null;
        if (note) notes.push(note);
      }
      return no;
    },
  };

  const collect = (node: MNode, style: RunStyle, runs: Run[], images: MNode[]) => {
    switch (node.type) {
      case "run": {
        const s: RunStyle = { ...style, bold: style.bold || node.isBold, italic: style.italic || node.isItalic, underline: style.underline || node.isUnderline, sup: node.verticalAlignment === "superscript" || style.sup };
        for (const c of node.children ?? []) collect(c, s, runs, images);
        return;
      }
      case "text":
        if (node.value) runs.push({ ...style, text: node.value });
        return;
      case "tab":
        runs.push({ ...style, text: "\t" });
        return;
      case "break":
        runs.push({ ...style, text: node.breakType === "page" ? "\f" : "\n" });
        return;
      case "noteReference":
        runs.push({ ...style, sup: true, text: String(ctx.noteNumber(node)) });
        return;
      case "checkbox":
        runs.push({ ...style, text: node.checked ? "[x]" : "[ ]" });
        return;
      case "image":
        images.push(node);
        return;
      case "commentReference":
      case "bookmarkStart":
        return;
      default:
        for (const c of node.children ?? []) collect(c, style, runs, images);
    }
  };

  const paraText = (runs: Run[]) => runs.map((r) => r.text.replace(/[\t\n\f]/g, " ")).join("");

  const isHeading = (p: MNode) => /^(heading|заголовок|title|название|subtitle)/i.test(p.styleName ?? "") || /^(heading|title)/i.test(p.styleId ?? "");

  const label = (n: NonNullable<MNode["numbering"]>) => {
    const lvl = Math.max(0, Math.min(8, Number(n.level) || 0));
    if (!n.isOrdered) return lvl === 0 ? "•" : "–";
    counters[lvl] = (counters[lvl] ?? 0) + 1;
    counters.length = lvl + 1;
    if (lvl === 0) return `${counters[0]}.`;
    if (lvl === 1) return `${counters[0] ?? 1}.${counters[1]}.`;
    return `${String.fromCharCode(0x0430 + ((counters[lvl] - 1) % 28))})`; // а) б) в)…
  };

  const paraModel = (p: MNode, base: { size?: number } = {}) => {
    const runs: Run[] = [];
    const images: MNode[] = [];
    for (const c of p.children ?? []) collect(c, {}, runs, images);
    const heading = isHeading(p);
    const opts: ParaOptions = {
      align: ALIGN[p.alignment ?? ""] ?? "left",
      indentLeft: twip(p.indent?.start),
      indentRight: twip(p.indent?.end),
      firstLine: p.indent?.hanging ? -twip(p.indent.hanging) : twip(p.indent?.firstLine),
      spaceAfter: heading ? 6 : 4,
      spaceBefore: heading ? 6 : 0,
      keepWithNext: heading,
      bold: heading || undefined,
      size: base.size ?? (heading ? (/title|название/i.test(p.styleName ?? p.styleId ?? "") ? 14 : 13) : undefined),
    };
    const text = paraText(runs);
    if (p.numbering && text.trim()) runs.unshift({ text: `${label(p.numbering)} `, bold: opts.bold });
    return { runs, images, opts, text };
  };

  /** Есть ли в блоке текст или изображение (без побочных эффектов: сноски и счётчики списков не трогаются). */
  const hasContent = (b: MNode): boolean => {
    if (b.type === "table") return true;
    if (b.type !== "paragraph") return false;
    let found = false;
    const walk = (n: MNode) => {
      if (found) return;
      if ((n.type === "text" && n.value?.trim()) || n.type === "image" || n.type === "noteReference" || n.type === "checkbox") found = true;
      else for (const c of n.children ?? []) walk(c);
    };
    walk(b);
    return found;
  };

  const renderImages = async (images: MNode[], align: Align) => {
    for (const im of images) {
      const ct = (im.contentType ?? "").toLowerCase();
      const kind = ct.includes("png") ? "png" : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : null;
      if (!kind) {
        ts.issues.push(`Изображение формата ${ct || "неизвестного"} не перенесено в PDF`);
        continue;
      }
      try {
        const ab = im.readAsArrayBuffer ? await im.readAsArrayBuffer() : im.read ? await im.read() : null;
        if (!ab) continue;
        await ts.image(ab instanceof ArrayBuffer ? new Uint8Array(ab) : new Uint8Array(ab.buffer, ab.byteOffset, ab.byteLength), kind, align);
      } catch (e) {
        ts.issues.push(`Изображение не прочитано: ${(e as Error).message}`);
      }
    }
  };

  const renderParagraph = async (p: MNode) => {
    const pm = paraModel(p);
    if (pm.text.trim()) {
      expected.push(pm.text);
      ts.paragraph(pm.runs, pm.opts);
    } else if (!pm.images.length) {
      if (pm.runs.some((r) => r.text.includes("\f"))) ts.newPage();
      else ts.blank();
    }
    if (pm.images.length) await renderImages(pm.images, pm.opts.align ?? "left");
  };

  const cellParas = (blocks: MNode[], out: TableCell["paras"]) => {
    for (const b of blocks) {
      if (b.type === "paragraph") {
        const pm = paraModel(b, { size: 11 });
        if (!pm.text.trim()) continue;
        expected.push(pm.text);
        out.push({ runs: pm.runs.map((r) => ({ ...r, text: r.text.replace(/\f/g, "\n") })), opts: { ...pm.opts, keepWithNext: false, spaceBefore: 0, spaceAfter: 2, size: 11 } });
        if (pm.images.length) ts.issues.push("Изображение внутри таблицы не перенесено в PDF");
      } else if (b.type === "table") {
        // Вложенная таблица — содержимое как абзацы ячейки.
        for (const row of b.children ?? []) for (const cell of row.children ?? []) cellParas(cell.children ?? [], out);
      }
    }
  };

  const renderTable = (t: MNode) => {
    const rows: TableCell[][] = [];
    for (const row of t.children ?? []) {
      if (row.type !== "tableRow") continue;
      const cells: TableCell[] = [];
      for (const cell of row.children ?? []) {
        if (cell.type !== "tableCell") continue;
        const paras: TableCell["paras"] = [];
        cellParas(cell.children ?? [], paras);
        cells.push({ paras, span: cell.colSpan ?? 1 });
      }
      rows.push(cells);
    }
    ts.table(rows, { size: 11 });
    ts.space(6);
  };

  // Хвостовые пустые абзацы не переносятся: QR — сразу после последней строки (DOC-04).
  const blocks = docNode.children ?? [];
  let lastIdx = blocks.length - 1;
  while (lastIdx >= 0 && !hasContent(blocks[lastIdx])) lastIdx--;
  let started = false;
  for (let i = 0; i <= lastIdx; i++) {
    const b = blocks[i];
    if (!started && b.type === "paragraph" && !hasContent(b)) continue; // ведущие пустые абзацы
    started = true;
    if (b.type === "paragraph") await renderParagraph(b);
    else if (b.type === "table") renderTable(b);
  }
  if (!started) throw new Error("Файл Word не содержит текста заключения");

  // Сноски — часть текста заключения, выводятся в конце перед QR.
  if (notes.length) {
    ts.hrule(ts.colWidth / 3);
    notes.forEach((note, i) => {
      for (const b of note.body ?? []) {
        if (b.type !== "paragraph") continue;
        const pm = paraModel(b, { size: 10 });
        if (!pm.text.trim()) continue;
        expected.push(pm.text);
        ts.paragraph([{ text: `${i + 1} `, sup: true, size: 10 }, ...pm.runs.map((r) => ({ ...r, size: 10 }))], { size: 10, spaceAfter: 2 });
      }
    });
  }

  const placement = await ts.placeQrAtEnd(png);
  const qrPage = placement === "new_page" ? ts.pages.length - 1 : -1; // страница, где только QR
  ts.numberPages(9);
  const bytes = await ts.save();

  const issues = [...ts.issues];
  try {
    const out = await analyzePdf(bytes, { paints: false });
    const mgPt = { left: mg.left * MM, right: mg.right * MM, top: mg.top * MM, bottom: mg.bottom * MM };
    const footerY = mgPt.bottom - 2;
    let stream = "";
    out.forEach((p, i) => {
      const [, , x1, y1] = p.view;
      const body = p.texts.filter((t) => t.str.trim() && t.y >= footerY);
      if (!body.length && i !== qrPage && !ts.pagesWithImages.has(i)) issues.push(`Пустая страница ${i + 1}`);
      if (body.some((t) => t.x < mgPt.left - 1 || t.x + t.w > x1 - mgPt.right + 1 || t.y > y1 - mgPt.top + 1)) issues.push(`Текст выходит за поля на странице ${i + 1}`);
      stream += normForCheck(body.map((t) => t.str).join(""));
    });
    let cursor = 0;
    for (const e of expected) {
      const n = normForCheck(e);
      if (!n) continue;
      const at = stream.indexOf(n, cursor);
      if (at < 0) {
        const short = e.trim().slice(0, 60);
        issues.push(`Текст абзаца не найден в PDF в исходном порядке: «${short}${e.trim().length > 60 ? "…" : ""}»`);
      } else cursor = at + n.length;
    }
  } catch (e) {
    issues.push(`Не удалось проверить итоговый PDF: ${(e as Error).message}`);
  }
  return { bytes, pages: ts.pages.length, qrPlacement: placement, issues };
}
