import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { sha256Hex } from "@/domain/hash";
import { audit } from "../audit";
import { env } from "../env";
import { safeEqual } from "../crypto";
import { getMailAdapter, getPrimaryAccount } from "@/integrations/mail";

/**
 * SEC-02. Вход по одноразовому коду, который платформа отправляет с почты комиссии.
 * Код живёт 10 минут, допускает 5 попыток, хранится только хеш. Ответ на запрос кода
 * одинаков для известного и неизвестного адреса — состав комиссии не раскрывается.
 */

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const hashCode = (userId: string, code: string) => sha256Hex(`login:${userId}:${code}:${env.encryptionKey || env.cronSecret}`);

async function findUserByEmail(email: string) {
  return db.query.users.findFirst({ where: and(eq(sql`lower(${schema.users.email})`, email.trim().toLowerCase()), eq(schema.users.status, "active")) });
}

export type RequestCodeResult = { ok: true } | { ok: false; error: string };

export async function requestLoginCode(email: string): Promise<RequestCodeResult> {
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { ok: false, error: "Укажите адрес электронной почты" };
  const adapter = getMailAdapter();
  if (adapter.mode !== "gmail") return { ok: false, error: "Почта комиссии не подключена, коды входа не отправляются. Администратор может войти по ключу развёртывания." };
  const u = await findUserByEmail(clean);
  if (!u) return { ok: true }; // не раскрываем, есть ли адрес в составе
  const account = await getPrimaryAccount(u.organizationId);
  if (!account || !["connected", "up_to_date", "syncing", "delayed"].includes(account.state)) {
    return { ok: false, error: "Почтовый ящик комиссии не подключён или требует повторного входа. Обратитесь к администратору." };
  }
  const recent = await db.select({ n: sql<number>`count(*)::int` }).from(schema.loginCodes).where(and(eq(schema.loginCodes.userId, u.id), gt(schema.loginCodes.createdAt, new Date(Date.now() - 3600_000))));
  if ((recent[0]?.n ?? 0) >= MAX_CODES_PER_HOUR) return { ok: false, error: "Слишком много запросов кода. Повторите через час или используйте последний полученный код." };

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const [row] = await db.insert(schema.loginCodes).values({ userId: u.id, codeHash: await hashCode(u.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) }).returning();
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.organizationId) });
  try {
    await adapter.sendApprovedPackage(account.id, {
      from: org!.officialSender,
      to: [u.email],
      cc: [],
      bcc: [],
      subject: `Код входа в платформу КЗППА: ${code}`,
      text: `Код входа в платформу ${org!.shortName}: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход, просто удалите это письмо.\n\n${env.appUrl}`,
      html: `<p style="font:15px/1.6 Arial,sans-serif;color:#17202b">Код входа в платформу ${org!.shortName}:</p><p style="font:600 28px/1.2 Arial,sans-serif;letter-spacing:6px;color:#0f4c5c">${code}</p><p style="font:13px/1.6 Arial,sans-serif;color:#66717f">Код действует 10 минут. Если вы не запрашивали вход, просто удалите это письмо.</p>`,
      attachments: [],
      outgoingId: `svc-login-${row.id}`,
    });
    await db.update(schema.loginCodes).set({ sendState: "sent" }).where(eq(schema.loginCodes.id, row.id));
  } catch (e) {
    await db.update(schema.loginCodes).set({ sendState: "error" }).where(eq(schema.loginCodes.id, row.id));
    console.error("login code send", (e as Error).message);
    return { ok: false, error: "Не удалось отправить код с почты комиссии. Повторите через минуту." };
  }
  return { ok: true };
}

export type VerifyResult = { ok: true; userId: string } | { ok: false; error: string };

export async function verifyLoginCode(email: string, code: string): Promise<VerifyResult> {
  const fail = { ok: false as const, error: "Код неверен или истёк. Запросите новый код." };
  const u = await findUserByEmail(email);
  if (!u || !/^\d{6}$/.test(code.trim())) return fail;
  const row = await db.query.loginCodes.findFirst({
    where: and(eq(schema.loginCodes.userId, u.id), isNull(schema.loginCodes.usedAt), gt(schema.loginCodes.expiresAt, new Date())),
    orderBy: desc(schema.loginCodes.createdAt),
  });
  if (!row || row.attempts >= MAX_ATTEMPTS) return fail;
  const ok = safeEqual(row.codeHash, await hashCode(u.id, code.trim()));
  if (!ok) {
    await db.update(schema.loginCodes).set({ attempts: row.attempts + 1 }).where(eq(schema.loginCodes.id, row.id));
    return fail;
  }
  await db.update(schema.loginCodes).set({ usedAt: new Date() }).where(eq(schema.loginCodes.id, row.id));
  if (!u.emailVerified) await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, u.id));
  await db.transaction((tx) => audit(tx, { orgId: u.organizationId, actor: { id: u.id, type: "user", label: u.fullName }, action: "auth.login", objectType: "user", objectId: u.id, after: { method: "email_code" } }));
  return { ok: true, userId: u.id };
}

/**
 * Аварийный вход технического администратора по ключу развёртывания (CRON_SECRET):
 * нужен, пока почта комиссии не подключена или если подключение сломалось.
 */
export async function verifyAdminKeyLogin(email: string, key: string): Promise<VerifyResult> {
  const fail = { ok: false as const, error: "Адрес или ключ неверны" };
  if (!env.cronSecret || !safeEqual(key.trim(), env.cronSecret)) return fail;
  const u = await findUserByEmail(email);
  if (!u) return fail;
  const role = await db.query.orgRoles.findFirst({ where: and(eq(schema.orgRoles.userId, u.id), eq(schema.orgRoles.role, "tech_admin")) });
  if (!role) return fail;
  await db.transaction((tx) => audit(tx, { orgId: u.organizationId, actor: { id: u.id, type: "user", label: u.fullName }, action: "auth.login", objectType: "user", objectId: u.id, after: { method: "deployment_key" } }));
  return { ok: true, userId: u.id };
}
