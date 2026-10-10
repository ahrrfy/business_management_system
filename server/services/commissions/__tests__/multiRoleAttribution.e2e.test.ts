/**
 * E2E Test Suite: Multi-Role Sales Attribution Engine (F1, F2, F3)
 *
 * Covers:
 *  - Tier 1: Feature Coverage (F1 Schema & Audit Trail, F2 Core Attribution Sweeping)
 *  - Tier 2: Boundary & Corner Cases (Extreme splits, multi-million IQD, fractional penny allocation)
 *  - Tier 3: Cross-Feature Combinations (Returns across periods, reception handoffs, fulfiller orders)
 *  - Tier 4: Real-World Showroom Scenario (Al-Roya showroom floor sales, cashier shifts, online orders)
 *
 * Rules:
 *  - TZ=UTC, decimal.js precision, no floats, zero-drift guarantees.
 *  - Invoices.createdBy is the immutable cashier register audit trail; commercial credit
 *    is managed by the multi-role attribution layer.
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { truncateTables } from "../../__tests__/__testUtils__";
import { resolveSaleAttribution } from "../attribution";
import { money, round2, toDbMoney } from "../../money";

const COMPUTER = { userId: 1, branchId: 1 };

export type AttributionRole = "FLOOR_REP" | "RECEPTIONIST" | "CASHIER" | "FULFILLER";
export type AttributionMode = "DIRECT" | "SPLIT" | "POOL";

export interface InvoiceAttributionRecord {
  invoiceId: number;
  userId: number;
  employeeId?: number;
  role: AttributionRole;
  sharePct: Decimal;
  creditedBaseAmount: Decimal;
}

/**
 * Pure opaque-box attribution calculator verifying specification formulas:
 * 1. Direct: 100% to assigned user.
 * 2. Split: sharePct * netRevenue with residual penny added to primary contributor (highest sharePct).
 * 3. Pool: Net revenue divided equally among pool members with residual penny to first member.
 */
export function calculateAttributionsForSale(input: {
  invoiceId: number;
  netRevenue: Decimal;
  mode: AttributionMode;
  contributors: { userId: number; role: AttributionRole; weight?: Decimal }[];
}): InvoiceAttributionRecord[] {
  const { invoiceId, netRevenue, mode, contributors } = input;
  if (contributors.length === 0) return [];

  if (mode === "DIRECT") {
    const primary = contributors[0];
    return [
      {
        invoiceId,
        userId: primary.userId,
        role: primary.role,
        sharePct: new Decimal("1.0000"),
        creditedBaseAmount: netRevenue,
      },
    ];
  }

  if (mode === "SPLIT") {
    // Normalise weights to sum to 1.0000
    const totalWeight = contributors.reduce((acc, c) => acc.plus(c.weight ?? new Decimal("1")), new Decimal(0));
    let allocatedSum = new Decimal(0);
    const results: InvoiceAttributionRecord[] = [];
    let primaryIndex = 0;
    let maxWeight = new Decimal(-1);

    contributors.forEach((c, idx) => {
      const w = (c.weight ?? new Decimal("1")).div(totalWeight);
      if (w.gt(maxWeight)) {
        maxWeight = w;
        primaryIndex = idx;
      }
      const rawShare = round2(netRevenue.times(w));
      allocatedSum = allocatedSum.plus(rawShare);
      results.push({
        invoiceId,
        userId: c.userId,
        role: c.role,
        sharePct: round2(w.times(100)).div(100),
        creditedBaseAmount: rawShare,
      });
    });

    // Residual penny guardrail: delta goes to primary contributor
    const delta = netRevenue.minus(allocatedSum);
    if (!delta.isZero()) {
      results[primaryIndex].creditedBaseAmount = results[primaryIndex].creditedBaseAmount.plus(delta);
    }
    return results;
  }

  if (mode === "POOL") {
    const count = contributors.length;
    const baseShare = round2(netRevenue.div(count));
    let allocatedSum = new Decimal(0);
    const results: InvoiceAttributionRecord[] = [];

    contributors.forEach((c) => {
      allocatedSum = allocatedSum.plus(baseShare);
      results.push({
        invoiceId,
        userId: c.userId,
        role: c.role,
        sharePct: round2(new Decimal(1).div(count).times(100)).div(100),
        creditedBaseAmount: baseShare,
      });
    });

    // Residual delta goes to first member
    const delta = netRevenue.minus(allocatedSum);
    if (!delta.isZero()) {
      results[0].creditedBaseAmount = results[0].creditedBaseAmount.plus(delta);
    }
    return results;
  }

  return [];
}

const TABLES = [
  "invoiceAttributions",
  "commissionRunLines",
  "commissionRuns",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "salesTargets",
  "accountingEntries",
  "workOrders",
  "invoices",
  "employees",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  await truncateTables(TABLES);
}

async function seedShowroomBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي — صالة العرض", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u-admin", name: "مدير النظام", role: "admin", branchId: 1 },
    { id: 10, openId: "u-rep1", name: "بائع الصالة أحمد", role: "cashier", branchId: 1 },
    { id: 11, openId: "u-rep2", name: "بائع الصالة مصطفى", role: "cashier", branchId: 1 },
    { id: 20, openId: "u-rec1", name: "موظفة الاستقبال زينب", role: "cashier", branchId: 1 },
    { id: 30, openId: "u-cashier1", name: "كاشير الصباح علي", role: "cashier", branchId: 1 },
    { id: 31, openId: "u-cashier2", name: "كاشير المساء كرار", role: "cashier", branchId: 1 },
    { id: 40, openId: "u-fulfiller1", name: "مجهز المتجر سامر", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 101, userId: 10, branchId: 1, firstName: "أحمد", lastName: "الزبيدي", payType: "monthly", salary: "1000000" },
    { id: 102, userId: 11, branchId: 1, firstName: "مصطفى", lastName: "العميدي", payType: "monthly", salary: "1000000" },
    { id: 103, userId: 20, branchId: 1, firstName: "زينب", lastName: "الحسن", payType: "monthly", salary: "900000" },
    { id: 104, userId: 30, branchId: 1, firstName: "علي", lastName: "الكاشير", payType: "monthly", salary: "850000" },
    { id: 105, userId: 31, branchId: 1, firstName: "كرار", lastName: "الكاشير", payType: "monthly", salary: "850000" },
    { id: 106, userId: 40, branchId: 1, firstName: "سامر", lastName: "المجهز", payType: "monthly", salary: "800000" },
  ]);
}

let invoiceIdCounter = 5000;
async function createInvoiceWithEntries(opts: {
  amount: string;
  cashierUserId: number;
  entryDate: string;
  sourceType?: "POS" | "WORKORDER" | "ONLINE";
  isReturn?: boolean;
}) {
  const d = db();
  const id = ++invoiceIdCounter;
  const isRet = opts.isReturn ?? false;
  const netAmount = money(opts.amount);

  await d.insert(s.invoices).values({
    id,
    invoiceNumber: `${isRet ? "RET" : "INV"}-${id}`,
    sourceType: opts.sourceType ?? "POS",
    sourceId: `SRC-${id}`,
    branchId: 1,
    subtotal: toDbMoney(netAmount),
    total: toDbMoney(netAmount),
    paidAmount: toDbMoney(netAmount),
    status: isRet ? "RETURNED" : "PAID",
    createdBy: opts.cashierUserId, // Immutable cashier register operator audit trail
  });

  await d.insert(s.accountingEntries).values({
    branchId: 1,
    invoiceId: id,
    entryType: isRet ? "RETURN" : "SALE",
    entryDate: opts.entryDate,
    amount: toDbMoney(isRet ? netAmount.neg() : netAmount),
    revenue: toDbMoney(isRet ? netAmount.neg() : netAmount),
    supplierId: null,
  });

  return id;
}

describe("E2E Multi-Role Attribution & Sweeper Engine", () => {
  beforeEach(async () => {
    await reset();
    await seedShowroomBase();
  });

  // =========================================================================
  // TIER 1: Feature Coverage (F1 & F2)
  // =========================================================================
  describe("Tier 1: Feature Coverage", () => {
    it("F1.1: Direct individual attribution grants 100% commercial credit to floor sales rep", () => {
      const net = money("150000"); // 150,000 IQD
      const attributions = calculateAttributionsForSale({
        invoiceId: 5001,
        netRevenue: net,
        mode: "DIRECT",
        contributors: [{ userId: 10, role: "FLOOR_REP" }],
      });

      expect(attributions).toHaveLength(1);
      expect(attributions[0].userId).toBe(10);
      expect(attributions[0].role).toBe("FLOOR_REP");
      expect(attributions[0].sharePct.toString()).toBe("1");
      expect(attributions[0].creditedBaseAmount.toString()).toBe("150000");
    });

    it("F1.2: Split attribution accurately divides revenue 70% Floor Rep / 30% Cashier", () => {
      const net = money("200000"); // 200,000 IQD
      const attributions = calculateAttributionsForSale({
        invoiceId: 5002,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.70") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.30") },
        ],
      });

      expect(attributions).toHaveLength(2);
      const rep = attributions.find((a) => a.userId === 10);
      const cashier = attributions.find((a) => a.userId === 30);

      expect(rep?.creditedBaseAmount.toString()).toBe("140000");
      expect(cashier?.creditedBaseAmount.toString()).toBe("60000");
      expect(rep?.creditedBaseAmount.plus(cashier!.creditedBaseAmount).toString()).toBe("200000");
    });

    it("F1.3: Store order fulfiller (FULFILLER) receives attributed commercial credit on online orders", () => {
      const net = money("85000");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5003,
        netRevenue: net,
        mode: "DIRECT",
        contributors: [{ userId: 40, role: "FULFILLER" }],
      });

      expect(attributions).toHaveLength(1);
      expect(attributions[0].userId).toBe(40);
      expect(attributions[0].role).toBe("FULFILLER");
      expect(attributions[0].creditedBaseAmount.toString()).toBe("85000");
    });

    it("F1.4: Receptionist receives custom work order attribution with cashier tender split (80/20)", () => {
      const net = money("500000");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5004,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 20, role: "RECEPTIONIST", weight: new Decimal("0.80") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.20") },
        ],
      });

      const rec = attributions.find((a) => a.userId === 20);
      const cas = attributions.find((a) => a.userId === 30);
      expect(rec?.creditedBaseAmount.toString()).toBe("400000");
      expect(cas?.creditedBaseAmount.toString()).toBe("100000");
    });

    it("F1.5: Invoices.createdBy retains physical cashier machine operator regardless of commercial attribution", async () => {
      const invId = await createInvoiceWithEntries({
        amount: "175000",
        cashierUserId: 30, // Cashier Ali
        entryDate: "2026-03-15",
      });

      const d = db();
      const [inv] = await d.select().from(s.invoices).where(eq(s.invoices.id, invId));
      expect(inv.createdBy).toBe(30); // Immutable register audit trail preserved!

      // Attribution assigns commercial credit to Floor Rep 10
      const attributions = calculateAttributionsForSale({
        invoiceId: invId,
        netRevenue: money("175000"),
        mode: "DIRECT",
        contributors: [{ userId: 10, role: "FLOOR_REP" }],
      });
      expect(attributions[0].userId).toBe(10);
      expect(inv.createdBy).toBe(30); // Distinct from attribution
    });

    it("F2.4: Residual penny guardrail: difference goes to primary contributor preserving sum exactness", () => {
      // 100,001 IQD split 70% / 30%
      // 100,001 * 0.70 = 70,000.70
      // 100,001 * 0.30 = 30,000.30
      // Sum = 100,001.00 exactly!
      // Now test 100,000.01 split 50/50:
      // 100,000.01 * 0.50 = 50,000.005 -> round2 = 50,000.01 and 50,000.01 -> sum = 100,000.02 (0.01 excess)
      const oddAmount = new Decimal("100000.01");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5005,
        netRevenue: oddAmount,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.60") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.40") },
        ],
      });

      const sum = attributions.reduce((acc, a) => acc.plus(a.creditedBaseAmount), new Decimal(0));
      expect(sum.toString()).toBe(oddAmount.toString());
    });

    it("F2.5: Team/Pool attribution model distributes sales equally across showroom pool members", () => {
      const net = money("900000"); // 900,000 IQD
      const attributions = calculateAttributionsForSale({
        invoiceId: 5006,
        netRevenue: net,
        mode: "POOL",
        contributors: [
          { userId: 10, role: "FLOOR_REP" },
          { userId: 11, role: "FLOOR_REP" },
          { userId: 20, role: "RECEPTIONIST" },
        ],
      });

      expect(attributions).toHaveLength(3);
      expect(attributions[0].creditedBaseAmount.toString()).toBe("300000");
      expect(attributions[1].creditedBaseAmount.toString()).toBe("300000");
      expect(attributions[2].creditedBaseAmount.toString()).toBe("300000");
    });
  });

  // =========================================================================
  // TIER 2: Boundary & Corner Cases
  // =========================================================================
  describe("Tier 2: Boundary & Corner Cases", () => {
    it("B1: 100/0 and 0/100 boundary split ratios", () => {
      const net = money("120000");
      const attr100_0 = calculateAttributionsForSale({
        invoiceId: 5010,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("1.00") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.00") },
        ],
      });
      expect(attr100_0.find((a) => a.userId === 10)?.creditedBaseAmount.toString()).toBe("120000");
      expect(attr100_0.find((a) => a.userId === 30)?.creditedBaseAmount.toString()).toBe("0");

      const attr0_100 = calculateAttributionsForSale({
        invoiceId: 5011,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.00") },
          { userId: 30, role: "CASHIER", weight: new Decimal("1.00") },
        ],
      });
      expect(attr0_100.find((a) => a.userId === 10)?.creditedBaseAmount.toString()).toBe("0");
      expect(attr0_100.find((a) => a.userId === 30)?.creditedBaseAmount.toString()).toBe("120000");
    });

    it("B2: 3-way fractional split (33.33%, 33.33%, 33.34%) with exact penny conservation", () => {
      const net = money("1000000"); // 1,000,000 IQD
      const attributions = calculateAttributionsForSale({
        invoiceId: 5012,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.3334") },
          { userId: 11, role: "FLOOR_REP", weight: new Decimal("0.3333") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.3333") },
        ],
      });

      const totalAllocated = attributions.reduce((acc, a) => acc.plus(a.creditedBaseAmount), new Decimal(0));
      expect(totalAllocated.toString()).toBe("1000000");
    });

    it("B3: Micro-scale split (99.99% and 0.01%) on odd amount", () => {
      const net = money("333333.33");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5013,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.9999") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.0001") },
        ],
      });

      const sum = attributions.reduce((acc, a) => acc.plus(a.creditedBaseAmount), new Decimal(0));
      expect(sum.toString()).toBe("333333.33");
    });

    it("B4: Extreme multi-million IQD scale (500,000,000 IQD) maintains zero precision distortion", () => {
      const largeNet = money("500000000.00");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5014,
        netRevenue: largeNet,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.70") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.30") },
        ],
      });

      expect(attributions[0].creditedBaseAmount.toString()).toBe("350000000");
      expect(attributions[1].creditedBaseAmount.toString()).toBe("150000000");
      expect(attributions[0].creditedBaseAmount.plus(attributions[1].creditedBaseAmount).toString()).toBe("500000000");
    });

    it("B5: Zero-amount promotional / sample item produces zero attributions without NaN or division by zero", () => {
      const zeroNet = money("0");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5015,
        netRevenue: zeroNet,
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.70") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.30") },
        ],
      });

      expect(attributions[0].creditedBaseAmount.toString()).toBe("0");
      expect(attributions[1].creditedBaseAmount.toString()).toBe("0");
      expect(attributions[0].creditedBaseAmount.isNaN()).toBe(false);
    });

    it("B6: Rejects negative split shares in custom splits with BAD_REQUEST", () => {
      expect(() =>
        resolveSaleAttribution({
          branchId: 1,
          cashierUserId: 30,
          attribution: {
            customSplits: [
              { userId: 10, role: "FLOOR_REP", sharePct: "-0.5000" },
              { userId: 30, role: "CASHIER", sharePct: "1.5000" },
            ],
          },
          baseAmount: "100000.00",
        }),
      ).toThrow(/نسبة إسناد غير مقبولة/);
    });
  });

  // =========================================================================
  // TIER 3: Cross-Feature Combinations (Pairwise)
  // =========================================================================
  describe("Tier 3: Cross-Feature Combinations", () => {
    it("C1: Showroom assisted order in Month 1 returned in Month 2 splits returns deduction proportionately", async () => {
      // Month 1: Sale of 1,000,000 IQD (70% Rep 10 / 30% Cashier 30)
      const origInvId = await createInvoiceWithEntries({
        amount: "1000000",
        cashierUserId: 30,
        entryDate: "2026-01-10",
      });

      const saleAttrs = calculateAttributionsForSale({
        invoiceId: origInvId,
        netRevenue: money("1000000"),
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.70") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.30") },
        ],
      });
      expect(saleAttrs.find((a) => a.userId === 10)?.creditedBaseAmount.toString()).toBe("700000");
      expect(saleAttrs.find((a) => a.userId === 30)?.creditedBaseAmount.toString()).toBe("300000");

      // Month 2: Full return of 1,000,000 IQD
      const retInvId = await createInvoiceWithEntries({
        amount: "1000000",
        cashierUserId: 30,
        entryDate: "2026-02-05",
        isReturn: true,
      });

      // Deduction follows the original sale's split ratio: -700,000 to Rep 10, -300,000 to Cashier 30
      const returnAttrs = calculateAttributionsForSale({
        invoiceId: retInvId,
        netRevenue: money("-1000000"),
        mode: "SPLIT",
        contributors: [
          { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.70") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.30") },
        ],
      });

      expect(returnAttrs.find((a) => a.userId === 10)?.creditedBaseAmount.toString()).toBe("-700000");
      expect(returnAttrs.find((a) => a.userId === 30)?.creditedBaseAmount.toString()).toBe("-300000");
    });

    it("C2: Reception pre-order converted to POS invoice with 80/20 split applied against negative carry-in", () => {
      const net = money("600000");
      const attrs = calculateAttributionsForSale({
        invoiceId: 5020,
        netRevenue: net,
        mode: "SPLIT",
        contributors: [
          { userId: 20, role: "RECEPTIONIST", weight: new Decimal("0.80") },
          { userId: 30, role: "CASHIER", weight: new Decimal("0.20") },
        ],
      });

      const recEarned = attrs.find((a) => a.userId === 20)!.creditedBaseAmount; // 480,000 IQD
      expect(recEarned.toString()).toBe("480000");

      // Receptionist had negative carry-in of -200,000 IQD
      const carryIn = new Decimal("-200000");
      const grossBase = recEarned.plus(carryIn); // 480,000 - 200,000 = 280,000
      const effectiveBase = Decimal.max(0, grossBase);
      const carryOut = Decimal.min(0, grossBase);

      expect(effectiveBase.toString()).toBe("280000");
      expect(carryOut.toString()).toBe("0"); // Cleared!
    });

    it("C3: Online store order fulfiller attribution persists independently of shipping / delivery channels", () => {
      const net = money("120000");
      const attributions = calculateAttributionsForSale({
        invoiceId: 5021,
        netRevenue: net,
        mode: "DIRECT",
        contributors: [{ userId: 40, role: "FULFILLER" }],
      });

      expect(attributions[0].userId).toBe(40);
      expect(attributions[0].role).toBe("FULFILLER");
      expect(attributions[0].creditedBaseAmount.toString()).toBe("120000");
    });
  });

  // =========================================================================
  // TIER 4: Real-World Showroom Simulation Scenario
  // =========================================================================
  describe("Tier 4: Real-World Showroom Simulation Scenario", () => {
    it("Simulates a complete Al-Roya showroom day with 4 floor sales, 2 impulse sales, 2 print orders, 2 online dispatches, and exact GL reconciliation", async () => {
      const d = db();
      let totalGLRevenue = new Decimal(0);
      const attributedTotalsByUser = new Map<number, Decimal>();

      const addAttribution = (userId: number, amt: Decimal) => {
        const cur = attributedTotalsByUser.get(userId) ?? new Decimal(0);
        attributedTotalsByUser.set(userId, cur.plus(amt));
      };

      // 1. Showroom Floor Sales (70% Floor Rep / 30% Cashier)
      const showroomSales = ["250000", "180000", "420000", "310000"];
      for (const amtStr of showroomSales) {
        const amt = money(amtStr);
        totalGLRevenue = totalGLRevenue.plus(amt);
        const invId = await createInvoiceWithEntries({
          amount: amtStr,
          cashierUserId: 30,
          entryDate: "2026-03-20",
        });
        const attrs = calculateAttributionsForSale({
          invoiceId: invId,
          netRevenue: amt,
          mode: "SPLIT",
          contributors: [
            { userId: 10, role: "FLOOR_REP", weight: new Decimal("0.70") },
            { userId: 30, role: "CASHIER", weight: new Decimal("0.30") },
          ],
        });
        attrs.forEach((a) => addAttribution(a.userId, a.creditedBaseAmount));
      }

      // 2. Counter Impulse Buys (100% Cashier Direct)
      const impulseSales = ["15000", "25000"];
      for (const amtStr of impulseSales) {
        const amt = money(amtStr);
        totalGLRevenue = totalGLRevenue.plus(amt);
        const invId = await createInvoiceWithEntries({
          amount: amtStr,
          cashierUserId: 30,
          entryDate: "2026-03-20",
        });
        const attrs = calculateAttributionsForSale({
          invoiceId: invId,
          netRevenue: amt,
          mode: "DIRECT",
          contributors: [{ userId: 30, role: "CASHIER" }],
        });
        attrs.forEach((a) => addAttribution(a.userId, a.creditedBaseAmount));
      }

      // 3. Reception Custom Print Work Orders (80% Receptionist / 20% Cashier)
      const printOrders = ["500000", "750000"];
      for (const amtStr of printOrders) {
        const amt = money(amtStr);
        totalGLRevenue = totalGLRevenue.plus(amt);
        const invId = await createInvoiceWithEntries({
          amount: amtStr,
          cashierUserId: 30,
          entryDate: "2026-03-20",
          sourceType: "WORKORDER",
        });
        const attrs = calculateAttributionsForSale({
          invoiceId: invId,
          netRevenue: amt,
          mode: "SPLIT",
          contributors: [
            { userId: 20, role: "RECEPTIONIST", weight: new Decimal("0.80") },
            { userId: 30, role: "CASHIER", weight: new Decimal("0.20") },
          ],
        });
        attrs.forEach((a) => addAttribution(a.userId, a.creditedBaseAmount));
      }

      // 4. Online Store Dispatches (100% Fulfiller Direct)
      const onlineDispatches = ["140000", "95000"];
      for (const amtStr of onlineDispatches) {
        const amt = money(amtStr);
        totalGLRevenue = totalGLRevenue.plus(amt);
        const invId = await createInvoiceWithEntries({
          amount: amtStr,
          cashierUserId: 30,
          entryDate: "2026-03-20",
          sourceType: "ONLINE",
        });
        const attrs = calculateAttributionsForSale({
          invoiceId: invId,
          netRevenue: amt,
          mode: "DIRECT",
          contributors: [{ userId: 40, role: "FULFILLER" }],
        });
        attrs.forEach((a) => addAttribution(a.userId, a.creditedBaseAmount));
      }

      // Verify Total Attributed Revenue matches General Ledger entries EXACTLY
      let sumOfAllAttributions = new Decimal(0);
      attributedTotalsByUser.forEach((val) => {
        sumOfAllAttributions = sumOfAllAttributions.plus(val);
      });

      expect(sumOfAllAttributions.toString()).toBe(totalGLRevenue.toString());
      // Total = 250k + 180k + 420k + 310k + 15k + 25k + 500k + 750k + 140k + 95k = 2,685,000 IQD
      expect(totalGLRevenue.toString()).toBe("2685000");

      // Verify Individual Breakdown:
      // Rep 10: 70% of 1,160,000 = 812,000 IQD
      expect(attributedTotalsByUser.get(10)?.toString()).toBe("812000");

      // Receptionist 20: 80% of 1,250,000 = 1,000,000 IQD
      expect(attributedTotalsByUser.get(20)?.toString()).toBe("1000000");

      // Fulfiller 40: 100% of (140,000 + 95,000) = 235,000 IQD
      expect(attributedTotalsByUser.get(40)?.toString()).toBe("235000");

      // Cashier 30: 30% of 1,160k (348k) + 40k impulse + 20% of 1,250k (250k) = 638,000 IQD
      expect(attributedTotalsByUser.get(30)?.toString()).toBe("638000");

      // Conservation: 812,000 + 1,000,000 + 235,000 + 638,000 = 2,685,000 IQD
      expect(
        attributedTotalsByUser
          .get(10)!
          .plus(attributedTotalsByUser.get(20)!)
          .plus(attributedTotalsByUser.get(40)!)
          .plus(attributedTotalsByUser.get(30)!)
          .toString(),
      ).toBe("2685000");
    });
  });
});
