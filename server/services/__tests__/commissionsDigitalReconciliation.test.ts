import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeCommissionRun } from "../commissions/engine";
import { assignPlan, createPlan } from "../commissions/plans";
import { approveRun } from "../commissions/runs";
import {
  finalizeService,
  intentService,
  offeringService,
  pricingService,
  providerService,
  reversalService,
  walletService,
} from "../digitalCards";
import { prepareCheckoutSnapshot } from "../digitalCards/mixedCartService";
import { reserveIntentInventory } from "../digitalCards/inventoryReservationService";
import { reviewDigitalCommissionDifferences } from "../commissions/digitalReconciliation";
import {
  approveRun as approvePayroll,
  generatePayroll,
  payRun,
} from "../payrollService";
import { withTx } from "../tx";
import { money, toDbMoney } from "../money";

const cashier = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const approver = { userId: 3, branchId: 1, role: "admin" };
const PERIOD = "2026-06";
const DATE = new Date("2026-06-10T00:00:00Z");
function db() {
  const value = getDb();
  if (!value) throw new Error("Missing isolated test DB");
  return value;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Other", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values(
      [cashier, manager, approver].map((actor) => ({
        id: actor.userId,
        openId: `commission-digital-${actor.userId}`,
        name: `Actor ${actor.userId}`,
        branchId: actor.branchId,
        role: actor.role as "cashier" | "manager" | "admin",
        isOwner: actor.userId === 3,
      })),
    );
  await db().insert(s.employees).values({
    id: 1,
    userId: 1,
    branchId: 1,
    firstName: "Seller",
    lastName: "Test",
    payType: "monthly",
    salary: "1000000",
  });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    status: "OPEN",
    openingBalance: "1000000",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "2000000",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 3,
  });
  await db().insert(s.products).values({ id: 1, name: "Ordinary goods" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "COMMISSION-GOODS",
    costPrice: "1000",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "3000" });
  await db()
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 100 });
  await db().insert(s.suppliers).values({ id: 1, name: "Digital supplier" });
});

async function stampEntries(invoiceId: number) {
  await db()
    .update(s.accountingEntries)
    .set({ entryDate: DATE })
    .where(eq(s.accountingEntries.invoiceId, invoiceId));
}

/** Real issuance/finalize path; mixed checkout is persisted at its documented seam. */
async function sale(
  settlementMode: "PREPAID" | "POSTPAID",
  regular = true,
  cards = 1,
) {
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId: 1,
        providerType: "TELECOM",
        settlementMode,
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      manager,
    ),
  );
  let walletId: number | null = null;
  if (settlementMode === "PREPAID") {
    ({ walletId } = await withTx((tx) =>
      walletService.createWallet(
        tx,
        {
          providerId,
          branchId: 1,
          code: "COMMISSION",
          name: "Commission test wallet",
        },
        manager,
      ),
    ));
    await db()
      .update(s.digitalWallets)
      .set({ currentBalance: "100000" })
      .where(eq(s.digitalWallets.id, walletId));
  }
  const { offeringId } = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "TELECOM_CARD",
        name: "Card",
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "850",
        roundingStep: "0",
        branches: [{ branchId: 1, walletId }],
      },
      manager,
    ),
  );
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      {
        branchId: 1,
        providerId,
        businessDate: "2026-06-10",
      },
      manager,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      {
        batchId,
        lines: [{ offeringId, providerShare: "13400" }],
      },
      manager,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, manager));
  const [current] = await db()
    .select()
    .from(s.digitalCurrentPrices)
    .where(eq(s.digitalCurrentPrices.offeringId, offeringId));
  const { intentId } = await withTx((tx) =>
    intentService.prepare(
      tx,
      {
        clientRequestId: "commission-digital",
        branchId: 1,
        shiftId: 1,
        paymentMethod: "CASH",
        cartFingerprint: "commission-digital",
        lines: Array.from({ length: cards }, (_, i) => ({
          lineKey: `card-${i}`,
          offeringId,
          priceVersionId: Number(current.priceVersionId),
          expectedSellPrice: "14250",
          providerReference: `COMMISSION-${i}`,
        })),
      },
      cashier,
    ),
  );
  if (regular) {
    const snapshot = await withTx((tx) =>
      prepareCheckoutSnapshot(
        tx,
        {
          regularLines: [
            {
              lineKey: "ordinary",
              variantId: 1,
              productUnitId: 1,
              quantity: "1",
            },
          ],
        },
        cashier,
      ),
    );
    await withTx(async (tx) => {
      await tx
        .update(s.digitalSaleIntents)
        .set({
          checkoutSnapshot: snapshot,
          expectedTotal: toDbMoney(
            money("14250").times(cards).plus(snapshot.expectedSubtotal),
          ),
        })
        .where(eq(s.digitalSaleIntents.id, intentId));
      await reserveIntentInventory(tx, { intentId, branchId: 1, snapshot });
    });
  }
  const items = await db()
    .select()
    .from(s.digitalSaleIntentItems)
    .where(eq(s.digitalSaleIntentItems.intentId, intentId));
  for (const item of items)
    await withTx(async (tx) => {
      const claimToken = `commission-${item.id}`;
      await intentService.claimExecution(
        tx,
        { intentId, intentItemId: Number(item.id), claimToken },
        cashier,
      );
      await intentService.markExecution(
        tx,
        {
          intentId,
          intentItemId: Number(item.id),
          claimToken,
          status: "SUCCESS",
          providerReference: item.providerReference,
        },
        cashier,
      );
    });
  const result = await withTx((tx) =>
    finalizeService.finalize(
      tx,
      {
        intentId,
        clientRequestId: "commission-finalize",
        paymentMethod: "CASH",
        paymentAmount: toDbMoney(
          money("14250")
            .times(cards)
            .plus(regular ? "3000" : "0"),
        ),
      },
      cashier,
    ),
  );
  await stampEntries(result.invoiceId);
  const details = await db()
    .select()
    .from(s.digitalSaleDetails)
    .where(eq(s.digitalSaleDetails.invoiceId, result.invoiceId));
  return {
    invoiceId: result.invoiceId,
    detailIds: details.map((d) => Number(d.id)),
  };
}

async function plan() {
  const { planId } = await createPlan(
    {
      name: "Commission test",
      tierMode: "AMOUNT_SLAB",
      tiers: [{ threshold: "0", ratePct: "10", fixedBonus: "0" }],
    },
    manager,
  );
  await assignPlan({ employeeId: 1, planId, effectiveFrom: PERIOD }, manager);
}

async function historicalRun(
  period = PERIOD,
  legacy?: {
    baseSales: string;
    baseReturns: string;
    baseConsignDeduction: string;
    carryIn?: string;
    carryOut?: string;
    effectiveBase: string;
    commissionAmount: string;
  },
) {
  const run = await computeCommissionRun(period, manager);
  // Isolated historical fixture, before canonical approval and payroll capture.
  // Approved/paid rows are never rewritten, even by the fixture.
  if (legacy) {
    await db()
      .update(s.commissionRunLines)
      .set(legacy)
      .where(eq(s.commissionRunLines.runId, run.runId));
    await db()
      .update(s.commissionRuns)
      .set({
        totalBaseSales: legacy.baseSales,
        totalBaseReturns: legacy.baseReturns,
        totalCommission: legacy.commissionAmount,
      })
      .where(eq(s.commissionRuns.id, run.runId));
  }
  await approveRun(run.runId, approver);
  return run.runId;
}

async function frozenState() {
  return {
    runs: await db().select().from(s.commissionRuns),
    lines: await db().select().from(s.commissionRunLines),
    payroll: await db().select().from(s.payrollRuns),
    payrollItems: await db().select().from(s.payrollItems),
    journals: await db().select().from(s.accountingEntries),
    receipts: await db().select().from(s.receipts),
  };
}

const review = (
  period = PERIOD,
  scope: { branchId?: number; userId?: number } = {},
) =>
  reviewDigitalCommissionDifferences(db(), {
    period,
    actorUserId: 3,
    ...scope,
  });

function cli(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL(
          "../../../scripts/digital-commission-reconcile.mts",
          import.meta.url,
        ),
      ),
      ...args,
    ],
    { encoding: "utf8", env },
  );
}

describe("frozen digital commission difference review", () => {
  it.each(["PREPAID", "POSTPAID"] as const)(
    "reviews paid mixed %s snapshots without changing money or carry",
    async (mode) => {
      const sold = await sale(mode);
      await plan();
      const deduction = mode === "POSTPAID" ? "13400.00" : "0.00";
      const oldNet = money("17250").minus(deduction);
      const runId = await historicalRun(PERIOD, {
        baseSales: "17250.00",
        baseReturns: "0.00",
        baseConsignDeduction: deduction,
        effectiveBase: toDbMoney(oldNet),
        commissionAmount: toDbMoney(oldNet.div(10)),
      });
      const payroll = await generatePayroll(PERIOD, manager);
      await approvePayroll(Number(payroll!.id), approver);
      await payRun(Number(payroll!.id), approver);
      // A mutable plan change cannot manufacture a historical payout comparison.
      await db().update(s.commissionPlanTiers).set({ ratePct: "90" });
      const before = await frozenState();
      const report = await review(PERIOD, { branchId: 1, userId: 1 });
      expect(report.scope.baseScope).toBe("COMPANY_WIDE_USER_ACTIVITY");
      expect(report.rows).toHaveLength(1);
      const row = report.rows[0];
      expect(row).toMatchObject({
        runId,
        lineId: before.lines[0].id,
        employeeId: 1,
        userId: 1,
        payrollStatus: "paid",
        paymentEvidence: "LINKED_PAYROLL_PAID",
        original: {
          baseSales: "17250.00",
          baseConsignDeduction: deduction,
          carryIn: "0.00",
          carryOut: "0.00",
          commissionAmount: toDbMoney(oldNet.div(10)),
        },
        current: {
          baseSales: "3000.00",
          baseReturns: "0.00",
          baseConsignDeduction: "0.00",
          netBase: "3000.00",
        },
        delta: {
          baseSales: "-14250.00",
          baseConsignDeduction: toDbMoney(money(deduction).neg()),
          netBase: toDbMoney(money(3000).minus(oldNet)),
        },
        assessment: "BASE_DIFFERENCE_WITH_DIGITAL_SOURCES_REQUIRES_REVIEW",
        payoutDifference: null,
        payoutAssessment: "REQUIRES_REVIEW",
      });
      expect(
        row.digitalSources.find((source) => source.kind === "DIGITAL_SALE"),
      ).toMatchObject({
        invoiceId: sold.invoiceId,
        eventDate: "2026-06-10",
        attributedSourceAmount: "14250.00",
        digitalDetails: [{ id: sold.detailIds[0], settlementMode: mode }],
      });
      if (mode === "PREPAID") {
        const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
        const output = cli([
          "--period",
          PERIOD,
          "--actor-id",
          "3",
          "--database",
          database,
        ]);
        expect(output.stderr).not.toContain("testpw");
        expect(output.status, output.stderr).toBe(0);
        expect(JSON.parse(output.stdout)).toMatchObject({
          target: { host: "127.0.0.1", port: 3311, database },
          rows: [{ lineId: row.lineId }],
        });
      }
      expect(await frozenState()).toEqual(before);
    },
  );

  it("dates digital returns by their later source event and retains frozen negative carry", async () => {
    const sold = await sale("POSTPAID");
    await plan();
    await historicalRun();
    await withTx((tx) =>
      reversalService.approveReversal(
        tx,
        { ...sold, reason: "Later period digital refund" },
        manager,
      ),
    );
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, sold.invoiceId));
    for (const entry of entries.filter(
      (entry) =>
        entry.dedupeKey?.startsWith("DIGITAL:REV:") ||
        entry.dedupeKey?.startsWith("DIGITAL:APREV:"),
    ))
      await db()
        .update(s.accountingEntries)
        .set({ entryDate: new Date("2026-07-01T00:00:00Z") })
        .where(eq(s.accountingEntries.id, entry.id));
    const runId = await historicalRun("2026-07", {
      baseSales: "0.00",
      baseReturns: "14250.00",
      baseConsignDeduction: "-13400.00",
      carryIn: "-50.00",
      carryOut: "-900.00",
      effectiveBase: "0.00",
      commissionAmount: "0.00",
    });
    const before = await frozenState();
    const [row] = (await review("2026-07")).rows;
    expect(row).toMatchObject({
      runId,
      original: {
        carryIn: "-50.00",
        carryOut: "-900.00",
        effectiveBase: "0.00",
      },
      current: { netBase: "0.00" },
      delta: { netBase: "850.00" },
      payoutDifference: null,
    });
    expect(
      row.digitalSources.find((source) => source.kind === "DIGITAL_RETURN"),
    ).toMatchObject({
      invoiceId: sold.invoiceId,
      eventDate: "2026-07-01",
      attributedSourceAmount: "-14250.00",
      detailRelation: "INVOICE_DETAILS_ONLY",
    });
    expect(
      row.digitalSources.every((source) =>
        source.eventDate.startsWith("2026-07"),
      ),
    ).toBe(true);
    expect(
      (await review()).rows[0].digitalSources.every(
        (source) => source.kind !== "DIGITAL_RETURN",
      ),
    ).toBe(true);
    expect(await frozenState()).toEqual(before);
  });

  it("does not label an unchanged digital period as a correction", async () => {
    await sale("PREPAID");
    await plan();
    await historicalRun();
    const [row] = (await review()).rows;
    expect(row.digitalSources.length).toBeGreaterThan(0);
    expect(row).toMatchObject({
      assessment: "UNCHANGED",
      hasBaseDifference: false,
      delta: { netBase: "0.00" },
    });
  });

  it("aggregates digital sources once per event and original beneficiary across multiple cards and roles", async () => {
    const sold = await sale("PREPAID", true, 2);
    await db()
      .delete(s.invoiceAttributions)
      .where(eq(s.invoiceAttributions.invoiceId, sold.invoiceId));
    await db()
      .insert(s.invoiceAttributions)
      .values([
        {
          invoiceId: sold.invoiceId,
          branchId: 1,
          userId: 1,
          role: "CASHIER",
          sharePct: "0.2500",
          attributionMode: "SPLIT",
          creditedBaseAmount: "7875",
        },
        {
          invoiceId: sold.invoiceId,
          branchId: 1,
          userId: 1,
          role: "FLOOR_REP",
          sharePct: "0.2500",
          attributionMode: "SPLIT",
          creditedBaseAmount: "7875",
        },
        {
          invoiceId: sold.invoiceId,
          branchId: 1,
          userId: 2,
          role: "FLOOR_REP",
          sharePct: "0.5000",
          attributionMode: "SPLIT",
          creditedBaseAmount: "15750",
        },
      ]);
    await plan();
    await historicalRun(PERIOD, {
      baseSales: "15750.00",
      baseReturns: "0.00",
      baseConsignDeduction: "0.00",
      effectiveBase: "15750.00",
      commissionAmount: "1575.00",
    });
    const [row] = (await review()).rows;
    expect(row.current.baseSales).toBe("1500.00");
    expect(row.digitalSources).toHaveLength(1);
    expect(row.digitalSources[0]).toMatchObject({
      userId: 1,
      attributionShare: "0.5000",
      attributedSourceAmount: "14250.00",
    });
    expect(
      row.digitalSources[0].digitalDetails.map((detail) => detail.id),
    ).toEqual(sold.detailIds);
  });

  it("ordinary-only home-branch scope preserves company-wide attribution across sale branches", async () => {
    await plan();
    await db()
      .insert(s.invoices)
      .values([
        {
          id: 801,
          invoiceNumber: "CROSS-1",
          sourceType: "POS",
          sourceId: "cross1",
          branchId: 1,
          createdBy: 1,
          subtotal: "3000",
          total: "3000",
        },
        {
          id: 802,
          invoiceNumber: "CROSS-2",
          sourceType: "POS",
          sourceId: "cross2",
          branchId: 2,
          createdBy: 1,
          subtotal: "1000",
          total: "1000",
        },
      ]);
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          invoiceId: 801,
          branchId: 1,
          entryType: "SALE",
          revenue: "3000",
          amount: "3000",
          entryDate: DATE,
        },
        {
          invoiceId: 802,
          branchId: 2,
          entryType: "SALE",
          revenue: "1000",
          amount: "1000",
          entryDate: DATE,
        },
        // Actual consignment retains its margin semantics in the corrected reader.
        {
          invoiceId: 801,
          branchId: 1,
          supplierId: 1,
          entryType: "PURCHASE",
          amount: "500",
          dedupeKey: "CONSIG:801:1",
          entryDate: DATE,
        },
      ]);
    await historicalRun();
    const [row] = (await review(PERIOD, { branchId: 1, userId: 1 })).rows;
    expect(row).toMatchObject({
      original: { netBase: "3500.00" },
      current: {
        baseSales: "4000.00",
        baseConsignDeduction: "500.00",
        netBase: "3500.00",
      },
      assessment: "UNCHANGED",
      digitalSources: [],
    });
    expect((await review(PERIOD, { branchId: 2 })).rows).toEqual([]);
    expect((await review(PERIOD, { userId: 2 })).rows).toEqual([]);
    expect((await review("2026-08")).rows).toEqual([]);
  });

  it("labels other historical differences honestly and excludes unapproved drafts", async () => {
    await plan();
    const draft = await computeCommissionRun(PERIOD, manager);
    expect((await review()).rows).toEqual([]);
    await db()
      .update(s.commissionRunLines)
      .set({ baseSales: "100", effectiveBase: "100", commissionAmount: "10" })
      .where(eq(s.commissionRunLines.runId, draft.runId));
    await approveRun(draft.runId, approver);
    expect((await review()).rows[0]).toMatchObject({
      assessment: "BASE_DIFFERENCE_CAUSE_UNPROVEN",
      digitalSources: [],
      payoutDifference: null,
    });
  });

  it("requires persisted active authority and an explicit valid month/scope", async () => {
    await expect(
      reviewDigitalCommissionDifferences(db(), {
        period: PERIOD,
        actorUserId: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reviewDigitalCommissionDifferences(db(), {
        period: PERIOD,
        actorUserId: 999,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.users).set({ isOwner: true }).where(eq(s.users.id, 1));
    expect(
      (
        await reviewDigitalCommissionDifferences(db(), {
          period: PERIOD,
          actorUserId: 1,
        })
      ).rows,
    ).toEqual([]);
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, 1));
    await expect(
      reviewDigitalCommissionDifferences(db(), {
        period: PERIOD,
        actorUserId: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(review("2026-13")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(review(PERIOD, { branchId: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("CLI rejects write flags, unsafe targets and implicit periods without exposing URLs", () => {
    const secretTarget =
      "mysql://secret-user:secret-password@untrusted.example:3306/erp_test";
    const env = { ...process.env, TEST_DATABASE_URL: secretTarget };
    const output = cli(
      ["--period", PERIOD, "--actor-id", "3", "--database", "erp_test"],
      env,
    );
    expect(output.status).toBe(1);
    expect(output.stderr).toContain("127.0.0.1:3311");
    expect(output.stderr).not.toContain("secret");
    expect(cli(["--apply"], env).status).toBe(1);
    expect(cli(["--actor-id", "3", "--database", "erp_test"], env).status).toBe(
      1,
    );
  });
});
