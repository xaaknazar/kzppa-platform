import "server-only";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  convertMillimetersToTwip,
} from "docx";
import { coverLetter, type CoverLetterData } from "@/domain/templates";
import type { Lang } from "@/domain/types";

/**
 * DOC-07, DOC-08, DOC-10. Сопроводительное письмо в РКА — Word DOCX на языке исходного
 * обращения. Язык берётся строго из параметра `lang` (никакого автоопределения по тексту).
 * Содержит: бланк комиссии (слева вверху), исходящий номер и дату, ссылку «На №… от …»,
 * адресата (справа вверху), текст, «Приложение:» с нумерованной описью, подпись председателя.
 * Шрифт PT Serif 12 pt (в DOCX указывается имя шрифта; при его отсутствии Word подставит замену).
 */

const FONT = "PT Serif";
const SIZE = 24; // половины пункта → 12 pt
const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE } as const;

/** Детерминизм: дата свойств файла фиксирована, чтобы одинаковые данные давали одинаковые байты. */
const FIXED_DATE = "2026-01-01T00:00:00Z";

export type CoverLetterInput = CoverLetterData & {
  /** Почтовый адрес/реквизиты комиссии строками для бланка. */
  commissionAddressLines?: string[];
};

const t = (text: string, o: { bold?: boolean; size?: number; italics?: boolean } = {}) => new TextRun({ text, bold: o.bold, italics: o.italics, size: o.size ?? SIZE, font: FONT });

function lines(text: string, o: { bold?: boolean; size?: number } = {}) {
  return text.split("\n").map((s, i) => new TextRun({ text: s, bold: o.bold, size: o.size ?? SIZE, font: FONT, break: i > 0 ? 1 : undefined }));
}

function cellPara(children: TextRun[], align: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT, after = 0) {
  return new Paragraph({ children, alignment: align, spacing: { after, line: 264 } });
}

export async function buildCoverLetterDocx(lang: Lang, data: CoverLetterInput): Promise<Uint8Array> {
  if (lang !== "ru" && lang !== "kk") throw new Error("Язык сопроводительного письма должен быть ru или kk");
  const isKk = lang === "kk";
  const c = coverLetter(lang, data);
  const languageTag = isKk ? "kk-KZ" : "ru-RU";

  // ── Шапка: бланк комиссии слева, адресат справа ──
  const leftBlock: Paragraph[] = [
    cellPara(lines(data.commissionName, { bold: true, size: 22 }), AlignmentType.LEFT, 60),
    ...(data.commissionAddressLines ?? []).map((l) => cellPara([t(l, { size: 18 })])),
    cellPara([], AlignmentType.LEFT, 120),
    // Исходящий номер и дата (DOC-08: номер — основа номера дела с дробным индексом повторов)
    cellPara([t(c.title, { size: 22 })], AlignmentType.LEFT, 40),
    // Ссылка на исходное письмо РКА
    cellPara([t(c.ref, { size: 22 })]),
  ];
  const rightBlock: Paragraph[] = [cellPara(lines(c.addressee), AlignmentType.LEFT)];

  const header = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [4700, 4650],
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({ children: leftBlock, width: { size: 50, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP }),
          new TableCell({ children: rightBlock, width: { size: 50, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP, margins: { left: convertMillimetersToTwip(12) } }),
        ],
      }),
    ],
  });

  const body = new Paragraph({
    children: [t(c.body)],
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: convertMillimetersToTwip(12.5) },
    spacing: { before: 480, after: 240, line: 276 },
  });

  const attachments: Paragraph[] = c.attachLines.length
    ? [
        new Paragraph({ children: [t(c.attachHeader)], spacing: { before: 120, after: 60 } }),
        ...c.attachLines.map((l) => new Paragraph({ children: [t(l)], indent: { left: convertMillimetersToTwip(12.5) }, spacing: { after: 0, line: 264 } })),
      ]
    : [];

  // Подпись: должность слева, ФИО председателя справа (по табуляции).
  const signature = new Paragraph({
    children: [...lines(c.sign), new TextRun({ text: "\t", font: FONT, size: SIZE }), t(c.chair)],
    tabStops: [{ type: TabStopType.RIGHT, position: 9350 }],
    spacing: { before: 720 },
  });

  const doc = new Document({
    creator: isKk ? "ҚҚҚЗК РАА платформасы" : "КЗППА РКА платформа",
    lastModifiedBy: "КЗППА РКА платформа",
    title: c.subject,
    description: isKk ? "Ілеспе хат" : "Сопроводительное письмо",
    revision: 1,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: SIZE, language: { value: languageTag } },
          paragraph: { spacing: { line: 276 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: { top: convertMillimetersToTwip(20), bottom: convertMillimetersToTwip(20), left: convertMillimetersToTwip(30), right: convertMillimetersToTwip(15) },
          },
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, font: FONT })] })],
          }),
        },
        children: [header, body, ...attachments, signature],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  return fixDocxDates(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}

/**
 * docx пишет в core.xml текущее время. Для воспроизводимости (одинаковые данные → одинаковый хеш
 * в манифесте пакета, OUT-01) перезаписываем даты фиксированным значением.
 */
async function fixDocxDates(bytes: Uint8Array): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const core = zip.file("docProps/core.xml");
  if (!core) return bytes;
  const xml = (await core.async("string"))
    .replace(/(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${FIXED_DATE}$2`)
    .replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${FIXED_DATE}$2`);
  zip.file("docProps/core.xml", xml, { date: new Date(FIXED_DATE) });
  zip.forEach((_, f) => {
    f.date = new Date(FIXED_DATE);
  });
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", platform: "UNIX" });
  return out;
}
