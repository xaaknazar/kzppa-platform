import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/* ───────────── Кнопки ───────────── */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "seal";

const variants: Record<Variant, string> = {
  primary: "bg-petrol text-white hover:bg-petrol-600 active:bg-petrol-700 disabled:bg-ink-4",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken disabled:text-ink-4",
  ghost: "text-petrol hover:bg-petrol-50 disabled:text-ink-4",
  danger: "bg-surface text-bad border border-bad/40 hover:bg-bad-50",
  seal: "bg-seal text-white hover:brightness-95 disabled:bg-ink-4",
};

export function Button({ variant = "primary", size = "md", className, ...p }: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...p}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-[14px]",
        variants[variant],
        className,
      )}
    />
  );
}

export function LinkButton({ variant = "secondary", size = "md", className, ...p }: ComponentProps<typeof Link> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <Link
      {...p}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-[14px]",
        variants[variant],
        className,
      )}
    />
  );
}

/* ───────────── Статусы ───────────── */

export type Tone = "neutral" | "info" | "ok" | "warn" | "bad" | "seal" | "petrol";

const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-2 ring-line",
  info: "bg-info-50 text-info ring-info/20",
  ok: "bg-ok-50 text-ok ring-ok/20",
  warn: "bg-warn-50 text-warn ring-warn/25",
  bad: "bg-bad-50 text-bad ring-bad/20",
  seal: "bg-seal-50 text-seal ring-seal/30",
  petrol: "bg-petrol-50 text-petrol ring-petrol/20",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral" }: { tone?: Tone }) {
  const c: Record<Tone, string> = { neutral: "bg-ink-4", info: "bg-info", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", seal: "bg-seal", petrol: "bg-petrol" };
  return <span aria-hidden className={clsx("inline-block size-2 shrink-0 rounded-full", c[tone])} />;
}

/* ───────────── Раскладка ───────────── */

export function PageHeader({ title, lead, actions, serif }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; serif?: boolean }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div className="min-w-0">
        <h1 className={clsx("text-[26px] leading-tight text-ink", serif ? "font-serif" : "font-semibold tracking-[-0.01em]")}>{title}</h1>
        {lead && <p className="mt-1.5 max-w-[68ch] text-[14px] text-ink-3">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-lg border border-line bg-surface", className)}>
      {(title || aside) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
          {aside}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-8">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {children && <div className="max-w-[60ch] text-[14px] text-ink-3">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Сообщение-блокировка: что мешает перейти к следующему этапу и что сделать. */
export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "ok" | "seal"; title: ReactNode; children?: ReactNode }) {
  const bar: Record<string, string> = { info: "border-l-info", warn: "border-l-warn", bad: "border-l-bad", ok: "border-l-ok", seal: "border-l-seal" };
  return (
    <div role={tone === "bad" ? "alert" : undefined} className={clsx("rounded-md border border-line border-l-[3px] bg-surface px-4 py-3", bar[tone])}>
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-[13.5px] text-ink-2">{children}</div>}
    </div>
  );
}

/* ───────────── Формы ───────────── */

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[12.5px] text-ink-3">{hint}</span>}
      {error && <span className="mt-1 block text-[12.5px] text-bad">{error}</span>}
    </label>
  );
}

const inputBase = "w-full rounded-md border border-line-strong bg-surface px-3 text-[14px] text-ink placeholder:text-ink-4 focus:border-petrol focus:outline-none focus:ring-2 focus:ring-petrol/15 disabled:bg-sunken";

export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={clsx(inputBase, "h-10", p.className)} />;
}
export function Textarea(p: ComponentProps<"textarea">) {
  return <textarea {...p} className={clsx(inputBase, "py-2 leading-relaxed", p.className)} />;
}
export function Select(p: ComponentProps<"select">) {
  return <select {...p} className={clsx(inputBase, "h-10 pr-8", p.className)} />;
}

/* ───────────── Данные ───────────── */

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx("grid gap-x-8 gap-y-3", cols === 1 ? "grid-cols-1" : cols === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12.5px] text-ink-3">{k}</dt>
          <dd className="mt-0.5 break-words text-[14px] text-ink">{v ?? <span className="text-ink-4">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Hash({ value, chars = 12 }: { value?: string | null; chars?: number }) {
  if (!value) return <span className="text-ink-4">—</span>;
  return (
    <code title={value} className="rounded bg-sunken px-1 py-0.5 font-mono text-[12px] text-ink-2">
      {value.slice(0, chars)}…
    </code>
  );
}

export function Tabs({ tabs, active, base }: { tabs: { key: string; label: string; count?: number | null }[]; active: string; base: string }) {
  return (
    <nav aria-label="Разделы" className="-mb-px flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`${base}${base.includes("?") ? "&" : "?"}tab=${t.key}`}
          aria-current={active === t.key ? "page" : undefined}
          className={clsx(
            "whitespace-nowrap border-b-2 px-3 py-2.5 text-[14px] transition-colors",
            active === t.key ? "border-petrol font-medium text-petrol" : "border-transparent text-ink-3 hover:text-ink",
          )}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 text-ink-4 tnum">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function fmtDate(x?: Date | string | null, withTime = false) {
  if (!x) return null;
  const v = typeof x === "string" ? new Date(x.length === 10 ? `${x}T00:00:00+05:00` : x) : x;
  return v.toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function fmtSize(n?: number | null) {
  if (n == null) return "—";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}
