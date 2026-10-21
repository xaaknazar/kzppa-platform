import "server-only";
import { and, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";

/**
 * ARCH-03. Transactional outbox: событие пишется в той же транзакции, что и бизнес-данные.
 * Обработчики идемпотентны, повторы ограничены, backoff с jitter, dead-letter.
 * Прогресс сохраняется, авария процесса не сбрасывает очередь в начало.
 */

export type OutboxType =
  | "assignment.grant_access"
  | "assignment.send"
  | "outgoing.send"
  | "outgoing.reconcile"
  | "mail.sync"
  | "mail.fetch_message"
  | "sign.poll"
  | "sign.register_verify"
  | "vote.invite";

export interface EnqueueInput {
  orgId: string;
  type: OutboxType;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number | null;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  correlationId?: string | null;
  delayMs?: number;
}

export async function enqueue(tx: Tx, e: EnqueueInput) {
  await tx
    .insert(schema.outbox)
    .values({
      organizationId: e.orgId,
      type: e.type,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      aggregateVersion: e.aggregateVersion ?? null,
      payload: e.payload ?? {},
      idempotencyKey: e.idempotencyKey,
      correlationId: e.correlationId ?? null,
      nextAttemptAt: new Date(Date.now() + (e.delayMs ?? 0)),
    })
    .onConflictDoNothing({ target: schema.outbox.idempotencyKey });
}

export type OutboxRow = typeof schema.outbox.$inferSelect;
export type Handler = (row: OutboxRow) => Promise<
  | { status: "done"; note?: string }
  | { status: "retry"; error: string; delayMs?: number }
  | { status: "dead"; error: string }
>;

const handlers = new Map<string, Handler>();
export function registerHandler(type: OutboxType, h: Handler) {
  handlers.set(type, h);
}

const MAX_ATTEMPTS = 8;

function backoff(attempt: number) {
  const base = Math.min(60 * 60_000, 15_000 * 2 ** attempt);
  return Math.round(base * (0.7 + Math.random() * 0.6)); // jitter
}

/** Забрать и обработать пачку событий. Вызывается cron-маршрутом и сразу после команд. */
export async function processOutbox(opts: { limit?: number; types?: OutboxType[]; aggregateId?: string } = {}) {
  const now = new Date();
  const lockUntil = new Date(Date.now() + 5 * 60_000);
  const claimed = await db.transaction(async (tx) => {
    const conds = [
      eq(schema.outbox.status, "pending"),
      lte(schema.outbox.nextAttemptAt, now),
      or(isNull(schema.outbox.lockedUntil), lte(schema.outbox.lockedUntil, now)),
    ];
    if (opts.types?.length) conds.push(inArray(schema.outbox.type, opts.types));
    if (opts.aggregateId) conds.push(eq(schema.outbox.aggregateId, opts.aggregateId));
    const rows = await tx
      .select()
      .from(schema.outbox)
      .where(and(...conds))
      .orderBy(schema.outbox.createdAt)
      .limit(opts.limit ?? 20)
      .for("update", { skipLocked: true });
    if (rows.length) {
      await tx
        .update(schema.outbox)
        .set({ lockedUntil: lockUntil, attempts: sql`${schema.outbox.attempts} + 1` })
        .where(inArray(schema.outbox.id, rows.map((r) => r.id)));
    }
    return rows;
  });

  const results: { id: string; type: string; status: string; error?: string }[] = [];
  for (const row of claimed) {
    const h = handlers.get(row.type);
    if (!h) {
      results.push({ id: row.id, type: row.type, status: "skipped", error: "Обработчик не зарегистрирован" });
      await db.update(schema.outbox).set({ lockedUntil: null }).where(eq(schema.outbox.id, row.id));
      continue;
    }
    try {
      const r = await h({ ...row, attempts: row.attempts + 1 });
      if (r.status === "done") {
        await db.update(schema.outbox).set({ status: "done", doneAt: new Date(), lockedUntil: null, lastError: null }).where(eq(schema.outbox.id, row.id));
      } else if (r.status === "dead" || row.attempts + 1 >= MAX_ATTEMPTS) {
        await db.update(schema.outbox).set({ status: "dead", lockedUntil: null, lastError: r.status === "done" ? null : r.error }).where(eq(schema.outbox.id, row.id));
      } else {
        await db
          .update(schema.outbox)
          .set({ lockedUntil: null, lastError: r.error, nextAttemptAt: new Date(Date.now() + (r.delayMs ?? backoff(row.attempts))) })
          .where(eq(schema.outbox.id, row.id));
      }
      results.push({ id: row.id, type: row.type, status: r.status, error: r.status === "done" ? undefined : r.error });
    } catch (e) {
      const msg = (e as Error).message;
      await db
        .update(schema.outbox)
        .set({
          lockedUntil: null,
          lastError: msg,
          status: row.attempts + 1 >= MAX_ATTEMPTS ? "dead" : "pending",
          nextAttemptAt: new Date(Date.now() + backoff(row.attempts)),
        })
        .where(eq(schema.outbox.id, row.id));
      results.push({ id: row.id, type: row.type, status: "error", error: msg });
    }
  }
  return results;
}

/** Безопасный перезапуск события из dead-letter (ARCH-03). */
export async function requeueDead(id: string) {
  await db.update(schema.outbox).set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null }).where(and(eq(schema.outbox.id, id), eq(schema.outbox.status, "dead")));
}
