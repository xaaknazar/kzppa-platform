import { afterEach, describe, expect, it, vi } from "vitest";
import { SigexAdapter, jwtFromSetCookie } from "@/integrations/sign/sigex";
import { AuthRequiredError } from "@/integrations/sign/types";

/**
 * SIGN-06: вход в SIGEX по подписи nonce из той же процедуры eGov.
 * Сеть подменена: проверяется форма запросов и обработка ответов.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockFetch(handler: (c: Call) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      let body: unknown = init.body;
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const c = { url: String(url), method: init.method ?? "GET", headers, body };
      calls.push(c);
      const r = handler(c);
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
    }),
  );
  return calls;
}

const cmsLike = (fill: number) => Buffer.from([0x30, ...Array.from({ length: 120 }, () => fill)]).toString("base64");
const qrStart = { dataURL: "https://sigex.kz/api/egovQr/q1", signURL: "https://sigex.kz/api/egovQr/q1/sign", expireAt: Date.now() + 300_000, qrCode: "UE5H", eGovMobileLaunchLink: "https://m.egov.kz/x" };

afterEach(() => vi.unstubAllGlobals());

describe("SIGEX: вход по подписи nonce", () => {
  it("start() запрашивает nonce вместе с процедурой", async () => {
    const calls = mockFetch((c) => (c.url.endsWith("/api/egovQr") ? { json: qrStart } : c.url.endsWith("/api/auth") ? { json: { nonce: "Tk9OQ0U=" } } : { status: 404 }));
    const proc = await new SigexAdapter().start({ documentName: "c.pdf", documentSha256: "a".repeat(64), description: "test" });
    expect(proc.authNonce).toBe("Tk9OQ0U=");
    expect(proc.procedureId).toBe("q1");
    expect(calls.find((c) => c.url.endsWith("/api/auth"))?.body).toEqual({});
  });

  it("без nonce подписание не ломается", async () => {
    mockFetch((c) => (c.url.endsWith("/api/egovQr") ? { json: qrStart } : { json: { message: "Service unavailable" } }));
    const proc = await new SigexAdapter().start({ documentName: "c.pdf", documentSha256: "a".repeat(64), description: "test" });
    expect(proc.authNonce).toBeNull();
  });

  it("submit() с nonce — одна процедура MIX_SIGN на два документа", async () => {
    const calls = mockFetch(() => ({ json: { signURL: qrStart.signURL, expireAt: qrStart.expireAt } }));
    const a = new SigexAdapter();
    const proc = { procedureId: "q1", qrCodeDataUrl: null, mobileLink: null, businessLink: null, dataUrl: qrStart.dataURL, signUrl: qrStart.signURL, expireAt: new Date(qrStart.expireAt), authNonce: "Tk9OQ0U=" };
    await a.submit(proc, new Uint8Array([1, 2, 3]), { documentName: "c.pdf" });
    const body = calls[0].body as { signMethod: string; documentsToSign: { id: number; signMethod: string; document: { file: { mime: string; data: string } } }[] };
    expect(body.signMethod).toBe("MIX_SIGN");
    expect(body.documentsToSign).toHaveLength(2);
    expect(body.documentsToSign[0]).toMatchObject({ id: 1, signMethod: "CMS_SIGN_ONLY", document: { file: { mime: "@file/pdf" } } });
    expect(body.documentsToSign[1]).toMatchObject({ id: 2, signMethod: "CMS_WITH_DATA", document: { file: { data: "Tk9OQ0U=" } } });

    await a.submit({ ...proc, authNonce: null }, new Uint8Array([1]), { documentName: "c.pdf" });
    const plain = calls[1].body as { signMethod: string; documentsToSign: { signMethod?: string }[] };
    expect(plain.signMethod).toBe("CMS_SIGN_ONLY");
    expect(plain.documentsToSign).toHaveLength(1);
    expect(plain.documentsToSign[0].signMethod).toBeUndefined();
  });

  it("poll() берёт подпись заключения по id 1, подпись входа — по id 2", async () => {
    const pdfSig = cmsLike(7);
    const authSig = cmsLike(9);
    mockFetch(() => ({ json: { signMethod: "MIX_SIGN", documentsToSign: [{ id: 2, document: { file: { data: authSig } } }, { id: 1, document: { file: { data: pdfSig } } }] } }));
    const r = await new SigexAdapter().poll(qrStart.signURL);
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    expect(Buffer.from(r.signature.cms).toString("base64")).toBe(pdfSig);
    expect(r.signature.authSignature).toBe(authSig);
    expect(JSON.stringify(r.signature.providerResponse)).not.toContain(authSig);
  });

  it("регистрация: «Authentication required» → вход по nonce → повтор с cookie", async () => {
    const calls = mockFetch((c) => {
      if (c.url.endsWith("/api/auth")) return { json: { userId: "IIN800101300123" }, headers: { "set-cookie": "jwt=abc.def.ghi; Path=/; Secure; HttpOnly; SameSite=Strict" } };
      if (c.url.endsWith("/api") && c.method === "POST") return c.headers.cookie === "jwt=abc.def.ghi" ? { json: { documentId: "D1", signId: 5 } } : { json: { message: "Authentication required" } };
      if (c.url.endsWith("/api/D1/data")) return { json: { documentId: "D1", signedDataSize: 3 } };
      return { status: 404 };
    });
    const a = new SigexAdapter();
    const params = { documentName: "c.pdf", documentBytes: new Uint8Array([1, 2, 3]), cms: new Uint8Array(Buffer.from(cmsLike(7), "base64")), private: true as const };
    await expect(a.register(params)).rejects.toBeInstanceOf(AuthRequiredError);
    const { cookie, userId } = await a.authenticate("Tk9OQ0U=", cmsLike(9));
    expect(cookie).toBe("abc.def.ghi");
    expect(userId).toBe("IIN800101300123");
    const authCall = calls.find((c) => c.url.endsWith("/api/auth"))!;
    expect(authCall.body).toEqual({ nonce: "Tk9OQ0U=", signature: cmsLike(9) });
    const reg = await a.register({ ...params, authCookie: cookie });
    expect(reg.registrationId).toBe("D1");
    expect(calls.find((c) => c.url.endsWith("/api/D1/data"))?.headers.cookie).toBe("jwt=abc.def.ghi");
  });

  it("отказ во входе (nonce истёк) → AuthRequiredError с понятным текстом", async () => {
    mockFetch(() => ({ json: { message: "Invalid authentication nonce", requestID: 1 } }));
    await expect(new SigexAdapter().authenticate("old", cmsLike(1))).rejects.toThrow(/SIGEX отклонил вход: Invalid authentication nonce/);
  });

  it("jwt извлекается из Set-Cookie", () => {
    expect(jwtFromSetCookie(new Headers({ "set-cookie": "jwt=xyz; Path=/" }))).toBe("xyz");
    expect(jwtFromSetCookie(new Headers({ "set-cookie": "other=1" }))).toBeNull();
  });

  it("процедура только для входа: один документ CMS_WITH_DATA с nonce", async () => {
    const calls = mockFetch((c) => (c.url.endsWith("/api/egovQr") ? { json: qrStart } : c.url.endsWith("/api/auth") ? { json: { nonce: "TjI=" } } : { json: { signURL: qrStart.signURL } }));
    const a = new SigexAdapter();
    const proc = await a.startAuth({ description: "Вход в SIGEX" });
    expect(proc.authNonce).toBe("TjI=");
    await a.submitAuth(proc);
    const body = calls[calls.length - 1].body as { signMethod: string; documentsToSign: { id: number; document: { file: { data: string } } }[] };
    expect(body.signMethod).toBe("CMS_WITH_DATA");
    expect(body.documentsToSign).toHaveLength(1);
    expect(body.documentsToSign[0].document.file.data).toBe("TjI=");
  });
});
