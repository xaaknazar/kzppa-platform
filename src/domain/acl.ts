/**
 * Раздел 4, ACL-01..06, BR-07. Права вычисляются сервером на каждый запрос.
 * При отсутствии полномочия — отказ. Участие в комиссии не даёт доступа ко всем делам.
 */

import type { CaseArea, CaseRole, OrgRole } from "./types";

export interface Principal {
  userId: string;
  orgRoles: OrgRole[];
  /** Роли в конкретных делах: caseId → роли; для voter — ещё и cycleId. */
  caseRoles: { caseId: string; role: CaseRole; cycleId?: string | null; active: boolean }[];
}

export type Action =
  | "case.read_root" // корень дела, полная переписка
  | "case.read_workspace" // материалы исполнителя
  | "case.read_discussion" // папка обсуждения цикла
  | "case.read_signed"
  | "case.register"
  | "case.attach"
  | "case.assign_executor" // ACL-03: только председатель
  | "case.prepare_assignment" // секретарь готовит кандидатуру
  | "assignment.approve_send" // «Утвердить поручение и отправить»
  | "draft.upload"
  | "draft.preapprove" // предварительное одобрение председателем
  | "cycle.open_vote"
  | "vote.cast"
  | "conclusion.finalize"
  | "conclusion.sign" // личная ЭЦП
  | "outgoing.prepare"
  | "outgoing.approve_send" // «Согласовать комплект и направить в РКА»
  | "intake.exclude_item"
  | "audit.read"
  | "admin.settings"
  | "admin.members";

const has = (p: Principal, r: OrgRole) => p.orgRoles.includes(r);
const hasCase = (p: Principal, caseId: string, role: CaseRole, cycleId?: string) =>
  p.caseRoles.some(
    (cr) =>
      cr.active && cr.caseId === caseId && cr.role === role && (cycleId === undefined || cr.cycleId === cycleId),
  );

export function can(
  p: Principal,
  action: Action,
  ctx: { caseId?: string; cycleId?: string } = {},
): boolean {
  const chair = has(p, "chair");
  const secretary = has(p, "secretary");
  const caseId = ctx.caseId ?? "";

  switch (action) {
    case "case.read_root":
      return chair || secretary; // ACL-01
    case "case.read_workspace":
      return chair || secretary || hasCase(p, caseId, "executor") || hasCase(p, caseId, "workspace_admin");
    case "case.read_discussion":
      return chair || secretary || hasCase(p, caseId, "voter", ctx.cycleId);
    case "case.read_signed":
      return chair || secretary || hasCase(p, caseId, "executor") || hasCase(p, caseId, "signer");
    case "case.register":
    case "case.attach":
    case "case.prepare_assignment":
    case "outgoing.prepare":
    case "intake.exclude_item":
      return chair || secretary;
    case "case.assign_executor":
    case "assignment.approve_send":
    case "draft.preapprove":
    case "cycle.open_vote":
    case "conclusion.finalize":
    case "outgoing.approve_send":
      return chair;
    case "conclusion.sign":
      return chair; // SIGN-01: подписывает лично председатель своей ЭЦП
    case "draft.upload":
      return chair || secretary || hasCase(p, caseId, "executor");
    case "vote.cast":
      return hasCase(p, caseId, "voter", ctx.cycleId);
    case "audit.read":
      return chair || secretary || has(p, "auditor");
    case "admin.settings":
    case "admin.members":
      return chair || has(p, "tech_admin");
  }
}

/** Набор областей дела, видимых пользователю. */
export function visibleAreas(p: Principal, caseId: string, cycleIds: string[]): CaseArea[] {
  const out: CaseArea[] = [];
  if (can(p, "case.read_root", { caseId })) out.push("root");
  if (can(p, "case.read_workspace", { caseId })) out.push("executor_workspace");
  if (cycleIds.some((cycleId) => can(p, "case.read_discussion", { caseId, cycleId }))) out.push("discussion");
  if (can(p, "case.read_signed", { caseId })) out.push("signed");
  return out;
}

/**
 * ACL-04. Желаемые права области дела по составу участников. Возвращается план
 * изменений; применяется последовательно (ARCH-08), затем права перечитываются.
 */
export interface DesiredGrant {
  email: string;
  role: "reader" | "commenter" | "writer";
  area: CaseArea;
}

export interface ActualGrant {
  email: string | null; // null для anyone/domain
  type: "user" | "group" | "domain" | "anyone";
  role: string;
  inherited: boolean;
  canReshare?: boolean;
}

export interface PermissionDiff {
  toAdd: DesiredGrant[];
  toRemove: ActualGrant[];
  violations: string[]; // публичные/доменные доступы, лишние наследуемые
  ok: boolean;
}

export function diffPermissions(desired: DesiredGrant[], actual: ActualGrant[], owners: string[]): PermissionDiff {
  const violations: string[] = [];
  const toAdd: DesiredGrant[] = [];
  const toRemove: ActualGrant[] = [];
  const keep = new Set([...owners.map((e) => e.toLowerCase())]);

  for (const g of actual) {
    if (g.type === "anyone") violations.push("Публичный доступ по ссылке (BR-08)");
    if (g.type === "domain") violations.push("Доменный доступ");
    if (g.canReshare && g.email && !keep.has(g.email.toLowerCase()))
      violations.push(`${g.email} может повторно предоставлять доступ`);
  }
  for (const d of desired) {
    const exists = actual.some((a) => a.email?.toLowerCase() === d.email.toLowerCase() && a.role === d.role);
    if (!exists) toAdd.push(d);
  }
  for (const a of actual) {
    const wanted =
      !a.email ||
      keep.has(a.email.toLowerCase()) ||
      desired.some((d) => d.email.toLowerCase() === a.email!.toLowerCase());
    if (!wanted || a.type === "anyone" || a.type === "domain") {
      toRemove.push(a);
      if (a.inherited) violations.push(`Лишнее наследуемое право: ${a.email ?? a.type}`);
    }
  }
  return { toAdd, toRemove, violations, ok: violations.length === 0 && toAdd.length === 0 && toRemove.length === 0 };
}
