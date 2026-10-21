"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { castVoteAction } from "@/app/actions";
import { Button, Notice, Textarea } from "@/components/ui";
import type { VoteChoice } from "@/domain/types";

const OPTIONS: { value: VoteChoice; label: string; hint: string }[] = [
  { value: "for", label: "За", hint: "Согласен с проектом заключения" },
  { value: "against", label: "Против", hint: "Не согласен с проектом" },
  { value: "abstain", label: "Воздержался", hint: "Учитывается как участие в голосовании" },
];

/** FLOW-06: один голос на участника, с подтверждением; ключ идемпотентности фиксирован на время показа формы. */
export function VoteForm({ cycleId }: { cycleId: string }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [choice, setChoice] = useState<VoteChoice | null>(null);
  const [comment, setComment] = useState("");
  const [special, setSpecial] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<{ choice: VoteChoice; at: Date } | null>(null);
  const [pending, start] = useTransition();

  const label = OPTIONS.find((o) => o.value === choice)?.label;

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!choice) {
      setError("Выберите вариант: «За», «Против» или «Воздержался».");
      return;
    }
    setConfirming(true);
  }

  function submit() {
    if (!choice) return;
    setError(null);
    start(async () => {
      const r = await castVoteAction({ cycleId, choice, comment: comment.trim() || undefined, specialOpinion: special.trim() || undefined, idempotencyKey: key });
      if (r.ok) {
        setRecorded({ choice, at: new Date() });
        router.refresh();
      } else {
        setConfirming(false);
        setError(r.error);
      }
    });
  }

  if (recorded) {
    return (
      <Notice tone="ok" title="Ваш голос учтён">
        <span className="tnum">
          {OPTIONS.find((o) => o.value === recorded.choice)?.label},{" "}
          {recorded.at.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}.
        </span>
      </Notice>
    );
  }

  return (
    <form onSubmit={review} className="space-y-4" noValidate>
      <fieldset disabled={confirming || pending}>
        <legend className="mb-2 text-[13px] font-medium text-ink-2">Ваше решение по проекту</legend>
        <div className="space-y-2">
          {OPTIONS.map((o) => (
            <label
              key={o.value}
              className={clsx(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-petrol/30",
                choice === o.value ? "border-petrol bg-petrol-50" : "border-line-strong bg-surface hover:bg-sunken",
              )}
            >
              <input type="radio" name="choice" value={o.value} checked={choice === o.value} onChange={() => setChoice(o.value)} className="mt-1 size-4 accent-[var(--color-petrol)]" />
              <span>
                <span className="block text-[14.5px] font-medium text-ink">{o.label}</span>
                <span className="block text-[12.5px] text-ink-3">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">Замечание (необязательно)</span>
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} />
        </label>

        <details className="mt-3 rounded-md border border-line" open={special.length > 0 || undefined}>
          <summary className="cursor-pointer px-3 py-2 text-[13.5px] text-petrol hover:bg-sunken">Добавить особое мнение</summary>
          <div className="border-t border-line px-3 py-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink-2">Особое мнение</span>
              <Textarea rows={5} value={special} onChange={(e) => setSpecial(e.target.value)} maxLength={20000} />
              <span className="mt-1 block text-[12.5px] text-ink-3">Сохраняется в протоколе в разрешённом объёме.</span>
            </label>
          </div>
        </details>
      </fieldset>

      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}

      {!confirming ? (
        <Button type="submit" className="w-full" disabled={pending}>
          Перейти к подтверждению
        </Button>
      ) : (
        <div className="space-y-3 rounded-md border border-line bg-sunken px-3 py-3" aria-live="polite">
          <p className="text-[14px] text-ink">
            Вы голосуете: <strong className="font-semibold">{label}</strong>
            {comment.trim() ? ", с замечанием" : ""}
            {special.trim() ? ", с особым мнением" : ""}.
          </p>
          <p className="text-[13px] text-ink-2">Голос нельзя изменить после подачи.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? "Подаём голос…" : "Подать голос"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Изменить выбор
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
