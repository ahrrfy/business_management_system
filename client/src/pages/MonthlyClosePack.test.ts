import { describe, expect, it } from "vitest";
import {
  currentBaghdadMonth,
  MONTHLY_CLOSE_EXPORT_COLUMNS,
  monthCloseApprovalDisabled,
  monthlyCloseExportMeta,
  monthlyCloseExportRows,
  monthCloseUsesYearEnd,
  monthlyAccountingBasisLabel,
  yearEndCloseHref,
  type ClosePack,
} from "./MonthlyClosePack";

const pack = {
  month: "2026-07",
  period: { from: "2026-07-01", to: "2026-07-31" },
  accountingBasis: "DOUBLE_ENTRY_ACTIVE",
  sales: {
    invoiceCount: 12,
    subtotal: "1234567.50",
    tax: "0.00",
    total: "1234567.50",
    returnedTotal: "2500.00",
    netAfterReturns: "1232067.50",
  },
  profit: {
    revenue: "1232067.50",
    cost: "700000.25",
    profit: "532067.25",
    grossProfit: "532067.25",
    totalExpenses: "120000.00",
    netProfit: "412067.25",
  },
  purchases: {
    orderCount: 3,
    total: "450000.00",
    paid: "300000.00",
    unpaid: "150000.00",
  },
  expenses: { total: "120000.00", topCategories: [] },
  treasury: { totalIn: "900000.00", totalOut: "340000.00", net: "560000.00" },
  receivablesSnapshot: { arTotal: "0.00", apTotal: "0.00" },
  workOrdersDelivered: 4,
} as ClosePack;

describe("MonthlyClosePack Excel contract", () => {
  it("يسلّم Excel قيماً رقمية حقيقية لا مبالغ منسّقة كنصوص", () => {
    const rows = monthlyCloseExportRows(pack, {
      ar: "765432.10",
      ap: "234567.90",
    });

    expect(rows).toHaveLength(18);
    expect(
      rows.every(
        (row) => typeof row.value === "number" && Number.isFinite(row.value),
      ),
    ).toBe(true);
    expect(
      rows.find((row) => row.section === "المبيعات (صافٍ قبل الضريبة)")?.value,
    ).toBe(1234567.5);
    expect(
      rows.find((row) => row.section === "عدد فواتير المبيعات")?.value,
    ).toBe(12);
    expect(rows.find((row) => row.section === "صافي الربح")?.value).toBe(412067.25);
    expect(MONTHLY_CLOSE_EXPORT_COLUMNS).toEqual([
      { key: "section", header: "البند" },
      { key: "value", header: "القيمة (IQD / عدد)", money: true },
    ]);
  });

  it("يثبت metadata الفترة والفرع والجاهزية والطلب ولقطة الذمم", () => {
    expect(
      monthlyCloseExportMeta(
        pack,
        "الفرع الرئيسي",
        "جاهز للإقفال",
        "بانتظار الاعتماد — الطلب #19",
      ),
    ).toEqual([
      { label: "الفترة", value: "2026-07-01 — 2026-07-31" },
      { label: "الفرع", value: "الفرع الرئيسي" },
      { label: "الجاهزية", value: "جاهز للإقفال" },
      { label: "طلب الإقفال", value: "بانتظار الاعتماد — الطلب #19" },
      { label: "الأساس المحاسبي", value: "الدفتر المزدوج المعتمد" },
      { label: "الذمم", value: "لقطة دفترية كما في 2026-07-31" },
    ]);
  });

  it("يميّز الأساس الرسمي عن التقرير التشغيلي المشتق", () => {
    expect(monthlyAccountingBasisLabel("DOUBLE_ENTRY_ACTIVE")).toBe("الدفتر المزدوج المعتمد");
    expect(monthlyAccountingBasisLabel("LEGACY_DERIVED")).toContain("OFF/SHADOW");
  });
});

describe("MonthlyClosePack Baghdad month", () => {
  it("ينتقل إلى الشهر الجديد عند منتصف ليل بغداد لا منتصف ليل UTC", () => {
    expect(currentBaghdadMonth(new Date("2026-08-31T20:59:59.999Z"))).toBe(
      "2026-08",
    );
    expect(currentBaghdadMonth(new Date("2026-08-31T21:00:00.000Z"))).toBe(
      "2026-09",
    );
  });
});

describe("MonthlyClosePack close action readiness", () => {
  it("يحجب اعتماد الطلب عند تحميل/فشل/حجب الجاهزية ولا يكتفي بحالة busy", () => {
    const base = {
      busy: false,
      readinessLoading: false,
      readinessError: false,
      readinessBlocked: false,
    };
    expect(monthCloseApprovalDisabled(base)).toBe(false);
    expect(
      monthCloseApprovalDisabled({ ...base, readinessLoading: true }),
    ).toBe(true);
    expect(monthCloseApprovalDisabled({ ...base, readinessError: true })).toBe(
      true,
    );
    expect(
      monthCloseApprovalDisabled({ ...base, readinessBlocked: true }),
    ).toBe(true);
    expect(
      monthCloseApprovalDisabled({ ...base, readinessBlocked: undefined }),
    ).toBe(true);
    expect(monthCloseApprovalDisabled({ ...base, routeLoading: true })).toBe(
      true,
    );
    expect(monthCloseApprovalDisabled({ ...base, routeError: true })).toBe(
      true,
    );
  });

  it("يحيل طلب ديسمبر إلى YearEnd حصراً عندما يكون الدفتر ACTIVE", () => {
    expect(monthCloseUsesYearEnd("2025-12", "ACTIVE")).toBe(true);
    expect(monthCloseUsesYearEnd("2025-12", "SHADOW")).toBe(false);
    expect(monthCloseUsesYearEnd("2025-11", "ACTIVE")).toBe(false);
  });

  it("preserves the selected year and request in the year-end link", () => {
    expect(yearEndCloseHref("2024-12", 73)).toBe(
      "/closing?tab=yearend&year=2024&requestId=73",
    );
  });
});
