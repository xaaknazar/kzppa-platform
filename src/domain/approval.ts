/**
 * BR-04, FLOW-02, FLOW-10, OUT-04. Согласие председателя связано с хешем
 * конкретной версии: текст, адресат, срок, ссылка и состав материалов (для поручения)
 * либо весь канонический пакет (для исходящего в РКА). Любое изменение аннулирует согласие.
 */

import { hashCanonical } from "./hash";

export interface AssignmentLetterSnapshot {
  to: string;
  lang: "ru" | "kk";
  subject: string;
  bodyText: string;
  deadline: string; // ISO date
  workspaceLink: string;
  materialVersionIds: string[];
}

export function assignmentHash(s: AssignmentLetterSnapshot): Promise<string> {
  return hashCanonical({
    ...s,
    to: s.to.toLowerCase(),
    materialVersionIds: [...s.materialVersionIds].sort(),
  });
}

export interface Approval {
  approvedHash: string;
  approvedBy: string;
  approvedAt: string;
}

export type ApprovalCheck =
  | { ok: true }
  | { ok: false; reason: "not_approved" | "stale"; message: string };

export function checkApproval(approval: Approval | null | undefined, currentHash: string): ApprovalCheck {
  if (!approval) return { ok: false, reason: "not_approved", message: "Текст не утверждён председателем" };
  if (approval.approvedHash !== currentHash)
    return {
      ok: false,
      reason: "stale",
      message: "Содержимое изменилось после согласия — требуется повторное утверждение",
    };
  return { ok: true };
}
