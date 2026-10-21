import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { syncAccount } from "@/server/services/intake";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * MAIL-03. Push-уведомление Pub/Sub от Gmail: {message:{data: base64({emailAddress, historyId})}}.
 * Уведомление лишь запускает чтение изменений и не заменяет получение письма;
 * пропущенные уведомления подберёт периодическая сверка (cron mail-sync).
 * Подписка Pub/Sub настраивается с push endpoint `${APP_URL}/api/integrations/gmail/push?token=<CRON_SECRET>`.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!env.cronSecret || !safeEqual(token, env.cronSecret)) return new NextResponse("Unauthorized", { status: 401 });

  let email: string | null = null;
  try {
    const body = (await req.json()) as { message?: { data?: string } };
    const data = body.message?.data ? JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")) : null;
    email = typeof data?.emailAddress === "string" ? data.emailAddress.toLowerCase() : null;
  } catch {
    // Некорректное сообщение — подтверждаем, чтобы Pub/Sub не повторял его бесконечно.
    return new NextResponse(null, { status: 204 });
  }
  if (!email || env.mailTransport !== "gmail") return new NextResponse(null, { status: 204 });

  const accounts = await db.query.mailAccounts.findMany({
    where: and(eq(sql`lower(${schema.mailAccounts.email})`, email), eq(schema.mailAccounts.provider, "gmail")),
  });
  for (const acc of accounts) {
    if (acc.state === "disabled" || acc.state === "login_required") continue;
    try {
      await syncAccount(acc.id, { budgetMs: 20_000 });
    } catch (e) {
      console.error("gmail push sync", acc.id, (e as Error).message);
    }
  }
  return new NextResponse(null, { status: 204 });
}
