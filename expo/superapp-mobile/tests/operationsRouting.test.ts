import { describe, expect, it } from "vitest";

describe("operations routes and business logic invariants", () => {
  it("defines canonical routes for all core enterprise operational modules", () => {
    const operationalRoutes = [
      "/operations/invoices",
      "/operations/inventory",
      "/operations/customers",
      "/operations/approvals",
      "/operations/treasury",
      "/operations/purchases",
    ];

    expect(operationalRoutes).toHaveLength(6);
    for (const route of operationalRoutes) {
      expect(route).toMatch(/^\/operations\/[a-z-]+$/);
    }
  });

  it("calculates branch inventory totals across multiple locations accurately", () => {
    const item = {
      name: "ورق طباعة A4 دبل إيه",
      branchMansourQty: 48,
      branchKarradaQty: 22,
      reorderLevel: 20,
    };

    const totalQty = item.branchMansourQty + item.branchKarradaQty;
    expect(totalQty).toBe(70);
    expect(totalQty > item.reorderLevel).toBe(true);
  });

  it("identifies low-stock conditions when inventory breaches safety thresholds", () => {
    const item = {
      name: "أحبار طابعة ليزر ملونة",
      branchMansourQty: 3,
      branchKarradaQty: 1,
      reorderLevel: 5,
    };

    const totalQty = item.branchMansourQty + item.branchKarradaQty;
    const isLowStock = totalQty < item.reorderLevel;
    expect(isLowStock).toBe(true);
  });

  it("accurately segregates customers with accounts receivable (AR) balances", () => {
    const customerAccounts = [
      { name: "شركة الرافدين", balanceDue: 3450000 },
      { name: "مكتب الضياء", balanceDue: 0 },
      { name: "مستشفى الفرح", balanceDue: 1890000 },
    ];

    const debtors = customerAccounts.filter((c) => c.balanceDue > 0);
    const totalDue = debtors.reduce((sum, c) => sum + c.balanceDue, 0);

    expect(debtors).toHaveLength(2);
    expect(totalDue).toBe(5340000);
  });

  it("calculates total treasury liquidity combining main vault and cashier drawers", () => {
    const branchTreasuries = [
      { branchName: "الفرع الرئيسي - المنصور", balance: 85400000 },
      { branchName: "فرع الكرادة", balance: 55287454 },
    ];
    const cashierDrawers = [
      { cashierName: "أحمد كاشير المنصور", balance: 145000 },
      { cashierName: "حيدر كاشير الكرادة", balance: 86500 },
    ];

    const totalVaults = branchTreasuries.reduce((sum, t) => sum + t.balance, 0);
    const totalDrawers = cashierDrawers.reduce((sum, d) => sum + d.balance, 0);
    const totalLiquidity = totalVaults + totalDrawers;

    expect(totalVaults).toBe(140687454);
    expect(totalDrawers).toBe(231500);
    expect(totalLiquidity).toBe(140918954);
  });

  it("calculates supplier accounts payable (AP) totals and filters indebted suppliers", () => {
    const suppliers = [
      { name: "شركة النور للمواد الغذائية", balanceDue: 12500000 },
      { name: "مكتب بغداد للتجارة", balanceDue: 4800000 },
      { name: "مورد التجهيزات الحديثة", balanceDue: 0 },
    ];

    const creditors = suppliers.filter((s) => s.balanceDue > 0);
    const totalPayables = creditors.reduce((sum, s) => sum + s.balanceDue, 0);

    expect(creditors).toHaveLength(2);
    expect(totalPayables).toBe(17300000);
  });

  it("enforces that sales invoice totals sum up all paid non-cancelled transactions", () => {
    const invoices = [
      { id: "1", amount: 485000, status: "PAID" },
      { id: "2", amount: 175000, status: "PAID" },
      { id: "3", amount: 890000, status: "PENDING" },
      { id: "4", amount: 15000, status: "CANCELLED" },
    ];

    const settledSales = invoices
      .filter((inv) => inv.status === "PAID")
      .reduce((sum, inv) => sum + inv.amount, 0);

    expect(settledSales).toBe(660000);
  });

  it("strictly enforces zero hardcoded mock user names across operations files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const forbiddenNames = ["علي حسن", "سارة كريم", "أحمد السعدي", "حسين علي", "زينب مهدي", "قتيبة السعدي"];
    const filesToAudit = [
      "app/operations/approvals.tsx",
      "app/operations/customers.tsx",
      "app/operations/inventory.tsx",
      "app/operations/invoices.tsx",
      "app/operations/treasury.tsx",
      "app/operations/purchases.tsx",
      "app/(tabs)/work.tsx",
      "app/(tabs)/index.tsx",
    ];

    for (const rel of filesToAudit) {
      const fullPath = path.resolve(process.cwd(), rel);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf8");
        for (const name of forbiddenNames) {
          expect(content.includes(name), `Forbidden mock name "${name}" found in ${rel}`).toBe(false);
        }
      }
    }
  });

  it("formats today's date strictly in Baghdad timezone YYYY-MM-DD", async () => {
    const { getTodayBaghdadYmd, formatYmdInBaghdad } = await import("../lib/operationsApi");
    const today = getTodayBaghdadYmd();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const formatted = formatYmdInBaghdad("2026-09-26T14:00:00Z");
    expect(formatted).toBe("2026-09-26");
  });

  it("excludes DEAD_INVOICE_STATUSES (RETURNED, SUPERSEDED, CANCELLED) from collectible debt", () => {
    const invoices = [
      { id: "1", amount: 100000, paidAmount: 0, status: "PENDING" },
      { id: "2", amount: 50000, paidAmount: 0, status: "RETURNED" },
      { id: "3", amount: 75000, paidAmount: 0, status: "SUPERSEDED" },
      { id: "4", amount: 30000, paidAmount: 0, status: "CANCELLED" },
      { id: "5", amount: 80000, paidAmount: 20000, status: "PARTIALLY_PAID" },
    ];

    const DEAD_STATUSES = new Set(["CANCELLED", "RETURNED", "SUPERSEDED"]);
    const collectibleInvoices = invoices.filter((inv) => !DEAD_STATUSES.has(inv.status));
    const totalPendingDebt = collectibleInvoices.reduce(
      (sum, inv) => sum + (inv.amount - inv.paidAmount),
      0,
    );

    expect(collectibleInvoices).toHaveLength(2); // Only PENDING and PARTIALLY_PAID
    expect(totalPendingDebt).toBe(160000); // 100000 + (80000 - 20000)
  });

  it("accurately converts base inventory quantity using conversionFactor", () => {
    const rawVariant = {
      productName: "دفاتر مدرسية سلك",
      stockBase: 120, // 120 قطعة
      conversionFactor: 12, // الدرزن = 12 قطعة
    };

    const factor = rawVariant.conversionFactor > 0 ? rawVariant.conversionFactor : 1;
    const packagesCount = Math.floor(rawVariant.stockBase / factor);
    expect(packagesCount).toBe(10); // 10 درازن
  });
});

