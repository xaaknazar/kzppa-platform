import Link from "next/link";
import { requireUser, isStaff } from "@/server/auth";
import { dashboard } from "@/server/queries";
import { Badge, Empty, LinkButton, PageHeader, Section, fmtDate } from "@/components/ui";
import { formatBase } from "@/domain/numbering";
import { CASE_STATE_LABEL, OUTGOING_STATE_LABEL } from "@/domain/states";
import type { CaseState, OutgoingState } from "@/domain/types";

export const metadata = { title: "Главная" };

/** UI-01: мои задачи, просрочки, неполные поступления, согласования, проблемы подключений. */
export default async function Home() {
  const u = await requireUser();
  const d = await dashboard(u);
  const staff = isStaff(u);
  const firstName = u.fullName.split(" ")[1] ?? u.fullName;

  const approvalsCount = d.approvals ? d.approvals.assignments.length + d.approvals.packages.length + d.approvals.toSign.length + d.approvals.drafts.length : 0;
  const total = d.stateCounts.reduce((a, b) => a + b.n, 0);
  const inWork = d.stateCounts.filter((s) => !["sent", "closed", "cancelled"].includes(s.state)).reduce((a, b) => a + b.n, 0);

  return (
    <>
      <PageHeader
        title={`Добрый день, ${firstName}`}
        lead={staff ? `В работе ${inWork} из ${total} обращений. Ниже — то, что ждёт вашего решения.` : "Ваши поручения и голосования."}
        actions={staff ? <LinkButton href="/registry" variant="secondary">Открыть реестр</LinkButton> : null}
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {d.approvals && (
            <Section title="Ждёт решения председателя" aside={<Badge tone={approvalsCount ? "seal" : "neutral"}>{approvalsCount}</Badge>}>
              {approvalsCount === 0 ? (
                <p className="text-[14px] text-ink-3">Нет документов, ожидающих вашего утверждения.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.approvals.assignments.map(({ a, c, e }) => (
                    <Row key={a.id} href={`/cases/${c.id}?tab=assignments`} num={c.number} title={`Поручение исполнителю: ${e.fullName}`} meta={`${c.applicant}. Срок ${fmtDate(a.deadline)}. Письмо не отправлено до утверждения текста.`} tag="Утвердить поручение" />
                  ))}
                  {d.approvals.drafts.map(({ c, k }) => (
                    <Row key={c.id} href={`/cases/${k.id}?tab=review`} num={k.number} title="Проект заключения на предварительную проверку" meta={k.applicant} tag="Проверить проект" />
                  ))}
                  {d.approvals.toSign.map(({ q, k }) => (
                    <Row key={q.id} href={`/cases/${k.id}?tab=signatures`} num={k.number} title="Заключение готово к подписанию ЭЦП" meta={k.applicant} tag="Подписать" />
                  ))}
                  {d.approvals.packages.map(({ o, c }) => (
                    <Row key={o.id} href={`/cases/${c.id}?tab=outgoing`} num={c.number} title={`Комплект в РКА, исх. № ${o.numberDisplay}`} meta={`${c.applicant}. ${(o.manifest as unknown[]).length} файлов`} tag="Согласовать комплект" />
                  ))}
                </ul>
              )}
            </Section>
          )}

          {staff && (
            <Section title="Задачи" aside={<Badge>{d.tasks.length}</Badge>}>
              {d.tasks.length === 0 ? (
                <p className="text-[14px] text-ink-3">Открытых задач нет.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.tasks.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="text-[14px] text-ink">{t.title}</p>
                        {t.detail && <p className="mt-0.5 text-[13px] text-ink-3">{t.detail}</p>}
                        <p className="mt-0.5 text-[12px] text-ink-4 tnum">{fmtDate(t.createdAt, true)}</p>
                      </div>
                      {t.caseId ? (
                        <LinkButton size="sm" href={`/cases/${t.caseId}`}>Открыть дело</LinkButton>
                      ) : t.kind.startsWith("intake") ? (
                        <LinkButton size="sm" href={`/inbox${t.objectId ? `/${t.objectId}` : ""}`}>Разобрать</LinkButton>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {staff && d.overdue.length > 0 && (
            <Section title="Просроченные поручения" aside={<Badge tone="bad">{d.overdue.length}</Badge>}>
              <ul className="divide-y divide-line">
                {d.overdue.map(({ a, c, e }) => (
                  <Row key={a.id} href={`/cases/${c.id}?tab=assignments`} num={c.number} title={`${e.fullName}: срок ${fmtDate(a.extendedUntil ?? a.deadline)}`} meta={c.applicant} tag="Просрочено" tone="bad" />
                ))}
              </ul>
            </Section>
          )}

          {(d.myAssignments.length > 0 || !staff) && (
            <Section title="Мои поручения">
              {d.myAssignments.length === 0 ? (
                <p className="text-[14px] text-ink-3">Поручений нет.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {d.myAssignments.map(({ a, c }) => (
                    <Row key={a.id} href={`/w/${c.id}`} num={c.number} title={c.applicant} meta={`Срок ${fmtDate(a.extendedUntil ?? a.deadline)}`} tag={a.state === "on_rework" ? "На доработке" : a.state === "draft_submitted" ? "Проект представлен" : "В работе"} />
                  ))}
                </ul>
              )}
            </Section>
          )}
        </div>

        <div className="space-y-6">
          <Section title="Голосования">
            {d.votes.length === 0 ? (
              <p className="text-[14px] text-ink-3">Открытых голосований нет.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.votes.map((v) => (
                  <li key={v.cycle.id} className="py-3">
                    <Link href={`/votes/${v.cycle.id}`} className="group block">
                      <p className="text-[14px] text-ink group-hover:text-petrol">
                        Дело <span className="doc-number">№{formatBase(v.kase.number)}</span>, {v.kase.applicant}
                      </p>
                      <p className="mt-0.5 text-[12.5px] text-ink-3">
                        до {fmtDate(v.cycle.closesAt, true)}. {v.voted ? "Ваш голос учтён" : "Вы ещё не голосовали"}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {staff && (
            <Section title="Состояние системы">
              <ul className="space-y-2.5 text-[13.5px]">
                {d.connections.length === 0 && (
                  <li className="flex justify-between gap-2">
                    <span className="text-ink-2">Почта комиссии</span>
                    <Badge tone="warn">Не подключена</Badge>
                  </li>
                )}
                {d.connections.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span className="truncate text-ink-2">{c.email}</span>
                    <Badge tone={["up_to_date", "connected", "syncing"].includes(c.state) ? "ok" : "warn"}>{CONN[c.state] ?? c.state}</Badge>
                  </li>
                ))}
                {d.unknownSends.map((o) => (
                  <li key={o.id} className="flex justify-between gap-2">
                    <Link href={`/cases/${o.caseId}?tab=outgoing`} className="truncate text-ink-2 hover:text-petrol">
                      {o.kind === "assignment" ? "Поручение" : `Исх. № ${o.numberDisplay}`}
                    </Link>
                    <Badge tone="bad">{OUTGOING_STATE_LABEL[o.state as OutgoingState]}</Badge>
                  </li>
                ))}
                {d.deadOutbox > 0 && (
                  <li className="flex justify-between gap-2">
                    <span className="text-ink-2">Фоновые операции с ошибкой</span>
                    <Badge tone="bad">{d.deadOutbox}</Badge>
                  </li>
                )}
                {d.unknownSends.length === 0 && d.deadOutbox === 0 && d.connections.every((c) => ["up_to_date", "connected", "syncing"].includes(c.state)) && d.connections.length > 0 && <li className="text-ink-3">Сбоев нет.</li>}
              </ul>
            </Section>
          )}

          {staff && total > 0 && (
            <Section title="Обращения по этапам">
              <ul className="space-y-1.5 text-[13.5px]">
                {d.stateCounts
                  .sort((a, b) => b.n - a.n)
                  .map((s) => (
                    <li key={s.state} className="flex justify-between">
                      <span className="text-ink-2">{CASE_STATE_LABEL[s.state as CaseState] ?? s.state}</span>
                      <span className="tnum text-ink">{s.n}</span>
                    </li>
                  ))}
              </ul>
            </Section>
          )}
          {!staff && d.votes.length === 0 && d.myAssignments.length === 0 && <Empty title="Сейчас для вас ничего нет">Когда председатель назначит вам дело или откроет голосование, оно появится здесь и придёт письмом.</Empty>}
        </div>
      </div>
    </>
  );
}

const CONN: Record<string, string> = { connected: "Подключена", syncing: "Синхронизация", up_to_date: "Актуально", delayed: "Задержка", login_required: "Требуется вход", quota: "Квота", unavailable: "Недоступна", disabled: "Отключена" };

function Row({ href, num, title, meta, tag, tone = "petrol" }: { href: string; num: number; title: string; meta?: string; tag: string; tone?: "petrol" | "bad" }) {
  return (
    <li>
      <Link href={href} className="group flex items-start gap-4 py-3">
        <span className="doc-number w-10 shrink-0 pt-0.5 text-[15px] text-ink-3">{formatBase(num)}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] text-ink group-hover:text-petrol">{title}</span>
          {meta && <span className="mt-0.5 block text-[12.5px] text-ink-3">{meta}</span>}
        </span>
        <Badge tone={tone === "bad" ? "bad" : "petrol"}>{tag}</Badge>
      </Link>
    </li>
  );
}
