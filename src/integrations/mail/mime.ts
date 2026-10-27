/**
 * Чистые помощники MIME для почтового адаптера Gmail (без сети и БД — тестируются отдельно).
 *  - MAIL-05: рекурсивный разбор MIME, отдельная классификация inline-подписей/логотипов,
 *    вложенные письма (message/rfc822) учитываются как контейнер с производными элементами.
 *  - MAIL-10: разбор Authentication-Results и признаки подозрительного источника.
 *  - OUT-06: сборка исходящего RFC 5322 с заголовком X-KZPPA-Outgoing-Id.
 */

import { domainToUnicode } from "node:url";
import type { FetchedAttachmentMeta, MailAddress, OutgoingMail } from "./types";

/* ────────────────────────────── Типы ресурса Gmail API ────────────────────────────── */

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPartBody {
  attachmentId?: string;
  size?: number;
  data?: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailPartBody;
  parts?: GmailPart[];
}
export interface GmailMessageResource {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
  raw?: string;
}

/** Префикс providerAttachmentId для частей, чьё содержимое Gmail вернул прямо в body.data. */
export const INLINE_DATA_PREFIX = "part:";

/* ────────────────────────────── Кодировки ────────────────────────────── */

export function base64UrlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

export function bytesToBase64Url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

const CHARSET_ALIASES: Record<string, string> = {
  utf8: "utf-8",
  "utf-8": "utf-8",
  cp1251: "windows-1251",
  "x-cp1251": "windows-1251",
  "win-1251": "windows-1251",
  win1251: "windows-1251",
  "windows-1251": "windows-1251",
  koi8r: "koi8-r",
  "koi8-r": "koi8-r",
  "koi8-u": "koi8-u",
  "us-ascii": "utf-8", // ASCII — подмножество UTF-8
  ascii: "utf-8",
  latin1: "iso-8859-1",
  cp866: "ibm866",
  "x-mac-cyrillic": "x-mac-cyrillic",
};

export function normalizeCharset(cs: string | null | undefined): string {
  const c = (cs ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!c) return "utf-8";
  return CHARSET_ALIASES[c] ?? c;
}

/** Декодировать байты в строку по charset; неизвестный charset → UTF-8 (строго) → windows-1251. */
export function decodeBytes(bytes: Uint8Array, charset?: string | null): string {
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("windows-1251").decode(bytes);
    }
  }
}

/** RFC 2047: декодирование encoded-words; соседние слова одной кодировки склеиваются по байтам. */
export function decodeRfc2047(input: string | null | undefined): string {
  if (!input) return "";
  const re = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  let out = "";
  let pending: { charset: string; chunks: Uint8Array[] } | null = null;
  let last = 0;
  const flush = () => {
    if (!pending) return;
    const total = pending.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const c of pending.chunks) {
      all.set(c, o);
      o += c.length;
    }
    out += decodeBytes(all, pending.charset);
    pending = null;
  };
  for (let m = re.exec(input); m; m = re.exec(input)) {
    const gap = input.slice(last, m.index);
    if (!(pending && /^\s*$/.test(gap))) {
      flush();
      out += gap;
    }
    const charset = m[1].split("*")[0];
    const bytes = m[2].toUpperCase() === "B" ? new Uint8Array(Buffer.from(m[3], "base64")) : decodeQ(m[3]);
    if (pending && normalizeCharset(pending.charset) === normalizeCharset(charset)) pending.chunks.push(bytes);
    else {
      flush();
      pending = { charset, chunks: [bytes] };
    }
    last = m.index + m[0].length;
  }
  flush();
  out += input.slice(last);
  return out;
}

function decodeQ(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

/** RFC 2231 значение параметра: UTF-8''%D0%... */
export function decodeRfc2231(v: string): string {
  const m = v.match(/^([^']*)'[^']*'(.*)$/);
  if (!m) return v;
  const bytes: number[] = [];
  const s = m[2];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return decodeBytes(new Uint8Array(bytes), m[1] || "utf-8");
}

/* ────────────────────────────── Заголовки ────────────────────────────── */

export function headerValues(headers: GmailHeader[] | undefined, name: string): string[] {
  const n = name.toLowerCase();
  return (headers ?? []).filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

/** Разбор заголовка с параметрами: `type; a=b; c*=UTF-8''...; d*0*=...; d*1*=...`. */
export function parseParamHeader(value: string | null | undefined): { value: string; params: Record<string, string> } {
  if (!value) return { value: "", params: {} };
  const parts = splitOutside(value, ";");
  const main = (parts.shift() ?? "").trim().toLowerCase();
  const raw: Record<string, string> = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    raw[k] = v;
  }
  const params: Record<string, string> = {};
  // Продолжения RFC 2231: name*0*, name*1* ...
  const cont: Record<string, { idx: number; v: string; enc: boolean }[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = k.match(/^([^*]+)\*(\d+)(\*)?$/);
    if (m) (cont[m[1]] ??= []).push({ idx: Number(m[2]), v, enc: !!m[3] });
  }
  for (const [name, list] of Object.entries(cont)) {
    list.sort((a, b) => a.idx - b.idx);
    if (list[0]?.enc) {
      // первая часть содержит charset'lang', остальные — только %-кодирование
      const joined = list.map((x) => x.v).join("");
      params[name] = decodeRfc2231(joined);
    } else params[name] = list.map((x) => x.v).join("");
  }
  for (const [k, v] of Object.entries(raw)) {
    if (/\*\d+\*?$/.test(k)) continue;
    if (k.endsWith("*")) params[k.slice(0, -1)] = decodeRfc2231(v);
    else if (!(k in params)) params[k] = decodeRfc2047(v);
  }
  return { value: main, params };
}

/** Разделить строку по символу вне кавычек, угловых и круглых скобок. */
function splitOutside(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') q = false;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if (ch === sep && !angle && !paren) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/\\(.)/g, "$1");
  return t;
}

/** Список адресов RFC 5322 с отображаемыми именами (RFC 2047) и группами. */
export function parseAddressList(value: string | null | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  for (let seg of splitOutside(value.replace(/\r?\n[ \t]+/g, " "), ",")) {
    seg = seg.trim();
    if (!seg) continue;
    // группа: "Получатели: a@b, c@d;" — имя группы отбрасываем
    const colon = seg.indexOf(":");
    const lt = seg.indexOf("<");
    const qt = seg.indexOf('"');
    if (colon > 0 && !seg.slice(0, colon).includes("@") && (lt < 0 || colon < lt) && (qt < 0 || colon < qt)) {
      seg = seg.slice(colon + 1).trim();
    }
    seg = seg.replace(/;\s*$/, "").trim();
    if (!seg) continue;
    const m = seg.match(/^(.*)<([^<>]*)>\s*(?:\(.*\))?$/);
    if (m) {
      const name = decodeRfc2047(unquote(m[1].replace(/\s+$/, "")));
      const email = m[2].trim();
      if (email) out.push({ email, name: name || null });
      continue;
    }
    const comment = seg.match(/\(([^)]*)\)/);
    const email = seg.replace(/\([^)]*\)/g, "").trim().replace(/;$/, "");
    if (email.includes("@")) out.push({ email, name: comment ? decodeRfc2047(comment[1]).trim() || null : null });
  }
  return out;
}

export function parseMailDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const cleaned = v.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ────────────────────────────── Authentication-Results (MAIL-10) ────────────────────────────── */

export interface AuthResults {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  raw?: string | null;
  dkimDomains?: string[];
  spfDomain?: string | null;
  dmarcFrom?: string | null;
}

/**
 * Берётся верхний заголовок, добавленный принимающим сервером Google (authserv-id *.google.com).
 * Нижние заголовки Authentication-Results мог вставить отправитель — им не доверяем.
 */
export function parseAuthResults(values: string[]): AuthResults {
  if (!values.length) return { raw: null };
  const pick = values.find((v) => /^\s*[^;]*google\.com/i.test(v)) ?? values[0];
  const v = pick.replace(/\r?\n[ \t]+/g, " ");
  const res: AuthResults = { raw: v.slice(0, 2000) };
  const spf = v.match(/\bspf=(\w+)/i);
  if (spf) res.spf = spf[1].toLowerCase();
  const dmarc = v.match(/\bdmarc=(\w+)/i);
  if (dmarc) res.dmarc = dmarc[1].toLowerCase();
  const dkims = [...v.matchAll(/\bdkim=(\w+)([^;]*)/gi)];
  if (dkims.length) {
    res.dkim = dkims.some((d) => d[1].toLowerCase() === "pass") ? "pass" : dkims[0][1].toLowerCase();
    res.dkimDomains = dkims
      .filter((d) => d[1].toLowerCase() === "pass")
      .map((d) => (d[2].match(/header\.(?:i=[^@\s]*@|d=)([^\s;]+)/i)?.[1] ?? "").toLowerCase())
      .filter(Boolean);
  }
  res.spfDomain = (v.match(/smtp\.mailfrom=(?:[^@\s;]*@)?([^\s;]+)/i)?.[1] ?? null)?.toLowerCase() ?? null;
  res.dmarcFrom = (v.match(/header\.from=([^\s;]+)/i)?.[1] ?? null)?.toLowerCase() ?? null;
  return res;
}

/* ────────────────────────────── Проверка источника (MAIL-10) ────────────────────────────── */

export interface SourceCheck {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  authenticated: boolean; // выровненный DMARC/DKIM/SPF для домена From
  fromOfficialRka: boolean; // адрес совпал с официальным адресом РКА
  verifiedRka: boolean; // совпал и подтверждён
  suspicious: boolean;
  flags: string[]; // признаки подозрительности (блокируют автоприобщение)
  warnings: string[]; // справочные замечания
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase().replace(/\.$/, "");
const aligned = (d: string | null | undefined, base: string) => !!d && (d === base || d.endsWith(`.${base}`));

const HOMO: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", к: "k", т: "t", в: "b", м: "m", н: "h", і: "i", ј: "j",
  "0": "o", "1": "l", "3": "e", "5": "s", "|": "l", i: "l",
};
function skeleton(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((c) => HOMO[c] ?? c)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[-_.]/g, "");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Домен похож на официальный, но не совпадает с ним и не является его поддоменом. */
export function isLookalikeDomain(domain: string, official: string): boolean {
  const d = domainToUnicode(domain.toLowerCase()) || domain.toLowerCase();
  const o = official.toLowerCase();
  if (d === o || d.endsWith(`.${o}`)) return false;
  if (domain.toLowerCase().includes("xn--")) {
    if (skeleton(d).includes(skeleton(o.split(".")[0]))) return true;
  }
  const oLabel = o.split(".")[0];
  if (skeleton(d) === skeleton(o)) return true;
  if (d.includes(oLabel)) return true; // advokatura.com, advokatura-kz.net, advokatura.kz.evil.ru
  const dLabels = d.split(".");
  return dLabels.some((l) => l.length >= 5 && (levenshtein(skeleton(l), skeleton(oLabel)) <= 2));
}

const RKA_NAME_RE = /(\bрка\b|республиканск\S*\s+коллеги|advokatura|адвокатур|республикалық\s+адвокаттар)/i;

export function assessSource(params: {
  from: MailAddress;
  replyTo: string | null;
  auth: AuthResults;
  officialRkaAddress: string;
  direction: "in" | "out";
}): SourceCheck {
  const { from, auth } = params;
  const email = from.email.toLowerCase();
  const rka = params.officialRkaAddress.toLowerCase();
  const rkaDomain = domainOf(rka);
  const fromDomain = domainOf(email);
  const flags: string[] = [];
  const warnings: string[] = [];

  const authenticated =
    auth.dmarc === "pass" ||
    (auth.dkim === "pass" && (auth.dkimDomains ?? []).some((d) => aligned(d, fromDomain))) ||
    (auth.spf === "pass" && aligned(auth.spfDomain, fromDomain));

  const fromOfficialRka = email === rka;
  if (params.direction === "in") {
    if (fromOfficialRka && !authenticated) {
      flags.push(
        auth.raw
          ? "Письмо от адреса РКА не подтверждено SPF/DKIM/DMARC"
          : "Нет данных проверки подлинности для письма от адреса РКА",
      );
    }
    if (auth.dmarc === "fail") flags.push("DMARC: проверка не пройдена");
    if (!fromOfficialRka && isLookalikeDomain(fromDomain, rkaDomain)) {
      flags.push(`Домен отправителя ${fromDomain} похож на официальный домен РКА ${rkaDomain}`);
    }
    const name = from.name ?? "";
    const nameEmail = name.match(/[^\s<>"']+@[^\s<>"']+/)?.[0]?.toLowerCase();
    if (nameEmail && nameEmail !== email) flags.push(`В имени отправителя указан другой адрес (${nameEmail})`);
    if (!fromOfficialRka && !aligned(fromDomain, rkaDomain) && RKA_NAME_RE.test(name)) {
      flags.push("Имя отправителя похоже на РКА, но адрес не официальный");
    }
    if (fromOfficialRka && params.replyTo) {
      const rt = parseAddressList(params.replyTo)[0]?.email.toLowerCase();
      if (rt && domainOf(rt) !== rkaDomain) warnings.push(`Адрес для ответа (${rt}) отличается от домена РКА`);
    }
    if (aligned(fromDomain, rkaDomain) && !fromOfficialRka) warnings.push("Адрес домена РКА, но не официальный адрес отправителя");
  }

  return {
    spf: auth.spf ?? null,
    dkim: auth.dkim ?? null,
    dmarc: auth.dmarc ?? null,
    authenticated,
    fromOfficialRka,
    verifiedRka: fromOfficialRka && authenticated,
    suspicious: flags.length > 0,
    flags,
    warnings,
  };
}

/* ────────────────────────────── Разбор MIME (MAIL-05) ────────────────────────────── */

export interface PendingBody {
  partId: string;
  attachmentId: string;
  mimeType: "text/plain" | "text/html";
  charset: string | null;
}

export interface WalkResult {
  textPlain: string;
  textHtml: string | null;
  attachments: FetchedAttachmentMeta[];
  /** Крупные текстовые тела, которые Gmail вынес в attachmentId — адаптер дочитывает их. */
  pendingBodies: PendingBody[];
}

const EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "application/zip": ".zip",
  "message/rfc822": ".eml",
  "text/plain": ".txt",
  "text/html": ".html",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

interface Leaf {
  path: string;
  part: GmailPart;
  mime: string;
  inRelated: boolean;
  containerPartId: string | null;
}

/**
 * Рекурсивный обход payload Gmail. partId — путь Gmail ("0", "1.2"); при его отсутствии
 * строится тем же способом. Классификация inline (не входит в обязательный манифест):
 * только изображения, на которые ссылается HTML через cid:, либо изображения с Content-ID /
 * disposition inline внутри multipart/related. Изображение с disposition inline вне related
 * (так iOS Mail вкладывает фотографии документов) считается обычным вложением — ошибочно
 * скрыть материал опаснее, чем лишний раз скачать логотип.
 */
export function walkMime(payload: GmailPart | undefined): WalkResult {
  const leaves: Leaf[] = [];
  const plain: string[] = [];
  const html: string[] = [];
  const pendingBodies: PendingBody[] = [];

  const visit = (p: GmailPart, computed: string, inRelated: boolean, container: string | null, depth: number) => {
    if (depth > 30) return; // защита от патологической вложенности
    const path = p.partId && p.partId !== "" ? p.partId : computed;
    const mime = (p.mimeType || "application/octet-stream").toLowerCase();
    const child = (i: number) => (path === "root" ? `${i}` : `${path}.${i}`);
    if (mime.startsWith("multipart/") && p.parts?.length) {
      const rel = mime === "multipart/related" ? true : mime === "multipart/mixed" ? false : inRelated;
      p.parts.forEach((c, i) => visit(c, child(i), rel, container, depth + 1));
      return;
    }
    leaves.push({ path, part: p, mime, inRelated, containerPartId: container });
    if (mime === "message/rfc822" && p.parts?.length) {
      p.parts.forEach((c, i) => visit(c, child(i), false, container ?? path, depth + 1));
    }
  };
  if (payload) visit(payload, "root", false, null, 0);

  // Первый проход: тела письма.
  const bodyLeaves = new Set<Leaf>();
  for (const l of leaves) {
    if (l.mime !== "text/plain" && l.mime !== "text/html") continue;
    if (l.containerPartId) continue; // текст вложенного письма — часть контейнера
    const disp = parseParamHeader(headerValue(l.part.headers, "Content-Disposition"));
    const ct = parseParamHeader(headerValue(l.part.headers, "Content-Type"));
    const fname = l.part.filename || disp.params.filename || ct.params.name;
    if (fname || disp.value === "attachment") continue;
    bodyLeaves.add(l);
    const charset = ct.params.charset ?? null;
    if (l.part.body?.data) {
      const text = decodeBytes(base64UrlToBytes(l.part.body.data), charset);
      (l.mime === "text/plain" ? plain : html).push(text);
    } else if (l.part.body?.attachmentId) {
      pendingBodies.push({ partId: l.path, attachmentId: l.part.body.attachmentId, mimeType: l.mime as PendingBody["mimeType"], charset });
    }
  }
  const htmlAll = html.join("\n");
  const cids = new Set([...htmlAll.matchAll(/cid:([^"'\s>)]+)/gi)].map((m) => decodeURIComponent(m[1]).toLowerCase()));

  // Второй проход: вложения.
  const attachments: FetchedAttachmentMeta[] = [];
  for (const l of leaves) {
    if (bodyLeaves.has(l)) continue;
    const p = l.part;
    const disp = parseParamHeader(headerValue(p.headers, "Content-Disposition"));
    const ct = parseParamHeader(headerValue(p.headers, "Content-Type"));
    let filename = decodeRfc2047(p.filename || disp.params.filename || ct.params.name || "").trim();
    const size = p.body?.size ?? 0;
    const hasContent = !!(p.body?.attachmentId || p.body?.data);
    if (!filename && !hasContent && disp.value !== "attachment") continue;
    if (!filename && !p.body?.attachmentId && size === 0 && (l.mime === "text/plain" || l.mime === "text/html")) continue;
    if (!filename) {
      filename = l.mime === "message/rfc822" ? `message-${l.path}.eml` : `attachment-${l.path}${EXT[l.mime] ?? ".bin"}`;
    }
    const contentId = (headerValue(p.headers, "Content-ID") ?? headerValue(p.headers, "X-Attachment-Id") ?? "")
      .trim()
      .replace(/^<|>$/g, "");
    const isImage = l.mime.startsWith("image/");
    const cidRef = !!contentId && cids.has(contentId.toLowerCase());
    const inline =
      isImage && disp.value !== "attachment" && (cidRef || (l.inRelated && (!!contentId || disp.value === "inline")));
    attachments.push({
      partId: l.path,
      providerAttachmentId: p.body?.attachmentId ?? (p.body?.data ? `${INLINE_DATA_PREFIX}${l.path}` : null),
      filename,
      mimeType: l.mime,
      size,
      inline,
      contentId: contentId || null,
      parentPartId: l.containerPartId,
    });
  }

  return { textPlain: plain.join("\n"), textHtml: html.length ? htmlAll : null, attachments, pendingBodies };
}

/** Найти часть по partId (для частей с содержимым в body.data). */
export function findPart(payload: GmailPart | undefined, partId: string): GmailPart | null {
  let found: GmailPart | null = null;
  const visit = (p: GmailPart, computed: string) => {
    if (found) return;
    const path = p.partId && p.partId !== "" ? p.partId : computed;
    if (path === partId) {
      found = p;
      return;
    }
    p.parts?.forEach((c, i) => visit(c, path === "root" ? `${i}` : `${path}.${i}`));
  };
  if (payload) visit(payload, "root");
  return found;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ────────────────────────────── Возвраты (OUT-08) ────────────────────────────── */

export interface BounceInfo {
  failed: boolean;
  originalMessageId: string | null;
  outgoingId: string | null;
  reason: string;
}

/** Текст для разбора возврата: заголовки и тела всех частей, кроме корня (там заголовки самого bounce). */
export function collectBounceText(payload: GmailPart | undefined): {
  headerText: string;
  bodyText: string;
  pending: { attachmentId: string; size: number }[];
} {
  const headerLines: string[] = [];
  const bodies: string[] = [];
  const pending: { attachmentId: string; size: number }[] = [];
  const textual = (m: string) =>
    m.startsWith("text/") || m === "message/delivery-status" || m === "message/rfc822" || m === "message/global-headers";
  const visit = (p: GmailPart, root: boolean) => {
    if (!root) for (const h of p.headers ?? []) headerLines.push(`${h.name}: ${h.value}`);
    const m = (p.mimeType ?? "").toLowerCase();
    if (textual(m)) {
      if (p.body?.data) bodies.push(decodeBytes(base64UrlToBytes(p.body.data)));
      else if (p.body?.attachmentId && (p.body.size ?? 0) < 512 * 1024) pending.push({ attachmentId: p.body.attachmentId, size: p.body.size ?? 0 });
    }
    p.parts?.forEach((c) => visit(c, false));
  };
  if (payload) visit(payload, true);
  return { headerText: headerLines.join("\n"), bodyText: bodies.join("\n"), pending };
}

export function parseBounce(headerText: string, bodyText: string): BounceInfo {
  const all = `${headerText}\n${bodyText}`;
  const outgoingId = all.match(/X-KZPPA-Outgoing-Id:\s*([A-Za-z0-9._:-]+)/i)?.[1] ?? null;
  const originalMessageId =
    headerText.match(/^Message-ID:\s*(<[^>\r\n]+>)/im)?.[1] ?? bodyText.match(/^Message-ID:\s*(<[^>\r\n]+>)/im)?.[1] ?? null;
  const actions = [...all.matchAll(/^Action:\s*(\w+)/gim)].map((m) => m[1].toLowerCase());
  const failed = actions.length === 0 ? true : actions.includes("failed");
  const diag = all.match(/^Diagnostic-Code:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/im)?.[1]?.replace(/\s+/g, " ").trim();
  const status = all.match(/^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im)?.[1];
  const recipient = all.match(/^Final-Recipient:\s*(?:rfc822;)?\s*([^\r\n]+)/im)?.[1]?.trim();
  let reason = diag ?? (status ? `Статус доставки ${status}` : "");
  if (!reason) reason = bodyText.replace(/\s+/g, " ").trim().slice(0, 300) || "Возврат письма без указания причины";
  if (recipient) reason = `${recipient}: ${reason}`;
  return { failed, originalMessageId, outgoingId, reason: reason.slice(0, 1000) };
}

/* ────────────────────────────── Сборка исходящего (OUT-06) ────────────────────────────── */

function assertHeaderSafe(v: string, what: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error(`Недопустимые символы перевода строки в поле «${what}»`);
  return v;
}

const isAsciiPrintable = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 B-кодирование UTF-8 с разбиением на слова ≤ 75 символов по границам символов. */
export function encodeHeaderWord(s: string, force = false): string {
  if (!force && isAsciiPrintable(s) && !s.includes("=?")) return s;
  const words: string[] = [];
  let buf: number[] = [];
  const enc = new TextEncoder();
  for (const ch of s) {
    const b = enc.encode(ch);
    if (buf.length + b.length > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(buf).toString("base64")}?=`);
      buf = [];
    }
    buf.push(...b);
  }
  if (buf.length || !words.length) words.push(`=?UTF-8?B?${Buffer.from(buf).toString("base64")}?=`);
  return words.join("\r\n ");
}

const EMAIL_RE = /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+\.[^\s<>@,;:"()[\]\\]+$/;

export function formatAddress(a: MailAddress): string {
  const email = assertHeaderSafe(a.email.trim(), "адрес");
  if (!EMAIL_RE.test(email)) throw new Error(`Некорректный адрес: ${email}`);
  if (!a.name) return email;
  const name = assertHeaderSafe(a.name.trim(), "имя");
  if (!isAsciiPrintable(name)) return `${encodeHeaderWord(name, true)} <${email}>`;
  return /[()<>@,;:\\".[\]]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}" <${email}>` : `${name} <${email}>`;
}

function formatAddressField(values: string[], what: string): string {
  const list: MailAddress[] = [];
  for (const v of values) {
    assertHeaderSafe(v, what);
    const parsed = parseAddressList(v);
    if (!parsed.length) throw new Error(`Некорректный адрес в поле «${what}»: ${v}`);
    list.push(...parsed);
  }
  return list.map(formatAddress).join(",\r\n ");
}

function wrapBase64(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** RFC 5987/2231: percent-encoding UTF-8 для filename*. */
export function encodeRfc2231Value(s: string): string {
  return encodeURIComponent(s).replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ә: "a", ғ: "g", қ: "q", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i", "№": "No",
};
/** Запасное ASCII-имя для старых почтовых клиентов: транслитерация вместо «_ _ _». */
function translit(s: string): string {
  return [...s].map((ch) => { const low = ch.toLowerCase(); const t = TRANSLIT[low]; if (t === undefined) return ch; return ch !== low && t ? t[0].toUpperCase() + t.slice(1) : t; }).join("");
}
function asciiFallbackName(name: string): string {
  name = translit(name);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).replace(/[^\x20-\x7e]/g, "") : "";
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^\x20-\x7e]/g, "_").replace(/_+/g, "_");
  return (base.replace(/^_+$/, "") || "file") + ext;
}

export function contentDispositionAttachment(filename: string): string {
  const name = assertHeaderSafe(filename, "имя файла");
  const fallback = asciiFallbackName(name).replace(/(["\\])/g, "\\$1");
  if (isAsciiPrintable(name)) return `attachment; filename="${fallback}"`;
  const enc = encodeRfc2231Value(name);
  if (enc.length <= 900) return `attachment; filename="${fallback}";\r\n filename*=UTF-8''${enc}`;
  // Очень длинные имена — продолжения RFC 2231 (filename*0*, filename*1*, ...), не разрывая %XX.
  const chunks: string[] = [];
  let i = 0;
  while (i < enc.length) {
    let end = Math.min(enc.length, i + 60);
    const pct = enc.lastIndexOf("%", end - 1);
    if (pct > end - 3 && pct >= i && end < enc.length) end = pct;
    chunks.push(enc.slice(i, end));
    i = end;
  }
  return (
    `attachment; filename="${fallback}"` +
    chunks.map((c, n) => `;\r\n filename*${n}*=${n === 0 ? "UTF-8''" : ""}${c}`).join("")
  );
}

export function formatRfc2822Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export interface BuildOptions {
  date?: Date;
  boundarySeed?: string; // для детерминированных тестов
  messageId?: string | null;
}

/**
 * RFC 5322 сообщение: multipart/mixed { multipart/alternative { text, html } | text, вложения base64 }.
 * Возвращает текст с CRLF. Заголовки проверяются на CR/LF (защита от внедрения заголовков).
 */
export function buildMimeMessage(mail: OutgoingMail, opts: BuildOptions = {}): string {
  const seed = opts.boundarySeed ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  const mixed = `=_kzppa_mixed_${seed}`;
  const alt = `=_kzppa_alt_${seed}`;
  const outgoingId = assertHeaderSafe(mail.outgoingId, "X-KZPPA-Outgoing-Id");
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(outgoingId)) throw new Error("Некорректный идентификатор исходящего");

  const h: string[] = [];
  h.push(`From: ${formatAddressField([mail.from], "От")}`);
  if (mail.to.length) h.push(`To: ${formatAddressField(mail.to, "Кому")}`);
  if (mail.cc.length) h.push(`Cc: ${formatAddressField(mail.cc, "Копия")}`);
  if (mail.bcc.length) h.push(`Bcc: ${formatAddressField(mail.bcc, "Скрытая копия")}`);
  h.push(`Subject: ${encodeHeaderWord(assertHeaderSafe(mail.subject, "Тема"))}`);
  h.push(`Date: ${formatRfc2822Date(opts.date ?? new Date())}`);
  if (opts.messageId) h.push(`Message-ID: ${assertHeaderSafe(opts.messageId, "Message-ID")}`);
  if (mail.inReplyTo) {
    const irt = assertHeaderSafe(mail.inReplyTo, "In-Reply-To");
    h.push(`In-Reply-To: ${irt}`);
    h.push(`References: ${irt}`);
  }
  h.push(`X-KZPPA-Outgoing-Id: ${outgoingId}`);
  h.push("MIME-Version: 1.0");
  h.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);

  const textPart = (type: "plain" | "html", body: string) =>
    [
      `Content-Type: text/${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(new TextEncoder().encode(body.replace(/\r?\n/g, "\r\n"))),
    ].join("\r\n");

  const lines: string[] = [...h, "", "This is a multi-part message in MIME format.", `--${mixed}`];
  if (mail.html) {
    lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`, "", `--${alt}`);
    lines.push(textPart("plain", mail.text), `--${alt}`, textPart("html", mail.html), `--${alt}--`);
  } else {
    lines.push(textPart("plain", mail.text));
  }
  for (const a of mail.attachments) {
    const mime = assertHeaderSafe(a.mimeType || "application/octet-stream", "тип файла");
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error(`Некорректный тип файла: ${mime}`);
    lines.push(
      `--${mixed}`,
      `Content-Type: ${mime}; name="${isAsciiPrintable(a.filename) ? asciiFallbackName(a.filename).replace(/(["\\])/g, "\\$1") : encodeHeaderWord(a.filename, true).replace(/\r\n /g, " ")}"`,
      `Content-Disposition: ${contentDispositionAttachment(a.filename)}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(a.bytes),
    );
  }
  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n");
}

/* ────────────────────────────── Контейнеры (MAIL-05, MAIL-09) ────────────────────────────── */

export interface ArchiveInfo {
  kind: "zip" | "rar" | "7z" | null;
  encrypted: boolean | null; // null — определить без распаковки нельзя
  entries: number | null;
  corrupt: boolean;
}

/**
 * Определение архива по сигнатуре и признака шифрования ZIP (бит 0 general purpose flag
 * в центральном каталоге или, при его отсутствии, в локальных заголовках). Без распаковки.
 */
export function inspectArchive(bytes: Uint8Array): ArchiveInfo {
  const b = bytes;
  const sig = (o: number, s: number[]) => s.every((x, i) => b[o + i] === x);
  if (b.length >= 6 && sig(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { kind: "rar", encrypted: null, entries: null, corrupt: false };
  if (b.length >= 6 && sig(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "7z", encrypted: null, entries: null, corrupt: false };
  if (!(b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07))) {
    return { kind: null, encrypted: null, entries: null, corrupt: false };
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  // EOCD: 0x06054b50, ищем с конца (комментарий до 65535 байт).
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd >= 0) {
    const total = u16(eocd + 10);
    let off = u32(eocd + 16);
    let encrypted = false;
    let n = 0;
    if (off !== 0xffffffff && off < b.length) {
      for (; n < total && off + 46 <= b.length; n++) {
        if (u32(off) !== 0x02014b50) return { kind: "zip", encrypted: null, entries: n, corrupt: true };
        if (u16(off + 8) & 1) encrypted = true;
        off += 46 + u16(off + 28) + u16(off + 30) + u16(off + 32);
      }
      return { kind: "zip", encrypted, entries: total, corrupt: n < total };
    }
  }
  // Нет центрального каталога (ZIP64/повреждён) — смотрим локальные заголовки.
  let off = 0;
  let encrypted = false;
  let n = 0;
  while (off + 30 <= b.length && u32(off) === 0x04034b50 && n < 10000) {
    const flags = u16(off + 6);
    if (flags & 1) encrypted = true;
    if (flags & 8) break; // размер в data descriptor — дальше без распаковки не пройти
    off += 30 + u32(off + 18) + u16(off + 26) + u16(off + 28);
    n++;
  }
  return { kind: "zip", encrypted: encrypted || null, entries: n || null, corrupt: eocd < 0 };
}

/** Значение заголовка из исходного EML (только блок заголовков верхнего уровня, с развёрткой строк). */
export function extractRawHeader(raw: Uint8Array | null | undefined, name: string): string | null {
  if (!raw?.byteLength) return null;
  const head = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.byteLength, 256 * 1024)));
  const end = head.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp(`^${name.replace(/[-]/g, "\\-")}:[ \\t]*(.*)$`, "im");
  return block.match(re)?.[1]?.trim() ?? null;
}

/** Postgres text не принимает NUL; длинные поля обрезаются до разумного предела. */
export function cleanText(s: string | null | undefined, max = 5_000_000): string {
  return (s ?? "").replace(/\u0000/g, "").slice(0, max);
}
