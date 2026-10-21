/**
 * ARCH-07. Контракт почтового адаптера. Реализации: gmail (боевой), dry-run (тестовый,
 * ничего не отправляет наружу). Сервисы платформы зависят только от этого контракта.
 */

export interface MailAddress {
  email: string;
  name?: string | null;
}

export interface FetchedAttachmentMeta {
  partId: string;
  providerAttachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId?: string | null;
  parentPartId?: string | null;
}

export interface FetchedMessage {
  providerMessageId: string;
  internetMessageId: string | null;
  threadId: string | null;
  labelIds: string[];
  sentAt: Date | null;
  receivedAt: Date | null; // internalDate — фактическое получение ящиком
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: FetchedAttachmentMeta[];
  authResults: { spf?: string; dkim?: string; dmarc?: string; raw?: string | null };
  raw?: Uint8Array | null; // исходный MIME (EML) при наличии
}

export interface ChangesPage {
  messageIds: string[];
  nextCursor: string | null; // historyId или pageToken
  cursorExpired: boolean; // курсор устарел → контролируемая повторная синхронизация (MAIL-03)
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string | null;
  attachments: { filename: string; mimeType: string; bytes: Uint8Array }[];
  /** Заголовок для сверки отправленного (OUT-06): X-KZPPA-Outgoing-Id. */
  outgoingId: string;
  inReplyTo?: string | null;
  threadId?: string | null;
}

export interface SendResult {
  providerMessageId: string;
  threadId: string | null;
  internetMessageId: string | null;
}

export interface MailAdapter {
  readonly mode: "gmail" | "dry-run";
  fetchChanges(accountId: string, cursor: string | null): Promise<ChangesPage>;
  fetchMessage(accountId: string, providerMessageId: string): Promise<FetchedMessage>;
  fetchAttachment(accountId: string, providerMessageId: string, providerAttachmentId: string): Promise<Uint8Array>;
  createOrUpdateDraft(accountId: string, mail: OutgoingMail, existingDraftId?: string | null): Promise<{ draftId: string }>;
  /** Отправка только утверждённого пакета. Таймаут после возможного принятия → бросает UnknownSendResultError. */
  sendApprovedPackage(accountId: string, mail: OutgoingMail, draftId?: string | null): Promise<SendResult>;
  /** Поиск отправленного по X-KZPPA-Outgoing-Id (OUT-06/07, OUT-09). */
  reconcileSent(accountId: string, outgoingId: string): Promise<SendResult | null>;
  readDeliveryEvents(accountId: string, sinceCursor: string | null): Promise<{ bounces: { originalMessageId: string | null; outgoingId: string | null; reason: string }[] }>;
}

export class UnknownSendResultError extends Error {
  constructor(msg = "Результат отправки неизвестен: требуется сверка отправленных") {
    super(msg);
    this.name = "UnknownSendResultError";
  }
}

export class MailAuthError extends Error {
  constructor(msg = "Почтовое подключение требует повторного входа") {
    super(msg);
    this.name = "MailAuthError";
  }
}
