"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import * as cases from "@/server/services/cases";
import * as asg from "@/server/services/assignments";
import * as cyc from "@/server/services/cycles";
import * as out from "@/server/services/outgoing";
import type { Lang, VoteChoice } from "@/domain/types";

/**
 * Серверные действия интерфейса. Каждое — тонкая обёртка над командой сервиса:
 * права, идемпотентность, версия и аудит проверяются в сервисе (ARCH-05).
 */

export type ActionResult<T = unknown> = { ok: true; data?: T; replayed?: boolean } | { ok: false; error: string };

function done<T>(r: { ok: true; data: T; replayed: boolean } | { ok: false; error: string }, ...paths: string[]): ActionResult<T> {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/", "layout");
  return r.ok ? { ok: true, data: r.data, replayed: r.replayed } : { ok: false, error: r.error };
}

export async function registerCaseAction(input: { messageId: string; applicant: string; rkaNumber?: string; rkaDate?: string; collegium?: string; summary?: string; lang?: Lang | null; idempotencyKey: string }) {
  const u = await requireUser();
  const r = await cases.registerCase(u, input);
  return done(r, "/inbox", "/registry");
}

export async function attachMessageAction(input: { messageId: string; caseId: string; basis: string; idempotencyKey: string }) {
  const u = await requireUser();
  return done(await cases.attachManually(u, input), "/inbox", `/cases/${input.caseId}`);
}

export async function updateCaseFieldsAction(input: Parameters<typeof cases.updateCaseFields>[1]) {
  const u = await requireUser();
  return done(await cases.updateCaseFields(u, input), `/cases/${input.caseId}`, "/registry");
}

export async function excludeAttachmentAction(input: { attachmentId: string; basis: string; caseId?: string }) {
  const u = await requireUser();
  return done(await cases.excludeAttachment(u, input), "/inbox", input.caseId ? `/cases/${input.caseId}` : "/inbox");
}

export async function assignExecutorAction(input: Parameters<typeof asg.assignExecutor>[1]) {
  const u = await requireUser();
  return done(await asg.assignExecutor(u, input), `/cases/${input.caseId}`);
}

export async function editAssignmentLetterAction(input: Parameters<typeof asg.editAssignmentLetter>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await asg.editAssignmentLetter(u, input), `/cases/${input.caseId}`, "/approvals");
}

export async function approveAssignmentAction(input: { assignmentId: string; shownHash: string; idempotencyKey: string; caseId: string }) {
  const u = await requireUser();
  return done(await asg.approveAndSendAssignment(u, input), `/cases/${input.caseId}`, "/approvals");
}

export async function rejectAssignmentAction(input: { assignmentId: string; reason: string; caseId: string }) {
  const u = await requireUser();
  return done(await asg.rejectAssignmentLetter(u, input), `/cases/${input.caseId}`, "/approvals");
}

export async function resubmitAssignmentAction(input: { assignmentId: string; caseId: string }) {
  const u = await requireUser();
  return done(await asg.resubmitAssignment(u, input), `/cases/${input.caseId}`);
}

export async function extendDeadlineAction(input: { assignmentId: string; until: string; basis: string; caseId: string }) {
  const u = await requireUser();
  return done(await asg.extendDeadline(u, input), `/cases/${input.caseId}`);
}

export async function preapproveAction(input: Parameters<typeof cyc.preapproveDraft>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await cyc.preapproveDraft(u, input), `/cases/${input.caseId}`);
}

export async function openVotingAction(input: Parameters<typeof cyc.openVoting>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await cyc.openVoting(u, input), `/cases/${input.caseId}`, "/votes");
}

export async function castVoteAction(input: { cycleId: string; choice: VoteChoice; comment?: string; specialOpinion?: string; idempotencyKey: string }) {
  const u = await requireUser();
  return done(await cyc.castVote(u, input), `/votes/${input.cycleId}`, "/votes");
}

export async function closeVotingAction(input: Parameters<typeof cyc.closeVoting>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await cyc.closeVoting(u, input), `/cases/${input.caseId}`, "/votes");
}

export async function chooseFinalRouteAction(input: Parameters<typeof cyc.chooseFinalRoute>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await cyc.chooseFinalRoute(u, input), `/cases/${input.caseId}`);
}

export async function approveFinalAction(input: Parameters<typeof cyc.approveFinal>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await cyc.approveFinal(u, input), `/cases/${input.caseId}`);
}

export async function preparePdfAction(input: Parameters<typeof cyc.prepareSignablePdf>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await cyc.prepareSignablePdf(u, input), `/cases/${input.caseId}`);
}

export async function prepareRkaPackageAction(input: Parameters<typeof out.prepareRkaPackage>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await out.prepareRkaPackage(u, input), `/cases/${input.caseId}`, "/approvals", "/outgoing");
}

export async function updatePackageFilesAction(input: Parameters<typeof out.updatePackageFiles>[1] & { caseId: string }) {
  const u = await requireUser();
  return done(await out.updatePackageFiles(u, input), `/cases/${input.caseId}`, "/approvals");
}

export async function approvePackageAction(input: { outgoingId: string; shownHash: string; idempotencyKey: string; caseId: string }) {
  const u = await requireUser();
  return done(await out.approveAndSendPackage(u, input), `/cases/${input.caseId}`, "/approvals", "/outgoing");
}

export async function rejectPackageAction(input: { outgoingId: string; reason: string; caseId: string }) {
  const u = await requireUser();
  return done(await out.rejectPackage(u, input), `/cases/${input.caseId}`, "/approvals");
}

export async function resolveUnknownSendAction(input: { outgoingId: string; decision: "resend" | "confirm_sent"; basis: string; caseId: string }) {
  const u = await requireUser();
  return done(await out.resolveUnknownSend(u, input), `/cases/${input.caseId}`, "/outgoing");
}
