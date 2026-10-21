/**
 * DOC-08, DEC-01. Нумерация исходящих комиссии.
 *
 * Основа — номер дела комиссии тремя цифрами. Первое направление по делу 001 — «001»,
 * первое повторное — «001/01», второе повторное — «001/02». Дробный индекс — две цифры,
 * увеличивается на каждое новое повторное направление по данному делу, независимо от причины.
 * Номер РКА (например 04-01/1351) хранится отдельно и никогда не смешивается с этой схемой.
 * Исторические документы с записью «001/1» не переименовываются (INC-06).
 */

export interface OutgoingNumber {
  caseNumber: number; // номер дела комиссии
  repeatIndex: number; // 0 — первое направление, 1 — первое повторное, ...
}

export function formatBase(caseNumber: number): string {
  if (!Number.isInteger(caseNumber) || caseNumber < 1) {
    throw new Error(`Некорректный номер дела: ${caseNumber}`);
  }
  return String(caseNumber).padStart(3, "0");
}

export function formatOutgoing(n: OutgoingNumber): string {
  const base = formatBase(n.caseNumber);
  if (!Number.isInteger(n.repeatIndex) || n.repeatIndex < 0) {
    throw new Error(`Некорректный индекс повторного направления: ${n.repeatIndex}`);
  }
  if (n.repeatIndex === 0) return base;
  if (n.repeatIndex > 99) throw new Error("Индекс повторного направления превышает 99");
  return `${base}/${String(n.repeatIndex).padStart(2, "0")}`;
}

/**
 * Полный реквизит с утвержденным префиксом и годом (DEC-01: префикс и место года
 * ещё утверждаются, поэтому они — настройки организации, а не константы).
 */
export function formatOutgoingFull(
  n: OutgoingNumber,
  opts: { prefix?: string | null; year?: number | null } = {},
): string {
  const core = formatOutgoing(n);
  const parts: string[] = [];
  if (opts.prefix) parts.push(opts.prefix);
  if (opts.year) parts.push(String(opts.year));
  return parts.length ? `${parts.join("-")}/${core}` : core;
}

/** Разбор номера. Поддерживает исторический формат «001/1» с флагом legacy. */
export function parseOutgoing(
  s: string,
): (OutgoingNumber & { legacy: boolean }) | null {
  const m = s.trim().match(/(?:^|\/)(\d{3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const caseNumber = Number(m[1]);
  if (!m[2]) return { caseNumber, repeatIndex: 0, legacy: false };
  return {
    caseNumber,
    repeatIndex: Number(m[2]),
    legacy: m[2].length === 1,
  };
}

/**
 * Следующий индекс для нового исходящего по делу. Отменённые резервирования
 * фиксируются, но номер не переиспользуется: учитываются все когда-либо выданные.
 */
export function nextRepeatIndex(issuedIndexes: number[]): number {
  if (issuedIndexes.length === 0) return 0;
  return Math.max(...issuedIndexes) + 1;
}

/** Номер письма РКА: «04-01/1351» и «04-01-1351» — одно и то же значение. */
export function normalizeRkaNumber(s: string): string | null {
  const m = s.match(/(\d{2})\s*-\s*(\d{2})\s*[\/-]\s*(\d{1,6})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}/${m[3]}`;
}
