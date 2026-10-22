/**
 * Схема базы платформы КЗППА РКА. Источник истины для реестра, статусов и связей (BR-02).
 * DATA-01..10 и ограничения раздела 5. Все записи содержат organization_id (DATA-01).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  date,
  uniqueIndex,
  index,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const orgId = () => uuid("organization_id").notNull().references(() => organizations.id);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts("created_at").notNull().defaultNow();

/* DATA-01 */
export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  nameKk: text("name_kk"),
  shortName: text("short_name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Almaty"),
  officialSender: text("official_sender").notNull(), // kzppa.rka@gmail.com
  rkaAddress: text("rka_address").notNull(), // office@advokatura.kz
  rkaAddressee: text("rka_addressee").notNull().default("Председателю Республиканской коллегии адвокатов"),
  outgoingPrefix: text("outgoing_prefix"), // DEC-01: ещё утверждается
  outgoingYearInNumber: boolean("outgoing_year_in_number").notNull().default(false),
  quorumRule: jsonb("quorum_rule").notNull(),
  decisionRule: jsonb("decision_rule").notNull(),
  policies: jsonb("policies").notNull().default({}),
  createdAt: created(),
});

/* DATA-02 */
export const users = pgTable(
  "users",
  {
    id: id(),
    organizationId: orgId(),
    authUserId: uuid("auth_user_id"),
    fullName: text("full_name").notNull(),
    fullNameKk: text("full_name_kk"),
    firstName: text("first_name"), // подтверждённое обращение RU
    patronymic: text("patronymic"),
    addressKk: text("address_kk"), // подтверждённое обращение KK
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    collegium: text("collegium"),
    status: text("status").notNull().default("active"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("users_org_email").on(t.organizationId, t.email)],
);

export const orgRoles = pgTable(
  "org_roles",
  {
    id: id(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("org_roles_user_role").on(t.userId, t.role)],
);

/* DATA-03 */
export const cases = pgTable(
  "cases",
  {
    id: id(),
    organizationId: orgId(),
    year: integer("year").notNull(),
    number: integer("number").notNull(), // A — постоянный номер обращения комиссии
    rkaNumber: text("rka_number"), // B
    rkaDate: date("rka_date"),
    receivedAt: ts("received_at"), // C — фактическое поступление на ящик КЗППА
    collegium: text("collegium"), // D
    collegiumCandidates: jsonb("collegium_candidates").notNull().default([]),
    collegiumSource: text("collegium_source"),
    collegiumManual: boolean("collegium_manual").notNull().default(false),
    applicant: text("applicant").notNull(), // E
    applicantAliases: text("applicant_aliases").array().notNull().default(sql`'{}'::text[]`),
    summary: text("summary"), // F
    summarySource: text("summary_source"),
    summaryMachine: boolean("summary_machine").notNull().default(false),
    summaryManual: boolean("summary_manual").notNull().default(false),
    lang: text("lang"), // язык обращения
    langConfirmed: boolean("lang_confirmed").notNull().default(false),
    conclusionLang: text("conclusion_lang"),
    state: text("state").notNull().default("registered"),
    currentCycleId: uuid("current_cycle_id"),
    executorId: uuid("executor_id"),
    chairId: uuid("chair_id"),
    secretaryId: uuid("secretary_id"),
    resultCode: text("result_code"), // K
    resultAt: ts("result_at"), // L
    measures: text("measures"), // N
    closedBasis: text("closed_basis"),
    initialMessageId: uuid("initial_message_id"), // AB
    driveFolderId: text("drive_folder_id"),
    version: integer("version").notNull().default(1),
    createdAt: created(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cases_org_year_number").on(t.organizationId, t.year, t.number),
    index("cases_rka").on(t.organizationId, t.rkaNumber),
  ],
);

export const caseMembers = pgTable(
  "case_members",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(), // executor | workspace_admin | voter | signer
    cycleId: uuid("cycle_id"),
    active: boolean("active").notNull().default(true),
    grantedBy: uuid("granted_by"),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("case_members_case").on(t.caseId), index("case_members_user").on(t.userId)],
);

/* Почтовые подключения (MAIL-01..03) */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: id(),
    organizationId: orgId(),
    provider: text("provider").notNull().default("gmail"),
    email: text("email").notNull(),
    state: text("state").notNull().default("disabled"),
    refreshTokenEnc: text("refresh_token_enc"), // зашифровано AES-GCM, ключ в секретах
    scopes: text("scopes"),
    historyId: text("history_id"),
    watchExpiration: ts("watch_expiration"),
    initialSyncFrom: date("initial_sync_from"),
    initialSyncCursor: text("initial_sync_cursor"),
    initialSyncDone: boolean("initial_sync_done").notNull().default(false),
    lastSyncAt: ts("last_sync_at"),
    lastError: text("last_error"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("mail_accounts_org_email").on(t.organizationId, t.email)],
);

/* DATA-04 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    organizationId: orgId(),
    accountId: uuid("account_id").notNull().references(() => mailAccounts.id),
    providerMessageId: text("provider_message_id").notNull(),
    internetMessageId: text("internet_message_id"),
    threadId: text("thread_id"),
    direction: text("direction").notNull(), // in | out
    sentAt: ts("sent_at"),
    receivedAt: ts("received_at"),
    processedAt: ts("processed_at").notNull().defaultNow(),
    fromAddr: text("from_addr").notNull(),
    fromName: text("from_name"),
    toAddrs: text("to_addrs").array().notNull().default(sql`'{}'::text[]`),
    ccAddrs: text("cc_addrs").array().notNull().default(sql`'{}'::text[]`),
    replyTo: text("reply_to"),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    rawBlobId: uuid("raw_blob_id"),
    labelIds: text("label_ids").array().notNull().default(sql`'{}'::text[]`),
    sourceCheck: jsonb("source_check").notNull().default({}), // SPF/DKIM/DMARC, признаки подозрительности
    intakeState: text("intake_state").notNull().default("discovered"),
    intakeKind: text("intake_kind"),
    match: jsonb("match"), // предложение сопоставления с основаниями
    caseId: uuid("case_id").references(() => cases.id),
    attachedBy: uuid("attached_by"),
    attachBasis: text("attach_basis"),
    lang: text("lang"),
    addedLate: boolean("added_late").notNull().default(false), // OUT-12
  },
  (t) => [
    uniqueIndex("messages_account_provider").on(t.accountId, t.providerMessageId),
    index("messages_case").on(t.caseId),
    index("messages_thread").on(t.threadId),
    index("messages_intake").on(t.organizationId, t.intakeState),
  ],
);

/* Физические объекты содержимого (дедупликация не раскрывает доступ — см. раздел 5) */
export const blobs = pgTable(
  "blobs",
  {
    id: id(),
    organizationId: orgId(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mimeType: text("mime_type"),
    storageKey: text("storage_key").notNull(), // без ПДн в имени (STORE-04)
    verifiedAt: ts("verified_at"),
    legalHold: boolean("legal_hold").notNull().default(false),
    createdAt: created(),
  },
  (t) => [uniqueIndex("blobs_org_sha").on(t.organizationId, t.sha256)],
);

/* DATA-05 */
export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    organizationId: orgId(),
    messageId: uuid("message_id").notNull().references(() => messages.id),
    partId: text("part_id").notNull(),
    providerAttachmentId: text("provider_attachment_id"),
    filename: text("filename").notNull(),
    displayName: text("display_name"),
    mimeType: text("mime_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    sha256: text("sha256"),
    inline: boolean("inline").notNull().default(false),
    parentPartId: text("parent_part_id"),
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    exclusion: jsonb("exclusion"),
    blobId: uuid("blob_id").references(() => blobs.id),
    documentVersionId: uuid("document_version_id"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: created(),
  },
  (t) => [uniqueIndex("attachments_message_part").on(t.messageId, t.partId)],
);

/* DATA-06 */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    cycleId: uuid("cycle_id"),
    category: text("category").notNull(),
    title: text("title").notNull(),
    lang: text("lang"),
    confidential: boolean("confidential").notNull().default(true),
    area: text("area").notNull().default("root"), // root | executor_workspace | discussion | signed
    createdAt: created(),
  },
  (t) => [index("documents_case").on(t.caseId)],
);

/** CASE-05: документ может относиться к нескольким делам. */
export const documentLinks = pgTable(
  "document_links",
  {
    organizationId: orgId(),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    linkedBy: uuid("linked_by"),
    basis: text("basis"),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.caseId] })],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: id(),
    organizationId: orgId(),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    version: integer("version").notNull(),
    state: text("state").notNull().default("working"),
    blobId: uuid("blob_id").references(() => blobs.id),
    sha256: text("sha256"),
    size: bigint("size", { mode: "number" }),
    format: text("format"), // pdf | docx | eml | html
    filename: text("filename"),
    authorId: uuid("author_id"),
    sourceMessageId: uuid("source_message_id"),
    sourceAttachmentId: uuid("source_attachment_id"),
    createdFrom: uuid("created_from"),
    replaces: uuid("replaces"),
    signsVersionId: uuid("signs_version_id"),
    generator: jsonb("generator"), // версии шаблона/конвертера (DOC-03)
    approval: jsonb("approval"), // { approvedHash, approvedBy, approvedAt }
    legalHold: boolean("legal_hold").notNull().default(false),
    quarantine: boolean("quarantine").notNull().default(false),
    deletedAt: ts("deleted_at"), // STORE-07: обратимое удаление
    deleteBasis: text("delete_basis"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("doc_versions_doc_ver").on(t.documentId, t.version)],
);

/* DATA-07: циклы рассмотрения */
export const cycles = pgTable(
  "cycles",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    number: integer("number").notNull(),
    parentCycleId: uuid("parent_cycle_id"),
    supplementary: boolean("supplementary").notNull().default(false),
    basis: text("basis"),
    state: text("state").notNull().default("preparation"), // preparation | preapproved | voting | closed | finalized
    draftVersionId: uuid("draft_version_id"),
    frozenManifest: jsonb("frozen_manifest"),
    eligibleSnapshot: jsonb("eligible_snapshot"), // [{userId, fullName}]
    recused: jsonb("recused").notNull().default([]),
    quorumRule: jsonb("quorum_rule"),
    decisionRule: jsonb("decision_rule"),
    preapprovedBy: uuid("preapproved_by"),
    preapprovedAt: ts("preapproved_at"),
    discussionNotifiedAt: ts("discussion_notified_at"),
    openedAt: ts("opened_at"),
    closesAt: ts("closes_at"),
    closedAt: ts("closed_at"),
    earlyCloseBasis: text("early_close_basis"),
    tally: jsonb("tally"),
    protocolVersionId: uuid("protocol_version_id"),
    protocolHash: text("protocol_hash"),
    finalRoute: text("final_route"), // as_is | rework
    finalVersionId: uuid("final_version_id"),
    finalReceivedAt: ts("final_received_at"),
    approvedBy: uuid("approved_by"),
    approvedAt: ts("approved_at"),
    conclusionNumber: text("conclusion_number"),
    conclusionDate: date("conclusion_date"),
    version: integer("version").notNull().default(1),
    createdAt: created(),
  },
  (t) => [uniqueIndex("cycles_case_number").on(t.caseId, t.number)],
);

export const votes = pgTable(
  "votes",
  {
    id: id(),
    organizationId: orgId(),
    cycleId: uuid("cycle_id").notNull().references(() => cycles.id),
    memberId: uuid("member_id").notNull().references(() => users.id),
    choice: text("choice").notNull(),
    comment: text("comment"),
    specialOpinion: text("special_opinion"),
    draftVersionId: uuid("draft_version_id").notNull(), // голос привязан к снимку проекта
    castAt: ts("cast_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("votes_cycle_member").on(t.cycleId, t.memberId)],
);

/** FLOW-13: приглашение, доставка, открытие и голос — разные события. */
export const voteInvitations = pgTable(
  "vote_invitations",
  {
    id: id(),
    organizationId: orgId(),
    cycleId: uuid("cycle_id").notNull().references(() => cycles.id),
    memberId: uuid("member_id").notNull().references(() => users.id),
    token: text("token").notNull(),
    sentAt: ts("sent_at"),
    deliveryState: text("delivery_state").notNull().default("pending"),
    openedAt: ts("opened_at"),
  },
  (t) => [uniqueIndex("vote_inv_token").on(t.token), uniqueIndex("vote_inv_cycle_member").on(t.cycleId, t.memberId)],
);

/* DATA-07: поручения */
export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    cycleId: uuid("cycle_id"),
    kind: text("kind").notNull().default("initial"), // initial | finalization
    executorId: uuid("executor_id").notNull().references(() => users.id),
    preparedBy: uuid("prepared_by"),
    assignedBy: uuid("assigned_by"), // председатель — решение AE
    assignedAt: ts("assigned_at"), // H
    deadline: date("deadline"), // I
    extendedUntil: date("extended_until"), // J
    extensionBasis: text("extension_basis"),
    task: text("task").notNull(),
    lang: text("lang").notNull(),
    state: text("state").notNull().default("assigned_by_chair"),
    letterSubject: text("letter_subject"),
    letterText: text("letter_text"),
    letterHtml: text("letter_html"),
    letterHash: text("letter_hash"),
    workspaceLink: text("workspace_link"),
    materialVersionIds: jsonb("material_version_ids").notNull().default([]),
    approval: jsonb("approval"),
    accessResult: jsonb("access_result"),
    outgoingId: uuid("outgoing_id"),
    sentAt: ts("sent_at"), // AC
    sentProviderId: text("sent_provider_id"), // AJ для финализации
    version: integer("version").notNull().default(1),
    createdAt: created(),
  },
  (t) => [index("assignments_case").on(t.caseId)],
);

/* DATA-08 */
export const signSessions = pgTable(
  "sign_sessions",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    documentVersionId: uuid("document_version_id").notNull().references(() => documentVersions.id),
    documentSha256: text("document_sha256").notNull(),
    assignedSignerId: uuid("assigned_signer_id").notNull(),
    actualSigner: jsonb("actual_signer"), // минимально необходимые данные сертификата
    provider: text("provider").notNull().default("sigex"),
    procedureId: text("procedure_id"),
    urls: jsonb("urls"),
    expireAt: ts("expire_at"),
    state: text("state").notNull().default("created"),
    registrationId: text("registration_id"),
    signatureBlobId: uuid("signature_blob_id"),
    signatureType: text("signature_type"), // cms | pades
    receivedAt: ts("received_at"),
    verification: jsonb("verification"), // {crypto, trust, authority, checkedAt}
    providerResponses: jsonb("provider_responses").notNull().default([]),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("sign_sessions_idem").on(t.idempotencyKey)],
);

/* QR-карточка проверки (DOC-05, DOC-06, DOC-11, DOC-12) */
export const qrCards = pgTable(
  "qr_cards",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    cycleId: uuid("cycle_id").notNull().references(() => cycles.id),
    documentVersionId: uuid("document_version_id").notNull(),
    token: text("token").notNull(),
    manifest: jsonb("manifest").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    pdfSha256: text("pdf_sha256"),
    signatureStatus: jsonb("signature_status"),
    statusHistory: jsonb("status_history").notNull().default([]),
    createdAt: created(),
  },
  (t) => [uniqueIndex("qr_cards_token").on(t.token), uniqueIndex("qr_cards_version").on(t.documentVersionId)],
);

/* DATA-09 */
export const outgoings = pgTable(
  "outgoings",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id").notNull().references(() => cases.id),
    cycleId: uuid("cycle_id"),
    kind: text("kind").notNull(), // assignment | rka_package | decision_notice | discussion_notice
    numberCase: integer("number_case"),
    repeatIndex: integer("repeat_index"),
    numberDisplay: text("number_display"),
    outgoingDate: date("outgoing_date"),
    lang: text("lang"),
    fromAddr: text("from_addr").notNull(),
    toAddrs: text("to_addrs").array().notNull(),
    ccAddrs: text("cc_addrs").array().notNull().default(sql`'{}'::text[]`),
    bccAddrs: text("bcc_addrs").array().notNull().default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    manifest: jsonb("manifest").notNull().default([]),
    packageHash: text("package_hash"),
    approval: jsonb("approval"),
    state: text("state").notNull().default("project"),
    providerDraftId: text("provider_draft_id"),
    attempts: integer("attempts").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    internetMessageId: text("internet_message_id"),
    sentAt: ts("sent_at"),
    reconcile: jsonb("reconcile"),
    rejectedReason: text("rejected_reason"),
    cancelledAt: ts("cancelled_at"),
    idempotencyKey: text("idempotency_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("outgoings_idem").on(t.idempotencyKey),
    // уникальный исходящий в серии (раздел 5)
    uniqueIndex("outgoings_number").on(t.organizationId, t.numberCase, t.repeatIndex).where(sql`kind = 'rka_package' and number_case is not null`),
  ],
);

/* Задачи людям (очередь разбора, возвраты, проблемы доступа) */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    organizationId: orgId(),
    caseId: uuid("case_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    assigneeRole: text("assignee_role").notNull().default("secretary"),
    assigneeId: uuid("assignee_id"),
    objectType: text("object_type"),
    objectId: uuid("object_id"),
    state: text("state").notNull().default("open"),
    dueAt: ts("due_at"),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by"),
    dedupKey: text("dedup_key"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("tasks_dedup").on(t.dedupKey), index("tasks_open").on(t.organizationId, t.state)],
);

/* DATA-10, AUD-01..02: журнал с цепочкой хешей */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: orgId(),
    at: ts("at").notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorType: text("actor_type").notNull(), // user | service | external
    actorLabel: text("actor_label"),
    role: text("role"),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id"),
    objectVersion: integer("object_version"),
    caseId: uuid("case_id"),
    result: text("result").notNull(), // ok | denied | error
    before: jsonb("before"),
    after: jsonb("after"),
    basis: text("basis"),
    correlationId: text("correlation_id"),
    externalIds: jsonb("external_ids"),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (t) => [index("audit_case").on(t.caseId), index("audit_at").on(t.organizationId, t.at)],
);

/* ARCH-03: transactional outbox */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    organizationId: orgId(),
    type: text("type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version"),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | done | dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    correlationId: text("correlation_id"),
    createdAt: created(),
    doneAt: ts("done_at"),
  },
  (t) => [uniqueIndex("outbox_idem").on(t.idempotencyKey), index("outbox_due").on(t.status, t.nextAttemptAt)],
);

/* ARCH-05: идемпотентность команд */
export const commandLog = pgTable("command_log", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  organizationId: orgId(),
  command: text("command").notNull(),
  actorId: uuid("actor_id"),
  result: jsonb("result"),
  at: ts("at").notNull().defaultNow(),
});

/* Шаблоны с версиями (DEC-05) */
export const templates = pgTable(
  "templates",
  {
    id: id(),
    organizationId: orgId(),
    kind: text("kind").notNull(),
    lang: text("lang").notNull(),
    version: integer("version").notNull(),
    body: jsonb("body").notNull(),
    active: boolean("active").notNull().default(true),
    approvedBy: uuid("approved_by"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("templates_kind_lang_ver").on(t.organizationId, t.kind, t.lang, t.version)],
);

/* SEC-02: одноразовые коды входа, отправляемые с почты комиссии. Хранится только хеш кода. */
export const loginCodes = pgTable(
  "login_codes",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    codeHash: text("code_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: ts("used_at"),
    sendState: text("send_state").notNull().default("pending"),
    createdAt: created(),
  },
  (t) => [index("login_codes_user").on(t.userId, t.createdAt)],
);

/* Сессии входа (демо, вход по коду с почты комиссии, вход администратора по ключу) */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  createdAt: created(),
  expiresAt: ts("expires_at").notNull(),
});
