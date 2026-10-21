import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { ensureHandlers } from "@/server/handlers";
import { processOutbox } from "@/server/outbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** ARCH-03: периодическая обработка outbox (повторы, сверка, опрос подписи). */
export async function GET(req: Request) {
  if (!env.cronSecret || req.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  await ensureHandlers();
  const started = Date.now();
  const all: Awaited<ReturnType<typeof processOutbox>> = [];
  while (Date.now() - started < 45_000) {
    const r = await processOutbox({ limit: 10 });
    all.push(...r);
    if (r.length === 0) break;
  }
  return NextResponse.json({ processed: all.length, results: all.map((r) => ({ type: r.type, status: r.status })) });
}
