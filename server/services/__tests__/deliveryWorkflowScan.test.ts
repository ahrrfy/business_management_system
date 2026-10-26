import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import {
  aftercareCases,
  aftercareExecutions,
  fulfillmentCharges,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { previewWorkflowScan } from "../delivery/workflow/preview";
import { previewWorkflowBatch } from "../delivery/workflow/dispatch";
import { normalizeKnownSystemBarcode } from "../../../shared/barcodeScanner";

const actor = { userId: 1, role: "admin", branchId: 1 };
const db = () => {
  const value = getDb();
  if (!value) throw new Error("Isolated DB required");
  return value;
};
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" },
      { id: 2, code: "OTHER", name: "الثاني", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "workflow-owner", role: "admin", branchId: 1 },
      { id: 2, openId: "workflow-cashier", role: "cashier", branchId: 2 },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "عميل المسح",
    phone: "07701234567",
    address: "بغداد المنصور",
    currentBalance: "0",
  });
  await db()
    .insert(s.invoices)
    .values([
      {
        id: 1,
        invoiceNumber: "70001",
        customerId: 1,
        branchId: 1,
        subtotal: "10000",
        total: "10000",
        paidAmount: "3000",
        returnedTotal: "1000",
        paymentMode: "COD",
        createdBy: 1,
      },
      {
        id: 2,
        invoiceNumber: "1",
        customerId: 1,
        branchId: 2,
        subtotal: "50",
        total: "50",
        paidAmount: "0",
        paymentMode: "CREDIT",
        createdBy: 2,
      },
    ]);
  await db().insert(s.workOrders).values({
    id: 1,
    orderNumber: "70001",
    branchId: 1,
    customerId: 1,
    title: "خدمة مفوترة",
    invoiceId: 1,
    status: "READY",
    salePrice: "10000",
    paymentMode: "COD",
    createdBy: 1,
  });
});
describe("typed barcode workflow preview", () => {
  it("reads current values, source identity, canonical linked WO identity and writes nothing", async () => {
    const before = {
      cn: await db().select().from(s.deliveryConsignments),
      receipts: await db().select().from(s.receipts),
      ledger: await db().select().from(s.accountingEntries),
      movements: await db().select().from(s.inventoryMovements),
    };
    const invoice = await previewWorkflowScan(
      { raw: "INV-70001", station: "dispatch", branchId: 1 },
      actor,
    );
    const wo = await previewWorkflowScan(
      {
        raw: "WO|70001|2026-10-24|1|signature",
        station: "dispatch",
        branchId: 1,
      },
      actor,
    );
    expect(invoice.source).toMatchObject({
      kind: "invoice",
      id: 1,
      number: "70001",
      canonicalKey: "invoice:1",
    });
    expect(wo.source.canonicalKey).toBe(invoice.source.canonicalKey);
    expect(invoice.money).toMatchObject({
      currentTotal: "9000.00",
      paidAmount: "3000.00",
      remainingAmount: "6000.00",
      codAmount: "6000.00",
    });
    expect(invoice.summaries).toMatchObject({
      commercial: {
        documentNumber: "70001",
        status: "PENDING",
        customerId: 1,
        currentTotal: "9000.00",
      },
      parcel: {
        shipmentNumber: null,
        consignmentCount: 0,
        parcelStatus: null,
        physicallyReturned: false,
      },
      inventory: {
        custodyTracked: false,
        reviewRequired: false,
        state: "NOT_ASSIGNED",
        baseQuantity: null,
      },
      collection: {
        customerDue: "6000.00",
        customerCollected: "0.00",
        cashInCourierCustody: "0.00",
      },
    });
    expect(
      invoice.allowedActions.find((a) => a.action === "dispatch"),
    ).toMatchObject({
      allowed: true,
      requiredRole: "موظف إسناد مخوّل",
      nextStep: "راجع الجهة والمستلم ثم أكّد الإسناد مرة واحدة",
    });
    expect(invoice.effectPreview).toMatchObject({
      sale: { direction: "NONE" },
      inventory: { direction: "TRANSFER" },
      accountsReceivable: { direction: "NONE" },
      courierCustody: { direction: "NONE" },
      drawerCash: { direction: "NONE" },
      bankCash: { direction: "NONE" },
      refund: { direction: "NONE" },
    });
    expect(invoice.availableDocuments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "INVOICE",
          action: "PRINT",
          allowed: false,
          reason: expect.stringMatching(/مسار الفاتورة/),
        }),
        expect.objectContaining({
          type: "SHIPPING_LABEL",
          action: "PRINT",
          allowed: true,
        }),
      ]),
    );
    expect(JSON.stringify(invoice)).not.toMatch(
      /costTotal|materialsCost|laborCost|totalCost/,
    );
    expect({
      cn: await db().select().from(s.deliveryConsignments),
      receipts: await db().select().from(s.receipts),
      ledger: await db().select().from(s.accountingEntries),
      movements: await db().select().from(s.inventoryMovements),
    }).toEqual(before);
    const batch = await previewWorkflowBatch(
      {
        sources: [invoice, wo].map((p) => ({
          kind: p.source.kind,
          id: p.source.id,
          expectedVersion: p.source.version,
        })),
        branchId: 1,
      },
      actor,
    );
    expect(batch.sources).toHaveLength(1);
    expect(batch.duplicateCanonicalKeys).toEqual(["invoice:1"]);
  });
  it("never resolves a bare display number as an internal ID and enforces current branch", async () => {
    await expect(
      previewWorkflowScan(
        { raw: "1", station: "dispatch", branchId: 1 },
        actor,
      ),
    ).rejects.toThrow(/لم يعثر/);
    const displayed = await previewWorkflowScan(
      { raw: "1", station: "dispatch", branchId: 2 },
      actor,
    );
    expect(displayed.source.id).toBe(2);
    expect(displayed.money.codAmount).toBe("0.00");
    await expect(
      previewWorkflowScan(
        { raw: "INV-70001", station: "collect", branchId: 1 },
        { userId: 2, role: "admin", branchId: 1 },
      ),
    ).rejects.toThrow(/خارج نطاق/);
  });
  it("keeps old printed QR numbers and reports ambiguous unrelated numbers", async () => {
    await db()
      .update(s.invoices)
      .set({ invoiceNumber: "INV-1-20260818-00073" })
      .where(eq(s.invoices.id, 1));
    const old = await previewWorkflowScan(
      {
        raw: "https://local.test/?payload=INV%7CINV-1-20260818-00073%7C2026-08-18%7C10000%7C1%7Csig",
        station: "edit",
        branchId: 1,
      },
      actor,
    );
    expect(old.source.id).toBe(1);
    await db().insert(s.workOrders).values({
      id: 3,
      orderNumber: "1",
      branchId: 2,
      customerId: 1,
      title: "مستند آخر",
      status: "READY",
      createdBy: 1,
    });
    await expect(
      previewWorkflowScan(
        { raw: "1", station: "dispatch", branchId: 2 },
        actor,
      ),
    ).rejects.toThrow(/مستندات مختلفة/);
  });
  it("keeps invoice printing in its protected invoice route even if a delivery snapshot exists", async () => {
    const eventAt = new Date("2026-10-24T09:15:00.000Z");
    await db()
      .insert(s.deliveryDocumentSnapshots)
      .values({
        id: 41,
        documentNumber: "DDS-INV-70001",
        documentType: "INVOICE",
        layout: "A4_12MM",
        sourceType: "INVOICE",
        sourceId: 1,
        sourceVersion: "invoice:1:v1",
        branchId: 1,
        eventKey: "INVOICE:1:ISSUED",
        eventOccurredAt: eventAt,
        payload: { invoiceNumber: "70001", eventAt: eventAt.toISOString() },
        payloadHash: "d".repeat(64),
        createdBy: 1,
      });
    const preview = await previewWorkflowScan(
      { raw: "INV-70001", station: "edit", branchId: 1 },
      actor,
    );
    expect(
      preview.availableDocuments.find((doc) => doc.type === "INVOICE"),
    ).toEqual({
      type: "INVOICE",
      action: "PRINT",
      allowed: false,
      reason: "اطبع النسخة الحالية من مسار الفاتورة وصلاحية الطباعة المستقلة",
    });
    expect(
      preview.availableDocuments.find((doc) => doc.type === "SHIPPING_LABEL"),
    ).toMatchObject({
      action: "REPRINT",
      allowed: false,
    });
  });
  it("identifies real AE and CHG records without inventing a commercial invoice", async () => {
    await db()
      .insert(aftercareCases)
      .values({
        id: 1,
        branchId: 1,
        invoiceId: 1,
        customerId: 1,
        caseNumber: "AC-SCAN",
        reason: "نقص مثبت",
        evidence: "محضر العميل",
        createdBy: 1,
        clientRequestId: "scan-case-0001",
        sourceHash: "a".repeat(64),
      });
    await db()
      .insert(aftercareExecutions)
      .values({
        id: 1,
        caseId: 1,
        branchId: 1,
        recipientName: "عميل المسح",
        recipientPhone: "07701234567",
        deliveryAddress: "بغداد المنصور",
        preparedBy: 1,
        totalCost: "900",
        clientRequestId: "scan-exec-0001",
        sourceHash: "b".repeat(64),
      });
    await db()
      .insert(fulfillmentCharges)
      .values({
        id: 1,
        branchId: 1,
        customerId: 1,
        category: "SERVICE",
        status: "APPROVED",
        description: "خدمة فعلية",
        amount: "3000",
        createdBy: 1,
        approvedBy: 1,
        approvedAt: new Date("2026-10-24T10:00:00.000Z"),
        clientRequestId: "scan-charge-001",
        sourceHash: "c".repeat(64),
      });
    const ae = await previewWorkflowScan(
      { raw: "AE|1|1|signature", station: "dispatch", branchId: 1 },
      actor,
    );
    expect(ae.source).toMatchObject({
      kind: "aftercareExecution",
      id: 1,
      number: "AE-1",
    });
    expect(ae.relations).toMatchObject({
      aftercareCaseId: 1,
      aftercareExecutionId: 1,
    });
    expect(ae.relations.invoiceId).toBeUndefined();
    expect(ae.money.codAmount).toBe("0.00");
    expect(ae.summaries.collection.customerDue).toBe("0.00");
    expect(ae.effectPreview).toMatchObject({
      sale: { direction: "NONE" },
      inventory: { direction: "TRANSFER" },
      accountsReceivable: { direction: "NONE" },
    });
    expect(
      ae.availableDocuments.find((doc) => doc.type === "AFTERCARE_WAYBILL"),
    ).toMatchObject({ allowed: true, action: "PRINT" });
    const charge = await previewWorkflowScan(
      { raw: "CHG-1", station: "collect", branchId: 1 },
      actor,
    );
    expect(charge.source.kind).toBe("charge");
    expect(charge.money.remainingAmount).toBe("3000.00");
    expect(charge.summaries.commercial).toMatchObject({
      documentNumber: "CHG-1",
      status: "APPROVED",
      customerId: 1,
    });
    expect(normalizeKnownSystemBarcode("ُِ-1")).toBe("AE-1");
  });
});
