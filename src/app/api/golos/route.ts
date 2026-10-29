import { NextResponse } from "next/server";
import { legacySubmitVote } from "@/server/legacy/vote";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Передача голоса в скрипт председателя (старый метод голосования). */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { round?: string; token?: string; choice?: string };
  const r = await legacySubmitVote(String(b.round ?? ""), String(b.token ?? ""), String(b.choice ?? ""));
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}
