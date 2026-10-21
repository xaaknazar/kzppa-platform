import Link from "next/link";
import { requireUser } from "@/server/auth";
import { discussion } from "@/server/queries";
import { can } from "@/domain/acl";
import { Badge, Hash, KV, Notice, PageHeader, Section, fmtDate, fmtSize } from "@/components/ui";
import { formatBase } from "@/domain/numbering";
import { VoteForm } from "./vote-form";

export const metadata = { title: "Голосование" };

const CHOICE_LABEL: Record<string, string> = { for: "За", against: "Против", abstain: "Воздержался" };

const CYCLE_STATE: Record<string, { label: string; tone: "neutral" | "petrol" | "ok" | "warn" }> = {
  preparation: { label: "Подготовка", tone: "neutral" },
  preapproved: { label: "Проект предварительно одобрен", tone: "neutral" },
  voting: { label: "Идёт голосование", tone: "petrol" },
  closed: { label: "Голосование завершено", tone: "neutral" },
  finalized: { label: "Голосование завершено", tone: "neutral" },
};

/** FLOW-05, FLOW-06, DEC-03: зафиксированный комплект обсуждения и личный голос. */
export default async function VotePage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await params;
  const u = await requireUser();
  const d = await discussion(u, cycleId);

  if (!d) {
    return (
      <div className="max-w-[640px] pt-4">
        <Notice tone="warn" title="Нет доступа к этому обсуждению">
          Ссылка относится к голосованию, в котором вы не участвуете, или срок доступа к нему закончился. Если вы считаете, что это ошибка, обратитесь к секретарю комиссии.
        </Notice>
        <p className="mt-4">
          <Link href="/votes" className="text-[14px] text-petrol hover:underline">
            Перейти к списку голосований
          </Link>
        </p>
      </div>
    );
  }

  const { cycle, kase, docs, myVote, votedCount, composition } = d;
  const manifest = cycle.frozenManifest as { draft: { versionId: string; sha256: string; filename: string }; materials: string[] } | null;
  const draft = manifest ? docs.find((x) => x.v.id === manifest.draft.versionId) : undefined;
  const materials = manifest ? docs.filter((x) => manifest.materials.includes(x.v.id)) : [];
  const state = CYCLE_STATE[cycle.state] ?? { label: cycle.state, tone: "neutral" as const };
  const expired = !!cycle.closesAt && cycle.closesAt.getTime() < Date.now();
  const canVote = can(u.principal, "vote.cast", { caseId: kase.id, cycleId: cycle.id });
  const votingOpen = cycle.state === "voting" && !expired;
  const pct = composition > 0 ? Math.min(100, Math.round((votedCount / composition) * 100)) : 0;

  return (
    <>
      <PageHeader
        serif
        title={
          <>
            Дело <span className="doc-number">№{formatBase(kase.number)}</span>
          </>
        }
        lead={
          <>
            Обращение адвоката <span className="font-serif text-ink">{kase.applicant}</span>.{" "}
            {cycle.supplementary ? "Дополнительное рассмотрение" : `Рассмотрение, цикл ${cycle.number}`}.
          </>
        }
        actions={<Badge tone={state.tone}>{state.label}</Badge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Section title="Проект заключения на голосование">
            {!manifest || !draft ? (
              <Notice tone="warn" title="Комплект обсуждения не зафиксирован">
                Проект ещё не передан на голосование. Голосовать можно только по зафиксированной версии.
              </Notice>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-[15px] font-medium text-ink">{draft.d.title}</p>
                  <p className="mt-0.5 break-all text-[13px] text-ink-3">{draft.v.filename ?? manifest.draft.filename}</p>
                </div>
                <KV
                  cols={3}
                  items={[
                    ["Версия", <span key="v" className="tnum">{draft.v.version}</span>],
                    ["Размер", <span key="s" className="tnum">{fmtSize(draft.v.size)}</span>],
                    ["SHA-256", <Hash key="h" value={draft.v.sha256 ?? manifest.draft.sha256} chars={16} />],
                  ]}
                />
                <div className="flex flex-wrap gap-2">
                  <a href={`/api/files/${draft.v.id}?inline=1`} target="_blank" rel="noopener" className="inline-flex h-10 items-center rounded-md bg-petrol px-4 text-[14px] font-medium text-white hover:bg-petrol-600">
                    Открыть для чтения
                  </a>
                  <a href={`/api/files/${draft.v.id}`} className="inline-flex h-10 items-center rounded-md border border-line-strong bg-surface px-4 text-[14px] font-medium text-ink hover:bg-sunken">
                    Скачать файл
                  </a>
                </div>
                <p className="text-[13px] text-ink-3">Голос относится именно к этой версии. Если проект существенно изменится, будет открыт новый цикл голосования.</p>
              </div>
            )}
          </Section>

          <Section title="Материалы дела для ознакомления" aside={<span className="text-[13px] text-ink-3 tnum">{materials.length}</span>}>
            {materials.length === 0 ? (
              <p className="text-[14px] text-ink-3">К обсуждению не приложены дополнительные материалы.</p>
            ) : (
              <ul className="divide-y divide-line">
                {materials.map(({ d: doc, v }) => (
                  <li key={v.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-[14px] text-ink">{doc.title}</p>
                      <p className="mt-0.5 break-all text-[12.5px] text-ink-3">
                        {v.filename ?? "Файл"}, <span className="tnum">{fmtSize(v.size)}</span>, версия <span className="tnum">{v.version}</span>
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
            <p className="mt-3 text-[12.5px] text-ink-3">Материалы доступны только для чтения. Корневая папка дела и переписка в обсуждение не входят.</p>
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Сроки и участие">
            <KV
              cols={1}
              items={[
                ["Голосование открыто", <span key="o" className="tnum">{fmtDate(cycle.openedAt, true) ?? "—"}</span>],
                [
                  cycle.state === "voting" ? "Срок голосования" : "Голосование закрыто",
                  <span key="c" className="tnum">
                    {cycle.state === "voting" ? (fmtDate(cycle.closesAt, true) ?? "Не установлен") : (fmtDate(cycle.closedAt, true) ?? "—")}
                  </span>,
                ],
              ]}
            />
            <div className="mt-4">
              <p className="text-[14px] text-ink tnum">
                Проголосовали {votedCount} из {composition}
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={composition} aria-valuenow={votedCount} aria-label="Ход голосования">
                <div className="h-full bg-petrol" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-2 text-[12.5px] text-ink-3">Показывается только количество. Кто и как голосовал, видно в протоколе в пределах полномочий.</p>
            </div>
          </Section>

          <Section title="Ваш голос">
            {myVote ? (
              <div className="space-y-3">
                <Notice tone="ok" title="Ваш голос учтён">
                  <span className="tnum">
                    {CHOICE_LABEL[myVote.choice] ?? myVote.choice}, подан {fmtDate(myVote.castAt, true)}.
                  </span>
                </Notice>
                {myVote.comment && (
                  <div>
                    <p className="text-[12.5px] text-ink-3">Замечание</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-[14px] text-ink">{myVote.comment}</p>
                  </div>
                )}
                {myVote.specialOpinion && (
                  <div>
                    <p className="text-[12.5px] text-ink-3">Особое мнение</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-[14px] text-ink">{myVote.specialOpinion}</p>
                  </div>
                )}
                <p className="text-[12.5px] text-ink-3">Голос привязан к версии проекта, по которой он подан, и не может быть изменён.</p>
              </div>
            ) : cycle.state === "closed" || cycle.state === "finalized" ? (
              <Notice tone="info" title="Голосование завершено">
                Вы не голосовали в этом цикле. В протоколе вы учтены как не участвовавший.
              </Notice>
            ) : cycle.state !== "voting" ? (
              <Notice tone="info" title="Голосование ещё не открыто">
                Председатель откроет голосование после предварительного одобрения проекта. Вы получите письмо.
              </Notice>
            ) : expired ? (
              <Notice tone="warn" title="Срок голосования истёк">
                Голос больше не принимается. Итоги подведёт председатель.
              </Notice>
            ) : !canVote ? (
              <Notice tone="info" title="Вы не голосуете в этом цикле">
                Вы можете ознакомиться с комплектом, но не входите в состав, имеющий право голоса на этот цикл.
              </Notice>
            ) : !draft ? (
              <Notice tone="warn" title="Голосовать пока нельзя">
                Проект не зафиксирован. Обратитесь к секретарю комиссии.
              </Notice>
            ) : (
              votingOpen && <VoteForm cycleId={cycle.id} />
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
