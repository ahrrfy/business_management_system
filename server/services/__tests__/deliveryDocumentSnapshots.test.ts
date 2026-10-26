import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  deliveryDocumentPrints,
  deliveryDocumentSnapshots,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import {
  completeDeliveryDocumentPrintTx,
  bootstrapHistoricalShipmentDocumentSnapshotsTx,
  createDeliveryDocumentSnapshotTx,
  requestDeliveryDocumentPrintTx,
} from "../delivery/documentSnapshots";

function db() {
  const value = getDb();
  if (!value) throw new Error("isolated test database required");
  return value;
}

beforeEach(async () => {
  await db().insert(s.branches).values({
    id: 1,
    code: "MAIN",
    name: "الرئيسي",
    type: "MAIN",
  });
  await db().insert(s.users).values({
    id: 1,
    openId: "document-snapshot-actor",
    role: "admin",
    branchId: 1,
  });
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    openingBalance: "0",
    status: "OPEN",
    shiftType: "RECEPTION",
    openGuard: "1:1:RECEPTION",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "جهة أصلية",
    partyType: "COMPANY",
    branchId: 1,
    isActive: true,
  });
});

describe("delivery document snapshots", () => {
  it("replays the immutable event payload and rejects live-value replacement", async () => {
    const input = {
      documentType: "DISPATCH_SLIP" as const,
      layout: "THERMAL_80_CONTENT_72" as const,
      sourceType: "SHIPMENT" as const,
      sourceId: 71,
      sourceVersion: "dispatch-v1",
      branchId: 1,
      shiftId: 1,
      eventKey: "dispatch:71:confirmed",
      eventOccurredAt: new Date("2026-10-25T08:00:00.789Z"),
      payload: { codAmount: "58000.00", recipient: "عميل أصل" },
      createdBy: 1,
    };
    const first = await withTx((tx) =>
      createDeliveryDocumentSnapshotTx(tx, input),
    );
    const replay = await withTx((tx) =>
      createDeliveryDocumentSnapshotTx(tx, input),
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(replay.snapshot.eventOccurredAt.toISOString()).toBe(
      "2026-10-25T08:00:00.000Z",
    );

    await expect(
      withTx((tx) =>
        createDeliveryDocumentSnapshotTx(tx, {
          ...input,
          eventOccurredAt: new Date("2026-10-25T08:00:02.789Z"),
        }),
      ),
    ).rejects.toThrow(/eventOccurredAt/);

    await expect(
      withTx((tx) =>
        createDeliveryDocumentSnapshotTx(tx, {
          ...input,
          payload: { codAmount: "0.00", recipient: "قيمة حية متغيرة" },
        }),
      ),
    ).rejects.toThrow(/لا يجوز استبدال أثر الطباعة الأصلي/);
    expect(await db().select().from(deliveryDocumentSnapshots)).toHaveLength(1);
  });

  it("audits original and reprint attempts without financial or stock effects", async () => {
    const { snapshot } = await withTx((tx) =>
      createDeliveryDocumentSnapshotTx(tx, {
        documentType: "SHIPPING_LABEL",
        layout: "LABEL_100X150_SAFE_3",
        sourceType: "CONSIGNMENT",
        sourceId: 80,
        sourceVersion: "cn-v4",
        branchId: 1,
        eventKey: "consignment:80:assigned",
        eventOccurredAt: new Date("2026-10-25T09:15:00.000Z"),
        payload: { dueAtDoor: "0.00", phone: "07700000000" },
        createdBy: 1,
      }),
    );
    const original = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, {
        snapshotId: snapshot.id,
        branchId: 1,
        clientRequestId: "print-original-80",
        copyType: "ORIGINAL",
        printerKey: "label-front",
        requestedBy: 1,
      }),
    );
    await withTx((tx) =>
      completeDeliveryDocumentPrintTx(tx, {
        printId: original.print.id,
        branchId: 1,
        status: "SENT",
      }),
    );
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          snapshotId: snapshot.id,
          branchId: 1,
          clientRequestId: "print-original-again-80",
          copyType: "ORIGINAL",
          printerKey: "label-front",
          requestedBy: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const reprint = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, {
        snapshotId: snapshot.id,
        branchId: 1,
        clientRequestId: "print-reprint-80",
        copyType: "REPRINT",
        reason: "تلف الملصق الأول",
        printerKey: "label-front",
        requestedBy: 1,
      }),
    );
    expect(reprint.print.copyType).toBe("REPRINT");
    expect(reprint.print.reason).toBe("تلف الملصق الأول");
    expect(await db().select().from(deliveryDocumentPrints)).toHaveLength(2);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("requires a reason for a reprint", async () => {
    const { snapshot } = await withTx((tx) =>
      createDeliveryDocumentSnapshotTx(tx, {
        documentType: "REMITTANCE_RECEIPT",
        layout: "A4_12MM",
        sourceType: "REMITTANCE",
        sourceId: 9,
        sourceVersion: "remit-v1",
        branchId: 1,
        eventKey: "remittance:9:posted",
        eventOccurredAt: new Date("2026-10-25T10:00:00.000Z"),
        payload: { counted: "47000.00", shortfall: "1000.00" },
        createdBy: 1,
      }),
    );
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          snapshotId: snapshot.id,
          branchId: 1,
          clientRequestId: "print-reprint-without-reason",
          copyType: "REPRINT",
          requestedBy: 1,
        }),
      ),
    ).rejects.toThrow(/سبب إعادة الطباعة مطلوب/);
  });

  it("bootstraps a legacy pair only from the original assignment evidence", async () => {
    const eventAt = new Date("2026-10-20T07:15:00.000Z");
    await db().insert(s.workOrders).values({
      id: 7001,
      orderNumber: "WO-LEGACY-7001",
      branchId: 1,
      title: "أمر شغل تاريخي",
    });
    await db().insert(s.invoices).values({
      id: 91,
      invoiceNumber: "INV-LEGACY-91",
      sourceType: "WORKORDER",
      sourceId: "7001",
      branchId: 1,
      subtotal: "58000.00",
      total: "58000.00",
      paidAmount: "0.00",
      status: "CONFIRMED",
    });
    await db().insert(s.deliveryConsignments).values({
      id: 91,
      consignmentNumber: "LEGACY-CN-91",
      branchId: 1,
      partyId: 1,
      invoiceId: 91,
      workOrderId: 7001,
      sourceType: "WORK_ORDER",
      sourceId: 7001,
      codAmount: "58000.00",
      deliveryFee: "5000.00",
      feeCollection: "COURIER",
      recipientName: "المستلم الحالي",
      recipientPhone: "07700000000",
      deliveryAddress: "العنوان الحالي",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "UNSETTLED",
      status: "DISPATCHED",
      dispatchedBy: 1,
      dispatchedAt: eventAt,
      outForDeliveryAt: eventAt,
    });
    await db()
      .insert(s.deliveryEvents)
      .values({
        id: 910,
        eventKey: "legacy-cn-91:out",
        consignmentId: 91,
        eventType: "OUT_FOR_DELIVERY",
        toParcelStatus: "OUT_FOR_DELIVERY",
        toMoneyStatus: "UNSETTLED",
        payload: {
          partyId: 1,
          sourceType: "WORK_ORDER",
          sourceId: 7001,
        },
        actorUserId: 1,
        occurredAt: eventAt,
      });

    // These values are mutable after dispatch. Historical preparation must not
    // present them as if the original event had captured them.
    await db()
      .update(s.deliveryConsignments)
      .set({ codAmount: "0.00", deliveryFee: "9999.00" })
      .where(eq(s.deliveryConsignments.id, 91));
    await db()
      .update(s.deliveryParties)
      .set({ name: "اسم حي متغير" })
      .where(eq(s.deliveryParties.id, 1));

    const snapshotIds = await withTx((tx) =>
      bootstrapHistoricalShipmentDocumentSnapshotsTx(tx, {
        consignmentId: 91,
        branchId: 1,
      }),
    );
    expect(snapshotIds).toHaveLength(3);
    const snapshots = await db()
      .select()
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.sourceId, 91));
    expect(snapshots.map((row) => row.documentType).sort()).toEqual([
      "DELIVERY_MANIFEST",
      "DISPATCH_SLIP",
      "SHIPPING_LABEL",
    ]);
    for (const snapshot of snapshots.filter(
      (row) => row.documentType !== "DELIVERY_MANIFEST",
    )) {
      const payload = snapshot.payload as {
        evidence: { mode: string; notice: string; unavailableFields: string[] };
        money: { codAmount: string | null; deliveryFee: string | null };
        party: { name: string };
      };
      expect(snapshot.eventOccurredAt.toISOString()).toBe(
        eventAt.toISOString(),
      );
      expect(payload.evidence.mode).toBe("HISTORICAL_ORIGINAL_EVIDENCE");
      expect(payload.evidence.notice).toMatch(/المبالغ.*غير متاحة/);
      expect(payload.evidence.unavailableFields).toContain(
        "money.codAmountAtDispatch",
      );
      expect(payload.money).toMatchObject({
        codAmount: null,
        deliveryFee: null,
      });
      expect(payload.party.name).not.toContain("اسم حي متغير");
    }
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  });

  it("refuses a legacy bootstrap without a matching immutable assignment event", async () => {
    await db().insert(s.invoices).values({
      id: 92,
      invoiceNumber: "INV-LEGACY-92",
      sourceType: "POS",
      sourceId: "legacy-92",
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      paidAmount: "0.00",
      status: "CONFIRMED",
    });
    await db()
      .insert(s.deliveryConsignments)
      .values({
        id: 92,
        consignmentNumber: "LEGACY-CN-92",
        branchId: 1,
        partyId: 1,
        invoiceId: 92,
        sourceType: "INVOICE",
        sourceId: 92,
        codAmount: "1000.00",
        deliveryFee: "500.00",
        parcelStatus: "OUT_FOR_DELIVERY",
        moneyStatus: "UNSETTLED",
        status: "DISPATCHED",
        dispatchedBy: 1,
        dispatchedAt: new Date("2026-10-20T08:00:00.000Z"),
      });
    await expect(
      withTx((tx) =>
        bootstrapHistoricalShipmentDocumentSnapshotsTx(tx, {
          consignmentId: 92,
          branchId: 1,
        }),
      ),
    ).rejects.toThrow(/لا تتوفر واقعة إسناد أصلية متطابقة/);
    expect(await db().select().from(deliveryDocumentSnapshots)).toHaveLength(0);
  });
});
