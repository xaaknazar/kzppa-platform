import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * MAIL-02, ARCH-09. Шифрование секретов (refresh-токенов почты) AES-256-GCM.
 * Ключ — APP_ENCRYPTION_KEY (32 байта в base64). Формат шифротекста: "v1.<iv>.<ciphertext+tag>" (base64url).
 * В production без ключа работа невозможна; в разработке выводится громкое предупреждение
 * и используется детерминированный небезопасный ключ.
 */

const VERSION = "v1";
let cachedKey: Buffer | null = null;
let warned = false;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.encryptionKey.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY не задан: хранение токенов почты невозможно (MAIL-02).");
    }
    if (!warned) {
      warned = true;
      console.warn(
        "\n**********************************************************************\n" +
          "* ВНИМАНИЕ: APP_ENCRYPTION_KEY не задан. Используется НЕБЕЗОПАСНЫЙ    *\n" +
          "* ключ разработки. Не подключайте боевую почту в этом режиме.         *\n" +
          "**********************************************************************\n",
      );
    }
    cachedKey = createHash("sha256").update("kzppa-dev-insecure-encryption-key").digest();
    return cachedKey;
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY должен быть 32 байтами в base64");
  cachedKey = key;
  return key;
}

/** Зашифровать секрет. aad — привязка к контексту (например, "mail:<org>:<email>"). */
export function encryptSecret(plain: string, aad?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptSecret(enc: string, aad?: string): string {
  const [ver, ivB64, ctB64] = enc.split(".");
  if (ver !== VERSION || !ivB64 || !ctB64) throw new Error("Неизвестный формат зашифрованного секрета");
  const iv = Buffer.from(ivB64, "base64url");
  const all = Buffer.from(ctB64, "base64url");
  if (all.length < 17) throw new Error("Повреждённый зашифрованный секрет");
  const tag = all.subarray(all.length - 16);
  const ct = all.subarray(0, all.length - 16);
  const d = createDecipheriv("aes-256-gcm", masterKey(), iv);
  if (aad) d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new Error("Не удалось расшифровать секрет: неверный ключ или данные изменены");
  }
}

/** Отдельный ключ подписи, производный от мастер-ключа (не используется для шифрования). */
function signingKey(purpose: string): Buffer {
  return createHmac("sha256", masterKey()).update(`kzppa-sign:${purpose}`).digest();
}

/** Подписать значение HMAC-SHA256: "<value>.<sig>". Значение не должно содержать секретов. */
export function signValue(value: string, purpose = "default"): string {
  const sig = createHmac("sha256", signingKey(purpose)).update(value).digest("base64url");
  return `${value}.${sig}`;
}

/** Проверить подпись; возвращает исходное значение или null. */
export function verifySigned(signed: string | null | undefined, purpose = "default"): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const sig = Buffer.from(signed.slice(i + 1), "base64url");
  const expected = createHmac("sha256", signingKey(purpose)).update(value).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  return value;
}

/** Сравнение строк постоянного времени (токены cron/push). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
