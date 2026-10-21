import Link from "next/link";
import { and, asc, count, desc, eq, inArray, like, type SQL } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { verifyAuditChain } from "@/server/audit";
import { can } from "@/domain/acl";
import { formatBase } from "@/domain/numbering";
import { Badge, Button, Empty, Input, LinkButton, Notice, PageHeader, Section, Select, type Tone } from "@/components/ui";

export const metadata = { title: "Журнал операций" };

/**
 * AUD-01..03. Журнал событий организации с цепочкой хешей. Только чтение:
 * изменить запись из интерфейса нельзя. Проверка целостности пересчитывает всю цепочку.
 */

const PAGE = 50;

const ACTION_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "case.", label: "Дела: регистрация, приобщение, поля" },
  { prefix: "intake.", label: "Поступления и вложения" },
  { prefix: "assignment.", label: "Поручения" },
  { prefix: "access.", label: "Права доступа" },
  { prefix: "draft.", label: "Проекты заключений" },
  { prefix: "cycle.", label: "Обсуждение и голосование" },
  { prefix: "vote.", label: "Голоса" },
  { prefix: "conclusion.", label: "Заключения и подписание" },
  { prefix: "outgoing.", label: "Исходящие" },
  { prefix: "document.", label: "Документы и скачивания" },
  { prefix: "registry.", label: "Выгрузки реестра" },
  { prefix: "admin.", label: "Администрирование" },
];

const ACTION_LABEL: Record<string, string> = {
  "case.register": "Регистрация обращения",
  "case.attach": "Приобщение письма к делу",
  "case.attach_auto": "Автоматическое приобщение письма",
  "case.update_fields": "Изменение полей дела",
  "intake.exclude_item": "Исключение вложения из обязательного состава",
  "assignment.assign": "Назначение исполнителя",
  "assignment.edit_letter": "Изменение текста поручения",
  "assignment.approve_send": "Утверждение и отправка поручения",
  "assignment.reject": "Возврат текста поручения",
  "assignment.extend": "Продление срока",
  "assignment.resubmit": "Повторная подача поручения",
  "access.grant": "Выдача доступа",
  "access.revoke": "Отзыв доступа",
  "draft.preapprove": "Предварительное одобрение проекта",
  "draft.preapprove_rework": "Возврат проекта на доработку",
  "cycle.open_vote": "Открытие голосования",
  "cycle.close_vote": "Закрытие голосования",
  "vote.cast": "Голос члена комиссии",
  "conclusion.route": "Выбор маршрута заключения",
  "conclusion.approve": "Утверждение заключения",
  "conclusion.prepare_pdf": "Подготовка PDF к подписи",
  "outgoing.prepare_rka": "Подготовка комплекта в РКА",
  "outgoing.update_files": "Изменение состава комплекта",
  "outgoing.approve_send": "Согласование и отправка комплекта",
  "outgoing.reject": "Возврат комплекта",
  "outgoing.sent": "Отправка подтверждена провайдером",
  "outgoing.reconcile": "Сверка отправленного",
  "outgoing.approval_stale": "Разрешение на отправку устарело",
  "document.download": "Скачивание документа",
  "registry.export": "Выгрузка реестра",
};

const OBJECT_LABEL: Record<string, string> = {
  case: "Дело",
  message: "Письмо",
  attachment: "Вложение",
  assignment: "Поручение",
  outgoing: "Исходящее",
  cycle: "Цикл рассмотрения",
  document_version: "Версия документа",
  sign_session: "Сеанс подписи",
  registry: "Реестр",
  command: "Команда",
};

const ACTOR_TYPE: Record<string, string> = { user: "человек", service: "сервис", external: "внешний" };
const RESULT: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "Выполнено", tone: "ok" },
  denied: { label: "Отказано", tone: "warn" },
  error: { label: "Ошибка", tone: "bad" },
};

const fmtAlmaty = (d: Date) =>
  d.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requireUser();
  if (!can(u.principal, "audit.read")) {
    return (
      <>
        <PageHeader title="Журнал операций" />
        <Notice tone="warn" title="Раздел доступен председателю, секретарю и аудитору" />
      </>
    );
  }

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const action = str("action").slice(0, 60);
  const caseQ = str("case").replace(/^№/, "").slice(0, 10);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(str("page") || "1", 10) || 1));
  const verify = str("verify") === "1";

  const ev = schema.auditEvents;
  const conds: SQL[] = [eq(ev.organizationId, u.orgId)];
  if (action) conds.push(like(ev.action, `${action.replace(/[%_\\]/g, "\\$&")}%`));

  let caseFilterError: string | null = null;
  let caseMatches: { id: string; number: number; year: number }[] = [];
  if (caseQ) {
    const n = Number.parseInt(caseQ, 10);
    if (!Number.isFinite(n) || n < 1) {
      caseFilterError = "Номер дела — число, например 7 или 007.";
    } else {
      caseMatches = await db.select({ id: schema.cases.id, number: schema.cases.number, year: schema.cases.year }).from(schema.cases).where(and(eq(schema.cases.organizationId, u.orgId), eq(schema.cases.number, n)));
      if (caseMatches.length === 0) caseFilterError = `Дело №${formatBase(n)} не найдено.`;
      else conds.push(inArray(ev.caseId, caseMatches.map((c) => c.id)));
    }
  }
  const where = and(...conds);

  const [[{ n: total }], rows] = caseFilterError
    ? [[{ n: 0 }], []]
    : await Promise.all([db.select({ n: count() }).from(ev).where(where), db.select().from(ev).where(where).orderBy(desc(ev.id)).limit(PAGE).offset((page - 1) * PAGE)]);

  const caseIds = [...new Set(rows.map((r) => r.caseId).filter((x): x is string => !!x))];
  const caseRows = caseIds.length ? await db.select({ id: schema.cases.id, number: schema.cases.number }).from(schema.cases).where(and(eq(schema.cases.organizationId, u.orgId), inArray(schema.cases.id, caseIds))) : [];
  const caseNum = new Map(caseRows.map((c) => [c.id, c.number]));

  let verification: { ok: boolean; brokenAt: number | null; checked: number } | null = null;
  if (verify) {
    const all = await db.select().from(ev).where(eq(ev.organizationId, u.orgId)).orderBy(asc(ev.id));
    const r = await verifyAuditChain(all);
    verification = { ...r, checked: all.length };
  }

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const qs = (patch: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | number | null> = { action: action || null, case: caseQ || null, page: page > 1 ? page : null, ...patch };
    for (const [k, v] of Object.entries(base)) if (v !== null && v !== "" && !(k === "page" && v === 1)) p.set(k, String(v));
    const s = p.toString();
    return s ? `/audit?${s}` : "/audit";
  };

  return (
    <>
      <PageHeader
        title="Журнал операций"
        lead="Все действия с делами, письмами, правами, подписями и отправками. Записи нельзя изменить или удалить; каждая содержит хеш предыдущей, поэтому подмена обнаруживается проверкой целостности. Время показано по Алматы."
      />

      <Section
        title="Целостность журнала"
        className="mb-6"
        aside={
          <form method="get" action="/audit">
            {action && <input type="hidden" name="action" value={action} />}
            {caseQ && <input type="hidden" name="case" value={caseQ} />}
            <input type="hidden" name="verify" value="1" />
            <Button type="submit" size="sm" variant="secondary">
              Проверить целостность журнала
            </Button>
          </form>
        }
      >
        {!verification ? (
          <p className="text-[14px] text-ink-3">Проверка пересчитывает хеши всех записей организации по порядку и сравнивает их с сохранёнными. На большом журнале это может занять некоторое время.</p>
        ) : verification.ok ? (
          <Notice tone="ok" title="Цепочка не нарушена">
            Проверено записей: <span className="tnum">{verification.checked}</span>. Каждая запись совпадает со своим хешем и ссылается на предыдущую. Проверка выполнена {fmtAlmaty(new Date())}.
          </Notice>
        ) : (
          <Notice tone="bad" title={<>Цепочка нарушена на записи <span className="tnum">№{verification.brokenAt}</span></>}>
            Запись изменена, удалена или вставлена вне порядка. Записи до неё не затронуты. Не исправляйте журнал вручную: сохраните выгрузку базы и сообщите техническому администратору, чтобы восстановить запись из резервной копии и составить отчёт об инциденте.
            <span className="mt-1 block tnum">Проверено записей: {verification.checked}.</span>
          </Notice>
        )}
      </Section>

      <form method="get" action="/audit" className="mb-5 flex flex-wrap items-end gap-3">
        <label className="block w-full sm:w-[320px]">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">Вид операции</span>
          <Select name="action" defaultValue={action}>
            <option value="">Все операции</option>
            {ACTION_GROUPS.map((g) => (
              <option key={g.prefix} value={g.prefix}>
                {g.label}
              </option>
            ))}
            {action && !ACTION_GROUPS.some((g) => g.prefix === action) && <option value={action}>{action}</option>}
          </Select>
        </label>
        <label className="block w-full sm:w-[160px]">
          <span className="mb-1 block text-[13px] font-medium text-ink-2">Номер дела</span>
          <Input name="case" defaultValue={caseQ} inputMode="numeric" placeholder="Например, 007" className="doc-number" />
        </label>
        <Button type="submit" variant="secondary">
          Показать
        </Button>
        {(action || caseQ) && (
          <LinkButton href="/audit" variant="ghost">
            Сбросить
          </LinkButton>
        )}
      </form>

      {caseFilterError ? (
        <Notice tone="warn" title={caseFilterError}>
          Проверьте номер и повторите поиск или сбросьте фильтр.
        </Notice>
      ) : rows.length === 0 ? (
        <Empty title="Записей не найдено" action={action || caseQ ? <LinkButton href="/audit" size="sm">Показать весь журнал</LinkButton> : undefined}>
          {action || caseQ ? "По выбранным условиям операций не было." : "Журнал пуст: операций ещё не было."}
        </Empty>
      ) : (
        <>
          <p className="mb-2 text-[13px] text-ink-3 tnum">
            Записей: {total}. Страница {page} из {pages}.
            {caseMatches.length > 1 && " Номер встречается в нескольких годах — показаны события всех таких дел."}
          </p>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[1080px] text-left text-[13.5px]">
              <caption className="sr-only">Журнал операций, новые записи сверху</caption>
              <thead className="bg-sunken text-[12.5px] text-ink-2">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">№</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Время (Алматы)</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Кто</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Операция</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Объект</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Дело</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Результат</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Основание</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const res = RESULT[r.result] ?? { label: r.result, tone: "neutral" as Tone };
                  const num = r.caseId ? caseNum.get(r.caseId) : undefined;
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="px-4 py-2.5 tnum text-ink-3">{r.id}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 tnum text-ink-2" title={`UTC ${new Date(r.at).toISOString()}`}>
                        {fmtAlmaty(new Date(r.at))}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="block text-ink">{r.actorLabel ?? "Не указан"}</span>
                        <span className="block text-[12px] text-ink-3">{ACTOR_TYPE[r.actorType] ?? r.actorType}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="block text-ink">{ACTION_LABEL[r.action] ?? r.action}</span>
                        {ACTION_LABEL[r.action] && <code className="block font-mono text-[11.5px] text-ink-4">{r.action}</code>}
                      </td>
                      <td className="px-3 py-2.5 text-ink-2">
                        {OBJECT_LABEL[r.objectType] ?? r.objectType}
                        {r.objectVersion != null && <span className="text-[12px] text-ink-3 tnum">, версия {r.objectVersion}</span>}
                        {r.objectId && (
                          <code title={r.objectId} className="block font-mono text-[11.5px] text-ink-4">
                            {r.objectId.slice(0, 8)}
                          </code>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        {r.caseId && num != null ? (
                          <Link href={`/cases/${r.caseId}`} className="doc-number text-ink hover:text-petrol">
                            №{formatBase(num)}
                          </Link>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={res.tone}>{res.label}</Badge>
                      </td>
                      <td className="max-w-[320px] px-4 py-2.5 text-ink-2">{r.basis ? <span className="line-clamp-3" title={r.basis}>{r.basis}</span> : <span className="text-ink-4">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Страницы журнала" className="mt-4 flex flex-wrap items-center gap-2">
              {page > 1 ? <LinkButton href={qs({ page: page - 1 })} size="sm">Более новые</LinkButton> : null}
              <span className="px-2 text-[13px] text-ink-3 tnum">
                {page} из {pages}
              </span>
              {page < pages ? <LinkButton href={qs({ page: page + 1 })} size="sm">Более ранние</LinkButton> : null}
            </nav>
          )}
        </>
      )}
    </>
  );
}

