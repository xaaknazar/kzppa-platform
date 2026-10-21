import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Миграции — через прямое (session) подключение: транзакционный пулер не держит advisory-lock и DDL-сессию.
const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!raw) {
  if (process.env.VERCEL) {
    console.warn("Строка подключения к базе не задана — миграции пропущены");
    process.exit(0);
  }
}
const u = new URL(raw ?? "postgres://postgres:postgres@localhost:5432/kzppa");
for (const k of [...u.searchParams.keys()]) if (k !== "sslmode") u.searchParams.delete(k);
const sql = postgres(u.toString(), { max: 1, prepare: false, onnotice: () => {} });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
console.log("Миграции применены");
await sql.end();
