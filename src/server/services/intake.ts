import "server-only";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { getMailAdapter, cursorHasMore } from "@/integrations/mail";
import { MailAuthError, type FetchedAttachmentMeta, type FetchedMessage } from "@/integrations/mail/types";
import { GmailApiError, MAX_MESSAGE_BYTES } from "@/integrations/mail/gmail";
import { assessSource, cleanText, extractRawHeader, htmlToText, inspectArchive, type SourceCheck } from "@/integrations/mail/mime";
import { summarizeManifest, type AttachmentStatus, type ManifestItem, type ManifestSummary } from "@/domain/manifest";
import { detectLanguage } from "@/domain/language";
import { matchCase, parseSubject, type CaseIndexEntry, type MatchDecision } from "@/domain/matching";
import { audit, SERVICE_ACTOR } from "../audit";
import { enqueue } from "../outbox";
import { putImmutable } from "../storage";

/**
 * MAIL-03..10, CASE-01..04, ARCH-03. Конвейер приёма почты:
 *   syncAccount → (постранично, с контрольной точкой после каждой страницы) → ingestMessage
 *   ingestMessage: запись письма и манифеста MIME → загрузка и проверка вложений →
 *                  язык → сопоставление с делом → автоприобщение / очередь разбора.
 * Все шаги идемпотентны: уникальные (account_id, provider_message_id) и (message_id, part_id)
 * исключают дубли при повторе страницы, повторной синхронизации и параллельном запуске.
 */

const ATTACHMENT_LIMIT = MAX_MESSAGE_BYTES; // 25 МБ — лимит Gmail для вложения
const ARCHIVE_REASON = "Архив сохранён целиком; распаковка — отдельный безопасный шаг";
const OFFICE_EXT = /\.(docx|docm|dotx|xlsx|xlsm|pptx|odt|ods|odp)$/i;
function isOfficeDocument(filename: string | null | undefined, mime: string | null | undefined) {
  return OFFICE_EXT.test(filename ?? "") || /openxmlformats|opendocument/i.test(mime ?? "");
}
const AV_DISABLED_REASON = "Антивирусная проверка не настроена";
/** Ручной/адресный повтор (MAIL-08) пробует и «недоступные» позиции; cron — только pending (см. listIncompleteMessages). */
const RETRYABLE: AttachmentStatus[] = ["pending", "downloading", "stored", "unavailable"];
/** Состояния, в которых итог приёма ещё вычисляется автоматически (решение человека не перезаписывается). */
const AUTO_STATES = ["discovered", "loading", "incomplete", "verified", "matched"];

/* ────────────────────────────── Антивирус (MAIL-07) ────────────────────────────── */

export type ScanResult = { status: "clean" | "infected" | "error" | "not_scanned"; detail?: string };
export type Scanner = (bytes: Uint8Array, meta: { filename: string; mimeType: string }) => Promise<ScanResult>;

/** Антивирусного движка в среде нет: проверка честно отмечается как «не выполнена». */
let scanner: Scanner = async () => ({ status: "not_scanned" });

export function setAttachmentScanner(s: Scanner) {
  scanner = s;
}

export async function scanBytes(bytes: Uint8Array, meta: { filename: string; mimeType: string }): Promise<ScanResult> {
  try {
    return await scanner(bytes, meta);
  } catch (e) {
    return { status: "error", detail: (e as Error).message };
  }
}

/* ────────────────────────────── Синхронизация (MAIL-03) ────────────────────────────── */

export interface SyncResult {
  processed: number;
  remaining: boolean;
  skipped?: string;
  error?: string;
}

const running = new Map<string, Promise<SyncResult>>();

/**
 * Синхронизация ящика в пределах бюджета времени (Vercel). Курсор сохраняется после КАЖДОЙ
 * полностью обработанной страницы: авария не откатывает прогресс к началу (ARCH-03), а
 * повтор незавершённой страницы безопасен благодаря дедупликации.
 * Параллельный запуск в том же процессе не начинается; между процессами защищает идемпотентность.
 */
export function syncAccount(accountId: string, opts: { budgetMs?: number } = {}): Promise<SyncResult> {
  const cur = running.get(accountId);
  if (cur) return Promise.resolve({ processed: 0, remaining: true, skipped: "Синхронизация уже выполняется" });
  const p = doSync(accountId, opts.budgetMs ?? 50_000).finally(() => running.delete(accountId));
  running.set(accountId, p);
  return p;
}

async function doSync(accountId: string, budgetMs: number): Promise<SyncResult> {
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const adapter = getMailAdapter();
  let acc = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.id, accountId) });
  if (!acc) return { processed: 0, remaining: false, skipped: "Подключение не найдено" };
  if (acc.state === "disabled" || acc.state === "login_required") {
    return { processed: 0, remaining: false, skipped: `Подключение в состоянии ${acc.state}` };
  }
  if (adapter.mode === "gmail" && !acc.refreshTokenEnc) return { processed: 0, remaining: false, skipped: "Нет токена" };

  await db.update(schema.mailAccounts).set({ state: "syncing" }).where(eq(schema.mailAccounts.id, accountId));

  let processed = 0;
  let remaining = false;
  let resets = 0;
  const failures: string[] = [];
  try {
    for (let guard = 0; guard < 10_000; guard++) {
      if (left() < 3_000) {
        remaining = true;
        break;
      }
      const initial = !acc.initialSyncDone;
      const cursor = initial ? acc.initialSyncCursor : acc.historyId;
      const page = await adapter.fetchChanges(accountId, cursor);

      if (page.cursorExpired) {
        // MAIL-03: устаревший курсор → контролируемая повторная синхронизация периода.
        if (++resets > 1) throw new Error("Курсор синхронизации повторно устарел");
        await db
          .update(schema.mailAccounts)
          .set({ initialSyncDone: false, initialSyncCursor: null, historyId: null, lastError: "Курсор устарел: выполняется повторная синхронизация" })
          .where(eq(schema.mailAccounts.id, accountId));
        await db.transaction((tx) =>
          audit(tx, {
            orgId: acc!.organizationId,
            actor: SERVICE_ACTOR,
            action: "mail.resync",
            objectType: "mail_account",
            objectId: accountId,
            basis: "Курсор журнала изменений устарел (MAIL-03)",
            externalIds: { cursor },
          }),
        );
        acc = { ...acc, initialSyncDone: false, initialSyncCursor: null, historyId: null };
        continue;
      }

      let interrupted = false;
      for (const id of page.messageIds) {
        if (left() < 5_000) {
          interrupted = true; // страница будет перечитана — уже принятые письма пропустятся
          break;
        }
        try {
          const r = await ingestMessage(accountId, id);
          if (r.created) processed++;
        } catch (e) {
          if (e instanceof MailAuthError) throw e;
          // Письмо не потеряется: повтор через outbox (ARCH-03), курсор можно двигать дальше.
          failures.push(`${id}: ${(e as Error).message}`);
          await db.transaction((tx) =>
            enqueue(tx, {
              orgId: acc!.organizationId,
              type: "mail.fetch_message",
              aggregateType: "mail_account",
              aggregateId: accountId,
              payload: { accountId, providerMessageId: id },
              idempotencyKey: `mail.fetch_message:${accountId}:${id}`,
              delayMs: 60_000,
            }),
          );
        }
      }
      if (interrupted) {
        remaining = true;
        break;
      }

      // Контрольная точка после страницы.
      const more = cursorHasMore(page.nextCursor);
      const patch: Partial<typeof schema.mailAccounts.$inferInsert> = { lastSyncAt: new Date() };
      if (initial) {
        if (more) patch.initialSyncCursor = page.nextCursor;
        else {
          patch.initialSyncDone = true;
          patch.initialSyncCursor = null;
          patch.historyId = page.nextCursor;
        }
      } else {
        patch.historyId = page.nextCursor;
      }
      await db.update(schema.mailAccounts).set(patch).where(eq(schema.mailAccounts.id, accountId));
      acc = { ...acc, ...patch } as typeof acc;

      if (!more) {
        if (initial && page.nextCursor) continue; // первичный обход завершён — догоняем журнал изменений
        break;
      }
    }

    const state = failures.length ? "delayed" : remaining ? "syncing" : "up_to_date";
    await db
      .update(schema.mailAccounts)
      .set({
        state,
        lastSyncAt: new Date(),
        lastError: failures.length ? `Не загружено писем: ${failures.length}; повтор запланирован` : null,
      })
      .where(eq(schema.mailAccounts.id, accountId));
    return { processed, remaining };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof MailAuthError) {
      // Состояние login_required уже выставил адаптер.
      await db.update(schema.mailAccounts).set({ lastError: msg }).where(eq(schema.mailAccounts.id, accountId));
      return { processed, remaining: false, error: msg };
    }
    const quota = e instanceof GmailApiError && (e.status === 429 || /quota|rateLimit/i.test(e.reason ?? ""));
    await db
      .update(schema.mailAccounts)
      .set({ state: quota ? "quota" : "delayed", lastError: msg.slice(0, 1000), lastSyncAt: new Date() })
      .where(eq(schema.mailAccounts.id, accountId));
    return { processed, remaining: true, error: msg };
  }
}

/* ────────────────────────────── Приём письма ────────────────────────────── */

export interface IngestResult {
  messageId: string | null;
  created: boolean;
  intakeState?: string;
  skipped?: string;
}

const SKIP_LABELS = ["SPAM", "TRASH", "DRAFT", "CHAT"];

/** Идемпотентный приём одного письма по provider message id. */
export async function ingestMessage(accountId: string, providerMessageId: string): Promise<IngestResult> {
  const existing = await db.query.messages.findFirst({
    where: and(eq(schema.messages.accountId, accountId), eq(schema.messages.providerMessageId, providerMessageId)),
  });
  if (existing) {
    if (["discovered", "loading", "incomplete"].includes(existing.intakeState)) {
      const r = await retryIncompleteAttachments(existing.id);
      return { messageId: existing.id, created: false, intakeState: r.intakeState };
    }
    return { messageId: existing.id, created: false, intakeState: existing.intakeState };
  }

  const acc = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.id, accountId) });
  if (!acc) throw new Error("Почтовое подключение не найдено");
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, acc.organizationId) });
  if (!org) throw new Error("Организация не найдена");
  const orgId = org.id;

  const adapter = getMailAdapter();
  const fm = await adapter.fetchMessage(accountId, providerMessageId);
  // MAIL-04: спам, корзина и черновики не регистрируются автоматически.
  if (fm.labelIds.some((l) => SKIP_LABELS.includes(l))) return { messageId: null, created: false, skipped: "Спам/корзина/черновик" };

  const direction: "in" | "out" = fm.labelIds.includes("SENT") || fm.from.email === acc.email.toLowerCase() ? "out" : "in";

  // Исходный EML — неизменяемый объект (доказательство поступления).
  let rawBlobId: string | null = null;
  let rawNote: string | null = null;
  if (fm.raw && fm.raw.byteLength) {
    try {
      rawBlobId = (await putImmutable(orgId, fm.raw, "message/rfc822", { size: fm.raw.byteLength })).id;
    } catch (e) {
      rawNote = `Исходный EML не сохранён: ${(e as Error).message}`;
    }
  } else {
    rawNote = "Исходный EML не получен (превышен лимит 25 МБ или недоступен)";
  }

  const source: SourceCheck = assessSource({
    from: fm.from,
    replyTo: fm.replyTo,
    auth: fm.authResults,
    officialRkaAddress: org.rkaAddress,
    direction,
  });
  const sourceCheck = {
    ...source,
    authResults: fm.authResults,
    ...(rawNote ? { warnings: [...source.warnings, rawNote] } : {}),
  };

  const bodyText = cleanText(fm.bodyText || (fm.bodyHtml ? htmlToText(fm.bodyHtml) : ""));
  const outgoingHeader = direction === "out" ? extractRawHeader(fm.raw, "X-KZPPA-Outgoing-Id") : null;
  // Служебные письма платформы (коды входа, проверка подключения) не являются материалами дел.
  if (outgoingHeader?.startsWith("svc-")) return { messageId: null, created: false, skipped: "Служебное письмо платформы" };

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.messages)
      .values({
        organizationId: orgId,
        accountId,
        providerMessageId: fm.providerMessageId,
        internetMessageId: fm.internetMessageId,
        threadId: fm.threadId,
        direction,
        sentAt: fm.sentAt,
        receivedAt: fm.receivedAt,
        fromAddr: fm.from.email || "(без адреса)",
        fromName: fm.from.name ? cleanText(fm.from.name, 500) : null,
        toAddrs: fm.to.map((a) => a.email.toLowerCase()),
        ccAddrs: fm.cc.map((a) => a.email.toLowerCase()),
        replyTo: fm.replyTo ? cleanText(fm.replyTo, 1000) : null,
        subject: cleanText(fm.subject, 2000),
        bodyText,
        bodyHtml: fm.bodyHtml ? cleanText(fm.bodyHtml) : null,
        rawBlobId,
        labelIds: fm.labelIds,
        sourceCheck,
        intakeState: "loading",
      })
      .onConflictDoNothing({ target: [schema.messages.accountId, schema.messages.providerMessageId] })
      .returning();
    if (!row) return null; // параллельный приём того же письма
    if (fm.attachments.length) {
      await tx
        .insert(schema.attachments)
        .values(fm.attachments.map((a) => attachmentRow(orgId, row.id, a)))
        .onConflictDoNothing({ target: [schema.attachments.messageId, schema.attachments.partId] });
    }
    return row;
  });
  if (!inserted) {
    const again = await db.query.messages.findFirst({
      where: and(eq(schema.messages.accountId, accountId), eq(schema.messages.providerMessageId, providerMessageId)),
    });
    return { messageId: again?.id ?? null, created: false, intakeState: again?.intakeState };
  }

  // Загрузка обязательных вложений (MAIL-07).
  const rows = await db.query.attachments.findMany({ where: eq(schema.attachments.messageId, inserted.id) });
  for (const a of rows) {
    if (a.inline || a.parentPartId) continue;
    await downloadAttachment(orgId, accountId, inserted.providerMessageId, a);
  }

  const state = await finalizeIntake(inserted.id, {
    direction,
    outgoingHeader,
    externalIds: { providerMessageId: fm.providerMessageId, threadId: fm.threadId, internetMessageId: fm.internetMessageId },
    first: true,
  });
  return { messageId: inserted.id, created: true, intakeState: state };
}

function attachmentRow(orgId: string, messageId: string, a: FetchedAttachmentMeta): typeof schema.attachments.$inferInsert {
  let reason: string | null = null;
  if (a.inline) reason = "Встроенное изображение (подпись, логотип) — не входит в обязательный состав";
  else if (a.parentPartId) reason = "Элемент вложенного письма; сохраняется в составе контейнера";
  return {
    organizationId: orgId,
    messageId,
    partId: a.partId,
    providerAttachmentId: a.providerAttachmentId,
    filename: cleanText(a.filename, 500) || `attachment-${a.partId}`,
    mimeType: a.mimeType,
    size: a.size,
    inline: a.inline,
    parentPartId: a.parentPartId ?? null,
    status: "pending",
    reason,
  };
}

type AttachmentRow = typeof schema.attachments.$inferSelect;

/** Скачать → размер → антивирус → контейнер → неизменяемое хранилище (с перечитыванием и SHA-256). */
async function downloadAttachment(orgId: string, accountId: string, providerMessageId: string, a: AttachmentRow): Promise<AttachmentStatus> {
  const set = async (patch: Partial<typeof schema.attachments.$inferInsert>) => {
    await db.update(schema.attachments).set(patch).where(eq(schema.attachments.id, a.id));
  };
  const attempts = a.attempts + 1;
  if (a.size > ATTACHMENT_LIMIT) {
    await set({ status: "unavailable", reason: `Размер ${formatMb(a.size)} превышает лимит 25 МБ: требуется получить файл иным способом или исключить с основанием`, attempts });
    return "unavailable";
  }
  if (!a.providerAttachmentId && a.size > 0) {
    await set({ status: "unavailable", reason: "Провайдер не предоставил содержимое части письма", attempts });
    return "unavailable";
  }
  await set({ status: "downloading", attempts });
  try {
    const bytes = a.providerAttachmentId
      ? await getMailAdapter().fetchAttachment(accountId, providerMessageId, a.providerAttachmentId)
      : new Uint8Array(0);
    if (bytes.byteLength > ATTACHMENT_LIMIT) {
      await set({ status: "unavailable", reason: `Размер ${formatMb(bytes.byteLength)} превышает лимит 25 МБ` });
      return "unavailable";
    }
    if (a.size && bytes.byteLength !== a.size) {
      await set({ status: "pending", reason: `Размер не совпал: заявлено ${a.size} байт, получено ${bytes.byteLength}; повтор загрузки` });
      return "pending";
    }

    const reasons: string[] = [];
    let status: AttachmentStatus = "verified";

    const scan = await scanBytes(bytes, { filename: a.filename, mimeType: a.mimeType });
    if (scan.status === "infected") {
      status = "quarantine";
      reasons.push(`Антивирус: обнаружена угроза${scan.detail ? ` (${scan.detail})` : ""}`);
    } else if (scan.status === "error") {
      status = "quarantine";
      reasons.push(`Ошибка антивирусной проверки${scan.detail ? `: ${scan.detail}` : ""}`);
    } else if (scan.status === "not_scanned") {
      reasons.push(AV_DISABLED_REASON);
    }

    const arc = inspectArchive(bytes);
    if (arc.kind) {
      if (arc.encrypted) {
        if (status === "verified") status = "encrypted";
        reasons.unshift("Архив защищён паролем: нужен пароль от заявителя или исключение с основанием");
      } else if (arc.corrupt) {
        if (status === "verified") status = "rejected";
        reasons.unshift("Архив повреждён или неполон: требуется повторное получение");
      } else if (!isOfficeDocument(a.filename, a.mimeType)) {
        // DOCX/XLSX/ODT — это ZIP-контейнеры, но не архивы для распаковки.
        reasons.unshift(ARCHIVE_REASON);
      }
    }

    const blob = await putImmutable(orgId, bytes, a.mimeType || "application/octet-stream", { size: bytes.byteLength });
    await set({ status, sha256: blob.sha256, blobId: blob.id, size: bytes.byteLength, reason: reasons.join("; ") || null });
    return status;
  } catch (e) {
    if (e instanceof MailAuthError) {
      await set({ status: "pending", reason: "Почта требует повторного подключения; загрузка будет повторена" });
      throw e;
    }
    if (e instanceof GmailApiError && (e.status === 404 || e.status === 400)) {
      await set({ status: "unavailable", reason: `Вложение недоступно у провайдера (HTTP ${e.status})` });
      return "unavailable";
    }
    await set({ status: "pending", reason: `Ошибка загрузки: ${(e as Error).message}`.slice(0, 1000) });
    return "pending";
  }
}

const formatMb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;

function toItem(a: AttachmentRow): ManifestItem {
  return {
    partId: a.partId,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    sha256: a.sha256,
    inline: a.inline,
    parentPartId: a.parentPartId,
    status: a.status as AttachmentStatus,
    reason: a.reason,
    exclusion: a.exclusion as ManifestItem["exclusion"],
  };
}

/** MAIL-08 / AT-01: повторная загрузка только непроверенных позиций, без дублей; пересчёт состояния. */
export async function retryIncompleteAttachments(messageId: string): Promise<{ intakeState: string; summary: ManifestSummary }> {
  const msg = await db.query.messages.findFirst({ where: eq(schema.messages.id, messageId) });
  if (!msg) throw new Error("Письмо не найдено");
  const rows = await db.query.attachments.findMany({ where: eq(schema.attachments.messageId, messageId) });
  for (const a of rows) {
    if (a.inline || a.parentPartId) continue;
    if (!RETRYABLE.includes(a.status as AttachmentStatus)) continue;
    await downloadAttachment(msg.organizationId, msg.accountId, msg.providerMessageId, a);
  }
  const fresh = await db.query.attachments.findMany({ where: eq(schema.attachments.messageId, messageId) });
  const summary = summarizeManifest(fresh.map(toItem));
  if (!AUTO_STATES.includes(msg.intakeState)) {
    // Решение уже принято человеком (или письмо приобщено) — фиксируем только факт повтора.
    await db.transaction((tx) =>
      audit(tx, {
        orgId: msg.organizationId,
        actor: SERVICE_ACTOR,
        action: "mail.retry_attachments",
        objectType: "message",
        objectId: msg.id,
        caseId: msg.caseId,
        after: { manifest: summary.label, complete: summary.complete },
        externalIds: { providerMessageId: msg.providerMessageId, threadId: msg.threadId },
      }),
    );
    return { intakeState: msg.intakeState, summary };
  }
  const intakeState = await finalizeIntake(messageId, {
    direction: msg.direction as "in" | "out",
    outgoingHeader: null,
    externalIds: { providerMessageId: msg.providerMessageId, threadId: msg.threadId, internetMessageId: msg.internetMessageId },
    first: false,
  });
  return { intakeState, summary };
}

/* ────────────────────────────── Итог приёма и сопоставление ────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function buildCaseIndex(tx: Tx, orgId: string, threadId: string | null): Promise<CaseIndexEntry[]> {
  const rows = await tx
    .select({
      id: schema.cases.id,
      number: schema.cases.number,
      rkaNumber: schema.cases.rkaNumber,
      applicant: schema.cases.applicant,
      aliases: schema.cases.applicantAliases,
      executorEmail: schema.users.email,
    })
    .from(schema.cases)
    .leftJoin(schema.users, eq(schema.users.id, schema.cases.executorId))
    .where(and(eq(schema.cases.organizationId, orgId), ne(schema.cases.state, "cancelled")));
  const threadCases = new Set<string>();
  if (threadId) {
    const t = await tx
      .selectDistinct({ caseId: schema.messages.caseId })
      .from(schema.messages)
      .where(and(eq(schema.messages.organizationId, orgId), eq(schema.messages.threadId, threadId), isNotNull(schema.messages.caseId)));
    t.forEach((r) => r.caseId && threadCases.add(r.caseId));
  }
  return rows.map((r) => ({
    caseId: r.id,
    caseNumber: r.number,
    rkaNumber: r.rkaNumber,
    applicantFullName: r.applicant,
    applicantAliases: r.aliases ?? [],
    executorEmail: r.executorEmail ?? null,
    threadIds: threadId && threadCases.has(r.id) ? [threadId] : [],
  }));
}

type CasesModule = typeof import("@/server/services/cases");
let casesModule: Promise<CasesModule | null> | null = null;
function loadCases(): Promise<CasesModule | null> {
  casesModule ??= import("@/server/services/cases").catch((e) => {
    console.warn("Сервис дел недоступен, автоприобщение отключено:", (e as Error).message);
    casesModule = null;
    return null;
  });
  return casesModule;
}

/**
 * Вычислить и записать итог приёма: манифест, язык, сопоставление, задачи разбора,
 * автоприобщение при однозначном совпадении и полном проверенном составе (CASE-01..04, MAIL-08, MAIL-10).
 */
async function finalizeIntake(
  messageId: string,
  ctx: {
    direction: "in" | "out";
    outgoingHeader: string | null;
    externalIds: Record<string, string | null>;
    first: boolean;
  },
): Promise<string> {
  const cases = await loadCases();
  return db.transaction(async (tx) => {
    // Сериализация по письму: параллельный повтор не создаст второе решение.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"intake:" + messageId}))`);
    const msg = (await tx.query.messages.findFirst({ where: eq(schema.messages.id, messageId) }))!;
    if (!AUTO_STATES.includes(msg.intakeState)) return msg.intakeState;
    const orgId = msg.organizationId;
    const org = (await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) }))!;
    const atts = await tx.query.attachments.findMany({ where: eq(schema.attachments.messageId, messageId) });
    const summary = summarizeManifest(atts.map(toItem));
    const source = msg.sourceCheck as Partial<SourceCheck>;
    const suspicious = source.suspicious === true;

    const text = `${msg.subject}\n${msg.bodyText ?? ""}`;
    const lang = detectLanguage(text).lang;
    const manifestInfo = {
      label: summary.label,
      complete: summary.complete,
      declared: summary.declared,
      verified: summary.verified,
      uniqueBlobs: summary.uniqueBlobs,
      problems: summary.problems,
      pending: summary.pending,
    };

    let intakeState: string;
    let match: Record<string, unknown>;
    let intakeKind: string | null = null;
    let task: { kind: "intake_review" | "intake_new_case"; title: string; detail: string } | null = null;
    let caseId: string | null = null;
    let attach: { caseId: string; basis: string } | null = null;

    // ── Исходящие (OUT-09): своё письмо платформы или отправленное вручную.
    if (ctx.direction === "out") {
      const outgoing = await findOutgoing(tx, orgId, ctx.outgoingHeader, msg.providerMessageId, msg.internetMessageId);
      if (outgoing) {
        caseId = outgoing.caseId;
        intakeState = "attached";
        match = { kind: "outgoing", caseId: outgoing.caseId, outgoingId: outgoing.id, reasons: ["Исходящее платформы (X-KZPPA-Outgoing-Id)"], manifest: manifestInfo };
        if (outgoing.state === "unknown_result" || outgoing.state === "sending") {
          // Синхронизация обнаружила отправленное — ускоряем сверку (OUT-06/09).
          await enqueue(tx, {
            orgId,
            type: "outgoing.reconcile",
            aggregateType: "outgoing",
            aggregateId: outgoing.id,
            idempotencyKey: `outgoing.reconcile:${outgoing.id}:mail:${msg.providerMessageId}`,
          });
        }
      } else {
        const parsed = parseSubject(msg.subject, msg.bodyText ?? "");
        const decision = matchCase({ parsed, fromEmail: msg.fromAddr, threadId: msg.threadId, officialRkaSender: org.rkaAddress, cases: await buildCaseIndex(tx, orgId, msg.threadId) });
        intakeKind = parsed.kind;
        match = { ...decisionJson(decision), parsed: parsedJson(parsed), manualSend: true, manifest: manifestInfo };
        intakeState = "needs_review";
        task = {
          kind: "intake_review",
          title: `Письмо отправлено вручную из почтового интерфейса: «${short(msg.subject)}» — сверьте и привяжите к делу`,
          detail: ["OUT-09: отправка вне платформы обнаружена синхронизацией.", ...decision.reasons].join("\n"),
        };
      }
    } else {
      // ── Входящие.
      const parsed = parseSubject(msg.subject, msg.bodyText ?? "");
      intakeKind = parsed.kind;
      const decision = matchCase({
        parsed,
        fromEmail: msg.fromAddr,
        threadId: msg.threadId,
        officialRkaSender: org.rkaAddress,
        cases: await buildCaseIndex(tx, orgId, msg.threadId),
      });
      match = { ...decisionJson(decision), parsed: parsedJson(parsed), manifest: manifestInfo, at: new Date().toISOString() };
      const sourceFlags = source.flags ?? [];
      const missing = summary.missing.map((m) => `• ${m.filename}: ${statusLabel(m.status)}${m.reason ? ` — ${m.reason}` : ""}`);

      if (decision.kind === "attach" && !suspicious && summary.complete) {
        intakeState = "matched";
        attach = { caseId: decision.caseId, basis: `Автоматически: ${decision.reasons.join("; ")}` };
      } else if (decision.kind === "attach" && !suspicious) {
        // Дело определено, но состав не полон — приобщение после загрузки (MAIL-08).
        intakeState = "matched";
        const stuck = atts.some((a) => !a.inline && !a.parentPartId && a.status !== "verified" && a.attempts >= 3);
        if (summary.problems > 0 || stuck) {
          task = {
            kind: "intake_review",
            title: `Неполное поступление: «${short(msg.subject)}» — ${summary.label}`,
            detail: ["Дело определено, но не все вложения сохранены и проверены (MAIL-08, MAIL-09).", ...missing].join("\n"),
          };
        }
      } else if (decision.kind === "new_case" && !suspicious) {
        intakeState = "needs_review";
        task = {
          kind: "intake_new_case",
          title: `Новое обращение РКА: «${short(msg.subject)}» — подтвердите регистрацию`,
          detail: [...decision.reasons, ...(summary.complete ? [] : [summary.label, ...missing])].join("\n"),
        };
      } else {
        intakeState = "needs_review";
        const reasons = [
          ...(suspicious ? ["Подозрительный источник (MAIL-10):", ...sourceFlags.map((f) => `• ${f}`)] : []),
          ...decision.reasons,
          ...(decision.kind === "needs_review" && decision.candidates.length
            ? decision.candidates.slice(0, 5).map((c) => `Кандидат: дело №${String(c.caseNumber).padStart(3, "0")} (${Math.round(c.score * 100)}%) — ${c.reasons.join("; ")}`)
            : []),
          ...(summary.complete ? [] : [summary.label, ...missing]),
        ];
        task = {
          kind: decision.kind === "new_case" ? "intake_new_case" : "intake_review",
          title: `${suspicious ? "Проверьте подлинность письма" : "Требует разбора"}: «${short(msg.subject)}»`,
          detail: reasons.join("\n"),
        };
        if (suspicious) match.suspicious = sourceFlags;
      }
    }

    await tx
      .update(schema.messages)
      .set({ intakeState, intakeKind, match, lang, ...(caseId ? { caseId, attachBasis: "Исходящее платформы" } : {}) })
      .where(eq(schema.messages.id, messageId));

    if (task) {
      await tx
        .insert(schema.tasks)
        .values({
          organizationId: orgId,
          kind: task.kind,
          title: task.title.slice(0, 500),
          detail: task.detail.slice(0, 8000),
          assigneeRole: "secretary",
          objectType: "message",
          objectId: messageId,
          dedupKey: `${task.kind}:${messageId}`,
        })
        .onConflictDoNothing({ target: schema.tasks.dedupKey });
    }

    if (attach) {
      if (cases?.attachMessageToCase) {
        try {
          // Точка сохранения: отказ приобщения не откатывает запись приёма и аудит.
          await tx.transaction((sp) =>
            cases.attachMessageToCase(sp, { orgId, messageId, caseId: attach!.caseId, actor: SERVICE_ACTOR, basis: attach!.basis, auto: true }),
          );
          intakeState = "attached";
        } catch (e) {
          intakeState = "needs_review";
          await tx.update(schema.messages).set({ intakeState }).where(eq(schema.messages.id, messageId));
          await tx
            .insert(schema.tasks)
            .values({
              organizationId: orgId,
              kind: "intake_review",
              title: `Автоприобщение не выполнено: «${short(msg.subject)}»`,
              detail: `${(e as Error).message}\n${attach.basis}`.slice(0, 8000),
              assigneeRole: "secretary",
              objectType: "message",
              objectId: messageId,
              dedupKey: `intake_review:${messageId}`,
            })
            .onConflictDoNothing({ target: schema.tasks.dedupKey });
        }
      } // иначе остаётся «matched» до появления сервиса дел
    }

    await audit(tx, {
      orgId,
      actor: SERVICE_ACTOR,
      action: ctx.first ? "mail.ingest" : "mail.retry_attachments",
      objectType: "message",
      objectId: messageId,
      caseId: intakeState === "attached" ? (caseId ?? attach?.caseId ?? null) : null,
      after: {
        direction: ctx.direction,
        intakeState,
        intakeKind,
        decision: match.kind,
        manifest: summary.label,
        lang,
        suspicious,
      },
      externalIds: ctx.externalIds,
    });
    return intakeState;
  });
}

async function findOutgoing(tx: Tx, orgId: string, header: string | null, providerMessageId: string, internetMessageId: string | null) {
  if (header && UUID_RE.test(header)) {
    const o = await tx.query.outgoings.findFirst({ where: and(eq(schema.outgoings.id, header), eq(schema.outgoings.organizationId, orgId)) });
    if (o) return o;
  }
  const o = await tx.query.outgoings.findFirst({ where: and(eq(schema.outgoings.organizationId, orgId), eq(schema.outgoings.providerMessageId, providerMessageId)) });
  if (o) return o;
  if (internetMessageId) {
    return (await tx.query.outgoings.findFirst({ where: and(eq(schema.outgoings.organizationId, orgId), eq(schema.outgoings.internetMessageId, internetMessageId)) })) ?? null;
  }
  return null;
}

function decisionJson(d: MatchDecision): Record<string, unknown> {
  if (d.kind === "attach") return { kind: d.kind, caseId: d.caseId, confidence: d.confidence, reasons: d.reasons, candidates: [{ caseId: d.caseId, score: d.confidence, reasons: d.reasons }] };
  if (d.kind === "new_case") return { kind: d.kind, reasons: d.reasons, candidates: [] };
  return { kind: d.kind, reasons: d.reasons, candidates: d.candidates };
}

function parsedJson(p: ReturnType<typeof parseSubject>) {
  return { rkaNumber: p.rkaNumber, year: p.year, kind: p.kind, applicantCandidates: p.applicantCandidates, signals: p.signals };
}

const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s || "(без темы)");

const STATUS_LABEL: Partial<Record<AttachmentStatus, string>> = {
  pending: "не загружено",
  downloading: "загрузка",
  stored: "сохранено, не проверено",
  rejected: "отклонено",
  encrypted: "зашифровано",
  unavailable: "недоступно",
  quarantine: "карантин",
};
const statusLabel = (s: AttachmentStatus) => STATUS_LABEL[s] ?? s;

/* ────────────────────────────── Обслуживание ────────────────────────────── */

const MAX_AUTO_ATTEMPTS = 8;

/**
 * Письма с незагруженными обязательными вложениями для повтора (cron), независимо от
 * состояния разбора. «unavailable» (лимит размера, 404) автоматически не повторяется.
 */
export async function listIncompleteMessages(accountId: string, limit = 20) {
  return db
    .selectDistinct({ id: schema.messages.id })
    .from(schema.messages)
    .innerJoin(schema.attachments, eq(schema.attachments.messageId, schema.messages.id))
    .where(
      and(
        eq(schema.messages.accountId, accountId),
        inArray(schema.attachments.status, ["pending", "downloading", "stored"]),
        eq(schema.attachments.inline, false),
        sql`${schema.attachments.parentPartId} is null`,
        sql`${schema.attachments.attempts} < ${MAX_AUTO_ATTEMPTS}`,
      ),
    )
    .limit(limit);
}

export type { FetchedMessage };
