"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Notice } from "@/components/ui";
import type { OrgRole } from "@/domain/types";
import { saveMemberAction } from "../actions";

const ROLES: { value: OrgRole; label: string; hint: string }[] = [
  { value: "member", label: "Член комиссии", hint: "Входит в состав, голосует, может быть исполнителем" },
  { value: "chair", label: "Председатель", hint: "Назначает исполнителей, утверждает, подписывает ЭЦП" },
  { value: "secretary", label: "Секретарь", hint: "Регистрация, переписка, сроки, реестр" },
  { value: "outgoing_registrar", label: "Регистратор исходящих", hint: "Номера и черновики исходящих" },
  { value: "auditor", label: "Аудитор", hint: "Журнал событий и отчёты" },
  { value: "tech_admin", label: "Технический администратор", hint: "Подключения и настройки, без доступа к содержимому дел" },
];

export interface MemberValues {
  id?: string;
  fullName: string;
  fullNameKk: string;
  firstName: string;
  patronymic: string;
  addressKk: string;
  email: string;
  emailVerified: boolean;
  collegium: string;
  roles: OrgRole[];
  status: "active" | "inactive";
}

export const EMPTY_MEMBER: MemberValues = { fullName: "", fullNameKk: "", firstName: "", patronymic: "", addressKk: "", email: "", emailVerified: false, collegium: "", roles: ["member"], status: "active" };

export function MemberForm({ initial, closeHref }: { initial: MemberValues; closeHref: string }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [confirmVerified, setConfirmVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const isNew = !initial.id;
  const emailChanged = !isNew && v.email.trim().toLowerCase() !== initial.email.trim().toLowerCase();
  const uid = initial.id ?? "new";

  const set = <K extends keyof MemberValues>(k: K, val: MemberValues[K]) => {
    setNotice(null);
    setV((p) => ({ ...p, [k]: val }));
  };
  const toggleRole = (r: OrgRole) => set("roles", v.roles.includes(r) ? v.roles.filter((x) => x !== r) : [...v.roles, r]);

  // Подсказка: разложить ФИО на имя и отчество, если поля обращения пусты.
  function suggestFromFullName() {
    const parts = v.fullName.trim().split(/\s+/);
    if (parts.length >= 2) setV((p) => ({ ...p, firstName: p.firstName || parts[1] || "", patronymic: p.patronymic || parts.slice(2).join(" ") }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!v.firstName.trim()) {
      setError("Укажите имя для обращения. Без него нельзя сформировать поручение исполнителю.");
      return;
    }
    if (v.roles.length === 0) {
      setError("Выберите хотя бы одну роль.");
      return;
    }
    start(async () => {
      const r = await saveMemberAction({
        id: v.id,
        fullName: v.fullName,
        fullNameKk: v.fullNameKk || null,
        firstName: v.firstName,
        patronymic: v.patronymic || null,
        addressKk: v.addressKk || null,
        email: v.email,
        emailVerified: v.emailVerified,
        confirmVerifiedEmail: emailChanged ? confirmVerified : undefined,
        collegium: v.collegium || null,
        roles: v.roles,
        status: v.status,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const data = r.data as { emailReset?: boolean } | undefined;
      if (data?.emailReset) {
        setV((p) => ({ ...p, emailVerified: false }));
        setNotice("Сохранено. Адрес изменён, поэтому отметка о подтверждении снята: участник подтвердит его при первом входе.");
        router.refresh();
        return;
      }
      router.push(closeHref);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="ФИО полностью (русский)" hint="Фамилия, имя, отчество, как в документах">
            <Input required value={v.fullName} onChange={(e) => set("fullName", e.target.value)} onBlur={suggestFromFullName} autoComplete="off" />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="ФИО полностью (казахский)" hint="Если отличается написание">
            <Input lang="kk" value={v.fullNameKk} onChange={(e) => set("fullNameKk", e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </div>

      <fieldset className="rounded-md border border-line px-4 py-3">
        <legend className="px-1 text-[13px] font-medium text-ink-2">Подтверждённое обращение в письмах</legend>
        <p className="mb-3 text-[12.5px] text-ink-3">Берётся в поручения дословно. Не восстанавливается из инициалов, поэтому проверьте написание с самим участником.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Имя">
            <Input required value={v.firstName} onChange={(e) => set("firstName", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Отчество" hint="Если есть">
            <Input value={v.patronymic} onChange={(e) => set("patronymic", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Обращение на казахском" hint="Например, «Айгүл Серікқызы»">
            <Input lang="kk" value={v.addressKk} onChange={(e) => set("addressKk", e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Электронная почта" hint="Один адрес — один человек. По нему выполняется вход и отправка поручений">
          <Input type="email" required value={v.email} onChange={(e) => set("email", e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Коллегия адвокатов">
          <Input value={v.collegium} onChange={(e) => set("collegium", e.target.value)} autoComplete="off" />
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2.5 text-[14px] text-ink">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--color-petrol)]" checked={v.emailVerified} onChange={(e) => set("emailVerified", e.target.checked)} />
          <span>
            Адрес подтверждён
            <span className="block text-[12.5px] text-ink-3">Отмечайте только если участник подтвердил, что это его адрес. При входе по коду отметка ставится автоматически.</span>
          </span>
        </label>
        {emailChanged && v.emailVerified && (
          <label className="ml-6 flex items-start gap-2.5 rounded-md bg-warn-50 px-3 py-2 text-[13.5px] text-ink">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--color-petrol)]" checked={confirmVerified} onChange={(e) => setConfirmVerified(e.target.checked)} />
            <span>Новый адрес тоже подтверждён участником. Без этой отметки подтверждение будет снято при сохранении.</span>
          </label>
        )}
      </div>

      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-2">Роли</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLES.map((r) => (
            <label key={r.value} className="flex items-start gap-2.5 rounded-md border border-line px-3 py-2 text-[14px] text-ink has-[:checked]:border-petrol has-[:checked]:bg-petrol-50">
              <input type="checkbox" className="mt-1 size-4 accent-[var(--color-petrol)]" checked={v.roles.includes(r.value)} onChange={() => toggleRole(r.value)} />
              <span>
                {r.label}
                <span className="block text-[12px] text-ink-3">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-2">Статус</legend>
        <div className="flex flex-wrap gap-4 text-[14px] text-ink">
          <label className="flex items-center gap-2">
            <input type="radio" name={`status-${uid}`} className="size-4 accent-[var(--color-petrol)]" checked={v.status === "active"} onChange={() => set("status", "active")} />
            Действует
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`status-${uid}`} className="size-4 accent-[var(--color-petrol)]" checked={v.status === "inactive"} onChange={() => set("status", "inactive")} />
            Выведен из состава
          </label>
        </div>
        <p className="mt-1 text-[12.5px] text-ink-3">Участники не удаляются: история дел и протоколы ссылаются на них. Выведенный из состава не входит и не учитывается в новых голосованиях.</p>
      </fieldset>

      {error && <Notice tone="bad" title="Не сохранено">{error}</Notice>}
      {notice && <Notice tone="ok" title={notice} />}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Сохраняем…" : isNew ? "Добавить участника" : "Сохранить изменения"}
        </Button>
        <Link href={closeHref} scroll={false} className="inline-flex h-10 items-center rounded-md border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink hover:bg-sunken">
          {notice ? "Закрыть" : "Отменить"}
        </Link>
      </div>
    </form>
  );
}
