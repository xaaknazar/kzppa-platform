import Link from "next/link";
import clsx from "clsx";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser, isStaff } from "@/server/auth";
import { formatBase } from "@/domain/numbering";
import { OUTGOING_STATE_LABEL } from "@/domain/states";
import type { OutgoingState } from "@/domain/types";
import { Badge, Empty, Hash, LinkButton, Notice, PageHeader, fmtDate, type Tone } from "@/components/ui";

export const metadata = { title: "Исходящие" };

/**
 * DATA-09, OUT-05..09. Все исходящие организации. «Принято провайдером и сверено»,
 * «результат неизвестен», «ошибка» и «возврат» — разные факты (OUT-08).
 */

const KIND_LABEL: Record<string, string> = {
  assignment: "Поручение",
  rka_package: "Комплект в РКА",
  decision_notice: "Уведомление о решении",
  discussion_notice: "Уведомление об обсуждении",
};

const STATE_TONE: Record<string, Tone> = {
  project: "neutral",
  package_checked: "neutral",
  draft: "info",
  approved: "seal",
  sending: "info",
  sent: "ok",
  approval_stale: "bad",
  unknown_result: "bad",
  bounced: "bad",
  error: "bad",
};

/** Пояснение к состоянию: что именно известно о письме. */
const STATE_NOTE: Record<string, string> = {
  project: "Не отправлено. Готовится.",
  package_checked: "Не отправлено. Состав проверен.",
  draft: "Не отправлено. Ждёт согласования председателя.",
  approved: "Не отправлено. Разрешено, ожидает отправки.",
  sending: "Передаётся почтовому провайдеру.",
  sent: "Принято провайдером, отправка сверена. Доставка и прочтение этим не подтверждаются.",
  unknown_result: "Провайдер не ответил. Возможно, письмо ушло: идёт сверка отправленных. Повторно не отправляйте.",
  error: "Провайдер отклонил отправку. Письмо не ушло.",
  bounced: "Письмо ушло, но вернулось с ошибкой доставки.",
  approval_stale: "Состав изменён после разрешения. Нужно новое согласование.",
};

const FILTERS = [
  { key: "all", label: "Все" },
  { key: "problems", label: "Требуют внимания" },
  { key: "pending", label: "Не отправлены" },
  { key: "sent", label: "Отправлены" },
] as const;
const PROBLEM = ["unknown_result", "error", "bounced", "approval_stale"];
const PENDING = ["project", "package_checked", "draft", "approved", "sending"];

export default async function OutgoingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requireUser();
  if (!isStaff(u)) {
    return (
      <>
        <PageHeader title="Исходящие" />
        <Notice tone="warn" title="Раздел доступен председателю и секретарю" />
      </>
    );
  }
  const sp = await searchParams;
  const f = FILTERS.find((x) => x.key === sp.f)?.key ?? "all";

  const o = schema.outgoings;
  const rows = await db
    .select({ o, c: { id: schema.cases.id, number: schema.cases.number, applicant: schema.cases.applicant } })
    .from(o)
    .innerJoin(schema.cases, eq(schema.cases.id, o.caseId))
    .where(eq(o.organizationId, u.orgId))
    .orderBy(desc(o.createdAt))
    .limit(1000);

  const pick = (key: string) => rows.filter(({ o }) => (key === "problems" ? PROBLEM.includes(o.state) : key === "pending" ? PENDING.includes(o.state) : key === "sent" ? o.state === "sent" : true));
  const shown = pick(f);
  const problems = pick("problems").length;

  return (
    <>
      <PageHeader title="Исходящие" lead="Поручения исполнителям, комплекты в РКА и уведомления. До согласования письмо не отправляется, даже если рабочий доступ уже выдан." />

      {problems > 0 && (
        <div className="mb-5">
          <Notice tone="bad" title={`Требуют внимания: ${problems}`}>
            Результат неизвестен, ошибка, возврат или устаревшее разрешение. Откройте дело: там видно, что известно о письме и какое действие доступно. Повторную отправку при неизвестном результате платформа не делает, пока не завершена сверка отправленных.
          </Notice>
        </div>
      )}

      <nav aria-label="Фильтр исходящих" className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
        {FILTERS.map((x) => (
          <Link
            key={x.key}
            href={x.key === "all" ? "/outgoing" : `/outgoing?f=${x.key}`}
            aria-current={f === x.key ? "page" : undefined}
            className={clsx("whitespace-nowrap border-b-2 px-3 py-2.5 text-[14px] transition-colors", f === x.key ? "border-petrol font-medium text-petrol" : "border-transparent text-ink-3 hover:text-ink")}
          >
            {x.label}
            <span className="ml-1.5 text-ink-4 tnum">{pick(x.key).length}</span>
          </Link>
        ))}
      </nav>

      <div className="mt-6">
        {shown.length === 0 ? (
          <Empty title={f === "problems" ? "Проблемных отправок нет" : "Исходящих пока нет"} action={f !== "all" ? <LinkButton href="/outgoing" size="sm">Показать все</LinkButton> : <LinkButton href="/registry" size="sm">Открыть реестр</LinkButton>}>
            Поручение появляется здесь после утверждения председателем, комплект в РКА — после подготовки в карточке дела.
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[1080px] text-left text-[13.5px]">
              <caption className="sr-only">Исходящие письма комиссии</caption>
              <thead className="bg-sunken text-[12.5px] text-ink-2">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Вид</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Исх. №</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Дело</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Кому</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Тема</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Состояние</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Отправлено</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">ID у провайдера</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map(({ o, c }) => {
                  const tab = o.kind === "assignment" ? "assignments" : "outgoing";
                  return (
                    <tr key={o.id} className="align-top">
                      <td className="px-4 py-3 text-ink">{KIND_LABEL[o.kind] ?? o.kind}</td>
                      <td className="whitespace-nowrap px-3 py-3">{o.numberDisplay ? <span className="doc-number">{o.numberDisplay}</span> : <span className="text-ink-4">—</span>}</td>
                      <td className="px-3 py-3">
                        <Link href={`/cases/${c.id}?tab=${tab}`} className="group block">
                          <span className="doc-number text-ink group-hover:text-petrol">№{formatBase(c.number)}</span>
                          <span className="block max-w-[200px] truncate font-serif text-[13px] text-ink-3">{c.applicant}</span>
                        </Link>
                      </td>
                      <td className="max-w-[220px] px-3 py-3 break-words text-ink-2">
                        {o.toAddrs.join(", ")}
                        {o.ccAddrs.length > 0 && <span className="block text-[12px] text-ink-3">копия: {o.ccAddrs.join(", ")}</span>}
                      </td>
                      <td className="max-w-[280px] px-3 py-3 text-ink-2">
                        <span className="line-clamp-2" title={o.subject}>{o.subject}</span>
                      </td>
                      <td className="max-w-[260px] px-3 py-3">
                        <Badge tone={STATE_TONE[o.state] ?? "neutral"}>{o.state === "sent" ? "Принято провайдером" : OUTGOING_STATE_LABEL[o.state as OutgoingState] ?? o.state}</Badge>
                        <span className="mt-1 block text-[12.5px] leading-snug text-ink-3">{STATE_NOTE[o.state] ?? ""}</span>
                        {o.state === "error" && o.rejectedReason && <span className="mt-1 block text-[12.5px] text-bad">{o.rejectedReason}</span>}
                        {o.attempts > 1 && <span className="mt-1 block text-[12px] text-ink-3 tnum">попыток: {o.attempts}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 tnum text-ink-2">{o.state === "sent" || o.state === "bounced" ? fmtDate(o.sentAt, true) ?? "—" : <span className="text-ink-4">—</span>}</td>
                      <td className="px-4 py-3">
                        <Hash value={o.providerMessageId} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
