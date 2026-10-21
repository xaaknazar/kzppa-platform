import Link from "next/link";
import clsx from "clsx";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser, isStaff } from "@/server/auth";
import { toManifestItem } from "@/server/services/cases";
import { summarizeManifest } from "@/domain/manifest";
import { formatBase } from "@/domain/numbering";
import { INTAKE_STATE_LABEL } from "@/domain/states";
import type { IntakeState } from "@/domain/types";
import { Badge, Empty, LinkButton, Notice, PageHeader, fmtDate, type Tone } from "@/components/ui";

export const metadata = { title: "Разбор почты" };

/**
 * UI-02. Очередь разбора входящей почты: неприобщённые письма и письма,
 * которым нужно решение человека. Права проверяются на сервере.
 */

const OPEN_STATES: IntakeState[] = ["needs_review", "incomplete", "matched", "quarantine"];

type FilterKey = "review" | "incomplete" | "quarantine" | "all";

const FILTERS: { key: FilterKey; label: string; states: string[] | null }[] = [
  { key: "review", label: "Требует разбора", states: ["needs_review", "matched", "verified"] },
  { key: "incomplete", label: "Не завершена загрузка", states: ["incomplete", "loading", "discovered", "access_error"] },
  { key: "quarantine", label: "Карантин", states: ["quarantine"] },
  { key: "all", label: "Все неприобщённые", states: null },
];

const INTAKE_TONE: Record<string, Tone> = {
  needs_review: "warn",
  incomplete: "warn",
  quarantine: "bad",
  access_error: "bad",
  matched: "petrol",
  verified: "info",
  attached: "ok",
  loading: "neutral",
  discovered: "neutral",
};

const KIND_LABEL: Record<string, string> = {
  initial: "Обращение",
  supplement: "Дополнительные материалы",
  rework: "На доработку",
  executor_reply: "Ответ исполнителя",
  unknown: "Вид не определён",
};

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requireUser();
  if (!isStaff(u)) {
    return (
      <>
        <PageHeader title="Разбор почты" />
        <Notice tone="warn" title="Раздел доступен председателю и секретарю">
          Если вам нужен доступ к почте комиссии, обратитесь к председателю.
        </Notice>
      </>
    );
  }

  const sp = await searchParams;
  const fRaw = typeof sp.f === "string" ? sp.f : "review";
  const active: FilterKey = FILTERS.find((f) => f.key === fRaw)?.key ?? "review";

  const m = schema.messages;
  const rows = await db
    .select({
      id: m.id,
      subject: m.subject,
      fromAddr: m.fromAddr,
      fromName: m.fromName,
      receivedAt: m.receivedAt,
      processedAt: m.processedAt,
      intakeState: m.intakeState,
      intakeKind: m.intakeKind,
      match: m.match,
      sourceCheck: m.sourceCheck,
      caseId: m.caseId,
      addedLate: m.addedLate,
    })
    .from(m)
    .where(and(eq(m.organizationId, u.orgId), eq(m.direction, "in"), or(isNull(m.caseId), inArray(m.intakeState, OPEN_STATES))))
    .orderBy(desc(sql`coalesce(${m.receivedAt}, ${m.processedAt})`))
    .limit(500);

  const inFilter = (key: FilterKey, state: string) => {
    const f = FILTERS.find((x) => x.key === key)!;
    return f.states === null || f.states.includes(state);
  };
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter((r) => inFilter(f.key, r.intakeState)).length])) as Record<FilterKey, number>;
  const shown = rows.filter((r) => inFilter(active, r.intakeState)).slice(0, 200);

  const ids = shown.map((r) => r.id);
  const atts = ids.length ? await db.query.attachments.findMany({ where: inArray(schema.attachments.messageId, ids) }) : [];

  // Номера дел для предложений сопоставления и уже приобщённых писем.
  const caseIds = new Set<string>();
  for (const r of shown) {
    if (r.caseId) caseIds.add(r.caseId);
    const mv = readMatch(r.match);
    if (mv.caseId) caseIds.add(mv.caseId);
    for (const c of mv.candidates.slice(0, 1)) caseIds.add(c.caseId);
  }
  const validIds = [...caseIds].filter((x) => UUID.test(x));
  const caseRows = validIds.length
    ? await db.select({ id: schema.cases.id, number: schema.cases.number, applicant: schema.cases.applicant }).from(schema.cases).where(and(eq(schema.cases.organizationId, u.orgId), inArray(schema.cases.id, validIds)))
    : [];
  const caseById = new Map(caseRows.map((c) => [c.id, c]));

  return (
    <>
      <PageHeader
        title="Разбор почты"
        lead="Входящие письма, которые ещё не приобщены к делу или требуют решения. Откройте письмо, проверьте его целиком и выберите: приобщить к делу или зарегистрировать новое обращение."
      />

      <nav aria-label="Фильтр очереди" className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "review" ? "/inbox" : `/inbox?f=${f.key}`}
            aria-current={active === f.key ? "page" : undefined}
            className={clsx(
              "whitespace-nowrap border-b-2 px-3 py-2.5 text-[14px] transition-colors",
              active === f.key ? "border-petrol font-medium text-petrol" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {f.label}
            <span className="ml-1.5 text-ink-4 tnum">{counts[f.key]}</span>
          </Link>
        ))}
      </nav>

      <div className="mt-6">
        {shown.length === 0 ? (
          <Empty
            title={active === "review" ? "Писем, требующих разбора, нет" : active === "incomplete" ? "Незавершённых загрузок нет" : active === "quarantine" ? "В карантине писем нет" : "Все письма приобщены к делам"}
            action={active !== "all" ? <LinkButton href="/inbox?f=all" size="sm">Показать все неприобщённые</LinkButton> : <LinkButton href="/registry" size="sm">Открыть реестр</LinkButton>}
          >
            Новые письма появляются здесь после синхронизации почты комиссии.
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[960px] text-left text-[14px]">
              <caption className="sr-only">Письма в очереди разбора</caption>
              <thead className="bg-sunken text-[13px] text-ink-2">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Получено</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Отправитель</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Тема</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Вложения</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Предложение</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Состояние</th>
                  <th scope="col" className="px-4 py-2.5 font-medium"><span className="sr-only">Действие</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((r) => {
                  const s = summarizeManifest(atts.filter((a) => a.messageId === r.id).map(toManifestItem));
                  const sc = readSourceCheck(r.sourceCheck);
                  const mv = readMatch(r.match);
                  const top = mv.kind === "attach" && mv.caseId ? { caseId: mv.caseId, caseNumber: caseById.get(mv.caseId)?.number ?? null, score: mv.confidence } : mv.candidates[0];
                  const topNumber = top ? (top.caseNumber ?? caseById.get(top.caseId)?.number ?? null) : null;
                  const attached = r.caseId ? caseById.get(r.caseId) : null;
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 tnum text-ink-2">
                        {fmtDate(r.receivedAt ?? r.processedAt, true)}
                        {!r.receivedAt && <span className="block text-[12px] text-ink-4">время обработки</span>}
                        {r.addedLate && <span className="mt-1 block"><Badge>Добавлено позднее</Badge></span>}
                      </td>
                      <td className="max-w-[240px] px-4 py-3">
                        {r.fromName && <span className="block truncate text-ink">{r.fromName}</span>}
                        <span className="block truncate text-[13px] text-ink-3">{r.fromAddr}</span>
                        {sc.suspicious && (
                          <span className="mt-1 block">
                            <Badge tone="bad" title={sc.flags.join("; ") || undefined}>Подозрительный источник</Badge>
                          </span>
                        )}
                      </td>
                      <td className="max-w-[340px] px-4 py-3">
                        <Link href={`/inbox/${r.id}`} className="block text-ink hover:text-petrol">
                          {r.subject.trim() || <span className="text-ink-4">Без темы</span>}
                        </Link>
                        {r.intakeKind && <span className="mt-0.5 block text-[12.5px] text-ink-3">{KIND_LABEL[r.intakeKind] ?? r.intakeKind}</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {s.declared === 0 ? (
                          <span className="text-ink-3">Без вложений</span>
                        ) : (
                          <>
                            <span className={clsx("tnum", s.complete ? "text-ok" : s.problems ? "text-bad" : "text-warn")}>
                              {s.verified} из {s.declared} проверено
                            </span>
                            {s.excluded > 0 && <span className="block text-[12px] text-ink-3 tnum">исключено {s.excluded}</span>}
                            {s.problems > 0 && <span className="block text-[12px] text-bad tnum">с проблемами {s.problems}</span>}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {attached ? (
                          <Link href={`/cases/${attached.id}`} className="text-ink hover:text-petrol">
                            Приобщено к делу <span className="doc-number">№{formatBase(attached.number)}</span>
                          </Link>
                        ) : top && topNumber ? (
                          <>
                            <span className="text-ink">
                              Дело <span className="doc-number">№{formatBase(topNumber)}</span>
                            </span>
                            {top.score != null && <span className="ml-1.5 text-[13px] text-ink-3 tnum">{pct(top.score)}</span>}
                            {mv.candidates.length > 1 && <span className="block text-[12px] text-ink-3">кандидатов: {mv.candidates.length}</span>}
                          </>
                        ) : mv.kind === "new_case" ? (
                          <span className="text-ink">Новое обращение</span>
                        ) : (
                          <span className="text-ink-3">Кандидатов нет</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={INTAKE_TONE[r.intakeState] ?? "neutral"}>{INTAKE_STATE_LABEL[r.intakeState as IntakeState] ?? r.intakeState}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <LinkButton href={`/inbox/${r.id}`} size="sm">Разобрать</LinkButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length >= 500 && <p className="mt-3 text-[13px] text-ink-3">Показаны 500 последних писем очереди. Разберите их, чтобы увидеть более ранние.</p>}
      </div>
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pct = (s: number | null) => (s == null ? null : `${Math.round(s <= 1 ? s * 100 : s)}%`);

/** Защитное чтение messages.match: структура может отличаться у старых записей. */
function readMatch(v: unknown) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
  const candidates = (Array.isArray(o.candidates) ? o.candidates : [])
    .flatMap((c) => {
      if (!c || typeof c !== "object") return [];
      const r = c as Record<string, unknown>;
      if (typeof r.caseId !== "string") return [];
      return [{ caseId: r.caseId, caseNumber: num(r.caseNumber), score: num(r.score ?? r.confidence), reasons: strs(r.reasons) }];
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    kind: typeof o.kind === "string" ? o.kind : null,
    reasons: strs(o.reasons),
    caseId: typeof o.caseId === "string" ? o.caseId : null,
    confidence: num(o.confidence),
    candidates,
  };
}

/** Защитное чтение messages.source_check (SPF/DKIM/DMARC и признаки подозрительности). */
function readSourceCheck(v: unknown) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const auth = (o.authResults && typeof o.authResults === "object" ? o.authResults : o) as Record<string, unknown>;
  const res = (x: unknown) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { result?: unknown }).result === "string" ? (x as { result: string }).result : null);
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const spf = res(auth.spf);
  const dkim = res(auth.dkim);
  const dmarc = res(auth.dmarc);
  const flags = [...strs(o.flags), ...strs(o.suspiciousFlags), ...strs(o.reasons), ...strs(o.warnings)];
  const failing = [spf, dkim, dmarc].some((r) => !!r && /fail|permerror/i.test(r));
  return { spf, dkim, dmarc, flags, suspicious: o.suspicious === true || flags.length > 0 || failing };
}
