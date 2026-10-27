import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { createServerClient } from "@supabase/ssr";
import { db, schema } from "@/db/client";
import type { Principal } from "@/domain/acl";
import type { CaseRole, OrgRole } from "@/domain/types";
import { env } from "./env";

/**
 * SEC-02. Вход:
 *  - email: одноразовый код, который платформа отправляет с почты комиссии на подтверждённый адрес;
 *  - supabase: код от Supabase Auth;
 *  - demo: выбор участника, только для тестовых сред.
 * Сопоставление адреса с человеком отделено от проверки полномочий (DATA-02): адрес должен быть в составе.
 */

export interface SessionUser {
  id: string;
  orgId: string;
  fullName: string;
  email: string;
  orgRoles: OrgRole[];
  principal: Principal;
}

export const SESSION_COOKIE = "kzppa_session";
/** @deprecated прежнее имя */
export const DEMO_COOKIE = SESSION_COOKIE;
const SESSION_HOURS = 12;

/** Создать сессию и установить cookie (серверное действие или обработчик маршрута). */
export async function createSession(userId: string) {
  const id = crypto.randomUUID() + crypto.randomUUID();
  await db.insert(schema.sessions).values({ id, userId, expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000) });
  const store = await cookies();
  store.set(SESSION_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: env.appUrl.startsWith("https"), path: "/", maxAge: SESSION_HOURS * 3600 });
  return id;
}

export async function destroySession() {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  if (sid) await db.delete(schema.sessions).where(eq(schema.sessions.id, sid));
  store.delete(SESSION_COOKIE);
}

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

export async function loadUserById(userId: string): Promise<SessionUser | null> {
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
  // Сессия платформы: демо, вход по коду с почты комиссии, вход администратора по ключу.
  {
    const store = await cookies();
    const sid = store.get(SESSION_COOKIE)?.value;
    if (sid) {
      const s = await db.query.sessions.findFirst({ where: and(eq(schema.sessions.id, sid), gt(schema.sessions.expiresAt, new Date())) });
      if (s) return loadUserById(s.userId);
    }
    if (env.authMode !== "supabase") return null;
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
  if (!u) {
    const { headers } = await import("next/headers");
    const path = (await headers()).get("x-kzppa-path") ?? "";
    redirect(safeNext(path) ? `/login?next=${encodeURIComponent(path)}` : "/login");
  }
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

/** Возврат после входа только на внутренние страницы платформы (без открытого редиректа). */
export function safeNext(p: string | null | undefined): p is string {
  return !!p && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") && !p.startsWith("/login") && p !== "/";
}
