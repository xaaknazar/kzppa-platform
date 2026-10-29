import "server-only";

/**
 * Голосования по старому методу (Google Apps Script председателя, реестр в Google Таблице).
 * Платформа только показывает форму на своём домене и передаёт голос в тот же скрипт:
 * ссылки script.google.com на телефонах перехватывает приложение «Google Диск» («Не удалось
 * открыть файл»), а ссылка на домен платформы открывается в обычном браузере.
 * Источник правды — реестр и скрипт; здесь ничего не хранится.
 */
export const LEGACY_VOTE_URL =
  process.env.KZPPA_LEGACY_VOTE_URL ||
  "https://script.google.com/macros/s/AKfycbxxdYq7SoGfVzOh-vRMN06sgFVYoRwvwW8SB8Nw_HxX4ZO8ezoVIw1qAie_4akCyfWt/exec";

export const ROUND_RE = /^2026-\d{3}-R\d$/;
export const TOKEN_RE = /^[0-9a-f-]{36,100}$/i;

export interface LegacyVoteInfo {
  ok: true;
  round: string;
  n: number;
  name: string;
  executor?: string;
  voter: string;
  preview: boolean;
  open: boolean;
  voted: string | null;
  start: string | null;
  end: string | null;
  doc: string;
  folder: string;
}
export type LegacyResult<T> = T | { ok: false; error: string };

const GENERIC = "Ссылка недействительна или голосование ещё не подготовлено. Обратитесь к председателю Комиссии.";

export async function legacyVoteInfo(round: string, token: string): Promise<LegacyResult<LegacyVoteInfo>> {
  if (!ROUND_RE.test(round) || !TOKEN_RE.test(token)) return { ok: false, error: GENERIC };
  const url = `${LEGACY_VOTE_URL}?api=1&round=${encodeURIComponent(round)}&token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(25_000) });
    const j = (await r.json()) as LegacyResult<LegacyVoteInfo>;
    return j && typeof j === "object" ? j : { ok: false, error: GENERIC };
  } catch {
    return { ok: false, error: "Сервис голосования временно недоступен. Обновите страницу через минуту." };
  }
}

export async function legacySubmitVote(round: string, token: string, choice: string): Promise<{ ok: boolean; message?: string; error?: string; preview?: boolean }> {
  if (!ROUND_RE.test(round) || !TOKEN_RE.test(token)) return { ok: false, error: GENERIC };
  if (!["За", "Против", "Воздержался"].includes(choice)) return { ok: false, error: "Недопустимый вариант" };
  try {
    // Apps Script отвечает на POST переадресацией 302 на результат — fetch переходит по ней сам.
    const r = await fetch(LEGACY_VOTE_URL, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ round, token, choice }),
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    return (await r.json()) as { ok: boolean; message?: string; error?: string };
  } catch {
    return { ok: false, error: "Не удалось связаться с сервисом голосования. Голос мог не записаться — обновите страницу и проверьте статус." };
  }
}
