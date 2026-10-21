import "server-only";
import { registerHandler, type OutboxRow } from "../outbox";
import { MailAuthError } from "@/integrations/mail/types";
import { ingestMessage, retryIncompleteAttachments, syncAccount } from "../services/intake";

/**
 * ARCH-03. Обработчики outbox для почты:
 *  - mail.sync          { accountId }                         — дочитать изменения ящика;
 *  - mail.fetch_message { accountId, providerMessageId } | { messageId } — принять письмо / повторить загрузку вложений.
 */

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

async function syncHandler(row: OutboxRow) {
  const p = row.payload as Record<string, unknown>;
  const accountId = str(p.accountId) ?? row.aggregateId;
  const r = await syncAccount(accountId, { budgetMs: typeof p.budgetMs === "number" ? p.budgetMs : 40_000 });
  if (r.error) return { status: "retry" as const, error: r.error, delayMs: 2 * 60_000 };
  // Незавершённый обход дочитает cron (не плодим новые события на каждую страницу).
  return { status: "done" as const, note: `Принято писем: ${r.processed}${r.remaining ? ", продолжение по расписанию" : ""}` };
}

async function fetchMessageHandler(row: OutboxRow) {
  const p = row.payload as Record<string, unknown>;
  try {
    const messageId = str(p.messageId);
    if (messageId) {
      const r = await retryIncompleteAttachments(messageId);
      if (!r.summary.complete && r.summary.pending > 0) {
        return { status: "retry" as const, error: `Не загружено: ${r.summary.pending}` };
      }
      return { status: "done" as const, note: r.summary.label };
    }
    const accountId = str(p.accountId) ?? row.aggregateId;
    const providerMessageId = str(p.providerMessageId);
    if (!providerMessageId) return { status: "dead" as const, error: "Не указан идентификатор письма" };
    const r = await ingestMessage(accountId, providerMessageId);
    return { status: "done" as const, note: r.skipped ?? r.intakeState };
  } catch (e) {
    if (e instanceof MailAuthError) return { status: "retry" as const, error: e.message, delayMs: 30 * 60_000 };
    return { status: "retry" as const, error: (e as Error).message };
  }
}

export function registerMailHandlers() {
  registerHandler("mail.sync", syncHandler);
  registerHandler("mail.fetch_message", fetchMessageHandler);
}
