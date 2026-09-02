// الشحن/الكمرك على أمر الشراء — **قرار المالك ٥/٨/٢٦**: «الشحن يُسجَّل مصروفاً لحظة الاستلام
// وتكلفة الصنف سعر المورّد فقط؛ الشحن مصاريف علينا ولا دخل للمورّد به.»
//
// نسخت هذه الاختبارات سياسةً سابقة (رسملة الشحن في WAVG + إضافته لذمّة المورّد، #311) وأُعيدت
// كتابتها بالكامل. الثوابت الأربعة الآن:
//   (١) `purchaseOrders.total` = البضاعة + الضريبة فقط — الشحن يُخزَّن ولا يدخل الإجمالي/الذمّة.
//   (٢) WAVG بعد الاستلام = **سعر المورّد وحده** (لا حصّة شحن) ⇒ COGS عند البيع لا يحمل الشحن.
//   (٣) رصيد المورّد يرتفع بالبضاعة + الضريبة فقط، وقيد PURCHASE.cost = البضاعة.
//   (٤) الشحن يُسجَّل **صفّ مصروفٍ حقيقياً** (فئة نقل) + قيد استحقاق ADJUST لحظة الاستلام،
//       ثم إيصال وقيد PAYMENT_OUT عند اعتماد التسوية فقط، بحصّةٍ متناسبة مع المستلَم فعلاً.
// الجمع بين (٢) و(٤) محظور: لو رُسمِل الشحن **وسُجّل** مصروفاً لاحتُسِب مرّتين فينقص الربح ضعفاً.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseOrder,
  receivePurchase as receivePurchaseRaw,
} from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import {
  approveVoucher,
  createVoucher,
  rejectVoucher,
} from "../voucherService";
import { resubmitRejectedExpensePayment } from "../voucher/approval";
import { cancelExpense } from "../expenseService";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { toDateStr } from "../money";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const owner = { userId: 2, branchId: 1, role: "manager" as const };
function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function receivePurchase(
  input: Parameters<typeof receivePurchaseRaw>[0],
  currentActor: Parameters<typeof receivePurchaseRaw>[1],
) {
  return receivePurchaseRaw(
    {
      shippingBeneficiaryName: "شركة الشحن التجريبية",
      shippingEvidenceReference: `SHIP-EVIDENCE-PO-${input.purchaseOrderId}`,
      ...input,
    },
    currentActor,
  );
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "idempotencyKeys",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "accrualCorrectionRequests",
    "accrualObligationEvents",
    "accrualObligations",
    "accountingEntries",
    "expenses",
    "receipts",
    "inventoryMovements",
    "purchaseOrderItems",
    "purchaseOrders",
    "branchStock",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d
    .insert(s.branches)
    .values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" },
    {
      id: 2,
      openId: "owner-2",
      name: "مالك ثانٍ",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await d
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
  await d.insert(s.products).values([
    { id: 1, name: "ورق" },
    { id: 2, name: "حبر" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "P-2", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
}
beforeEach(async () => {
  await reset();
  await seed();
});

async function costOf(variantId: number): Promise<string> {
  const r = (
    await db()
      .select({ c: s.productVariants.costPrice })
      .from(s.productVariants)
      .where(eq(s.productVariants.id, variantId))
  )[0];
  return String(r?.c);
}
async function supplierBalance(): Promise<string> {
  const r = (
    await db()
      .select({ b: s.suppliers.currentBalance })
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1))
  )[0];
  return String(r?.b);
}
async function itemsOf(poId: number) {
  return db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, poId))
    .orderBy(s.purchaseOrderItems.id);
}
async function entries() {
  return db()
    .select()
    .from(s.accountingEntries)
    .orderBy(s.accountingEntries.id);
}
async function expenseRows() {
  return db().select().from(s.expenses).orderBy(s.expenses.id);
}

async function createApprovedPurchaseOrder(
  input: Parameters<typeof createPurchaseOrder>[0],
) {
  const created = await createPurchaseOrder(input, actor);
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "اعتماد أمر الشراء قبل اختبار الاستلام والتكلفة الهابطة",
      requestKey: `landed-submit:${randomUUID()}`,
    },
    actor,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `landed-approve:${randomUUID()}`,
      approve: true,
      reason: "راجعت المورد والكميات والأسعار واعتمدت الأمر",
    },
    owner,
  );
  return created;
}

/** أمرٌ بقيمة بضاعة ٤٬٠٠٠ وشحن+كمرك ٤٠٠ (بلا ضريبة). */
async function orderWithShipping(shipping = "300", customs = "100") {
  return createApprovedPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // 1,000
        { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" }, // 3,000
      ],
      shippingCost: shipping,
      customsCost: customs,
    },
  );
}

describe("الشحن/الكمرك — مصروفُ شركةٍ لا ذمّةُ مورّد ولا تكلفةُ صنف", () => {
  it("(١) إجمالي أمر الشراء = البضاعة + الضريبة فقط، والشحن يُخزَّن خارجه", async () => {
    const po = await orderWithShipping();
    const row = (
      await db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, po.purchaseOrderId))
    )[0];
    expect(row.subtotal).toBe("4000.00");
    expect(row.shippingCost).toBe("300.00");
    expect(row.customsCost).toBe("100.00");
    // ٤٬٠٠٠ لا ٤٬٤٠٠: المورّد لم يبِعنا الشحن، فلا يدخل ما نُطالَب به.
    expect(row.total).toBe("4000.00");
  });

  it("(٢+٣) استلام كامل: WAVG = سعر المورّد وحده، والذمّة = البضاعة، وقيد PURCHASE بلا شحن", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      actor,
    );
    // سعر المورّد: ١٠٠ و٦٠٠ — بلا أيّ حصّة شحن مُضافة (كانت ١١٠ و٦٦٠ في السياسة الملغاة).
    expect(await costOf(1)).toBe("100.00");
    expect(await costOf(2)).toBe("600.00");
    expect(await supplierBalance()).toBe("4000.00");
    const purchase = (await entries()).filter(
      (e) => e.entryType === "PURCHASE",
    );
    expect(purchase).toHaveLength(1);
    expect(purchase[0].cost).toBe("4000.00");
    expect(purchase[0].amount).toBe("4000.00");
  });

  it("(٤) الاستلام يُثبت مصروف النقل والتزامه، والاعتماد وحده يُخرج النقد", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const receiveInput = {
      purchaseOrderId: po.purchaseOrderId,
      lines: items.map((i) => ({
        purchaseOrderItemId: Number(i.id),
        receivedBaseQuantity: i.baseQuantity,
      })),
      clientRequestId: "shipping-pending-replay",
    };
    const received = await receivePurchase(receiveInput, actor);
    expect(received.shippingPaymentRequestReceiptId).not.toBeNull();
    const replayed = await receivePurchase(receiveInput, actor);
    expect(replayed.shippingPaymentRequestReceiptId).toBe(
      received.shippingPaymentRequestReceiptId,
    );
    const pending = (
      await db()
        .select()
        .from(s.receipts)
        .where(
          eq(s.receipts.id, Number(received.shippingPaymentRequestReceiptId)),
        )
    )[0];
    expect(pending).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });
    const recognizedExpenses = await expenseRows();
    expect(recognizedExpenses).toHaveLength(1);
    expect(recognizedExpenses[0]).toMatchObject({
      category: "TRANSPORT",
      amount: "400.00",
      paymentMethod: "ACCRUAL",
      source: "ACCRUAL",
      cashBucket: null,
      status: "ACTIVE",
      receiptId: null,
    });
    const recognizedEntries = (await entries()).filter(
      (e) => e.entryType === "ADJUST",
    );
    expect(recognizedEntries).toHaveLength(1);
    expect(recognizedEntries[0]).toMatchObject({
      amount: "400.00",
      receiptId: null,
      supplierId: null,
    });
    expect(recognizedEntries[0].dedupeKey).toMatch(
      /^PURCHASE_SHIPPING_ACCRUAL:/,
    );
    expect(
      (await entries()).filter((e) => e.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    await approveVoucher(
      Number(received.shippingPaymentRequestReceiptId),
      owner,
    );
    const exps = await expenseRows();
    expect(exps).toHaveLength(1);
    expect(exps[0].category).toBe("TRANSPORT");
    expect(exps[0].amount).toBe("400.00"); // ٣٠٠ شحن + ١٠٠ كمرك
    expect(exps[0].status).toBe("ACTIVE");
    expect(exps[0].receiptId).toBeNull();

    const payOut = (await entries()).filter(
      (e) => e.entryType === "PAYMENT_OUT",
    );
    expect(payOut).toHaveLength(1);
    expect(payOut[0].amount).toBe("400.00");
    expect(payOut[0].receiptId).toBe(Number(pending.id));
    // المصروف **ليس** على المورّد: القيد بلا supplierId فلا يظهر حركةً في كشف حسابه.
    expect(payOut[0].supplierId).toBeNull();
    // وإيصال صرفٍ فعليّ خرج به النقد.
    const rcpts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(rcpts).toHaveLength(1);
    expect(rcpts[0].direction).toBe("OUT");
    expect(rcpts[0].amount).toBe("400.00");
  });

  it("الشحن غير النقدي يبقى التزاماً بلا أثر خزينة حتى الاعتماد، ثم يُسوّى على أداة الدفع الفعلية", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const treasuryBefore = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );

    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
        shippingPaymentMethod: "CARD",
        shippingCardLastFour: "4242",
        clientRequestId: "shipping-card-accrual",
      },
      actor,
    );
    const requestId = Number(received.shippingPaymentRequestReceiptId);
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, requestId));
    const [recognizedExpense] = await expenseRows();
    expect(pending).toMatchObject({
      paymentMethod: "CARD",
      cardLastFour: "4242",
      cashBucket: null,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });
    expect(
      JSON.parse(
        String(pending.internalNote).replace("@SYSTEM_PAYMENT_REQUEST:", ""),
      ),
    ).toMatchObject({
      kind: "PURCHASE_SHIPPING",
      paymentReference: "4242",
    });
    expect(recognizedExpense).toMatchObject({
      paymentMethod: "ACCRUAL",
      source: "ACCRUAL",
      cashBucket: null,
      receiptId: null,
      status: "ACTIVE",
    });
    expect(
      (await entries()).filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    expect(
      await db().transaction(async (tx) =>
        (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
      ),
    ).toBe(treasuryBefore);

    await approveVoucher(requestId, owner);

    const [approved] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, requestId));
    expect(approved).toMatchObject({
      paymentMethod: "CARD",
      cashBucket: null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const settlements = (await entries()).filter(
      (entry) => entry.entryType === "PAYMENT_OUT",
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0].receiptId).toBe(requestId);
    expect([null, "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT"]).toContain(
      settlements[0].postingProfile,
    );
    expect(
      await db().transaction(async (tx) =>
        (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
      ),
    ).toBe(treasuryBefore);

    const entriesBeforeCancel = await entries();
    const receiptsBeforeCancel = await db().select().from(s.receipts);
    await expect(
      cancelExpense(Number(recognizedExpense.id), actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await entries()).toEqual(entriesBeforeCancel);
    expect(await db().select().from(s.receipts)).toEqual(receiptsBeforeCancel);
    expect(
      await db().transaction(async (tx) =>
        (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
      ),
    ).toBe(treasuryBefore);
  });

  it("رفض تسوية شحن غير نقدية وإعادة تقديمها يحفظان الأداة ودليلها ولا يكرران الاعتراف", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
        shippingPaymentMethod: "CARD",
        shippingCardLastFour: "7788",
        clientRequestId: "shipping-card-resubmit",
      },
      actor,
    );
    const rejectedId = Number(received.shippingPaymentRequestReceiptId);
    await rejectVoucher(rejectedId, owner, "تدقيق مستند البطاقة");

    const replacement = await resubmitRejectedExpensePayment(
      rejectedId,
      actor,
      {
        note: "أُعيد فحص دليل البطاقة",
        priorReceiptId: rejectedId,
        reissueReason: "أُرفق دليل البطاقة الصحيح",
      },
    );
    const [replacementReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, replacement.receiptId));
    expect(replacementReceipt).toMatchObject({
      paymentMethod: "CARD",
      cardLastFour: "7788",
      cashBucket: null,
      shiftId: null,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });
    const [expense] = await expenseRows();
    expect(expense).toMatchObject({
      paymentMethod: "ACCRUAL",
      source: "ACCRUAL",
      receiptId: null,
    });
    expect(
      (await entries()).filter((entry) => entry.entryType === "ADJUST"),
    ).toHaveLength(1);
    expect(
      (await entries()).filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);

    await approveVoucher(replacement.receiptId, owner);
    expect(
      (await entries()).filter((entry) => entry.entryType === "ADJUST"),
    ).toHaveLength(1);
    expect(
      (await entries()).filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(1);
  });

  it("الاستلام الجزئيّ: المصروف متناسب، وΣ عبر الاستلامات = الشحن بالضبط", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    // الدفعة الأولى: نصف كمية البند الأول فقط.
    const received1 = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          { purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: 5 },
        ],
      },
      actor,
    );
    await approveVoucher(
      Number(received1.shippingPaymentRequestReceiptId),
      owner,
    );
    const first = await expenseRows();
    expect(first).toHaveLength(1);
    // حصّة البند الأول من الشحن = ٤٠٠ × (1000/4000) = ١٠٠، ونصفها = ٥٠.
    expect(first[0].amount).toBe("50.00");
    expect(await supplierBalance()).toBe("500.00"); // بضاعة الدفعة وحدها

    // بقيّة الكميات.
    const received2 = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          { purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: 5 },
          {
            purchaseOrderItemId: Number(items[1].id),
            receivedBaseQuantity: items[1].baseQuantity,
          },
        ],
      },
      actor,
    );
    const [request1] = await db()
      .select()
      .from(s.receipts)
      .where(
        eq(s.receipts.id, Number(received1.shippingPaymentRequestReceiptId)),
      );
    const [request2] = await db()
      .select()
      .from(s.receipts)
      .where(
        eq(s.receipts.id, Number(received2.shippingPaymentRequestReceiptId)),
      );
    expect(request1.referenceNumber).not.toBe(request2.referenceNumber);
    expect(request1.referenceNumber).toMatch(/^SHIP-.+-[0-9a-f]{16}$/i);
    expect(request2.referenceNumber).toMatch(/^SHIP-.+-[0-9a-f]{16}$/i);
    await approveVoucher(
      Number(received2.shippingPaymentRequestReceiptId),
      owner,
    );
    const all = await expenseRows();
    const sum = all.reduce((a, e) => a + Number(e.amount), 0);
    expect(sum).toBeCloseTo(400, 2); // لا انجراف تقريب
    expect(await supplierBalance()).toBe("4000.00");
    expect(await costOf(1)).toBe("100.00"); // ما زال سعر المورّد وحده
  });

  it("اعتراف شهر A يبقى في شهره، وتسوية الاعتماد تُؤرَّخ في شهر B الفعلي", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
      },
      actor,
    );
    const requestId = Number(received.shippingPaymentRequestReceiptId);
    const monthA = "2020-01-15";
    await db()
      .update(s.accountingEntries)
      .set({ entryDate: new Date(`${monthA}T12:00:00Z`) })
      .where(
        sql`${s.accountingEntries.dedupeKey} LIKE 'PURCHASE_SHIPPING_ACCRUAL:%'`,
      );
    await db()
      .update(s.receipts)
      .set({ voucherDate: monthA })
      .where(eq(s.receipts.id, requestId));

    await approveVoucher(requestId, owner);

    const rows = await entries();
    const recognition = rows.find((entry) =>
      entry.dedupeKey?.startsWith("PURCHASE_SHIPPING_ACCRUAL:"),
    );
    const settlement = rows.find(
      (entry) =>
        entry.entryType === "PAYMENT_OUT" && entry.receiptId === requestId,
    );
    expect(toDateStr(new Date(recognition!.entryDate))).toBe(monthA);
    expect(toDateStr(new Date(settlement!.entryDate))).toBe(toDateStr());
    expect(Number(recognition!.amount) - Number(settlement!.amount)).toBe(0);
  });

  it("أمرٌ بلا شحن ⇒ لا مصروف ولا إيصال (حارس انحدار)", async () => {
    const po = await createApprovedPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
    );
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            purchaseOrderItemId: Number(items[0].id),
            receivedBaseQuantity: items[0].baseQuantity,
          },
        ],
      },
      actor,
    );
    expect(await expenseRows()).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(0);
    expect(await costOf(1)).toBe("100.00");
    expect(await supplierBalance()).toBe("1000.00");
  });

  it("دفعة المورد النقدية تبقى طلباً بلا أثر حتى مالك آخر، ثم تُعتمد مرة واحدة وتعيد القراءة من PO", async () => {
    const po = await createApprovedPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
    );
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            purchaseOrderItemId: Number(items[0].id),
            receivedBaseQuantity: items[0].baseQuantity,
          },
        ],
        payment: { amount: "400.00", method: "CASH" },
        clientRequestId: "purchase-supplier-pending",
      },
      actor,
    );
    const requestId = Number(received.supplierPaymentRequestReceiptId);
    expect(requestId).toBeGreaterThan(0);
    expect(await supplierBalance()).toBe("1000.00");
    let [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));
    expect(order.paidAmount).toBe("0.00");
    expect(
      (await entries()).filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, requestId));
    expect(pending).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });

    const approved = await approveVoucher(requestId, owner);
    const replay = await approveVoucher(requestId, owner);
    expect(approved.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(await supplierBalance()).toBe("600.00");
    [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));
    expect(order.paidAmount).toBe("400.00");
    expect(
      (await entries()).filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(1);
  });

  it("تغيّر مصدر طلب دفعة المورد قبل الاعتماد يفشل مغلقاً ويرجع كل أثر الاعتماد", async () => {
    const po = await createApprovedPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
    );
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            purchaseOrderItemId: Number(items[0].id),
            receivedBaseQuantity: items[0].baseQuantity,
          },
        ],
        payment: { amount: "400.00", method: "CASH" },
        clientRequestId: "purchase-supplier-source-change",
      },
      actor,
    );
    const requestId = Number(received.supplierPaymentRequestReceiptId);
    await db()
      .update(s.purchaseOrders)
      .set({ total: "300.00" })
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));
    await expect(approveVoucher(requestId, owner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, requestId));
    expect(pending).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });
    expect(await supplierBalance()).toBe("1000.00");
    const [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));
    expect(order.paidAmount).toBe("0.00");
    expect(
      (await entries()).filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
  });

  it("نقص الخزينة عند اعتماد الشحن ⇒ يبقى الاستلام وAP والطلب معلّقاً بلا أثر دفع جزئي", async () => {
    await db()
      .delete(s.receipts)
      .where(eq(s.receipts.referenceNumber, "TEST-TREASURY-FUND"));
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);

    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
      },
      actor,
    );
    await expect(
      approveVoucher(Number(received.shippingPaymentRequestReceiptId), owner),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await costOf(1)).toBe("100.00");
    expect(await costOf(2)).toBe("600.00");
    expect(await supplierBalance()).toBe("4000.00");
    expect(await expenseRows()).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(2);
    expect(
      (await entries()).filter((e) => e.entryType === "PURCHASE"),
    ).toHaveLength(1);
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(
        eq(s.receipts.id, Number(received.shippingPaymentRequestReceiptId)),
      );
    expect(pending).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });
    expect(
      (await entries()).filter((e) => e.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    expect(
      (await entries()).filter((e) => e.entryType === "ADJUST"),
    ).toHaveLength(1);
  });

  it("رفض دفع الشحن لا يعيد طلباً تلقائياً؛ إعادة التقديم الصريحة ثم الاعتماد لا تكرر المصروف أو القيد", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
        clientRequestId: "shipping-reject-resubmit",
      },
      actor,
    );
    const rejectedId = Number(received.shippingPaymentRequestReceiptId);

    await rejectVoucher(rejectedId, owner, "مرجع شركة النقل غير واضح");
    const afterReject = await db().select().from(s.receipts);
    expect(
      afterReject.filter((row) => row.approvalStatus === "PENDING_APPROVAL"),
    ).toHaveLength(0);
    expect(
      afterReject.find((row) => Number(row.id) === rejectedId),
    ).toMatchObject({ status: "FAILED", approvalStatus: "REJECTED" });
    expect(await expenseRows()).toHaveLength(1);
    expect(
      (await entries()).filter((row) => row.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    expect(
      (await entries()).filter((row) => row.entryType === "ADJUST"),
    ).toHaveLength(1);

    const replacement = await resubmitRejectedExpensePayment(
      rejectedId,
      actor,
      {
        note: "صُحّح مرجع الناقل",
        priorReceiptId: rejectedId,
        reissueReason: "صُحّح مرجع شركة النقل",
      },
    );
    expect(replacement).toMatchObject({
      rootReceiptId: rejectedId,
      attempt: 1,
      priorReceiptId: rejectedId,
      replayed: false,
    });
    expect(replacement.receiptId).not.toBe(rejectedId);
    const pendingReplay = await resubmitRejectedExpensePayment(
      rejectedId,
      actor,
      {
        note: "صُحّح مرجع الناقل",
        priorReceiptId: rejectedId,
        reissueReason: "صُحّح مرجع شركة النقل",
      },
    );
    expect(pendingReplay).toMatchObject({
      receiptId: replacement.receiptId,
      attempt: 1,
      replayed: true,
    });
    const beforeApproval = await db().select().from(s.receipts);
    expect(
      beforeApproval.filter((row) => row.approvalStatus === "PENDING_APPROVAL"),
    ).toHaveLength(1);
    expect(await expenseRows()).toHaveLength(1);
    expect(
      (await entries()).filter((row) => row.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
    expect(
      (await entries()).filter((row) => row.entryType === "ADJUST"),
    ).toHaveLength(1);

    await approveVoucher(replacement.receiptId, owner);
    await approveVoucher(replacement.receiptId, owner); // retry idempotent
    const approvedReplay = await resubmitRejectedExpensePayment(
      rejectedId,
      actor,
      {
        note: "صُحّح مرجع الناقل",
        priorReceiptId: rejectedId,
        reissueReason: "صُحّح مرجع شركة النقل",
      },
    );
    expect(approvedReplay).toMatchObject({
      receiptId: replacement.receiptId,
      approvalStatus: "APPROVED",
      replayed: true,
    });
    expect(await expenseRows()).toHaveLength(1);
    expect(
      (await entries()).filter((row) => row.entryType === "PAYMENT_OUT"),
    ).toHaveLength(1);
    expect(
      (await entries()).filter((row) => row.entryType === "ADJUST"),
    ).toHaveLength(1);
    const materialCashOut = (await db().select().from(s.receipts)).filter(
      (row) =>
        row.direction === "OUT" &&
        row.cashBucket === "TREASURY" &&
        row.approvalStatus === "APPROVED",
    );
    expect(materialCashOut).toHaveLength(1);
  });

  it("يحفظ سلسلة A<n> بلا طمس ويمنع metadata المعبث بها ويعيد سباق root/A1 بلا deadlock", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
        shippingPaymentMethod: "TRANSFER",
        shippingPaymentReference: "TRX-LINEAGE-001",
        clientRequestId: "shipping-lineage-race",
      },
      actor,
    );
    const rootReceiptId = Number(received.shippingPaymentRequestReceiptId);
    await rejectVoucher(
      rootReceiptId,
      owner,
      "مرجع الناقل الأول يحتاج تصحيحاً",
    );

    const firstInput = {
      note: "فاتورة الناقل المصححة الأولى",
      priorReceiptId: rootReceiptId,
      reissueReason: "تصحيح مرجع الناقل الأول",
    };
    const first = await resubmitRejectedExpensePayment(
      rootReceiptId,
      actor,
      firstInput,
    );
    expect(first).toMatchObject({
      rootReceiptId,
      attempt: 1,
      priorReceiptId: rootReceiptId,
      replayed: false,
    });
    await rejectVoucher(first.receiptId, owner, "المرفق الأول ما زال غير واضح");

    const [firstReceipt] = await db()
      .select({ description: s.receipts.description })
      .from(s.receipts)
      .where(eq(s.receipts.id, first.receiptId));
    await db()
      .update(s.receipts)
      .set({ description: "وصف عُبث به وفقد رابط المحاولة السابقة" })
      .where(eq(s.receipts.id, first.receiptId));
    await expect(
      resubmitRejectedExpensePayment(first.receiptId, actor, {
        note: "فاتورة الناقل المصححة الثانية",
        priorReceiptId: first.receiptId,
        reissueReason: "تصحيح مرجع الناقل الثاني",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db()
        .select()
        .from(s.idempotencyKeys)
        .where(
          eq(
            s.idempotencyKeys.clientRequestId,
            `system-expense-resubmit-${rootReceiptId}-A2`,
          ),
        ),
    ).toHaveLength(0);
    await db()
      .update(s.receipts)
      .set({ description: firstReceipt.description })
      .where(eq(s.receipts.id, first.receiptId));

    const outcomes = await Promise.allSettled([
      resubmitRejectedExpensePayment(rootReceiptId, actor, firstInput),
      resubmitRejectedExpensePayment(first.receiptId, actor, {
        note: "فاتورة الناقل المصححة الثانية",
        priorReceiptId: first.receiptId,
        reissueReason: "تصحيح مرجع الناقل الثاني",
      }),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(String(outcome.reason)).not.toMatch(
          /ER_LOCK_DEADLOCK|deadlock/i,
        );
      }
    }
    if (outcomes[1].status === "rejected") throw outcomes[1].reason;
    expect(outcomes[1]).toMatchObject({ status: "fulfilled" });
    const second =
      outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
    expect(second).toMatchObject({
      rootReceiptId,
      attempt: 2,
      priorReceiptId: first.receiptId,
      replayed: false,
    });
    expect(
      await db()
        .select()
        .from(s.idempotencyKeys)
        .where(
          sql`${s.idempotencyKeys.clientRequestId} LIKE ${`system-expense-resubmit-${rootReceiptId}-A%`}`,
        ),
    ).toHaveLength(2);

    await rejectVoucher(
      Number(second?.receiptId),
      owner,
      "المرفق الثاني يحتاج مراجعة مستقلة",
    );
    await db()
      .update(s.receipts)
      .set({ description: "محاولة ثانية بلا وصف lineage موثوق" })
      .where(eq(s.receipts.id, Number(second?.receiptId)));
    await expect(
      resubmitRejectedExpensePayment(Number(second?.receiptId), actor, {
        note: "فاتورة ناقل ثالثة",
        priorReceiptId: Number(second?.receiptId),
        reissueReason: "إصدار محاولة ثالثة بعد التصحيح",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await db()
        .select()
        .from(s.idempotencyKeys)
        .where(
          eq(
            s.idempotencyKeys.clientRequestId,
            `system-expense-resubmit-${rootReceiptId}-A3`,
          ),
        ),
    ).toHaveLength(0);
  });

  it("الإلغاء العام لمصروف شحن مستحق يفشل مغلقاً بلا أي أثر مالي", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const received = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((item) => ({
          purchaseOrderItemId: Number(item.id),
          receivedBaseQuantity: item.baseQuantity,
        })),
        clientRequestId: "shipping-cancel-before-payment",
      },
      actor,
    );
    const requestId = Number(received.shippingPaymentRequestReceiptId);
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    const [expense] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    const before = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );
    const receiptsBefore = await db().select().from(s.receipts);
    const entriesBefore = await entries();

    await expect(
      cancelExpense(Number(expense.id), actor),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const after = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );
    expect(after).toBe(before);
    expect(
      (
        await db()
          .select()
          .from(s.expenses)
          .where(eq(s.expenses.id, Number(expense.id)))
      )[0].status,
    ).toBe("ACTIVE");
    expect(
      (
        await db().select().from(s.receipts).where(eq(s.receipts.id, requestId))
      )[0],
    ).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });
    expect(
      (
        await db()
          .select()
          .from(s.accrualObligations)
          .where(eq(s.accrualObligations.id, Number(obligation.id)))
      )[0].status,
    ).toBe("PAYMENT_PENDING");
    expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
    expect(await entries()).toEqual(entriesBefore);
  });

  it("استلام نقدي واعتماد سند للمورد نفسه يتسلسلان بلا deadlock", async () => {
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "5000.00" })
      .where(eq(s.suppliers.id, 1));
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);
    const voucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "100.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "دفعة متزامنة مع الاستلام",
        clientRequestId: "purchase-voucher-lock-order",
      },
      actor,
    );
    const results = await Promise.allSettled([
      receivePurchase(
        {
          purchaseOrderId: po.purchaseOrderId,
          lines: items.map((item) => ({
            purchaseOrderItemId: Number(item.id),
            receivedBaseQuantity: item.baseQuantity,
          })),
        },
        actor,
      ),
      approveVoucher(voucher.receiptId, {
        userId: 2,
        branchId: 1,
        role: "manager",
      }),
    ]);

    expect(
      results.flatMap((result) =>
        result.status === "rejected"
          ? [String(result.reason?.message ?? result.reason)]
          : [],
      ),
    ).toEqual([]);
    expect(await supplierBalance()).toBe("8900.00"); // 5000 + 4000 purchase − 100 payment
    const approved = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, voucher.receiptId))
    )[0];
    expect(approved).toMatchObject({
      approvalStatus: "APPROVED",
      cashBucket: "TREASURY",
      shiftId: null,
    });
  });

  it("حارس: شحن سالب ⇒ BAD_REQUEST", async () => {
    await expect(orderWithShipping("-1", "0")).rejects.toThrow(/سالب/);
  });
});
