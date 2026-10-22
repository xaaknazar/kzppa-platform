"use server";

import { isDemoAuth } from "@/server/env";

/** Одна порция демо-заполнения. Клиент вызывает её в цикле, пока заполнение не завершится. */
export async function seedStepAction(): Promise<{ ok: true; complete: boolean; done: string[]; log: string[] } | { ok: false; error: string }> {
  if (!isDemoAuth()) return { ok: false, error: "Демо-заполнение доступно только в демо-режиме" };
  const { runSeed } = await import("@/server/seed");
  try {
    const r = await runSeed({ demo: true, budgetMs: Number(process.env.SEED_BUDGET_MS ?? 25_000) });
    return { ok: true, complete: r.complete, done: r.done, log: r.logs };
  } catch (e) {
    console.error("setup", e);
    return { ok: false, error: `Этап остановлен: ${(e as Error).message}` };
  }
}
