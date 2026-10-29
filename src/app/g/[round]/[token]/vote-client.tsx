"use client";
import { useState } from "react";
import clsx from "clsx";

const CHOICES = [
  { v: "За", hint: "Согласен с заключением" },
  { v: "Против", hint: "Не согласен с заключением" },
  { v: "Воздержался", hint: "Учитывается как участие" },
] as const;

export function VoteClient({ round, token, open, voted, preview }: { round: string; token: string; open: boolean; voted: string | null; preview: boolean }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "confirm" | "sending" | "done">(voted ? "done" : "pick");
  const [message, setMessage] = useState<string | null>(voted ? `Ваш голос «${voted}» уже зарегистрирован. Повторное голосование не требуется.` : null);
  const [error, setError] = useState<string | null>(null);

  if (step === "done") return <p role="status" className="rounded-md border border-ok/30 bg-ok-50 px-4 py-3 text-[15px] font-medium text-ok">{message}</p>;
  if (!open && !preview) return <p className="rounded-md bg-sunken px-4 py-3 text-[14.5px] text-ink-2">Голосование закрыто или ещё не открыто.</p>;

  async function send() {
    setStep("sending");
    setError(null);
    try {
      const r = await fetch("/api/golos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ round, token, choice }) });
      const j = (await r.json()) as { ok: boolean; message?: string; error?: string };
      if (j.ok) {
        setMessage(j.message ?? "Голос зарегистрирован. Спасибо.");
        setStep("done");
      } else {
        setError(j.error ?? "Голос не записан. Попробуйте ещё раз.");
        setStep("confirm");
      }
    } catch {
      setError("Нет связи. Проверьте интернет и нажмите ещё раз.");
      setStep("confirm");
    }
  }

  return (
    <div>
      <fieldset disabled={step !== "pick"} className="space-y-2.5">
        <legend className="mb-3 text-[15px] font-medium text-ink">Ваше решение:</legend>
        {CHOICES.map((c) => (
          <button
            key={c.v}
            type="button"
            onClick={() => setChoice(c.v)}
            className={clsx(
              "flex w-full items-center justify-between rounded-lg border px-4 py-4 text-left transition-colors",
              choice === c.v ? "border-petrol bg-petrol-50 ring-2 ring-petrol/20" : "border-line-strong bg-surface hover:border-petrol",
            )}
          >
            <span className="text-[17px] font-medium text-ink">{c.v}</span>
            <span className="text-[13px] text-ink-3">{c.hint}</span>
          </button>
        ))}
      </fieldset>
      {error && <p role="alert" className="mt-3 rounded-md bg-bad-50 px-3 py-2 text-[14px] text-bad">{error}</p>}
      {step === "pick" ? (
        <button type="button" disabled={!choice} onClick={() => setStep("confirm")} className="mt-5 h-12 w-full rounded-lg bg-petrol text-[16px] font-medium text-white disabled:opacity-40">
          Продолжить
        </button>
      ) : (
        <div className="mt-5 rounded-lg border border-line bg-sunken p-4">
          <p className="text-[15px] text-ink">
            Подтвердите голос: <b>«{choice}»</b>. {preview ? "Это предварительный просмотр — голос не запишется." : "Изменить его после отправки нельзя."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={step === "sending"} onClick={() => { setStep("pick"); setError(null); }} className="h-11 rounded-lg border border-line-strong bg-surface text-[15px] text-ink">
              Назад
            </button>
            <button type="button" disabled={step === "sending"} onClick={send} className="h-11 rounded-lg bg-petrol text-[15px] font-medium text-white disabled:opacity-60">
              {step === "sending" ? "Отправляем…" : "Подтвердить"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
