/**
 * Базовые доменные типы платформы КЗППА РКА.
 * Ссылки в комментариях — идентификаторы требований ТЗ ред. 3.0 от 21.10.2026.
 */

export type Lang = "ru" | "kk";

/** Раздел 4. Роли назначаются отдельно на организацию и на дело. */
export type OrgRole =
  | "chair" // Председатель
  | "secretary" // Секретарь
  | "member" // Член комиссии
  | "auditor" // Аудитор
  | "outgoing_registrar" // Регистратор исходящих
  | "tech_admin"; // Технический администратор

export type CaseRole =
  | "executor" // Исполнитель
  | "workspace_admin" // Администратор рабочих материалов (ACL-02)
  | "voter" // Допущенный член комиссии в конкретном цикле
  | "signer"; // Подписант

/** Области внутри одного дела (раздел 4, таблица разграничения). */
export type CaseArea =
  | "root" // Корень дела и полная хронология — председатель и секретарь
  | "executor_workspace" // Материалы для исполнителя
  | "discussion" // Обсуждение и голосование конкретного цикла
  | "signed"; // Подписанные версии и проверочная карточка

/** Раздел 13. Состояния объектов. */
export type IntakeState =
  | "discovered"
  | "loading"
  | "verified"
  | "matched"
  | "attached"
  | "incomplete"
  | "quarantine"
  | "needs_review"
  | "access_error";

export type CaseState =
  | "registered"
  | "assigned"
  | "in_progress"
  | "review"
  | "approved"
  | "sent"
  | "closed"
  | "rework"
  | "suspended"
  | "resumed"
  | "cancelled";

export type DocVersionState =
  | "working"
  | "on_approval"
  | "approved"
  | "ready_to_sign"
  | "signed"
  | "archived"
  | "rejected"
  | "superseded"
  | "signature_check_pending";

export type SignSessionState =
  | "created"
  | "data_submitted"
  | "waiting"
  | "signature_saved"
  | "registered"
  | "verified"
  | "expired"
  | "refused"
  | "error"
  | "auth_required"
  | "needs_reconcile";

export type OutgoingState =
  | "project"
  | "package_checked"
  | "draft"
  | "approved"
  | "sending"
  | "sent"
  | "approval_stale"
  | "unknown_result"
  | "bounced"
  | "error";

export type ConnectionState =
  | "connected"
  | "syncing"
  | "up_to_date"
  | "delayed"
  | "login_required"
  | "quota"
  | "unavailable"
  | "disabled";

/** FLOW-02. Стадии поручения. */
export type AssignmentState =
  | "assigned_by_chair"
  | "access_granting"
  | "access_verified"
  | "draft_ready"
  | "text_on_approval"
  | "approved_to_send"
  | "sending"
  | "sent"
  | "receipt_confirmed"
  | "in_work"
  | "draft_submitted"
  | "on_rework"
  | "done"
  | "access_error";

export type VoteChoice = "for" | "against" | "abstain";

export type DocCategory =
  | "incoming_original" // исходные обращения
  | "supplement" // дополнения
  | "assignment" // поручения и переписка
  | "draft" // рабочие проекты
  | "protocol" // рассмотрение и протоколы
  | "conclusion" // утвержденные заключения
  | "outgoing" // исходящие
  | "evidence"; // служебные доказательства (CMS, журналы)

export const DOC_CATEGORY_LABEL: Record<DocCategory, string> = {
  incoming_original: "Исходные обращения",
  supplement: "Дополнения",
  assignment: "Поручения и переписка",
  draft: "Рабочие проекты",
  protocol: "Рассмотрение и протоколы",
  conclusion: "Утвержденные заключения",
  outgoing: "Исходящие",
  evidence: "Служебные доказательства",
};
