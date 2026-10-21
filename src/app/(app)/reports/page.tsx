import { and, avg, count, countDistinct, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser, isStaff } from "@/server/auth";
import { CASE_STATE_LABEL, INTAKE_STATE_LABEL, OUTGOING_STATE_LABEL } from "@/domain/states";
import type { CaseState, IntakeState, OutgoingState } from "@/domain/types";
import { Button, Input, LinkButton, Notice, PageHeader, Section } from "@/components/ui";

export const metadata = { title: "Отчёты" };

/**
 * AUD-04. Рабочие отчёты за период. Каждый показатель сопровождается определением.
 * Отчёт отражает текущее состояние данных; исторический срез по журналу (AUD-05) — отдельная задача.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_ASG = ["sent", "receipt_confirmed", "in_work", "on_rework"];
const KIND_LABEL: Record<string, string> = { assignment: "Поручения", rka_package: "Комплекты в РКА", decision_notice: "Уведомления о решении", discussion_notice: "Уведомления об обсуждении" };

function validDate(s: string) {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requireUser();
  if (!isStaff(u)) {
    return (
      <>
        <PageHeader title="Отчёты" />
        <Notice tone="warn" title="Раздел доступен председателю и секретарю" />
      </>
    );
  }

  const sp = await searchParams;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" });
  const year = today.slice(0, 4);
  const fromRaw = typeof sp.from === "string" ? sp.from : "";
  const toRaw = typeof sp.to === "string" ? sp.to : "";
  const errors: string[] = [];
  let from = `${year}-01-01`;
  let to = `${year}-12-31`;
  if (fromRaw) validDate(fromRaw) ? (from = fromRaw) : errors.push(`Дата начала «${fromRaw}» не распознана — использовано 01.01.${year}.`);
  if (toRaw) validDate(toRaw) ? (to = toRaw) : errors.push(`Дата окончания «${toRaw}» не распознана — использовано 31.12.${year}.`);
  if (from > to) {
    errors.push("Дата начала позже даты окончания — даты поменяны местами.");
    [from, to] = [to, from];
  }
  // Границы периода в часовом поясе организации, хранение — UTC (UI-06).
  const start = new Date(`${from}T00:00:00+05:00`);
  const end = new Date(`${to}T23:59:59.999+05:00`);

  const org = u.orgId;
  const C = schema.cases;
  const A = schema.assignments;
  const O = schema.outgoings;
  const M = schema.messages;
  const AT = schema.attachments;
  const inPeriod = and(eq(C.organizationId, org), gte(C.receivedAt, start), lte(C.receivedAt, end));

  const [byState, byExecutor, overdue, intakeQueue, incompleteCases, sends, avgToSend, totals] = await Promise.all([
    // 1. Обращения за период по этапам
    db.select({ state: C.state, n: count() }).from(C).where(inPeriod).groupBy(C.state),

    // 2. По исполнителю: последнее первичное поручение дела
    db
      .select({
        name: schema.users.fullName,
        cases: countDistinct(A.caseId),
        active: sql<number>`count(distinct ${A.caseId}) filter (where ${A.state} in ('sent','receipt_confirmed','in_work','on_rework'))`.mapWith(Number),
        submitted: sql<number>`count(distinct ${A.caseId}) filter (where ${A.state} in ('draft_submitted','done'))`.mapWith(Number),
        overdue: sql<number>`count(distinct ${A.caseId}) filter (where ${A.state} in ('sent','receipt_confirmed','in_work','on_rework') and coalesce(${A.extendedUntil}, ${A.deadline}) < ${today})`.mapWith(Number),
      })
      .from(A)
      .innerJoin(C, eq(C.id, A.caseId))
      .innerJoin(schema.users, eq(schema.users.id, A.executorId))
      .where(and(eq(A.organizationId, org), eq(A.kind, "initial"), gte(C.receivedAt, start), lte(C.receivedAt, end)))
      .groupBy(schema.users.fullName)
      .orderBy(sql`count(distinct ${A.caseId}) desc`),

    // 3. Просроченные поручения (на сегодня, без привязки к периоду)
    db
      .select({ n: count(), cases: countDistinct(A.caseId) })
      .from(A)
      .where(and(eq(A.organizationId, org), inArray(A.state, ACTIVE_ASG), lt(sql`coalesce(${A.extendedUntil}, ${A.deadline})`, today))),

    // 4а. Очередь разбора: входящие без дела или с незавершённым приёмом
    db
      .select({ state: M.intakeState, n: count() })
      .from(M)
      .where(and(eq(M.organizationId, org), eq(M.direction, "in"), or(isNull(M.caseId), inArray(M.intakeState, ["needs_review", "incomplete", "quarantine", "access_error"])), ne(M.intakeState, "attached")))
      .groupBy(M.intakeState),

    // 4б. Дела с непроверенными обязательными вложениями
    db
      .select({ cases: countDistinct(M.caseId), items: count() })
      .from(AT)
      .innerJoin(M, eq(M.id, AT.messageId))
      .where(and(eq(AT.organizationId, org), isNotNull(M.caseId), eq(AT.inline, false), isNull(AT.parentPartId), notInArray(AT.status, ["verified", "excluded"]))),

    // 5. Исходящие за период по виду и состоянию
    db
      .select({ kind: O.kind, state: O.state, n: count() })
      .from(O)
      .where(and(eq(O.organizationId, org), gte(O.createdAt, start), lte(O.createdAt, end)))
      .groupBy(O.kind, O.state),

    // 6. Средний срок от поступления до отправки в РКА
    db
      .select({
        days: avg(sql`extract(epoch from (${O.sentAt} - ${C.receivedAt})) / 86400`),
        n: count(),
        min: sql<string | null>`min(extract(epoch from (${O.sentAt} - ${C.receivedAt})) / 86400)`,
        max: sql<string | null>`max(extract(epoch from (${O.sentAt} - ${C.receivedAt})) / 86400)`,
      })
      .from(O)
      .innerJoin(C, eq(C.id, O.caseId))
      .where(and(eq(O.organizationId, org), eq(O.kind, "rka_package"), eq(O.state, "sent"), isNotNull(O.sentAt), isNotNull(C.receivedAt), gte(O.sentAt, start), lte(O.sentAt, end))),

    db.select({ n: count() }).from(C).where(inPeriod),
  ]);

  const total = totals[0]?.n ?? 0;
  const stateOrder = Object.keys(CASE_STATE_LABEL) as CaseState[];
  const states = [...byState].sort((a, b) => stateOrder.indexOf(a.state as CaseState) - stateOrder.indexOf(b.state as CaseState));
  const queueTotal = intakeQueue.reduce((s, r) => s + r.n, 0);
  const sendKinds = [...new Set(sends.map((s) => s.kind))];
  const avgDays = avgToSend[0]?.days != null ? Number(avgToSend[0].days) : null;
  const fmtDays = (x: number | string | null | undefined) => (x == null ? "—" : Number(x).toLocaleString("ru-RU", { maximumFractionDigits: 1 }));
  const ruDate = (s: string) => s.split("-").reverse().join(".");

  return (
    <>
      <PageHeader title="Отчёты" lead={`Период: ${ruDate(from)} — ${ruDate(to)}. Даты по Алматы.`} />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">С</span>
          <Input type="date" name="from" defaultValue={from} className="tnum" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">По</span>
          <Input type="date" name="to" defaultValue={to} className="tnum" />
        </label>
        <Button type="submit" variant="secondary">
          Построить отчёт
        </Button>
        {(fromRaw || toRaw) && (
          <LinkButton href="/reports" variant="ghost">
            Текущий год
          </LinkButton>
        )}
      </form>

      {errors.length > 0 && (
        <div className="mb-4">
          <Notice tone="warn" title="Параметры исправлены">
            <ul className="list-disc pl-5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="mb-6">
        <Notice tone="info" title="Отчёт отражает текущее состояние дел">
          Этапы и статусы показаны на момент открытия страницы, а не на дату окончания периода. Исторический отчёт на дату среза строится по журналу операций (AUD-05) и пока не реализован. Для фиксации среза выгрузите реестр в CSV — в имени файла будет дата выгрузки.
        </Notice>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Обращения по этапам">
          <Figure value={total} label="обращений поступило за период" />
          {states.length === 0 ? (
            <p className="mt-3 text-[14px] text-ink-3">За период обращений не поступало.</p>
          ) : (
            <SimpleTable head={["Этап", "Обращений"]} rows={states.map((s) => [CASE_STATE_LABEL[s.state as CaseState] ?? s.state, s.n])} />
          )}
          <Definition>Обращения, у которых дата фактического поступления на ящик комиссии (столбец C реестра) попадает в период. Этап — текущий. Повторные циклы не считаются новыми обращениями.</Definition>
        </Section>

        <Section title="Сроки">
          <Figure value={overdue[0]?.n ?? 0} label="поручений просрочено сейчас" tone={(overdue[0]?.n ?? 0) > 0 ? "bad" : undefined} />
          <Definition>Поручения в работе (отправлено, получение подтверждено, в работе, на доработке), у которых срок — с учётом продления — раньше сегодняшнего дня. Считается на сегодня, без привязки к периоду. Дел: {overdue[0]?.cases ?? 0}.</Definition>
          <div className="mt-5 border-t border-line pt-4">
            <Figure value={fmtDays(avgDays)} label="дней в среднем от поступления до отправки в РКА" />
            {avgToSend[0]?.n ? (
              <p className="mt-1 text-[13px] text-ink-3 tnum">
                Отправок: {avgToSend[0].n}. Быстрее всего — {fmtDays(avgToSend[0].min)}, дольше всего — {fmtDays(avgToSend[0].max)} дн.
              </p>
            ) : null}
            <Definition>Разница между датой поступления письма РКА (C) и подтверждённой отправкой комплекта в РКА (Z) по комплектам, отправленным в периоде. Календарные дни. Повторные направления учитываются отдельными отправками.</Definition>
          </div>
        </Section>

        <Section title="Исполнители">
          {byExecutor.length === 0 ? (
            <p className="text-[14px] text-ink-3">За период поручений по обращениям не было.</p>
          ) : (
            <SimpleTable head={["Исполнитель", "Дел", "В работе", "Проект представлен", "Просрочено"]} rows={byExecutor.map((e) => [e.name, e.cases, e.active, e.submitted, e.overdue])} numeric={[1, 2, 3, 4]} />
          )}
          <Definition>Дела, поступившие в периоде, по исполнителю первичного поручения. «Проект представлен» — исполнитель прислал проект или поручение выполнено. Просрочка — на сегодня.</Definition>
        </Section>

        <Section title="Полнота поступлений">
          <Figure value={queueTotal} label="писем ждут разбора" tone={queueTotal > 0 ? "warn" : undefined} />
          {intakeQueue.length > 0 && <SimpleTable head={["Состояние", "Писем"]} rows={intakeQueue.map((r) => [INTAKE_STATE_LABEL[r.state as IntakeState] ?? r.state, r.n])} />}
          <Definition>Входящие письма, не приобщённые к делу, либо с незавершённым приёмом (требует разбора, загрузка не завершена, карантин, ошибка доступа). Считается на сегодня.</Definition>
          <div className="mt-5 border-t border-line pt-4">
            <Figure value={incompleteCases[0]?.cases ?? 0} label="дел с непроверенными вложениями" tone={(incompleteCases[0]?.cases ?? 0) > 0 ? "warn" : undefined} />
            <Definition>Дела, в письмах которых есть обязательные вложения не в состоянии «сохранено и проверено» и не исключённые с основанием. Таким делам заблокирована передача исполнителю. Вложений: {incompleteCases[0]?.items ?? 0}.</Definition>
          </div>
        </Section>

        <Section title="Исходящие и возвраты" className="lg:col-span-2">
          {sends.length === 0 ? (
            <p className="text-[14px] text-ink-3">За период исходящих не создавалось.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[14px]">
                <caption className="sr-only">Исходящие по виду и состоянию</caption>
                <thead className="text-[13px] text-ink-2">
                  <tr className="border-b border-line">
                    <th scope="col" className="py-2 pr-4 font-medium">Вид</th>
                    {(Object.keys(OUTGOING_STATE_LABEL) as OutgoingState[])
                      .filter((st) => sends.some((s) => s.state === st))
                      .map((st) => (
                        <th key={st} scope="col" className="px-3 py-2 text-right font-medium">
                          {st === "sent" ? "Принято провайдером" : OUTGOING_STATE_LABEL[st]}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {sendKinds.map((k) => (
                    <tr key={k}>
                      <th scope="row" className="py-2 pr-4 font-normal text-ink">
                        {KIND_LABEL[k] ?? k}
                      </th>
                      {(Object.keys(OUTGOING_STATE_LABEL) as OutgoingState[])
                        .filter((st) => sends.some((s) => s.state === st))
                        .map((st) => {
                          const n = sends.find((s) => s.kind === k && s.state === st)?.n ?? 0;
                          return (
                            <td key={st} className={`px-3 py-2 text-right tnum ${n && ["unknown_result", "error", "bounced", "approval_stale"].includes(st) ? "text-bad" : n ? "text-ink" : "text-ink-4"}`}>
                              {n}
                            </td>
                          );
                        })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Definition>Исходящие, созданные в периоде, по текущему состоянию. «Принято провайдером» означает, что почтовый сервис принял письмо и отправка сверена; доставку и прочтение это не подтверждает. «Возврат» — письмо вернулось с ошибкой доставки. «Результат неизвестен» — идёт сверка, повторная отправка не выполняется.</Definition>
        </Section>
      </div>
    </>
  );
}

function Figure({ value, label, tone }: { value: number | string; label: string; tone?: "bad" | "warn" }) {
  return (
    <p className="flex items-baseline gap-2">
      <span className={`text-[28px] font-semibold leading-none tnum ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink"}`}>{value}</span>
      <span className="text-[14px] text-ink-2">{label}</span>
    </p>
  );
}

function Definition({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-3">{children}</p>;
}

function SimpleTable({ head, rows, numeric = [1] }: { head: string[]; rows: (string | number)[][]; numeric?: number[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-[14px]">
        <thead className="text-[13px] text-ink-2">
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={h} scope="col" className={`py-2 font-medium ${numeric.includes(i) ? "px-3 text-right" : "pr-4"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-2 pr-4 font-normal text-ink">
                    {c}
                  </th>
                ) : (
                  <td key={i} className={`py-2 tnum ${numeric.includes(i) ? "px-3 text-right" : "pr-4"} ${c === 0 ? "text-ink-4" : "text-ink"}`}>
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
