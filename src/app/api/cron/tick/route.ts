import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { sha256Hex } from "@/domain/hash";
import { GET as mailSync } from "../mail-sync/route";
import { GET as outbox } from "../outbox/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Частый планировщик (каждые 5 минут) для тарифа Vercel, где собственные cron-задачи
 * запускаются не чаще раза в сутки. Вызывается внешним расписанием (GitHub Actions,
 * .github/workflows/tick.yml) с отдельным ключом: в коде хранится только SHA-256 ключа,
 * сам ключ — в секрете репозитория TICK_TOKEN. Задачи те же, что у суточных cron:
 *   ?job=mail   — синхронизация почты комиссии;
 *   ?job=outbox — отправка писем из очереди, закрытие истёкших голосований.
 */
const TICK_TOKEN_SHA256 = "19add9a51fe06b64d732b7028dcbe78376938f6ccc9c2d6895f02b7d02869998";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !safeEqual(await sha256Hex(token), TICK_TOKEN_SHA256)) return new NextResponse("Unauthorized", { status: 401 });
  if (!env.cronSecret) return NextResponse.json({ error: "CRON_SECRET не задан — фоновые задачи отключены" }, { status: 503 });

  const job = new URL(req.url).searchParams.get("job");
  const inner = new Request(req.url, { headers: { authorization: `Bearer ${env.cronSecret}` } });
  if (job === "mail") return mailSync(inner);
  if (job === "outbox") return outbox(inner);
  return NextResponse.json({ error: "job: mail | outbox" }, { status: 400 });
}
