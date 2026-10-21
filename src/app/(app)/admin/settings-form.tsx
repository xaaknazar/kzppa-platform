"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { formatOutgoingFull } from "@/domain/numbering";
import type { DecisionRule, QuorumRule } from "@/domain/quorum";
import { saveOrgSettingsAction } from "./actions";

/* ───────────── Подразделы администрирования ───────────── */

const SECTIONS = [
  { href: "/admin", label: "Общие настройки" },
  { href: "/admin/members", label: "Состав комиссии" },
  { href: "/admin/connections", label: "Подключения" },
  { href: "/admin/templates", label: "Шаблоны" },
  { href: "/admin/outbox", label: "Фоновые операции" },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav aria-label="Разделы администрирования" className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
      {SECTIONS.map((s) => {
        const active = s.href === "/admin" ? path === "/admin" : path === s.href || path.startsWith(`${s.href}/`);
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={clsx("whitespace-nowrap border-b-2 px-3 py-2.5 text-[14px] transition-colors", active ? "border-petrol font-medium text-petrol" : "border-transparent text-ink-3 hover:text-ink")}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Кнопка, вызывающая привязанное серверное действие: подпись ожидания,
 * сообщение об успехе или ошибке рядом с кнопкой.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  successLabel,
  variant = "secondary",
}: {
  action: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>;
  label: string;
  pendingLabel: string;
  successLabel: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={pending}
        onClick={() => {
          setResult(null);
          start(async () => {
            const r = await action();
            setResult(r.ok ? { ok: true, text: successLabel } : { ok: false, text: r.error });
            router.refresh();
          });
        }}
      >
        {pending ? pendingLabel : label}
      </Button>
      <span aria-live="polite" className={clsx("max-w-[48ch] text-[12.5px]", result?.ok ? "text-ok" : "text-bad")}>
        {result?.text}
      </span>
    </div>
  );
}

/* ───────────── Настройки организации ───────────── */

export interface SettingsValues {
  name: string;
  nameKk: string;
  shortName: string;
  officialSender: string;
  rkaAddress: string;
  rkaAddressee: string;
  outgoingPrefix: string;
  outgoingYearInNumber: boolean;
  quorumRule: QuorumRule;
  decisionRule: DecisionRule;
}

type DecisionKind = DecisionRule["kind"];

const DECISION_OPTIONS: { value: DecisionKind; label: string }[] = [
  { value: "unknown", label: "Не зафиксировано" },
  { value: "for_more_than_half_of_participants", label: "«За» более половины участвовавших" },
  { value: "for_more_than_against", label: "«За» больше, чем «Против»" },
  { value: "for_more_than_half_of_composition", label: "«За» более половины состава" },
];

export function SettingsForm({ initial, composition }: { initial: SettingsValues; composition: number }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [qKind, setQKind] = useState<QuorumRule["kind"]>(initial.quorumRule.kind);
  const [qMin, setQMin] = useState(initial.quorumRule.kind === "min_participants" ? String(initial.quorumRule.min) : "");
  const [qComp, setQComp] = useState(initial.quorumRule.kind === "min_participants" ? String(initial.quorumRule.composition) : String(composition || ""));
  const [dKind, setDKind] = useState<DecisionKind>(initial.decisionRule.kind);
  const [source, setSource] = useState(initial.decisionRule.kind === "unknown" ? "" : initial.decisionRule.source);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ warnings: string[] } | null>(null);
  const [pending, start] = useTransition();

  const set = <K extends keyof SettingsValues>(k: K, val: SettingsValues[K]) => {
    setSaved(null);
    setV((p) => ({ ...p, [k]: val }));
  };

  const year = v.outgoingYearInNumber ? new Date().getFullYear() : null;
  const prefix = v.outgoingPrefix.trim() || null;
  const preview = [0, 1, 2].map((i) => {
    try {
      return formatOutgoingFull({ caseNumber: 1, repeatIndex: i }, { prefix, year });
    } catch {
      return "—";
    }
  });

  const compNum = Number(qComp);
  const minNum = Number(qMin);
  const halfOfCurrent = Math.floor(composition / 2) + 1;
  const compMismatch = qKind === "min_participants" && qComp !== "" && Number.isFinite(compNum) && compNum !== composition;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSourceError(null);
    setSaved(null);
    if (dKind !== "unknown" && source.trim().length < 5) {
      setSourceError("Укажите пункт и редакцию Положения, например «п. 4.7 Положения о Комиссии, ред. от 12.03.2025».");
      return;
    }
    if (qKind === "min_participants" && (!Number.isInteger(minNum) || !Number.isInteger(compNum) || minNum < 1 || compNum < 1)) {
      setError("Укажите порог кворума и состав целыми числами.");
      return;
    }
    const quorumRule: QuorumRule = qKind === "min_participants" ? { kind: "min_participants", min: minNum, composition: compNum } : { kind: "more_than_half_of_composition" };
    const decisionRule: DecisionRule = dKind === "unknown" ? { kind: "unknown" } : { kind: dKind, source: source.trim() };
    start(async () => {
      const r = await saveOrgSettingsAction({ ...v, quorumRule, decisionRule });
      if (r.ok) {
        const data = r.data as { warnings?: string[] } | undefined;
        setSaved({ warnings: data?.warnings ?? [] });
        router.refresh();
      } else setError(r.error);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <fieldset className="rounded-lg border border-line bg-surface px-5 py-4">
        <legend className="px-1 text-[15px] font-semibold text-ink">Комиссия</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Полное наименование (русский)">
              <Input required value={v.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Полное наименование (казахский)" hint="Используется в казахских шаблонах и на QR-карточке">
              <Input lang="kk" value={v.nameKk} onChange={(e) => set("nameKk", e.target.value)} />
            </Field>
          </div>
          <Field label="Краткое наименование">
            <Input required value={v.shortName} onChange={(e) => set("shortName", e.target.value)} />
          </Field>
          <Field label="Официальный адрес комиссии" hint="С него уходят письма, на него исполнители присылают проекты">
            <Input type="email" required value={v.officialSender} onChange={(e) => set("officialSender", e.target.value)} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-line bg-surface px-5 py-4">
        <legend className="px-1 text-[15px] font-semibold text-ink">Направление в РКА</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <Field label="Адрес РКА для комплектов">
            <Input type="email" required value={v.rkaAddress} onChange={(e) => set("rkaAddress", e.target.value)} />
          </Field>
          <Field label="Адресат сопроводительного письма">
            <Input required value={v.rkaAddressee} onChange={(e) => set("rkaAddressee", e.target.value)} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-line bg-surface px-5 py-4">
        <legend className="px-1 text-[15px] font-semibold text-ink">Нумерация исходящих</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <Field label="Буквенный префикс" hint="Ещё утверждается (DEC-01). Оставьте пустым, если не утверждён">
            <Input value={v.outgoingPrefix} onChange={(e) => set("outgoingPrefix", e.target.value)} placeholder="Например, КЗППА" maxLength={24} />
          </Field>
          <div className="pt-6">
            <label className="flex items-start gap-2.5 text-[14px] text-ink">
              <input type="checkbox" className="mt-1 size-4 accent-[var(--color-petrol)]" checked={v.outgoingYearInNumber} onChange={(e) => set("outgoingYearInNumber", e.target.checked)} />
              <span>Включать год в полный номер</span>
            </label>
          </div>
        </div>
        <div className="mt-4 rounded-md bg-sunken px-4 py-3">
          <p className="text-[12.5px] text-ink-3">Как будут выглядеть номера по делу 001</p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-[14px] sm:grid-cols-3">
            {["Первое направление", "Первое повторное", "Второе повторное"].map((l, i) => (
              <div key={l}>
                <dt className="text-[12.5px] text-ink-3">{l}</dt>
                <dd className="doc-number text-[16px] text-ink">{preview[i]}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[12.5px] text-ink-3">Основа и дробный индекс подтверждены заказчиком и не настраиваются. Номер письма РКА хранится отдельно.</p>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-line bg-surface px-5 py-4">
        <legend className="px-1 text-[15px] font-semibold text-ink">Кворум и решение</legend>
        <div className="mt-2 space-y-5">
          <Notice tone="warn" title="Правило переносится из действующего Положения, а не выбирается в платформе">
            Укажите правило так, как оно записано в Положении о Комиссии, и сошлитесь на пункт и редакцию. Платформа не устанавливает большинство сама. Изменение правила действует только для новых голосований: каждый цикл хранит правила, действовавшие при его открытии, и прошлые протоколы не пересчитываются.
          </Notice>

          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-ink-2">Кворум</legend>
            <div className="space-y-2">
              <label className={clsx("flex items-start gap-3 rounded-md border px-3 py-2.5", qKind === "min_participants" ? "border-petrol bg-petrol-50" : "border-line-strong")}>
                <input type="radio" name="quorum" className="mt-1 size-4 accent-[var(--color-petrol)]" checked={qKind === "min_participants"} onChange={() => setQKind("min_participants")} />
                <span className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
                  Не менее
                  <input
                    aria-label="Минимальное число участвовавших"
                    inputMode="numeric"
                    className="h-8 w-16 rounded-md border border-line-strong bg-surface px-2 text-center tnum focus:border-petrol focus:outline-none focus:ring-2 focus:ring-petrol/15 disabled:bg-sunken"
                    value={qMin}
                    disabled={qKind !== "min_participants"}
                    onChange={(e) => setQMin(e.target.value.replace(/\D/g, ""))}
                  />
                  участвовавших при составе
                  <input
                    aria-label="Состав комиссии, для которого утверждён порог"
                    inputMode="numeric"
                    className="h-8 w-16 rounded-md border border-line-strong bg-surface px-2 text-center tnum focus:border-petrol focus:outline-none focus:ring-2 focus:ring-petrol/15 disabled:bg-sunken"
                    value={qComp}
                    disabled={qKind !== "min_participants"}
                    onChange={(e) => setQComp(e.target.value.replace(/\D/g, ""))}
                  />
                </span>
              </label>
              <label className={clsx("flex items-start gap-3 rounded-md border px-3 py-2.5", qKind === "more_than_half_of_composition" ? "border-petrol bg-petrol-50" : "border-line-strong")}>
                <input type="radio" name="quorum" className="mt-1 size-4 accent-[var(--color-petrol)]" checked={qKind === "more_than_half_of_composition"} onChange={() => setQKind("more_than_half_of_composition")} />
                <span className="text-[14px] text-ink">
                  Более половины состава
                  <span className="block text-[12.5px] text-ink-3 tnum">При текущем составе {composition}: не менее {halfOfCurrent} участвовавших</span>
                </span>
              </label>
            </div>
            <p className="mt-2 text-[12.5px] text-ink-3">Воздержавшиеся учитываются как участвовавшие, не голосовавшие — нет.</p>
            {compMismatch && (
              <p className="mt-2 text-[13px] text-warn" role="status">
                Порог задан для состава {compNum}, а сейчас в составе {composition} действующих членов комиссии. Новые голосования не дадут результата, пока числа не совпадут.
              </p>
            )}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Порядок определения решения">
              <Select value={dKind} onChange={(e) => setDKind(e.target.value as DecisionKind)}>
                {DECISION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Пункт и редакция Положения" error={sourceError} hint={dKind === "unknown" ? "Заполняется вместе с правилом" : "Обязательно. Попадает в каждый протокол"}>
              <Input value={source} disabled={dKind === "unknown"} onChange={(e) => setSource(e.target.value)} placeholder="п. 4.7, ред. от 12.03.2025" aria-required={dKind !== "unknown"} />
            </Field>
          </div>
          {dKind === "unknown" && <p className="text-[13px] text-ink-3">Пока правило не зафиксировано, протокол покажет «Решение не определено» даже при достигнутом кворуме.</p>}
        </div>
      </fieldset>

      <div className="space-y-3">
        {error && <Notice tone="bad" title="Настройки не сохранены">{error}</Notice>}
        {saved && (
          <Notice tone={saved.warnings.length ? "warn" : "ok"} title="Настройки сохранены">
            {saved.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5">
                {saved.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : (
              "Изменение записано в журнал операций."
            )}
          </Notice>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Сохраняем…" : "Сохранить настройки"}
        </Button>
      </div>
    </form>
  );
}
