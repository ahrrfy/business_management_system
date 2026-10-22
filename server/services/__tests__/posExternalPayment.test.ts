import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPrintSale } from "../printSaleService";
import {
  confirmExternalPaymentAttempt,
  createConfirmedPosSale,
  initiateExternalPaymentAttempt,
} from "../posExternalPayment";
import { returnSale } from "../returnService";
import { processPayment } from "../saleService";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { truncateTables } from "./__testUtils__";

const cashier = { userId: 1, branchId: 1, role: "cashier" } as const;
const owner = { userId: 2, branchId: 1, role: "admin" } as const;
const EXTERNAL_METHODS = ["CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"] as const;
/** الطرق المرفوضة بنيوياً: رصيد زين (مساره البطاقات الرقمية) والصكوك (قرار مالك ٢٢/٧). */
const REJECTED_METHODS = ["TELECOM", "CHECK"] as const;
const TABLES = [
  "externalPaymentAttempts",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "productionRecipeLines", "productionRecipes", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users", "idempotencyKeys",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "pos-failclosed-cashier", name: "Cashier", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "pos-failclosed-owner", name: "Owner", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "Stock item" },
    { id: 2, name: "Print service", productType: "PRINT_SERVICE", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "STOCK-FAILCLOSED", costPrice: "10.00" },
    { id: 2, productId: 2, sku: "PRINT-FAILCLOSED", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "piece", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "service", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "100.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "250.00" },
  ]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
  await d.insert(s.shifts).values([
    { id: 1, branchId: 1, userId: 1, shiftType: "RETAIL", openingBalance: "1000", status: "OPEN", openGuard: "1:1:RETAIL" },
    { id: 2, branchId: 1, userId: 1, shiftType: "PRINT_SERVICES", openingBalance: "1000", status: "OPEN", openGuard: "1:1:PRINT_SERVICES" },
  ]);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;

const stockSale = (method: (typeof EXTERNAL_METHODS)[number] | "CASH", requireExternalPaymentAttempt = true) =>
  createConfirmedPosSale({
    branchId: 1,
    shiftId: 1,
    deviceId: "TEST-POS-DEVICE",
    sourceType: "POS",
    clientRequestId: unique("SALE"),
    requireExternalPaymentAttempt,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
    payment: { amount: "100.00", method },
  }, cashier);

const printSale = (method: (typeof EXTERNAL_METHODS)[number] | "CASH") =>
  createPrintSale({
    branchId: 1,
    shiftId: 2,
    deviceId: "TEST-PRINT-DEVICE",
    clientRequestId: unique("PRINT"),
    requireExternalPaymentAttempt: true,
    lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
    payment: { amount: "250.00", method },
  }, cashier);

async function expectNoBusinessEffects() {
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
  expect(Number(stock.quantity)).toBe(10);
}

/**
 * العقد: الدفع غير النقدي مسموحٌ لكن **لا يُثبَّت أثرٌ ماليّ بلا محاولةٍ مؤكَّدة**.
 * فما يُرفض هنا هو البيع بلا محاولة، والمحاولة الملفَّقة، ورصيد زين — لا الطريقة نفسها.
 */
describe("بوّابة الدفع الخارجي: محاولةٌ مؤكَّدة أو لا أثر", () => {
  it.each(REJECTED_METHODS)("الطريقة المرفوضة بنيوياً %s تُردّ قبل أيّ أثر في القاعدة", async (method) => {
    await expect(initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: method as any,
      amount: "100.00",
      reference: unique("REF"),
      requestId: unique("REQ"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier)).rejects.toThrow();

    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
    await expectNoBusinessEffects();
  });

  it("محاولةٌ لا تخصّ الكاشير/الجهاز لا تُؤكَّد ولا تتحوّل حالتها", async () => {
    const legacyReference = unique("LEGACY-REF").toUpperCase();
    await db().insert(s.externalPaymentAttempts).values({
      branchId: 1,
      channel: "POS",
      paymentMethod: "CARD",
      amount: "100.00",
      providerCode: "LEGACY",
      accountReference: "LEGACY",
      deviceId: "TEST-POS-DEVICE",
      externalReference: legacyReference,
      normalizedReference: legacyReference,
      state: "INITIATED",
      requestId: unique("LEGACY-REQ"),
      createdBy: 1,
    });
    const row = (await db().select().from(s.externalPaymentAttempts))[0];

    // كاشيرٌ آخر لا يؤكّد محاولة غيره، وجهازٌ آخر لا يؤكّد محاولة جهازٍ سواه.
    await expect(confirmExternalPaymentAttempt({
      attemptId: Number(row.id), branchId: 1, channel: "POS", deviceId: "TEST-POS-DEVICE",
    }, owner)).rejects.toThrow();
    await expect(confirmExternalPaymentAttempt({
      attemptId: Number(row.id), branchId: 1, channel: "POS", deviceId: "ANOTHER-DEVICE",
    }, cashier)).rejects.toThrow();
    // وقناةٌ أخرى (المطبعة) لا تستهلك محاولة الكاشير.
    await expect(confirmExternalPaymentAttempt({
      attemptId: Number(row.id), branchId: 1, channel: "PRINT_POS", deviceId: "TEST-POS-DEVICE",
    }, cashier)).rejects.toThrow();

    const unchanged = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, row.id)))[0];
    expect(unchanged.state).toBe("INITIATED");
    expect(unchanged.confirmedBy).toBeNull();
    await expectNoBusinessEffects();
  });

  it.each(EXTERNAL_METHODS)("بيع %s بلا محاولة مؤكَّدة: صفر فاتورة/إيصال/قيد/مخزون", async (method) => {
    await expect(stockSale(method)).rejects.toThrow();
    await expectNoBusinessEffects();
  });

  it("إسقاط علامة الراوتر لا يفتح باباً خلفياً — الخدمة تفرض المحاولة بنفسها", async () => {
    await expect(stockSale("CARD", false)).rejects.toThrow();
    await expectNoBusinessEffects();
  });

  it.each(EXTERNAL_METHODS)("بيع المطبعة بـ%s بلا محاولة مؤكَّدة: صفر أثر", async (method) => {
    await expect(printSale(method)).rejects.toThrow();
    await expectNoBusinessEffects();
  });

  it("النقد يبقى عاملاً في الكاشير والمطبعة بإيصالات درجٍ فقط", async () => {
    await stockSale("CASH");
    await printSale("CASH");

    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(2);
    expect(receipts.every((row) => row.paymentMethod === "CASH" && row.cashBucket === "DRAWER" && row.referenceNumber == null)).toBe(true);
    const paymentEntries = (await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "PAYMENT_IN");
    expect(paymentEntries).toHaveLength(2);
  });

  it("الدفع المقسّم (نقدي + بطاقة بمحاولة مؤكَّدة) يُنشئ فاتورة MIXED وإيصالين وقيدَي قبض ويربط المحاولة بإيصال البطاقة", async () => {
    const cardRef = unique("CARD-SPLIT-REF");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "60.00",
      reference: cardRef,
      requestId: unique("REQ-SPLIT"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    const res = await createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("SPLIT-SALE"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "45.00" },
        { method: "CARD", amount: "60.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier);

    expect(res.total).toBe("100.00");
    expect(res.status).toBe("PAID");
    const inv = (await db().select().from(s.invoices))[0];
    expect(inv.paymentMethod).toBe("MIXED");
    expect(inv.paidAmount).toBe("100.00");
    expect(inv.status).toBe("PAID");

    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(2);
    const cashReceipt = receipts.find((r) => r.paymentMethod === "CASH")!;
    const cardReceipt = receipts.find((r) => r.paymentMethod === "CARD")!;
    expect(cashReceipt.amount).toBe("40.00");
    expect(cashReceipt.cashBucket).toBe("DRAWER");
    expect(cardReceipt.amount).toBe("60.00");
    expect(cardReceipt.cashBucket).toBeNull();
    expect(cardReceipt.referenceNumber).toBe(cardRef.toUpperCase());

    const attemptRow = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, initiated.attemptId)))[0];
    expect(Number(attemptRow.receiptId)).toBe(Number(cardReceipt.id));

    const paymentEntries = (await db().select().from(s.accountingEntries)).filter((row) => row.entryType === "PAYMENT_IN");
    expect(paymentEntries).toHaveLength(2);
  });

  it("الدفع المقسّم يرفض إعادة استخدام نفس المحاولة المؤكَّدة لدفعتين أو تجاوز غير النقدي لإجمالي الفاتورة", async () => {
    const cardRef = unique("CARD-DUP-REF");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "50.00",
      reference: cardRef,
      requestId: unique("REQ-DUP"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    await expect(createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("DUP-ATTEMPT-SALE"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "CARD", amount: "50.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
        { method: "CARD", amount: "50.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier)).rejects.toThrow();

    await expect(createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("OVERPAY-NONCASH-SALE"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "10.00" },
        { method: "CARD", amount: "110.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier)).rejects.toThrow();

    await expectNoBusinessEffects();
  });

  it("الدفع المقسّم بدفعتين غير نقديتين (بطاقة + تحويل) يربط كل محاولة بسندها ويقبل الإعادة بنفس المفتاح", async () => {
    const cardRef = unique("CARD-2NC");
    const transferRef = unique("XFER-2NC");
    const cardInit = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "60.00",
      reference: cardRef,
      requestId: unique("REQ-2NC-CARD"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    const xferInit = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "TRANSFER",
      amount: "40.00",
      reference: transferRef,
      requestId: unique("REQ-2NC-XFER"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: cardInit.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: xferInit.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    const clientReqId = unique("SPLIT-2NC-SALE");
    const payload = {
      branchId: 1,
      shiftId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS" as const,
      clientRequestId: clientReqId,
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "TRANSFER" as const, amount: "40.00", reference: transferRef, externalPaymentAttemptId: xferInit.attemptId },
        { method: "CARD" as const, amount: "60.00", reference: cardRef, externalPaymentAttemptId: cardInit.attemptId },
      ],
    };

    const first = await createConfirmedPosSale(payload, cashier);
    const replayed = await createConfirmedPosSale(payload, cashier);
    expect(replayed.invoiceId).toBe(first.invoiceId);
    expect(replayed.idempotentReplay).toBe(true);

    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(2);
    expect(first.createdReceiptIds).toEqual(receipts.map((r) => Number(r.id)));
    expect(first.createdReceiptId).toBe(Number(receipts[0].id));
    expect(replayed.createdReceiptIds).toEqual(first.createdReceiptIds);
    expect(replayed.createdReceiptId).toBe(first.createdReceiptId);
    const cardReceipt = receipts.find((r) => r.paymentMethod === "CARD")!;
    const xferReceipt = receipts.find((r) => r.paymentMethod === "TRANSFER")!;
    const cardAttempt = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, cardInit.attemptId)))[0];
    const xferAttempt = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, xferInit.attemptId)))[0];
    expect(Number(cardAttempt.receiptId)).toBe(Number(cardReceipt.id));
    expect(Number(xferAttempt.receiptId)).toBe(Number(xferReceipt.id));
  });

  it("الدفع المقسّم المحتوي على شِقّ نقدي يفرض وجود وردية مفتوحة ويمنع التسجيل على وردية مستخدم آخر (SHIFT-OWN)", async () => {
    const cardRef = unique("SHIFT-GUARD-CARD");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "60.00",
      reference: cardRef,
      requestId: unique("REQ-SHIFT-GUARD"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    // ١) بيع مقسّم يحتوي شِقّاً نقدياً بلا وردية يُرفض بـ PRECONDITION_FAILED
    await expect(createConfirmedPosSale({
      branchId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("NO-SHIFT-SPLIT"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "40.00" },
        { method: "CARD", amount: "60.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier)).rejects.toThrow(/يَلزم وردية مفتوحة للبيع النقدي/);

    // ٢) مدير يحاول تسجيل بيع مقسّم فيه شِقّ نقدي على وردية الكاشير يُرفض بـ SHIFT-OWN
    const ownerCardRef = unique("SHIFT-GUARD-OWNER-CARD");
    const ownerInit = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "60.00",
      reference: ownerCardRef,
      requestId: unique("REQ-SHIFT-GUARD-OWNER"),
      deviceId: "TEST-POS-DEVICE",
    }, owner);
    await confirmExternalPaymentAttempt({
      attemptId: ownerInit.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, owner);

    await expect(createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("OTHER-SHIFT-SPLIT"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "40.00" },
        { method: "CARD", amount: "60.00", reference: ownerCardRef, externalPaymentAttemptId: ownerInit.attemptId },
      ],
    }, owner)).rejects.toThrow(/لا تَستطيع التسجيل على وردية مستخدم آخر/);

    // ٣) نفس الحارس في نقطة بيع المطبعة (createPrintSale)
    const printRef = unique("PRINT-SHIFT-GUARD");
    const printInit = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "PRINT_POS",
      method: "WALLET",
      amount: "150.00",
      reference: printRef,
      requestId: unique("REQ-PRINT-SHIFT-GUARD"),
      deviceId: "TEST-PRINT-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: printInit.attemptId,
      branchId: 1,
      channel: "PRINT_POS",
      deviceId: "TEST-PRINT-DEVICE",
    }, cashier);

    await expect(createPrintSale({
      branchId: 1,
      deviceId: "TEST-PRINT-DEVICE",
      clientRequestId: unique("PRINT-NO-SHIFT-SPLIT"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "100.00" },
        { method: "WALLET", amount: "150.00", reference: printRef, externalPaymentAttemptId: printInit.attemptId },
      ],
    }, cashier)).rejects.toThrow(/يَلزم وردية مفتوحة للبيع النقدي/);

    const ownerPrintRef = unique("PRINT-SHIFT-GUARD-OWNER");
    const ownerPrintInit = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "PRINT_POS",
      method: "WALLET",
      amount: "150.00",
      reference: ownerPrintRef,
      requestId: unique("REQ-PRINT-SHIFT-GUARD-OWNER"),
      deviceId: "TEST-PRINT-DEVICE",
    }, owner);
    await confirmExternalPaymentAttempt({
      attemptId: ownerPrintInit.attemptId,
      branchId: 1,
      channel: "PRINT_POS",
      deviceId: "TEST-PRINT-DEVICE",
    }, owner);

    await expect(createPrintSale({
      branchId: 1,
      shiftId: 2,
      deviceId: "TEST-PRINT-DEVICE",
      clientRequestId: unique("PRINT-OTHER-SHIFT-SPLIT"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "100.00" },
        { method: "WALLET", amount: "150.00", reference: ownerPrintRef, externalPaymentAttemptId: ownerPrintInit.attemptId },
      ],
    }, owner)).rejects.toThrow(/لا تَستطيع التسجيل على وردية مستخدم آخر/);

    await expectNoBusinessEffects();
  });

  it("بيع المطبعة بالدفع المقسّم (نقدي + محفظة بمحاولة مؤكَّدة) يُنشئ فاتورة MIXED وإيصالين ويربط المحاولة", async () => {
    const walletRef = unique("PRINT-WALLET-REF");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "PRINT_POS",
      method: "WALLET",
      amount: "150.00",
      reference: walletRef,
      requestId: unique("REQ-PRINT-SPLIT"),
      deviceId: "TEST-PRINT-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "PRINT_POS",
      deviceId: "TEST-PRINT-DEVICE",
    }, cashier);

    const res = await createPrintSale({
      branchId: 1,
      shiftId: 2,
      deviceId: "TEST-PRINT-DEVICE",
      clientRequestId: unique("PRINT-SPLIT-SALE"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "100.00" },
        { method: "WALLET", amount: "150.00", reference: walletRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier);

    expect(res.total).toBe("250.00");
    expect(res.status).toBe("PAID");
    const inv = (await db().select().from(s.invoices))[0];
    expect(inv.paymentMethod).toBe("MIXED");
    expect(inv.paidAmount).toBe("250.00");

    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(2);
    const cashReceipt = receipts.find((r) => r.paymentMethod === "CASH")!;
    const walletReceipt = receipts.find((r) => r.paymentMethod === "WALLET")!;
    expect(cashReceipt.amount).toBe("100.00");
    expect(cashReceipt.cashBucket).toBe("DRAWER");
    expect(walletReceipt.amount).toBe("150.00");
    expect(walletReceipt.cashBucket).toBeNull();

    const attemptRow = (await db().select().from(s.externalPaymentAttempts).where(eq(s.externalPaymentAttempts.id, initiated.attemptId)))[0];
    expect(Number(attemptRow.receiptId)).toBe(Number(walletReceipt.id));
  });

  it("إرجاع فاتورة MIXED يسقط بأمان إلى مسار ردّ صالح (CASH) دون إدخال MIXED في enum سندات القبض", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل اختبار", phone: "07700000001" });
    const cardRef = unique("RET-MIXED-CARD");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "60.00",
      reference: cardRef,
      requestId: unique("REQ-RET-MIXED"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    const sale = await createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      customerId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("RET-MIXED-SALE"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payments: [
        { method: "CASH", amount: "40.00" },
        { method: "CARD", amount: "60.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier);

    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    const retRes = await returnSale({
      invoiceId: sale.invoiceId,
      reason: "إرجاع فاتورة دفع مقسم",
      lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 1 }],
      refund: { amount: "100.00", method: "CASH", shiftId: 1 },
    }, owner);

    expect(retRes.returnedTotal).toBe("100.00");
    const refundReceipts = (await db().select().from(s.receipts)).filter((r) => r.direction === "OUT");
    expect(refundReceipts).toHaveLength(1);
    expect(refundReceipts[0].paymentMethod).toBe("CASH");
    expect(refundReceipts[0].amount).toBe("100.00");
  });

  it("استرداد CARD على فاتورة MIXED يُحكَم بسقف المقبوض الفعلي عبر البطاقة ويرفض التجاوز", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل اختبار", phone: "07700000001" });
    const cardRef = unique("RET-CAP-CARD");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "POS",
      method: "CARD",
      amount: "60.00",
      reference: cardRef,
      requestId: unique("REQ-RET-CAP"),
      deviceId: "TEST-POS-DEVICE",
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "POS",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    const sale = await createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      customerId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("RET-CAP-SALE"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      payments: [
        { method: "CASH", amount: "140.00" },
        { method: "CARD", amount: "60.00", reference: cardRef, externalPaymentAttemptId: initiated.attemptId },
      ],
    }, cashier);

    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    // محاولة استرداد 100 بالبطاقة بينما المقبوض بالبطاقة 60 فقط ⇒ تُرفض
    await expect(returnSale({
      invoiceId: sale.invoiceId,
      reason: "إرجاع يتجاوز سقف البطاقة",
      lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 1 }],
      refund: { amount: "100.00", method: "CARD", reference: "REF-OVER-CAP" },
    }, owner)).rejects.toThrow();

    // استرداد 60 بالبطاقة (ضمن السقف الفعلي للبطاقة) مع إبقاء الباقي رصيداً دائناً ⇒ ينجح
    const okRet = await returnSale({
      invoiceId: sale.invoiceId,
      reason: "إرجاع ضمن سقف البطاقة",
      lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 1 }],
      refund: { amount: "60.00", method: "CARD", reference: "REF-WITHIN-CAP" },
    }, owner);
    expect(okRet.returnedTotal).toBe("100.00");
    expect(okRet.fullyReturned).toBe(false);
    const outRecs = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId)))
      .filter((r) => r.direction === "OUT");
    expect(outRecs).toHaveLength(1);
    expect(outRecs[0].paymentMethod).toBe("CARD");
    expect(outRecs[0].amount).toBe("60.00");
    const custAfter = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(custAfter.currentBalance).toBe("-40.00");
  });

  it("تحصيل ذمّة آجل بدفعات مقسّمة (processPayment payments[]) يُحدّث الفاتورة إلى MIXED ويُنشئ سندَي قبض وقيدَين", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل ذمّة", phone: "07700000002" });
    const sale = await createConfirmedPosSale({
      branchId: 1,
      shiftId: 1,
      customerId: 1,
      deviceId: "TEST-POS-DEVICE",
      sourceType: "POS",
      clientRequestId: unique("CREDIT-SALE-FOR-SPLIT-PAY"),
      requireExternalPaymentAttempt: true,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { method: "CASH", amount: "20.00" },
    }, cashier);
    expect(sale.status).toBe("PARTIALLY_PAID");

    const transferRef = unique("TRX-SPLIT-PAY");
    const initiated = await initiateExternalPaymentAttempt({
      branchId: 1,
      channel: "SALES_COLLECTION",
      method: "TRANSFER",
      amount: "50.00",
      reference: transferRef,
      requestId: unique("REQ-INV-PAY"),
      deviceId: "TEST-POS-DEVICE",
      invoiceId: sale.invoiceId,
    }, cashier);
    await confirmExternalPaymentAttempt({
      attemptId: initiated.attemptId,
      branchId: 1,
      channel: "SALES_COLLECTION",
      deviceId: "TEST-POS-DEVICE",
    }, cashier);

    const payRes = await processPayment({
      invoiceId: sale.invoiceId,
      shiftId: 1,
      payments: [
        { method: "CASH", amount: "30.00" },
        {
          method: "TRANSFER",
          amount: "50.00",
          reference: transferRef,
          externalPaymentAttemptId: initiated.attemptId,
          externalPaymentDeviceId: "TEST-POS-DEVICE",
        },
      ],
    }, cashier);

    expect(payRes.status).toBe("PAID");
    expect(payRes.paidAmount).toBe("100.00");
    expect(payRes.receiptIds).toHaveLength(2);

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.paymentMethod).toBe("MIXED");
    expect(inv.paidAmount).toBe("100.00");

    const receipts = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId));
    expect(receipts).toHaveLength(3); // 20 CASH + 30 CASH + 50 TRANSFER
    expect(receipts.filter((r) => r.paymentMethod === "CASH")).toHaveLength(2);
    expect(receipts.filter((r) => r.paymentMethod === "TRANSFER")).toHaveLength(1);
  });
});

