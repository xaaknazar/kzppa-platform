import { describe, expect, it } from "vitest";
import { collegiumNominative, extractCollegiumCandidates, machineSummary } from "@/domain/extract";

describe("CASE-07: машинные проекты D и F", () => {
  const body =
    "Уважаемые коллеги!\n\nНаправляем обращение адвоката Восточно-Казахстанской областной коллегии адвокатов Рамазановой Динары Ериковны о вызове адвоката на допрос в качестве свидетеля. Просим рассмотреть.\n\nРеспубликанская коллегия адвокатов\nг. Астана";
  it("коллегия извлекается целиком и в именительном падеже; город подписи РКА не берётся", () => {
    expect(extractCollegiumCandidates(body)).toEqual(["Восточно-Казахстанская областная коллегия адвокатов"]);
    expect(collegiumNominative("Алматинской городской коллегии адвокатов")).toBe("Алматинская городская коллегия адвокатов");
    expect(extractCollegiumCandidates("Обращение адвоката коллегии адвокатов города Астаны Иванова.")).toEqual(["Коллегия адвокатов города Астаны"]);
  });
  it("краткое содержание без приветствия и «Просим рассмотреть»", () => {
    const s = machineSummary(body)!;
    expect(s.startsWith("Обращение адвоката")).toBe(true);
    expect(s).not.toMatch(/Уважаемые|Просим/);
  });
});
