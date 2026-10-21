"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { attachMessageAction, excludeAttachmentAction, registerCaseAction } from "@/app/actions";
import { LANG_LABEL } from "@/domain/language";
import type { Lang } from "@/domain/types";
import { Badge, Button, Field, Input, Notice, Select, Textarea } from "@/components/ui";

/** Один ключ идемпотентности на монтирование формы: повторное нажатие не создаёт дублей. */
function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return () => {
    if (!ref.current) ref.current = crypto.randomUUID();
    return ref.current;
  };
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[13px] text-bad">
      {error}
    </p>
  );
}

const NETWORK_ERROR = "Не удалось связаться с сервером. Проверьте подключение и нажмите кнопку ещё раз — повтор не создаст дубля.";

/* ───────────── Исключение вложения из обязательного состава (MAIL-09) ───────────── */

export function ExcludeAttachmentForm({ attachmentId, filename }: { attachmentId: string; filename: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" className="-ml-3" onClick={() => setOpen(true)}>
        Исключить из обязательного состава
      </Button>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (basis.trim().length < 10) {
      setError("Опишите основание исключения — не короче 10 символов.");
      return;
    }
    start(async () => {
      try {
        const r = await excludeAttachmentAction({ attachmentId, basis: basis.trim() });
        if (!r.ok) return setError(r.error);
        setOpen(false);
        setBasis("");
        router.refresh();
      } catch {
        setError(NETWORK_ERROR);
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-line bg-paper p-3">
      <Field label={`Основание исключения файла «${filename}»`} hint="Например: файл повреждён у отправителя, РКА подтвердила повторную отправку письмом от …">
        <Textarea rows={3} value={basis} onChange={(e) => setBasis(e.target.value)} required minLength={10} disabled={pending} />
      </Field>
      <p className="text-[12.5px] text-ink-3">Исключение записывается в журнал с вашим именем. Файл останется в списке с отметкой.</p>
      <ErrorText error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {pending ? "Сохраняем…" : "Исключить с основанием"}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

/* ───────────── Приобщение к предложенному делу (CASE-06) ───────────── */

function AttachForm({ messageId, caseId, caseNumber, placeholder, onCancel }: { messageId: string; caseId: string; caseNumber: string; placeholder?: string; onCancel?: () => void }) {
  const router = useRouter();
  const key = useIdempotencyKey();
  const [basis, setBasis] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (basis.trim().length < 5) {
      setError("Укажите основание приобщения: почему письмо относится к этому делу.");
      return;
    }
    start(async () => {
      try {
        const r = await attachMessageAction({ messageId, caseId, basis: basis.trim(), idempotencyKey: key() });
        if (!r.ok) return setError(r.error);
        router.push(`/cases/${caseId}`);
      } catch {
        setError(NETWORK_ERROR);
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <Field label="Основание приобщения" hint="Сохраняется в деле и журнале операций.">
        <Textarea rows={2} value={basis} onChange={(e) => setBasis(e.target.value)} placeholder={placeholder} required minLength={5} disabled={pending} />
      </Field>
      <ErrorText error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Сохраняем…" : <>Приобщить к делу <span className="doc-number">№{caseNumber}</span></>}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={onCancel}>
            Отмена
          </Button>
        )}
      </div>
    </form>
  );
}

export function AttachToCandidate({ messageId, caseId, caseNumber, defaultBasis }: { messageId: string; caseId: string; caseNumber: string; defaultBasis?: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Приобщить к делу <span className="doc-number">№{caseNumber}</span>
      </Button>
    );
  }
  return <AttachForm messageId={messageId} caseId={caseId} caseNumber={caseNumber} placeholder={defaultBasis ? `Например: ${defaultBasis}` : undefined} onCancel={() => setOpen(false)} />;
}

/* ───────────── Поиск дела и приобщение ───────────── */

export function CaseSearchAttach({ messageId, cases }: { messageId: string; cases: { id: string; label: string; number: string }[] }) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState("");
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cases.slice(0, 50);
    return cases.filter((c) => c.label.toLowerCase().includes(s)).slice(0, 50);
  }, [q, cases]);
  const chosen = cases.find((c) => c.id === selected) ?? null;

  if (cases.length === 0) return <p className="text-[13.5px] text-ink-3">В реестре пока нет дел.</p>;

  return (
    <div className="space-y-3">
      <Field label="Поиск дела">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Номер, фамилия или номер РКА" />
      </Field>
      <Field label="Дело" hint={matches.length === 50 ? "Показаны первые 50 совпадений. Уточните запрос." : `Найдено: ${matches.length}`}>
        <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Выберите дело</option>
          {matches.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
          {chosen && !matches.some((m) => m.id === chosen.id) && <option value={chosen.id}>{chosen.label}</option>}
        </Select>
      </Field>
      {chosen && <AttachForm key={chosen.id} messageId={messageId} caseId={chosen.id} caseNumber={chosen.number} />}
    </div>
  );
}

/* ───────────── Регистрация нового обращения (CASE-01, CASE-07) ───────────── */

export function RegisterCaseForm({
  messageId,
  manifestIncomplete,
  defaults,
  collegiumCandidates,
}: {
  messageId: string;
  manifestIncomplete: boolean;
  defaults: { applicant: string; applicantOptions: string[]; rkaNumber: string; rkaDate: string; summary: string; lang: Lang | null; langMixed: boolean };
  collegiumCandidates: string[];
}) {
  const router = useRouter();
  const key = useIdempotencyKey();
  const [applicant, setApplicant] = useState(defaults.applicant);
  const [rkaNumber, setRkaNumber] = useState(defaults.rkaNumber);
  const [rkaDate, setRkaDate] = useState(defaults.rkaDate);
  const [collegium, setCollegium] = useState(collegiumCandidates.length === 1 ? collegiumCandidates[0] : "");
  const [summary, setSummary] = useState(defaults.summary);
  const [lang, setLang] = useState<Lang | "">(defaults.lang ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const summaryIsMachine = !!defaults.summary && summary === defaults.summary;
  const collegiumNeedsCheck = collegiumCandidates.length !== 1;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!applicant.trim()) return setError("Укажите заявителя: фамилию, имя и отчество адвоката.");
    if (!lang) return setError("Выберите язык обращения: от него зависит язык поручения и сопроводительного письма.");
    start(async () => {
      try {
        const r = await registerCaseAction({
          messageId,
          applicant: applicant.trim(),
          rkaNumber: rkaNumber.trim() || undefined,
          rkaDate: rkaDate || undefined,
          collegium: collegium.trim() || undefined,
          // Неизменённый машинный проект не передаётся как ручной ввод: сервер сохранит его с признаком «машинный проект».
          summary: summaryIsMachine ? undefined : summary.trim() || undefined,
          lang,
          idempotencyKey: key(),
        });
        if (!r.ok) return setError(r.error);
        const data = r.data as { caseId?: string } | undefined;
        if (data?.caseId) router.push(`/cases/${data.caseId}`);
        else router.push("/registry");
      } catch {
        setError(NETWORK_ERROR);
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-[13px] text-ink-3">Проверьте, что такого дела нет в списке кандидатов. Поля заполнены по тексту письма — сверьте их с оригиналом.</p>

      {manifestIncomplete && (
        <Notice tone="warn" title="Регистрация возможна, передача исполнителю — нет">
          Не все вложения сохранены и проверены. Дело будет создано, но назначить исполнителя и выдать ему материалы можно только после проверки всех обязательных вложений или их исключения с основанием.
        </Notice>
      )}

      <Field label="Заявитель" hint="Фамилия, имя, отчество адвоката, в защиту прав которого поступило обращение.">
        <Input value={applicant} onChange={(e) => setApplicant(e.target.value)} required autoComplete="off" className="font-serif" disabled={pending} />
      </Field>
      {defaults.applicantOptions.length > 1 && (
        <div className="-mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] text-ink-3">Варианты из темы:</span>
          {defaults.applicantOptions.map((a) => (
            <Chip key={a} active={applicant === a} onClick={() => setApplicant(a)}>
              {a}
            </Chip>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Номер письма РКА" hint="Например, 04-01/1351">
          <Input value={rkaNumber} onChange={(e) => setRkaNumber(e.target.value)} className="doc-number" autoComplete="off" disabled={pending} />
        </Field>
        <Field label="Дата письма РКА">
          <Input type="date" value={rkaDate} onChange={(e) => setRkaDate(e.target.value)} className="tnum" disabled={pending} />
        </Field>
      </div>

      <div>
        <Field
          label="Регион / коллегия"
          hint={
            collegiumNeedsCheck ? (
              <>
                <span className="font-medium text-warn">Требует проверки.</span> {collegiumCandidates.length === 0 ? "Коллегия в тексте письма не найдена." : "Найдено несколько вариантов."} Город в подписи РКА не является коллегией заявителя.
              </>
            ) : (
              "Извлечено из текста письма. Город в подписи РКА не является коллегией заявителя."
            )
          }
        >
          <Input value={collegium} onChange={(e) => setCollegium(e.target.value)} autoComplete="off" placeholder="Можно оставить пустым до проверки" disabled={pending} />
        </Field>
        {collegiumCandidates.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] text-ink-3">Найдено в письме:</span>
            {collegiumCandidates.map((c) => (
              <Chip key={c} active={collegium === c} onClick={() => setCollegium(c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink-2">Краткое содержание</span>
          {summaryIsMachine && <Badge tone="info">машинный проект</Badge>}
        </div>
        <Textarea aria-label="Краткое содержание" rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} disabled={pending} />
        <p className="mt-1 text-[12.5px] text-ink-3">{summaryIsMachine ? "Подготовлено автоматически по тексту письма. Если отредактируете, текст сохранится как ручной и не будет перезаписан." : "Текст сохранится как ручной и не будет перезаписан автообработкой."}</p>
      </div>

      <Field label="Язык обращения" error={!lang ? (defaults.langMixed ? "Язык не определён: в тексте смешаны русский и казахский — выберите" : "Язык не определён — выберите") : null} hint="Определяет язык поручения и письма в РКА.">
        <Select value={lang} onChange={(e) => setLang(e.target.value as Lang | "")} required disabled={pending}>
          <option value="">Выберите язык</option>
          {(Object.keys(LANG_LABEL) as Lang[]).map((l) => (
            <option key={l} value={l}>
              {LANG_LABEL[l]}
            </option>
          ))}
        </Select>
      </Field>

      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Сохраняем…" : "Зарегистрировать обращение"}
        </Button>
        <span className="text-[12.5px] text-ink-3">Будет присвоен следующий номер дела в году поступления.</span>
      </div>
    </form>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "rounded border px-2 py-0.5 text-[12.5px] transition-colors",
        active ? "border-petrol bg-petrol-50 text-petrol" : "border-line-strong bg-surface text-ink-2 hover:bg-sunken",
      )}
    >
      {children}
    </button>
  );
}
