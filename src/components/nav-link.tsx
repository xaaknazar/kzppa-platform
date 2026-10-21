"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

export function NavLink({ href, children, count }: { href: string; children: React.ReactNode; count: number | null }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-[14px] transition-colors",
        active ? "bg-petrol-50 font-medium text-petrol" : "text-ink-2 hover:bg-sunken hover:text-ink",
      )}
    >
      <span>{children}</span>
      {count ? <span className={clsx("rounded px-1.5 text-[12px] tnum", active ? "bg-petrol text-white" : "bg-sunken text-ink-2")}>{count}</span> : null}
    </Link>
  );
}
