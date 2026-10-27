import "server-only";
import { OUTCOME_LABEL, type Tally } from "@/domain/quorum";
import type { Lang } from "@/domain/types";
import { MM, Typesetter, type Run, type TableCell } from "./conclusion-pdf";

/**
 * FLOW-07, FLOW-12, FLOW-13. Протокол электронного голосования комиссии.
 * Содержит: номер дела и цикла, заявителя, исполнителя, состав и число имеющих право голоса,
 * участвовавших, За/Против/Воздержался/Не участвовал, правило кворума и результат,
 * правило определения решения и результат, даты открытия и закрытия, версию и SHA-256
 * проголосованного проекта, поимённые записи голосов и особые мнения.
 * Протокол хранится в деле и доступен только по полномочиям (DOC-06); в QR-карточку
 * попадают лишь агрегированные числа.
 */

export interface ProtocolInput {
  lang: Lang;
  commissionName: string;
  caseNumber: string;
  cycleNumber: number;
  applicant: string;
  executorFullName: string;
  chairFullName: string;
  draftVersionLabel: string;
  draftSha256: string;
  openedAt: Date | string;
  closedAt: Date | string;
  eligible: { fullName: string }[];
  votes: { fullName: string; choice: "for" | "against" | "abstain"; comment?: string | null; specialOpinion?: string | null }[];
  notParticipated: { fullName: string }[];
  tally: Tally;
}

const L = {
  ru: {
    title: "ПРОТОКОЛ",
    subtitle: "электронного голосования комиссии",
    case: "Дело №",
    cycle: "Цикл рассмотрения",
    applicant: "Заявитель",
    executor: "Исполнитель",
    chair: "Председатель",
    opened: "Голосование открыто",
    closed: "Голосование закрыто",
    draft: "Проект заключения",
    draftHash: "SHA-256 проекта",
    results: "Итоги голосования",
    composition: "Состав (имеющие право голоса)",
    recused: "Отводы / исключения",
    eligible: "Имели право голоса с учётом отводов",
    participated: "Участвовали",
    for: "За",
    against: "Против",
    abstain: "Воздержался",
    notParticipated: "Не участвовали",
    quorumRule: "Правило кворума",
    quorumResult: "Кворум",
    reached: "достигнут",
    notReached: "не достигнут",
    decisionRule: "Правило определения решения",
    decision: "Решение",
    arithmetic: "Арифметическая проверка",
    arithmeticOk: "За + Против + Воздержался = Участвовали; Участвовали + Не участвовали + Отводы = Состав — сходится",
    arithmeticBad: "НЕ СХОДИТСЯ — решение не может считаться принятым",
    compositionList: "Состав комиссии в голосовании",
    records: "Поимённые записи голосов",
    no: "№",
    name: "ФИО",
    choice: "Голос",
    comment: "Комментарий",
    notParticipatedList: "Не участвовали в голосовании",
    special: "Особые мнения",
    none: "нет",
    errors: "Замечания подсчёта",
    footer: "Протокол сформирован платформой автоматически по зафиксированным голосам. Индивидуальные голоса не публикуются в QR-карточке.",
    choiceLabel: { for: "За", against: "Против", abstain: "Воздержался" },
  },
  kk: {
    title: "ХАТТАМА",
    subtitle: "комиссияның электрондық дауыс беруі",
    case: "Іс №",
    cycle: "Қарау циклі",
    applicant: "Өтініш беруші",
    executor: "Орындаушы",
    chair: "Төраға",
    opened: "Дауыс беру ашылды",
    closed: "Дауыс беру жабылды",
    draft: "Қорытынды жобасы",
    draftHash: "Жобаның SHA-256",
    results: "Дауыс беру қорытындысы",
    composition: "Құрамы (дауыс беру құқығы барлар)",
    recused: "Қарсылық білдірулер / шығарулар",
    eligible: "Қарсылықтарды ескергенде дауыс беру құқығы барлар",
    participated: "Қатысқандар",
    for: "Жақтап",
    against: "Қарсы",
    abstain: "Қалыс қалды",
    notParticipated: "Қатыспағандар",
    quorumRule: "Кворум ережесі",
    quorumResult: "Кворум",
    reached: "жиналды",
    notReached: "жиналмады",
    decisionRule: "Шешімді анықтау ережесі",
    decision: "Шешім",
    arithmetic: "Арифметикалық тексеру",
    arithmeticOk: "Жақтап + Қарсы + Қалыс = Қатысқандар; Қатысқандар + Қатыспағандар + Қарсылықтар = Құрамы — сәйкес",
    arithmeticBad: "СӘЙКЕС ЕМЕС — шешім қабылданды деп есептелмейді",
    compositionList: "Дауыс берудегі комиссия құрамы",
    records: "Дауыстардың атаулы жазбалары",
    no: "№",
    name: "Т.А.Ә.",
    choice: "Дауыс",
    comment: "Түсініктеме",
    notParticipatedList: "Дауыс беруге қатыспағандар",
    special: "Ерекше пікірлер",
    none: "жоқ",
    errors: "Санау ескертпелері",
    footer: "Хаттаманы платформа тіркелген дауыстар бойынша автоматты түрде жасады. Жеке дауыстар QR-карточкада жарияланбайды.",
    choiceLabel: { for: "Жақтап", against: "Қарсы", abstain: "Қалыс қалды" },
  },
} as const;

/** Подписи исхода на казахском; правила кворума/решения приходят из домена на русском и выводятся как есть. */
const OUTCOME_KK: Record<keyof typeof OUTCOME_LABEL, string> = {
  accepted: "Шешім қабылданды",
  rejected: "Шешім қабылданбады",
  no_quorum: "Кворум жиналмады",
  undetermined: "Шешім анықталмады",
};

function fmtDateTime(d: Date | string) {
  const x = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return String(d);
  const p = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(x);
  return `${p.replace(",", "")} (Алматы)`;
}

const cell = (text: string, o: { bold?: boolean; align?: "left" | "center" | "right"; sans?: boolean; shade?: boolean; span?: number; size?: number } = {}): TableCell => ({
  paras: [{ runs: [{ text, bold: o.bold, sans: o.sans, size: o.size }], opts: { align: o.align ?? "left", size: o.size } }],
  shade: o.shade,
  span: o.span,
});

export async function buildProtocolPdf(input: ProtocolInput): Promise<Uint8Array> {
  const lang: Lang = input.lang === "kk" ? "kk" : "ru";
  const s = L[lang];
  const t = input.tally;
  const closed = typeof input.closedAt === "string" ? new Date(input.closedAt) : input.closedAt;
  const ts = await Typesetter.create({
    lang,
    title: `${s.title} — ${s.case}${input.caseNumber}, ${s.cycle.toLowerCase()} ${input.cycleNumber}`,
    margins: { top: 20 * MM, right: 15 * MM, bottom: 20 * MM, left: 25 * MM },
    baseSize: 11.5,
    lineHeight: 1.2,
    fixedDate: Number.isNaN(closed.getTime()) ? null : closed,
  });

  // ── Шапка ──
  ts.paragraph([{ text: input.commissionName }], { align: "center", size: 11, spaceAfter: 10 });
  ts.paragraph([{ text: s.title, bold: true, size: 15 }], { align: "center" });
  ts.paragraph([{ text: s.subtitle }], { align: "center", spaceAfter: 2 });
  ts.paragraph([{ text: `${s.case}${input.caseNumber} · ${s.cycle.toLowerCase()} ${input.cycleNumber}`, bold: true }], { align: "center", spaceAfter: 12 });

  // ── Реквизиты ──
  const kv = (k: string, v: string, sans = false): TableCell[] => [cell(k, { shade: true }), cell(v, { sans, size: sans ? 9.5 : undefined })];
  ts.table(
    [
      kv(s.applicant, input.applicant),
      kv(s.executor, input.executorFullName),
      kv(s.chair, input.chairFullName),
      kv(s.opened, fmtDateTime(input.openedAt)),
      kv(s.closed, fmtDateTime(input.closedAt)),
      kv(s.draft, input.draftVersionLabel),
      kv(s.draftHash, input.draftSha256 || "—", true),
    ],
    { colWidths: [34, 66], size: 11 },
  );

  // ── Итоги ──
  ts.paragraph([{ text: s.results, bold: true }], { spaceBefore: 12, spaceAfter: 4, keepWithNext: true });
  const num = (k: string, v: number, bold = false): TableCell[] => [cell(k, { bold }), cell(String(v), { align: "right", bold })];
  ts.table(
    [
      num(s.composition, t.composition),
      ...(t.recused ? [num(s.recused, t.recused), num(s.eligible, t.eligible)] : []),
      num(s.participated, t.participated, true),
      num(s.for, t.for),
      num(s.against, t.against),
      num(s.abstain, t.abstain),
      num(s.notParticipated, t.notParticipated),
    ],
    { colWidths: [80, 20], size: 11 },
  );

  const outcomeText = lang === "kk" ? OUTCOME_KK[t.outcome] : OUTCOME_LABEL[t.outcome];
  ts.table(
    [
      [cell(s.quorumRule, { shade: true }), cell(t.quorumRuleText)],
      [cell(s.quorumResult, { shade: true }), cell(`${t.quorumReached ? s.reached : s.notReached} (${s.participated.toLowerCase()} ${t.participated}${t.quorumRequired ? ` / ≥ ${t.quorumRequired}` : ""})`)],
      [cell(s.decisionRule, { shade: true }), cell(t.decisionRuleText)],
      [cell(s.decision, { shade: true, bold: true }), cell(outcomeText, { bold: true })],
      [cell(s.arithmetic, { shade: true }), cell(t.arithmeticOk ? s.arithmeticOk : s.arithmeticBad, { bold: !t.arithmeticOk })],
    ],
    { colWidths: [34, 66], size: 11 },
  );
  if (t.errors.length) {
    ts.paragraph([{ text: `${s.errors}:`, bold: true }], { spaceBefore: 6, size: 10.5 });
    for (const e of t.errors) ts.paragraph([{ text: `– ${e}` }], { size: 10.5, indentLeft: 6 * MM });
  }

  // ── Состав (FLOW-13: версия списка, использованная в голосовании) ──
  ts.paragraph([{ text: `${s.compositionList} (${input.eligible.length})`, bold: true }], { spaceBefore: 12, spaceAfter: 4, keepWithNext: true });
  ts.paragraph([{ text: input.eligible.map((e, i) => `${i + 1}. ${e.fullName}`).join("\n") }], { size: 10.5 });

  // ── Поимённые записи ──
  ts.paragraph([{ text: s.records, bold: true }], { spaceBefore: 12, spaceAfter: 4, keepWithNext: true });
  if (input.votes.length) {
    const rows: TableCell[][] = [[cell(s.no, { bold: true, shade: true, align: "center", size: 10.5 }), cell(s.name, { bold: true, shade: true, size: 10.5 }), cell(s.choice, { bold: true, shade: true, size: 10.5 }), cell(s.comment, { bold: true, shade: true, size: 10.5 })]];
    input.votes.forEach((v, i) =>
      rows.push([cell(String(i + 1), { align: "center", size: 10.5 }), cell(v.fullName, { size: 10.5 }), cell(s.choiceLabel[v.choice] ?? v.choice, { size: 10.5 }), cell(v.comment?.trim() || "—", { size: 10.5 })]),
    );
    ts.table(rows, { colWidths: [7, 38, 17, 38], headerRows: 1, size: 10.5 });
  } else ts.paragraph([{ text: s.none }], { size: 10.5 });

  ts.paragraph([{ text: `${s.notParticipatedList} (${input.notParticipated.length})`, bold: true }], { spaceBefore: 10, spaceAfter: 4, keepWithNext: true });
  ts.paragraph([{ text: input.notParticipated.length ? input.notParticipated.map((p) => p.fullName).join("; ") : s.none }], { size: 10.5 });

  // ── Особые мнения ──
  const opinions = input.votes.filter((v) => v.specialOpinion?.trim());
  ts.paragraph([{ text: s.special, bold: true }], { spaceBefore: 10, spaceAfter: 4, keepWithNext: true });
  if (opinions.length) {
    for (const o of opinions) {
      const runs: Run[] = [{ text: `${o.fullName}: `, bold: true }, { text: o.specialOpinion!.trim() }];
      ts.paragraph(runs, { size: 10.5, align: "justify", spaceAfter: 4 });
    }
  } else ts.paragraph([{ text: s.none }], { size: 10.5 });

  ts.hrule();
  ts.paragraph([{ text: s.footer, italic: true }], { size: 9.5 });

  ts.numberPages(9);
  return ts.save();
}
