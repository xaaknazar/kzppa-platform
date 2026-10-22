import { requireUser } from "@/server/auth";
import { can } from "@/domain/acl";
import { Notice, PageHeader } from "@/components/ui";
import { ImportForm } from "./import-form";

export const metadata = { title: "Загрузка состава" };

export default async function ImportPage() {
  const u = await requireUser();
  if (!can(u.principal, "admin.members")) return <Notice tone="warn" title="Раздел доступен председателю и техническому администратору" />;
  return (
    <>
      <PageHeader title="Загрузка состава комиссии" lead="Скопируйте строки из таблицы Excel или Google Sheets и вставьте сюда. Платформа покажет, что получилось, до сохранения." />
      <ImportForm />
    </>
  );
}
