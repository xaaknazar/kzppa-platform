import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { env, integrationModes } from "@/server/env";
import { safeEqual } from "@/server/crypto";

export const dynamic = "force-dynamic";

/** Проверка состояния: база, задержка запросов, режимы интеграций. Подробности — только с ключом. */
export async function GET(req: Request) {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
  } catch (e) {
    return NextResponse.json({ ok: false, db: "unavailable" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const detailed = !!env.cronSecret && safeEqual(auth, `Bearer ${env.cronSecret}`);
  if (!detailed) return NextResponse.json({ ok: true });
  const timings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await db.execute(sql`select 1`);
    timings.push(Math.round(performance.now() - t));
  }
  return NextResponse.json({
    ok: true,
    region: process.env.VERCEL_REGION ?? null,
    firstQueryMs: Date.now() - started - timings.reduce((a, b) => a + b, 0),
    queryMs: timings,
    modes: integrationModes(),
  });
}
