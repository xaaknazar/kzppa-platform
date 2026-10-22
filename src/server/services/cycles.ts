import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { tally, type DecisionRule, type QuorumRule, OUTCOME_LABEL } from "@/domain/quorum";
import { assertTransition, CASE, DOC_VERSION } from "@/domain/states";
import { formatBase, formatOutgoing } from "@/domain/numbering";
import { qrManifestHash, sha256Hex, type QrManifest } from "@/domain/hash";
import type { DocVersionState, VoteChoice } from "@/domain/types";
import { audit } from "../audit";
import { CommandError, expectVersion, runCommand } from "../command";
import { putImmutable, readBlob } from "../storage";
import type { SessionUser } from "../auth";
import { env } from "../env";
import { buildProtocolPdf } from "../docs/protocol-pdf";
import { buildFinalConclusionPdf } from "../docs/conclusion-pdf";
import { verificationUrl } from "../docs/qr";

/**
 * FLOW-04..08, FLOW-11..14, DEC-02, DEC-03. Циклы рассмотрения внутри одного дела.
 * Состояния цикла: preparation → preapproved → voting → closed → finalized.
 */

type Cycle = typeof schema.cycles.$inferSelect;

async function loadCycle(tx: Tx, cycleId: string, orgId: string) {
  const c = await tx.query.cycles.findFirst({ where: and(eq(schema.cycles.id, cycleId), eq(schema.cycles.organizationId, orgId)) });
  if (!c) throw new CommandError("Цикл рассмотрения не найден");
  const k = await tx.query.cases.findFirst({ where: eq(schema.cases.id, c.caseId) });
  return { cycle: c, kase: k! };
}

async function setVersionState(tx: Tx, versionId: string, to: DocVersionState) {
  const v = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, versionId) });
  if (!v) throw new CommandError("Версия документа не найдена");
  if (v.state === to) return v;
  assertTransition(DOC_VERSION, "document_version", v.state as DocVersionState, to);
  await tx.update(schema.documentVersions).set({ state: to }).where(eq(schema.documentVersions.id, versionId));
  return { ...v, state: to };
}

/** FLOW-04: обязательная предварительная проверка проекта председателем до обсуждения (AF). */
export async function preapproveDraft(user: SessionUser, input: { cycleId: string; draftVersionId: string; decision: "approve" | "rework"; remarks?: string; expectedVersion: number }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "draft.preapprove", user, permission: { action: "draft.preapprove", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    expectVersion(cycle.version, input.expectedVersion);
    if (!["preparation", "preapproved"].includes(cycle.state)) throw new CommandError("Проект уже передан на обсуждение");
    const v = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, input.draftVersionId) });
    const d = v && (await tx.query.documents.findFirst({ where: eq(schema.documents.id, v.documentId) }));
    if (!v || !d || d.caseId !== kase.id || d.category !== "draft") throw new CommandError("Выберите проект заключения этого дела");
    if (input.decision === "rework") {
      if (!input.remarks?.trim()) throw new CommandError("Укажите замечания для доработки");
      await tx.update(schema.cycles).set({ version: cycle.version + 1 }).where(eq(schema.cycles.id, cycle.id));
      const asg = await tx.query.assignments.findFirst({ where: and(eq(schema.assignments.caseId, kase.id), eq(schema.assignments.state, "draft_submitted")) });
      if (asg) await tx.update(schema.assignments).set({ state: "on_rework", version: asg.version + 1 }).where(eq(schema.assignments.id, asg.id));
      await audit(tx, { orgId, actor, action: "draft.preapprove_rework", objectType: "document_version", objectId: v.id, caseId: kase.id, basis: input.remarks });
      return { state: cycle.state };
    }
    if (v.state === "working") await setVersionState(tx, v.id, "on_approval");
    await tx.update(schema.cycles).set({ state: "preapproved", draftVersionId: v.id, preapprovedBy: user.id, preapprovedAt: new Date(), version: cycle.version + 1 }).where(eq(schema.cycles.id, cycle.id));
    if (kase.state === "assigned") await tx.update(schema.cases).set({ state: "in_progress" }).where(eq(schema.cases.id, kase.id));
    await audit(tx, { orgId, actor, action: "draft.preapprove", objectType: "document_version", objectId: v.id, caseId: kase.id, after: { sha256: v.sha256 } });
    return { state: "preapproved" };
  });
}

/**
 * FLOW-05, DEC-03: открыть обсуждение и голосование. Фиксируются версия проекта, манифест,
 * снимок состава и правила кворума/решения на дату открытия. Члены получают доступ
 * только к папке обсуждения этого цикла.
 */
export async function openVoting(user: SessionUser, input: { cycleId: string; closesAt: string; materialVersionIds?: string[]; expectedVersion: number }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "cycle.open_vote", user, permission: { action: "cycle.open_vote", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    expectVersion(cycle.version, input.expectedVersion);
    if (cycle.state !== "preapproved" || !cycle.draftVersionId) throw new CommandError("Сначала предварительно одобрите проект");
    const closesAt = new Date(input.closesAt);
    if (!(closesAt.getTime() > Date.now())) throw new CommandError("Время окончания голосования должно быть в будущем");
    const org = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
    const members = await tx
      .select({ id: schema.users.id, fullName: schema.users.fullName, email: schema.users.email })
      .from(schema.orgRoles)
      .innerJoin(schema.users, eq(schema.users.id, schema.orgRoles.userId))
      .where(and(eq(schema.orgRoles.organizationId, orgId), eq(schema.orgRoles.role, "member"), eq(schema.users.status, "active")))
      .orderBy(asc(schema.users.fullName));
    if (!members.length) throw new CommandError("Состав комиссии пуст");
    const draft = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, cycle.draftVersionId) });
    const frozenManifest = { draft: { versionId: draft!.id, sha256: draft!.sha256, filename: draft!.filename }, materials: input.materialVersionIds ?? [] };
    await tx
      .update(schema.cycles)
      .set({
        state: "voting",
        frozenManifest,
        eligibleSnapshot: members.map((m) => ({ userId: m.id, fullName: m.fullName })),
        quorumRule: org!.quorumRule,
        decisionRule: org!.decisionRule,
        openedAt: new Date(),
        closesAt,
        discussionNotifiedAt: new Date(),
        version: cycle.version + 1,
      })
      .where(eq(schema.cycles.id, cycle.id));
    // Пакетно: доступ к папке обсуждения и персональные приглашения (FLOW-05, FLOW-13).
    await tx.insert(schema.caseMembers).values(members.map((m) => ({ organizationId: orgId, caseId: kase.id, userId: m.id, role: "voter", cycleId: cycle.id, grantedBy: user.id })));
    const invitations = await Promise.all(members.map(async (m) => ({ organizationId: orgId, cycleId: cycle.id, memberId: m.id, token: (await sha256Hex(`${cycle.id}:${m.id}:${crypto.randomUUID()}`)).slice(0, 40), deliveryState: "pending" })));
    await tx.insert(schema.voteInvitations).values(invitations).onConflictDoNothing();
    // Документ обсуждения доступен членам только на чтение.
    const draftDoc = await tx.query.documents.findFirst({ where: eq(schema.documents.id, draft!.documentId) });
    if (draftDoc) await tx.update(schema.documents).set({ area: "discussion", cycleId: cycle.id }).where(eq(schema.documents.id, draftDoc.id));
    if (kase.state === "in_progress" || kase.state === "rework") {
      assertTransition(CASE, "case", kase.state as never, "review");
      await tx.update(schema.cases).set({ state: "review", updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
    }
    await audit(tx, { orgId, actor, action: "cycle.open_vote", objectType: "cycle", objectId: cycle.id, caseId: kase.id, after: { composition: members.length, closesAt, draftSha256: draft!.sha256 } });
    return { composition: members.length };
  });
}

/** FLOW-06: голос идентифицирован, привязан к участнику и снимку проекта; пересылка ссылки не даёт права. */
export async function castVote(user: SessionUser, input: { cycleId: string; choice: VoteChoice; comment?: string; specialOpinion?: string; idempotencyKey: string }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "vote.cast", user, idempotencyKey: input.idempotencyKey, permission: { action: "vote.cast", caseId: c0?.caseId, cycleId: input.cycleId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    if (cycle.state !== "voting") throw new CommandError("Голосование по этому циклу не идёт");
    if (cycle.closesAt && cycle.closesAt.getTime() < Date.now()) throw new CommandError("Срок голосования истёк");
    if (!["for", "against", "abstain"].includes(input.choice)) throw new CommandError("Неверный вариант голоса");
    const snap = (cycle.eligibleSnapshot as { userId: string }[]) ?? [];
    if (!snap.some((s) => s.userId === user.id)) throw new CommandError("Вы не входите в состав, имеющий право голоса в этом цикле");
    const existing = await tx.query.votes.findFirst({ where: and(eq(schema.votes.cycleId, cycle.id), eq(schema.votes.memberId, user.id)) });
    if (existing) throw new CommandError("Ваш голос уже учтён и не может быть изменён");
    await tx.insert(schema.votes).values({ organizationId: orgId, cycleId: cycle.id, memberId: user.id, choice: input.choice, comment: input.comment?.trim() || null, specialOpinion: input.specialOpinion?.trim() || null, draftVersionId: cycle.draftVersionId! });
    await audit(tx, { orgId, actor, action: "vote.cast", objectType: "cycle", objectId: cycle.id, caseId: kase.id, after: { draftVersionId: cycle.draftVersionId } });
    return { ok: true };
  });
}

/** FLOW-07, FLOW-12: закрытие голосования и автоматический протокол в том же деле. */
export async function closeVoting(user: SessionUser, input: { cycleId: string; earlyBasis?: string; expectedVersion: number }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "cycle.close_vote", user, permission: { action: "cycle.open_vote", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    expectVersion(cycle.version, input.expectedVersion);
    if (cycle.state !== "voting") throw new CommandError("Голосование не открыто");
    const early = !!cycle.closesAt && cycle.closesAt.getTime() > Date.now();
    if (early && (!input.earlyBasis || input.earlyBasis.trim().length < 5)) throw new CommandError("Досрочное закрытие требует основания");
    const snap = (cycle.eligibleSnapshot as { userId: string; fullName: string }[]) ?? [];
    const votes = await tx.query.votes.findMany({ where: eq(schema.votes.cycleId, cycle.id) });
    const t = tally({
      eligibleMemberIds: snap.map((s) => s.userId),
      recusedMemberIds: (cycle.recused as string[]) ?? [],
      votes: votes.map((v) => ({ memberId: v.memberId, choice: v.choice as VoteChoice, comment: v.comment })),
      quorumRule: cycle.quorumRule as QuorumRule,
      decisionRule: cycle.decisionRule as DecisionRule,
      chairMemberId: kase.chairId,
    });
    const name = new Map(snap.map((s) => [s.userId, s.fullName]));
    const org = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
    const exec = kase.executorId ? await tx.query.users.findFirst({ where: eq(schema.users.id, kase.executorId) }) : null;
    const chair = kase.chairId ? await tx.query.users.findFirst({ where: eq(schema.users.id, kase.chairId) }) : null;
    const draft = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, cycle.draftVersionId!) });
    const closedAt = new Date();
    const pdf = await buildProtocolPdf({
      lang: (kase.lang as "ru" | "kk") ?? "ru",
      commissionName: org!.name,
      caseNumber: formatBase(kase.number),
      cycleNumber: cycle.number,
      applicant: kase.applicant,
      executorFullName: exec?.fullName ?? "—",
      chairFullName: chair?.fullName ?? "—",
      draftVersionLabel: `${draft?.filename ?? "проект"} (версия ${draft?.version ?? "?"})`,
      draftSha256: draft?.sha256 ?? "",
      openedAt: cycle.openedAt!,
      closedAt,
      eligible: snap.map((s) => ({ fullName: s.fullName })),
      votes: votes.map((v) => ({ fullName: name.get(v.memberId) ?? v.memberId, choice: v.choice as VoteChoice, comment: v.comment, specialOpinion: v.specialOpinion })),
      notParticipated: snap.filter((s) => !votes.some((v) => v.memberId === s.userId)).map((s) => ({ fullName: s.fullName })),
      tally: t,
    } as Parameters<typeof buildProtocolPdf>[0]);
    const blob = await putImmutable(orgId, pdf, "application/pdf", undefined, tx);
    const [doc] = await tx.insert(schema.documents).values({ organizationId: orgId, caseId: kase.id, cycleId: cycle.id, category: "protocol", title: `Протокол голосования, дело №${formatBase(kase.number)}, цикл ${cycle.number}`, lang: kase.lang, area: "root" }).returning();
    const [ver] = await tx.insert(schema.documentVersions).values({ organizationId: orgId, documentId: doc.id, version: 1, state: "approved", blobId: blob.id, sha256: blob.sha256, size: blob.size, format: "pdf", filename: `protocol-${formatBase(kase.number)}-${cycle.number}.pdf`, generator: { kind: "protocol", template: "protocol-v1" } }).returning();
    await tx
      .update(schema.cycles)
      .set({ state: "closed", closedAt, earlyCloseBasis: early ? input.earlyBasis!.trim() : null, tally: t, protocolVersionId: ver.id, protocolHash: blob.sha256, version: cycle.version + 1 })
      .where(eq(schema.cycles.id, cycle.id));
    // Доступ голосовавших к папке обсуждения закрытого цикла — по политике (DEC-03); пока оставляем чтение.
    await audit(tx, { orgId, actor, action: "cycle.close_vote", objectType: "cycle", objectId: cycle.id, caseId: kase.id, after: { tally: t, protocolHash: blob.sha256 }, basis: early ? input.earlyBasis : null });
    return { outcome: t.outcome, label: OUTCOME_LABEL[t.outcome] };
  });
}

/**
 * FLOW-08: два маршрута. «Принять без изменений как финал» — та же проверенная версия
 * без повторной отправки файла. «Запросить доработку» — поручение исполнителю на финализацию.
 */
export async function chooseFinalRoute(user: SessionUser, input: { cycleId: string; route: "as_is" | "rework"; remarks?: string; expectedVersion: number }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "conclusion.route", user, permission: { action: "conclusion.finalize", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    expectVersion(cycle.version, input.expectedVersion);
    if (cycle.state !== "closed") throw new CommandError("Сначала завершите голосование и сформируйте протокол");
    const t = cycle.tally as { outcome: string } | null;
    if (input.route === "as_is") {
      if (t?.outcome !== "accepted") throw new CommandError("Принять без изменений можно только при принятом решении по протоколу");
      await tx.update(schema.cycles).set({ finalRoute: "as_is", finalVersionId: cycle.draftVersionId, version: cycle.version + 1 }).where(eq(schema.cycles.id, cycle.id));
    } else {
      if (!input.remarks?.trim()) throw new CommandError("Зафиксируйте замечания для доработки (в том числе устные)");
      await tx.update(schema.cycles).set({ finalRoute: "rework", version: cycle.version + 1 }).where(eq(schema.cycles.id, cycle.id));
      await tx.update(schema.cases).set({ state: "rework", updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
    }
    await audit(tx, { orgId, actor, action: `conclusion.route_${input.route}`, objectType: "cycle", objectId: cycle.id, caseId: kase.id, basis: input.remarks ?? null });
    return { route: input.route };
  });
}

/** FLOW-14: утвердить окончательную редакцию (W, X). Номер заключения (V) — по правилу DOC-08. */
export async function approveFinal(user: SessionUser, input: { cycleId: string; versionId: string; conformityNote?: string; expectedVersion: number }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "conclusion.approve", user, permission: { action: "conclusion.finalize", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    expectVersion(cycle.version, input.expectedVersion);
    if (cycle.state !== "closed" || !cycle.finalRoute) throw new CommandError("Сначала выберите маршрут финализации");
    if (cycle.finalRoute === "as_is" && input.versionId !== cycle.draftVersionId) throw new CommandError("При принятии без изменений финалом может быть только проголосованная версия");
    if (cycle.finalRoute === "rework") {
      if (input.versionId === cycle.draftVersionId) throw new CommandError("Ожидается доработанная редакция от исполнителя");
      if (!input.conformityNote || input.conformityNote.trim().length < 5) throw new CommandError("Отметьте, как учтены замечания: нельзя приписать новой редакции одобрение старой без проверки (FLOW-14)");
    }
    const t = cycle.tally as { outcome: string } | null;
    if (t?.outcome !== "accepted") throw new CommandError("Утверждение возможно только при принятом решении");
    // Номер заключения: основа номера дела + индекс по числу ранее утверждённых заключений дела.
    const approvedBefore = (await tx.query.cycles.findMany({ where: and(eq(schema.cycles.caseId, kase.id)) })).filter((c) => c.conclusionNumber && c.id !== cycle.id).length;
    const conclusionNumber = formatOutgoing({ caseNumber: kase.number, repeatIndex: approvedBefore });
    await tx.update(schema.cycles).set({ finalVersionId: input.versionId, approvedBy: user.id, approvedAt: new Date(), conclusionNumber, conclusionDate: new Date().toISOString().slice(0, 10), version: cycle.version + 1 }).where(eq(schema.cycles.id, cycle.id));
    const v = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, input.versionId) });
    if (v?.state === "working") await setVersionState(tx, v.id, "on_approval");
    if (v && ["working", "on_approval"].includes(v.state)) await setVersionState(tx, v.id, "approved");
    if (["review", "rework", "in_progress"].includes(kase.state)) await tx.update(schema.cases).set({ state: "approved", resultCode: "accepted", resultAt: new Date(), updatedAt: new Date() }).where(eq(schema.cases.id, kase.id));
    await audit(tx, { orgId, actor, action: "conclusion.approve", objectType: "document_version", objectId: input.versionId, caseId: kase.id, after: { conclusionNumber }, basis: input.conformityNote ?? null });
    return { conclusionNumber };
  });
}

/**
 * DOC-03..05, DOC-12: подготовить PDF с постоянным QR ДО подписи. Манифест фиксируется,
 * его хеш кодируется в QR-адресе, затем формируется PDF; хеш PDF сохраняется отдельно.
 */
export async function prepareSignablePdf(user: SessionUser, input: { cycleId: string; expectedVersion: number }) {
  const c0 = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, input.cycleId) });
  return runCommand({ name: "conclusion.prepare_pdf", user, permission: { action: "conclusion.finalize", caseId: c0?.caseId } }, async ({ tx, actor, orgId }) => {
    const { cycle, kase } = await loadCycle(tx, input.cycleId, orgId);
    expectVersion(cycle.version, input.expectedVersion);
    if (!cycle.approvedAt || !cycle.finalVersionId) throw new CommandError("Окончательная редакция ещё не утверждена");
    const existingCard = await tx.query.qrCards.findFirst({ where: eq(schema.qrCards.cycleId, cycle.id) });
    if (existingCard) {
      const v = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, existingCard.documentVersionId) });
      if (v && v.state !== "superseded") throw new CommandError("PDF для подписи уже подготовлен");
    }
    const source = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, cycle.finalVersionId) });
    if (!source?.blobId) throw new CommandError("Файл окончательной редакции не найден");
    const fmt = (source.format ?? "").toLowerCase();
    if (fmt !== "pdf" && fmt !== "docx") throw new CommandError("Для подготовки PDF нужен файл Word (DOCX) или PDF");
    const exec = kase.executorId ? await tx.query.users.findFirst({ where: eq(schema.users.id, kase.executorId) }) : null;
    const chair = await tx.query.users.findFirst({ where: eq(schema.users.id, cycle.approvedBy!) });
    const t = cycle.tally as ReturnType<typeof tally>;
    const [convDoc] = await tx
      .insert(schema.documents)
      .values({ organizationId: orgId, caseId: kase.id, cycleId: cycle.id, category: "conclusion", title: `${cycle.supplementary ? "Дополнительное заключение" : "Заключение"} №${cycle.conclusionNumber}`, lang: kase.conclusionLang ?? kase.lang, area: "signed" })
      .returning();
    const [ver] = await tx
      .insert(schema.documentVersions)
      .values({ organizationId: orgId, documentId: convDoc.id, version: 1, state: "working", format: "pdf", filename: `conclusion-${(cycle.conclusionNumber ?? "").replace("/", "-")}.pdf`, createdFrom: source.id, authorId: user.id })
      .returning();
    const manifest: QrManifest = {
      caseId: kase.id,
      caseNumber: formatBase(kase.number),
      cycleId: cycle.id,
      cycleNumber: cycle.number,
      documentVersionId: ver.id,
      conclusionNumber: cycle.conclusionNumber!,
      conclusionDate: cycle.conclusionDate!,
      applicant: kase.applicant,
      executorFullName: exec?.fullName ?? "—",
      chairFullName: chair?.fullName ?? "—",
      approvedAt: cycle.approvedAt.toISOString(),
      protocolHash: cycle.protocolHash ?? "",
      vote: { composition: t.composition, participated: t.participated, for: t.for, against: t.against, abstain: t.abstain, notParticipated: t.notParticipated, quorumReached: t.quorumReached, outcome: t.outcome },
      supplementary: cycle.supplementary,
    };
    const manifestHash = await qrManifestHash(manifest);
    const token = (await sha256Hex(`${ver.id}:${crypto.randomUUID()}`)).slice(0, 32);
    const qrUrl = verificationUrl(token, manifestHash);
    const src = await readBlob(source.blobId, tx);
    const built = await buildFinalConclusionPdf({ source: { bytes: src.bytes, format: fmt as "pdf" | "docx", filename: source.filename ?? "conclusion" }, qrUrl, lang: ((kase.conclusionLang ?? kase.lang) as "ru" | "kk") ?? "ru" });
    if (!built.textCheck.ok) throw new CommandError(`Проверка PDF не пройдена: ${built.textCheck.issues.join("; ")}`);
    const blob = await putImmutable(orgId, built.bytes, "application/pdf", undefined, tx);
    await tx.update(schema.documentVersions).set({ blobId: blob.id, sha256: blob.sha256, size: blob.size, generator: { ...built.generator, qrPlacement: built.qrPlacement, pages: built.pages, envAppUrl: env.appUrl } }).where(eq(schema.documentVersions.id, ver.id));
    await setVersionState(tx, ver.id, "on_approval");
    await setVersionState(tx, ver.id, "approved");
    await setVersionState(tx, ver.id, "ready_to_sign");
    await tx.insert(schema.qrCards).values({ organizationId: orgId, caseId: kase.id, cycleId: cycle.id, documentVersionId: ver.id, token, manifest, manifestHash, pdfSha256: blob.sha256, signatureStatus: { state: "not_signed", label: "Подпись ещё не подтверждена" } });
    await audit(tx, { orgId, actor, action: "conclusion.prepare_pdf", objectType: "document_version", objectId: ver.id, caseId: kase.id, after: { manifestHash, pdfSha256: blob.sha256, qrPlacement: built.qrPlacement } });
    return { versionId: ver.id, token };
  });
}

export async function cyclesOf(caseId: string): Promise<Cycle[]> {
  return db.query.cycles.findMany({ where: eq(schema.cycles.caseId, caseId), orderBy: asc(schema.cycles.number) });
}
