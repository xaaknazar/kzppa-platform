import "server-only";
import { env } from "@/server/env";
import type { SignAdapter } from "./types";
import { DryRunSignAdapter } from "./dry-run";
import { SigexAdapter } from "./sigex";

/** ARCH-02, ARCH-07: адаптер подписи по SIGN_PROVIDER (sigex | dry-run). */
let cached: { mode: string; adapter: SignAdapter } | null = null;

export function getSignAdapter(): SignAdapter {
  if (cached?.mode === env.signProvider) return cached.adapter;
  const adapter: SignAdapter = env.signProvider === "sigex" ? new SigexAdapter() : new DryRunSignAdapter();
  cached = { mode: env.signProvider, adapter };
  return adapter;
}

export { AuthRequiredError } from "./types";
export type { SignAdapter } from "./types";
