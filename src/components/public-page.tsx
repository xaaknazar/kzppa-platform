import Link from "next/link";
import { Emblem } from "./shell";

/** Публичная информационная страница (без входа): о платформе, конфиденциальность, условия. */
export function PublicPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[760px] px-4 py-10 sm:px-6">
      <Link href="/about" className="mb-8 flex items-center gap-3">
        <Emblem className="size-10" />
        <span className="leading-tight">
          <span className="block font-serif text-[18px] text-ink">КЗППА РКА</span>
          <span className="block text-[12px] text-ink-3">Платформа Комиссии по защите профессиональных прав адвокатов</span>
        </span>
      </Link>
      <h1 className="font-serif text-[28px] leading-tight text-ink">{title}</h1>
      <p className="mt-1 text-[13px] text-ink-3">Редакция от {updated}</p>
      <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-ink-2 [&_h2]:mt-8 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_a]:text-petrol [&_a]:underline">{children}</div>
      <nav className="mt-12 flex flex-wrap gap-4 border-t border-line pt-5 text-[13px]">
        <Link href="/about" className="text-petrol hover:underline">О платформе</Link>
        <Link href="/privacy" className="text-petrol hover:underline">Конфиденциальность</Link>
        <Link href="/terms" className="text-petrol hover:underline">Условия использования</Link>
        <Link href="/login" className="text-petrol hover:underline">Вход для участников</Link>
      </nav>
    </main>
  );
}
