import Link from "next/link";
import clsx from "clsx";
import { can } from "@/domain/acl";
import type { SessionUser } from "@/server/auth";
import { ROLE_LABEL } from "@/server/auth";
import { integrationModes } from "@/server/env";
import { NavLink } from "./nav-link";

interface NavItem {
  href: string;
  label: string;
  show: (u: SessionUser) => boolean;
  count?: number | null;
}

export function Emblem({ className }: { className?: string }) {
  // Монограмма комиссии: щит и раскрытая книга закона. Без государственной символики.
  return (
    <svg viewBox="0 0 40 40" className={clsx("shrink-0", className)} aria-hidden>
      <path d="M20 3 34 8v11c0 9-6.2 15.4-14 18-7.8-2.6-14-9-14-18V8l14-5Z" fill="var(--color-petrol)" />
      <path d="M11.5 15.5c3-1 5.8-.6 8.5 1 2.7-1.6 5.5-2 8.5-1v12c-3-1-5.8-.6-8.5 1-2.7-1.6-5.5-2-8.5-1v-12Z" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M20 16.5v12" stroke="#fff" strokeWidth="1.6" />
      <circle cx="20" cy="10.5" r="1.6" fill="var(--color-seal)" />
    </svg>
  );
}

export function AppShell({ user, counts, children }: { user: SessionUser; counts: Record<string, number>; children: React.ReactNode }) {
  const p = user.principal;
  const staff = (u: SessionUser) => u.orgRoles.includes("chair") || u.orgRoles.includes("secretary");
  const items: NavItem[] = [
    { href: "/", label: "Главная", show: () => true },
    { href: "/inbox", label: "Разбор почты", show: staff, count: counts.inbox },
    { href: "/registry", label: "Реестр обращений", show: staff },
    { href: "/my", label: "Мои поручения", show: (u) => u.principal.caseRoles.some((c) => c.role === "executor"), count: counts.my },
    { href: "/votes", label: "Голосования", show: (u) => u.orgRoles.includes("member") || staff(u), count: counts.votes },
    { href: "/approvals", label: "На утверждение", show: (u) => u.orgRoles.includes("chair"), count: counts.approvals },
    { href: "/outgoing", label: "Исходящие", show: staff },
    { href: "/reports", label: "Отчёты", show: staff },
    { href: "/audit", label: "Журнал операций", show: (u) => can(u.principal, "audit.read") },
    { href: "/admin", label: "Администрирование", show: (u) => can(u.principal, "admin.settings") },
  ];
  const modes = integrationModes();
  const testMode = modes.mail === "dry-run" || modes.sign === "dry-run";
  void p;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col">
          <Link href="/" className="flex items-center gap-3 px-5 py-5">
            <Emblem className="size-9" />
            <span className="leading-tight">
              <span className="block font-serif text-[17px] text-ink">КЗППА РКА</span>
              <span className="block text-[11.5px] text-ink-3">Защита профессиональных прав адвокатов</span>
            </span>
          </Link>
          <nav aria-label="Основная навигация" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {items
              .filter((i) => i.show(user))
              .map((i) => (
                <NavLink key={i.href} href={i.href} count={i.count ?? null}>
                  {i.label}
                </NavLink>
              ))}
          </nav>
          <div className="hidden border-t border-line px-5 py-4 lg:block">
            <p className="text-[13.5px] font-medium text-ink">{user.fullName}</p>
            <p className="text-[12px] text-ink-3">{user.orgRoles.map((r) => ROLE_LABEL[r]).join(", ") || "Нет ролей"}</p>
            <form action="/api/auth/logout" method="post" className="mt-2">
              <button className="text-[12.5px] text-petrol hover:underline">Выйти</button>
            </form>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        {testMode && (
          <div className="border-b border-warn/25 bg-warn-50 px-6 py-2 text-[13px] text-warn">
            Тестовый режим: {modes.mail === "dry-run" && "письма не уходят наружу"}
            {modes.mail === "dry-run" && modes.sign === "dry-run" && ", "}
            {modes.sign === "dry-run" && "подписи не имеют юридической силы"}. Боевые подключения включаются в администрировании.
          </div>
        )}
        <main className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
