"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type { RegistryRow, ColKey } from "@/server/services/registry";
import { Badge, type Tone } from "@/components/ui";

/** Ключевые столбцы компактного вида (CASE-07). */
const COMPACT: { key: ColKey; label: string; className?: string }[] = [
  { key: "A", label: "№", className: "w-[64px]" },
  { key: "B", label: "№ письма РКА", className: "w-[120px]" },
  { key: "C", label: "Поступило", className: "w-[104px]" },
  { key: "D", label: "Регион / коллегия", className: "min-w-[170px]" },
  { key: "E", label: "Заявитель", className: "min-w-[180px]" },
  { key: "F", label: "Краткое содержание", className: "min-w-[280px]" },
  { key: "G", label: "Кому поручено", className: "min-w-[150px]" },
  { key: "I", label: "Срок", className: "w-[104px]" },
  { key: "K", label: "Этап / результат", className: "min-w-[150px]" },
  { key: "T", label: "Голосование", className: "min-w-[150px]" },
  { key: "V", label: "№ заключения", className: "w-[110px]" },
  { key: "Z", label: "Отправлено в РКА", className: "w-[110px]" },
  { key: "AA", label: "Статус отправки", className: "min-w-[150px]" },
];

const STATE_TONE: Record<string, Tone> = {
  registered: "info",
  assigned: "petrol",
  in_progress: "petrol",
  review: "petrol",
  rework: "warn",
  approved: "petrol",
  sent: "ok",
  closed: "neutral",
  suspended: "warn",
  resumed: "info",
  cancelled: "neutral",
};

const SEND_TONE: Record<string, Tone> = {
  Отправлено: "ok",
  "Результат неизвестен": "bad",
  Ошибка: "bad",
  Возврат: "bad",
  "Разрешение устарело": "bad",
};

/** Короткая запись голосования: «за 5, против 1. Решение принято». */
function shortTally(t: string | null) {
  if (!t) return null;
  const votes = t.match(/за (\d+), против (\d+)/);
  const outcome = t.split(". ").pop()?.trim();
  return [votes ? `за ${votes[1]}, против ${votes[2]}` : null, outcome].filter(Boolean).join(". ");
}

function hrefWith(query: { q: string; state: string }, full: boolean) {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.state) p.set("state", query.state);
  if (full) p.set("view", "full");
  const s = p.toString();
  return s ? `/registry?${s}` : "/registry";
}

export function RegistryTable({ rows, columns, full, query, total }: { rows: RegistryRow[]; columns: { key: ColKey; label: string }[]; full: boolean; query: { q: string; state: string }; total: number }) {
  const router = useRouter();
  const open = (caseId: string) => router.push(`/cases/${caseId}`);
  const onRowClick = (e: React.MouseEvent, caseId: string) => {
    // Не перехватываем клики по ссылкам и выделение текста.
    if ((e.target as HTMLElement).closest("a") || window.getSelection()?.toString()) return;
    open(caseId);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-ink-3 tnum">
          {rows.length === total ? `Показано ${rows.length}` : `Найдено ${rows.length} из ${total}`}
        </p>
        <div className="flex items-center gap-1 rounded-md border border-line bg-surface p-0.5" role="group" aria-label="Вид таблицы">
          <Link href={hrefWith(query, false)} aria-current={!full ? "true" : undefined} className={clsx("rounded px-3 py-1.5 text-[13px]", !full ? "bg-petrol-50 font-medium text-petrol" : "text-ink-3 hover:text-ink")}>
            Основные столбцы
          </Link>
          <Link href={hrefWith(query, true)} aria-current={full ? "true" : undefined} className={clsx("rounded px-3 py-1.5 text-[13px]", full ? "bg-petrol-50 font-medium text-petrol" : "text-ink-3 hover:text-ink")}>
            Все 37 столбцов
          </Link>
        </div>
      </div>

      {full ? (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-line bg-surface">
          <table className="reg-table w-max min-w-full border-separate border-spacing-0 text-left text-[13px]">
            <caption className="sr-only">Реестр обращений, все столбцы раздела 25</caption>
            <thead className="text-[12.5px] text-ink-2">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="max-w-[260px] border-b border-line px-3 py-2 align-bottom font-medium">
                    <span className="text-ink-4">{c.key}</span> {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.caseId} onClick={(e) => onRowClick(e, r.caseId)} className={clsx("cursor-pointer align-top hover:bg-paper", r.flags.overdue && "bg-bad-50/40")}>
                  {columns.map((c) => (
                    <td key={c.key} className="max-w-[260px] border-b border-line px-3 py-2">
                      <FullCell row={r} col={c.key} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[1400px] text-left text-[13.5px]">
            <caption className="sr-only">Реестр обращений, основные столбцы</caption>
            <thead className="bg-sunken text-[12.5px] text-ink-2">
              <tr>
                {COMPACT.map((c) => (
                  <th key={c.key} scope="col" className={clsx("px-3 py-2.5 font-medium", c.className)}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.caseId} onClick={(e) => onRowClick(e, r.caseId)} className={clsx("cursor-pointer align-top hover:bg-paper", r.flags.overdue && "bg-bad-50/40")}>
                  {COMPACT.map((c) => (
                    <td key={c.key} className="px-3 py-3">
                      <CompactCell row={r} col={c.key} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">Строка показывает актуальный цикл рассмотрения. Прежние циклы, направления и решения — в карточке дела и в выгрузке.</p>
    </div>
  );
}

function Dash() {
  return <span className="text-ink-4">—</span>;
}

function CompactCell({ row: r, col }: { row: RegistryRow; col: ColKey }) {
  switch (col) {
    case "A":
      return (
        <Link href={`/cases/${r.caseId}`} className="doc-number text-[15px] text-ink hover:text-petrol">
          {r.A}
          {r.cyclesCount > 1 && <span className="ml-1 font-sans text-[11.5px] text-ink-3">цикл {r.cyclesCount}</span>}
        </Link>
      );
    case "B":
      return r.B ? <span className="doc-number whitespace-nowrap">{r.B}</span> : <Dash />;
    case "C":
    case "I":
    case "Z":
      if (col === "I" && r.I) {
        return (
          <span className="whitespace-nowrap tnum">
            {r.J ? <><s className="text-ink-4">{r.I}</s><span className="block">{r.J}</span></> : r.I}
            {r.flags.overdue && <span className="mt-1 block"><Badge tone="bad">Просрочено</Badge></span>}
          </span>
        );
      }
      return r[col] ? <span className="whitespace-nowrap tnum">{r[col]}</span> : <Dash />;
    case "D":
      return r.flags.collegiumNeedsCheck ? (
        <span className="text-warn">
          <span className="font-medium">Требует проверки</span>
          {r.D && r.D.startsWith("Требует проверки:") && <span className="block text-[12.5px] text-ink-3">{r.D.replace(/^Требует проверки:\s*/, "")}</span>}
        </span>
      ) : (
        <span>{r.D}</span>
      );
    case "E":
      return <span className="font-serif text-[14.5px] text-ink">{r.E}</span>;
    case "F":
      return r.F ? (
        <span>
          <span className="line-clamp-2 text-ink-2" title={r.F}>
            {r.F}
          </span>
          {r.flags.summaryMachine && <span className="mt-1 inline-block"><Badge tone="info">машинный проект</Badge></span>}
        </span>
      ) : (
        <Dash />
      );
    case "K":
      return (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={STATE_TONE[r.state] ?? "neutral"}>{r.stateLabel}</Badge>
          {r.K && r.K !== r.stateLabel && <span className="text-[12.5px] text-ink-2">{r.K}</span>}
          {r.flags.incomplete && <Badge tone="warn">Вложения не проверены</Badge>}
        </span>
      );
    case "T": {
      const t = shortTally(r.T);
      return t ? <span className="tnum" title={r.T ?? undefined}>{t}</span> : <Dash />;
    }
    case "V":
      return r.V ? <span className="doc-number whitespace-nowrap">{r.V}</span> : <Dash />;
    case "AA":
      return r.AA ? <Badge tone={SEND_TONE[r.AA] ?? "neutral"}>{r.AA}</Badge> : <Dash />;
    default:
      return r[col] ? <span>{r[col]}</span> : <Dash />;
  }
}

function FullCell({ row: r, col }: { row: RegistryRow; col: ColKey }) {
  const v = r[col];
  if (col === "A") return <CompactCell row={r} col="A" />;
  if (col === "D" && r.flags.collegiumNeedsCheck) return <span className="text-warn">{v}</span>;
  if (col === "E") return <span className="font-serif">{v}</span>;
  if (col === "F")
    return v ? (
      <span>
        <span className="line-clamp-2" title={v}>{v}</span>
        {r.flags.summaryMachine && <span className="mt-1 inline-block"><Badge tone="info">машинный проект</Badge></span>}
      </span>
    ) : (
      <Dash />
    );
  if (col === "I" && r.flags.overdue) return <span className="tnum text-bad">{v} <span className="text-[12px]">просрочено</span></span>;
  if (!v) return <Dash />;
  if (col === "O" || col === "Y")
    return (
      <a href={v} className="break-all text-petrol hover:underline" onClick={(e) => e.stopPropagation()}>
        {col === "O" ? "Открыть дело" : "Итоговый PDF"}
      </a>
    );
  if (col === "AB" || col === "AJ") return <code className="break-all font-mono text-[12px] text-ink-2">{v}</code>;
  if (col === "B" || col === "V") return <span className="doc-number">{v}</span>;
  return <span className="tnum">{v}</span>;
}
