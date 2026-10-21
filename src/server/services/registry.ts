import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { formatBase } from "@/domain/numbering";
import { OUTCOME_LABEL, type DecisionOutcome } from "@/domain/quorum";
import { ASSIGNMENT_STATE_LABEL, CASE_STATE_LABEL, OUTGOING_STATE_LABEL } from "@/domain/states";
import type { AssignmentState, CaseState, OutgoingState } from "@/domain/types";

/**
 * Раздел 25, REG-01..03. Каждое поле реестра вычисляется из подтверждённого события.
 * Пустая ячейка до события — нормальное состояние; значения не придумываются.
 * Основная строка показывает актуальный цикл, прежние циклы доступны в истории.
 */

export const REGISTRY_COLUMNS = [
  ["A", "№"],
  ["B", "№ письма РКА"],
  ["C", "Дата поступления"],
  ["D", "Регион / коллегия"],
  ["E", "Заявитель"],
  ["F", "Краткое содержание"],
  ["G", "Кому поручено"],
  ["H", "Дата поручения"],
  ["I", "Срок рассмотрения"],
  ["J", "Продление до"],
  ["K", "Результат рассмотрения"],
  ["L", "Дата результата"],
  ["M", "Дата направления в РКА"],
  ["N", "Меры / итог"],
  ["O", "Ссылка на электронное дело"],
  ["P", "Дата поступления проекта заключения"],
  ["Q", "Дата передачи Председателю"],
  ["R", "Дата направления на обсуждение"],
  ["S", "Дата голосования"],
  ["T", "Результат голосования"],
  ["U", "Дата поступления окончательного заключения на почту Комиссии"],
  ["V", "№ заключения"],
  ["W", "Статус утверждения"],
  ["X", "Дата утверждения"],
  ["Y", "Ссылка на итоговый PDF"],
  ["Z", "Дата отправки в РКА"],
  ["AA", "Статус отправки в РКА"],
  ["AB", "ID письма"],
  ["AC", "Дата уведомления исполнителя"],
  ["AD", "Статус уведомления"],
  ["AE", "Решение Председателя по назначению исполнителя"],
  ["AF", "Решение Председателя по проекту заключения"],
  ["AG", "Статус отправки решения Председателя"],
  ["AH", "Поручение об окончательном заключении"],
  ["AI", "Дата отправки окончательного поручения"],
  ["AJ", "ID письма окончательного поручения"],
  ["AK", "Порог участников для поручения"],
] as const;

export type ColKey = (typeof REGISTRY_COLUMNS)[number][0];
export type RegistryRow = Record<ColKey, string | null> & {
  caseId: string;
  caseNumber: number;
  state: CaseState;
  stateLabel: string;
  cyclesCount: number;
  flags: { collegiumNeedsCheck: boolean; summaryMachine: boolean; overdue: boolean; incomplete: boolean };
};

const d = (x: Date | string | null | undefined) => {
  if (!x) return null;
  const v = typeof x === "string" ? new Date(x.length === 10 ? `${x}T00:00:00+05:00` : x) : x;
  return v.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" });
};

export async function buildRegistry(orgId: string, opts: { caseIds?: string[]; appUrl: string }): Promise<RegistryRow[]> {
  const where = opts.caseIds ? and(eq(schema.cases.organizationId, orgId), inArray(schema.cases.id, opts.caseIds)) : eq(schema.cases.organizationId, orgId);
  const cases = await db.query.cases.findMany({ where, orderBy: [desc(schema.cases.year), desc(schema.cases.number)] });
  if (!cases.length) return [];
  const ids = cases.map((c) => c.id);
  const [users, cycles, assignments, outgoings, messages, cards, docs, org] = await Promise.all([
    db.query.users.findMany({ where: eq(schema.users.organizationId, orgId) }),
    db.query.cycles.findMany({ where: inArray(schema.cycles.caseId, ids), orderBy: asc(schema.cycles.number) }),
    db.query.assignments.findMany({ where: inArray(schema.assignments.caseId, ids), orderBy: asc(schema.assignments.createdAt) }),
    db.query.outgoings.findMany({ where: inArray(schema.outgoings.caseId, ids), orderBy: asc(schema.outgoings.createdAt) }),
    db.query.messages.findMany({ where: inArray(schema.messages.caseId, ids), columns: { id: true, caseId: true, providerMessageId: true, receivedAt: true, intakeKind: true, direction: true, intakeState: true } }),
    db.query.qrCards.findMany({ where: inArray(schema.qrCards.caseId, ids) }),
    db
      .select({ caseId: schema.documents.caseId, cycleId: schema.documents.cycleId, category: schema.documents.category, createdAt: schema.documentVersions.createdAt, sourceMessageId: schema.documentVersions.sourceMessageId })
      .from(schema.documentVersions)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId))
      .where(and(inArray(schema.documents.caseId, ids), eq(schema.documents.category, "draft"))),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) }),
  ]);
  const name = new Map(users.map((u) => [u.id, u.fullName]));
  const quorum = org?.quorumRule as { kind: string; min?: number; composition?: number } | undefined;

  return cases.map((c) => {
    const cs = cycles.filter((x) => x.caseId === c.id);
    const cyc = cs.find((x) => x.id === c.currentCycleId) ?? cs[cs.length - 1];
    const asgs = assignments.filter((a) => a.caseId === c.id);
    const initial = [...asgs].reverse().find((a) => a.kind === "initial");
    const fin = [...asgs].reverse().find((a) => a.kind === "finalization");
    const pkg = [...outgoings].reverse().find((o) => o.caseId === c.id && o.kind === "rka_package" && (!cyc || o.cycleId === cyc.id));
    const firstMsg = messages.find((m) => m.id === c.initialMessageId);
    const cyclesDrafts = docs.filter((x) => x.caseId === c.id).filter((x) => !cyc || x.cycleId === cyc.id || x.cycleId === null);
    const firstDraft = cyclesDrafts.sort((a, b) => +a.createdAt - +b.createdAt)[0];
    const card = cards.find((k) => k.cycleId === cyc?.id);
    const t = cyc?.tally as { composition: number; participated: number; for: number; against: number; abstain: number; notParticipated: number; quorumReached: boolean; outcome: DecisionOutcome } | null;
    const sentAt = pkg?.state === "sent" ? pkg.sentAt : null; // M и Z — из одного события
    const deadline = initial?.extendedUntil ?? initial?.deadline ?? null;
    const overdue = !!deadline && !["sent", "closed", "approved"].includes(c.state) && new Date(`${deadline}T23:59:59+05:00`).getTime() < Date.now();
    const incomplete = messages.some((m) => m.caseId === c.id && m.direction === "in" && m.intakeState === "incomplete");
    const finalPdfReady = card && card.signatureStatus && (card.signatureStatus as { state?: string }).state === "verified";

    const row: RegistryRow = {
      caseId: c.id,
      caseNumber: c.number,
      state: c.state as CaseState,
      stateLabel: CASE_STATE_LABEL[c.state as CaseState] ?? c.state,
      cyclesCount: cs.length,
      flags: { collegiumNeedsCheck: !c.collegium, summaryMachine: c.summaryMachine && !c.summaryManual, overdue, incomplete },
      A: formatBase(c.number),
      B: c.rkaNumber,
      C: d(c.receivedAt),
      D: c.collegium ?? ((c.collegiumCandidates as string[])?.length ? `Требует проверки: ${(c.collegiumCandidates as string[]).join("; ")}` : "Требует проверки"),
      E: c.applicant,
      F: c.summary,
      G: initial ? name.get(initial.executorId) ?? null : null,
      H: d(initial?.assignedAt),
      I: d(initial?.deadline),
      J: d(initial?.extendedUntil),
      K: c.resultCode ? (c.resultCode === "accepted" ? "Заключение утверждено" : c.resultCode) : CASE_STATE_LABEL[c.state as CaseState],
      L: d(c.resultAt),
      M: d(sentAt),
      N: c.measures,
      O: `${opts.appUrl}/cases/${c.id}`,
      P: d(firstDraft?.createdAt),
      Q: d(cyc?.preapprovedAt ?? (firstDraft ? firstDraft.createdAt : null)),
      R: d(cyc?.discussionNotifiedAt),
      S: d(cyc?.closedAt ?? cyc?.openedAt),
      T: t ? `Состав ${t.composition}, участвовали ${t.participated}: за ${t.for}, против ${t.against}, воздерж. ${t.abstain}, не участв. ${t.notParticipated}. ${t.quorumReached ? "Кворум есть" : "Кворума нет"}. ${OUTCOME_LABEL[t.outcome]}` : null,
      U: cyc?.finalRoute === "as_is" ? "Проект принят без изменений" : d(cyc?.finalReceivedAt),
      V: cyc?.conclusionNumber ?? null,
      W: cyc?.approvedAt ? "Утверждено председателем" : null,
      X: d(cyc?.approvedAt),
      Y: finalPdfReady ? `${opts.appUrl}/cases/${c.id}?tab=signatures` : null,
      Z: d(sentAt),
      AA: pkg ? OUTGOING_STATE_LABEL[pkg.state as OutgoingState] : null,
      AB: firstMsg?.providerMessageId ?? null,
      AC: d(initial?.sentAt),
      AD: initial ? ASSIGNMENT_STATE_LABEL[initial.state as AssignmentState] : null,
      AE: initial?.assignedBy ? `Назначен: ${name.get(initial.executorId) ?? ""}` : null,
      AF: cyc?.preapprovedAt ? "Предварительно одобрен" : null,
      AG: cyc?.preapprovedAt ? (cyc.discussionNotifiedAt ? "Члены уведомлены об обсуждении" : "Не уведомлены") : null,
      AH: fin ? fin.task : cyc?.finalRoute === "as_is" ? "Не требовалось: проект принят без изменений" : null,
      AI: d(fin?.sentAt),
      AJ: fin?.sentProviderId ?? null,
      AK: quorum?.kind === "min_participants" ? `${quorum.min} при составе ${quorum.composition}` : quorum ? "Более половины состава" : null,
    };
    return row;
  });
}

/** CSV-выгрузка реестра (AUD-05) с датой среза. */
export function registryToCsv(rows: RegistryRow[]) {
  const head = REGISTRY_COLUMNS.map(([k, l]) => `${k} ${l}`);
  const esc = (v: string | null) => (v == null ? "" : /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [head.map(esc).join(";"), ...rows.map((r) => REGISTRY_COLUMNS.map(([k]) => esc(r[k])).join(";"))];
  return "﻿" + lines.join("\r\n");
}
