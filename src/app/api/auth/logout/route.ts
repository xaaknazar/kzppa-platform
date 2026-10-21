import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, schema } from "@/db/client";
import { DEMO_COOKIE, supabaseServer } from "@/server/auth";
import { isDemoAuth } from "@/server/env";

export async function POST(req: Request) {
  if (isDemoAuth()) {
    const store = await cookies();
    const sid = store.get(DEMO_COOKIE)?.value;
    if (sid) await db.delete(schema.sessions).where(eq(schema.sessions.id, sid));
    store.delete(DEMO_COOKIE);
  } else {
    const supa = await supabaseServer();
    await supa.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
