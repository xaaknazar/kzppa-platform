import "server-only";

/**
 * Конфигурация из окружения. Секреты не попадают в клиент и в логи (ARCH-09, AUD-02).
 * Режимы внешних интеграций: «live» — боевой провайдер, «dry-run» — тестовый транспорт,
 * который ничего не отправляет наружу и явно помечает это в интерфейсе (ARCH-02, MIG-06).
 */
export const env = {
  appUrl: (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  authMode: (process.env.AUTH_MODE ?? (process.env.NEXT_PUBLIC_SUPABASE_URL ? "supabase" : "demo")) as "supabase" | "demo",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  storageBucket: process.env.STORAGE_BUCKET ?? "kzppa-objects",
  mailTransport: (process.env.MAIL_TRANSPORT ?? "dry-run") as "gmail" | "dry-run",
  signProvider: (process.env.SIGN_PROVIDER ?? "dry-run") as "sigex" | "dry-run",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  gmailPubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? "",
  encryptionKey: process.env.APP_ENCRYPTION_KEY ?? "", // 32 байта base64, для токенов
  cronSecret: process.env.CRON_SECRET ?? "",
  sigexBaseUrl: process.env.SIGEX_BASE_URL ?? "https://sigex.kz",
  demoSeed: process.env.DEMO_SEED === "1",
};

export const isDemoAuth = () => env.authMode === "demo";

export function integrationModes() {
  return {
    mail: env.mailTransport,
    sign: env.signProvider,
    auth: env.authMode,
    storage: env.supabaseServiceKey ? "supabase" : "local",
  } as const;
}
