import "server-only";
import { eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { can, type Action } from "@/domain/acl";
import { audit, type Actor } from "./audit";
import type { SessionUser } from "./auth";

/**
 * ARCH-05, BR-06, STATE-02. Команды изменения:
 *  - выполняются в одной транзакции с записью аудита и outbox-событий (ARCH-03);
 *  - принимают ключ идемпотентности: повтор возвращает сохранённый результат без побочных эффектов;
 *  - проверяют полномочие на сервере (раздел 4) и пишут отказ в журнал.
 */

export class DeniedError extends Error {
  constructor(public readonly action: string) {
    super("Недостаточно полномочий для этого действия");
  }
}

export class CommandError extends Error {}

export interface CommandContext {
  tx: Tx;
  user: SessionUser;
  actor: Actor;
  orgId: string;
  correlationId: string;
}

export interface CommandOptions {
  name: string;
  user: SessionUser;
  idempotencyKey?: string | null;
  permission?: { action: Action; caseId?: string; cycleId?: string };
}

export type CommandResult<T> = { ok: true; data: T; replayed: boolean } | { ok: false; error: string; code?: string };

export async function runCommand<T>(opts: CommandOptions, fn: (ctx: CommandContext) => Promise<T>): Promise<CommandResult<T>> {
  const { user } = opts;
  const actor: Actor = { id: user.id, type: "user", label: user.fullName, role: user.orgRoles.join(",") };
  const correlationId = crypto.randomUUID();

  if (opts.permission && !can(user.principal, opts.permission.action, opts.permission)) {
    await db.transaction(async (tx) => {
      await audit(tx, {
        orgId: user.orgId,
        actor,
        action: opts.name,
        objectType: "command",
        caseId: opts.permission?.caseId ?? null,
        result: "denied",
        correlationId,
      });
    });
    return { ok: false, error: "Недостаточно полномочий для этого действия", code: "denied" };
  }

  try {
    const res = await db.transaction(async (tx) => {
      if (opts.idempotencyKey) {
        const prev = await tx.query.commandLog.findFirst({ where: eq(schema.commandLog.idempotencyKey, opts.idempotencyKey) });
        if (prev) return { data: prev.result as T, replayed: true };
      }
      const data = await fn({ tx, user, actor, orgId: user.orgId, correlationId });
      if (opts.idempotencyKey) {
        await tx
          .insert(schema.commandLog)
          .values({
            idempotencyKey: opts.idempotencyKey,
            organizationId: user.orgId,
            command: opts.name,
            actorId: user.id,
            result: (data ?? null) as never,
          })
          .onConflictDoNothing();
      }
      return { data, replayed: false };
    });
    return { ok: true, ...res };
  } catch (e) {
    const err = e as Error & { code?: string };
    // Уникальное нарушение — признак параллельного повтора той же команды.
    if (err.code === "23505" && opts.idempotencyKey) {
      const prev = await db.query.commandLog.findFirst({ where: eq(schema.commandLog.idempotencyKey, opts.idempotencyKey) });
      if (prev) return { ok: true, data: prev.result as T, replayed: true };
    }
    const message =
      e instanceof CommandError || e instanceof DeniedError || err.name === "VersionConflictError" || err.name === "TransitionError"
        ? err.message
        : err.code === "P0001" || err.code === "23514" || err.code === "42501"
          ? err.message
          : process.env.NODE_ENV === "production"
            ? `Операция не выполнена. Код обращения в поддержку: ${correlationId.slice(0, 8)}`
            : err.message;
    if (!(e instanceof CommandError)) console.error(`[${opts.name}] ${correlationId}`, err);
    return { ok: false, error: message, code: err.code };
  }
}

/** STATE-02: проверка ожидаемой версии строки. */
export function expectVersion(actual: number, expected: number | undefined | null) {
  if (expected != null && actual !== expected) {
    const e = new CommandError(
      `Данные изменены другим пользователем (ожидалась версия ${expected}, текущая ${actual}). Обновите страницу и повторите.`,
    );
    e.name = "VersionConflictError";
    throw e;
  }
}
