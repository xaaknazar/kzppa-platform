import { redirect } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Emblem } from "@/components/shell";
import { env, isDemoAuth } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { Button, Field, Input, Notice } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Первичная настройка" };

/**
 * Первичная настройка пустой базы. В демо-режиме — с демонстрационными данными;
 * в боевом — только организация и администратор, по секрету развёртывания.
 * Когда база заполнена, страница недоступна.
 */
async function state() {
  const [{ n: orgs }] = await db.select({ n: count() }).from(schema.organizations);
  const [{ n: cases }] = await db.select({ n: count() }).from(schema.cases);
  return { orgs, cases };
}

async function setup(form: FormData) {
  "use server";
  const s = await state();
  const demo = isDemoAuth() && form.get("demo") === "1";
  if (!isDemoAuth()) {
    const key = String(form.get("key") ?? "");
    if (!env.cronSecret || !safeEqual(key, env.cronSecret)) redirect("/setup?error=Неверный ключ развёртывания");
  }
  if (s.orgs > 0 && !(demo && s.cases === 0)) redirect("/login");
  const adminEmail = String(form.get("email") ?? "").trim().toLowerCase() || null;
  if (!isDemoAuth() && !adminEmail) redirect("/setup?error=Укажите адрес администратора");
  const { runSeed } = await import("@/server/seed");
  try {
    await runSeed({ demo, adminEmail });
  } catch (e) {
    console.error("setup", e);
    redirect(`/setup?error=${encodeURIComponent(`Заполнение остановлено: ${(e as Error).message}`)}`);
  }
  redirect("/login");
}

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const s = await state();
  const demo = isDemoAuth();
  if (s.orgs > 0 && !(demo && s.cases === 0)) redirect("/login");
  const org = s.orgs > 0 ? await db.query.organizations.findFirst() : null;
  void eq;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[460px]">
        <div className="mb-8 flex items-center gap-3">
          <Emblem className="size-11" />
          <p className="font-serif text-[20px] text-ink">Первичная настройка</p>
        </div>
        <form action={setup} className="space-y-4 rounded-lg border border-line bg-surface p-6">
          {error && <Notice tone="bad" title={error} />}
          {demo ? (
            <>
              <p className="text-[14px] text-ink-2">База пуста{org ? " (организация создана, дел нет)" : ""}. Платформа создаст организацию, состав из 30 участников и несколько дел на разных этапах. Все письма и подписи — тестовые, наружу ничего не уходит.</p>
              <input type="hidden" name="demo" value="1" />
              <Field label="Ваш адрес (необязательно)" hint="Добавит вас председателем и администратором">
                <Input type="email" name="email" placeholder="name@example.kz" />
              </Field>
              <Button className="w-full">Заполнить демонстрационными данными</Button>
              <p className="text-[12.5px] text-ink-3">Заполнение занимает до минуты: каждое дело проходит маршрут через настоящие сервисы платформы.</p>
            </>
          ) : (
            <>
              <p className="text-[14px] text-ink-2">Будут созданы организация и учётная запись администратора. Состав комиссии вносится затем в администрировании.</p>
              <Field label="Адрес администратора"><Input type="email" name="email" required /></Field>
              <Field label="Ключ развёртывания" hint="Значение переменной CRON_SECRET в Vercel"><Input type="password" name="key" required /></Field>
              <Button className="w-full">Создать организацию</Button>
            </>
          )}
        </form>
      </div>
    </main>
  );
}
