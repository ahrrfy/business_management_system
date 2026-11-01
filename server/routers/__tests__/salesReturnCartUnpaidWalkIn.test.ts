import { and, eq, sql } from "drizzle-orm";
import mysql from "mysql2/promise";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { createSale } from "../../services/saleService";
import { recordStaffDeliveryConfirmation } from "../../services/delivery/companyStatement";
import { reconcileCustomerBalances } from "../../services/reconcileService";
import { returnRouter } from "../returnRouter";
import { saleRouter } from "../saleRouter";
import { router } from "../../trpc";
import { assertIsolatedActivationTestTarget } from "../../services/__tests__/activationTestTarget";

const api = router({ returns: returnRouter });
const db = () => getDb()!;
const cashier = { userId: 2, branchId: 1, role: "cashier" as const };
const owner = { userId: 1, branchId: 1, role: "admin" as const };
const caller = () => returnRouter.createCaller({
  req: { headers: {} }, res: {},
  user: { id: 2, role: "cashier", branchId: 1, isActive: true, isOwner: false, name: "كاشير" },
} as TrpcContext);
const invoice = async (id: number) => (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];

beforeEach(async () => {
  await db().insert(s.branches).values([
    { id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" },
    { id: 2, code: "OTHER", name: "آخر", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "portal-owner", name: "مالك", role: "admin", isOwner: true, branchId: 1 },
    { id: 2, openId: "portal-cashier", name: "كاشير", role: "cashier", branchId: 1 },
  ]);
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PORTAL-1", costPrice: "500" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true });
  await db().insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000" });
  await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 100 });
});

async function unpaid(qty = "3") {
  return createSale({ branchId: 1, sourceType: "ORDER", codDispatchPending: true, paymentMode: "COD",
    lines: [{ variantId: 1, productUnitId: 1, quantity: qty }],
  }, owner);
}
async function cart(invoiceNumber: string, quantity: number, amount: string, key: string,
  extra: Partial<Parameters<ReturnType<typeof caller>["executeSalesReturnCart"]>[0]> = {}) {
  const inspected = (await caller().inspectInvoiceForReturn({ invoiceNumber }))!;
  const item = inspected.items[0];
  return {
    invoiceNumber: inspected.invoiceNumber,
    disposition: "RESTOCK" as const,
    items: [{ invoiceItemId: item.invoiceItemId, variantId: item.variantId, productUnitId: item.productUnitId,
      productName: item.productName, quantity, unitPrice: item.effectiveUnitPrice }],
    settlement: { method: "CREDIT_OFFSET" as const, totalAmount: amount },
    clientRequestId: key,
    ...extra,
  };
}

async function simulateSameHistoricalNumber(invoiceId: number, removeBinding: boolean) {
  const sharedNumber = "SR-202610-7777";
  const entries = await db().select().from(s.accountingEntries).where(and(
    eq(s.accountingEntries.invoiceId, invoiceId), eq(s.accountingEntries.entryType, "RETURN"),
  ));
  const audits = await db().select().from(s.auditLogs).where(and(
    eq(s.auditLogs.action, "sale.return_cart"), eq(s.auditLogs.entityId, String(invoiceId)),
  ));
  expect(entries).toHaveLength(2);
  expect(audits).toHaveLength(2);
  for (const row of entries) {
    await db().update(s.accountingEntries).set({
      notes: row.notes!.replace(/\[SR-[^\]]+\]/g, `[${sharedNumber}]`),
    }).where(eq(s.accountingEntries.id, row.id));
  }
  for (const row of audits) {
    const value: Record<string, unknown> = { ...(row.newValue as Record<string, unknown>), returnNumber: sharedNumber };
    if (removeBinding) delete value.returnEntryId;
    await db().update(s.auditLogs).set({ newValue: value }).where(eq(s.auditLogs.id, row.id));
  }
  for (const entry of entries) {
    const [result] = await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.action, "sale.return_cart.result"), eq(s.auditLogs.entityId, String(entry.id)),
    ));
    if (removeBinding) await db().delete(s.auditLogs).where(eq(s.auditLogs.id, result.id));
    else await db().update(s.auditLogs).set({
      newValue: { ...(result.newValue as Record<string, unknown>), returnNumber: sharedNumber },
    }).where(eq(s.auditLogs.id, result.id));
  }
  return sharedNumber;
}

function ownerSalesCaller() {
  return saleRouter.createCaller({
    req: { headers: {} }, res: {},
    user: { id: 1, role: "admin", branchId: 1, isActive: true, isOwner: true, name: "مالك" },
  } as TrpcContext);
}

describe("sales return portal — no cash, no invented customer account", () => {
  it("keeps each partial return distinct and replays only its own result even when randomness collides", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1234);
    try {
      const sale = await unpaid();
      const first = await cart(sale.invoiceNumber, 1, "1000", "collision-first");
      const firstResult = await caller().executeSalesReturnCart(first);
      const secondResult = await caller().executeSalesReturnCart(
        await cart(sale.invoiceNumber, 2, "2000", "collision-second"),
      );
      const beforeReplay = {
        invoice: await invoice(sale.invoiceId),
        stock: await db().select().from(s.branchStock),
        entries: await db().select().from(s.accountingEntries),
        movements: await db().select().from(s.inventoryMovements),
        receipts: await db().select().from(s.receipts),
        results: await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "sale.return_cart.result")),
      };
      expect(await caller().executeSalesReturnCart(first)).toMatchObject({
        idempotentReplay: true, returnNumber: firstResult.returnNumber,
        payoutAmount: "0.00", debtOffsetAmount: "1000.00",
      });
      expect(secondResult.returnNumber).not.toBe(firstResult.returnNumber);
      expect({
        invoice: await invoice(sale.invoiceId),
        stock: await db().select().from(s.branchStock),
        entries: await db().select().from(s.accountingEntries),
        movements: await db().select().from(s.inventoryMovements),
        receipts: await db().select().from(s.receipts),
        results: await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "sale.return_cart.result")),
      }).toEqual(beforeReplay);
      const inspected = await caller().inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
      const detailed = await ownerSalesCaller().get({ invoiceId: sale.invoiceId });
      for (const history of [inspected!.previousReturns, detailed!.returns]) {
        expect(history.find((row) => row.returnNumber === firstResult.returnNumber)?.items[0]?.quantity).toBe(1);
        expect(history.find((row) => row.returnNumber === secondResult.returnNumber)?.items[0]?.quantity).toBe(2);
      }
    } finally {
      random.mockRestore();
    }
  });

  it.each([false, true])("binds colliding historical-looking records safely (legacy=%s)", async (legacy) => {
    const sale = await unpaid();
    const first = await cart(sale.invoiceNumber, 1, "1000", `bound-first-${legacy}`);
    await caller().executeSalesReturnCart(first);
    await caller().executeSalesReturnCart(await cart(sale.invoiceNumber, 2, "2000", `bound-second-${legacy}`));
    const sharedNumber = await simulateSameHistoricalNumber(sale.invoiceId, legacy);
    const before = {
      invoice: await invoice(sale.invoiceId),
      entries: await db().select().from(s.accountingEntries),
      stock: await db().select().from(s.branchStock),
      movements: await db().select().from(s.inventoryMovements),
      receipts: await db().select().from(s.receipts),
      results: await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "sale.return_cart.result")),
    };
    if (legacy) {
      await expect(caller().executeSalesReturnCart(first)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } else {
      await expect(caller().executeSalesReturnCart(first)).resolves.toMatchObject({
        idempotentReplay: true, returnNumber: sharedNumber, payoutAmount: "0.00", debtOffsetAmount: "1000.00",
      });
    }
    const inspected = await caller().inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
    const detailed = await ownerSalesCaller().get({ invoiceId: sale.invoiceId });
    for (const history of [inspected!.previousReturns, detailed!.returns]) {
      const quantities = history.map((row) => row.items[0]?.quantity).sort();
      expect(quantities).toEqual(legacy ? [undefined, undefined] : [1, 2]);
    }
    expect({
      invoice: await invoice(sale.invoiceId),
      entries: await db().select().from(s.accountingEntries),
      stock: await db().select().from(s.branchStock),
      movements: await db().select().from(s.inventoryMovements),
      receipts: await db().select().from(s.receipts),
      results: await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "sale.return_cart.result")),
    }).toEqual(before);
  });

  it("replays a unique legacy audit without changing its original financial result", async () => {
    const sale = await unpaid();
    const request = await cart(sale.invoiceNumber, 1, "1000", "legacy-single-return", {
      reason: "ملاحظة [SR-202601-9999] راجعت الأصناف",
    });
    const result = await caller().executeSalesReturnCart(request);
    const [audit] = await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.action, "sale.return_cart"), eq(s.auditLogs.entityId, String(sale.invoiceId)),
    ));
    const value = { ...(audit.newValue as Record<string, unknown>) };
    delete value.returnEntryId;
    await db().update(s.auditLogs).set({ newValue: value }).where(eq(s.auditLogs.id, audit.id));
    await db().delete(s.auditLogs).where(and(
      eq(s.auditLogs.action, "sale.return_cart.result"),
      eq(s.auditLogs.entityId, String((audit.newValue as Record<string, unknown>).returnEntryId)),
    ));
    await expect(caller().executeSalesReturnCart(request)).resolves.toMatchObject({
      idempotentReplay: true, returnNumber: result.returnNumber, debtOffsetAmount: "1000.00", payoutAmount: "0.00",
    });
  });

  it("refuses a legacy replay when the source number and audit are missing", async () => {
    const sale = await unpaid();
    const request = await cart(sale.invoiceNumber, 1, "1000", "legacy-missing-evidence");
    await caller().executeSalesReturnCart(request);
    const [entry] = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, sale.invoiceId), eq(s.accountingEntries.entryType, "RETURN"),
    ));
    await db().update(s.accountingEntries).set({ notes: entry.notes!.replace(/\[SR-[^\]]+\]/g, "") })
      .where(eq(s.accountingEntries.id, entry.id));
    await db().delete(s.auditLogs).where(and(eq(s.auditLogs.action, "sale.return_cart"),
      eq(s.auditLogs.entityId, String(sale.invoiceId))));
    await db().delete(s.auditLogs).where(and(eq(s.auditLogs.action, "sale.return_cart.result"),
      eq(s.auditLogs.entityId, String(entry.id))));
    await expect(caller().executeSalesReturnCart(request)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("keeps replay linked when an unusually large cart audit is truncated", async () => {
    const sale = await unpaid("8");
    const request = await cart(sale.invoiceNumber, 8, "8000", "large-return-audit");
    const item = request.items[0];
    request.items = Array.from({ length: 8 }, () => ({ ...item, quantity: 1, productName: "ع".repeat(1024) }));
    const first = await caller().executeSalesReturnCart(request);
    const [fullAudit] = await db().select().from(s.auditLogs).where(and(
      eq(s.auditLogs.action, "sale.return_cart"), eq(s.auditLogs.entityId, String(sale.invoiceId)),
    ));
    expect(fullAudit.newValue).toMatchObject({ _truncated: true });
    await expect(caller().executeSalesReturnCart(request)).resolves.toMatchObject({
      idempotentReplay: true, returnNumber: first.returnNumber, debtOffsetAmount: "8000.00", payoutAmount: "0.00",
    });
    const inspected = await caller().inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
    const detailed = await ownerSalesCaller().get({ invoiceId: sale.invoiceId });
    for (const history of [inspected!.previousReturns, detailed!.returns]) {
      expect(history.find((row) => row.returnNumber === first.returnNumber)).toMatchObject({
        method: "CREDIT_OFFSET", items: [],
      });
    }
  });

  it("serializes concurrent retries without creating a second return or consuming a second number", async () => {
    const sale = await unpaid();
    const request = await cart(sale.invoiceNumber, 1, "1000", "concurrent-same-return");
    const results = await Promise.all([
      caller().executeSalesReturnCart(request),
      caller().executeSalesReturnCart(request),
    ]);
    expect(results[0].returnNumber).toBe(results[1].returnNumber);
    expect(results.filter((row) => "idempotentReplay" in row && row.idempotentReplay === true)).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, sale.invoiceId), eq(s.accountingEntries.entryType, "RETURN"),
    ))).toHaveLength(1);
    const counters = await db().select().from(s.documentCounters).where(sql`${s.documentCounters.counterKey} LIKE 'sales_return_cart_%'`);
    expect(counters).toHaveLength(1);
    expect(Number(counters[0].lastValue)).toBe(1);
  });

  it("allows the current admin to replay a cross-branch core return without widening cashier access", async () => {
    await db().insert(s.branchStock).values({ branchId: 2, variantId: 1, quantity: 100 });
    const sale = await createSale({ branchId: 2, sourceType: "ORDER", codDispatchPending: true, paymentMode: "COD",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
    }, owner);
    const admin = returnRouter.createCaller({ req: { headers: {} }, res: {},
      user: { id: 1, role: "admin", branchId: 1, isActive: true, isOwner: true, name: "مالك" },
    } as TrpcContext);
    const inspected = await admin.inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
    const item = inspected!.items[0];
    const request = {
      invoiceNumber: inspected!.invoiceNumber, disposition: "RESTOCK" as const,
      items: [{ invoiceItemId: item.invoiceItemId, variantId: item.variantId, productUnitId: item.productUnitId,
        productName: item.productName, quantity: 1, unitPrice: item.effectiveUnitPrice }],
      settlement: { method: "CREDIT_OFFSET" as const, totalAmount: "1000" }, clientRequestId: "cross-branch-return",
    };
    const first = await admin.executeSalesReturnCart(request);
    await expect(admin.executeSalesReturnCart(request)).resolves.toMatchObject({
      idempotentReplay: true, returnNumber: first.returnNumber, debtOffsetAmount: "1000.00",
    });
    await expect(caller().executeSalesReturnCart(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(s.users).set({ role: "cashier", isOwner: false }).where(eq(s.users.id, 1));
    await expect(admin.executeSalesReturnCart(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(["no-receipt", "purchase"] as const)("%s stock writer waits for the exclusive financial gate", async route => {
    const raw = process.env.DATABASE_URL!;
    assertIsolatedActivationTestTarget(raw);
    await db().insert(s.suppliers).values({ id: 1, name: "مورد الاختبار", currentBalance: "0.00" });
    const admin = api.createCaller({
      req: { headers: {} }, res: {},
      user: { id: 1, role: "admin", branchId: 1, isActive: true, isOwner: true, name: "مالك" },
    } as TrpcContext).returns;
    const gate = await mysql.createConnection(raw);
    const observer = await mysql.createConnection(raw);
    let pending: Promise<unknown> | undefined;
    let settled = false;
    try {
      await observer.query("INSERT INTO monthCloseSequence(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id");
      const [[identity]] = await gate.query<mysql.RowDataPacket[]>("SELECT CONNECTION_ID() id, DATABASE() db");
      await gate.beginTransaction();
      await gate.query("SELECT id FROM monthCloseSequence WHERE id=1 FOR UPDATE");
      pending = route === "no-receipt"
        ? admin.executeNoReceiptOrExchange({
            mode: "STORE_CREDIT",
            returnItems: [{ variantId: 1, productUnitId: 1, productName: "دفتر", quantity: 1, unitPrice: "1000", disposition: "RESTOCK" }],
            settlement: { returnTotal: "1000", differenceAmount: "0" },
          })
        : admin.executePurchaseReturnCart({
            supplierId: 1,
            reference: "GATE-SUPPLIER-ACK", evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
            items: [{ variantId: 1, productUnitId: 1, productName: "دفتر", quantity: 1, unitCost: "500" }],
            settlement: { method: "CREDIT_OFFSET", totalAmount: "500" },
            reason: "مرتجع اختبار البوابة", clientRequestId: "purchase-financial-gate",
          });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const deadline = Date.now() + 5000;
      let observed = false;
      let waitingTransaction: string | number | undefined;
      do {
        const [waits] = await observer.query<mysql.RowDataPacket[]>(
          `SELECT w.REQUESTING_ENGINE_TRANSACTION_ID
           FROM performance_schema.data_lock_waits w
           JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID
           JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE
           WHERE b.PROCESSLIST_ID=? AND l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='monthCloseSequence'
             AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA='1'`,
          [identity.id, identity.db],
        );
        if (waits.length) { observed = true; waitingTransaction = waits[0].REQUESTING_ENGINE_TRANSACTION_ID; break; }
        if (settled) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      expect(observed).toBe(true);
      expect(settled).toBe(false);
      const [domainLocks] = await observer.query<mysql.RowDataPacket[]>(
        `SELECT DISTINCT OBJECT_NAME FROM performance_schema.data_locks
         WHERE ENGINE_TRANSACTION_ID=? AND OBJECT_SCHEMA=? AND LOCK_STATUS='GRANTED'
           AND OBJECT_NAME IN ('productVariants','branchStock','inventoryMovements','receipts')`,
        [waitingTransaction, identity.db],
      );
      expect(domainLocks).toEqual([]);
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      await gate.rollback();
      await expect(pending).resolves.toMatchObject(route === "no-receipt" ? { ok: true } : { mode: "EXECUTED" });
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(route === "no-receipt" ? 101 : 99);
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    } finally {
      await gate.rollback();
      if (pending) await Promise.allSettled([pending]);
      await Promise.all([gate.end(), observer.end()]);
    }
  });

  it("cashier returns another maker's old unpaid walk-in invoice partially then fully, replaying once", async () => {
    const sale = await unpaid();
    await db().update(s.invoices).set({ invoiceDate: new Date("2026-10-01T12:00:00Z") }).where(eq(s.invoices.id, sale.invoiceId));
    const first = await cart(sale.invoiceNumber, 1, "1000", "portal-unpaid-first");
    const result = await caller().executeSalesReturnCart(first);
    expect(result).toMatchObject({ noCashNoAccount: true, method: "CREDIT_OFFSET", receiptId: null, payoutAmount: "0.00", debtOffsetAmount: "1000.00" });
    expect(await caller().executeSalesReturnCart(first)).toMatchObject({ idempotentReplay: true, noCashNoAccount: true, payoutAmount: "0.00", debtOffsetAmount: "1000.00" });
    await caller().executeSalesReturnCart(await cart(sale.invoiceNumber, 2, "2000", "portal-unpaid-rest"));
    expect(await caller().executeSalesReturnCart(first)).toMatchObject({ idempotentReplay: true, payoutAmount: "0.00", debtOffsetAmount: "1000.00" });
    expect(await invoice(sale.invoiceId)).toMatchObject({ status: "RETURNED", paidAmount: "0.00", returnedTotal: "3000.00" });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.customers)).toHaveLength(0);
    expect(await db().select().from(s.salesControlRequests)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
  });

  it.each(["CONTROL", "LEGACY"] as const)("blocks an existing %s intent without changing stock, money or the intent", async (source) => {
    const sale = await unpaid();
    if (source === "CONTROL") await db().insert(s.salesControlRequests).values({
      requestKey: "portal-pending", invoiceId: sale.invoiceId, branchId: 1, requestType: "SALES_RETURN",
      requestedBy: 2, reason: "طلب معلق", payload: {}, payloadHash: "test", invoiceSnapshot: {}, snapshotHash: "test",
    });
    else await db().insert(s.returnRequests).values({ invoiceId: sale.invoiceId, branchId: 1, linesJson: [], createdBy: 2, reason: "طلب قديم" });
    await expect(caller().executeSalesReturnCart(await cart(sale.invoiceNumber, 3, "3000", "portal-pending-return")))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await invoice(sale.invoiceId)).returnedTotal).toBe("0.00");
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(97);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.operation, "sale.return_cart"))).toHaveLength(0);
  });

  it("offsets delivered unremitted walk-in custody without drawer money or customer credit", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "توصيل", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0" });
    const sale = await createSale({ branchId: 1, sourceType: "ORDER",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, cashier);
    await recordStaffDeliveryConfirmation({ consignmentId: sale.consignmentId!, collectedAmount: "3000", evidence: "وصل العميل", clientRequestId: "portal-delivered" }, owner);
    const inspected = await caller().inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
    expect(inspected).toMatchObject({ maxCreditOffsetAmount: "3000.00", refundablePaidAmount: "0.00" });
    await caller().executeSalesReturnCart(await cart(sale.invoiceNumber, 3, "3000", "portal-custody"));
    expect((await db().select().from(s.deliveryParties))[0].currentBalance).toBe("0.00");
    expect(await invoice(sale.invoiceId)).toMatchObject({ status: "RETURNED", paidAmount: "0.00" });
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.customers)).toHaveLength(0);
  });

  it("resolves the current scoped invoice before importing old barcode prices", async () => {
    const original = await unpaid();
    const replacement = await unpaid("2");
    await db().update(s.invoices).set({ status: "SUPERSEDED", correctedByInvoiceId: replacement.invoiceId }).where(eq(s.invoices.id, original.invoiceId));
    expect(await caller().inspectInvoiceForReturn({ invoiceNumber: original.invoiceNumber })).toMatchObject({
      id: replacement.invoiceId, total: "2000.00", invoiceNumber: replacement.invoiceNumber, scannedInvoiceNumber: original.invoiceNumber,
    });
    await db().update(s.invoices).set({ branchId: 2 }).where(eq(s.invoices.id, replacement.invoiceId));
    expect(await caller().inspectInvoiceForReturn({ invoiceNumber: original.invoiceNumber })).toBeNull();
  });

  it("does not turn a paid walk-in deposit into CREDIT_OFFSET or a supplied customer credit", async () => {
    await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 2, status: "OPEN", openingBalance: "0", shiftType: "RETAIL" });
    const sale = await createSale({ branchId: 1, shiftId: 1, sourceType: "ORDER", codDispatchPending: true, paymentMode: "COD",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }], payment: { amount: "1000", method: "CASH" },
    }, cashier);
    await expect(caller().executeSalesReturnCart(await cart(sale.invoiceNumber, 3, "3000", "portal-no-credit"))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await db().insert(s.customers).values({ id: 99, name: "حساب آخر", currentBalance: "0" });
    await expect(caller().executeSalesReturnCart(await cart(sale.invoiceNumber, 1, "1000", "portal-no-injected-credit", { customer: { customerId: 99 } })))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect((await invoice(sale.invoiceId)).returnedTotal).toBe("0.00");
  });

  it("separates return total from actual cash paid on both history screens", async () => {
    await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 2, status: "OPEN", openingBalance: "0", shiftType: "RETAIL" });
    const sale = await createSale({ branchId: 1, shiftId: 1, sourceType: "ORDER", codDispatchPending: true, paymentMode: "COD",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }], payment: { amount: "1000", method: "CASH" },
    }, cashier);
    const request = await cart(sale.invoiceNumber, 3, "3000", "portal-mixed-cash", {
      settlement: { method: "CASH", totalAmount: "3000", shiftId: 1 },
    });
    const result = await caller().executeSalesReturnCart(request);
    expect(result).toMatchObject({ totalAmount: "3000", payoutAmount: "1000.00", debtOffsetAmount: "2000.00" });
    const inspected = await caller().inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
    const detailed = await ownerSalesCaller().get({ invoiceId: sale.invoiceId });
    for (const history of [inspected!.previousReturns, detailed!.returns]) {
      expect(history.find((row) => row.returnNumber === result.returnNumber)).toMatchObject({
        amount: "3000.00", amountSource: "RETURN_TOTAL", payoutAmount: "1000.00", debtOffsetAmount: "2000.00", receiptId: result.receiptId,
      });
    }
  });

  it.each(["DELIVERY_FEE", "ROUNDING"] as const)("full completion reverses authoritative %s residue through the core engine", async (kind) => {
    await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 2, status: "OPEN", openingBalance: "0", shiftType: "RETAIL" });
    if (kind === "ROUNDING") await db().update(s.productPrices).set({ price: "1300" });
    const sale = await createSale({ branchId: 1, shiftId: 1, sourceType: "ORDER", codDispatchPending: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      ...(kind === "DELIVERY_FEE" ? { deliveryFee: "500", payment: { amount: "1500", method: "CASH" as const } }
        : { cashRoundIQD: true, payment: { amount: "1300", method: "CASH" as const } }),
    }, cashier);
    const doc = await invoice(sale.invoiceId);
    const request = await cart(sale.invoiceNumber, 1, doc.total, `portal-full-${kind}`, {
      settlement: { method: "CASH", totalAmount: doc.total, shiftId: 1 },
      reason: "وصف تالف [SR-202601-9999] لكن أُعيد للرف",
    });
    const result = await caller().executeSalesReturnCart(request);
    expect(result).toMatchObject({ totalAmount: doc.total, payoutAmount: doc.total, debtOffsetAmount: "0.00" });
    expect(await invoice(sale.invoiceId)).toMatchObject({ status: "RETURNED", returnedTotal: doc.total, paidAmount: "0.00" });
    const outs = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe(doc.total);
    expect(result.receiptId).toBe(Number(outs[0].id));
    const inspected = await caller().inspectInvoiceForReturn({ invoiceNumber: sale.invoiceNumber });
    const detailed = await ownerSalesCaller().get({ invoiceId: sale.invoiceId });
    for (const history of [inspected!.previousReturns, detailed!.returns]) {
      expect(history.find((row) => row.returnNumber === result.returnNumber)).toMatchObject({
        receiptId: Number(outs[0].id), disposition: "RESTOCK",
      });
    }
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
    const [sum] = await db().select({ amount: sql<string>`SUM(${s.accountingEntries.amount})` }).from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.invoiceId, sale.invoiceId), sql`${s.accountingEntries.entryType} IN ('SALE','RETURN','ADJUST')`));
    expect(String(sum.amount)).toBe("0.00");
    expect(await caller().executeSalesReturnCart(request)).toMatchObject({ idempotentReplay: true, returnNumber: result.returnNumber, receiptId: result.receiptId, payoutAmount: doc.total, debtOffsetAmount: "0.00" });
  });

  it("full fee residue keeps paid store credit on the original customer and still rejects walk-in store credit", async () => {
    await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0", shiftType: "RETAIL" });
    await db().insert(s.customers).values({ id: 1, name: "عميل أصلي", currentBalance: "0" });
    const paid = await createSale({ branchId: 1, shiftId: 1, customerId: 1, sourceType: "ORDER", codDispatchPending: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], deliveryFee: "500", payment: { amount: "1500", method: "CASH" },
    }, owner);
    const ownerCaller = returnRouter.createCaller({ req: { headers: {} }, res: {}, user: { id: 1, role: "admin", branchId: 1, isActive: true, isOwner: true, name: "مالك" } } as TrpcContext);
    const request = await cart(paid.invoiceNumber, 1, "1500", "portal-store-fee", {
      customer: { customerId: 1 }, settlement: { method: "STORE_CREDIT", totalAmount: "1500" },
    });
    const result = await ownerCaller.executeSalesReturnCart(request);
    expect(result).toMatchObject({ method: "STORE_CREDIT", payoutAmount: "0.00", debtOffsetAmount: "0.00", receiptId: null });
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("-1500.00");
    expect(await reconcileCustomerBalances()).toEqual([]);
    expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);
    expect(await ownerCaller.executeSalesReturnCart(request)).toMatchObject({ idempotentReplay: true, payoutAmount: "0.00", debtOffsetAmount: "0.00" });
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("-1500.00");
    const walkIn = await createSale({ branchId: 1, sourceType: "ORDER", codDispatchPending: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], deliveryFee: "500",
    }, owner);
    await expect(ownerCaller.executeSalesReturnCart(await cart(walkIn.invoiceNumber, 1, "1500", "portal-no-store-fee", {
      settlement: { method: "STORE_CREDIT", totalAmount: "1500" },
    }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await invoice(walkIn.invoiceId)).returnedTotal).toBe("0.00");
  });
});
