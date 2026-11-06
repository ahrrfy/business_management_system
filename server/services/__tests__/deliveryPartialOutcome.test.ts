import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { deliveryCustodyItems } from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { returnSale } from "../returnService";
import { previewWorkflowSource } from "../delivery/workflow/preview";
import { receiveWorkflowReturn } from "../delivery/workflow/returns";

const actor = { userId: 1, branchId: 1, role: "admin" };
const db = () => getDb()!;

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "partial-owner",
        name: "المدير",
        role: "admin",
        isOwner: true,
        branchId: 1,
      },
      {
        id: 2,
        openId: "partial-courier",
        name: "المندوب",
        role: "courier",
        branchId: 1,
      },
    ]);
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "المندوب",
    partyType: "INDIVIDUAL",
    userId: 2,
    branchId: 1,
    currentBalance: "0.00",
  });
  for (const [id, price, cost] of [
    [1, "7000.00", "3000.00"],
    [2, "10000.00", "4000.00"],
  ] as const) {
    await db()
      .insert(s.products)
      .values({ id, name: `صنف ${id}` });
    await db()
      .insert(s.productVariants)
      .values({ id, productId: id, sku: `PARTIAL-${id}`, costPrice: cost });
    await db().insert(s.productUnits).values({
      id,
      variantId: id,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    await db()
      .insert(s.productPrices)
      .values({ productUnitId: id, priceTier: "RETAIL", price });
    await db()
      .insert(s.branchStock)
      .values({ variantId: id, branchId: 1, quantity: 10 });
  }
});

async function fixture(wholeReceipt = false, wrongReceiptLine = false) {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    actor,
  );
  const sale = await checkoutReception(
    {
      branchId: 1,
      shiftId: shift.shiftId,
      customerId: 1,
      paidAmount: "0",
      paymentMethod: "CASH",
      clientRequestId: "partial-sale-17000",
      regularSale: {
        amount: "17000.00",
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "1" },
          { variantId: 2, productUnitId: 2, quantity: "1" },
        ],
      },
      delivery: {
        partyId: 1,
        assignedUserId: 2,
        fee: "2000.00",
        feeCollection: "COURIER",
      },
    },
    actor,
  );
  const invoiceId = sale.regularSale!.invoiceId;
  const [cn] = await db()
    .select()
    .from(s.deliveryConsignments)
    .where(eq(s.deliveryConsignments.invoiceId, invoiceId));
  const items = await db()
    .select()
    .from(s.invoiceItems)
    .where(eq(s.invoiceItems.invoiceId, invoiceId));
  const returned = items.find((item) => item.variantId === 2)!;
  const delivered = items.find((item) => item.variantId === 1)!;
  await returnSale(
    {
      invoiceId,
      lines: [{ invoiceItemId: Number(returned.id), baseQuantity: 1 }],
      restock: true,
      clientRequestId: "partial-commercial-return",
    },
    actor,
  );
  const p = await previewWorkflowSource(
    {
      source: { kind: "consignment", id: Number(cn.id) },
      station: "return",
      branchId: 1,
    },
    actor,
  );
  await receiveWorkflowReturn(
    {
      source: {
        kind: p.source.kind,
        id: p.source.id,
        expectedVersion: p.source.version,
      },
      branchId: 1,
      evidence: "استلمنا الصنف المرتجع فقط وفحصناه",
      inspected: true,
      clientRequestId: "partial-physical-return",
      ...(wholeReceipt
        ? {}
        : {
            receivedLines: [
              {
                consignmentId: Number(cn.id),
                invoiceItemId: Number(
                  wrongReceiptLine ? delivered.id : returned.id,
                ),
                baseQuantity: 1,
              },
            ],
          }),
    },
    actor,
  );
  return {
    invoiceId,
    consignmentId: Number(cn.id),
    returnedItemId: Number(returned.id),
    deliveredItemId: Number(delivered.id),
    shiftId: shift.shiftId,
  };
}

async function snapshot() {
  return {
    invoices: await db().select().from(s.invoices),
    customers: await db().select().from(s.customers),
    parties: await db().select().from(s.deliveryParties),
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
    ledger: await db().select().from(s.deliveryLedgerEntries),
    custody: await db().select().from(deliveryCustodyItems),
    events: await db().select().from(s.deliveryEvents),
    stock: await db().select().from(s.inventoryMovements),
  };
}

async function settlement(wholeReceipt = true) {
  const f = await fixture(wholeReceipt);
  const service = await import("../delivery/workflow/partialOutcome");
  const p = await service.previewPartialDeliverySettlement(
    { consignmentId: f.consignmentId },
    actor,
  );
  return {
    ...f,
    ...service,
    input: {
      consignmentId: f.consignmentId,
      expectedVersion: p.version,
      targetShiftId: f.shiftId,
      cashReceivedAmount: "7000.00",
      evidence:
        "استلم العميل البند الباقي ودفعه للمندوب وسلم المندوب النقد للمكتبة",
      clientRequestId: "partial-adversarial-7000",
    },
  };
}

describe("تسليم جزئي مع مرتجع وتوريد فعلي", () => {
  it("استلام بند المرتجع وحده لا يحول بقية البضاعة إلى عهدة المكتبة", async () => {
    const f = await fixture();
    const [cn] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, f.consignmentId));
    expect(cn.parcelStatus).not.toBe("RETURNED");
    const rows = await db()
      .select()
      .from(deliveryCustodyItems)
      .where(eq(deliveryCustodyItems.consignmentId, f.consignmentId));
    expect(
      rows.find((row) => row.invoiceItemId === f.deliveredItemId)
        ?.customerOwnedHeldBaseQuantity,
    ).toBe(0);
  });

  it("يصالح الاستلام القديم الخاطئ ويثبت 7000 قبضاً وتوريداً مرة واحدة دون تكرار المرتجع", async () => {
    const f = await fixture(true);
    const { previewPartialDeliverySettlement, settlePartialDeliveryOutcome } =
      await import("../delivery/workflow/partialOutcome");
    const preview = await previewPartialDeliverySettlement(
      { consignmentId: f.consignmentId },
      actor,
    );
    expect(preview.allowed).toBe(true);
    expect(preview.goodsAmount).toBe("7000.00");
    const beforeMovements = await db().select().from(s.inventoryMovements);
    const input = {
      consignmentId: f.consignmentId,
      expectedVersion: preview.version,
      targetShiftId: f.shiftId,
      cashReceivedAmount: "7000.00",
      evidence:
        "العميل استلم الباقي وسدد للمندوب وسلمنا المندوب 7000 نقداً مع المرتجع",
      clientRequestId: "partial-reconcile-7000",
    };
    await settlePartialDeliveryOutcome(input, actor);
    await settlePartialDeliveryOutcome(input, actor);
    const [inv] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, f.invoiceId));
    expect([inv.total, inv.returnedTotal, inv.paidAmount, inv.status]).toEqual([
      "17000.00",
      "10000.00",
      "7000.00",
      "PAID",
    ]);
    const [customer] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, 1));
    const [party] = await db()
      .select()
      .from(s.deliveryParties)
      .where(eq(s.deliveryParties.id, 1));
    expect(customer.currentBalance).toBe("0.00");
    expect(party.currentBalance).toBe("0.00");
    expect(await db().select().from(s.inventoryMovements)).toEqual(
      beforeMovements,
    );
    const cash = await db().select().from(s.receipts);
    expect(
      cash.filter((row) => row.direction === "IN").map((row) => row.amount),
    ).toEqual(["7000.00"]);
    expect(cash.filter((row) => row.direction === "OUT")).toEqual([]);
    const ledger = await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.consignmentId, f.consignmentId));
    expect(
      ledger
        .filter((row) => row.entryType === "COD_COLLECTED")
        .map((row) => row.amount),
    ).toEqual(["7000.00"]);
    expect(
      ledger
        .filter((row) => row.entryType === "COD_REMITTED")
        .map((row) => row.amount),
    ).toEqual(["7000.00"]);
    const custody = await db()
      .select()
      .from(deliveryCustodyItems)
      .where(eq(deliveryCustodyItems.consignmentId, f.consignmentId));
    expect(
      custody.find((row) => row.invoiceItemId === f.deliveredItemId)
        ?.customerDeliveredBaseQuantity,
    ).toBe(1);
    expect(
      custody.find((row) => row.invoiceItemId === f.returnedItemId)
        ?.restockedClosedBaseQuantity,
    ).toBe(1);
    await expect(
      settlePartialDeliveryOutcome(
        { ...input, cashReceivedAmount: "9000.00" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يسوي الاستلام المحدد بالبنود مع إبقاء الديون الأخرى مستقلة", async () => {
    await db()
      .update(s.customers)
      .set({ currentBalance: "500.00" })
      .where(eq(s.customers.id, 1));
    const f = await settlement(false);
    await f.settlePartialDeliveryOutcome(f.input, actor);
    const [customer] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, 1));
    expect(customer.currentBalance).toBe("500.00");
  });

  it("التوريد الجزئي لا يعيد مطالبة العميل ويسجل النقد الذي وصل فقط", async () => {
    const f = await settlement();
    await f.settlePartialDeliveryOutcome(
      { ...f.input, cashReceivedAmount: "4000.00" },
      actor,
    );
    const [invoice] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, f.invoiceId));
    const [party] = await db()
      .select()
      .from(s.deliveryParties)
      .where(eq(s.deliveryParties.id, 1));
    expect(invoice.paidAmount).toBe("7000.00");
    expect(party.currentBalance).toBe("3000.00");
    expect(
      (await db().select().from(s.receipts)).map((row) => row.amount),
    ).toEqual(["4000.00"]);
  });

  it("يرفض تضمين أجرة المندوب في نقد المكتبة دون أي أثر جزئي", async () => {
    const f = await settlement();
    const before = await snapshot();
    await expect(
      f.settlePartialDeliveryOutcome(
        { ...f.input, cashReceivedAmount: "9000.00" },
        actor,
      ),
    ).rejects.toThrow(/أجرة المندوب/);
    expect(await snapshot()).toEqual(before);
  });

  it("يرفض المعاينة القديمة والفرع الآخر دون كتابة", async () => {
    const f = await settlement();
    await db()
      .insert(s.branches)
      .values({ id: 2, code: "SALES", name: "فرع آخر", type: "SALES" });
    await db()
      .insert(s.users)
      .values({ id: 3, openId: "other-manager", role: "manager", branchId: 2 });
    await db()
      .update(s.invoices)
      .set({ notes: "تغير المستند بعد المعاينة" })
      .where(eq(s.invoices.id, f.invoiceId));
    const before = await snapshot();
    await expect(
      f.settlePartialDeliveryOutcome(f.input, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.previewPartialDeliverySettlement(
        { consignmentId: f.consignmentId },
        { userId: 3, branchId: 2, role: "manager" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await snapshot()).toEqual(before);
  });

  it("استلام صنف مختلف لا يثبت وصول بند المرتجع التجاري", async () => {
    const f = await fixture(false, true);
    const service = await import("../delivery/workflow/partialOutcome");
    const p = await service.previewPartialDeliverySettlement(
      { consignmentId: f.consignmentId },
      actor,
    );
    expect(p.allowed).toBe(false);
  });

  it("يربط التوريد المكتمل السابق عند تصحيح نطاق العهدة دون قبض أو قيد نقد جديد", async () => {
    const f = await settlement();
    const original = await f.settlePartialDeliveryOutcome(f.input, actor);
    const current = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: f.consignmentId },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    await receiveWorkflowReturn(
      {
        source: {
          kind: current.source.kind,
          id: current.source.id,
          expectedVersion: current.source.version,
        },
        branchId: 1,
        inspected: true,
        evidence: "محضر قديم عمم استلام بند المرتجع على كامل الطرد خطأً",
        clientRequestId: "partial-old-receipt-after-remit",
      },
      actor,
    );
    const before = await snapshot();
    const p = await f.previewPartialDeliverySettlement(
      { consignmentId: f.consignmentId },
      actor,
    );
    expect(p.allowed).toBe(true);
    expect(p.cashAlreadyRecorded).toBe(true);
    const result = await f.settlePartialDeliveryOutcome(
      {
        ...f.input,
        expectedVersion: p.version,
        clientRequestId: "partial-reuse-recorded-remit",
      },
      actor,
    );
    expect(result.remittanceId).toBe(original.remittanceId);
    const after = await snapshot();
    for (const key of [
      "invoices",
      "customers",
      "parties",
      "receipts",
      "entries",
      "ledger",
      "stock",
    ] as const)
      expect(after[key]).toEqual(before[key]);
    const custody = after.custody.find(
      (row) => row.invoiceItemId === f.deliveredItemId,
    )!;
    expect(custody.customerDeliveredBaseQuantity).toBe(1);
  });

  it("محاولتان متزامنتان لا تثبتان النقد مرتين", async () => {
    const f = await settlement();
    const results = await Promise.allSettled([
      f.settlePartialDeliveryOutcome(f.input, actor),
      f.settlePartialDeliveryOutcome(
        { ...f.input, clientRequestId: "partial-concurrent-second" },
        actor,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await db().select().from(s.receipts)).map((row) => row.amount),
    ).toEqual(["7000.00"]);
  });

  it("فشل التوريد يعيد إثبات التسليم والقبض والعهدة بالكامل", async () => {
    const f = await settlement();
    const before = await snapshot();
    await db().execute(
      sql.raw(
        "CREATE TRIGGER partial_outcome_test_failure BEFORE INSERT ON deliveryRemittances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'partial outcome forced failure'",
      ),
    );
    try {
      await expect(
        f.settlePartialDeliveryOutcome(f.input, actor),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await db().execute(
        sql.raw("DROP TRIGGER IF EXISTS partial_outcome_test_failure"),
      );
    }
  });
});
