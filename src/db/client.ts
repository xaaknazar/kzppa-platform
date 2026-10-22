import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { __kzppaSql?: ReturnType<typeof postgres> };

/**
 * Строка подключения: DATABASE_URL или переменные интеграции Vercel–Supabase (POSTGRES_URL).
 * Служебные параметры пулера (pgbouncer, supa) удаляются — драйвер передал бы их серверу как настройки.
 */
export function cleanConnectionString(raw: string) {
  const u = new URL(raw);
  for (const k of [...u.searchParams.keys()]) if (k !== "sslmode") u.searchParams.delete(k);
  return u.toString();
}

function connectionString() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("Не задана строка подключения к Postgres: DATABASE_URL или POSTGRES_URL.");
  return cleanConnectionString(url);
}

export const sqlClient =
  globalForDb.__kzppaSql ??
  postgres(connectionString(), {
    // Не 1: экземпляр функции обслуживает параллельные запросы (fluid compute), а часть кода
    // читает через общий пул внутри открытой транзакции — с одним соединением это взаимоблокировка.
    max: Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 5 : 10),
    prepare: false, // совместимо с пулером Supabase (transaction mode)
    idle_timeout: 20,
  });
if (process.env.NODE_ENV !== "production") globalForDb.__kzppaSql = sqlClient;

export const db = drizzle(sqlClient, { schema });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
