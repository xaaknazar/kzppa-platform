"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { seedStepAction } from "./actions";

/**
 * Демо-заполнение порциями: функция на Vercel ограничена по времени, поэтому клиент
 * вызывает порции подряд и показывает прогресс. Сбой сети — повтор той же порции.
 */
export function SeedRunner({ stages, initialDone, started }: { stages: { key: string; label: string }[]; initialDone: string[]; started: boolean }) {
  const [done, setDone] = useState<string[]>(initialDone);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = stages.every((s) => done.includes(s.key));

  async function run() {
    setRunning(true);
    setError(null);
    let failures = 0;
    for (;;) {
      try {
        const r = await seedStepAction();
        if (!r.ok) {
          setError(r.error);
          break;
        }
        setDone(r.done);
        failures = 0;
        if (r.complete) {
          window.location.href = "/login";
          return;
        }
      } catch {
        if (++failures >= 3) {
          setError("Нет связи с сервером. Нажмите «Продолжить заполнение» ещё раз.");
          break;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    setRunning(false);
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-1.5 text-[13.5px]">
        {stages.map((s) => {
          const ok = done.includes(s.key);
          const current = running && !ok && stages.find((x) => !done.includes(x.key))?.key === s.key;
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span aria-hidden className={ok ? "text-ok" : current ? "text-petrol" : "text-ink-4"}>{ok ? "✓" : current ? "●" : "○"}</span>
              <span className={ok ? "text-ink" : current ? "font-medium text-petrol" : "text-ink-3"}>{s.label}</span>
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="rounded-md bg-bad-50 px-3 py-2 text-[13.5px] text-bad">{error}</p>}
      {!complete && (
        <div>
          <Button className="w-full" disabled={running} onClick={run}>
            {running ? "Идёт заполнение…" : started ? "Продолжить заполнение" : "Заполнить демонстрационными данными"}
          </Button>
          <p className="mt-2 text-[12.5px] text-ink-3">Заполнение идёт порциями, обычно 2–4 минуты. Не закрывайте страницу; если закроете, продолжите с того же места.</p>
        </div>
      )}
    </div>
  );
}
