import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { can } from "@/domain/acl";
import type { SessionUser } from "./auth";
import { caseIntakeCompleteness, toManifestItem } from "./services/cases";
import { summarizeManifest } from "@/domain/manifest";

/**
 * Чтение для интерфейса. Права применяются ДО выдачи данных, фрагментов и счётчиков
 * (UI-05, SEC-05): пользователь не узнаёт о недоступном деле даже по количеству.
 */

const staff = (u: SessionUser) => u.orgRoles.includes("chair") || u.orgRoles.includes("secretary");

export async function navCounts(u: SessionUser) {
  const out: Record<string, number> = {};
  if (staff(u)) {
    const [r] = await db.select({ n: count() }).from(schema.messages).where(and(eq(schema.messages.organizationId, u.orgId), inArray(schema.messages.intakeState, ["needs_review", "incomplete", "matched", "quarantine", "verified"]), isNull(schema.messages.caseId), eq(schema.messages.direction, "in")));
    out.inbox = r.n;
  }
  if (u.orgRoles.includes("chair")) {
    const [a] = await db.select({ n: count() }).from(schema.assignments).where(and(eq(schema.assignments.organizationId, u.orgId), eq(schema.assignments.state, "text_on_approval")));
    const [o] = await db.select({ n: count() }).from(schema.outgoings).where(and(eq(schema.outgoings.organizationId, u.orgId), eq(schema.outgoings.state, "draft"), eq(schema.outgoings.kind, "rka_package")));
    out.approvals = a.n + o.n;
  }
  const myVotes = await openVotesFor(u);
  out.votes = myVotes.filter((v) => !v.voted).length;
  const my = await db.select({ n: count() }).from(schema.assignments).where(and(eq(schema.assignments.executorId, u.id), inArray(schema.assignments.state, ["sent", "receipt_confirmed", "in_work", "on_rework"])));
  out.my = my[0].n;
  return out;
}

export async function openVotesFor(u: SessionUser) {
  const rows = await db
    .select({ cycle: schema.cycles, kase: schema.cases })
    .from(schema.caseMembers)
    .innerJoin(schema.cycles, eq(schema.cycles.id, schema.caseMembers.cycleId))
    .innerJoin(schema.cases, eq(schema.cases.id, schema.cycles.caseId))
    .where(and(eq(schema.caseMembers.userId, u.id), eq(schema.caseMembers.role, "voter"), eq(schema.caseMembers.active, true), eq(schema.cycles.state, "voting")));
  const ids = rows.map((r) => r.cycle.id);
  const voted = ids.length ? await db.select({ cycleId: schema.votes.cycleId }).from(schema.votes).where(and(inArray(schema.votes.cycleId, ids), eq(schema.votes.memberId, u.id))) : [];
  const set = new Set(voted.map((v) => v.cycleId));
  return rows.map((r) => ({ ...r, voted: set.has(r.cycle.id) }));
}

export async function dashboard(u: SessionUser) {
  const orgId = u.orgId;
  const tasks = staff(u)
    ? await db.query.tasks.findMany({
        where: and(eq(schema.tasks.organizationId, orgId), eq(schema.tasks.state, "open"), or(inArray(schema.tasks.assigneeRole, u.orgRoles), eq(schema.tasks.assigneeId, u.id))),
        orderBy: desc(schema.tasks.createdAt),
        limit: 30,
      })
    : [];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = staff(u)
    ? await db
        .select({ a: schema.assignments, c: schema.cases, e: schema.users })
        .from(schema.assignments)
        .innerJoin(schema.cases, eq(schema.cases.id, schema.assignments.caseId))
        .innerJoin(schema.users, eq(schema.users.id, schema.assignments.executorId))
        .where(and(eq(schema.assignments.organizationId, orgId), inArray(schema.assignments.state, ["sent", "receipt_confirmed", "in_work", "on_rework"]), lt(sql`coalesce(${schema.assignments.extendedUntil}, ${schema.assignments.deadline})`, today)))
    : [];
  const approvals = u.orgRoles.includes("chair")
    ? {
        assignments: await db
          .select({ a: schema.assignments, c: schema.cases, e: schema.users })
          .from(schema.assignments)
          .innerJoin(schema.cases, eq(schema.cases.id, schema.assignments.caseId))
          .innerJoin(schema.users, eq(schema.users.id, schema.assignments.executorId))
          .where(and(eq(schema.assignments.organizationId, orgId), eq(schema.assignments.state, "text_on_approval"))),
        packages: await db
          .select({ o: schema.outgoings, c: schema.cases })
          .from(schema.outgoings)
          .innerJoin(schema.cases, eq(schema.cases.id, schema.outgoings.caseId))
          .where(and(eq(schema.outgoings.organizationId, orgId), eq(schema.outgoings.kind, "rka_package"), eq(schema.outgoings.state, "draft"))),
        drafts: await db
          .select({ c: schema.cycles, k: schema.cases })
          .from(schema.cycles)
          .innerJoin(schema.cases, eq(schema.cases.id, schema.cycles.caseId))
          .where(and(eq(schema.cycles.organizationId, orgId), eq(schema.cycles.state, "preparation"), inArray(schema.cases.state, ["in_progress"]))),
        toSign: await db
          .select({ q: schema.qrCards, k: schema.cases, v: schema.documentVersions })
          .from(schema.qrCards)
          .innerJoin(schema.cases, eq(schema.cases.id, schema.qrCards.caseId))
          .innerJoin(schema.documentVersions, eq(schema.documentVersions.id, schema.qrCards.documentVersionId))
          .where(and(eq(schema.qrCards.organizationId, orgId), eq(schema.documentVersions.state, "ready_to_sign"))),
      }
    : null;
  const unknownSends = staff(u)
    ? await db.query.outgoings.findMany({ where: and(eq(schema.outgoings.organizationId, orgId), inArray(schema.outgoings.state, ["unknown_result", "error", "approval_stale", "bounced"])) })
    : [];
  const connections = staff(u) ? await db.query.mailAccounts.findMany({ where: eq(schema.mailAccounts.organizationId, orgId) }) : [];
  const deadOutbox = staff(u) ? await db.select({ n: count() }).from(schema.outbox).where(and(eq(schema.outbox.organizationId, orgId), eq(schema.outbox.status, "dead"))) : [{ n: 0 }];
  const votes = await openVotesFor(u);
  const myAssignments = await db
    .select({ a: schema.assignments, c: schema.cases })
    .from(schema.assignments)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.assignments.caseId))
    .where(and(eq(schema.assignments.executorId, u.id), inArray(schema.assignments.state, ["sent", "receipt_confirmed", "in_work", "on_rework", "draft_submitted"])));
  const stateCounts = staff(u)
    ? await db.select({ state: schema.cases.state, n: count() }).from(schema.cases).where(eq(schema.cases.organizationId, orgId)).groupBy(schema.cases.state)
    : [];
  return { tasks, overdue, approvals, unknownSends, connections, deadOutbox: deadOutbox[0].n, votes, myAssignments, stateCounts };
}

/** Полная карточка дела — только для корня (председатель, секретарь). */
export async function caseDetail(u: SessionUser, caseId: string) {
  if (!can(u.principal, "case.read_root", { caseId })) return null;
  const kase = await db.query.cases.findFirst({ where: and(eq(schema.cases.id, caseId), eq(schema.cases.organizationId, u.orgId)) });
  if (!kase) return null;
  const [messages, documents, cycles, assignments, outgoings, members, cards, signs, audits, tasks, users] = await Promise.all([
    db.query.messages.findMany({ where: eq(schema.messages.caseId, caseId), orderBy: asc(sql`coalesce(${schema.messages.receivedAt}, ${schema.messages.processedAt})`) }),
    db
      .select({ d: schema.documents, v: schema.documentVersions })
      .from(schema.documents)
      .innerJoin(schema.documentVersions, eq(schema.documentVersions.documentId, schema.documents.id))
      .where(eq(schema.documents.caseId, caseId))
      .orderBy(asc(schema.documentVersions.createdAt)),
    db.query.cycles.findMany({ where: eq(schema.cycles.caseId, caseId), orderBy: asc(schema.cycles.number) }),
    db.query.assignments.findMany({ where: eq(schema.assignments.caseId, caseId), orderBy: asc(schema.assignments.createdAt) }),
    db.query.outgoings.findMany({ where: eq(schema.outgoings.caseId, caseId), orderBy: asc(schema.outgoings.createdAt) }),
    db.select({ m: schema.caseMembers, u: schema.users }).from(schema.caseMembers).innerJoin(schema.users, eq(schema.users.id, schema.caseMembers.userId)).where(eq(schema.caseMembers.caseId, caseId)),
    db.query.qrCards.findMany({ where: eq(schema.qrCards.caseId, caseId) }),
    db.query.signSessions.findMany({ where: eq(schema.signSessions.caseId, caseId), orderBy: asc(schema.signSessions.createdAt) }),
    db.query.auditEvents.findMany({ where: eq(schema.auditEvents.caseId, caseId), orderBy: asc(schema.auditEvents.id), limit: 500 }),
    db.query.tasks.findMany({ where: and(eq(schema.tasks.caseId, caseId), eq(schema.tasks.state, "open")) }),
    db.query.users.findMany({ where: eq(schema.users.organizationId, u.orgId) }),
  ]);
  const attachments = messages.length ? await db.query.attachments.findMany({ where: inArray(schema.attachments.messageId, messages.map((m) => m.id)), orderBy: asc(schema.attachments.partId) }) : [];
  const votes = cycles.length ? await db.query.votes.findMany({ where: inArray(schema.votes.cycleId, cycles.map((c) => c.id)) }) : [];
  const completeness = await caseIntakeCompleteness(db, caseId);
  const manifests = new Map(messages.map((m) => [m.id, summarizeManifest(attachments.filter((a) => a.messageId === m.id).map(toManifestItem))]));
  return { kase, messages, attachments, manifests, documents, cycles, assignments, outgoings, members, cards, signs, audits, tasks, users, votes, completeness };
}

/** Рабочая область исполнителя: только порученные материалы, без корня и полной переписки. */
export async function executorWorkspace(u: SessionUser, caseId: string) {
  if (!can(u.principal, "case.read_workspace", { caseId })) return null;
  const kase = await db.query.cases.findFirst({ where: and(eq(schema.cases.id, caseId), eq(schema.cases.organizationId, u.orgId)) });
  if (!kase) return null;
  const docs = await db
    .select({ d: schema.documents, v: schema.documentVersions })
    .from(schema.documents)
    .innerJoin(schema.documentVersions, eq(schema.documentVersions.documentId, schema.documents.id))
    .where(and(eq(schema.documents.caseId, caseId), inArray(schema.documents.area, ["executor_workspace", "discussion"]), isNull(schema.documentVersions.deletedAt)))
    .orderBy(asc(schema.documentVersions.createdAt));
  const assignment = await db.query.assignments.findFirst({ where: and(eq(schema.assignments.caseId, caseId), eq(schema.assignments.executorId, u.id)), orderBy: desc(schema.assignments.createdAt) });
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) });
  return { kase, docs, assignment, org };
}

/** Комплект обсуждения цикла для члена комиссии (DEC-03). */
export async function discussion(u: SessionUser, cycleId: string) {
  const cycle = await db.query.cycles.findFirst({ where: and(eq(schema.cycles.id, cycleId), eq(schema.cycles.organizationId, u.orgId)) });
  if (!cycle || !can(u.principal, "case.read_discussion", { caseId: cycle.caseId, cycleId })) return null;
  const kase = (await db.query.cases.findFirst({ where: eq(schema.cases.id, cycle.caseId) }))!;
  const manifest = cycle.frozenManifest as { draft: { versionId: string; sha256: string; filename: string }; materials: string[] } | null;
  const ids = manifest ? [manifest.draft.versionId, ...manifest.materials] : [];
  const docs = ids.length
    ? await db.select({ d: schema.documents, v: schema.documentVersions }).from(schema.documentVersions).innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId)).where(inArray(schema.documentVersions.id, ids))
    : [];
  const myVote = await db.query.votes.findFirst({ where: and(eq(schema.votes.cycleId, cycleId), eq(schema.votes.memberId, u.id)) });
  const [{ n: votedCount }] = await db.select({ n: count() }).from(schema.votes).where(eq(schema.votes.cycleId, cycleId));
  return { cycle, kase, docs, myVote, votedCount, composition: ((cycle.eligibleSnapshot as unknown[]) ?? []).length };
}

/** Доступ к файлу версии: проверка права по области документа (AT-09). */
export async function canDownloadVersion(u: SessionUser, versionId: string) {
  const row = await db.select({ d: schema.documents, v: schema.documentVersions }).from(schema.documentVersions).innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId)).where(eq(schema.documentVersions.id, versionId)).limit(1);
  const r = row[0];
  if (!r || r.d.organizationId !== u.orgId) return null;
  const caseId = r.d.caseId;
  const ok =
    can(u.principal, "case.read_root", { caseId }) ||
    (r.d.area === "executor_workspace" && can(u.principal, "case.read_workspace", { caseId })) ||
    (r.d.area === "discussion" && (can(u.principal, "case.read_workspace", { caseId }) || (r.d.cycleId && can(u.principal, "case.read_discussion", { caseId, cycleId: r.d.cycleId })))) ||
    (r.d.area === "signed" && can(u.principal, "case.read_signed", { caseId }));
  return ok ? r : null;
}
