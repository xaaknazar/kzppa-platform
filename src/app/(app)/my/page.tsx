import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { Badge, Empty, PageHeader, Section, fmtDate, type Tone } from "@/components/ui";
import { formatBase } from "@/domain/numbering";
import { ASSIGNMENT_STATE_LABEL } from "@/domain/states";
import type { AssignmentState } from "@/domain/types";

export const metadata = { title: "Мои поручения" };

/** Поручения, видимые исполнителю: только после отправки письма (до этого текст на утверждении). */
const VISIBLE: AssignmentState[] = ["sent", "receipt_confirmed", "in_work", "draft_submitted", "on_rework", "done"];
const ACTIVE: AssignmentState[] = ["sent", "receipt_confirmed", "in_work", "on_rework"];

const TONE: Partial<Record<AssignmentState, Tone>> = {
  sent: "petrol",
  receipt_confirmed: "petrol",
  in_work: "petrol",
  on_rework: "warn",
  draft_submitted: "info",
  done: "ok",
};

export default async function MyAssignmentsPage() {
  const u = await requireUser();
  const rows = await db
    .select({ a: schema.assignments, c: schema.cases })
    .from(schema.assignments)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.assignments.caseId))
    .where(and(eq(schema.assignments.executorId, u.id), eq(schema.assignments.organizationId, u.orgId), inArray(schema.assignments.state, VISIBLE)))
    .orderBy(desc(schema.assignments.createdAt));

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" });
  const active = rows.filter((r) => ACTIVE.includes(r.a.state as AssignmentState) || r.a.state === "draft_submitted");
  const finished = rows.filter((r) => r.a.state === "done");

  return (
    <>
      <PageHeader title="Мои поручения" lead="Дела, по которым председатель поручил вам подготовить проект заключения. Откройте дело, чтобы увидеть материалы и порядок направления проекта." />

      {rows.length === 0 ? (
        <Empty title="Поручений нет">Когда председатель назначит вас исполнителем, поручение появится здесь и придёт письмом.</Empty>
      ) : (
        <div className="space-y-6">
          <Section title="В работе" aside={<Badge tone={active.length ? "petrol" : "neutral"}>{active.length}</Badge>}>
            {active.length === 0 ? <p className="text-[14px] text-ink-3">Активных поручений нет.</p> : <List rows={active} today={today} />}
          </Section>
          {finished.length > 0 && (
            <Section title="Выполненные" aside={<Badge>{finished.length}</Badge>}>
              <List rows={finished} today={today} />
            </Section>
          )}
        </div>
      )}
    </>
  );
}

function List({ rows, today }: { rows: { a: typeof schema.assignments.$inferSelect; c: typeof schema.cases.$inferSelect }[]; today: string }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map(({ a, c }) => {
        const due = a.extendedUntil ?? a.deadline;
        const overdue = !!due && due < today && ACTIVE.includes(a.state as AssignmentState);
        const state = a.state as AssignmentState;
        return (
          <li key={a.id}>
            <Link href={`/w/${c.id}`} className="group flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
              <span className="doc-number w-12 shrink-0 pt-0.5 text-[16px] text-ink-3">{formatBase(c.number)}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-serif text-[15.5px] text-ink group-hover:text-petrol">{c.applicant}</span>
                <span className="mt-0.5 block text-[13px] text-ink-3 tnum">
                  {a.kind === "finalization" ? "Окончательная редакция. " : ""}
                  {due ? (
                    <span className={overdue ? "font-medium text-bad" : undefined}>
                      Срок {fmtDate(due)}
                      {a.extendedUntil ? `, продлён с ${fmtDate(a.deadline)}` : ""}
                      {overdue ? ", просрочено" : ""}
                    </span>
                  ) : (
                    "Срок не установлен"
                  )}
                </span>
              </span>
              <Badge tone={TONE[state] ?? "neutral"}>{ASSIGNMENT_STATE_LABEL[state] ?? a.state}</Badge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
