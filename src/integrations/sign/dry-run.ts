import "server-only";
import QRCode from "qrcode";
import { env } from "@/server/env";
import { sha256Hex } from "@/domain/hash";
import type { PollResult, SignAdapter, SignProcedure, Verification } from "./types";

/**
 * ARCH-02, MIG-06. Тестовый адаптер подписи: имитирует сеанс eGov для тестовых сред.
 * НЕ ИМЕЕТ ЮРИДИЧЕСКОЙ СИЛЫ: «подпись» — JSON {dryRun:true, sha256, signedAt}, а не CMS.
 *
 * «Телефон» заменяет страница /dev/sign/{procedureId} (доступна только при SIGN_PROVIDER=dry-run):
 * кнопка ставит sign_sessions.urls.devApproved = true. Опрос читает именно это поле, поэтому
 * состояние переживает перезапуск процесса и работает на нескольких экземплярах (serverless).
 * Дополнительно ведётся Map в памяти процесса (для тестов без БД).
 */

interface Pending {
  sha256: string;
  approved: boolean;
  approvedAt: string | null;
  expireAt: number;
}

const pending = new Map<string, Pending>();
const TTL_MS = 15 * 60_000;

/** Для тестов и для страницы /dev/sign: отметить процедуру подписанной в памяти процесса. */
export function approveDryRun(procedureId: string, at = new Date()) {
  const p = pending.get(procedureId);
  if (p) {
    p.approved = true;
    p.approvedAt = at.toISOString();
  }
}

function parseSignUrl(signUrl: string): { id: string; sha: string } | null {
  const m = signUrl.match(/^dry-run:sign\/([0-9a-f-]{36})\?sha=([0-9a-f]{64})$/);
  return m ? { id: m[1], sha: m[2] } : null;
}

export function dryRunSignature(sha256: string, signedAt: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ dryRun: true, sha256, signedAt }));
}

function parseDryRun(cms: Uint8Array): { dryRun: boolean; sha256: string; signedAt: string } | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(cms));
    return j && j.dryRun === true && typeof j.sha256 === "string" ? j : null;
  } catch {
    return null;
  }
}

export class DryRunSignAdapter implements SignAdapter {
  readonly mode = "dry-run" as const;

  async start(p: { documentName: string; documentSha256: string; description: string }): Promise<SignProcedure> {
    const procedureId = crypto.randomUUID();
    const mobileLink = `${env.appUrl}/dev/sign/${procedureId}`;
    const expireAt = new Date(Date.now() + TTL_MS);
    pending.set(procedureId, { sha256: p.documentSha256, approved: false, approvedAt: null, expireAt: expireAt.getTime() });
    return {
      procedureId,
      // Временный QR сеанса ведёт на тестовую страницу — это не постоянный QR проверки (SIGN-02).
      qrCodeDataUrl: await QRCode.toDataURL(mobileLink, { errorCorrectionLevel: "M", margin: 2, width: 320 }),
      mobileLink,
      businessLink: null,
      dataUrl: `dry-run:data/${procedureId}`,
      signUrl: `dry-run:sign/${procedureId}?sha=${p.documentSha256}`,
      expireAt,
    };
  }

  async submit(proc: SignProcedure, documentBytes: Uint8Array, _meta?: { documentName: string }): Promise<{ signUrl: string; expireAt?: Date | null; confirmed: boolean }> {
    const sha = await sha256Hex(documentBytes);
    const parsed = parseSignUrl(proc.signUrl);
    if (parsed && parsed.sha !== sha) throw new Error("Тестовая подпись: байты документа не совпали с хешем сеанса");
    return { signUrl: proc.signUrl, expireAt: proc.expireAt, confirmed: true };
  }

  async poll(signUrl: string): Promise<PollResult> {
    const parsed = parseSignUrl(signUrl);
    if (!parsed) return { status: "error", error: "Некорректная ссылка тестового сеанса", retryable: false };
    let approvedAt: string | null = null;
    let expireAt: number | null = null;
    const mem = pending.get(parsed.id);
    if (mem?.approved) approvedAt = mem.approvedAt;
    else {
      // Состояние в БД (переживает перезапуск процесса). Ленивый импорт — модуль работает и без БД.
      const { db, schema } = await import("@/db/client");
      const { sql } = await import("drizzle-orm");
      const [row] = await db
        .select({ urls: schema.signSessions.urls, expireAt: schema.signSessions.expireAt })
        .from(schema.signSessions)
        .where(sql`${schema.signSessions.urls}->>'procedureId' = ${parsed.id}`)
        .limit(1);
      const urls = (row?.urls ?? {}) as { devApproved?: boolean; devApprovedAt?: string };
      if (urls.devApproved === true) approvedAt = urls.devApprovedAt ?? new Date().toISOString();
      expireAt = row?.expireAt?.getTime() ?? mem?.expireAt ?? null;
    }
    if (approvedAt) {
      pending.delete(parsed.id);
      return {
        status: "signed",
        signature: { cms: dryRunSignature(parsed.sha, approvedAt), signatureType: "cms", providerResponse: { dryRun: true, procedureId: parsed.id, approvedAt } },
      };
    }
    if (expireAt !== null && Date.now() > expireAt) return { status: "expired" };
    return { status: "waiting" };
  }

  async register(p: { documentName: string; documentBytes: Uint8Array; cms: Uint8Array; private: true }): Promise<{ registrationId: string; response: unknown }> {
    const sha = await sha256Hex(p.documentBytes);
    return { registrationId: `dry-run:${sha.slice(0, 16)}`, response: { dryRun: true, private: p.private } };
  }

  async verify(p: { documentBytes: Uint8Array; cms: Uint8Array; registrationId?: string | null }): Promise<Verification> {
    const sig = parseDryRun(p.cms);
    const sha = await sha256Hex(p.documentBytes);
    return {
      cryptoValid: null, // тестовая подпись криптографически не проверяется
      trustChecked: false,
      authorityConfirmed: null,
      signer: { commonName: "ТЕСТОВАЯ ПОДПИСЬ", iin: null, serial: null, notBefore: null, notAfter: null },
      signedAt: sig?.signedAt ?? null,
      checkedAt: new Date().toISOString(),
      unavailable: false,
      details: { dryRun: true, hashMatches: sig?.sha256 === sha, note: "Тестовая подпись без юридической силы" },
    };
  }

  async reconcile(): Promise<{ registrationId: string } | null> {
    return null; // в тестовом режиме регистрация локальная — сверять не с чем
  }
}
