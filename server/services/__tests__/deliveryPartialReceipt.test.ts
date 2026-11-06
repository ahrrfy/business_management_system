import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { deliveryCustodyItems } from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { returnSale } from "../returnService";
import { previewWorkflowSource } from "../delivery/workflow/preview";
import { receiveWorkflowReturn } from "../delivery/workflow/returns";
import { appendDeliveryEvent } from "../delivery/lifecycle";
import { repairDeliveryCustodyFromRecordedEventsTx } from "../delivery/custody";
import { withTx } from "../tx";

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

async function fixture(restock = false, quantity = 1) {
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
      clientRequestId: "receipt-sale",
      regularSale: {
        amount: String(7000 + 10000 * quantity),
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "1" },
          { variantId: 2, productUnitId: 2, quantity: String(quantity) },
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
  if (restock)
    await returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: Number(returned.id), baseQuantity: 1 }],
        restock: true,
        clientRequestId: "receipt-commercial",
      },
      actor,
    );
  const input = async (key: string, baseQuantity = 1) => {
    const p = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: Number(cn.id) },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    return {
      source: {
        kind: p.source.kind,
        id: p.source.id,
        expectedVersion: p.source.version,
      },
      branchId: 1,
      evidence: "استلمنا الصنف المرتجع فقط وفحصناه",
      inspected: true as const,
      clientRequestId: key,
      receivedLines: [
        {
          consignmentId: Number(cn.id),
          invoiceItemId: Number(returned.id),
          baseQuantity,
        },
      ],
    };
  };
  return { cn: cn!, invoiceId, returned, delivered, input };
}

async function custody(consignmentId: number) {
  return db()
    .select()
    .from(deliveryCustodyItems)
    .where(eq(deliveryCustodyItems.consignmentId, consignmentId));
}

describe("استلام المرتجع الفعلي على مستوى البند", () => {
  it("يحتسب الكمية المغلقة تجارياً مرة واحدة عند استلام بقية كمية البند لاحقاً", async () => {
    const f = await fixture(true, 3);
    const movements = await db().select().from(s.inventoryMovements);
    await receiveWorkflowReturn(await f.input("restocked-first"), actor);
    await receiveWorkflowReturn(await f.input("remaining-next", 2), actor);
    const row = (await custody(f.cn.id)).find(
      (r) => r.invoiceItemId === f.returned.id,
    )!;
    expect(row.restockedClosedBaseQuantity).toBe(1);
    expect(row.customerOwnedHeldBaseQuantity).toBe(2);
    expect(row.carrierCustodyBaseQuantity).toBe(0);
    expect(await db().select().from(s.inventoryMovements)).toEqual(movements);
  });

  it("لا يثبت الكمية نفسها مرتين عند وصول طلبين متزامنين", async () => {
    const f = await fixture();
    const first = await f.input("concurrent-first");
    const second = { ...first, clientRequestId: "concurrent-second" };
    const results = await Promise.allSettled([
      receiveWorkflowReturn(first, actor),
      receiveWorkflowReturn(second, actor),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await custody(f.cn.id)).find((r) => r.invoiceItemId === f.returned.id)
        ?.customerOwnedHeldBaseQuantity,
    ).toBe(1);
  });
  it("يصحح التسليم القديم لبند محدد ويحافظ على المرتجع المخزني عند إعادة التشغيل", async () => {
    const f = await fixture(true);
    const { receivedLines: _, ...whole } = await f.input(
      "legacy-whole-receipt",
    );
    await receiveWorkflowReturn(whole, actor);
    const before = await db().select().from(s.inventoryMovements);
    await withTx(async (tx) => {
      await appendDeliveryEvent(tx, {
        eventKey: `CN:${f.cn.id}:PARTIAL_SCOPE_CORRECTION`,
        consignmentId: f.cn.id,
        eventType: "PARTIAL_DELIVERY_SCOPE_CORRECTED",
        actorUserId: actor.userId,
        payload: {
          invoiceId: f.invoiceId,
          claimVersion: f.cn.codClaimVersion,
          deliveredLines: [{ invoiceItemId: f.delivered.id, baseQuantity: 1 }],
          receivedLines: [{ invoiceItemId: f.returned.id, baseQuantity: 1 }],
          supersedesPhysicalReceiptEventId: null,
          evidence: "تصحيح نطاق محضر الاستلام القديم",
        },
      });
      await repairDeliveryCustodyFromRecordedEventsTx(tx, f.cn.id);
      await repairDeliveryCustodyFromRecordedEventsTx(tx, f.cn.id);
    });
    const rows = await custody(f.cn.id);
    expect(
      rows.find((row) => row.invoiceItemId === f.delivered.id)
        ?.customerDeliveredBaseQuantity,
    ).toBe(1);
    expect(
      rows.find((row) => row.invoiceItemId === f.delivered.id)
        ?.customerOwnedHeldBaseQuantity,
    ).toBe(0);
    expect(
      rows.find((row) => row.invoiceItemId === f.returned.id)
        ?.restockedClosedBaseQuantity,
    ).toBe(1);
    expect(await db().select().from(s.inventoryMovements)).toEqual(before);
  });

  it("يسمح بتحديد جميع البنود الأصلية كاستلام كامل", async () => {
    const f = await fixture();
    const input = await f.input("all-selected");
    await receiveWorkflowReturn(
      {
        ...input,
        receivedLines: [
          ...input.receivedLines,
          {
            consignmentId: f.cn.id,
            invoiceItemId: f.delivered.id,
            baseQuantity: 1,
          },
        ],
      },
      actor,
    );
    const [cn] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, f.cn.id));
    expect(cn.parcelStatus).toBe("RETURNED");
    expect(cn.returnedAt).not.toBeNull();
    expect(
      (await custody(f.cn.id)).every(
        (row) => row.customerOwnedHeldBaseQuantity === 1,
      ),
    ).toBe(true);
    expect(await db().select().from(s.receipts)).toEqual([]);
    const [invoice] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, f.invoiceId));
    expect(invoice.returnedTotal).toBe("0.00");
    expect(invoice.paidAmount).toBe("0.00");
  });

  it("يرفض البكج والخدمة حتى لو وجدت عهدة تاريخية مفردة", async () => {
    const f = await fixture();
    const input = await f.input("unsupported-product");
    await db()
      .update(s.products)
      .set({ isBundle: true })
      .where(eq(s.products.id, 2));
    await expect(receiveWorkflowReturn(input, actor)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await db()
      .update(s.products)
      .set({ isBundle: false, isService: true })
      .where(eq(s.products.id, 2));
    await expect(receiveWorkflowReturn(input, actor)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(
      (await custody(f.cn.id)).every(
        (row) => row.customerOwnedHeldBaseQuantity === 0,
      ),
    ).toBe(true);
  });
  it("يبقي بقية البضاعة بعهدتها ولا يكرر استرجاع المخزون المسجل تجارياً", async () => {
    const f = await fixture(true);
    const before = await db().select().from(s.inventoryMovements);
    const input = await f.input("receipt-one");
    await receiveWorkflowReturn(input, actor);
    expect((await receiveWorkflowReturn(input, actor)).idempotentReplay).toBe(
      true,
    );
    const [cn] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, f.cn.id));
    expect(cn.parcelStatus).not.toBe("RETURNED");
    expect(cn.returnedAt).toBeNull();
    const rows = await custody(f.cn.id);
    expect(
      rows.find((r) => r.invoiceItemId === f.delivered.id)
        ?.customerOwnedHeldBaseQuantity,
    ).toBe(0);
    expect(
      rows.find((r) => r.invoiceItemId === f.returned.id)
        ?.restockedClosedBaseQuantity,
    ).toBe(1);
    expect(await db().select().from(s.inventoryMovements)).toEqual(before);
    await expect(
      receiveWorkflowReturn(await f.input("receipt-duplicate"), actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const events = await db()
      .select()
      .from(s.deliveryEvents)
      .where(eq(s.deliveryEvents.consignmentId, f.cn.id));
    expect(
      events.find((e) => e.eventType === "WORKFLOW_RETURN_RECEIVED")?.payload,
    ).toMatchObject({
      scope: "ITEMS",
      receivedLines: [{ invoiceItemId: f.returned.id, baseQuantity: 1 }],
    });
  });

  it("ينقل الكمية المحددة فقط ويرفض تجاوز الكمية الأصلية أو تكرار السطر", async () => {
    const f = await fixture(false, 3);
    await receiveWorkflowReturn(await f.input("receipt-first"), actor);
    let row = (await custody(f.cn.id)).find(
      (r) => r.invoiceItemId === f.returned.id,
    )!;
    expect(row.customerOwnedHeldBaseQuantity).toBe(1);
    expect(
      row.preparedHeldBaseQuantity +
        row.carrierCustodyBaseQuantity +
        row.customerDeliveredBaseQuantity,
    ).toBe(2);
    const duplicate = await f.input("receipt-bad");
    await expect(
      receiveWorkflowReturn(
        {
          ...duplicate,
          receivedLines: [
            ...duplicate.receivedLines,
            ...duplicate.receivedLines,
          ],
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      receiveWorkflowReturn(await f.input("receipt-too-many", 3), actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await receiveWorkflowReturn(await f.input("receipt-second", 2), actor);
    row = (await custody(f.cn.id)).find(
      (r) => r.invoiceItemId === f.returned.id,
    )!;
    expect(row.customerOwnedHeldBaseQuantity).toBe(3);
    expect(
      (await custody(f.cn.id)).find((r) => r.invoiceItemId === f.delivered.id)
        ?.customerOwnedHeldBaseQuantity,
    ).toBe(0);
  });

  it("يرفض المعرف الغريب والكمية غير الصحيحة والقائمة الفارغة", async () => {
    const f = await fixture();
    const input = await f.input("receipt-invalid");
    for (const receivedLines of [
      [],
      [{ ...input.receivedLines[0]!, baseQuantity: 0 }],
      [{ ...input.receivedLines[0]!, baseQuantity: 0.5 }],
      [{ ...input.receivedLines[0]!, invoiceItemId: 999999 }],
      [{ ...input.receivedLines[0]!, consignmentId: 999999 }],
    ]) {
      await expect(
        receiveWorkflowReturn({ ...input, receivedLines }, actor),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(
      (await custody(f.cn.id)).every(
        (r) => r.customerOwnedHeldBaseQuantity === 0,
      ),
    ).toBe(true);
  });
});
