import { and, asc, count, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { env, integrationModes } from "@/server/env";
import { GoLiveChecklist } from "./go-live";

import { Badge, Empty, KV, LinkButton, Notice, Section, fmtDate, type Tone } from "@/components/ui";
import type { ConnectionState } from "@/domain/types";
import { sendTestMailAction, syncMailAccountAction } from "../actions";
import { ActionButton } from "../settings-form";

export const metadata = { title: "Подключения" };

const STATE: Record<ConnectionState, { label: string; tone: Tone; hint?: string }> = {
  connected: { label: "Подключена", tone: "ok" },
  syncing: { label: "Синхронизация", tone: "info" },
  up_to_date: { label: "Актуально", tone: "ok" },
  delayed: { label: "Задержка", tone: "warn", hint: "Новые письма поступают с опозданием. Синхронизация продолжится автоматически." },
  login_required: { label: "Требуется вход", tone: "bad", hint: "Доступ к ящику отозван или истёк. Подключите Gmail повторно под официальным адресом." },
  quota: { label: "Квота исчерпана", tone: "warn", hint: "Google временно ограничил запросы. Синхронизация возобновится сама." },
  unavailable: { label: "Недоступна", tone: "bad", hint: "Сервис почты не отвечает. Повторите позже или проверьте состояние Google Workspace." },
  disabled: { label: "Отключена", tone: "neutral" },
};

const ERRORS: Record<string, string> = {
  access_denied: "Вход в Google отменён. Подключение не выполнено.",
  wrong_account: "Выбран не тот ящик. Войдите в Google под официальным адресом комиссии.",
  missing_scope: "Не выданы все запрошенные разрешения. Повторите подключение и отметьте все пункты.",
  state_mismatch: "Сеанс подключения устарел. Начните подключение заново.",
  not_configured: "Подключение Gmail не настроено на сервере: не заданы ключи приложения Google.",
};

/** MAIL-01..03, ARCH-02, UI-07: почтовые подключения и режимы внешних интеграций. */
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const u = await requireUser();
  const { connected, error } = await searchParams;
  const [accounts, org] = await Promise.all([
    db.query.mailAccounts.findMany({ where: eq(schema.mailAccounts.organizationId, u.orgId), orderBy: asc(schema.mailAccounts.createdAt) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) }),
  ]);
  const modes = integrationModes();
  const now = Date.now();
  const appUrl = env.appUrl;
  const [{ n: composition }] = await db
    .select({ n: count() })
    .from(schema.orgRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgRoles.userId))
    .where(and(eq(schema.orgRoles.organizationId, u.orgId), eq(schema.orgRoles.role, "member"), eq(schema.users.status, "active")));

  return (
    <div className="space-y-6">
      {connected === "1" && <Notice tone="ok" title="Gmail подключён">Ящик добавлен. Первая загрузка писем идёт в фоне; новые поступления появятся в разборе почты.</Notice>}
      {error && (
        <Notice tone="bad" title="Подключение не выполнено">
          {ERRORS[error] ?? `Google вернул ошибку: ${error.slice(0, 200)}. Повторите подключение; если ошибка повторяется, сообщите техническому администратору.`}
        </Notice>
      )}

      <GoLiveChecklist
        items={[
          { done: modes.auth !== "demo", title: "Боевой вход", note: modes.auth === "demo" ? "Сейчас AUTH_MODE=demo: войти может любой, выбрав участника. Для боевой работы — AUTH_MODE=email." : "Вход по коду с почты комиссии." },
          { done: composition >= 2, title: "Состав комиссии внесён", note: `Действующих участников: ${composition}. Загрузка из таблицы — в разделе «Состав комиссии».` },
          { done: modes.mail === "gmail", title: "Боевая почта", note: modes.mail === "gmail" ? "MAIL_TRANSPORT=gmail" : "Сейчас MAIL_TRANSPORT=dry-run: письма наружу не уходят." },
          { done: accounts.some((a) => ["connected", "up_to_date", "syncing", "delayed"].includes(a.state)), title: `Ящик ${org?.officialSender ?? "комиссии"} подключён`, note: "Кнопка «Подключить Gmail» ниже; входить в Google нужно именно под этим ящиком." },
          { done: modes.sign === "sigex", title: "Боевая подпись", note: modes.sign === "sigex" ? "SIGN_PROVIDER=sigex" : "Сейчас SIGN_PROVIDER=dry-run: подписи тестовые." },
        ]}
        redirectUri={`${appUrl}/api/integrations/gmail/callback`}
      />

      {modes.mail === "gmail" && accounts.length > 0 && (
        <Section title="Проверка отправки">
          <p className="mb-3 text-[13.5px] text-ink-3">Платформа отправит с ящика комиссии короткое письмо на ваш адрес {u.email}. Служебные письма не попадают в разбор почты.</p>
          <ActionButton action={sendTestMailAction} label="Отправить проверочное письмо" pendingLabel="Отправляем…" successLabel="Отправлено — проверьте почту" />
        </Section>
      )}

      <Section title="Почтовые ящики" aside={<LinkButton href="/api/integrations/gmail/connect" variant="primary" size="sm" prefetch={false}>Подключить Gmail</LinkButton>}>
        {accounts.length === 0 ? (
          <Empty title="Почта не подключена">
            Подключите официальный ящик комиссии{org?.officialSender ? ` (${org.officialSender})` : ""}. После подключения платформа загружает письма РКА и ответы исполнителей и показывает их в разборе почты.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {accounts.map((a) => {
              const st = STATE[a.state as ConnectionState] ?? { label: a.state, tone: "neutral" as Tone };
              const watchExpired = !!a.watchExpiration && a.watchExpiration.getTime() < now;
              return (
                <li key={a.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-all text-[15px] font-medium text-ink">{a.email}</p>
                      <p className="mt-0.5 text-[12.5px] text-ink-3">{a.provider === "gmail" ? "Gmail" : a.provider}{a.email === org?.officialSender ? ", официальный адрес комиссии" : ""}</p>
                    </div>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </div>
                  {st.hint && <p className="mt-2 text-[13px] text-ink-2">{st.hint}</p>}
                  <div className="mt-3">
                    <KV
                      cols={3}
                      items={[
                        ["Последняя синхронизация", <span key="s" className="tnum">{fmtDate(a.lastSyncAt, true) ?? "Ещё не выполнялась"}</span>],
                        [
                          "Уведомления Gmail действуют до",
                          a.watchExpiration ? (
                            <span key="w" className={watchExpired ? "text-warn tnum" : "tnum"}>
                              {fmtDate(a.watchExpiration, true)}
                              {watchExpired ? ", истекли" : ""}
                            </span>
                          ) : (
                            "Не настроены"
                          ),
                        ],
                        ["Позиция истории", a.historyId ? "Сохранена" : "Нет, будет полная загрузка"],
                        ["Первичная загрузка", a.initialSyncDone ? "Завершена" : a.initialSyncFrom ? `Идёт, с ${fmtDate(a.initialSyncFrom)}` : "Не начата"],
                      ]}
                    />
                  </div>
                  {a.lastError && (
                    <div className="mt-3 rounded-md border border-bad/20 bg-bad-50 px-3 py-2">
                      <p className="text-[12.5px] font-medium text-bad">Последняя ошибка</p>
                      <p className="mt-0.5 break-words font-mono text-[12.5px] text-ink-2">{a.lastError}</p>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-start gap-3">
                    <ActionButton action={syncMailAccountAction.bind(null, a.id)} label="Синхронизировать сейчас" pendingLabel="Синхронизируем…" successLabel="Синхронизация выполнена. Новые письма — в разборе почты." />
                    {a.state === "login_required" && (
                      <LinkButton href="/api/integrations/gmail/connect" size="sm" prefetch={false}>
                        Подключить заново
                      </LinkButton>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Режимы интеграций">
        <p className="mb-4 max-w-[72ch] text-[13.5px] text-ink-2">
          Режим задаётся переменными окружения сервера и меняется при развёртывании, а не в интерфейсе. Тестовый режим ничего не отправляет наружу и не создаёт юридически значимых действий; это видно на каждой странице в жёлтой полосе вверху.
        </p>
        <dl className="divide-y divide-line">
          <ModeRow
            name="Отправка почты"
            live={modes.mail === "gmail"}
            liveLabel="Gmail"
            testLabel="Тестовый режим"
            liveText="Письма уходят адресатам через подключённый ящик комиссии."
            testText="Письма формируются и сохраняются в деле, но не отправляются. Адресаты ничего не получат."
          />
          <ModeRow
            name="Электронная подпись"
            live={modes.sign === "sigex"}
            liveLabel="SIGEX"
            testLabel="Тестовый режим"
            liveText="Подпись выполняется личным ключом ЭЦП через SIGEX и проверяется по реестру."
            testText="Подпись имитируется. Такие документы не имеют юридической силы и не должны направляться в РКА."
          />
          <ModeRow
            name="Вход пользователей"
            live={modes.auth !== "demo"}
            liveLabel="По коду на почту"
            testLabel="Демонстрационный"
            liveText={modes.auth === "email" ? "Вход по одноразовому коду, который платформа отправляет с почты комиссии на подтверждённый адрес участника." : "Вход по одноразовому коду Supabase Auth на подтверждённый адрес участника."}
            testText="Вход выбором участника из списка, без проверки почты. Только для демонстрации."
          />
          <ModeRow
            name="Хранение файлов"
            live={modes.storage === "supabase"}
            liveLabel="Supabase Storage"
            testLabel="Локальный диск"
            liveText="Файлы хранятся в защищённом хранилище с проверкой хеша при каждой выдаче."
            testText="Файлы хранятся на диске сервера. Подходит для проверки, но не для рабочей эксплуатации: нет резервного копирования."
          />
        </dl>
      </Section>
    </div>
  );
}

function ModeRow({ name, live, liveLabel, testLabel, liveText, testText }: { name: string; live: boolean; liveLabel: string; testLabel: string; liveText: string; testText: string }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[200px_160px_1fr] sm:gap-4">
      <dt className="text-[14px] font-medium text-ink">{name}</dt>
      <dd>
        <Badge tone={live ? "ok" : "warn"}>{live ? liveLabel : testLabel}</Badge>
      </dd>
      <dd className="text-[13.5px] text-ink-2">{live ? liveText : testText}</dd>
    </div>
  );
}
