import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { ChangesPage, FetchedMessage, MailAdapter, OutgoingMail, SendResult } from "./types";
import { buildMimeMessage } from "./mime";

/**
 * ТЕСТОВЫЙ ТРАНСПОРТ (ARCH-02, MIG-06). НИЧЕГО НЕ ОТПРАВЛЯЕТ НАРУЖУ.
 * «Отправленные» письма получают синтетические идентификаторы `dry-<uuid>` и запоминаются
 * в памяти процесса; результат отправки хранится платформой в outgoings/assignments (БД),
 * откуда его и находит reconcileSent. Входящих писем этот транспорт не получает.
 * Интерфейс обязан явно показывать, что включён тестовый режим (integrationModes().mail).
 */

export const DRY_RUN_PREFIX = "dry-";

interface DrySent {
  outgoingId: string;
  result: SendResult;
  mime: string;
  at: Date;
}

const g = globalThis as unknown as { __kzppaDrySent?: Map<string, DrySent>; __kzppaDryDrafts?: Map<string, string> };
const sentByOutgoing = (g.__kzppaDrySent ??= new Map());
const drafts = (g.__kzppaDryDrafts ??= new Map());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DryRunMailAdapter implements MailAdapter {
  readonly mode = "dry-run" as const;

  async fetchChanges(_accountId: string, cursor: string | null): Promise<ChangesPage> {
    return { messageIds: [], nextCursor: cursor, cursorExpired: false };
  }

  async fetchMessage(_accountId: string, providerMessageId: string): Promise<FetchedMessage> {
    throw new Error(`Тестовый транспорт не получает письма (запрошено ${providerMessageId})`);
  }

  async fetchAttachment(): Promise<Uint8Array> {
    throw new Error("Тестовый транспорт не получает вложения");
  }

  async createOrUpdateDraft(_accountId: string, mail: OutgoingMail, existingDraftId?: string | null): Promise<{ draftId: string }> {
    const mime = buildMimeMessage(mail); // те же проверки заголовков, что и в боевом транспорте
    const draftId = existingDraftId ?? `${DRY_RUN_PREFIX}draft-${crypto.randomUUID()}`;
    drafts.set(draftId, mime);
    return { draftId };
  }

  async sendApprovedPackage(_accountId: string, mail: OutgoingMail, draftId?: string | null): Promise<SendResult> {
    const prev = sentByOutgoing.get(mail.outgoingId);
    if (prev) return prev.result; // повтор той же отправки не создаёт второе письмо
    const id = crypto.randomUUID();
    const result: SendResult = {
      providerMessageId: `${DRY_RUN_PREFIX}${id}`,
      threadId: mail.threadId ?? `${DRY_RUN_PREFIX}thread-${id}`,
      internetMessageId: `<${DRY_RUN_PREFIX}${id}@dry-run.kzppa.invalid>`,
    };
    const mime = buildMimeMessage(mail, { messageId: result.internetMessageId });
    sentByOutgoing.set(mail.outgoingId, { outgoingId: mail.outgoingId, result, mime, at: new Date() });
    if (draftId) drafts.delete(draftId);
    console.info(`[mail:dry-run] ТЕСТ: письмо НЕ отправлено наружу (outgoing ${mail.outgoingId}, ${mail.to.length} получат.)`);
    return result;
  }

  async reconcileSent(_accountId: string, outgoingId: string): Promise<SendResult | null> {
    const mem = sentByOutgoing.get(outgoingId);
    if (mem) return mem.result;
    if (!UUID_RE.test(outgoingId)) return null;
    const o = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, outgoingId) });
    if (o?.providerMessageId?.startsWith(DRY_RUN_PREFIX)) {
      return { providerMessageId: o.providerMessageId, threadId: o.providerThreadId, internetMessageId: o.internetMessageId };
    }
    const a = await db.query.assignments.findFirst({ where: eq(schema.assignments.outgoingId, outgoingId) });
    if (a?.sentProviderId?.startsWith(DRY_RUN_PREFIX)) {
      return { providerMessageId: a.sentProviderId, threadId: null, internetMessageId: null };
    }
    return null;
  }

  async readDeliveryEvents(): Promise<{ bounces: { originalMessageId: string | null; outgoingId: string | null; reason: string }[] }> {
    return { bounces: [] };
  }
}

/** Для тестов и отладочной страницы: MIME последнего «отправленного» письма. */
export function dryRunSentMime(outgoingId: string): string | null {
  return sentByOutgoing.get(outgoingId)?.mime ?? null;
}
