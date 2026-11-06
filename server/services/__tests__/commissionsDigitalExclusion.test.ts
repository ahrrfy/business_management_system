import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeNetSalesByUser } from "../commissions/base";
import { computeCommissionRun } from "../commissions/engine";
import { assignPlan, createPlan } from "../commissions/plans";
import { approveRun, getRun } from "../commissions/runs";
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
import { returnSaleInTx } from "../returnService";
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
    amount: "1000000",
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

async function base() {
  return (await computeNetSalesByUser(db(), PERIOD, 1)).get(1)!;
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

describe("digital-card commission exclusion", () => {
  it.each(["PREPAID", "POSTPAID"] as const)(
    "mixed %s keeps only ordinary net sales",
    async (mode) => {
      await sale(mode);
      const actual = await base();
      expect(toDbMoney(actual.sales)).toBe("3000.00");
      expect(toDbMoney(actual.consigDeduction)).toBe("0.00");
      expect(toDbMoney(actual.returns)).toBe("0.00");
    },
  );

  it.each(["PREPAID", "POSTPAID"] as const)(
    "digital-only %s sale and reversal leave zero commission and carry",
    async (mode) => {
      const sold = await sale(mode, false);
      await withTx((tx) =>
        reversalService.approveReversal(
          tx,
          {
            ...sold,
            reason: "Synthetic digital-only reversal",
          },
          manager,
        ),
      );
      await stampEntries(sold.invoiceId);
      const actual = await base();
      expect(toDbMoney(actual.sales)).toBe("0.00");
      expect(toDbMoney(actual.returns)).toBe("0.00");
      expect(toDbMoney(actual.consigDeduction)).toBe("0.00");
      await plan();
      const run = await computeCommissionRun(PERIOD, manager);
      expect((await getRun(run.runId))!.lines[0]).toMatchObject({
        effectiveBase: "0.00",
        commissionAmount: "0.00",
        carryOut: "0.00",
      });
    },
  );

  it("aggregates multiple digital details before applying original attribution shares and scope", async () => {
    const { invoiceId } = await sale("POSTPAID", true, 2);
    await db()
      .delete(s.invoiceAttributions)
      .where(eq(s.invoiceAttributions.invoiceId, invoiceId));
    await db()
      .insert(s.invoiceAttributions)
      .values([
        {
          invoiceId,
          branchId: 1,
          userId: 1,
          role: "CASHIER",
          sharePct: "0.2500",
          attributionMode: "SPLIT",
          creditedBaseAmount: "7875",
        },
        {
          invoiceId,
          branchId: 1,
          userId: 2,
          role: "FLOOR_REP",
          sharePct: "0.7500",
          attributionMode: "SPLIT",
          creditedBaseAmount: "23625",
        },
      ]);
    const actual = await computeNetSalesByUser(db(), PERIOD, 1);
    expect(toDbMoney(actual.get(1)!.sales)).toBe("750.00");
    expect(toDbMoney(actual.get(2)!.sales)).toBe("2250.00");
    expect(await computeNetSalesByUser(db(), PERIOD, 2)).toEqual(new Map());
    const scoped = await computeNetSalesByUser(db(), PERIOD, 1, 2);
    expect(Array.from(scoped.keys())).toEqual([2]);
    expect(toDbMoney(scoped.get(2)!.sales)).toBe("2250.00");
  });

  it.each(["REVERSED", "LOSS_REFUND"] as const)(
    "digital %s adds no return or negative carry; goods return still removes goods",
    async (kind) => {
      const sold = await sale("POSTPAID");
      if (kind === "REVERSED")
        await withTx((tx) =>
          reversalService.approveReversal(
            tx,
            {
              ...sold,
              reason: "Synthetic provider reversal",
            },
            manager,
          ),
        );
      else {
        await withTx((tx) =>
          reversalService.requestLossRefund(
            tx,
            { ...sold, reason: "Synthetic loss" },
            manager,
          ),
        );
        await withTx((tx) =>
          reversalService.lossRefund(tx, { ...sold }, approver),
        );
      }
      await stampEntries(sold.invoiceId);
      expect(toDbMoney((await base()).returns)).toBe("0.00");
      const goods = (
        await db()
          .select()
          .from(s.invoiceItems)
          .where(eq(s.invoiceItems.invoiceId, sold.invoiceId))
      ).find((item) => item.variantId === 1)!;
      await withTx((tx) =>
        returnSaleInTx(
          tx,
          {
            invoiceId: sold.invoiceId,
            lines: [{ invoiceItemId: Number(goods.id), baseQuantity: 1 }],
            restock: true,
            resolution: {
              kind: "IMMEDIATE_REFUND",
              method: "CASH",
              amount: "3000",
              reason: "Synthetic ordinary goods return",
              disposition: "RESTOCK",
            },
          },
          manager,
        ),
      );
      await stampEntries(sold.invoiceId);
      const actual = await base();
      expect(
        toDbMoney(
          actual.sales.minus(actual.returns).minus(actual.consigDeduction),
        ),
      ).toBe("0.00");
      await plan();
      const run = await computeCommissionRun(PERIOD, manager);
      const stored = await getRun(run.runId);
      expect(stored!.lines[0]).toMatchObject({
        effectiveBase: "0.00",
        carryOut: "0.00",
      });
    },
  );

  it("preserves real consignment margin and legacy NULL-profile return deductions", async () => {
    await db()
      .insert(s.suppliers)
      .values({ id: 2, name: "Actual consignor", supplierKind: "CONSIGNOR" });
    await db()
      .update(s.products)
      .set({ isConsignment: true, consignorId: 2 })
      .where(eq(s.products.id, 1));
    await db()
      .update(s.productVariants)
      .set({ costPrice: "2000" })
      .where(eq(s.productVariants.id, 1));
    const { invoiceId } = await sale("POSTPAID");
    expect(
      toDbMoney((await base()).sales.minus((await base()).consigDeduction)),
    ).toBe("1000.00");
    await db().insert(s.accountingEntries).values({
      entryType: "PURCHASE",
      invoiceId,
      branchId: 1,
      supplierId: 2,
      amount: "-2000",
      cost: "-2000",
      notes: "عكس استحقاق أمانة — مرتجع",
      entryDate: DATE,
    });
    expect(toDbMoney((await base()).consigDeduction)).toBe("0.00");
  });

  it("recomputes an unpaid draft while keeping approved history and journals unchanged", async () => {
    await plan();
    const empty = await computeCommissionRun(PERIOD, manager);
    await sale("PREPAID");
    const recomputed = await computeCommissionRun(PERIOD, manager);
    expect(recomputed.runId).toBe(empty.runId);
    const draft = await getRun(recomputed.runId);
    expect(draft!.lines[0]).toMatchObject({
      baseSales: "3000.00",
      effectiveBase: "3000.00",
      commissionAmount: "300.00",
    });
    await approveRun(recomputed.runId, approver);
    const approved = await getRun(recomputed.runId);
    const entries = await db().select().from(s.accountingEntries);
    await expect(computeCommissionRun(PERIOD, manager)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await getRun(recomputed.runId)).toEqual(approved);
    expect(await db().select().from(s.accountingEntries)).toEqual(entries);
  });
});
