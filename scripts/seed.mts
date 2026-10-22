/**
 * Начальное заполнение базы из командной строки:
 *   SEED_ADMIN_EMAIL=you@example.kz npm run seed
 *   DEMO_SEED=1 npm run seed            — плюс демонстрационные данные
 */
process.env.MAIL_TRANSPORT ??= "dry-run";
process.env.SIGN_PROVIDER ??= "dry-run";
const { runSeed } = await import("../src/server/seed");
const { sqlClient } = await import("../src/db/client");
await runSeed({ demo: process.env.DEMO_SEED === "1", adminEmail: process.env.SEED_ADMIN_EMAIL ?? null });
await sqlClient.end();
process.exit(0);
