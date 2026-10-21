import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { Badge, Empty, Section, fmtDate } from "@/components/ui";
import { requeueOutboxAction } from "../actions";
import { ActionButton } from "../settings-form";

export const metadata = { title: "Фоновые операции" };

const TYPE_LABEL: Record<string, string> = {
  "assignment.grant_access": "Выдача доступа исполнителю",
  "assignment.send": "Отправка поручения",
  "outgoing.send": "Отправка исходящего",
  "outgoing.reconcile": "Сверка отправленного",
  "mail.sync": "Синхронизация почты",
  "mail.fetch_message": "Загрузка письма",
  "sign.poll": "Проверка статуса подписи",
  "sign.register_verify": "Регистрация и проверка подписи",
  "vote.invite": "Приглашение к голосованию",
};

const AGG_LABEL: Record<string, string> = { assignment: "Поручение", outgoing: "Исходящее", mail_account: "Почтовый ящик", message: "Письмо", sign_session: "Сеанс подписи", cycle: "Цикл рассмотрения", case: "Дело" };

/** ARCH-03: операции, остановленные после ошибок, и повторяющиеся с ошибкой. */
export default async function OutboxPage() {
  const u = await requireUser();
  const rows = await db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.organizationId, u.orgId), or(eq(schema.outbox.status, "dead"), and(eq(schema.outbox.status, "pending"), isNotNull(schema.outbox.lastError)))))
    .orderBy(desc(schema.outbox.status), desc(schema.outbox.createdAt))
    .limit(200);
  const dead = rows.filter((r) => r.status === "dead");
  const retrying = rows.filter((r) => r.status !== "dead");

  return (
    <div className="space-y-6">
      <p className="max-w-[76ch] text-[13.5px] text-ink-2">
        Отправки, выдача доступа, загрузка почты и проверка подписей выполняются в фоне и повторяются автоматически. Здесь показаны только операции с ошибками. Повтор безопасен: каждая операция выполняется с ключом идемпотентности и не создаёт дублей писем, файлов или подписей.
      </p>

      <Section title="Остановлены после ошибок" aside={<Badge tone={dead.length ? "bad" : "neutral"}>{dead.length}</Badge>}>
        {dead.length === 0 ? <p className="text-[14px] text-ink-3">Остановленных операций нет.</p> : <Rows rows={dead} />}
      </Section>

      <Section title="Повторяются автоматически" aside={<Badge tone={retrying.length ? "warn" : "neutral"}>{retrying.length}</Badge>}>
        {retrying.length === 0 ? <Empty title="Сбоев нет">Все фоновые операции выполняются без ошибок.</Empty> : <Rows rows={retrying} />}
      </Section>
    </div>
  );
}

function Rows({ rows }: { rows: (typeof schema.outbox.$inferSelect)[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <p className="text-[14.5px] font-medium text-ink">{TYPE_LABEL[r.type] ?? r.type}</p>
            <p className="mt-0.5 text-[12.5px] text-ink-3 tnum">
              {AGG_LABEL[r.aggregateType] ?? r.aggregateType} <code className="font-mono text-[12px]">{r.aggregateId.slice(0, 8)}</code>
              {r.aggregateVersion != null ? `, версия ${r.aggregateVersion}` : ""}. Попыток: {r.attempts}.{" "}
              {r.status === "dead" ? `Создана ${fmtDate(r.createdAt, true)}` : `Следующая попытка ${fmtDate(r.nextAttemptAt, true)}`}
            </p>
            {r.lastError && <p className="mt-2 break-words rounded-md bg-sunken px-3 py-2 font-mono text-[12.5px] text-ink-2">{r.lastError}</p>}
            {r.correlationId && <p className="mt-1 text-[12px] text-ink-4">Код для поддержки: {r.correlationId.slice(0, 8)}</p>}
          </div>
          {r.status === "dead" && (
            <div className="md:pt-0.5">
              <ActionButton action={requeueOutboxAction.bind(null, r.id)} label="Повторить" pendingLabel="Ставим в очередь…" successLabel="Поставлено в очередь. Операция выполнится в ближайшую минуту." />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
