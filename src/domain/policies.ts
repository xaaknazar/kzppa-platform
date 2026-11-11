/**
 * Политики организации (organizations.policies, jsonb).
 *
 * signature — как заключение становится окончательным перед отправкой в РКА:
 *  - "eds"            — личная ЭЦП председателя через SIGEX с проверкой (BR-05);
 *  - "chair_approval" — утверждение председателем в платформе без ЭЦП. Так Комиссия
 *    работает сейчас: председатель согласует заключение и письмо, подпись ЭЦП не ставится.
 * Отсутствие значения — "eds" (как в ТЗ).
 */
export type SignatureMode = "eds" | "chair_approval";

export interface OrgPolicies {
  signature?: SignatureMode;
}

export function signatureMode(policies: unknown): SignatureMode {
  return (policies as OrgPolicies | null)?.signature === "chair_approval" ? "chair_approval" : "eds";
}

/** Состояние карточки QR для заключения, утверждённого председателем без ЭЦП. */
export const CHAIR_APPROVED = "chair_approved";

export function isChairApproved(signatureStatus: unknown): boolean {
  return (signatureStatus as { state?: string } | null)?.state === CHAIR_APPROVED;
}

export const CHAIR_APPROVED_LABEL = {
  ru: "Утверждено председателем Комиссии (без ЭЦП)",
  kk: "Комиссия төрағасы бекітті (ЭЦҚ-сыз)",
} as const;
