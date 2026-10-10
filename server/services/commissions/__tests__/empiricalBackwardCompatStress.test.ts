/**
 * Empirical Stress Test: Backward Compatibility & Base Sweeper Proportionality
 * M1 Challenger 2 Empirical Verification Suite
 *
 * Verifies against live MySQL database:
 * 1. Historical invoices with no `invoiceAttributions` rows are cleanly credited to
 *    `COALESCE(workOrders.createdBy, invoices.createdBy)` with 100% share.
 * 2. Historical work order invoices credit `workOrders.createdBy` rather than `invoices.createdBy`.
 * 3. Returns clawback on historical invoices deducts 100% from the historical seller.
 * 4. Returns clawback on multi-role attributed invoices preserves exact negative proportionality.
 * 5. Partial returns clawback scales strictly by `sharePct`.
 * 6. Cross-period returns generate exact proportional negative credit in return period.
 * 7. Consignment deductions scale strictly by `effectiveShare`.
 * 8. Grand total conservation: Sum of all attributed (sales - returns) equals total GL revenue.
 */
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { money, round2, toDbMoney } from "../../money";
import { computeNetSalesByUser } from "../base";

const TABLES = [
  "invoiceAttributions",
  "accountingEntries",
  "workOrders",
  "invoices",
  "suppliers",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.delete(s.invoiceAttributions);
  await d.delete(s.accountingEntries);
  await d.delete(s.workOrders);
  await d.delete(s.invoices);
}

async function seedMaster() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
  ]).onDuplicateKeyUpdate({ set: { id: sql`id` } });

  await d.insert(s.suppliers).values([
    { id: 999, name: "مورد أمانة" },
  ]).onDuplicateKeyUpdate({ set: { id: sql`id` } });

  await d.insert(s.users).values([
    { id: 1, openId: "u-admin", name: "المدير", role: "admin", branchId: 1 },
    { id: 10, openId: "u-rep1", name: "بائع الصالة أحمد", role: "cashier", branchId: 1 },
    { id: 11, openId: "u-rep2", name: "بائع الصالة مصطفى", role: "cashier", branchId: 1 },
    { id: 20, openId: "u-rec1", name: "موظفة الاستقبال زينب", role: "cashier", branchId: 1 },
    { id: 30, openId: "u-cashier1", name: "الكاشير علي", role: "cashier", branchId: 1 },
    { id: 40, openId: "u-fulfiller", name: "مجهز الطلبات سامر", role: "cashier", branchId: 1 },
  ]).onDuplicateKeyUpdate({ set: { id: sql`id` } });
}

let seq = 8000;

async function insertHistoricalInvoice(opts: {
  amount: string;
  cashierId: number;
  entryDate: string;
  sourceType?: "POS" | "WORKORDER";
  workOrderCreatorId?: number;
}): Promise<number> {
  const d = db();
  const invId = ++seq;
  const net = money(opts.amount);
  const srcType = opts.sourceType ?? "POS";

  await d.insert(s.invoices).values({
    id: invId,
    invoiceNumber: `HIST-${invId}`,
    sourceType: srcType,
    sourceId: `SRC-${invId}`,
    branchId: 1,
    subtotal: toDbMoney(net),
    total: toDbMoney(net),
    paidAmount: toDbMoney(net),
    status: "PAID",
    createdBy: opts.cashierId,
  });

  if (srcType === "WORKORDER" && opts.workOrderCreatorId != null) {
    await d.insert(s.workOrders).values({
      id: invId + 10000,
      orderNumber: `WO-${invId}`,
      branchId: 1,
      title: "أمر شغل تاريخي",
      invoiceId: invId,
      createdBy: opts.workOrderCreatorId,
      status: "DELIVERED",
    });
  }

  await d.insert(s.accountingEntries).values({
    branchId: 1,
    invoiceId: invId,
    entryType: "SALE",
    entryDate: opts.entryDate as any,
    amount: toDbMoney(net),
    revenue: toDbMoney(net),
    supplierId: null,
  });

  return invId;
}

async function insertAttributedInvoice(opts: {
  amount: string;
  cashierId: number;
  entryDate: string;
  attributions: { userId: number; role: "FLOOR_REP" | "CASHIER" | "RECEPTIONIST" | "FULFILLER"; sharePct: string; creditedAmount: string }[];
}): Promise<number> {
  const d = db();
  const invId = ++seq;
  const net = money(opts.amount);

  await d.insert(s.invoices).values({
    id: invId,
    invoiceNumber: `ATTR-${invId}`,
    sourceType: "POS",
    sourceId: `SRC-${invId}`,
    branchId: 1,
    subtotal: toDbMoney(net),
    total: toDbMoney(net),
    paidAmount: toDbMoney(net),
    status: "PAID",
    createdBy: opts.cashierId,
  });

  await d.insert(s.accountingEntries).values({
    branchId: 1,
    invoiceId: invId,
    entryType: "SALE",
    entryDate: opts.entryDate as any,
    amount: toDbMoney(net),
    revenue: toDbMoney(net),
    supplierId: null,
  });

  for (const attr of opts.attributions) {
    await d.insert(s.invoiceAttributions).values({
      invoiceId: invId,
      branchId: 1,
      userId: attr.userId,
      role: attr.role,
      attributionMode: opts.attributions.length > 1 ? "SPLIT" : "DIRECT",
      sharePct: attr.sharePct,
      creditedBaseAmount: attr.creditedAmount,
    });
  }

  return invId;
}

async function postReturn(opts: {
  invoiceId: number;
  returnAmount: string;
  entryDate: string;
  cashierId: number;
}) {
  const d = db();
  const retNet = money(opts.returnAmount);

  await d.insert(s.accountingEntries).values({
    branchId: 1,
    invoiceId: opts.invoiceId,
    entryType: "RETURN",
    entryDate: opts.entryDate as any,
    amount: toDbMoney(retNet.neg()),
    revenue: toDbMoney(retNet.neg()),
    supplierId: null,
    createdBy: opts.cashierId,
  });
}

describe("Empirical Challenger: Backward Compatibility & Sweeper Proportionality", () => {
  beforeEach(async () => {
    await seedMaster();
  });

  describe("1. Historical Invoices Backward Compatibility (Zero Attribution Rows)", () => {
    it("credits 100% of historical POS invoice to invoices.createdBy", async () => {
      // Historical POS sale: Cashier 30, Amount: 250,000 IQD, Date: 2026-03-05
      await insertHistoricalInvoice({
        amount: "250000.00",
        cashierId: 30,
        entryDate: "2026-03-05",
        sourceType: "POS",
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);

      // Cashier 30 should receive 100% (250,000 IQD)
      const cashierBase = netMap.get(30);
      expect(cashierBase).toBeDefined();
      expect(cashierBase?.sales.toString()).toBe("250000");
      expect(cashierBase?.returns.toString()).toBe("0");
      expect(cashierBase?.saleEntryCount).toBe(1);

      // No other user receives any credit
      expect(netMap.get(10)).toBeUndefined();
      expect(netMap.get(20)).toBeUndefined();
    });

    it("credits 100% of historical WORKORDER invoice to workOrders.createdBy, NOT invoices.createdBy", async () => {
      // Historical Work Order sale:
      // Invoiced by Cashier 30, but Work Order created by Receptionist 20
      await insertHistoricalInvoice({
        amount: "400000.00",
        cashierId: 30,
        workOrderCreatorId: 20,
        entryDate: "2026-03-08",
        sourceType: "WORKORDER",
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);

      // Receptionist 20 MUST receive 100% credit
      const recBase = netMap.get(20);
      expect(recBase).toBeDefined();
      expect(recBase?.sales.toString()).toBe("400000");
      expect(recBase?.workOrderCount).toBe(1);

      // Cashier 30 MUST NOT receive this credit
      expect(netMap.get(30)).toBeUndefined();
    });

    it("falls back cleanly to invoices.createdBy if WORKORDER row is missing", async () => {
      // Historical Work Order invoice where workOrders row is missing
      await insertHistoricalInvoice({
        amount: "150000.00",
        cashierId: 30,
        entryDate: "2026-03-10",
        sourceType: "WORKORDER",
        workOrderCreatorId: undefined, // no workOrders row inserted
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);

      // Falls back to invoices.createdBy (30)
      const cashierBase = netMap.get(30);
      expect(cashierBase).toBeDefined();
      expect(cashierBase?.sales.toString()).toBe("150000");
    });
  });

  describe("2. Returns Clawback Exact Negative Proportionality", () => {
    it("claws back 100% from historical seller when historical invoice is returned", async () => {
      // Sale of 300,000 IQD to Cashier 30
      const invId = await insertHistoricalInvoice({
        amount: "300000.00",
        cashierId: 30,
        entryDate: "2026-03-02",
        sourceType: "POS",
      });

      // Partial return of 100,000 IQD in same period
      await postReturn({
        invoiceId: invId,
        returnAmount: "100000.00",
        entryDate: "2026-03-15",
        cashierId: 30,
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);
      const cashierBase = netMap.get(30);

      expect(cashierBase?.sales.toString()).toBe("300000");
      expect(cashierBase?.returns.toString()).toBe("100000");
      expect(cashierBase?.sales.minus(cashierBase.returns).toString()).toBe("200000");
      expect(cashierBase?.returnEntryCount).toBe(1);
    });

    it("claws back 100% from workOrders.createdBy on historical work order return", async () => {
      const invId = await insertHistoricalInvoice({
        amount: "500000.00",
        cashierId: 30,
        workOrderCreatorId: 20,
        entryDate: "2026-03-03",
        sourceType: "WORKORDER",
      });

      await postReturn({
        invoiceId: invId,
        returnAmount: "200000.00",
        entryDate: "2026-03-16",
        cashierId: 30,
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);
      const recBase = netMap.get(20);

      expect(recBase?.sales.toString()).toBe("500000");
      expect(recBase?.returns.toString()).toBe("200000");
      expect(recBase?.sales.minus(recBase.returns).toString()).toBe("300000");
      expect(netMap.get(30)).toBeUndefined();
    });

    it("strictly preserves 70/30 negative proportionality on multi-role attributed invoice return", async () => {
      // Sale: 1,000,000 IQD (70% Rep 10 / 30% Cashier 30)
      const invId = await insertAttributedInvoice({
        amount: "1000000.00",
        cashierId: 30,
        entryDate: "2026-03-01",
        attributions: [
          { userId: 10, role: "FLOOR_REP", sharePct: "0.7000", creditedAmount: "700000.00" },
          { userId: 30, role: "CASHIER", sharePct: "0.3000", creditedAmount: "300000.00" },
        ],
      });

      // Full return of 1,000,000 IQD
      await postReturn({
        invoiceId: invId,
        returnAmount: "1000000.00",
        entryDate: "2026-03-20",
        cashierId: 30,
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);

      const repBase = netMap.get(10);
      const casBase = netMap.get(30);

      expect(repBase?.sales.toString()).toBe("700000");
      expect(repBase?.returns.toString()).toBe("700000");
      expect(repBase?.sales.minus(repBase.returns).toString()).toBe("0");

      expect(casBase?.sales.toString()).toBe("300000");
      expect(casBase?.returns.toString()).toBe("300000");
      expect(casBase?.sales.minus(casBase.returns).toString()).toBe("0");
    });

    it("strictly preserves negative proportionality on partial return (40% return on 70/30 split)", async () => {
      // Sale: 500,000 IQD (70% Rep 10 = 350,000; 30% Cashier 30 = 150,000)
      const invId = await insertAttributedInvoice({
        amount: "500000.00",
        cashierId: 30,
        entryDate: "2026-03-05",
        attributions: [
          { userId: 10, role: "FLOOR_REP", sharePct: "0.7000", creditedAmount: "350000.00" },
          { userId: 30, role: "CASHIER", sharePct: "0.3000", creditedAmount: "150000.00" },
        ],
      });

      // Partial return: 200,000 IQD
      // Rep 10 return should be: 200,000 * 0.70 = 140,000
      // Cashier 30 return should be: 200,000 * 0.30 = 60,000
      await postReturn({
        invoiceId: invId,
        returnAmount: "200000.00",
        entryDate: "2026-03-22",
        cashierId: 30,
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);

      const repBase = netMap.get(10);
      const casBase = netMap.get(30);

      expect(repBase?.sales.toString()).toBe("350000");
      expect(repBase?.returns.toString()).toBe("140000");
      expect(repBase?.sales.minus(repBase.returns).toString()).toBe("210000");

      expect(casBase?.sales.toString()).toBe("150000");
      expect(casBase?.returns.toString()).toBe("60000");
      expect(casBase?.sales.minus(casBase.returns).toString()).toBe("90000");
    });

    it("handles cross-period return: Sale in M1, Return in M2 leaves M2 net sales strictly negative", async () => {
      // Sale in 2026-01: 600,000 IQD (80% Rep 10 / 20% Cashier 30)
      const invId = await insertAttributedInvoice({
        amount: "600000.00",
        cashierId: 30,
        entryDate: "2026-01-15",
        attributions: [
          { userId: 10, role: "FLOOR_REP", sharePct: "0.8000", creditedAmount: "480000.00" },
          { userId: 30, role: "CASHIER", sharePct: "0.2000", creditedAmount: "120000.00" },
        ],
      });

      // Return in 2026-02: 300,000 IQD
      await postReturn({
        invoiceId: invId,
        returnAmount: "300000.00",
        entryDate: "2026-02-10",
        cashierId: 30,
      });

      // Check Month 1 (2026-01): pure sales, 0 returns
      const m1Map = await computeNetSalesByUser(db(), "2026-01", 1);
      expect(m1Map.get(10)?.sales.toString()).toBe("480000");
      expect(m1Map.get(10)?.returns.toString()).toBe("0");
      expect(m1Map.get(30)?.sales.toString()).toBe("120000");
      expect(m1Map.get(30)?.returns.toString()).toBe("0");

      // Check Month 2 (2026-02): 0 sales, proportional returns!
      const m2Map = await computeNetSalesByUser(db(), "2026-02", 1);
      const repM2 = m2Map.get(10);
      const casM2 = m2Map.get(30);

      expect(repM2?.sales.toString()).toBe("0");
      expect(repM2?.returns.toString()).toBe("240000"); // 300,000 * 0.8000
      expect(repM2?.sales.minus(repM2.returns).toString()).toBe("-240000");

      expect(casM2?.sales.toString()).toBe("0");
      expect(casM2?.returns.toString()).toBe("60000");  // 300,000 * 0.2000
      expect(casM2?.sales.minus(casM2.returns).toString()).toBe("-60000");
    });

    it("verifies 3-way fractional split returns clawback with penny-exact conservation", async () => {
      // 3-way split: 50% Rep 10, 30% Rep 11, 20% Cashier 30
      // Sale: 999,999.00 IQD
      const invId = await insertAttributedInvoice({
        amount: "999999.00",
        cashierId: 30,
        entryDate: "2026-03-02",
        attributions: [
          { userId: 10, role: "FLOOR_REP", sharePct: "0.5000", creditedAmount: "499999.50" },
          { userId: 11, role: "FLOOR_REP", sharePct: "0.3000", creditedAmount: "299999.70" },
          { userId: 30, role: "CASHIER", sharePct: "0.2000", creditedAmount: "199999.80" },
        ],
      });

      // Partial return: 333,333.00 IQD
      await postReturn({
        invoiceId: invId,
        returnAmount: "333333.00",
        entryDate: "2026-03-12",
        cashierId: 30,
      });

      const netMap = await computeNetSalesByUser(db(), "2026-03", 1);
      const u10 = netMap.get(10)!;
      const u11 = netMap.get(11)!;
      const u30 = netMap.get(30)!;

      // Returns:
      // 333,333 * 0.50 = 166,666.50
      // 333,333 * 0.30 = 99,999.90
      // 333,333 * 0.20 = 66,666.60
      // Sum = 333,333.00 exactly
      expect(u10.returns.toString()).toBe("166666.5");
      expect(u11.returns.toString()).toBe("99999.9");
      expect(u30.returns.toString()).toBe("66666.6");

      const sumReturns = u10.returns.plus(u11.returns).plus(u30.returns);
      expect(sumReturns.toString()).toBe("333333");
    });
  });

  describe("3. Mixed Batch Reconciliation (Historical + Multi-Role + Returns + Consignment)", () => {
    it("preserves exact GL revenue equality Σ(sales - returns - consig) across diverse operational mix", async () => {
      // 1. Historical POS Sale: 200,000 IQD by Cashier 30
      await insertHistoricalInvoice({
        amount: "200000.00",
        cashierId: 30,
        entryDate: "2026-03-01",
        sourceType: "POS",
      });

      // 2. Historical Work Order: 350,000 IQD by Rec 20 (cashier 30)
      const histWoId = await insertHistoricalInvoice({
        amount: "350000.00",
        cashierId: 30,
        workOrderCreatorId: 20,
        entryDate: "2026-03-02",
        sourceType: "WORKORDER",
      });

      // Return on Historical Work Order: 50,000 IQD
      await postReturn({
        invoiceId: histWoId,
        returnAmount: "50000.00",
        entryDate: "2026-03-10",
        cashierId: 30,
      });

      // 3. Multi-role Split: 600,000 IQD (70% Rep 10 / 30% Cashier 30)
      const splitInvId = await insertAttributedInvoice({
        amount: "600000.00",
        cashierId: 30,
        entryDate: "2026-03-03",
        attributions: [
          { userId: 10, role: "FLOOR_REP", sharePct: "0.7000", creditedAmount: "420000.00" },
          { userId: 30, role: "CASHIER", sharePct: "0.3000", creditedAmount: "180000.00" },
        ],
      });

      // Partial return on Multi-role Split: 100,000 IQD
      await postReturn({
        invoiceId: splitInvId,
        returnAmount: "100000.00",
        entryDate: "2026-03-15",
        cashierId: 30,
      });

      // 4. Online Dispatch: 150,000 IQD direct to Fulfiller 40
      await insertAttributedInvoice({
        amount: "150000.00",
        cashierId: 30,
        entryDate: "2026-03-04",
        attributions: [
          { userId: 40, role: "FULFILLER", sharePct: "1.0000", creditedAmount: "150000.00" },
        ],
      });

      // 5. Consignment Item Deduction on Multi-Role Invoice:
      // Add a consignment PURCHASE entry of 40,000 IQD linked to splitInvId
      const d = db();
      await d.insert(s.accountingEntries).values({
        branchId: 1,
        invoiceId: splitInvId,
        entryType: "PURCHASE",
        entryDate: new Date("2026-03-03T10:05:00Z"),
        amount: "40000.00",
        revenue: "0.00",
        supplierId: 999, // Consignor
      });

      // Compute Net Sales via base sweeper
      const netMap = await computeNetSalesByUser(d, "2026-03", 1);

      // Verify Individual Breakdown:
      // User 20 (Receptionist):
      // Sales: 350,000 | Returns: 50,000 | Net: 300,000
      const u20 = netMap.get(20)!;
      expect(u20.sales.toString()).toBe("350000");
      expect(u20.returns.toString()).toBe("50000");
      expect(u20.sales.minus(u20.returns).toString()).toBe("300000");

      // User 10 (Floor Rep):
      // Sales: 420,000 (70% of 600k) | Returns: 70,000 (70% of 100k) | Consig: 28,000 (70% of 40k)
      // Net: 420,000 - 70,000 - 28,000 = 322,000
      const u10 = netMap.get(10)!;
      expect(u10.sales.toString()).toBe("420000");
      expect(u10.returns.toString()).toBe("70000");
      expect(u10.consigDeduction.toString()).toBe("28000");
      expect(u10.sales.minus(u10.returns).minus(u10.consigDeduction).toString()).toBe("322000");

      // User 40 (Fulfiller):
      // Sales: 150,000 | Returns: 0 | Net: 150,000 | Fulfilled Count: 1
      const u40 = netMap.get(40)!;
      expect(u40.sales.toString()).toBe("150000");
      expect(u40.returns.toString()).toBe("0");
      expect(u40.fulfilledOrderCount).toBe(1);

      // User 30 (Cashier):
      // Sales: 200,000 (hist POS) + 180,000 (30% of 600k) = 380,000
      // Returns: 30,000 (30% of 100k)
      // Consig: 12,000 (30% of 40k)
      // Net: 380,000 - 30,000 - 12,000 = 338,000
      const u30 = netMap.get(30)!;
      expect(u30.sales.toString()).toBe("380000");
      expect(u30.returns.toString()).toBe("30000");
      expect(u30.consigDeduction.toString()).toBe("12000");
      expect(u30.sales.minus(u30.returns).minus(u30.consigDeduction).toString()).toBe("338000");

      // Net Base Sum across all users:
      // 300,000 + 322,000 + 150,000 + 338,000 = 1,110,000 IQD
      const totalAttributedNet = u20.sales.minus(u20.returns)
        .plus(u10.sales.minus(u10.returns).minus(u10.consigDeduction))
        .plus(u40.sales.minus(u40.returns))
        .plus(u30.sales.minus(u30.returns).minus(u30.consigDeduction));

      expect(totalAttributedNet.toString()).toBe("1110000");

      // GL Totals:
      // Gross Sales: 200k + 350k + 600k + 150k = 1,300,000
      // Returns: 50k + 100k = 150,000
      // Consignment: 40,000
      // Net GL Base: 1,300,000 - 150,000 - 40,000 = 1,110,000 IQD!
      expect(totalAttributedNet.toString()).toBe("1110000");
    });
  });
});
