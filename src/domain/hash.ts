/**
 * Канонические хеши. OUT-01 (хеш пакета по каноническому представлению),
 * DOC-12 (манифест QR), BR-04/FLOW-02 (разрешение связано с хешем текста).
 * Работает и в Node, и в Edge (Web Crypto).
 */

/** Детерминированная сериализация: ключи сортируются, undefined отбрасывается. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** OUT-01. Снимок пакета исходящего — всё, что меняет смысл отправки. */
export interface PackageSnapshot {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  outgoingNumber: string | null;
  outgoingDate: string | null;
  files: { name: string; size: number; sha256: string; versionId: string }[];
}

export function packageHash(p: PackageSnapshot): Promise<string> {
  return hashCanonical({
    ...p,
    to: [...p.to].map((s) => s.toLowerCase()).sort(),
    cc: [...p.cc].map((s) => s.toLowerCase()).sort(),
    bcc: [...p.bcc].map((s) => s.toLowerCase()).sort(),
    files: [...p.files].sort((a, b) => a.versionId.localeCompare(b.versionId)),
  });
}

/**
 * DOC-12. Манифест, хеш которого кодируется в постоянный QR ДО формирования PDF.
 * Хеш окончательного PDF сюда не входит (иначе циклическая зависимость).
 */
export interface QrManifest {
  caseId: string;
  caseNumber: string;
  cycleId: string;
  cycleNumber: number;
  documentVersionId: string;
  conclusionNumber: string;
  conclusionDate: string;
  applicant: string;
  executorFullName: string;
  chairFullName: string;
  approvedAt: string;
  protocolHash: string;
  vote: {
    composition: number;
    participated: number;
    for: number;
    against: number;
    abstain: number;
    notParticipated: number;
    quorumReached: boolean;
    outcome: string;
  };
  supplementary: boolean;
}

export function qrManifestHash(m: QrManifest): Promise<string> {
  return hashCanonical(m);
}

/** Ключ идемпотентности по смыслу операции (BR-06). */
export function idempotencyKey(...parts: (string | number)[]): Promise<string> {
  return sha256Hex(parts.join("␟"));
}
