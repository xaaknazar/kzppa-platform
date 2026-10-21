import { describe, expect, it } from "vitest";
import {
  assessSource,
  base64UrlToBytes,
  buildMimeMessage,
  collectBounceText,
  contentDispositionAttachment,
  decodeRfc2047,
  extractRawHeader,
  inspectArchive,
  isLookalikeDomain,
  parseAddressList,
  parseAuthResults,
  parseBounce,
  parseParamHeader,
  walkMime,
  type GmailPart,
} from "@/integrations/mail/mime";
import type { OutgoingMail } from "@/integrations/mail/types";

const b64u = (s: string | Uint8Array) => Buffer.from(typeof s === "string" ? Buffer.from(s, "utf8") : s).toString("base64url");
const win1251 = (s: string) => {
  // Минимальный кодировщик windows-1251 для кириллицы (А..я, Ё/ё) — только для фикстур.
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else out.push(0x3f);
  }
  return new Uint8Array(out);
};

describe("RFC 2047: декодирование темы (MAIL-05, CASE-02)", () => {
  it("UTF-8 B: кириллица", () => {
    const enc = `=?UTF-8?B?${Buffer.from("Обращение Жубатовой Н.К.").toString("base64")}?=`;
    expect(decodeRfc2047(enc)).toBe("Обращение Жубатовой Н.К.");
  });

  it("UTF-8 Q: казахские буквы, подчёркивание — пробел", () => {
    const kk = "Өтініш Ахметовтың қосымша";
    const q = [...Buffer.from(kk)].map((b) => (b === 0x20 ? "_" : b < 0x80 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase()}`)).join("");
    expect(decodeRfc2047(`=?utf-8?Q?${q}?=`)).toBe(kk);
  });

  it("многобайтовый символ, разрезанный между соседними словами, склеивается; пробел между словами удаляется", () => {
    const bytes = Buffer.from("Қорытынды жоба");
    const a = bytes.subarray(0, 1).toString("base64"); // половина буквы «Қ»
    const b = bytes.subarray(1).toString("base64");
    expect(decodeRfc2047(`Re: =?UTF-8?B?${a}?=\r\n =?UTF-8?B?${b}?= №04-01/1351`)).toBe("Re: Қорытынды жоба №04-01/1351");
  });

  it("windows-1251 и koi8-r", () => {
    const cp = Buffer.from(win1251("Дополнительные материалы")).toString("base64");
    expect(decodeRfc2047(`=?windows-1251?B?${cp}?=`)).toBe("Дополнительные материалы");
    // «Привет» в KOI8-R
    const koi = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]).toString("base64");
    expect(decodeRfc2047(`=?KOI8-R?B?${koi}?=`)).toBe("Привет");
  });

  it("RFC 2231 параметры с продолжениями", () => {
    const p = parseParamHeader(`attachment; filename*0*=UTF-8''%D0%9E%D0%B1; filename*1*=%D1%80.pdf`);
    expect(p.value).toBe("attachment");
    expect(p.params.filename).toBe("Обр.pdf");
  });

  it("адреса с закодированным именем и кавычками", () => {
    const list = parseAddressList(`=?UTF-8?B?${Buffer.from("РКА").toString("base64")}?= <office@advokatura.kz>, "Иванов, И." <ivanov@mail.kz>, plain@x.kz`);
    expect(list).toEqual([
      { email: "office@advokatura.kz", name: "РКА" },
      { email: "ivanov@mail.kz", name: "Иванов, И." },
      { email: "plain@x.kz", name: null },
    ]);
  });
});

/** Типичное письмо РКА: тело (text+html) с логотипом в related, два одинаковых PDF и вложенное письмо. */
function fixturePayload(): GmailPart {
  const html = `<p>Направляем обращение.</p><img src="cid:logo@rka">`;
  return {
    partId: "",
    mimeType: "multipart/mixed",
    headers: [{ name: "Content-Type", value: 'multipart/mixed; boundary="x"' }],
    parts: [
      {
        partId: "0",
        mimeType: "multipart/related",
        parts: [
          {
            partId: "0.0",
            mimeType: "multipart/alternative",
            parts: [
              {
                partId: "0.0.0",
                mimeType: "text/plain",
                headers: [{ name: "Content-Type", value: "text/plain; charset=windows-1251" }],
                body: { size: 24, data: b64u(win1251("Направляем обращение.")) },
              },
              {
                partId: "0.0.1",
                mimeType: "text/html",
                headers: [{ name: "Content-Type", value: 'text/html; charset="UTF-8"' }],
                body: { size: html.length, data: b64u(html) },
              },
            ],
          },
          {
            partId: "0.1",
            mimeType: "image/png",
            filename: "logo.png",
            headers: [
              { name: "Content-Type", value: 'image/png; name="logo.png"' },
              { name: "Content-ID", value: "<logo@rka>" },
              { name: "Content-Disposition", value: 'inline; filename="logo.png"' },
            ],
            body: { attachmentId: "ATT_LOGO", size: 2048 },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "Обращение.pdf",
        headers: [
          { name: "Content-Type", value: 'application/pdf; name="=?UTF-8?B?0J7QsdGA0LDRidC10L3QuNC1LnBkZg==?="' },
          { name: "Content-Disposition", value: "attachment; filename*=UTF-8''%D0%9E%D0%B1%D1%80%D0%B0%D1%89%D0%B5%D0%BD%D0%B8%D0%B5.pdf" },
        ],
        body: { attachmentId: "ATT_PDF_1", size: 100_000 },
      },
      {
        partId: "2",
        mimeType: "application/pdf",
        filename: "Обращение.pdf",
        headers: [{ name: "Content-Disposition", value: "attachment" }],
        body: { attachmentId: "ATT_PDF_2", size: 100_000 },
      },
      {
        partId: "3",
        mimeType: "message/rfc822",
        filename: "",
        headers: [{ name: "Content-Disposition", value: "attachment" }],
        body: { attachmentId: "ATT_EML", size: 5000 },
        parts: [
          {
            partId: "3.0",
            mimeType: "multipart/mixed",
            parts: [
              { partId: "3.0.0", mimeType: "text/plain", body: { size: 5, data: b64u("hello") } },
              { partId: "3.0.1", mimeType: "image/jpeg", filename: "scan.jpg", body: { attachmentId: "ATT_SCAN", size: 3000 } },
            ],
          },
        ],
      },
    ],
  };
}

describe("Разбор MIME (MAIL-05, MAIL-06)", () => {
  const r = walkMime(fixturePayload());

  it("тела письма декодированы с учётом charset", () => {
    expect(r.textPlain).toBe("Направляем обращение.");
    expect(r.textHtml).toContain("cid:logo@rka");
    expect(r.pendingBodies).toEqual([]);
  });

  it("логотип по cid — inline, два одинаковых PDF — две позиции манифеста", () => {
    const byPart = Object.fromEntries(r.attachments.map((a) => [a.partId, a]));
    expect(byPart["0.1"]).toMatchObject({ inline: true, contentId: "logo@rka", mimeType: "image/png" });
    expect(byPart["1"]).toMatchObject({ inline: false, filename: "Обращение.pdf", providerAttachmentId: "ATT_PDF_1", parentPartId: null });
    expect(byPart["2"]).toMatchObject({ inline: false, filename: "Обращение.pdf", providerAttachmentId: "ATT_PDF_2" });
    const required = r.attachments.filter((a) => !a.inline && !a.parentPartId);
    expect(required.map((a) => a.partId)).toEqual(["1", "2", "3"]);
  });

  it("вложенное письмо — контейнер; его части помечены происхождением", () => {
    const eml = r.attachments.find((a) => a.partId === "3")!;
    expect(eml.filename).toBe("message-3.eml");
    const scan = r.attachments.find((a) => a.partId === "3.0.1")!;
    expect(scan.parentPartId).toBe("3");
    // текст вложенного письма не смешивается с телом основного
    expect(r.textPlain).not.toContain("hello");
  });

  it("partId строится и без partId от провайдера", () => {
    const strip = (p: GmailPart): GmailPart => ({ ...p, partId: undefined, parts: p.parts?.map(strip) });
    const r2 = walkMime(strip(fixturePayload()));
    expect(r2.attachments.map((a) => a.partId)).toEqual(r.attachments.map((a) => a.partId));
  });

  it("картинка с disposition inline вне related (фото документа с iPhone) — обычное вложение", () => {
    const p: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { size: 3, data: b64u("abc") } },
        { mimeType: "image/jpeg", filename: "IMG_0001.jpg", headers: [{ name: "Content-Disposition", value: "inline" }], body: { attachmentId: "A", size: 10 } },
      ],
    };
    expect(walkMime(p).attachments[0]).toMatchObject({ partId: "1", inline: false });
  });

  it("крупное тело без data возвращается для дочитывания", () => {
    const p: GmailPart = { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=koi8-r" }], body: { attachmentId: "BIG", size: 600000 } };
    const w = walkMime(p);
    expect(w.pendingBodies).toEqual([{ partId: "root", attachmentId: "BIG", mimeType: "text/html", charset: "koi8-r" }]);
    expect(w.attachments).toEqual([]);
  });
});

describe("Сборка исходящего (OUT-06)", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const mail: OutgoingMail = {
    from: "kzppa.rka@gmail.com",
    to: ["office@advokatura.kz"],
    cc: ["Секретарь КЗППА <secretary@kzppa.kz>"],
    bcc: [],
    subject: "Исх. №001/01 — заключение по обращению Жубатовой Н.К. (қорытынды)",
    text: "Уважаемый председатель!\nНаправляем заключение.",
    html: "<p>Уважаемый председатель!</p>",
    attachments: [{ filename: "Заключение №001 Жубатова.pdf", mimeType: "application/pdf", bytes: pdf }],
    outgoingId: "7d3c2a40-1b2c-4d5e-8f90-a1b2c3d4e5f6",
  };
  const mime = buildMimeMessage(mail, { boundarySeed: "t", date: new Date("2026-10-21T10:00:00Z") });
  const headerBlock = mime.slice(0, mime.indexOf("\r\n\r\n"));

  it("заголовки: From точно, X-KZPPA-Outgoing-Id, тема в RFC 2047 UTF-8", () => {
    expect(headerBlock).toMatch(/^From: kzppa\.rka@gmail\.com$/m);
    expect(headerBlock).toMatch(/^To: office@advokatura\.kz$/m);
    expect(headerBlock).toMatch(/^X-KZPPA-Outgoing-Id: 7d3c2a40-1b2c-4d5e-8f90-a1b2c3d4e5f6$/m);
    expect(headerBlock).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    const subj = extractRawHeader(new TextEncoder().encode(mime), "Subject")!;
    expect(decodeRfc2047(subj)).toBe(mail.subject);
    expect(extractRawHeader(new TextEncoder().encode(mime), "X-KZPPA-Outgoing-Id")).toBe(mail.outgoingId);
    // строки заголовков не длиннее 78 символов
    for (const line of headerBlock.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(headerBlock.split("\r\n").filter((l) => l.startsWith(" =?UTF-8")).every((l) => l.length <= 78)).toBe(true);
    expect(parseAddressList(extractRawHeader(new TextEncoder().encode(mime), "Cc")).map((a) => a.name)).toEqual(["Секретарь КЗППА"]);
  });

  it("структура multipart/mixed → alternative + вложение base64 с filename*=UTF-8''", () => {
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="=_kzppa_mixed_t"');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="=_kzppa_alt_t"');
    const enc = encodeURIComponent("Заключение №001 Жубатова.pdf");
    expect(mime).toContain(`filename*=UTF-8''${enc}`);
    expect(mime).toContain("Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjc=");
    expect(mime.endsWith("--=_kzppa_mixed_t--\r\n")).toBe(true);
    expect(mime).not.toMatch(/[^\r]\n/); // только CRLF
  });

  it("сборка → разбор: имя файла восстанавливается из Content-Disposition", () => {
    const disp = contentDispositionAttachment("Заключение №001 Жубатова.pdf").replace(/\r\n /g, " ");
    expect(parseParamHeader(disp).params.filename).toBe("Заключение №001 Жубатова.pdf");
    const long = "Очень длинное имя файла ".repeat(30) + ".pdf";
    const d2 = contentDispositionAttachment(long).replace(/\r\n /g, " ");
    expect(parseParamHeader(d2).params.filename).toBe(long);
  });

  it("внедрение заголовков через CR/LF отклоняется", () => {
    expect(() => buildMimeMessage({ ...mail, subject: "Тема\r\nBcc: evil@x.kz" })).toThrow(/перевода строки/);
    expect(() => buildMimeMessage({ ...mail, to: ["a@b.kz\r\nBcc: evil@x.kz"] })).toThrow();
    expect(() => buildMimeMessage({ ...mail, outgoingId: "x y" })).toThrow();
  });

  it("без HTML — простой text/plain внутри mixed", () => {
    const m = buildMimeMessage({ ...mail, html: null, attachments: [] }, { boundarySeed: "u" });
    expect(m).not.toContain("multipart/alternative");
    const b64 = m.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(mail.text.replace(/\n/g, "\r\n"));
  });
});

describe("Подлинность источника (MAIL-10)", () => {
  const googleAR =
    "mx.google.com; dkim=pass header.i=@advokatura.kz header.s=mail header.b=abc; spf=pass (google.com: domain of office@advokatura.kz designates 1.2.3.4 as permitted sender) smtp.mailfrom=office@advokatura.kz; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=advokatura.kz";

  it("разбор Authentication-Results; поддельный нижний заголовок игнорируется", () => {
    const a = parseAuthResults([googleAR, "evil.example; dkim=fail"]);
    expect(a).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", dkimDomains: ["advokatura.kz"], spfDomain: "advokatura.kz" });
  });

  it("подтверждённое письмо РКА не подозрительно", () => {
    const s = assessSource({ from: { email: "office@advokatura.kz", name: "РКА" }, replyTo: null, auth: parseAuthResults([googleAR]), officialRkaAddress: "office@advokatura.kz", direction: "in" });
    expect(s).toMatchObject({ verifiedRka: true, suspicious: false });
  });

  it("адрес РКА без подтверждения, двойники домена и подмена имени — подозрительно", () => {
    const fail = parseAuthResults(["mx.google.com; spf=softfail smtp.mailfrom=office@advokatura.kz; dmarc=fail header.from=advokatura.kz"]);
    expect(assessSource({ from: { email: "office@advokatura.kz" }, replyTo: null, auth: fail, officialRkaAddress: "office@advokatura.kz", direction: "in" }).suspicious).toBe(true);
    for (const d of ["advokatura.com", "advokatura-kz.net", "adv0katura.kz", "advokature.kz", "advokatura.kz.evil.ru"]) {
      expect(isLookalikeDomain(d, "advokatura.kz"), d).toBe(true);
    }
    for (const d of ["advokatura.kz", "mail.advokatura.kz", "gmail.com", "mail.kz"]) expect(isLookalikeDomain(d, "advokatura.kz"), d).toBe(false);
    const spoof = assessSource({ from: { email: "rka.office@gmail.com", name: "office@advokatura.kz" }, replyTo: null, auth: {}, officialRkaAddress: "office@advokatura.kz", direction: "in" });
    expect(spoof.suspicious).toBe(true);
    expect(spoof.flags.join(" ")).toMatch(/другой адрес/);
  });
});

describe("Возвраты (OUT-08)", () => {
  it("исходный Message-ID и X-KZPPA-Outgoing-Id из text/rfc822-headers", () => {
    const payload: GmailPart = {
      mimeType: "multipart/report",
      headers: [{ name: "Message-ID", value: "<bounce@google.com>" }],
      parts: [
        { mimeType: "text/plain", body: { size: 10, data: b64u("Address not found") } },
        { mimeType: "message/delivery-status", body: { size: 10, data: b64u("Final-Recipient: rfc822; nobody@advokatura.kz\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown") } },
        { mimeType: "text/rfc822-headers", body: { size: 10, data: b64u("Message-ID: <orig-1@mail.gmail.com>\nX-KZPPA-Outgoing-Id: 7d3c2a40-1b2c-4d5e-8f90-a1b2c3d4e5f6\nSubject: test") } },
      ],
    };
    const c = collectBounceText(payload);
    const b = parseBounce(c.headerText, c.bodyText);
    expect(b).toMatchObject({ failed: true, originalMessageId: "<orig-1@mail.gmail.com>", outgoingId: "7d3c2a40-1b2c-4d5e-8f90-a1b2c3d4e5f6" });
    expect(b.reason).toContain("550 5.1.1");
  });

  it("отчёт о задержке не считается возвратом", () => {
    expect(parseBounce("", "Action: delayed\nStatus: 4.4.7").failed).toBe(false);
  });
});

describe("Архивы (MAIL-05, MAIL-09)", () => {
  function zip(encrypted: boolean): Uint8Array {
    const name = Buffer.from("a.txt");
    const data = Buffer.from("hello");
    const flag = encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flag, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flag, 8);
    central.writeUInt16LE(name.length, 28);
    const cdOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    return new Uint8Array(Buffer.concat([local, name, data, central, name, eocd]));
  }

  it("зашифрованный ZIP определяется без распаковки", () => {
    expect(inspectArchive(zip(true))).toMatchObject({ kind: "zip", encrypted: true, entries: 1, corrupt: false });
    expect(inspectArchive(zip(false))).toMatchObject({ kind: "zip", encrypted: false, entries: 1 });
    expect(inspectArchive(base64UrlToBytes(b64u("%PDF-1.7")))).toMatchObject({ kind: null });
  });
});
