import "server-only";
import QRCode from "qrcode";
import { env } from "../env";

/**
 * DOC-05, DOC-12. Постоянный QR проверки заключения.
 *  - ведёт на устойчивый HTTPS-адрес платформы, относящийся к конкретной версии документа;
 *  - адрес содержит префикс хеша манифеста (DOC-12): хеш вычисляется и кодируется
 *    ДО формирования финального PDF, поэтому ЭЦП PDF защищает связь с манифестом;
 *  - это НЕ временный QR сеанса eGov (SIGN-02) — тот выдаёт поставщик подписи.
 */

/** Длина префикса хеша манифеста в адресе: 16 hex = 64 бита, достаточно для сверки и компактно для QR. */
export const MANIFEST_PREFIX_LEN = 16;

/** DOC-12: `${appUrl}/v/${token}?h=${manifestHash[0..16)}`. */
export function verificationUrl(token: string, manifestHash: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) throw new Error("Некорректный токен QR-карточки");
  if (!/^[0-9a-f]{64}$/i.test(manifestHash)) throw new Error("Хеш манифеста должен быть SHA-256 (64 hex)");
  return `${env.appUrl}/v/${token}?h=${manifestHash.slice(0, MANIFEST_PREFIX_LEN).toLowerCase()}`;
}

/**
 * PNG постоянного QR. Уровень коррекции M, поле 2 модуля (DOC-04: читаемость при печати).
 * Вывод детерминирован для одинакового адреса и размера.
 */
export async function qrPngBytes(url: string, sizePx = 600): Promise<Uint8Array> {
  const buf = await QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: sizePx,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
