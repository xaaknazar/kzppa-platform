import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/server/env";
import type { MailAdapter } from "./types";
import { GmailAdapter } from "./gmail";
import { DryRunMailAdapter } from "./dry-run";

/**
 * ARCH-07. Выбор почтового транспорта: MAIL_TRANSPORT=gmail — боевой Gmail,
 * иначе тестовый dry-run, который ничего не отправляет наружу.
 */

let cached: MailAdapter | null = null;

export function getMailAdapter(): MailAdapter {
  if (!cached) cached = env.mailTransport === "gmail" ? new GmailAdapter() : new DryRunMailAdapter();
  return cached;
}

export type MailAccountRow = typeof schema.mailAccounts.$inferSelect;

/** Подключение официального ящика комиссии (organizations.official_sender), если оно есть. */
export async function getPrimaryAccount(orgId: string): Promise<MailAccountRow | null> {
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
  if (!org) return null;
  const acc = await db.query.mailAccounts.findFirst({
    where: and(
      eq(schema.mailAccounts.organizationId, orgId),
      eq(sql`lower(${schema.mailAccounts.email})`, org.officialSender.toLowerCase()),
    ),
  });
  return acc ?? null;
}

/** Курсор fetchChanges указывает на продолжение страниц (см. gmail.ts). */
export function cursorHasMore(cursor: string | null): boolean {
  return !!cursor && (cursor.startsWith("page:") || cursor.startsWith("hist:"));
}

export { MailAuthError, UnknownSendResultError } from "./types";
export type { MailAdapter } from "./types";
