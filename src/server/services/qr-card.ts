import "server-only";
import { eq } from "drizzle-orm";
import { OUTCOME_LABEL, type DecisionOutcome } from "@/domain/quorum";
import type { QrManifest } from "@/domain/hash";
import type { MANIFEST_PREFIX_LEN } from "../docs/qr"; // длина префикса ?h= в QR (16 hex)

/**
 * DOC-05, DOC-06, DOC-11, DOC-12, DOC-13. Публичная карточка проверки по постоянному QR (/v/[token]).
 *  - Данные берутся ТОЛЬКО из зафиксированного манифеста qr_cards.manifest и статуса проверки
 *    qr_cards.signatureStatus — числа не вводятся повторно и не пересчитываются.
 *  - Голосование — только агрегаты. ФИО голосовавших и индивидуальные голоса не возвращаются
 *    (DOC-06, DOC-11); модель собирается по белому списку полей.
 *  - До завершения проверки карточка не утверждает, что ЭЦП подтверждена (DOC-06, BR-05).
 */

export type SignatureCardState = "verified" | "pending" | "unavailable";

export interface PublicQrCard {
  commissionName: string;
  commissionNameKk: string | null;
  applicant: string;
  caseNumber: string;
  conclusionNumber: string;
  conclusionDate: string;
  executorFullName: string;
  chairFullName: string;
  approvedAt: string | null;
  signature: { state: SignatureCardState; label: string; labelKk: string; checkedAt: string | null; testOnly: boolean };
  vote: {
    composition: number;
    participated: number;
    for: number;
    against: number;
    abstain: number;
    notParticipated: number;
    quorumReached: boolean;
    outcome: DecisionOutcome | string;
    outcomeLabel: string;
  };
  /** DOC-13: дополнительное заключение отмечается явно. */
  supplementary: boolean;
  manifestHash: string;
  pdfSha256: string | null;
  /** Сравнить префикс ?h= из QR-адреса с хешем манифеста. */
  hashMatches: (h: string | null | undefined) => boolean;
}

interface StoredStatus {
  state?: string;
  label?: string;
  checkedAt?: string;
  cryptoValid?: boolean | null;
  trustChecked?: boolean | null;
  dryRun?: boolean;
}

const LABELS: Record<SignatureCardState, { ru: string; kk: string }> = {
  verified: { ru: "ЭЦП проверена", kk: "ЭЦҚ тексерілді" },
  pending: { ru: "Подпись ещё не подтверждена", kk: "Қолтаңба әлі расталмаған" },
  unavailable: { ru: "Проверка недоступна", kk: "Тексеру қолжетімсіз" },
};

/**
 * «ЭЦП проверена» — только если проверка завершена: сеанс verified, подпись криптографически
 * корректна и проверка доверия завершена. Тестовая подпись никогда не показывается как проверенная.
 */
function signatureView(st: StoredStatus | null): PublicQrCard["signature"] {
  const raw = st?.state ?? "not_signed";
  const testOnly = st?.dryRun === true;
  let state: SignatureCardState = "pending";
  if (raw === "unavailable") state = "unavailable";
  else if (raw === "verified" && !testOnly && st?.cryptoValid === true && st?.trustChecked === true) state = "verified";
  const base = LABELS[state];
  return {
    state,
    label: testOnly ? `${base.ru} (тестовая подпись без юридической силы)` : base.ru,
    labelKk: base.kk,
    checkedAt: state === "pending" && raw !== "verified" ? null : st?.checkedAt ?? null,
    testOnly,
  };
}

/** Префикс в QR — MANIFEST_PREFIX_LEN (16) hex; для ручного ввода допускается не менее 8 символов. */
export function hashPrefixMatches(manifestHash: string, h: string | null | undefined): boolean {
  if (h == null || h === "") return true; // параметр отсутствует — сверять нечего
  const p = h.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(p) || p.length < 8 || p.length > 64) return false;
  return manifestHash.toLowerCase().startsWith(p);
}

export async function getPublicQrCard(token: string): Promise<PublicQrCard | null> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  const { db, schema } = await import("@/db/client"); // ленивый импорт: hashPrefixMatches используется и без БД
  const card = await db.query.qrCards.findFirst({ where: eq(schema.qrCards.token, token) });
  if (!card) return null;
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, card.organizationId) });
  const m = card.manifest as QrManifest;
  const v = m.vote ?? ({} as QrManifest["vote"]);
  const outcome = v.outcome as DecisionOutcome;
  const manifestHash = card.manifestHash;
  return {
    commissionName: org?.name ?? "Комиссия по защите профессиональных прав адвокатов",
    commissionNameKk: org?.nameKk ?? null,
    applicant: m.applicant,
    caseNumber: m.caseNumber,
    conclusionNumber: m.conclusionNumber,
    conclusionDate: m.conclusionDate,
    executorFullName: m.executorFullName,
    chairFullName: m.chairFullName,
    approvedAt: m.approvedAt ?? null,
    signature: signatureView(card.signatureStatus as StoredStatus | null),
    vote: {
      composition: Number(v.composition) || 0,
      participated: Number(v.participated) || 0,
      for: Number(v.for) || 0,
      against: Number(v.against) || 0,
      abstain: Number(v.abstain) || 0,
      notParticipated: Number(v.notParticipated) || 0,
      quorumReached: !!v.quorumReached,
      outcome,
      outcomeLabel: OUTCOME_LABEL[outcome] ?? String(v.outcome ?? "—"),
    },
    supplementary: !!m.supplementary,
    manifestHash,
    pdfSha256: card.pdfSha256 ?? null,
    hashMatches: (h) => hashPrefixMatches(manifestHash, h),
  };
}
