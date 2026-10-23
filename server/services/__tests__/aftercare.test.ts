import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  aftercareCases,
  aftercareExecutions,
  aftercareExecutionLines,
  aftercareLines,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { applyMovement } from "../inventoryService";
import { withTx } from "../tx";
import { openShift } from "../shiftService";
import { payPartyDeliveryFees } from "../delivery/fees";
import { todayUtcDate } from "../businessDay";
import {
  approveAftercareCase,
  confirmAftercareDelivery,
  createAftercareCase,
  dispatchAftercareExecution,
  payAftercareDeliveryFee,
  prepareAftercareExecution,
  resolveAftercareCase,
} from "../fulfillment/aftercare";
import {
  getAftercareCase,
  previewAftercareSource,
} from "../fulfillment/aftercareQueries";
import { assertNoActiveAftercareForInvoiceTx } from "../fulfillment/aftercareSources";
import {
  assertAftercareAssignmentCancellationTx,
  declareAftercareReturnTx,
  routeAftercareDeliveryResultTx,
} from "../fulfillment/aftercareDelivery";

const MAKER = { userId: 1, branchId: 1, role: "cashier" };
const CHECKER = { userId: 2, branchId: 1, role: "admin" };
const FOREIGN = { userId: 3, branchId: 2, role: "cashier" };
function db() {
  const value = getDb();
  if (!value) throw new Error("isolated test database required");
  return value;
}
const key = () => randomUUID();
let originalMovementId: number;

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الثاني", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "ac-maker", name: "طالب", role: "cashier", branchId: 1 },
      {
        id: 2,
        openId: "ac-checker",
        name: "معتمد",
        role: "admin",
        branchId: 1,
      },
      {
        id: 3,
        openId: "ac-foreign",
        name: "فرع آخر",
        role: "cashier",
        branchId: 2,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل المعالجة",
    phone: "+9647700000000",
    currentBalance: "0.00",
  });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "مكون أصلي" },
      { id: 2, name: "خامة جديدة" },
      { id: 10, name: "بكج أصلي", isBundle: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "AC-ORIGINAL", costPrice: "100.00" },
      { id: 2, productId: 2, sku: "AC-MATERIAL", costPrice: "25.00" },
      { id: 10, productId: 10, sku: "AC-BUNDLE", costPrice: "0.00" },
    ]);
  // Current recipe intentionally differs from the immutable invoice snapshot.
  await db().insert(s.bundleComponents).values({
    bundleVariantId: 10,
    componentVariantId: 2,
    componentBaseQuantity: 9,
  });
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 2, branchId: 1, quantity: 100 },
    ]);
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "AC-ORIGINAL-1",
    sourceType: "POS",
    branchId: 1,
    customerId: 1,
    subtotal: "10000.00",
    total: "10000.00",
    paidAmount: "10000.00",
    status: "PAID",
    costTotal: "600.00",
  });
  await db().insert(s.invoiceItems).values({
    id: 1,
    invoiceId: 1,
    variantId: 10,
    quantity: "2",
    baseQuantity: 2,
    unitPrice: "5000.00",
    total: "10000.00",
    lineCost: "600.00",
  });
  await db().insert(s.invoiceItemBundleComponents).values({
    id: 1,
    invoiceItemId: 1,
    componentVariantId: 1,
    componentBaseQuantity: 3,
  });
  originalMovementId = (
    await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1,
        branchId: 1,
        baseQuantity: 6,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: 1,
        createdBy: 1,
      }),
    )
  ).movementId;
  await db().insert(s.receipts).values({
    invoiceId: 1,
    branchId: 1,
    direction: "IN",
    amount: "10000.00",
    paymentMethod: "CARD",
    status: "COMPLETED",
    createdBy: 1,
  });
  const [originalInvoice] = await db()
    .select({ invoiceDate: s.invoices.invoiceDate })
    .from(s.invoices)
    .where(eq(s.invoices.id, 1))
    .limit(1);
  if (!originalInvoice)
    throw new Error("Original sale invoice fixture is missing");
  await db().insert(s.accountingEntries).values({
    entryType: "SALE",
    branchId: 1,
    invoiceId: 1,
    entryDate: originalInvoice.invoiceDate,
    revenue: "10000.00",
    cost: "600.00",
    profit: "9400.00",
    dedupeKey: "SALE:1",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "ناقل المعالجة",
    partyType: "INDIVIDUAL",
    branchId: 1,
    defaultFee: "500.00",
  });
});

function createInput(
  disposition: "MISSING_HELD" | "REPLACEMENT" | "REPRINT" = "MISSING_HELD",
  quantity = 1,
) {
  return {
    invoiceId: 1,
    branchId: 1,
    clientRequestId: key(),
    reason: "نقص مثبت بعد البيع",
    evidence: "محضر تحقق من المبيع والأصل",
    lines: [
      {
        originalInvoiceItemId: 1,
        originalBundleComponentId: 1,
        componentVariantId: 1,
        baseQuantity: quantity,
        disposition,
        originalMovementId:
          disposition === "MISSING_HELD" ? originalMovementId : undefined,
        physicalHeldConfirmed: disposition === "MISSING_HELD",
        evidence: "قطعة مفصولة بعهدة العميل ومعلومة الهوية",
      },
    ],
  };
}
async function approved(
  disposition: "MISSING_HELD" | "REPLACEMENT" | "REPRINT" = "MISSING_HELD",
  quantity = 1,
) {
  const result = await createAftercareCase(
    createInput(disposition, quantity),
    MAKER,
  );
  await approveAftercareCase(
    { id: result.id, expectedVersion: 1, clientRequestId: key() },
    CHECKER,
  );
  return getAftercareCase(result.id, CHECKER);
}
function preparation(data: Awaited<ReturnType<typeof approved>>, quantity = 1) {
  return {
    id: data.case.id,
    expectedVersion: data.case.version,
    clientRequestId: key(),
    recipientName: "مستلم المعالجة",
    recipientPhone: "07700000000",
    deliveryAddress: "عنوان تسليم المعالجة الموثق",
    deliveryFee: "500.00",
    lines: [{ aftercareLineId: data.lines[0].id, baseQuantity: quantity }],
  };
}
async function stock(variantId = 1) {
  return (
    await db()
      .select()
      .from(s.branchStock)
      .where(
        and(
          eq(s.branchStock.variantId, variantId),
          eq(s.branchStock.branchId, 1),
        ),
      )
  )[0].quantity;
}
async function originalState() {
  return {
    invoice: (
      await db().select().from(s.invoices).where(eq(s.invoices.id, 1))
    )[0],
    receipts: await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.invoiceId, 1)),
    sale: await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, 1)),
    customer: (
      await db().select().from(s.customers).where(eq(s.customers.id, 1))
    )[0],
  };
}

describe("aftercare real document, stock, custody and fee integration", () => {
  it("resolves the exact printed invoice reference or scanner barcode before an internal ID, within branch scope", async () => {
    await db()
      .update(s.invoices)
      .set({ invoiceNumber: "240001" })
      .where(eq(s.invoices.id, 1));
    const manual = await previewAftercareSource(
      { sourceKind: "INVOICE", sourceReference: "240001" },
      MAKER,
    );
    expect(manual).toMatchObject({
      invoiceId: 1,
      invoiceNumber: "240001",
      sourceNumber: "240001",
    });
    expect(
      (
        await previewAftercareSource(
          { sourceKind: "INVOICE", sourceReference: "]C1INV-240001" },
          MAKER,
        )
      ).invoiceId,
    ).toBe(1);
    expect(
      (
        await previewAftercareSource(
          { sourceKind: "INVOICE", sourceReference: "1" },
          MAKER,
        )
      ).invoiceId,
    ).toBe(1);
    expect(
      (await previewAftercareSource({ invoiceId: 1 }, MAKER)).invoiceId,
    ).toBe(1);
    await expect(
      previewAftercareSource(
        { sourceKind: "INVOICE", sourceReference: "240001" },
        FOREIGN,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      previewAftercareSource(
        { sourceKind: "INVOICE", sourceReference: "INV-999999" },
        MAKER,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      previewAftercareSource(
        { sourceKind: "WORK_ORDER", sourceReference: "INV-240001" },
        MAKER,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db().select().from(aftercareCases)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
  });
  it("generic BULK SHOP fee payout uses one real receipt and appears in both aftercare cases without new sale/COGS", async () => {
    const original = await originalState();
    const beforeStock = await stock();
    const caseIds: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      const data = await approved();
      caseIds.push(data.case.id);
      const execution = await prepareAftercareExecution(
        preparation(data),
        CHECKER,
      );
      await dispatchAftercareExecution(
        {
          id: execution.id,
          expectedVersion: 1,
          clientRequestId: key(),
          partyId: 1,
        },
        CHECKER,
      );
      await confirmAftercareDelivery(
        {
          id: execution.id,
          expectedVersion: 2,
          clientRequestId: key(),
          result: "DELIVERED",
          proof: "تسليم المعالجة الموثق قبل تسديد أجرة الجهة",
        },
        CHECKER,
      );
    }
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "2000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      createdBy: CHECKER.userId,
    });
    const shift = await openShift(
      { branchId: 1, openingBalance: "2000.00", shiftType: "RECEPTION" },
      CHECKER,
    );
    const payout = {
      partyId: 1,
      branchId: 1,
      shiftId: shift.id,
      clientRequestId: key(),
    };
    const paid = await payPartyDeliveryFees(payout, CHECKER);
    expect(paid).toMatchObject({
      paidTotal: "1000.00",
      count: 2,
      replay: false,
    });
    expect(await payPartyDeliveryFees(payout, CHECKER)).toMatchObject({
      receiptId: paid.receiptId,
      replay: true,
    });
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, paid.receiptId))
      )[0],
    ).toMatchObject({
      invoiceId: null,
      amount: "1000.00",
      direction: "OUT",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
    });
    for (const caseId of caseIds) {
      const current = await getAftercareCase(caseId, CHECKER);
      expect(current.receipts.map((receipt) => receipt.id)).toEqual([
        paid.receiptId,
      ]);
      expect(current.executions[0]).toMatchObject({
        feePaidAmount: "500.00",
        feeReceiptId: paid.receiptId,
        feeLedger: { due: "0.00" },
      });
      await resolveAftercareCase(
        {
          id: caseId,
          expectedVersion: current.case.version,
          clientRequestId: key(),
          resolution: "سلّمت العهدة وسددت أجرة الجهة بالسند المجمع",
        },
        CHECKER,
      );
    }
    expect(await stock()).toBe(beforeStock);
    expect(await originalState()).toEqual(original);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "ADJUST")),
    ).toHaveLength(0);
    const [totals] = await db()
      .select({
        cost: sql<string>`SUM(${s.accountingEntries.cost})`,
        revenue: sql<string>`SUM(${s.accountingEntries.revenue})`,
      })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DELIVERY_FEE"));
    expect(Number(totals.cost)).toBe(1000);
    expect(Number(totals.revenue)).toBe(0);
  });
  it("generic declaration/cancellation/actual-return hooks preserve the original sale and physical custody", async () => {
    const data = await approved();
    const execution = await prepareAftercareExecution(
      preparation(data),
      CHECKER,
    );
    const sent = await dispatchAftercareExecution(
      {
        id: execution.id,
        expectedVersion: 1,
        clientRequestId: key(),
        partyId: 1,
      },
      CHECKER,
    );
    if (!sent.consignmentId)
      throw new Error("actual aftercare consignment missing");
    const original = await originalState();
    const before = await stock();
    await expect(
      withTx((tx) =>
        assertAftercareAssignmentCancellationTx(tx, sent.consignmentId!),
      ),
    ).rejects.toThrow(/عهدة مثبتة/);
    await withTx((tx) =>
      declareAftercareReturnTx(
        tx,
        {
          consignmentId: sent.consignmentId!,
          reason: "أعلنت الشركة رجوع العهدة ولم تصل بعد",
          clientRequestId: key(),
        },
        CHECKER,
      ),
    );
    expect(
      (await getAftercareCase(data.case.id, CHECKER)).executions[0].lines[0]
        .custodyBaseQuantity,
    ).toBe(1);
    const input = {
      consignmentId: sent.consignmentId,
      result: "RETURNED" as const,
      proof: "استلم المخزن عهدة المعالجة وفحصها فعلياً",
      clientRequestId: key(),
      authorization: {
        kind: "STAFF" as const,
        operationPath: "delivery.returnConsignment" as const,
      },
    };
    expect(
      await withTx((tx) => routeAftercareDeliveryResultTx(tx, input, CHECKER)),
    ).toMatchObject({ handled: true, replay: false });
    expect(
      await withTx((tx) => routeAftercareDeliveryResultTx(tx, input, CHECKER)),
    ).toMatchObject({ handled: true, replay: true });
    expect(
      (await getAftercareCase(data.case.id, CHECKER)).executions[0].lines[0],
    ).toMatchObject({ custodyBaseQuantity: 0, returnedBaseQuantity: 1 });
    expect(await stock()).toBe(before);
    expect(await originalState()).toEqual(original);
  });

  it("generic courier confirmation requires a current real member and cannot declare stock physically returned", async () => {
    await db()
      .insert(s.users)
      .values([
        {
          id: 4,
          openId: "ac-courier",
          name: "الناقل",
          role: "courier",
          branchId: 1,
        },
        {
          id: 5,
          openId: "ac-wrong-courier",
          name: "ناقل آخر",
          role: "courier",
          branchId: 1,
        },
      ]);
    await db()
      .update(s.deliveryParties)
      .set({ userId: 4 })
      .where(eq(s.deliveryParties.id, 1));
    const data = await approved();
    const execution = await prepareAftercareExecution(
      preparation(data),
      CHECKER,
    );
    const sent = await dispatchAftercareExecution(
      {
        id: execution.id,
        expectedVersion: 1,
        clientRequestId: key(),
        partyId: 1,
      },
      CHECKER,
    );
    if (!sent.consignmentId)
      throw new Error("actual aftercare consignment missing");
    const input = {
      consignmentId: sent.consignmentId,
      result: "DELIVERED" as const,
      proof: "تأكيد الناقل تسليم المعالجة للمستلم",
      clientRequestId: key(),
      authorization: { kind: "COURIER" as const },
      customerCollectedAmount: "0.00",
    };
    await expect(
      withTx((tx) => routeAftercareDeliveryResultTx(tx, input, { userId: 5 })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTx((tx) =>
        routeAftercareDeliveryResultTx(
          tx,
          { ...input, result: "RETURNED" },
          { userId: 4 },
        ),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTx((tx) =>
        routeAftercareDeliveryResultTx(
          tx,
          { ...input, customerCollectedAmount: "1.00" },
          { userId: 4 },
        ),
      ),
    ).rejects.toThrow(/قيمة التحصيل صفر/);
    await db()
      .insert(s.deliveryPartyMembers)
      .values({
        partyId: 1,
        userId: 4,
        memberRole: "ACCOUNTANT",
        isActive: true,
        createdBy: CHECKER.userId,
      });
    await expect(
      withTx((tx) => routeAftercareDeliveryResultTx(tx, input, { userId: 4 })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db()
      .update(s.deliveryPartyMembers)
      .set({ memberRole: "DRIVER" })
      .where(eq(s.deliveryPartyMembers.userId, 4));
    expect(
      await withTx((tx) =>
        routeAftercareDeliveryResultTx(tx, input, { userId: 4 }),
      ),
    ).toMatchObject({ handled: true });
    const [fee] = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.entryType, "FEE_EARNED"));
    expect(Number(fee.n)).toBe(1);
  });
  it("reads per-bundle historical components, subtracts returns, and serializes concurrent allocations", async () => {
    const preview = await previewAftercareSource({ invoiceId: 1 }, MAKER);
    expect(preview.choices).toMatchObject([
      { variantId: 1, originalQuantity: 6, availableForAftercare: 6 },
    ]);
    await db()
      .update(s.invoiceItems)
      .set({ returnedBaseQuantity: 1 })
      .where(eq(s.invoiceItems.id, 1));
    expect(
      (await previewAftercareSource({ invoiceId: 1 }, MAKER)).choices[0]
        .availableForAftercare,
    ).toBe(3);
    const attempts = await Promise.allSettled([
      createAftercareCase(createInput("MISSING_HELD", 2), MAKER),
      createAftercareCase(createInput("MISSING_HELD", 2), MAKER),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await db().select().from(aftercareCases)).toHaveLength(1);
    const mismatch = createInput("REPLACEMENT");
    mismatch.lines[0].componentVariantId = 2;
    await expect(createAftercareCase(mismatch, MAKER)).rejects.toThrow(
      /لقطة البكج/,
    );
  });

  it("requires physical/original evidence, independent approval and the original branch", async () => {
    const missingProof = createInput();
    missingProof.lines[0].physicalHeldConfirmed = false;
    await expect(createAftercareCase(missingProof, MAKER)).rejects.toThrow(
      /وجود المبيع/,
    );
    await expect(
      createAftercareCase(createInput(), FOREIGN),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const created = await createAftercareCase(createInput(), CHECKER);
    await expect(
      approveAftercareCase(
        { id: created.id, expectedVersion: 1, clientRequestId: key() },
        CHECKER,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTx((tx) => assertNoActiveAftercareForInvoiceTx(tx, 1)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db()
      .update(s.branchStock)
      .set({ lastCountedAt: new Date(Date.now() + 1000) })
      .where(eq(s.branchStock.variantId, 1));
    await expect(createAftercareCase(createInput(), MAKER)).rejects.toThrow(
      /جرد أو تعديل/,
    );
  });

  it("MISSING_HELD creates real COD-zero source and delivers sold custody with no second stock, cost or sale", async () => {
    const original = await originalState();
    const data = await approved();
    const beforeStock = await stock();
    const prep = preparation(data);
    const execution = await prepareAftercareExecution(prep, CHECKER);
    expect(await prepareAftercareExecution(prep, CHECKER)).toMatchObject({
      id: execution.id,
      replay: true,
    });
    await expect(
      prepareAftercareExecution({ ...prep, deliveryFee: "600.00" }, CHECKER),
    ).rejects.toThrow();
    const dispatch = {
      id: execution.id,
      expectedVersion: 1,
      clientRequestId: key(),
      partyId: 1,
    };
    const sent = await dispatchAftercareExecution(dispatch, CHECKER);
    expect(await dispatchAftercareExecution(dispatch, CHECKER)).toMatchObject({
      consignmentId: sent.consignmentId,
      replay: true,
    });
    const [cn] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, sent.consignmentId!));
    expect(cn).toMatchObject({
      sourceType: "AFTERCARE_EXECUTION",
      sourceId: execution.id,
      aftercareExecutionId: execution.id,
      invoiceId: null,
      codAmount: "0.00",
      feeCollection: "SHOP",
    });
    const delivery = {
      id: execution.id,
      expectedVersion: 2,
      clientRequestId: key(),
      result: "DELIVERED" as const,
      proof: "محضر تسليم موقع من المستلم",
    };
    await confirmAftercareDelivery(delivery, CHECKER);
    await confirmAftercareDelivery(delivery, CHECKER);
    expect(await stock()).toBe(beforeStock);
    expect(await originalState()).toEqual(original);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "ADJUST")),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.deliveryLedgerEntries)
        .where(eq(s.deliveryLedgerEntries.entryType, "FEE_EARNED")),
    ).toHaveLength(1);
    await expect(
      resolveAftercareCase(
        {
          id: data.case.id,
          expectedVersion: 4,
          clientRequestId: key(),
          resolution: "تم التسليم بالكامل",
        },
        CHECKER,
      ),
    ).rejects.toThrow(/استحقاق ناقل/);
  });

  it("REPLACEMENT issues once at current cost, never reconstructing the old component cost", async () => {
    const original = await originalState();
    const data = await approved("REPLACEMENT", 2);
    await db()
      .update(s.productVariants)
      .set({ costPrice: "175.00" })
      .where(eq(s.productVariants.id, 1));
    const prep = preparation(data, 2);
    const execution = await prepareAftercareExecution(prep, CHECKER);
    await prepareAftercareExecution(prep, CHECKER);
    expect(await stock()).toBe(92);
    expect(await originalState()).toEqual(original);
    const [issue] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        eq(s.accountingEntries.dedupeKey, `AFTERCARE_ISSUE:${execution.id}`),
      );
    expect(issue).toMatchObject({
      revenue: "0.00",
      cost: "350.00",
      profit: "-350.00",
      invoiceId: null,
    });
    const outputs = await db()
      .select()
      .from(aftercareExecutionLines)
      .where(eq(aftercareExecutionLines.executionId, execution.id));
    expect(outputs).toMatchObject([
      {
        kind: "OUTPUT",
        unitCost: "175.00",
        lineCost: "350.00",
        fulfilledBaseQuantity: 2,
      },
    ]);
    expect(outputs[0].movementId).toBeGreaterThan(0);
  });

  it("REPRINT consumes only specified new materials and counts the output once", async () => {
    const original = await originalState();
    const data = await approved("REPRINT");
    const prep = preparation(data);
    const execution = await prepareAftercareExecution(
      {
        ...prep,
        lines: [
          {
            aftercareLineId: data.lines[0].id,
            baseQuantity: 1,
            materials: [
              { variantId: 2, baseQuantity: 2 },
              { variantId: 1, baseQuantity: 1 },
            ],
          },
        ],
      },
      CHECKER,
    );
    const rows = await db()
      .select()
      .from(aftercareExecutionLines)
      .where(eq(aftercareExecutionLines.executionId, execution.id));
    expect(rows.filter((line) => line.kind === "OUTPUT")).toMatchObject([
      { fulfilledBaseQuantity: 1, lineCost: "0.00", movementId: null },
    ]);
    expect(
      rows
        .filter((line) => line.kind === "MATERIAL")
        .map((line) => line.fulfilledBaseQuantity),
    ).toEqual([0, 0]);
    expect(
      (
        await db()
          .select()
          .from(aftercareExecutions)
          .where(eq(aftercareExecutions.id, execution.id))
      )[0].totalCost,
    ).toBe("150.00");
    expect(await stock()).toBe(93);
    expect(await stock(2)).toBe(98);
    expect(await originalState()).toEqual(original);
  });

  it("rolls back all execution effects when a later reprint material is unavailable", async () => {
    const data = await approved("REPRINT");
    const prep = preparation(data);
    const before = await stock();
    await expect(
      prepareAftercareExecution(
        {
          ...prep,
          lines: [
            {
              aftercareLineId: data.lines[0].id,
              baseQuantity: 1,
              materials: [
                { variantId: 1, baseQuantity: 1 },
                { variantId: 2, baseQuantity: 1000 },
              ],
            },
          ],
        },
        CHECKER,
      ),
    ).rejects.toThrow();
    expect(await stock()).toBe(before);
    expect(await db().select().from(aftercareExecutions)).toHaveLength(0);
    expect(await db().select().from(aftercareExecutionLines)).toHaveLength(0);
    expect(
      (await db().select().from(aftercareLines))[0].executedBaseQuantity,
    ).toBe(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
  });

  it("failed delivery retains custody; a verified full return can be reissued only once without a second OUT", async () => {
    const data = await approved("REPLACEMENT");
    const prep = preparation(data);
    const execution = await prepareAftercareExecution(prep, CHECKER);
    await dispatchAftercareExecution(
      {
        id: execution.id,
        expectedVersion: 1,
        clientRequestId: key(),
        partyId: 1,
      },
      CHECKER,
    );
    await confirmAftercareDelivery(
      {
        id: execution.id,
        expectedVersion: 2,
        clientRequestId: key(),
        result: "FAILED",
        proof: "المستلم رفض والتعويض بقي لدى الناقل",
      },
      CHECKER,
    );
    let current = await getAftercareCase(data.case.id, CHECKER);
    expect(current.executions[0].lines[0].custodyBaseQuantity).toBe(1);
    await expect(
      prepareAftercareExecution(
        {
          ...prep,
          expectedVersion: current.case.version,
          clientRequestId: key(),
        },
        CHECKER,
      ),
    ).rejects.toThrow(/حق الصرف/);
    await confirmAftercareDelivery(
      {
        id: execution.id,
        expectedVersion: 3,
        clientRequestId: key(),
        result: "RETURNED",
        proof: "استلام وفحص العهدة العائدة دون رد مخزون تلقائي",
      },
      CHECKER,
    );
    current = await getAftercareCase(data.case.id, CHECKER);
    const beforeStock = await stock();
    const retryInput = {
      ...prep,
      expectedVersion: current.case.version,
      clientRequestId: key(),
      reuseExecutionId: execution.id,
    };
    const retried = await prepareAftercareExecution(retryInput, CHECKER);
    expect(await stock()).toBe(beforeStock);
    expect(
      (
        await db()
          .select()
          .from(aftercareExecutionLines)
          .where(eq(aftercareExecutionLines.executionId, retried.id))
      )[0],
    ).toMatchObject({
      reusedFromLineId: current.executions[0].lines[0].id,
      movementId: null,
      lineCost: "0.00",
    });
    current = await getAftercareCase(data.case.id, CHECKER);
    await expect(
      prepareAftercareExecution(
        {
          ...retryInput,
          clientRequestId: key(),
          expectedVersion: current.case.version,
        },
        CHECKER,
      ),
    ).rejects.toThrow(/أعيد تخصيص/);
    expect(current.lines[0].executedBaseQuantity).toBe(1);
  });

  it("pays an accrued SHOP fee with a real guarded receipt, rejects the closed day and never expenses it twice", async () => {
    const data = await approved();
    const execution = await prepareAftercareExecution(
      preparation(data),
      CHECKER,
    );
    await dispatchAftercareExecution(
      {
        id: execution.id,
        expectedVersion: 1,
        clientRequestId: key(),
        partyId: 1,
      },
      CHECKER,
    );
    await confirmAftercareDelivery(
      {
        id: execution.id,
        expectedVersion: 2,
        clientRequestId: key(),
        result: "DELIVERED",
        proof: "إثبات تسليم فعلي للعميل",
      },
      CHECKER,
    );
    // Actual pre-existing treasury cash, independent from aftercare expenses.
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "1000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      createdBy: 2,
    });
    const closeId = extractInsertId(
      await db()
        .insert(s.cashDailyReconciliations)
        .values({
          branchId: 1,
          businessDate: todayUtcDate(),
          expectedTreasuryCash: "1000.00",
          countedTreasuryCash: "1000.00",
          variance: "0.00",
          status: "CLOSED",
          lastClientRequestId: key(),
          evidenceHash: "a".repeat(64),
          countedByUserId: 2,
        }),
    );
    const payment = {
      id: execution.id,
      expectedVersion: 3,
      clientRequestId: key(),
      cashBucket: "TREASURY" as const,
      amount: "500.00",
    };
    await expect(payAftercareDeliveryFee(payment, CHECKER)).rejects.toThrow(
      /مطابقة نقد اليوم مغلقة/,
    );
    await db()
      .update(s.cashDailyReconciliations)
      .set({ status: "REOPENED" })
      .where(eq(s.cashDailyReconciliations.id, closeId));
    const paid = await payAftercareDeliveryFee(payment, CHECKER);
    expect(await payAftercareDeliveryFee(payment, CHECKER)).toMatchObject({
      receiptId: paid.receiptId,
      replay: true,
    });
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, paid.receiptId))
      )[0],
    ).toMatchObject({
      direction: "OUT",
      amount: "500.00",
      cashBucket: "TREASURY",
      invoiceId: null,
    });
    const [totals] = await db()
      .select({ cost: sql<string>`SUM(${s.accountingEntries.cost})` })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DELIVERY_FEE"));
    expect(Number(totals.cost)).toBe(500);
    await expect(
      payAftercareDeliveryFee(
        { ...payment, expectedVersion: 4, clientRequestId: key() },
        CHECKER,
      ),
    ).rejects.toThrow(/استحقاق الناقل/);
    const current = await getAftercareCase(data.case.id, CHECKER);
    await resolveAftercareCase(
      {
        id: data.case.id,
        expectedVersion: current.case.version,
        clientRequestId: key(),
        resolution: "تسليم كامل مع تصفية استحقاق الناقل",
      },
      CHECKER,
    );
    expect((await getAftercareCase(data.case.id, CHECKER)).case.status).toBe(
      "RESOLVED",
    );
  });
});
