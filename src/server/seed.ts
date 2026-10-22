import "server-only";
/**
 * Начальное заполнение базы (scripts/seed.mts или страница /setup).
 *
 * Демонстрационные дела проходят маршрут через настоящие сервисы платформы
 * (регистрация → поручение → проект → голосование → протокол → PDF с QR → ЭЦП → комплект → отправка),
 * поэтому заполнение одновременно служит сквозной проверкой. Внешние отправки — только dry-run.
 *
 * Заполнение разбито на этапы: функция на Vercel ограничена по времени, поэтому /setup
 * выполняет этапы порциями и продолжает с места остановки. Каждый этап идемпотентен:
 * прерванный этап при повторе пропускает уже сделанное.
 */
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db, schema } from "@/db/client";
import { putImmutable } from "./storage";
import { loadUserById, type SessionUser } from "./auth";
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

const ROSTER: [string, string, string | null, string][] = [
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
export const DEMO_STAGES = [
  { key: "base", label: "Организация и состав комиссии" },
  { key: "c1_intake", label: "Дело 001: регистрация и поручение" },
  { key: "c1_draft", label: "Дело 001: проект и открытие голосования" },
  { key: "c1_votes", label: "Дело 001: голосование" },
  { key: "c1_close", label: "Дело 001: протокол и утверждение" },
  { key: "c1_pdf", label: "Дело 001: PDF с QR и ЭЦП" },
  { key: "c1_send", label: "Дело 001: комплект и направление в РКА" },
  { key: "c2_intake", label: "Дело 002: регистрация и поручение" },
  { key: "c2_vote", label: "Дело 002: проект и голосование" },
  { key: "c3", label: "Дело 003: поручение на утверждении" },
  { key: "queue", label: "Очередь разбора почты" },
] as const;
export type StageKey = (typeof DEMO_STAGES)[number]["key"];

const k = () => crypto.randomUUID();
const day = (n: number, h = 10) => new Date(Date.UTC(2026, 9, n, h - 5, 12));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function seedProgress() {
  const org = await db.query.organizations.findFirst();
  const done = ((org?.policies as { seedStages?: string[] } | null)?.seedStages ?? []) as string[];
  return { org, done, demoComplete: DEMO_STAGES.every((s) => done.includes(s.key)) };
}

async function markDone(orgId: string, stage: string) {
  await db.execute(sql`update organizations set policies = jsonb_set(coalesce(policies, '{}'::jsonb), '{seedStages}', coalesce(policies->'seedStages', '[]'::jsonb) || to_jsonb(${stage}::text)) where id = ${orgId} and not coalesce(policies->'seedStages', '[]'::jsonb) ? ${stage}`);
}

interface Ctx {
  orgId: string;
  org: typeof schema.organizations.$inferSelect;
  accountId: string;
  people: (typeof schema.users.$inferSelect)[];
  chair: SessionUser;
  secretary: SessionUser;
  log: (...a: unknown[]) => void;
  /** Момент, после которого длинные этапы останавливаются и продолжаются в следующем вызове. */
  deadline: number;
}

async function createOrg(_demo: boolean) {
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
        // DEC-02: правило решения — из действующего Положения (п. 20): большинство голосов присутствующих,
        // при равенстве голосов решающий голос председателя.
        decisionRule: { kind: "for_more_than_half_of_participants", source: "п. 20 Положения о Комиссии по защите профессиональных прав адвокатов РКА (утв. Республиканской конференцией коллегий адвокатов 19.02.2022)", chairCastingVote: true },
        policies: {},
      })
      .returning();
  }
  return org;
}

async function addUser(orgId: string, u: { fullName: string; firstName: string; patronymic?: string | null; addressKk?: string | null; email: string; roles: string[]; collegium?: string }) {
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

const demoEmail = (i: number) => `member${String(i + 1).padStart(2, "0")}@kzppa-demo.kz`;

async function loadCtx(log: Ctx["log"], deadline: number): Promise<Ctx> {
  const org = (await db.query.organizations.findFirst())!;
  const people: Ctx["people"] = [];
  for (let i = 0; i < ROSTER.length; i++) {
    const u = await db.query.users.findFirst({ where: and(eq(schema.users.organizationId, org.id), eq(schema.users.email, demoEmail(i))) });
    if (!u) throw new Error("Демонстрационный состав не создан");
    people.push(u);
  }
  const account = await db.query.mailAccounts.findFirst({ where: eq(schema.mailAccounts.organizationId, org.id) });
  return { orgId: org.id, org, accountId: account!.id, people, chair: (await loadUserById(people[0].id))!, secretary: (await loadUserById(people[1].id))!, log, deadline };
}

/** Поступившее письмо с проверенными вложениями. Повтор с тем же ключом возвращает существующее. */
async function ingest(ctx: Ctx, key: string, p: { from: string; fromName?: string; subject: string; body: string; receivedAt: Date; files: () => Promise<{ name: string; bytes: Uint8Array; mime: string }[]>; pending?: { name: string; size: number }[]; kind?: string; lang?: string }) {
  const providerMessageId = `demo-${key}`;
  const existing = await db.query.messages.findFirst({ where: and(eq(schema.messages.accountId, ctx.accountId), eq(schema.messages.providerMessageId, providerMessageId)) });
  if (existing) return existing;
  const files = await p.files();
  const blobs: { f: { name: string; bytes: Uint8Array; mime: string }; b: Awaited<ReturnType<typeof putImmutable>> }[] = [];
  for (const f of files) blobs.push({ f, b: await putImmutable(ctx.orgId, f.bytes, f.mime) });
  return db.transaction(async (tx) => {
    const [m] = await tx
      .insert(schema.messages)
      .values({
        organizationId: ctx.orgId,
        accountId: ctx.accountId,
        providerMessageId,
        internetMessageId: `<${providerMessageId}@mail.gmail.com>`,
        threadId: `thread-${providerMessageId}`,
        direction: "in",
        sentAt: new Date(p.receivedAt.getTime() - 60_000),
        receivedAt: p.receivedAt,
        fromAddr: p.from,
        fromName: p.fromName ?? null,
        toAddrs: [ctx.org.officialSender],
        subject: p.subject,
        bodyText: p.body,
        sourceCheck: { spf: "pass", dkim: "pass", dmarc: "pass", suspicious: false, flags: [] },
        intakeState: p.pending?.length ? "incomplete" : "verified",
        intakeKind: p.kind ?? "initial",
        lang: p.lang ?? null,
      })
      .returning();
    let part = 1;
    for (const { f, b } of blobs) {
      await tx.insert(schema.attachments).values({ organizationId: ctx.orgId, messageId: m.id, partId: String(part++), filename: f.name, mimeType: f.mime, size: f.bytes.byteLength, sha256: b.sha256, blobId: b.id, status: "verified" });
    }
    for (const f of p.pending ?? []) {
      await tx.insert(schema.attachments).values({ organizationId: ctx.orgId, messageId: m.id, partId: String(part++), filename: f.name, mimeType: "application/pdf", size: f.size, status: "pending", reason: "Загрузка прервана; повтор продолжит без дублей" });
    }
    return m;
  });
}

const pdf = (t: string, ps: string[]) => makePdf(t, ps).then((bytes) => ({ name: `${t}.pdf`.replace(/[\\/:"]/g, ""), bytes, mime: "application/pdf" }));

async function caseByRka(orgId: string, rka: string) {
  return db.query.cases.findFirst({ where: and(eq(schema.cases.organizationId, orgId), eq(schema.cases.rkaNumber, rka)) });
}
async function currentCycle(caseId: string) {
  const kase = (await db.query.cases.findFirst({ where: eq(schema.cases.id, caseId) }))!;
  return (await db.query.cycles.findFirst({ where: eq(schema.cycles.id, kase.currentCycleId!) }))!;
}
async function firstDraft(caseId: string) {
  const r = await db.select().from(schema.documentVersions).innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId)).where(and(eq(schema.documents.caseId, caseId), eq(schema.documents.category, "draft")));
  return r[0]?.document_versions;
}

/** Регистрация + назначение + (по желанию) утверждение и отправка поручения. */
async function intakeAndAssign(ctx: Ctx, p: { key: string; rka: string; rkaDate: string; applicant: string; lang?: "ru" | "kk"; executor: number; deadline: string; task: string; send: boolean; mail: Parameters<typeof ingest>[2] }) {
  let kase = await caseByRka(ctx.orgId, p.rka);
  if (!kase) {
    const m = await ingest(ctx, p.key, p.mail);
    const c = must(await cases.registerCase(ctx.secretary, { messageId: m.id, applicant: p.applicant, rkaNumber: p.rka, rkaDate: p.rkaDate, lang: p.lang ?? null, idempotencyKey: k() }), `Регистрация ${p.rka}`);
    kase = (await db.query.cases.findFirst({ where: eq(schema.cases.id, c.caseId) }))!;
  }
  let a = await db.query.assignments.findFirst({ where: eq(schema.assignments.caseId, kase.id) });
  if (!a) {
    must(await asg.assignExecutor(ctx.chair, { caseId: kase.id, executorId: ctx.people[p.executor].id, deadline: p.deadline, task: p.task, idempotencyKey: k() }), `Назначение ${p.rka}`);
    a = (await db.query.assignments.findFirst({ where: eq(schema.assignments.caseId, kase.id) }))!;
  }
  if (p.send && a.state === "text_on_approval") {
    must(await asg.approveAndSendAssignment(ctx.chair, { assignmentId: a.id, shownHash: a.letterHash!, idempotencyKey: k() }), `Отправка поручения ${p.rka}`);
  }
  if (p.send) await processOutbox({ limit: 10 });
  return kase;
}

async function draftAndOpen(ctx: Ctx, p: { caseRka: string; key: string; executor: number; subject: string; body: string; lang?: string; title: string; paragraphs: string[]; fileName: string; receivedAt: Date; closesInMs: number }) {
  const kase = (await caseByRka(ctx.orgId, p.caseRka))!;
  if (!(await firstDraft(kase.id))) {
    const exec = ctx.people[p.executor];
    const reply = await ingest(ctx, p.key, { from: exec.email, fromName: exec.fullName, subject: p.subject, body: p.body, receivedAt: p.receivedAt, kind: "executor_reply", lang: p.lang, files: async () => [{ name: p.fileName, bytes: await makeDocx(p.title, p.paragraphs), mime: DOCX }] });
    must(await cases.attachManually(ctx.secretary, { messageId: reply.id, caseId: kase.id, basis: "Ответ исполнителя в цепочке поручения", idempotencyKey: k() }), "Приобщение проекта");
  }
  let cycle = await currentCycle(kase.id);
  if (cycle.state === "preparation") {
    const draft = (await firstDraft(kase.id))!;
    must(await cyc.preapproveDraft(ctx.chair, { cycleId: cycle.id, draftVersionId: draft.id, decision: "approve", expectedVersion: cycle.version }), "Предварительное одобрение");
    cycle = await currentCycle(kase.id);
  }
  if (cycle.state === "preapproved") {
    must(await cyc.openVoting(ctx.chair, { cycleId: cycle.id, closesAt: new Date(Date.now() + p.closesInMs).toISOString(), expectedVersion: cycle.version }), "Открытие голосования");
  }
  return kase;
}

/** Возвращает false, если не успели подать все голоса до дедлайна — этап продолжится в следующем вызове. */
async function castVotes(ctx: Ctx, caseRka: string, plan: { index: number; choice: "for" | "against" | "abstain" }[]): Promise<boolean> {
  const kase = (await caseByRka(ctx.orgId, caseRka))!;
  const cycle = await currentCycle(kase.id);
  if (cycle.state !== "voting") return true;
  const already = new Set((await db.query.votes.findMany({ where: eq(schema.votes.cycleId, cycle.id) })).map((v) => v.memberId));
  let cast = 0;
  for (const v of plan) {
    const member = ctx.people[v.index];
    if (already.has(member.id)) continue;
    if (cast > 0 && Date.now() > ctx.deadline) return false; // хотя бы один голос за вызов — прогресс гарантирован
    cast++;
    const voter = (await loadUserById(member.id))!;
    must(await cyc.castVote(voter, { cycleId: cycle.id, choice: v.choice, idempotencyKey: k() }), `Голос ${v.index + 1}`);
  }
  return true;
}

/** Этап возвращает false, если выполнен частично и должен продолжиться в следующем вызове. */
const STAGES: Record<StageKey, (ctx: Ctx) => Promise<void | boolean>> = {
  base: async () => {},

  c1_intake: async (ctx) => {
    await intakeAndAssign(ctx, {
      key: "c1-initial",
      rka: "04-01/1351",
      rkaDate: "2026-10-05",
      applicant: "Жубатова Айгерим Сериковна",
      lang: "ru",
      executor: 2,
      deadline: "2026-10-20",
      task: "изучить материалы обращения и подготовить проект заключения о нарушении права адвоката на свидание с подзащитным",
      send: true,
      mail: {
        from: "office@advokatura.kz",
        fromName: "Республиканская коллегия адвокатов",
        subject: "04-01/1351 Обращение адвоката Жубатовой А.С.",
        body: "Уважаемые коллеги!\n\nНаправляем для рассмотрения обращение адвоката Алматинской городской коллегии адвокатов Жубатовой Айгерим Сериковны о нарушении её профессиональных прав. Адвокату было отказано в допуске к подзащитному в изоляторе временного содержания под предлогом отсутствия согласования следователя, при наличии ордера и удостоверения. Просим рассмотреть обращение и подготовить заключение Комиссии.\n\nПриложение: на 3 л.\n\nС уважением,\nРеспубликанская коллегия адвокатов\nг. Астана",
        receivedAt: day(6),
        files: async () => [
          await pdf("Обращение Жубатовой А.С.", ["Председателю Республиканской коллегии адвокатов.", "Прошу защитить мои профессиональные права: 2 октября 2026 года мне было отказано в допуске к подзащитному в ИВС.", "Ордер и удостоверение предъявлены. Отказ мотивирован отсутствием согласования следователя."]),
          await pdf("Копия ордера", ["Ордер № 001234 на защиту по уголовному делу.", "Выдан Алматинской городской коллегией адвокатов."]),
          await pdf("Рапорт дежурного ИВС", ["Рапорт о посещении адвокатом.", "В допуске отказано до получения разрешения следователя."]),
        ],
      },
    });
  },

  c1_draft: async (ctx) => {
    await draftAndOpen(ctx, {
      caseRka: "04-01/1351",
      key: "c1-draft",
      executor: 2,
      subject: "Re: КЗППА: поручение по делу №001 — Жубатова Айгерим Сериковна",
      body: "Добрый день! Направляю проект заключения.",
      receivedAt: day(14),
      title: "Проект заключения по обращению адвоката Жубатовой А.С.",
      fileName: "Проект заключения Жубатова.docx",
      paragraphs: [
        "Комиссия по защите профессиональных прав адвокатов рассмотрела обращение адвоката Жубатовой Айгерим Сериковны.",
        "Установлено, что 2 октября 2026 года адвокату при предъявлении ордера и удостоверения было отказано в свидании с подзащитным в изоляторе временного содержания.",
        "Законодательство не требует согласования следователя для свидания защитника с подзащитным. Отказ нарушает профессиональные права адвоката.",
        "Комиссия рекомендует Республиканской коллегии адвокатов направить обращение в органы прокуратуры.",
      ],
      closesInMs: 3600_000,
    });
  },

  // AT-31: состав 30, за 23, против 0, воздержался 1, не участвовали 6
  c1_votes: async (ctx) => {
    return castVotes(ctx, "04-01/1351", Array.from({ length: 24 }, (_, i) => ({ index: i, choice: i === 23 ? ("abstain" as const) : ("for" as const) })));
  },

  c1_close: async (ctx) => {
    const kase = (await caseByRka(ctx.orgId, "04-01/1351"))!;
    let cycle = await currentCycle(kase.id);
    if (cycle.state === "voting") {
      must(await cyc.closeVoting(ctx.chair, { cycleId: cycle.id, earlyBasis: "Проголосовали все члены, которые могли участвовать", expectedVersion: cycle.version }), "Протокол 001");
      cycle = await currentCycle(kase.id);
    }
    if (!cycle.finalRoute) {
      must(await cyc.chooseFinalRoute(ctx.chair, { cycleId: cycle.id, route: "as_is", expectedVersion: cycle.version }), "Маршрут 001");
      cycle = await currentCycle(kase.id);
    }
    if (!cycle.approvedAt) must(await cyc.approveFinal(ctx.chair, { cycleId: cycle.id, versionId: cycle.draftVersionId!, expectedVersion: cycle.version }), "Утверждение 001");
  },

  c1_pdf: async (ctx) => {
    const kase = (await caseByRka(ctx.orgId, "04-01/1351"))!;
    const cycle = await currentCycle(kase.id);
    let card = await db.query.qrCards.findFirst({ where: eq(schema.qrCards.cycleId, cycle.id) });
    if (!card) {
      must(await cyc.prepareSignablePdf(ctx.chair, { cycleId: cycle.id, expectedVersion: cycle.version }), "PDF 001");
      card = (await db.query.qrCards.findFirst({ where: eq(schema.qrCards.cycleId, cycle.id) }))!;
    }
    // ЭЦП в тестовом режиме: сеанс → «подтверждение» на тестовой странице → фоновый приём подписи.
    let sess = await db.query.signSessions.findFirst({ where: eq(schema.signSessions.documentVersionId, card.documentVersionId) });
    if (!sess) {
      const signing = await import("./services/signing");
      const s = must(await signing.startSigning(ctx.chair, { documentVersionId: card.documentVersionId, idempotencyKey: k() }), "Подписание 001") as { sessionId: string };
      sess = (await db.query.signSessions.findFirst({ where: eq(schema.signSessions.id, s.sessionId) }))!;
    }
    if (!(sess.urls as { devApproved?: boolean } | null)?.devApproved) {
      await db.update(schema.signSessions).set({ urls: { ...(sess.urls as object), devApproved: true } }).where(eq(schema.signSessions.id, sess.id));
    }
  },

  c1_send: async (ctx) => {
    const kase = (await caseByRka(ctx.orgId, "04-01/1351"))!;
    const cycle = await currentCycle(kase.id);
    const card = (await db.query.qrCards.findFirst({ where: eq(schema.qrCards.cycleId, cycle.id) }))!;
    // Фоновый приём подписи: опрос → сохранение → регистрация → проверка (SIGN-03/04).
    for (let i = 0; i < 30; i++) {
      const st = (await db.query.signSessions.findFirst({ where: eq(schema.signSessions.documentVersionId, card.documentVersionId) }))!;
      if (["verified", "expired", "refused", "error", "auth_required"].includes(st.state)) break;
      await db.update(schema.outbox).set({ nextAttemptAt: new Date(), lockedUntil: null }).where(eq(schema.outbox.status, "pending"));
      await processOutbox({ limit: 10 });
      await new Promise((r) => setTimeout(r, 400));
    }
    const st = (await db.query.signSessions.findFirst({ where: eq(schema.signSessions.documentVersionId, card.documentVersionId) }))!;
    ctx.log(`ЭЦП дела 001: ${st.state}`);
    if (st.state !== "verified") throw new Error(`Подпись дела 001 не проверена: ${st.state}`);
    let pkg = await db.query.outgoings.findFirst({ where: and(eq(schema.outgoings.cycleId, cycle.id), eq(schema.outgoings.kind, "rka_package")) });
    if (!pkg) {
      const p = must(await out.prepareRkaPackage(ctx.secretary, { cycleId: cycle.id, includeDraftVersionIds: [cycle.draftVersionId!], idempotencyKey: k() }), "Комплект 001");
      pkg = (await db.query.outgoings.findFirst({ where: eq(schema.outgoings.id, p.outgoingId) }))!;
    }
    if (pkg.state === "draft") must(await out.approveAndSendPackage(ctx.chair, { outgoingId: pkg.id, shownHash: pkg.packageHash!, idempotencyKey: k() }), "Отправка в РКА 001");
    await processOutbox({ limit: 10 });
  },

  c2_intake: async (ctx) => {
    await intakeAndAssign(ctx, {
      key: "c2-initial",
      rka: "04-01/1402",
      rkaDate: "2026-10-09",
      applicant: "Ахметов Бауыржан Кайратұлы",
      executor: 3,
      deadline: "2026-10-28",
      task: "өтініш материалдарын зерделеу және Комиссия қорытындысының жобасын дайындау",
      send: true,
      mail: {
        from: "office@advokatura.kz",
        fromName: "Республиканская коллегия адвокатов",
        subject: "04-01/1402 Адвокат Ахметов Б.К. өтініші",
        body: "Құрметті әріптестер!\n\nҚарағанды облыстық адвокаттар алқасының адвокаты Ахметов Бауыржан Кайратұлының кәсіби құқықтарын бұзу туралы өтінішін қарауға жолдаймыз. Адвокатқа тергеу әрекеттеріне қатысуға рұқсат берілмеген және оның қорғауындағы адамның істі материалдарымен танысу құқығы шектелген. Өтінішті қарап, Комиссия қорытындысын дайындауды сұраймыз.\n\nҚұрметпен,\nРеспубликалық адвокаттар алқасы",
        receivedAt: day(10),
        lang: "kk",
        files: async () => [await pdf("Ахметов Б.К. өтініші", ["Республикалық адвокаттар алқасының төрағасына.", "Менің кәсіби құқықтарымды қорғауды сұраймын: тергеу әрекеттеріне қатысуға рұқсат берілмеді."])],
      },
    });
  },

  c2_vote: async (ctx) => {
    await draftAndOpen(ctx, {
      caseRka: "04-01/1402",
      key: "c2-draft",
      executor: 3,
      subject: "Re: КЗППА: №002 іс бойынша тапсырма — Ахметов Бауыржан Кайратұлы",
      body: "Қорытынды жобасын жолдаймын.",
      lang: "kk",
      receivedAt: day(18),
      title: "Ахметов Б.К. өтініші бойынша қорытынды жобасы",
      fileName: "Қорытынды жобасы Ахметов.docx",
      paragraphs: [
        "Адвокаттардың кәсіби құқықтарын қорғау жөніндегі комиссия адвокат Ахметов Бауыржан Кайратұлының өтінішін қарады.",
        "Адвокатқа тергеу әрекеттеріне қатысуға негізсіз рұқсат берілмегені анықталды. Бұл адвокаттың кәсіби құқықтарын бұзу болып табылады.",
      ],
      closesInMs: 3 * 86400_000,
    });
    return castVotes(ctx, "04-01/1402", [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => ({ index: i, choice: i === 7 ? ("against" as const) : ("for" as const) })));
  },

  c3: async (ctx) => {
    await intakeAndAssign(ctx, {
      key: "c3-initial",
      rka: "04-01/1410",
      rkaDate: "2026-10-16",
      applicant: "Рамазанова Динара Ериковна",
      lang: "ru",
      executor: 4,
      deadline: "2026-11-05",
      task: "изучить материалы обращения и подготовить проект заключения о допустимости допроса адвоката в качестве свидетеля",
      send: false,
      mail: {
        from: "office@advokatura.kz",
        fromName: "Республиканская коллегия адвокатов",
        subject: "04-01/1410 Обращение адвоката Рамазановой Д.Е.",
        body: "Уважаемые коллеги!\n\nНаправляем обращение адвоката Восточно-Казахстанской областной коллегии адвокатов Рамазановой Динары Ериковны о вызове адвоката на допрос в качестве свидетеля по обстоятельствам, ставшим ей известными в связи с оказанием юридической помощи. Просим рассмотреть.\n\nРеспубликанская коллегия адвокатов",
        receivedAt: day(17),
        files: async () => [await pdf("Обращение Рамазановой Д.Е.", ["Прошу оценить правомерность вызова адвоката на допрос в качестве свидетеля по делу подзащитного."]), await pdf("Повестка о вызове", ["Повестка о вызове на допрос в качестве свидетеля на 15 октября 2026 года."])],
      },
    });
  },

  queue: async (ctx) => {
    // Новое обращение — регистрацию подтверждает человек (CASE-01).
    const m = await ingest(ctx, "q-new", {
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1433 Обращение адвоката Сулейменова Н.А.",
      body: "Уважаемые коллеги!\n\nНаправляем обращение адвоката Павлодарской областной коллегии адвокатов Сулейменова Нурлана Асылбековича о проведении обыска в помещении юридической консультации без санкции суда. Просим рассмотреть.\n\nРеспубликанская коллегия адвокатов",
      receivedAt: day(20),
      files: async () => [await pdf("Обращение Сулейменова Н.А.", ["Прошу защитить профессиональные права: в помещении юридической консультации проведён обыск."])],
    });
    await db.update(schema.messages).set({ intakeState: "needs_review", match: { kind: "new_case", reasons: ["Новое обращение от РКА, существующее дело не найдено"], candidates: [] } }).where(eq(schema.messages.id, m.id));
    await db.insert(schema.tasks).values({ organizationId: ctx.orgId, kind: "intake_new_case", title: "Новое обращение от РКА: подтвердите регистрацию (04-01/1433, Сулейменов Н.А.)", assigneeRole: "secretary", objectType: "message", objectId: m.id, dedupKey: `intake_new_case:${m.id}` }).onConflictDoNothing();

    // AT-01: 14 вложений, загружены 3 — неполное поступление.
    const m2 = await ingest(ctx, "q-incomplete", {
      from: "office@advokatura.kz",
      fromName: "Республиканская коллегия адвокатов",
      subject: "04-01/1440 Обращение адвоката Кенжебаевой Ж.М. (14 вложений)",
      body: "Уважаемые коллеги!\n\nНаправляем обращение адвоката Кенжебаевой Жанар Муратовны с материалами на 14 листах.\n\nРеспубликанская коллегия адвокатов",
      receivedAt: day(21, 9),
      files: () => Promise.all([1, 2, 3].map((i) => pdf(`Материал ${i} Кенжебаевой`, [`Материал дела № ${i}.`]))),
      pending: Array.from({ length: 11 }, (_, i) => ({ name: `Материал ${i + 4} Кенжебаевой.pdf`, size: 180_000 + i * 1000 })),
    });
    await db.update(schema.messages).set({ match: { kind: "new_case", reasons: ["Новое обращение от РКА, существующее дело не найдено"], candidates: [] } }).where(eq(schema.messages.id, m2.id));
    await db.insert(schema.tasks).values({ organizationId: ctx.orgId, kind: "intake_review", title: "Загрузка вложений не завершена: 3 из 14 (04-01/1440, Кенжебаева Ж.М.)", assigneeRole: "secretary", objectType: "message", objectId: m2.id, dedupKey: `intake_review:${m2.id}` }).onConflictDoNothing();
  },
};

export interface SeedResult {
  logs: string[];
  complete: boolean;
  done: string[];
  next: string | null;
}

/**
 * Выполнить заполнение. budgetMs ограничивает время одного вызова: этапы начинаются,
 * пока остаётся бюджет; невыполненные продолжатся при следующем вызове.
 */
export async function runSeed(opts: { demo: boolean; adminEmail?: string | null; budgetMs?: number }): Promise<SeedResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? Number.POSITIVE_INFINITY;
  const logs: string[] = [];
  const log = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    logs.push(line);
    console.log(line);
  };
  if (opts.demo && (env.mailTransport !== "dry-run" || env.signProvider !== "dry-run")) {
    throw new Error("Демо-заполнение допускается только при MAIL_TRANSPORT=dry-run и SIGN_PROVIDER=dry-run");
  }
  const org = await createOrg(opts.demo);
  const adminEmail = (opts.adminEmail ?? "").trim().toLowerCase();
  if (adminEmail) {
    await addUser(org.id, { fullName: "Администратор платформы", firstName: "Администратор", email: adminEmail, roles: ["tech_admin"] }); // председатель и секретарь назначаются при вводе состава
    log(`Администратор ${adminEmail} добавлен`);
  }
  if (!opts.demo) return { logs, complete: true, done: [], next: null };

  let { done } = await seedProgress();
  if (!done.includes("base")) {
    // Одной пачкой: на Vercel каждый запрос к базе — сетевой круг.
    const inserted = await db
      .insert(schema.users)
      .values(ROSTER.map(([fullName, firstName, patronymic, collegium], i) => ({ organizationId: org.id, fullName, firstName, patronymic, addressKk: firstName, email: demoEmail(i), emailVerified: true, collegium })))
      .onConflictDoNothing()
      .returning();
    const all = inserted.length === ROSTER.length ? inserted : await db.query.users.findMany({ where: eq(schema.users.organizationId, org.id) });
    const byEmail = new Map(all.map((u) => [u.email, u.id]));
    const roleRows = ROSTER.flatMap((_, i) => ["member", ...(i === 0 ? ["chair"] : []), ...(i === 1 ? ["secretary"] : [])].map((role) => ({ organizationId: org.id, userId: byEmail.get(demoEmail(i))!, role })));
    await db.insert(schema.orgRoles).values(roleRows).onConflictDoNothing();
    await db.insert(schema.mailAccounts).values({ organizationId: org.id, provider: "gmail", email: org.officialSender, state: "disabled" }).onConflictDoNothing();
    await markDone(org.id, "base");
    log("Организация и состав созданы");
  }
  await ensureHandlers();
  const ctx = await loadCtx(log, started + budget);
  ({ done } = await seedProgress());
  let ran = 0;
  for (const st of DEMO_STAGES) {
    if (done.includes(st.key)) continue;
    // Хотя бы один этап за вызов — прогресс гарантирован при любом бюджете.
    if (ran > 0 && Date.now() - started > budget) return { logs, complete: false, done, next: st.key };
    ran++;
    const t0 = Date.now();
    const finished = await STAGES[st.key](ctx);
    if (finished === false) {
      log(`${st.label}: выполнено частично за ${((Date.now() - t0) / 1000).toFixed(1)} с, продолжится`);
      return { logs, complete: false, done, next: st.key };
    }
    await markDone(ctx.orgId, st.key);
    done = [...done, st.key];
    log(`${st.label}: готово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  }
  log("Демо-заполнение завершено.");
  return { logs, complete: true, done, next: null };
}

/**
 * Сброс демонстрационной базы. Триггеры запрета удаления срабатывают на DELETE, но не на TRUNCATE,
 * поэтому сброс возможен только целиком и только в демо-режиме — для боевых данных он недоступен.
 */
export async function resetDemoDatabase() {
  if (env.authMode !== "demo") throw new Error("Сброс доступен только в демо-режиме");
  await db.execute(sql`truncate table outbox, command_log, login_codes, sessions, tasks, audit_events, qr_cards, sign_sessions, vote_invitations, votes, outgoings, assignments, document_links, attachments, document_versions, documents, messages, cycles, case_members, cases, blobs, templates, mail_accounts, org_roles, users, organizations restart identity cascade`);
}
