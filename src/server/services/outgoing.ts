import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { packageHash, idempotencyKey, type PackageSnapshot } from "@/domain/hash";
import { formatBase, formatOutgoing, formatOutgoingFull, nextRepeatIndex } from "@/domain/numbering";
import { coverLetter } from "@/domain/templates";
import { assertTransition, CASE, OUTGOING } from "@/domain/states";
import type { Lang, OutgoingState } from "@/domain/types";
import { audit, SERVICE_ACTOR } from "../audit";
import { CommandError, expectVersion, runCommand } from "../command";
import { enqueue, registerHandler, type OutboxRow } from "../outbox";
import { putImmutable, readBlob } from "../storage";
import type { SessionUser } from "../auth";
import { buildCoverLetterDocx } from "../docs/cover-letter-docx";
import { getMailAdapter, getPrimaryAccount } from "@/integrations/mail";
import { UnknownSendResultError, MailAuthError } from "@/integrations/mail/types";

/**
 * Состав манифеста пакета: каждый файл указывает версию документа и роль в комплекте.
 * CMS и служебные доказательства в обычную отправку не входят (DOC-10).
 */
export interface ManifestEntry {
  versionId: string;
  role: "cover" | "conclusion" | "draft_attachment" | "other";
  name: string;
  size: number;
  sha256: string;
  mimeType: string;
}

const fmt = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00` : d) : d;
  return x.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" });
};

async function snapshotOf(tx: Tx | typeof db, out: typeof schema.outgoings.$inferSelect): Promise<PackageSnapshot> {
  const manifest = (out.manifest as ManifestEntry[]) ?? [];
  return {
    from: out.fromAddr,
    to: out.toAddrs,
    cc: out.ccAddrs,
    bcc: out.bccAddrs,
    subject: out.subject,
    bodyText: out.bodyText,
    outgoingNumber: out.numberDisplay,
    outgoingDate: out.outgoingDate,
    files: manifest.map((m) => ({ name: m.name, size: m.size, sha256: m.sha256, versionId: m.versionId })),
  };
}

async function setOutState(tx: Tx, out: { id: string; state: string; version: number }, to: OutgoingState, patch: Partial<typeof schema.outgoings.$inferInsert> = {}) {
  assertTransition(OUTGOING, "outgoing", out.state as OutgoingState, to);
  await tx.update(schema.outgoings).set({ ...patch, state: to, version: out.version + 1 }).where(eq(schema.outgoings.id, out.id));
  out.state = to;
  out.version += 1;
}

/** DOC-10: связанные с финальным заключением проекты и Word-приложения исполнителя — предложение. */
export async function suggestAttachments(caseId: string, cycleId: string) {
  const rows = await db
    .select({ v: schema.documentVersions, d: schema.documents })
    .from(schema.documentVersions)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId))
    .where(and(eq(schema.documents.caseId, caseId), eq(schema.documents.cycleId, cycleId), eq(schema.documents.category, "draft")))
    .orderBy(asc(schema.documentVersions.createdAt));
  return rows.filter((r) => r.v.format === "docx" && r.v.state !== "superseded" && !r.v.deletedAt);
}

/**
 * OUT-11: сначала сопроводительное DOCX и опись, затем почтовый черновик с той же описью.
 * Номер исходящего резервируется атомарно при подготовке (DOC-08).
 */
export async function prepareRkaPackage(user: SessionUser, input: { cycleId: string; includeDraftVersionIds: string[]; lang?: Lang | null; purpose?: string; idempotencyKey: string }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "outgoing.prepare_rka", user, idempotencyKey: input.idempotencyKey, permission: { action: "outgoing.prepare", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const cycle = await tx.query.cycles.findFirst({ where: and(eq(schema.cycles.id, input.cycleId), eq(schema.cycles.organizationId, orgId)) });
    if (!cycle) throw new CommandError("Цикл не найден");
    const kase = (await tx.query.cases.findFirst({ where: eq(schema.cases.id, cycle.caseId) }))!;
    const org = (await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) }))!;
    const card = await tx.query.qrCards.findFirst({ where: eq(schema.qrCards.cycleId, cycle.id) });
    if (!card) throw new CommandError("Нет подготовленного PDF заключения с QR");
    const pdf = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, card.documentVersionId) });
    if (!pdf || pdf.state !== "signed") throw new CommandError("Заключение ещё не подписано ЭЦП председателя");
    const sign = await tx.query.signSessions.findFirst({ where: and(eq(schema.signSessions.documentVersionId, pdf.id), eq(schema.signSessions.state, "verified")) });
    if (!sign) throw new CommandError("Проверка ЭЦП не завершена — подготовка комплекта заблокирована (BR-05)");

    const active = await tx.query.outgoings.findFirst({ where: and(eq(schema.outgoings.cycleId, cycle.id), eq(schema.outgoings.kind, "rka_package"), inArray(schema.outgoings.state, ["project", "package_checked", "draft", "approved", "sending", "unknown_result", "approval_stale"])) });
    if (active) throw new CommandError("Комплект по этому циклу уже подготовлен");

    // Язык — по языку исходного обращения (DOC-01, DOC-07).
    const lang = (input.lang ?? kase.lang) as Lang | null;
    if (!lang) throw new CommandError("Язык обращения не определён — выберите язык сопроводительного письма");

    // Атомарное резервирование номера: все выданные индексы по делу, включая отменённые.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`outgoing:${kase.id}`}))`);
    const issued = await tx.select({ i: schema.outgoings.repeatIndex }).from(schema.outgoings).where(and(eq(schema.outgoings.caseId, kase.id), eq(schema.outgoings.kind, "rka_package")));
    const repeatIndex = nextRepeatIndex(issued.map((r) => r.i).filter((x): x is number => x !== null));
    const number = { caseNumber: kase.number, repeatIndex };
    const numberDisplay = formatOutgoingFull(number, { prefix: org.outgoingPrefix, year: org.outgoingYearInNumber ? kase.year : null });
    const outgoingDate = new Date().toISOString().slice(0, 10);

    const drafts = input.includeDraftVersionIds.length
      ? await tx.select({ v: schema.documentVersions, d: schema.documents }).from(schema.documentVersions).innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId)).where(inArray(schema.documentVersions.id, input.includeDraftVersionIds))
      : [];
    for (const d of drafts) if (d.d.caseId !== kase.id) throw new CommandError("Приложение относится к другому делу");

    const chair = (await tx.query.users.findFirst({ where: eq(schema.users.id, cycle.approvedBy!) }))!;
    const attachmentsList = [
      { name: `${cycle.supplementary ? (lang === "kk" ? "Қосымша қорытынды" : "Дополнительное заключение") : lang === "kk" ? "Қорытынды" : "Заключение"} №${cycle.conclusionNumber} (PDF, ЭЦП)` },
      ...drafts.map((d) => ({ name: d.v.filename ?? d.d.title })),
    ];
    const coverData = {
      outgoingNumber: numberDisplay,
      outgoingDate: fmt(outgoingDate),
      rkaNumber: kase.rkaNumber ?? "—",
      rkaDate: fmt(kase.rkaDate),
      caseNumber: formatBase(kase.number),
      applicant: kase.applicant,
      purpose: input.purpose?.trim() || (lang === "kk" ? "Қорытынды Комиссия отырысында қаралып, төрағаның ЭЦҚ-мен қол қойылды." : "Заключение рассмотрено Комиссией и подписано ЭЦП председателя."),
      attachments: attachmentsList,
      chairFullName: chair.fullName,
      commissionName: lang === "kk" ? org.nameKk ?? org.name : org.name,
      addressee: org.rkaAddressee,
      supplementary: cycle.supplementary,
    };
    const docx = await buildCoverLetterDocx(lang, coverData);
    const coverBlob = await putImmutable(orgId, docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", undefined, tx);
    const [coverDoc] = await tx.insert(schema.documents).values({ organizationId: orgId, caseId: kase.id, cycleId: cycle.id, category: "outgoing", title: `Сопроводительное письмо исх. №${numberDisplay}`, lang, area: "root" }).returning();
    const coverFile = `cover-${numberDisplay.replace(/\//g, "-")}.docx`;
    const [coverVer] = await tx.insert(schema.documentVersions).values({ organizationId: orgId, documentId: coverDoc.id, version: 1, state: "approved", blobId: coverBlob.id, sha256: coverBlob.sha256, size: coverBlob.size, format: "docx", filename: coverFile, authorId: user.id, generator: { kind: "cover_letter", lang } }).returning();

    const manifest: ManifestEntry[] = [
      { versionId: coverVer.id, role: "cover", name: coverFile, size: coverBlob.size, sha256: coverBlob.sha256, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { versionId: pdf.id, role: "conclusion", name: pdf.filename ?? "conclusion.pdf", size: pdf.size ?? 0, sha256: pdf.sha256!, mimeType: "application/pdf" },
      ...drafts.map((d) => ({ versionId: d.v.id, role: "draft_attachment" as const, name: d.v.filename ?? d.d.title, size: d.v.size ?? 0, sha256: d.v.sha256!, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })),
    ];
    const tmpl = coverLetter(lang, coverData);
    const [out] = await tx
      .insert(schema.outgoings)
      .values({
        organizationId: orgId,
        caseId: kase.id,
        cycleId: cycle.id,
        kind: "rka_package",
        numberCase: kase.number,
        repeatIndex,
        numberDisplay,
        outgoingDate,
        lang,
        fromAddr: org.officialSender,
        toAddrs: [org.rkaAddress],
        subject: tmpl.subject,
        bodyText: tmpl.emailBody,
        manifest,
        state: "project",
        idempotencyKey: await idempotencyKey("rka-package", cycle.id, repeatIndex),
      })
      .returning();
    const o = { id: out.id, state: out.state, version: out.version };
    const snap = await snapshotOf(tx, { ...out });
    await setOutState(tx, o, "package_checked", { packageHash: await packageHash(snap) });
    await setOutState(tx, o, "draft");
    const langMismatch = kase.conclusionLang && kase.conclusionLang !== lang;
    await audit(tx, { orgId, actor, action: "outgoing.prepare_rka", objectType: "outgoing", objectId: out.id, caseId: kase.id, after: { numberDisplay, lang, files: manifest.length, langMismatch: !!langMismatch, formatted: formatOutgoing(number) } });
    return { outgoingId: out.id, numberDisplay };
  });
}

/** Изменить состав приложений: согласие аннулируется (OUT-04, AT-17). */
export async function updatePackageFiles(user: SessionUser, input: { outgoingId: string; includeDraftVersionIds: string[]; expectedVersion: number }) {
  const o0 = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
  return runCommand({ name: "outgoing.update_files", user, permission: { action: "outgoing.prepare", caseId: o0?.caseId } }, async ({ tx, actor }) => {
    const out = await tx.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
    if (!out) throw new CommandError("Исходящее не найдено");
    expectVersion(out.version, input.expectedVersion);
    if (!["draft", "approved", "approval_stale"].includes(out.state)) throw new CommandError("Состав отправленного комплекта менять нельзя");
    const manifest = ((out.manifest as ManifestEntry[]) ?? []).filter((m) => m.role !== "draft_attachment");
    const drafts = input.includeDraftVersionIds.length ? await tx.query.documentVersions.findMany({ where: inArray(schema.documentVersions.id, input.includeDraftVersionIds) }) : [];
    for (const d of drafts) manifest.push({ versionId: d.id, role: "draft_attachment", name: d.filename ?? "приложение.docx", size: d.size ?? 0, sha256: d.sha256!, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const h = await packageHash(await snapshotOf(tx, { ...out, manifest }));
    const state = out.state === "approved" ? "approval_stale" : out.state;
    await tx.update(schema.outgoings).set({ manifest, packageHash: h, approval: null, state: state === "approval_stale" ? "draft" : state, version: out.version + 1 }).where(eq(schema.outgoings.id, out.id));
    await audit(tx, { orgId: out.organizationId, actor, action: "outgoing.update_files", objectType: "outgoing", objectId: out.id, caseId: out.caseId, after: { files: manifest.length, approvalReset: !!out.approval } });
    return { packageHash: h };
  });
}

/** «Согласовать комплект и направить в РКА». */
export async function approveAndSendPackage(user: SessionUser, input: { outgoingId: string; shownHash: string; idempotencyKey: string }) {
  const o0 = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
  const res = await runCommand({ name: "outgoing.approve_send", user, idempotencyKey: input.idempotencyKey, permission: { action: "outgoing.approve_send", caseId: o0?.caseId } }, async ({ tx, actor, orgId, correlationId }) => {
    const out = await tx.query.outgoings.findFirst({ where: and(eq(schema.outgoings.id, input.outgoingId), eq(schema.outgoings.organizationId, orgId)) });
    if (!out) throw new CommandError("Исходящее не найдено");
    if (out.state !== "draft") throw new CommandError("Комплект не в состоянии черновика");
    const current = await packageHash(await snapshotOf(tx, out));
    if (current !== input.shownHash || current !== out.packageHash) throw new CommandError("Комплект изменился после показа. Проверьте опись и согласуйте снова.");
    // Целостность файлов перед разрешением (OUT-02).
    for (const m of (out.manifest as ManifestEntry[]) ?? []) {
      const v = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, m.versionId) });
      if (!v || v.sha256 !== m.sha256 || v.deletedAt || v.quarantine) throw new CommandError(`Файл «${m.name}» изменён или недоступен`);
    }
    const o = { id: out.id, state: out.state, version: out.version };
    await setOutState(tx, o, "approved", { approval: { approvedHash: current, approvedBy: user.id, approvedAt: new Date().toISOString() } });
    await enqueue(tx, { orgId, type: "outgoing.send", aggregateType: "outgoing", aggregateId: out.id, idempotencyKey: `outgoing.send:${out.id}:${current}`, correlationId });
    await audit(tx, { orgId, actor, action: "outgoing.approve_send", objectType: "outgoing", objectId: out.id, caseId: out.caseId, after: { approvedHash: current, numberDisplay: out.numberDisplay } });
    return { ok: true };
  });
  if (res.ok) await (await import("../handlers")).kick({ types: ["outgoing.send"], aggregateId: input.outgoingId, limit: 1 });
  return res;
}

export async function rejectPackage(user: SessionUser, input: { outgoingId: string; reason: string }) {
  const o0 = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
  return runCommand({ name: "outgoing.reject", user, permission: { action: "outgoing.approve_send", caseId: o0?.caseId } }, async ({ tx, actor }) => {
    const out = await tx.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
    if (!out || out.state !== "draft") throw new CommandError("Комплект не на согласовании");
    await tx.update(schema.outgoings).set({ rejectedReason: input.reason, version: out.version + 1 }).where(eq(schema.outgoings.id, out.id));
    await audit(tx, { orgId: out.organizationId, actor, action: "outgoing.reject", objectType: "outgoing", objectId: out.id, caseId: out.caseId, basis: input.reason });
    return { ok: true };
  });
}

/* ───────────────────────── Фоновая отправка (OUT-06, OUT-07) ───────────────────────── */

async function afterSent(tx: Tx, out: typeof schema.outgoings.$inferSelect, sentAt: Date) {
  if (out.kind === "assignment") {
    const asg = await tx.query.assignments.findFirst({ where: eq(schema.assignments.outgoingId, out.id) });
    if (asg && asg.state === "sending") {
      await tx.update(schema.assignments).set({ state: "sent", sentAt, sentProviderId: out.providerMessageId, version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
    }
  }
  if (out.kind === "rka_package") {
    // M и Z вычисляются из одного подтверждённого события (REG-03).
    const kase = await tx.query.cases.findFirst({ where: eq(schema.cases.id, out.caseId) });
    if (kase && kase.state !== "sent") {
      if (["approved"].includes(kase.state)) assertTransition(CASE, "case", "approved", "sent");
      await tx.update(schema.cases).set({ state: "sent", updatedAt: new Date(), version: kase.version + 1 }).where(eq(schema.cases.id, kase.id));
    }
    if (out.cycleId) await tx.update(schema.cycles).set({ state: "finalized" }).where(eq(schema.cycles.id, out.cycleId));
  }
}

async function loadAttachmentsBytes(out: typeof schema.outgoings.$inferSelect) {
  const files: { filename: string; mimeType: string; bytes: Uint8Array }[] = [];
  for (const m of (out.manifest as ManifestEntry[]) ?? []) {
    const v = await db.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, m.versionId) });
    if (!v?.blobId) throw new Error(`Файл «${m.name}» не найден`);
    const b = await readBlob(v.blobId);
    if (b.sha256 !== m.sha256) throw new Error(`Файл «${m.name}» не совпал по SHA-256`);
    files.push({ filename: m.name, mimeType: m.mimeType, bytes: b.bytes });
  }
  return files;
}

async function sendHandler(row: OutboxRow) {
  const out = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, row.aggregateId) });
  if (!out) return { status: "dead" as const, error: "Исходящее не найдено" };
  if (out.state === "sent") return { status: "done" as const, note: "уже отправлено" };
  if (out.state === "unknown_result") return { status: "done" as const, note: "ожидает сверки" };
  if (out.state !== "approved") return { status: "dead" as const, error: `Состояние ${out.state} не допускает отправку` };

  // Повторная проверка: разрешение относится именно к этой версии пакета.
  const current = await packageHash(await snapshotOf(db, out));
  const approval = out.approval as { approvedHash: string } | null;
  if (!approval || approval.approvedHash !== current) {
    await db.transaction(async (tx) => {
      await setOutState(tx, { id: out.id, state: out.state, version: out.version }, "approval_stale");
      await audit(tx, { orgId: out.organizationId, actor: SERVICE_ACTOR, action: "outgoing.approval_stale", objectType: "outgoing", objectId: out.id, caseId: out.caseId });
    });
    return { status: "dead" as const, error: "Разрешение устарело" };
  }
  const account = await getPrimaryAccount(out.organizationId);
  const adapter = getMailAdapter();
  if (adapter.mode === "gmail" && (!account || !["connected", "up_to_date", "syncing", "delayed"].includes(account.state))) {
    return { status: "retry" as const, error: "Почтовый ящик комиссии не подключён", delayMs: 5 * 60_000 };
  }
  const files = await loadAttachmentsBytes(out);

  // Зафиксировать попытку ДО вызова провайдера.
  await db.transaction(async (tx) => {
    await setOutState(tx, { id: out.id, state: out.state, version: out.version }, "sending", { attempts: out.attempts + 1 });
  });
  try {
    const r = await adapter.sendApprovedPackage(account?.id ?? "dry-run", {
      from: out.fromAddr,
      to: out.toAddrs,
      cc: out.ccAddrs,
      bcc: out.bccAddrs,
      subject: out.subject,
      text: out.bodyText,
      html: out.bodyHtml,
      attachments: files,
      outgoingId: out.id,
    });
    await db.transaction(async (tx) => {
      const fresh = (await tx.query.outgoings.findFirst({ where: eq(schema.outgoings.id, out.id) }))!;
      const sentAt = new Date();
      await setOutState(tx, { id: fresh.id, state: fresh.state, version: fresh.version }, "sent", { providerMessageId: r.providerMessageId, providerThreadId: r.threadId, internetMessageId: r.internetMessageId, sentAt, reconcile: { verifiedAt: sentAt.toISOString(), mode: adapter.mode } });
      await afterSent(tx, { ...fresh, providerMessageId: r.providerMessageId }, sentAt);
      await audit(tx, { orgId: out.organizationId, actor: SERVICE_ACTOR, action: "outgoing.sent", objectType: "outgoing", objectId: out.id, caseId: out.caseId, after: { to: out.toAddrs, files: files.length, transport: adapter.mode }, externalIds: { providerMessageId: r.providerMessageId, threadId: r.threadId, internetMessageId: r.internetMessageId } });
    });
    return { status: "done" as const };
  } catch (e) {
    const unknown = e instanceof UnknownSendResultError;
    await db.transaction(async (tx) => {
      const fresh = (await tx.query.outgoings.findFirst({ where: eq(schema.outgoings.id, out.id) }))!;
      if (unknown) {
        await setOutState(tx, { id: fresh.id, state: fresh.state, version: fresh.version }, "unknown_result");
        await enqueue(tx, { orgId: out.organizationId, type: "outgoing.reconcile", aggregateType: "outgoing", aggregateId: out.id, idempotencyKey: `outgoing.reconcile:${out.id}:${fresh.attempts}`, delayMs: 90_000 });
      } else {
        await setOutState(tx, { id: fresh.id, state: fresh.state, version: fresh.version }, "error", { reconcile: { error: (e as Error).message } });
        await tx.insert(schema.tasks).values({ organizationId: out.organizationId, caseId: out.caseId, kind: "send_error", title: `Ошибка отправки ${out.kind === "assignment" ? "поручения" : `исх. №${out.numberDisplay}`}: ${(e as Error).message}`, assigneeRole: "secretary", objectType: "outgoing", objectId: out.id, dedupKey: `send_error:${out.id}:${fresh.attempts}` }).onConflictDoNothing();
      }
      await audit(tx, { orgId: out.organizationId, actor: SERVICE_ACTOR, action: unknown ? "outgoing.unknown_result" : "outgoing.error", objectType: "outgoing", objectId: out.id, caseId: out.caseId, result: "error", after: { error: (e as Error).message } });
    });
    if (e instanceof MailAuthError) return { status: "dead" as const, error: e.message };
    return { status: unknown ? ("done" as const) : ("dead" as const), error: (e as Error).message };
  }
}

async function reconcileHandler(row: OutboxRow) {
  const out = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, row.aggregateId) });
  if (!out || out.state !== "unknown_result") return { status: "done" as const };
  const account = await getPrimaryAccount(out.organizationId);
  const found = await getMailAdapter().reconcileSent(account?.id ?? "dry-run", out.id);
  await db.transaction(async (tx) => {
    const fresh = (await tx.query.outgoings.findFirst({ where: eq(schema.outgoings.id, out.id) }))!;
    if (found) {
      const sentAt = new Date();
      await setOutState(tx, { id: fresh.id, state: fresh.state, version: fresh.version }, "sent", { providerMessageId: found.providerMessageId, providerThreadId: found.threadId, internetMessageId: found.internetMessageId, sentAt, reconcile: { foundBy: "reconcile", at: sentAt.toISOString() } });
      await afterSent(tx, fresh, sentAt);
    } else {
      // OUT-06: отсутствие письма в результатах поиска — ещё не доказательство, что оно не ушло
      // (индексация Gmail запаздывает, поиск ограничен окном). Две сверки с интервалом,
      // затем решение о повторе принимает человек — автоматической повторной отправки нет.
      const prev = (fresh.reconcile as { misses?: number } | null)?.misses ?? 0;
      const misses = prev + 1;
      if (misses < 2) {
        await tx.update(schema.outgoings).set({ reconcile: { misses, lastCheckAt: new Date().toISOString() }, version: fresh.version + 1 }).where(eq(schema.outgoings.id, fresh.id));
        await enqueue(tx, { orgId: out.organizationId, type: "outgoing.reconcile", aggregateType: "outgoing", aggregateId: out.id, idempotencyKey: `outgoing.reconcile:${out.id}:miss:${misses}`, delayMs: 10 * 60_000 });
      } else {
        await tx.update(schema.outgoings).set({ reconcile: { misses, lastCheckAt: new Date().toISOString(), needsDecision: true }, version: fresh.version + 1 }).where(eq(schema.outgoings.id, fresh.id));
        await tx
          .insert(schema.tasks)
          .values({ organizationId: out.organizationId, caseId: out.caseId, kind: "send_unknown", title: `Результат отправки неизвестен: ${out.kind === "assignment" ? "поручение" : `исх. №${out.numberDisplay}`} не найдено в отправленных после двух сверок`, detail: "Проверьте папку «Отправленные» ящика комиссии. Если письма там нет — разрешите повторную отправку в карточке дела; если есть — отметьте отправку подтверждённой.", assigneeRole: "secretary", objectType: "outgoing", objectId: out.id, dedupKey: `send_unknown:${out.id}` })
          .onConflictDoNothing();
      }
    }
    await audit(tx, { orgId: out.organizationId, actor: SERVICE_ACTOR, action: "outgoing.reconcile", objectType: "outgoing", objectId: out.id, caseId: out.caseId, after: { found: !!found } });
  });
  return { status: "done" as const };
}

/**
 * OUT-06: решение по письму с неизвестным результатом после сверок.
 * «resend» — повтор той же утверждённой версии; «confirm_sent» — письмо найдено вручную в «Отправленных».
 */
export async function resolveUnknownSend(user: SessionUser, input: { outgoingId: string; decision: "resend" | "confirm_sent"; basis: string; providerMessageId?: string | null }) {
  const o0 = await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
  const res = await runCommand({ name: "outgoing.resolve_unknown", user, permission: { action: "outgoing.prepare", caseId: o0?.caseId } }, async ({ tx, actor }) => {
    const out = await tx.query.outgoings.findFirst({ where: eq(schema.outgoings.id, input.outgoingId) });
    if (!out || out.state !== "unknown_result") throw new CommandError("Письмо не в состоянии «Результат неизвестен»");
    if (input.basis.trim().length < 5) throw new CommandError("Укажите, что показала ручная проверка папки «Отправленные»");
    const o = { id: out.id, state: out.state, version: out.version };
    if (input.decision === "confirm_sent") {
      const sentAt = new Date();
      await setOutState(tx, o, "sent", { sentAt, providerMessageId: input.providerMessageId || out.providerMessageId, reconcile: { manual: true, by: user.fullName, basis: input.basis.trim(), at: sentAt.toISOString() } });
      await afterSent(tx, { ...out, providerMessageId: input.providerMessageId || out.providerMessageId }, sentAt);
    } else {
      await setOutState(tx, o, "approved", { reconcile: { manualResend: true, by: user.fullName, basis: input.basis.trim() } });
      await enqueue(tx, { orgId: out.organizationId, type: "outgoing.send", aggregateType: "outgoing", aggregateId: out.id, idempotencyKey: `outgoing.send:${out.id}:manual:${out.attempts}` });
    }
    await tx.update(schema.tasks).set({ state: "done", resolvedAt: new Date(), resolvedBy: user.id }).where(and(eq(schema.tasks.dedupKey, `send_unknown:${out.id}`), eq(schema.tasks.state, "open")));
    await audit(tx, { orgId: out.organizationId, actor, action: `outgoing.resolve_${input.decision}`, objectType: "outgoing", objectId: out.id, caseId: out.caseId, basis: input.basis.trim() });
    return { decision: input.decision };
  });
  if (res.ok && input.decision === "resend") await (await import("../handlers")).kick({ types: ["outgoing.send"], aggregateId: input.outgoingId, limit: 1 });
  return res;
}

export function registerOutgoingHandlers() {
  registerHandler("outgoing.send", sendHandler);
  registerHandler("outgoing.reconcile", reconcileHandler);
}

export { snapshotOf };
