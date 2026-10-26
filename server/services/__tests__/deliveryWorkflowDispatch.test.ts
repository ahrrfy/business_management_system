import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  fulfillmentRequestItems,
  fulfillmentRequests,
  fulfillmentCharges,
  fulfillmentChargePayments,
  deliveryDocumentSnapshots,
} from "../../../drizzle/fulfillmentSchema";
import type { WorkflowDispatchBatchInput } from "../../../shared/deliveryWorkflow";
import { docBarcode } from "../../../shared/documentNumber";
import { getDb } from "../../db";
import {
  dispatchWorkflowBatch,
  previewWorkflowBatch,
} from "../delivery/workflow/dispatch";
import { createChargeOnlyCheckout } from "../checkoutCharges";
import {
  createFulfillmentCharge,
  approveFulfillmentCharge,
} from "../fulfillment/charges";
import { confirmWorkflowDelivery } from "../delivery/workflow/collection";
import { previewWorkflowScan } from "../delivery/workflow/preview";
import { mutateWorkflowAssignment } from "../delivery/workflow/assignment";
import {
  createFulfillmentRequest,
  releaseFulfillmentRequest,
} from "../fulfillment/requests";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { dispatchInvoiceShipment } from "../delivery/shipments";
import {
  createShipmentDispatchDocumentSnapshotsTx,
  prepareShipmentWorkflowDocumentsTx,
  type ShipmentDispatchDocumentPayload,
} from "../delivery/documentSnapshots";
import { withTx } from "../tx";
import { idempotencyHash } from "../idempotency";

const actor = { userId: 1, role: "admin", branchId: 1 };
const db = () => {
  const value = getDb();
  if (!value) throw new Error("Isolated DB required");
  return value;
};
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "batch-owner",
        operationalCaps: { maxServiceChargeAmountIqd: "10000" },
        role: "admin",
        isOwner: true,
        branchId: 1,
      },
      { id: 2, openId: "batch-driver", role: "cashier", branchId: 1 },
    ]);
  await db()
    .insert(s.customers)
    .values([
      {
        id: 1,
        name: "عميل الشحنة",
        phone: "+9647701234567",
        currentBalance: "0",
        creditLimit: null,
      },
      { id: 2, name: "عميل آخر", phone: "+9647711234567", currentBalance: "0" },
    ]);
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب الموظفين",
    partyType: "INDIVIDUAL",
    userId: 2,
    branchId: 1,
    isActive: true,
    currentBalance: "0",
  });
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    shiftType: "RETAIL",
    openingBalance: "0",
    status: "OPEN",
    openGuard: "1:1:RETAIL",
  });
  await db()
    .insert(s.invoices)
    .values(
      [1, 2].map((id) => ({
        id,
        invoiceNumber: String(80000 + id),
        branchId: 1,
        customerId: 1,
        subtotal: "10000",
        total: "10000",
        paidAmount: "10000",
        status: "PAID" as const,
        createdBy: 1,
      })),
    );
});
async function input(): Promise<WorkflowDispatchBatchInput> {
  const sources = [];
  for (const raw of ["INV-80001", "INV-80002"]) {
    const p = await previewWorkflowScan(
      { raw, station: "dispatch", branchId: 1 },
      actor,
    );
    sources.push({
      kind: p.source.kind,
      id: p.source.id,
      expectedVersion: p.source.version,
    });
  }
  return {
    sources,
    branchId: 1,
    partyId: 1,
    assignedUserId: 2,
    deliveryFee: "0",
    feeCollection: "COURIER",
    recipientName: "عميل الشحنة",
    recipientPhone: "07701234567",
    deliveryAddress: "بغداد المنصور قرب المكتبة",
    clientRequestId: "workflow-batch-0001",
  };
}
async function noDuplicateEffects() {
  return {
    invoices: await db().select().from(s.invoices),
    stock: await db().select().from(s.branchStock),
    movements: await db().select().from(s.inventoryMovements),
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
  };
}
async function collectionEffects() {
  return {
    invoices: await db().select().from(s.invoices),
    customers: await db().select().from(s.customers),
    parties: await db().select().from(s.deliveryParties),
    consignments: await db().select().from(s.deliveryConsignments),
    ledger: await db().select().from(s.deliveryLedgerEntries),
    remittances: await db().select().from(s.deliveryRemittances),
    receipts: await db().select().from(s.receipts),
  };
}
async function useSparseNativeRole(grants: Record<string, boolean>) {
  await db()
    .insert(s.roles)
    .values({
      id: 7001,
      key: "workflow-sparse-native",
      label: "تفويض إرسال أصلي محفوظ",
      baseRole: "admin",
      permissions: { store: "FULL" },
      operationPolicy: { version: 1, grants },
      isActive: true,
    });
  await db()
    .update(s.users)
    .set({ isOwner: false, customRoleId: 7001, operationPolicy: null })
    .where(eq(s.users.id, 1));
}
describe("atomic barcode batch dispatch", () => {
  it.each([
    { channel: "workflow", legacy: false, degraded: false },
    { channel: "workflow", legacy: true, degraded: false },
    { channel: "invoice", legacy: false, degraded: false },
    { channel: "invoice", legacy: true, degraded: false },
    { channel: "workflow", legacy: true, degraded: true },
  ])(
    "preserves committed $channel snapshots during preparation (legacy=$legacy)",
    async ({ channel, legacy, degraded }) => {
      const command = await input();
      command.deliveryFee = "5000";
      const dispatched =
        channel === "workflow"
          ? await dispatchWorkflowBatch(command, actor)
          : await dispatchInvoiceShipment(
              {
                invoiceId: 1,
                invoiceIds: [1, 2],
                partyId: 1,
                assignedUserId: 2,
                deliveryFee: command.deliveryFee,
                feeCollection: "COURIER",
                recipientName: command.recipientName,
                recipientPhone: command.recipientPhone,
                deliveryAddress: command.deliveryAddress,
                clientRequestId: "group-print-preparation",
              },
              actor,
            );
      if (legacy) {
        const rows = await db().select().from(deliveryDocumentSnapshots);
        for (const row of rows.filter(
          (row) => row.documentType !== "DELIVERY_MANIFEST",
        )) {
          const payload = row.payload as { evidence: { eventId?: number } };
          delete payload.evidence.eventId;
          await db()
            .update(deliveryDocumentSnapshots)
            .set({ payload, payloadHash: idempotencyHash(payload) })
            .where(eq(deliveryDocumentSnapshots.id, row.id));
        }
      }
      const committed = await db().select().from(deliveryDocumentSnapshots);
      if (degraded) {
        const slip = committed.find(
          (row) => row.documentType === "DISPATCH_SLIP",
        )!;
        const [assignment] = await db()
          .select()
          .from(s.deliveryEvents)
          .where(eq(s.deliveryEvents.consignmentId, dispatched.consignmentId));
        const payload = structuredClone(
          slip.payload as ShipmentDispatchDocumentPayload,
        );
        const eventKey = "legacy-degraded-duplicate";
        payload.evidence = {
          ...payload.evidence,
          mode: "HISTORICAL_ORIGINAL_EVIDENCE",
          eventId: assignment.id,
          eventKey,
        };
        payload.money = {
          ...payload.money,
          currentTotal: null,
          paidAmount: null,
          deliveryFee: null,
        };
        payload.invoices = payload.invoices.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: `#${invoice.id}`,
          total: null,
        }));
        await withTx((tx) =>
          createShipmentDispatchDocumentSnapshotsTx(tx, {
            consignmentId: dispatched.consignmentId,
            branchId: 1,
            eventKey,
            eventOccurredAt: slip.eventOccurredAt,
            createdBy: 1,
            payload,
          }),
        );
      }
      const frozen = await db().select().from(deliveryDocumentSnapshots);
      await db()
        .update(s.invoices)
        .set({ paidAmount: "9000", status: "PARTIALLY_PAID" })
        .where(eq(s.invoices.id, 2));
      const before = await noDuplicateEffects();
      const prepared = await withTx((tx) =>
        prepareShipmentWorkflowDocumentsTx(tx, {
          consignmentId: dispatched.consignmentId,
          branchId: 1,
        }),
      );
      expect(prepared.map((row) => row.id).sort()).toEqual(
        frozen.map((row) => row.id).sort(),
      );
      expect(await db().select().from(deliveryDocumentSnapshots)).toEqual(
        frozen,
      );
      const selected = [
        "DISPATCH_SLIP",
        "SHIPPING_LABEL",
        "DELIVERY_MANIFEST",
      ].map((type) => prepared.find((row) => row.documentType === type)!);
      expect(selected.map((row) => row.id).sort()).toEqual(
        committed.map((row) => row.id).sort(),
      );
      for (const row of selected.filter(
        (row) => row.documentType !== "DELIVERY_MANIFEST",
      ))
        expect(row.payload).toMatchObject({
          evidence: { mode: "COMMITTED_DISPATCH_EVENT" },
          money: {
            deliveryFee: "5000.00",
            currentTotal: "20000.00",
            paidAmount: "20000.00",
          },
          invoices: expect.arrayContaining([
            expect.objectContaining({
              id: 1,
              invoiceNumber: "80001",
              total: "10000.00",
              paidAmount: "10000.00",
              returnedTotal: "0.00",
              status: "PAID",
            }),
          ]),
        });
      expect(await noDuplicateEffects()).toEqual(before);
    },
  );
  it("checks every locked implicit FR member before invoice-only authority can materialize an unbilled work order", async () => {
    await db().insert(s.workOrders).values({
      id: 51,
      orderNumber: "READY-UNBILLED-51",
      branchId: 1,
      customerId: 1,
      title: "خدمة فعلية جاهزة غير مفوترة",
      status: "READY",
      salePrice: "7000",
      deposit: "0",
      paymentMode: "COD",
      createdBy: 1,
    });
    const base = await input();
    const request = await createFulfillmentRequest(
      {
        branchId: 1,
        customerId: 1,
        recipientName: base.recipientName,
        recipientPhone: base.recipientPhone,
        deliveryAddress: base.deliveryAddress,
        partyId: 1,
        deliveryFee: "0",
        feeCollection: "COURIER",
        sources: [{ invoiceId: 1 }, { workOrderId: 51 }],
        clientRequestId: "expanded-fr-source-create",
      },
      actor,
    );
    await useSparseNativeRole({
      "operation.delivery.dispatchInvoice": true,
      "operation.delivery.dispatch": false,
      "operation.delivery.dispatchByBarcode": false,
      "operation.delivery.fulfillment.requests.release": false,
    });
    const p = await previewWorkflowScan(
      { raw: "INV-80001", station: "dispatch", branchId: 1 },
      actor,
    );
    expect(p.source.kind).toBe("invoice");
    expect(p.relations.fulfillmentRequestId).toBe(request.id);
    const payload = {
      ...base,
      sources: [
        {
          kind: p.source.kind,
          id: p.source.id,
          expectedVersion: p.source.version,
        },
      ],
      clientRequestId: "expanded-fr-source-denied",
    };
    const before = await noDuplicateEffects(),
      ordersBefore = await db().select().from(s.workOrders),
      countersBefore = await db().select().from(s.documentCounters),
      requestsBefore = await db().select().from(fulfillmentRequests),
      itemsBefore = await db().select().from(fulfillmentRequestItems);
    await expect(dispatchWorkflowBatch(payload, actor)).rejects.toThrow(
      /صلاحية إرساله|الصلاحية|مفوضة/,
    );
    expect(await noDuplicateEffects()).toEqual(before);
    expect(await db().select().from(s.workOrders)).toEqual(ordersBefore);
    expect(await db().select().from(s.documentCounters)).toEqual(
      countersBefore,
    );
    expect(await db().select().from(fulfillmentRequests)).toEqual(
      requestsBefore,
    );
    expect(await db().select().from(fulfillmentRequestItems)).toEqual(
      itemsBefore,
    );
    await db()
      .update(s.roles)
      .set({
        operationPolicy: {
          version: 1,
          grants: {
            "operation.delivery.dispatchInvoice": true,
            "operation.delivery.dispatch": false,
            "operation.delivery.dispatchByBarcode": false,
            "operation.delivery.fulfillment.requests.release": true,
          },
        },
      })
      .where(eq(s.roles.id, 7001));
    const allowed = await previewWorkflowScan(
      { raw: "INV-80001", station: "dispatch", branchId: 1 },
      actor,
    );
    await dispatchWorkflowBatch(
      {
        ...payload,
        sources: [
          {
            kind: allowed.source.kind,
            id: allowed.source.id,
            expectedVersion: allowed.source.version,
          },
        ],
        clientRequestId: "expanded-fr-native-release",
      },
      actor,
    );
    expect(
      (await db().select().from(s.workOrders).where(eq(s.workOrders.id, 51)))[0]
        ?.invoiceId,
    ).toBeTypeOf("number");
  });

  it("composes an ordinary barcode batch from a sparse saved native grant without granting public request CRUD", async () => {
    await useSparseNativeRole({ "operation.delivery.dispatchByBarcode": true });
    const payload = await input();
    const before = await noDuplicateEffects();
    const result = await dispatchWorkflowBatch(payload, actor);
    expect(result.invoiceIds).toEqual([1, 2]);
    expect(await noDuplicateEffects()).toEqual(before);
    expect((await dispatchWorkflowBatch(payload, actor)).consignmentId).toBe(
      result.consignmentId,
    );
    const { createFulfillmentRequest } =
      await import("../fulfillment/requests");
    await expect(
      createFulfillmentRequest(
        {
          branchId: 1,
          customerId: 1,
          recipientName: payload.recipientName,
          recipientPhone: payload.recipientPhone,
          deliveryAddress: payload.deliveryAddress,
          partyId: 1,
          deliveryFee: "0",
          feeCollection: "COURIER",
          sources: [],
          clientRequestId: "public-request-crud-stays-denied",
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each([
    { "operation.delivery.fulfillment.aftercare.dispatch": true },
    {
      "operation.delivery.dispatchByBarcode": true,
      "operation.delivery.workflow.dispatchBatch": false,
    },
    {
      "operation.delivery.dispatchByBarcode": false,
      "operation.delivery.workflow.dispatchBatch": true,
    },
  ])(
    "rejects an ordinary batch without its actual native grant or with an explicit workflow denial before effects: %j",
    async (grants) => {
      await useSparseNativeRole(grants);
      const payload = await input();
      const before = await noDuplicateEffects();
      await expect(dispatchWorkflowBatch(payload, actor)).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );
      expect(await noDuplicateEffects()).toEqual(before);
      expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
      expect(await db().select().from(fulfillmentRequests)).toHaveLength(0);
    },
  );

  it("keeps a real unlinked external individual carrier usable without inventing an ERP employee", async () => {
    const payload = await input();
    await db()
      .update(s.deliveryParties)
      .set({ userId: null })
      .where(eq(s.deliveryParties.id, 1));
    const result = await dispatchWorkflowBatch(
      { ...payload, assignedUserId: undefined },
      actor,
    );
    expect(
      (
        await db()
          .select()
          .from(s.deliveryConsignments)
          .where(eq(s.deliveryConsignments.id, result.consignmentId))
      )[0]?.assignedUserId,
    ).toBeNull();
  });
  it("refuses an inactive linked employee instead of downgrading the party to an external carrier", async () => {
    const payload = await input();
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, 2));
    await expect(dispatchWorkflowBatch(payload, actor)).rejects.toThrow(
      /غير نشط/,
    );
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
  });
  it("confirms live goods plus assigned service claims atomically and shows real carrier cash after customer due clears", async () => {
    const charge = await createFulfillmentCharge(
      {
        branchId: 1,
        customerId: 1,
        category: "SERVICE",
        description: "خدمة فعلية معتمدة",
        amount: "3000",
        externalCost: "0",
        clientRequestId: "workflow-approved-charge",
      },
      actor,
    );
    await approveFulfillmentCharge(
      {
        id: charge.id,
        expectedVersion: charge.version,
        clientRequestId: "workflow-approve-charge",
      },
      actor,
    );
    const chargePreview = await previewWorkflowScan(
      { raw: `CHG-${charge.id}`, station: "dispatch", branchId: 1 },
      actor,
    );
    const payload = await input();
    payload.sources.push({
      kind: "charge",
      id: charge.id,
      expectedVersion: chargePreview.source.version,
    });
    const dispatched = await dispatchWorkflowBatch(payload, actor);
    const preview = await previewWorkflowScan(
      {
        raw: docBarcode("CN", dispatched.consignmentNumber),
        station: "collect",
        branchId: 1,
      },
      actor,
    );
    expect(preview.money.codAmount).toBe("3000.00");
    const receiptsBefore = await db().select().from(s.receipts);
    const proof = {
      source: {
        kind: preview.source.kind,
        id: preview.source.id,
        expectedVersion: preview.source.version,
      },
      branchId: 1,
      evidence: "تحقق تسليم الشحنة وقبض أجورها الفعلية",
      clientRequestId: "workflow-proof-charge-group",
    };
    await confirmWorkflowDelivery(proof, actor);
    const current = await previewWorkflowScan(
      {
        raw: docBarcode("CN", dispatched.consignmentNumber),
        station: "collect",
        branchId: 1,
      },
      actor,
    );
    expect(current.money).toMatchObject({
      codAmount: "0.00",
      cashInCourierCustody: "3000.00",
    });
    expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
    expect((await confirmWorkflowDelivery(proof, actor)).idempotentReplay).toBe(
      true,
    );
    expect(await db().select().from(s.invoices)).toHaveLength(2);
  });
  it.each([
    { label: "single", invoiceCount: 1 },
    { label: "grouped", invoiceCount: 2 },
  ])(
    "freezes final $label goods and service COD after claims and preserves it on replay",
    async ({ invoiceCount }) => {
      await db()
        .update(s.invoices)
        .set({
          subtotal: invoiceCount === 1 ? "10000" : "5000",
          total: invoiceCount === 1 ? "10000" : "5000",
          paidAmount: "0",
          status: "PENDING",
          paymentMode: "COD",
        })
        .where(eq(s.invoices.id, 1));
      if (invoiceCount === 2)
        await db()
          .update(s.invoices)
          .set({
            subtotal: "5000",
            total: "5000",
            paidAmount: "0",
            status: "PENDING",
            paymentMode: "COD",
          })
          .where(eq(s.invoices.id, 2));
      await db()
        .update(s.customers)
        .set({ currentBalance: "10000" })
        .where(eq(s.customers.id, 1));
      const charge = await createFulfillmentCharge(
        {
          branchId: 1,
          customerId: 1,
          category: "SERVICE",
          description: "خدمة ملحقة بالشحنة",
          amount: "5000",
          externalCost: "0",
          clientRequestId: `snapshot-service-${invoiceCount}`,
        },
        actor,
      );
      await approveFulfillmentCharge(
        {
          id: charge.id,
          expectedVersion: charge.version,
          clientRequestId: `snapshot-service-approve-${invoiceCount}`,
        },
        actor,
      );
      const chargePreview = await previewWorkflowScan(
        { raw: `CHG-${charge.id}`, station: "dispatch", branchId: 1 },
        actor,
      );
      const payload = await input();
      payload.sources = payload.sources.slice(0, invoiceCount);
      payload.sources.push({
        kind: "charge",
        id: charge.id,
        expectedVersion: chargePreview.source.version,
      });
      payload.clientRequestId = `snapshot-final-claims-${invoiceCount}`;
      const result = await dispatchWorkflowBatch(payload, actor);
      const consignments = await db()
        .select()
        .from(s.deliveryConsignments)
        .where(
          eq(
            s.deliveryConsignments.fulfillmentRequestId,
            result.fulfillmentRequestId!,
          ),
        );
      expect(
        consignments.reduce((sum, row) => sum + Number(row.codAmount), 0),
      ).toBe(15_000);
      const snapshots = await db()
        .select()
        .from(deliveryDocumentSnapshots)
        .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId));
      expect(snapshots).toHaveLength(3);
      for (const snapshot of snapshots.filter(
        (row) => row.documentType !== "DELIVERY_MANIFEST",
      )) {
        const document = snapshot.payload as {
          invoiceIds: number[];
          money: {
            codAmount: string;
            currentTotal: string;
            paidAmount: string;
          };
        };
        expect(document.invoiceIds).toEqual(invoiceCount === 1 ? [1] : [1, 2]);
        expect(document.money).toMatchObject({
          codAmount: "15000.00",
          currentTotal: "10000.00",
          paidAmount: "0.00",
        });
      }
      expect(await dispatchWorkflowBatch(payload, actor)).toMatchObject({
        consignmentId: result.consignmentId,
        idempotentReplay: true,
      });
      expect(
        await db()
          .select()
          .from(deliveryDocumentSnapshots)
          .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId)),
      ).toEqual(snapshots);
    },
  );
  it("requires a classified reason for barcode partial collection and replays collection and remittance without duplicate AR or custody", async () => {
    await db()
      .update(s.invoices)
      .set({ paidAmount: "0", status: "PENDING", paymentMode: "COD" });
    await db()
      .update(s.customers)
      .set({ currentBalance: "20000" })
      .where(eq(s.customers.id, 1));
    const payload = await input();
    payload.clientRequestId = "workflow-partial-dispatch";
    const dispatched = await dispatchWorkflowBatch(payload, actor);
    const preview = await previewWorkflowScan(
      {
        raw: docBarcode("CN", dispatched.consignmentNumber),
        station: "collect",
        branchId: 1,
      },
      actor,
    );
    expect(preview.money.codAmount).toBe("20000.00");
    const baseProof = {
      source: {
        kind: preview.source.kind,
        id: preview.source.id,
        expectedVersion: preview.source.version,
      },
      branchId: 1,
      evidence: "إفادة اتصال المندوب بعد التسليم",
      collectedAmount: "15000",
      clientRequestId: "workflow-partial-collection",
    };
    const beforeRejected = await collectionEffects();
    await expect(confirmWorkflowDelivery(baseProof, actor)).rejects.toThrow(
      /سبب العجز/,
    );
    expect(await collectionEffects()).toEqual(beforeRejected);

    const proof = {
      ...baseProof,
      shortfallReason: "PARTIAL_REFUSAL",
    };
    expect(await confirmWorkflowDelivery(proof, actor)).toMatchObject({
      consignmentId: dispatched.consignmentId,
      idempotentReplay: false,
    });
    const afterCollection = await collectionEffects();
    expect(afterCollection.invoices.map((row) => row.paidAmount)).toEqual([
      "10000.00",
      "10000.00",
    ]);
    expect(afterCollection.customers[0]?.currentBalance).toBe("0.00");
    expect(afterCollection.parties[0]?.currentBalance).toBe("20000.00");
    expect(
      afterCollection.ledger
        .filter((row) => row.entryType === "COD_COLLECTED")
        .reduce((sum, row) => sum + Number(row.amount), 0),
    ).toBe(15000);
    expect(
      afterCollection.ledger
        .filter((row) => row.entryType === "SHORTFALL_ASSIGNED")
        .reduce((sum, row) => sum + Number(row.amount), 0),
    ).toBe(5000);
    expect(afterCollection.receipts).toHaveLength(0);
    expect(afterCollection.remittances).toHaveLength(0);
    expect(await confirmWorkflowDelivery(proof, actor)).toMatchObject({
      idempotentReplay: true,
    });
    expect(await collectionEffects()).toEqual(afterCollection);

    const cashLines = afterCollection.ledger
      .filter((row) => row.entryType === "COD_COLLECTED")
      .map((row) => ({
        consignmentId: Number(row.consignmentId),
        collectedAmount: row.amount,
      }));
    const remittance = {
      branchId: 1,
      partyId: 1,
      shiftType: "RETAIL" as const,
      targetShiftId: 1,
      lines: cashLines,
      countedCash: "15000",
      clientRequestId: "workflow-partial-remittance",
    };
    expect(await recordDeliveryRemittance(remittance, actor)).toMatchObject({
      idempotentReplay: false,
    });
    const afterRemittance = await collectionEffects();
    expect(afterRemittance.customers[0]?.currentBalance).toBe("0.00");
    expect(afterRemittance.parties[0]?.currentBalance).toBe("5000.00");
    expect(afterRemittance.remittances).toHaveLength(1);
    expect(afterRemittance.receipts).toHaveLength(1);
    expect(await recordDeliveryRemittance(remittance, actor)).toMatchObject({
      idempotentReplay: true,
    });
    expect(await collectionEffects()).toEqual(afterRemittance);
  });
  it("quotes one requested courier fee rather than per-source legacy delivery fees", async () => {
    const payload = await input();
    const preview = await previewWorkflowBatch(
      {
        sources: payload.sources,
        branchId: 1,
        deliveryFee: "5000",
        feeCollection: "COURIER",
      },
      actor,
    );
    expect(preview.summary).toMatchObject({
      goodsCodAmount: "0.00",
      courierFeeAmount: "5000.00",
      codAmount: "5000.00",
    });
  });
  it.each([1, null])(
    "dispatches real prepaid charge-only customer %s with zero COD and no second receipt/sale/stock/AR",
    async (customerId) => {
      const checkout = await createChargeOnlyCheckout(
        {
          branchId: 1,
          customerId,
          shiftId: 1,
          clientRequestId: `prepaid-charge-${customerId ?? "guest"}`,
          payments: [{ method: "CASH", amount: "0" }],
          serviceCharges: [{ description: "تجهيز فعلي مدفوع", amount: "3000" }],
          chargePayments: [{ paymentIndex: 0, amount: "3000" }],
        },
        actor,
        "POS",
      );
      const chargeId = checkout.chargeAllocations[0]!.chargeId;
      const p = await previewWorkflowScan(
        { raw: `CHG-${chargeId}`, station: "dispatch", branchId: 1 },
        actor,
      );
      expect(p.actions.find((a) => a.action === "dispatch")?.allowed).toBe(
        true,
      );
      const base = await input();
      const payload = {
        ...base,
        sources: [
          {
            kind: p.source.kind,
            id: p.source.id,
            expectedVersion: p.source.version,
          },
        ],
        clientRequestId: `dispatch-prepaid-${customerId ?? "guest"}`,
      };
      const before = await noDuplicateEffects(),
        customersBefore = await db().select().from(s.customers);
      const result = await dispatchWorkflowBatch(payload, actor);
      const [cn] = await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, result.consignmentId));
      expect(cn).toMatchObject({
        invoiceId: null,
        sourceType: "FULFILLMENT_REQUEST",
        codAmount: "0.00",
        endCustomerId: customerId,
      });
      const snapshots = await db()
        .select()
        .from(deliveryDocumentSnapshots)
        .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId));
      expect(snapshots).toHaveLength(3);
      for (const snapshot of snapshots.filter(
        (row) => row.documentType !== "DELIVERY_MANIFEST",
      )) {
        const document = snapshot.payload as {
          invoiceIds: number[];
          money: { codAmount: string; currentTotal: string };
        };
        expect(document.invoiceIds).toEqual([]);
        expect(document.money).toMatchObject({
          codAmount: "0.00",
          currentTotal: "0.00",
        });
      }
      expect(await noDuplicateEffects()).toEqual(before);
      expect(await db().select().from(s.customers)).toEqual(customersBefore);
      expect(await db().select().from(fulfillmentChargePayments)).toHaveLength(
        1,
      );
      expect(
        (
          await db()
            .select()
            .from(fulfillmentCharges)
            .where(eq(fulfillmentCharges.id, chargeId))
        )[0]?.requestId,
      ).toBe(result.fulfillmentRequestId);
      expect((await dispatchWorkflowBatch(payload, actor)).consignmentId).toBe(
        result.consignmentId,
      );
    },
  );
  it("creates one genuine group, replays after lost response, and never sells/issues/collects again", async () => {
    const payload = await input();
    payload.deliveryFee = "5000";
    const before = await noDuplicateEffects();
    const result = await dispatchWorkflowBatch(payload, actor);
    expect(result.invoiceIds).toEqual([1, 2]);
    expect(result.fulfillmentRequestId).toBeTypeOf("number");
    const consignments = await db().select().from(s.deliveryConsignments);
    expect(consignments).toHaveLength(2);
    expect(consignments.every((c) => c.assignedUserId === 2)).toBe(true);
    expect(await noDuplicateEffects()).toEqual(before);
    const snapshotsBeforeReplay = await db()
      .select()
      .from(deliveryDocumentSnapshots)
      .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId));
    expect(snapshotsBeforeReplay).toHaveLength(3);
    expect(result.documentSnapshotIds).toEqual(
      snapshotsBeforeReplay.map((row) => Number(row.id)).sort((a, b) => a - b),
    );
    for (const snapshot of snapshotsBeforeReplay.filter(
      (row) => row.documentType !== "DELIVERY_MANIFEST",
    )) {
      const document = snapshot.payload as {
        shipment: { members: Array<{ invoiceId: number | null }> };
        invoiceIds: number[];
        money: {
          codAmount: string;
          deliveryFee: string;
          currentTotal: string;
          paidAmount: string;
        };
      };
      expect(document.shipment.members).toHaveLength(2);
      expect(document.invoiceIds).toEqual([1, 2]);
      expect(document.money).toMatchObject({
        codAmount: "0.00",
        deliveryFee: "5000.00",
        currentTotal: "20000.00",
        paidAmount: "20000.00",
      });
    }
    await db()
      .update(s.invoices)
      .set({ paidAmount: "9000", status: "PARTIALLY_PAID" })
      .where(eq(s.invoices.id, 2));
    const replay = await dispatchWorkflowBatch(payload, actor);
    expect(replay).toMatchObject({
      consignmentId: result.consignmentId,
      idempotentReplay: true,
    });
    expect(await db().select().from(fulfillmentRequests)).toHaveLength(1);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(2);
    expect(
      await db()
        .select()
        .from(deliveryDocumentSnapshots)
        .where(eq(deliveryDocumentSnapshots.sourceId, result.consignmentId)),
    ).toEqual(snapshotsBeforeReplay);
    const member = await previewWorkflowScan(
      { raw: "INV-80002", station: "collect", branchId: 1 },
      actor,
    );
    expect(member.group?.consignmentIds).toHaveLength(2);
    expect(member.money.currentTotal).toBe("20000.00");
    await expect(
      dispatchWorkflowBatch({ ...payload, deliveryFee: "1000" }, actor),
    ).rejects.toThrow(/بيانات مختلفة|حمولة/);
  });
  it("rejects stale current values, different real customers and missing explicit driver before writes", async () => {
    const payload = await input();
    await expect(
      dispatchWorkflowBatch({ ...payload, assignedUserId: undefined }, actor),
    ).rejects.toThrow(/اختر المندوب/);
    await db()
      .update(s.invoices)
      .set({ paidAmount: "9000", status: "PARTIALLY_PAID" })
      .where(eq(s.invoices.id, 2));
    await expect(dispatchWorkflowBatch(payload, actor)).rejects.toThrow(/تغير/);
    const fresh = await input();
    await db()
      .update(s.invoices)
      .set({ customerId: 2 })
      .where(eq(s.invoices.id, 2));
    const p = await previewWorkflowScan(
      { raw: "INV-80002", station: "dispatch", branchId: 1 },
      actor,
    );
    fresh.sources[1]!.expectedVersion = p.source.version;
    await expect(dispatchWorkflowBatch(fresh, actor)).rejects.toThrow(
      /العميل الحقيقي/,
    );
    expect(await db().select().from(fulfillmentRequests)).toHaveLength(0);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
  });
  it("canonical dedup rejects a WO and its existing invoice without duplicate materialization", async () => {
    await db().insert(s.workOrders).values({
      id: 1,
      orderNumber: "80001",
      branchId: 1,
      customerId: 1,
      title: "مفوتر",
      invoiceId: 1,
      status: "READY",
      createdBy: 1,
    });
    const payload = await input();
    const p = await previewWorkflowScan(
      { raw: "WO-80001", station: "dispatch", branchId: 1 },
      actor,
    );
    payload.sources[1] = {
      kind: p.source.kind,
      id: p.source.id,
      expectedVersion: p.source.version,
    };
    await expect(dispatchWorkflowBatch(payload, actor)).rejects.toThrow(
      /المصدر الاقتصادي/,
    );
    expect(await db().select().from(s.invoices)).toHaveLength(2);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
  });
  it("cancellation cannot stand in for actual physical return", async () => {
    const result = await dispatchWorkflowBatch(await input(), actor);
    await db()
      .update(s.deliveryConsignments)
      .set({ pickedUpAt: new Date(), parcelStatus: "PICKED_UP" })
      .where(eq(s.deliveryConsignments.id, result.consignmentId));
    const p = await previewWorkflowScan(
      {
        raw: docBarcode("CN", result.consignmentNumber),
        station: "cancelAssignment",
        branchId: 1,
      },
      actor,
    );
    await expect(
      mutateWorkflowAssignment(
        {
          source: {
            kind: p.source.kind,
            id: p.source.id,
            expectedVersion: p.source.version,
          },
          branchId: 1,
          action: "cancelAssignment",
          reason: "العميل ألغى",
          clientRequestId: "workflow-cancel-001",
          physicalHeldConfirmed: true,
        },
        actor,
      ),
    ).rejects.toThrow(/استلمه|الرجوع/);
    expect(
      (
        await db()
          .select()
          .from(s.deliveryConsignments)
          .where(eq(s.deliveryConsignments.id, result.consignmentId))
      )[0]?.parcelStatus,
    ).toBe("PICKED_UP");
  });
});

async function nativeDriverSetup(family: "invoice" | "chargeOnly") {
  if (family === "invoice")
    return (assignedUserId?: number) =>
      dispatchInvoiceToDelivery(
        {
          invoiceId: 1,
          partyId: 1,
          assignedUserId,
          deliveryFee: "0",
          feeCollection: "COURIER",
          externalTrackingRef: "NATIVE-DRIVER-ONE",
          clientRequestId: "native-invoice-driver",
        },
        actor,
      );
  const request = await createFulfillmentRequest(
    {
      branchId: 1,
      customerId: 1,
      recipientName: "عميل الشحنة",
      recipientPhone: "07701234567",
      deliveryAddress: "بغداد المنصور قرب المكتبة",
      partyId: 1,
      deliveryFee: "0",
      feeCollection: "COURIER",
      sources: [],
      clientRequestId: "native-driver-fr-create",
    },
    actor,
  );
  const charge = await createFulfillmentCharge(
    {
      branchId: 1,
      requestId: request.id,
      customerId: 1,
      category: "SERVICE",
      description: "تجهيز مستقل معتمد للإرسال",
      amount: "1000",
      externalCost: "0",
      clientRequestId: "native-driver-charge-create",
    },
    actor,
  );
  await approveFulfillmentCharge(
    {
      id: charge.id,
      expectedVersion: charge.version,
      clientRequestId: "native-driver-charge-approve",
    },
    actor,
  );
  return (assignedUserId?: number) =>
    releaseFulfillmentRequest(
      {
        id: request.id,
        expectedVersion: request.version,
        assignedUserId,
        externalTrackingRef: "NATIVE-DRIVER-ONE",
        clientRequestId: "native-request-driver",
      },
      actor,
    );
}
async function nativeDriverSnapshot() {
  return {
    ...(await noDuplicateEffects()),
    requests: await db().select().from(fulfillmentRequests),
    items: await db().select().from(fulfillmentRequestItems),
    charges: await db().select().from(fulfillmentCharges),
    payments: await db().select().from(fulfillmentChargePayments),
    cn: await db().select().from(s.deliveryConsignments),
    ledger: await db().select().from(s.deliveryLedgerEntries),
    customers: await db().select().from(s.customers),
    counters: await db().select().from(s.documentCounters),
  };
}
describe("native driver assignment guards", () => {
  for (const family of ["invoice", "chargeOnly"] as const) {
    it.each(["omitted", "inactive", "outbranch"] as const)(
      `${family} native rejects %s internal driver without financial or request effects`,
      async (fault) => {
        if (fault === "inactive")
          await db()
            .update(s.users)
            .set({ isActive: false })
            .where(eq(s.users.id, 2));
        if (fault === "outbranch") {
          await db()
            .insert(s.branches)
            .values({ id: 2, code: "B2", name: "الثاني", type: "SALES" });
          await db()
            .update(s.users)
            .set({ branchId: 2 })
            .where(eq(s.users.id, 2));
        }
        const command = await nativeDriverSetup(family),
          before = await nativeDriverSnapshot();
        await expect(
          command(fault === "omitted" ? undefined : 2),
        ).rejects.toThrow(/صراحة|غير نشط|خارج الفرع/);
        expect(await nativeDriverSnapshot()).toEqual(before);
      },
    );
    it(`${family} native never silently chooses the first active DRIVER member`, async () => {
      await db()
        .update(s.deliveryParties)
        .set({ userId: null })
        .where(eq(s.deliveryParties.id, 1));
      await db().insert(s.deliveryPartyMembers).values({
        partyId: 1,
        userId: 2,
        memberRole: "DRIVER",
        isActive: true,
        createdBy: 1,
      });
      const command = await nativeDriverSetup(family),
        before = await nativeDriverSnapshot();
      await expect(command()).rejects.toThrow(/صراحة/);
      expect(await nativeDriverSnapshot()).toEqual(before);
    });
    it.each(["external", "company", "explicitInternal"] as const)(
      `${family} native preserves a valid %s carrier without inventing or silently choosing a driver`,
      async (kind) => {
        if (kind !== "explicitInternal")
          await db()
            .update(s.deliveryParties)
            .set({
              userId: null,
              partyType: kind === "company" ? "COMPANY" : "INDIVIDUAL",
            })
            .where(eq(s.deliveryParties.id, 1));
        const command = await nativeDriverSetup(family),
          before = await noDuplicateEffects();
        const result = await command(
          kind === "explicitInternal" ? 2 : undefined,
        );
        const [cn] = await db()
          .select()
          .from(s.deliveryConsignments)
          .where(eq(s.deliveryConsignments.id, result.consignmentId));
        expect(cn?.assignedUserId).toBe(kind === "explicitInternal" ? 2 : null);
        expect(cn?.partyId).toBe(1);
        expect(await noDuplicateEffects()).toEqual(before);
      },
    );
  }
});
