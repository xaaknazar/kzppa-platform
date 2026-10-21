import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type Tx } from "@/db/client";
import { canonicalJson, sha256Hex } from "@/domain/hash";

/**
 * DATA-10, AUD-01, AUD-02. Журнал аудита с цепочкой хешей: каждое событие
 * содержит хеш предыдущего, поэтому незаметное изменение обнаруживается проверкой цепочки.
 * Секреты и токены в журнал не пишутся — поля, похожие на секреты, вырезаются.
 */

export interface Actor {
  id: string | null;
  type: "user" | "service" | "external";
  label: string;
  role?: string | null;
}

export const SERVICE_ACTOR: Actor = { id: null, type: "service", label: "Платформа" };

export interface AuditInput {
  orgId: string;
  actor: Actor;
  action: string;
  objectType: string;
  objectId?: string | null;
  objectVersion?: number | null;
  caseId?: string | null;
  result?: "ok" | "denied" | "error";
  before?: unknown;
  after?: unknown;
  basis?: string | null;
  correlationId?: string | null;
  externalIds?: Record<string, string | null | undefined>;
}

const SECRET_KEYS = /(token|secret|password|refresh|authorization|cookie|key)$/i;

function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[скрыто]" : scrub(x);
    }
    return out;
  }
  return v;
}

export async function audit(tx: Tx, e: AuditInput) {
  // Сериализуем запись в цепочку организации.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"audit:" + e.orgId}))`);
  const prev = await tx
    .select({ hash: schema.auditEvents.hash })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.organizationId, e.orgId))
    .orderBy(desc(schema.auditEvents.id))
    .limit(1);
  const prevHash = prev[0]?.hash ?? null;
  const at = new Date();
  const body = {
    organizationId: e.orgId,
    at: at.toISOString(),
    actorId: e.actor.id,
    actorType: e.actor.type,
    actorLabel: e.actor.label,
    role: e.actor.role ?? null,
    action: e.action,
    objectType: e.objectType,
    objectId: e.objectId ?? null,
    objectVersion: e.objectVersion ?? null,
    caseId: e.caseId ?? null,
    result: e.result ?? "ok",
    before: e.before === undefined ? null : scrub(e.before),
    after: e.after === undefined ? null : scrub(e.after),
    basis: e.basis ?? null,
    correlationId: e.correlationId ?? null,
    externalIds: e.externalIds ?? null,
    prevHash,
  };
  const hash = await sha256Hex(canonicalJson(body));
  await tx.insert(schema.auditEvents).values({ ...body, at, hash } as typeof schema.auditEvents.$inferInsert);
}

/** Проверка целостности цепочки (AUD-02). */
export async function verifyAuditChain(
  rows: (typeof schema.auditEvents.$inferSelect)[],
): Promise<{ ok: boolean; brokenAt: number | null }> {
  let prev: string | null = null;
  for (const r of rows) {
    const body = {
      organizationId: r.organizationId,
      at: new Date(r.at).toISOString(),
      actorId: r.actorId,
      actorType: r.actorType,
      actorLabel: r.actorLabel,
      role: r.role,
      action: r.action,
      objectType: r.objectType,
      objectId: r.objectId,
      objectVersion: r.objectVersion,
      caseId: r.caseId,
      result: r.result,
      before: r.before,
      after: r.after,
      basis: r.basis,
      correlationId: r.correlationId,
      externalIds: r.externalIds,
      prevHash: r.prevHash,
    };
    if (r.prevHash !== prev) return { ok: false, brokenAt: r.id };
    if ((await sha256Hex(canonicalJson(body))) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null };
}
