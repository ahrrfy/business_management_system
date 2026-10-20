import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import * as audit from "../auditService";
import { recordAttestedSupplierSettlement } from "../purchase/attestedSupplierSettlement";
import { baghdadToday, todayUtcDate } from "../businessDay";
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
const manifestAction = "supplier.attestedSettlement.manifest";
const fragmentAction = "supplier.attestedSettlement.fragment";
function fragmentDocument(audits: Awaited<ReturnType<typeof state>>["audits"]) {
  const pieces = audits
    .filter((row) => row.action === fragmentAction)
    .map((row) => row.newValue as { index: number; data: string })
    .sort((a, b) => a.index - b.index);
  return JSON.parse(
    Buffer.from(pieces.map((row) => row.data).join(""), "base64").toString(
      "utf8",
    ),
  );
}
async function largeInput(targetCount = 17) {
  const [po] = await db()
    .select()
    .from(s.purchaseOrders)
    .where(eq(s.purchaseOrders.id, 1));
  const [revision] = await db()
    .select()
    .from(s.purchaseOrderRevisions)
    .where(eq(s.purchaseOrderRevisions.id, 1));
  const [revisionItem] = await db()
    .select()
    .from(s.purchaseOrderRevisionItems)
    .where(eq(s.purchaseOrderRevisionItems.id, 1));
  const [invoice] = await db()
    .select()
    .from(s.supplierInvoices)
    .where(eq(s.supplierInvoices.id, 1));
  const [line] = await db()
    .select()
    .from(s.supplierInvoiceLines)
    .where(eq(s.supplierInvoiceLines.supplierInvoiceId, 1));
  await db().update(s.receipts).set({ amount: "1000.00" });
  const large = {
    ...input(),
    evidenceText: "دفع المالك نقداً من الخزينة الإدارية بالفعل. "
      .repeat(40)
      .trim(),
  };
  for (let id = 3; id <= targetCount; id++) {
    await db()
      .insert(s.suppliers)
      .values({ id, name: `Large supplier ${id}`, currentBalance: "1.00" });
    await db()
      .insert(s.purchaseOrders)
      .values({
        ...po,
        id,
        supplierId: id,
        poNumber: `LARGE-PO-${id}`,
        subtotal: "1.00",
        total: "1.00",
      });
    await db()
      .insert(s.purchaseOrderRevisions)
      .values({
        ...revision,
        id,
        purchaseOrderId: id,
        supplierId: id,
        subtotal: "1.00",
        total: "1.00",
      });
    await db()
      .insert(s.purchaseOrderRevisionItems)
      .values({
        ...revisionItem,
        id,
        revisionId: id,
        listUnitPrice: "1.00",
        unitPrice: "1.00",
        lineTotal: "1.00",
      });
    const postingEntryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "ADJUST",
          entryDate: baghdadToday(),
          amount: "1.00",
          supplierId: id,
          branchId: 1,
          purchaseOrderId: id,
          dedupeKey: `GRNI:SUPPLIER_INVOICE:${id}`,
        }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        ...invoice,
        id,
        supplierId: id,
        invoiceNumber: `LARGE-SI-${id}`,
        clientRequestId: `LARGE-SI-${id}`,
        externalInvoiceNumber: `LARGE-EXT-${id}`,
        externalNumberNorm: `LARGEEXT${id}`,
        subtotal: "1.00",
        totalAmount: "1.00",
        postingEntryId,
      });
    await db()
      .insert(s.supplierInvoiceLines)
      .values({
        ...line,
        id: undefined,
        supplierInvoiceId: id,
        purchaseOrderRevisionItemId: id,
        unitPriceIqd: "1.00",
        netAmount: "1.00",
        totalAmount: "1.00",
      });
    large.payments.push({
      purchaseOrderId: id,
      supplierInvoiceId: id,
      invoiceVersion: 1,
      amount: "1.00",
      actualPaymentDate: baghdadToday(),
    });
  }
  return large;
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
  it("keeps small canonical audit records fully readable without changing fragments", async () => {
    const accepted = input();
    const result = await recordAttestedSupplierSettlement(accepted, owner);
    const after = await state();
    const readable = after.audits.find(
      (row) => row.action === "supplier.attestedSettlement.record",
    )!.newValue as Record<string, unknown>;
    expect(readable.auditDetail).toBe("FULL");
    expect(readable.evidenceText).toBe(accepted.evidenceText);
    expect(readable.recordingDate).toBe(accepted.recordingDate);
    expect(readable.paymentIds).toEqual(result.paymentIds);
    expect(readable.verification).toEqual(result.verification);
    expect(readable.payments).toEqual(
      fragmentDocument(after.audits).evidence.payments,
    );
    expect(readable).not.toHaveProperty("_truncated");
    expect(Buffer.byteLength(JSON.stringify(readable), "utf8")).toBeLessThan(
      8192,
    );
  });

  it("keeps a 50-row batch with 2000 Arabic evidence characters readable and bounded", async () => {
    // Existing line IDs need not match invoice IDs after other test files run.
    // Occupy IDs that the large fixture previously tried to assign explicitly.
    const existingLines = await db().select().from(s.supplierInvoiceLines);
    const nextLineId = Math.max(...existingLines.map((line) => line.id)) + 1;
    for (const [index, line] of existingLines.entries()) {
      await db()
        .update(s.supplierInvoiceLines)
        .set({ id: nextLineId + index })
        .where(
          eq(s.supplierInvoiceLines.supplierInvoiceId, line.supplierInvoiceId),
        );
    }
    for (const [index, id] of [3, 7].entries()) {
      await db()
        .update(s.supplierInvoiceLines)
        .set({ id })
        .where(eq(s.supplierInvoiceLines.supplierInvoiceId, index + 1));
    }
    const accepted = await largeInput(50);
    accepted.evidenceText = "أ".repeat(2000);
    const result = await recordAttestedSupplierSettlement(accepted, owner);
    const after = await state();
    const readable = after.audits.find(
      (row) => row.action === "supplier.attestedSettlement.record",
    )!.newValue as Record<string, unknown>;
    expect(readable.auditDetail).toBe("SUMMARY");
    expect(readable.evidenceText).toBe(accepted.evidenceText.slice(0, 500));
    expect(readable.omittedEvidenceCharacters).toBe(1500);
    expect(readable.invoiceCount).toBe(50);
    expect(readable.paymentCount).toBe(50);
    expect(readable.totalAmount).toBe("148.00");
    expect(readable.paymentIds).toEqual(result.paymentIds);
    expect(readable.requestIds).toEqual(result.requestIds);
    expect(readable.receiptIds).toEqual(result.receiptIds);
    expect(readable.payments).toHaveLength(3);
    expect(readable.omittedPaymentsCount).toBe(47);
    expect(readable.omittedPriorPaymentEvidenceCount).toBe(50);
    expect(readable.verification).toEqual(result.verification.slice(0, 3));
    expect(readable.omittedVerificationCount).toBe(48);
    expect(readable).not.toHaveProperty("_truncated");
    expect(Buffer.byteLength(JSON.stringify(readable), "utf8")).toBeLessThan(
      8192,
    );
    expect(audit.redactAuditValue(readable)).toEqual(readable);
    expect(fragmentDocument(after.audits).evidence.evidenceText).toBe(
      accepted.evidenceText,
    );
    expect(await recordAttestedSupplierSettlement(accepted, owner)).toEqual({
      ...result,
      replayed: true,
    });
    expect(await state()).toEqual(after);
  });

  it("does not use a readable new-format record as legacy fallback when every fragment is missing", async () => {
    await recordAttestedSupplierSettlement(input(), owner);
    const before = await state();
    for (const row of before.audits.filter(
      (item) =>
        item.action === manifestAction || item.action === fragmentAction,
    ))
      await db().delete(s.auditLogs).where(eq(s.auditLogs.id, row.id));
    const damaged = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(damaged);
  });
  it("preserves a real large batch and full long evidence through bounded fragments and exact replay", async () => {
    const accepted = await largeInput();
    const result = await recordAttestedSupplierSettlement(accepted, owner);
    const after = await state();
    expect(result.paymentIds).toHaveLength(17);
    const fragments = after.audits.filter(
      (row) => row.action === fragmentAction,
    );
    expect(fragments.length).toBeGreaterThan(1);
    for (const row of fragments) {
      const value = row.newValue as { data: string };
      expect(value.data.length).toBeLessThanOrEqual(800);
      expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThan(
        8192,
      );
    }
    const document = fragmentDocument(after.audits);
    expect(document.result).toEqual(result);
    expect(document.evidence.evidenceText).toBe(accepted.evidenceText);
    expect(document.evidence.payments).toHaveLength(17);
    expect(
      audit.redactAuditValue({
        ...document.result,
        ...document.evidence,
        payloadHash: document.payloadHash,
      }),
    ).toHaveProperty("_truncated", true);
    expect(await recordAttestedSupplierSettlement(accepted, owner)).toEqual({
      ...result,
      replayed: true,
    });
    expect(await state()).toEqual(after);
  });

  it.each([
    "DATA",
    "MISSING",
    "DUPLICATE",
    "TRUNCATED",
    "PAYLOAD",
    "INDEX",
    "MANIFEST_TRUNCATED",
  ] as const)("fails closed on damaged audit fragments: %s", async (kind) => {
    await recordAttestedSupplierSettlement(input(), owner);
    const before = await state();
    const fragment = before.audits.find(
      (row) => row.action === fragmentAction,
    )!;
    const value = fragment.newValue as Record<string, unknown>;
    if (kind === "DATA")
      await db()
        .update(s.auditLogs)
        .set({ newValue: { ...value, data: "AAAA" } })
        .where(eq(s.auditLogs.id, fragment.id));
    if (kind === "MISSING")
      await db().delete(s.auditLogs).where(eq(s.auditLogs.id, fragment.id));
    if (kind === "DUPLICATE")
      await db()
        .insert(s.auditLogs)
        .values({ ...fragment, id: undefined });
    if (kind === "TRUNCATED")
      await db()
        .update(s.auditLogs)
        .set({ newValue: { _truncated: true, _preview: "lost" } })
        .where(eq(s.auditLogs.id, fragment.id));
    if (kind === "PAYLOAD")
      await db()
        .update(s.auditLogs)
        .set({ newValue: { ...value, payloadHash: "f".repeat(64) } })
        .where(eq(s.auditLogs.id, fragment.id));
    if (kind === "INDEX")
      await db()
        .update(s.auditLogs)
        .set({ newValue: { ...value, index: 999 } })
        .where(eq(s.auditLogs.id, fragment.id));
    if (kind === "MANIFEST_TRUNCATED") {
      const manifest = before.audits.find(
        (row) => row.action === manifestAction,
      )!;
      await db()
        .update(s.auditLogs)
        .set({ newValue: { _truncated: true } })
        .where(eq(s.auditLogs.id, manifest.id));
    }
    const damaged = await state();
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow();
    expect(await state()).toEqual(damaged);
  });

  it("uses validated recovery fragments even when the original record is truncated", async () => {
    const result = await recordAttestedSupplierSettlement(input(), owner);
    const before = await state();
    const record = before.audits.find(
      (row) => row.action === "supplier.attestedSettlement.record",
    )!;
    await db()
      .update(s.auditLogs)
      .set({ newValue: { _truncated: true, _preview: "old truncated record" } })
      .where(eq(s.auditLogs.id, record.id));
    const recovered = await state();
    expect(await recordAttestedSupplierSettlement(input(), owner)).toEqual({
      ...result,
      replayed: true,
    });
    expect(await state()).toEqual(recovered);
  });

  it("replays a legacy small unfragmented record without financial writes", async () => {
    const fragments: Array<{ index: number; data: string }> = [];
    const original = audit.logAuditTx;
    vi.spyOn(audit, "logAuditTx").mockImplementation(
      async (tx, source, data) => {
        if (data.action === fragmentAction) {
          fragments.push(data.newValue as { index: number; data: string });
          return;
        }
        if (data.action === manifestAction) return;
        if (data.action === "supplier.attestedSettlement.record") {
          const document = JSON.parse(
            Buffer.from(
              fragments
                .sort((a, b) => a.index - b.index)
                .map((row) => row.data)
                .join(""),
              "base64",
            ).toString("utf8"),
          );
          return original(tx, source, {
            ...data,
            newValue: {
              ...document.result,
              ...document.evidence,
              payloadHash: document.payloadHash,
            },
          });
        }
        return original(tx, source, data);
      },
    );
    const result = await recordAttestedSupplierSettlement(input(), owner);
    const before = await state();
    expect(await recordAttestedSupplierSettlement(input(), owner)).toEqual({
      ...result,
      replayed: true,
    });
    expect(await state()).toEqual(before);
  });

  it("rolls back all money when writing a fragment fails", async () => {
    const before = await state();
    const original = audit.logAuditTx;
    vi.spyOn(audit, "logAuditTx").mockImplementation(
      async (tx, source, data) => {
        if (data.action === fragmentAction)
          throw new Error("fragment audit unavailable");
        return original(tx, source, data);
      },
    );
    await expect(
      recordAttestedSupplierSettlement(input(), owner),
    ).rejects.toThrow("fragment audit unavailable");
    expect(await state()).toEqual(before);
  });
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
    // Ledger DATE uses the ERP's UTC day; the attestation records Baghdad's date.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T21:30:00Z"));
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
    ).toEqual([todayUtcDate(), todayUtcDate()]);
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
    const evidenceAudit = fragmentDocument(after.audits)
      .evidence as typeof evidence & {
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
