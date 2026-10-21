import "server-only";
import { and, eq, inArray, ne, sql, count } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import type { OrgRole } from "@/domain/types";
import type { DecisionRule, QuorumRule } from "@/domain/quorum";
import { audit } from "../audit";
import { CommandError, runCommand } from "../command";
import type { SessionUser } from "../auth";
import { requeueDead } from "../outbox";

/**
 * UI-07, DATA-01, DATA-02, DEC-02. Административные команды: состав комиссии,
 * настройки организации, фоновые операции. Все изменения — через runCommand
 * с проверкой полномочия на сервере и записью «до/после» в журнал.
 * Пользователи не удаляются: только деактивация (история дел ссылается на них).
 */

const ALL_ROLES: readonly OrgRole[] = ["chair", "secretary", "member", "auditor", "outgoing_registrar", "tech_admin"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (s: string | null | undefined) => {
  const v = (s ?? "").trim().replace(/\s+/g, " ");
  return v.length ? v : null;
};

/** Число действующих членов комиссии — тот же отбор, что при открытии голосования. */
export async function activeCompositionCount(orgId: string, tx: Tx | typeof db = db): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(schema.orgRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.orgRoles.userId))
    .where(and(eq(schema.orgRoles.organizationId, orgId), eq(schema.orgRoles.role, "member"), eq(schema.users.status, "active")));
  return r?.n ?? 0;
}

/* ───────────── Состав комиссии ───────────── */

export interface MemberInput {
  id?: string;
  fullName: string;
  fullNameKk?: string | null;
  firstName: string;
  patronymic?: string | null;
  addressKk?: string | null;
  email: string;
  emailVerified: boolean;
  /** Явное подтверждение, что новый адрес уже проверен. Без него смена адреса сбрасывает отметку. */
  confirmVerifiedEmail?: boolean;
  collegium?: string | null;
  roles: OrgRole[];
  status: "active" | "inactive";
}

export async function upsertMember(user: SessionUser, input: MemberInput) {
  return runCommand({ name: input.id ? "admin.member.update" : "admin.member.create", user, permission: { action: "admin.members" } }, async ({ tx, actor, orgId }) => {
    const fullName = clean(input.fullName);
    if (!fullName || fullName.split(" ").length < 2) throw new CommandError("Укажите ФИО полностью: фамилию, имя и, если есть, отчество.");
    const email = (input.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new CommandError("Адрес электронной почты указан неверно. Проверьте написание, например name@example.kz.");
    if (input.status !== "active" && input.status !== "inactive") throw new CommandError("Неизвестный статус участника");
    const roles = [...new Set(input.roles ?? [])];
    const bad = roles.filter((r) => !ALL_ROLES.includes(r));
    if (bad.length) throw new CommandError(`Неизвестные роли: ${bad.join(", ")}`);

    // Самоблокировка: администратор не может снять с себя права администрирования.
    if (input.id && input.id === user.id) {
      const keepsAdmin = roles.includes("chair") || roles.includes("tech_admin");
      if (input.status !== "active" || !keepsAdmin) {
        throw new CommandError("Нельзя деактивировать себя или снять с себя права администрирования. Это может сделать другой председатель или технический администратор.");
      }
    }

    const dup = await tx.query.users.findFirst({
      where: and(eq(schema.users.organizationId, orgId), eq(sql`lower(${schema.users.email})`, email), input.id ? ne(schema.users.id, input.id) : undefined),
    });
    if (dup) throw new CommandError(`Адрес ${email} уже закреплён за участником «${dup.fullName}». Один адрес — один человек.`);

    const fields = {
      fullName,
      fullNameKk: clean(input.fullNameKk),
      firstName: clean(input.firstName),
      patronymic: clean(input.patronymic),
      addressKk: clean(input.addressKk),
      collegium: clean(input.collegium),
      status: input.status,
    };

    if (input.id) {
      const before = await tx.query.users.findFirst({ where: and(eq(schema.users.id, input.id), eq(schema.users.organizationId, orgId)) });
      if (!before) throw new CommandError("Участник не найден. Обновите страницу.");
      const beforeRoles = (await tx.select({ role: schema.orgRoles.role }).from(schema.orgRoles).where(eq(schema.orgRoles.userId, before.id))).map((r) => r.role).sort();
      const emailChanged = before.email.toLowerCase() !== email;
      const emailVerified = emailChanged ? !!(input.emailVerified && input.confirmVerifiedEmail) : !!input.emailVerified;
      await tx
        .update(schema.users)
        .set({
          ...fields,
          email,
          emailVerified,
          // Новая почта — новая учётная запись входа: прежняя привязка снимается.
          ...(emailChanged ? { authUserId: null } : {}),
        })
        .where(eq(schema.users.id, before.id));
      await replaceRoles(tx, orgId, before.id, roles);
      await audit(tx, {
        orgId,
        actor,
        action: "admin.member.update",
        objectType: "user",
        objectId: before.id,
        before: { fullName: before.fullName, fullNameKk: before.fullNameKk, firstName: before.firstName, patronymic: before.patronymic, addressKk: before.addressKk, email: before.email, emailVerified: before.emailVerified, collegium: before.collegium, status: before.status, roles: beforeRoles },
        after: { ...fields, email, emailVerified, roles: [...roles].sort() },
      });
      return { id: before.id, emailVerified, emailReset: emailChanged && !emailVerified };
    }

    const [created] = await tx
      .insert(schema.users)
      .values({ organizationId: orgId, ...fields, email, emailVerified: !!input.emailVerified })
      .returning({ id: schema.users.id });
    await replaceRoles(tx, orgId, created.id, roles);
    await audit(tx, {
      orgId,
      actor,
      action: "admin.member.create",
      objectType: "user",
      objectId: created.id,
      after: { ...fields, email, emailVerified: !!input.emailVerified, roles: [...roles].sort() },
    });
    return { id: created.id, emailVerified: !!input.emailVerified, emailReset: false };
  });
}

async function replaceRoles(tx: Tx, orgId: string, userId: string, roles: OrgRole[]) {
  const existing = await tx.select({ id: schema.orgRoles.id, role: schema.orgRoles.role }).from(schema.orgRoles).where(eq(schema.orgRoles.userId, userId));
  const remove = existing.filter((r) => !roles.includes(r.role as OrgRole)).map((r) => r.id);
  if (remove.length) await tx.delete(schema.orgRoles).where(inArray(schema.orgRoles.id, remove));
  const have = new Set(existing.map((r) => r.role));
  const add = roles.filter((r) => !have.has(r));
  if (add.length) await tx.insert(schema.orgRoles).values(add.map((role) => ({ organizationId: orgId, userId, role })));
}

/* ───────────── Настройки организации ───────────── */

export interface OrgSettingsInput {
  name: string;
  nameKk?: string | null;
  shortName: string;
  officialSender: string;
  rkaAddress: string;
  rkaAddressee: string;
  outgoingPrefix?: string | null;
  outgoingYearInNumber: boolean;
  quorumRule: QuorumRule;
  decisionRule: DecisionRule;
}

function validateQuorum(q: QuorumRule): QuorumRule {
  if (q?.kind === "more_than_half_of_composition") return { kind: "more_than_half_of_composition" };
  if (q?.kind === "min_participants") {
    const min = Number(q.min);
    const composition = Number(q.composition);
    if (!Number.isInteger(composition) || composition < 1) throw new CommandError("Укажите состав комиссии целым числом не меньше 1.");
    if (!Number.isInteger(min) || min < 1) throw new CommandError("Укажите минимальное число участвовавших целым числом не меньше 1.");
    if (min > composition) throw new CommandError(`Порог кворума (${min}) не может превышать состав (${composition}).`);
    return { kind: "min_participants", min, composition };
  }
  throw new CommandError("Выберите правило кворума.");
}

function validateDecision(d: DecisionRule): DecisionRule {
  if (d?.kind === "unknown") return { kind: "unknown" };
  if (d?.kind === "for_more_than_half_of_participants" || d?.kind === "for_more_than_against" || d?.kind === "for_more_than_half_of_composition") {
    const source = clean(d.source);
    if (!source || source.length < 5) {
      throw new CommandError("Укажите пункт и редакцию Положения, из которых перенесено правило определения решения. Без источника правило не сохраняется: платформа не выбирает большинство сама.");
    }
    return { kind: d.kind, source };
  }
  throw new CommandError("Выберите правило определения решения.");
}

export async function updateOrgSettings(user: SessionUser, input: OrgSettingsInput) {
  return runCommand({ name: "admin.settings.update", user, permission: { action: "admin.settings" } }, async ({ tx, actor, orgId }) => {
    const name = clean(input.name);
    const shortName = clean(input.shortName);
    const rkaAddressee = clean(input.rkaAddressee);
    if (!name) throw new CommandError("Укажите полное наименование комиссии.");
    if (!shortName) throw new CommandError("Укажите краткое наименование, например «КЗППА РКА».");
    if (!rkaAddressee) throw new CommandError("Укажите адресата сопроводительных писем в РКА.");
    const officialSender = (input.officialSender ?? "").trim().toLowerCase();
    const rkaAddress = (input.rkaAddress ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(officialSender)) throw new CommandError("Официальный адрес комиссии указан неверно.");
    if (!EMAIL_RE.test(rkaAddress)) throw new CommandError("Адрес РКА указан неверно.");
    const outgoingPrefix = clean(input.outgoingPrefix);
    if (outgoingPrefix && !/^[\p{L}\p{N}.-]{1,24}$/u.test(outgoingPrefix)) {
      throw new CommandError("Префикс исходящего может содержать только буквы, цифры, точку и дефис (до 24 знаков), без пробелов и косой черты.");
    }
    const quorumRule = validateQuorum(input.quorumRule);
    const decisionRule = validateDecision(input.decisionRule);

    const before = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
    if (!before) throw new CommandError("Организация не найдена");

    const warnings: string[] = [];
    const composition = await activeCompositionCount(orgId, tx);
    if (quorumRule.kind === "min_participants" && quorumRule.composition !== composition) {
      warnings.push(
        `Порог кворума ${quorumRule.min} задан для состава ${quorumRule.composition}, а сейчас в составе ${composition} действующих членов комиссии. Пока правило не приведено в соответствие, итог новых голосований будет «Решение не определено».`,
      );
    }
    if (decisionRule.kind === "unknown") {
      warnings.push("Правило определения решения не зафиксировано. Протоколы будут показывать «Решение не определено», пока правило не перенесено из Положения.");
    }

    const after = { name, nameKk: clean(input.nameKk), shortName, officialSender, rkaAddress, rkaAddressee, outgoingPrefix, outgoingYearInNumber: !!input.outgoingYearInNumber, quorumRule, decisionRule };
    await tx.update(schema.organizations).set(after).where(eq(schema.organizations.id, orgId));
    await audit(tx, {
      orgId,
      actor,
      action: "admin.settings.update",
      objectType: "organization",
      objectId: orgId,
      before: {
        name: before.name,
        nameKk: before.nameKk,
        shortName: before.shortName,
        officialSender: before.officialSender,
        rkaAddress: before.rkaAddress,
        rkaAddressee: before.rkaAddressee,
        outgoingPrefix: before.outgoingPrefix,
        outgoingYearInNumber: before.outgoingYearInNumber,
        quorumRule: before.quorumRule,
        decisionRule: before.decisionRule,
      },
      after,
      // Прошлые протоколы не меняются: каждый цикл хранит снимок правил на момент открытия.
      basis: decisionRule.kind === "unknown" ? null : decisionRule.source,
    });
    return { warnings, composition };
  });
}

/* ───────────── Фоновые операции ───────────── */

export async function requeueDeadOutbox(user: SessionUser, id: string) {
  return runCommand({ name: "admin.outbox.requeue", user, permission: { action: "admin.settings" } }, async ({ tx, actor, orgId }) => {
    const row = await tx.query.outbox.findFirst({ where: and(eq(schema.outbox.id, id), eq(schema.outbox.organizationId, orgId)) });
    if (!row) throw new CommandError("Операция не найдена. Обновите страницу.");
    if (row.status !== "dead") throw new CommandError("Повторить можно только операцию, остановленную после ошибок.");
    await audit(tx, {
      orgId,
      actor,
      action: "admin.outbox.requeue",
      objectType: "outbox",
      objectId: row.id,
      before: { status: row.status, attempts: row.attempts, lastError: row.lastError },
      after: { status: "pending", attempts: 0 },
    });
    // Если перезапуск не удался, транзакция откатит и запись журнала.
    await requeueDead(row.id);
    return { id: row.id };
  });
}

/** Ручной запуск синхронизации почтового ящика: проверка принадлежности и запись в журнал. */
export async function recordMailSyncRequest(user: SessionUser, accountId: string) {
  return runCommand({ name: "admin.mail.sync_now", user, permission: { action: "admin.settings" } }, async ({ tx, actor, orgId }) => {
    const acc = await tx.query.mailAccounts.findFirst({ where: and(eq(schema.mailAccounts.id, accountId), eq(schema.mailAccounts.organizationId, orgId)) });
    if (!acc) throw new CommandError("Почтовое подключение не найдено. Обновите страницу.");
    await audit(tx, { orgId, actor, action: "admin.mail.sync_now", objectType: "mail_account", objectId: acc.id, externalIds: { email: acc.email } });
    return { id: acc.id, email: acc.email };
  });
}
