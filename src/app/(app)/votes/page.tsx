import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { openVotesFor } from "@/server/queries";
import { Badge, Empty, PageHeader, Section, fmtDate } from "@/components/ui";
import { formatBase } from "@/domain/numbering";

export const metadata = { title: "Голосования" };

const CHOICE_LABEL: Record<string, string> = { for: "За", against: "Против", abstain: "Воздержался" };

/** FLOW-05, FLOW-13: открытые голосования участника и недавно завершённые с его голосом. */
export default async function VotesPage() {
  const u = await requireUser();
  const open = (await openVotesFor(u)).sort((a, b) => Number(a.voted) - Number(b.voted) || (a.cycle.closesAt?.getTime() ?? 0) - (b.cycle.closesAt?.getTime() ?? 0));
  // Собственные голоса пользователя по уже закрытым циклам — его собственная запись.
  const past = await db
    .select({ vote: schema.votes, cycle: schema.cycles, kase: schema.cases })
    .from(schema.votes)
    .innerJoin(schema.cycles, eq(schema.cycles.id, schema.votes.cycleId))
    .innerJoin(schema.cases, eq(schema.cases.id, schema.cycles.caseId))
    .where(and(eq(schema.votes.memberId, u.id), eq(schema.votes.organizationId, u.orgId), ne(schema.cycles.state, "voting")))
    .orderBy(desc(schema.votes.castAt))
    .limit(20);
  const waiting = open.filter((v) => !v.voted).length;

  return (
    <>
      <PageHeader
        title="Голосования"
        lead={
          open.length === 0
            ? "Открытых голосований нет. Когда председатель откроет обсуждение, вы получите письмо со ссылкой."
            : waiting > 0
              ? `Ждут вашего голоса: ${waiting}. Голос подаётся один раз и не меняется.`
              : "По всем открытым голосованиям ваш голос учтён."
        }
      />

      <div className="space-y-6">
        <Section title="Открытые" aside={<Badge tone={waiting ? "petrol" : "neutral"}>{open.length}</Badge>}>
          {open.length === 0 ? (
            <p className="text-[14px] text-ink-3">Сейчас нет голосований, в которых вы участвуете.</p>
          ) : (
            <ul className="divide-y divide-line">
              {open.map((v) => {
                const expired = !!v.cycle.closesAt && v.cycle.closesAt.getTime() < Date.now();
                return (
                  <li key={v.cycle.id}>
                    <Link href={`/votes/${v.cycle.id}`} className="group flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                      <span className="doc-number w-12 shrink-0 pt-0.5 text-[16px] text-ink-3">{formatBase(v.kase.number)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-serif text-[15.5px] text-ink group-hover:text-petrol">{v.kase.applicant}</span>
                        <span className="mt-0.5 block text-[13px] text-ink-3 tnum">
                          {v.cycle.supplementary ? "Дополнительное рассмотрение. " : v.cycle.number > 1 ? `Цикл ${v.cycle.number}. ` : ""}
                          {v.cycle.closesAt ? (expired ? `Срок истёк ${fmtDate(v.cycle.closesAt, true)}` : `Голосование до ${fmtDate(v.cycle.closesAt, true)}`) : "Срок не установлен"}
                        </span>
                      </span>
                      <Badge tone={v.voted ? "ok" : expired ? "neutral" : "warn"}>{v.voted ? "Ваш голос учтён" : expired ? "Срок истёк" : "Вы ещё не голосовали"}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Завершённые с вашим участием">
          {past.length === 0 ? (
            <Empty title="Пока пусто">Здесь появятся голосования, в которых вы подали голос, после их закрытия.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {past.map(({ vote, cycle, kase }) => (
                <li key={vote.id}>
                  <Link href={`/votes/${cycle.id}`} className="group flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                    <span className="doc-number w-12 shrink-0 pt-0.5 text-[16px] text-ink-3">{formatBase(kase.number)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-serif text-[15.5px] text-ink group-hover:text-petrol">{kase.applicant}</span>
                      <span className="mt-0.5 block text-[13px] text-ink-3 tnum">
                        Ваш голос: {CHOICE_LABEL[vote.choice] ?? vote.choice}, подан {fmtDate(vote.castAt, true)}
                        {cycle.closedAt ? `. Голосование завершено ${fmtDate(cycle.closedAt, true)}` : ""}
                      </span>
                    </span>
                    <Badge tone="neutral">Ваш голос учтён</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
