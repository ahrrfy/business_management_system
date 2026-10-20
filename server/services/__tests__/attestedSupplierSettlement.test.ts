import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import * as audit from "../auditService";
import { recordAttestedSupplierSettlement } from "../purchase/attestedSupplierSettlement";
import { baghdadToday } from "../businessDay";
import { openPurchaseIntegrityCase } from "../purchase/integrityCases";

const owner = { userId: 9, branchId: 1, role: "manager", isOwner: true };
const db = () => getDb()!;
const input = () => ({
  attestationKey: "owner-confirmed-purchase-payment",
  evidenceText:
    "أقر المالك بدفع البضاعة نقداً من الخزينة الإدارية اليوم، والتسجيل مفقود.",
  recordingDate: baghdadToday(),
  payments: [
    {
      purchaseOrderId: 1,
      supplierInvoiceId: 1,
      invoiceVersion: 1,
      amount: "60.00",
      actualPaymentDate: baghdadToday(),
    },
    {
      purchaseOrderId: 2,
      supplierInvoiceId: 2,
      invoiceVersion: 1,
      amount: "40.00",
      actualPaymentDate: baghdadToday(),
    },
  ],
});
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 7,
        openId: "attest-maker",
        role: "accountant",
        name: "منشئ الفاتورة",
        branchId: 1,
      },
      {
        id: 9,
        openId: "attest-owner",
        role: "manager",
        name: "مالك",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.receipts).values({
    branchId: 1,
    amount: "100.00",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    direction: "IN",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 9,
  });
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    variantName: "افتراضي",
    sku: "ATTESTED-ITEM",
  });
  for (const [id, total] of [
    [1, "60.00"],
    [2, "40.00"],
  ] as const) {
    await db()
      .insert(s.suppliers)
      .values({ id, name: `مورد ${id}`, currentBalance: total });
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `ATTEST-PO-${id}`,
        supplierId: id,
        branchId: 1,
        subtotal: total,
        total,
        settlementType: "CASH",
        status: "RECEIVED",
        createdBy: 7,
      });
    await db()
      .insert(s.purchaseOrderRevisions)
      .values({
        id,
        purchaseOrderId: id,
        revisionNo: 1,
        origin: "NATIVE",
        supplierId: id,
        branchId: 1,
        agreedCurrency: "IQD",
        settlementType: "CASH",
        subtotal: total,
        total,
        taxAmount: "0.00",
        shippingCost: "0.00",
        customsCost: "0.00",
        invoiceDiscount: "0.00",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "فاتورة أصلية",
        createdBy: 7,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1.000",
      baseQuantity: 1,
      listUnitPrice: total,
      unitPrice: total,
      lineTotal: total,
      productNameSnapshot: "صنف",
    });
    const entry = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "ADJUST",
          entryDate: baghdadToday(),
          amount: total,
          supplierId: id,
          branchId: 1,
          purchaseOrderId: id,
          dedupeKey: `GRNI:SUPPLIER_INVOICE:${id}`,
        }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `ATTEST-SI-${id}`,
        clientRequestId: `ATTEST-SI-${id}`,
        origin: "NATIVE",
        supplierId: id,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: baghdadToday(),
        currency: "IQD",
        subtotal: total,
        totalAmount: total,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        evidenceType: "OTHER",
        externalInvoiceNumber: `ATTEST-EXT-${id}`,
        externalNumberNorm: `ATTESTEXT${id}`,
        evidenceReference: "original-invoice",
        createdBy: 7,
        postingEntryId: entry,
        postedBy: 9,
        postedAt: new Date(),
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "بند",
      invoicedBaseQuantity: 1,
      unitPriceIqd: total,
      netAmount: total,
      totalAmount: total,
    });
  }
});
afterEach(() => vi.restoreAllMocks());

async function state() {
  return {
    suppliers: await db().select().from(s.suppliers),
    receipts: await db().select().from(s.receipts),
    entries: await db().select().from(s.accountingEntries),
    invoices: await db().select().from(s.supplierInvoices),
    orders: await db().select().from(s.purchaseOrders),
    requests: await db().select().from(s.supplierPaymentRequests),
    payments: await db().select().from(s.supplierPayments),
    allocations: await db().select().from(s.supplierPaymentAllocations),
    audits: await db().select().from(s.auditLogs),
    evidenceCases: await db().select().from(s.purchaseIntegrityCases),
    caseEvents: await db().select().from(s.purchaseIntegrityCaseEvents),
  };
}
async function evidenceCase() {
  const row = await openPurchaseIntegrityCase(
    {
      caseKey: "ATTESTED-CASE-1",
      branchId: 1,
      supplierId: 1,
      purchaseOrderId: 1,
      supplierInvoiceId: 1,
      code: "LEGACY_PAYMENT_EVIDENCE_INVALID",
      severity: "HIGH",
      title: "دفع نقدي غير محسوم",
      description: "لم يتذكر المالك هل تم الدفع؛ يُحسم الآن بإقرار مباشر.",
      evidence: { purchaseOrderId: 1, supplierInvoiceId: 1 },
      reason: "مطابقة الدفع قبل الصرف",
    },
    owner,
  );
  return {
    ...input(),
    evidenceCases: [
      { caseId: row.caseId, purchaseOrderId: 1, supplierInvoiceId: 1 },
    ],
  };
}
describe("owner-attested missing treasury supplier payments", () => {
  it("resolves only the explicitly attested evidence hold atomically with native payment", async () => {
    const accepted = await evidenceCase();
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
    await recordAttestedSupplierSettlement(accepted, owner);
    const after = await state();
    expect(after.evidenceCases[0].status).toBe("RESOLVED");
    expect(after.caseEvents.map((row) => row.eventType)).toEqual([
      "OPENED",
      "RESOLUTION_REQUESTED",
      "RESOLUTION_APPROVED",
    ]);
    expect(after.suppliers.map((row) => row.currentBalance)).toEqual([
      "0.00",
      "0.00",
    ]);
    expect(
      (await recordAttestedSupplierSettlement(accepted, owner)).replayed,
    ).toBe(true);
    expect(await state()).toEqual(after);
  });
  it("rolls evidence resolution back with every payment if a later supplier lacks funds", async () => {
    const accepted = await evidenceCase();
    await db().update(s.receipts).set({ amount: "70.00" });
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(accepted, owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("rejects evidence cases outside the attested invoice identity", async () => {
    const accepted = await evidenceCase();
    accepted.evidenceCases[0].purchaseOrderId = 2;
    accepted.evidenceCases[0].supplierInvoiceId = 2;
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(accepted, owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("records both suppliers atomically with one treasury deduction and stable replay", async () => {
    const result = await recordAttestedSupplierSettlement(input(), owner);
    const after = await state();
    expect(result.replayed).toBe(false);
    expect(result.paymentIds).toHaveLength(2);
    expect(result.verification).toEqual([
      {
        kind: "TREASURY",
        id: 1,
        before: "100.00",
        after: "0.00",
        delta: "-100.00",
      },
      {
        kind: "SUPPLIER_AP",
        id: 1,
        before: "60.00",
        after: "0.00",
        delta: "-60.00",
      },
      {
        kind: "SUPPLIER_AP",
        id: 2,
        before: "40.00",
        after: "0.00",
        delta: "-40.00",
      },
    ]);
    expect(after.suppliers.map((row) => row.currentBalance)).toEqual([
      "0.00",
      "0.00",
    ]);
    expect(
      after.receipts
        .filter((row) => row.direction === "OUT")
        .map((row) => [row.amount, row.cashBucket, row.partyId]),
    ).toEqual([
      ["60.00", "TREASURY", 1],
      ["40.00", "TREASURY", 2],
    ]);
    expect(
      after.entries.filter((row) => row.entryType === "PAYMENT_OUT"),
    ).toHaveLength(2);
    expect(after.invoices.every((row) => row.paymentGate === "SETTLED")).toBe(
      true,
    );
    expect(after.orders.map((row) => row.paidAmount)).toEqual([
      "60.00",
      "40.00",
    ]);
    expect(
      after.audits.some(
        (row) => row.action === "supplier.attestedSettlement.record",
      ),
    ).toBe(true);
    const replay = await recordAttestedSupplierSettlement(input(), owner);
    expect(replay.replayed).toBe(true);
    expect(replay.verification).toEqual(result.verification);
    expect(await state()).toEqual(after);
  });
  it("rejects changed evidence under the same attestation key", async () => {
    await recordAttestedSupplierSettlement(input(), owner);
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(
        { ...input(), evidenceText: "إقرار مختلف لا يطابق الدليل الأصلي" },
        owner,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("serializes concurrent retries without duplicate money", async () => {
    const results = await Promise.all([
      recordAttestedSupplierSettlement(input(), owner),
      recordAttestedSupplierSettlement(input(), owner),
    ]);
    expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
    const after = await state();
    expect(after.payments).toHaveLength(2);
    expect(
      after.receipts.filter((row) => row.direction === "OUT"),
    ).toHaveLength(2);
    expect(after.suppliers.map((row) => row.currentBalance)).toEqual([
      "0.00",
      "0.00",
    ]);
  });
  it("stops when an existing later payment could be the missing allocation", async () => {
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      entryDate: baghdadToday(),
      supplierId: 1,
      branchId: 1,
      amount: "60.00",
    });
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("rolls back the first supplier if the second payment lacks treasury funds", async () => {
    await db().update(s.receipts).set({ amount: "70.00" });
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("requires an active owner from the database and ignores a forged actor flag", async () => {
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), { ...owner, userId: 7 }),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("records old attested payments today while preserving original dates and records", async () => {
    const actualPaymentDate = "2026-01-01";
    const invoiceRecognitionDate = "2026-01-03";
    await db()
      .update(s.purchaseOrders)
      .set({ orderDate: new Date(`${actualPaymentDate}T10:00:00Z`) });
    await db()
      .update(s.supplierInvoices)
      .set({ invoiceDate: invoiceRecognitionDate });
    await db()
      .update(s.accountingEntries)
      .set({ entryDate: actualPaymentDate });
    const before = await state();
    const evidence = {
      ...input(),
      payments: input().payments.map((row) => ({
        ...row,
        actualPaymentDate,
        invoiceVersion: before.invoices.find(
          (invoice) => invoice.id === row.supplierInvoiceId,
        )!.version,
      })),
    };
    await recordAttestedSupplierSettlement(evidence, owner);
    const after = await state();
    expect(
      after.entries
        .filter((row) => row.entryType === "PAYMENT_OUT")
        .map((row) => row.entryDate.toISOString().slice(0, 10)),
    ).toEqual([baghdadToday(), baghdadToday()]);
    expect(after.entries.filter((row) => row.entryType === "ADJUST")).toEqual(
      before.entries,
    );
    expect(after.receipts.filter((row) => row.direction === "IN")).toEqual(
      before.receipts,
    );
    expect(after.invoices.map((row) => row.invoiceDate)).toEqual([
      invoiceRecognitionDate,
      invoiceRecognitionDate,
    ]);
    const evidenceAudit = after.audits.find(
      (row) => row.action === "supplier.attestedSettlement.record",
    )!.newValue as typeof evidence & {
      payments: Array<{
        actualPaymentDate: string;
        invoiceRecognitionDate: string;
      }>;
    };
    expect(evidenceAudit.recordingDate).toBe(baghdadToday());
    expect(evidenceAudit.payments.map((row) => row.actualPaymentDate)).toEqual([
      actualPaymentDate,
      actualPaymentDate,
    ]);
    expect(
      evidenceAudit.payments.map((row) => row.invoiceRecognitionDate),
    ).toEqual([invoiceRecognitionDate, invoiceRecognitionDate]);
    expect(
      (await recordAttestedSupplierSettlement(evidence, owner)).replayed,
    ).toBe(true);
    expect(await state()).toEqual(after);
  });
  it("rejects backdated recording and mismatched actual dates before money moves", async () => {
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(
        { ...input(), recordingDate: "2026-01-01" },
        owner,
      ),
    ).rejects.toThrow();
    await expect(
      recordAttestedSupplierSettlement(
        {
          ...input(),
          payments: input().payments.map((row) => ({
            ...row,
            actualPaymentDate: "2026-01-01",
          })),
        },
        owner,
      ),
    ).rejects.toThrow();
    await expect(
      recordAttestedSupplierSettlement(
        {
          ...input(),
          payments: input().payments.map((row) => ({
            ...row,
            actualPaymentDate: "2099-01-01",
          })),
        },
        owner,
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("rejects stale invoices instead of bypassing version controls", async () => {
    await db()
      .update(s.supplierInvoices)
      .set({ version: 2 })
      .where(eq(s.supplierInvoices.id, 2));
    const before = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it("rolls back all money if the mandatory attestation audit fails", async () => {
    const before = await state();
    const original = audit.logAuditTx;
    vi.spyOn(audit, "logAuditTx").mockImplementation(
      async (tx, source, data) => {
        if (data.action === "supplier.attestedSettlement.record")
          throw new Error("attestation audit unavailable");
        return original(tx, source, data);
      },
    );
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow("attestation audit unavailable");
    expect(await state()).toEqual(before);
  });
});
