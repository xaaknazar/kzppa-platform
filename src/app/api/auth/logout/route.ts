import { NextResponse } from "next/server";
import { destroySession, supabaseServer } from "@/server/auth";
import { env } from "@/server/env";

export async function POST(req: Request) {
  await destroySession();
  if (env.authMode === "supabase") {
    const supa = await supabaseServer();
    await supa.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
