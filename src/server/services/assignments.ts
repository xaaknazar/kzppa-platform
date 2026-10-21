import "server-only";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { assignmentHash, checkApproval, type Approval } from "@/domain/approval";
import { can, type Principal } from "@/domain/acl";
import { assignmentLetter } from "@/domain/templates";
import { assertTransition, ASSIGNMENT, CASE } from "@/domain/states";
import { formatBase } from "@/domain/numbering";
import type { AssignmentState, CaseRole, Lang } from "@/domain/types";
import { audit } from "../audit";
import { CommandError, expectVersion, runCommand } from "../command";
import { enqueue } from "../outbox";
import { packageHash } from "@/domain/hash";
import { idempotencyKey } from "@/domain/hash";
import type { SessionUser } from "../auth";
import { env } from "../env";
import { caseIntakeCompleteness } from "./cases";

const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00` : d) : d;
  return x.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" });
};

export const workspaceLink = (caseId: string) => `${env.appUrl}/w/${caseId}`;

async function principalFor(tx: Tx, userId: string): Promise<Principal> {
  const roles = await tx.select({ role: schema.orgRoles.role }).from(schema.orgRoles).where(eq(schema.orgRoles.userId, userId));
  const cr = await tx.select().from(schema.caseMembers).where(and(eq(schema.caseMembers.userId, userId), eq(schema.caseMembers.active, true)));
  return {
    userId,
    orgRoles: roles.map((r) => r.role as never),
    caseRoles: cr.map((c) => ({ caseId: c.caseId, role: c.role as CaseRole, cycleId: c.cycleId, active: c.active })),
  };
}

/** Материалы рабочей области исполнителя: исходные обращения и дополнения дела. */
async function workspaceMaterialVersions(tx: Tx, caseId: string) {
  const rows = await tx
    .select({ id: schema.documentVersions.id })
    .from(schema.documentVersions)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId))
    .where(and(eq(schema.documents.caseId, caseId), eq(schema.documents.area, "executor_workspace"), inArray(schema.documents.category, ["incoming_original", "supplement"])));
  return rows.map((r) => r.id);
}

async function buildLetter(tx: Tx, asg: typeof schema.assignments.$inferSelect) {
  const kase = await tx.query.cases.findFirst({ where: eq(schema.cases.id, asg.caseId) });
  const exec = await tx.query.users.findFirst({ where: eq(schema.users.id, asg.executorId) });
  const org = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, asg.organizationId) });
  const chair = kase?.chairId ? await tx.query.users.findFirst({ where: eq(schema.users.id, kase.chairId) }) : null;
  if (!kase || !exec || !org) throw new CommandError("Не найдены данные дела или исполнителя");
  const lang = asg.lang as Lang;
  const firstName = lang === "kk" ? exec.addressKk ?? exec.firstName : exec.firstName;
  if (!firstName) throw new CommandError(`В профиле ${exec.fullName} не подтверждено обращение по имени${lang === "kk" ? " на казахском" : " и отчеству"}. Заполните его в составе комиссии.`);
  const letter = assignmentLetter(lang, {
    addressee: { firstName, patronymic: lang === "kk" ? null : exec.patronymic },
    caseNumber: formatBase(kase.number),
    applicant: kase.applicant,
    rkaNumber: kase.rkaNumber ?? "—",
    rkaDate: fmtDate(kase.rkaDate),
    receivedAt: fmtDate(kase.receivedAt),
    summary: kase.summary ?? "—",
    subject: asg.task,
    deadline: fmtDate(asg.extendedUntil ?? asg.deadline),
    workspaceLink: asg.workspaceLink ?? workspaceLink(kase.id),
    replyTo: org.officialSender,
    chairFullName: chair?.fullName ?? "—",
    commissionName: lang === "kk" ? org.nameKk ?? org.name : org.name,
  });
  const materialVersionIds = await workspaceMaterialVersions(tx, kase.id);
  const hash = await assignmentHash({
    to: exec.email,
    lang,
    subject: letter.subject,
    bodyText: letter.text,
    deadline: asg.extendedUntil ?? asg.deadline ?? "",
    workspaceLink: asg.workspaceLink ?? workspaceLink(kase.id),
    materialVersionIds,
  });
  return { letter, hash, materialVersionIds, exec, kase, org };
}

async function setState(tx: Tx, asg: { id: string; state: string; version: number }, to: AssignmentState, patch: Partial<typeof schema.assignments.$inferInsert> = {}) {
  assertTransition(ASSIGNMENT, "assignment", asg.state as AssignmentState, to);
  await tx.update(schema.assignments).set({ ...patch, state: to, version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
  asg.state = to;
  asg.version += 1;
}

/**
 * ACL-03 + FLOW-01: председатель назначает исполнителя и срок. Это событие сразу
 * выдаёт ограниченный доступ к рабочей области, проверяет его и готовит черновик
 * поручения на языке обращения. Письмо остаётся черновиком до утверждения текста.
 */
export async function assignExecutor(
  user: SessionUser,
  input: { caseId: string; executorId: string; deadline: string; task: string; lang?: Lang | null; kind?: "initial" | "finalization"; idempotencyKey: string },
) {
  return runCommand({ name: "assignment.assign", user, idempotencyKey: input.idempotencyKey, permission: { action: "case.assign_executor", caseId: input.caseId } }, async ({ tx, actor, orgId }) => {
    const kase = await tx.query.cases.findFirst({ where: and(eq(schema.cases.id, input.caseId), eq(schema.cases.organizationId, orgId)) });
    if (!kase) throw new CommandError("Дело не найдено");
    const exec = await tx.query.users.findFirst({ where: and(eq(schema.users.id, input.executorId), eq(schema.users.organizationId, orgId), eq(schema.users.status, "active")) });
    if (!exec) throw new CommandError("Исполнитель не найден в составе комиссии");
    const isMember = await tx.query.orgRoles.findFirst({ where: and(eq(schema.orgRoles.userId, exec.id), inArray(schema.orgRoles.role, ["member", "chair", "secretary"])) });
    if (!isMember) throw new CommandError("Исполнитель должен входить в утверждённый состав комиссии");
    if (!exec.emailVerified && process.env.AUTH_MODE !== "demo") throw new CommandError(`Адрес ${exec.email} не подтверждён. Подтвердите его в составе комиссии.`);
    if (!input.task.trim()) throw new CommandError("Опишите предмет поручения");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deadline)) throw new CommandError("Укажите срок");
    const lang = (input.lang ?? kase.lang) as Lang | null;
    if (!lang) throw new CommandError("Язык обращения не определён — выберите язык поручения (DOC-01)");

    if ((input.kind ?? "initial") === "initial") {
      const completeness = await caseIntakeCompleteness(tx, kase.id);
      if (!completeness.complete) {
        throw new CommandError("Поступление не завершено: не все вложения сохранены и проверены. Передача дела исполнителю заблокирована (MAIL-08).");
      }
    }

    // Замена прежнего исполнителя: история сохраняется, права отзываются по политике.
    const prevExec = await tx.query.caseMembers.findMany({ where: and(eq(schema.caseMembers.caseId, kase.id), eq(schema.caseMembers.role, "executor"), eq(schema.caseMembers.active, true), ne(schema.caseMembers.userId, exec.id)) });
    for (const p of prevExec) {
      if ((input.kind ?? "initial") === "initial") {
        await tx.update(schema.caseMembers).set({ active: false, revokedAt: new Date() }).where(eq(schema.caseMembers.id, p.id));
        await audit(tx, { orgId, actor, action: "access.revoke", objectType: "case_member", objectId: p.id, caseId: kase.id, basis: "Замена исполнителя" });
      }
    }

    const [asg] = await tx
      .insert(schema.assignments)
      .values({
        organizationId: orgId,
        caseId: kase.id,
        cycleId: kase.currentCycleId,
        kind: input.kind ?? "initial",
        executorId: exec.id,
        preparedBy: user.id,
        assignedBy: user.id,
        assignedAt: new Date(),
        deadline: input.deadline,
        task: input.task.trim(),
        lang,
        state: "assigned_by_chair",
        workspaceLink: workspaceLink(kase.id),
      })
      .returning();
    const a = { ...asg };
    await audit(tx, { orgId, actor, action: "assignment.assign", objectType: "assignment", objectId: asg.id, caseId: kase.id, after: { executor: exec.fullName, deadline: input.deadline, lang } });

    // Выдача доступа к рабочей области (серверное представление с независимой проверкой прав).
    await setState(tx, a, "access_granting");
    const existing = await tx.query.caseMembers.findFirst({ where: and(eq(schema.caseMembers.caseId, kase.id), eq(schema.caseMembers.userId, exec.id), eq(schema.caseMembers.role, "executor"), eq(schema.caseMembers.active, true)) });
    if (!existing) {
      await tx.insert(schema.caseMembers).values({ organizationId: orgId, caseId: kase.id, userId: exec.id, role: "executor", grantedBy: user.id });
    }
    // ACL-04: перечитать фактические права и проверить, что корень закрыт.
    const p = await principalFor(tx, exec.id);
    const workspaceOk = can(p, "case.read_workspace", { caseId: kase.id });
    const rootClosed = !can(p, "case.read_root", { caseId: kase.id }) || p.orgRoles.some((r) => r === "chair" || r === "secretary");
    const accessResult = { checkedAt: new Date().toISOString(), workspace: workspaceOk, rootClosed, publicLinks: false, area: "executor_workspace" };
    if (!workspaceOk || !rootClosed) {
      await setState(tx, a, "access_error", { accessResult });
      await tx.insert(schema.tasks).values({ organizationId: orgId, caseId: kase.id, kind: "access_error", title: `Ошибка выдачи доступа исполнителю по делу №${formatBase(kase.number)}`, assigneeRole: "chair", objectType: "assignment", objectId: asg.id, dedupKey: `access_error:${asg.id}` }).onConflictDoNothing();
      throw new CommandError("Доступ исполнителю не подтверждён проверкой прав — отправка заблокирована");
    }
    await setState(tx, a, "access_verified", { accessResult });
    await audit(tx, { orgId, actor, action: "access.grant", objectType: "case_member", objectId: exec.id, caseId: kase.id, after: accessResult });

    // Черновик поручения на языке обращения.
    const built = await buildLetter(tx, { ...asg, state: a.state, version: a.version });
    await setState(tx, a, "draft_ready", { letterSubject: built.letter.subject, letterText: built.letter.text, letterHtml: built.letter.html, letterHash: built.hash, materialVersionIds: built.materialVersionIds });
    await setState(tx, a, "text_on_approval");

    if (input.kind !== "finalization" && kase.state !== "assigned") {
      if (["registered", "resumed"].includes(kase.state)) {
        assertTransition(CASE, "case", kase.state as never, "assigned");
        await tx.update(schema.cases).set({ state: "assigned", executorId: exec.id, version: kase.version + 1, updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
      } else {
        await tx.update(schema.cases).set({ executorId: exec.id, updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
      }
    }
    return { assignmentId: asg.id, letterHash: built.hash };
  });
}

/** Правка текста/срока черновика — согласие (если было) аннулируется (FLOW-02). */
export async function editAssignmentLetter(user: SessionUser, input: { assignmentId: string; expectedVersion: number; subject: string; text: string; deadline?: string | null }) {
  const asg0 = await db.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
  return runCommand({ name: "assignment.edit", user, permission: { action: "case.prepare_assignment", caseId: asg0?.caseId } }, async ({ tx, actor }) => {
    const asg = await tx.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
    if (!asg) throw new CommandError("Поручение не найдено");
    expectVersion(asg.version, input.expectedVersion);
    if (!["text_on_approval", "draft_ready", "approved_to_send"].includes(asg.state)) throw new CommandError("Текст отправленного поручения изменить нельзя");
    const exec = await tx.query.users.findFirst({ where: eq(schema.users.id, asg.executorId) });
    const deadline = input.deadline ?? asg.deadline;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = input.text
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 12px;font:15px/1.55 Arial,sans-serif;color:#17202b">${esc(p).replace(/\n/g, "<br>").replace(esc(asg.workspaceLink ?? ""), `<a href="${asg.workspaceLink}">${asg.lang === "kk" ? "Электрондық іске өту" : "Открыть электронное дело"}</a>`)}</p>`)
      .join("");
    const hash = await assignmentHash({ to: exec!.email, lang: asg.lang as Lang, subject: input.subject, bodyText: input.text, deadline: deadline ?? "", workspaceLink: asg.workspaceLink ?? "", materialVersionIds: (asg.materialVersionIds as string[]) ?? [] });
    const state = asg.state === "approved_to_send" ? "text_on_approval" : asg.state;
    await tx.update(schema.assignments).set({ letterSubject: input.subject, letterText: input.text, letterHtml: html, letterHash: hash, deadline, approval: null, state, version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
    await audit(tx, { orgId: asg.organizationId, actor, action: "assignment.edit_letter", objectType: "assignment", objectId: asg.id, objectVersion: asg.version + 1, caseId: asg.caseId, after: { hash, approvalReset: !!asg.approval } });
    return { letterHash: hash, version: asg.version + 1 };
  });
}

/**
 * «Утвердить поручение и отправить» (OUT-04): согласие привязано к хешу показанной
 * председателю версии; перед отправкой права перечитываются; затем автоматическая отправка.
 */
export async function approveAndSendAssignment(user: SessionUser, input: { assignmentId: string; shownHash: string; idempotencyKey: string }) {
  const asg0 = await db.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
  const res = await runCommand({ name: "assignment.approve_send", user, idempotencyKey: input.idempotencyKey, permission: { action: "assignment.approve_send", caseId: asg0?.caseId } }, async ({ tx, actor, orgId, correlationId }) => {
    const asg = await tx.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
    if (!asg) throw new CommandError("Поручение не найдено");
    if (asg.state !== "text_on_approval") throw new CommandError(`Поручение в состоянии «${asg.state}» — утверждение невозможно`);
    // Пересчитать хеш по текущим данным (адресат, материалы могли измениться).
    const exec = await tx.query.users.findFirst({ where: eq(schema.users.id, asg.executorId) });
    const materialVersionIds = await workspaceMaterialVersions(tx, asg.caseId);
    const currentHash = await assignmentHash({ to: exec!.email, lang: asg.lang as Lang, subject: asg.letterSubject ?? "", bodyText: asg.letterText ?? "", deadline: asg.extendedUntil ?? asg.deadline ?? "", workspaceLink: asg.workspaceLink ?? "", materialVersionIds });
    if (currentHash !== input.shownHash) {
      await tx.update(schema.assignments).set({ letterHash: currentHash, materialVersionIds, version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
      throw new CommandError("Содержимое поручения изменилось после показа (адресат, срок, ссылка или материалы). Проверьте текст и утвердите снова.");
    }
    // Повторная сверка прав (FLOW-10).
    const p = await principalFor(tx, exec!.id);
    if (!can(p, "case.read_workspace", { caseId: asg.caseId })) throw new CommandError("Доступ исполнителя к рабочей области не подтверждён — отправка заблокирована");

    const approval: Approval = { approvedHash: currentHash, approvedBy: user.id, approvedAt: new Date().toISOString() };
    const a = { id: asg.id, state: asg.state, version: asg.version };
    await setState(tx, a, "approved_to_send", { approval, letterHash: currentHash });
    const org = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
    const snapshot = { from: org!.officialSender, to: [exec!.email], cc: [], bcc: [], subject: asg.letterSubject ?? "", bodyText: asg.letterText ?? "", outgoingNumber: null, outgoingDate: null, files: [] };
    const pkgHash = await packageHash(snapshot);
    const [out] = await tx
      .insert(schema.outgoings)
      .values({
        organizationId: orgId,
        caseId: asg.caseId,
        cycleId: asg.cycleId,
        kind: "assignment",
        lang: asg.lang,
        fromAddr: org!.officialSender,
        toAddrs: [exec!.email], // OUT-05: без остальных членов в копии
        subject: snapshot.subject,
        bodyText: snapshot.bodyText,
        bodyHtml: asg.letterHtml,
        manifest: [],
        packageHash: pkgHash,
        approval: { approvedHash: pkgHash, approvedBy: user.id, approvedAt: approval.approvedAt, source: "assignment", assignmentHash: currentHash },
        state: "approved",
        idempotencyKey: await idempotencyKey("assignment-send", asg.id, currentHash),
      })
      .onConflictDoNothing({ target: schema.outgoings.idempotencyKey })
      .returning();
    if (!out) throw new CommandError("Эта версия поручения уже поставлена в отправку");
    await setState(tx, a, "sending", { outgoingId: out.id });
    await enqueue(tx, { orgId, type: "outgoing.send", aggregateType: "outgoing", aggregateId: out.id, idempotencyKey: `outgoing.send:${out.id}`, correlationId });
    await audit(tx, { orgId, actor, action: "assignment.approve_send", objectType: "assignment", objectId: asg.id, caseId: asg.caseId, after: { approvedHash: currentHash, outgoingId: out.id } });
    return { outgoingId: out.id };
  });
  if (res.ok) await (await import("../handlers")).kick({ types: ["outgoing.send"], aggregateId: res.data.outgoingId, limit: 1 });
  return res;
}

/** Отклонить черновик поручения: отправки нет, причина сохраняется (OUT-04). */
export async function rejectAssignmentLetter(user: SessionUser, input: { assignmentId: string; reason: string }) {
  const asg0 = await db.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
  return runCommand({ name: "assignment.reject", user, permission: { action: "assignment.approve_send", caseId: asg0?.caseId } }, async ({ tx, actor }) => {
    const asg = await tx.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
    if (!asg || asg.state !== "text_on_approval") throw new CommandError("Поручение не на утверждении");
    const a = { id: asg.id, state: asg.state, version: asg.version };
    await setState(tx, a, "draft_ready", { approval: null });
    await audit(tx, { orgId: asg.organizationId, actor, action: "assignment.reject", objectType: "assignment", objectId: asg.id, caseId: asg.caseId, basis: input.reason });
    return { ok: true };
  });
}

/** Вернуть черновик на утверждение после правок. */
export async function resubmitAssignment(user: SessionUser, input: { assignmentId: string }) {
  const asg0 = await db.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
  return runCommand({ name: "assignment.resubmit", user, permission: { action: "case.prepare_assignment", caseId: asg0?.caseId } }, async ({ tx }) => {
    const asg = await tx.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
    if (!asg || asg.state !== "draft_ready") throw new CommandError("Поручение не в состоянии черновика");
    await setState(tx, { id: asg.id, state: asg.state, version: asg.version }, "text_on_approval");
    return { ok: true };
  });
}

/** FLOW-03 / J: продление срока с основанием; прежний срок остаётся в истории (аудит). */
export async function extendDeadline(user: SessionUser, input: { assignmentId: string; until: string; basis: string }) {
  const asg0 = await db.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
  return runCommand({ name: "assignment.extend", user, permission: { action: "case.assign_executor", caseId: asg0?.caseId } }, async ({ tx, actor }) => {
    const asg = await tx.query.assignments.findFirst({ where: eq(schema.assignments.id, input.assignmentId) });
    if (!asg) throw new CommandError("Поручение не найдено");
    if (input.basis.trim().length < 5) throw new CommandError("Укажите основание продления");
    await tx.update(schema.assignments).set({ extendedUntil: input.until, extensionBasis: input.basis.trim(), version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
    await audit(tx, { orgId: asg.organizationId, actor, action: "assignment.extend", objectType: "assignment", objectId: asg.id, caseId: asg.caseId, before: { deadline: asg.deadline, extendedUntil: asg.extendedUntil }, after: { extendedUntil: input.until }, basis: input.basis });
    return { ok: true };
  });
}

export async function latestAssignment(caseId: string) {
  return db.query.assignments.findFirst({ where: eq(schema.assignments.caseId, caseId), orderBy: desc(schema.assignments.createdAt) });
}

export { checkApproval };
