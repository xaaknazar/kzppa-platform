import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { __kzppaSql?: ReturnType<typeof postgres> };

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL не задан. Укажите строку подключения к Postgres (Supabase).");
  return url;
}

export const sqlClient =
  globalForDb.__kzppaSql ??
  postgres(connectionString(), {
    max: process.env.VERCEL ? 1 : 10,
    prepare: false, // совместимо с пулером Supabase (transaction mode)
    idle_timeout: 20,
  });
if (process.env.NODE_ENV !== "production") globalForDb.__kzppaSql = sqlClient;

export const db = drizzle(sqlClient, { schema });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
