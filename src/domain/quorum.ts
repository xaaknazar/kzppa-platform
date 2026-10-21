/**
 * FLOW-06, FLOW-07, FLOW-12, FLOW-13, DEC-02. Кворум, итоги и арифметика протокола.
 *
 * Подтверждено заказчиком: при составе 30 кворум — минимум 16 участвовавших.
 * Воздержавшиеся учитываются в числе участников, отсутствовавшие — нет.
 * Порядок определения решения — по действующему Положению комиссии. Платформа
 * НЕ выбирает большинство сама: правило задаётся настройкой с указанием пункта
 * и редакции Положения. Пока правило не задано, решение не может считаться принятым.
 */

import type { VoteChoice } from "./types";

export type QuorumRule =
  /** Минимальное число участвовавших задано явно (подтверждено: 16 при составе 30). */
  | { kind: "min_participants"; min: number; composition: number }
  /** Более половины состава: floor(N/2) + 1. Для N = 30 даёт 16. */
  | { kind: "more_than_half_of_composition" };

export type DecisionRule =
  | { kind: "unknown" }
  /** «За» больше половины участвовавших. */
  | { kind: "for_more_than_half_of_participants"; source: string }
  /** «За» больше, чем «Против» (воздержавшиеся не влияют). */
  | { kind: "for_more_than_against"; source: string }
  /** «За» больше половины состава. */
  | { kind: "for_more_than_half_of_composition"; source: string };

export interface VoteRecord {
  memberId: string;
  choice: VoteChoice;
  comment?: string | null;
}

export interface TallyInput {
  /** Список имеющих право голоса на момент открытия цикла (снимок состава). */
  eligibleMemberIds: string[];
  /** Отводы/исключения, если установлены регламентом. */
  recusedMemberIds?: string[];
  votes: VoteRecord[];
  quorumRule: QuorumRule;
  decisionRule: DecisionRule;
}

export type DecisionOutcome = "accepted" | "rejected" | "no_quorum" | "undetermined";

export interface Tally {
  composition: number; // состав (имеющие право голоса)
  recused: number;
  eligible: number; // состав минус отводы
  participated: number;
  for: number;
  against: number;
  abstain: number;
  notParticipated: number;
  quorumRequired: number;
  quorumReached: boolean;
  outcome: DecisionOutcome;
  /** Человекочитаемое правило для протокола. */
  quorumRuleText: string;
  decisionRuleText: string;
  arithmeticOk: boolean;
  errors: string[];
}

export function quorumRequired(rule: QuorumRule, composition: number): number {
  switch (rule.kind) {
    case "min_participants":
      if (rule.composition !== composition) {
        // Порог подтверждён для конкретного состава. При другом составе
        // нельзя молча переносить число — нужен пересмотр правила.
        throw new Error(
          `Порог кворума ${rule.min} утверждён для состава ${rule.composition}, а в цикле состав ${composition}. Нужна актуализация правила.`,
        );
      }
      return rule.min;
    case "more_than_half_of_composition":
      return Math.floor(composition / 2) + 1;
  }
}

export function describeQuorum(rule: QuorumRule, composition: number): string {
  const n = quorumRequired(rule, composition);
  return `Кворум: не менее ${n} участвовавших при составе ${composition}; воздержавшиеся учитываются как участвовавшие`;
}

export function describeDecision(rule: DecisionRule): string {
  switch (rule.kind) {
    case "unknown":
      return "Правило определения решения не зафиксировано по Положению";
    case "for_more_than_half_of_participants":
      return `«За» более половины участвовавших (${rule.source})`;
    case "for_more_than_against":
      return `«За» больше, чем «Против» (${rule.source})`;
    case "for_more_than_half_of_composition":
      return `«За» более половины состава (${rule.source})`;
  }
}

export function tally(input: TallyInput): Tally {
  const errors: string[] = [];
  const eligibleSet = new Set(input.eligibleMemberIds);
  const recused = new Set(
    (input.recusedMemberIds ?? []).filter((id) => eligibleSet.has(id)),
  );

  // Один участник — один голос; голоса не имеющих права отбрасываются с ошибкой.
  const byMember = new Map<string, VoteRecord>();
  for (const v of input.votes) {
    if (!eligibleSet.has(v.memberId)) {
      errors.push(`Голос участника ${v.memberId}, не входящего в снимок состава, не учтён`);
      continue;
    }
    if (recused.has(v.memberId)) {
      errors.push(`Голос участника ${v.memberId} с отводом не учтён`);
      continue;
    }
    if (byMember.has(v.memberId)) {
      errors.push(`Повторный голос участника ${v.memberId} не учтён`);
      continue;
    }
    byMember.set(v.memberId, v);
  }

  const composition = eligibleSet.size;
  const eligible = composition - recused.size;
  let f = 0,
    a = 0,
    ab = 0;
  for (const v of byMember.values()) {
    if (v.choice === "for") f++;
    else if (v.choice === "against") a++;
    else ab++;
  }
  const participated = f + a + ab;
  const notParticipated = eligible - participated;

  // FLOW-12: арифметические проверки протокола.
  const arithmeticOk =
    f + a + ab === participated &&
    participated + notParticipated + recused.size === composition &&
    notParticipated >= 0;
  if (!arithmeticOk) errors.push("Арифметика протокола не сходится");

  let qReq = 0;
  let quorumRuleText = "";
  try {
    qReq = quorumRequired(input.quorumRule, composition);
    quorumRuleText = describeQuorum(input.quorumRule, composition);
  } catch (e) {
    errors.push((e as Error).message);
    quorumRuleText = "Правило кворума не применимо к составу цикла";
    qReq = Number.POSITIVE_INFINITY;
  }
  const quorumReached = participated >= qReq;

  let outcome: DecisionOutcome;
  if (!arithmeticOk || !Number.isFinite(qReq)) outcome = "undetermined";
  else if (!quorumReached) outcome = "no_quorum";
  else {
    switch (input.decisionRule.kind) {
      case "unknown":
        outcome = "undetermined";
        break;
      case "for_more_than_half_of_participants":
        outcome = f > participated / 2 ? "accepted" : "rejected";
        break;
      case "for_more_than_against":
        outcome = f > a ? "accepted" : "rejected";
        break;
      case "for_more_than_half_of_composition":
        outcome = f > composition / 2 ? "accepted" : "rejected";
        break;
    }
  }

  return {
    composition,
    recused: recused.size,
    eligible,
    participated,
    for: f,
    against: a,
    abstain: ab,
    notParticipated,
    quorumRequired: Number.isFinite(qReq) ? qReq : 0,
    quorumReached,
    outcome,
    quorumRuleText,
    decisionRuleText: describeDecision(input.decisionRule),
    arithmeticOk,
    errors,
  };
}

export const OUTCOME_LABEL: Record<DecisionOutcome, string> = {
  accepted: "Решение принято",
  rejected: "Решение не принято",
  no_quorum: "Кворум не достигнут",
  undetermined: "Решение не определено",
};
