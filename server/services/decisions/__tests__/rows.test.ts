/**
 * المحوِّلاتُ النقيّة لصندوق القرار — بلا قاعدة (مُسجَّلة في `vitest.unit.config.ts`).
 *
 * تقيس ثلاثةً يقيناً: أنّ الصفّ يُبنى من مدخل المصدر بافتراضاتٍ صريحة، وأنّ النتيجة لا تكون
 * «نجاحاً» على `STALE`/`PENDING`، وأنّ بوّابة المصدر تُقيَّم بمفردات الصلاحيات نفسها.
 */
import { describe, expect, it } from "vitest";
import { gatePasses, scopedBranchIdFor, serviceActor } from "../gate";
import { assertActionSupported, buildRow, decisionKeyFor, isoOf, itemLabel, moneyText, outcomeFor, pickApproveVariant, statusOf } from "../rows";
import { serviceBranchScopedIds } from "../sources/branchScope";
import type { DecisionActor } from "../types";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function actor(over: Partial<DecisionActor> = {}): DecisionActor {
  return { userId: 7, branchId: 1, role: "manager", isOwner: false, permissionsOverride: null, crossBranch: false, ...over };
}

describe("buildRow — الصف يعرض ما يقرر عليه", () => {
  it("يشتق العمر والـSLA والرابط من السجل ويملأ الافتراضات صراحة", () => {
    const row = buildRow(
      {
        kind: "purchase.order.control",
        id: 42,
        title: "اعتماد المراجعة · امر شراء PO-1",
        requestedAt: new Date("2026-09-04T12:00:00.000Z"),
        party: " مورد الورق ",
        amount: 1250000,
        currency: "USD",
        summaryItems: [{ label: "ورق A4", qty: "10.000", unit: "كرتون", unitPrice: "3.4566" }],
        hrefId: 99,
        trigger: null,
      },
      NOW,
    );
    expect(row.ageHours).toBe(24);
    expect(row.sla).toEqual({ hours: 48, remainingHours: 24, breached: false });
    expect(row.href).toBe("/purchases/99");
    expect(row.party).toBe("مورد الورق");
    expect(row.amount).toBe("1250000");
    expect(row.currency).toBe("USD");
    expect(row.allowedActions).toEqual(["APPROVE", "REJECT"]);
    expect(row.rejectReason).toBe("REQUIRED");
    expect(row.approveReason).toBe("OPTIONAL");
    expect(row.summaryItems[0]?.unitPrice).toBe("3.4566");
  });

  it("خروج المال يقصر السقف الى 24 ساعة ويعلن التأخر", () => {
    const row = buildRow(
      { kind: "expense.approve", id: 1, title: "مصروف", requestedAt: new Date("2026-09-03T00:00:00.000Z"), trigger: "MONEY_OUT" },
      NOW,
    );
    expect(row.sla?.hours).toBe(24);
    expect(row.sla?.breached).toBe(true);
    expect(row.sla?.remainingHours).toBeLessThan(0);
  });

  it("يرفض نوعا غير مسجل — صف لقرار لا وجود له", () => {
    expect(() => buildRow({ kind: "لا.وجود.له", id: 1, title: "x", requestedAt: NOW }, NOW)).toThrow(/not registered/);
  });

  it("تاريخ غائب او فاسد لا يسقط الصف — يعامل كاقدم ما يكون", () => {
    const row = buildRow({ kind: "hr.leave.decide", id: 1, title: "اجازة", requestedAt: null }, NOW);
    expect(row.requestedAt).toBe(new Date(0).toISOString());
    expect(row.sla?.breached).toBe(true);
  });
});

describe("النتيجة المهيكلة — لا نجاح على STALE", () => {
  it("STALE من الخدمة تبقى STALE مهما كان الفعل", () => {
    expect(outcomeFor("APPROVE", "STALE")).toBe("STALE");
    expect(outcomeFor("REJECT", "stale")).toBe("STALE");
  });
  it("الاعتماد الذي يترك الطلب معلقا = REQUESTED لا EXECUTED", () => {
    expect(outcomeFor("APPROVE", "PENDING")).toBe("REQUESTED");
    expect(outcomeFor("APPROVE", "PENDING_APPROVAL")).toBe("REQUESTED");
    expect(outcomeFor("APPROVE", "APPROVED")).toBe("EXECUTED");
    expect(outcomeFor("APPROVE", null)).toBe("EXECUTED");
  });
  it("الرفض والسحب", () => {
    expect(outcomeFor("REJECT", "REJECTED")).toBe("REJECTED");
    expect(outcomeFor("WITHDRAW", "WITHDRAWN")).toBe("WITHDRAWN");
  });
  it("statusOf يقرا الاشكال الشائعة لنتائج الخدمات", () => {
    expect(statusOf({ status: "APPROVED" })).toBe("APPROVED");
    expect(statusOf({ request: { status: "STALE" } })).toBe("STALE");
    expect(statusOf({ ok: true })).toBeNull();
    expect(statusOf(null)).toBeNull();
  });
});

describe("gatePasses — مرآة بوابة الاجراء الاصلي", () => {
  it("MODULE: مدير مشتريات يعبر، وكاشير لا يعبر، وغير العابر بلا فرع لا يعبر", () => {
    const gate = { type: "MODULE", moduleKey: "purchases", roles: ["manager", "purchasing"] } as const;
    expect(gatePasses(gate, actor({ role: "manager" }))).toBe(true);
    expect(gatePasses(gate, actor({ role: "cashier" }))).toBe(false);
    expect(gatePasses(gate, actor({ role: "manager", branchId: null }))).toBe(false);
    expect(gatePasses(gate, actor({ role: "admin", branchId: null, crossBranch: true }))).toBe(true);
  });
  it("OWNER: صفة المالك لا الدور", () => {
    expect(gatePasses({ type: "OWNER" }, actor({ role: "admin", isOwner: false }))).toBe(false);
    expect(gatePasses({ type: "OWNER" }, actor({ role: "admin", isOwner: true, crossBranch: true }))).toBe(true);
  });
  it("REPORTS_ADMIN: admin وحده", () => {
    expect(gatePasses({ type: "REPORTS_ADMIN" }, actor({ role: "manager" }))).toBe(false);
    expect(gatePasses({ type: "REPORTS_ADMIN" }, actor({ role: "admin", crossBranch: true }))).toBe(true);
  });
  it("serviceActor يمرر الفرع الغائب صفرا كما تفعل الراوترات", () => {
    expect(serviceActor(actor({ branchId: null, isOwner: true })).branchId).toBe(0);
    expect(serviceActor(actor()).isOwner).toBe(false);
  });

  // Codex على #1004 (P1): `MODULE_MAP` كان فحصَ صلاحيةٍ مجرّداً بينما الأصل `branchScopedProcedure`
  // يرفض غيرَ العابر بلا فرع — فكان hr:FULL بلا فرعٍ يبلغ `decideLeave` بلا قيد فرعٍ إطلاقاً.
  it("MODULE_MAP branchScoped: غير العابر بلا فرع لا يعبر، والعابر يعبر، والمجرد لا يشترط فرعا", () => {
    const scoped = { type: "MODULE_MAP", moduleKey: "hr", branchScoped: true } as const;
    expect(gatePasses(scoped, actor({ role: "manager", branchId: null }))).toBe(false);
    expect(gatePasses(scoped, actor({ role: "manager", branchId: 1 }))).toBe(true);
    expect(gatePasses(scoped, actor({ role: "admin", branchId: null, crossBranch: true }))).toBe(true);
    expect(gatePasses({ type: "MODULE_MAP", moduleKey: "hr" }, actor({ role: "manager", branchId: null }))).toBe(true);
    expect(gatePasses(scoped, actor({ role: "cashier", branchId: 1 }))).toBe(false);
  });

  it("scopedBranchIdFor مرآة branchScopedProcedure: null للعابر، فرع الفاعل لغيره، ورفض بلا فرع", () => {
    expect(scopedBranchIdFor(actor({ crossBranch: true, branchId: null }))).toBeNull();
    expect(scopedBranchIdFor(actor({ branchId: 3 }))).toBe(3);
    expect(() => scopedBranchIdFor(actor({ branchId: null }))).toThrow(/لا فرع مُسنَد لهذا المستخدم/);
  });
});

describe("assertActionSupported — لا فعل غير معلن يبلغ الحسم", () => {
  const input = { kind: "gifts.request.approve", id: 9, action: "REJECT", clientRequestId: "req-1" } as const;
  it("الرفض على مصدر يعتمد فقط يرفض برسالة تسمي المدعوم وتقود الى الشاشة", () => {
    let message = "";
    try {
      assertActionSupported({ supportedActions: ["APPROVE"] }, input, "الهدية (رقم 9)");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/لا يدعم فعل «رفض»/);
    expect(message).toMatch(/المدعوم هنا: اعتماد/);
    expect(message).toContain("/gifts");
  });
  it("الفعل المعلن يمر بصمت", () => {
    expect(() => assertActionSupported({ supportedActions: ["APPROVE", "REJECT"] }, input, "x")).not.toThrow();
    expect(() => assertActionSupported({ supportedActions: ["REJECT"] }, { ...input, action: "WITHDRAW" }, "x")).toThrow(/لا يدعم فعل «سحب الطلب»/);
  });
});

describe("pickApproveVariant — لا افتراض صامت لصيغة الاعتماد", () => {
  const variants = [
    { key: "APPROVE_RESOLVED", label: "حلت" },
    { key: "APPROVE_DISMISSED", label: "تصرف" },
  ] as const;
  it("بلا اختيار يرفض ويسمي الصيغ؛ والصيغة الغريبة ترفض؛ والصحيحة تعود", () => {
    expect(() => pickApproveVariant(variants, undefined, "القضية")).toThrow(/اختر صيغة الاعتماد صراحةً: حلت · تصرف/);
    expect(() => pickApproveVariant(variants, "BOGUS", "القضية")).toThrow(/ليست من الصيغ المتاحة/);
    expect(pickApproveVariant(variants, "APPROVE_DISMISSED", "القضية")).toBe("APPROVE_DISMISSED");
  });
  it("بلا صيغ معلنة = اعتماد واحد (null) والصف يحمل قائمة فارغة افتراضا", () => {
    expect(pickApproveVariant([], "anything", "x")).toBeNull();
    const row = buildRow({ kind: "purchase.integrity.resolution", id: 1, title: "قضية", requestedAt: NOW }, NOW);
    expect(row.approveVariants).toEqual([]);
    const withVariants = buildRow({ kind: "purchase.integrity.resolution", id: 1, title: "قضية", requestedAt: NOW, approveVariants: [...variants] }, NOW);
    expect(withVariants.approveVariants.map((v) => v.key)).toEqual(["APPROVE_RESOLVED", "APPROVE_DISMISSED"]);
  });
});

describe("serviceBranchScopedIds — فروع مصدر تقصر خدمته غير الادمن على فرعه", () => {
  it("الادمن يعدد كل فروع النطاق، والمرشح يقيده", () => {
    expect(serviceBranchScopedIds({ role: "admin", branchId: null }, null, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(serviceBranchScopedIds({ role: "admin", branchId: 1 }, [2], [1, 2, 3])).toEqual([2]);
  });
  it("غير الادمن فرعه وحده، ولا شيء بلا فرع او خارج فرعه", () => {
    expect(serviceBranchScopedIds({ role: "manager", branchId: 1 }, null, [1, 2])).toEqual([1]);
    expect(serviceBranchScopedIds({ role: "manager", branchId: 1 }, [2], [1, 2])).toEqual([]);
    expect(serviceBranchScopedIds({ role: "manager", branchId: 1 }, [1], [1, 2])).toEqual([1]);
    expect(serviceBranchScopedIds({ role: "accountant", branchId: null }, null, [1, 2])).toEqual([]);
  });
});

describe("ادوات صغيرة", () => {
  it("moneyText يمرر النص كما هو ولا يحول المال رقما", () => {
    expect(moneyText("1450.99")).toBe("1450.99");
    expect(moneyText(12)).toBe("12");
    expect(moneyText("")).toBeNull();
    expect(moneyText(null)).toBeNull();
  });
  it("decisionKeyFor مشتق من مفتاح النقرة وضمن 120 محرفا", () => {
    expect(decisionKeyFor("abc")).toBe("inbox:abc");
    expect(decisionKeyFor("x".repeat(200)).length).toBe(120);
  });
  it("itemLabel يسقط الفراغات و isoOf يتحمل النص", () => {
    expect(itemLabel(["ورق", null, " ", "A4"])).toBe("ورق · A4");
    expect(isoOf("2026-09-01T00:00:00.000Z")).toBe("2026-09-01T00:00:00.000Z");
  });
});
