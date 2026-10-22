import "server-only";
import { env } from "@/server/env";
import { sha256Hex } from "@/domain/hash";
import {
  AuthRequiredError,
  type AuthPollResult,
  type PollResult,
  type SignAdapter,
  type SignProcedure,
  type Verification,
} from "./types";

/**
 * ARCH-07, SIGN-01..10. Адаптер SIGEX (eGov Mobile / eGov Business).
 * Документация: https://sigex.kz/support/developers/api-egov-basic/ и /api-documents/.
 *
 * Сверено с документацией (2026-10-21):
 *  - POST {base}/api/egovQr {description} → expireAt (мс UNIX), qrCode (base64 PNG),
 *    eGovMobileLaunchLink, eGovBusinessLaunchLink, dataURL, signURL (+ варианты mTLS/Auto).
 *    Проверено живым запросом: шаг доступен без аутентификации.
 *  - POST dataURL {signMethod, documentsToSign:[{id,nameRu,nameKz,nameEn,meta,document:{file:{mime,data}}}]}
 *    → expireAt, signURL. Это длинный запрос: ответ приходит, когда eGov mobile скачал данные.
 *    При разрыве без HTTP-ответа запрос можно повторить — сервис обрабатывает последний.
 *  - GET signURL — длинный опрос до подписи; ответ {signMethod, documentsToSign, version, status?}.
 *    status:"CANCELED" — отказ (вместо подписей возвращаются исходные данные).
 *  - signMethod "CMS_SIGN_ONLY" — открепленная CMS (без данных) по точным байтам документа.
 *  - POST {base}/api {title, description, signType:"cms", signature, settings} → {documentId, signId};
 *    затем POST /api/{id}/data (application/octet-stream, тело — документ) завершает регистрацию.
 *  - POST /api/{id}/verify (octet-stream, тело — документ) → проверка подписей на момент регистрации
 *    по сохранённым OCSP/TSP; ответ {documentId, dataArchived, tempStorage}. Данные подписантов —
 *    GET /api/{id} → signatures[] (userId=ИИН, subject, serialNumber, from, until, tsp, ocsp…).
 *  - POST /api/exported {signType, signature} → {documentId, signId} — поиск регистрации по подписи
 *    (используется для сверки, SIGN-07).
 *  - Ошибки: HTTP 200 + JSON {message, requestID}; иной HTTP-код — серьёзная проблема.
 *    Известные строки: "Authentication required", "Access denied", "eGov signing operation expired",
 *    "QR signing operation timeout", "QR signing operation is not active", "This signature has already
 *    been submitted", "Document digests are already known", "Signature does not correspond to the document".
 *
 *  - Вход (проверено живым запросом 2026-10-22): POST /api/auth {} → {nonce} (base64);
 *    POST /api/auth {nonce, signature: base64 DER CMS} → данные сертификата + Set-Cookie jwt=…
 *    Nonce подписывается председателем в той же процедуре eGov, что и заключение (два документа,
 *    signMethod MIX_SIGN). Если регистрация отвечает «Authentication required», платформа входит
 *    по этой подписи и повторяет запрос с cookie. Cookie хранится только в памяти обработчика.
 *
 * Закрытый ключ и пароль председателя платформа не получает и не хранит (SIGN-01).
 * В журнал не пишутся тела запросов и подписи — только коды ответов.
 */

const FETCH_TIMEOUT_MS = 25_000; // короткие запросы
const LONG_POLL_MS = 50_000; // длинный опрос на один вызов (лимит функции Vercel ~60 с)

/** Длинный запрос завершился без HTTP-ответа: данные/результат ещё не получены, повтор безопасен. */
export function isNotDelivered(e: unknown): boolean {
  return e instanceof Error && e.name === "SigexError" && (e as SigexError).httpStatus === null;
}

/** Ошибка, после которой запрос мог быть применён у поставщика (SIGN-07: нужна сверка). */
export function maybeApplied(e: unknown): boolean {
  if (e instanceof Error && e.name === "SigexError") {
    const se = e as SigexError;
    return se.maybeApplied || /already been submitted|digests are already known/i.test(se.sigexMessage ?? "");
  }
  return true; // неизвестная ошибка — результат не известен
}

export class SigexError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly sigexMessage: string | null,
    /** Запрос мог быть выполнен на стороне SIGEX (нет ответа после отправки). */
    public readonly maybeApplied: boolean,
  ) {
    super(message);
    this.name = "SigexError";
  }
}

const AUTH_MESSAGES = /^(Authentication required|Access denied|Not enough authorities|Invalid authentication nonce)$/i;

function base() {
  return env.sigexBaseUrl.replace(/\/$/, "");
}

const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** PEM → DER, иначе base64 DER как есть. */
function cmsBytesFrom(data: string): Uint8Array {
  const pem = data.match(/-----BEGIN [A-Z0-9 ]+-----([\s\S]+?)-----END/);
  return unb64((pem ? pem[1] : data).replace(/\s+/g, ""));
}

interface CallOpts {
  method: "GET" | "POST";
  /** Значение cookie jwt после входа в SIGEX (только в памяти). */
  cookie?: string | null;
  json?: unknown;
  body?: Uint8Array;
  timeoutMs?: number;
}

/**
 * Вызов SIGEX. Возвращает разобранный JSON. Ошибка-объект {message} при HTTP 200 тоже считается ошибкой.
 * "Authentication required" → AuthRequiredError (SIGN-06: это не признак отсутствия подписи).
 */
async function call<T = Record<string, unknown>>(url: string, o: CallOpts): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    const headers: Record<string, string> = o.json !== undefined ? { "content-type": "application/json" } : o.body ? { "content-type": "application/octet-stream", "content-length": String(o.body.byteLength) } : {};
    if (o.cookie) headers.cookie = `jwt=${o.cookie}`;
    res = await fetch(url, {
      method: o.method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: o.json !== undefined ? JSON.stringify(o.json) : o.body ? (o.body as BodyInit) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    // Нет HTTP-ответа: для POST результат неизвестен (мог примениться).
    throw new SigexError(aborted ? "Нет ответа от SIGEX (таймаут)" : `Нет соединения с SIGEX: ${(e as Error).message}`, null, null, o.method === "POST");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON */
  }
  const msg = data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string" ? ((data as { message: string }).message) : null;
  if (res.status === 401 || res.status === 403 || (msg && AUTH_MESSAGES.test(msg))) {
    throw new AuthRequiredError(`SIGEX: ${msg ?? `HTTP ${res.status}`} — требуется авторизация платформы у поставщика подписи`);
  }
  if (!res.ok || msg) {
    // VERIFY: документация не перечисляет HTTP-коды ошибок; 5xx/неизвестное → результат неясен.
    throw new SigexError(`SIGEX: ${msg ?? `HTTP ${res.status}`}`, res.status, msg, res.status >= 500 && o.method === "POST");
  }
  if (data === null || typeof data !== "object") throw new SigexError("SIGEX вернул ответ не в формате JSON", res.status, null, false);
  return data as T;
}

/* ───────────── форма ответов SIGEX ───────────── */

interface EgovQrStart {
  expireAt?: number;
  qrCode?: string;
  eGovMobileLaunchLink?: string;
  eGovBusinessLaunchLink?: string;
  dataURL?: string;
  dataURLAuto?: string;
  signURL?: string;
  signURLAuto?: string;
}

interface EgovSignResult {
  signMethod?: string;
  version?: number;
  status?: string;
  documentsToSign?: { id?: number | string; document?: { file?: { mime?: string; data?: string } } }[];
}

interface SigexSignature {
  userId?: string; // "IIN…"
  businessId?: string;
  subject?: string;
  subjectStructure?: { oid?: string; name?: string; value?: string }[][];
  serialNumber?: string;
  from?: number;
  until?: number;
  issuer?: string;
  signId?: number;
  signType?: string;
  storedAt?: number;
  tsp?: { timeStamp?: number } | null;
  ocsp?: Record<string, unknown> | null;
}

const toDate = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null);
const iso = (ms: unknown) => toDate(ms)?.toISOString() ?? null;

function procedureFrom(r: EgovQrStart, dataUrl: string, signUrl: string): SignProcedure {
  // qrId — последний сегмент ссылки (…/api/egovQr/{qrId}); используется как идентификатор процедуры.
  const procedureId = new URL(dataUrl).pathname.split("/").filter(Boolean).pop() ?? dataUrl;
  return {
    procedureId,
    qrCodeDataUrl: r.qrCode ? `data:image/png;base64,${r.qrCode}` : null,
    mobileLink: r.eGovMobileLaunchLink ?? null,
    businessLink: r.eGovBusinessLaunchLink ?? null,
    dataUrl,
    signUrl,
    expireAt: toDate(r.expireAt) ?? new Date(Date.now() + 5 * 60_000), // VERIFY: срок по умолчанию, если поля нет
  };
}

/** Документ «подтверждение входа»: nonce SIGEX (base64), CMS с данными. */
function authDocument(id: number, nonce: string) {
  return {
    id,
    nameRu: "Подтверждение входа в SIGEX для регистрации подписи",
    nameKz: "Қолтаңбаны тіркеу үшін SIGEX жүйесіне кіруді растау",
    nameEn: "SIGEX sign-in confirmation",
    meta: [{ name: "Назначение", value: "Вход платформы КЗППА в SIGEX от имени подписанта" }],
    // VERIFY: mime для произвольных байтов. Документация приводит "" для SIGN_BYTES_ARRAY и
    // "@file/pdf" для PDF; для CMS_WITH_DATA над nonce используем "" (данные — base64 nonce).
    document: { file: { mime: "", data: nonce } },
  };
}

/** Значение cookie jwt из ответа /api/auth. */
export function jwtFromSetCookie(h: Headers): string | null {
  const list: string[] =
    typeof (h as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function" ? (h as Headers & { getSetCookie: () => string[] }).getSetCookie() : [];
  const raw = list.length ? list : (h.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  for (const c of raw) {
    const m = c.match(/(?:^|\s)jwt=([^;]*)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Ошибки длинного опроса signURL → результат опроса. */
function mapPollError(e: unknown): { status: "waiting" } | { status: "expired" } | { status: "error"; error: string; retryable: boolean } {
  if (e instanceof AuthRequiredError) return { status: "error", error: e.message, retryable: false };
  if (e instanceof SigexError) {
    const m = e.sigexMessage ?? "";
    if (/expired|timeout/i.test(m)) return { status: "expired" };
    if (/not active|not found/i.test(m)) return { status: "expired" }; // VERIFY: «не активна» после истечения/завершения
    if (/Other endpoint connected/i.test(m)) return { status: "waiting" }; // другое соединение продолжает операцию
    if (e.httpStatus === null) return { status: "waiting" }; // разрыв длинного соединения — опрашиваем снова
    if (/eGov mobile data exchange failed/i.test(m)) return { status: "error", error: e.message, retryable: false };
    return { status: "error", error: e.message, retryable: (e.httpStatus ?? 500) >= 500 || /rate limit|queue/i.test(m) };
  }
  return { status: "error", error: (e as Error).message, retryable: true };
}

export class SigexAdapter implements SignAdapter {
  readonly mode = "sigex" as const;

  /** SIGN-02: процедура подписания с временным QR eGov (не постоянный QR проверки). */
  async start(p: { documentName: string; documentSha256: string; description: string }): Promise<SignProcedure> {
    const r = await call<EgovQrStart>(`${base()}/api/egovQr`, {
      method: "POST",
      json: {
        description: p.description.slice(0, 500),
        // whenDone.backUrl — опционально; возврат на платформу после подписи.
        whenDone: { backUrl: env.appUrl },
      },
    });
    const dataUrl = r.dataURL ?? r.dataURLAuto;
    const signUrl = r.signURL ?? r.signURLAuto;
    if (!dataUrl || !signUrl) throw new SigexError("SIGEX не вернул ссылки dataURL/signURL", 200, null, false);
    // Nonce входа: подпишется в той же процедуре. Неудача не мешает подписанию заключения.
    // SIGEX_COMBINED_AUTH=0 — аварийный выключатель: если eGov не примет пакет «заключение + вход»,
    // подписывается только заключение, а вход в SIGEX подтверждается отдельным QR.
    const combined = process.env.SIGEX_COMBINED_AUTH !== "0";
    const authNonce = combined ? await this.requestNonce().catch(() => null) : null;
    return { ...procedureFrom(r, dataUrl, signUrl), authNonce };
  }

  /** POST /api/auth {} → одноразовый nonce (base64). */
  async requestNonce(): Promise<string> {
    const r = await call<{ nonce?: string }>(`${base()}/api/auth`, { method: "POST", json: {} });
    if (!r.nonce) throw new SigexError("SIGEX не выдал nonce для входа", 200, null, false);
    return r.nonce;
  }

  /**
   * Вход в SIGEX по подписанному nonce (внутренний режим: SIGEX ставит cookie jwt).
   * Cookie возвращается вызывающему и нигде не сохраняется.
   */
  async authenticate(nonce: string, signatureB64: string): Promise<{ cookie: string; userId: string | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base()}/api/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, signature: signatureB64 }),
        signal: ctrl.signal,
        cache: "no-store",
      });
    } catch (e) {
      throw new AuthRequiredError(`Вход в SIGEX не выполнен: нет ответа (${(e as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
    let data: { message?: string; userId?: string } | null = null;
    try {
      data = (await res.json()) as { message?: string; userId?: string } | null;
    } catch {
      data = null; // не JSON
    }
    if (!res.ok || typeof data?.message === "string") {
      // Типичный случай — nonce истёк или уже использован; подпись заключения при этом сохранена.
      throw new AuthRequiredError(`SIGEX отклонил вход: ${data?.message ?? `HTTP ${res.status}`}. Подтвердите вход в SIGEX ещё раз — подпись заключения сохранена.`);
    }
    const cookie = jwtFromSetCookie(res.headers);
    if (!cookie) throw new AuthRequiredError("SIGEX не вернул сессию входа (cookie jwt). Подтвердите вход в SIGEX ещё раз.");
    return { cookie, userId: data?.userId ?? null };
  }

  /** Процедура eGov только для входа (продолжение после auth_required). */
  async startAuth(p: { description: string }): Promise<SignProcedure & { authNonce: string }> {
    const r = await call<EgovQrStart>(`${base()}/api/egovQr`, { method: "POST", json: { description: p.description.slice(0, 500), whenDone: { backUrl: env.appUrl } } });
    const dataUrl = r.dataURL ?? r.dataURLAuto;
    const signUrl = r.signURL ?? r.signURLAuto;
    if (!dataUrl || !signUrl) throw new SigexError("SIGEX не вернул ссылки dataURL/signURL", 200, null, false);
    const authNonce = await this.requestNonce();
    return { ...procedureFrom(r, dataUrl, signUrl), authNonce };
  }

  async submitAuth(proc: SignProcedure & { authNonce: string }): Promise<{ signUrl: string; expireAt?: Date | null }> {
    const body = { signMethod: "CMS_WITH_DATA", documentsToSign: [authDocument(1, proc.authNonce)] };
    const budget = Math.max(5_000, Math.min(LONG_POLL_MS, proc.expireAt.getTime() - Date.now()));
    const r = await call<{ expireAt?: number; signURL?: string; signURLAuto?: string }>(proc.dataUrl, { method: "POST", json: body, timeoutMs: budget });
    return { signUrl: r.signURL ?? r.signURLAuto ?? proc.signUrl, expireAt: toDate(r.expireAt) };
  }

  async pollAuth(signUrl: string): Promise<AuthPollResult> {
    let r: EgovSignResult;
    try {
      r = await call<EgovSignResult>(signUrl, { method: "GET", timeoutMs: LONG_POLL_MS });
    } catch (e) {
      return mapPollError(e);
    }
    if ((r.status ?? "").toUpperCase() === "CANCELED") return { status: "refused", reason: "Вход отменён в приложении eGov" };
    const data = (r.documentsToSign?.find((d) => String(d.id) === "1") ?? r.documentsToSign?.[0])?.document?.file?.data;
    if (!data) return { status: "error", error: "SIGEX вернул ответ без подписи входа", retryable: false };
    try {
      return { status: "signed", authSignature: b64(cmsBytesFrom(data)) };
    } catch {
      return { status: "error", error: "Подпись входа в ответе SIGEX не декодируется", retryable: false };
    }
  }

  /**
   * Передача документа: открепленная CMS (CMS_SIGN_ONLY) по точным байтам PDF.
   * Длинный запрос: SIGEX держит соединение, пока eGov mobile не скачает данные.
   * Разрыв без HTTP-ответа допускает повтор (обрабатывается последний запрос).
   */
  async submit(proc: SignProcedure, documentBytes: Uint8Array, meta: { documentName: string }): Promise<{ signUrl: string; expireAt?: Date | null }> {
    const sha = await sha256Hex(documentBytes);
    const pdfDoc = {
      id: 1,
      nameRu: meta.documentName,
      nameKz: meta.documentName,
      nameEn: meta.documentName,
      meta: [
        { name: "SHA-256", value: sha },
        { name: "Размер, байт", value: String(documentBytes.byteLength) },
      ],
      document: { file: { mime: "@file/pdf", data: b64(documentBytes) } },
    };
    // С nonce — одна процедура на два документа: заключение (открепленная CMS) и подтверждение входа.
    const body = proc.authNonce
      ? { signMethod: "MIX_SIGN", documentsToSign: [{ ...pdfDoc, signMethod: "CMS_SIGN_ONLY" }, { ...authDocument(2, proc.authNonce), signMethod: "CMS_WITH_DATA" }] }
      : { signMethod: "CMS_SIGN_ONLY", documentsToSign: [pdfDoc] };
    // Ждём не дольше срока процедуры и лимита функции; при таймауте процедура остаётся в силе —
    // фоновый опрос signURL продолжит работу, а повтор submit безопасен.
    const budget = Math.max(5_000, Math.min(LONG_POLL_MS, proc.expireAt.getTime() - Date.now()));
    // Таймаут без HTTP-ответа (телефон ещё не подключился) пробрасывается как SigexError с
    // httpStatus=null: данные НЕ доставлены, фоновый обработчик повторит отправку (это допускается
    // документацией — сервис обрабатывает последний запрос). См. isNotDelivered().
    const r = await call<{ expireAt?: number; signURL?: string; signURLAuto?: string }>(proc.dataUrl, { method: "POST", json: body, timeoutMs: budget });
    return { signUrl: r.signURL ?? r.signURLAuto ?? proc.signUrl, expireAt: toDate(r.expireAt) };
  }

  /**
   * SIGN-03: длинный опрос signURL. Таймаут без ответа → "waiting" (повторить позже, в пределах expireAt).
   */
  async poll(signUrl: string): Promise<PollResult> {
    let r: EgovSignResult;
    try {
      r = await call<EgovSignResult>(signUrl, { method: "GET", timeoutMs: LONG_POLL_MS });
    } catch (e) {
      return mapPollError(e);
    }
    if ((r.status ?? "").toUpperCase() === "CANCELED") return { status: "refused", reason: "Подписание отменено в приложении eGov" };
    const docs = r.documentsToSign ?? [];
    // Подпись заключения — документ id 1 (порядок в ответе не гарантирован), вход — id 2.
    const pdfEntry = docs.find((d) => String(d.id) === "1") ?? docs[0];
    const authEntry = docs.find((d) => String(d.id) === "2");
    const data = pdfEntry?.document?.file?.data;
    if (!data) return { status: "error", error: "SIGEX вернул ответ без подписи", retryable: false };
    let cms: Uint8Array;
    try {
      cms = cmsBytesFrom(data);
    } catch {
      return { status: "error", error: "Подпись в ответе SIGEX не декодируется", retryable: false };
    }
    // Минимальная проверка формата: DER SEQUENCE (0x30). CMS_SIGN_ONLY не содержит данных документа.
    if (cms.byteLength < 64 || cms[0] !== 0x30) return { status: "error", error: "Ответ SIGEX не похож на CMS-подпись", retryable: false };
    let authSignature: string | null = null;
    const authData = authEntry?.document?.file?.data;
    if (authData) {
      try {
        authSignature = b64(cmsBytesFrom(authData));
      } catch {
        authSignature = null; // подпись входа не обязательна — заключение подписано
      }
    }
    return {
      status: "signed",
      signature: {
        cms,
        authSignature,
        signatureType: "cms",
        // Ответ поставщика без самой подписи и данных (подпись хранится отдельным неизменяемым объектом).
        providerResponse: { signMethod: r.signMethod ?? null, version: r.version ?? null, documents: (r.documentsToSign ?? []).map((d) => ({ id: d.id ?? null, mime: d.document?.file?.mime ?? null })) },
      },
    };
  }

  /**
   * SIGN-06: регистрация в SIGEX с явной приватностью. Два шага:
   * POST /api (подпись) → documentId; POST /api/{id}/data (байты документа) — фиксация хешей.
   * Если второй шаг прервался, повтор вернёт "Document digests are already known" — это успех.
   */
  async register(p: { documentName: string; documentBytes: Uint8Array; cms: Uint8Array; private: true; authCookie?: string | null }): Promise<{ registrationId: string; response: unknown }> {
    const reg = await call<{ documentId?: string; signId?: number }>(`${base()}/api`, {
      method: "POST",
      cookie: p.authCookie,
      json: {
        title: p.documentName.slice(0, 200),
        description: "Заключение КЗППА РКА",
        signType: "cms",
        signature: b64(p.cms),
        settings: {
          private: true, // SIGN-06: приватность задаётся явно
          signaturesLimit: 0,
          switchToPrivateAfterLimitReached: false,
          unique: [],
          strictSignersRequirements: false,
          signersRequirements: [],
          publicWhileLessThanSignatures: 0,
          documentAccess: [],
          forceArchive: false,
          tempStorageAfterRegistration: 0,
        },
      },
    });
    if (!reg.documentId) throw new SigexError("SIGEX не вернул documentId", 200, null, true);
    const data = await this.finishData(reg.documentId, p.documentBytes, p.authCookie);
    return { registrationId: reg.documentId, response: { documentId: reg.documentId, signId: reg.signId ?? null, data } };
  }

  private async finishData(documentId: string, bytes: Uint8Array, cookie?: string | null) {
    try {
      const r = await call<{ documentId?: string; signedDataSize?: number; digests?: Record<string, string>; dataArchived?: boolean; tempStorage?: boolean }>(`${base()}/api/${encodeURIComponent(documentId)}/data`, { method: "POST", body: bytes, cookie });
      return { signedDataSize: r.signedDataSize ?? null, digests: r.digests ?? null, dataArchived: r.dataArchived ?? null };
    } catch (e) {
      if (e instanceof SigexError && /Document digests are already known/i.test(e.sigexMessage ?? "")) return { alreadyKnown: true };
      throw e;
    }
  }

  /**
   * SIGN-05: проверка зарегистрированной подписи по точным байтам документа (POST /api/{id}/verify)
   * и чтение данных подписанта (GET /api/{id}). Различаются «криптографически корректна»,
   * «проверка доверия завершена» и «проверка недоступна». Полномочия подписанта (председатель)
   * сверяются платформой отдельно — здесь authorityConfirmed = null.
   */
  async verify(p: { documentBytes: Uint8Array; cms: Uint8Array; registrationId?: string | null; authCookie?: string | null }): Promise<Verification> {
    const checkedAt = new Date().toISOString();
    if (!p.registrationId) {
      // Проверка CMS без регистрации в документации SIGEX не описана.
      return { cryptoValid: null, trustChecked: null, authorityConfirmed: null, signer: null, signedAt: null, checkedAt, unavailable: true, details: { reason: "Нет идентификатора регистрации SIGEX" } };
    }
    const id = encodeURIComponent(p.registrationId);
    try {
      const v = await call<{ documentId?: string; dataArchived?: boolean; tempStorage?: boolean }>(`${base()}/api/${id}/verify`, { method: "POST", body: p.documentBytes, cookie: p.authCookie });
      const info = await call<{ signatures?: SigexSignature[]; signaturesTotal?: number; settings?: { private?: boolean } }>(`${base()}/api/${id}`, { method: "GET", cookie: p.authCookie });
      // Подпись, зарегистрированная нами, — первая (документ зарегистрирован с ней). VERIFY: порядок signatures.
      const s = info.signatures?.[0] ?? null;
      const cn = s?.subjectStructure?.flat().find((x) => x.oid === "2.5.4.3" || x.name === "CN")?.value ?? s?.subject?.match(/CN=([^,]+)/)?.[1] ?? null;
      const iin = s?.userId?.replace(/^IIN/, "") ?? null;
      return {
        // Успешный /verify означает: сохранённые подписи соответствуют этим байтам и проверены на момент
        // регистрации по сохранённым OCSP/TSP (при несоответствии SIGEX возвращает ошибку).
        cryptoValid: true,
        trustChecked: !!(s?.ocsp && Object.keys(s.ocsp).length) && !!s?.tsp, // VERIFY: признак завершённой проверки доверия
        authorityConfirmed: null,
        signer: s ? { commonName: cn, iin, serial: s.serialNumber ?? null, notBefore: iso(s.from), notAfter: iso(s.until) } : null,
        signedAt: iso(s?.tsp?.timeStamp) ?? iso(s?.storedAt),
        checkedAt,
        unavailable: false,
        details: { provider: "sigex", documentId: v.documentId ?? p.registrationId, signaturesTotal: info.signaturesTotal ?? null, private: info.settings?.private ?? null, issuer: s?.issuer ?? null, signId: s?.signId ?? null, dataArchived: v.dataArchived ?? null },
      };
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      const m = e instanceof SigexError ? e.sigexMessage ?? "" : "";
      if (/does not correspond|Invalid signature|Bad signer certificate|Request size is not equal/i.test(m)) {
        return { cryptoValid: false, trustChecked: null, authorityConfirmed: null, signer: null, signedAt: null, checkedAt, unavailable: false, details: { provider: "sigex", error: m } };
      }
      // Сеть, OCSP/TSP недоступны и т. п. — «проверка недоступна», а не «недействительна» (BR-05).
      return { cryptoValid: null, trustChecked: null, authorityConfirmed: null, signer: null, signedAt: null, checkedAt, unavailable: true, details: { provider: "sigex", error: (e as Error).message } };
    }
  }

  /**
   * SIGN-07: сверка после неопределённого результата регистрации. POST /api/exported по подписи
   * возвращает documentId, если эта подпись уже зарегистрирована. Подпись из eGov не содержит
   * встроенных TSP/OCSP (их добавляет SIGEX), поэтому сопоставление идёт по самой CMS.
   * VERIFY: что /api/exported находит регистрацию по исходной (не экспортированной) CMS.
   * Если регистрация найдена, но хеши не зафиксированы — догружаем данные (идемпотентно).
   * Поиск по хешу документа в API не описан; при неудаче возвращается null.
   */
  async reconcile(p: { cms: Uint8Array; documentSha256: string; authCookie?: string | null }): Promise<{ registrationId: string } | null> {
    try {
      const r = await call<{ documentId?: string; signId?: number }>(`${base()}/api/exported`, { method: "POST", json: { signType: "cms", signature: b64(p.cms) }, cookie: p.authCookie });
      return r.documentId ? { registrationId: r.documentId } : null;
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      if (e instanceof SigexError && /not found|not registered/i.test(e.sigexMessage ?? "")) return null;
      throw e; // неизвестно — сверка не завершена, новую регистрацию не начинаем
    }
  }

  /** Догрузить данные документа к найденной регистрации (после сверки). */
  async ensureData(registrationId: string, documentBytes: Uint8Array, cookie?: string | null) {
    try {
      return await this.finishData(registrationId, documentBytes, cookie);
    } catch (e) {
      if (e instanceof SigexError && /This signature has already been submitted/i.test(e.sigexMessage ?? "")) return { alreadyKnown: true };
      throw e;
    }
  }
}
