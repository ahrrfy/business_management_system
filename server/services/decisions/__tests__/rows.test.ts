/**
 * المحوِّلاتُ النقيّة لصندوق القرار — بلا قاعدة (مُسجَّلة في `vitest.unit.config.ts`).
 *
 * تقيس ثلاثةً يقيناً: أنّ الصفّ يُبنى من مدخل المصدر بافتراضاتٍ صريحة، وأنّ النتيجة لا تكون
 * «نجاحاً» على `STALE`/`PENDING`، وأنّ بوّابة المصدر تُقيَّم بمفردات الصلاحيات نفسها.
 */
import { describe, expect, it } from "vitest";
import { gatePasses, serviceActor } from "../gate";
import { buildRow, decisionKeyFor, isoOf, itemLabel, moneyText, outcomeFor, statusOf } from "../rows";
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
