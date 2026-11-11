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

  // Номер обращения без ведущих нулей, как его называют исполнители: «обращение № 9».
  const n = /^\d+$/.test(d.caseNumber) ? String(Number(d.caseNumber)) : d.caseNumber;
  const summary = d.summary && d.summary.trim() && d.summary.trim() !== "—" ? d.summary.trim() : null;
  const subject = lang === "kk" ? `РАА Комиссиясының тапсырмасы — № ${n} өтініш` : `Поручение Комиссии РКА — обращение № ${n}`;

  const paragraphs =
    lang === "kk"
      ? [
          `Құрметті ${name}!`,
          `Сізге адвокаттардың кәсіби құқықтарын қорғау жөніндегі РАА комиссиясына түскен өтінішті қарау тапсырылады.`,
          [`Тіркеу нөмірі: ${n}`, `РАА хатының нөмірі: ${d.rkaNumber}, ${d.rkaDate}`, `Өтініш беруші: ${d.applicant.replace(/\.+$/, "")}`, `Қарау мерзімі: ${d.deadline}`, `Электрондық іс: ${d.workspaceLink}`].join("\n"),
          ...(summary ? [`Мән-жайы: ${summary}`] : []),
          `Дайындалған қорытынды жобасын Word форматында ${d.replyTo} электрондық поштасына жіберуіңізді сұраймыз.\nХаттың тақырыбында міндетті түрде көрсетіңіз: «Қорытынды жобасы — № ${n} өтініш».\nЭлектрондық істің бастапқы құжаттарын өзгертпеуіңізді және жоймауыңызды сұраймыз.`,
          `Материалдарды зерделеп, қорытынды жобасын не Ережеде көзделген өзге қарау нәтижесін дайындауыңызды сұраймыз. Тапсырманы алғаныңызды растауыңызды сұраймыз.`,
          `Құрметпен,\n${d.commissionName} төрағасы\n${d.chairFullName}`,
        ]
      : [
          `${salutationRu(d.addressee.patronymic)} ${name}!`,
          `Вам поручено рассмотрение обращения, поступившего в Комиссию по защите профессиональных прав адвокатов РКА.`,
          [`Регистрационный №: ${n}`, `№ письма РКА: ${d.rkaNumber} от ${d.rkaDate}`, `Заявитель: ${d.applicant.replace(/\.+$/, "")}`, `Срок рассмотрения: ${d.deadline}`, `Электронное дело: ${d.workspaceLink}`].join("\n"),
          ...(summary ? [`Обстоятельства: ${summary}`] : []),
          `Подготовленный проект заключения просим направить в формате Word на электронную почту ${d.replyTo}.\nВ теме письма обязательно укажите: «Проект заключения — обращение № ${n}».\nПросим не изменять и не удалять исходные документы электронного дела.`,
          `Просим изучить материалы и подготовить проект заключения либо иной предусмотренный Положением результат рассмотрения. Просим подтвердить получение поручения.`,
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
