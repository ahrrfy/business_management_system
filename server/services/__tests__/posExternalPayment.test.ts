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
});
