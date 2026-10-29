import type { Metadata } from "next";
import { Emblem } from "@/components/shell";
import { legacyVoteInfo } from "@/server/legacy/vote";
import { VoteClient } from "./vote-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata: Metadata = {
  title: "Голосование Комиссии РКА",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const fmt = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null;

/** Персональная форма голосования по старому методу на домене платформы (без входа). */
export default async function LegacyVotePage({ params }: { params: Promise<{ round: string; token: string }> }) {
  const { round, token } = await params;
  const info = await legacyVoteInfo(decodeURIComponent(round), decodeURIComponent(token));

  return (
    <main className="min-h-dvh bg-paper px-4 py-8">
      <div className="mx-auto w-full max-w-[520px]">
        <div className="mb-6 flex items-center gap-3">
          <Emblem className="size-10" />
          <div>
            <p className="font-serif text-[18px] leading-tight text-ink">Голосование Комиссии РКА</p>
            <p className="text-[12.5px] text-ink-3">Комиссия по защите профессиональных прав адвокатов</p>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          {!info.ok ? (
            <p className="text-[15px] text-ink-2">{info.error}</p>
          ) : (
            <>
              <p className="text-[13px] uppercase tracking-wide text-ink-3">Обращение №{info.n}</p>
              <h1 className="mt-1 text-[19px] font-semibold leading-snug text-ink">Заключение Комиссии по обращению адвоката {info.name.replace(/\.+$/, "")}.</h1>
              {info.executor && <p className="mt-1 text-[14px] text-ink-2">Исполнитель — {info.executor}</p>}
              <p className="mt-4 text-[14.5px] text-ink-2">
                Голосует: <b className="text-ink">{info.voter}</b>
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <a href={info.doc} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center justify-center rounded-lg border border-petrol text-[15px] font-medium text-petrol">
                  Открыть заключение
                </a>
                <a href={info.folder} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center justify-center rounded-lg border border-line-strong text-[15px] text-ink">
                  Материалы обращения
                </a>
              </div>
              <p className="mt-4 text-[13px] text-ink-3">
                {info.end ? `Голосование открыто до ${fmt(info.end)} (время Алматы).` : "Срок: 24 часа после открытия."}
                {info.preview ? " Предварительный просмотр: голос не записывается." : " Ссылка персональная — не пересылайте её другим."}
              </p>
              <div className="mt-5 border-t border-line pt-5">
                <VoteClient round={info.round} token={decodeURIComponent(token)} open={info.open} voted={info.voted} preview={info.preview} />
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
