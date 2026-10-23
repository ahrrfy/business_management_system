import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  fulfillmentRequestItems,
  fulfillmentRequests,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import {
  createFulfillmentRequest,
  releaseFulfillmentRequest,
  cancelFulfillmentRequest,
  updateFulfillmentRequest,
  readyFulfillmentRequest,
  reassignFulfillmentRequest,
  type FulfillmentRequestFields,
} from "../fulfillment/requests";
import {
  getFulfillmentRequest,
  listFulfillmentRequestCandidates,
} from "../fulfillment/requestQueries";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
} from "../fulfillment/charges";
import { withTx } from "../tx";
import { prepareWorkOrderDeliveryInvoiceInTx } from "../delivery/dispatch";
import { loadInvoiceDeliveryFeeHeldTx } from "../delivery/dispatchInvoice";
import { cancelShipmentAssignment } from "../delivery/shipmentOperations";
import { confirmShipmentDelivery } from "../delivery/shipmentOperations";
import { returnFulfillmentRequestConsignmentTx } from "../fulfillment/requestSources";

const actor = { userId: 1, branchId: 1, role: "admin" };
function db() {
  const database = getDb();
  if (!database) throw new Error("Isolated test DB required");
  return database;
}
function fields(
  sources: FulfillmentRequestFields["sources"],
): FulfillmentRequestFields {
  return {
    branchId: 1,
    customerId: 1,
    recipientName: "عميل الطلب",
    recipientPhone: "07701234567",
    deliveryAddress: "بغداد / المنصور / قرب الجامع",
    partyId: 1,
    deliveryFee: "5000",
    feeCollection: "COURIER",
    sources,
  };
}
const identity = (row: { id: number; version: number }, key: string) => ({
  id: row.id,
  expectedVersion: row.version,
  clientRequestId: key,
});
async function snapshot() {
  return {
    invoices: await db().select().from(s.invoices),
    receipts: await db().select().from(s.receipts),
    stock: await db().select().from(s.branchStock),
    movements: await db().select().from(s.inventoryMovements),
    entries: await db().select().from(s.accountingEntries),
    customer: await db().select().from(s.customers),
  };
}
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الثاني", code: "B2", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "fr-admin", role: "admin", branchId: 1 },
      { id: 2, openId: "fr-cashier-a", role: "cashier", branchId: 1 },
      { id: 3, openId: "fr-cashier-b", role: "cashier", branchId: 1 },
      { id: 4, openId: "fr-other-branch", role: "cashier", branchId: 2 },
    ]);
  await db()
    .insert(s.customers)
    .values([
      {
        id: 1,
        name: "عميل الطلب",
        phone: "+9647701234567",
        currentBalance: "0",
      },
      { id: 2, name: "عميل آخر", phone: "+9647711234567", currentBalance: "0" },
    ]);
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب المكتبة",
    partyType: "INDIVIDUAL",
    currentBalance: "0",
    isActive: true,
  });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "FR-PAPER", costPrice: "40" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 7 });
  await db()
    .insert(s.invoices)
    .values(
      [1, 2, 3].map((id) => ({
        id,
        invoiceNumber: `FR-PAID-${id}`,
        branchId: 1,
        customerId: 1,
        subtotal: "10000",
        total: "10000",
        paidAmount: "10000",
        status: "PAID" as const,
        createdBy: id === 1 ? 2 : 3,
      })),
    );
  await db()
    .insert(s.invoiceItems)
    .values(
      [1, 2, 3].map((invoiceId) => ({
        invoiceId,
        variantId: 1,
        quantity: "1",
        baseQuantity: 1,
        unitPrice: "10000",
        unitCost: "40",
        lineCost: "40",
        total: "10000",
      })),
    );
  await db()
    .insert(s.inventoryMovements)
    .values(
      [1, 2, 3].map((referenceId) => ({
        variantId: 1,
        branchId: 1,
        quantity: 1,
        movementType: "OUT" as const,
        referenceType: "INVOICE",
        referenceId,
        createdBy: 2,
      })),
    );
  await db()
    .insert(s.workOrders)
    .values([
      {
        id: 1,
        orderNumber: "FR-WO-READY",
        branchId: 1,
        customerId: 1,
        title: "خدمة طباعة جاهزة",
        status: "READY",
        salePrice: "5000",
        deposit: "0",
        paymentMode: "COD",
        materialsCost: "40",
        createdBy: 2,
      },
      {
        id: 2,
        orderNumber: "FR-WO-WAIT",
        branchId: 1,
        customerId: 1,
        title: "خدمة قيد التجهيز",
        status: "IN_PROGRESS",
        salePrice: "7000",
        deposit: "0",
        paymentMode: "COD",
        createdBy: 3,
      },
    ]);
});

describe("fulfillment request atomic release", () => {
  it("executes real candidate SQL and searches local phones, partial invoice references and ready work orders", async () => {
    const all = await listFulfillmentRequestCandidates({ branchId: 1 }, actor);
    expect(all.map((r) => r.key).sort()).toEqual([
      "I:1",
      "I:2",
      "I:3",
      "W:1",
      "W:2",
    ]);
    expect(all.find((r) => r.workOrderId === 1)?.ready).toBe(true);
    expect(all.find((r) => r.workOrderId === 2)?.ready).toBe(false);
    const local = await listFulfillmentRequestCandidates(
      { branchId: 1, search: "07701234567" },
      actor,
    );
    const international = await listFulfillmentRequestCandidates(
      { branchId: 1, search: "+9647701234567" },
      actor,
    );
    expect(local.map((r) => r.key).sort()).toEqual(
      all.map((r) => r.key).sort(),
    );
    expect(international.map((r) => r.key).sort()).toEqual(
      local.map((r) => r.key).sort(),
    );
    expect(
      (
        await listFulfillmentRequestCandidates(
          { branchId: 1, search: "PAID-2" },
          actor,
        )
      ).map((r) => r.key),
    ).toEqual(["I:2"]);
    expect(
      (
        await listFulfillmentRequestCandidates(
          { branchId: 1, search: "WO-READY" },
          actor,
        )
      ).map((r) => [r.key, r.ready]),
    ).toEqual([["W:1", true]]);
    expect(
      (
        await listFulfillmentRequestCandidates(
          { branchId: 1, search: "خدمة طباعة" },
          actor,
        )
      ).map((r) => r.key),
    ).toEqual(["W:1"]);
  });
  it("filters real active source ownership and live shipments while retaining cancelled uncollected sources", async () => {
    const request = await createFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { workOrderId: 2 }]),
        clientRequestId: "fr-candidate-owned",
      },
      actor,
    );
    expect(
      (await listFulfillmentRequestCandidates({ branchId: 1 }, actor))
        .map((r) => r.key)
        .sort(),
    ).toEqual(["I:2", "I:3", "W:1"]);
    await cancelFulfillmentRequest(
      {
        ...identity(request, "fr-candidate-cancel"),
        reason: "تحرير مصادر التجهيز للاختبار",
      },
      actor,
    );
    await db().insert(s.deliveryConsignments).values({
      consignmentNumber: "FR-CANDIDATE-CANCELLED",
      branchId: 1,
      partyId: 1,
      invoiceId: 2,
      sourceType: "INVOICE",
      sourceId: 2,
      codAmount: "0",
      collectedAmount: "0",
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
      deliveryFee: "0",
      dispatchedBy: 1,
    });
    expect(
      (
        await listFulfillmentRequestCandidates(
          { branchId: 1, search: "PAID-2" },
          actor,
        )
      ).map((r) => r.key),
    ).toEqual(["I:2"]);
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: "DISPATCHED",
        parcelStatus: "OUT_FOR_DELIVERY",
        moneyStatus: "UNSETTLED",
      })
      .where(eq(s.deliveryConsignments.invoiceId, 2));
    expect(
      await listFulfillmentRequestCandidates(
        { branchId: 1, search: "PAID-2" },
        actor,
      ),
    ).toHaveLength(0);
  });
  it("creates a charge-only consignment with no fake invoice, receipt or inventory effect", async () => {
    const request = await createFulfillmentRequest(
      { ...fields([]), clientRequestId: "fr-chargeonly-create" },
      actor,
    );
    const charge = await createFulfillmentCharge(
      {
        branchId: 1,
        requestId: request.id,
        customerId: 1,
        category: "SERVICE",
        description: "أجر تغليف مستقل",
        amount: "2000",
        externalCost: "0",
        clientRequestId: "fr-chargeonly-charge",
      },
      actor,
    );
    await approveFulfillmentCharge(
      identity(charge, "fr-chargeonly-approve"),
      actor,
    );
    const before = await snapshot();
    const payload = identity(request, "fr-chargeonly-release");
    const result = await releaseFulfillmentRequest(payload, actor);
    await releaseFulfillmentRequest(payload, actor);
    expect(await snapshot()).toEqual(before);
    const [cn] = await db().select().from(s.deliveryConsignments);
    expect(cn).toMatchObject({
      id: result.consignmentId,
      invoiceId: null,
      fulfillmentRequestId: request.id,
      sourceType: "FULFILLMENT_REQUEST",
      sourceId: request.id,
      codAmount: "2000.00",
    });
    expect(
      (await getFulfillmentRequest(request.id, actor)).consignments,
    ).toHaveLength(1);
    const assigned = await db().select().from(s.deliveryLedgerEntries);
    expect(assigned.filter((r) => r.entryType === "COD_ASSIGNED")).toHaveLength(
      1,
    );
    await withTx((tx) =>
      returnFulfillmentRequestConsignmentTx(
        tx,
        {
          consignmentId: cn.id,
          reason: "عادت مهمة تحصيل الأجر دون قبض",
          clientRequestId: "fr-chargeonly-return",
        },
        actor,
      ),
    );
    expect(await snapshot()).toEqual(before);
    const returned = await getFulfillmentRequest(request.id, actor);
    const reassignment = {
      ...identity(returned.request, "fr-chargeonly-reassign"),
      consignmentId: cn.id,
    };
    await reassignFulfillmentRequest(reassignment, actor);
    await reassignFulfillmentRequest(reassignment, actor);
    expect(await snapshot()).toEqual(before);
    const after = await db().select().from(s.deliveryConsignments);
    expect(after).toHaveLength(1);
    expect(after[0].codAmount).toBe("2000.00");
  });
  it("keeps CREDIT debt off courier COD while preserving the current receivable", async () => {
    await db()
      .update(s.invoices)
      .set({ paymentMode: "CREDIT", paidAmount: "0", status: "PENDING" })
      .where(eq(s.invoices.id, 1));
    const request = await createFulfillmentRequest(
      { ...fields([{ invoiceId: 1 }]), clientRequestId: "fr-credit-create" },
      actor,
    );
    const before = await snapshot();
    await releaseFulfillmentRequest(
      identity(request, "fr-credit-release"),
      actor,
    );
    expect(await snapshot()).toEqual(before);
    expect(
      (await db().select().from(s.deliveryConsignments))[0].codAmount,
    ).toBe("0.00");
    const detail = await getFulfillmentRequest(request.id, actor);
    expect(detail.totals.invoiceRemaining).toBe("10000.00");
    expect(detail.totals.invoiceCodRemaining).toBe("0.00");
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(0);
  });
  it("preserves anonymous service contact identity and the original WO held-fee receipt", async () => {
    await db()
      .update(s.workOrders)
      .set({
        customerId: null,
        contactName: "مستلم عابر",
        contactPhone: "07701234567",
        deliveryPhone: "+9647701234567",
        deliveryAddress: "بغداد / الكرادة",
        deliveryCost: "5000",
        deliveryFeeCollection: "COUNTER",
      })
      .where(eq(s.workOrders.id, 1));
    await db().insert(s.receipts).values({
      workOrderId: 1,
      branchId: 1,
      direction: "IN",
      amount: "5000",
      paymentMethod: "CARD",
      cashBucket: null,
      status: "COMPLETED",
      referenceNumber: "DLV-FEE-WO-1",
      createdBy: 1,
    });
    const invoice = await withTx((tx) =>
      prepareWorkOrderDeliveryInvoiceInTx(
        tx,
        { workOrderId: 1, partyId: 1, requestId: 1 },
        actor,
      ),
    );
    const held = await withTx((tx) =>
      loadInvoiceDeliveryFeeHeldTx(tx, [invoice.invoiceId]),
    );
    expect(held.get(invoice.invoiceId)?.toFixed(2)).toBe("5000.00");
    const [row] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, invoice.invoiceId));
    expect(row).toMatchObject({
      contactName: "مستلم عابر",
      contactPhone: "+9647701234567",
    });
    const [receipt] = await db().select().from(s.receipts);
    expect(receipt).toMatchObject({
      invoiceId: invoice.invoiceId,
      workOrderId: 1,
      referenceNumber: "DLV-FEE-WO-1",
      paymentMethod: "CARD",
      cashBucket: null,
    });
  });
  it("reassigns a cancelled original batch without another sale, receipt, fee or materialization", async () => {
    const request = await createFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { workOrderId: 1 }]),
        clientRequestId: "fr-reassign-create",
      },
      actor,
    );
    const first = await releaseFulfillmentRequest(
      identity(request, "fr-reassign-first"),
      actor,
    );
    const before = await snapshot();
    const firstMembers = await db().select().from(s.deliveryConsignments);
    expect(firstMembers.find((c) => c.workOrderId === 1)?.sourceType).toBe(
      "WORK_ORDER",
    );
    await cancelShipmentAssignment(
      {
        consignmentId: first.consignmentId,
        reason: "تأجيل تسليم الدفعة",
        clientRequestId: "fr-reassign-cancel",
      },
      actor,
    );
    const current = await getFulfillmentRequest(request.id, actor);
    const payload = {
      ...identity(current.request, "fr-reassign-again"),
      consignmentId: first.consignmentId,
    };
    const again = await reassignFulfillmentRequest(payload, actor);
    await reassignFulfillmentRequest(payload, actor);
    expect(again.consignmentId).toBe(first.consignmentId);
    expect(await snapshot()).toEqual(before);
    const members = await db().select().from(s.deliveryConsignments);
    expect(members.map((c) => c.id)).toEqual(firstMembers.map((c) => c.id));
    expect(members.filter((c) => c.deliveryFee === "5000.00")).toHaveLength(1);
  });
  it("ships three paid invoices by two cashiers with one fee and no second financial or inventory effect", async () => {
    const before = await snapshot();
    const request = await createFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { invoiceId: 2 }, { invoiceId: 3 }]),
        clientRequestId: "fr-paid-create",
      },
      actor,
    );
    const result = await releaseFulfillmentRequest(
      identity(request, "fr-paid-release"),
      actor,
    );
    const after = await snapshot();
    expect(after).toEqual(before);
    const consignments = await db().select().from(s.deliveryConsignments);
    expect(consignments).toHaveLength(3);
    expect(
      consignments.filter((c) => c.deliveryFee === "5000.00"),
    ).toHaveLength(1);
    expect(consignments.every((c) => c.codAmount === "0.00")).toBe(true);
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(3);
    const detail = await getFulfillmentRequest(request.id, actor);
    expect(detail.request.status).toBe("RELEASED");
    expect(detail.totals.currentClaim).toBe("0.00");
    const replay = await releaseFulfillmentRequest(
      identity(request, "fr-paid-release"),
      actor,
    );
    expect(replay.consignmentId).toBe(result.consignmentId);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(3);
    expect(await snapshot()).toEqual(after);
  });
  it("rejects release while an included order is not ready and rolls every effect back", async () => {
    const request = await createFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { workOrderId: 2 }]),
        clientRequestId: "fr-notready-create",
      },
      actor,
    );
    const before = await snapshot();
    await expect(
      releaseFulfillmentRequest(
        identity(request, "fr-notready-release"),
        actor,
      ),
    ).rejects.toThrow(/لم تجهز/);
    expect(await snapshot()).toEqual(before);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
    expect((await db().select().from(fulfillmentRequests))[0].version).toBe(
      request.version,
    );
  });
  it("materializes a ready service order once without consuming stock or collecting again", async () => {
    const request = await createFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { workOrderId: 1 }]),
        clientRequestId: "fr-wo-create",
      },
      actor,
    );
    const before = await snapshot();
    const payload = identity(request, "fr-wo-release");
    await releaseFulfillmentRequest(payload, actor);
    await releaseFulfillmentRequest(payload, actor);
    const after = await snapshot();
    expect(after.invoices).toHaveLength(before.invoices.length + 1);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.stock).toEqual(before.stock);
    expect(after.movements).toEqual(before.movements);
    expect(after.entries.filter((e) => e.entryType === "SALE")).toHaveLength(1);
    const [order] = await db()
      .select()
      .from(s.workOrders)
      .where(eq(s.workOrders.id, 1));
    expect(order.invoiceId).not.toBeNull();
    const detail = await getFulfillmentRequest(request.id, actor);
    expect(
      detail.items.find((r) => r.workOrderId === 1)?.materializedInvoiceId,
    ).toBe(order.invoiceId);
    await confirmShipmentDelivery(
      {
        consignmentId: detail.items[0].consignmentId!,
        collectedAmount: "5000.00",
        evidence: "تأكيد العميل تسليم دفعة الخدمة",
        clientRequestId: "fr-wo-courier-delivered",
      },
      actor,
    );
    expect(
      (await db().select().from(s.workOrders).where(eq(s.workOrders.id, 1)))[0]
        .status,
    ).toBe("DELIVERED");
    expect((await snapshot()).stock).toEqual(before.stock);
  });
  it("requires explicit partial and future fee decisions; retains waiting ownership for the next batch", async () => {
    const request = await createFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { workOrderId: 2 }]),
        partialReleaseAllowed: true,
        futureFeeDecision: "الدفعة القادمة بأجرة جديدة يوافق عليها العميل",
        clientRequestId: "fr-partial-create",
      },
      actor,
    );
    const detail = await getFulfillmentRequest(request.id, actor);
    const item = detail.items.find((r) => r.originalInvoiceId === 1)!;
    await expect(
      releaseFulfillmentRequest(
        { ...identity(request, "fr-partial-no-confirm"), itemIds: [item.id] },
        actor,
      ),
    ).rejects.toThrow(/الإرسال الجزئي/);
    await releaseFulfillmentRequest(
      {
        ...identity(request, "fr-partial-release"),
        itemIds: [item.id],
        partialReleaseConfirmed: true,
        futureFeeDecision: "الدفعة القادمة بأجرة يوافق عليها العميل",
      },
      actor,
    );
    const partial = await getFulfillmentRequest(request.id, actor);
    expect(partial.request.status).toBe("PARTIALLY_RELEASED");
    expect(partial.remainingItems).toHaveLength(1);
    expect(partial.remainingItems[0].isActive).toBe(true);
    await db()
      .update(s.workOrders)
      .set({ status: "READY" })
      .where(eq(s.workOrders.id, 2));
    await expect(
      releaseFulfillmentRequest(
        identity(partial.request, "fr-next-no-fee"),
        actor,
      ),
    ).rejects.toThrow(/أجرة الدفعة اللاحقة/);
    await releaseFulfillmentRequest(
      {
        ...identity(partial.request, "fr-next-release"),
        subsequentDeliveryFee: "0",
        subsequentFeeCollection: "SHOP",
      },
      actor,
    );
    expect(
      (await getFulfillmentRequest(request.id, actor)).request.status,
    ).toBe("RELEASED");
  });
  it("rejects changed key reuse, active source duplication, wrong customer and branch scope", async () => {
    const input = {
      ...fields([{ invoiceId: 1 }]),
      clientRequestId: "fr-key-create",
    };
    const request = await createFulfillmentRequest(input, actor);
    expect((await createFulfillmentRequest(input, actor)).id).toBe(request.id);
    await expect(
      createFulfillmentRequest({ ...input, recipientName: "اسم مختلف" }, actor),
    ).rejects.toThrow(/بيانات مختلفة/);
    await expect(
      createFulfillmentRequest(
        { ...input, clientRequestId: "fr-duplicate-create" },
        actor,
      ),
    ).rejects.toThrow(/طلب توصيل نشط آخر/);
    await expect(
      createFulfillmentRequest(
        {
          ...fields([{ invoiceId: 2 }]),
          customerId: 2,
          clientRequestId: "fr-other-customer",
        },
        actor,
      ),
    ).rejects.toThrow(/العميل الحقيقي/);
    await expect(
      getFulfillmentRequest(request.id, {
        userId: 4,
        branchId: 2,
        role: "cashier",
      }),
    ).rejects.toThrow(/خارج نطاق/);
    await cancelFulfillmentRequest(
      {
        ...identity(request, "fr-cancel-request"),
        reason: "إلغاء قبل الإرسال",
      },
      actor,
    );
    expect(
      (await db().select().from(fulfillmentRequestItems))[0].isActive,
    ).toBe(false);
    const again = await createFulfillmentRequest(
      { ...input, clientRequestId: "fr-source-reuse" },
      actor,
    );
    expect(again.id).not.toBe(request.id);
  });
  it("versions edits and readiness without posting financial effects", async () => {
    const request = await createFulfillmentRequest(
      { ...fields([{ invoiceId: 1 }]), clientRequestId: "fr-edit-create" },
      actor,
    );
    const before = await snapshot();
    const updated = await updateFulfillmentRequest(
      {
        ...fields([{ invoiceId: 1 }, { workOrderId: 2 }]),
        ...identity(request, "fr-edit-update"),
      },
      actor,
    );
    const ready = await readyFulfillmentRequest(
      identity(updated, "fr-edit-ready"),
      actor,
    );
    expect(ready.status).toBe("PREPARING");
    expect(await snapshot()).toEqual(before);
    await expect(
      readyFulfillmentRequest(identity(request, "fr-stale-ready"), actor),
    ).rejects.toThrow(/تغيّر المستند/);
  });
});
