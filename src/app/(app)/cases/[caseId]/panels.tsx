"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveAssignmentAction,
  approveFinalAction,
  approvePackageAction,
  assignExecutorAction,
  chooseFinalRouteAction,
  closeVotingAction,
  editAssignmentLetterAction,
  openVotingAction,
  preapproveAction,
  preparePdfAction,
  prepareRkaPackageAction,
  rejectAssignmentAction,
  rejectPackageAction,
  resolveUnknownSendAction,
  resubmitAssignmentAction,
  updateCaseFieldsAction,
  updatePackageFilesAction,
  type ActionResult,
} from "@/app/actions";
import { resumeSigningAction, signingStatusAction, startSigexAuthAction, startSigningAction } from "./sign-actions";
import { Badge, Button, Field, Hash, Input, Notice, Section, Select, Textarea } from "@/components/ui";

/* Общий помощник: выполнить действие, показать ошибку, обновить данные. */
function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown> | { ok: boolean; error?: string }>, onOk?: () => void) =>
    start(async () => {
      setError(null);
      try {
        const r = await fn();
        if (!r.ok) setError((r as { error?: string }).error ?? "Действие не выполнено");
        else {
          onOk?.();
          router.refresh();
        }
      } catch {
        setError("Не удалось выполнить действие: нет связи с сервером. Повторите.");
      }
    });
  return { pending, error, run, setError };
}

const useKey = () => useMemo(() => crypto.randomUUID(), []);

function Err({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-3 rounded-md bg-bad-50 px-3 py-2 text-[13.5px] text-bad">
      {error}
    </p>
  ) : null;
}

function addDays(n: number) {
  const d = new Date(Date.now() + n * 86400_000);
  return d.toISOString().slice(0, 10);
}

/* ───────── Назначение исполнителя (ACL-03, FLOW-01) ───────── */

export function AssignForm({ caseId, lang, blocked, members }: { caseId: string; lang: "ru" | "kk" | null; blocked: boolean; members: { id: string; name: string; ready: boolean }[] }) {
  const { pending, error, run } = useAction();
  const key = useKey();
  const [executorId, setExecutor] = useState("");
  const [deadline, setDeadline] = useState(addDays(14));
  const [task, setTask] = useState("изучить материалы обращения и подготовить проект заключения Комиссии");
  const [l, setL] = useState<"ru" | "kk" | "">(lang ?? "");
  const sel = members.find((m) => m.id === executorId);
  return (
    <Section title="Назначить исполнителя">
      {blocked && <Notice tone="bad" title="Назначение заблокировано: поступление не завершено">Сначала дождитесь загрузки всех вложений или исключите недоступные с основанием.</Notice>}
      <p className="mb-4 text-[13.5px] text-ink-3">
        После назначения исполнитель сразу получит доступ только к рабочей области этого дела, а платформа подготовит черновик поручения. Письмо уйдёт лишь после того, как вы утвердите его текст.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Исполнитель из состава комиссии" error={sel && !sel.ready ? "В профиле не подтверждено обращение по имени и отчеству" : null}>
          <Select value={executorId} onChange={(e) => setExecutor(e.target.value)} disabled={blocked}>
            <option value="">Выберите участника</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.ready ? "" : " (нет обращения)"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Срок">
          <Input type="date" value={deadline} min={addDays(0)} onChange={(e) => setDeadline(e.target.value)} disabled={blocked} />
        </Field>
        <Field label="Язык поручения" hint={lang ? "По языку исходного обращения" : "Язык обращения не определён автоматически"}>
          <Select value={l} onChange={(e) => setL(e.target.value as "ru" | "kk")} disabled={blocked}>
            <option value="">Выберите язык</option>
            <option value="ru">Русский</option>
            <option value="kk">Қазақша</option>
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Предмет поручения" hint="Вставляется в текст письма после слов «Вам поручается»">
            <Textarea rows={2} value={task} onChange={(e) => setTask(e.target.value)} disabled={blocked} />
          </Field>
        </div>
      </div>
      <Err error={error} />
      <div className="mt-4">
        <Button disabled={blocked || pending || !executorId || !l || !deadline} onClick={() => run(() => assignExecutorAction({ caseId, executorId, deadline, task, lang: l || null, idempotencyKey: key }))}>
          {pending ? "Назначаем и проверяем доступ…" : "Назначить и подготовить поручение"}
        </Button>
      </div>
    </Section>
  );
}

/* ───────── Утверждение поручения (BR-04, FLOW-10, OUT-04) ───────── */

export function AssignmentReview({ caseId, assignment: a }: { caseId: string; assignment: { id: string; version: number; subject: string; text: string; hash: string; to: string; lang: string; deadline: string; link: string; materials: number } }) {
  const { pending, error, run } = useAction();
  const key = useKey();
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(a.subject);
  const [text, setText] = useState(a.text);
  const [reject, setReject] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-seal/40 bg-seal-50/40 p-4">
      <p className="text-[14px] font-semibold text-ink">Проверьте письмо перед отправкой</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13.5px] sm:grid-cols-2">
        <div><dt className="text-ink-3">Кому</dt><dd className="text-ink">{a.to} (без копий другим членам)</dd></div>
        <div><dt className="text-ink-3">Язык</dt><dd className="text-ink">{a.lang === "kk" ? "Қазақша" : "Русский"}</dd></div>
        <div><dt className="text-ink-3">Срок</dt><dd className="text-ink tnum">{new Date(`${a.deadline}T00:00:00+05:00`).toLocaleDateString("ru-RU")}</dd></div>
        <div><dt className="text-ink-3">Ссылка на рабочую область</dt><dd className="truncate text-ink">{a.link}</dd></div>
        <div><dt className="text-ink-3">Материалов в рабочей области</dt><dd className="text-ink tnum">{a.materials}</dd></div>
        <div><dt className="text-ink-3">Версия текста</dt><dd><Hash value={a.hash} /></dd></div>
      </dl>
      {editing ? (
        <div className="mt-4 space-y-3">
          <Field label="Тема"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="Текст письма"><Textarea rows={16} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => run(() => editAssignmentLetterAction({ assignmentId: a.id, expectedVersion: a.version, subject, text, caseId }), () => setEditing(false))}>
              {pending ? "Сохраняем…" : "Сохранить текст"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Отменить правку</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-line bg-surface p-4">
          <p className="text-[13.5px] font-medium text-ink">{a.subject}</p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink-2">{a.text}</pre>
        </div>
      )}
      <Err error={error} />
      {reject !== null ? (
        <div className="mt-4 space-y-2">
          <Field label="Причина отклонения"><Textarea rows={2} value={reject} onChange={(e) => setReject(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button variant="danger" disabled={pending || reject.trim().length < 3} onClick={() => run(() => rejectAssignmentAction({ assignmentId: a.id, reason: reject, caseId }), () => setReject(null))}>Отклонить черновик</Button>
            <Button variant="ghost" onClick={() => setReject(null)}>Не отклонять</Button>
          </div>
        </div>
      ) : (
        !editing && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="seal" disabled={pending} onClick={() => run(() => approveAssignmentAction({ assignmentId: a.id, shownHash: a.hash, idempotencyKey: key, caseId }))}>
              {pending ? "Утверждаем и отправляем…" : "Утвердить поручение и отправить"}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>Изменить текст</Button>
            <Button variant="ghost" onClick={() => setReject("")}>Отклонить</Button>
          </div>
        )
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">Согласие относится только к этой версии. Изменение текста, адресата, срока или состава материалов потребует повторного утверждения.</p>
    </div>
  );
}

export function ResubmitButton({ caseId, assignmentId }: { caseId: string; assignmentId: string }) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => resubmitAssignmentAction({ assignmentId, caseId }))}>Вернуть на утверждение</Button>
      <Err error={error} />
    </>
  );
}

/* ───────── Поля D, F и язык (CASE-07) ───────── */

export function CaseFieldsEditor(p: { caseId: string; version: number; collegium: string | null; collegiumCandidates: string[]; collegiumSource: string | null; summary: string | null; summarySource: string | null; summaryMachine: boolean; lang: "ru" | "kk" | null }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [collegium, setCollegium] = useState(p.collegium ?? "");
  const [summary, setSummary] = useState(p.summary ?? "");
  const [lang, setLang] = useState(p.lang ?? "");
  return (
    <Section
      title="Коллегия и краткое содержание"
      aside={!open && <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Исправить</Button>}
    >
      {!open ? (
        <dl className="space-y-3 text-[14px]">
          <div>
            <dt className="text-[12.5px] text-ink-3">D. Регион / коллегия</dt>
            <dd className="text-ink">{p.collegium ?? <Badge tone="warn">Требует проверки{p.collegiumCandidates.length ? `: ${p.collegiumCandidates.join("; ")}` : ""}</Badge>}</dd>
            {p.collegiumSource && <dd className="text-[12px] text-ink-4">{p.collegiumSource}</dd>}
          </div>
          <div>
            <dt className="text-[12.5px] text-ink-3">F. Краткое содержание {p.summaryMachine && <Badge className="ml-1">машинный проект</Badge>}</dt>
            <dd className="text-ink">{p.summary ?? "—"}</dd>
            {p.summarySource && <dd className="text-[12px] text-ink-4">{p.summarySource}</dd>}
          </div>
        </dl>
      ) : (
        <div className="space-y-4">
          <Field label="Регион / коллегия заявителя" hint="Город в подписи письма РКА не является коллегией заявителя">
            <Input value={collegium} onChange={(e) => setCollegium(e.target.value)} />
          </Field>
          {p.collegiumCandidates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {p.collegiumCandidates.map((c) => (
                <button key={c} type="button" onClick={() => setCollegium(c)} className="rounded border border-line px-2 py-1 text-[12.5px] text-ink-2 hover:border-petrol">
                  {c}
                </button>
              ))}
            </div>
          )}
          <Field label="Краткое содержание"><Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
          <Field label="Язык обращения" hint="Определяет язык поручения и сопроводительного письма">
            <Select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="">Не определён</option>
              <option value="ru">Русский</option>
              <option value="kk">Қазақша</option>
            </Select>
          </Field>
          <Err error={error} />
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    updateCaseFieldsAction({
                      caseId: p.caseId,
                      expectedVersion: p.version,
                      ...(collegium !== (p.collegium ?? "") ? { collegium: collegium || null } : {}),
                      ...(summary !== (p.summary ?? "") ? { summary: summary || null } : {}),
                      ...(lang !== (p.lang ?? "") ? { lang: (lang || null) as "ru" | "kk" | null } : {}),
                    }),
                  () => setOpen(false),
                )
              }
            >
              {pending ? "Сохраняем…" : "Сохранить"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Отменить</Button>
          </div>
          <p className="text-[12.5px] text-ink-3">Ручные правки сохраняются и не перезаписываются автоматической обработкой.</p>
        </div>
      )}
    </Section>
  );
}

/* ───────── Предварительная проверка проекта (FLOW-04) ───────── */

export function PreapprovePanel({ caseId, cycleId, version, drafts }: { caseId: string; cycleId: string; version: number; drafts: { id: string; name: string; at: string; sha: string }[] }) {
  const { pending, error, run } = useAction();
  const [draft, setDraft] = useState(drafts[drafts.length - 1]?.id ?? "");
  const [remarks, setRemarks] = useState("");
  const [mode, setMode] = useState<"approve" | "rework">("approve");
  return (
    <Section title="Предварительная проверка проекта">
      <p className="mb-3 text-[13.5px] text-ink-3">До вашего одобрения члены комиссии не получают доступ к проекту.</p>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium text-ink-2">Версия проекта</legend>
        {drafts.map((d) => (
          <label key={d.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-[13.5px] has-[:checked]:border-petrol has-[:checked]:bg-petrol-50">
            <input type="radio" name="draft" value={d.id} checked={draft === d.id} onChange={() => setDraft(d.id)} />
            <a href={`/api/files/${d.id}`} className="text-petrol hover:underline">{d.name}</a>
            <span className="text-ink-3 tnum">{new Date(d.at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "short", timeStyle: "short" })}</span>
            <Hash value={d.sha} />
          </label>
        ))}
      </fieldset>
      <div className="mt-4 flex gap-4 text-[13.5px]">
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "approve"} onChange={() => setMode("approve")} /> Одобрить для обсуждения</label>
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "rework"} onChange={() => setMode("rework")} /> Вернуть исполнителю</label>
      </div>
      {mode === "rework" && (
        <div className="mt-3"><Field label="Замечания (в том числе устные)"><Textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>
      )}
      <Err error={error} />
      <div className="mt-4">
        <Button variant={mode === "approve" ? "seal" : "secondary"} disabled={pending || !draft} onClick={() => run(() => preapproveAction({ caseId, cycleId, draftVersionId: draft, decision: mode, remarks, expectedVersion: version }))}>
          {pending ? "Сохраняем…" : mode === "approve" ? "Предварительно одобрить" : "Зафиксировать замечания"}
        </Button>
      </div>
    </Section>
  );
}

/* ───────── Обсуждение и голосование (FLOW-05) ───────── */

export function OpenVotingForm({ caseId, cycleId, version, materials }: { caseId: string; cycleId: string; version: number; materials: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [closes, setCloses] = useState(() => {
    const d = new Date(Date.now() + 3 * 86400_000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [picked, setPicked] = useState<string[]>(materials.map((m) => m.id));
  return (
    <Section title="Открыть обсуждение и голосование">
      <p className="mb-4 text-[13.5px] text-ink-3">Будут зафиксированы версия проекта, выбранные материалы и состав комиссии на сегодня. Члены получат доступ только к папке этого обсуждения, корень дела им не откроется.</p>
      <Field label="Окончание голосования"><Input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
      {materials.length > 0 && (
        <fieldset className="mt-4 space-y-1.5">
          <legend className="mb-1 text-[13px] font-medium text-ink-2">Материалы для ознакомления</legend>
          {materials.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-[13.5px]">
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
              {m.name}
            </label>
          ))}
        </fieldset>
      )}
      <Err error={error} />
      <div className="mt-4">
        <Button disabled={pending} onClick={() => run(() => openVotingAction({ caseId, cycleId, closesAt: new Date(closes).toISOString(), materialVersionIds: picked, expectedVersion: version }))}>
          {pending ? "Открываем…" : "Открыть голосование"}
        </Button>
      </div>
    </Section>
  );
}

export function ClosePanel({ caseId, cycleId, version, closesAt }: { caseId: string; cycleId: string; version: number; closesAt: string | null }) {
  const { pending, error, run } = useAction();
  const early = !!closesAt && new Date(closesAt).getTime() > Date.now();
  const [basis, setBasis] = useState("");
  return (
    <Section title="Голосование идёт">
      <p className="text-[13.5px] text-ink-3">После закрытия платформа сформирует протокол в этом деле по зафиксированным правилам кворума и решения.</p>
      {early && <div className="mt-3"><Field label="Основание досрочного закрытия" hint={`Срок голосования — ${new Date(closesAt!).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}`}><Input value={basis} onChange={(e) => setBasis(e.target.value)} /></Field></div>}
      <Err error={error} />
      <div className="mt-4">
        <Button disabled={pending || (early && basis.trim().length < 5)} onClick={() => run(() => closeVotingAction({ caseId, cycleId, earlyBasis: basis, expectedVersion: version }))}>
          {pending ? "Формируем протокол…" : early ? "Закрыть досрочно и сформировать протокол" : "Закрыть и сформировать протокол"}
        </Button>
      </div>
    </Section>
  );
}

/* ───────── Финализация (FLOW-08, FLOW-14) ───────── */

export function FinalRoutePanel({ caseId, cycleId, version }: { caseId: string; cycleId: string; version: number }) {
  const { pending, error, run } = useAction();
  const [route, setRoute] = useState<"as_is" | "rework">("as_is");
  const [remarks, setRemarks] = useState("");
  return (
    <Section title="Окончательная редакция">
      <fieldset className="space-y-2">
        <legend className="sr-only">Маршрут</legend>
        <label className="flex items-start gap-3 rounded-md border border-line p-3 has-[:checked]:border-petrol has-[:checked]:bg-petrol-50">
          <input type="radio" className="mt-1" checked={route === "as_is"} onChange={() => setRoute("as_is")} />
          <span><span className="block text-[14px] font-medium text-ink">Принять проголосованный проект без изменений</span><span className="text-[13px] text-ink-3">Используется та же версия; повторно присылать файл не нужно.</span></span>
        </label>
        <label className="flex items-start gap-3 rounded-md border border-line p-3 has-[:checked]:border-petrol has-[:checked]:bg-petrol-50">
          <input type="radio" className="mt-1" checked={route === "rework"} onChange={() => setRoute("rework")} />
          <span><span className="block text-[14px] font-medium text-ink">Запросить доработку</span><span className="text-[13px] text-ink-3">Исполнитель пришлёт окончательную редакцию на почту комиссии.</span></span>
        </label>
      </fieldset>
      {route === "rework" && <div className="mt-3"><Field label="Замечания, включая устные и телефонные"><Textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>}
      <Err error={error} />
      <div className="mt-4"><Button disabled={pending} onClick={() => run(() => chooseFinalRouteAction({ caseId, cycleId, route, remarks, expectedVersion: version }))}>{pending ? "Сохраняем…" : "Подтвердить маршрут"}</Button></div>
    </Section>
  );
}

export function ApproveFinalPanel({ caseId, cycleId, version, route, finalVersion, votedVersionId }: { caseId: string; cycleId: string; version: number; route: "as_is" | "rework"; finalVersion: { id: string; name: string; sha: string } | null; votedVersionId: string | null }) {
  const { pending, error, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <Section title="Утвердить окончательную редакцию">
      {finalVersion ? (
        <p className="text-[13.5px] text-ink-2">
          Окончательная редакция: <a className="text-petrol hover:underline" href={`/api/files/${finalVersion.id}`}>{finalVersion.name}</a> <Hash value={finalVersion.sha} />
        </p>
      ) : (
        <p className="text-[13.5px] text-bad">Окончательная редакция не найдена</p>
      )}
      {route === "rework" && votedVersionId && (
        <>
          <p className="mt-2 text-[13.5px] text-ink-3">
            Сравните с <a className="text-petrol hover:underline" href={`/api/files/${votedVersionId}`}>проголосованной версией</a>. Одобрение старой версии не переносится на новую без вашей проверки.
          </p>
          <div className="mt-3"><Field label="Как учтены замечания"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        </>
      )}
      <Err error={error} />
      <div className="mt-4">
        <Button variant="seal" disabled={pending || !finalVersion} onClick={() => run(() => approveFinalAction({ caseId, cycleId, versionId: finalVersion!.id, conformityNote: note, expectedVersion: version }))}>
          {pending ? "Утверждаем…" : "Утвердить окончательную редакцию"}
        </Button>
      </div>
    </Section>
  );
}

export function PreparePdfPanel({ caseId, cycleId, version }: { caseId: string; cycleId: string; version: number }) {
  const { pending, error, run } = useAction();
  return (
    <Section title="Подготовить PDF для подписи">
      <p className="text-[13.5px] text-ink-3">Платформа зафиксирует сведения для карточки проверки, поставит постоянный QR в конце заключения и сформирует PDF. После подписи байты PDF не меняются.</p>
      <Err error={error} />
      <div className="mt-4"><Button disabled={pending} onClick={() => run(() => preparePdfAction({ caseId, cycleId, expectedVersion: version }))}>{pending ? "Формируем PDF…" : "Сформировать PDF с QR"}</Button></div>
    </Section>
  );
}

/* ───────── Личная ЭЦП (SIGN-01..04) ───────── */

type AuthStatus = { state: string; qrCodeDataUrl: string | null; mobileLink: string | null; businessLink: string | null; expireAt: string | null; error: string | null };
type SignStatus = { state: string; label?: string; qrCodeDataUrl?: string | null; mobileLink?: string | null; businessLink?: string | null; expireAt?: string | null; error?: string | null; auth?: AuthStatus | null };

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" });

export function SignPanel({ caseId, versionId, lastSession }: { caseId: string; versionId: string; lastSession: { id: string; state: string } | null }) {
  const router = useRouter();
  const { pending, error, run, setError } = useAction();
  const key = useKey();
  const [session, setSession] = useState<string | null>(lastSession && ["created", "data_submitted", "waiting", "signature_saved", "registered", "auth_required", "needs_reconcile"].includes(lastSession.state) ? lastSession.id : null);
  const [status, setStatus] = useState<SignStatus | null>(null);

  useEffect(() => {
    if (!session) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = (await signingStatusAction({ sessionId: session })) as { ok: boolean; data?: SignStatus; error?: string };
        if (stop) return;
        if (r.ok && r.data) {
          setStatus(r.data);
          if (["verified", "expired", "refused", "error"].includes(r.data.state)) {
            router.refresh();
            return;
          }
        }
      } catch {
        /* сеть — продолжаем опрос; подпись получает фоновый процесс независимо от вкладки */
      }
      if (!stop) setTimeout(tick, 3000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [session, router]);

  const start = () =>
    run(async () => {
      const r = await startSigningAction({ documentVersionId: versionId, idempotencyKey: key, caseId });
      if (r.ok) {
        const data = r.data as unknown as { sessionId: string } & SignStatus;
        setSession(data.sessionId);
        setStatus({ ...data, state: "waiting" });
      }
      return r;
    });

  return (
    <Section title="Личная ЭЦП председателя">
      <p className="text-[13.5px] text-ink-3">
        Подпись ставится в eGov Mobile или eGov Business. Закрытый ключ и пароль платформа не получает. Результат принимает фоновый процесс: вкладку можно закрыть, повторно подписывать не придётся.
      </p>
      {!session && (
        <>
          <Err error={error} />
          <div className="mt-4">
            <Button variant="seal" disabled={pending} onClick={start}>{pending ? "Создаём сеанс…" : "Подписать ЭЦП"}</Button>
          </div>
        </>
      )}
      {session && status && (
        <div className="mt-4 grid gap-5 sm:grid-cols-[200px_1fr]">
          {status.qrCodeDataUrl && ["waiting", "data_submitted", "created"].includes(status.state) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={status.qrCodeDataUrl} alt="QR-код сеанса подписания eGov. Отсканируйте в приложении eGov Mobile." className="size-[200px] rounded-md border border-line bg-white p-2" />
          ) : (
            <div className="flex size-[200px] items-center justify-center rounded-md border border-line bg-sunken text-center text-[13px] text-ink-3">{status.label ?? status.state}</div>
          )}
          <div className="space-y-3 text-[13.5px]">
            <p>
              <Badge tone={status.state === "verified" ? "seal" : ["error", "expired", "refused", "auth_required", "needs_reconcile"].includes(status.state) ? "bad" : "petrol"}>{status.label ?? status.state}</Badge>
            </p>
            {["waiting", "data_submitted", "created"].includes(status.state) && (
              <>
                <p className="text-ink-2">Отсканируйте этот временный QR в eGov Mobile. Это не постоянный QR проверки, он действует только для сеанса{status.expireAt ? ` до ${new Date(status.expireAt).toLocaleTimeString("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" })}` : ""}.</p>
                <div className="flex flex-wrap gap-2">
                  {status.mobileLink && <a className="rounded-md border border-line-strong px-3 py-1.5 text-petrol hover:bg-sunken" href={status.mobileLink}>Открыть в eGov Mobile</a>}
                  {status.businessLink && <a className="rounded-md border border-line-strong px-3 py-1.5 text-petrol hover:bg-sunken" href={status.businessLink}>Открыть в eGov Business</a>}
                </div>
              </>
            )}
            {status.state === "auth_required" && (
              <SigexAuthStep
                auth={status.auth ?? null}
                pending={pending}
                onStart={() =>
                  run(async () => {
                    const r = await startSigexAuthAction({ sessionId: session, caseId });
                    if (r.ok) setStatus((prev) => (prev ? { ...prev, auth: r.data } : prev));
                    return r;
                  })
                }
              />
            )}
            {status.state === "needs_reconcile" && (
              <>
                <p className="text-ink-2">Подпись уже получена и сохранена. Нужно завершить регистрацию и проверку у поставщика подписи, повторно подписывать не нужно.</p>
                <Button variant="secondary" disabled={pending} onClick={() => run(() => resumeSigningAction({ sessionId: session, caseId }))}>Продолжить проверку</Button>
              </>
            )}
            {["expired", "refused", "error"].includes(status.state) && (
              <Button variant="seal" disabled={pending} onClick={() => { setSession(null); setStatus(null); setError(null); }}>Начать новый сеанс</Button>
            )}
            {status.error && <p className="text-bad">{status.error}</p>}
            <Err error={error} />
          </div>
        </div>
      )}
    </Section>
  );
}

/** Вход в SIGEX от имени председателя: временный QR eGov только для входа (SIGN-06). */
function SigexAuthStep({ auth, pending, onStart }: { auth: AuthStatus | null; pending: boolean; onStart: () => void }) {
  const active = !!auth && (auth.state === "created" || auth.state === "waiting");
  const processing = !!auth && (auth.state === "signed" || auth.state === "used");
  return (
    <div className="space-y-3">
      <p className="text-ink-2">Подпись уже сохранена. Отсканируйте QR, чтобы платформа зарегистрировала её в SIGEX от вашего имени. Повторно подписывать заключение не нужно.</p>
      {active && auth?.qrCodeDataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={auth.qrCodeDataUrl} alt="QR-код входа в SIGEX. Отсканируйте в приложении eGov Mobile." className="size-[180px] rounded-md border border-line bg-white p-2" />
      )}
      {active && (
        <>
          <p className="text-[13px] text-ink-3">Временный QR только для входа{auth?.expireAt ? `, действует до ${hhmm(auth.expireAt)}` : ""}.</p>
          <div className="flex flex-wrap gap-2">
            {auth?.mobileLink && <a className="rounded-md border border-line-strong px-3 py-1.5 text-petrol hover:bg-sunken" href={auth.mobileLink}>Открыть в eGov Mobile</a>}
            {auth?.businessLink && <a className="rounded-md border border-line-strong px-3 py-1.5 text-petrol hover:bg-sunken" href={auth.businessLink}>Открыть в eGov Business</a>}
          </div>
        </>
      )}
      {processing && <p className="text-[13px] text-ink-2">Вход подтверждён. Платформа регистрирует и проверяет подпись.</p>}
      {auth && ["expired", "refused", "error"].includes(auth.state) && (
        <p className="text-[13px] text-bad">{auth.state === "expired" ? "Срок QR для входа истёк." : auth.state === "refused" ? "Вход отменён в eGov." : auth.error ?? "Вход не выполнен."} Запросите новый QR.</p>
      )}
      {!active && !processing && (
        <Button variant="seal" disabled={pending} onClick={onStart}>{pending ? "Готовим QR…" : "Подтвердить вход в SIGEX"}</Button>
      )}
    </div>
  );
}

/* ───────── Комплект в РКА (DOC-07, DOC-10, OUT-11) ───────── */

export function PreparePackageForm({ caseId, cycleId, lang, langMismatch, suggestions }: { caseId: string; cycleId: string; lang: "ru" | "kk" | null; langMismatch: boolean; suggestions: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const key = useKey();
  const [l, setL] = useState<"ru" | "kk" | "">(lang ?? "");
  const [picked, setPicked] = useState<string[]>(suggestions.map((s) => s.id));
  const [purpose, setPurpose] = useState("");
  return (
    <Section title="Подготовить комплект в РКА">
      <p className="mb-4 text-[13.5px] text-ink-3">Платформа зарезервирует исходящий номер, сформирует сопроводительное письмо в Word и опись. Отправка — только после вашего согласия на весь комплект.</p>
      {langMismatch && <div className="mb-4"><Notice tone="warn" title="Язык заключения отличается от языка обращения">Сопроводительное письмо по правилу готовится на языке обращения. Выберите язык явно.</Notice></div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Язык сопроводительного письма">
          <Select value={l} onChange={(e) => setL(e.target.value as "ru" | "kk")}>
            <option value="">Выберите язык</option>
            <option value="ru">Русский</option>
            <option value="kk">Қазақша</option>
          </Select>
        </Field>
        <Field label="Назначение отправки" hint="Необязательно; по умолчанию стандартная формулировка">
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
      </div>
      <fieldset className="mt-4 space-y-1.5">
        <legend className="mb-1 text-[13px] font-medium text-ink-2">Приложения исполнителя (Word)</legend>
        {suggestions.length === 0 && <p className="text-[13px] text-ink-3">Связанных проектов в формате Word нет — это не мешает отправке.</p>}
        {suggestions.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
            {s.name}
          </label>
        ))}
      </fieldset>
      <Err error={error} />
      <div className="mt-4"><Button disabled={pending || !l} onClick={() => run(() => prepareRkaPackageAction({ caseId, cycleId, includeDraftVersionIds: picked, lang: l || null, purpose, idempotencyKey: key }))}>{pending ? "Готовим комплект…" : "Подготовить комплект"}</Button></div>
    </Section>
  );
}

export function PackagePanel({ caseId, outgoing: o, draftOptions, included, langMismatch }: { caseId: string; outgoing: { id: string; version: number; hash: string; subject: string; body: string; to: string[]; from: string; lang: string; number: string }; draftOptions: { id: string; name: string }[]; included: string[]; langMismatch: boolean }) {
  const { pending, error, run } = useAction();
  const key = useKey();
  const [picked, setPicked] = useState<string[]>(included);
  const [reject, setReject] = useState<string | null>(null);
  const changed = picked.length !== included.length || picked.some((x) => !included.includes(x));
  return (
    <div className="rounded-lg border border-seal/40 bg-seal-50/40 p-4">
      <p className="text-[14px] font-semibold text-ink">Проверьте комплект перед направлением в РКА</p>
      {langMismatch && <p className="mt-1 text-[13px] text-warn">Язык заключения отличается от языка обращения; письмо подготовлено на языке обращения.</p>}
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13.5px] sm:grid-cols-2">
        <div><dt className="text-ink-3">От</dt><dd>{o.from}</dd></div>
        <div><dt className="text-ink-3">Кому</dt><dd>{o.to.join(", ")}</dd></div>
        <div><dt className="text-ink-3">Исходящий номер</dt><dd className="doc-number">{o.number}</dd></div>
        <div><dt className="text-ink-3">Версия комплекта</dt><dd><Hash value={o.hash} /></dd></div>
      </dl>
      <div className="mt-4 rounded-md border border-line bg-surface p-4">
        <p className="text-[13.5px] font-medium text-ink">{o.subject}</p>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink-2">{o.body}</pre>
      </div>
      {draftOptions.length > 0 && (
        <fieldset className="mt-4 space-y-1.5">
          <legend className="mb-1 text-[13px] font-medium text-ink-2">Приложения исполнителя</legend>
          {draftOptions.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-[13.5px]">
              <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
              {s.name}
            </label>
          ))}
          {changed && <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => updatePackageFilesAction({ caseId, outgoingId: o.id, includeDraftVersionIds: picked, expectedVersion: o.version }))}>Обновить опись</Button>}
        </fieldset>
      )}
      <Err error={error} />
      {reject !== null ? (
        <div className="mt-4 space-y-2">
          <Field label="Причина"><Textarea rows={2} value={reject} onChange={(e) => setReject(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button variant="danger" disabled={pending || reject.trim().length < 3} onClick={() => run(() => rejectPackageAction({ caseId, outgoingId: o.id, reason: reject }), () => setReject(null))}>Отклонить комплект</Button>
            <Button variant="ghost" onClick={() => setReject(null)}>Не отклонять</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="seal" disabled={pending || changed} onClick={() => run(() => approvePackageAction({ caseId, outgoingId: o.id, shownHash: o.hash, idempotencyKey: key }))}>
            {pending ? "Согласуем и направляем…" : "Согласовать комплект и направить в РКА"}
          </Button>
          <Button variant="ghost" onClick={() => setReject("")}>Отклонить</Button>
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">Согласие относится к этой версии комплекта. Изменение адресата, текста или файлов потребует повторного согласия. CMS и служебные журналы в письмо не входят.</p>
    </div>
  );
}

/* ───────── Неизвестный результат отправки (OUT-06) ───────── */

export function UnknownSendPanel({ caseId, outgoingId, needsDecision }: { caseId: string; outgoingId: string; needsDecision: boolean }) {
  const { pending, error, run } = useAction();
  const [basis, setBasis] = useState("");
  if (!needsDecision) return <p className="mt-3 text-[13px] text-ink-3">Идёт автоматическая сверка с папкой «Отправленные». Повторная отправка не выполняется.</p>;
  return (
    <div className="mt-4 rounded-md border border-bad/30 bg-bad-50/50 p-4">
      <p className="text-[14px] font-medium text-ink">Две сверки не нашли письмо в «Отправленных»</p>
      <p className="mt-1 text-[13.5px] text-ink-2">Откройте ящик комиссии и проверьте папку «Отправленные». Отсутствие письма в поиске ещё не доказывает, что оно не ушло.</p>
      <div className="mt-3"><Field label="Что показала проверка"><Input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="Например: письма от 21.10 в «Отправленных» нет" /></Field></div>
      <Err error={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={pending || basis.trim().length < 5} onClick={() => run(() => resolveUnknownSendAction({ caseId, outgoingId, decision: "confirm_sent", basis }))}>Письмо найдено — отметить отправленным</Button>
        <Button disabled={pending || basis.trim().length < 5} onClick={() => run(() => resolveUnknownSendAction({ caseId, outgoingId, decision: "resend", basis }))}>Письма нет — отправить повторно</Button>
      </div>
    </div>
  );
}
