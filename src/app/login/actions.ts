"use server";

import { createSession } from "@/server/auth";
import { requestLoginCode, verifyAdminKeyLogin, verifyLoginCode } from "@/server/services/login";

export async function requestCodeAction(email: string) {
  return requestLoginCode(email);
}

export async function verifyCodeAction(email: string, code: string) {
  const r = await verifyLoginCode(email, code);
  if (!r.ok) return r;
  await createSession(r.userId);
  return { ok: true as const };
}

export async function adminKeyLoginAction(email: string, key: string) {
  const r = await verifyAdminKeyLogin(email, key);
  if (!r.ok) return r;
  await createSession(r.userId);
  return { ok: true as const };
}
