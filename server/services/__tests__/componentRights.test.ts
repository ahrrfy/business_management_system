import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  aftercareCases,
  aftercareLines,
  aftercareSettlements,
} from "../../../drizzle/fulfillmentSchema";
import { componentRightsAdjustments } from "../../../drizzle/fulfillmentRightsSchema";
import { getDb } from "../../db";
import { reportsRouter } from "../../routers/reportsRouter";
import type { TrpcContext } from "../../context";
import { applyMovement } from "../inventoryService";
import { withTx } from "../tx";
import {
  postComponentRights,
  assertComponentRightsClosedTx,
  confirmComponentRightsRefund,
} from "../fulfillment/componentRights";
import {
  rightsAbsorbedAmount,
  rightsAdjustedComponentQuantity,
} from "../fulfillment/componentRightsPolicy";
import { returnSale } from "../returnService";
import { reverseInvoiceSaleInTx } from "../reversal/invoiceReversal";
import { reserveExternalRefundConfirmationTx } from "../externalRefundConfirmation";
import { getTopProducts } from "../reports/salesAnalytics";
import { getSalesRegister } from "../reportsSalesService";
import { todayUtcDate } from "../businessDay";
import { lockAftercareSourceTx } from "../fulfillment/aftercareSources";
import { validateAftercareSourceRightsTx } from "../fulfillment/componentRightsValuation";

const actor = { userId: 2, branchId: 1, role: "admin" };
const db = () => getDb()!;
const key = () => randomUUID();
let movementId: number;
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "المتجر", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "rights-maker",
        name: "الطالب",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "rights-checker",
        name: "المراجع",
        role: "admin",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل البكج",
    phone: "07700000000",
    currentBalance: "0",
  });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "مكوّن أ" },
      { id: 2, name: "مكوّن ب" },
      { id: 10, name: "البكج", isBundle: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "RIGHT-A", costPrice: "150" },
      { id: 2, productId: 2, sku: "RIGHT-B", costPrice: "200" },
      { id: 10, productId: 10, sku: "RIGHT-PACK", costPrice: "0" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { branchId: 1, variantId: 1, quantity: 10 },
      { branchId: 1, variantId: 2, quantity: 10 },
    ]);
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "RIGHTS-1",
    sourceType: "POS",
    branchId: 1,
    customerId: 1,
    subtotal: "10000",
    total: "10000",
    paidAmount: "10000",
    status: "PAID",
    costTotal: "600",
  });
  await db().insert(s.invoiceItems).values({
    id: 1,
    invoiceId: 1,
    variantId: 10,
    quantity: "2",
    baseQuantity: 2,
    unitPrice: "5000",
    total: "10000",
    unitCost: "300",
    lineCost: "600",
  });
  await db()
    .insert(s.invoiceItemBundleComponents)
    .values([
      {
        id: 1,
        invoiceItemId: 1,
        componentVariantId: 1,
        componentBaseQuantity: 1,
        issueUnitCost: "100",
        issueLineCost: "200",
      },
      {
        id: 2,
        invoiceItemId: 1,
        componentVariantId: 2,
        componentBaseQuantity: 1,
        issueUnitCost: "200",
        issueLineCost: "400",
      },
    ]);
  movementId = (
    await withTx((tx) =>
      applyMovement(tx, {
        branchId: 1,
        variantId: 1,
        baseQuantity: 2,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: 1,
        createdBy: 1,
      }),
    )
  ).movementId;
  await withTx((tx) =>
    applyMovement(tx, {
      branchId: 1,
      variantId: 2,
      baseQuantity: 2,
      movementType: "OUT",
      referenceType: "INVOICE",
      referenceId: 1,
      createdBy: 1,
    }),
  );
  await db().insert(s.receipts).values({
    invoiceId: 1,
    branchId: 1,
    direction: "IN",
    amount: "10000",
    paymentMethod: "CARD",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 1,
  });
  const [originalInvoice] = await db()
    .select({ invoiceDate: s.invoices.invoiceDate })
    .from(s.invoices)
    .where(eq(s.invoices.id, 1))
    .limit(1);
  if (!originalInvoice)
    throw new Error("Original source invoice fixture is missing");
  await db().insert(s.accountingEntries).values({
    entryType: "SALE",
    branchId: 1,
    invoiceId: 1,
    entryDate: originalInvoice.invoiceDate,
    customerId: 1,
    createdBy: 1,
    amount: "10000",
    revenue: "10000",
    cost: "600",
    profit: "9400",
    dedupeKey: "SALE:1",
  });
  await db()
    .insert(aftercareCases)
    .values({
      id: 1,
      caseNumber: "AC-RIGHT-1",
      branchId: 1,
      invoiceId: 1,
      customerId: 1,
      status: "IN_PROGRESS",
      reason: "قطعة بقيت بالمتجر",
      evidence: "محضر وجود فعلي",
      createdBy: 1,
      approvedBy: 2,
      approvedAt: new Date(),
      clientRequestId: key(),
      sourceHash: "a".repeat(64),
    });
  await db().insert(aftercareLines).values({
    id: 1,
    caseId: 1,
    originalInvoiceItemId: 1,
    originalBundleComponentId: 1,
    componentVariantId: 1,
    baseQuantity: 1,
    disposition: "MISSING_HELD",
    originalMovementId: movementId,
    settledBaseQuantity: 1,
    heldConfirmedBy: 1,
    heldConfirmedAt: new Date(),
    evidence: "قطعة أصلية مثبتة",
  });
  await db()
    .insert(aftercareSettlements)
    .values({
      id: 1,
      caseId: 1,
      branchId: 1,
      caseVersion: 1,
      status: "POSTED",
      reason: "توقف التعويض",
      evidence: "محضر فحص مستقل",
      decisions: [],
      sourceRights: [
        {
          invoiceItemId: 1,
          originalBundleComponentId: 1,
          componentVariantId: 1,
          baseQuantity: 1,
          originalMovementId: movementId,
          usableBaseQuantity: 1,
          damagedBaseQuantity: 0,
          commercialAmount: "2000",
          originalIssueValue: "100",
          costEvidence: "لقطة تكلفة الصرف الأصلية",
          costEvidenceReference: "invoiceItemBundleComponents:1:issueLineCost",
        },
      ],
      restoredValue: "0",
      previewHash: "b".repeat(64),
      sourceHash: "c".repeat(64),
      createdBy: 1,
      approvedBy: 2,
      approvedAt: new Date(),
      postedBy: 2,
      postedAt: new Date(),
      clientRequestId: key(),
    });
});

const input = () => ({
  settlementId: 1,
  rightIndex: 0,
  clientRequestId: key(),
  refund: {
    amount: "2000",
    method: "CARD" as const,
    reference: "terminal-refund-actual-1",
  },
});
const row = async () =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, 1)))[0]!;
const stock = async (variantId: number) =>
  (
    await db()
      .select()
      .from(s.branchStock)
      .where(
        and(
          eq(s.branchStock.branchId, 1),
          eq(s.branchStock.variantId, variantId),
        ),
      )
  )[0]!.quantity;

describe("source-linked original component rights", () => {
  it("credits one reviewed component, restores original COGS, and replays without a second refund or receipt", async () => {
    const command = input();
    const first = await postComponentRights(command, actor);
    const replay = await postComponentRights(command, actor);
    expect(replay.id).toBe(first.id);
    expect(replay.replay).toBe(true);
    expect((await row()).returnedTotal).toBe("2000.00");
    expect((await row()).paidAmount).toBe("8000.00");
    const item = (
      await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, 1))
    )[0]!;
    expect(item.returnedBaseQuantity).toBe(0);
    expect(await stock(1)).toBe(9);
    expect(await stock(2)).toBe(8);
    const returns = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.invoiceId, 1),
          eq(s.accountingEntries.entryType, "RETURN"),
        ),
      );
    expect(returns).toHaveLength(1);
    expect(returns[0]!.cost).toBe("-100.00");
    expect(await db().select().from(componentRightsAdjustments)).toHaveLength(
      1,
    );
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(1);
    const [product] = await getTopProducts({ by: "revenue" });
    expect(product!.revenue).toBe("8000.00");
    expect(product!.cost).toBe("500.00");
    const date = todayUtcDate();
    const register = await getSalesRegister({ from: date, to: date });
    expect(register.totals.revenue).toBe("8000.00");
    expect(register.totals.cost).toBe("500.00");
    const invoiceReport = await reportsRouter.createCaller({
      req: { headers: {} }, res: {},
      user: { id: actor.userId, role: actor.role, branchId: actor.branchId, isActive: true },
    } as TrpcContext).salesReport({});
    expect(invoiceReport.rows[0]).toMatchObject({ id: 1, costTotal: "600.00",
      netRevenue: "8000.00", netCOGS: "500.00", profit: "7500.00" });
    await withTx((tx) => assertComponentRightsClosedTx(tx, 1));
  });

  it("rejects current-cost substitution and rolls back every financial and stock effect", async () => {
    const [settlement] = await db()
      .select()
      .from(aftercareSettlements)
      .where(eq(aftercareSettlements.id, 1));
    await db()
      .update(aftercareSettlements)
      .set({
        sourceRights: [
          { ...settlement!.sourceRights[0]!, originalIssueValue: "150" },
        ],
      })
      .where(eq(aftercareSettlements.id, 1));
    await expect(postComponentRights(input(), actor)).rejects.toThrow(
      /لقطة صرف المكوّن الأصلية/,
    );
    expect((await row()).returnedTotal).toBe("0.00");
    expect(await stock(1)).toBe(8);
    expect(await db().select().from(componentRightsAdjustments)).toHaveLength(
      0,
    );
  });

  it("subsequent full remaining return never restores or credits that component twice", async () => {
    await postComponentRights(input(), actor);
    await db()
      .update(aftercareCases)
      .set({ status: "RESOLVED" })
      .where(eq(aftercareCases.id, 1));
    await returnSale(
      {
        invoiceId: 1,
        lines: [{ invoiceItemId: 1, baseQuantity: 2 }],
        refund: {
          amount: "8000",
          method: "CARD",
          reference: "terminal-refund-actual-2",
        },
        clientRequestId: key(),
      },
      actor,
    );
    expect((await row()).returnedTotal).toBe("10000.00");
    expect((await row()).paidAmount).toBe("0.00");
    expect(await stock(1)).toBe(10);
    expect(await stock(2)).toBe(10);
    const [sums] = await db()
      .select({
        cost: sql<string>`SUM(${s.accountingEntries.cost})`,
        amount: sql<string>`SUM(${s.accountingEntries.amount})`,
      })
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.invoiceId, 1),
          eq(s.accountingEntries.entryType, "RETURN"),
        ),
      );
    expect(sums!.cost).toBe("-600.00");
    expect(sums!.amount).toBe("-10000.00");
  });

  it("keeps line reports equal to actual component and partial remaining return cost", async () => {
    await postComponentRights(input(), actor);
    await db()
      .update(aftercareCases)
      .set({ status: "RESOLVED" })
      .where(eq(aftercareCases.id, 1));
    await returnSale(
      {
        invoiceId: 1,
        lines: [{ invoiceItemId: 1, baseQuantity: 1 }],
        refund: {
          amount: "4000",
          method: "CARD",
          reference: "partial-original-refund",
        },
        clientRequestId: key(),
      },
      actor,
    );
    expect((await row()).returnedTotal).toBe("6000.00");
    expect(await stock(1)).toBe(10);
    expect(await stock(2)).toBe(9);
    const [product] = await getTopProducts({ by: "revenue" });
    expect(product!.revenue).toBe("4000.00");
    expect(product!.cost).toBe("200.00");
    await returnSale(
      {
        invoiceId: 1,
        lines: [{ invoiceItemId: 1, baseQuantity: 1 }],
        refund: {
          amount: "4000",
          method: "CARD",
          reference: "final-original-refund",
        },
        clientRequestId: key(),
      },
      actor,
    );
    expect((await row()).returnedTotal).toBe("10000.00");
    expect(await stock(1)).toBe(10);
    expect(await stock(2)).toBe(10);
    const date = todayUtcDate();
    expect((await getSalesRegister({ from: date, to: date })).totals.cost).toBe(
      "0.00",
    );
  });

  it("rejects invalid valuation before physical settlement can be posted", async () => {
    const [settlement] = await db()
      .select()
      .from(aftercareSettlements)
      .where(eq(aftercareSettlements.id, 1));
    await expect(
      withTx(async (tx) => {
        const source = await lockAftercareSourceTx(tx, { invoiceId: 1 }, actor);
        await validateAftercareSourceRightsTx(
          tx,
          {
            source,
            rights: [
              { ...settlement!.sourceRights[0]!, originalIssueValue: "150" },
            ],
            excludingSettlementId: 1,
          },
          actor,
        );
      }),
    ).rejects.toThrow(/لقطة صرف/);
    expect(await stock(1)).toBe(8);
    expect((await row()).returnedTotal).toBe("0.00");
  });

  it("rejects a WORKORDER/WIP countercase before any component inventory return", async () => {
    await db()
      .update(s.invoices)
      .set({ sourceType: "WORKORDER" })
      .where(eq(s.invoices.id, 1));
    const [settlement] = await db()
      .select()
      .from(aftercareSettlements)
      .where(eq(aftercareSettlements.id, 1));
    await expect(
      withTx(async (tx) => {
        const source = await lockAftercareSourceTx(tx, { invoiceId: 1 }, actor);
        await validateAftercareSourceRightsTx(
          tx,
          {
            source,
            rights: settlement!.sourceRights,
            excludingSettlementId: 1,
          },
          actor,
        );
      }),
    ).rejects.toThrow(/WIP/);
    expect(await stock(1)).toBe(8);
    expect((await row()).returnedTotal).toBe("0.00");
    expect(await db().select().from(componentRightsAdjustments)).toHaveLength(
      0,
    );
  });

  it("keeps actual transfer refund pending until its original receipt executes", async () => {
    await db()
      .update(s.receipts)
      .set({ paymentMethod: "TRANSFER" })
      .where(eq(s.receipts.direction, "IN"));
    await postComponentRights(
      { ...input(), refund: { amount: "2000", method: "TRANSFER" } },
      actor,
    );
    await expect(
      withTx((tx) => assertComponentRightsClosedTx(tx, 1)),
    ).rejects.toThrow(/لم يُنفّذ فعلياً/);
    expect((await row()).paidAmount).toBe("10000.00");
    expect((await row()).returnedTotal).toBe("2000.00");
  });

  it("prevents cancellation from silently reversing an already settled component", async () => {
    await postComponentRights(input(), actor);
    await expect(
      withTx((tx) =>
        reverseInvoiceSaleInTx(
          tx,
          { invoiceId: 1, flavor: "CANCEL", reason: "محاولة إلغاء" },
          actor,
        ),
      ),
    ).rejects.toThrow(/للأجزاء المتبقية/);
  });

  it("splits original CARD/CASH refund once, reserves provider proof globally, and waits for actual CARD execution", async () => {
    await db()
      .update(s.invoices)
      .set({
        subtotal: "2000",
        total: "2000",
        paidAmount: "2000",
        paymentMethod: "MIXED",
      })
      .where(eq(s.invoices.id, 1));
    await db()
      .update(s.invoiceItems)
      .set({ total: "2000", unitPrice: "1000" })
      .where(eq(s.invoiceItems.id, 1));
    await db()
      .update(s.accountingEntries)
      .set({ amount: "2000", revenue: "2000", profit: "1400" })
      .where(eq(s.accountingEntries.entryType, "SALE"));
    await db()
      .update(s.receipts)
      .set({ amount: "1000" })
      .where(eq(s.receipts.direction, "IN"));
    await db().insert(s.shifts).values({
      id: 1,
      branchId: 1,
      userId: 2,
      openingBalance: "0",
      status: "OPEN",
    });
    await db().insert(s.receipts).values({
      invoiceId: 1,
      branchId: 1,
      shiftId: 1,
      cashBucket: "DRAWER",
      direction: "IN",
      amount: "1000",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 2,
    });
    const command = {
      settlementId: 1,
      rightIndex: 0,
      clientRequestId: key(),
      refunds: [
        { amount: "1000", method: "CARD" as const, pendingExternal: true },
        { amount: "1000", method: "CASH" as const, shiftId: 1 },
      ],
    };
    await postComponentRights(command, actor);
    await postComponentRights(command, actor);
    const refunds = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(refunds).toHaveLength(2);
    const card = refunds.find((receipt) => receipt.paymentMethod === "CARD")!;
    expect(card.status).toBe("PENDING");
    expect(
      refunds.find((receipt) => receipt.paymentMethod === "CASH")!.status,
    ).toBe("COMPLETED");
    expect((await row()).returnedTotal).toBe("2000.00");
    expect((await row()).paidAmount).toBe("1000.00");
    expect(await stock(1)).toBe(9);
    await expect(
      withTx((tx) => assertComponentRightsClosedTx(tx, 1)),
    ).rejects.toThrow(/لم يُنفّذ فعلياً/);
    await withTx((tx) =>
      reserveExternalRefundConfirmationTx(tx, {
        receiptId: 999,
        method: "CARD",
        reference: "OTHER-FLOW-PROOF",
      }),
    );
    await expect(
      confirmComponentRightsRefund(
        {
          receiptId: card.id,
          reference: "other-flow-proof",
          clientRequestId: key(),
        },
        actor,
      ),
    ).rejects.toThrow();
    expect((await row()).paidAmount).toBe("1000.00");
    const proof = {
      receiptId: card.id,
      reference: "actual-card-refund-split",
      clientRequestId: key(),
    };
    await confirmComponentRightsRefund(proof, actor);
    await confirmComponentRightsRefund(proof, actor);
    expect((await row()).paidAmount).toBe("0.00");
    expect((await row()).returnedTotal).toBe("2000.00");
    expect(await stock(1)).toBe(9);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "RETURN")),
    ).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT")),
    ).toHaveLength(2);
    await withTx((tx) => assertComponentRightsClosedTx(tx, 1));
  });
});

describe("component rights remaining allocation", () => {
  it("absorbs a prior commercial credit exactly once across successive ordinary returns", () => {
    expect(rightsAbsorbedAmount("2000", 3, 0, 0, 1).toFixed(2)).toBe("666.67");
    expect(rightsAbsorbedAmount("2000", 3, 0, 1, 1).toFixed(2)).toBe("666.66");
    expect(rightsAbsorbedAmount("2000", 3, 0, 2, 1).toFixed(2)).toBe("666.67");
    expect(rightsAdjustedComponentQuantity(1, 2, 0, 1, 1)).toBe(1);
    expect(rightsAdjustedComponentQuantity(1, 2, 1, 1, 1)).toBe(0);
  });
});
