import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { can } from "@/domain/acl";
import { getSessionUser } from "@/server/auth";
import { env } from "@/server/env";
import { randomToken, signValue } from "@/server/crypto";
import {
  GMAIL_SCOPES,
  GOOGLE_AUTH_URL,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_PURPOSE,
  OAUTH_STATE_TTL_SEC,
} from "@/integrations/mail/gmail";

export const dynamic = "force-dynamic";

const back = (q: string) => NextResponse.redirect(new URL(`/admin/connections?${q}`, env.appUrl), 303);

/**
 * MAIL-02, ARCH-09. Начало OAuth-подключения ящика комиссии. Только председатель или
 * технический администратор. Минимальные scopes: чтение, черновики, отправка.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.appUrl), 303);
  if (!can(user.principal, "admin.settings")) {
    return back(`error=${encodeURIComponent("Подключать почту может только председатель или технический администратор")}`);
  }
  if (!env.googleClientId || !env.googleClientSecret) {
    return back(`error=${encodeURIComponent("Не настроено OAuth-приложение Google (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)")}`);
  }
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, user.orgId) });
  if (!org) return back(`error=${encodeURIComponent("Организация не найдена")}`);

  // state = nonce.userId.expires, подписанный HMAC; nonce дополнительно сверяется с cookie.
  const nonce = randomToken(24);
  const expires = Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SEC;
  const state = signValue(`${nonce}.${user.id}.${expires}`, OAUTH_STATE_PURPOSE);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.googleClientId);
  url.searchParams.set("redirect_uri", `${env.appUrl}${OAUTH_CALLBACK_PATH}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("login_hint", org.officialSender);
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString(), 303);
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax", // cookie должна вернуться при переходе с accounts.google.com
    secure: env.appUrl.startsWith("https"),
    path: "/api/integrations/gmail",
    maxAge: OAUTH_STATE_TTL_SEC,
  });
  return res;
}
