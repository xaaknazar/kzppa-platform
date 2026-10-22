"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { parseRoster } from "@/domain/roster-import";
import { Badge, Button, Notice, Section, Textarea } from "@/components/ui";
import { ROLE_LABELS } from "./role-labels";
import { importMembersAction } from "../../actions";

const EXAMPLE = "ФИО\tЭлектронная почта\tКоллегия\tРоль\nТулегенов Артур Куанышевич\tname@example.kz\tМангистауская областная коллегия адвокатов\tпредседатель";

export function ImportForm() {
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ email: string; ok: boolean; error?: string; created?: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => parseRoster(text), [text]);
  const valid = rows.filter((r) => !r.errors.length);

  return (
    <div className="space-y-6">
      <Section title="Данные">
        <p className="mb-2 text-[13.5px] text-ink-3">Столбцы: ФИО, электронная почта, коллегия, роль («председатель», «секретарь»; пусто — член комиссии). Строка заголовка необязательна.</p>
        <Textarea rows={10} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} placeholder={EXAMPLE} className="font-mono text-[13px]" />
      </Section>

      {rows.length > 0 && (
        <Section title="Что будет сохранено" aside={<span className="text-[13px] text-ink-3 tnum">{valid.length} из {rows.length}</span>}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead className="text-left text-[12.5px] text-ink-3">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Строка</th>
                  <th scope="col" className="py-2 pr-3 font-medium">ФИО</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Обращение в письмах</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Почта</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Роли</th>
                  <th scope="col" className="py-2 font-medium">Проверка</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.line} className={r.errors.length ? "bg-bad-50/40" : undefined}>
                    <td className="py-2 pr-3 text-ink-3 tnum">{r.line}</td>
                    <td className="py-2 pr-3">{r.fullName || "—"}<span className="block text-[12px] text-ink-3">{r.collegium}</span></td>
                    <td className="py-2 pr-3">{[r.firstName, r.patronymic].filter(Boolean).join(" ") || "—"}</td>
                    <td className="py-2 pr-3">{r.email || "—"}</td>
                    <td className="py-2 pr-3">{r.roles.map((x) => ROLE_LABELS[x] ?? x).join(", ")}</td>
                    <td className="py-2">{r.errors.length ? <span className="text-bad">{r.errors.join("; ")}</span> : <Badge tone="ok">Готово</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12.5px] text-ink-3">Обращение «Имя Отчество» берётся из ФИО и используется в поручениях. Если форма обращения иная, исправьте её в карточке участника после загрузки.</p>
          <label className="mt-4 flex items-start gap-2 text-[13.5px] text-ink-2">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              Адреса сверены секретарём с членами комиссии
              <span className="block text-[12.5px] text-ink-3">Иначе адрес считается подтверждённым после первого входа участника по коду. Поручение можно отправить только на подтверждённый адрес.</span>
            </span>
          </label>
          {error && <p className="mt-3 text-[13px] text-bad">{error}</p>}
          <div className="mt-4">
            <Button
              disabled={pending || !valid.length}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await importMembersAction({ rows: valid.map(({ fullName, firstName, patronymic, email, collegium, roles }) => ({ fullName, firstName, patronymic, email, collegium, roles })), emailsConfirmed: confirmed });
                  if (r.ok) setResult(r.data ?? []);
                  else setError(r.error);
                })
              }
            >
              {pending ? "Сохраняем…" : `Сохранить ${valid.length} участников`}
            </Button>
          </div>
        </Section>
      )}

      {result && (
        <Notice tone={result.every((r) => r.ok) ? "ok" : "warn"} title={`Сохранено ${result.filter((r) => r.ok).length} из ${result.length}`}>
          {result.filter((r) => !r.ok).map((r) => (
            <span key={r.email} className="block">{r.email}: {r.error}</span>
          ))}
          <Link href="/admin/members" className="text-petrol underline">Перейти к составу</Link>
        </Notice>
      )}
    </div>
  );
}
