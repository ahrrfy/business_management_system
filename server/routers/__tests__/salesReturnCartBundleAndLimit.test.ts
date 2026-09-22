/**
 * salesReturnCartBundleAndLimit.test.ts — اختبارات تكامل حوكمة المرتجعات بالسلة:
 *   1) استرجاع البكجات المركبة (Bundle) ذرّياً للرف (RESTOCK) بتوسيع مكوّناتها في المخزون
 *   2) استرجاع البكجات كـ (DAMAGED) بدون حركة مخزون للرف
 *   3) حارس منع تجاوز سقف الفاتورة والمدفوع (معالجة ثغرة الفاتورة 17738)
 *   4) حارس منع تجاوز كمية بنود الفاتورة المتبقية
 *   5) حارس الفواتير المغلقة / الملغاة / المسترجعة بالكامل
 *   6) إجراء فحص الفاتورة للمرتجع (inspectInvoiceForReturn)
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { createProduct } from "../../services/catalogService";
import { createSale } from "../../services/saleService";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "bundleComponents",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "roles",
  "users",
  "salesControlRequests",
  "returnRequests",
  "auditLogs",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await d.insert(s.users).values({
    id: 2,
    openId: "cart-cashier",
    name: "كاشير المرتجعات",
    role: "cashier",
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });

  // مكوّنان بسيطان: قلم (تكلفة 4، بيع 10) ودفتر (تكلفة 10، بيع 25)
  await d.insert(s.products).values([
    { id: 1, name: "قلم" },
    { id: 2, name: "دفتر" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NOTE-1", costPrice: "10.00" },
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
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "25.00" },
  ]);

  // رصيد مخزني للمكوّنات في الفرع 1
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 50 },
  ]);

  await d.insert(s.customers).values({
    id: 1,
    name: "عميل تجربة",
    currentBalance: "0.00",
  });
}

const cashierActor = { userId: 2, branchId: 1, role: "cashier" as const };

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 2,
      role: "cashier",
      branchId: 1,
      name: "كاشير المرتجعات",
      email: "cart-cashier@test.local",
      isActive: true,
      isOwner: false,
    } as TrpcContext["user"],
  };
}

async function openShift(): Promise<number> {
  const r = await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 2,
    openingBalance: "100.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:2:RETAIL",
  });
  return Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 1);
}

async function createTestBundle(
  name: string,
  components: Array<{ vid: number; qty: number }>,
  price: string,
) {
  const res = await createProduct(
    {
      name,
      isBundle: true,
      variants: [
        {
          sku: `BDL-${name}`,
          costPrice: "0",
          units: [
            {
              unitName: "بكج",
              conversionFactor: "1",
              isBaseUnit: true,
              barcode: `BC-${name}`,
              prices: [{ priceTier: "RETAIL", price }],
            },
          ],
        },
      ],
      bundleComponents: components.map((c) => ({
        componentVariantId: c.vid,
        componentBaseQuantity: c.qty,
      })),
    } as any,
    cashierActor,
  );

  const variants = await db()
    .select()
    .from(s.productVariants)
    .where(eq(s.productVariants.productId, (res as any).productId));
  const variantId = Number(variants[0].id);

  const units = await db()
    .select()
    .from(s.productUnits)
    .where(eq(s.productUnits.variantId, variantId));
  const productUnitId = Number(units[0].id);

  return { productId: (res as any).productId, variantId, productUnitId };
}

async function stockOf(variantId: number, branchId = 1): Promise<number> {
  const rows = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(
      and(
        eq(s.branchStock.variantId, variantId),
        eq(s.branchStock.branchId, branchId),
      ),
    );
  return rows[0]?.q ?? 0;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("returns.executeSalesReturnCart — حوكمة البكجات وسقف الفواتير", () => {
  it("⭐ استرجاع بكج للرف (RESTOCK) يفكك المكونات ذرياً ويرجع رصيدها المخزني", async () => {
    const shiftId = await openShift();

    // إنشاء بكج مكون من: 2 قلم (variant 1) و 1 دفتر (variant 2) بسعر 40.00
    const bundle = await createTestBundle(
      "بكج القرطاسية",
      [
        { vid: 1, qty: 2 },
        { vid: 2, qty: 1 },
      ],
      "40.00",
    );

    // بيع قطعتين من البكج نقداً (إجمالي 80.00)
    // مخزون المكونات قبل البيع: قلم=100، دفتر=50
    // بعد بيع 2 بكج: قلم ينقص 2*2=4 (يصبح 96)، دفتر ينقص 2*1=2 (يصبح 48)
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: bundle.variantId,
            productUnitId: bundle.productUnitId,
            quantity: "2",
          },
        ],
        payment: { amount: "80.00", method: "CASH" },
      },
      cashierActor,
    );

    expect(await stockOf(1)).toBe(96);
    expect(await stockOf(2)).toBe(48);

    // تنفيذ مرتجع 1 بكج إلى الرف RESTOCK
    const caller = returnRouter.createCaller(context());
    const res = await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل تجربة" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: bundle.variantId,
          productName: "بكج القرطاسية",
          quantity: 1,
          unitPrice: "40.00",
        },
      ],
      settlement: { method: "CASH", totalAmount: "40.00", shiftId },
      clientRequestId: "ret-bundle-restock-1",
    });

    expect(res.returnNumber).toMatch(/^SR-/);

    // التحقق من استرجاع رصيد مكونات البكج في المخزون بدقة:
    // قلم: 96 + (1 * 2) = 98
    // دفتر: 48 + (1 * 1) = 49
    expect(await stockOf(1)).toBe(98);
    expect(await stockOf(2)).toBe(49);

    // التحقق من تحديث invoiceItems للكميات المرتجعة
    const invItems = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.variantId, bundle.variantId));
    expect(invItems).toHaveLength(1);
    expect(Number(invItems[0].returnedBaseQuantity)).toBe(1);
    expect(Number(invItems[0].returnedRestockedBaseQuantity)).toBe(1);
  });

  it("⭐ استرجاع بكج كـ DAMAGED يوثق المرتجع مالياً دون زيادة رصيد الرف", async () => {
    const shiftId = await openShift();

    const bundle = await createTestBundle(
      "بكج القرطاسية التالف",
      [
        { vid: 1, qty: 2 },
        { vid: 2, qty: 1 },
      ],
      "40.00",
    );

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: bundle.variantId,
            productUnitId: bundle.productUnitId,
            quantity: "1",
          },
        ],
        payment: { amount: "40.00", method: "CASH" },
      },
      cashierActor,
    );

    expect(await stockOf(1)).toBe(98);
    expect(await stockOf(2)).toBe(49);

    // إرجاع البكج كـ DAMAGED
    const caller = returnRouter.createCaller(context());
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل تجربة" },
      disposition: "DAMAGED",
      items: [
        {
          variantId: bundle.variantId,
          productName: "بكج القرطاسية التالف",
          quantity: 1,
          unitPrice: "40.00",
        },
      ],
      settlement: { method: "CASH", totalAmount: "40.00", shiftId },
      clientRequestId: "ret-bundle-damaged-1",
    });

    // الرصيد المخزني لا يتغير لأن البكج تالف ولا يعود للرف
    expect(await stockOf(1)).toBe(98);
    expect(await stockOf(2)).toBe(49);

    const invItems = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.variantId, bundle.variantId));
    expect(Number(invItems[0].returnedBaseQuantity)).toBe(1);
    expect(Number(invItems[0].returnedRestockedBaseQuantity ?? 0)).toBe(0);
  });

  it("⭐ حارس سقف الفاتورة (ثغرة 17738): يرفض إرجاع مبلغ أكبر من إجمالي أو مدفوع الفاتورة", async () => {
    const shiftId = await openShift();

    // إنشاء فاتورة بمبلغ 19.00 (مثل حالة 19,000 د.ع)
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "1",
          },
        ],
        payment: { amount: "10.00", method: "CASH" },
      },
      cashierActor,
    );

    const caller = returnRouter.createCaller(context());

    // محاولة استرجاع 50.00 على فاتورة إجماليها 10.00
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجربة" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: 1,
            productName: "قلم",
            quantity: 1,
            unitPrice: "50.00",
          },
        ],
        settlement: { method: "CASH", totalAmount: "50.00", shiftId },
        clientRequestId: "overflow-attempt-1",
      }),
    ).rejects.toThrow(/مبلغ المرتجع يتجاوز القيمة المتبقية للفاتورة/);
  });

  it("⭐ حارس كمية البند: يرفض إرجاع كمية أكبر من الكمية المباعة المتبقية", async () => {
    const shiftId = await openShift();

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
          },
        ],
        payment: { amount: "20.00", method: "CASH" },
      },
      cashierActor,
    );

    const caller = returnRouter.createCaller(context());

    // محاولة إرجاع 3 قطع من أصل 2 تم بيعها
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجربة" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: 1,
            productName: "قلم",
            quantity: 3,
            unitPrice: "10.00",
          },
        ],
        settlement: { method: "CASH", totalAmount: "30.00", shiftId },
        clientRequestId: "qty-overflow-attempt-1",
      }),
    ).rejects.toThrow();
  });

  it("⭐ حارس الفاتورة المرجعة/الملغاة: يرفض تنفيذ مرتجع على فاتورة RETURNED", async () => {
    const shiftId = await openShift();

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "1",
          },
        ],
        payment: { amount: "10.00", method: "CASH" },
      },
      cashierActor,
    );

    // تحويل حالة الفاتورة إلى RETURNED يدوياً لمحاكاة فاتورة أغلقت
    await db()
      .update(s.invoices)
      .set({ status: "RETURNED" })
      .where(eq(s.invoices.invoiceNumber, sale.invoiceNumber));

    const caller = returnRouter.createCaller(context());

    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجربة" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: 1,
            productName: "قلم",
            quantity: 1,
            unitPrice: "10.00",
          },
        ],
        settlement: { method: "CASH", totalAmount: "10.00", shiftId },
        clientRequestId: "dead-inv-attempt-1",
      }),
    ).rejects.toThrow(/لا يمكن تنفيذ مرتجع على هذه الفاتورة/);
  });

  it("⭐ إجراء inspectInvoiceForReturn: يجلب تفاصيل الفاتورة وسقف الاسترداد وبنودها بدقة", async () => {
    const shiftId = await openShift();

    const bundle = await createTestBundle(
      "بكج الفحص",
      [{ vid: 1, qty: 1 }],
      "30.00",
    );

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: bundle.variantId,
            productUnitId: bundle.productUnitId,
            quantity: "2",
          },
        ],
        payment: { amount: "60.00", method: "CASH" },
      },
      cashierActor,
    );

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });

    expect(inspected).not.toBeNull();
    expect(inspected?.invoiceNumber).toBe(sale.invoiceNumber);
    expect(inspected?.isDead).toBe(false);
    expect(Number(inspected?.total)).toBe(60);
    expect(Number(inspected?.paidAmount)).toBe(60);
    expect(Number(inspected?.maxRefundable)).toBe(60);
    expect(inspected?.items).toHaveLength(1);
    expect(inspected?.items[0].isBundle).toBe(true);
    expect(inspected?.items[0].baseQuantity).toBe(2);
    expect(inspected?.items[0].remainingQuantity).toBe(2);
  });
});
