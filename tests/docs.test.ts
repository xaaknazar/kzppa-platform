import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { buildFinalConclusionPdf } from "@/server/docs/conclusion-pdf";
import { buildCoverLetterDocx } from "@/server/docs/cover-letter-docx";
import { buildProtocolPdf } from "@/server/docs/protocol-pdf";
import { qrPngBytes, verificationUrl } from "@/server/docs/qr";
import { hashPrefixMatches } from "@/server/services/qr-card";
import { DryRunSignAdapter, approveDryRun } from "@/integrations/sign/dry-run";
import { tally } from "@/domain/quorum";
import { sha256Hex } from "@/domain/hash";

const MANIFEST_HASH = "0123456789abcdef".repeat(4);
const QR_URL = verificationUrl("abcdefgh12345678", MANIFEST_HASH);

async function pdfWithLines(lines: number, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595.28, 841.89]);
    for (let i = 0; i < lines; i++) page.drawText(`Page ${p + 1}, line ${i + 1}: conclusion text`, { x: 70, y: 780 - i * 14, size: 12, font });
  }
  return doc.save();
}

const KK_PARAGRAPH =
  "Адвокаттардың кәсіби құқықтарын қорғау жөніндегі комиссия өтінішті қарап, мынадай қорытындыға келді: әріптестің құқықтары бұзылған, Қазақстан Республикасының заңнамасына сәйкес шаралар қабылдау қажет. Ә Ғ Қ Ң Ө Ұ Ү Һ І ә ғ қ ң ө ұ ү һ і.";

async function kazakhDocx(paragraphs = 6): Promise<Uint8Array> {
  const d = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, children: [new TextRun("ҚОРЫТЫНДЫ №001")] }),
          ...Array.from({ length: paragraphs }, (_, i) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: `${i + 1}. `, bold: true }), new TextRun(KK_PARAGRAPH)] })),
          new Paragraph({ children: [new TextRun("Төраға\tСейтқалиев Ә.Ғ.")] }),
          new Paragraph({ children: [] }), // хвостовой пустой абзац не переносится
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(d));
}

describe("DOC-12 адрес и QR", () => {
  it("адрес содержит префикс хеша манифеста", () => {
    expect(QR_URL).toMatch(/\/v\/abcdefgh12345678\?h=0123456789abcdef$/);
    expect(hashPrefixMatches(MANIFEST_HASH, "0123456789abcdef")).toBe(true);
    expect(hashPrefixMatches(MANIFEST_HASH, "ffffffffffffffff")).toBe(false);
  });
  it("PNG детерминирован", async () => {
    const a = await qrPngBytes(QR_URL);
    const b = await qrPngBytes(QR_URL);
    expect(Buffer.from(a.slice(0, 4)).toString("hex")).toBe("89504e47");
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });
});

describe("DOC-03/DOC-04 финальный PDF с QR", () => {
  it("короткий PDF: QR на той же странице, число страниц не меняется", async () => {
    const src = await pdfWithLines(10);
    const r = await buildFinalConclusionPdf({ source: { bytes: src, format: "pdf", filename: "c.pdf" }, qrUrl: QR_URL, lang: "ru" });
    expect(r.qrPlacement).toBe("same_page");
    expect(r.pages).toBe(1);
    expect(r.textCheck).toEqual({ ok: true, issues: [] });
    expect(r.generator.sourceSha256).toBe(await sha256Hex(src));
  }, 30_000);

  it("последняя страница заполнена: одна новая страница только с QR", async () => {
    const src = await pdfWithLines(52, 2); // текст до y≈66 pt — ниже 20 мм + 28 мм не помещается
    const r = await buildFinalConclusionPdf({ source: { bytes: src, format: "pdf", filename: "c.pdf" }, qrUrl: QR_URL, lang: "ru" });
    expect(r.qrPlacement).toBe("new_page");
    expect(r.pages).toBe(3);
    expect(r.textCheck.ok).toBe(true);
    // На новой странице нет текста (DOC-04: без заголовка и подписей).
    const out = await PDFDocument.load(r.bytes);
    expect(out.getPageCount()).toBe(3);
  }, 30_000);

  it("DOCX на казахском → PDF, весь текст на месте", async () => {
    const r = await buildFinalConclusionPdf({ source: { bytes: await kazakhDocx(), format: "docx", filename: "қорытынды.docx" }, qrUrl: QR_URL, lang: "kk" });
    expect(r.textCheck).toEqual({ ok: true, issues: [] });
    expect(r.pages).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(r.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(r.bytes, { updateMetadata: false });
    expect(doc.getProducer()).toBe("КЗППА РКА платформа");
  }, 30_000);

  it("длинный DOCX: несколько страниц, проверка текста проходит", async () => {
    const r = await buildFinalConclusionPdf({ source: { bytes: await kazakhDocx(40), format: "docx", filename: "c.docx" }, qrUrl: QR_URL, lang: "kk" });
    expect(r.pages).toBeGreaterThan(1);
    expect(r.textCheck.ok).toBe(true);
  }, 30_000);

  it("детерминизм: одинаковый вход → одинаковый SHA-256", async () => {
    const docx = await kazakhDocx();
    const a = await buildFinalConclusionPdf({ source: { bytes: docx, format: "docx", filename: "c.docx" }, qrUrl: QR_URL, lang: "kk", fixedDate: "2026-10-21T00:00:00Z" });
    const b = await buildFinalConclusionPdf({ source: { bytes: docx, format: "docx", filename: "c.docx" }, qrUrl: QR_URL, lang: "kk", fixedDate: "2026-10-21T00:00:00Z" });
    expect(await sha256Hex(a.bytes)).toBe(await sha256Hex(b.bytes));
    const pdf = await pdfWithLines(10);
    const c = await buildFinalConclusionPdf({ source: { bytes: pdf, format: "pdf", filename: "c.pdf" }, qrUrl: QR_URL, lang: "ru" });
    const d = await buildFinalConclusionPdf({ source: { bytes: pdf, format: "pdf", filename: "c.pdf" }, qrUrl: QR_URL, lang: "ru" });
    expect(await sha256Hex(c.bytes)).toBe(await sha256Hex(d.bytes));
  }, 30_000);
});

describe("DOC-07 сопроводительное письмо", () => {
  const data = {
    outgoingNumber: "001/01",
    outgoingDate: "21.10.2026",
    rkaNumber: "04-01/1351",
    rkaDate: "01.10.2026",
    caseNumber: "001",
    applicant: "Сейткали А.Б.",
    purpose: "Заключение рассмотрено Комиссией.",
    attachments: [{ name: "Заключение №001/01 (PDF, ЭЦП)", pages: 3 }, { name: "Проект.docx" }],
    chairFullName: "Иванов Иван Иванович",
    commissionName: "Комиссия по защите профессиональных прав адвокатов РКА",
    addressee: "Председателю Республиканской коллегии адвокатов",
    supplementary: false,
    commissionAddressLines: ["г. Алматы", "kzppa.rka@gmail.com"],
  };
  for (const lang of ["ru", "kk"] as const) {
    it(`DOCX (${lang}) — корректный zip, детерминирован`, async () => {
      const a = await buildCoverLetterDocx(lang, data);
      expect(Buffer.from(a.slice(0, 2)).toString()).toBe("PK");
      const b = await buildCoverLetterDocx(lang, data);
      expect(await sha256Hex(a)).toBe(await sha256Hex(b));
      const mammoth = (await import("mammoth")).default;
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(a) });
      expect(value).toContain(lang === "kk" ? "Қосымша:" : "Приложение:");
      expect(value).toContain("Иванов Иван Иванович");
    });
  }
});

describe("FLOW-07 протокол", () => {
  it("формируется по итогам tally()", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${i}`);
    const t = tally({
      eligibleMemberIds: ids,
      votes: ids.slice(0, 20).map((m, i) => ({ memberId: m, choice: i === 3 ? "against" : i === 5 ? "abstain" : "for" })),
      quorumRule: { kind: "min_participants", min: 16, composition: 30 },
      decisionRule: { kind: "for_more_than_half_of_participants", source: "п. 5.3 Положения" },
    });
    expect(t.outcome).toBe("accepted");
    for (const lang of ["ru", "kk"] as const) {
      const pdf = await buildProtocolPdf({
        lang,
        commissionName: "Комиссия по защите профессиональных прав адвокатов РКА",
        caseNumber: "001",
        cycleNumber: 1,
        applicant: "Сейткали А.Б.",
        executorFullName: "Петров Пётр Петрович",
        chairFullName: "Иванов Иван Иванович",
        draftVersionLabel: "проект.docx (версия 2)",
        draftSha256: "a".repeat(64),
        openedAt: new Date("2026-10-01T05:00:00Z"),
        closedAt: new Date("2026-10-05T05:00:00Z"),
        eligible: ids.map((i) => ({ fullName: `Член ${i}` })),
        votes: ids.slice(0, 20).map((m, i) => ({ fullName: `Член ${m}`, choice: i === 3 ? "against" : i === 5 ? "abstain" : "for", specialOpinion: i === 3 ? "Нарушение не доказано." : null })),
        notParticipated: ids.slice(20).map((i) => ({ fullName: `Член ${i}` })),
        tally: t,
      });
      expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
      expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(1);
    }
  }, 30_000);
});

describe("ARCH-02 тестовый адаптер подписи", () => {
  it("сеанс → подтверждение → подпись → регистрация → проверка", async () => {
    const a = new DryRunSignAdapter();
    const bytes = new TextEncoder().encode("%PDF-1.7 test");
    const sha = await sha256Hex(bytes);
    const proc = await a.start({ documentName: "c.pdf", documentSha256: sha, description: "тест" });
    expect(proc.mobileLink).toContain(`/dev/sign/${proc.procedureId}`);
    expect(proc.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    const sub = await a.submit(proc, bytes, { documentName: "c.pdf" });
    await expect(a.submit(proc, new Uint8Array([1, 2, 3]), { documentName: "c.pdf" })).rejects.toThrow();
    approveDryRun(proc.procedureId, new Date("2026-10-21T10:00:00Z"));
    const r = await a.poll(sub.signUrl);
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    const sig = JSON.parse(new TextDecoder().decode(r.signature.cms));
    expect(sig).toEqual({ dryRun: true, sha256: sha, signedAt: "2026-10-21T10:00:00.000Z" });
    const reg = await a.register({ documentName: "c.pdf", documentBytes: bytes, cms: r.signature.cms, private: true });
    const v = await a.verify({ documentBytes: bytes, cms: r.signature.cms, registrationId: reg.registrationId });
    expect(v).toMatchObject({ cryptoValid: null, trustChecked: false, unavailable: false, signer: { commonName: "ТЕСТОВАЯ ПОДПИСЬ" }, details: { dryRun: true, hashMatches: true } });
    expect(await a.reconcile()).toBeNull();
  });
});
