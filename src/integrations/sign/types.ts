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
}

export interface ReceivedSignature {
  cms: Uint8Array; // CMS (detached) по точным байтам документа
  signatureType: "cms";
  providerResponse: unknown;
}

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
  register(params: { documentName: string; documentBytes: Uint8Array; cms: Uint8Array; private: true }): Promise<{ registrationId: string; response: unknown }>;
  verify(params: { documentBytes: Uint8Array; cms: Uint8Array; registrationId?: string | null }): Promise<Verification>;
  /** SIGN-07: найти регистрацию по подписи/идентификатору после неопределённого результата. */
  reconcile(params: { cms: Uint8Array; documentSha256: string }): Promise<{ registrationId: string } | null>;
}

export class AuthRequiredError extends Error {
  constructor(msg = "Authentication required: шаг требует авторизации у поставщика подписи") {
    super(msg);
    this.name = "AuthRequiredError";
  }
}
