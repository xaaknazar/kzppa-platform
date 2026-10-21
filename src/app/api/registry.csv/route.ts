import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { getSessionUser, isStaff } from "@/server/auth";
import { audit } from "@/server/audit";
import { env } from "@/server/env";
import { buildRegistry, registryToCsv } from "@/server/services/registry";

export const dynamic = "force-dynamic";

/**
 * Выгрузка реестра в CSV (раздел 25, AUD-05). Только председатель и секретарь.
 * Факт выгрузки фиксируется в журнале операций (UI-05: экспорт требует права и аудита).
 */
export async function GET() {
  const u = await getSessionUser();
  if (!u) return new NextResponse("Требуется вход", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!isStaff(u)) {
    await db.transaction((tx) =>
      audit(tx, { orgId: u.orgId, actor: { id: u.id, type: "user", label: u.fullName, role: u.orgRoles.join(",") }, action: "registry.export", objectType: "registry", result: "denied" }),
    );
    return new NextResponse("Выгрузка реестра доступна председателю и секретарю", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const rows = await buildRegistry(u.orgId, { appUrl: env.appUrl });
  const csv = registryToCsv(rows);
  const cutoff = new Date();
  // Дата среза — по часовому поясу организации (UI-06).
  const day = cutoff.toLocaleDateString("sv-SE", { timeZone: "Asia/Almaty" });
  const filename = `registry-${day}.csv`;

  await db.transaction((tx) =>
    audit(tx, {
      orgId: u.orgId,
      actor: { id: u.id, type: "user", label: u.fullName, role: u.orgRoles.join(",") },
      action: "registry.export",
      objectType: "registry",
      after: { format: "csv", rows: rows.length, cutoff: cutoff.toISOString(), filename },
    }),
  );

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
