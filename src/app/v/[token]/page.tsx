import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { getPublicQrCard } from "@/server/services/qr-card";
import { Emblem } from "@/components/shell";
import { Hash, Notice, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Проверка заключения",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

/** Ожидаемая форма данных карточки (DOC-06, DOC-11). Имена голосовавших сюда не входят. */
interface PublicQrCard {
  commissionName: string;
  commissionNameKk?: string | null;
  applicant: string;
  caseNumber: string;
  conclusionNumber: string;
  conclusionDate: string;
  executorFullName: string;
  chairFullName: string;
  approvedAt: string | Date | null;
  signature: { state: string; label?: string | null; checkedAt?: string | Date | null };
  vote: {
    composition: number;
    participated: number;
    for: number;
    against: number;
    abstain: number;
    notParticipated: number;
    quorumReached: boolean;
    outcomeLabel: string;
  };
  supplementary: boolean;
  manifestHash: string;
  pdfSha256?: string | null;
  matchesHash?: ((h: string) => boolean) | boolean;
  hashMatches?: ((h: string) => boolean) | boolean;
}

type SigTone = "ok" | "warn" | "neutral";

function signatureStatus(state: string): { tone: SigTone; ru: string; kk: string } {
  const s = state.toLowerCase();
  if (["verified", "valid", "ok", "signed_verified"].includes(s)) return { tone: "ok", ru: "ЭЦП проверена", kk: "ЭЦҚ тексерілді" };
  if (["unavailable", "check_unavailable", "error", "unknown", "needs_reconcile"].includes(s)) return { tone: "neutral", ru: "Проверка недоступна", kk: "Тексеру қолжетімсіз" };
  return { tone: "warn", ru: "Подпись ещё не подтверждена", kk: "Қолтаңба әлі расталмаған" };
}

function hashMatches(card: PublicQrCard, h: string): boolean {
  const check = card.matchesHash ?? card.hashMatches;
  if (typeof check === "function") return check(h);
  if (typeof check === "boolean") return check;
  const p = h.trim().toLowerCase();
  return p.length >= 8 && card.manifestHash.toLowerCase().startsWith(p);
}

/** Публичная карточка проверки заключения по постоянному QR (DOC-05, DOC-06, DOC-11). */
export default async function QrCardPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ h?: string | string[] }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const h = Array.isArray(sp.h) ? sp.h[0] : sp.h;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) notFound();
  const card = (await getPublicQrCard(token)) as unknown as PublicQrCard | null;
  if (!card) notFound();

  const mismatch = h != null && h !== "" && !hashMatches(card, h);
  const sig = signatureStatus(card.signature?.state ?? "");
  const v = card.vote;

  return (
    <main className="min-h-dvh bg-paper px-4 py-8 sm:py-12">
      <article className="mx-auto w-full max-w-[720px] rounded-lg border border-line-strong bg-surface" aria-labelledby="card-title">
        <header className="border-b border-line px-5 py-6 sm:px-8">
          <div className="flex items-start gap-4">
            <Emblem className="size-12" />
            <div className="min-w-0">
              <p className="font-serif text-[17px] leading-snug text-ink">{card.commissionName}</p>
              {card.commissionNameKk && (
                <p lang="kk" className="mt-0.5 font-serif text-[14px] leading-snug text-ink-3">
                  {card.commissionNameKk}
                </p>
              )}
            </div>
          </div>
          <h1 id="card-title" className="mt-6 text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            {card.supplementary ? "Дополнительное заключение" : "Заключение"} <span className="doc-number font-normal">№{card.conclusionNumber}</span>
          </h1>
          <p lang="kk" className="mt-0.5 text-[13.5px] text-ink-3">
            {card.supplementary ? "Қосымша қорытынды" : "Қорытынды"} <span className="doc-number">№{card.conclusionNumber}</span>
          </p>
          <p className="mt-2 text-[14px] text-ink-2 tnum">
            от {fmtDate(card.conclusionDate) ?? card.conclusionDate}
            <span lang="kk" className="text-ink-3"> / {fmtDate(card.conclusionDate) ?? card.conclusionDate} ж.</span>
          </p>
        </header>

        {mismatch && (
          <div className="border-b border-line px-5 py-4 sm:px-8">
            <Notice tone="bad" title="Код не соответствует этой карточке">
              Проверочный код в ссылке не совпадает с данными заключения. Возможно, ссылка изменена или относится к другой версии документа. Сверьте QR-код с бумажным экземпляром и обратитесь в комиссию.
              <span lang="kk" className="mt-1 block text-ink-3">
                Код осы карточкаға сәйкес келмейді.
              </span>
            </Notice>
          </div>
        )}

        <div className={clsx("border-b px-5 py-4 sm:px-8", sig.tone === "ok" ? "border-ok/20 bg-ok-50" : sig.tone === "warn" ? "border-warn/25 bg-warn-50" : "border-line bg-sunken")} role="status">
          <p className={clsx("text-[16px] font-semibold", sig.tone === "ok" ? "text-ok" : sig.tone === "warn" ? "text-warn" : "text-ink-2")}>{sig.ru}</p>
          <p lang="kk" className="text-[13px] text-ink-3">
            {sig.kk}
          </p>
          <p className="mt-1.5 text-[13px] text-ink-2 tnum">
            {card.signature?.checkedAt ? (
              <>
                Время проверки: {fmtDate(card.signature.checkedAt, true)} (Алматы)
                <span lang="kk" className="text-ink-3"> / Тексерілген уақыты</span>
              </>
            ) : sig.tone === "ok" ? null : (
              "Проверка подписи ещё не выполнялась."
            )}
          </p>
          {card.signature?.label && card.signature.label !== sig.ru && <p className="mt-1 text-[13px] text-ink-2">{card.signature.label}</p>}
        </div>

        <div className="px-5 py-6 sm:px-8">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Row ru="Заявитель" kk="Өтініш беруші" value={<span className="font-serif text-[16px]">{card.applicant}</span>} />
            <Row ru="Дело комиссии" kk="Комиссиядағы іс" value={<span className="doc-number text-[16px]">№{card.caseNumber}</span>} />
            <Row ru="Исполнитель" kk="Орындаушы" value={card.executorFullName} />
            <Row
              ru="Утвердил председатель"
              kk="Бекіткен төраға"
              value={
                <>
                  {card.chairFullName}
                  {card.approvedAt && <span className="block text-[13px] text-ink-3 tnum">Дата утверждения: {fmtDate(card.approvedAt, true)}</span>}
                </>
              }
            />
          </dl>

          <section className="mt-8 border-t border-line pt-6" aria-labelledby="vote-title">
            <h2 id="vote-title" className="text-[15px] font-semibold text-ink">
              Итог голосования
            </h2>
            <p lang="kk" className="text-[12.5px] text-ink-3">
              Дауыс беру қорытындысы
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Num ru="Состав" kk="Құрамы" n={v.composition} />
              <Num ru="Участвовали" kk="Қатысқандар" n={v.participated} />
              <Num ru="Не участвовали" kk="Қатыспағандар" n={v.notParticipated} />
              <Num ru="За" kk="Жақтап" n={v.for} />
              <Num ru="Против" kk="Қарсы" n={v.against} />
              <Num ru="Воздержались" kk="Қалыс қалғандар" n={v.abstain} />
            </dl>
            <dl className="mt-5 grid gap-x-8 gap-y-3 rounded-md bg-sunken px-4 py-3 sm:grid-cols-2">
              <Row ru="Кворум" kk="Кворум" value={v.quorumReached ? "Достигнут" : "Не достигнут"} />
              <Row ru="Решение" kk="Шешім" value={<span className="font-medium">{v.outcomeLabel}</span>} />
            </dl>
            <p className="mt-3 text-[12.5px] text-ink-3">Имена голосовавших и индивидуальные голоса не публикуются. Подробный протокол хранится в деле комиссии.</p>
          </section>
        </div>

        <footer className="border-t border-line px-5 py-5 sm:px-8">
          <dl className="space-y-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <dt className="text-ink-3">Хеш сведений карточки</dt>
              <dd>
                <Hash value={card.manifestHash} chars={24} />
              </dd>
            </div>
            {card.pdfSha256 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <dt className="text-ink-3">SHA-256 файла PDF</dt>
                <dd>
                  <Hash value={card.pdfSha256} chars={24} />
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
            Карточка подтверждает сведения только об этой версии заключения. Сравните SHA-256 полученного файла с указанным здесь: если значения различаются, это другой документ.
          </p>
          <p lang="kk" className="mt-1 text-[12.5px] leading-relaxed text-ink-4">
            Карточка қорытындының осы нұсқасына ғана қатысты. Алынған файлдың SHA-256 мәнін осында көрсетілгенмен салыстырыңыз.
          </p>
        </footer>
      </article>
    </main>
  );
}

function Row({ ru, kk, value }: { ru: string; kk: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-ink-3">
        {ru}
        <span lang="kk" className="text-ink-4">
          {" "}
          / {kk}
        </span>
      </dt>
      <dd className="mt-0.5 break-words text-[15px] text-ink">{value}</dd>
    </div>
  );
}

function Num({ ru, kk, n }: { ru: string; kk: string; n: number }) {
  return (
    <div>
      <dt className="text-[12.5px] text-ink-3">
        {ru}
        <span lang="kk" className="block text-[11.5px] text-ink-4">
          {kk}
        </span>
      </dt>
      <dd className="mt-0.5 text-[20px] text-ink tnum">{n}</dd>
    </div>
  );
}
