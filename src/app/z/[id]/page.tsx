import type { Metadata } from "next";
import { Emblem } from "@/components/shell";
import { legacyCard } from "@/server/legacy/vote";

export const revalidate = 300;
export const maxDuration = 60;
export const metadata: Metadata = {
  title: "Заключение Комиссии РКА",
  robots: { index: false, follow: false },
};

/** Строки карточки, которые не показываются на публичной странице (служебные ссылки на Google Диск). */
const HIDDEN = /^(Электронное дело|Заключение PDF)\s*:/;

/** Карточка утверждённого заключения — сюда ведёт QR-код в заключении. */
export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await legacyCard(decodeURIComponent(id));

  const lines = card.ok ? card.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const title = lines[0] ?? "";
  const rows: { k?: string; v: string }[] = [];
  for (const l of lines.slice(1)) {
    if (HIDDEN.test(l)) continue;
    const i = l.indexOf(": ");
    if (i > 0 && i < 40) rows.push({ k: l.slice(0, i), v: l.slice(i + 2) });
    else rows.push({ v: l });
  }
  const note = rows.filter((r) => !r.k && /QR-код/.test(r.v));
  const body = rows.filter((r) => !note.includes(r));

  return (
    <main className="min-h-dvh bg-paper px-4 py-8">
      <div className="mx-auto w-full max-w-[640px]">
        <div className="mb-6 flex items-center gap-3">
          <Emblem className="size-10" />
          <div>
            <p className="font-serif text-[18px] leading-tight text-ink">Комиссия РКА по защите профессиональных прав адвокатов</p>
            <p className="text-[12.5px] text-ink-3">Республиканская коллегия адвокатов</p>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {!card.ok ? (
            <p className="text-[15px] text-ink-2">{card.error}</p>
          ) : (
            <>
              <p className="text-[13px] uppercase tracking-wide text-ink-3">Информационная карточка</p>
              <h1 className="mt-1 text-[20px] font-semibold leading-snug text-ink">{title.replace(/^КЗППА РКА\.\s*/, "")}</h1>
              <dl className="mt-5 divide-y divide-line border-y border-line">
                {body.map((r, i) =>
                  r.k ? (
                    <div key={i} className="grid gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
                      <dt className="text-[13px] text-ink-3">{r.k}</dt>
                      <dd className={/SHA-256/.test(r.k) ? "break-all font-mono text-[12px] text-ink-2" : "text-[14.5px] text-ink"}>{r.v}</dd>
                    </div>
                  ) : (
                    <p key={i} className="py-3 text-[14.5px] text-ink">{r.v}</p>
                  ),
                )}
              </dl>
              {note.map((r, i) => (
                <p key={i} className="mt-4 text-[12.5px] text-ink-3">{r.v}</p>
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
