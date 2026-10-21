import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { requireUser } from "@/server/auth";
import { activeCompositionCount } from "@/server/services/admin";
import { describeDecision, type DecisionRule, type QuorumRule } from "@/domain/quorum";
import { Notice } from "@/components/ui";
import { SettingsForm } from "./settings-form";

export const metadata = { title: "Общие настройки" };

export default async function AdminSettingsPage() {
  const u = await requireUser();
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, u.orgId) });
  if (!org) return <Notice tone="bad" title="Организация не найдена">Учётная запись не связана с организацией. Обратитесь к техническому администратору.</Notice>;
  const composition = await activeCompositionCount(u.orgId);
  const quorumRule = (org.quorumRule ?? { kind: "more_than_half_of_composition" }) as QuorumRule;
  const decisionRule = (org.decisionRule ?? { kind: "unknown" }) as DecisionRule;

  return (
    <div className="max-w-[880px] space-y-6">
      <div className="rounded-md bg-sunken px-4 py-3 text-[13.5px] text-ink-2">
        <p>
          Действующий состав: <span className="tnum font-medium text-ink">{composition}</span> членов комиссии.
        </p>
        <p className="mt-0.5">Текущее правило решения: {describeDecision(decisionRule)}.</p>
      </div>
      <SettingsForm
        composition={composition}
        initial={{
          name: org.name,
          nameKk: org.nameKk ?? "",
          shortName: org.shortName,
          officialSender: org.officialSender,
          rkaAddress: org.rkaAddress,
          rkaAddressee: org.rkaAddressee,
          outgoingPrefix: org.outgoingPrefix ?? "",
          outgoingYearInNumber: org.outgoingYearInNumber,
          quorumRule,
          decisionRule,
        }}
      />
    </div>
  );
}
