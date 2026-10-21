import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth";
import { canDownloadVersion } from "@/server/queries";
import { readBlob } from "@/server/storage";
import { db } from "@/db/client";
import { audit } from "@/server/audit";

/**
 * Скачивание файла версии: права проверяются независимо от знания ID (SEC-03, AT-09).
 * Ответ для недоступного объекта не отличается от несуществующего (SEC-05).
 */
export async function GET(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const u = await getSessionUser();
  if (!u) return new NextResponse("Требуется вход", { status: 401 });
  const { versionId } = await params;
  const r = await canDownloadVersion(u, versionId);
  if (!r || !r.v.blobId) return new NextResponse("Не найдено", { status: 404 });
  const b = await readBlob(r.v.blobId);
  if (b.sha256 !== r.v.sha256) return new NextResponse("Целостность файла нарушена: хеш не совпал. Обратитесь к администратору.", { status: 409 });
  if (r.d.confidential) {
    await db.transaction((tx) => audit(tx, { orgId: u.orgId, actor: { id: u.id, type: "user", label: u.fullName }, action: "document.download", objectType: "document_version", objectId: versionId, caseId: r.d.caseId }));
  }
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  const name = r.v.filename ?? "document";
  return new NextResponse(b.bytes as BodyInit, {
    headers: {
      "content-type": b.mimeType ?? "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
