import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/server/env";
import { decryptSecret } from "@/server/crypto";
import {
  MailAuthError,
  UnknownSendResultError,
  type ChangesPage,
  type FetchedMessage,
  type MailAdapter,
  type OutgoingMail,
  type SendResult,
} from "./types";
import {
  INLINE_DATA_PREFIX,
  base64UrlToBytes,
  buildMimeMessage,
  collectBounceText,
  decodeBytes,
  decodeRfc2047,
  findPart,
  headerValue,
  headerValues,
  parseAddressList,
  parseAuthResults,
  parseBounce,
  parseMailDate,
  walkMime,
  type GmailMessageResource,
  type GmailPart,
} from "./mime";

/**
 * ARCH-07, MAIL-01..05, OUT-06..09. Боевой адаптер Gmail через REST API (fetch, без googleapis).
 *
 * Курсоры fetchChanges (хранятся платформой как непрозрачные строки):
 *   null                       — начать первичную синхронизацию;
 *   "page:<hid>:<pageToken>"   — продолжение первичной синхронизации (messages.list);
 *   "hist:<hid>[:<pageToken>]" — продолжение чтения журнала изменений (history.list);
 *   "<hid>"                    — догнали журнал; следующий вызов читает изменения после hid.
 * Префиксы "page:"/"hist:" означают «есть ещё страницы» (см. cursorHasMore в index.ts).
 * historyId первичной синхронизации фиксируется ДО листинга: письма, пришедшие во время
 * постраничного обхода, попадут в журнал изменений (дубли исключает уникальный ключ).
 */

// Адрес API переопределяется только для локального сквозного теста с имитацией Gmail
// (KZPPA_TEST_GMAIL_ORIGIN); в боевой среде переменная не задаётся.
const GMAIL_ORIGIN = process.env.KZPPA_TEST_GMAIL_ORIGIN || "https://gmail.googleapis.com";
const API = `${GMAIL_ORIGIN}/gmail/v1/users/me`;
const UPLOAD = `${GMAIL_ORIGIN}/upload/gmail/v1/users/me`;

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

/** OAuth-подключение (MAIL-02): cookie с подписанным state и путь возврата. */
export const OAUTH_STATE_COOKIE = "kzppa_gmail_oauth_state";
export const OAUTH_STATE_PURPOSE = "gmail-oauth-state";
export const OAUTH_STATE_TTL_SEC = 10 * 60;
export const OAUTH_CALLBACK_PATH = "/api/integrations/gmail/callback";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = process.env.KZPPA_TEST_GMAIL_ORIGIN ? `${process.env.KZPPA_TEST_GMAIL_ORIGIN}/token` : "https://oauth2.googleapis.com/token";

export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024; // лимит хранения исходного EML и вложения
const INITIAL_PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 500;
const SKIP_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "CHAT"]); // MAIL-04: по умолчанию не регистрируются

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

/* ────────────────────────────── Токены ────────────────────────────── */

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

export function invalidateAccessToken(accountId: string) {
  tokenCache.delete(accountId);
}

export function primeAccessToken(accountId: string, token: string, expiresInSec: number) {
  tokenCache.set(accountId, { token, expiresAt: Date.now() + Math.max(0, expiresInSec - 60) * 1000 });
}

export function refreshTokenAad(orgId: string, email: string) {
  return `mail:${orgId}:${email.toLowerCase()}`;
}

async function markLoginRequired(accountId: string, reason: string) {
  tokenCache.delete(accountId);
  await db
    .update(schema.mailAccounts)
    .set({ state: "login_required", lastError: reason })
    .where(eq(schema.mailAccounts.id, accountId));
}

async function refreshAccessToken(accountId: string): Promise<string> {
  const acc = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.id, accountId) });
  if (!acc) throw new Error("Почтовое подключение не найдено");
  if (!acc.refreshTokenEnc) {
    await markLoginRequired(accountId, "Нет сохранённого refresh-токена");
    throw new MailAuthError();
  }
  if (!env.googleClientId || !env.googleClientSecret) throw new Error("Не заданы GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  const refreshToken = decryptSecret(acc.refreshTokenEnc, refreshTokenAad(acc.organizationId, acc.email));
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`Сервер авторизации Google недоступен: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_grant" || body.error === "unauthorized_client") {
      // Токен отозван/истёк/сменён пароль — нужен повторный вход администратора (MAIL-02).
      await markLoginRequired(accountId, "Доступ к почте отозван или истёк: требуется повторное подключение");
      throw new MailAuthError();
    }
    throw new Error(`Не удалось обновить токен доступа Gmail (HTTP ${res.status}${body.error ? `, ${body.error}` : ""})`);
  }
  primeAccessToken(accountId, body.access_token, body.expires_in ?? 3600);
  return body.access_token;
}

async function accessToken(accountId: string): Promise<string> {
  const c = tokenCache.get(accountId);
  if (c && c.expiresAt > Date.now()) return c.token;
  let p = inflight.get(accountId);
  if (!p) {
    p = refreshAccessToken(accountId).finally(() => inflight.delete(accountId));
    inflight.set(accountId, p);
  }
  return p;
}

/* ────────────────────────────── HTTP ────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CallInit {
  method?: string;
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  json?: unknown;
  body?: BodyInit;
  contentType?: string;
  retries?: number;
  timeoutMs?: number;
}

function buildUrl(base: string, query?: CallInit["query"]): string {
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function readError(res: Response): Promise<GmailApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string; status?: string; errors?: { reason?: string }[] };
  } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;
  const msg = body?.error?.message ?? res.statusText;
  return new GmailApiError(res.status, reason, `Gmail API: HTTP ${res.status}${reason ? ` (${reason})` : ""}: ${msg}`);
}

const isRateLimit = (e: GmailApiError) =>
  e.status === 429 || (e.status === 403 && /rateLimit|userRateLimit|quotaExceeded|concurrentLimit/i.test(e.reason ?? ""));
const isScopeError = (e: GmailApiError) => e.status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(e.reason ?? "");

/** Идемпотентные запросы (чтение, черновики): повтор с backoff при 429/5xx/сетевых сбоях. */
async function call<T>(accountId: string, path: string, init: CallInit = {}): Promise<T> {
  const url = buildUrl(path.startsWith("http") ? path : `${API}${path}`, init.query);
  const retries = init.retries ?? 3;
  let authRetried = false;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(accountId);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.contentType ? { "content-type": init.contentType } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw new Error(`Gmail API недоступен: ${(e as Error).message}`);
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    if (res.status === 401 && !authRetried) {
      authRetried = true;
      invalidateAccessToken(accountId);
      attempt--;
      continue;
    }
    const err = await readError(res);
    if (isScopeError(err)) {
      await markLoginRequired(accountId, "Недостаточно прав OAuth: переподключите почту с нужными разрешениями");
      throw new MailAuthError("Недостаточно прав доступа к почте: требуется повторное подключение");
    }
    if ((isRateLimit(err) || err.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    throw err;
  }
}

/** Ошибки, при которых запрос гарантированно не дошёл до Google (безопасно считать «не отправлено»). */
function isPreSendNetworkError(e: unknown): boolean {
  const err = e as { cause?: { code?: string }; code?: string };
  const code = err?.cause?.code ?? err?.code ?? "";
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code);
}

/**
 * OUT-06. Отправляющий запрос без автоматических повторов. Таймаут/обрыв/5xx после
 * передачи тела → UnknownSendResultError: решение о повторе принимается только после сверки.
 */
async function sendCall<T>(accountId: string, url: string, body: BodyInit, contentType: string): Promise<T> {
  let authRetried = false;
  for (;;) {
    const token = await accessToken(accountId); // ошибка здесь — запрос ещё не отправлен
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body,
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      if (isPreSendNetworkError(e)) throw new Error(`Нет соединения с Gmail, письмо не отправлено: ${(e as Error).message}`);
      throw new UnknownSendResultError();
    }
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch {
        // Провайдер принял запрос, но ответ не прочитан — результат неизвестен.
        throw new UnknownSendResultError();
      }
    }
    if (res.status === 401 && !authRetried) {
      // Запрос отклонён на этапе авторизации — письмо не принято, повтор безопасен.
      authRetried = true;
      invalidateAccessToken(accountId);
      continue;
    }
    if (res.status >= 500) throw new UnknownSendResultError();
    const err = await readError(res);
    if (isScopeError(err)) {
      await markLoginRequired(accountId, "Недостаточно прав OAuth для отправки");
      throw new MailAuthError("Недостаточно прав для отправки: требуется повторное подключение почты");
    }
    throw err; // 4xx — провайдер явно отклонил, письмо не отправлено
  }
}

/** multipart/related для upload-эндпоинтов: JSON-метаданные + message/rfc822. */
function multipartUpload(metadata: unknown, rfc822: string): { body: Uint8Array; contentType: string } {
  const boundary = `kzppa_upload_${crypto.randomUUID()}`;
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const enc = new TextEncoder();
  const parts = [enc.encode(head), enc.encode(rfc822), enc.encode(tail)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { body: out, contentType: `multipart/related; boundary=${boundary}` };
}

/* ────────────────────────────── Адаптер ────────────────────────────── */

interface ListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
interface HistoryResponse {
  history?: { id: string; messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[] }[];
  nextPageToken?: string;
  historyId?: string;
}
interface ProfileResponse {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
}

export async function getProfile(accountId: string): Promise<ProfileResponse> {
  return call<ProfileResponse>(accountId, "/profile");
}

export class GmailAdapter implements MailAdapter {
  readonly mode = "gmail" as const;

  async fetchChanges(accountId: string, cursor: string | null): Promise<ChangesPage> {
    if (cursor === null || cursor.startsWith("page:")) return this.initialPage(accountId, cursor);
    return this.historyPage(accountId, cursor);
  }

  private async initialPage(accountId: string, cursor: string | null): Promise<ChangesPage> {
    let startHistoryId: string;
    let pageToken: string | undefined;
    if (cursor) {
      const [, hid, ...rest] = cursor.split(":");
      startHistoryId = hid;
      pageToken = rest.join(":") || undefined;
    } else {
      startHistoryId = (await getProfile(accountId)).historyId; // до листинга — см. комментарий модуля
    }
    const acc = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.id, accountId) });
    const from = acc?.initialSyncFrom ? new Date(`${acc.initialSyncFrom}T00:00:00Z`) : new Date(Date.now() - 90 * 86400_000);
    // MAIL-04: входящие, архив и отправленные; спам, корзина и черновики по умолчанию исключены.
    const q = `in:anywhere -in:spam -in:trash -in:drafts after:${Math.floor(from.getTime() / 1000)}`;
    let res: ListResponse;
    try {
      res = await call<ListResponse>(accountId, "/messages", {
        query: { q, maxResults: INITIAL_PAGE_SIZE, pageToken, includeSpamTrash: false },
      });
    } catch (e) {
      if (pageToken && e instanceof GmailApiError && (e.status === 400 || e.status === 404)) {
        return { messageIds: [], nextCursor: null, cursorExpired: true }; // устаревший pageToken
      }
      throw e;
    }
    const ids = (res.messages ?? []).map((m) => m.id);
    return {
      messageIds: ids,
      nextCursor: res.nextPageToken ? `page:${startHistoryId}:${res.nextPageToken}` : startHistoryId,
      cursorExpired: false,
    };
  }

  private async historyPage(accountId: string, cursor: string): Promise<ChangesPage> {
    let startHistoryId = cursor;
    let pageToken: string | undefined;
    if (cursor.startsWith("hist:")) {
      const [, hid, ...rest] = cursor.split(":");
      startHistoryId = hid;
      pageToken = rest.join(":") || undefined;
    }
    let res: HistoryResponse;
    try {
      res = await call<HistoryResponse>(accountId, "/history", {
        query: { startHistoryId, historyTypes: "messageAdded", maxResults: HISTORY_PAGE_SIZE, pageToken },
      });
    } catch (e) {
      // 404: startHistoryId вне доступного журнала → контролируемая повторная синхронизация (MAIL-03).
      if (e instanceof GmailApiError && (e.status === 404 || (e.status === 400 && pageToken))) {
        return { messageIds: [], nextCursor: null, cursorExpired: true };
      }
      throw e;
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const h of res.history ?? []) {
      for (const a of h.messagesAdded ?? []) {
        const m = a.message;
        if (!m?.id || seen.has(m.id)) continue;
        if ((m.labelIds ?? []).some((l) => SKIP_LABELS.has(l))) continue;
        seen.add(m.id);
        ids.push(m.id);
      }
    }
    const nextCursor = res.nextPageToken ? `hist:${startHistoryId}:${res.nextPageToken}` : (res.historyId ?? startHistoryId);
    return { messageIds: ids, nextCursor, cursorExpired: false };
  }

  async fetchMessage(accountId: string, providerMessageId: string): Promise<FetchedMessage> {
    const m = await call<GmailMessageResource>(accountId, `/messages/${encodeURIComponent(providerMessageId)}`, {
      query: { format: "full" },
    });
    const payload = m.payload;
    const headers = payload?.headers ?? [];
    const walk = walkMime(payload);

    let bodyText = walk.textPlain;
    let bodyHtml = walk.textHtml;
    for (const pb of walk.pendingBodies) {
      // Крупные тела Gmail отдаёт как вложения — дочитываем их.
      const bytes = await this.fetchAttachment(accountId, providerMessageId, pb.attachmentId);
      const text = decodeBytes(bytes, pb.charset);
      if (pb.mimeType === "text/plain") bodyText = bodyText ? `${bodyText}\n${text}` : text;
      else bodyHtml = bodyHtml ? `${bodyHtml}\n${text}` : text;
    }

    const from = parseAddressList(headerValue(headers, "From"))[0] ?? { email: "", name: null };
    const auth = parseAuthResults(headerValues(headers, "Authentication-Results"));

    let raw: Uint8Array | null = null;
    if ((m.sizeEstimate ?? 0) <= MAX_MESSAGE_BYTES) {
      try {
        const r = await call<GmailMessageResource>(accountId, `/messages/${encodeURIComponent(providerMessageId)}`, {
          query: { format: "raw" },
          timeoutMs: 60_000,
        });
        if (r.raw) {
          const bytes = base64UrlToBytes(r.raw);
          raw = bytes.byteLength <= MAX_MESSAGE_BYTES ? bytes : null;
        }
      } catch (e) {
        if (e instanceof MailAuthError) throw e;
        raw = null; // исходный EML — дополнительное доказательство; его отсутствие не блокирует приём
      }
    }

    return {
      providerMessageId: m.id,
      internetMessageId: headerValue(headers, "Message-ID")?.trim() ?? headerValue(headers, "Message-Id")?.trim() ?? null,
      threadId: m.threadId ?? null,
      labelIds: m.labelIds ?? [],
      sentAt: parseMailDate(headerValue(headers, "Date")),
      receivedAt: m.internalDate ? new Date(Number(m.internalDate)) : null,
      from: { email: from.email.toLowerCase(), name: from.name ?? null },
      to: parseAddressList(headerValues(headers, "To").join(", ")),
      cc: parseAddressList(headerValues(headers, "Cc").join(", ")),
      replyTo: headerValue(headers, "Reply-To"),
      subject: decodeRfc2047(headerValue(headers, "Subject") ?? "").replace(/\s*\r?\n\s*/g, " ").trim(),
      bodyText,
      bodyHtml,
      attachments: walk.attachments,
      authResults: { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, raw: auth.raw ?? null },
      raw,
    };
  }

  async fetchAttachment(accountId: string, providerMessageId: string, providerAttachmentId: string): Promise<Uint8Array> {
    if (providerAttachmentId.startsWith(INLINE_DATA_PREFIX)) {
      // Маленькие части Gmail возвращает прямо в body.data — перечитываем сообщение.
      const partId = providerAttachmentId.slice(INLINE_DATA_PREFIX.length);
      const m = await call<GmailMessageResource>(accountId, `/messages/${encodeURIComponent(providerMessageId)}`, {
        query: { format: "full" },
      });
      const part = findPart(m.payload, partId);
      if (!part) throw new GmailApiError(404, "partNotFound", `Часть ${partId} не найдена в письме`);
      return part.body?.data ? base64UrlToBytes(part.body.data) : new Uint8Array(0);
    }
    const r = await call<{ size?: number; data?: string }>(
      accountId,
      `/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(providerAttachmentId)}`,
      { timeoutMs: 120_000 },
    );
    return r.data ? base64UrlToBytes(r.data) : new Uint8Array(0);
  }

  async createOrUpdateDraft(accountId: string, mail: OutgoingMail, existingDraftId?: string | null): Promise<{ draftId: string }> {
    const rfc822 = buildMimeMessage(mail);
    const meta = { ...(existingDraftId ? { id: existingDraftId } : {}), message: mail.threadId ? { threadId: mail.threadId } : {} };
    const { body, contentType } = multipartUpload(meta, rfc822);
    if (existingDraftId) {
      try {
        const r = await call<{ id: string }>(accountId, `${UPLOAD}/drafts/${encodeURIComponent(existingDraftId)}`, {
          method: "PUT",
          query: { uploadType: "multipart" },
          body: body as BodyInit,
          contentType,
          retries: 2,
          timeoutMs: 90_000,
        });
        return { draftId: r.id };
      } catch (e) {
        if (!(e instanceof GmailApiError && e.status === 404)) throw e;
        // Черновик удалён в почтовом интерфейсе — создаём новый.
      }
    }
    const fresh = multipartUpload({ message: mail.threadId ? { threadId: mail.threadId } : {} }, rfc822);
    const r = await call<{ id: string }>(accountId, `${UPLOAD}/drafts`, {
      method: "POST",
      query: { uploadType: "multipart" },
      body: fresh.body as BodyInit,
      contentType: fresh.contentType,
      retries: 0, // повтор создания черновика мог бы дать дубль черновика
      timeoutMs: 90_000,
    });
    return { draftId: r.id };
  }

  async sendApprovedPackage(accountId: string, mail: OutgoingMail, draftId?: string | null): Promise<SendResult> {
    const acc = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.id, accountId) });
    const fromEmail = parseAddressList(mail.from)[0]?.email.toLowerCase();
    if (!acc || !fromEmail || fromEmail !== acc.email.toLowerCase()) {
      throw new Error(`Отправитель ${mail.from} не совпадает с подключённым ящиком — отправка запрещена`);
    }
    // Отправляем ровно утверждённое содержимое: при отправке черновика его тело заменяется пакетом.
    const rfc822 = buildMimeMessage(mail);
    let sent: { id: string; threadId?: string; message?: { id: string; threadId?: string } };
    if (draftId) {
      const { body, contentType } = multipartUpload(
        { id: draftId, message: mail.threadId ? { threadId: mail.threadId } : {} },
        rfc822,
      );
      try {
        sent = await sendCall(accountId, buildUrl(`${UPLOAD}/drafts/send`, { uploadType: "multipart" }), body as BodyInit, contentType);
      } catch (e) {
        if (!(e instanceof GmailApiError && e.status === 404)) throw e;
        // Черновик не найден — запрос отклонён до отправки; отправляем как новое письмо.
        const mp = multipartUpload(mail.threadId ? { threadId: mail.threadId } : {}, rfc822);
        sent = await sendCall(accountId, buildUrl(`${UPLOAD}/messages/send`, { uploadType: "multipart" }), mp.body as BodyInit, mp.contentType);
      }
    } else {
      const mp = multipartUpload(mail.threadId ? { threadId: mail.threadId } : {}, rfc822);
      sent = await sendCall(accountId, buildUrl(`${UPLOAD}/messages/send`, { uploadType: "multipart" }), mp.body as BodyInit, mp.contentType);
    }
    // drafts.send возвращает Message; на всякий случай поддерживаем и обёртку Draft.
    const msg = sent.message ?? sent;
    const providerMessageId = msg.id;
    let internetMessageId: string | null = null;
    try {
      const meta = await call<GmailMessageResource>(accountId, `/messages/${encodeURIComponent(providerMessageId)}`, {
        query: { format: "metadata", metadataHeaders: ["Message-ID"] },
      });
      internetMessageId = headerValue(meta.payload?.headers, "Message-ID")?.trim() ?? null;
    } catch {
      // Письмо уже принято провайдером; Message-ID восполнит сверка (OUT-07).
    }
    return { providerMessageId, threadId: msg.threadId ?? null, internetMessageId };
  }

  /**
   * OUT-06/07/09. Поиск отправленного по X-KZPPA-Outgoing-Id.
   * ОГРАНИЧЕНИЕ: поиск Gmail не индексирует произвольные заголовки, поэтому просматриваются
   * отправленные за 14 дней (до 300 писем, metadata-запросом только нужных заголовков).
   * Более старое или «утонувшее» в большом объёме отправленное не будет найдено — тогда
   * возвращается null, и платформа НЕ должна считать это доказательством неотправки без
   * ручной проверки (OUT-09: «не утверждает отсутствие дубля, пока не завершена сверка»).
   */
  async reconcileSent(accountId: string, outgoingId: string): Promise<SendResult | null> {
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page++) {
      const list = await call<ListResponse>(accountId, "/messages", {
        query: { q: "in:sent newer_than:14d", maxResults: 100, pageToken },
      });
      const ids = (list.messages ?? []).map((m) => m.id);
      for (let i = 0; i < ids.length; i += 10) {
        const batch = await Promise.all(
          ids.slice(i, i + 10).map((id) =>
            call<GmailMessageResource>(accountId, `/messages/${encodeURIComponent(id)}`, {
              query: { format: "metadata", metadataHeaders: ["X-KZPPA-Outgoing-Id", "Message-ID"] },
            }).catch((e) => {
              if (e instanceof MailAuthError) throw e;
              return null;
            }),
          ),
        );
        for (const m of batch) {
          if (!m) continue;
          const v = headerValue(m.payload?.headers, "X-KZPPA-Outgoing-Id")?.trim();
          if (v && v === outgoingId) {
            return {
              providerMessageId: m.id,
              threadId: m.threadId ?? null,
              internetMessageId: headerValue(m.payload?.headers, "Message-ID")?.trim() ?? null,
            };
          }
        }
      }
      if (!list.nextPageToken) break;
      pageToken = list.nextPageToken;
    }
    return null;
  }

  /**
   * OUT-08. Возвраты: письма от mailer-daemon/postmaster за 14 дней. sinceCursor — ISO-дата
   * или epoch ms: более ранние уведомления пропускаются. Разбирается text/rfc822-headers
   * (или вложенное message/rfc822) — исходный Message-ID и X-KZPPA-Outgoing-Id.
   */
  async readDeliveryEvents(
    accountId: string,
    sinceCursor: string | null,
  ): Promise<{ bounces: { originalMessageId: string | null; outgoingId: string | null; reason: string }[] }> {
    const since = sinceCursor ? (/^\d+$/.test(sinceCursor) ? Number(sinceCursor) : Date.parse(sinceCursor)) : 0;
    const list = await call<ListResponse>(accountId, "/messages", {
      query: { q: "{from:mailer-daemon from:postmaster} newer_than:14d", maxResults: 50 },
    });
    const bounces: { originalMessageId: string | null; outgoingId: string | null; reason: string }[] = [];
    for (const { id } of list.messages ?? []) {
      const m = await call<GmailMessageResource>(accountId, `/messages/${encodeURIComponent(id)}`, { query: { format: "full" } });
      if (since && Number(m.internalDate ?? 0) <= since) continue;
      const collected = collectBounceText(m.payload as GmailPart | undefined);
      let bodyText = collected.bodyText;
      for (const p of collected.pending.slice(0, 3)) {
        try {
          bodyText += "\n" + decodeBytes(await this.fetchAttachment(accountId, id, p.attachmentId));
        } catch (e) {
          if (e instanceof MailAuthError) throw e;
        }
      }
      const b = parseBounce(collected.headerText, bodyText);
      if (!b.failed) continue; // отчёты delayed/delivered — не возврат
      if (!b.originalMessageId && !b.outgoingId) continue; // не связать с исходящим
      bounces.push({ originalMessageId: b.originalMessageId, outgoingId: b.outgoingId, reason: b.reason });
    }
    return { bounces };
  }
}

/* ────────────────────────────── Наблюдение (MAIL-03) ────────────────────────────── */

/**
 * Продлить users.watch, если до истечения меньше суток. Без GMAIL_PUBSUB_TOPIC — пропуск:
 * уведомления лишь ускоряют чтение изменений, периодическая сверка по cron работает всегда.
 */
export async function ensureWatch(accountId: string): Promise<{ status: "skipped" | "fresh" | "renewed"; expiration?: Date }> {
  if (!env.gmailPubsubTopic || env.mailTransport !== "gmail") return { status: "skipped" };
  const acc = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.id, accountId) });
  if (!acc || !acc.refreshTokenEnc || acc.state === "disabled" || acc.state === "login_required") return { status: "skipped" };
  if (acc.watchExpiration && acc.watchExpiration.getTime() - Date.now() > 24 * 3600_000) {
    return { status: "fresh", expiration: acc.watchExpiration };
  }
  const r = await call<{ historyId: string; expiration: string }>(accountId, "/watch", {
    method: "POST",
    json: { topicName: env.gmailPubsubTopic, labelFilterBehavior: "exclude", labelIds: ["SPAM", "TRASH"] },
  });
  const expiration = new Date(Number(r.expiration));
  await db.update(schema.mailAccounts).set({ watchExpiration: expiration }).where(eq(schema.mailAccounts.id, accountId));
  return { status: "renewed", expiration };
}
