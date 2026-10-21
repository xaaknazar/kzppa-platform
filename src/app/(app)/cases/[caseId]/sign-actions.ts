"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import * as signing from "@/server/services/signing";

/** SIGN-01..03: личное подписание председателем через eGov Mobile/Business. */
export async function startSigningAction(input: { documentVersionId: string; idempotencyKey: string; caseId: string }) {
  const u = await requireUser();
  const r = await signing.startSigning(u, { documentVersionId: input.documentVersionId, idempotencyKey: input.idempotencyKey });
  revalidatePath(`/cases/${input.caseId}`);
  return r.ok ? { ok: true as const, data: r.data } : { ok: false as const, error: r.error };
}

export async function signingStatusAction(input: { sessionId: string }) {
  const u = await requireUser();
  const r = await signing.getSigningStatus(u, input.sessionId);
  return r;
}

export async function resumeSigningAction(input: { sessionId: string; caseId: string }) {
  const u = await requireUser();
  const r = await signing.resumeSigning(u, input.sessionId);
  revalidatePath(`/cases/${input.caseId}`);
  return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
}
