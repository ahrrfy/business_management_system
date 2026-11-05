import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { approveVoucher } from "../voucher/approval";
import {
  dashboardService,
  finalizeService,
  intentService,
  offeringService,
  pricingService,
  providerService,
  walletOpsService,
  walletService,
} from "../digitalCards";

/** Real finalized sales plus physical return allocations and ledger history. */

const actor = { userId: 1, branchId: 1, role: "cashier" };
const mgr = { userId: 2, branchId: 1, role: "manager" };
const owner = { userId: 3, branchId: 1, role: "admin", isOwner: true };
const DATE = "2026-07-29";
const FROM = "2026-01-01";
const TO = "2027-01-01";

const TABLES = [
  "digitalWalletReconciliations",
  "digitalSaleDetails",
  "digitalSaleExecutionClaims",
  "digitalSaleIntentItems",
  "digitalWalletReservations",
  "digitalSaleIntents",
  "digitalWalletTransactions",
  "digitalCurrentPrices",
  "digitalPriceVersions",
  "digitalPriceBatches",
  "digitalOfferingBranches",
  "digitalOfferings",
  "digitalWallets",
  "digitalProviders",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "idempotencyKeys",
  "branchStock",
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "auditLogs",
  "studentProfiles",
  "customers",
  "suppliers",
  "categories",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const scope = (
  over: Partial<dashboardService.Scope> = {},
): dashboardService.Scope => ({
  from: FROM,
  to: TO,
  branchId: 1,
  includeCost: true,
  ...over,
});

async function seedBase() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "u1",
        name: "كاشير",
        role: "cashier",
        branchId: 1,
        loginMethod: "local",
      },
      {
        id: 2,
        openId: "u2",
        name: "مدير",
        role: "manager",
        branchId: 1,
        loginMethod: "local",
      },
      {
        id: 3,
        openId: "u3",
        name: "المالك",
        role: "admin",
        branchId: 1,
        loginMethod: "local",
        isOwner: true,
      },
    ]);
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "100000000",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: owner.userId,
  });
  await db()
    .insert(s.shifts)
    .values({
      id: 1,
      branchId: 1,
      userId: 1,
      status: "OPEN",
      openingBalance: "0",
    });
}

async function mkProvider(name: string, mode: "PREPAID" | "POSTPAID") {
  const { supplierId } = await createSupplier(
    { name },
    { userId: 1, branchId: 1 },
  );
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: mode,
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
        lowBalanceThreshold: "50000",
      },
      { userId: 1, branchId: 1 },
    ),
  );
  return { providerId, supplierId };
}

async function mkWallet(providerId: number, balance: string, code = "W1") {
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(
      tx,
      { providerId, branchId: 1, code, name: `محفظة ${code}` },
      { userId: 1, branchId: 1 },
    ),
  );
  const request = await withTx((tx) =>
    walletOpsService.deposit(
      tx,
      {
        walletId,
        amount: balance,
        paymentMethod: "CASH",
        clientRequestId: `dep-${code}-${Math.random().toString(36).slice(2, 9)}`,
      },
      mgr,
    ),
  );
  await approveVoucher(request.receiptId, owner);
  return walletId;
}

async function mkOffering(
  providerId: number,
  name: string,
  walletId: number | null,
  branchId = 1,
) {
  const r = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "TELECOM_CARD",
        name,
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "850",
        roundingStep: "0",
        branches: [{ branchId, walletId }],
      },
      { userId: 1, branchId: 1 },
    ),
  );
  return r.offeringId;
}

async function publish(
  providerId: number,
  branchId: number,
  lines: { offeringId: number; providerShare: string }[],
) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      { branchId, providerId, businessDate: DATE },
      { userId: 1, branchId: 1 },
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      { batchId, lines },
      { userId: 1, branchId: 1 },
    ),
  );
  await withTx((tx) =>
    pricingService.publish(tx, { batchId }, { userId: 1, branchId: 1 }),
  );
  const rows = await db()
    .select({
      offeringId: s.digitalCurrentPrices.offeringId,
      pv: s.digitalCurrentPrices.priceVersionId,
      price: s.digitalPriceVersions.sellPrice,
    })
    .from(s.digitalCurrentPrices)
    .innerJoin(
      s.digitalPriceVersions,
      eq(s.digitalCurrentPrices.priceVersionId, s.digitalPriceVersions.id),
    )
    .where(eq(s.digitalCurrentPrices.branchId, branchId));
  return new Map(
    rows.map((r) => [
      Number(r.offeringId),
      { pv: Number(r.pv), price: r.price },
    ]),
  );
}

let seq = 0;
async function sell(
  offerings: { offeringId: number; priced: { pv: number; price: string } }[],
) {
  const id = ++seq;
  const r = await withTx((tx) =>
    intentService.prepare(
      tx,
      {
        clientRequestId: `p-${id}-${Math.random().toString(36).slice(2, 9)}`,
        branchId: 1,
        shiftId: 1,
        paymentMethod: "CASH",
        cartFingerprint: `fp${id}`,
        lines: offerings.map((o, i) => ({
          lineKey: `lk-${id}-${i}`,
          offeringId: o.offeringId,
          priceVersionId: o.priced.pv,
          expectedSellPrice: o.priced.price,
          providerReference: `REF-DASH-${id}-${i}`,
        })),
      },
      actor,
    ),
  );
  const items = await db()
    .select()
    .from(s.digitalSaleIntentItems)
    .where(eq(s.digitalSaleIntentItems.intentId, r.intentId));
  for (const it of items) {
    await withTx(async (tx) => {
      const claimToken = `dashboard-claim-${id}-${it.id}`;
      await intentService.claimExecution(
        tx,
        { intentId: r.intentId, intentItemId: Number(it.id), claimToken },
        actor,
      );
      return intentService.markExecution(
        tx,
        {
          intentId: r.intentId,
          intentItemId: Number(it.id),
          claimToken,
          status: "SUCCESS",
          providerReference: it.providerReference,
        },
        actor,
      );
    });
  }
  const total = offerings.reduce((a, o) => a + Number(o.priced.price), 0);
  return withTx((tx) =>
    finalizeService.finalize(
      tx,
      {
        intentId: r.intentId,
        clientRequestId: `f-${id}-${Math.random().toString(36).slice(2, 9)}`,
        paymentAmount: total.toFixed(2),
        paymentMethod: "CASH",
      },
      actor,
    ),
  );
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

const january = scope({ from: "2026-01-01", to: "2026-02-01" });
const february = scope({ from: "2026-02-01", to: "2026-03-01" });

async function originalSale(mode: "PREPAID" | "POSTPAID", cards = 1) {
  const provider = await mkProvider("مزود التقرير", mode);
  const walletId =
    mode === "PREPAID" ? await mkWallet(provider.providerId, "1000000") : null;
  const offeringId = await mkOffering(
    provider.providerId,
    "كرت التقرير",
    walletId,
  );
  const prices = await publish(provider.providerId, 1, [
    { offeringId, providerShare: "1000" },
  ]);
  const sale = await sell(
    Array.from({ length: cards }, () => ({
      offeringId,
      priced: prices.get(offeringId)!,
    })),
  );
  await db()
    .update(s.invoices)
    .set({ createdAt: new Date("2026-01-15T12:00:00Z") })
    .where(eq(s.invoices.id, sale.invoiceId));
  const details = await db()
    .select()
    .from(s.digitalSaleDetails)
    .where(eq(s.digitalSaleDetails.invoiceId, sale.invoiceId));
  return {
    invoiceId: sale.invoiceId,
    detail: details[0]!,
    details,
    offeringId,
  };
}

async function refundEvent(
  detailId: number,
  outcome: "REVERSAL" | "LOSS_REFUND",
  occurredAt: string | null,
) {
  await db()
    .execute(sql`INSERT INTO digitalRefundItems (detailId, refundOutcome, revenue, cost, occurredAt)
    VALUES (${detailId}, ${outcome}, '-1850.00', ${outcome === "REVERSAL" ? "-1000.00" : "0.00"}, ${occurredAt})`);
  await db()
    .update(s.digitalSaleDetails)
    .set({
      fulfillmentStatus: outcome === "REVERSAL" ? "REVERSED" : "LOSS_REFUND",
    })
    .where(eq(s.digitalSaleDetails.id, detailId));
}

describe("digital reports use financial movement dates", () => {
  it.each(["PREPAID", "POSTPAID"] as const)(
    "keeps the sale month stable after a later %s reversal",
    async (mode) => {
      const sale = await originalSale(mode);
      const before = await dashboardService.summary(db(), january);
      await refundEvent(sale.detail.id, "REVERSAL", "2026-02-01 00:00:00");
      expect(await dashboardService.summary(db(), january)).toEqual(before);
      expect(await dashboardService.summary(db(), february)).toMatchObject({
        cards: -1,
        sales: "-1850.00",
        grossSales: "0.00",
        refunds: "-1850.00",
        providerShare: "-1000.00",
        profit: "-850.00",
        byMode: [
          expect.objectContaining({
            settlementMode: mode,
            sales: "-1850.00",
            profit: "-850.00",
          }),
        ],
      });
      expect(await dashboardService.topOfferings(db(), february)).toEqual([
        expect.objectContaining({
          offeringId: sale.offeringId,
          sales: "-1850.00",
          profit: "-850.00",
        }),
      ]);
    },
  );

  it.each(["PREPAID", "POSTPAID"] as const)(
    "keeps original cost in the sale month for a later %s loss refund",
    async (mode) => {
      const sale = await originalSale(mode);
      await refundEvent(sale.detail.id, "LOSS_REFUND", "2026-02-15 12:00:00");
      expect(await dashboardService.summary(db(), january)).toMatchObject({
        sales: "1850.00",
        providerShare: "1000.00",
        profit: "850.00",
      });
      expect(await dashboardService.summary(db(), february)).toMatchObject({
        sales: "-1850.00",
        providerShare: "0.00",
        profit: "-1850.00",
      });
      expect(
        await dashboardService.summary(
          db(),
          scope({ from: "2026-01-01", to: "2026-03-01" }),
        ),
      ).toMatchObject({
        sales: "0.00",
        providerShare: "1000.00",
        profit: "-1000.00",
      });
    },
  );

  it("uses half-open UTC event dates, the original invoice branch, and hides all costs", async () => {
    const sale = await originalSale("PREPAID");
    await refundEvent(sale.detail.id, "REVERSAL", "2026-03-01 00:00:00");
    expect(await dashboardService.summary(db(), february)).toMatchObject({
      sales: "0.00",
    });
    const march = scope({
      from: "2026-03-01",
      to: "2026-04-01",
      includeCost: false,
    });
    const report = await dashboardService.summary(db(), march);
    expect(report).toMatchObject({
      sales: "-1850.00",
      providerShare: null,
      profit: null,
      byMode: [expect.objectContaining({ providerShare: null, profit: null })],
    });
    expect(await dashboardService.topOfferings(db(), march)).toEqual([
      expect.objectContaining({ profit: null }),
    ]);
    expect(
      await dashboardService.summary(db(), { ...march, branchId: 2 }),
    ).toMatchObject({ sales: "0.00", byMode: [] });
    expect(
      await dashboardService.summary(db(), { ...march, branchId: null }),
    ).toMatchObject({ sales: "-1850.00" });
  });

  it("does not report a reserved external refund as a completed event", async () => {
    const sale = await originalSale("POSTPAID");
    await refundEvent(sale.detail.id, "REVERSAL", null);
    expect(await dashboardService.summary(db(), february)).toMatchObject({
      sales: "0.00",
    });
    expect(await dashboardService.summary(db(), january)).toMatchObject({
      sales: "1850.00",
    });
  });

  it("shows legacy ledger returns on their entry date in an explicit unallocated bucket", async () => {
    const sale = await originalSale("POSTPAID");
    await db()
      .update(s.digitalSaleDetails)
      .set({ fulfillmentStatus: "REVERSED" })
      .where(eq(s.digitalSaleDetails.id, sale.detail.id));
    await db()
      .insert(s.accountingEntries)
      .values({
        invoiceId: sale.invoiceId,
        branchId: 1,
        entryType: "RETURN",
        entryDate: new Date("2026-02-10T00:00:00Z"),
        createdAt: new Date("2026-03-01T00:00:00Z"),
        revenue: "-1850",
        cost: "-1000",
        profit: "-850",
        amount: "-1850",
        dedupeKey: `DIGITAL:REV:${sale.invoiceId}:REVERSED:3:old-receipt`,
      });
    expect(await dashboardService.summary(db(), january)).toMatchObject({
      sales: "1850.00",
    });
    expect(await dashboardService.summary(db(), february)).toMatchObject({
      sales: "-1850.00",
      providerShare: "-1000.00",
      profit: "-850.00",
      byMode: [],
      legacyAdjustment: expect.objectContaining({
        sales: "-1850.00",
        providerShare: "-1000.00",
        profit: "-850.00",
        allocation: "UNALLOCATED_LEGACY",
      }),
    });
  });
  it("subtracts completed allocations once and leaves only the legacy residual", async () => {
    const sale = await originalSale("POSTPAID", 2);
    await refundEvent(sale.detail.id, "REVERSAL", "2026-02-10 23:59:59");
    await db()
      .insert(s.accountingEntries)
      .values({
        invoiceId: sale.invoiceId,
        branchId: 1,
        entryType: "RETURN",
        entryDate: new Date("2026-02-10T00:00:00Z"),
        revenue: "-1850",
        cost: "-1000",
        profit: "-850",
        amount: "-1850",
        dedupeKey: `DIGITAL:REV:${sale.invoiceId}:REVERSED:3:${sale.detail.id}`,
      });
    const allocated = await dashboardService.summary(db(), february);
    expect(allocated).toMatchObject({
      sales: "-1850.00",
      countsComplete: true,
      legacyAdjustment: { sales: "0.00" },
    });
    await db()
      .update(s.digitalSaleDetails)
      .set({ fulfillmentStatus: "REVERSED" })
      .where(eq(s.digitalSaleDetails.id, sale.details[1]!.id));
    await db()
      .insert(s.accountingEntries)
      .values({
        invoiceId: sale.invoiceId,
        branchId: 1,
        entryType: "RETURN",
        entryDate: new Date("2026-02-10T00:00:00Z"),
        revenue: "-1850",
        cost: "-1000",
        profit: "-850",
        amount: "-1850",
        dedupeKey: `DIGITAL:REV:${sale.invoiceId}:REVERSED:3:legacy-other-receipt`,
      });
    expect(await dashboardService.summary(db(), february)).toMatchObject({
      sales: "-3700.00",
      providerShare: "-2000.00",
      profit: "-1700.00",
      countsComplete: false,
      byMode: [expect.objectContaining({ sales: "-1850.00" })],
      legacyAdjustment: { sales: "-1850.00" },
    });
    expect(
      await dashboardService.summary(db(), { ...february, includeCost: false }),
    ).toMatchObject({
      providerShare: null,
      profit: null,
      legacyAdjustment: { providerShare: null, profit: null },
    });
  });
});
