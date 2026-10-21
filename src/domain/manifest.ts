/**
 * MAIL-05..09, INC-01. Полнота поступления определяется по манифесту исходных
 * MIME-вложений, а не по числу файлов в папке. Два одинаковых вложения — две позиции
 * источника, даже если физически хранится один blob.
 */

export type AttachmentStatus =
  | "pending" // ещё не загружено
  | "downloading"
  | "stored" // байты сохранены, проверка не завершена
  | "verified" // сохранено и проверено: размер, SHA-256, антивирус, перечитано из хранилища
  | "rejected" // запрещённый тип, архивная бомба и т.п.
  | "encrypted"
  | "unavailable" // недоступная внешняя ссылка, лимит провайдера
  | "quarantine"
  | "excluded"; // исключено из обязательного состава с основанием и разрешением

export interface ManifestItem {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string | null;
  inline: boolean;
  parentPartId?: string | null; // элемент архива
  status: AttachmentStatus;
  reason?: string | null;
  exclusion?: { by: string; basis: string; at: string } | null;
}

export interface ManifestSummary {
  declared: number; // MIME-вложения, обязательные (без inline-подписей и элементов архивов)
  verified: number;
  uniqueBlobs: number;
  pending: number;
  problems: number; // rejected/encrypted/unavailable/quarantine
  excluded: number;
  inline: number;
  complete: boolean;
  missing: ManifestItem[];
  label: string;
}

export function summarizeManifest(items: ManifestItem[]): ManifestSummary {
  const required = items.filter((i) => !i.inline && !i.parentPartId);
  const verified = required.filter((i) => i.status === "verified");
  const excluded = required.filter((i) => i.status === "excluded" && i.exclusion);
  const pending = required.filter((i) => ["pending", "downloading", "stored"].includes(i.status));
  const problems = required.filter((i) =>
    ["rejected", "encrypted", "unavailable", "quarantine"].includes(i.status),
  );
  const missing = required.filter(
    (i) => i.status !== "verified" && !(i.status === "excluded" && i.exclusion),
  );
  const uniqueBlobs = new Set(verified.map((i) => i.sha256).filter(Boolean)).size;
  const complete = missing.length === 0;

  let label: string;
  if (complete) {
    label = `Все ${required.length} вложений сохранены и проверены`;
    if (excluded.length) label += `, ${excluded.length} исключено с основанием`;
  } else {
    label = `Загружено и проверено ${verified.length} из ${required.length}; не хватает ${missing.length}`;
  }

  return {
    declared: required.length,
    verified: verified.length,
    uniqueBlobs,
    pending: pending.length,
    problems: problems.length,
    excluded: excluded.length,
    inline: items.filter((i) => i.inline).length,
    complete,
    missing,
    label,
  };
}

/** MAIL-09. Исключить элемент можно только с основанием и отдельным разрешением. */
export function excludeItem(
  item: ManifestItem,
  by: string,
  basis: string,
): ManifestItem {
  if (!basis || basis.trim().length < 10) {
    throw new Error("Для исключения вложения нужно основание (не короче 10 символов)");
  }
  return { ...item, status: "excluded", exclusion: { by, basis: basis.trim(), at: new Date().toISOString() } };
}

/** STORE-08. Различение причин расхождения с исходным составом. */
export type IntegrityFinding =
  | "ok"
  | "never_uploaded"
  | "uploaded_then_deleted"
  | "moved"
  | "modified"
  | "no_access"
  | "insufficient_data";

export const INTEGRITY_LABEL: Record<IntegrityFinding, string> = {
  ok: "Совпадает",
  never_uploaded: "Не загружалось",
  uploaded_then_deleted: "Загружено и удалено",
  moved: "Перемещено",
  modified: "Изменено",
  no_access: "Недоступно из-за прав",
  insufficient_data: "Недостаточно данных",
};

export function classifyIntegrity(params: {
  expectedSha256: string;
  uploadEvent: boolean | null; // null — журнал недоступен
  deleteEvent: boolean | null;
  present: boolean | null;
  actualSha256?: string | null;
  inExpectedLocation?: boolean | null;
  accessDenied?: boolean;
}): IntegrityFinding {
  if (params.accessDenied) return "no_access";
  if (params.present === true) {
    if (params.actualSha256 && params.actualSha256 !== params.expectedSha256) return "modified";
    if (params.inExpectedLocation === false) return "moved";
    return "ok";
  }
  if (params.present === null || params.uploadEvent === null) return "insufficient_data";
  if (params.uploadEvent === false) return "never_uploaded";
  if (params.deleteEvent === true) return "uploaded_then_deleted";
  return "insufficient_data";
}
