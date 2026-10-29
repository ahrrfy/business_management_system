import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { MySql2PreparedQuery } from "drizzle-orm/mysql2/session";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createProduction } from "../productionService";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import { evidenceHash } from "../purchase/returnEvidence";
import { createGoodsReceipt } from "../purchase/goodsReceipts";
import {
  createSupplierInvoice,
  decideSupplierInvoiceApproval,
  requestSupplierInvoiceApproval,
} from "../purchase/supplierInvoices";
import { runThreeWayMatch } from "../purchase/threeWayMatch";
import { createPurchaseOrder } from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import {
  cumulativeSourceReturnAmount,
  decidePurchaseReturn,
  decidePurchaseReturnReversal,
  requestPurchaseReturn,
  requestPurchaseReturnReversal,
} from "../purchase/returnGovernance";
import { truncateAllTables } from "./__testUtils__";

/**
 * مرتجعُ الشراء وعكسُه محوُ أثرٍ حقيقيّان (حركةُ مخزونٍ + قيدٌ + ذمّةُ مورّد) خلف بوّابة فصل
 * مهامٍ (decidePurchaseReturn/decidePurchaseReturnReversal) — الملفّ القائم
 * purchaseReturnGovernanceS5.test.ts يفحص دوالّ نقيّةً معزولة بلا معاملة ولا مخزون ولا قيد. هذا
 * الملفّ يسدّ الفجوة على قاعدةٍ حقيقية، ويثبت أنّ تجاوز المالك (٣/٩، 3227ce5b) يعمل فعلياً على
 * `purchaseReturnRequests`/`purchaseReturnReversalRequests` بعد إسقاط
 * `chk_purchase_return_request_maker_checker`/`chk_purchase_return_reversal_maker_checker`
 * في الهجرة 0333 (PR #982) — قبلها كانت محاولة المالك اعتماد طلبه تسقط بخطأ DB خامّ
 * (ER_CHECK_CONSTRAINT_VIOLATED). راجع ذاكرة [[owner-decision-no-second-approval-2026-09-03]].
 *
 * سلسلة التجهيز (أمر شراء معتمد ← إذن استلام ← فاتورة مورّد مطابَقة ومرحَّلة) منقولةٌ عن
 * makeGovernedReturnSource في purchaseReturnsForensicClosure.test.ts — الطريق الوحيد المُثبَت
 * لبناء مصدر مرتجعٍ محكوم صالح.
 */

const PURCHASING = { userId: 1, branchId: 1, role: "purchasing" as const };
const WAREHOUSE = { userId: 2, branchId: 1, role: "warehouse" as const };
/** owner نشطٌ — يُستعمَل هنا اختباراً لمساري الاعتماد الذاتي (طلبٌ + قرارٌ بنفس الهويّة). */
const OWNER = { userId: 3, branchId: 1, role: "manager" as const };

const TABLES = [
  "purchaseReturnReversalItems",
  "purchaseReturnReversals",
  "purchaseReturnReversalRequestItems",
  "purchaseReturnReversalRequests",
  "purchaseReturnItems",
  "purchaseReturns",
  "purchaseReturnRequestItems",
  "purchaseReturnRequests",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierInvoices",
  "goodsReceiptItems",
  "goodsReceipts",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "branchStock",
  "purchaseOrderControlRequests",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "purchaseOrderItems",
  "purchaseOrders",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedBase() {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "pr-gov-purchasing",
        name: "مسؤول المشتريات",
        role: "purchasing",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "pr-gov-warehouse",
        name: "أمين المخزن",
        role: "warehouse",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "pr-gov-owner",
        name: "المالك",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد اختبار حوكمة المرتجع",
    currentBalance: "0.00",
  });
  await db().insert(s.products).values({ id: 1, name: "ورق تصوير" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "PR-GOV-1", costPrice: "0.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

beforeEach(async () => {
  await truncateAllTables();
  await seedBase();
});

type SourceOptions = {
  supplierId?: number;
  variantId?: number;
  quantity?: number;
  price?: string;
  discount?: string;
  tax?: string;
  splitReceipts?: boolean;
  conversion?: number;
  usd?: boolean;
};

async function makeOrder(options: SourceOptions = {}) {
  const created = await createPurchaseOrder(
    {
      supplierId: options.supplierId ?? 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      invoiceDiscount: options.usd ? undefined : options.discount,
      agreedCurrency: options.usd ? "USD" : "IQD",
      agreedRate: options.usd ? "100.00" : undefined,
      usdTotal: options.usd ? "0.01" : undefined,
      taxRatePercent: options.tax
        ? new Decimal(options.tax)
            .times(100)
            .div(
              new Decimal(options.quantity ?? 2)
                .times(options.price ?? "100.00")
                .minus(options.discount ?? 0),
            )
            .toString()
        : undefined,
      items: [
        {
          variantId: options.variantId ?? 1,
          productUnitId: options.variantId ?? 1,
          quantity: new Decimal(options.quantity ?? 2)
            .div(options.conversion ?? 1)
            .toString(),
          unitPrice: options.usd
            ? "0.0034"
            : new Decimal(options.price ?? "100.00")
                .times(options.conversion ?? 1)
                .toFixed(2),
        },
      ],
    },
    PURCHASING,
  );
  const [item] = await db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "إرسال أمر اختبار حوكمة المرتجع للمراجعة المستقلة",
      requestKey: `pr-gov-submit:${randomUUID()}`,
    },
    PURCHASING,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `pr-gov-po-approve:${randomUUID()}`,
      approve: true,
      reason: "راجعت المورد والكميات والأسعار واعتمدت أمر الاختبار",
    },
    OWNER,
    { legacyConfirmOnly: true },
  );
  return {
    purchaseOrderId: created.purchaseOrderId,
    purchaseOrderItemId: Number(item.id),
  };
}

/** يبني مصدر مرتجعٍ محكوماً كاملاً: استلامٌ + فاتورةُ موردٍ مطابَقة ومرحَّلة. */
async function makeGovernedReturnSource(options: SourceOptions = {}) {
  const quantity = options.quantity ?? 2;
  if (options.conversion)
    await db()
      .update(s.productUnits)
      .set({ conversionFactor: String(options.conversion) })
      .where(eq(s.productUnits.id, 1));
  const order = await makeOrder(options);
  const [approvedOrder] = await db()
    .select()
    .from(s.purchaseOrders)
    .where(eq(s.purchaseOrders.id, order.purchaseOrderId));
  if (!approvedOrder?.approvedRevisionId)
    throw new Error("approved purchase-order revision is missing");

  const receipt = await createGoodsReceipt(
    {
      purchaseOrderId: order.purchaseOrderId,
      purchaseOrderRevisionId: Number(approvedOrder.approvedRevisionId),
      expectedOrderVersion: Number(approvedOrder.version),
      clientRequestId: `pr-gov-grn:${randomUUID()}`,
      supplierDeliveryNote: `DN-${randomUUID()}`,
      lines: [
        {
          purchaseOrderItemId: order.purchaseOrderItemId,
          acceptedBaseQuantity: options.splitReceipts ? quantity - 1 : quantity,
        },
      ],
    },
    WAREHOUSE,
  );
  const [goodsReceiptItem] = await db()
    .select()
    .from(s.goodsReceiptItems)
    .where(
      eq(s.goodsReceiptItems.goodsReceiptId, Number(receipt.goodsReceiptId)),
    );
  if (!goodsReceiptItem?.purchaseOrderRevisionItemId)
    throw new Error("goods-receipt revision source is missing");
  const matchSources = [
    {
      goodsReceiptItemId: Number(goodsReceiptItem.id),
      matchedBaseQuantity: options.splitReceipts ? quantity - 1 : quantity,
    },
  ];
  if (options.splitReceipts) {
    const [currentOrder] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, order.purchaseOrderId));
    const extra = await createGoodsReceipt(
      {
        purchaseOrderId: order.purchaseOrderId,
        purchaseOrderRevisionId: Number(approvedOrder.approvedRevisionId),
        expectedOrderVersion: Number(currentOrder.version),
        clientRequestId: randomUUID(),
        supplierDeliveryNote: randomUUID(),
        lines: [
          {
            purchaseOrderItemId: order.purchaseOrderItemId,
            acceptedBaseQuantity: 1,
          },
        ],
      },
      WAREHOUSE,
    );
    const [extraItem] = await db()
      .select()
      .from(s.goodsReceiptItems)
      .where(
        eq(s.goodsReceiptItems.goodsReceiptId, Number(extra.goodsReceiptId)),
      );
    matchSources.push({
      goodsReceiptItemId: Number(extraItem.id),
      matchedBaseQuantity: 1,
    });
  }

  const invoice = await createSupplierInvoice(
    {
      supplierId: options.supplierId ?? 1,
      branchId: 1,
      clientRequestId: `pr-gov-invoice:${randomUUID()}`,
      externalInvoiceNumber: `EXT-${randomUUID()}`,
      invoiceDate: new Date().toISOString().slice(0, 10),
      currency: options.usd ? "USD" : "IQD",
      agreedRate: options.usd ? "100.00" : undefined,
      discountAmount: options.usd ? undefined : options.discount,
      taxAmount: options.tax,
      evidenceType: "PDF",
      evidenceReference: `invoice-evidence:${randomUUID()}`,
      lines: [
        {
          purchaseOrderRevisionItemId: Number(
            goodsReceiptItem.purchaseOrderRevisionItemId,
          ),
          description: "ورق تصوير مطابق لمصدر الاستلام",
          invoicedBaseQuantity: quantity,
          unitPrice: options.usd ? "0.0034" : (options.price ?? "100.00"),
        },
      ],
    },
    PURCHASING,
  );
  const [invoiceRow, invoiceLine] = await Promise.all([
    db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId)))
      .then((rows) => rows[0]),
    db()
      .select()
      .from(s.supplierInvoiceLines)
      .where(
        eq(
          s.supplierInvoiceLines.supplierInvoiceId,
          Number(invoice.supplierInvoiceId),
        ),
      )
      .then((rows) => rows[0]),
  ]);
  if (!invoiceRow || !invoiceLine)
    throw new Error("supplier-invoice source is missing");

  const match = await runThreeWayMatch(
    {
      supplierInvoiceId: Number(invoice.supplierInvoiceId),
      expectedInvoiceVersion: Number(invoiceRow.version),
      matchKey: `pr-gov-match:${randomUUID()}`,
      allocations: matchSources.map((row) => ({
        supplierInvoiceLineId: Number(invoiceLine.id),
        ...row,
      })),
    },
    PURCHASING,
  );
  expect(match.outcome).toBe("EXACT");

  const [matchedInvoice] = await db()
    .select()
    .from(s.supplierInvoices)
    .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId)));
  const approval = await requestSupplierInvoiceApproval(
    {
      supplierInvoiceId: Number(invoice.supplierInvoiceId),
      expectedInvoiceVersion: Number(matchedInvoice.version),
      requestKey: `pr-gov-invoice-approval:${randomUUID()}`,
      kind: "POST_INVOICE",
      matchRunId: Number(match.matchRunId),
      reason: "مطابقة الفاتورة وإذن الاستلام وأمر الشراء مكتملة",
    },
    PURCHASING,
  );
  await decideSupplierInvoiceApproval(
    {
      requestId: Number(approval.requestId),
      decisionKey: `pr-gov-invoice-decision:${randomUUID()}`,
      action: "APPROVE",
      reviewReason: "راجعت أدلة المطابقة الثلاثية واعتمدت ترحيل الفاتورة",
    },
    OWNER,
  );

  const [[postedInvoice], [allocation]] = await Promise.all([
    db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(invoice.supplierInvoiceId))),
    db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(
        eq(
          s.supplierInvoiceMatchAllocations.matchRunId,
          Number(match.matchRunId),
        ),
      ),
  ]);
  if (!postedInvoice || !allocation)
    throw new Error("governed return source is incomplete");
  expect(postedInvoice.status).toBe("POSTED");

  return {
    supplierInvoiceId: Number(postedInvoice.id),
    supplierInvoiceVersion: Number(postedInvoice.version),
    matchRunId: Number(match.matchRunId),
    matchAllocationId: Number(allocation.id),
  };
}

function returnRequestInput(
  source: Awaited<ReturnType<typeof makeGovernedReturnSource>>,
) {
  return {
    supplierInvoiceId: source.supplierInvoiceId,
    matchRunId: source.matchRunId,
    expectedInvoiceVersion: source.supplierInvoiceVersion,
    requestKey: `pr-gov-return-request:${randomUUID()}`,
    settlement: "CREDIT" as const,
    paymentMethod: "TRANSFER" as const,
    evidenceType: "RETURN_NOTE" as const,
    evidenceReference: `return-note:${randomUUID()}`,
    reason: "إرجاع وحدة معيبة إلى المورد بعد المطابقة الثلاثية",
    lines: [
      {
        matchAllocationId: source.matchAllocationId,
        baseQuantity: 1,
        reason: "وحدة تالفة مثبتة بمحضر الفحص",
      },
    ],
  };
}

describe("A10 cumulative source entitlement", () => {
  it.each(["guard", "allocation"] as const)(
    "rejects changed reserved native %s before any stock or money effect",
    async (changed) => {
      const source = await makeGovernedReturnSource();
      const requested = await requestPurchaseReturn(
        returnRequestInput(source),
        PURCHASING,
      );
      if (changed === "guard")
        await db()
          .update(s.purchaseReturnRequests)
          .set({ pendingGuard: "RETURN:wrong-invoice" })
          .where(eq(s.purchaseReturnRequests.id, requested.requestId));
      else
        await db()
          .update(s.supplierInvoiceMatchAllocations)
          .set({ matchedBaseQuantity: 1 })
          .where(
            eq(s.supplierInvoiceMatchAllocations.id, source.matchAllocationId),
          );
      const effects = async () => ({
        stock: await db().select().from(s.branchStock),
        suppliers: await db().select().from(s.suppliers),
        invoices: await db().select().from(s.supplierInvoices),
        movements: await db().select().from(s.inventoryMovements),
        entries: await db().select().from(s.accountingEntries),
        receipts: await db().select().from(s.receipts),
        returns: await db().select().from(s.purchaseReturns),
        requests: await db().select().from(s.purchaseReturnRequests),
      });
      const before = await effects();
      await expect(
        decidePurchaseReturn(
          {
            requestId: requested.requestId,
            decisionKey: randomUUID(),
            action: "APPROVE",
            reviewReason: "Reject changed reserved entitlement",
          },
          OWNER,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await effects()).toEqual(before);
    },
  );

  it("approves distinct native variants without a shared empty-history gap cycle", async () => {
    await db()
      .insert(s.suppliers)
      .values({ id: 2, name: "مورد مستقل", currentBalance: "0.00" });
    await db().insert(s.products).values({ id: 2, name: "صنف مستقل" });
    await db().insert(s.productVariants).values({
      id: 2,
      productId: 2,
      sku: "NATIVE-DISTINCT",
      costPrice: "0.00",
    });
    await db().insert(s.productUnits).values({
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    });
    const sources = [
      await makeGovernedReturnSource(),
      await makeGovernedReturnSource({ supplierId: 2, variantId: 2 }),
    ];
    const inputs = [];
    for (const source of sources) {
      const request = await requestPurchaseReturn(
        returnRequestInput(source),
        PURCHASING,
      );
      inputs.push({
        requestId: request.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE" as const,
        reviewReason: "Reviewed distinct native return source",
      });
    }
    const resume = Promise.withResolvers<void>();
    const execute = MySql2PreparedQuery.prototype.execute;
    let reached = 0;
    const spy = vi
      .spyOn(MySql2PreparedQuery.prototype, "execute")
      .mockImplementation(async function (
        this: typeof MySql2PreparedQuery.prototype,
        values,
      ) {
        const query = (this as unknown as { query: { sql: string } }).query.sql;
        if (query.startsWith("insert into `branchStock`") && reached < 2) {
          reached++;
          if (reached === 2) resume.resolve();
          await resume.promise;
        }
        return execute.call(this, values);
      });
    let barrierTimedOut = false;
    const timer = setTimeout(() => {
      barrierTimedOut = true;
      resume.resolve();
    }, 8_000);
    try {
      const results = await Promise.allSettled(
        inputs.map((input) => decidePurchaseReturn(input, OWNER)),
      );
      expect(reached).toBe(2);
      expect(barrierTimedOut).toBe(false);
      if (results.some((result) => result.status === "rejected")) {
        const [status] = await db().execute(sql`SHOW ENGINE INNODB STATUS`);
        const diagnostic = (status as unknown as Array<{ Status: string }>)[0]!
          .Status;
        console.log(
          diagnostic.slice(
            diagnostic.indexOf("LATEST DETECTED DEADLOCK"),
            diagnostic.indexOf("TRANSACTIONS\n"),
          ),
        );
      }
      expect(results).toEqual(
        inputs.map(() => ({
          status: "fulfilled",
          value: expect.objectContaining({ idempotent: false }),
        })),
      );
      expect(
        (await db().select().from(s.branchStock)).map((row) => row.quantity),
      ).toEqual([1, 1]);
      expect(await db().select().from(s.purchaseReturns)).toHaveLength(2);
    } finally {
      clearTimeout(timer);
      resume.resolve();
      spy.mockRestore();
    }
  }, 30_000);

  it("approves independent native CREDIT returns without upgrading the shared product lock", async () => {
    await db()
      .insert(s.suppliers)
      .values({ id: 2, name: "مورد مستقل", currentBalance: "0.00" });
    const sources = [
      await makeGovernedReturnSource({
        supplierId: 1,
        quantity: 2,
        price: "100.00",
      }),
      await makeGovernedReturnSource({
        supplierId: 2,
        quantity: 2,
        price: "200.00",
      }),
    ];
    const requests = [];
    for (const source of sources)
      requests.push(
        await requestPurchaseReturn(returnRequestInput(source), PURCHASING),
      );
    await db()
      .insert(s.accounts)
      .values([
        { code: "NATIVE-AP", name: "AP", type: "LIABILITY", systemRole: "AP" },
        {
          code: "NATIVE-STOCK",
          name: "Inventory",
          type: "ASSET",
          systemRole: "INVENTORY",
        },
        {
          code: "NATIVE-VARIANCE",
          name: "Variance",
          type: "EXPENSE",
          systemRole: "PURCHASE_PRICE_VARIANCE",
        },
      ]);
    await db()
      .update(s.doubleEntrySettings)
      .set({
        mode: "ACTIVE",
        shadowCycleId: "native-overlap",
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "NATIVE-APPROVAL",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: "native-overlap",
        policyApprovalOpeningHash: "a".repeat(64),
        policyAccountantName: "Test accountant",
        policyApprovedAt: new Date(),
        policyApprovedBy: OWNER.userId,
      })
      .where(eq(s.doubleEntrySettings.id, 1));
    const inputs = requests.map(({ requestId }) => ({
      requestId,
      decisionKey: randomUUID(),
      action: "APPROVE" as const,
      reviewReason: "Reviewed independent native source and supplier credit",
    }));
    const scopeHeld = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const execute = MySql2PreparedQuery.prototype.execute;
    let paused = false;
    const spy = vi
      .spyOn(MySql2PreparedQuery.prototype, "execute")
      .mockImplementation(async function (
        this: typeof MySql2PreparedQuery.prototype,
        values,
      ) {
        const query = (this as unknown as { query: { sql: string } }).query.sql;
        // Pause after the real economic scope and before the stock/metadata writes.
        if (!paused && query.startsWith("insert into `branchStock`")) {
          paused = true;
          scopeHeld.resolve();
          await resume.promise;
        }
        return execute.call(this, values);
      });
    const tasks: ReturnType<typeof decidePurchaseReturn>[] = [];
    const timeout = setTimeout(() => resume.resolve(), 10_000);
    try {
      tasks.push(decidePurchaseReturn(inputs[0]!, OWNER));
      // Attach rejection handlers before observing barriers, including the RED run.
      void tasks[0]!.catch(() => undefined);
      await Promise.race([
        scopeHeld.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Native scope barrier not reached")),
            8_000,
          ),
        ),
      ]);
      tasks.push(decidePurchaseReturn(inputs[1]!, OWNER));
      void tasks[1]!.catch(() => undefined);
      let observed: unknown[] = [];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const [rows] = await db().execute(sql`
          SELECT waiting.OBJECT_NAME AS waitingTable, waiting.LOCK_MODE AS waitingMode,
                 held.OBJECT_NAME AS heldTable, held.LOCK_MODE AS heldMode,
                 @@transaction_isolation AS isolationLevel
          FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks waiting ON waiting.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
          JOIN performance_schema.data_locks held ON held.ENGINE_TRANSACTION_ID=waiting.ENGINE_TRANSACTION_ID
          WHERE waiting.OBJECT_SCHEMA=DATABASE() AND waiting.OBJECT_NAME='productVariants'
            AND waiting.LOCK_STATUS='WAITING' AND held.OBJECT_NAME='products'
            AND held.INDEX_NAME='PRIMARY' AND held.LOCK_STATUS='GRANTED' AND held.LOCK_MODE LIKE 'S%'
        `);
        observed = Array.isArray(rows) ? rows : [];
        if (observed.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observed).toEqual([
        expect.objectContaining({
          waitingTable: "productVariants",
          waitingMode: "X,REC_NOT_GAP",
          heldTable: "products",
          heldMode: "S,REC_NOT_GAP",
          isolationLevel: "REPEATABLE-READ",
        }),
      ]);
      console.log("Native overlap observed MySQL locks", observed);
      resume.resolve();
      const results = await Promise.allSettled(tasks);
      if (results.some((result) => result.status === "rejected")) {
        const [status] = await db().execute(sql`SHOW ENGINE INNODB STATUS`);
        const diagnostic = (status as unknown as Array<{ Status: string }>)[0]!
          .Status;
        console.log(
          diagnostic.slice(
            diagnostic.indexOf("LATEST DETECTED DEADLOCK"),
            diagnostic.indexOf("TRANSACTIONS\n"),
          ),
        );
      }
      expect(results).toEqual(
        inputs.map(() => ({
          status: "fulfilled",
          value: expect.objectContaining({ idempotent: false }),
        })),
      );
      const effects = async () => ({
        returns: await db().select().from(s.purchaseReturns),
        items: await db().select().from(s.purchaseReturnItems),
        stock: await db().select().from(s.branchStock),
        suppliers: await db().select().from(s.suppliers),
        invoices: await db().select().from(s.supplierInvoices),
        allocations: await db()
          .select()
          .from(s.supplierInvoiceMatchAllocations),
        receivedItems: await db().select().from(s.goodsReceiptItems),
        movements: await db().select().from(s.inventoryMovements),
        entries: await db().select().from(s.accountingEntries),
        journals: await db().select().from(s.journalEntries),
        lines: await db().select().from(s.journalLines),
        receipts: await db().select().from(s.receipts),
      });
      const saved = await effects();
      expect(saved.returns).toHaveLength(2);
      expect(saved.items).toHaveLength(2);
      expect(saved.stock).toEqual([expect.objectContaining({ quantity: 2 })]);
      expect(saved.suppliers.map((row) => row.currentBalance).sort()).toEqual([
        "100.00",
        "200.00",
      ]);
      expect(
        saved.receivedItems.map((row) => row.returnedBaseQuantity),
      ).toEqual([1, 1]);
      expect(saved.returns.map((row) => row.creditOffsetAmount).sort()).toEqual(
        ["100.00", "200.00"],
      );
      expect(
        saved.movements.filter(
          (row) => row.referenceType === "PURCHASE_RETURN",
        ),
      ).toHaveLength(2);
      expect(
        saved.entries.filter((row) => row.entryType === "RETURN"),
      ).toHaveLength(2);
      expect(saved.receipts).toHaveLength(0);
      expect(saved.journals).toHaveLength(2);
      for (const journal of saved.journals) {
        expect(journal.status).toBe("POSTED");
        const lines = saved.lines.filter(
          (line) => line.journalId === journal.id,
        );
        expect(lines).toHaveLength(3);
        expect(
          Decimal.sum(...lines.map((line) => line.debit)).eq(
            Decimal.sum(...lines.map((line) => line.credit)),
          ),
        ).toBe(true);
        expect(lines.find((line) => line.role === "INVENTORY")?.credit).toBe(
          "150.00",
        );
      }
      for (const item of saved.items) {
        expect(item.valuationEvidence).toMatchObject({
          basis: "LOCKED_WAVG",
          inventoryUnitCost: "150.00",
          inventoryAmount: "150.00",
          baseQuantity: 1,
        });
        expect(item.valuationEvidenceHash).toBe(
          evidenceHash(item.valuationEvidence),
        );
        await expect(
          db()
            .update(s.purchaseReturnItems)
            .set({ valuationEvidenceHash: "b".repeat(64) })
            .where(eq(s.purchaseReturnItems.id, item.id)),
        ).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringContaining("immutable"),
          }),
        });
      }
      for (let index = 0; index < inputs.length; index++)
        expect(await decidePurchaseReturn(inputs[index]!, OWNER)).toMatchObject(
          { idempotent: true },
        );
      expect(await effects()).toEqual(saved);
      console.log("Native overlap effects", {
        returns: saved.returns.length,
        stock: 2,
        supplierAP: saved.suppliers.map((row) => row.currentBalance),
        activeJournals: saved.journals.length,
        replayUnchanged: true,
      });
    } finally {
      clearTimeout(timeout);
      resume.resolve();
      await Promise.allSettled(tasks);
      spy.mockRestore();
    }
  }, 30_000);

  it("completes native production while an independent supplier return holds the shared input scope", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "100.00",
    });
    const request = await requestPurchaseReturn(
      returnRequestInput(source),
      PURCHASING,
    );
    await db().insert(s.products).values({ id: 2, name: "ناتج إنتاج" });
    await db()
      .insert(s.productVariants)
      .values({ id: 2, productId: 2, sku: "NATIVE-OUTPUT", costPrice: "0.00" });
    const decision = {
      requestId: request.requestId,
      decisionKey: randomUUID(),
      action: "APPROVE" as const,
      reviewReason: "Reviewed return during production overlap",
    };
    const production = {
      branchId: 1,
      clientRequestId: randomUUID(),
      inputs: [{ variantId: 1, baseQuantity: 1 }],
      outputs: [{ variantId: 2, baseQuantity: 1 }],
    };
    const held = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const execute = MySql2PreparedQuery.prototype.execute;
    let paused = false;
    const spy = vi
      .spyOn(MySql2PreparedQuery.prototype, "execute")
      .mockImplementation(async function (
        this: typeof MySql2PreparedQuery.prototype,
        values,
      ) {
        const query = (this as unknown as { query: { sql: string } }).query.sql;
        if (!paused && query.startsWith("insert into `branchStock`")) {
          paused = true;
          held.resolve();
          await resume.promise;
        }
        return execute.call(this, values);
      });
    const tasks: Promise<unknown>[] = [];
    const timeout = setTimeout(() => resume.resolve(), 10_000);
    try {
      tasks.push(decidePurchaseReturn(decision, OWNER));
      void tasks[0]!.catch(() => undefined);
      await Promise.race([
        held.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Return scope not reached")),
            8_000,
          ),
        ),
      ]);
      tasks.push(createProduction(production, OWNER));
      void tasks[1]!.catch(() => undefined);
      let waits = 0;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const [rows] = await db().execute(sql`
          SELECT w.REQUESTING_ENGINE_TRANSACTION_ID
          FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks waiting ON waiting.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
          JOIN performance_schema.data_locks held ON held.ENGINE_TRANSACTION_ID=waiting.ENGINE_TRANSACTION_ID
          WHERE waiting.OBJECT_SCHEMA=DATABASE() AND waiting.OBJECT_NAME='productVariants'
            AND waiting.LOCK_STATUS='WAITING' AND held.OBJECT_NAME='products'
            AND held.INDEX_NAME='PRIMARY' AND held.LOCK_STATUS='GRANTED' AND held.LOCK_MODE LIKE 'S%'
        `);
        waits = Array.isArray(rows) ? rows.length : 0;
        if (waits) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waits).toBeGreaterThan(0);
      resume.resolve();
      const results = await Promise.allSettled(tasks);
      expect(results).toEqual([
        {
          status: "fulfilled",
          value: expect.objectContaining({
            idempotent: false,
            status: "APPROVED",
          }),
        },
        {
          status: "fulfilled",
          value: expect.objectContaining({ totalCost: "100.00" }),
        },
      ]);
      const effects = async () => ({
        stock: await db().select().from(s.branchStock),
        variants: await db().select().from(s.productVariants),
        movements: await db().select().from(s.inventoryMovements),
        returns: await db().select().from(s.purchaseReturns),
        items: await db().select().from(s.purchaseReturnItems),
        productions: await db().select().from(s.productionOrders),
        productionLines: await db().select().from(s.productionLines),
        suppliers: await db().select().from(s.suppliers),
        entries: await db().select().from(s.accountingEntries),
      });
      const saved = await effects();
      expect(saved.stock).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ variantId: 1, quantity: 1 }),
          expect.objectContaining({ variantId: 2, quantity: 1 }),
        ]),
      );
      expect(saved.variants.find((row) => row.id === 2)?.costPrice).toBe(
        "100.00",
      );
      expect(saved.returns).toHaveLength(1);
      expect(saved.items[0]?.valuationEvidence).toMatchObject({
        inventoryAmount: "100.00",
        inventoryUnitCost: "100.00",
      });
      expect(saved.productions).toHaveLength(1);
      expect(saved.productionLines).toHaveLength(2);
      expect(saved.suppliers[0]?.currentBalance).toBe("200.00");
      expect(
        saved.movements.filter(
          (row) => row.referenceType === "PURCHASE_RETURN",
        ),
      ).toHaveLength(1);
      expect(
        saved.movements.filter((row) => row.referenceType === "PRODUCTION"),
      ).toHaveLength(2);
      expect(await decidePurchaseReturn(decision, OWNER)).toMatchObject({
        idempotent: true,
      });
      expect(await createProduction(production, OWNER)).toMatchObject({
        idempotent: true,
        totalCost: "100.00",
      });
      expect(await effects()).toEqual(saved);
      console.log("Production/return overlap", {
        actualWait: waits,
        inputRemaining: 1,
        output: 1,
        outputValue: "100.00",
        supplierAP: "200.00",
        replayUnchanged: true,
      });
    } finally {
      clearTimeout(timeout);
      resume.resolve();
      await Promise.allSettled(tasks);
      spy.mockRestore();
    }
  }, 30_000);

  it("conserves nonzero tax arithmetically using actual prior amounts", () => {
    let prior = new Decimal(0);
    const deltas = [1, 2, 3].map((quantity) => {
      const delta = cumulativeSourceReturnAmount("0.02", 3, quantity, prior);
      prior = prior.plus(delta);
      return delta.toFixed(2);
    });
    expect(deltas).toEqual(["0.01", "0.00", "0.01"]);
    expect(
      cumulativeSourceReturnAmount("1.00", 3, 2, new Decimal("0.32")).toFixed(
        2,
      ),
    ).toBe("0.35");
    expect(
      cumulativeSourceReturnAmount("1.00", 3, 3, new Decimal("0.66")).toFixed(
        2,
      ),
    ).toBe("0.34");
  });
  async function requestFresh(
    source: Awaited<ReturnType<typeof makeGovernedReturnSource>>,
    lines?: Array<{ matchAllocationId: number; baseQuantity: number }>,
  ) {
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, source.supplierInvoiceId));
    const input = returnRequestInput({
      ...source,
      supplierInvoiceVersion: Number(invoice.version),
    });
    return {
      input: { ...input, ...(lines ? { lines } : {}) },
      result: await requestPurchaseReturn(
        { ...input, ...(lines ? { lines } : {}) },
        PURCHASING,
      ),
    };
  }
  async function approve(requestId: number) {
    return decidePurchaseReturn(
      {
        requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "Reviewed frozen source entitlement",
      },
      OWNER,
    );
  }
  async function reverse(purchaseReturnId: number, quantity: number) {
    const [row] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, purchaseReturnId));
    const [item] = await db()
      .select()
      .from(s.purchaseReturnItems)
      .where(eq(s.purchaseReturnItems.purchaseReturnId, purchaseReturnId));
    const request = await requestPurchaseReturnReversal(
      {
        purchaseReturnId,
        expectedReturnVersion: Number(row.version),
        requestKey: randomUUID(),
        evidenceType: "SIGNED_APPROVAL",
        evidenceReference: randomUUID(),
        reason: "Actual partial reversal before new supplier return",
        lines: [
          { purchaseReturnItemId: Number(item.id), baseQuantity: quantity },
        ],
      },
      PURCHASING,
    );
    return decidePurchaseReturnReversal(
      {
        requestId: request.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "Reviewed actual source reversal",
      },
      OWNER,
    );
  }

  it("creates a return and a reversal request concurrently without a parent-item lock cycle", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "0.34",
      discount: "0.02",
    });
    const first = await approve((await requestFresh(source)).result.requestId);
    const purchaseReturnId = Number(first.purchaseReturnId);
    const [original] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, purchaseReturnId));
    const [item] = await db()
      .select()
      .from(s.purchaseReturnItems)
      .where(eq(s.purchaseReturnItems.purchaseReturnId, purchaseReturnId));
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, source.supplierInvoiceId));
    const returnInput = returnRequestInput({
      ...source,
      supplierInvoiceVersion: Number(invoice.version),
    });
    const reversalInput = {
      purchaseReturnId,
      expectedReturnVersion: Number(original.version),
      requestKey: randomUUID(),
      evidenceType: "SIGNED_APPROVAL" as const,
      evidenceReference: randomUUID(),
      reason: "Concurrent governed reversal request",
      lines: [{ purchaseReturnItemId: Number(item.id), baseQuantity: 1 }],
    };
    const effects = async () => ({
      suppliers: await db().select().from(s.suppliers),
      stock: await db().select().from(s.branchStock),
      movements: await db().select().from(s.inventoryMovements),
      ledger: await db().select().from(s.accountingEntries),
      receipts: await db().select().from(s.receipts),
      returns: await db().select().from(s.purchaseReturns),
      reversals: await db().select().from(s.purchaseReturnReversals),
    });
    const before = await effects();
    const itemHeld = Promise.withResolvers<void>();
    const resumeReturn = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const execute = MySql2PreparedQuery.prototype.execute;
    let paused = false;
    let invoiceAttempts = 0;
    let reversalReachedLock = false;
    const spy = vi
      .spyOn(MySql2PreparedQuery.prototype, "execute")
      .mockImplementation(async function (
        this: typeof MySql2PreparedQuery.prototype,
        values,
      ) {
        const query = (this as unknown as { query: { sql: string } }).query.sql;
        if (
          query.includes("from `supplierInvoices`") &&
          query.includes("for update")
        ) {
          invoiceAttempts += 1;
          if (invoiceAttempts === 2) {
            // Fixed protocol: the reversal waits on the source invoice before
            // holding its parent. Let the first transaction finish normally.
            reversalReachedLock = true;
            resumeReturn.resolve();
          }
        }
        const pending = execute.call(this, values);
        if (
          paused &&
          query.includes("from `purchaseReturnItems`") &&
          query.includes("for update")
        ) {
          // Old protocol: reversal already owns parent X and now waits for item X.
          // Resume return's monetary current read, which needs the same parent S.
          reversalReachedLock = true;
          resumeReturn.resolve();
        }
        const result = await pending;
        if (
          !paused &&
          query.includes("from `purchaseReturnItems`") &&
          !query.includes("join") &&
          query.includes("for share")
        ) {
          paused = true;
          itemHeld.resolve();
          await Promise.race([resumeReturn.promise, deadline.promise]);
        }
        return result;
      });
    const tasks: Promise<unknown>[] = [];
    const timeout = setTimeout(
      () =>
        deadline.reject(
          new Error("Concurrent requests did not reach their lock barriers"),
        ),
      8_000,
    );
    try {
      const returning = requestPurchaseReturn(returnInput, PURCHASING);
      tasks.push(returning);
      await Promise.race([itemHeld.promise, deadline.promise]);
      const reversing = requestPurchaseReturnReversal(
        reversalInput,
        PURCHASING,
      );
      tasks.push(reversing);
      const results = await Promise.allSettled([returning, reversing]);
      expect(reversalReachedLock).toBe(true);
      expect(await effects()).toEqual(before);
      expect(results).toEqual([
        {
          status: "fulfilled",
          value: expect.objectContaining({
            status: "PENDING",
            idempotent: false,
          }),
        },
        {
          status: "fulfilled",
          value: expect.objectContaining({
            status: "PENDING",
            idempotent: false,
          }),
        },
      ]);
      const requests = await db()
        .select()
        .from(s.purchaseReturnRequests)
        .where(eq(s.purchaseReturnRequests.status, "PENDING"));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        requestedNetAmount: "0.34",
        requestedTaxAmount: "0.00",
      });
      const reversals = await db()
        .select()
        .from(s.purchaseReturnReversalRequests);
      expect(reversals).toHaveLength(1);
      const reservedItems = await db()
        .select()
        .from(s.purchaseReturnRequestItems)
        .where(eq(s.purchaseReturnRequestItems.requestId, requests[0]!.id));
      expect(reservedItems).toEqual([
        expect.objectContaining({
          requestedBaseQuantity: 1,
          netAmount: "0.34",
          taxAmount: "0.00",
        }),
      ]);
      const reversalItems = await db()
        .select()
        .from(s.purchaseReturnReversalRequestItems)
        .where(
          eq(s.purchaseReturnReversalRequestItems.requestId, reversals[0]!.id),
        );
      expect(reversalItems).toEqual([
        expect.objectContaining({
          purchaseReturnItemId: item.id,
          baseQuantity: 1,
        }),
      ]);
      expect(
        await requestPurchaseReturn(returnInput, PURCHASING),
      ).toMatchObject({ requestId: requests[0]!.id, idempotent: true });
      expect(
        await requestPurchaseReturnReversal(reversalInput, PURCHASING),
      ).toMatchObject({ requestId: reversals[0]!.id, idempotent: true });
    } finally {
      clearTimeout(timeout);
      resumeReturn.resolve();
      await Promise.allSettled(tasks);
      spy.mockRestore();
    }
  });

  it("reads actual money after waiting for a concurrent cash-return posting despite an older replay snapshot", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "0.34",
      discount: "0.02",
    });
    const input = {
      ...returnRequestInput(source),
      settlement: "CASH" as const,
      evidenceType: "SUPPLIER_ACKNOWLEDGEMENT" as const,
    };
    const first = await requestPurchaseReturn(input, PURCHASING);
    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = MySql2PreparedQuery.prototype.execute;
    let lockCount = 0;
    let sawSnapshot = false;
    const spy = vi
      .spyOn(MySql2PreparedQuery.prototype, "execute")
      .mockImplementation(async function (
        this: typeof MySql2PreparedQuery.prototype,
        values,
      ) {
        const query = (this as unknown as { query: { sql: string } }).query.sql;
        if (
          lockCount === 1 &&
          query.includes("from `purchaseReturnRequests`") &&
          !query.includes("for update") &&
          query.includes("`requestKey`")
        )
          sawSnapshot = true;
        const invoiceLock =
          query.includes("from `supplierInvoices`") &&
          query.includes("for update");
        if (invoiceLock && ++lockCount === 2) release();
        const result = await execute.call(this, values);
        if (invoiceLock && lockCount === 1) {
          locked();
          await released;
        }
        return result;
      });
    try {
      const posting = approve(first.requestId);
      await hasLock;
      const next = requestPurchaseReturn(
        { ...input, requestKey: randomUUID(), evidenceReference: randomUUID() },
        PURCHASING,
      );
      await posting;
      const requested = await next;
      expect(sawSnapshot).toBe(true);
      const [reserved] = await db()
        .select()
        .from(s.purchaseReturnRequests)
        .where(eq(s.purchaseReturnRequests.id, requested.requestId));
      expect(reserved.requestedNetAmount).toBe("0.34");
      await approve(requested.requestId);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("keeps the original USD book total through fractional credit returns", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "0.34",
      discount: "0.02",
      usd: true,
    });
    const [invoice] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, source.supplierInvoiceId));
    expect(invoice).toMatchObject({
      usdTotal: "0.01",
      totalAmount: "1.00",
      agreedRate: "100.0000",
    });
    for (let index = 0; index < 3; index += 1)
      await approve((await requestFresh(source)).result.requestId);
    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("0.00");
    expect(supplier.currentBalanceUsd).toBe("0.00");
  });
  it.each([
    { discount: "0.02", net: "1.00", amounts: ["0.33", "0.34", "0.33"] },
    { discount: "0.01", net: "1.01", amounts: ["0.34", "0.33", "0.34"] },
  ])(
    "returns exactly $net across three actual request/approve/post cycles",
    async ({ discount, net, amounts }) => {
      const source = await makeGovernedReturnSource({
        quantity: 3,
        price: "0.34",
        discount,
      });
      const posted: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const [invoice] = await db()
          .select()
          .from(s.supplierInvoices)
          .where(eq(s.supplierInvoices.id, source.supplierInvoiceId));
        const requested = await requestPurchaseReturn(
          returnRequestInput({
            ...source,
            supplierInvoiceVersion: Number(invoice.version),
          }),
          PURCHASING,
        );
        const approved = await decidePurchaseReturn(
          {
            requestId: requested.requestId,
            decisionKey: randomUUID(),
            action: "APPROVE",
            reviewReason: "Reviewed frozen source entitlement",
          },
          OWNER,
        );
        const [row] = await db()
          .select()
          .from(s.purchaseReturns)
          .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId)));
        posted.push(row.netAmount);
      }
      expect(posted).toEqual(amounts);
      const [sum] = await db()
        .select({ net: sql<string>`SUM(${s.purchaseReturns.netAmount})` })
        .from(s.purchaseReturns);
      expect(sum.net).toBe(net);
      const [supplier] = await db()
        .select()
        .from(s.suppliers)
        .where(eq(s.suppliers.id, 1));
      expect(supplier.currentBalance).toBe("0.00");
    },
  );

  it("aggregates one source across real split GRNs, discount, converted purchase unit and zero-tax policy", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "0.34",
      discount: "0.02",
      conversion: 3,
      splitReceipts: true,
    });
    const allocations = await db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(
        eq(s.supplierInvoiceMatchAllocations.matchRunId, source.matchRunId),
      );
    expect(allocations).toHaveLength(2);
    const amounts: string[] = [];
    for (const allocation of allocations) {
      for (
        let count = 0;
        count < Number(allocation.matchedBaseQuantity);
        count += 1
      ) {
        const requested = await requestFresh(source, [
          { matchAllocationId: Number(allocation.id), baseQuantity: 1 },
        ]);
        const result = await approve(requested.result.requestId);
        const [row] = await db()
          .select()
          .from(s.purchaseReturns)
          .where(eq(s.purchaseReturns.id, Number(result.purchaseReturnId)));
        amounts.push(row.netAmount);
      }
    }
    expect(amounts).toEqual(["0.33", "0.34", "0.33"]);
    const [totals] = await db()
      .select({
        net: sql<string>`SUM(${s.purchaseReturns.netAmount})`,
        tax: sql<string>`SUM(${s.purchaseReturns.taxAmount})`,
      })
      .from(s.purchaseReturns);
    expect(totals).toEqual({ net: "1.00", tax: "0.00" });
    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("0.00");
  });

  it("uses actual posted and partially reversed money before granting the final entitlement", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "0.34",
      discount: "0.02",
    });
    const first = await requestFresh(source, [
      { matchAllocationId: source.matchAllocationId, baseQuantity: 2 },
    ]);
    const posted = await approve(first.result.requestId);
    await reverse(Number(posted.purchaseReturnId), 1);
    const next = await requestFresh(source, [
      { matchAllocationId: source.matchAllocationId, baseQuantity: 2 },
    ]);
    const [reserved] = await db()
      .select()
      .from(s.purchaseReturnRequests)
      .where(eq(s.purchaseReturnRequests.id, next.result.requestId));
    const [[original], [reversal]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseReturns)
        .where(eq(s.purchaseReturns.id, Number(posted.purchaseReturnId))),
      db().select().from(s.purchaseReturnReversals),
    ]);
    expect(
      new Decimal(original.netAmount)
        .minus(reversal.netAmount)
        .plus(reserved.requestedNetAmount)
        .toFixed(2),
    ).toBe("1.00");
    expect(
      new Decimal(original.taxAmount)
        .minus(reversal.taxAmount)
        .plus(reserved.requestedTaxAmount)
        .toFixed(2),
    ).toBe("0.00");
    await approve(next.result.requestId);
    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("0.00");
  });

  it("releases rejected reservations, preserves replay and fails stale approval without repricing", async () => {
    const source = await makeGovernedReturnSource({
      quantity: 3,
      price: "0.34",
      discount: "0.02",
    });
    const first = await requestFresh(source);
    expect(
      (await requestPurchaseReturn(first.input, PURCHASING)).idempotent,
    ).toBe(true);
    await expect(
      requestPurchaseReturn(
        { ...first.input, reason: "Changed reviewed payload" },
        PURCHASING,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(requestFresh(source)).rejects.toThrow(); // UNIQUE pendingGuard: one reservation per invoice.
    await decidePurchaseReturn(
      {
        requestId: first.result.requestId,
        decisionKey: randomUUID(),
        action: "REJECT",
        reviewReason: "Release reserved quantity and cents",
      },
      OWNER,
    );
    const fresh = await requestFresh(source);
    const [before] = await db()
      .select()
      .from(s.purchaseReturnRequests)
      .where(eq(s.purchaseReturnRequests.id, fresh.result.requestId));
    expect(before.requestedNetAmount).toBe("0.33");
    await db()
      .update(s.supplierInvoices)
      .set({ version: sql`${s.supplierInvoices.version} + 1` })
      .where(eq(s.supplierInvoices.id, source.supplierInvoiceId));
    expect((await approve(fresh.result.requestId)).status).toBe("STALE");
    const [after] = await db()
      .select()
      .from(s.purchaseReturnRequests)
      .where(eq(s.purchaseReturnRequests.id, fresh.result.requestId));
    expect(after.requestedNetAmount).toBe(before.requestedNetAmount);
    const final = await requestFresh(source, [
      { matchAllocationId: source.matchAllocationId, baseQuantity: 3 },
    ]);
    await approve(final.result.requestId);
    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("0.00");
  });
});

describe("حوكمة مرتجع الشراء — فصل المهام على قاعدةٍ حقيقية", () => {
  it("يرفض اعتماد طالب المرتجع لطلبه ذاته", async () => {
    const source = await makeGovernedReturnSource();
    const requested = await requestPurchaseReturn(
      returnRequestInput(source),
      PURCHASING,
    );
    expect(requested.status).toBe("PENDING");

    await expect(
      decidePurchaseReturn(
        {
          requestId: Number(requested.requestId),
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "محاولة اعتماد ذاتي",
        },
        PURCHASING,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await db().select().from(s.purchaseReturns)).toHaveLength(0);
  });

  it("يعتمد المالكُ طلب مرتجعٍ أنشأه هو بنفسه فيُسجَّل المرتجع فعلياً (لا خطأ DB خامّ بعد الهجرة 0333)", async () => {
    const source = await makeGovernedReturnSource();
    const requested = await requestPurchaseReturn(
      returnRequestInput(source),
      OWNER,
    );
    expect(requested.status).toBe("APPROVED");

    const [purchaseReturn] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, Number(requested.purchaseReturnId)));
    expect(purchaseReturn).toMatchObject({
      status: "POSTED",
      settlement: "CREDIT",
    });

    const [request] = await db()
      .select()
      .from(s.purchaseReturnRequests)
      .where(eq(s.purchaseReturnRequests.id, Number(requested.requestId)));
    expect(request).toMatchObject({
      status: "APPROVED",
      requestedBy: OWNER.userId,
      reviewedBy: OWNER.userId,
    });

    return { purchaseReturnId: Number(requested.purchaseReturnId) };
  });
});

describe("حوكمة عكس مرتجع الشراء — فصل المهام على قاعدةٍ حقيقية", () => {
  /** يبني مرتجعاً معتمَداً (باعتمادٍ مستقلّ عاديّ) لتجهيز سياق اختبارات العكس. */
  async function approveFreshReturn() {
    const source = await makeGovernedReturnSource();
    const requested = await requestPurchaseReturn(
      returnRequestInput(source),
      PURCHASING,
    );
    const approved = await decidePurchaseReturn(
      {
        requestId: Number(requested.requestId),
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "راجعت المطابقة والكمية والدليل واعتمدت المرتجع",
      },
      OWNER,
    );
    expect(approved.status).toBe("APPROVED");
    const [[item], [purchaseReturn]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseReturnItems)
        .where(
          eq(
            s.purchaseReturnItems.purchaseReturnId,
            Number(approved.purchaseReturnId),
          ),
        ),
      db()
        .select()
        .from(s.purchaseReturns)
        .where(eq(s.purchaseReturns.id, Number(approved.purchaseReturnId))),
    ]);
    return {
      purchaseReturnId: Number(approved.purchaseReturnId),
      purchaseReturnItemId: Number(item.id),
      purchaseReturnVersion: Number(purchaseReturn.version),
    };
  }

  it("يرفض اعتماد طالب العكس لطلبه ذاته", async () => {
    const { purchaseReturnId, purchaseReturnItemId, purchaseReturnVersion } =
      await approveFreshReturn();
    const requested = await requestPurchaseReturnReversal(
      {
        purchaseReturnId,
        expectedReturnVersion: purchaseReturnVersion,
        requestKey: `pr-gov-reversal-request:${randomUUID()}`,
        evidenceType: "SIGNED_APPROVAL",
        evidenceReference: `reversal-evidence:${randomUUID()}`,
        reason: "عكسٌ اختباريّ لمرتجعٍ سجَّلناه بالخطأ",
        lines: [{ purchaseReturnItemId, baseQuantity: 1 }],
      },
      PURCHASING,
    );
    expect(requested.status).toBe("PENDING");

    await expect(
      decidePurchaseReturnReversal(
        {
          requestId: Number(requested.requestId),
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "محاولة اعتماد ذاتي للعكس",
        },
        PURCHASING,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [purchaseReturn] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, purchaseReturnId));
    expect(purchaseReturn.status).toBe("POSTED");
  });

  it("يعتمد المالكُ طلب عكسٍ أنشأه هو بنفسه فيُعكَس المرتجع فعلياً (لا خطأ DB خامّ بعد الهجرة 0333)", async () => {
    const { purchaseReturnId, purchaseReturnItemId, purchaseReturnVersion } =
      await approveFreshReturn();
    const requested = await requestPurchaseReturnReversal(
      {
        purchaseReturnId,
        expectedReturnVersion: purchaseReturnVersion,
        requestKey: `pr-gov-reversal-request:${randomUUID()}`,
        evidenceType: "SIGNED_APPROVAL",
        evidenceReference: `reversal-evidence:${randomUUID()}`,
        reason: "عكسٌ ذاتيّ — قرار المالك ٣/٩/٢٦",
        lines: [{ purchaseReturnItemId, baseQuantity: 1 }],
      },
      OWNER,
    );
    expect(requested.status).toBe("APPROVED");

    const [purchaseReturn] = await db()
      .select()
      .from(s.purchaseReturns)
      .where(eq(s.purchaseReturns.id, purchaseReturnId));
    expect(purchaseReturn.status).toBe("REVERSED");

    const [request] = await db()
      .select()
      .from(s.purchaseReturnReversalRequests)
      .where(
        eq(s.purchaseReturnReversalRequests.id, Number(requested.requestId)),
      );
    expect(request).toMatchObject({
      status: "APPROVED",
      requestedBy: OWNER.userId,
      reviewedBy: OWNER.userId,
    });
  });
});
