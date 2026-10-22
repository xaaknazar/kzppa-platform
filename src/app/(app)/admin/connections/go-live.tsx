import { Section } from "@/components/ui";

/** Порядок перехода в боевой режим: что уже сделано и что осталось. */
export function GoLiveChecklist({ items, redirectUri }: { items: { done: boolean; title: string; note: string }[]; redirectUri: string }) {
  const left = items.filter((i) => !i.done).length;
  return (
    <Section title="Переход в боевой режим" aside={<span className="text-[13px] text-ink-3 tnum">{left ? `осталось ${left} из ${items.length}` : "всё готово"}</span>}>
      <ol className="space-y-3">
        {items.map((i, n) => (
          <li key={i.title} className="grid grid-cols-[24px_1fr] gap-x-3">
            <span aria-hidden className={i.done ? "mt-0.5 flex size-6 items-center justify-center rounded-full bg-ok text-[12px] text-white" : "mt-0.5 flex size-6 items-center justify-center rounded-full bg-sunken text-[12px] text-ink-3 ring-1 ring-line-strong tnum"}>
              {i.done ? "✓" : n + 1}
            </span>
            <span>
              <span className="sr-only">{i.done ? "Выполнено: " : "Не выполнено: "}</span>
              <span className={i.done ? "text-[14px] text-ink" : "text-[14px] font-medium text-ink"}>{i.title}</span>
              <span className="block text-[12.5px] text-ink-3">{i.note}</span>
            </span>
          </li>
        ))}
      </ol>
      <details className="mt-4 rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2">
        <summary className="cursor-pointer text-ink">Настройки Google Cloud для подключения Gmail</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>APIs &amp; Services → Library: включён Gmail API.</li>
          <li>
            Credentials → OAuth-клиент (Web) → Authorized redirect URI: <code className="break-all rounded bg-surface px-1">{redirectUri}</code>
          </li>
          <li>OAuth consent screen → Publishing status: <b>In production</b>. В режиме Testing Google отзывает доступ через 7 дней, и почта перестанет синхронизироваться.</li>
          <li>Предупреждение «приложение не проверено» при подключении нормально: доступ даёт только ящик комиссии.</li>
        </ul>
      </details>
    </Section>
  );
}
