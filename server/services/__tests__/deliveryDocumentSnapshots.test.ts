import { describe, expect, it, beforeEach } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  deliveryDocumentPrints,
  deliveryDocumentSnapshots,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import {
  completeDeliveryDocumentPrintTx,
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
      eventOccurredAt: new Date("2026-10-25T08:00:00.000Z"),
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
});
