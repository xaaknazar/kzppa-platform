import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { formatBase } from "@/domain/numbering";
import { salutationRu } from "@/domain/templates";
import { getMailAdapter, getPrimaryAccount } from "@/integrations/mail";
import { MailAuthError } from "@/integrations/mail/types";
import { registerHandler, type OutboxRow } from "../outbox";
import { env } from "../env";

/**
 * FLOW-05, FLOW-13. Персональное приглашение к голосованию — письмо с почты комиссии.
 * Ссылка ведёт на страницу голосования, которая открывается только после входа участника:
 * пересланное письмо не даёт права голосовать (FLOW-06). Приглашение, доставка, открытие
 * и голос — разные события; молчание голосом не считается.
 * Заголовок X-KZPPA-Outgoing-Id = svc-vote-…: служебное письмо, входящий разбор его пропускает.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function fmtAlmaty(d: Date) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

async function inviteHandler(row: OutboxRow) {
  const invitationId = String((row.payload as Record<string, unknown>).invitationId ?? "");
  const inv = await db.query.voteInvitations.findFirst({ where: eq(schema.voteInvitations.id, invitationId) });
  if (!inv) return { status: "dead" as const, error: "Приглашение не найдено" };
  if (inv.sentAt) return { status: "done" as const, note: "уже отправлено" };

  const cycle = await db.query.cycles.findFirst({ where: eq(schema.cycles.id, inv.cycleId) });
  if (!cycle) return { status: "dead" as const, error: "Цикл не найден" };
  if (cycle.state !== "voting" || (cycle.closesAt && cycle.closesAt.getTime() < Date.now())) {
    await db.update(schema.voteInvitations).set({ deliveryState: "cancelled" }).where(eq(schema.voteInvitations.id, inv.id));
    return { status: "done" as const, note: "голосование уже закрыто — письмо не отправлялось" };
  }
  const [kase, member, org] = await Promise.all([
    db.query.cases.findFirst({ where: eq(schema.cases.id, cycle.caseId) }),
    db.query.users.findFirst({ where: eq(schema.users.id, inv.memberId) }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, inv.organizationId) }),
  ]);
  if (!kase || !member || !org) return { status: "dead" as const, error: "Нет данных дела, участника или организации" };

  const account = await getPrimaryAccount(org.id);
  if (!account) return { status: "retry" as const, error: "Почта комиссии не подключена", delayMs: 10 * 60_000 };
  const adapter = getMailAdapter();
  const outgoingId = `svc-vote-${inv.id}`;

  try {
    // Повтор после сбоя: сначала ищем уже отправленное письмо, чтобы не продублировать.
    let sent = row.attempts > 1 ? await adapter.reconcileSent(account.id, outgoingId) : null;
    if (!sent) {
      const caseNo = formatBase(kase.number);
      const link = `${env.appUrl}/votes/${cycle.id}?i=${inv.token}`;
      const name = [member.firstName, member.patronymic].filter(Boolean).join(" ") || member.fullName;
      const greet = `${salutationRu(member.patronymic)} ${name}!`;
      const until = cycle.closesAt ? fmtAlmaty(cycle.closesAt) : null;
      const lines = [
        greet,
        "",
        `Открыто обсуждение и голосование по обращению №${caseNo} (заявитель: ${kase.applicant}, цикл ${cycle.number}).`,
        kase.summary ? `Предмет: ${kase.summary}` : null,
        until ? `Голосование открыто до ${until} (время Алматы).` : null,
        "",
        `Проект заключения и материалы: ${link}`,
        "",
        "Для просмотра и голосования войдите на платформу по своему адресу электронной почты — код входа придёт отдельным письмом. Ссылка персональная: пересылать её не нужно, без вашего входа она не откроется.",
        "",
        `С уважением,\n${org.shortName}`,
      ].filter((l) => l !== null) as string[];
      const html = `<div style="font:15px/1.6 Arial,sans-serif;color:#17202b;max-width:560px">
<p>${esc(greet)}</p>
<p>Открыто обсуждение и голосование по обращению <b>№${esc(caseNo)}</b> (заявитель: ${esc(kase.applicant)}, цикл ${cycle.number}).</p>
${kase.summary ? `<p style="color:#3d4856">Предмет: ${esc(kase.summary)}</p>` : ""}
${until ? `<p>Голосование открыто до <b>${esc(until)}</b> (время Алматы).</p>` : ""}
<p style="margin:22px 0"><a href="${esc(link)}" style="background:#0f4c5c;color:#fff;text-decoration:none;padding:11px 18px;border-radius:6px;display:inline-block">Открыть проект и проголосовать</a></p>
<p style="font-size:13px;color:#66717f">Для просмотра и голосования войдите на платформу по своему адресу электронной почты — код входа придёт отдельным письмом. Ссылка персональная: без вашего входа она не откроется.</p>
<p>С уважением,<br>${esc(org.shortName)}</p></div>`;
      sent = await adapter.sendApprovedPackage(account.id, {
        from: org.officialSender,
        to: [member.email],
        cc: [],
        bcc: [],
        subject: `Голосование по обращению №${caseNo} — ${kase.applicant}`,
        text: lines.join("\n"),
        html,
        attachments: [],
        outgoingId,
      });
    }
    await db
      .update(schema.voteInvitations)
      .set({ sentAt: new Date(), deliveryState: "sent" })
      .where(and(eq(schema.voteInvitations.id, inv.id), isNull(schema.voteInvitations.sentAt)));
    return { status: "done" as const, note: `письмо ${sent.providerMessageId}` };
  } catch (e) {
    if (e instanceof MailAuthError) return { status: "retry" as const, error: e.message, delayMs: 30 * 60_000 };
    return { status: "retry" as const, error: (e as Error).message };
  }
}

export function registerVoteHandlers() {
  registerHandler("vote.invite", inviteHandler);
}
