import "server-only";
import type { caseDetail } from "./queries";
import { OUTCOME_LABEL, type DecisionOutcome } from "@/domain/quorum";

/**
 * Маршрут дела по подтверждённому процессу заказчика (раздел 1). Каждый этап
 * выводится из зафиксированных фактов; «неизвестно» никогда не показывается как успех (BR-05).
 */

export type StepStatus = "done" | "current" | "blocked" | "pending" | "skipped";

export interface RouteStep {
  key: string;
  title: string;
  status: StepStatus;
  at?: Date | string | null;
  note?: string | null;
  blocker?: string | null;
  seal?: boolean; // этап утверждения/ЭЦП — сигнальный цвет
}

type Detail = NonNullable<Awaited<ReturnType<typeof caseDetail>>>;

export function computeRoute(d: Detail, cycleId?: string | null): RouteStep[] {
  const cyc = d.cycles.find((c) => c.id === (cycleId ?? d.kase.currentCycleId)) ?? d.cycles[d.cycles.length - 1];
  const asg = [...d.assignments].reverse().find((a) => a.kind === "initial" && (!cyc || a.cycleId === cyc.id || d.cycles.length === 1));
  const drafts = d.documents.filter((x) => x.d.category === "draft" && (!cyc || x.d.cycleId === cyc.id || x.d.cycleId === null));
  const card = d.cards.find((c) => c.cycleId === cyc?.id);
  const pdfVer = card ? d.documents.find((x) => x.v.id === card.documentVersionId)?.v : undefined;
  const sign = [...d.signs].reverse().find((s) => s.documentVersionId === card?.documentVersionId);
  const pkg = [...d.outgoings].reverse().find((o) => o.kind === "rka_package" && o.cycleId === cyc?.id);
  const t = cyc?.tally as { outcome: DecisionOutcome; participated: number; composition: number; quorumReached: boolean } | null;

  const steps: RouteStep[] = [];
  const push = (s: RouteStep) => steps.push(s);

  push({
    key: "intake",
    title: cyc?.supplementary ? `Дополнения РКА, цикл ${cyc.number}` : "Письмо РКА зарегистрировано",
    status: d.completeness.complete ? "done" : "blocked",
    at: d.kase.receivedAt,
    note: d.kase.rkaNumber ? `№ ${d.kase.rkaNumber}` : null,
    blocker: d.completeness.complete ? null : "Не все вложения сохранены и проверены — передача исполнителю заблокирована",
  });

  const accessOk = asg && asg.accessResult && (asg.accessResult as { workspace?: boolean }).workspace;
  push({
    key: "assign",
    title: "Исполнитель назначен, рабочий доступ выдан",
    status: asg ? (asg.state === "access_error" ? "blocked" : accessOk ? "done" : "current") : d.completeness.complete ? "current" : "pending",
    at: asg?.assignedAt,
    note: asg ? d.users.find((u) => u.id === asg.executorId)?.fullName : null,
    blocker: asg?.state === "access_error" ? "Проверка прав не пройдена" : null,
  });

  const sentStates = ["sent", "receipt_confirmed", "in_work", "draft_submitted", "on_rework", "done"];
  push({
    key: "letter",
    title: "Поручение утверждено и отправлено",
    status: !asg ? "pending" : sentStates.includes(asg.state) ? "done" : asg.state === "sending" ? "current" : asg.state === "text_on_approval" ? "current" : "pending",
    at: asg?.sentAt,
    note: asg && !sentStates.includes(asg.state) ? (asg.state === "text_on_approval" ? "Черновик ждёт утверждения председателем — письмо не отправлено" : asg.state === "sending" ? "Отправляется" : null) : null,
    seal: true,
  });

  push({
    key: "draft",
    title: "Проект заключения получен",
    status: drafts.length ? "done" : asg && sentStates.includes(asg.state) ? "current" : "pending",
    at: drafts[0]?.v.createdAt,
    note: drafts.length ? `${drafts.length} ${drafts.length === 1 ? "версия" : "версии"}` : null,
  });

  push({
    key: "preapprove",
    title: "Предварительно одобрен председателем",
    status: cyc?.preapprovedAt ? "done" : drafts.length ? "current" : "pending",
    at: cyc?.preapprovedAt,
    seal: true,
  });

  push({
    key: "vote",
    title: "Обсуждение и голосование",
    status: cyc?.state === "voting" ? "current" : cyc?.closedAt ? "done" : cyc?.preapprovedAt ? "current" : "pending",
    at: cyc?.openedAt,
    note: cyc?.state === "voting" ? `Открыто до ${cyc.closesAt ? new Date(cyc.closesAt).toLocaleString("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "short", timeStyle: "short" }) : "—"}` : null,
  });

  push({
    key: "protocol",
    title: "Протокол",
    status: cyc?.protocolHash ? (t?.outcome === "accepted" ? "done" : "blocked") : "pending",
    at: cyc?.closedAt,
    note: t ? `${OUTCOME_LABEL[t.outcome]}; участвовали ${t.participated} из ${t.composition}` : null,
    blocker: t && t.outcome !== "accepted" ? (t.outcome === "undetermined" ? "Правило определения решения не зафиксировано — укажите его по Положению" : OUTCOME_LABEL[t.outcome]) : null,
  });

  push({
    key: "final",
    title: cyc?.finalRoute === "as_is" ? "Проект принят без изменений" : cyc?.finalRoute === "rework" ? "Окончательная редакция после доработки" : "Финал: без изменений или доработка",
    status: cyc?.finalRoute === "as_is" || (cyc?.finalRoute === "rework" && cyc.finalVersionId && cyc.finalVersionId !== cyc.draftVersionId) ? "done" : cyc?.protocolHash && t?.outcome === "accepted" ? "current" : "pending",
    at: cyc?.finalRoute === "rework" ? cyc.finalReceivedAt : null,
    note: cyc?.finalRoute === "rework" && !cyc.finalReceivedAt ? "Ожидается окончательная редакция от исполнителя" : null,
  });

  push({
    key: "approve",
    title: "Утверждено председателем",
    status: cyc?.approvedAt ? "done" : cyc?.finalVersionId && cyc.finalRoute ? "current" : "pending",
    at: cyc?.approvedAt,
    note: cyc?.conclusionNumber ? `Заключение № ${cyc.conclusionNumber}` : null,
    seal: true,
  });

  push({
    key: "pdf",
    title: "PDF с постоянным QR подготовлен",
    status: pdfVer ? "done" : cyc?.approvedAt ? "current" : "pending",
    at: pdfVer?.createdAt,
  });

  const signState = sign?.state;
  push({
    key: "sign",
    title: "Личная ЭЦП председателя",
    status: pdfVer?.state === "signed" && signState === "verified" ? "done" : signState && ["auth_required", "needs_reconcile", "error", "expired", "refused"].includes(signState) ? "blocked" : pdfVer ? "current" : "pending",
    at: sign?.receivedAt,
    note:
      signState === "signature_saved" || signState === "registered"
        ? "Подпись получена и сохранена, проверка не завершена"
        : signState === "verified"
          ? "Подпись проверена"
          : signState === "waiting"
            ? "Ожидание подписи в eGov Mobile"
            : null,
    blocker:
      signState === "auth_required"
        ? "Регистрация в SIGEX требует авторизации — подпись сохранена, повторно подписывать не нужно"
        : signState === "needs_reconcile"
          ? "Нужна сверка с поставщиком подписи"
          : signState === "expired"
            ? "Сеанс подписания истёк — начните новый"
            : signState === "refused"
              ? "Подписание отклонено в eGov"
              : null,
    seal: true,
  });

  push({
    key: "package",
    title: "Сопроводительное и комплект согласованы",
    status: pkg ? (["approved", "sending", "sent", "unknown_result"].includes(pkg.state) ? "done" : pkg.state === "draft" ? "current" : pkg.state === "approval_stale" ? "blocked" : "current") : signState === "verified" ? "current" : "pending",
    at: pkg?.createdAt,
    note: pkg ? `Исх. № ${pkg.numberDisplay}${pkg.state === "draft" ? " — ждёт согласия председателя" : ""}` : null,
    blocker: pkg?.state === "approval_stale" ? "Комплект изменился после согласия — нужно повторное согласование" : null,
    seal: true,
  });

  push({
    key: "sent",
    title: "Направлено в РКА",
    status: pkg?.state === "sent" ? "done" : pkg?.state === "bounced" ? "blocked" : pkg?.state === "unknown_result" ? "blocked" : pkg && ["approved", "sending"].includes(pkg.state) ? "current" : "pending",
    at: pkg?.sentAt,
    note: pkg?.state === "sent" ? "Отправка подтверждена провайдером" : null,
    blocker: pkg?.state === "unknown_result" ? "Результат отправки неизвестен — идёт сверка отправленных, повторной отправки не будет" : pkg?.state === "bounced" ? "Возврат письма" : null,
  });

  // Первый невыполненный этап — текущий; последующие «current» понижаются до pending.
  let seenCurrent = false;
  for (const s of steps) {
    if (s.status === "current" || s.status === "blocked") {
      if (seenCurrent && s.status === "current") s.status = "pending";
      seenCurrent = true;
    }
  }
  return steps;
}
