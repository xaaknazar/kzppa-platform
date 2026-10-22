import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser, ROLE_LABEL } from "@/server/auth";
import { can } from "@/domain/acl";
import { describeQuorum, quorumRequired, type QuorumRule } from "@/domain/quorum";
import { Badge, LinkButton, Notice, Section } from "@/components/ui";
import type { OrgRole } from "@/domain/types";
import { EMPTY_MEMBER, MemberForm, type MemberValues } from "./member-form";

export const metadata = { title: "Состав комиссии" };

/** UI-07, DATA-02, FLOW-01: состав, роли, проверенные адреса, подтверждённое обращение. */
export default async function MembersPage({ searchParams }: { searchParams: Promise<{ edit?: string; show?: string }> }) {
  const u = await requireUser();
  const { edit, show } = await searchParams;
  const canEdit = can(u.principal, "admin.members");

  const [org, users, roles] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) }),
    db.query.users.findMany({ where: eq(schema.users.organizationId, u.orgId), orderBy: asc(schema.users.fullName) }),
    db.select({ userId: schema.orgRoles.userId, role: schema.orgRoles.role }).from(schema.orgRoles).where(eq(schema.orgRoles.organizationId, u.orgId)),
  ]);
  const rolesOf = new Map<string, OrgRole[]>();
  for (const r of roles) rolesOf.set(r.userId, [...(rolesOf.get(r.userId) ?? []), r.role as OrgRole]);

  const active = users.filter((x) => x.status === "active");
  const composition = active.filter((x) => rolesOf.get(x.id)?.includes("member")).length;
  const missingAddress = active.filter((x) => !x.firstName?.trim());
  const unverified = active.filter((x) => !x.emailVerified);
  const list = show === "all" ? users : active;

  const qRule = org?.quorumRule as QuorumRule | undefined;
  let quorumText = "Правило кворума не задано";
  let quorumMismatch: string | null = null;
  if (qRule) {
    try {
      quorumText = describeQuorum(qRule, composition);
      void quorumRequired(qRule, composition);
    } catch (e) {
      quorumMismatch = (e as Error).message;
      quorumText = qRule.kind === "min_participants" ? `Не менее ${qRule.min} участвовавших при составе ${qRule.composition}` : quorumText;
    }
  }

  const toValues = (x: (typeof users)[number]): MemberValues => ({
    id: x.id,
    fullName: x.fullName,
    fullNameKk: x.fullNameKk ?? "",
    firstName: x.firstName ?? "",
    patronymic: x.patronymic ?? "",
    addressKk: x.addressKk ?? "",
    email: x.email,
    emailVerified: x.emailVerified,
    collegium: x.collegium ?? "",
    roles: rolesOf.get(x.id) ?? [],
    status: x.status === "inactive" ? "inactive" : "active",
  });
  const base = show === "all" ? "/admin/members?show=all" : "/admin/members";
  const withEdit = (id: string) => `${base}${base.includes("?") ? "&" : "?"}edit=${id}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="text-[14px] text-ink-2">
          <p>
            Действующий состав комиссии: <span className="tnum text-[17px] font-semibold text-ink">{composition}</span>
          </p>
          <p className="mt-0.5 text-[13px] text-ink-3">{quorumText}.</p>
        </div>
        {canEdit && edit !== "new" && (
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/admin/members/import" variant="secondary">
              Загрузить из таблицы
            </LinkButton>
            <LinkButton href={withEdit("new")} variant="primary" scroll={false}>
              Добавить участника
            </LinkButton>
          </div>
        )}
      </div>

      {quorumMismatch && (
        <Notice tone="warn" title="Правило кворума не соответствует составу">
          {quorumMismatch} Измените правило в <Link href="/admin" className="text-petrol underline">общих настройках</Link>, сославшись на Положение.
        </Notice>
      )}
      {missingAddress.length > 0 && (
        <Notice tone="warn" title={`Не подтверждено обращение: ${missingAddress.length}`}>
          Для этих участников нельзя сформировать письмо-поручение, пока не указаны имя и отчество для обращения. Строки выделены в таблице.
        </Notice>
      )}

      {canEdit && edit === "new" && (
        <Section title="Новый участник">
          <MemberForm initial={EMPTY_MEMBER} closeHref={base} />
        </Section>
      )}

      <Section
        title="Участники"
        aside={
          <span className="flex items-center gap-3 text-[13px]">
            {unverified.length > 0 && <Badge tone="warn">Адрес не подтверждён: {unverified.length}</Badge>}
            <Link href={show === "all" ? "/admin/members" : "/admin/members?show=all"} className="text-petrol hover:underline">
              {show === "all" ? "Только действующие" : "Показать выведенных"}
            </Link>
          </span>
        }
      >
        <div className="-mx-5 -my-4 overflow-x-auto">
          <table className="reg-table w-full min-w-[860px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="text-[12.5px] text-ink-3">
                <th scope="col" className="px-5 py-2 font-medium">ФИО</th>
                <th scope="col" className="px-3 py-2 font-medium">Электронная почта</th>
                <th scope="col" className="px-3 py-2 font-medium">Роли</th>
                <th scope="col" className="px-3 py-2 font-medium">Обращение</th>
                <th scope="col" className="px-3 py-2 font-medium">Статус</th>
                {canEdit && <th scope="col" className="px-5 py-2"><span className="sr-only">Действия</span></th>}
              </tr>
            </thead>
            <tbody>
              {list.map((x) => {
                const r = rolesOf.get(x.id) ?? [];
                const noAddress = !x.firstName?.trim();
                const ru = [x.firstName, x.patronymic].filter(Boolean).join(" ");
                const editing = edit === x.id;
                return [
                  <tr key={x.id} className={noAddress && x.status === "active" ? "bg-warn-50" : x.status !== "active" ? "text-ink-3" : undefined}>
                    <td className="border-t border-line px-5 py-3 align-top">
                      <span className="font-serif text-[15px] text-ink">{x.fullName}</span>
                      {x.fullNameKk && <span lang="kk" className="block text-[12.5px] text-ink-3">{x.fullNameKk}</span>}
                      {x.collegium && <span className="block text-[12.5px] text-ink-3">{x.collegium}</span>}
                    </td>
                    <td className="border-t border-line px-3 py-3 align-top">
                      <span className="break-all">{x.email}</span>
                      <span className="mt-1 block">{x.emailVerified ? <Badge tone="ok">Подтверждён</Badge> : <Badge tone="warn">Не подтверждён</Badge>}</span>
                    </td>
                    <td className="border-t border-line px-3 py-3 align-top text-[13.5px]">{r.length ? r.map((k) => ROLE_LABEL[k] ?? k).join(", ") : <span className="text-bad">Нет ролей</span>}</td>
                    <td className="border-t border-line px-3 py-3 align-top text-[13.5px]">
                      {noAddress ? (
                        <span className="font-medium text-warn">Не указано</span>
                      ) : (
                        <>
                          <span className="block">{ru}</span>
                          {x.addressKk ? <span lang="kk" className="block text-ink-3">{x.addressKk}</span> : <span className="block text-[12.5px] text-warn">Казахское обращение не указано</span>}
                        </>
                      )}
                    </td>
                    <td className="border-t border-line px-3 py-3 align-top">{x.status === "active" ? <Badge tone="ok">Действует</Badge> : <Badge>Выведен</Badge>}</td>
                    {canEdit && (
                      <td className="border-t border-line px-5 py-3 text-right align-top">
                        {!editing && (
                          <Link href={withEdit(x.id)} scroll={false} className="text-[13.5px] text-petrol hover:underline">
                            Изменить<span className="sr-only">: {x.fullName}</span>
                          </Link>
                        )}
                      </td>
                    )}
                  </tr>,
                  editing && canEdit ? (
                    <tr key={`${x.id}-edit`}>
                      <td colSpan={6} className="border-t border-line bg-paper px-5 py-5">
                        <h3 className="mb-4 text-[15px] font-semibold text-ink">Изменение: {x.fullName}</h3>
                        <MemberForm initial={toValues(x)} closeHref={base} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
          {list.length === 0 && <p className="px-5 py-6 text-[14px] text-ink-3">Участников нет. Добавьте состав комиссии, чтобы назначать исполнителей и открывать голосования.</p>}
        </div>
      </Section>
    </div>
  );
}
