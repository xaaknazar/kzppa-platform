import { redirect } from "next/navigation";
import { and, count, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Emblem } from "@/components/shell";
import { env, isDemoAuth } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { createSession } from "@/server/auth";
import { Button, Field, Input, Notice } from "@/components/ui";
import { DEMO_STAGES, seedProgress } from "@/server/seed";
import { SeedRunner } from "./auto-continue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Первичная настройка" };

/**
 * Первичная настройка.
 *  - Демо: заполнение порциями (функция на Vercel ограничена 60 с) с продолжением с места остановки; сброс по ключу.
 *  - Боевой режим: организация и технический администратор по ключу развёртывания; администратор сразу входит.
 * Когда настройка завершена, страница уводит на вход.
 */

async function hasAdmin() {
  const [{ n }] = await db.select({ n: count() }).from(schema.orgRoles).where(eq(schema.orgRoles.role, "tech_admin"));
  return n > 0;
}

function keyOk(form: FormData) {
  const key = String(form.get("key") ?? "");
  return !!env.cronSecret && safeEqual(key, env.cronSecret);
}

async function resetDemo(form: FormData) {
  "use server";
  if (!isDemoAuth()) redirect("/setup?error=Сброс доступен только в демо-режиме");
  if (!keyOk(form)) redirect("/setup?error=Неверный ключ развёртывания");
  const { resetDemoDatabase } = await import("@/server/seed");
  await resetDemoDatabase();
  redirect("/setup");
}

async function initLive(form: FormData) {
  "use server";
  if (isDemoAuth()) redirect("/setup");
  if (!keyOk(form)) redirect("/setup?error=Неверный ключ развёртывания");
  if (await hasAdmin()) redirect("/login");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const fullName = String(form.get("fullName") ?? "").trim();
  if (!email || !fullName) redirect("/setup?error=Укажите ФИО и адрес администратора");
  const { runSeed } = await import("@/server/seed");
  await runSeed({ demo: false, adminEmail: email });
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (u) {
    await db.update(schema.users).set({ fullName, firstName: fullName.split(/\s+/)[1] ?? fullName }).where(eq(schema.users.id, u.id));
    await createSession(u.id);
  }
  redirect("/admin/members");
}

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const demo = isDemoAuth();
  const progress = await seedProgress();

  if (!demo && progress.org && (await hasAdmin())) redirect("/login");

  const [{ n: realCases }] = progress.org ? await db.select({ n: count() }).from(schema.cases).where(and(eq(schema.cases.organizationId, progress.org.id))) : [{ n: 0 }];
  const started = !!progress.org;

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[480px]">
        <div className="mb-8 flex items-center gap-3">
          <Emblem className="size-11" />
          <p className="font-serif text-[20px] text-ink">Первичная настройка</p>
        </div>
        <div className="space-y-4 rounded-lg border border-line bg-surface p-6">
          {sp.error && <Notice tone="bad" title={sp.error} />}
          {demo ? (
            <>
              {progress.demoComplete ? (
                <Notice tone="ok" title="Демонстрационные данные готовы">
                  <a className="text-petrol underline" href="/login">Перейти ко входу</a>
                </Notice>
              ) : (
                <p className="text-[14px] text-ink-2">
                  Платформа создаст организацию, состав из 30 участников и дела на разных этапах. Каждое дело проходит маршрут через настоящие сервисы платформы. Письма и подписи — тестовые, наружу ничего не уходит.
                </p>
              )}
              <SeedRunner stages={DEMO_STAGES.map((x) => ({ key: x.key, label: x.label }))} initialDone={progress.done} started={started} />
              {(started || realCases > 0) && (
                <details className="border-t border-line pt-4">
                  <summary className="cursor-pointer text-[13px] text-ink-3 hover:text-petrol">Сбросить демо-базу</summary>
                  <form action={resetDemo} className="mt-3 space-y-3">
                    <p className="text-[13px] text-ink-2">Все данные будут удалены без возможности восстановления. Сброс работает только в демо-режиме.</p>
                    <Field label="Ключ развёртывания" hint="Значение CRON_SECRET в Vercel"><Input type="password" name="key" required /></Field>
                    <Button variant="danger" className="w-full">Удалить все данные</Button>
                  </form>
                </details>
              )}
            </>
          ) : (
            <form action={initLive} className="space-y-4">
              <p className="text-[14px] text-ink-2">Будут созданы организация и учётная запись технического администратора. Вы сразу войдёте и сможете внести состав комиссии и подключить почту.</p>
              <Field label="ФИО администратора"><Input name="fullName" required autoComplete="name" /></Field>
              <Field label="Адрес администратора"><Input type="email" name="email" required autoComplete="email" /></Field>
              <Field label="Ключ развёртывания" hint="Значение CRON_SECRET в Vercel"><Input type="password" name="key" required /></Field>
              <Button className="w-full">Создать организацию и войти</Button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
