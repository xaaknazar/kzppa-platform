import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, isChair } from "@/server/auth";
import { caseDetail } from "@/server/queries";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { can } from "@/domain/acl";
import { computeRoute } from "@/server/route";
import { RouteRail } from "@/components/route-rail";
import { Badge, Empty, Hash, KV, Notice, PageHeader, Section, Tabs, fmtDate, fmtSize, type Tone } from "@/components/ui";
import { formatBase } from "@/domain/numbering";
import { ASSIGNMENT_STATE_LABEL, CASE_STATE_LABEL, DOC_STATE_LABEL, INTAKE_STATE_LABEL, OUTGOING_STATE_LABEL, SIGN_STATE_LABEL } from "@/domain/states";
import { DOC_CATEGORY_LABEL, type AssignmentState, type CaseState, type DocCategory, type DocVersionState, type IntakeState, type OutgoingState, type SignSessionState } from "@/domain/types";
import { LANG_LABEL } from "@/domain/language";
import { OUTCOME_LABEL, type Tally } from "@/domain/quorum";
import { suggestAttachments } from "@/server/services/outgoing";
import {
  AssignForm,
  AssignmentReview,
  CaseFieldsEditor,
  ClosePanel,
  FinalRoutePanel,
  ApproveFinalPanel,
  OpenVotingForm,
  PackagePanel,
  PreapprovePanel,
  PreparePdfPanel,
  PreparePackageForm,
  SignPanel,
  UnknownSendPanel,
} from "./panels";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // приглашения к голосованию отправляются после ответа (after)

const TABS = [
  { key: "overview", label: "Обзор" },
  { key: "materials", label: "Материалы" },
  { key: "mail", label: "Переписка" },
  { key: "assignments", label: "Поручения" },
  { key: "review", label: "Рассмотрение" },
  { key: "signatures", label: "Заключение и ЭЦП" },
  { key: "outgoing", label: "Исходящие" },
  { key: "history", label: "Хронология" },
];

const caseTone = (s: string): Tone => (["sent", "closed"].includes(s) ? "ok" : ["rework", "suspended"].includes(s) ? "warn" : s === "cancelled" ? "neutral" : "petrol");
const outTone = (s: string): Tone => (s === "sent" ? "ok" : ["unknown_result", "error", "bounced", "approval_stale"].includes(s) ? "bad" : s === "draft" ? "seal" : "neutral");

export default async function CasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ tab?: string; cycle?: string }> }) {
  const u = await requireUser();
  const { caseId } = await params;
  const sp = await searchParams;
  const d = await caseDetail(u, caseId);
  if (!d) {
    // Не раскрываем, существует ли дело (SEC-05).
    return (
      <Notice tone="warn" title="Нет доступа к карточке дела">
        Полная карточка доступна председателю и секретарю. Если вы исполнитель, откройте <Link className="text-petrol underline" href={`/w/${caseId}`}>рабочую область</Link>.
      </Notice>
    );
  }
  const { kase } = d;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "overview";
  const cycle = d.cycles.find((c) => c.id === (sp.cycle ?? kase.currentCycleId)) ?? d.cycles[d.cycles.length - 1];
  if (!cycle) notFound();
  const route = computeRoute(d, cycle.id);
  const chair = isChair(u);
  const name = (id?: string | null) => d.users.find((x) => x.id === id)?.fullName ?? "—";
  const executors = d.users.filter((x) => x.status === "active");
  const base = `/cases/${caseId}${sp.cycle ? `?cycle=${sp.cycle}` : ""}`;
  // FLOW-13: приглашение, доставка и открытие ссылки — отдельные от голоса события.
  const canSeeRoot = can(u.principal, "case.read_root", { caseId: kase.id });
  const invRows = canSeeRoot ? await db.select({ sentAt: schema.voteInvitations.sentAt, openedAt: schema.voteInvitations.openedAt, deliveryState: schema.voteInvitations.deliveryState }).from(schema.voteInvitations).where(eq(schema.voteInvitations.cycleId, cycle.id)) : [];
  const inv = { total: invRows.length, sent: invRows.filter((r) => r.sentAt).length, opened: invRows.filter((r) => r.openedAt).length, pending: invRows.filter((r) => r.deliveryState === "pending").length };
  const cycleDocs = d.documents.filter((x) => x.d.cycleId === cycle.id || (x.d.cycleId === null && d.cycles.length === 1));
  const drafts = cycleDocs.filter((x) => x.d.category === "draft");
  const card = d.cards.find((c) => c.cycleId === cycle.id);
  const pdf = card ? d.documents.find((x) => x.v.id === card.documentVersionId) : undefined;
  const signs = d.signs.filter((s) => s.documentVersionId === card?.documentVersionId);
  const pkg = [...d.outgoings].reverse().find((o) => o.kind === "rka_package" && o.cycleId === cycle.id);
  const cycleAssignments = d.assignments.filter((a) => a.cycleId === cycle.id || d.cycles.length === 1);
  const activeAssignment = [...cycleAssignments].reverse()[0];
  const t = cycle.tally as Tally | null;
  const finalVersion = cycle.finalVersionId ? d.documents.find((x) => x.v.id === cycle.finalVersionId) : undefined;
  const suggested = pkg || !pdf ? [] : await suggestAttachments(kase.id, cycle.id);
  const langMismatch = kase.conclusionLang && kase.lang && kase.conclusionLang !== kase.lang;

  return (
    <>
      <nav className="mb-3 text-[13px] text-ink-3">
        <Link href="/registry" className="hover:text-petrol">Реестр</Link> <span aria-hidden>/</span> Дело №{formatBase(kase.number)}
      </nav>
      <PageHeader
        serif
        title={
          <>
            <span className="doc-number">№ {formatBase(kase.number)}</span>
            <span className="mx-3 text-ink-4">—</span>
            {kase.applicant}
          </>
        }
        lead={kase.summary ?? undefined}
        actions={
          <>
            <Badge tone={caseTone(kase.state)}>{CASE_STATE_LABEL[kase.state as CaseState]}</Badge>
            {d.cycles.length > 1 && <Badge tone="info">Циклов: {d.cycles.length}</Badge>}
          </>
        }
      />

      {d.cycles.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-ink-3">Цикл рассмотрения:</span>
          {d.cycles.map((c) => (
            <Link key={c.id} href={`/cases/${caseId}?cycle=${c.id}&tab=${tab}`} className={c.id === cycle.id ? "rounded bg-petrol px-2 py-0.5 text-white" : "rounded px-2 py-0.5 text-petrol hover:bg-petrol-50"}>
              {c.number}
              {c.supplementary ? ", дополнительный" : ""}
            </Link>
          ))}
        </div>
      )}

      <Tabs base={base} active={tab} tabs={TABS.map((x) => ({ ...x, count: x.key === "materials" ? d.documents.length : x.key === "mail" ? d.messages.length : null }))} />

      <div className="mt-6">
        {tab === "overview" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-6">
              {d.tasks.length > 0 && (
                <div className="space-y-2">
                  {d.tasks.map((x) => (
                    <Notice key={x.id} tone="warn" title={x.title}>
                      {x.detail}
                    </Notice>
                  ))}
                </div>
              )}
              {!d.completeness.complete && (
                <Notice tone="bad" title="Поступление не завершено">
                  {d.completeness.messages
                    .filter((m) => !m.summary.complete)
                    .map((m) => (
                      <span key={m.messageId} className="block">
                        «{m.subject}»: {m.summary.label}
                      </span>
                    ))}
                  Передача дела исполнителю заблокирована до сохранения всех вложений или их исключения с основанием.
                </Notice>
              )}
              <NextStep {...{ d, cycle, chair, kase, executors, activeAssignment, drafts, t, finalVersion, card, pdf, signs, pkg, suggested, langMismatch: !!langMismatch, name }} />
              <Section title="Сведения об обращении">
                <KV
                  items={[
                    ["Номер дела", <span key="n" className="doc-number">{formatBase(kase.number)} ({kase.year})</span>],
                    ["Письмо РКА", kase.rkaNumber ? `№ ${kase.rkaNumber}${kase.rkaDate ? ` от ${fmtDate(kase.rkaDate)}` : ""}` : null],
                    ["Поступило на почту комиссии", fmtDate(kase.receivedAt, true)],
                    ["Язык обращения", kase.lang ? `${LANG_LABEL[kase.lang as "ru" | "kk"]}${kase.langConfirmed ? "" : " (определён автоматически)"}` : <Badge key="l" tone="warn">Требует выбора</Badge>],
                    ["Исполнитель", kase.executorId ? name(kase.executorId) : null],
                    ["Председатель", name(kase.chairId)],
                  ]}
                />
              </Section>
              <CaseFieldsEditor
                caseId={kase.id}
                version={kase.version}
                collegium={kase.collegium}
                collegiumCandidates={(kase.collegiumCandidates as string[]) ?? []}
                collegiumSource={kase.collegiumSource}
                summary={kase.summary}
                summarySource={kase.summarySource}
                summaryMachine={kase.summaryMachine && !kase.summaryManual}
                lang={kase.lang as "ru" | "kk" | null}
              />
            </div>
            <aside>
              <Section title="Маршрут дела" aside={<span className="text-[12px] text-ink-3">Цикл {cycle.number}</span>}>
                <RouteRail steps={route} />
              </Section>
            </aside>
          </div>
        )}

        {tab === "materials" && (
          <div className="space-y-6">
            {(Object.keys(DOC_CATEGORY_LABEL) as DocCategory[]).map((cat) => {
              const items = d.documents.filter((x) => x.d.category === cat);
              if (!items.length) return null;
              return (
                <Section key={cat} title={DOC_CATEGORY_LABEL[cat]} aside={<span className="text-[12.5px] text-ink-3 tnum">{items.length}</span>}>
                  <DocTable items={items} cycles={d.cycles} />
                </Section>
              );
            })}
            {d.documents.length === 0 && <Empty title="Материалов пока нет">Документы появятся после приобщения писем и их вложений.</Empty>}
          </div>
        )}

        {tab === "mail" && (
          <Section title="Переписка по делу" aside={<span className="text-[12.5px] text-ink-3">в порядке поступления</span>}>
            <ol className="divide-y divide-line">
              {d.messages.map((m) => {
                const man = d.manifests.get(m.id)!;
                return (
                  <li key={m.id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium text-ink">{m.subject || "(без темы)"}</p>
                        <p className="mt-0.5 text-[12.5px] text-ink-3">
                          {m.direction === "in" ? `От ${m.fromAddr}` : `Кому ${m.toAddrs.join(", ")}`}. Получено {fmtDate(m.receivedAt, true)}
                          {m.sentAt && `, отправлено ${fmtDate(m.sentAt, true)}`}
                          {m.addedLate && ", добавлено позднее"}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Badge tone={man.complete ? "ok" : "bad"}>{man.declared ? man.label : "Без вложений"}</Badge>
                        <Badge>{INTAKE_STATE_LABEL[m.intakeState as IntakeState]}</Badge>
                      </div>
                    </div>
                    {m.bodyText && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[13px] text-petrol">Показать письмо целиком</summary>
                        <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-3 font-sans text-[13.5px] leading-relaxed text-ink-2">{m.bodyText}</pre>
                      </details>
                    )}
                    <ul className="mt-2 space-y-1">
                      {d.attachments
                        .filter((a) => a.messageId === m.id && !a.inline)
                        .map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                            <span className="text-ink-2">{a.filename}</span>
                            <span className="text-ink-4">{fmtSize(a.size)}</span>
                            <Badge tone={a.status === "verified" ? "ok" : a.status === "excluded" ? "neutral" : "bad"}>{ATT[a.status] ?? a.status}</Badge>
                            {a.reason && <span className="text-ink-3">{a.reason}</span>}
                          </li>
                        ))}
                    </ul>
                    <p className="mt-2 text-[12px] text-ink-4">
                      Gmail ID <Hash value={m.providerMessageId} chars={16} />
                    </p>
                  </li>
                );
              })}
            </ol>
          </Section>
        )}

        {tab === "assignments" && (
          <div className="space-y-6">
            {cycleAssignments.length === 0 && <Empty title="Поручений по этому циклу нет">Назначьте исполнителя на вкладке «Обзор».</Empty>}
            {[...cycleAssignments].reverse().map((a) => (
              <Section
                key={a.id}
                title={`${a.kind === "finalization" ? "Поручение на финализацию" : "Поручение"}: ${name(a.executorId)}`}
                aside={<Badge tone={a.state === "text_on_approval" ? "seal" : a.state === "access_error" ? "bad" : ["sent", "done", "draft_submitted"].includes(a.state) ? "ok" : "petrol"}>{ASSIGNMENT_STATE_LABEL[a.state as AssignmentState]}</Badge>}
              >
                <KV
                  cols={3}
                  items={[
                    ["Назначено председателем", fmtDate(a.assignedAt, true)],
                    ["Срок", a.extendedUntil ? `${fmtDate(a.extendedUntil)} (продлено; было ${fmtDate(a.deadline)})` : fmtDate(a.deadline)],
                    ["Язык письма", LANG_LABEL[a.lang as "ru" | "kk"]],
                    ["Рабочий доступ", a.accessResult ? ((a.accessResult as { workspace?: boolean }).workspace ? "Выдан и проверен, корень дела закрыт" : "Не подтверждён") : "Не выдан"],
                    ["Письмо исполнителю", a.sentAt ? `Отправлено ${fmtDate(a.sentAt, true)}` : "Не отправлено"],
                    ["Хеш текста", <Hash key="h" value={a.letterHash} />],
                  ]}
                />
                {a.state === "text_on_approval" && chair ? (
                  <div className="mt-5">
                    <AssignmentReview
                      caseId={kase.id}
                      assignment={{ id: a.id, version: a.version, subject: a.letterSubject ?? "", text: a.letterText ?? "", hash: a.letterHash ?? "", to: d.users.find((x) => x.id === a.executorId)?.email ?? "", lang: a.lang, deadline: a.extendedUntil ?? a.deadline ?? "", link: a.workspaceLink ?? "", materials: ((a.materialVersionIds as string[]) ?? []).length }}
                    />
                  </div>
                ) : (
                  a.letterText && (
                    <details className="mt-4">
                      <summary className="cursor-pointer text-[13px] text-petrol">Текст письма</summary>
                      <p className="mt-2 text-[13px] font-medium text-ink">{a.letterSubject}</p>
                      <pre className="mt-1 whitespace-pre-wrap rounded-md bg-sunken p-3 font-sans text-[13.5px] leading-relaxed text-ink-2">{a.letterText}</pre>
                    </details>
                  )
                )}
              </Section>
            ))}
          </div>
        )}

        {tab === "review" && (
          <div className="space-y-6">
            <Section title={`Рассмотрение, цикл ${cycle.number}`} aside={<Badge tone="petrol">{CYCLE[cycle.state] ?? cycle.state}</Badge>}>
              <KV
                cols={3}
                items={[
                  ["Предварительное одобрение", cycle.preapprovedAt ? `${fmtDate(cycle.preapprovedAt, true)}, ${name(cycle.preapprovedBy)}` : null],
                  ["Голосование открыто", fmtDate(cycle.openedAt, true)],
                  ["Окончание", fmtDate(cycle.closesAt, true)],
                  ["Закрыто", fmtDate(cycle.closedAt, true)],
                  ["Приглашения", inv.total ? `Отправлено ${inv.sent} из ${inv.total}, открыли ${inv.opened}${inv.pending ? `, в очереди ${inv.pending}` : ""}` : null],
                  ["Проект на голосовании", <Hash key="d" value={(cycle.frozenManifest as { draft?: { sha256?: string } } | null)?.draft?.sha256 ?? null} />],
                  ["Хеш протокола", <Hash key="p" value={cycle.protocolHash} />],
                ]}
              />
            </Section>
            {t && (
              <Section title="Итоги голосования" aside={<Badge tone={t.outcome === "accepted" ? "ok" : t.outcome === "undetermined" ? "warn" : "bad"}>{OUTCOME_LABEL[t.outcome]}</Badge>}>
                <dl className="grid grid-cols-3 gap-4 sm:grid-cols-6">
                  {[
                    ["Состав", t.composition],
                    ["Участвовали", t.participated],
                    ["За", t.for],
                    ["Против", t.against],
                    ["Воздержался", t.abstain],
                    ["Не участвовал", t.notParticipated],
                  ].map(([k, v]) => (
                    <div key={k as string}>
                      <dt className="text-[12.5px] text-ink-3">{k}</dt>
                      <dd className="text-[22px] font-semibold text-ink tnum">{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 text-[13px] text-ink-2">{t.quorumRuleText}. {t.quorumReached ? "Кворум достигнут." : "Кворум не достигнут."}</p>
                <p className="mt-1 text-[13px] text-ink-2">{t.decisionRuleText}.</p>
                {t.errors.length > 0 && <p className="mt-2 text-[13px] text-bad">{t.errors.join("; ")}</p>}
                {cycle.protocolVersionId && (
                  <p className="mt-3 text-[13px]">
                    <a className="text-petrol hover:underline" href={`/api/files/${cycle.protocolVersionId}?inline=1`} target="_blank">
                      Открыть протокол (PDF)
                    </a>
                  </p>
                )}
              </Section>
            )}
            {cycle.state === "voting" && <VoteProgress d={d} cycleId={cycle.id} />}
            <Section title="Проекты заключения">{drafts.length ? <DocTable items={drafts} cycles={d.cycles} /> : <p className="text-[14px] text-ink-3">Проект ещё не поступил от исполнителя.</p>}</Section>
          </div>
        )}

        {tab === "signatures" && (
          <div className="space-y-6">
            {!pdf ? (
              <Empty title="PDF для подписи ещё не подготовлен">Сначала утвердите окончательную редакцию на вкладке «Обзор».</Empty>
            ) : (
              <Section title={`${cycle.supplementary ? "Дополнительное заключение" : "Заключение"} № ${cycle.conclusionNumber}`} aside={<Badge tone={pdf.v.state === "signed" ? "seal" : "petrol"}>{DOC_STATE_LABEL[pdf.v.state as DocVersionState]}</Badge>}>
                <KV
                  cols={3}
                  items={[
                    ["Файл", <a key="f" className="text-petrol hover:underline" href={`/api/files/${pdf.v.id}?inline=1`} target="_blank">{pdf.v.filename}</a>],
                    ["SHA-256 PDF", <Hash key="s" value={pdf.v.sha256} />],
                    ["Размещение QR", (pdf.v.generator as { qrPlacement?: string } | null)?.qrPlacement === "new_page" ? "На следующей странице" : "В конце текста, на той же странице"],
                    ["Карточка проверки", card ? <a key="c" className="text-petrol hover:underline" href={`/v/${card.token}?h=${card.manifestHash.slice(0, 16)}`} target="_blank">Открыть по QR</a> : null],
                    ["Хеш манифеста", <Hash key="m" value={card?.manifestHash} />],
                    ["Утверждено", `${fmtDate(cycle.approvedAt, true)}, ${name(cycle.approvedBy)}`],
                  ]}
                />
              </Section>
            )}
            {signs.length > 0 && (
              <Section title="Сеансы подписания">
                <div className="overflow-x-auto">
                  <table className="w-full text-[13.5px]">
                    <thead className="text-left text-[12.5px] text-ink-3">
                      <tr>
                        <th scope="col" className="py-2 pr-4 font-medium">Создан</th>
                        <th scope="col" className="py-2 pr-4 font-medium">Состояние</th>
                        <th scope="col" className="py-2 pr-4 font-medium">Подпись получена</th>
                        <th scope="col" className="py-2 pr-4 font-medium">Регистрация</th>
                        <th scope="col" className="py-2 font-medium">Проверка</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {signs.map((s) => {
                        const v = s.verification as { cryptoValid?: boolean | null; trustChecked?: boolean | null; unavailable?: boolean } | null;
                        return (
                          <tr key={s.id}>
                            <td className="py-2 pr-4 tnum">{fmtDate(s.createdAt, true)}</td>
                            <td className="py-2 pr-4"><Badge tone={s.state === "verified" ? "seal" : ["error", "expired", "refused", "auth_required", "needs_reconcile"].includes(s.state) ? "bad" : "neutral"}>{SIGN_STATE_LABEL[s.state as SignSessionState]}</Badge></td>
                            <td className="py-2 pr-4 tnum">{fmtDate(s.receivedAt, true) ?? "—"}</td>
                            <td className="py-2 pr-4">{s.registrationId ? <Hash value={s.registrationId} /> : "—"}</td>
                            <td className="py-2">{!v ? "—" : v.unavailable ? "Проверка недоступна" : v.cryptoValid ? (v.trustChecked ? "Подпись корректна, доверие проверено" : "Подпись корректна, доверие не проверено") : v.cryptoValid === false ? "Подпись не соответствует документу" : "Тестовая подпись"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
          </div>
        )}

        {tab === "outgoing" && (
          <div className="space-y-6">
            {d.outgoings.length === 0 && <Empty title="Исходящих по делу нет">Поручения исполнителю и комплекты в РКА появятся здесь после утверждения.</Empty>}
            {[...d.outgoings].reverse().map((o) => (
              <Section key={o.id} title={o.kind === "rka_package" ? `Комплект в РКА, исх. № ${o.numberDisplay}` : o.kind === "assignment" ? "Поручение исполнителю" : "Уведомление"} aside={<Badge tone={outTone(o.state)}>{OUTGOING_STATE_LABEL[o.state as OutgoingState]}</Badge>}>
                <KV
                  cols={3}
                  items={[
                    ["От", o.fromAddr],
                    ["Кому", o.toAddrs.join(", ")],
                    ["Язык", o.lang ? LANG_LABEL[o.lang as "ru" | "kk"] : null],
                    ["Тема", o.subject],
                    ["Отправлено", o.sentAt ? fmtDate(o.sentAt, true) : null],
                    ["ID у провайдера", <Hash key="p" value={o.providerMessageId} chars={16} />],
                  ]}
                />
                {(o.manifest as { name: string; size: number; sha256: string; role: string }[]).length > 0 && (
                  <ul className="mt-4 divide-y divide-line rounded-md border border-line">
                    {(o.manifest as { name: string; size: number; sha256: string; role: string; versionId: string }[]).map((m) => (
                      <li key={m.versionId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13.5px]">
                        <a href={`/api/files/${m.versionId}`} className="text-petrol hover:underline">{m.name}</a>
                        <span className="flex items-center gap-3 text-ink-3">
                          {fmtSize(m.size)} <Hash value={m.sha256} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {o.state === "draft" && o.kind === "rka_package" && chair && (
                  <div className="mt-5">
                    <PackagePanel caseId={kase.id} outgoing={{ id: o.id, version: o.version, hash: o.packageHash ?? "", subject: o.subject, body: o.bodyText, to: o.toAddrs, from: o.fromAddr, lang: o.lang ?? "ru", number: o.numberDisplay ?? "" }} draftOptions={drafts.filter((x) => x.v.format === "docx").map((x) => ({ id: x.v.id, name: x.v.filename ?? x.d.title }))} included={(o.manifest as { role: string; versionId: string }[]).filter((m) => m.role === "draft_attachment").map((m) => m.versionId)} langMismatch={!!langMismatch} />
                  </div>
                )}
                {o.state === "unknown_result" && <UnknownSendPanel caseId={kase.id} outgoingId={o.id} needsDecision={!!(o.reconcile as { needsDecision?: boolean } | null)?.needsDecision} />}
                {o.rejectedReason && <p className="mt-3 text-[13px] text-bad">Отклонено: {o.rejectedReason}</p>}
              </Section>
            ))}
          </div>
        )}

        {tab === "history" && (
          <Section title="Хронология событий" aside={<span className="text-[12.5px] text-ink-3">журнал аудита по делу</span>}>
            <ol className="divide-y divide-line">
              {d.audits.map((a) => (
                <li key={a.id} className="grid gap-1 py-2.5 sm:grid-cols-[150px_1fr_auto] sm:gap-4">
                  <span className="text-[12.5px] text-ink-3 tnum">{fmtDate(a.at, true)}</span>
                  <span className="text-[13.5px] text-ink">
                    {ACTION[a.action] ?? a.action}
                    {a.basis && <span className="text-ink-3">. Основание: {a.basis}</span>}
                  </span>
                  <span className="text-[12.5px] text-ink-3">
                    {a.actorLabel}
                    {a.actorType !== "user" && " (сервис)"}
                    {a.result !== "ok" && <Badge tone="bad" className="ml-2">{a.result === "denied" ? "отказ" : "ошибка"}</Badge>}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>
    </>
  );
}

type D = NonNullable<Awaited<ReturnType<typeof caseDetail>>>;

function NextStep(p: {
  d: D;
  cycle: D["cycles"][number];
  chair: boolean;
  kase: D["kase"];
  executors: D["users"];
  activeAssignment: D["assignments"][number] | undefined;
  drafts: D["documents"];
  t: Tally | null;
  finalVersion: D["documents"][number] | undefined;
  card: D["cards"][number] | undefined;
  pdf: D["documents"][number] | undefined;
  signs: D["signs"];
  pkg: D["outgoings"][number] | undefined;
  suggested: Awaited<ReturnType<typeof suggestAttachments>>;
  langMismatch: boolean;
  name: (id?: string | null) => string;
}) {
  const { d, cycle, chair, kase, activeAssignment: a, drafts, t, card, pdf, signs, pkg } = p;
  const lastSign = signs[signs.length - 1];

  // Назначение исполнителя
  if (!a || (cycle.supplementary && !d.assignments.some((x) => x.cycleId === cycle.id))) {
    return chair ? (
      <AssignForm caseId={kase.id} lang={kase.lang as "ru" | "kk" | null} blocked={!d.completeness.complete} members={p.executors.map((x) => ({ id: x.id, name: x.fullName, ready: !!x.firstName }))} />
    ) : (
      <Notice title="Ожидается назначение исполнителя председателем">Секретарь может подготовить кандидатуру, но доступ выдаётся только по решению председателя.</Notice>
    );
  }
  if (a.state === "text_on_approval") {
    return (
      <Notice tone="seal" title="Черновик поручения ждёт утверждения председателем">
        Рабочий доступ исполнителю уже выдан, письмо не отправлено. <Link className="text-petrol underline" href={`/cases/${kase.id}?tab=assignments`}>Открыть текст поручения</Link>
      </Notice>
    );
  }
  if (["sending", "approved_to_send"].includes(a.state)) return <Notice title="Поручение отправляется">Статус обновится после подтверждения почтовым провайдером.</Notice>;
  if (a.state === "access_error") return <Notice tone="bad" title="Ошибка выдачи доступа">Проверьте адрес исполнителя в составе комиссии и назначьте заново.</Notice>;

  // Проект и предварительное одобрение
  if (cycle.state === "preparation") {
    if (!drafts.length) return <Notice title="Ожидается проект заключения от исполнителя">Проект придёт ответным письмом на почту комиссии и будет приобщён автоматически. Срок — {fmtDate(a.extendedUntil ?? a.deadline)}.</Notice>;
    return chair ? <PreapprovePanel caseId={kase.id} cycleId={cycle.id} version={cycle.version} drafts={drafts.map((x) => ({ id: x.v.id, name: x.v.filename ?? x.d.title, at: x.v.createdAt.toISOString(), sha: x.v.sha256 ?? "" }))} /> : <Notice title="Проект на предварительной проверке председателя" />;
  }
  if (cycle.state === "preapproved") {
    return chair ? <OpenVotingForm caseId={kase.id} cycleId={cycle.id} version={cycle.version} materials={d.documents.filter((x) => ["incoming_original", "supplement"].includes(x.d.category)).map((x) => ({ id: x.v.id, name: x.v.filename ?? x.d.title }))} /> : <Notice title="Проект предварительно одобрен — ожидается открытие голосования" />;
  }
  if (cycle.state === "voting") {
    return chair ? <ClosePanel caseId={kase.id} cycleId={cycle.id} version={cycle.version} closesAt={cycle.closesAt?.toISOString() ?? null} /> : <Notice title="Идёт голосование" />;
  }
  if (cycle.state === "closed" && !cycle.finalRoute) {
    if (t?.outcome !== "accepted") return <Notice tone="warn" title={t ? OUTCOME_LABEL[t.outcome] : "Протокол не сформирован"}>{t?.outcome === "undetermined" ? "Правило определения решения не зафиксировано. Укажите его по Положению в администрировании; прошлые протоколы при этом не пересчитываются. Для нового рассмотрения откройте новый цикл." : "Продолжение возможно только через новый цикл рассмотрения."}</Notice>;
    return chair ? <FinalRoutePanel caseId={kase.id} cycleId={cycle.id} version={cycle.version} /> : <Notice title="Председатель выбирает маршрут финализации" />;
  }
  if (cycle.state === "closed" && cycle.finalRoute && !cycle.approvedAt) {
    if (cycle.finalRoute === "rework" && (!cycle.finalVersionId || cycle.finalVersionId === cycle.draftVersionId)) {
      return <Notice title="Ожидается окончательная редакция от исполнителя">Она придёт на почту комиссии и будет приобщена как новая версия; затем председатель сверит отличия с проголосованной версией.</Notice>;
    }
    return chair ? <ApproveFinalPanel caseId={kase.id} cycleId={cycle.id} version={cycle.version} route={cycle.finalRoute as "as_is" | "rework"} finalVersion={p.finalVersion ? { id: p.finalVersion.v.id, name: p.finalVersion.v.filename ?? "", sha: p.finalVersion.v.sha256 ?? "" } : null} votedVersionId={cycle.draftVersionId} /> : <Notice title="Окончательная редакция на утверждении председателя" />;
  }
  if (cycle.approvedAt && !pdf) return chair ? <PreparePdfPanel caseId={kase.id} cycleId={cycle.id} version={cycle.version} /> : <Notice title="Готовится PDF с QR" />;
  if (pdf && pdf.v.state !== "signed") return chair ? <SignPanel caseId={kase.id} versionId={pdf.v.id} lastSession={lastSign ? { id: lastSign.id, state: lastSign.state } : null} /> : <Notice tone="seal" title="Ожидается личная ЭЦП председателя" />;
  if (pdf && pdf.v.state === "signed" && !pkg) {
    const verified = signs.some((s) => s.state === "verified");
    if (!verified) return <Notice tone="warn" title="Подпись получена, проверка не завершена">Комплект в РКА будет доступен после завершения проверки ЭЦП.</Notice>;
    return <PreparePackageForm caseId={kase.id} cycleId={cycle.id} lang={kase.lang as "ru" | "kk" | null} langMismatch={p.langMismatch} suggestions={p.suggested.map((x) => ({ id: x.v.id, name: x.v.filename ?? x.d.title }))} />;
  }
  if (pkg && pkg.state === "draft") return <Notice tone="seal" title={`Комплект исх. № ${pkg.numberDisplay} ждёт согласия председателя`}><Link className="text-petrol underline" href={`/cases/${kase.id}?tab=outgoing`}>Открыть комплект и опись</Link></Notice>;
  if (pkg && pkg.state === "sent") return <Notice tone="ok" title={`Направлено в РКА ${fmtDate(pkg.sentAt, true)}`}>Исх. № {pkg.numberDisplay}. Отправка подтверждена провайдером{pkg.reconcile && (pkg.reconcile as { mode?: string }).mode === "dry-run" ? " (тестовый транспорт: письмо наружу не уходило)" : ""}.</Notice>;
  if (pkg && pkg.state === "unknown_result") return <Notice tone="bad" title="Результат отправки неизвестен">Идёт сверка отправленных писем. Повторная отправка не выполняется, пока сверка не установит, что письма нет.</Notice>;
  if (card && pkg) return <Notice title={OUTGOING_STATE_LABEL[pkg.state as OutgoingState]} />;
  return null;
}

function VoteProgress({ d, cycleId }: { d: D; cycleId: string }) {
  const c = d.cycles.find((x) => x.id === cycleId)!;
  const snap = (c.eligibleSnapshot as { userId: string; fullName: string }[]) ?? [];
  const votes = d.votes.filter((v) => v.cycleId === cycleId);
  return (
    <Section title="Ход голосования" aside={<span className="text-[13px] text-ink-2 tnum">{votes.length} из {snap.length}</span>}>
      <div className="h-2 overflow-hidden rounded-full bg-sunken">
        <div className="h-full bg-petrol" style={{ width: `${snap.length ? (votes.length / snap.length) * 100 : 0}%` }} />
      </div>
      <p className="mt-2 text-[13px] text-ink-3">Индивидуальные голоса видны в протоколе после закрытия голосования. Молчание и непрочитанное письмо не считаются голосом.</p>
    </Section>
  );
}

function DocTable({ items, cycles }: { items: D["documents"]; cycles: D["cycles"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13.5px]">
        <thead className="text-left text-[12.5px] text-ink-3">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">Документ</th>
            <th scope="col" className="py-2 pr-4 font-medium">Версия</th>
            <th scope="col" className="py-2 pr-4 font-medium">Состояние</th>
            <th scope="col" className="py-2 pr-4 font-medium">Размер</th>
            <th scope="col" className="py-2 pr-4 font-medium">SHA-256</th>
            <th scope="col" className="py-2 font-medium">Добавлено</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((x) => (
            <tr key={x.v.id}>
              <td className="py-2 pr-4">
                <a className="text-petrol hover:underline" href={`/api/files/${x.v.id}${x.v.format === "pdf" ? "?inline=1" : ""}`} target={x.v.format === "pdf" ? "_blank" : undefined}>
                  {x.v.filename ?? x.d.title}
                </a>
                {x.d.cycleId && cycles.length > 1 && <span className="ml-2 text-[12px] text-ink-4">цикл {cycles.find((c) => c.id === x.d.cycleId)?.number}</span>}
              </td>
              <td className="py-2 pr-4 tnum">{x.v.version}</td>
              <td className="py-2 pr-4"><Badge tone={x.v.state === "signed" ? "seal" : "neutral"}>{DOC_STATE_LABEL[x.v.state as DocVersionState]}</Badge></td>
              <td className="py-2 pr-4 text-ink-3 tnum">{fmtSize(x.v.size)}</td>
              <td className="py-2 pr-4"><Hash value={x.v.sha256} /></td>
              <td className="py-2 text-ink-3 tnum">{fmtDate(x.v.createdAt, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ATT: Record<string, string> = { pending: "Ожидает загрузки", downloading: "Загружается", stored: "Сохранено, не проверено", verified: "Сохранено и проверено", rejected: "Отклонено", encrypted: "Зашифровано", unavailable: "Недоступно", quarantine: "Карантин", excluded: "Исключено с основанием" };
const CYCLE: Record<string, string> = { preparation: "Подготовка проекта", preapproved: "Предварительно одобрен", voting: "Идёт голосование", closed: "Голосование завершено", finalized: "Направлено" };
const ACTION: Record<string, string> = {
  "mail.ingest": "Письмо получено и разобрано",
  "case.register": "Обращение зарегистрировано",
  "case.attach": "Письмо приобщено к делу",
  "case.attach_auto": "Письмо приобщено автоматически",
  "case.update_fields": "Изменены сведения обращения",
  "assignment.assign": "Председатель назначил исполнителя",
  "access.grant": "Выдан и проверен рабочий доступ",
  "access.revoke": "Отозван доступ прежнего исполнителя",
  "assignment.edit_letter": "Изменён текст поручения",
  "assignment.approve_send": "Председатель утвердил поручение к отправке",
  "assignment.reject": "Председатель отклонил черновик поручения",
  "assignment.extend": "Продлён срок",
  "outgoing.sent": "Письмо отправлено, провайдер подтвердил",
  "outgoing.unknown_result": "Результат отправки неизвестен",
  "outgoing.reconcile": "Сверка отправленных",
  "outgoing.error": "Ошибка отправки",
  "outgoing.approval_stale": "Разрешение на отправку устарело",
  "draft.preapprove": "Проект предварительно одобрен",
  "draft.preapprove_rework": "Проект возвращён на доработку",
  "cycle.open_vote": "Открыто обсуждение и голосование",
  "vote.cast": "Подан голос",
  "cycle.close_vote": "Голосование закрыто, сформирован протокол",
  "conclusion.route_as_is": "Проект принят без изменений как финал",
  "conclusion.route_rework": "Запрошена доработка финала",
  "conclusion.approve": "Председатель утвердил окончательную редакцию",
  "conclusion.prepare_pdf": "Подготовлен PDF с постоянным QR",
  "sign.start": "Начат сеанс подписания ЭЦП",
  "sign.verified": "ЭЦП проверена",
  "outgoing.prepare_rka": "Подготовлен комплект в РКА",
  "outgoing.update_files": "Изменён состав комплекта",
  "outgoing.approve_send": "Председатель согласовал комплект и направление в РКА",
  "outgoing.reject": "Комплект отклонён",
  "intake.exclude_item": "Вложение исключено из обязательного состава",
  "document.download": "Скачан документ",
};
