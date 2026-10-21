import { AppShell } from "@/components/shell";
import { requireUser } from "@/server/auth";
import { navCounts } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const counts = await navCounts(user);
  return (
    <AppShell user={user} counts={counts}>
      {children}
    </AppShell>
  );
}
