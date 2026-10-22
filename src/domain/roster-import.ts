/**
 * Разбор состава комиссии, вставленного из таблицы (Excel, Google Sheets) или текста.
 * Столбцы: ФИО; e-mail; коллегия; роль. Разделитель — табуляция, «;» или «,».
 * Обращение по имени и отчеству берётся из ФИО «Фамилия Имя Отчество» и проверяется человеком (FLOW-01).
 */
import type { OrgRole } from "./types";

export interface RosterRow {
  line: number;
  fullName: string;
  firstName: string;
  patronymic: string | null;
  email: string;
  collegium: string | null;
  roles: OrgRole[];
  errors: string[];
}

const ROLE_WORDS: [RegExp, OrgRole][] = [
  [/председател|төраға/i, "chair"],
  [/секретар|хатшы/i, "secretary"],
  [/аудитор/i, "auditor"],
  [/администратор|админ/i, "tech_admin"],
  [/регистратор/i, "outgoing_registrar"],
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRoster(text: string): RosterRow[] {
  const rows: RosterRow[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const sep = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    // Заголовок таблицы пропускается.
    if (i === 0 && /фио|ф\.и\.о|email|e-mail|почта/i.test(line) && !cells.some((c) => EMAIL.test(c))) return;
    const emailIdx = cells.findIndex((c) => EMAIL.test(c));
    const email = emailIdx >= 0 ? cells[emailIdx].toLowerCase() : "";
    const rest = cells.filter((_, j) => j !== emailIdx);
    const fullName = (rest[0] ?? "").replace(/\s+/g, " ").trim();
    const collegium = rest[1]?.trim() || null;
    const roleText = rest.slice(2).join(" ");
    const roles = new Set<OrgRole>(["member"]);
    for (const [re, role] of ROLE_WORDS) if (re.test(roleText)) roles.add(role);
    const parts = fullName.split(" ");
    const errors: string[] = [];
    if (parts.length < 2) errors.push("ФИО указано не полностью");
    if (!email) errors.push("Нет адреса электронной почты");
    rows.push({ line: i + 1, fullName, firstName: parts[1] ?? "", patronymic: parts.slice(2).join(" ") || null, email, collegium, roles: [...roles], errors });
  });
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.email) continue;
    if (seen.has(r.email)) r.errors.push(`Адрес повторяется (строка ${seen.get(r.email)})`);
    else seen.set(r.email, r.line);
  }
  return rows;
}
