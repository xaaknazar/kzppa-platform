"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { can } from "@/domain/acl";
import * as admin from "@/server/services/admin";

/**
 * Серверные действия администрирования (UI-07). Тонкие обёртки над командами
 * src/server/services/admin.ts: права, проверка и журнал — в сервисе.
 */

export type AdminResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function done<T>(r: { ok: true; data: T } | { ok: false; error: string }, ...paths: string[]): AdminResult<T> {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/", "layout");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

export async function saveOrgSettingsAction(input: admin.OrgSettingsInput) {
  const u = await requireUser();
  return done(await admin.updateOrgSettings(u, input), "/admin", "/admin/members");
}

export async function saveMemberAction(input: admin.MemberInput) {
  const u = await requireUser();
  return done(await admin.upsertMember(u, input), "/admin/members");
}

export async function requeueOutboxAction(id: string) {
  const u = await requireUser();
  return done(await admin.requeueDeadOutbox(u, id), "/admin/outbox");
}

/** Синхронизация ящика по требованию. Модуль приёма почты подключается динамически. */
export async function syncMailAccountAction(accountId: string): Promise<AdminResult<{ note?: string }>> {
  const u = await requireUser();
  if (!can(u.principal, "admin.settings")) return { ok: false, error: "Недостаточно полномочий для этого действия" };
  const rec = await admin.recordMailSyncRequest(u, accountId);
  if (!rec.ok) return { ok: false, error: rec.error };
  let mod: Record<string, unknown>;
  try {
    mod = (await import("@/server/services/intake")) as unknown as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Модуль приёма почты ещё не установлен на сервере. Синхронизация выполнится по расписанию, когда он будет развёрнут." };
  }
  const syncAccount = mod.syncAccount as ((accountId: string, budgetMs: number) => Promise<unknown>) | undefined;
  if (typeof syncAccount !== "function") {
    return { ok: false, error: "Модуль приёма почты не поддерживает ручной запуск. Синхронизация выполнится по расписанию." };
  }
  try {
    await syncAccount(accountId, 50_000);
  } catch (e) {
    revalidatePath("/admin/connections");
    return { ok: false, error: `Синхронизация остановлена с ошибкой: ${(e as Error).message}. Подробности — в строке подключения; повторите позже.` };
  }
  revalidatePath("/admin/connections");
  revalidatePath("/inbox");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function importMembersAction(input: Parameters<typeof admin.importMembers>[1]) {
  const u = await requireUser();
  if (!can(u.principal, "admin.members")) return { ok: false as const, error: "Недостаточно полномочий" };
  const results = await admin.importMembers(u, input);
  revalidatePath("/admin/members");
  return { ok: true as const, data: results };
}

/** Проверочное письмо с ящика комиссии самому администратору (служебное, не попадает в разбор почты). */
export async function sendTestMailAction(): Promise<AdminResult<{ to: string }>> {
  const u = await requireUser();
  if (!can(u.principal, "admin.settings")) return { ok: false, error: "Недостаточно полномочий" };
  const { getMailAdapter, getPrimaryAccount } = await import("@/integrations/mail");
  const { db, schema } = await import("@/db/client");
  const { eq } = await import("drizzle-orm");
  const adapter = getMailAdapter();
  if (adapter.mode !== "gmail") return { ok: false, error: "Включён тестовый транспорт (MAIL_TRANSPORT=dry-run): письма наружу не уходят." };
  const account = await getPrimaryAccount(u.orgId);
  if (!account) return { ok: false, error: "Почтовый ящик комиссии не подключён" };
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) });
  try {
    await adapter.sendApprovedPackage(account.id, {
      from: org!.officialSender,
      to: [u.email],
      cc: [],
      bcc: [],
      subject: "Проверка подключения почты КЗППА",
      text: `Это проверочное письмо платформы ${org!.shortName}. Отправка с ${org!.officialSender} работает.`,
      html: null,
      attachments: [],
      outgoingId: `svc-test-${crypto.randomUUID()}`,
    });
    return { ok: true, data: { to: u.email } };
  } catch (e) {
    return { ok: false, error: `Отправка не удалась: ${(e as Error).message}` };
  }
}
