import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser, isChair } from "@/server/auth";
import { LANG_LABEL } from "@/domain/language";
import { formatBase } from "@/domain/numbering";
import type { Lang } from "@/domain/types";
import { Badge, Empty, LinkButton, Notice, PageHeader, Section, fmtDate, fmtSize } from "@/components/ui";

export const metadata = { title: "На утверждение" };

/**
 * OUT-01..05, UI-04. Очередь председателя: тексты поручений и комплекты в РКА.
 * Здесь — сводка того, что будет отправлено; утверждение выполняется в карточке дела,
 * где показан полный текст и хеш показанной версии.
 */
export default async function ApprovalsPage() {
  const u = await requireUser();
  if (!isChair(u)) {
    return (
      <>
        <PageHeader title="На утверждение" />
        <Notice tone="warn" title="Раздел доступен председателю">
          Поручения и комплекты в РКА утверждает лично председатель. Секретарь видит их состояние в карточке дела и в разделе «Исходящие».
        </Notice>
      </>
    );
  }

  const [assignments, packages] = await Promise.all([
    db
      .select({ a: schema.assignments, c: schema.cases, e: { fullName: schema.users.fullName, email: schema.users.email } })
      .from(schema.assignments)
      .innerJoin(schema.cases, eq(schema.cases.id, schema.assignments.caseId))
      .innerJoin(schema.users, eq(schema.users.id, schema.assignments.executorId))
      .where(and(eq(schema.assignments.organizationId, u.orgId), eq(schema.assignments.state, "text_on_approval")))
      .orderBy(asc(schema.assignments.createdAt)),
    db
      .select({ o: schema.outgoings, c: schema.cases })
      .from(schema.outgoings)
      .innerJoin(schema.cases, eq(schema.cases.id, schema.outgoings.caseId))
      .where(and(eq(schema.outgoings.organizationId, u.orgId), eq(schema.outgoings.kind, "rka_package"), eq(schema.outgoings.state, "draft")))
      .orderBy(asc(schema.outgoings.createdAt)),
  ]);
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) });
  const total = assignments.length + packages.length;

  return (
    <>
      <PageHeader
        title="На утверждение"
        lead={total ? `Ждут вашего решения: ${total}. Ничего не отправляется, пока вы не утвердите текст и состав в карточке дела.` : "Документов, ожидающих вашего утверждения, нет."}
      />

      {total === 0 ? (
        <Empty title="Всё утверждено" action={<LinkButton href="/registry">Открыть реестр</LinkButton>}>
          Здесь появятся тексты поручений исполнителям и комплекты писем в РКА, когда секретарь их подготовит.
        </Empty>
      ) : (
        <div className="space-y-6">
          <Section title="Поручения исполнителям" aside={<Badge tone={assignments.length ? "seal" : "neutral"}>{assignments.length}</Badge>}>
            {assignments.length === 0 ? (
              <p className="text-[14px] text-ink-3">Поручений на утверждении нет.</p>
            ) : (
              <ul className="divide-y divide-line">
                {assignments.map(({ a, c, e }) => {
                  const materials = Array.isArray(a.materialVersionIds) ? a.materialVersionIds.length : 0;
                  return (
                    <li key={a.id} className="py-4 first:pt-1 last:pb-1">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] text-ink">
                            Дело <span className="doc-number">№{formatBase(c.number)}</span>, <span className="font-serif">{c.applicant}</span>
                          </p>
                          <dl className="mt-2 grid gap-x-8 gap-y-1.5 text-[13.5px] sm:grid-cols-[auto_1fr]">
                            <dt className="text-ink-3">Кому</dt>
                            <dd className="text-ink">
                              {e.fullName} <span className="text-ink-2">&lt;{e.email}&gt;</span>, без копии другим членам комиссии
                            </dd>
                            <dt className="text-ink-3">От</dt>
                            <dd className="text-ink-2">{org?.officialSender ?? "—"}</dd>
                            <dt className="text-ink-3">Язык письма</dt>
                            <dd className="text-ink">{LANG_LABEL[a.lang as Lang] ?? a.lang}</dd>
                            <dt className="text-ink-3">Срок рассмотрения</dt>
                            <dd className="tnum text-ink">{fmtDate(a.deadline) ?? "Не указан"}</dd>
                            <dt className="text-ink-3">Тема</dt>
                            <dd className="text-ink-2">{a.letterSubject ?? <span className="text-ink-4">—</span>}</dd>
                            <dt className="text-ink-3">Материалы</dt>
                            <dd className="text-ink-2 tnum">{materials ? `${materials} в рабочей области исполнителя` : "Не выбраны"}</dd>
                          </dl>
                        </div>
                        <LinkButton href={`/cases/${c.id}?tab=assignments`} variant="seal">
                          Проверить и утвердить поручение
                        </LinkButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Комплекты в РКА" aside={<Badge tone={packages.length ? "seal" : "neutral"}>{packages.length}</Badge>}>
            {packages.length === 0 ? (
              <p className="text-[14px] text-ink-3">Комплектов на согласовании нет.</p>
            ) : (
              <ul className="divide-y divide-line">
                {packages.map(({ o, c }) => {
                  const files = (Array.isArray(o.manifest) ? o.manifest : []) as { name?: string; size?: number; role?: string }[];
                  const totalSize = files.reduce((s, f) => s + (typeof f.size === "number" ? f.size : 0), 0);
                  const langMismatch = c.conclusionLang && o.lang && c.conclusionLang !== o.lang;
                  return (
                    <li key={o.id} className="py-4 first:pt-1 last:pb-1">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] text-ink">
                            Исх. <span className="doc-number">№{o.numberDisplay ?? "—"}</span> по делу <span className="doc-number">№{formatBase(c.number)}</span>, <span className="font-serif">{c.applicant}</span>
                          </p>
                          <dl className="mt-2 grid gap-x-8 gap-y-1.5 text-[13.5px] sm:grid-cols-[auto_1fr]">
                            <dt className="text-ink-3">Кому</dt>
                            <dd className="text-ink">
                              {o.toAddrs.join(", ")}
                              {o.ccAddrs.length > 0 && <span className="text-ink-2">, копия: {o.ccAddrs.join(", ")}</span>}
                            </dd>
                            <dt className="text-ink-3">От</dt>
                            <dd className="text-ink-2">{o.fromAddr}</dd>
                            <dt className="text-ink-3">Язык письма</dt>
                            <dd className="text-ink">
                              {o.lang ? LANG_LABEL[o.lang as Lang] ?? o.lang : "Не указан"}
                              {langMismatch && <span className="ml-2"><Badge tone="warn">Заключение на другом языке</Badge></span>}
                            </dd>
                            <dt className="text-ink-3">Дата исходящего</dt>
                            <dd className="tnum text-ink">{fmtDate(o.outgoingDate) ?? "—"}</dd>
                            <dt className="text-ink-3">Тема</dt>
                            <dd className="text-ink-2">{o.subject}</dd>
                            <dt className="text-ink-3">Вложения</dt>
                            <dd className="text-ink-2">
                              <span className="tnum">
                                {files.length} файлов, {fmtSize(totalSize)}
                              </span>
                              {files.length > 0 && (
                                <ul className="mt-1 space-y-0.5">
                                  {files.map((f, i) => (
                                    <li key={i} className="break-all text-[13px]">
                                      {f.name ?? "Без имени"}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </dd>
                          </dl>
                        </div>
                        <LinkButton href={`/cases/${c.id}?tab=outgoing`} variant="seal">
                          Проверить и согласовать комплект
                        </LinkButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
          <p className="text-[13px] text-ink-3">
            Если после согласования изменится адресат, текст или любой файл, разрешение станет недействительным и комплект вернётся сюда. Отправку выполняет платформа с адреса {org?.officialSender ?? "комиссии"}; результат виден в разделе <Link href="/outgoing" className="text-petrol hover:underline">Исходящие</Link>.
          </p>
        </div>
      )}
    </>
  );
}
