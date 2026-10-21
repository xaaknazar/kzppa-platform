import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { assignmentLetter, coverLetter } from "@/domain/templates";
import { formatOutgoingFull } from "@/domain/numbering";
import { Notice, Section } from "@/components/ui";
import type { Lang } from "@/domain/types";

export const metadata = { title: "Шаблоны" };

/** DOC-01, DOC-07, FLOW-09, DEC-05: предпросмотр шаблонов по умолчанию на примере. */
export default async function TemplatesPage() {
  const u = await requireUser();
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) });
  const nameRu = org?.name ?? "Комиссия по защите профессиональных прав адвокатов";
  const nameKk = org?.nameKk ?? nameRu;
  const sender = org?.officialSender ?? "kzppa.rka@gmail.com";
  const year = org?.outgoingYearInNumber ? new Date().getFullYear() : null;
  const outNum = formatOutgoingFull({ caseNumber: 1, repeatIndex: 0 }, { prefix: org?.outgoingPrefix, year });

  const sample = (lang: Lang) => ({
    assignment: assignmentLetter(lang, {
      addressee: lang === "kk" ? { firstName: "Айгүл", patronymic: "Серікқызы" } : { firstName: "Айгуль", patronymic: "Сериковна" },
      caseNumber: "001",
      applicant: "Ахметов Б. С.",
      rkaNumber: "04-01/1351",
      rkaDate: "02.10.2026",
      receivedAt: "03.10.2026",
      summary: lang === "kk" ? "Тергеу әрекеті кезінде адвокаттың қорғалушымен оңаша кездесу құқығы шектелген." : "При производстве следственного действия адвокату ограничили право на конфиденциальное свидание с подзащитным.",
      subject: lang === "kk" ? "адвокаттың кәсіби құқықтарының бұзылуы туралы өтінішті қарау" : "рассмотрение обращения о нарушении профессиональных прав адвоката",
      deadline: "20.10.2026",
      workspaceLink: "https://kzppa.example.kz/w/…",
      replyTo: sender,
      chairFullName: "Председатель Комиссии (ФИО полностью)",
      commissionName: lang === "kk" ? nameKk : nameRu,
    }),
    cover: coverLetter(lang, {
      outgoingNumber: outNum,
      outgoingDate: "21.10.2026",
      rkaNumber: "04-01/1351",
      rkaDate: "02.10.2026",
      caseNumber: "001",
      applicant: "Ахметов Б. С.",
      purpose: lang === "kk" ? "Қорытынды төрағаның ЭЦҚ-мен қол қойылған." : "Заключение подписано ЭЦП председателя.",
      attachments: [
        { name: lang === "kk" ? "Қорытынды (PDF, ЭЦҚ)" : "Заключение (PDF, ЭЦП)", pages: 4 },
        { name: lang === "kk" ? "Қорытынды жобасы (DOCX)" : "Проект заключения (DOCX)", pages: null },
      ],
      chairFullName: "Председатель Комиссии (ФИО полностью)",
      commissionName: lang === "kk" ? nameKk : nameRu,
      addressee: lang === "kk" ? "Республикалық адвокаттар алқасының төрағасына" : (org?.rkaAddressee ?? "Председателю Республиканской коллегии адвокатов"),
      supplementary: false,
    }),
  });
  const ru = sample("ru");
  const kk = sample("kk");

  return (
    <div className="space-y-6">
      <Notice tone="warn" title="Шаблоны по умолчанию ещё не утверждены заказчиком">
        Тексты ниже — рабочие шаблоны платформы на русском и казахском. До запуска их утверждает комиссия (DEC-05); утверждённая редакция сохраняется с номером версии, и каждое письмо хранит, по какой версии оно составлено. Данные в примере вымышленные.
      </Notice>

      <Section title="Поручение исполнителю">
        <p className="mb-4 text-[13px] text-ink-3">Язык письма определяется языком обращения. Обращение по имени и отчеству берётся из подтверждённого профиля участника.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <Letter lang="ru" caption="Русский" subject={ru.assignment.subject} body={ru.assignment.text} />
          <Letter lang="kk" caption="Казахский" subject={kk.assignment.subject} body={kk.assignment.text} />
        </div>
      </Section>

      <Section title="Сопроводительное письмо в РКА">
        <p className="mb-4 text-[13px] text-ink-3">Формируется в Word (DOCX) на языке обращения. Ниже показан текст документа и тело почтового сообщения.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          {[
            { lang: "ru" as const, caption: "Русский", c: ru.cover },
            { lang: "kk" as const, caption: "Казахский", c: kk.cover },
          ].map(({ lang, caption, c }) => (
              <div key={lang} lang={lang} className="rounded-md border border-line">
                <p className="border-b border-line bg-sunken px-4 py-2 text-[12.5px] text-ink-3">{caption}</p>
                <div className="space-y-3 px-5 py-4 font-serif text-[14.5px] leading-relaxed text-ink">
                  <div className="flex flex-wrap justify-between gap-4 text-[13.5px]">
                    <div className="doc-number">
                      <p>{c.title}</p>
                      <p>{c.ref}</p>
                    </div>
                    <p className="max-w-[24ch] text-right">{c.addressee}</p>
                  </div>
                  <p>{c.body}</p>
                  <div>
                    <p>{c.attachHeader}</p>
                    {c.attachLines.map((l) => (
                      <p key={l}>{l}</p>
                    ))}
                  </div>
                  <div className="flex flex-wrap justify-between gap-4 pt-2">
                    <p className="max-w-[32ch]">{c.sign}</p>
                    <p>{c.chair}</p>
                  </div>
                </div>
                <div className="border-t border-line px-5 py-3">
                  <p className="text-[12.5px] text-ink-3">Тема письма</p>
                  <p className="mt-0.5 text-[13.5px] text-ink">{c.subject}</p>
                  <p className="mt-3 text-[12.5px] text-ink-3">Текст письма</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13.5px] text-ink">{c.emailBody}</p>
                </div>
              </div>
            ))}
        </div>
      </Section>
    </div>
  );
}

function Letter({ lang, caption, subject, body }: { lang: Lang; caption: string; subject: string; body: string }) {
  return (
    <div lang={lang} className="rounded-md border border-line">
      <p className="border-b border-line bg-sunken px-4 py-2 text-[12.5px] text-ink-3">{caption}</p>
      <div className="px-5 py-4">
        <p className="text-[12.5px] text-ink-3">Тема</p>
        <p className="mt-0.5 text-[14px] font-medium text-ink">{subject}</p>
        <p className="mt-4 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{body}</p>
      </div>
    </div>
  );
}
