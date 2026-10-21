/**
 * Применение миграций.
 * На Vercel — только при production-сборке: preview-ветки используют ту же базу
 * и не должны менять её схему непроверенными миграциями.
 * Параллельные запуски сериализуются advisory-lock'ом на одном соединении.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (process.env.VERCEL && process.env.VERCEL_ENV !== "production") {
  console.log(`Сборка ${process.env.VERCEL_ENV}: миграции пропущены (применяются только при production-сборке)`);
  process.exit(0);
}

// Прямое (session) подключение: транзакционный пулер не держит advisory-lock и DDL-сессию.
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

const LOCK = 7_420_001; // произвольный постоянный ключ блокировки миграций
await sql`select pg_advisory_lock(${LOCK})`;
try {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("Миграции применены");
} finally {
  await sql`select pg_advisory_unlock(${LOCK})`;
  await sql.end();
}
