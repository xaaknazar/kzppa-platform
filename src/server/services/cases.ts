import "server-only";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { summarizeManifest, type ManifestItem } from "@/domain/manifest";
import { detectLanguage } from "@/domain/language";
import { normalizeRkaNumber } from "@/domain/numbering";
import type { DocCategory } from "@/domain/types";
import { assertTransition, CASE } from "@/domain/states";
import { audit, type Actor } from "../audit";
import { CommandError, expectVersion, runCommand } from "../command";
import type { SessionUser } from "../auth";

/**
 * CASE-01..08, BR-01, INC-02. Регистрация обращения и приобщение материалов к делу.
 * Одно обращение — один постоянный ID и номер комиссии; дополнения, доработка и
 * повторное рассмотрение остаются в том же деле отдельными циклами.
 */

export type CaseRow = typeof schema.cases.$inferSelect;

/** Следующий номер дела в году организации — атомарно под advisory-lock. */
async function nextCaseNumber(tx: Tx, orgId: string, year: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`case-number:${orgId}:${year}`}))`);
  const [r] = await tx
    .select({ m: max(schema.cases.number) })
    .from(schema.cases)
    .where(and(eq(schema.cases.organizationId, orgId), eq(schema.cases.year, year)));
  return (r?.m ?? 0) + 1;
}

/** CASE-07: машинный проект поля D по тексту письма; город в подписи РКА не является коллегией. */
export function extractCollegiumCandidates(text: string): string[] {
  const out = new Set<string>();
  const re =
    /(?:коллеги[ияей]\s+адвокатов|адвокатск\S+\s+коллеги\S+|адвокаттар\s+алқасы\S*)\s+((?:города|г\.|области|обл\.|[А-ЯЁӘҒҚҢӨҰҮҺІ][\wәғқңөұүһі-]+)(?:\s+[А-ЯЁӘҒҚҢӨҰҮҺІ][\wәғқңөұүһі-]+){0,3})/giu;
  const signature = text.split(/\n\s*(?:--|С уважением|Құрметпен)/i)[0];
  for (const m of signature.matchAll(re)) {
    const v = m[0].replace(/\s+/g, " ").trim();
    if (!/республиканск/i.test(v)) out.add(v);
  }
  // «…ской области коллегии адвокатов», «Алматинская городская коллегия адвокатов»
  const re2 = /([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі-]+(?:ская|ской|ск\S{0,3})\s+(?:областн\S+|городск\S+)\s+коллеги\S+\s+адвокатов)/gu;
  for (const m of signature.matchAll(re2)) out.add(m[1].trim());
  return [...out].slice(0, 5);
}

/** CASE-07: машинный проект поля F — первые содержательные предложения с указанием источника. */
export function machineSummary(text: string): string | null {
  const clean = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(>|--|С уважением|Құрметпен|Тел|Email|e-mail|From:|Sent:)/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ");
  if (clean.length < 40) return null;
  const sentences = clean.match(/[^.!?]+[.!?]/g) ?? [clean];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > 420) break;
    out += s;
  }
  return (out || clean.slice(0, 420)).trim();
}

export function categoryForIntake(kind: string | null | undefined): DocCategory {
  switch (kind) {
    case "supplement":
    case "rework":
      return "supplement";
    case "executor_reply":
      return "draft";
    default:
      return "incoming_original";
  }
}

/** Документы и версии для проверенных вложений письма; повтор не создаёт дублей (BR-06, AT-03). */
async function materializeAttachments(tx: Tx, orgId: string, caseId: string, cycleId: string | null, message: typeof schema.messages.$inferSelect, category: DocCategory, authorId: string | null) {
  const atts = await tx.query.attachments.findMany({ where: eq(schema.attachments.messageId, message.id), orderBy: asc(schema.attachments.partId) });
  const created: string[] = [];
  const bySha = new Map<string, string>();
  for (const a of atts) {
    if (a.inline || a.status !== "verified" || !a.blobId || !a.sha256) continue;
    if (a.documentVersionId) {
      created.push(a.documentVersionId);
      bySha.set(a.sha256, a.documentVersionId);
      continue;
    }
    // Одинаковые байты в одном письме — одна версия, но обе позиции источника учтены.
    let versionId = bySha.get(a.sha256);
    if (!versionId) {
      const lang = detectLanguage(`${a.filename} ${message.subject}`).lang;
      const [doc] = await tx
        .insert(schema.documents)
        .values({ organizationId: orgId, caseId, cycleId, category, title: a.displayName ?? a.filename, lang: lang ?? message.lang, area: category === "evidence" ? "root" : "executor_workspace" })
        .returning();
      const format = a.filename.toLowerCase().endsWith(".pdf") ? "pdf" : a.filename.toLowerCase().match(/\.docx?$/) ? "docx" : (a.filename.split(".").pop() ?? "bin");
      const [ver] = await tx
        .insert(schema.documentVersions)
        .values({
          organizationId: orgId,
          documentId: doc.id,
          version: 1,
          state: category === "draft" ? "working" : "approved",
          blobId: a.blobId,
          sha256: a.sha256,
          size: a.size,
          format,
          filename: a.filename,
          authorId,
          sourceMessageId: message.id,
          sourceAttachmentId: a.id,
        })
        .returning();
      versionId = ver.id;
      bySha.set(a.sha256, versionId);
    }
    await tx.update(schema.attachments).set({ documentVersionId: versionId }).where(eq(schema.attachments.id, a.id));
    created.push(versionId);
  }
  return [...new Set(created)];
}

/**
 * Приобщить письмо к существующему делу. Используется автоматическим маршрутом
 * (строгое правило) и ручным решением секретаря (CASE-06).
 */
export async function attachMessageToCase(
  tx: Tx,
  p: { orgId: string; messageId: string; caseId: string; actor: Actor; basis: string; auto: boolean },
): Promise<void> {
  const message = await tx.query.messages.findFirst({ where: eq(schema.messages.id, p.messageId) });
  if (!message) throw new CommandError("Письмо не найдено");
  if (message.caseId && message.caseId !== p.caseId) throw new CommandError("Письмо уже приобщено к другому делу. Используйте перенос с сохранением истории.");
  if (message.caseId === p.caseId && message.intakeState === "attached") return; // идемпотентно
  const kase = await tx.query.cases.findFirst({ where: eq(schema.cases.id, p.caseId) });
  if (!kase) throw new CommandError("Дело не найдено");

  let cycleId = kase.currentCycleId;
  let category = categoryForIntake(message.intakeKind);
  const fromExecutor = await isExecutorEmail(tx, kase.id, message.fromAddr);
  if (fromExecutor) category = "draft";

  // FLOW-11 / AT-36: дополнение после отправленного заключения — новый цикл в том же деле.
  if ((kase.state === "sent" || kase.state === "closed") && category !== "draft") {
    const [last] = await tx.select({ m: max(schema.cycles.number) }).from(schema.cycles).where(eq(schema.cycles.caseId, kase.id));
    const [cyc] = await tx
      .insert(schema.cycles)
      .values({ organizationId: p.orgId, caseId: kase.id, number: (last?.m ?? 0) + 1, parentCycleId: kase.currentCycleId, supplementary: true, basis: `Поступили дополнительные материалы: ${message.subject}` })
      .returning();
    cycleId = cyc.id;
    assertTransition(CASE, "case", kase.state as never, "resumed");
    await tx.update(schema.cases).set({ state: "resumed", currentCycleId: cyc.id, version: kase.version + 1, updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
    await tx.insert(schema.tasks).values({ organizationId: p.orgId, caseId: kase.id, kind: "new_cycle", title: `Дело №${String(kase.number).padStart(3, "0")}: поступили дополнения после отправки — назначьте исполнителя нового цикла`, assigneeRole: "chair", dedupKey: `new_cycle:${cyc.id}` }).onConflictDoNothing();
  }

  const versions = await materializeAttachments(tx, p.orgId, kase.id, cycleId, message, category, null);

  // Сохранить и само письмо как документ переписки (EML/текст в корне дела).
  await tx
    .update(schema.messages)
    .set({ caseId: kase.id, intakeState: "attached", attachBasis: p.basis, attachedBy: p.actor.id })
    .where(eq(schema.messages.id, message.id));

  // FLOW-04: проект от исполнителя → новая версия, поручение «Проект представлен».
  if (category === "draft" && cycleId) {
    const asg = await tx.query.assignments.findFirst({
      where: and(eq(schema.assignments.caseId, kase.id), inArray(schema.assignments.state, ["sent", "receipt_confirmed", "in_work", "on_rework"])),
      orderBy: desc(schema.assignments.createdAt),
    });
    if (asg) await tx.update(schema.assignments).set({ state: "draft_submitted", version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
    const cyc = await tx.query.cycles.findFirst({ where: eq(schema.cycles.id, cycleId) });
    if (cyc && cyc.state === "closed" && cyc.finalRoute === "rework" && versions[0]) {
      await tx.update(schema.cycles).set({ finalVersionId: versions[0], finalReceivedAt: message.receivedAt ?? new Date(), version: cyc.version + 1 }).where(eq(schema.cycles.id, cyc.id));
    }
    if (kase.state === "assigned") await tx.update(schema.cases).set({ state: "in_progress", updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
    await tx.insert(schema.tasks).values({ organizationId: p.orgId, caseId: kase.id, kind: "draft_review", title: `Дело №${String(kase.number).padStart(3, "0")}: поступил ${cyc?.finalRoute === "rework" ? "окончательный вариант" : "проект"} заключения от исполнителя`, assigneeRole: "chair", objectType: "message", objectId: message.id, dedupKey: `draft_review:${message.id}` }).onConflictDoNothing();
  }

  await audit(tx, {
    orgId: p.orgId,
    actor: p.actor,
    action: p.auto ? "case.attach_auto" : "case.attach",
    objectType: "message",
    objectId: message.id,
    caseId: kase.id,
    basis: p.basis,
    after: { category, versions, cycleId },
    externalIds: { providerMessageId: message.providerMessageId, threadId: message.threadId },
  });
}

async function isExecutorEmail(tx: Tx, caseId: string, email: string) {
  const rows = await tx
    .select({ email: schema.users.email })
    .from(schema.caseMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.caseMembers.userId))
    .where(and(eq(schema.caseMembers.caseId, caseId), eq(schema.caseMembers.role, "executor")));
  return rows.some((r) => r.email.toLowerCase() === email.toLowerCase());
}

/** CASE-01: регистрация нового обращения после подтверждения уполномоченным пользователем. */
export async function registerCase(
  user: SessionUser,
  input: { messageId: string; applicant: string; rkaNumber?: string | null; rkaDate?: string | null; collegium?: string | null; summary?: string | null; lang?: "ru" | "kk" | null; idempotencyKey: string },
) {
  return runCommand({ name: "case.register", user, idempotencyKey: input.idempotencyKey, permission: { action: "case.register" } }, async ({ tx, actor, orgId }) => {
    const msg = await tx.query.messages.findFirst({ where: and(eq(schema.messages.id, input.messageId), eq(schema.messages.organizationId, orgId)) });
    if (!msg) throw new CommandError("Письмо не найдено");
    if (msg.caseId) throw new CommandError("Письмо уже приобщено к делу");
    if (!input.applicant.trim()) throw new CommandError("Укажите заявителя");
    const received = msg.receivedAt ?? msg.processedAt;
    const year = new Date(received).getFullYear();
    const number = await nextCaseNumber(tx, orgId, year);
    const text = `${msg.subject}\n${msg.bodyText ?? ""}`;
    const lang = input.lang ?? detectLanguage(text).lang;
    const collegiumCandidates = extractCollegiumCandidates(msg.bodyText ?? "");
    const summary = input.summary?.trim() || machineSummary(msg.bodyText ?? "");
    const org = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
    const chair = await tx
      .select({ id: schema.orgRoles.userId })
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.organizationId, orgId), eq(schema.orgRoles.role, "chair")))
      .limit(1);

    const [kase] = await tx
      .insert(schema.cases)
      .values({
        organizationId: orgId,
        year,
        number,
        rkaNumber: input.rkaNumber ? normalizeRkaNumber(input.rkaNumber) ?? input.rkaNumber : null,
        rkaDate: input.rkaDate || null,
        receivedAt: received,
        applicant: input.applicant.trim(),
        collegium: input.collegium?.trim() || (collegiumCandidates.length === 1 ? collegiumCandidates[0] : null),
        collegiumCandidates,
        collegiumSource: input.collegium ? "Указано при регистрации" : collegiumCandidates.length ? "Машинный проект по тексту письма РКА" : null,
        collegiumManual: !!input.collegium,
        summary,
        summarySource: input.summary ? "Указано при регистрации" : summary ? "Машинный проект по тексту письма" : null,
        summaryMachine: !input.summary && !!summary,
        summaryManual: !!input.summary,
        lang,
        langConfirmed: !!input.lang,
        chairId: chair[0]?.id ?? null,
        secretaryId: user.orgRoles.includes("secretary") ? user.id : null,
        initialMessageId: msg.id,
      })
      .returning();
    const [cyc] = await tx.insert(schema.cycles).values({ organizationId: orgId, caseId: kase.id, number: 1 }).returning();
    await tx.update(schema.cases).set({ currentCycleId: cyc.id }).where(eq(schema.cases.id, kase.id));
    await tx.update(schema.messages).set({ intakeKind: msg.intakeKind ?? "initial" }).where(eq(schema.messages.id, msg.id));
    await attachMessageToCase(tx, { orgId, messageId: msg.id, caseId: kase.id, actor, basis: "Первичное обращение", auto: false });
    await tx.update(schema.tasks).set({ state: "done", resolvedAt: new Date(), resolvedBy: user.id }).where(and(eq(schema.tasks.objectId, msg.id), eq(schema.tasks.state, "open")));
    await tx.update(schema.tasks).set({ state: "done", resolvedAt: new Date(), resolvedBy: user.id }).where(and(inArray(schema.tasks.dedupKey, [`intake_new_case:${msg.id}`, `intake_review:${msg.id}`]), eq(schema.tasks.state, "open")));
    await audit(tx, { orgId, actor, action: "case.register", objectType: "case", objectId: kase.id, caseId: kase.id, after: { number, year, rkaNumber: kase.rkaNumber, applicant: kase.applicant, officialSender: org?.officialSender } });
    return { caseId: kase.id, number };
  });
}

/** Ручное приобщение из очереди разбора (CASE-06). */
export async function attachManually(user: SessionUser, input: { messageId: string; caseId: string; basis: string; idempotencyKey: string }) {
  return runCommand({ name: "case.attach", user, idempotencyKey: input.idempotencyKey, permission: { action: "case.attach", caseId: input.caseId } }, async ({ tx, actor, orgId }) => {
    if (input.basis.trim().length < 5) throw new CommandError("Укажите основание приобщения");
    const msg = await tx.query.messages.findFirst({ where: and(eq(schema.messages.id, input.messageId), eq(schema.messages.organizationId, orgId)) });
    if (!msg) throw new CommandError("Письмо не найдено");
    const atts = await tx.query.attachments.findMany({ where: eq(schema.attachments.messageId, msg.id) });
    const s = summarizeManifest(atts.map(toManifestItem));
    await attachMessageToCase(tx, { orgId, messageId: msg.id, caseId: input.caseId, actor, basis: input.basis.trim(), auto: false });
    if (!s.complete) {
      // MAIL-08: запись приобщена, но неполнота явно видна и блокирует передачу исполнителю.
      await tx.update(schema.messages).set({ intakeState: "attached" }).where(eq(schema.messages.id, msg.id));
    }
    await tx.update(schema.tasks).set({ state: "done", resolvedAt: new Date(), resolvedBy: user.id }).where(and(eq(schema.tasks.objectId, msg.id), eq(schema.tasks.state, "open")));
    await tx.update(schema.tasks).set({ state: "done", resolvedAt: new Date(), resolvedBy: user.id }).where(and(inArray(schema.tasks.dedupKey, [`intake_new_case:${msg.id}`, `intake_review:${msg.id}`]), eq(schema.tasks.state, "open")));
    return { ok: true };
  });
}

/** CASE-07 / AT-40: ручные правки D и F не затираются автообработкой. */
export async function updateCaseFields(
  user: SessionUser,
  input: { caseId: string; expectedVersion: number; collegium?: string | null; summary?: string | null; lang?: "ru" | "kk" | null; applicantAliases?: string[] },
) {
  return runCommand({ name: "case.update_fields", user, permission: { action: "case.attach", caseId: input.caseId } }, async ({ tx, actor }) => {
    const kase = await tx.query.cases.findFirst({ where: eq(schema.cases.id, input.caseId) });
    if (!kase) throw new CommandError("Дело не найдено");
    expectVersion(kase.version, input.expectedVersion);
    const patch: Partial<CaseRow> = { version: kase.version + 1, updatedAt: new Date() };
    if (input.collegium !== undefined) Object.assign(patch, { collegium: input.collegium, collegiumManual: true, collegiumSource: `Исправлено вручную (${user.fullName}); исходное извлечение: ${kase.collegiumSource ?? "нет"}` });
    if (input.summary !== undefined) Object.assign(patch, { summary: input.summary, summaryManual: true, summaryMachine: false, summarySource: `Исправлено вручную (${user.fullName}); исходное извлечение: ${kase.summarySource ?? "нет"}` });
    if (input.lang !== undefined) Object.assign(patch, { lang: input.lang, langConfirmed: true });
    if (input.applicantAliases) patch.applicantAliases = input.applicantAliases;
    await tx.update(schema.cases).set(patch).where(eq(schema.cases.id, kase.id));
    await audit(tx, { orgId: kase.organizationId, actor, action: "case.update_fields", objectType: "case", objectId: kase.id, objectVersion: kase.version + 1, caseId: kase.id, before: { collegium: kase.collegium, summary: kase.summary, lang: kase.lang }, after: patch });
    return { version: kase.version + 1 };
  });
}

export function toManifestItem(a: typeof schema.attachments.$inferSelect): ManifestItem {
  return {
    partId: a.partId,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    sha256: a.sha256,
    inline: a.inline,
    parentPartId: a.parentPartId,
    status: a.status as ManifestItem["status"],
    reason: a.reason,
    exclusion: a.exclusion as ManifestItem["exclusion"],
  };
}

/** MAIL-08: полнота всех поступлений дела — условие передачи исполнителю. */
export async function caseIntakeCompleteness(q: Tx | typeof db, caseId: string) {
  const msgs = await q.query.messages.findMany({ where: and(eq(schema.messages.caseId, caseId), eq(schema.messages.direction, "in")) });
  const result: { messageId: string; subject: string; summary: ReturnType<typeof summarizeManifest> }[] = [];
  for (const m of msgs) {
    const atts = await q.query.attachments.findMany({ where: eq(schema.attachments.messageId, m.id) });
    result.push({ messageId: m.id, subject: m.subject, summary: summarizeManifest(atts.map(toManifestItem)) });
  }
  return { complete: result.every((r) => r.summary.complete), messages: result };
}

/** MAIL-09: исключение элемента из обязательного состава — только с основанием. */
export async function excludeAttachment(user: SessionUser, input: { attachmentId: string; basis: string }) {
  return runCommand({ name: "intake.exclude_item", user, permission: { action: "intake.exclude_item" } }, async ({ tx, actor, orgId }) => {
    if (input.basis.trim().length < 10) throw new CommandError("Основание исключения — не короче 10 символов");
    const a = await tx.query.attachments.findFirst({ where: and(eq(schema.attachments.id, input.attachmentId), eq(schema.attachments.organizationId, orgId)) });
    if (!a) throw new CommandError("Вложение не найдено");
    if (a.status === "verified") throw new CommandError("Вложение уже сохранено и проверено");
    const exclusion = { by: user.fullName, basis: input.basis.trim(), at: new Date().toISOString() };
    await tx.update(schema.attachments).set({ status: "excluded", exclusion }).where(eq(schema.attachments.id, a.id));
    const msg = await tx.query.messages.findFirst({ where: eq(schema.messages.id, a.messageId) });
    await audit(tx, { orgId, actor, action: "intake.exclude_item", objectType: "attachment", objectId: a.id, caseId: msg?.caseId ?? null, before: { status: a.status }, after: { status: "excluded" }, basis: exclusion.basis });
    return { ok: true };
  });
}

export async function listCaseCycles(caseId: string) {
  return db.query.cycles.findMany({ where: eq(schema.cycles.caseId, caseId), orderBy: asc(schema.cycles.number) });
}

