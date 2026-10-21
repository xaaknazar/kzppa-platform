import { requireUser, isStaff } from "@/server/auth";
import { env } from "@/server/env";
import { buildRegistry, REGISTRY_COLUMNS } from "@/server/services/registry";
import { normalizeRkaNumber } from "@/domain/numbering";
import { CASE_STATE_LABEL } from "@/domain/states";
import type { CaseState } from "@/domain/types";
import { Button, Empty, Input, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { RegistryTable } from "./registry-table";

export const metadata = { title: "Реестр обращений" };

/** CASE-07, раздел 25. Реестр строится из подтверждённых событий; пустая ячейка — нормальное состояние до события. */
export default async function RegistryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requireUser();
  if (!isStaff(u)) {
    return (
      <>
        <PageHeader title="Реестр обращений" />
        <Notice tone="warn" title="Раздел доступен председателю и секретарю">
          Ваши поручения и голосования — на главной странице.
        </Notice>
      </>
    );
  }

  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 200);
  const stateParam = typeof sp.state === "string" ? sp.state : "";
  const state = stateParam === "overdue" || stateParam === "open" || stateParam in CASE_STATE_LABEL ? stateParam : "";
  const full = sp.view === "full";

  const all = await buildRegistry(u.orgId, { appUrl: env.appUrl });

  const needle = q.toLowerCase();
  const rkaNeedle = q ? normalizeRkaNumber(q) : null;
  const digits = /^\d{1,4}$/.test(q) ? Number(q) : null;
  const rows = all.filter((r) => {
    if (state === "overdue" && !r.flags.overdue) return false;
    if (state === "open" && ["sent", "closed", "cancelled"].includes(r.state)) return false;
    if (state && state !== "overdue" && state !== "open" && r.state !== state) return false;
    if (!q) return true;
    if (digits !== null && r.caseNumber === digits) return true;
    if (r.A?.includes(q)) return true;
    if (r.E?.toLowerCase().includes(needle)) return true;
    if (r.B && (r.B.toLowerCase().includes(needle) || (rkaNeedle && r.B === rkaNeedle))) return true;
    return false;
  });

  const overdueCount = all.filter((r) => r.flags.overdue).length;
  const filtered = !!q || !!state;
  const csvHref = "/api/registry.csv";

  return (
    <>
      <PageHeader
        title="Реестр обращений"
        lead={`Всего ${all.length}${overdueCount ? `, с просроченным сроком рассмотрения ${overdueCount}` : ""}. Поля заполняются из подтверждённых событий дела: пустая ячейка означает, что событие ещё не произошло.`}
        actions={
          // Обычная ссылка: файл отдаёт обработчик маршрута, клиентская навигация не нужна.
          <a href={csvHref} download className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink transition-colors hover:bg-sunken">
            Выгрузить в CSV
          </a>
        }
      />

      <form method="get" className="mb-5 flex flex-wrap items-end gap-3" role="search">
        <label className="block min-w-[240px] flex-1">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">Поиск</span>
          <Input type="search" name="q" defaultValue={q} placeholder="Номер дела, фамилия заявителя или номер письма РКА" />
        </label>
        <label className="block w-full sm:w-[240px]">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">Этап</span>
          <Select name="state" defaultValue={state}>
            <option value="">Все этапы</option>
            <option value="open">В работе (не направлено и не закрыто)</option>
            <option value="overdue">Просроченный срок</option>
            {(Object.keys(CASE_STATE_LABEL) as CaseState[]).map((s) => (
              <option key={s} value={s}>
                {CASE_STATE_LABEL[s]}
              </option>
            ))}
          </Select>
        </label>
        {full && <input type="hidden" name="view" value="full" />}
        <Button type="submit" variant="secondary">
          Найти
        </Button>
        {filtered && (
          <LinkButton href={full ? "/registry?view=full" : "/registry"} variant="ghost">
            Сбросить
          </LinkButton>
        )}
      </form>

      {all.length === 0 ? (
        <Empty title="В реестре пока нет обращений" action={<LinkButton href="/inbox" variant="primary">Открыть разбор почты</LinkButton>}>
          Обращение появляется в реестре после регистрации письма РКА в разборе почты.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty title="Ничего не найдено" action={<LinkButton href="/registry">Показать весь реестр</LinkButton>}>
          Проверьте написание фамилии или номера. Номер письма РКА можно вводить в любом виде: 04-01/1351 и 04-01-1351 — одно и то же.
        </Empty>
      ) : (
        <RegistryTable rows={rows} columns={REGISTRY_COLUMNS.map(([k, l]) => ({ key: k, label: l }))} full={full} query={{ q, state }} total={all.length} />
      )}
    </>
  );
}
