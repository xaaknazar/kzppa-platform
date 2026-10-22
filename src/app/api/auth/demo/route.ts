import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { createSession } from "@/server/auth";
import { env, isDemoAuth } from "@/server/env";

/** Демо-вход доступен только при AUTH_MODE=demo (тестовые среды, ARCH-02). */
export async function POST(req: Request) {
  if (!isDemoAuth()) return new NextResponse("Демо-вход отключён", { status: 404 });
  const form = await req.formData();
  const userId = String(form.get("userId") ?? "");
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!u) return NextResponse.redirect(new URL("/login?error=Участник не найден", env.appUrl), 303);
  await createSession(u.id);
  return NextResponse.redirect(new URL("/", req.url), 303);
}
