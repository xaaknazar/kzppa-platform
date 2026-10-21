/**
 * CASE-02, CASE-03, CASE-04, INC-02. Разбор темы/текста письма и подбор дела.
 *
 * Нечёткий поиск никогда не объединяет людей автоматически. Противоречие номера
 * и фамилии, несколько кандидатов или отсутствие дела → «требует разбора».
 */

import { normalizeRkaNumber } from "./numbering";

export type IntakeKind =
  | "initial" // обращение / өтініш
  | "supplement" // дополнительные материалы
  | "rework" // на доработку
  | "executor_reply" // ответ исполнителя (проект/финал)
  | "unknown";

/** Варианты набора казахских букв без казахской раскладки. */
const KK_FOLD: Record<string, string> = {
  ә: "а", ғ: "г", қ: "к", ң: "н", ө: "о", ұ: "у", ү: "у", һ: "х", і: "и", ё: "е",
  // латинские двойники, встречающиеся в темах писем
  i: "и", a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", k: "к", h: "н", m: "м", t: "т", b: "в", y: "у",
};

export function foldLetters(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((ch) => KK_FOLD[ch] ?? ch)
    .join("");
}

/**
 * Стем фамилии для поиска кандидатов: «Жубатовой», «Жубатову», «Жубатова»,
 * «Жубатов» → «жубатов». Это ключ кандидатов, а не идентификатор человека.
 */
export function surnameStem(raw: string): string {
  let s = foldLetters(raw.trim()).replace(/[^а-яa-z-]/g, "");
  // казахские патронимы
  s = s.replace(/(улы|кызы)$/, "");
  // мужские/женские фамилии на -ов/-ев/-ин и их падежные формы
  const m = s.match(/^(.+?(?:ов|ев|ин|ын))(а|ой|ою|у|ую|ым|ом|е|ы|ой|ого|ому|ых|ыми)?$/);
  if (m) return m[1];
  // фамилии на -ский/-цкий
  const sk = s.match(/^(.+?(?:ск|цк))(ий|ая|ого|ому|им|ом|ой|ую)$/);
  if (sk) return sk[1];
  // общий случай: отрезаем короткие падежные окончания у длинных слов
  if (s.length > 5) return s.replace(/(ой|ей|ою|ую|ым|ом|ем|у|ю|е|а|я|ы|и)$/, "");
  return s;
}

export interface ParsedSubject {
  rkaNumber: string | null;
  year: number | null;
  applicantCandidates: string[]; // исходные написания
  kind: IntakeKind;
  signals: string[];
}

const KIND_PATTERNS: [IntakeKind, RegExp][] = [
  ["supplement", /(дополнительн\S*\s+материал|дополнени|қосымша\s+материал|қосымша)/i],
  ["rework", /(на\s+доработку|доработк|пысықтау)/i],
  ["executor_reply", /(проект\s+заключени|окончательн\S*\s+заключени|қорытынды\s+жоба|қорытынды)/i],
  ["initial", /(обращени|өтініш|отиниш|жалоб|шағым)/i],
];

/** Слова, которые не являются фамилиями даже с заглавной буквы. */
const STOP = new Set(
  [
    "обращение", "обращения", "өтініш", "дополнительные", "материалы", "на", "доработку",
    "проект", "заключения", "заключение", "окончательное", "рка", "кзппа", "адвокат",
    "адвоката", "коллегии", "коллегия", "письмо", "исх", "вх", "от", "по", "re", "fw", "fwd",
    "республиканская", "коллегия", "адвокатов", "комиссия", "комиссии", "защите",
  ].map(foldLetters),
);

export function parseSubject(subject: string, body = ""): ParsedSubject {
  const signals: string[] = [];
  const text = `${subject}\n${body}`;
  const rkaNumber = normalizeRkaNumber(text);
  if (rkaNumber) signals.push(`Номер РКА ${rkaNumber}`);

  const yearM = text.match(/\b(20\d{2})\b/);
  const year = yearM ? Number(yearM[1]) : null;

  let kind: IntakeKind = "unknown";
  if (/^\s*(re|ответ|жауап)\s*:/i.test(subject)) {
    kind = "executor_reply";
    signals.push("Ответ в цепочке");
  }
  for (const [k, re] of KIND_PATTERNS) {
    if (re.test(subject) || (kind === "unknown" && re.test(body.slice(0, 600)))) {
      if (kind === "unknown" || (kind === "executor_reply" && k !== "initial")) kind = k;
      signals.push(`Признак: ${k}`);
      break;
    }
  }

  // ФИО: последовательности слов с заглавной буквы (рус/каз), исключая служебные.
  const wordRe =
    /([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+(?:-[А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)?)((?:\s*[А-ЯЁӘҒҚҢӨҰҮҺІ]\.){0,2})/g;
  const candidates: string[] = [];
  for (const m of subject.matchAll(wordRe)) {
    const word = m[1];
    // казахские притяжательные формы: «Ахметовтың» → «Ахметов»
    const bare = word.replace(/(тың|тің|дың|дің|ның|нің|қа|ке|ға|ге|ке|ты|ті|ды|ді)$/u, "");
    if (STOP.has(foldLetters(word)) || STOP.has(foldLetters(bare))) continue;
    if (bare.length < 3) continue;
    candidates.push(`${bare}${m[2] ?? ""}`.trim());
  }

  return { rkaNumber, year, applicantCandidates: candidates, kind, signals };
}

export interface CaseIndexEntry {
  caseId: string;
  caseNumber: number;
  rkaNumber: string | null;
  applicantFullName: string;
  applicantAliases: string[];
  executorEmail?: string | null;
  threadIds?: string[];
}

export interface MatchCandidate {
  caseId: string;
  caseNumber: number;
  score: number; // 0..1
  reasons: string[];
}

export type MatchDecision =
  | { kind: "attach"; caseId: string; confidence: number; reasons: string[] }
  | { kind: "new_case"; reasons: string[] }
  | { kind: "needs_review"; reasons: string[]; candidates: MatchCandidate[] };

export interface MatchInput {
  parsed: ParsedSubject;
  fromEmail: string;
  threadId?: string | null;
  officialRkaSender: string; // office@advokatura.kz
  cases: CaseIndexEntry[];
}

/**
 * Подбор дела. Автоматическое приобщение допускается только при однозначном
 * сильном признаке (поток писем или номер РКА) без противоречий по фамилии.
 * Создание нового дела всегда требует подтверждения (CASE-01) — здесь лишь предложение.
 */
export function matchCase(input: MatchInput): MatchDecision {
  const { parsed, cases } = input;
  const reasons: string[] = [];
  const stems = parsed.applicantCandidates.map((c) => surnameStem(c.split(/\s+/)[0]));

  const scored: MatchCandidate[] = [];
  for (const c of cases) {
    const r: string[] = [];
    let score = 0;
    let threadHit = false;
    if (input.threadId && c.threadIds?.includes(input.threadId)) {
      score += 0.6;
      threadHit = true;
      r.push("Письмо в цепочке этого дела");
    }
    const numberHit = !!(parsed.rkaNumber && c.rkaNumber && parsed.rkaNumber === c.rkaNumber);
    if (numberHit) {
      score += 0.6;
      r.push(`Совпал номер РКА ${parsed.rkaNumber}`);
    }
    const caseStems = [c.applicantFullName, ...c.applicantAliases].map((n) =>
      surnameStem(n.split(/\s+/)[0]),
    );
    const nameHit = stems.some((s) => s.length >= 3 && caseStems.includes(s));
    if (nameHit) {
      score += 0.35;
      r.push(`Совпала фамилия заявителя (${c.applicantFullName})`);
    }
    if (c.executorEmail && c.executorEmail.toLowerCase() === input.fromEmail.toLowerCase()) {
      score += 0.15;
      r.push("Письмо от назначенного исполнителя");
    }
    if (score > 0) {
      // Противоречие: номер указывает на это дело, а фамилия в теме — на другое.
      if ((numberHit || threadHit) && stems.length && !nameHit) {
        const otherNameCase = cases.find(
          (o) =>
            o.caseId !== c.caseId &&
            [o.applicantFullName, ...o.applicantAliases].some((n) =>
              stems.includes(surnameStem(n.split(/\s+/)[0])),
            ),
        );
        if (otherNameCase) r.push(`Фамилия в теме указывает на дело ${otherNameCase.caseNumber}`);
      }
      scored.push({ caseId: c.caseId, caseNumber: c.caseNumber, score: Math.min(1, score), reasons: r });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const conflicts = scored.filter((s) => s.reasons.some((x) => x.startsWith("Фамилия в теме указывает")));
  if (conflicts.length) {
    return { kind: "needs_review", reasons: ["Номер и фамилия указывают на разные дела"], candidates: scored };
  }

  const top = scored[0];
  const second = scored[1];
  const strong = top && top.reasons.some((r) => r.startsWith("Совпал номер") || r.startsWith("Письмо в цепочке"));

  if (top && strong && (!second || top.score - second.score >= 0.3)) {
    return { kind: "attach", caseId: top.caseId, confidence: top.score, reasons: top.reasons };
  }
  if (scored.length > 0) {
    reasons.push(
      scored.length > 1 ? "Несколько кандидатов" : "Совпадение только по нестрогим признакам",
    );
    return { kind: "needs_review", reasons, candidates: scored };
  }
  if (parsed.kind === "initial" && input.fromEmail.toLowerCase() === input.officialRkaSender.toLowerCase()) {
    return { kind: "new_case", reasons: ["Новое обращение от РКА, существующее дело не найдено"] };
  }
  return { kind: "needs_review", reasons: ["Дело не найдено, вид поступления неясен"], candidates: [] };
}
