/**
 * FLOW-01, FLOW-09, DOC-01, DOC-07. Шаблоны по умолчанию на русском и казахском.
 * Подлежат утверждению заказчиком (DEC-05); в системе хранятся с версией.
 * Обращение по имени и отчеству берётся только из подтверждённого профиля, не из инициалов.
 */

import type { Lang } from "./types";

/** Обращение по отчеству: «-овна/-евна/-ична/-кызы» — «Уважаемая», «-ович/-евич/-ич/-улы» — «Уважаемый». */
/** «Комиссия по защите …» → «Комиссии по защите …» для подписи «Председатель …». */
export function genitiveRu(name: string) {
  return name.replace(/^([Кк])омиссия(?=\s|$)/, "$1омиссии");
}

export function salutationRu(patronymic: string | null | undefined) {
  const p = (patronymic ?? "").trim().toLowerCase();
  if (/(вна|чна|кызы|қызы)$/.test(p)) return "Уважаемая";
  if (/(вич|ич|улы|ұлы)$/.test(p)) return "Уважаемый";
  return "Уважаемый(ая)";
}

export interface AssignmentTemplateData {
  addressee: { firstName: string; patronymic: string | null }; // из подтверждённого профиля
  caseNumber: string; // «001»
  applicant: string;
  rkaNumber: string;
  rkaDate: string; // ДД.ММ.ГГГГ
  receivedAt: string; // ДД.ММ.ГГГГ
  summary: string; // краткие обстоятельства (F)
  subject: string; // предмет поручения
  deadline: string; // ДД.ММ.ГГГГ
  workspaceLink: string;
  replyTo: string;
  chairFullName: string;
  commissionName: string;
}

export function assignmentLetter(lang: Lang, d: AssignmentTemplateData): { subject: string; text: string; html: string } {
  const name = [d.addressee.firstName, d.addressee.patronymic].filter(Boolean).join(" ");
  if (!d.addressee.firstName) throw new Error("В профиле исполнителя не подтверждено имя для обращения");

  const subject =
    lang === "kk"
      ? `КЗППА: №${d.caseNumber} іс бойынша тапсырма — ${d.applicant}`
      : `КЗППА: поручение по делу №${d.caseNumber} — ${d.applicant}`;

  const paragraphs =
    lang === "kk"
      ? [
          `Құрметті ${name}!`,
          `Республикалық адвокаттар алқасынан ${d.rkaDate} жылғы №${d.rkaNumber} хатпен адвокат ${d.applicant} өтініші келіп түсті (Комиссияға ${d.receivedAt} түскен). Комиссиядағы іс нөмірі — №${d.caseNumber}.`,
          `Мән-жайы: ${d.summary}`,
          `Сізге тапсырылады: ${d.subject}. Материалдарды зерделеп, қорытынды жобасын дайындауыңызды сұраймын.`,
          `Мерзімі — ${d.deadline}.`,
          `Электрондық іс материалдары: ${d.workspaceLink}`,
          `Қорытынды жобасын осы хатқа жауап ретінде ${d.replyTo} мекенжайына жіберіңіз. Тапсырманы алғаныңызды растауыңызды сұраймын.`,
          `Құрметпен,\n${d.commissionName} төрағасы\n${d.chairFullName}`,
        ]
      : [
          `${salutationRu(d.addressee.patronymic)} ${name}!`,
          `Республиканская коллегия адвокатов письмом №${d.rkaNumber} от ${d.rkaDate} направила в Комиссию обращение адвоката (поступило ${d.receivedAt}). Заявитель — ${d.applicant.replace(/\.+$/, "")}. Номер дела в Комиссии — №${d.caseNumber}.`,
          `Обстоятельства: ${d.summary}`,
          `Вам поручается: ${d.subject}. Прошу изучить материалы и подготовить проект заключения.`,
          `Срок — до ${d.deadline}.`,
          `Материалы электронного дела: ${d.workspaceLink}`,
          `Проект заключения направьте ответным письмом на ${d.replyTo}. Прошу подтвердить получение поручения.`,
          `С уважением,\nПредседатель ${genitiveRu(d.commissionName)}\n${d.chairFullName}`,
        ];

  const text = paragraphs.join("\n\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = paragraphs
    .map((p) => {
      const linked = esc(p).replace(
        esc(d.workspaceLink),
        `<a href="${esc(d.workspaceLink)}">${lang === "kk" ? "Электрондық іске өту" : "Открыть электронное дело"}</a>`,
      );
      return `<p style="margin:0 0 12px;font:15px/1.55 Arial,sans-serif;color:#17202b">${linked.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
  return { subject, text, html };
}

export interface CoverLetterData {
  outgoingNumber: string; // 001, 001/01
  outgoingDate: string;
  rkaNumber: string;
  rkaDate: string;
  caseNumber: string;
  applicant: string;
  purpose: string; // краткое назначение отправки
  attachments: { name: string; pages?: number | null }[];
  chairFullName: string;
  commissionName: string;
  addressee: string; // «Председателю Республиканской коллегии адвокатов»
  supplementary: boolean;
}

export function coverLetter(lang: Lang, d: CoverLetterData) {
  const isKk = lang === "kk";
  const title = isKk
    ? `Шығыс №${d.outgoingNumber}, ${d.outgoingDate}`
    : `Исх. №${d.outgoingNumber} от ${d.outgoingDate}`;
  const ref = isKk
    ? `${d.rkaDate} жылғы №${d.rkaNumber} хатқа`
    : `На №${d.rkaNumber} от ${d.rkaDate}`;
  const body = isKk
    ? `${d.commissionName} №${d.caseNumber} іс бойынша адвокат ${d.applicant} өтініші бойынша ${
        d.supplementary ? "қосымша " : ""
      }қорытындыны жолдайды. ${d.purpose}`
    : `${d.commissionName} направляет ${d.supplementary ? "дополнительное " : ""}заключение по делу №${d.caseNumber} (заявитель — ${d.applicant}). ${d.purpose}`;
  const attachHeader = isKk ? "Қосымша:" : "Приложение:";
  const attachLines = d.attachments.map(
    (a, i) => `${i + 1}. ${a.name}${a.pages ? (isKk ? `, ${a.pages} п.` : `, на ${a.pages} л.`) : ""}`,
  );
  const sign = isKk ? `${d.commissionName} төрағасы` : `Председатель ${genitiveRu(d.commissionName)}`;
  const subject = isKk
    ? `КЗППА: №${d.caseNumber} іс бойынша қорытынды — ${d.applicant} (шығ. №${d.outgoingNumber})`
    : `КЗППА: заключение по делу №${d.caseNumber} — ${d.applicant} (исх. №${d.outgoingNumber})`;
  const emailBody = isKk
    ? `Құрметті әріптестер!\n\n${ref} жауап ретінде №${d.caseNumber} іс бойынша қорытынды жолданады.\n\nТіркелген файлдар: ілеспе хат және оның қосымшалары, барлығы — ${d.attachments.length + 1}.\n\nҚұрметпен,\n${sign}\n${d.chairFullName}`
    : `Уважаемые коллеги!\n\n${ref} направляем заключение по делу №${d.caseNumber} (заявитель — ${d.applicant}).\n\nВо вложении: сопроводительное письмо и приложения к нему, всего файлов — ${d.attachments.length + 1}.\n\nС уважением,\n${sign}\n${d.chairFullName}`;
  return { title, ref, addressee: d.addressee, body, attachHeader, attachLines, sign, chair: d.chairFullName, subject, emailBody };
}
