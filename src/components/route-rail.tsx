import clsx from "clsx";
import type { RouteStep } from "@/server/route";
import { fmtDate } from "./ui";

/**
 * Маршрут дела — вертикальная лента утверждённых этапов. Это последовательность,
 * поэтому нумерация уместна. Текущий этап выделен, блокирующее условие названо прямо.
 */
export function RouteRail({ steps }: { steps: RouteStep[] }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="relative grid grid-cols-[28px_1fr] gap-x-3 pb-4 last:pb-0">
            {!last && (
              <span
                aria-hidden
                className={clsx("absolute left-[13.5px] top-7 bottom-0 w-px", s.status === "done" ? (s.seal ? "bg-seal/50" : "bg-petrol/40") : "bg-line-strong")}
              />
            )}
            <span
              aria-hidden
              className={clsx(
                "relative z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full text-[12px] font-semibold tnum",
                s.status === "done" && (s.seal ? "bg-seal text-white" : "bg-petrol text-white"),
                s.status === "current" && "bg-surface text-petrol ring-2 ring-petrol",
                s.status === "blocked" && "bg-bad text-white",
                (s.status === "pending" || s.status === "skipped") && "bg-sunken text-ink-4 ring-1 ring-line-strong",
              )}
            >
              {s.status === "done" ? (
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              ) : s.status === "blocked" ? (
                "!"
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className={clsx("text-[14px] leading-snug", s.status === "pending" ? "text-ink-3" : "text-ink", s.status === "current" && "font-semibold")}>
                <span className="sr-only">{statusText(s.status)}: </span>
                {s.title}
              </p>
              {(s.at || s.note) && s.status !== "pending" && (
                <p className="mt-0.5 text-[12.5px] text-ink-3">
                  {s.at && <span className="tnum">{fmtDate(s.at, true)}</span>}
                  {s.at && s.note && <span>, </span>}
                  {s.note}
                </p>
              )}
              {s.blocker && <p className="mt-1 text-[12.5px] font-medium text-bad">{s.blocker}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function statusText(s: RouteStep["status"]) {
  return { done: "Выполнено", current: "Текущий этап", blocked: "Заблокировано", pending: "Ожидает", skipped: "Пропущено" }[s];
}
