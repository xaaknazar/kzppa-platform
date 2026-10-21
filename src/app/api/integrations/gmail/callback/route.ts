import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { can } from "@/domain/acl";
import { audit, type Actor } from "@/server/audit";
import { getSessionUser } from "@/server/auth";
import { env } from "@/server/env";
import { encryptSecret, safeEqual, verifySigned } from "@/server/crypto";
import {
  GMAIL_SCOPES,
  GOOGLE_TOKEN_URL,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_PURPOSE,
  invalidateAccessToken,
  primeAccessToken,
  refreshTokenAad,
} from "@/integrations/mail/gmail";

export const dynamic = "force-dynamic";

function back(q: string) {
  const res = NextResponse.redirect(new URL(`/admin/connections?${q}`, env.appUrl), 303);
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/api/integrations/gmail", maxAge: 0 });
  return res;
}
const fail = (msg: string) => back(`error=${encodeURIComponent(msg)}`);

/**
 * MAIL-01, MAIL-02. Завершение OAuth: проверка state, обмен кода, сверка адреса
 * с официальным ящиком комиссии, шифрованное хранение refresh-токена, аудит.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  if (q.get("error")) {
    return fail(q.get("error") === "access_denied" ? "Доступ к почте не предоставлен" : `Google вернул ошибку: ${q.get("error")}`);
  }

  // ── state: подпись, срок, совпадение с cookie и с текущим пользователем.
  const state = q.get("state") ?? "";
  const cookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
  const payload = verifySigned(state, OAUTH_STATE_PURPOSE);
  if (!payload || !cookie || !safeEqual(cookie, state)) return fail("Сеанс подключения недействителен. Начните подключение заново.");
  const [, stateUserId, expires] = payload.split(".");
  if (!expires || Number(expires) * 1000 < Date.now()) return fail("Время на подключение истекло. Начните заново.");

  const user = await getSessionUser();
  if (!user || user.id !== stateUserId) return fail("Подключение начато другим пользователем. Войдите и повторите.");
  if (!can(user.principal, "admin.settings")) return fail("Подключать почту может только председатель или технический администратор");

  const code = q.get("code");
  if (!code) return fail("Google не вернул код авторизации");
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, user.orgId) });
  if (!org) return fail("Организация не найдена");

  // ── Обмен кода.
  let tok: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  try {
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: `${env.appUrl}${OAUTH_CALLBACK_PATH}`,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    tok = await r.json();
    if (!r.ok || !tok.access_token) return fail(`Не удалось получить доступ к почте${tok.error ? ` (${tok.error})` : ""}`);
  } catch {
    return fail("Сервер авторизации Google недоступен. Повторите позже.");
  }
  if (!tok.refresh_token) {
    return fail("Google не выдал постоянный доступ. Отзовите доступ приложения в настройках аккаунта Google и подключите заново.");
  }
  const granted = new Set((tok.scope ?? "").split(/\s+/).filter(Boolean));
  const missing = GMAIL_SCOPES.filter((s) => !granted.has(s));
  if (missing.length) {
    return fail("Предоставлены не все разрешения: нужны чтение, черновики и отправка почты. Подключите заново и отметьте все пункты.");
  }

  // ── Чей это ящик.
  let email: string;
  try {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return fail(`Не удалось прочитать профиль ящика (HTTP ${r.status})`);
    email = String(((await r.json()) as { emailAddress?: string }).emailAddress ?? "").toLowerCase();
  } catch {
    return fail("Gmail недоступен. Повторите позже.");
  }
  const official = org.officialSender.toLowerCase();
  if (email !== official) {
    // Токен чужого ящика не сохраняем и отзываем (MAIL-01: подключается только ящик комиссии).
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok.refresh_token)}`, { method: "POST" }).catch(() => {});
    return fail(`Подключён ящик ${email || "неизвестный"}, а должен быть официальный ящик комиссии ${official}. Войдите в Google под ${official} и повторите.`);
  }

  // ── Сохранение.
  const enc = encryptSecret(tok.refresh_token, refreshTokenAad(org.id, email));
  const actor: Actor = { id: user.id, type: "user", label: user.fullName, role: user.orgRoles.join(",") };
  const syncFrom = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const accountId = await db.transaction(async (tx) => {
    const before = await tx.query.mailAccounts.findFirst({
      where: and(eq(schema.mailAccounts.organizationId, org.id), eq(sql`lower(${schema.mailAccounts.email})`, email)),
    });
    let id: string;
    if (before) {
      // Повторное подключение: курсоры сохраняются — синхронизация продолжится без потерь и дублей.
      await tx
        .update(schema.mailAccounts)
        .set({ refreshTokenEnc: enc, scopes: [...granted].join(" "), state: "connected", lastError: null, provider: "gmail" })
        .where(eq(schema.mailAccounts.id, before.id));
      id = before.id;
    } else {
      const [row] = await tx
        .insert(schema.mailAccounts)
        .values({
          organizationId: org.id,
          provider: "gmail",
          email,
          state: "connected",
          refreshTokenEnc: enc,
          scopes: [...granted].join(" "),
          initialSyncFrom: syncFrom,
        })
        .returning({ id: schema.mailAccounts.id });
      id = row.id;
    }
    await audit(tx, {
      orgId: org.id,
      actor,
      action: "mail.connect",
      objectType: "mail_account",
      objectId: id,
      before: before ? { state: before.state, scopes: before.scopes } : null,
      after: { email, state: "connected", scopes: [...granted], initialSyncFrom: before?.initialSyncFrom ?? syncFrom },
      externalIds: { email },
    });
    return id;
  });
  invalidateAccessToken(accountId);
  primeAccessToken(accountId, tok.access_token, tok.expires_in ?? 3600);
  return back("connected=1");
}
