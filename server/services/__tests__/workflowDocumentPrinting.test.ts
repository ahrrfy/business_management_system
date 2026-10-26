import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  deliveryDocumentPrints,
  deliveryDocumentSnapshots,
  aftercareExecutions,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import {
  bootstrapHistoricalShipmentDocumentSnapshotsTx,
  captureShipmentAssignmentDocumentsTx,
  completeDeliveryDocumentPrintTx,
  createDeliveryDocumentSnapshotTx,
  listDeliveryDocumentSnapshotsTx,
  prepareShipmentWorkflowDocumentsTx,
  requestDeliveryDocumentPrintTx,
  type GenericWorkflowDocumentPayload,
  type ShipmentDispatchDocumentPayload,
} from "../delivery/documentSnapshots";
import { reassignDeliveryConsignment } from "../delivery/parties";
import { receiveWorkflowReturn } from "../delivery/workflow/returns";
import { confirmWorkflowDelivery } from "../delivery/workflow/collection";
import { previewWorkflowSource } from "../delivery/workflow/preview";
import {
  createAftercareCase,
  approveAftercareCase,
  prepareAftercareExecution,
  dispatchAftercareExecution,
} from "../fulfillment/aftercare";
import { getAftercareCase } from "../fulfillment/aftercareQueries";
import {
  previewAftercareSettlement,
  requestAftercareSettlement,
  approveAftercareSettlement,
  postAftercareSettlement,
} from "../fulfillment/aftercareSettlement";

const actor = { userId: 1, branchId: 1, role: "admin" };
const eventAt = new Date("2026-10-25T08:00:00.000Z");
function db() {
  const value = getDb();
  if (!value) throw new Error("Explicit isolated test DB required");
  return value;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" },
      { id: 2, code: "OTHER", name: "الثاني", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "workflow-document-owner",
    role: "admin",
    isOwner: true,
    branchId: 1,
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل المستند", currentBalance: "100.00" });
  await db()
    .insert(s.deliveryParties)
    .values([
      {
        id: 1,
        partyType: "INDIVIDUAL",
        name: "الجهة الأولى",
        branchId: 1,
        isActive: true,
      },
      {
        id: 2,
        partyType: "INDIVIDUAL",
        name: "الجهة الجديدة",
        branchId: 1,
        isActive: true,
      },
    ]);
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "WORKFLOW-DOC", costPrice: "40.00" });
  await db()
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 9 });
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "PRINT-INV-1",
    sourceType: "POS",
    branchId: 1,
    customerId: 1,
    subtotal: "100.00",
    total: "100.00",
    costTotal: "40.00",
    paidAmount: "0.00",
    paymentMode: "COD",
    createdBy: 1,
  });
  await db().insert(s.invoiceItems).values({
    invoiceId: 1,
    variantId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: "100.00",
    unitCost: "40.00",
    lineCost: "40.00",
    total: "100.00",
  });
  await db().insert(s.inventoryMovements).values({
    variantId: 1,
    branchId: 1,
    movementType: "OUT",
    quantity: 1,
    referenceType: "INVOICE",
    referenceId: 1,
    createdBy: 1,
  });
  await db().insert(s.deliveryConsignments).values({
    id: 1,
    consignmentNumber: "PRINT-CN-1",
    branchId: 1,
    partyId: 1,
    invoiceId: 1,
    sourceType: "INVOICE",
    sourceId: 1,
    codAmount: "100.00",
    deliveryFee: "0.00",
    feeCollection: "COURIER",
    recipientName: "عميل المستند",
    recipientPhone: "07700000000",
    deliveryAddress: "عنوان المصدر",
    status: "DISPATCHED",
    parcelStatus: "OUT_FOR_DELIVERY",
    moneyStatus: "UNSETTLED",
    dispatchedBy: 1,
    dispatchedAt: eventAt,
    outForDeliveryAt: eventAt,
  });
  await db()
    .insert(s.deliveryEvents)
    .values({
      id: 1,
      consignmentId: 1,
      eventKey: "print:assignment:original",
      eventType: "OUT_FOR_DELIVERY",
      actorUserId: 1,
      occurredAt: eventAt,
      payload: {
        partyId: 1,
        partyName: "الجهة الأولى",
        sourceType: "INVOICE",
        sourceId: 1,
      },
    });
});

async function businessSnapshot() {
  return Promise.all([
    db().select().from(s.invoices),
    db().select().from(s.invoiceItems),
    db().select().from(s.inventoryMovements),
    db().select().from(s.branchStock),
    db().select().from(s.accountingEntries),
    db().select().from(s.receipts),
    db().select().from(s.deliveryLedgerEntries),
    db().select().from(s.customers),
    db().select().from(s.deliveryParties),
    db().select().from(s.productVariants),
  ]);
}

async function preparedAftercare() {
  await db().insert(s.users).values({
    id: 2,
    openId: "native-aftercare-approver",
    role: "admin",
    isOwner: true,
    branchId: 1,
  });
  const approver = { userId: 2, branchId: 1, role: "admin" };
  const [item] = await db()
    .select()
    .from(s.invoiceItems)
    .where(eq(s.invoiceItems.invoiceId, 1));
  const created = await createAftercareCase(
    {
      branchId: 1,
      invoiceId: 1,
      clientRequestId: "native-aftercare-create",
      reason: "بديل لنقص موثق",
      evidence: "محضر أصل المبيع",
      lines: [
        {
          originalInvoiceItemId: item.id,
          componentVariantId: 1,
          baseQuantity: 1,
          disposition: "REPLACEMENT",
          evidence: "دليل نقص فعلي",
        },
      ],
    },
    actor,
  );
  await approveAftercareCase(
    {
      id: created.id,
      expectedVersion: 1,
      clientRequestId: "native-aftercare-approve",
    },
    approver,
  );
  let detail = await getAftercareCase(created.id, approver);
  await prepareAftercareExecution(
    {
      id: created.id,
      expectedVersion: detail.case.version,
      clientRequestId: "native-aftercare-prepare",
      recipientName: "مستلم المعالجة",
      recipientPhone: "07700000000",
      deliveryAddress: "عنوان المعالجة",
      deliveryFee: "0.00",
      lines: [{ aftercareLineId: detail.lines[0].id, baseQuantity: 1 }],
    },
    approver,
  );
  detail = await getAftercareCase(created.id, approver);
  return detail.executions[0];
}

describe("workflow committed document printing", () => {
  it("captures native aftercare documents atomically and prints immutable evidence without another business effect", async () => {
    const execution = await preparedAftercare();
    const command = {
      id: execution.id,
      expectedVersion: execution.version,
      clientRequestId: "native-aftercare-dispatch",
      partyId: 1,
    };
    const result = await dispatchAftercareExecution(command, actor);
    const rows = await db().select().from(deliveryDocumentSnapshots);
    expect(rows.map((row) => row.documentType).sort()).toEqual([
      "AFTERCARE_WAYBILL",
      "DELIVERY_MANIFEST",
      "DISPATCH_SLIP",
      "SHIPPING_LABEL",
    ]);
    const slip = rows.find((row) => row.documentType === "DISPATCH_SLIP")!;
    expect(slip.eventKey).toBe(`AC:${execution.id}:DISPATCH`);
    expect(slip.payload).toMatchObject({
      evidence: { mode: "COMMITTED_DISPATCH_EVENT" },
      shipment: {
        consignmentId: result.consignmentId,
        sourceType: "AFTERCARE_EXECUTION",
        sourceId: execution.id,
      },
      recipient: { name: "مستلم المعالجة", address: "عنوان المعالجة" },
      money: { codAmount: "0.00", deliveryFee: "0.00", feeCollection: "SHOP" },
      invoices: [],
    });
    await db()
      .update(s.deliveryConsignments)
      .set({ recipientName: "اسم لاحق", deliveryAddress: "عنوان لاحق" })
      .where(eq(s.deliveryConsignments.id, result.consignmentId!));
    await db()
      .update(s.deliveryParties)
      .set({ name: "اسم جهة لاحق" })
      .where(eq(s.deliveryParties.id, 1));
    const committed = await businessSnapshot();
    expect((await dispatchAftercareExecution(command, actor)).replay).toBe(
      true,
    );
    const prepared = await withTx((tx) =>
      prepareShipmentWorkflowDocumentsTx(tx, {
        consignmentId: result.consignmentId!,
        branchId: 1,
      }),
    );
    expect(prepared.map((row) => row.id).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
    expect(prepared.find((row) => row.id === slip.id)!.payload).toEqual(
      slip.payload,
    );
    const attempt = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, {
        snapshotId: slip.id,
        branchId: 1,
        clientRequestId: "native-aftercare-print",
        copyType: "ORIGINAL",
        requestedBy: 1,
      }),
    );
    await withTx((tx) =>
      completeDeliveryDocumentPrintTx(tx, {
        printId: attempt.print.id,
        branchId: 1,
        status: "SENT",
      }),
    );
    expect(await businessSnapshot()).toEqual(committed);
  });

  it("prepares legacy native aftercare documents from its recorded dispatch association and rejects a mismatched party", async () => {
    const execution = await preparedAftercare();
    const result = await dispatchAftercareExecution(
      {
        id: execution.id,
        expectedVersion: execution.version,
        clientRequestId: "historical-aftercare-dispatch",
        partyId: 1,
      },
      actor,
    );
    await db().delete(deliveryDocumentSnapshots);
    // Original native dispatches saved this smaller event payload.
    await db()
      .update(s.deliveryEvents)
      .set({
        payload: {
          aftercareExecutionId: execution.id,
          caseId: execution.caseId,
          codAmount: "0.00",
        },
      })
      .where(eq(s.deliveryEvents.eventKey, `AC:${execution.id}:DISPATCH`));
    const committed = await businessSnapshot();
    const prepared = await withTx((tx) =>
      prepareShipmentWorkflowDocumentsTx(tx, {
        consignmentId: result.consignmentId!,
        branchId: 1,
      }),
    );
    expect(prepared).toHaveLength(3);
    expect(
      prepared.find((row) => row.documentType === "DISPATCH_SLIP")!.payload,
    ).toMatchObject({
      evidence: { mode: "HISTORICAL_ORIGINAL_EVIDENCE" },
      shipment: {
        sourceType: "AFTERCARE_EXECUTION",
        sourceId: execution.id,
        partyId: 1,
      },
      money: { codAmount: null, deliveryFee: null },
    });
    expect(await businessSnapshot()).toEqual(committed);
    await db()
      .update(s.deliveryConsignments)
      .set({ partyId: 2 })
      .where(eq(s.deliveryConsignments.id, result.consignmentId!));
    await expect(
      withTx((tx) =>
        prepareShipmentWorkflowDocumentsTx(tx, {
          consignmentId: result.consignmentId!,
          branchId: 1,
        }),
      ),
    ).rejects.toThrow(/إسناد أصلية/);
    expect((await db().select().from(aftercareExecutions))[0].partyId).toBe(1);
  });

  it.each([{}, { reason: "إعادة المحاولة" }, { source: "STAFF_HANDOVER" }])(
    "ignores later departure payload %j when preparing the latest assignment documents",
    async (payload) => {
      await withTx((tx) =>
        captureShipmentAssignmentDocumentsTx(tx, {
          consignmentId: 1,
          branchId: 1,
          eventKey: "print:assignment:original",
        }),
      );
      const frozen = await db().select().from(deliveryDocumentSnapshots);
      await db()
        .insert(s.deliveryEvents)
        .values({
          consignmentId: 1,
          eventKey: "print:later-departure",
          eventType: "OUT_FOR_DELIVERY",
          fromParcelStatus: "FAILED",
          toParcelStatus: "OUT_FOR_DELIVERY",
          actorUserId: 1,
          occurredAt: new Date("2026-10-26T08:00:00.000Z"),
          payload,
        });
      const before = await businessSnapshot();
      const prepared = await withTx((tx) =>
        prepareShipmentWorkflowDocumentsTx(tx, {
          consignmentId: 1,
          branchId: 1,
        }),
      );
      expect(prepared.map((row) => row.id).sort()).toEqual(
        frozen.map((row) => row.id).sort(),
      );
      expect(await db().select().from(deliveryDocumentSnapshots)).toEqual(
        frozen,
      );
      expect(await businessSnapshot()).toEqual(before);
    },
  );

  it.each([
    { partyId: 2, sourceType: "INVOICE", sourceId: 1 },
    { partyId: 2 },
    { sourceId: 999 },
  ])(
    "does not skip a newer assignment with conflicting or incomplete identity %j",
    async (payload) => {
      await withTx((tx) =>
        captureShipmentAssignmentDocumentsTx(tx, {
          consignmentId: 1,
          branchId: 1,
          eventKey: "print:assignment:original",
        }),
      );
      await db()
        .insert(s.deliveryEvents)
        .values({
          consignmentId: 1,
          eventKey: "print:bad-assignment",
          eventType: "OUT_FOR_DELIVERY",
          actorUserId: 1,
          occurredAt: new Date("2026-10-26T08:00:00.000Z"),
          payload,
        });
      await expect(
        withTx((tx) =>
          prepareShipmentWorkflowDocumentsTx(tx, {
            consignmentId: 1,
            branchId: 1,
          }),
        ),
      ).rejects.toThrow(/إسناد أصلية/);
    },
  );

  it("recovers the same original print before and after completion while rejecting different requests and cross-branch replay", async () => {
    const [snapshotId] = await withTx((tx) =>
      captureShipmentAssignmentDocumentsTx(tx, {
        consignmentId: 1,
        branchId: 1,
        eventKey: "print:assignment:original",
      }),
    );
    const command = {
      snapshotId,
      branchId: 1,
      clientRequestId: "lost-original-response",
      copyType: "ORIGINAL" as const,
      requestedBy: 1,
    };
    const before = await businessSnapshot();
    const attempt = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, command),
    );
    expect(
      await withTx((tx) => requestDeliveryDocumentPrintTx(tx, command)),
    ).toEqual({ print: attempt.print, idempotentReplay: true });
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          ...command,
          printerKey: "different-printer",
        }),
      ),
    ).rejects.toThrow(/طلب مختلف/);
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          ...command,
          clientRequestId: "different-original",
        }),
      ),
    ).rejects.toThrow(/قيد التنفيذ/);
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, { ...command, branchId: 2 }),
      ),
    ).rejects.toThrow(/الفرع/);
    await withTx((tx) =>
      completeDeliveryDocumentPrintTx(tx, {
        printId: attempt.print.id,
        branchId: 1,
        status: "SENT",
      }),
    );
    const replay = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, command),
    );
    expect(replay).toMatchObject({
      print: { id: attempt.print.id, status: "SENT" },
      idempotentReplay: true,
    });
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          ...command,
          clientRequestId: "different-original",
        }),
      ),
    ).rejects.toThrow(/طُبعت النسخة الأصلية/);
    expect(await db().select().from(deliveryDocumentPrints)).toHaveLength(1);
    expect(await businessSnapshot()).toEqual(before);
  });

  it("freezes a quantity-only settlement document on its own source and never reposts on replay or reprint", async () => {
    await db()
      .insert(s.users)
      .values([
        {
          id: 2,
          openId: "document-aftercare-approver",
          role: "admin",
          isOwner: true,
          branchId: 1,
        },
        {
          id: 3,
          openId: "document-aftercare-poster",
          role: "admin",
          isOwner: true,
          branchId: 1,
        },
      ]);
    const approver = { userId: 2, branchId: 1, role: "admin" };
    const reviewer = { userId: 3, branchId: 1, role: "admin" };
    const [originalItem] = await db()
      .select({ id: s.invoiceItems.id })
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, 1));
    const created = await createAftercareCase(
      {
        branchId: 1,
        invoiceId: 1,
        clientRequestId: "document-aftercare-create",
        reason: "بديل لنقص موثق",
        evidence: "محضر أصل المبيع",
        lines: [
          {
            originalInvoiceItemId: originalItem.id,
            componentVariantId: 1,
            baseQuantity: 1,
            disposition: "REPLACEMENT",
            evidence: "دليل نقص فعلي",
          },
        ],
      },
      actor,
    );
    await approveAftercareCase(
      {
        id: created.id,
        expectedVersion: 1,
        clientRequestId: "document-aftercare-approve",
      },
      approver,
    );
    let detail = await getAftercareCase(created.id, approver);
    await prepareAftercareExecution(
      {
        id: created.id,
        expectedVersion: detail.case.version,
        clientRequestId: "document-aftercare-prepare",
        recipientName: "عميل المستند",
        recipientPhone: "07700000000",
        deliveryAddress: "عنوان المصدر",
        deliveryFee: "0.00",
        lines: [{ aftercareLineId: detail.lines[0].id, baseQuantity: 1 }],
      },
      approver,
    );
    detail = await getAftercareCase(created.id, approver);
    const input = {
      id: created.id,
      expectedVersion: detail.case.version,
      reason: "توقف البديل بمحضر موثق",
      evidence: "وصل البديل الصالح وفحص فعلياً",
      physicalHeldConfirmed: true,
      sourceRights: [],
      decisions: detail.executions.flatMap((execution) =>
        execution.lines.map((line) => ({
          executionLineId: line.id,
          usableBaseQuantity: line.baseQuantity,
          consumedBaseQuantity: 0,
          damagedBaseQuantity: 0,
          evidence: "صالح مفحوص",
        })),
      ),
    };
    const preview = await previewAftercareSettlement(input, approver);
    const settlement = await requestAftercareSettlement(
      {
        ...input,
        previewHash: preview.previewHash,
        clientRequestId: "document-settlement-request",
      },
      approver,
    );
    await approveAftercareSettlement(
      {
        id: settlement.id,
        expectedVersion: 1,
        clientRequestId: "document-settlement-approve",
      },
      reviewer,
    );
    const command = {
      id: settlement.id,
      expectedVersion: 2,
      clientRequestId: "document-settlement-post",
    };
    const result = await postAftercareSettlement(command, reviewer);
    const snapshots = await withTx((tx) =>
      listDeliveryDocumentSnapshotsTx(tx, {
        sourceType: "AFTERCARE_SETTLEMENT",
        sourceId: settlement.id,
        branchId: 1,
      }),
    );
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    expect(result.documentSnapshotIds).toEqual([snapshot.id]);
    expect(snapshot.documentType).toBe("AFTERCARE_SETTLEMENT");
    expect(snapshot.payload).toMatchObject({
      schemaVersion: 1,
      title: "محضر تسوية عهدة المعالجة",
      rows: expect.arrayContaining([
        { label: "رقم التسوية", value: String(settlement.id) },
      ]),
      totals: [{ label: "عدد أسطر عهدة المعالجة المسواة", value: "1" }],
    });
    expect(Object.keys(snapshot.payload as object).sort()).toEqual(
      [
        "schemaVersion",
        "title",
        "documentNumber",
        "eventOccurredAt",
        "rows",
        "totals",
        "notice",
      ].sort(),
    );
    expect(JSON.stringify(snapshot.payload)).not.toMatch(
      /cost|originalIssueValue|restoredValue|commercialAmount/i,
    );
    const committed = await businessSnapshot();
    expect(
      (await postAftercareSettlement(command, reviewer)).documentSnapshotIds,
    ).toEqual([snapshot.id]);
    const attempt = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, {
        snapshotId: snapshot.id,
        branchId: 1,
        clientRequestId: "document-settlement-reprint",
        copyType: "REPRINT",
        reason: "نسخة من المحضر المعتمد",
        requestedBy: 3,
      }),
    );
    await withTx((tx) =>
      completeDeliveryDocumentPrintTx(tx, {
        printId: attempt.print.id,
        branchId: 1,
        status: "SENT",
      }),
    );
    const replay = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, {
        snapshotId: snapshot.id,
        branchId: 1,
        clientRequestId: "document-settlement-reprint",
        copyType: "REPRINT",
        reason: "نسخة من المحضر المعتمد",
        requestedBy: 3,
      }),
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(await db().select().from(deliveryDocumentSnapshots)).toHaveLength(1);
    expect(await businessSnapshot()).toEqual(committed);
  });
  it("captures the committed assignment slip, label and manifest without business postings", async () => {
    const before = await businessSnapshot();
    const ids = await withTx((tx) =>
      captureShipmentAssignmentDocumentsTx(tx, {
        consignmentId: 1,
        branchId: 1,
        eventKey: "print:assignment:original",
      }),
    );
    expect(ids).toHaveLength(3);
    const rows = await db().select().from(deliveryDocumentSnapshots);
    expect(rows.map((row) => row.documentType).sort()).toEqual([
      "DELIVERY_MANIFEST",
      "DISPATCH_SLIP",
      "SHIPPING_LABEL",
    ]);
    expect(
      (
        rows.find((row) => row.documentType === "DELIVERY_MANIFEST")!
          .payload as GenericWorkflowDocumentPayload
      ).title,
    ).toBe("محضر تسليم طرود لجهة التوصيل");
    expect(await businessSnapshot()).toEqual(before);
  });

  it("recovers the same original-print request before rejecting a genuinely new original", async () => {
    const [snapshotId] = await withTx((tx) =>
      captureShipmentAssignmentDocumentsTx(tx, {
        consignmentId: 1,
        branchId: 1,
        eventKey: "print:assignment:original",
      }),
    );
    const command = {
      snapshotId,
      branchId: 1,
      clientRequestId: "original-print-lost-response",
      copyType: "ORIGINAL" as const,
      requestedBy: 1,
    };
    const first = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, command),
    );
    expect(
      await withTx((tx) => requestDeliveryDocumentPrintTx(tx, command)),
    ).toMatchObject({
      print: { id: first.print.id, status: "REQUESTED" },
      idempotentReplay: true,
    });
    await withTx((tx) =>
      completeDeliveryDocumentPrintTx(tx, {
        printId: first.print.id,
        branchId: 1,
        status: "SENT",
      }),
    );
    expect(
      await withTx((tx) => requestDeliveryDocumentPrintTx(tx, command)),
    ).toMatchObject({
      print: { id: first.print.id, status: "SENT" },
      idempotentReplay: true,
    });
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          ...command,
          clientRequestId: "another-original-print-request",
        }),
      ),
    ).rejects.toThrow(/النسخة الأصلية/);
  });

  it("ignores a later departure transition when bootstrapping the assignment documents", async () => {
    await db()
      .insert(s.deliveryEvents)
      .values({
        id: 2,
        consignmentId: 1,
        eventKey: "print:departure:retry",
        eventType: "OUT_FOR_DELIVERY",
        actorUserId: 1,
        occurredAt: new Date("2026-10-25T09:00:00.000Z"),
        payload: { reason: "غادرت الشحنة بعد إعادة المحاولة" },
      });
    const ids = await withTx((tx) =>
      bootstrapHistoricalShipmentDocumentSnapshotsTx(tx, {
        consignmentId: 1,
        branchId: 1,
      }),
    );
    expect(ids).toHaveLength(3);
    const [slip] = await db()
      .select()
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.documentType, "DISPATCH_SLIP"));
    expect(slip.eventOccurredAt).toEqual(eventAt);
    expect((slip.payload as ShipmentDispatchDocumentPayload).party).toEqual({
      id: 1,
      name: "الجهة الأولى",
    });
  });

  it("selects the newest REASSIGNED event despite an old slip/label pair and retains both generations", async () => {
    await withTx((tx) =>
      captureShipmentAssignmentDocumentsTx(tx, {
        consignmentId: 1,
        branchId: 1,
        eventKey: "print:assignment:original",
      }),
    );
    await db()
      .delete(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.documentType, "DELIVERY_MANIFEST"));
    await db()
      .update(s.deliveryConsignments)
      .set({ partyId: 2 })
      .where(eq(s.deliveryConsignments.id, 1));
    await db()
      .insert(s.deliveryEvents)
      .values({
        id: 2,
        consignmentId: 1,
        eventKey: "print:assignment:new-party",
        eventType: "REASSIGNED",
        actorUserId: 1,
        occurredAt: new Date("2026-10-26T08:00:00.000Z"),
        payload: {
          partyId: 2,
          partyName: "الجهة الجديدة وقت الإسناد",
          sourceType: "INVOICE",
          sourceId: 1,
        },
      });
    const latest = await withTx((tx) =>
      bootstrapHistoricalShipmentDocumentSnapshotsTx(tx, {
        consignmentId: 1,
        branchId: 1,
      }),
    );
    expect(latest).toHaveLength(3);
    const rows = await withTx((tx) =>
      listDeliveryDocumentSnapshotsTx(tx, {
        sourceType: "SHIPMENT",
        sourceId: 1,
        branchId: 1,
      }),
    );
    expect(rows).toHaveLength(5);
    const label = rows.find((row) => row.documentType === "SHIPPING_LABEL")!;
    expect((label.payload as ShipmentDispatchDocumentPayload).party).toEqual({
      id: 2,
      name: "الجهة الجديدة وقت الإسناد",
    });
    expect(label.eventOccurredAt.toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(
      await withTx((tx) =>
        bootstrapHistoricalShipmentDocumentSnapshotsTx(tx, {
          consignmentId: 1,
          branchId: 1,
        }),
      ),
    ).toEqual(latest);
  });

  it("creates fresh snapshots for the actual reassignment and replays without duplicate documents", async () => {
    await withTx((tx) =>
      captureShipmentAssignmentDocumentsTx(tx, {
        consignmentId: 1,
        branchId: 1,
        eventKey: "print:assignment:original",
      }),
    );
    const input = {
      consignmentId: 1,
      partyId: 1,
      clientRequestId: "print-reassign-once",
    };
    const before = await businessSnapshot();
    const result = await reassignDeliveryConsignment(input, actor);
    expect(result.documentSnapshotIds).toHaveLength(3);
    const rows = await db().select().from(deliveryDocumentSnapshots);
    expect(rows).toHaveLength(6);
    await reassignDeliveryConsignment(input, actor);
    expect(await db().select().from(deliveryDocumentSnapshots)).toEqual(rows);
    expect(await businessSnapshot()).toEqual(before);
  });

  it("commits a physical inspection receipt with no stock, sale or refund and retains its exact replay", async () => {
    const preview = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: 1 },
        station: "return",
        branchId: 1,
      },
      actor,
    );
    const input = {
      source: {
        kind: preview.source.kind,
        id: preview.source.id,
        expectedVersion: preview.source.version,
      },
      branchId: 1,
      inspected: true as const,
      evidence: "استلمت الطرد وفحصته فعلياً في المكتبة",
      clientRequestId: "print-physical-return-once",
    };
    const before = await businessSnapshot();
    const result = await receiveWorkflowReturn(input, actor);
    expect(result.documentSnapshotIds).toHaveLength(1);
    const [receipt] = await db().select().from(deliveryDocumentSnapshots);
    expect(receipt.documentType).toBe("PHYSICAL_RETURN_RECEIPT");
    expect((receipt.payload as GenericWorkflowDocumentPayload).notice).toMatch(
      /لا يلغي البيع/,
    );
    expect(
      (await receiveWorkflowReturn(input, actor)).documentSnapshotIds,
    ).toEqual(result.documentSnapshotIds);
    expect(await db().select().from(deliveryDocumentSnapshots)).toHaveLength(1);
    expect(await businessSnapshot()).toEqual(before);
  });

  it("prints actual customer collection as a delivery confirmation, never as courier remittance", async () => {
    const preview = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: 1 },
        station: "collect",
        branchId: 1,
      },
      actor,
    );
    const input = {
      source: {
        kind: preview.source.kind,
        id: preview.source.id,
        expectedVersion: preview.source.version,
      },
      branchId: 1,
      evidence: "إفادة التسليم والتحصيل الفعلي من العميل",
      clientRequestId: "print-customer-collection-once",
    };
    const result = await confirmWorkflowDelivery(input, actor);
    const [snapshot] = await db().select().from(deliveryDocumentSnapshots);
    expect(snapshot.documentType).toBe("DELIVERY_MANIFEST");
    expect(snapshot.payload).toMatchObject({
      title: "محضر تسليم وتحصيل العميل",
      totals: expect.arrayContaining([
        { label: "المقبوض الفعلي من العميل", value: "100.00" },
      ]),
    });
    expect(
      (await confirmWorkflowDelivery(input, actor)).documentSnapshotIds,
    ).toEqual(result.documentSnapshotIds);
    expect(await db().select().from(deliveryDocumentSnapshots)).toHaveLength(1);
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
  });

  it("prepares remittance and settlement pages from persisted source documents without reposting", async () => {
    await db().insert(s.deliveryRemittances).values({
      id: 1,
      remittanceNumber: "PRINT-DR-1",
      branchId: 1,
      partyId: 1,
      collectedTotal: "100.00",
      feesTotal: "5.00",
      deductionsTotal: "2.00",
      netRemitted: "93.00",
      shortfallTotal: "0.00",
      status: "BALANCED",
      receivedBy: 1,
      receivedAt: eventAt,
    });
    await db().insert(s.deliveryRemittanceLines).values({
      remittanceId: 1,
      consignmentId: 1,
      grossApplied: "100.00",
      feeOffset: "5.00",
      cashReceived: "95.00",
    });
    const before = await businessSnapshot();
    const docs = await withTx((tx) =>
      prepareShipmentWorkflowDocumentsTx(tx, { consignmentId: 1, branchId: 1 }),
    );
    expect(docs.map((row) => row.documentType)).toEqual(
      expect.arrayContaining(["REMITTANCE_RECEIPT", "PARTY_SETTLEMENT"]),
    );
    const receipt = docs.find(
      (row) => row.documentType === "REMITTANCE_RECEIPT",
    )!;
    expect(receipt.payload).toMatchObject({
      documentNumber: "PRINT-DR-1",
      eventOccurredAt: eventAt.toISOString(),
      totals: expect.arrayContaining([
        { label: "صافي التوريد", value: "93.00" },
      ]),
    });
    expect(
      await withTx((tx) =>
        prepareShipmentWorkflowDocumentsTx(tx, {
          consignmentId: 1,
          branchId: 1,
        }),
      ),
    ).toHaveLength(docs.length);
    expect(await businessSnapshot()).toEqual(before);
    await expect(
      withTx((tx) =>
        prepareShipmentWorkflowDocumentsTx(tx, {
          consignmentId: 1,
          branchId: 2,
        }),
      ),
    ).rejects.toThrow(/الفرع/);
  });

  it("hides invoice snapshots and forbids printing them without blocking non-invoice documents sourced by an invoice", async () => {
    const base = {
      layout: "THERMAL_80_CONTENT_72" as const,
      sourceType: "INVOICE" as const,
      sourceId: 1,
      sourceVersion: "v1",
      branchId: 1,
      eventOccurredAt: eventAt,
      payload: { label: "مستند محمي" },
      createdBy: 1,
    };
    const invoice = await withTx((tx) =>
      createDeliveryDocumentSnapshotTx(tx, {
        ...base,
        documentType: "INVOICE",
        eventKey: "invoice-document-only",
      }),
    );
    const operational = await withTx((tx) =>
      createDeliveryDocumentSnapshotTx(tx, {
        ...base,
        documentType: "SALE_RETURN_RECEIPT",
        eventKey: "return-receipt-source-invoice",
      }),
    );
    const docs = await withTx((tx) =>
      listDeliveryDocumentSnapshotsTx(tx, {
        sourceType: "INVOICE",
        sourceId: 1,
        branchId: 1,
      }),
    );
    expect(docs.map((row) => row.id)).toEqual([operational.snapshot.id]);
    await expect(
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          snapshotId: invoice.snapshot.id,
          branchId: 1,
          clientRequestId: "invoice-denied-print",
          copyType: "ORIGINAL",
          requestedBy: 1,
        }),
      ),
    ).rejects.toThrow(/مسار الفواتير/);
    expect(await db().select().from(deliveryDocumentPrints)).toHaveLength(0);
    const attempt = await withTx((tx) =>
      requestDeliveryDocumentPrintTx(tx, {
        snapshotId: operational.snapshot.id,
        branchId: 1,
        clientRequestId: "operational-source-invoice-print",
        copyType: "ORIGINAL",
        requestedBy: 1,
      }),
    );
    expect(
      (
        await withTx((tx) =>
          completeDeliveryDocumentPrintTx(tx, {
            printId: attempt.print.id,
            branchId: 1,
            status: "SENT",
          }),
        )
      ).print.status,
    ).toBe("SENT");
    const preview = await previewWorkflowSource(
      {
        source: { kind: "consignment", id: 1 },
        station: "collect",
        branchId: 1,
      },
      actor,
    );
    expect(
      preview.availableDocuments.find((row) => row.type === "INVOICE"),
    ).toMatchObject({ allowed: false });
  });
});
