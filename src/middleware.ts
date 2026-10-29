import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Обновление сессии Supabase Auth в cookie (только при AUTH_MODE=supabase). */
export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Путь запроса — чтобы после входа вернуть участника на ту же страницу (ссылка из письма).
  const headers = new Headers(req.headers);
  headers.set("x-kzppa-path", req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers } });
  if (!url || !key || process.env.AUTH_MODE !== "supabase") return res;
  const supa = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => list.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
    },
  });
  await supa.auth.getUser();
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron|api/integrations/gmail/push|api/health|api/golos|v/|g/|setup|about|privacy|terms).*)"],
};
