import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Тестовое подписание", robots: { index: false, follow: false } };

/**
 * ARCH-02, MIG-06. Имитация eGov Mobile для тестовой среды (SIGN_PROVIDER=dry-run).
 * Кнопка отмечает сеанс как «подписанный» (urls.devApproved=true); подпись забирает фоновый
 * обработчик sign.poll. Подпись тестовая и юридической силы не имеет.
 * В боевом режиме страница не существует (404).
 */

async function findSession(procedureId: string) {
  const [row] = await db
    .select({ id: schema.signSessions.id, state: schema.signSessions.state, urls: schema.signSessions.urls, sha: schema.signSessions.documentSha256, expireAt: schema.signSessions.expireAt, provider: schema.signSessions.provider })
    .from(schema.signSessions)
    .where(sql`${schema.signSessions.urls}->>'procedureId' = ${procedureId}`)
    .limit(1);
  return row ?? null;
}

async function approve(formData: FormData) {
  "use server";
  if (env.signProvider !== "dry-run") notFound();
  const procedureId = String(formData.get("procedureId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(procedureId)) notFound();
  const s = await findSession(procedureId);
  if (!s || s.provider !== "dry-run" || !["created", "data_submitted", "waiting"].includes(s.state)) return;
  await db
    .update(schema.signSessions)
    .set({ urls: sql`coalesce(${schema.signSessions.urls}, '{}'::jsonb) || ${JSON.stringify({ devApproved: true, devApprovedAt: new Date().toISOString() })}::jsonb` })
    .where(sql`${schema.signSessions.id} = ${s.id}`);
  try {
    const { kick } = await import("@/server/handlers");
    await kick({ types: ["sign.poll"], aggregateId: s.id, limit: 1 });
  } catch {
    /* фоновый cron заберёт подпись позже */
  }
  revalidatePath(`/dev/sign/${procedureId}`);
}

export default async function DevSignPage({ params }: { params: Promise<{ procedureId: string }> }) {
  if (env.signProvider !== "dry-run") notFound();
  const { procedureId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(procedureId)) notFound();
  const s = await findSession(procedureId);
  if (!s || s.provider !== "dry-run") notFound();
  const urls = (s.urls ?? {}) as { devApproved?: boolean };
  const open = ["created", "data_submitted", "waiting"].includes(s.state) && !urls.devApproved;
  const expired = !!s.expireAt && s.expireAt.getTime() < Date.now();

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-xl font-semibold">Тестовое подписание (без юридической силы)</h1>
      <p className="mt-3 text-sm text-gray-600">
        Эта страница заменяет приложение eGov Mobile в тестовой среде. Подтверждение создаёт тестовую отметку, которая не является электронной цифровой подписью.
      </p>
      <dl className="mt-5 space-y-2 text-sm">
        <div>
          <dt className="text-gray-500">SHA-256 документа</dt>
          <dd className="break-all font-mono text-xs">{s.sha}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Состояние сеанса</dt>
          <dd>{urls.devApproved ? "Подтверждено — подпись принимается фоновым процессом" : s.state}</dd>
        </div>
      </dl>
      {open && !expired ? (
        <form action={approve} className="mt-6">
          <input type="hidden" name="procedureId" value={procedureId} />
          <button type="submit" className="rounded border border-gray-800 bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700">
            Подтвердить тестовое подписание
          </button>
        </form>
      ) : (
        <p className="mt-6 text-sm text-gray-600">{expired && !urls.devApproved ? "Срок сеанса истёк." : "Действие не требуется."}</p>
      )}
    </main>
  );
}
