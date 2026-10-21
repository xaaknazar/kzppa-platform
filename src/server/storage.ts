import "server-only";
import { and, eq } from "drizzle-orm";
import { promises as fs } from "node:fs";
import path from "node:path";
import { db, schema, type Tx } from "@/db/client";
import { sha256Hex } from "@/domain/hash";
import { env } from "./env";

/**
 * STORE-01..05, MAIL-07. Неизменяемое хранилище объектов.
 * Физическое имя объекта — хеш, без персональных данных (STORE-04).
 * putImmutable: проверка размера и SHA-256, запись, перечитывание и сверка хеша.
 * Только после этого объект получает verified_at. Удаления нет (STORE-07, триггер в БД).
 */

interface Backend {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}

const localRoot = path.join(process.cwd(), ".data", "objects");

const localBackend: Backend = {
  async put(key, bytes) {
    const p = path.join(localRoot, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    try {
      await fs.access(p);
      return; // объект с этим хешем уже есть — не перезаписываем
    } catch {}
    await fs.writeFile(p, bytes, { flag: "wx" });
  },
  async get(key) {
    return new Uint8Array(await fs.readFile(path.join(localRoot, key)));
  },
  async exists(key) {
    try {
      await fs.access(path.join(localRoot, key));
      return true;
    } catch {
      return false;
    }
  },
};

const supabaseBackend: Backend = {
  async put(key, bytes, mime) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/${env.storageBucket}/${key}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.supabaseServiceKey}`,
        "content-type": mime || "application/octet-stream",
        "x-upsert": "false", // объекты неизменяемы
      },
      body: bytes as BodyInit,
    });
    if (!r.ok && r.status !== 409 && !(r.status === 400 && (await r.text()).includes("Duplicate"))) {
      throw new Error(`Хранилище отклонило запись объекта (HTTP ${r.status})`);
    }
  },
  async get(key) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/authenticated/${env.storageBucket}/${key}`, {
      headers: { authorization: `Bearer ${env.supabaseServiceKey}` },
    });
    if (!r.ok) throw new Error(`Объект недоступен в хранилище (HTTP ${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  },
  async exists(key) {
    const r = await fetch(`${env.supabaseUrl}/storage/v1/object/info/authenticated/${env.storageBucket}/${key}`, {
      headers: { authorization: `Bearer ${env.supabaseServiceKey}` },
    });
    return r.ok;
  },
};

function backend(): Backend {
  return env.supabaseServiceKey && env.supabaseUrl ? supabaseBackend : localBackend;
}

export function storageKey(orgId: string, sha: string) {
  return `${orgId}/${sha.slice(0, 2)}/${sha}`;
}

export interface StoredBlob {
  id: string;
  sha256: string;
  size: number;
  mimeType: string | null;
}

/** Сохранить байты как неизменяемый объект; повтор с теми же байтами возвращает тот же объект. */
export async function putImmutable(
  orgId: string,
  bytes: Uint8Array,
  mimeType: string,
  expected?: { sha256?: string; size?: number },
  tx?: Tx,
): Promise<StoredBlob> {
  const sha = await sha256Hex(bytes);
  if (expected?.size !== undefined && expected.size !== bytes.byteLength) {
    throw new Error(`Размер не совпал: ожидалось ${expected.size}, получено ${bytes.byteLength}`);
  }
  if (expected?.sha256 && expected.sha256 !== sha) throw new Error("SHA-256 не совпал с ожидаемым");

  const q = tx ?? db;
  const existing = await q.query.blobs.findFirst({
    where: and(eq(schema.blobs.organizationId, orgId), eq(schema.blobs.sha256, sha)),
  });
  if (existing?.verifiedAt) return { id: existing.id, sha256: sha, size: existing.size, mimeType: existing.mimeType };

  const key = storageKey(orgId, sha);
  const b = backend();
  await b.put(key, bytes, mimeType);
  // Перечитать и сверить хеш (MAIL-07): только после этого «сохранено и проверено».
  const back = await b.get(key);
  const backSha = await sha256Hex(back);
  if (backSha !== sha) throw new Error("Перечитанный объект не совпал по SHA-256");

  const [row] = await q
    .insert(schema.blobs)
    .values({ organizationId: orgId, sha256: sha, size: bytes.byteLength, mimeType, storageKey: key, verifiedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.blobs.organizationId, schema.blobs.sha256], set: { verifiedAt: new Date() } })
    .returning();
  return { id: row.id, sha256: sha, size: row.size, mimeType: row.mimeType };
}

export async function readBlob(blobId: string): Promise<{ bytes: Uint8Array; mimeType: string | null; sha256: string }> {
  const row = await db.query.blobs.findFirst({ where: eq(schema.blobs.id, blobId) });
  if (!row) throw new Error("Объект не найден");
  const bytes = await backend().get(row.storageKey);
  return { bytes, mimeType: row.mimeType, sha256: row.sha256 };
}

/** STORE-08: проверка наличия и хеша. */
export async function verifyBlob(blobId: string): Promise<"ok" | "missing" | "modified"> {
  const row = await db.query.blobs.findFirst({ where: eq(schema.blobs.id, blobId) });
  if (!row) return "missing";
  try {
    const bytes = await backend().get(row.storageKey);
    return (await sha256Hex(bytes)) === row.sha256 ? "ok" : "modified";
  } catch {
    return "missing";
  }
}
