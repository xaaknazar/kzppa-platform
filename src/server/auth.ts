import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { createServerClient } from "@supabase/ssr";
import { db, schema } from "@/db/client";
import type { Principal } from "@/domain/acl";
import type { CaseRole, OrgRole } from "@/domain/types";
import { env, isDemoAuth } from "./env";

/**
 * SEC-02. Вход: Supabase Auth (одноразовый код на подтверждённый адрес) либо
 * демо-сессия для тестовых сред. Сопоставление почтового адреса с человеком
 * выполняется отдельно от проверки полномочий (DATA-02): адрес должен быть в составе.
 */

export interface SessionUser {
  id: string;
  orgId: string;
  fullName: string;
  email: string;
  orgRoles: OrgRole[];
  principal: Principal;
}

export const DEMO_COOKIE = "kzppa_demo_session";

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          /* вызвано из серверного компонента — обновление cookie выполнит middleware */
        }
      },
    },
  });
}

async function loadUserById(userId: string): Promise<SessionUser | null> {
  const u = await db.query.users.findFirst({ where: and(eq(schema.users.id, userId), eq(schema.users.status, "active")) });
  if (!u) return null;
  const today = new Date().toISOString().slice(0, 10);
  const roles = await db
    .select({ role: schema.orgRoles.role })
    .from(schema.orgRoles)
    .where(
      and(
        eq(schema.orgRoles.userId, u.id),
        sql`(${schema.orgRoles.validFrom} is null or ${schema.orgRoles.validFrom} <= ${today})`,
        sql`(${schema.orgRoles.validTo} is null or ${schema.orgRoles.validTo} >= ${today})`,
      ),
    );
  const caseRoles = await db
    .select({ caseId: schema.caseMembers.caseId, role: schema.caseMembers.role, cycleId: schema.caseMembers.cycleId, active: schema.caseMembers.active })
    .from(schema.caseMembers)
    .where(and(eq(schema.caseMembers.userId, u.id), eq(schema.caseMembers.active, true)));
  const orgRoles = roles.map((r) => r.role as OrgRole);
  return {
    id: u.id,
    orgId: u.organizationId,
    fullName: u.fullName,
    email: u.email,
    orgRoles,
    principal: {
      userId: u.id,
      orgRoles,
      caseRoles: caseRoles.map((c) => ({ ...c, role: c.role as CaseRole })),
    },
  };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  if (isDemoAuth()) {
    const store = await cookies();
    const sid = store.get(DEMO_COOKIE)?.value;
    if (!sid) return null;
    const s = await db.query.sessions.findFirst({ where: and(eq(schema.sessions.id, sid), gt(schema.sessions.expiresAt, new Date())) });
    return s ? loadUserById(s.userId) : null;
  }
  const supa = await supabaseServer();
  const { data } = await supa.auth.getUser();
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const u = await db.query.users.findFirst({ where: and(eq(sql`lower(${schema.users.email})`, email), eq(schema.users.status, "active")) });
  if (!u) return null;
  if (!u.authUserId && data.user?.id) {
    await db.update(schema.users).set({ authUserId: data.user.id, emailVerified: true }).where(eq(schema.users.id, u.id));
  } else if (u.authUserId && u.authUserId !== data.user?.id) {
    return null; // адрес привязан к другой учётной записи — вход запрещён
  }
  return loadUserById(u.id);
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) redirect("/login");
  return u;
}

export const isChair = (u: SessionUser) => u.orgRoles.includes("chair");
export const isSecretary = (u: SessionUser) => u.orgRoles.includes("secretary");
export const isStaff = (u: SessionUser) => isChair(u) || isSecretary(u);

export const ROLE_LABEL: Record<OrgRole, string> = {
  chair: "Председатель",
  secretary: "Секретарь",
  member: "Член комиссии",
  auditor: "Аудитор",
  outgoing_registrar: "Регистратор исходящих",
  tech_admin: "Технический администратор",
};
