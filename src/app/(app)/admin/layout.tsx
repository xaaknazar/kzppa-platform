import { requireUser } from "@/server/auth";
import { can } from "@/domain/acl";
import { Notice } from "@/components/ui";
import { AdminNav } from "./settings-form";

export const metadata = { title: "Администрирование" };

/** UI-07: администрирование доступно председателю и техническому администратору. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  if (!can(u.principal, "admin.settings")) {
    return (
      <div className="max-w-[640px] pt-4">
        <Notice tone="warn" title="Нет доступа к администрированию">
          Раздел доступен председателю комиссии и техническому администратору. Если вам нужны эти права, обратитесь к председателю.
        </Notice>
      </div>
    );
  }
  return (
    <>
      <header className="mb-6">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-ink">Администрирование</h1>
        <p className="mt-1.5 max-w-[68ch] text-[14px] text-ink-3">Изменения записываются в журнал операций с прежним и новым значением.</p>
        <div className="mt-4">
          <AdminNav />
        </div>
      </header>
      {children}
    </>
  );
}
