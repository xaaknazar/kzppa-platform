import { NextResponse } from "next/server";
import { and, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { audit, SERVICE_ACTOR } from "@/server/audit";
import { getMailAdapter } from "@/integrations/mail";
import { ensureWatch } from "@/integrations/mail/gmail";
import { MailAuthError } from "@/integrations/mail/types";
import { listIncompleteMessages, retryIncompleteAttachments, syncAccount } from "@/server/services/intake";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MAIL-03: периодическая сверка ящика (работает всегда, уведомления лишь ускоряют).
 * MAIL-08: повтор незавершённых загрузок. OUT-08: возвраты привязываются к исходящим.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!env.cronSecret || !safeEqual(auth, `Bearer ${env.cronSecret}`)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const adapter = getMailAdapter();
  if (adapter.mode !== "gmail") {
    return NextResponse.json({ mode: adapter.mode, note: "Тестовый транспорт: синхронизация почты не выполняется" });
  }

  const accounts = await db.query.mailAccounts.findMany({
    where: and(eq(schema.mailAccounts.provider, "gmail"), notInArray(schema.mailAccounts.state, ["disabled", "login_required"])),
  });
  const report: Record<string, unknown>[] = [];
  const perAccount = Math.max(10_000, Math.floor(50_000 / Math.max(1, accounts.length)));

  for (const acc of accounts) {
    const r: Record<string, unknown> = { account: acc.id };
    try {
      r.watch = (await ensureWatch(acc.id)).status;
    } catch (e) {
      r.watch = `ошибка: ${(e as Error).message}`; // наблюдение лишь ускоряет — не блокирует сверку
    }
    const budget = Math.min(perAccount, 50_000 - (Date.now() - started));
    if (budget < 5_000) {
      r.sync = "отложено: исчерпан бюджет времени";
      report.push(r);
      continue;
    }
    const s = await syncAccount(acc.id, { budgetMs: budget });
    r.sync = s;
    if (s.error && /повторного входа|подключени/i.test(s.error)) {
      report.push(r);
      continue;
    }

    // MAIL-08: дозагрузка неполных поступлений, пока есть время.
    if (Date.now() - started < 45_000) {
      let retried = 0;
      for (const m of await listIncompleteMessages(acc.id, 10)) {
        if (Date.now() - started > 48_000) break;
        try {
          await retryIncompleteAttachments(m.id);
          retried++;
        } catch (e) {
          if (e instanceof MailAuthError) break;
        }
      }
      r.retried = retried;
    }

    if (Date.now() - started < 52_000) {
      try {
        r.bounces = await processBounces(acc.id, acc.organizationId);
      } catch (e) {
        r.bounces = `ошибка: ${(e as Error).message}`;
      }
    }
    report.push(r);
  }
  return NextResponse.json({ accounts: report.length, ms: Date.now() - started, report });
}

/** OUT-08: возврат меняет «отправлено» на «возврат» и создаёт задачу секретарю. */
async function processBounces(accountId: string, orgId: string): Promise<number> {
  const { bounces } = await getMailAdapter().readDeliveryEvents(accountId, null);
  let applied = 0;
  for (const b of bounces) {
    let cond: SQL;
    if (b.outgoingId && /^[0-9a-f-]{36}$/i.test(b.outgoingId)) cond = eq(schema.outgoings.id, b.outgoingId);
    else if (b.originalMessageId) cond = eq(schema.outgoings.internetMessageId, b.originalMessageId);
    else continue;
    const changed = await db.transaction(async (tx) => {
      const out = await tx.query.outgoings.findFirst({ where: and(eq(schema.outgoings.organizationId, orgId), cond) });
      if (!out || out.state !== "sent") return false; // уже «возврат» или ещё не подтверждено — идемпотентно
      const reconcile = { ...((out.reconcile as Record<string, unknown> | null) ?? {}), bounce: { reason: b.reason, at: new Date().toISOString() } };
      const upd = await tx
        .update(schema.outgoings)
        .set({ state: "bounced", reconcile, version: out.version + 1 })
        .where(and(eq(schema.outgoings.id, out.id), eq(schema.outgoings.version, out.version), inArray(schema.outgoings.state, ["sent"])))
        .returning({ id: schema.outgoings.id });
      if (!upd.length) return false;
      const what = out.kind === "assignment" ? "поручения" : out.numberDisplay ? `исх. №${out.numberDisplay}` : "исходящего письма";
      await tx
        .insert(schema.tasks)
        .values({
          organizationId: orgId,
          caseId: out.caseId,
          kind: "bounce",
          title: `Возврат ${what}: письмо не доставлено (${out.toAddrs.join(", ")})`,
          detail: `Причина: ${b.reason}\nПроверьте адрес получателя и подготовьте повторную отправку. Отсутствие возврата не доказывает прочтение (OUT-08).`,
          assigneeRole: "secretary",
          objectType: "outgoing",
          objectId: out.id,
          dedupKey: `bounce:${out.id}`,
        })
        .onConflictDoNothing({ target: schema.tasks.dedupKey });
      await audit(tx, {
        orgId,
        actor: { ...SERVICE_ACTOR, type: "external", label: "Почтовый сервер (возврат)" },
        action: "outgoing.bounced",
        objectType: "outgoing",
        objectId: out.id,
        caseId: out.caseId,
        before: { state: "sent" },
        after: { state: "bounced", reason: b.reason },
        externalIds: { providerMessageId: out.providerMessageId, internetMessageId: out.internetMessageId },
      });
      return true;
    });
    if (changed) applied++;
  }
  return applied;
}
