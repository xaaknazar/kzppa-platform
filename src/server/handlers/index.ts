import "server-only";

/**
 * Регистрация обработчиков outbox. Модули подключаются динамически,
 * чтобы отсутствие боевых ключей одной интеграции не ломало остальные операции.
 */
let registered: Promise<void> | null = null;

export function ensureHandlers() {
  registered ??= (async () => {
    const o = await import("../services/outgoing");
    o.registerOutgoingHandlers();
    try {
      const m = await import("./mail");
      m.registerMailHandlers();
    } catch (e) {
      console.warn("Обработчики почты не загружены:", (e as Error).message);
    }
    try {
      const s = await import("../services/signing");
      s.registerSignHandlers();
    } catch (e) {
      console.warn("Обработчики подписи не загружены:", (e as Error).message);
    }
  })();
  return registered;
}

/** Запустить обработку сразу после команды (не дожидаясь cron). */
export async function kick(opts: Parameters<typeof import("../outbox").processOutbox>[0]) {
  await ensureHandlers();
  const { processOutbox } = await import("../outbox");
  return processOutbox(opts).catch((e) => {
    console.error("outbox kick", e);
    return [];
  });
}
