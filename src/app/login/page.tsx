import { asc, count, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db/client";
import { Emblem } from "@/components/shell";
import { getSessionUser, ROLE_LABEL, safeNext } from "@/server/auth";
import { env, isDemoAuth } from "@/server/env";
import { OtpLogin } from "./otp-login";
import { seedProgress } from "@/server/seed";
import { EmailLogin } from "./email-login";

export const dynamic = "force-dynamic";
export const metadata = { title: "Вход" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const sp0 = await searchParams;
  const next = safeNext(sp0.next) ? sp0.next : "/";
  if (await getSessionUser()) redirect(next);
  const [{ n: orgCount }] = await db.select({ n: count() }).from(schema.organizations);
  if (orgCount === 0) redirect("/setup");
  if (isDemoAuth() && !(await seedProgress()).demoComplete) redirect("/setup");
  const { error } = await searchParams;
  const demo = isDemoAuth();
  const sender = (await db.query.organizations.findFirst())?.officialSender ?? "почты комиссии";
  const people = demo
    ? await db
        .select({ id: schema.users.id, fullName: schema.users.fullName, role: schema.orgRoles.role })
        .from(schema.users)
        .innerJoin(schema.orgRoles, eq(schema.orgRoles.userId, schema.users.id))
        .orderBy(asc(schema.users.fullName))
    : [];
  // Один человек — одна строка, с перечнем ролей; сначала председатель, секретарь.
  const byUser = new Map<string, { id: string; fullName: string; roles: string[] }>();
  for (const p of people) {
    const e = byUser.get(p.id) ?? { id: p.id, fullName: p.fullName, roles: [] };
    e.roles.push(p.role);
    byUser.set(p.id, e);
  }
  const rank = (r: string[]) => (r.includes("chair") ? 0 : r.includes("secretary") ? 1 : 2);
  const list = [...byUser.values()].sort((a, b) => rank(a.roles) - rank(b.roles)).slice(0, 8);

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-3">
          <Emblem className="size-11" />
          <div>
            <p className="font-serif text-[20px] leading-tight text-ink">КЗППА РКА</p>
            <p className="text-[13px] text-ink-3">Комиссия по защите профессиональных прав адвокатов</p>
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <h1 className="text-[18px] font-semibold text-ink">Вход в платформу</h1>
          {error && <p className="mt-3 rounded-md bg-bad-50 px-3 py-2 text-[13.5px] text-bad">{error}</p>}
          {demo ? (
            <>
              <p className="mt-1 text-[13.5px] text-ink-3">Тестовая среда. Выберите участника, чтобы увидеть платформу его глазами.</p>
              <form action="/api/auth/demo" method="post" className="mt-4 space-y-2">
                {list.map((p) => (
                  <button key={p.id} name="userId" value={p.id} className="flex w-full items-center justify-between rounded-md border border-line px-3 py-2.5 text-left hover:border-petrol hover:bg-petrol-50">
                    <span className="text-[14px] text-ink">{p.fullName}</span>
                    <span className="text-[12px] text-ink-3">{p.roles.filter((r) => r !== "member").map((r) => ROLE_LABEL[r as keyof typeof ROLE_LABEL]).join(", ") || "Член комиссии"}</span>
                  </button>
                ))}
                {!list.length && (
                  <p className="text-[13.5px] text-ink-3">
                    Состав не загружен. <a className="text-petrol underline" href="/setup">Заполнить демонстрационными данными</a>
                  </p>
                )}
              </form>
            </>
          ) : env.authMode === "supabase" ? (
            <OtpLogin supabaseUrl={env.supabaseUrl} anonKey={env.supabaseAnonKey} />
          ) : (
            <EmailLogin sender={sender} next={next} />
          )}
        </div>
        <p className="mt-6 text-[12.5px] text-ink-3">Вход доступен только участникам с подтверждённым адресом в составе комиссии. Ссылка на дело без входа не открывает материалы.</p>
      </div>
    </main>
  );
}
