/**
 * CASE-07. Машинные проекты полей D (коллегия) и F (краткое содержание) по тексту письма.
 * Это предложения с пометкой источника; ручные правки их не затирают.
 */

/** Родительный падеж названия коллегии → именительный («Алматинской городской коллегии адвокатов» → «Алматинская городская коллегия адвокатов»). */
export function collegiumNominative(v: string): string {
  let out = v.replace(/\s+/g, " ").trim();
  out = out.replace(/коллегии адвокатов/i, "коллегия адвокатов").replace(/^коллегия/i, "Коллегия");
  out = out.replace(/([А-ЯЁа-яё-]+)(ской|ской)(?=\s)/g, "$1ская").replace(/(област|город)(ной|ской)(?=\s)/g, (_m, r, e) => r + (e === "ной" ? "ная" : "ская"));
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** CASE-07: машинный проект поля D по тексту письма; город в подписи РКА не является коллегией. */
export function extractCollegiumCandidates(text: string): string[] {
  const out = new Set<string>();
  // Подпись письма РКА отрезается: её город — не коллегия заявителя.
  const signature = text.split(/\n\s*(?:--|С уважением|Құрметпен|Республиканская коллегия адвокатов\s*$)/im)[0];
  const W = "[А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+(?:-[А-ЯЁӘҒҚҢӨҰҮҺІа-яёәғқңөұүһі][а-яёәғқңөұүһі]+)?";
  // «Алматинской городской коллегии адвокатов», «Восточно-Казахстанской областной коллегии адвокатов»
  const re1 = new RegExp(`(${W}\\s+(?:областн|городск)[а-яё]+\\s+коллеги[а-яё]+\\s+адвокатов)`, "gu");
  for (const m of signature.matchAll(re1)) out.add(collegiumNominative(m[1]));
  // «коллегии адвокатов города Астаны», «коллегии адвокатов области Абай»
  const re2 = new RegExp(`(коллеги[а-яё]+\\s+адвокатов\\s+(?:города|г\\.|области)\\s+${W})`, "giu");
  for (const m of signature.matchAll(re2)) if (!/республиканск/i.test(m[1])) out.add(collegiumNominative(m[1]));
  // казахский: «Қарағанды облыстық адвокаттар алқасы»
  const re3 = new RegExp(`(${W}\\s+(?:облыстық|қалалық)\\s+адвокаттар\\s+алқасы)`, "gu");
  for (const m of signature.matchAll(re3)) out.add(m[1]);
  return [...out].slice(0, 5);
}

/** CASE-07: машинный проект поля F — содержательные предложения без приветствий и служебных фраз. */
export function machineSummary(text: string): string | null {
  const clean = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(>|--|С уважением|Құрметпен|Тел|Email|e-mail|From:|Sent:|Приложение|Қосымша|Республиканская коллегия адвокатов$|Республикалық адвокаттар алқасы$|г\.\s)/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ");
  if (clean.length < 40) return null;
  const sentences = (clean.match(/[^.!?]+[.!?]+/g) ?? [clean])
    .map((x) => x.trim())
    .filter((x) => !/^(Уважаем|Құрметті|Просим рассмотреть|Прошу рассмотреть|Просим (?:Вас )?рассмотреть|Қарауды сұраймыз|Добрый день)/i.test(x))
    .map((x) => x.replace(/^Направляем(?:\s+для рассмотрения)?\s+обращение/i, "Обращение").replace(/^(.+?)\s+(?:өтінішін|өтінішін қарауға)\s+жолдаймыз/i, "$1 өтініші"));
  let out = "";
  for (const s of sentences) {
    if ((out + " " + s).length > 420) break;
    out = out ? `${out} ${s}` : s;
  }
  return (out || clean.slice(0, 420)).trim() || null;
}

