import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser, isStaff } from "@/server/auth";
import { extractCollegiumCandidates, machineSummary, toManifestItem } from "@/server/services/cases";
import { summarizeManifest } from "@/domain/manifest";
import { parseSubject } from "@/domain/matching";
import { detectLanguage } from "@/domain/language";
import { formatBase, normalizeRkaNumber } from "@/domain/numbering";
import { INTAKE_STATE_LABEL } from "@/domain/states";
import type { IntakeState } from "@/domain/types";
import { Badge, Hash, KV, Notice, PageHeader, Section, fmtDate, fmtSize, type Tone } from "@/components/ui";
import { AttachToCandidate, CaseSearchAttach, ExcludeAttachmentForm, RegisterCaseForm } from "./forms";

export const metadata = { title: "Письмо" };

/**
 * UI-02, MAIL-06..10, CASE-01..07. Письмо целиком, все вложения с состоянием,
 * проверка источника, кандидаты дел с основаниями и команды ручного решения.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ATT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Ожидает загрузки", tone: "neutral" },
  downloading: { label: "Загружается", tone: "neutral" },
  stored: { label: "Сохранено, проверка не завершена", tone: "warn" },
  verified: { label: "Сохранено и проверено", tone: "ok" },
  rejected: { label: "Отклонено", tone: "bad" },
  encrypted: { label: "Зашифровано", tone: "bad" },
  unavailable: { label: "Недоступно", tone: "bad" },
  quarantine: { label: "Карантин", tone: "bad" },
  excluded: { label: "Исключено с основанием", tone: "neutral" },
};

const INTAKE_TONE: Record<string, Tone> = {
  needs_review: "warn",
  incomplete: "warn",
  quarantine: "bad",
  access_error: "bad",
  matched: "petrol",
  verified: "info",
  attached: "ok",
};

const KIND_LABEL: Record<string, string> = {
  initial: "Обращение",
  supplement: "Дополнительные материалы",
  rework: "На доработку",
  executor_reply: "Ответ исполнителя",
  unknown: "Вид не определён",
};

const SIGNAL_KIND: Record<string, string> = {
  "Признак: initial": "Признак: обращение",
  "Признак: supplement": "Признак: дополнительные материалы",
  "Признак: rework": "Признак: на доработку",
  "Признак: executor_reply": "Признак: ответ исполнителя",
};

export default async function MessagePage({ params }: { params: Promise<{ messageId: string }> }) {
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

  const { messageId } = await params;
  if (!UUID.test(messageId)) notFound();
  const msg = await db.query.messages.findFirst({ where: and(eq(schema.messages.id, messageId), eq(schema.messages.organizationId, u.orgId)) });
  if (!msg) notFound();

  const [atts, org, caseList] = await Promise.all([
    db.query.attachments.findMany({ where: eq(schema.attachments.messageId, msg.id), orderBy: asc(schema.attachments.partId) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) }),
    db
      .select({ id: schema.cases.id, number: schema.cases.number, year: schema.cases.year, applicant: schema.cases.applicant, rkaNumber: schema.cases.rkaNumber, state: schema.cases.state })
      .from(schema.cases)
      .where(eq(schema.cases.organizationId, u.orgId))
      .orderBy(desc(schema.cases.year), desc(schema.cases.number))
      .limit(3000),
  ]);
  const caseById = new Map(caseList.map((c) => [c.id, c]));

  const manifest = summarizeManifest(atts.map(toManifestItem));
  const sc = readSourceCheck(msg.sourceCheck);
  const mv = readMatch(msg.match);
  const body = msg.bodyText?.trim() ? msg.bodyText : msg.bodyHtml ? htmlToText(msg.bodyHtml) : "";
  const bodyFromHtml = !msg.bodyText?.trim() && !!msg.bodyHtml;
  const parsed = parseSubject(msg.subject, body);
  const attachedCase = msg.caseId ? caseById.get(msg.caseId) : null;

  // Предложение по делу: явное «attach» или кандидаты.
  const candidates = [...mv.candidates];
  if (mv.kind === "attach" && mv.caseId && !candidates.some((c) => c.caseId === mv.caseId)) {
    candidates.unshift({ caseId: mv.caseId, caseNumber: caseById.get(mv.caseId)?.number ?? null, score: mv.confidence, reasons: mv.reasons });
  }
  const shownCandidates = candidates.filter((c) => caseById.has(c.caseId));

  // Машинные проекты полей карточки (CASE-02, CASE-07, DOC-01).
  const rkaNumber = normalizeRkaNumber(msg.subject) ?? normalizeRkaNumber(body.slice(0, 4000)) ?? "";
  const rkaDate = findRkaDate(`${msg.subject}\n${body.slice(0, 4000)}`);
  const collegiumCandidates = extractCollegiumCandidates(body);
  const summaryDraft = machineSummary(body) ?? "";
  const lang = detectLanguage(`${msg.subject}\n${body}`);

  // Признаки подозрительности, видимые прямо из заголовков (MAIL-10).
  const flags = [...sc.flags];
  if (msg.replyTo && !msg.replyTo.toLowerCase().includes(msg.fromAddr.toLowerCase())) flags.push(`Адрес для ответа (${msg.replyTo}) отличается от адреса отправителя`);
  const fromRka = !!org && msg.fromAddr.toLowerCase() === org.rkaAddress.toLowerCase();
  const suspicious = sc.suspicious || flags.length > 0;

  const open = !msg.caseId;
  const quarantine = msg.intakeState === "quarantine";

  return (
    <>
      <p className="mb-3 text-[13.5px]">
        <Link href="/inbox" className="text-petrol hover:underline">
          Разбор почты
        </Link>
      </p>
      <PageHeader
        title={msg.subject.trim() || "Без темы"}
        lead={
          <>
            {msg.fromName ? `${msg.fromName}, ` : ""}
            {msg.fromAddr}. Получено {fmtDate(msg.receivedAt ?? msg.processedAt, true) ?? "—"}.
          </>
        }
        actions={
          <>
            {msg.intakeKind && <Badge>{KIND_LABEL[msg.intakeKind] ?? msg.intakeKind}</Badge>}
            <Badge tone={INTAKE_TONE[msg.intakeState] ?? "neutral"}>{INTAKE_STATE_LABEL[msg.intakeState as IntakeState] ?? msg.intakeState}</Badge>
          </>
        }
      />

      <div className="space-y-4">
        {attachedCase && (
          <Notice tone="ok" title={<>Письмо приобщено к делу <span className="doc-number">№{formatBase(attachedCase.number)}</span>, {attachedCase.applicant}</>}>
            {msg.attachBasis && <p>Основание: {msg.attachBasis}</p>}
            <p className="mt-1">
              <Link href={`/cases/${attachedCase.id}`} className="text-petrol hover:underline">
                Открыть дело
              </Link>
            </p>
          </Notice>
        )}
        {quarantine && (
          <Notice tone="bad" title="Письмо в карантине">
            Вложения не переданы в работу. Проверьте источник и состав ниже. Если письмо подлинное, исключите проблемные вложения с основанием или дождитесь повторной загрузки, затем примите решение по делу.
          </Notice>
        )}
        {!manifest.complete && (
          <Notice tone="warn" title={`Не все вложения сохранены и проверены: ${manifest.verified} из ${manifest.declared}`}>
            Регистрация и приобщение возможны, но передача дела исполнителю будет заблокирована, пока все обязательные вложения не будут проверены или исключены с основанием (MAIL-08).
          </Notice>
        )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-6">
          <Section title="Письмо">
            <KV
              items={[
                ["От", <>{msg.fromName ? <>{msg.fromName} </> : null}<span className="text-ink-2">&lt;{msg.fromAddr}&gt;</span></>],
                ["Кому", msg.toAddrs.length ? msg.toAddrs.join(", ") : null],
                ["Копия", msg.ccAddrs.length ? msg.ccAddrs.join(", ") : null],
                ["Адрес для ответа", msg.replyTo],
                ["Отправлено (дата письма)", <span key="s" className="tnum">{fmtDate(msg.sentAt, true) ?? "—"}</span>],
                ["Получено ящиком комиссии", <span key="r" className="tnum">{fmtDate(msg.receivedAt, true) ?? "—"}</span>],
                ["Обработано платформой", <span key="p" className="tnum">{fmtDate(msg.processedAt, true) ?? "—"}</span>],
                ["Идентификатор письма", <Hash key="h" value={msg.internetMessageId ?? msg.providerMessageId} chars={24} />],
              ]}
            />
            {msg.addedLate && <p className="mt-3 text-[13px] text-ink-3">Письмо загружено позднее даты получения и встало в хронологию на своё историческое место.</p>}
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="mb-2 text-[13px] font-medium text-ink-2">Текст письма целиком</h3>
              {bodyFromHtml && <p className="mb-2 text-[12.5px] text-ink-3">Письмо пришло только в HTML. Показан извлечённый текст; разметка и внешние ресурсы не загружаются.</p>}
              {body.trim() ? (
                <div className="whitespace-pre-wrap break-words rounded-md bg-sunken px-4 py-3 text-[14px] leading-relaxed text-ink">{body}</div>
              ) : (
                <p className="text-[14px] text-ink-3">Текст письма пуст. Содержание — во вложениях.</p>
              )}
            </div>
          </Section>

          <Section
            title="Вложения"
            aside={<span className={manifest.complete ? "text-[13px] text-ok" : "text-[13px] text-warn"}>{manifest.label}</span>}
          >
            {atts.length === 0 ? (
              <p className="text-[14px] text-ink-3">В письме нет вложений.</p>
            ) : (
              <>
                <p className="mb-3 text-[13px] text-ink-3 tnum">
                  Обязательных {manifest.declared}, проверено {manifest.verified}, уникальных файлов {manifest.uniqueBlobs}, ожидают {manifest.pending}, с проблемами {manifest.problems}, исключено {manifest.excluded}, встроенных в текст {manifest.inline}.
                </p>
                <div className="-mx-5 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-[13.5px]">
                    <caption className="sr-only">Состав вложений письма</caption>
                    <thead className="bg-sunken text-[12.5px] text-ink-2">
                      <tr>
                        <th scope="col" className="px-5 py-2 font-medium">Файл</th>
                        <th scope="col" className="px-3 py-2 font-medium">Состояние</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Размер</th>
                        <th scope="col" className="px-3 py-2 font-medium">SHA-256</th>
                        <th scope="col" className="px-5 py-2 font-medium">Причина и основание</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {atts.map((a) => {
                        const st = ATT_STATUS[a.status] ?? { label: a.status, tone: "neutral" as Tone };
                        const ex = a.exclusion as { by?: string; basis?: string; at?: string } | null;
                        const required = !a.inline && !a.parentPartId;
                        const canExclude = open && required && a.status !== "verified" && a.status !== "excluded";
                        return (
                          <tr key={a.id} className="align-top">
                            <td className="px-5 py-3">
                              <span className="block break-all text-ink">{a.displayName ?? a.filename}</span>
                              <span className="block text-[12px] text-ink-3">
                                {a.mimeType}
                                {a.inline && ", встроено в текст письма"}
                                {a.parentPartId && ", элемент архива"}
                              </span>
                              {a.inline && <span className="mt-1 inline-block"><Badge>Не входит в обязательный состав</Badge></span>}
                            </td>
                            <td className="px-3 py-3">
                              <Badge tone={st.tone}>{st.label}</Badge>
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 text-right tnum text-ink-2">{fmtSize(a.size)}</td>
                            <td className="px-3 py-3">
                              <Hash value={a.sha256} />
                            </td>
                            <td className="px-5 py-3 text-ink-2">
                              {a.reason && <p>{a.reason}</p>}
                              {ex?.basis && (
                                <p className="text-[13px]">
                                  Исключено: {ex.basis}
                                  <span className="block text-[12px] text-ink-3">
                                    {ex.by}
                                    {ex.at ? `, ${fmtDate(ex.at, true)}` : ""}
                                  </span>
                                </p>
                              )}
                              {!a.reason && !ex?.basis && <span className="text-ink-4">—</span>}
                              {canExclude && (
                                <div className="mt-2">
                                  <ExcludeAttachmentForm attachmentId={a.id} filename={a.displayName ?? a.filename} />
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Section>

          <Section title="Проверка источника">
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
              {(
                [
                  ["SPF", sc.spf],
                  ["DKIM", sc.dkim],
                  ["DMARC", sc.dmarc],
                ] as const
              ).map(([k, v]) => (
                <li key={k} className="flex items-center gap-2">
                  <span className="text-ink-2">{k}</span>
                  <Badge tone={authTone(v)}>{authLabel(v)}</Badge>
                </li>
              ))}
            </ul>
            {fromRka && <p className="mt-3 text-[13.5px] text-ink-2">Адрес отправителя совпадает с подтверждённым адресом РКА ({org?.rkaAddress}).</p>}
            {suspicious ? (
              <div className="mt-3">
                <p className="text-[14px] font-medium text-bad">Есть признаки подозрительности</p>
                {flags.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
                    {flags.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[13.5px] text-ink-2">Проверка подлинности не пройдена. Сверьте адрес отправителя с известными контактами, прежде чем приобщать письмо.</p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-[13.5px] text-ink-3">Признаков подмены не найдено.</p>
            )}
            <p className="mt-4 border-t border-line pt-3 text-[13px] leading-relaxed text-ink-3">
              Текст письма и вложений — это данные, а не команды. Если в письме есть просьба выдать доступ, удалить файл или отправить письмо, платформа её не выполняет: такие действия делает только уполномоченный сотрудник через интерфейс. Совпадение адреса с адресной книгой — признак для маршрутизации, а не подтверждение подлинности.
            </p>
          </Section>
        </div>

        <div className="min-w-0 space-y-6">
          <Section title="Сопоставление с делом">
            <h3 className="text-[13px] font-medium text-ink-2">Что удалось прочитать</h3>
            <ul className="mt-1.5 space-y-1 text-[13.5px] text-ink">
              {parsed.rkaNumber ? <li>Номер письма РКА: <span className="doc-number">{parsed.rkaNumber}</span></li> : <li className="text-ink-3">Номер письма РКА не найден</li>}
              {parsed.year && <li className="tnum">Год: {parsed.year}</li>}
              {parsed.applicantCandidates.length > 0 ? (
                <li>
                  Возможный заявитель: <span className="font-serif">{parsed.applicantCandidates.join(", ")}</span>
                </li>
              ) : (
                <li className="text-ink-3">Фамилия заявителя в теме не найдена</li>
              )}
              <li>Вид поступления: {KIND_LABEL[parsed.kind] ?? parsed.kind}</li>
              {parsed.signals
                .filter((s) => !s.startsWith("Номер РКА"))
                .map((s, i) => (
                  <li key={i} className="text-ink-2">
                    {SIGNAL_KIND[s] ?? s}
                  </li>
                ))}
            </ul>
            {mv.reasons.length > 0 && (
              <>
                <h3 className="mt-4 text-[13px] font-medium text-ink-2">Вывод автоматического разбора</h3>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13.5px] text-ink">
                  {mv.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="mt-5 text-[13px] font-medium text-ink-2">Кандидаты</h3>
            {shownCandidates.length === 0 ? (
              <p className="mt-1.5 text-[13.5px] text-ink-3">{mv.kind === "new_case" ? "Существующее дело не найдено. Похоже на новое обращение — проверьте и зарегистрируйте его ниже." : "Подходящих дел не найдено. Найдите дело вручную или зарегистрируйте новое обращение."}</p>
            ) : (
              <ul className="mt-1.5 divide-y divide-line">
                {shownCandidates.map((c) => {
                  const k = caseById.get(c.caseId)!;
                  return (
                    <li key={c.caseId} className="py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <Link href={`/cases/${k.id}`} className="min-w-0 text-[14px] text-ink hover:text-petrol">
                          <span className="doc-number">№{formatBase(k.number)}</span> <span className="font-serif">{k.applicant}</span>
                        </Link>
                        {c.score != null && <span className="shrink-0 text-[13px] text-ink-3 tnum">уверенность {pct(c.score)}</span>}
                      </div>
                      {k.rkaNumber && <p className="text-[12.5px] text-ink-3">Письмо РКА {k.rkaNumber}</p>}
                      {c.reasons.length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">
                          {c.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      )}
                      {open && (
                        <div className="mt-2">
                          <AttachToCandidate messageId={msg.id} caseId={k.id} caseNumber={formatBase(k.number)} defaultBasis={c.reasons.join("; ")} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {open && (
              <div className="mt-5 border-t border-line pt-4">
                <h3 className="text-[13px] font-medium text-ink-2">Другое дело</h3>
                <p className="mt-0.5 text-[12.5px] text-ink-3">Найдите дело по номеру, фамилии заявителя или номеру письма РКА.</p>
                <div className="mt-2">
                  <CaseSearchAttach messageId={msg.id} cases={caseList.map((c) => ({ id: c.id, label: `${formatBase(c.number)}${c.year ? ` (${c.year})` : ""}, ${c.applicant}${c.rkaNumber ? `, РКА ${c.rkaNumber}` : ""}`, number: formatBase(c.number) }))} />
                </div>
              </div>
            )}
          </Section>

          {open && (
            <Section title="Зарегистрировать новое обращение">
              <RegisterCaseForm
                messageId={msg.id}
                manifestIncomplete={!manifest.complete}
                defaults={{
                  applicant: parsed.applicantCandidates[0] ?? "",
                  applicantOptions: parsed.applicantCandidates,
                  rkaNumber,
                  rkaDate: rkaDate ?? "",
                  summary: summaryDraft,
                  lang: lang.lang,
                  langMixed: lang.mixed,
                }}
                collegiumCandidates={collegiumCandidates}
              />
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

const pct = (s: number | null) => (s == null ? "" : `${Math.round(s <= 1 ? s * 100 : s)}%`);

function authTone(v: string | null): Tone {
  if (!v) return "neutral";
  if (/^pass/i.test(v)) return "ok";
  if (/fail|permerror/i.test(v)) return "bad";
  return "warn";
}
function authLabel(v: string | null) {
  if (!v) return "Нет данных";
  if (/^pass/i.test(v)) return "Пройдена";
  if (/softfail/i.test(v)) return "Мягкий отказ";
  if (/fail/i.test(v)) return "Не пройдена";
  if (/none|neutral/i.test(v)) return "Не настроена у отправителя";
  return v;
}

/** «от 12.10.2026» рядом с номером письма РКА → ISO-дата для поля формы (машинный проект). */
function findRkaDate(text: string): string | null {
  const m = text.match(/(?:от|ж\.?|күні)\s*(\d{1,2})[./](\d{1,2})[./](20\d{2})/i) ?? text.match(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/);
  if (!m) return null;
  const [dd, mm, yy] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Только текст: HTML письма не рендерится (внешние ресурсы, скрипты, подмена ссылок). */
function htmlToText(html: string) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Защитное чтение messages.match: {kind, reasons, caseId?, confidence?, candidates:[{caseId, caseNumber, score, reasons}]}. */
function readMatch(v: unknown) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
  const candidates = (Array.isArray(o.candidates) ? o.candidates : [])
    .flatMap((c) => {
      if (!c || typeof c !== "object") return [];
      const r = c as Record<string, unknown>;
      if (typeof r.caseId !== "string" || !UUID.test(r.caseId)) return [];
      return [{ caseId: r.caseId, caseNumber: num(r.caseNumber), score: num(r.score ?? r.confidence), reasons: strs(r.reasons) }];
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    kind: typeof o.kind === "string" ? o.kind : null,
    reasons: strs(o.reasons),
    caseId: typeof o.caseId === "string" && UUID.test(o.caseId) ? o.caseId : null,
    confidence: num(o.confidence),
    candidates,
  };
}

/** Защитное чтение messages.source_check. */
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

