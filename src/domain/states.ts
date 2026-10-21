/**
 * Раздел 13, FLOW-02, STATE-01..03. Переходы выполняются только серверными командами.
 * Произвольная запись строки статуса запрещена: допустимы лишь переходы из таблиц.
 */

import type {
  AssignmentState,
  CaseState,
  DocVersionState,
  IntakeState,
  OutgoingState,
  SignSessionState,
} from "./types";

type Graph<S extends string> = Record<S, readonly S[]>;

export const INTAKE: Graph<IntakeState> = {
  discovered: ["loading", "quarantine", "access_error"],
  loading: ["verified", "incomplete", "quarantine", "access_error"],
  incomplete: ["loading", "verified", "needs_review"],
  verified: ["matched", "needs_review"],
  needs_review: ["matched", "quarantine"],
  matched: ["attached", "needs_review"],
  attached: [],
  quarantine: ["needs_review", "loading"],
  access_error: ["loading"],
};

export const CASE: Graph<CaseState> = {
  registered: ["assigned", "suspended", "cancelled"],
  assigned: ["in_progress", "suspended", "cancelled"],
  in_progress: ["review", "rework", "suspended"],
  review: ["approved", "rework", "in_progress"],
  rework: ["in_progress", "review"],
  approved: ["sent", "rework"],
  sent: ["closed", "resumed"],
  closed: ["resumed"],
  suspended: ["resumed", "cancelled"],
  resumed: ["assigned", "in_progress"],
  cancelled: [],
};

export const DOC_VERSION: Graph<DocVersionState> = {
  working: ["on_approval", "superseded"],
  on_approval: ["approved", "rejected", "superseded"],
  approved: ["ready_to_sign", "superseded"],
  ready_to_sign: ["signature_check_pending", "signed", "superseded"],
  signature_check_pending: ["signed", "ready_to_sign"],
  signed: ["archived"],
  archived: [],
  rejected: ["superseded"],
  superseded: [],
};

export const SIGN_SESSION: Graph<SignSessionState> = {
  created: ["data_submitted", "expired", "error"],
  data_submitted: ["waiting", "expired", "error"],
  waiting: ["signature_saved", "expired", "refused", "error"],
  signature_saved: ["registered", "auth_required", "needs_reconcile"],
  auth_required: ["registered", "needs_reconcile"],
  needs_reconcile: ["registered", "signature_saved"],
  registered: ["verified", "auth_required", "needs_reconcile"],
  verified: [],
  expired: [],
  refused: [],
  error: ["needs_reconcile"],
};

export const OUTGOING: Graph<OutgoingState> = {
  project: ["package_checked"],
  package_checked: ["draft", "project"],
  draft: ["approved", "project", "approval_stale"],
  approved: ["sending", "approval_stale"],
  approval_stale: ["draft"],
  sending: ["sent", "unknown_result", "error"],
  unknown_result: ["sent", "approved"], // только после сверки отправленных (OUT-06)
  error: ["approved", "draft"],
  sent: ["bounced"],
  bounced: [],
};

export const ASSIGNMENT: Graph<AssignmentState> = {
  assigned_by_chair: ["access_granting"],
  access_granting: ["access_verified", "access_error"],
  access_error: ["access_granting"],
  access_verified: ["draft_ready"],
  draft_ready: ["text_on_approval"],
  text_on_approval: ["approved_to_send", "draft_ready"],
  approved_to_send: ["sending", "text_on_approval"],
  sending: ["sent", "approved_to_send"],
  sent: ["receipt_confirmed", "in_work", "draft_submitted"],
  receipt_confirmed: ["in_work", "draft_submitted"],
  in_work: ["draft_submitted"],
  draft_submitted: ["on_rework", "done"],
  on_rework: ["draft_submitted"],
  done: [],
};

export class TransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    machine: string,
  ) {
    super(`Недопустимый переход ${machine}: «${from}» → «${to}»`);
  }
}

export function assertTransition<S extends string>(
  graph: Graph<S>,
  machine: string,
  from: S,
  to: S,
): void {
  if (!graph[from]?.includes(to)) throw new TransitionError(from, to, machine);
}

export function canTransition<S extends string>(graph: Graph<S>, from: S, to: S): boolean {
  return !!graph[from]?.includes(to);
}

/** STATE-02. Оптимистичная блокировка: ожидаемая версия объекта. */
export class VersionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Объект изменён другим пользователем (ожидалась версия ${expected}, текущая ${actual}). Обновите страницу.`);
  }
}

export const CASE_STATE_LABEL: Record<CaseState, string> = {
  registered: "Зарегистрировано",
  assigned: "Назначено",
  in_progress: "В работе",
  review: "Рассмотрение",
  approved: "Утверждено",
  sent: "Направлено",
  closed: "Закрыто",
  rework: "Доработка",
  suspended: "Приостановлено",
  resumed: "Возобновлено",
  cancelled: "Отменено",
};

export const ASSIGNMENT_STATE_LABEL: Record<AssignmentState, string> = {
  assigned_by_chair: "Назначено председателем",
  access_granting: "Доступ предоставляется",
  access_verified: "Доступ проверен",
  draft_ready: "Черновик подготовлен",
  text_on_approval: "На утверждении текста",
  approved_to_send: "Утверждено к отправке",
  sending: "Отправляется",
  sent: "Отправлено",
  receipt_confirmed: "Получение подтверждено",
  in_work: "В работе",
  draft_submitted: "Проект представлен",
  on_rework: "На доработке",
  done: "Выполнено",
  access_error: "Ошибка доступа",
};

export const OUTGOING_STATE_LABEL: Record<OutgoingState, string> = {
  project: "Проект",
  package_checked: "Комплект проверен",
  draft: "Черновик",
  approved: "Разрешено к отправке",
  sending: "Отправляется",
  sent: "Отправлено",
  approval_stale: "Разрешение устарело",
  unknown_result: "Результат неизвестен",
  bounced: "Возврат",
  error: "Ошибка",
};

export const SIGN_STATE_LABEL: Record<SignSessionState, string> = {
  created: "Сеанс создан",
  data_submitted: "Данные переданы",
  waiting: "Ожидание подписи",
  signature_saved: "Подпись сохранена",
  registered: "Зарегистрирована",
  verified: "Проверена",
  expired: "Сеанс истёк",
  refused: "Отказ",
  error: "Ошибка",
  auth_required: "Нужна авторизация",
  needs_reconcile: "Требуется сверка",
};

export const DOC_STATE_LABEL: Record<DocVersionState, string> = {
  working: "Рабочая",
  on_approval: "На согласовании",
  approved: "Согласована",
  ready_to_sign: "Готова к подписи",
  signed: "Подписана",
  archived: "Архив",
  rejected: "Отклонена",
  superseded: "Заменена",
  signature_check_pending: "Проверка подписи не завершена",
};

export const INTAKE_STATE_LABEL: Record<IntakeState, string> = {
  discovered: "Обнаружено",
  loading: "Загружается",
  verified: "Проверено",
  matched: "Сопоставлено",
  attached: "Приобщено",
  incomplete: "Загрузка не завершена",
  quarantine: "Карантин",
  needs_review: "Требует разбора",
  access_error: "Ошибка доступа",
};
