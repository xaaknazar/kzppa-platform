import { describe, expect, it } from "vitest";
import { matchCase, parseCaseNumberRef, parseSubject, type CaseIndexEntry } from "@/domain/matching";
import { nextInRotation } from "@/domain/rotation";
import { assignmentLetter } from "@/domain/templates";
import { isChairApproved, signatureMode } from "@/domain/policies";

const cases: CaseIndexEntry[] = [
  { caseId: "c8", caseNumber: 8, rkaNumber: "04-01/1393", applicantFullName: "Утепов Радмир Маратович", applicantAliases: [], executorEmail: "dt.khabiev.04@gmail.com" },
  { caseId: "c9", caseNumber: 9, rkaNumber: "04-01/1462", applicantFullName: "Жуаспаева Гульнар Рымгалиевна", applicantAliases: [], executorEmail: "abdulin.olzhas85@gmail.com" },
];
const base = { fromEmail: "abdulin.olzhas85@gmail.com", officialRkaSender: "office@advokatura.kz", cases };

describe("номер обращения в теме", () => {
  it("разбирает «обращение № 9» и казахский вариант, но не номер письма РКА", () => {
    expect(parseCaseNumberRef("Проект заключения — обращение № 9")).toBe(9);
    expect(parseCaseNumberRef("Re: Поручение Комиссии РКА — обращение № 9")).toBe(9);
    expect(parseCaseNumberRef("Проект заключения по обращению №009")).toBe(9);
    expect(parseCaseNumberRef("Қорытынды жобасы — № 9 өтініш")).toBe(9);
    expect(parseCaseNumberRef("04-01-1462 от 09.11.2026г. КЗППА, обращение адвоката Жуаспаевой Г.Р.")).toBeNull();
    expect(parseCaseNumberRef("обращение № 04-01/1462")).toBeNull();
  });
  it("проект от исполнителя с номером обращения приобщается к его делу автоматически", () => {
    const r = matchCase({ ...base, parsed: parseSubject("Проект заключения — обращение № 9") });
    expect(r).toMatchObject({ kind: "attach", caseId: "c9" });
  });
  it("тот же номер от постороннего — только кандидат для разбора", () => {
    const r = matchCase({ ...base, fromEmail: "someone@mail.ru", parsed: parseSubject("Проект заключения — обращение № 9") });
    expect(r.kind).toBe("needs_review");
  });
  it("исполнитель указал номер чужого дела — не приобщается", () => {
    const r = matchCase({ ...base, parsed: parseSubject("Проект заключения — обращение № 8") });
    expect(r.kind).toBe("needs_review");
  });
});

describe("распределение по очереди", () => {
  const q = [
    { id: "a", fullName: "Абдулин Олжас" },
    { id: "b", fullName: "Абикенова Толганай" },
    { id: "h", fullName: "Хабиев Дархан" },
  ];
  it("следующий за последним исполнителем, по кругу", () => {
    expect(nextInRotation(q, null)?.id).toBe("a");
    expect(nextInRotation(q, { id: "a", fullName: "Абдулин Олжас" })?.id).toBe("b");
    expect(nextInRotation(q, { id: "h", fullName: "Хабиев Дархан" })?.id).toBe("a");
  });
  it("последний исполнитель выбыл из очереди — следующий по алфавиту после него", () => {
    expect(nextInRotation(q, { id: "x", fullName: "Мусин Салимжан" })?.id).toBe("h");
    expect(nextInRotation([], null)).toBeNull();
  });
});

describe("поручение в формате Комиссии", () => {
  const d = {
    addressee: { firstName: "Олжас", patronymic: "Зейнулаевич" },
    caseNumber: "009",
    applicant: "адвокат Жуаспаева Гульнар Рымгалиевна (Коллегия адвокатов области Абай)",
    rkaNumber: "04-01/1462",
    rkaDate: "09.11.2026",
    receivedAt: "10.11.2026",
    summary: "—",
    subject: "изучить материалы",
    deadline: "17.11.2026",
    workspaceLink: "https://kzppa-platform.vercel.app/w/x",
    replyTo: "kzppa.rka@gmail.com",
    chairFullName: "Тулегенов Артур Куанышевич",
    commissionName: "Комиссия по защите профессиональных прав адвокатов РКА",
  };
  it("тема и просьба указать номер обращения в ответе", () => {
    const l = assignmentLetter("ru", d);
    expect(l.subject).toBe("Поручение Комиссии РКА — обращение № 9");
    expect(l.text).toContain("Уважаемый Олжас Зейнулаевич!");
    expect(l.text).toContain("Регистрационный №: 9");
    expect(l.text).toContain("Срок рассмотрения: 17.11.2026");
    expect(l.text).toContain("«Проект заключения — обращение № 9»");
    expect(l.text).not.toContain("Обстоятельства: —");
    const kk = assignmentLetter("kk", d);
    expect(kk.subject).toBe("РАА Комиссиясының тапсырмасы — № 9 өтініш");
    expect(parseCaseNumberRef("Re: " + kk.subject)).toBe(9);
    expect(parseCaseNumberRef("Re: " + l.subject)).toBe(9);
  });
});

describe("окончательность без ЭЦП", () => {
  it("политика и состояние карточки", () => {
    expect(signatureMode({ signature: "chair_approval" })).toBe("chair_approval");
    expect(signatureMode({})).toBe("eds");
    expect(signatureMode(null)).toBe("eds");
    expect(isChairApproved({ state: "chair_approved" })).toBe(true);
    expect(isChairApproved({ state: "not_signed" })).toBe(false);
  });
});
