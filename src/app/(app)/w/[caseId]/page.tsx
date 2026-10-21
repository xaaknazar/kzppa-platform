import Link from "next/link";
import { requireUser } from "@/server/auth";
import { executorWorkspace } from "@/server/queries";
import { Badge, Hash, KV, Notice, PageHeader, Section, fmtDate, fmtSize } from "@/components/ui";
import { formatBase } from "@/domain/numbering";
import { ASSIGNMENT_STATE_LABEL } from "@/domain/states";
import type { AssignmentState } from "@/domain/types";

export const metadata = { title: "Рабочие материалы" };

/** ACL-01, ACL-02, FLOW-04: ограниченная рабочая область исполнителя внутри дела. */
export default async function WorkspacePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const u = await requireUser();
  const w = await executorWorkspace(u, caseId);

  if (!w) {
    return (
      <div className="max-w-[640px] pt-4">
        <Notice tone="warn" title="Нет доступа">
          Эта ссылка не относится к вашим поручениям, или доступ к материалам уже закрыт. Если вы считаете, что это ошибка, обратитесь к секретарю комиссии.
        </Notice>
        <p className="mt-4">
          <Link href="/my" className="text-[14px] text-petrol hover:underline">
            Перейти к моим поручениям
          </Link>
        </p>
      </div>
    );
  }

  const { kase, docs, assignment, org } = w;
  const num = formatBase(kase.number);
  const sender = org?.officialSender ?? "официальный адрес комиссии";
  const state = assignment?.state as AssignmentState | undefined;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" });
  const due = assignment ? (assignment.extendedUntil ?? assignment.deadline) : null;
  const overdue = !!due && due < today && !!state && ["sent", "receipt_confirmed", "in_work", "on_rework"].includes(state);
  const subject = `Проект заключения по делу №${num}, ${kase.applicant}`;

  return (
    <>
      <PageHeader
        serif
        title={
          <>
            Дело <span className="doc-number">№{num}</span>
          </>
        }
        lead={
          <>
            Обращение адвоката <span className="font-serif text-ink">{kase.applicant}</span>. Рабочие материалы исполнителя.
          </>
        }
        actions={state ? <Badge tone={state === "on_rework" ? "warn" : state === "done" ? "ok" : "petrol"}>{ASSIGNMENT_STATE_LABEL[state] ?? state}</Badge> : null}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Section title="Поручение">
            {assignment ? (
              <div className="space-y-4">
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{assignment.task}</p>
                <KV
                  items={[
                    [
                      "Срок",
                      <span key="d" className={overdue ? "font-medium text-bad tnum" : "tnum"}>
                        {fmtDate(due) ?? "Не установлен"}
                        {overdue ? ", просрочено" : ""}
                      </span>,
                    ],
                    [
                      "Продление",
                      assignment.extendedUntil ? (
                        <span key="e" className="tnum">
                          до {fmtDate(assignment.extendedUntil)}, первоначальный срок {fmtDate(assignment.deadline)}
                          {assignment.extensionBasis ? <span className="block text-[12.5px] text-ink-3">Основание: {assignment.extensionBasis}</span> : null}
                        </span>
                      ) : (
                        "Не продлевался"
                      ),
                    ],
                    ["Поручение направлено", <span key="s" className="tnum">{fmtDate(assignment.sentAt ?? assignment.assignedAt, true) ?? "—"}</span>],
                    ["Вид", assignment.kind === "finalization" ? "Окончательная редакция заключения" : "Проект заключения"],
                  ]}
                />
              </div>
            ) : (
              <p className="text-[14px] text-ink-3">Текст поручения пока не направлен. Материалы доступны для предварительного ознакомления.</p>
            )}
          </Section>

          <Section title="Материалы" aside={<span className="text-[13px] text-ink-3 tnum">{docs.length}</span>}>
            {docs.length === 0 ? (
              <p className="text-[14px] text-ink-3">Материалы ещё не переданы в рабочую область. Секретарь добавит их до отправки поручения.</p>
            ) : (
              <ul className="divide-y divide-line">
                {docs.map(({ d, v }) => (
                  <li key={v.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-[14px] text-ink">
                        {d.title}
                        {d.area === "discussion" && <span className="ml-2 align-middle text-[12px] text-ink-3">из обсуждения</span>}
                      </p>
                      <p className="mt-0.5 break-all text-[12.5px] text-ink-3">
                        {v.filename ?? "Файл"}, <span className="tnum">{fmtSize(v.size)}</span>, версия <span className="tnum">{v.version}</span>, добавлено <span className="tnum">{fmtDate(v.createdAt, true)}</span>
                      </p>
                      <p className="mt-1 text-[12px] text-ink-3">
                        SHA-256 <Hash value={v.sha256} />
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-3 text-[13.5px]">
                      <a href={`/api/files/${v.id}?inline=1`} target="_blank" rel="noopener" className="text-petrol hover:underline">
                        Открыть
                      </a>
                      <a href={`/api/files/${v.id}`} className="text-petrol hover:underline">
                        Скачать
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-petrol/30 bg-petrol-50 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink">Как направить проект</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-ink">
              Направьте проект заключения ответным письмом на <strong className="font-semibold break-all">{sender}</strong> в формате Word (DOCX) или PDF. Письмо будет автоматически приобщено к этому делу.
            </p>
            <p className="mt-3 text-[13px] text-ink-2">Укажите в теме письма номер дела:</p>
            <p className="mt-1 rounded-md border border-line bg-surface px-3 py-2 font-serif text-[14px] text-ink select-all">{subject}</p>
            <p className="mt-3 text-[12.5px] text-ink-3">Лучше всего ответить на письмо с поручением: так дело определится без ручного разбора.</p>
          </section>

          <Notice tone="info" title="Что доступно в этой области">
            Только материалы, переданные вам по поручению. Полная переписка дела, его корневая папка и материалы других исполнителей сюда не входят.
          </Notice>
        </div>
      </div>

      <p className="mt-8 max-w-[80ch] border-t border-line pt-4 text-[12.5px] text-ink-3">
        Исходные материалы защищены от изменения. Присланный вами проект сохраняется в деле как новая версия с собственным хешем; прежние версии остаются без изменений.
      </p>
    </>
  );
}
