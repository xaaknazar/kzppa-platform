import { describe, expect, it } from "vitest";
import { formatOutgoing, formatOutgoingFull, nextRepeatIndex, normalizeRkaNumber, parseOutgoing } from "@/domain/numbering";
import { tally, type QuorumRule, type DecisionRule } from "@/domain/quorum";
import { matchCase, parseSubject, surnameStem, type CaseIndexEntry } from "@/domain/matching";
import { summarizeManifest, excludeItem, classifyIntegrity, type ManifestItem } from "@/domain/manifest";
import { assignmentHash, checkApproval } from "@/domain/approval";
import { packageHash } from "@/domain/hash";
import { detectLanguage } from "@/domain/language";
import { assertTransition, OUTGOING, ASSIGNMENT, TransitionError } from "@/domain/states";
import { can, diffPermissions, type Principal } from "@/domain/acl";

const members = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);
const Q30: QuorumRule = { kind: "min_participants", min: 16, composition: 30 };
const D: DecisionRule = { kind: "for_more_than_half_of_participants", source: "тест" };

describe("DOC-08 / DEC-01 нумерация (AT-37)", () => {
  it("001 → 001/01 → 001/02; 002 → 002/01", () => {
    expect(formatOutgoing({ caseNumber: 1, repeatIndex: 0 })).toBe("001");
    expect(formatOutgoing({ caseNumber: 1, repeatIndex: 1 })).toBe("001/01");
    expect(formatOutgoing({ caseNumber: 1, repeatIndex: 2 })).toBe("001/02");
    expect(formatOutgoing({ caseNumber: 2, repeatIndex: 0 })).toBe("002");
    expect(formatOutgoing({ caseNumber: 2, repeatIndex: 1 })).toBe("002/01");
  });
  it("индекс растёт по выданным номерам, не переиспользуется", () => {
    expect(nextRepeatIndex([])).toBe(0);
    expect(nextRepeatIndex([0])).toBe(1);
    expect(nextRepeatIndex([0, 1, 2])).toBe(3);
  });
  it("исторический 001/1 распознаётся как legacy и не переписывается", () => {
    expect(parseOutgoing("001/1")).toEqual({ caseNumber: 1, repeatIndex: 1, legacy: true });
    expect(parseOutgoing("КЗППА-2026/001/01")).toEqual({ caseNumber: 1, repeatIndex: 1, legacy: false });
  });
  it("префикс и год — настройки", () => {
    expect(formatOutgoingFull({ caseNumber: 1, repeatIndex: 1 }, { prefix: "КЗППА", year: 2026 })).toBe("КЗППА-2026/001/01");
  });
  it("номер РКА хранится отдельно: 04-01/1351 и 04-01-1351 равны", () => {
    expect(normalizeRkaNumber("исх. 04-01-1351 от 12.10")).toBe("04-01/1351");
    expect(normalizeRkaNumber("04-01/1351")).toBe("04-01/1351");
  });
});

describe("FLOW-06/07/12 кворум и протокол (AT-31, AT-32)", () => {
  it("AT-31: состав 30, за 23, против 0, воздерж. 1 → участвовали 24, не участвовали 6", () => {
    const m = members(30);
    const votes = [
      ...m.slice(0, 23).map((id) => ({ memberId: id, choice: "for" as const })),
      { memberId: m[23], choice: "abstain" as const },
    ];
    const t = tally({ eligibleMemberIds: m, votes, quorumRule: Q30, decisionRule: D });
    expect(t).toMatchObject({ composition: 30, participated: 24, for: 23, against: 0, abstain: 1, notParticipated: 6, quorumReached: true, arithmeticOk: true, outcome: "accepted" });
  });
  it("AT-32: 15 — нет кворума, 16 и 17 — есть; воздержавшиеся считаются", () => {
    const m = members(30);
    const mk = (n: number) => m.slice(0, n).map((id, i) => ({ memberId: id, choice: i % 2 ? ("abstain" as const) : ("for" as const) }));
    expect(tally({ eligibleMemberIds: m, votes: mk(15), quorumRule: Q30, decisionRule: D }).outcome).toBe("no_quorum");
    expect(tally({ eligibleMemberIds: m, votes: mk(16), quorumRule: Q30, decisionRule: D }).quorumReached).toBe(true);
    expect(tally({ eligibleMemberIds: m, votes: mk(17), quorumRule: Q30, decisionRule: D }).quorumReached).toBe(true);
  });
  it("правило большинства неизвестно → решение не определено (FLOW-12)", () => {
    const m = members(30);
    const votes = m.slice(0, 20).map((id) => ({ memberId: id, choice: "for" as const }));
    expect(tally({ eligibleMemberIds: m, votes, quorumRule: Q30, decisionRule: { kind: "unknown" } }).outcome).toBe("undetermined");
  });
  it("порог 16 не переносится молча на другой состав (FLOW-13)", () => {
    const t = tally({ eligibleMemberIds: members(28), votes: [], quorumRule: Q30, decisionRule: D });
    expect(t.outcome).toBe("undetermined");
    expect(t.errors.join()).toMatch(/состав 28/);
  });
  it("голос не входящего в снимок и повторный голос не учитываются", () => {
    const m = members(30);
    const t = tally({ eligibleMemberIds: m, votes: [{ memberId: "m1", choice: "for" }, { memberId: "m1", choice: "against" }, { memberId: "x", choice: "for" }], quorumRule: Q30, decisionRule: D });
    expect(t.participated).toBe(1);
    expect(t.errors).toHaveLength(2);
  });
});

describe("CASE-02/03 сопоставление (AT-04, AT-05, AT-06)", () => {
  const cases: CaseIndexEntry[] = [
    { caseId: "c1", caseNumber: 1, rkaNumber: "04-01/1351", applicantFullName: "Жубатова Айгерим Сериковна", applicantAliases: [] },
    { caseId: "c2", caseNumber: 2, rkaNumber: "04-01/1402", applicantFullName: "Рамазанов Ерлан", applicantAliases: [] },
    { caseId: "c3", caseNumber: 3, rkaNumber: "04-01/1410", applicantFullName: "Рамазанова Динара", applicantAliases: [] },
  ];
  const base = { fromEmail: "office@advokatura.kz", officialRkaSender: "office@advokatura.kz", cases };

  it("падежи и казахские буквы дают общий стем", () => {
    expect(surnameStem("Жубатовой")).toBe("жубатов");
    expect(surnameStem("Жубатову")).toBe("жубатов");
    expect(surnameStem("Жұбатова")).toBe("жубатов");
    expect(surnameStem("Жубатов")).toBe("жубатов");
  });
  it("AT-04: дополнения по Жубатовой с номером идут в существующее дело", () => {
    const p = parseSubject("04-01-1351 Дополнительные материалы по обращению Жубатовой А.С.");
    expect(p.kind).toBe("supplement");
    const r = matchCase({ ...base, parsed: p });
    expect(r).toMatchObject({ kind: "attach", caseId: "c1" });
  });
  it("AT-05: номер указывает на одно дело, фамилия — на другое → разбор", () => {
    const p = parseSubject("04-01/1351 обращение Рамазановой Д.");
    const r = matchCase({ ...base, parsed: p });
    expect(r.kind).toBe("needs_review");
  });
  it("однофамильцы без номера → разбор, не автоприобщение", () => {
    const p = parseSubject("Обращение Рамазанова");
    const r = matchCase({ ...base, parsed: p });
    expect(r.kind).toBe("needs_review");
  });
  it("новое обращение от РКА без совпадений → предложение нового дела", () => {
    const p = parseSubject("04-01/1500 Обращение адвоката Ахметова Б.К.");
    expect(matchCase({ ...base, parsed: p }).kind).toBe("new_case");
  });
  it("тема на казахском распознаётся", () => {
    expect(parseSubject("04-01/1500 Ахметовтың өтініші").kind).toBe("initial");
  });
});

describe("MAIL-06/08 манифест (AT-01, AT-03)", () => {
  const item = (i: number, status: ManifestItem["status"], sha = `h${i}`): ManifestItem => ({ partId: `${i}`, filename: `f${i}.pdf`, mimeType: "application/pdf", size: 10, sha256: sha, inline: false, status });
  it("AT-01: 14 вложений, загружено 3 → неполно, видны 11", () => {
    const items = [...Array.from({ length: 3 }, (_, i) => item(i, "verified")), ...Array.from({ length: 11 }, (_, i) => item(i + 3, "pending"))];
    const s = summarizeManifest(items);
    expect(s.complete).toBe(false);
    expect(s.missing).toHaveLength(11);
    expect(s.label).toContain("3 из 14");
  });
  it("AT-03: два одинаковых вложения — две позиции, один blob", () => {
    const s = summarizeManifest([item(1, "verified", "same"), item(2, "verified", "same")]);
    expect(s.declared).toBe(2);
    expect(s.verified).toBe(2);
    expect(s.uniqueBlobs).toBe(1);
    expect(s.complete).toBe(true);
  });
  it("inline-подписи не входят в обязательный состав; исключение требует основания", () => {
    const logo: ManifestItem = { ...item(9, "pending"), inline: true };
    expect(summarizeManifest([item(1, "verified"), logo]).complete).toBe(true);
    expect(() => excludeItem(item(2, "unavailable"), "u", "нет")).toThrow();
    const ex = excludeItem(item(2, "unavailable"), "u", "Ссылка РКА недоступна, подтверждено письмом");
    expect(summarizeManifest([item(1, "verified"), ex]).complete).toBe(true);
  });
  it("AT-02: загружено и удалено ≠ не загружалось", () => {
    expect(classifyIntegrity({ expectedSha256: "a", uploadEvent: true, deleteEvent: true, present: false })).toBe("uploaded_then_deleted");
    expect(classifyIntegrity({ expectedSha256: "a", uploadEvent: false, deleteEvent: false, present: false })).toBe("never_uploaded");
    expect(classifyIntegrity({ expectedSha256: "a", uploadEvent: null, deleteEvent: null, present: false })).toBe("insufficient_data");
  });
});

describe("BR-04/OUT-04 согласие привязано к версии (AT-17, AT-29)", () => {
  it("изменение адресата аннулирует согласие поручения", async () => {
    const s = { to: "a@x.kz", lang: "ru" as const, subject: "s", bodyText: "t", deadline: "2026-11-01", workspaceLink: "l", materialVersionIds: ["v1"] };
    const h = await assignmentHash(s);
    const approval = { approvedHash: h, approvedBy: "chair", approvedAt: "now" };
    expect(checkApproval(approval, h).ok).toBe(true);
    expect(checkApproval(approval, await assignmentHash({ ...s, to: "b@x.kz" }))).toMatchObject({ ok: false, reason: "stale" });
    expect(checkApproval(null, h)).toMatchObject({ ok: false, reason: "not_approved" });
  });
  it("замена одного файла меняет хеш пакета", async () => {
    const p = { from: "k@g", to: ["office@advokatura.kz"], cc: [], bcc: [], subject: "s", bodyText: "b", outgoingNumber: "001", outgoingDate: "2026-10-21", files: [{ name: "a.pdf", size: 1, sha256: "x", versionId: "v1" }] };
    const h1 = await packageHash(p);
    expect(await packageHash({ ...p, to: ["OFFICE@advokatura.kz"] })).toBe(h1);
    expect(await packageHash({ ...p, files: [{ ...p.files[0], sha256: "y" }] })).not.toBe(h1);
  });
});

describe("DOC-01 язык (AT-27, AT-38)", () => {
  it("казахский текст → kk", () => {
    expect(detectLanguage("Құрметті әріптестер! Адвокаттың кәсіби құқықтарын қорғау туралы өтініш бойынша материалдарды жолдаймыз және қарауды сұраймыз. Бұл іс бойынша").lang).toBe("kk");
  });
  it("русский текст → ru", () => {
    expect(detectLanguage("Прошу рассмотреть обращение адвоката о нарушении профессиональных прав в ходе следственных действий по уголовному делу").lang).toBe("ru");
  });
});

describe("Состояния (раздел 13)", () => {
  it("отправленное нельзя вернуть в черновик; неизвестный результат не превращается в отправлено без сверки", () => {
    expect(() => assertTransition(OUTGOING, "outgoing", "sent", "draft")).toThrow(TransitionError);
    expect(() => assertTransition(OUTGOING, "outgoing", "sending", "approved")).toThrow();
  });
  it("AT-45: доступ выдан, но без утверждения текста отправка невозможна", () => {
    expect(() => assertTransition(ASSIGNMENT, "assignment", "access_verified", "sending")).toThrow();
  });
});

describe("ACL (AT-07, AT-09)", () => {
  const exec: Principal = { userId: "e", orgRoles: ["member"], caseRoles: [{ caseId: "c1", role: "executor", active: true }] };
  it("исполнитель видит рабочую область своего дела, но не корень и не другие дела", () => {
    expect(can(exec, "case.read_workspace", { caseId: "c1" })).toBe(true);
    expect(can(exec, "case.read_root", { caseId: "c1" })).toBe(false);
    expect(can(exec, "case.read_workspace", { caseId: "c2" })).toBe(false);
    expect(can(exec, "case.assign_executor", { caseId: "c1" })).toBe(false);
  });
  it("AT-08: публичное разрешение — нарушение", () => {
    const d = diffPermissions([{ email: "e@x", role: "reader", area: "executor_workspace" }], [{ email: null, type: "anyone", role: "reader", inherited: true }], ["chair@x"]);
    expect(d.ok).toBe(false);
    expect(d.violations.join()).toMatch(/Публичный/);
  });
});

describe("DEC-02: п. 20 Положения — большинство присутствующих, решающий голос председателя", () => {
  const m = Array.from({ length: 30 }, (_, i) => `m${i + 1}`);
  const rule = { kind: "for_more_than_half_of_participants" as const, source: "п. 20 Положения", chairCastingVote: true };
  const Q = { kind: "min_participants" as const, min: 16, composition: 30 };
  const votes = (forN: number, againstN: number, abstainN: number, chairChoice?: "for" | "against") => {
    const list: { memberId: string; choice: "for" | "against" | "abstain" }[] = [];
    let i = 1; // m1 — председатель
    if (chairChoice) list.push({ memberId: "m1", choice: chairChoice });
    const push = (n: number, c: "for" | "against" | "abstain") => { for (let k = 0; k < n; k++) list.push({ memberId: m[i++], choice: c }); };
    push(forN - (chairChoice === "for" ? 1 : 0), "for");
    push(againstN - (chairChoice === "against" ? 1 : 0), "against");
    push(abstainN, "abstain");
    return list;
  };
  it("9 за / 9 против, председатель «за» → принято решающим голосом", () => {
    const t = tally({ eligibleMemberIds: m, votes: votes(9, 9, 0, "for"), quorumRule: Q, decisionRule: rule, chairMemberId: "m1" });
    expect(t).toMatchObject({ outcome: "accepted", castingVoteApplied: true });
  });
  it("9 за / 9 против, председатель «против» → не принято", () => {
    expect(tally({ eligibleMemberIds: m, votes: votes(9, 9, 0, "against"), quorumRule: Q, decisionRule: rule, chairMemberId: "m1" }).outcome).toBe("rejected");
  });
  it("без правила решающего голоса равенство не даёт решения", () => {
    expect(tally({ eligibleMemberIds: m, votes: votes(9, 9, 0, "for"), quorumRule: Q, decisionRule: { ...rule, chairCastingVote: false }, chairMemberId: "m1" }).outcome).toBe("rejected");
  });
  it("большинство присутствующих: 12 за из 22 → принято; 11 за из 22 при 11 воздерж. → не принято", () => {
    expect(tally({ eligibleMemberIds: m, votes: votes(12, 5, 5), quorumRule: Q, decisionRule: rule, chairMemberId: "m1" }).outcome).toBe("accepted");
    expect(tally({ eligibleMemberIds: m, votes: votes(11, 0, 11), quorumRule: Q, decisionRule: rule, chairMemberId: "m1" }).outcome).toBe("rejected");
  });
});

import { parseRoster } from "@/domain/roster-import";
describe("Импорт состава", () => {
  it("таблица из Excel: заголовок, табуляция, роли, повтор адреса", () => {
    const rows = parseRoster("ФИО\tПочта\tКоллегия\tРоль\nТулегенов Артур Куанышевич\tA.Tulegenov@mail.kz\tМангистауская ОКА\tпредседатель\nШерубаев Руслан Айтказыевич\tsher@mail.kz\tВКО ОКА\tсекретарь\nИванов Иван\tsher@mail.kz\t\t");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ fullName: "Тулегенов Артур Куанышевич", firstName: "Артур", patronymic: "Куанышевич", email: "a.tulegenov@mail.kz", roles: ["member", "chair"] });
    expect(rows[1].roles).toContain("secretary");
    expect(rows[2].errors.join()).toMatch(/повторяется/);
  });
});
