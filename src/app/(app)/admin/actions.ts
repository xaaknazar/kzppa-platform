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
