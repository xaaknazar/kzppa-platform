import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { can } from "@/domain/acl";
import { assertTransition, DOC_VERSION, SIGN_SESSION, SIGN_STATE_LABEL } from "@/domain/states";
import type { DocVersionState, SignSessionState } from "@/domain/types";
import { sha256Hex, type QrManifest } from "@/domain/hash";
import { getSignAdapter } from "@/integrations/sign";
import { AuthRequiredError, type SignAdapter, type SignProcedure, type Verification } from "@/integrations/sign/types";
import { isNotDelivered, maybeApplied } from "@/integrations/sign/sigex";
import { audit, SERVICE_ACTOR } from "../audit";
import { CommandError, runCommand } from "../command";
import { enqueue, registerHandler, type Handler, type OutboxRow } from "../outbox";
import { putImmutable, readBlob } from "../storage";
import type { SessionUser } from "../auth";

/**
 * SIGN-01..10, DOC-05, DOC-12, BR-05. Личная ЭЦП председателя через eGov Mobile/Business.
 *
 * Поток:
 *  1. startSigning (команда, conclusion.sign): проверка, что PDF с постоянным QR готов (DOC-05),
 *     создание сеанса, вызов adapter.start ВНЕ транзакции и немедленное сохранение procedureId/URL/expireAt.
 *  2. outbox «sign.poll» (фоновый устойчивый процесс, SIGN-03): передача данных (submit) и длинный
 *     опрос результата до expireAt. Не зависит от открытой вкладки.
 *     Передача данных вынесена в фон намеренно: у SIGEX запрос dataURL держится открытым, пока
 *     eGov Mobile не отсканирует QR, а QR пользователь видит только после ответа startSigning.
 *  3. При получении подписи — SIGN-04: байты CMS сразу пишутся в неизменяемое хранилище и
 *     фиксируются в сеансе (commit), и только затем ставится «sign.register_verify».
 *  4. «sign.register_verify»: регистрация в SIGEX с private:true (SIGN-06), сверка при
 *     неопределённом результате (SIGN-07), проверка (SIGN-05), перевод версии в «signed» и
 *     обновление статуса QR-карточки с историей (DOC-12). «Проверка недоступна» ≠ «проверена» (BR-05).
 *
 * Завершённый сеанс не переиспользуется (SIGN-09). Полученная подпись никогда не отбрасывается:
 * ошибка авторизации на следующем шаге → состояние auth_required и задача председателю.
 */

type Session = typeof schema.signSessions.$inferSelect;

/** Отдельная процедура eGov «только вход в SIGEX» (продолжение после auth_required). */
interface AuthProcedure {
  procedureId: string;
  qrCodeDataUrl: string | null;
  mobileLink: string | null;
  businessLink: string | null;
  dataUrl: string;
  signUrl: string;
  expireAt: string;
  nonce: string;
  state: "created" | "waiting" | "signed" | "used" | "expired" | "refused" | "error";
  /** Подпись nonce — одноразовый токен; стирается сразу после попытки входа. */
  signature?: string | null;
  error?: string | null;
  startedAt: string;
}

interface SessionUrls {
  procedureId?: string;
  qrCodeDataUrl?: string | null;
  mobileLink?: string | null;
  businessLink?: string | null;
  dataUrl?: string;
  signUrl?: string;
  devApproved?: boolean;
  devApprovedAt?: string;
  /** Nonce входа SIGEX, подписываемый в той же процедуре, что и заключение. */
  authNonce?: string | null;
  /** Подпись nonce (одноразовая; стирается после попытки входа, в журналы не пишется). */
  authSignature?: string | null;
  auth?: AuthProcedure | null;
}

const urlsOf = (s: Session) => (s.urls ?? {}) as SessionUrls;

interface ProviderEntry {
  step: string;
  at: string;
  attemptId?: string | null;
  [k: string]: unknown;
}

const ACTIVE: SignSessionState[] = ["created", "data_submitted", "waiting"];
/** Подпись уже получена — новый сеанс недопустим, нужно продолжить проверку (SIGN-07, AT-14). */
const SIGNATURE_HELD: SignSessionState[] = ["signature_saved", "auth_required", "needs_reconcile", "registered", "verified"];

const POLL_DELAY_MS = 4_000; // SIGN-03: короткий интервал повторного опроса
const EXPIRE_GRACE_MS = 15_000;
const VERIFY_UNAVAILABLE_DELAY_MS = 10 * 60_000;

/* ───────────────────────── вспомогательные ───────────────────────── */

/** Запуск обработки outbox сразу (fire-and-forget); на Vercel — через after(), иначе фоном. */
function kickSoon(sessionId: string, types: ("sign.poll" | "sign.register_verify")[] = ["sign.poll", "sign.register_verify"]) {
  const run = async () => {
    try {
      const { kick } = await import("../handlers");
      await kick({ types, aggregateId: sessionId, limit: 1 });
    } catch (e) {
      console.error("sign kick", (e as Error).message);
    }
  };
  void (async () => {
    try {
      const { after } = await import("next/server");
      after(run);
    } catch {
      void run(); // вне запроса Next (сид, скрипты)
    }
  })();
}

const appendResponses = (entries: ProviderEntry[]) => sql`${schema.signSessions.providerResponses} || ${JSON.stringify(entries)}::jsonb`;

/** Переход сеанса по графу SIGN_SESSION с защитой от гонок (условие по текущему состоянию). */
async function moveSession(q: Tx | typeof db, s: Session, to: SignSessionState, patch: Partial<typeof schema.signSessions.$inferInsert> = {}, responses?: ProviderEntry[]) {
  const from = s.state as SignSessionState;
  if (from !== to) assertTransition(SIGN_SESSION, "sign_session", from, to);
  const set: Record<string, unknown> = { ...patch, state: to };
  if (responses?.length) set.providerResponses = appendResponses(responses);
  const rows = await q
    .update(schema.signSessions)
    .set(set as Partial<typeof schema.signSessions.$inferInsert>)
    .where(and(eq(schema.signSessions.id, s.id), eq(schema.signSessions.state, from)))
    .returning({ id: schema.signSessions.id });
  if (!rows.length) throw new Error(`Состояние сеанса подписи изменилось параллельно (ожидалось «${from}»)`);
  Object.assign(s, patch, { state: to });
}

async function patchSession(q: Tx | typeof db, id: string, patch: Partial<typeof schema.signSessions.$inferInsert>, responses?: ProviderEntry[]) {
  const set: Record<string, unknown> = { ...patch };
  if (responses?.length) set.providerResponses = appendResponses(responses);
  await q.update(schema.signSessions).set(set as Partial<typeof schema.signSessions.$inferInsert>).where(eq(schema.signSessions.id, id));
}

async function loadSession(id: string) {
  return db.query.signSessions.findFirst({ where: eq(schema.signSessions.id, id) });
}

/** Сброс счётчика попыток: ожидание подписи — штатное состояние, а не сбой (иначе dead-letter через 8 опросов). */
async function resetAttempts(row: OutboxRow) {
  await db.update(schema.outbox).set({ attempts: 0 }).where(eq(schema.outbox.id, row.id));
}

function procedureOf(s: Session): SignProcedure | null {
  const u = (s.urls ?? {}) as SessionUrls;
  if (!s.procedureId || !u.dataUrl || !u.signUrl) return null;
  return {
    procedureId: s.procedureId,
    qrCodeDataUrl: u.qrCodeDataUrl ?? null,
    mobileLink: u.mobileLink ?? null,
    businessLink: u.businessLink ?? null,
    dataUrl: u.dataUrl,
    signUrl: u.signUrl,
    expireAt: s.expireAt ?? new Date(0),
    authNonce: u.authNonce ?? null,
  };
}

/** Точные байты подписываемого PDF; хеш обязан совпасть с зафиксированным в сеансе (SIGN-05). */
async function documentBytes(s: Session) {
  const v = await db.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, s.documentVersionId) });
  if (!v?.blobId) throw new Error("Файл подписываемой версии не найден");
  const { bytes, sha256 } = await readBlob(v.blobId);
  const actual = await sha256Hex(bytes);
  if (actual !== s.documentSha256 || sha256 !== s.documentSha256) throw new Error("SHA-256 файла не совпал с подписываемой версией — подпись не может быть сопоставлена");
  return { bytes, version: v };
}

async function chairTask(q: Tx | typeof db, s: Session, kind: "sign_auth" | "sign_check", title: string, detail: string) {
  await q
    .insert(schema.tasks)
    .values({ organizationId: s.organizationId, caseId: s.caseId, kind, title, detail, assigneeRole: "chair", assigneeId: s.assignedSignerId, objectType: "sign_session", objectId: s.id, dedupKey: `${kind}:${s.id}` })
    .onConflictDoNothing();
}

async function resolveTasks(q: Tx | typeof db, s: Session) {
  await q
    .update(schema.tasks)
    .set({ state: "done", resolvedAt: new Date() })
    .where(and(inArray(schema.tasks.dedupKey, [`sign_auth:${s.id}`, `sign_check:${s.id}`]), eq(schema.tasks.state, "open")));
}

/** DOC-12: обновляется только служебный статус проверки, с сохранением истории. */
async function setCardStatus(q: Tx | typeof db, s: Session, status: Record<string, unknown>) {
  const card = await q.query.qrCards.findFirst({ where: eq(schema.qrCards.documentVersionId, s.documentVersionId) });
  if (!card) return;
  const history = Array.isArray(card.statusHistory) ? (card.statusHistory as unknown[]) : [];
  await q
    .update(schema.qrCards)
    .set({ signatureStatus: status, statusHistory: [...history, { ...status, sessionId: s.id, recordedAt: new Date().toISOString() }] })
    .where(eq(schema.qrCards.id, card.id));
}

/* ───────────────────────── команды ───────────────────────── */

export interface StartSigningResult {
  sessionId: string;
  qrCodeDataUrl: string | null;
  mobileLink: string | null;
  businessLink: string | null;
  expireAt: string | null;
  reused: boolean;
}

/** SIGN-01, SIGN-02, SIGN-09, DOC-05. */
export async function startSigning(user: SessionUser, params: { documentVersionId: string; idempotencyKey: string }) {
  const meta = await db
    .select({ caseId: schema.documents.caseId })
    .from(schema.documentVersions)
    .innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId))
    .where(eq(schema.documentVersions.id, params.documentVersionId))
    .limit(1);

  const r = await runCommand(
    { name: "sign.start", user, idempotencyKey: params.idempotencyKey, permission: { action: "conclusion.sign", caseId: meta[0]?.caseId } },
    async ({ tx, actor, orgId }) => {
      // Один активный сеанс на версию: параллельные запуски сериализуются.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"sign:" + params.documentVersionId}))`);
      const v = await tx.query.documentVersions.findFirst({ where: and(eq(schema.documentVersions.id, params.documentVersionId), eq(schema.documentVersions.organizationId, orgId)) });
      if (!v) throw new CommandError("Версия документа не найдена");
      const doc = (await tx.query.documents.findFirst({ where: eq(schema.documents.id, v.documentId) }))!;
      if (v.state !== "ready_to_sign") throw new CommandError("Подписать можно только версию в состоянии «Готова к подписи»");
      if (!v.blobId || !v.sha256) throw new CommandError("У версии нет сохранённого файла");
      // DOC-05: постоянный QR вставлен ДО ЭЦП — подписывается именно PDF с QR.
      const card = await tx.query.qrCards.findFirst({ where: eq(schema.qrCards.documentVersionId, v.id) });
      if (!card?.manifest || !card.manifestHash) throw new CommandError("Для версии нет QR-карточки с манифестом: сначала сформируйте PDF с постоянным QR");
      if (card.pdfSha256 && card.pdfSha256 !== v.sha256) throw new CommandError("Хеш PDF не совпадает с QR-карточкой — сформируйте PDF заново");

      const sessions = await tx.query.signSessions.findMany({ where: eq(schema.signSessions.documentVersionId, v.id) });
      const held = sessions.find((s) => SIGNATURE_HELD.includes(s.state as SignSessionState));
      if (held) {
        throw new CommandError(
          held.state === "verified" ? "Документ уже подписан и проверен" : "Подпись по этой версии уже получена и сохранена. Продолжите регистрацию и проверку — повторно подписывать не нужно.",
        );
      }
      const now = Date.now();
      const active = sessions.find((s) => ACTIVE.includes(s.state as SignSessionState) && (!s.expireAt || s.expireAt.getTime() > now + 30_000));
      if (active) return { sessionId: active.id, reused: true };

      const [s] = await tx
        .insert(schema.signSessions)
        .values({ organizationId: orgId, caseId: doc.caseId, documentVersionId: v.id, documentSha256: v.sha256, assignedSignerId: user.id, provider: getSignAdapter().mode, state: "created", idempotencyKey: params.idempotencyKey })
        .returning();
      await audit(tx, { orgId, actor, action: "sign.start", objectType: "sign_session", objectId: s.id, caseId: doc.caseId, after: { documentVersionId: v.id, documentSha256: v.sha256, provider: s.provider, manifestHash: card.manifestHash } });
      return { sessionId: s.id, reused: false };
    },
  );
  if (!r.ok) return r;

  // Шаг start — ВНЕ транзакции; результат сохраняется сразу (SIGN-02).
  try {
    const s = await ensureProcedure(r.data.sessionId);
    kickSoon(s.id, ["sign.poll"]);
    const u = (s.urls ?? {}) as SessionUrls;
    const data: StartSigningResult = { sessionId: s.id, qrCodeDataUrl: u.qrCodeDataUrl ?? null, mobileLink: u.mobileLink ?? null, businessLink: u.businessLink ?? null, expireAt: s.expireAt?.toISOString() ?? null, reused: r.data.reused };
    return { ok: true as const, data, replayed: r.replayed };
  } catch (e) {
    return { ok: false as const, error: `Не удалось начать сеанс подписания: ${(e as Error).message}`, code: "sign_start" };
  }
}

/** Создать процедуру у поставщика, если её ещё нет (повторный вызов после сбоя не создаёт вторую). */
async function ensureProcedure(sessionId: string): Promise<Session> {
  const s = await loadSession(sessionId);
  if (!s) throw new Error("Сеанс подписи не найден");
  if (s.procedureId || s.state !== "created") return s;
  const card = await db.query.qrCards.findFirst({ where: eq(schema.qrCards.documentVersionId, s.documentVersionId) });
  const m = (card?.manifest ?? {}) as Partial<QrManifest>;
  const v = await db.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, s.documentVersionId) });
  const documentName = v?.filename ?? `conclusion-${m.conclusionNumber ?? ""}.pdf`;
  const description = `${m.supplementary ? "Дополнительное заключение" : "Заключение"} КЗППА №${m.conclusionNumber ?? "—"} по делу №${m.caseNumber ?? "—"} (${m.applicant ?? ""}). SHA-256: ${s.documentSha256.slice(0, 16)}…`;
  const adapter = getSignAdapter();
  let proc: SignProcedure;
  try {
    proc = await adapter.start({ documentName, documentSha256: s.documentSha256, description });
  } catch (e) {
    await moveSession(db, s, "error", { lastError: (e as Error).message }, [{ step: "start.failed", at: new Date().toISOString(), error: (e as Error).message }]);
    throw e;
  }
  const urls: SessionUrls = { procedureId: proc.procedureId, qrCodeDataUrl: proc.qrCodeDataUrl, mobileLink: proc.mobileLink, businessLink: proc.businessLink, dataUrl: proc.dataUrl, signUrl: proc.signUrl, authNonce: proc.authNonce ?? null };
  await db.transaction(async (tx) => {
    await patchSession(tx, s.id, { procedureId: proc.procedureId, urls, expireAt: proc.expireAt }, [{ step: "start", at: new Date().toISOString(), procedureId: proc.procedureId, expireAt: proc.expireAt.toISOString(), provider: adapter.mode, withAuthNonce: !!proc.authNonce }]);
    await enqueue(tx, { orgId: s.organizationId, type: "sign.poll", aggregateType: "sign_session", aggregateId: s.id, idempotencyKey: `sign.poll:${s.id}` });
  });
  return { ...s, procedureId: proc.procedureId, urls, expireAt: proc.expireAt };
}

export interface SigningStatus {
  sessionId: string;
  state: SignSessionState;
  label: string;
  qrCodeDataUrl: string | null;
  mobileLink: string | null;
  businessLink: string | null;
  expireAt: string | null;
  receivedAt: string | null;
  registrationId: string | null;
  verification: { cryptoValid: boolean | null; trustChecked: boolean | null; unavailable: boolean; checkedAt: string | null; dryRun: boolean } | null;
  error: string | null;
  provider: string;
  /** Процедура входа в SIGEX (только в состоянии auth_required). */
  auth: { state: AuthProcedure["state"]; qrCodeDataUrl: string | null; mobileLink: string | null; businessLink: string | null; expireAt: string | null; error: string | null } | null;
}

function authView(a: AuthProcedure | null | undefined): SigningStatus["auth"] {
  if (!a) return null;
  const active = a.state === "created" || a.state === "waiting";
  return { state: a.state, qrCodeDataUrl: active ? a.qrCodeDataUrl : null, mobileLink: active ? a.mobileLink : null, businessLink: active ? a.businessLink : null, expireAt: a.expireAt, error: a.error ?? null };
}

/** Статус для опроса интерфейсом (conclusion.sign или case.read_root). */
export async function getSigningStatus(user: SessionUser, sessionId: string): Promise<{ ok: true; data: SigningStatus } | { ok: false; error: string }> {
  const s = await loadSession(sessionId);
  if (!s || s.organizationId !== user.orgId) return { ok: false, error: "Сеанс подписи не найден" };
  if (!can(user.principal, "conclusion.sign", { caseId: s.caseId }) && !can(user.principal, "case.read_root", { caseId: s.caseId })) return { ok: false, error: "Недостаточно полномочий для этого действия" };
  const state = s.state as SignSessionState;
  const u = (s.urls ?? {}) as SessionUrls;
  if ([...ACTIVE, "signature_saved", "registered"].includes(state)) kickSoon(s.id); // ускорение; фоновой обработке вкладка не нужна
  else if (state === "auth_required" && u.auth && ["created", "waiting", "signed"].includes(u.auth.state)) kickSoon(s.id);
  const ver = s.verification as (Verification & { dryRun?: boolean }) | null;
  const showSessionQr = ACTIVE.includes(state);
  return {
    ok: true,
    data: {
      sessionId: s.id,
      state,
      label: ver?.unavailable && state === "registered" ? "Подпись зарегистрирована; проверка недоступна" : SIGN_STATE_LABEL[state] ?? state,
      qrCodeDataUrl: showSessionQr ? u.qrCodeDataUrl ?? null : null,
      mobileLink: showSessionQr ? u.mobileLink ?? null : null,
      businessLink: showSessionQr ? u.businessLink ?? null : null,
      expireAt: s.expireAt?.toISOString() ?? null,
      receivedAt: s.receivedAt?.toISOString() ?? null,
      registrationId: s.registrationId,
      verification: ver ? { cryptoValid: ver.cryptoValid, trustChecked: ver.trustChecked, unavailable: ver.unavailable, checkedAt: ver.checkedAt ?? null, dryRun: s.provider === "dry-run" } : null,
      error: s.lastError,
      provider: s.provider,
      auth: state === "auth_required" ? authView(u.auth) : null,
    },
  };
}

/**
 * Продолжение после auth_required: отдельная процедура eGov только для входа в SIGEX.
 * Председатель подписывает новый nonce; подпись заключения уже сохранена — повторно не подписывается.
 */
export async function startSigexAuth(user: SessionUser, sessionId: string): Promise<{ ok: true; data: NonNullable<SigningStatus["auth"]> } | { ok: false; error: string }> {
  const s0 = await loadSession(sessionId);
  const r = await runCommand({ name: "sign.auth_start", user, permission: { action: "conclusion.sign", caseId: s0?.caseId } }, async ({ tx, actor, orgId }) => {
    const s = await tx.query.signSessions.findFirst({ where: and(eq(schema.signSessions.id, sessionId), eq(schema.signSessions.organizationId, orgId)) });
    if (!s) throw new CommandError("Сеанс подписи не найден");
    if (s.state !== "auth_required") throw new CommandError("Вход в SIGEX нужен, только когда регистрация подписи требует авторизации");
    const a = urlsOf(s).auth;
    const reusable = !!a && (a.state === "created" || a.state === "waiting") && new Date(a.expireAt).getTime() > Date.now() + 30_000;
    if (!reusable) await audit(tx, { orgId, actor, action: "sign.auth_start", objectType: "sign_session", objectId: s.id, caseId: s.caseId });
    return { reused: reusable };
  });
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.data.reused) {
    const adapter = getSignAdapter();
    try {
      const proc = await adapter.startAuth({ description: "Вход в SIGEX: регистрация ЭЦП заключения КЗППА от имени подписанта" });
      const s = (await loadSession(sessionId))!;
      const auth: AuthProcedure = {
        procedureId: proc.procedureId,
        qrCodeDataUrl: proc.qrCodeDataUrl,
        mobileLink: proc.mobileLink,
        businessLink: proc.businessLink,
        dataUrl: proc.dataUrl,
        signUrl: proc.signUrl,
        expireAt: proc.expireAt.toISOString(),
        nonce: proc.authNonce,
        state: "created",
        startedAt: new Date().toISOString(),
      };
      await db.transaction(async (tx) => {
        await patchSession(tx, s.id, { urls: { ...urlsOf(s), auth } }, [{ step: "auth.start", at: auth.startedAt, procedureId: proc.procedureId, expireAt: auth.expireAt }]);
        await enqueue(tx, { orgId: s.organizationId, type: "sign.poll", aggregateType: "sign_session", aggregateId: s.id, idempotencyKey: `sign.poll:${s.id}:auth:${proc.procedureId}` });
      });
    } catch (e) {
      return { ok: false, error: `Не удалось начать вход в SIGEX: ${(e as Error).message}` };
    }
  }
  kickSoon(sessionId, ["sign.poll"]);
  const s = (await loadSession(sessionId))!;
  return { ok: true, data: authView(urlsOf(s).auth)! };
}

/** AT-14: продолжить с нужного шага (авторизация, сверка, проверка) без повторной подписи. */
export async function resumeSigning(user: SessionUser, sessionId: string) {
  const s0 = await loadSession(sessionId);
  const r = await runCommand({ name: "sign.resume", user, permission: { action: "conclusion.sign", caseId: s0?.caseId } }, async ({ tx, actor, orgId }) => {
    const s = await tx.query.signSessions.findFirst({ where: and(eq(schema.signSessions.id, sessionId), eq(schema.signSessions.organizationId, orgId)) });
    if (!s) throw new CommandError("Сеанс подписи не найден");
    const state = s.state as SignSessionState;
    let type: "sign.poll" | "sign.register_verify";
    if (["signature_saved", "auth_required", "needs_reconcile", "registered"].includes(state)) type = "sign.register_verify";
    else if (ACTIVE.includes(state) && (!s.expireAt || s.expireAt.getTime() > Date.now())) type = "sign.poll";
    else if (state === "verified") throw new CommandError("Подпись уже проверена");
    else throw new CommandError("Сеанс завершён без подписи. Начните новый сеанс подписания.");
    await enqueue(tx, { orgId, type, aggregateType: "sign_session", aggregateId: s.id, idempotencyKey: `${type}:${s.id}:resume:${crypto.randomUUID()}`, payload: { resumedBy: user.id } });
    await audit(tx, { orgId, actor, action: "sign.resume", objectType: "sign_session", objectId: s.id, caseId: s.caseId, before: { state }, after: { step: type } });
    return { step: type };
  });
  if (r.ok) kickSoon(sessionId, [r.data.step]);
  return r;
}

/* ───────────────────────── обработчики outbox ───────────────────────── */

/** SIGN-03: передача данных и длинный опрос результата. */
const pollHandler: Handler = async (row) => {
  const s = await loadSession(row.aggregateId);
  if (!s) return { status: "dead", error: "Сеанс подписи не найден" };
  const state = s.state as SignSessionState;
  const adapter = getSignAdapter();

  // Подпись уже сохранена, а следующий шаг мог не поставиться (сбой между commit и enqueue).
  if (state === "signature_saved") {
    await enqueueRegister(s);
    return { status: "done", note: "Подпись уже сохранена" };
  }
  if (state === "auth_required") return authPoll(row, s);
  if (!ACTIVE.includes(state)) return { status: "done", note: `Сеанс в состоянии ${state}` };

  if (state === "created" && !s.procedureId) {
    await ensureProcedure(s.id);
    return { status: "retry", error: "Процедура создана", delayMs: 200 };
  }
  const proc = procedureOf(s);
  if (!proc) return { status: "dead", error: "У сеанса нет ссылок поставщика" };
  const expired = () => !!s.expireAt && Date.now() > s.expireAt.getTime() + EXPIRE_GRACE_MS;

  // Шаг submit: точные байты PDF (CMS_SIGN_ONLY), затем data_submitted → waiting.
  if (state === "created") {
    if (expired()) return finish(s, "expired", "Срок сеанса eGov истёк до передачи данных");
    const { bytes, version } = await documentBytes(s);
    try {
      const sub = await adapter.submit(proc, bytes, { documentName: version.filename ?? "conclusion.pdf" });
      const urls = { ...((s.urls ?? {}) as SessionUrls), signUrl: sub.signUrl };
      await moveSession(db, s, "data_submitted", { urls, expireAt: sub.expireAt ?? s.expireAt }, [{ step: "submit", at: new Date().toISOString(), expireAt: (sub.expireAt ?? s.expireAt)?.toISOString() ?? null }]);
      await moveSession(db, s, "waiting");
      await resetAttempts(row);
      return { status: "retry", error: "Данные переданы, ожидание подписи", delayMs: 300 };
    } catch (e) {
      if (isNotDelivered(e)) {
        // Длинный запрос не дождался eGov Mobile — повторяем сразу (SIGEX обрабатывает последний запрос).
        await resetAttempts(row);
        return expired() ? finish(s, "expired", "Срок сеанса eGov истёк") : { status: "retry", error: "Ожидание подключения eGov Mobile", delayMs: 200 };
      }
      if (/expired|timeout|not active/i.test((e as Error).message)) return finish(s, "expired", (e as Error).message);
      await patchSession(db, s.id, { lastError: (e as Error).message });
      return { status: "retry", error: (e as Error).message };
    }
  }

  if (state === "data_submitted") await moveSession(db, s, "waiting");

  const r = await adapter.poll(((s.urls ?? {}) as SessionUrls).signUrl ?? proc.signUrl);
  switch (r.status) {
    case "signed":
      await saveSignature(s, r.signature.cms, r.signature.signatureType, r.signature.providerResponse, r.signature.authSignature ?? null);
      await enqueueRegister(s);
      return { status: "done" };
    case "waiting":
      if (expired()) return finish(s, "expired", "Срок сеанса eGov истёк, подпись не получена");
      if (r.expireAt && r.expireAt.getTime() !== s.expireAt?.getTime()) await patchSession(db, s.id, { expireAt: r.expireAt });
      await resetAttempts(row);
      return { status: "retry", error: "Ожидание подписи в eGov", delayMs: POLL_DELAY_MS };
    case "expired":
      return finish(s, "expired", "Срок сеанса eGov истёк");
    case "refused":
      return finish(s, "refused", r.reason ?? "Подписание отменено");
    case "error":
      await patchSession(db, s.id, { lastError: r.error });
      if (!r.retryable) return finish(s, "error", r.error);
      if (expired()) return finish(s, "expired", r.error);
      return { status: "retry", error: r.error };
  }
};

/** Обновить процедуру входа (jsonb urls.auth), сохранив остальные поля сеанса. */
async function setAuth(s: Session, next: AuthProcedure, responses?: ProviderEntry[]) {
  const fresh = (await loadSession(s.id)) ?? s;
  const urls = { ...urlsOf(fresh), auth: next };
  await patchSession(db, s.id, { urls }, responses);
  s.urls = urls;
}

/** Опрос процедуры «только вход в SIGEX» (в состоянии auth_required). */
async function authPoll(row: OutboxRow, s: Session): ReturnType<Handler> {
  const a = urlsOf(s).auth;
  if (!a || (a.state !== "created" && a.state !== "waiting")) return { status: "done", note: "Нет активной процедуры входа" };
  const adapter = getSignAdapter();
  const exp = new Date(a.expireAt);
  const now = () => new Date().toISOString();
  if (Date.now() > exp.getTime() + EXPIRE_GRACE_MS) {
    await setAuth(s, { ...a, state: "expired", error: "Срок процедуры входа истёк" }, [{ step: "auth.expired", at: now() }]);
    return { status: "done" };
  }
  const proc = { procedureId: a.procedureId, qrCodeDataUrl: a.qrCodeDataUrl, mobileLink: a.mobileLink, businessLink: a.businessLink, dataUrl: a.dataUrl, signUrl: a.signUrl, expireAt: exp, authNonce: a.nonce };
  if (a.state === "created") {
    try {
      const sub = await adapter.submitAuth(proc);
      await setAuth(s, { ...a, state: "waiting", signUrl: sub.signUrl, expireAt: (sub.expireAt ?? exp).toISOString() }, [{ step: "auth.submit", at: now() }]);
      await resetAttempts(row);
      return { status: "retry", error: "Ожидание подтверждения входа", delayMs: 300 };
    } catch (e) {
      if (isNotDelivered(e)) {
        await resetAttempts(row);
        return { status: "retry", error: "Ожидание подключения eGov Mobile", delayMs: 200 };
      }
      if (/expired|timeout|not active/i.test((e as Error).message)) {
        await setAuth(s, { ...a, state: "expired", error: (e as Error).message }, [{ step: "auth.expired", at: now() }]);
        return { status: "done" };
      }
      return { status: "retry", error: (e as Error).message };
    }
  }
  const r = await adapter.pollAuth(a.signUrl);
  switch (r.status) {
    case "signed":
      await setAuth(s, { ...a, state: "signed", signature: r.authSignature, error: null }, [{ step: "auth.signed", at: now() }]);
      await db.transaction(async (tx) => {
        await enqueue(tx, { orgId: s.organizationId, type: "sign.register_verify", aggregateType: "sign_session", aggregateId: s.id, idempotencyKey: `sign.register_verify:${s.id}:auth:${a.procedureId}` });
      });
      kickSoon(s.id, ["sign.register_verify"]);
      return { status: "done" };
    case "waiting":
      await resetAttempts(row);
      return { status: "retry", error: "Ожидание подтверждения входа в eGov", delayMs: POLL_DELAY_MS };
    case "expired":
      await setAuth(s, { ...a, state: "expired", error: "Срок процедуры входа истёк" }, [{ step: "auth.expired", at: now() }]);
      return { status: "done" };
    case "refused":
      await setAuth(s, { ...a, state: "refused", error: r.reason ?? "Вход отменён" }, [{ step: "auth.refused", at: now() }]);
      return { status: "done" };
    case "error":
      if (!r.retryable) {
        await setAuth(s, { ...a, state: "error", error: r.error }, [{ step: "auth.error", at: now(), error: r.error }]);
        return { status: "done" };
      }
      return { status: "retry", error: r.error };
  }
}

async function finish(s: Session, to: "expired" | "refused" | "error", reason: string): Promise<{ status: "done" }> {
  await db.transaction(async (tx) => {
    await moveSession(tx, s, to, { lastError: reason }, [{ step: to, at: new Date().toISOString(), reason }]);
    await audit(tx, { orgId: s.organizationId, actor: SERVICE_ACTOR, action: `sign.${to}`, objectType: "sign_session", objectId: s.id, caseId: s.caseId, basis: reason });
  });
  return { status: "done" };
}

/**
 * SIGN-04: подпись сохраняется немедленно — байты, хеш, документ и ответ поставщика —
 * до регистрации и проверки. CMS хранится отдельно как служебное доказательство (DOC-10).
 */
async function saveSignature(s: Session, cms: Uint8Array, signatureType: "cms", providerResponse: unknown, authSignature: string | null) {
  const isDry = s.provider === "dry-run";
  const blob = await putImmutable(s.organizationId, cms, isDry ? "application/json" : "application/pkcs7-signature");
  const v = await db.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, s.documentVersionId) });
  const base = (v?.filename ?? "conclusion.pdf").replace(/\.pdf$/i, "");
  const receivedAt = new Date();
  await db.transaction(async (tx) => {
    // Подпись nonce входа хранится в сеансе до первой попытки входа (не в журнале и не в ответах поставщика).
    const urlPatch = authSignature ? { urls: { ...urlsOf(s), authSignature } } : {};
    await moveSession(tx, s, "signature_saved", { signatureBlobId: blob.id, signatureType, receivedAt, lastError: null, ...urlPatch }, [
      { step: "signature_received", at: receivedAt.toISOString(), signatureSha256: blob.sha256, size: blob.size, withAuthSignature: !!authSignature, response: providerResponse as Record<string, unknown> },
    ]);
    const [doc] = await tx
      .insert(schema.documents)
      .values({ organizationId: s.organizationId, caseId: s.caseId, category: "evidence", title: isDry ? `Тестовая подпись (без юридической силы) — ${base}` : `ЭЦП (CMS) — ${base}`, area: "root" })
      .returning();
    await tx.insert(schema.documentVersions).values({
      organizationId: s.organizationId,
      documentId: doc.id,
      version: 1,
      state: "approved",
      blobId: blob.id,
      sha256: blob.sha256,
      size: blob.size,
      format: isDry ? "json" : "cms",
      filename: isDry ? `${base}.dry-run.json` : `${base}.cms`,
      signsVersionId: s.documentVersionId,
      generator: { kind: "signature", provider: s.provider, sessionId: s.id },
    });
    await audit(tx, { orgId: s.organizationId, actor: SERVICE_ACTOR, action: "sign.signature_saved", objectType: "sign_session", objectId: s.id, caseId: s.caseId, after: { signatureSha256: blob.sha256, documentSha256: s.documentSha256 }, externalIds: { procedureId: s.procedureId } });
  });
}

async function enqueueRegister(s: Session) {
  await db.transaction(async (tx) => {
    await enqueue(tx, { orgId: s.organizationId, type: "sign.register_verify", aggregateType: "sign_session", aggregateId: s.id, idempotencyKey: `sign.register_verify:${s.id}` });
  });
  kickSoon(s.id, ["sign.register_verify"]);
}

/** Последняя попытка регистрации без известного исхода (сбой процесса во время запроса). */
function openRegisterAttempt(s: Session): string | null {
  const list = (Array.isArray(s.providerResponses) ? s.providerResponses : []) as ProviderEntry[];
  const req = [...list].reverse().find((e) => e.step === "register.request");
  if (!req?.attemptId) return null;
  const closed = list.some((e) => e.attemptId === req.attemptId && e.step !== "register.request");
  return closed ? null : req.attemptId;
}

class AuthInProgress extends Error {
  constructor() {
    super("Вход в SIGEX выполняет параллельная обработка");
  }
}

/** SIGN-05..07, DOC-12, BR-05. */
const registerVerifyHandler: Handler = async (row) => {
  const s = await loadSession(row.aggregateId);
  if (!s) return { status: "dead", error: "Сеанс подписи не найден" };
  if (s.state === "verified") return { status: "done", note: "Уже проверено" };
  if (!s.signatureBlobId) return { status: "dead", error: "Подпись не сохранена — регистрация невозможна" };
  const adapter = getSignAdapter();
  const { bytes } = await documentBytes(s);
  const sig = await readBlob(s.signatureBlobId);
  const cms = sig.bytes;

  /*
   * Вход в SIGEX от имени подписанта: по подписи nonce из процедуры подписания или из отдельной
   * процедуры входа. Сессия (cookie) живёт только в памяти этого обработчика и не сохраняется.
   * Подпись nonce одноразовая — стирается сразу после попытки входа.
   */
  let cookie: string | null = null;
  let authTried = false;
  const tryAuth = async (): Promise<string | null | "taken"> => {
    if (authTried) return null;
    authTried = true;
    const fresh = (await loadSession(s.id)) ?? s;
    const u = urlsOf(fresh);
    const pair =
      u.authNonce && u.authSignature
        ? { nonce: u.authNonce, signature: u.authSignature, source: "signing" }
        : u.auth?.state === "signed" && u.auth.signature
          ? { nonce: u.auth.nonce, signature: u.auth.signature, source: "auth_procedure" }
          : null;
    if (!pair) return null;
    const cleared: SessionUrls = { ...u, authSignature: null, auth: u.auth ? { ...u.auth, signature: null, state: u.auth.state === "signed" ? "used" : u.auth.state } : u.auth };
    // Атомарный захват одноразового токена: параллельный обработчик не сможет использовать его повторно.
    const claimed = await db.execute(
      sql`update sign_sessions set urls = ${JSON.stringify(cleared)}::jsonb where id = ${s.id} and (urls->>'authSignature' = ${pair.signature} or urls->'auth'->>'signature' = ${pair.signature}) returning id`,
    );
    if (!(claimed as unknown as unknown[]).length) return "taken";
    s.urls = cleared;
    try {
      const r = await adapter.authenticate(pair.nonce, pair.signature);
      await patchSession(db, s.id, {}, [{ step: "auth.ok", at: new Date().toISOString(), source: pair.source, userId: r.userId }]);
      return r.cookie;
    } catch (e) {
      await patchSession(db, s.id, {}, [{ step: "auth.failed", at: new Date().toISOString(), source: pair.source, error: (e as Error).message }]);
      return null;
    }
  };
  /** Выполнить шаг; при «Authentication required» — войти по подписи nonce и повторить один раз. */
  const withAuth = async <T>(fn: (authCookie: string | null) => Promise<T>): Promise<T> => {
    try {
      return await fn(cookie);
    } catch (e) {
      if (!(e instanceof AuthRequiredError) || cookie) throw e;
      const c = await tryAuth();
      if (c === "taken") throw new AuthInProgress();
      if (!c) throw e;
      cookie = c;
      return fn(cookie);
    }
  };

  try {
    // Авторизация потребовалась уже после регистрации (на шаге проверки) — регистрацию не повторяем.
    if (s.state === "auth_required" && s.registrationId) await moveSession(db, s, "registered", { lastError: null });

    // Незакрытая попытка регистрации = результат неизвестен → сначала сверка (SIGN-07).
    if ((s.state === "signature_saved" || s.state === "auth_required") && openRegisterAttempt(s)) {
      await moveSession(db, s, "needs_reconcile", { lastError: "Результат регистрации неизвестен — нужна сверка" });
    }

    if (s.state === "needs_reconcile") {
      const found = await withAuth((authCookie) => adapter.reconcile({ cms, documentSha256: s.documentSha256, authCookie }));
      const attemptId = openRegisterAttempt(s);
      if (found) {
        const extra = "ensureData" in adapter ? await withAuth((c) => (adapter as SignAdapter & { ensureData(id: string, b: Uint8Array, c?: string | null): Promise<unknown> }).ensureData(found.registrationId, bytes, c)) : null;
        await moveSession(db, s, "registered", { registrationId: found.registrationId, lastError: null }, [{ step: "reconcile.found", at: new Date().toISOString(), attemptId, registrationId: found.registrationId, data: extra as Record<string, unknown> | null }]);
      } else {
        // Только установив отсутствие регистрации, разрешаем новую операцию.
        await moveSession(db, s, "signature_saved", { lastError: null }, [{ step: "reconcile.absent", at: new Date().toISOString(), attemptId }]);
      }
    }

    if (s.state === "signature_saved" || s.state === "auth_required") {
      const attemptId = crypto.randomUUID();
      // Отметка попытки фиксируется ДО запроса: при сбое процесса следующая обработка начнёт со сверки.
      await patchSession(db, s.id, {}, [{ step: "register.request", at: new Date().toISOString(), attemptId }]);
      s.providerResponses = [...((s.providerResponses as ProviderEntry[]) ?? []), { step: "register.request", at: "", attemptId }];
      try {
        const v = await db.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, s.documentVersionId) });
        // «Authentication required» — явный отказ (запрос не применён), поэтому повтор после входа безопасен.
        const reg = await withAuth((authCookie) => adapter.register({ documentName: v?.filename ?? "conclusion.pdf", documentBytes: bytes, cms, private: true, authCookie }));
        await db.transaction(async (tx) => {
          await moveSession(tx, s, "registered", { registrationId: reg.registrationId, lastError: null }, [{ step: "register.response", at: new Date().toISOString(), attemptId, registrationId: reg.registrationId, response: reg.response as Record<string, unknown> }]);
          await audit(tx, { orgId: s.organizationId, actor: SERVICE_ACTOR, action: "sign.registered", objectType: "sign_session", objectId: s.id, caseId: s.caseId, externalIds: { registrationId: reg.registrationId }, after: { private: true } });
        });
      } catch (e) {
        if (e instanceof AuthInProgress) {
          // Запрос был явно отклонён («Authentication required») — попытка закрыта, сверка не нужна.
          await patchSession(db, s.id, {}, [{ step: "register.failed", at: new Date().toISOString(), attemptId, auth: true }]);
          throw e;
        }
        if (e instanceof AuthRequiredError) throw e;
        if (maybeApplied(e)) {
          await moveSession(db, s, "needs_reconcile", { lastError: (e as Error).message }, [{ step: "register.unknown", at: new Date().toISOString(), attemptId, error: (e as Error).message }]);
          return { status: "retry", error: "Результат регистрации неизвестен — выполняется сверка", delayMs: 5_000 };
        }
        await patchSession(db, s.id, { lastError: (e as Error).message }, [{ step: "register.failed", at: new Date().toISOString(), attemptId, error: (e as Error).message }]);
        return { status: "retry", error: (e as Error).message };
      }
    }

    if (s.state === "registered") return await verifyStep(s, adapter, bytes, cms, withAuth);
    return { status: "done", note: `Сеанс в состоянии ${s.state}` };
  } catch (e) {
    // Токен входа забрал параллельный обработчик — он и завершит шаг; здесь повторим позже.
    if (e instanceof AuthInProgress) return { status: "retry", error: e.message, delayMs: 5_000 };
    if (e instanceof AuthRequiredError) {
      // SIGN-06: «Authentication required» — нужна авторизация для шага, подпись сохраняется.
      // Попытку закрываем, только если отказ пришёл на сам запрос регистрации (а не на сверку/проверку).
      const attemptId = s.state === "signature_saved" || s.state === "auth_required" ? openRegisterAttempt(s) : null;
      await db.transaction(async (tx) => {
        if (s.state !== "auth_required" && SIGN_SESSION[s.state as SignSessionState]?.includes("auth_required")) {
          await moveSession(tx, s, "auth_required", { lastError: e.message }, [{ step: attemptId ? "register.failed" : "auth_required", at: new Date().toISOString(), attemptId, auth: true }]);
        } else {
          await patchSession(tx, s.id, { lastError: e.message }, attemptId ? [{ step: "register.failed", at: new Date().toISOString(), attemptId, auth: true }] : undefined);
        }
        await chairTask(tx, s, "sign_auth", "Подтвердите вход в SIGEX для регистрации ЭЦП", "Подпись председателя получена и сохранена. Для её регистрации SIGEX требует входа от имени подписанта. Откройте дело, нажмите «Подтвердить вход в SIGEX» и отсканируйте QR в eGov Mobile. Повторно подписывать заключение не нужно.");
        await audit(tx, { orgId: s.organizationId, actor: SERVICE_ACTOR, action: "sign.auth_required", objectType: "sign_session", objectId: s.id, caseId: s.caseId, result: "error", basis: e.message });
      });
      return { status: "done", note: "Нужна авторизация" };
    }
    throw e;
  }
};

async function verifyStep(s: Session, adapter: SignAdapter, bytes: Uint8Array, cms: Uint8Array, withAuth: <T>(fn: (c: string | null) => Promise<T>) => Promise<T>) {
  const ver = await withAuth((authCookie) => adapter.verify({ documentBytes: bytes, cms, registrationId: s.registrationId, authCookie }));
  const isDry = s.provider === "dry-run";
  const verification = { ...ver, dryRun: isDry };

  if (ver.unavailable) {
    // BR-05: «проверка недоступна» не превращается в «проверена»; состояние остаётся registered.
    await db.transaction(async (tx) => {
      await patchSession(tx, s.id, { verification, lastError: "Проверка подписи недоступна" }, [{ step: "verify.unavailable", at: ver.checkedAt, details: ver.details as Record<string, unknown> }]);
      await setCardStatus(tx, s, { state: "unavailable", label: "Проверка недоступна", checkedAt: ver.checkedAt });
    });
    return { status: "retry" as const, error: "Проверка подписи недоступна", delayMs: VERIFY_UNAVAILABLE_DELAY_MS };
  }

  if (ver.cryptoValid === false) {
    await db.transaction(async (tx) => {
      await patchSession(tx, s.id, { verification, lastError: "Подпись не соответствует документу" }, [{ step: "verify.invalid", at: ver.checkedAt }]);
      await setCardStatus(tx, s, { state: "invalid", label: "Подпись не подтверждена проверкой", checkedAt: ver.checkedAt });
      await chairTask(tx, s, "sign_check", "Проверка ЭЦП не пройдена", "Поставщик сообщил, что подпись не соответствует документу. Документ не считается подписанным.");
      await audit(tx, { orgId: s.organizationId, actor: SERVICE_ACTOR, action: "sign.verify_failed", objectType: "sign_session", objectId: s.id, caseId: s.caseId, result: "error" });
    });
    return { status: "dead" as const, error: "Подпись не соответствует документу" };
  }

  await db.transaction(async (tx) => {
    // Одноразовые данные входа больше не нужны.
    const u = urlsOf(s);
    const urls: SessionUrls = { ...u, authSignature: null, auth: u.auth ? { ...u.auth, signature: null } : u.auth };
    await moveSession(tx, s, "verified", { verification, actualSigner: ver.signer, lastError: null, urls }, [{ step: "verify.ok", at: ver.checkedAt }]);
    const v = await tx.query.documentVersions.findFirst({ where: eq(schema.documentVersions.id, s.documentVersionId) });
    if (v && v.state !== "signed") {
      assertTransition(DOC_VERSION, "document_version", v.state as DocVersionState, "signed");
      // После перехода триггер БД запрещает менять байты версии (BR-03, DOC-09).
      await tx.update(schema.documentVersions).set({ state: "signed" }).where(eq(schema.documentVersions.id, v.id));
    }
    const complete = !isDry && ver.cryptoValid === true && ver.trustChecked === true;
    await setCardStatus(tx, s, {
      state: "verified",
      label: isDry ? "Тестовая подпись (без юридической силы)" : complete ? "ЭЦП проверена" : "Подпись получена; проверка доверия не завершена",
      checkedAt: ver.checkedAt,
      cryptoValid: ver.cryptoValid,
      trustChecked: ver.trustChecked,
      dryRun: isDry,
      provider: s.provider,
      registrationId: s.registrationId,
    });
    await resolveTasks(tx, s);
    // Событие, значимое для реестра дела (подпись и проверка).
    await audit(tx, {
      orgId: s.organizationId,
      actor: SERVICE_ACTOR,
      action: "sign.verified",
      objectType: "document_version",
      objectId: s.documentVersionId,
      caseId: s.caseId,
      after: { sessionId: s.id, documentSha256: s.documentSha256, cryptoValid: ver.cryptoValid, trustChecked: ver.trustChecked, signedAt: ver.signedAt, dryRun: isDry },
      externalIds: { registrationId: s.registrationId, procedureId: s.procedureId },
    });
  });
  return { status: "done" as const };
}

export function registerSignHandlers() {
  registerHandler("sign.poll", pollHandler);
  registerHandler("sign.register_verify", registerVerifyHandler);
}
