import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/kzppa";
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
console.log("Миграции применены");
await sql.end();
