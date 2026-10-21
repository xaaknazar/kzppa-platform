import "server-only";
/**
 * Начальное заполнение базы (вызывается скриптом scripts/seed.mts или страницей /setup).
 * Демонстрационные дела проходят маршрут через настоящие сервисы платформы
 * (регистрация → поручение → проект → голосование → протокол → PDF с QR → ЭЦП → комплект → отправка),
 * поэтому заполнение одновременно служит сквозной проверкой. Внешние отправки — только dry-run.
 */
import { eq, and } from "drizzle-orm";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db, schema } from "@/db/client";
import { putImmutable } from "./storage";
import { loadUserById } from "./auth";
import * as cases from "./services/cases";
import * as asg from "./services/assignments";
import * as cyc from "./services/cycles";
import * as out from "./services/outgoing";
import { ensureHandlers } from "./handlers";
import { processOutbox } from "./outbox";
import { env } from "./env";

const fontFile = (name: string) => readFile(path.join(process.cwd(), "src/server/docs/fonts", name));

function must<T>(r: { ok: true; data: T } | { ok: false; error: string }, what: string): T {
  if (!r.ok) throw new Error(`${what}: ${r.error}`);
  return r.data;
}


async function makePdf(title: string, paragraphs: string[]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setCreationDate(new Date("2026-10-01T09:00:00Z"));
  doc.setModificationDate(new Date("2026-10-01T09:00:00Z"));
  const font = await doc.embedFont(await fontFile("PT_Serif-Web-Regular.ttf"), { subset: true });
  const bold = await doc.embedFont(await fontFile("PT_Serif-Web-Bold.ttf"), { subset: true });
  let page = doc.addPage([595.28, 841.89]);
  let y = 780;
  page.drawText(title, { x: 70, y, size: 14, font: bold, color: rgb(0.09, 0.13, 0.17) });
  y -= 30;
  for (const p of paragraphs) {
    const words = p.split(" ");
    let line = "";
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, 11.5) > 455) {
        page.drawText(line, { x: 70, y, size: 11.5, font });
        y -= 16;
        line = w;
        if (y < 70) {
          page = doc.addPage([595.28, 841.89]);
          y = 780;
        }
      } else line = t;
    }
    if (line) page.drawText(line, { x: 70, y, size: 11.5, font });
    y -= 26;
  }
  return new Uint8Array(await doc.save());
}

async function makeDocx(title: string, paragraphs: string[]) {
  const d = new Document({
    creator: "Исполнитель",
    sections: [{ children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 28, font: "PT Serif" })] }), ...paragraphs.map((t) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: t, size: 24, font: "PT Serif" })] }))] }],
  });
  return new Uint8Array(await Packer.toBuffer(d));
}


export async function runSeed(opts: { demo: boolean; adminEmail?: string | null }): Promise<string[]> {
  const logs: string[] = [];
  const log = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    logs.push(line);
    console.log(line);
  };
  const demo = opts.demo;
  const adminEmail = (opts.adminEmail ?? "").toLowerCase();
  if (demo && (env.mailTransport !== "dry-run" || env.signProvider !== "dry-run")) {
    throw new Error("Демо-заполнение допускается только при MAIL_TRANSPORT=dry-run и SIGN_PROVIDER=dry-run");
  }


  function must<T>(r: { ok: true; data: T } | { ok: false; error: string }, what: string): T {
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    return r.data;
  }

  const fontBytes = await readFile(path.join(process.cwd(), "src/server/docs/fonts/PT_Serif-Web-Regular.ttf"));
  const boldBytes = await readFile(path.join(process.cwd(), "src/server/docs/fonts/PT_Serif-Web-Bold.ttf"));

  async function makePdf(title: string, paragraphs: string[]) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setCreationDate(new Date("2026-10-01T09:00:00Z"));
    doc.setModificationDate(new Date("2026-10-01T09:00:00Z"));
    const font = await doc.embedFont(fontBytes, { subset: true });
    const bold = await doc.embedFont(boldBytes, { subset: true });
    let page = doc.addPage([595.28, 841.89]);
    let y = 780;
    page.drawText(title, { x: 70, y, size: 14, font: bold, color: rgb(0.09, 0.13, 0.17) });
    y -= 30;
    for (const p of paragraphs) {
      const words = p.split(" ");
      let line = "";
      for (const w of words) {
        const t = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(t, 11.5) > 455) {
          page.drawText(line, { x: 70, y, size: 11.5, font });
          y -= 16;
          line = w;
          if (y < 70) {
            page = doc.addPage([595.28, 841.89]);
            y = 780;
          }
        } else line = t;
      }
      if (line) page.drawText(line, { x: 70, y, size: 11.5, font });
      y -= 26;
    }
    return new Uint8Array(await doc.save());
  }

  async function makeDocx(title: string, paragraphs: string[]) {
    const d = new Document({
      creator: "Исполнитель",
      sections: [{ children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 28, font: "PT Serif" })] }), ...paragraphs.map((t) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: t, size: 24, font: "PT Serif" })] }))] }],
    });
    return new Uint8Array(await Packer.toBuffer(d));
  }

  /* ───────── Организация ───────── */
  let org = await db.query.organizations.findFirst();
  if (!org) {
    [org] = await db
      .insert(schema.organizations)
      .values({
        name: "Комиссия по защите профессиональных прав адвокатов Республиканской коллегии адвокатов",
        nameKk: "Республикалық адвокаттар алқасының адвокаттардың кәсіби құқықтарын қорғау жөніндегі комиссиясы",
        shortName: "КЗППА РКА",
        officialSender: "kzppa.rka@gmail.com",
        rkaAddress: "office@advokatura.kz",
        rkaAddressee: "Председателю Республиканской коллегии адвокатов",
        outgoingPrefix: null,
        quorumRule: { kind: "min_participants", min: 16, composition: 30 },
        // DEC-02: правило решения переносится из действующего Положения. В демо — явная пометка.
        decisionRule: demo ? { kind: "for_more_than_half_of_participants", source: "ДЕМО: заменить формулой и пунктом действующего Положения" } : { kind: "unknown" },
      })
      .returning();
    log("Организация создана");
  }
  const orgId = org.id;

  async function addUser(u: { fullName: string; firstName: string; patronymic?: string | null; addressKk?: string | null; email: string; roles: string[]; collegium?: string }) {
    const existing = await db.query.users.findFirst({ where: and(eq(schema.users.organizationId, orgId), eq(schema.users.email, u.email)) });
    const row =
      existing ??
      (
        await db
          .insert(schema.users)
          .values({ organizationId: orgId, fullName: u.fullName, firstName: u.firstName, patronymic: u.patronymic ?? null, addressKk: u.addressKk ?? u.firstName, email: u.email, emailVerified: true, collegium: u.collegium ?? null })
          .returning()
      )[0];
    for (const role of u.roles) await db.insert(schema.orgRoles).values({ organizationId: orgId, userId: row.id, role }).onConflictDoNothing();
    return row;
  }

  if (adminEmail) {
    await addUser({ fullName: "Администратор платформы", firstName: "Администратор", email: adminEmail, roles: ["tech_admin", "chair", "secretary"] });
    log(`Администратор ${adminEmail} добавлен`);
  }

  if (!demo) {
    log("Готово (без демо-данных).");
    return logs;
  }

  if (await db.query.cases.findFirst({ where: eq(schema.cases.organizationId, orgId) })) {
    log("Демо-данные уже есть — пропускаю.");
    return logs;
  }

  /* ───────── Демонстрационный состав (30 человек, вымышленные) ───────── */
  const roster: [string, string, string | null, string][] = [
    ["Абдрахманов Ерлан Серикович", "Ерлан", "Серикович", "Алматинская городская коллегия адвокатов"],
    ["Калиева Динара Ахметовна", "Динара", "Ахметовна", "Коллегия адвокатов города Астаны"],
    ["Омарова Гульнар Бакытовна", "Гульнар", "Бакытовна", "Алматинская городская коллегия адвокатов"],
    ["Нурланов Арман Кайратович", "Арман", "Кайратович", "Карагандинская областная коллегия адвокатов"],
    ["Сергеева Ольга Викторовна", "Ольга", "Викторовна", "Восточно-Казахстанская областная коллегия адвокатов"],
    ["Ахметжанов Бауыржан Маратович", "Бауыржан", "Маратович", "Павлодарская областная коллегия адвокатов"],
    ["Байжанова Салтанат Ериковна", "Салтанат", "Ериковна", "Коллегия адвокатов города Шымкента"],
    ["Ким Виктор Александрович", "Виктор", "Александрович", "Алматинская городская коллегия адвокатов"],
    ["Есенова Айжан Нурлановна", "Айжан", "Нурлановна", "Атырауская областная коллегия адвокатов"],
    ["Жумабеков Талгат Ержанович", "Талгат", "Ержанович", "Жамбылская областная коллегия адвокатов"],
    ["Мусина Лаура Сериковна", "Лаура", "Сериковна", "Костанайская областная коллегия адвокатов"],
    ["Петров Андрей Николаевич", "Андрей", "Николаевич", "Северо-Казахстанская областная коллегия адвокатов"],
    ["Сатпаева Мадина Асхатовна", "Мадина", "Асхатовна", "Коллегия адвокатов города Астаны"],
    ["Тулегенов Нуржан Болатович", "Нуржан", "Болатович", "Актюбинская областная коллегия адвокатов"],
    ["Утебаева Жанар Кенесовна", "Жанар", "Кенесовна", "Мангистауская областная коллегия адвокатов"],
    ["Габдуллин Ринат Ильдарович", "Ринат", "Ильдарович", "Западно-Казахстанская областная коллегия адвокатов"],
    ["Дауренбекова Асель Муратовна", "Асель", "Муратовна", "Кызылординская областная коллегия адвокатов"],
    ["Ермеков Даурен Нурбекович", "Даурен", "Нурбекович", "Туркестанская областная коллегия адвокатов"],
    ["Исмаилова Эльмира Рашидовна", "Эльмира", "Рашидовна", "Алматинская областная коллегия адвокатов"],
    ["Кожахметов Серик Аманович", "Серик", "Аманович", "Акмолинская областная коллегия адвокатов"],
    ["Ли Наталья Сергеевна", "Наталья", "Сергеевна", "Алматинская городская коллегия адвокатов"],
    ["Мухамеджанов Азамат Тимурович", "Азамат", "Тимурович", "Коллегия адвокатов области Абай"],
    ["Нуртазина Гаухар Бериковна", "Гаухар", "Бериковна", "Коллегия адвокатов области Жетісу"],
    ["Оспанов Кайрат Жанатович", "Кайрат", "Жанатович", "Коллегия адвокатов области Ұлытау"],
    ["Рахимова Камила Ерлановна", "Камила", "Ерлановна", "Коллегия адвокатов города Шымкента"],
    ["Сарсенбаев Мурат Аскарович", "Мурат", "Аскарович", "Карагандинская областная коллегия адвокатов"],
    ["Тажибаева Индира Канатовна", "Индира", "Канатовна", "Павлодарская областная коллегия адвокатов"],
    ["Умаров Руслан Шамильевич", "Руслан", "Шамильевич", "Атырауская областная коллегия адвокатов"],
    ["Хасенова Алия Даулетовна", "Алия", "Даулетовна", "Коллегия адвокатов города Астаны"],
    ["Шайхутдинов Ильяс Маратович", "Ильяс", "Маратович", "Костанайская областная коллегия адвокатов"],
  ];
  const people = [];
  for (const [i, [fullName, firstName, patronymic, collegium]] of roster.entries()) {
    const roles = ["member", ...(i === 0 ? ["chair"] : []), ...(i === 1 ? ["secretary"] : [])];
    people.push(await addUser({ fullName, firstName, patronymic, collegium, email: `member${String(i + 1).padStart(2, "0")}@kzppa-demo.kz`, roles }));
  }
  const chairRow = people[0];
  const secretaryRow = people[1];

  /* Почтовый ящик комиссии — запись подключения (тестовый транспорт). */
  const [account] = await db
    .insert(schema.mailAccounts)
    .values({ organizationId: orgId, provider: "gmail", email: org.officialSender, state: "disabled" })
    .onConflictDoNothing()
    .returning();
  const accountId = account?.id ?? (await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.organizationId, orgId) }))!.id;

  /* Поступившее письмо: сохранение вложений через проверенное хранилище. */
  let seq = 1;
  async function ingest(p: { from: string; fromName?: string; subject: string; body: string; receivedAt: Date; files: { name: string; bytes: Uint8Array; mime: string }[]; pending?: { name: string; size: number }[]; kind?: string; threadId?: string; lang?: string }) {
    const id = `demo-${String(seq++).padStart(4, "0")}`;
    const [m] = await db
      .insert(schema.messages)
      .values({
        organizationId: orgId,
        accountId,
        providerMessageId: id,
        internetMessageId: `<${id}@mail.gmail.com>`,
        threadId: p.threadId ?? `thread-${id}`,
        direction: "in",
        sentAt: new Date(p.receivedAt.getTime() - 60_000),
        receivedAt: p.receivedAt,
        fromAddr: p.from,
        fromName: p.fromName ?? null,
        toAddrs: [org!.officialSender],
        subject: p.subject,
        bodyText: p.body,
        sourceCheck: { spf: "pass", dkim: "pass", dmarc: "pass", suspicious: [] },
        intakeState: "verified",
        intakeKind: p.kind ?? "initial",
        lang: p.lang ?? null,
      })
      .returning();
    let part = 1;
    for (const f of p.files) {
      const b = await putImmutable(orgId, f.bytes, f.mime);
      await db.insert(schema.attachments).values({ organizationId: orgId, messageId: m.id, partId: String(part++), filename: f.name, mimeType: f.mime, size: f.bytes.byteLength, sha256: b.sha256, blobId: b.id, status: "verified" });
    }
    for (const f of p.pending ?? []) {
      await db.insert(schema.attachments).values({ organizationId: orgId, messageId: m.id, partId: String(part++), filename: f.name, mimeType: "application/pdf", size: f.size, status: "pending", reason: "Загрузка прервана; повтор продолжит без дублей" });
    }
    if (p.pending?.length) await db.update(schema.messages).set({ intakeState: "incomplete" }).where(eq(schema.messages.id, m.id));
    return m;
  }

  const chair = (await loadUserById(chairRow.id))!;
  const secretary = (await loadUserById(secretaryRow.id))!;
  const k = () => crypto.randomUUID();
  const day = (n: number, h = 10) => new Date(Date.UTC(2026, 9, n, h - 5, 12));
  await ensureHandlers();

  const pdf = (t: string, ps: string[]) => makePdf(t, ps).then((bytes) => ({ name: `${t}.pdf`.replace(/[\\/:"]/g, ""), bytes, mime: "application/pdf" }));

  /* ═════════ Дело 001: полный маршрут до отправки в РКА ═════════ */
  {
    const m = await ingest({
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1351 Обращение адвоката Жубатовой А.С.",
      body:
        "Уважаемые коллеги!\n\nНаправляем для рассмотрения обращение адвоката Алматинской городской коллегии адвокатов Жубатовой Айгерим Сериковны о нарушении её профессиональных прав. Адвокату было отказано в допуске к подзащитному в изоляторе временного содержания под предлогом отсутствия согласования следователя, при наличии ордера и удостоверения. Просим рассмотреть обращение и подготовить заключение Комиссии.\n\nПриложение: на 3 л.\n\nС уважением,\nРеспубликанская коллегия адвокатов\nг. Астана",
      receivedAt: day(6),
      files: [
        await pdf("Обращение Жубатовой А.С.", ["Председателю Республиканской коллегии адвокатов.", "Прошу защитить мои профессиональные права: 2 октября 2026 года мне было отказано в допуске к подзащитному в ИВС.", "Ордер и удостоверение предъявлены. Отказ мотивирован отсутствием согласования следователя."]),
        await pdf("Копия ордера", ["Ордер № 001234 на защиту по уголовному делу.", "Выдан Алматинской городской коллегией адвокатов."]),
        await pdf("Рапорт дежурного ИВС", ["Рапорт о посещении адвокатом.", "В допуске отказано до получения разрешения следователя."]),
      ],
    });
    const c = must(await cases.registerCase(secretary, { messageId: m.id, applicant: "Жубатова Айгерим Сериковна", rkaNumber: "04-01/1351", rkaDate: "2026-10-05", lang: "ru", idempotencyKey: k() }), "Регистрация 001");
    const exec = people[2];
    const a = must(await asg.assignExecutor(chair, { caseId: c.caseId, executorId: exec.id, deadline: "2026-10-20", task: "изучить материалы обращения и подготовить проект заключения о нарушении права адвоката на свидание с подзащитным", idempotencyKey: k() }), "Назначение 001");
    must(await asg.approveAndSendAssignment(chair, { assignmentId: a.assignmentId, shownHash: a.letterHash, idempotencyKey: k() }), "Отправка поручения 001");
    await processOutbox({ limit: 10 });

    const draftBytes = await makeDocx("Проект заключения по обращению адвоката Жубатовой А.С.", [
      "Комиссия по защите профессиональных прав адвокатов рассмотрела обращение адвоката Жубатовой Айгерим Сериковны.",
      "Установлено, что 2 октября 2026 года адвокату при предъявлении ордера и удостоверения было отказано в свидании с подзащитным в изоляторе временного содержания.",
      "Законодательство не требует согласования следователя для свидания защитника с подзащитным. Отказ нарушает профессиональные права адвоката.",
      "Комиссия рекомендует Республиканской коллегии адвокатов направить обращение в органы прокуратуры.",
    ]);
    const reply = await ingest({ from: exec.email, fromName: exec.fullName, subject: "Re: КЗППА: поручение по делу №001 — Жубатова Айгерим Сериковна", body: "Добрый день! Направляю проект заключения.", receivedAt: day(14), kind: "executor_reply", files: [{ name: "Проект заключения Жубатова.docx", bytes: draftBytes, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] });
    must(await cases.attachManually(secretary, { messageId: reply.id, caseId: c.caseId, basis: "Ответ исполнителя в цепочке поручения", idempotencyKey: k() }), "Проект 001");

    let kase = (await db.query.cases.findFirst({ where: eq(schema.cases.id, c.caseId) }))!;
    let cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, kase.currentCycleId!) }))!;
    const draft = (await db.select().from(schema.documentVersions).innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId)).where(and(eq(schema.documents.caseId, c.caseId), eq(schema.documents.category, "draft"))))[0];
    must(await cyc.preapproveDraft(chair, { cycleId: cycle.id, draftVersionId: draft.document_versions.id, decision: "approve", expectedVersion: cycle.version }), "Предодобрение 001");
    cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, cycle.id) }))!;
    must(await cyc.openVoting(chair, { cycleId: cycle.id, closesAt: new Date(Date.now() + 3600_000).toISOString(), expectedVersion: cycle.version }), "Голосование 001");
    // AT-31: состав 30, за 23, против 0, воздержался 1, не участвовали 6
    for (let i = 0; i < 24; i++) {
      const voter = (await loadUserById(people[i].id))!;
      must(await cyc.castVote(voter, { cycleId: cycle.id, choice: i === 23 ? "abstain" : "for", idempotencyKey: k() }), `Голос ${i}`);
    }
    cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, cycle.id) }))!;
    must(await cyc.closeVoting(chair, { cycleId: cycle.id, earlyBasis: "Проголосовали все члены, которые могли участвовать", expectedVersion: cycle.version }), "Протокол 001");
    cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, cycle.id) }))!;
    must(await cyc.chooseFinalRoute(chair, { cycleId: cycle.id, route: "as_is", expectedVersion: cycle.version }), "Маршрут 001");
    cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, cycle.id) }))!;
    must(await cyc.approveFinal(chair, { cycleId: cycle.id, versionId: cycle.draftVersionId!, expectedVersion: cycle.version }), "Утверждение 001");
    cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, cycle.id) }))!;
    const prep = must(await cyc.prepareSignablePdf(chair, { cycleId: cycle.id, expectedVersion: cycle.version }), "PDF 001");

    // ЭЦП в тестовом режиме: сеанс → «подтверждение» на тестовой странице → фоновый приём подписи.
    const signing = await import("./services/signing");
    const s = must(await signing.startSigning(chair, { documentVersionId: prep.versionId, idempotencyKey: k() }), "Подписание 001") as { sessionId: string };
    const sess = (await db.query.signSessions.findFirst({ where: eq(schema.signSessions.id, s.sessionId) }))!;
    await db.update(schema.signSessions).set({ urls: { ...(sess.urls as object), devApproved: true } }).where(eq(schema.signSessions.id, s.sessionId));
    for (let i = 0; i < 6; i++) {
      await db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.status, "pending"));
      await processOutbox({ limit: 10 });
      const st = (await db.query.signSessions.findFirst({ where: eq(schema.signSessions.id, s.sessionId) }))!;
      if (st.state === "verified") break;
    }
    const finalSess = (await db.query.signSessions.findFirst({ where: eq(schema.signSessions.id, s.sessionId) }))!;
    log(`  ЭЦП дела 001: ${finalSess.state}`);
    if (finalSess.state === "verified") {
      const p = must(await out.prepareRkaPackage(secretary, { cycleId: cycle.id, includeDraftVersionIds: [cycle.draftVersionId!], idempotencyKey: k() }), "Комплект 001");
      const o = (await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, p.outgoingId) }))!;
      must(await out.approveAndSendPackage(chair, { outgoingId: o.id, shownHash: o.packageHash!, idempotencyKey: k() }), "Отправка в РКА 001");
      await processOutbox({ limit: 10 });
    }
    kase = (await db.query.cases.findFirst({ where: eq(schema.cases.id, c.caseId) }))!;
    log(`Дело 001: ${kase.state}`);
  }

  /* ═════════ Дело 002: на казахском, идёт голосование ═════════ */
  {
    const m = await ingest({
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1402 Адвокат Ахметов Б.К. өтініші",
      body:
        "Құрметті әріптестер!\n\nҚарағанды облыстық адвокаттар алқасының адвокаты Ахметов Бауыржан Кайратұлының кәсіби құқықтарын бұзу туралы өтінішін қарауға жолдаймыз. Адвокатқа тергеу әрекеттеріне қатысуға рұқсат берілмеген және оның қорғауындағы адамның істі материалдарымен танысу құқығы шектелген. Өтінішті қарап, Комиссия қорытындысын дайындауды сұраймыз.\n\nҚұрметпен,\nРеспубликалық адвокаттар алқасы",
      receivedAt: day(10),
      lang: "kk",
      files: [await pdf("Ахметов Б.К. өтініші", ["Республикалық адвокаттар алқасының төрағасына.", "Менің кәсіби құқықтарымды қорғауды сұраймын: тергеу әрекеттеріне қатысуға рұқсат берілмеді."])],
    });
    const c = must(await cases.registerCase(secretary, { messageId: m.id, applicant: "Ахметов Бауыржан Кайратұлы", rkaNumber: "04-01/1402", rkaDate: "2026-10-09", idempotencyKey: k() }), "Регистрация 002");
    const exec = people[3];
    const a = must(await asg.assignExecutor(chair, { caseId: c.caseId, executorId: exec.id, deadline: "2026-10-28", task: "өтініш материалдарын зерделеу және Комиссия қорытындысының жобасын дайындау", idempotencyKey: k() }), "Назначение 002");
    must(await asg.approveAndSendAssignment(chair, { assignmentId: a.assignmentId, shownHash: a.letterHash, idempotencyKey: k() }), "Отправка поручения 002");
    await processOutbox({ limit: 10 });
    const draftBytes = await makeDocx("Ахметов Б.К. өтініші бойынша қорытынды жобасы", [
      "Адвокаттардың кәсіби құқықтарын қорғау жөніндегі комиссия адвокат Ахметов Бауыржан Кайратұлының өтінішін қарады.",
      "Адвокатқа тергеу әрекеттеріне қатысуға негізсіз рұқсат берілмегені анықталды. Бұл адвокаттың кәсіби құқықтарын бұзу болып табылады.",
    ]);
    const reply = await ingest({ from: exec.email, fromName: exec.fullName, subject: "Re: КЗППА: №002 іс бойынша тапсырма — Ахметов Бауыржан Кайратұлы", body: "Қорытынды жобасын жолдаймын.", receivedAt: day(18), kind: "executor_reply", lang: "kk", files: [{ name: "Қорытынды жобасы Ахметов.docx", bytes: draftBytes, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] });
    must(await cases.attachManually(secretary, { messageId: reply.id, caseId: c.caseId, basis: "Ответ исполнителя", idempotencyKey: k() }), "Проект 002");
    const kase = (await db.query.cases.findFirst({ where: eq(schema.cases.id, c.caseId) }))!;
    let cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, kase.currentCycleId!) }))!;
    const draft = (await db.select().from(schema.documentVersions).innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId)).where(and(eq(schema.documents.caseId, c.caseId), eq(schema.documents.category, "draft"))))[0];
    must(await cyc.preapproveDraft(chair, { cycleId: cycle.id, draftVersionId: draft.document_versions.id, decision: "approve", expectedVersion: cycle.version }), "Предодобрение 002");
    cycle = (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, cycle.id) }))!;
    must(await cyc.openVoting(chair, { cycleId: cycle.id, closesAt: new Date(Date.now() + 3 * 86400_000).toISOString(), expectedVersion: cycle.version }), "Голосование 002");
    for (let i = 1; i < 13; i++) {
      if (i === 3) continue;
      const voter = (await loadUserById(people[i].id))!;
      must(await cyc.castVote(voter, { cycleId: cycle.id, choice: i === 7 ? "against" : "for", idempotencyKey: k() }), `Голос 002/${i}`);
    }
    log("Дело 002: голосование открыто");
  }

  /* ═════════ Дело 003: поручение ждёт утверждения текста ═════════ */
  {
    const m = await ingest({
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1410 Обращение адвоката Рамазановой Д.Е.",
      body: "Уважаемые коллеги!\n\nНаправляем обращение адвоката Восточно-Казахстанской областной коллегии адвокатов Рамазановой Динары Ериковны о вызове адвоката на допрос в качестве свидетеля по обстоятельствам, ставшим ей известными в связи с оказанием юридической помощи. Просим рассмотреть.\n\nРеспубликанская коллегия адвокатов",
      receivedAt: day(17),
      files: [await pdf("Обращение Рамазановой Д.Е.", ["Прошу оценить правомерность вызова адвоката на допрос в качестве свидетеля по делу подзащитного."]), await pdf("Повестка о вызове", ["Повестка о вызове на допрос в качестве свидетеля на 15 октября 2026 года."])],
    });
    const c = must(await cases.registerCase(secretary, { messageId: m.id, applicant: "Рамазанова Динара Ериковна", rkaNumber: "04-01/1410", rkaDate: "2026-10-16", lang: "ru", idempotencyKey: k() }), "Регистрация 003");
    must(await asg.assignExecutor(chair, { caseId: c.caseId, executorId: people[4].id, deadline: "2026-11-05", task: "изучить материалы обращения и подготовить проект заключения о допустимости допроса адвоката в качестве свидетеля", idempotencyKey: k() }), "Назначение 003");
    log("Дело 003: поручение на утверждении");
  }

  /* ═════════ Очередь разбора ═════════ */
  {
    // Новое обращение — регистрацию подтверждает человек (CASE-01).
    const m = await ingest({
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1433 Обращение адвоката Сулейменова Н.А.",
      body: "Уважаемые коллеги!\n\nНаправляем обращение адвоката Павлодарской областной коллегии адвокатов Сулейменова Нурлана Асылбековича о проведении обыска в помещении юридической консультации без санкции суда. Просим рассмотреть.\n\nРеспубликанская коллегия адвокатов",
      receivedAt: day(20),
      files: [await pdf("Обращение Сулейменова Н.А.", ["Прошу защитить профессиональные права: в помещении юридической консультации проведён обыск."])],
    });
    await db.update(schema.messages).set({ intakeState: "needs_review", match: { kind: "new_case", reasons: ["Новое обращение от РКА, существующее дело не найдено"], candidates: [] } }).where(eq(schema.messages.id, m.id));
    await db.insert(schema.tasks).values({ organizationId: orgId, kind: "intake_new_case", title: "Новое обращение от РКА: подтвердите регистрацию (04-01/1433, Сулейменов Н.А.)", assigneeRole: "secretary", objectType: "message", objectId: m.id, dedupKey: `intake_new_case:${m.id}` });

    // AT-01: 14 вложений, загружены 3 — неполное поступление.
    const parts = await Promise.all([1, 2, 3].map((i) => pdf(`Материал ${i} Кенжебаевой`, [`Материал дела № ${i}.`])));
    const m2 = await ingest({
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1440 Обращение адвоката Кенжебаевой Ж.М. (14 вложений)",
      body: "Уважаемые коллеги!\n\nНаправляем обращение адвоката Кенжебаевой Жанар Муратовны с материалами на 14 листах.\n\nРеспубликанская коллегия адвокатов",
      receivedAt: day(21, 9),
      files: parts,
      pending: Array.from({ length: 11 }, (_, i) => ({ name: `Материал ${i + 4} Кенжебаевой.pdf`, size: 180_000 + i * 1000 })),
    });
    await db.update(schema.messages).set({ match: { kind: "new_case", reasons: ["Новое обращение от РКА, существующее дело не найдено"], candidates: [] } }).where(eq(schema.messages.id, m2.id));
    await db.insert(schema.tasks).values({ organizationId: orgId, kind: "intake_review", title: "Загрузка вложений не завершена: 3 из 14 (04-01/1440, Кенжебаева Ж.М.)", assigneeRole: "secretary", objectType: "message", objectId: m2.id, dedupKey: `intake_review:${m2.id}` });
    log("Очередь разбора: 2 письма");
  }

  log("Демо-заполнение завершено.");
  return logs;
}
