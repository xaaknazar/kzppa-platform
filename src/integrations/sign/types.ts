/**
 * ARCH-07, SIGN-01..10. Контракт адаптера подписи: start, submit, receiveAndPersist,
 * register, verify, reconcile. Закрытый ключ и пароль председателя платформа не хранит.
 * Реализации: sigex (eGov Mobile/Business через SIGEX API), dry-run (тестовая, без юридической силы).
 */

export interface SignProcedure {
  procedureId: string;
  /** Временный QR/ссылка сеанса eGov — НЕ постоянный QR проверки (SIGN-02). */
  qrCodeDataUrl: string | null;
  mobileLink: string | null; // eGov Mobile deep link
  businessLink: string | null; // eGov Business
  dataUrl: string; // куда передать данные
  signUrl: string; // откуда получить подпись
  expireAt: Date;
  /**
   * Одноразовый nonce SIGEX /api/auth. Подписывается председателем в той же процедуре eGov,
   * что и заключение: подпись nonce даёт платформе вход в SIGEX от имени председателя
   * для регистрации подписи (SIGN-06) без mTLS и без хранения ключей. null — не получен.
   */
  authNonce?: string | null;
}

export interface ReceivedSignature {
  cms: Uint8Array; // CMS (detached) по точным байтам документа
  signatureType: "cms";
  providerResponse: unknown;
  /** Подпись nonce входа (base64 DER CMS) — одноразовый токен, в журналы не пишется. */
  authSignature?: string | null;
}

/** Результат опроса процедуры «только вход в SIGEX». */
export type AuthPollResult =
  | { status: "signed"; authSignature: string }
  | { status: "waiting"; expireAt?: Date | null }
  | { status: "expired" }
  | { status: "refused"; reason?: string }
  | { status: "error"; error: string; retryable: boolean };

export type PollResult =
  | { status: "signed"; signature: ReceivedSignature }
  | { status: "waiting"; expireAt?: Date | null; signUrl?: string | null }
  | { status: "expired" }
  | { status: "refused"; reason?: string }
  | { status: "error"; error: string; retryable: boolean };

export interface Verification {
  cryptoValid: boolean | null; // подпись соответствует точным байтам
  trustChecked: boolean | null; // проверка доверия/отзыва завершена
  authorityConfirmed: boolean | null; // полномочия подписанта
  signer: { commonName?: string | null; iin?: string | null; serial?: string | null; notBefore?: string | null; notAfter?: string | null } | null;
  signedAt: string | null;
  checkedAt: string;
  unavailable: boolean; // «проверка недоступна» ≠ «недействительна» (SIGN-05, BR-05)
  details?: unknown;
}

export interface SignAdapter {
  readonly mode: "sigex" | "dry-run";
  start(params: { documentName: string; documentSha256: string; description: string }): Promise<SignProcedure>;
  submit(proc: SignProcedure, documentBytes: Uint8Array, meta: { documentName: string }): Promise<{ signUrl: string; expireAt?: Date | null }>;
  /** Длинный опрос/повторы до получения результата. Вызывается фоновым процессом (SIGN-03). */
  poll(signUrl: string): Promise<PollResult>;
  /** Регистрация в SIGEX с явной приватностью (SIGN-06). Ошибка авторизации → AuthRequiredError. */
  register(params: { documentName: string; documentBytes: Uint8Array; cms: Uint8Array; private: true; authCookie?: string | null }): Promise<{ registrationId: string; response: unknown }>;
  verify(params: { documentBytes: Uint8Array; cms: Uint8Array; registrationId?: string | null; authCookie?: string | null }): Promise<Verification>;
  /** SIGN-07: найти регистрацию по подписи/идентификатору после неопределённого результата. */
  reconcile(params: { cms: Uint8Array; documentSha256: string; authCookie?: string | null }): Promise<{ registrationId: string } | null>;
  /**
   * Вход в SIGEX по подписанному nonce. Возвращает значение сессии (cookie jwt), которое живёт
   * только в памяти обработчика и никогда не сохраняется. Отказ → AuthRequiredError.
   */
  authenticate(nonce: string, signatureB64: string): Promise<{ cookie: string; userId: string | null }>;
  /** Отдельная процедура eGov только для входа (продолжение после auth_required): новый nonce. */
  startAuth(params: { description: string }): Promise<SignProcedure & { authNonce: string }>;
  submitAuth(proc: SignProcedure & { authNonce: string }): Promise<{ signUrl: string; expireAt?: Date | null }>;
  pollAuth(signUrl: string): Promise<AuthPollResult>;
}

export class AuthRequiredError extends Error {
  constructor(msg = "Authentication required: шаг требует авторизации у поставщика подписи") {
    super(msg);
    this.name = "AuthRequiredError";
  }
}
