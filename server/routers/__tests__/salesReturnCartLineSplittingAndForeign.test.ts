/**
 * salesReturnCartLineSplittingAndForeign.test.ts — اختبارات تكامل حوكمة المرتجعات بالسلة:
 *   1) تجميع بنود المرتجع المقسمة على نفس بند الفاتورة (Line-Splitting Accumulation)
 *   2) منع استغلال تكرار الإرجاع بعد استنفاد الحصة (Anti-Double-Refund Quota Protection)
 *   3) رفض الأصناف الأجنبية غير الموجودة في الفاتورة المرجعية (Foreign Item Rejection)
 *   4) التراجع الذري التام عند وجود صنف أجنبي ضمن سلة مختلطة (Atomic Rollback on Foreign Item)
 *   5) استمرار عمل المرتجع العابر بدون فاتورة كمرتجع حر (Walk-in Return Compatibility)
 *   6) معالجة المرتجع التالف (DAMAGED) المقسم دون إعادة للرف
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
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

  // ثلاثة منتجات: قلم (variant 1)، دفتر (variant 2)، ممحاة أجنبية (variant 3)
  await d.insert(s.products).values([
    { id: 1, name: "قلم حبر" },
    { id: 2, name: "دفتر ملاحظات" },
    { id: 3, name: "ممحاة خاصة" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NOTE-1", costPrice: "10.00" },
    { id: 3, productId: 3, sku: "ERAS-1", costPrice: "2.00" },
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
    {
      id: 3,
      variantId: 3,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "25.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "5.00" },
  ]);

  // رصيد مخزني أولي في الفرع 1
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 50 },
    { variantId: 3, branchId: 1, quantity: 50 },
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
    openingBalance: "1000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:2:RETAIL",
  });
  return Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 1);
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

describe("returns.executeSalesReturnCart — حوكمة تجميع البنود المقسمة ورفض الأصناف الأجنبية", () => {
  // -------------------------------------------------------------------------
  // IT-INV-01: Line Splitting Overwrite Protection (6 + 4 = 10)
  // -------------------------------------------------------------------------
  it("IT-INV-01: سلة المرتجع تجمع كميات البنود المقسمة لنفس صنف الفاتورة ذرياً (6 + 4 = 10)", async () => {
    const shiftId = await openShift();

    // 1. بيع 10 قطع من الدفتر (variant 2) بسعر 25.00 = 250.00 CASH
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [
          {
            variantId: 2,
            productUnitId: 2,
            quantity: "10",
          },
        ],
        payment: { amount: "250.00", method: "CASH" },
      },
      cashierActor,
    );

    const [createdItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.variantId, 2));
    expect(createdItem).toBeDefined();
    expect(Number(createdItem.baseQuantity)).toBe(10);
    expect(Number(createdItem.returnedBaseQuantity)).toBe(0);

    const initialStock = await stockOf(2); // 50 - 10 = 40

    // 2. إرجاع 6 قطع في السطر الأول، و 4 قطع في السطر الثاني لنفس البند
    const caller = returnRouter.createCaller(context());
    const res = await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل تجربة" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: 2,
          invoiceItemId: createdItem.id,
          productName: "دفتر ملاحظات",
          quantity: 6,
          unitPrice: "25.00",
        },
        {
          variantId: 2,
          invoiceItemId: createdItem.id,
          productName: "دفتر ملاحظات",
          quantity: 4,
          unitPrice: "25.00",
        },
      ],
      settlement: { method: "CASH", totalAmount: "250.00", shiftId },
      clientRequestId: "it-split-return-1",
    });

    expect(res.returnNumber).toMatch(/^SR-/);

    // 3. التحقق من جدول invoiceItems: يجب أن يكون 10 بالضبط (وليس 4 كالسابق)
    const [updatedItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.id, createdItem.id));

    expect(Number(updatedItem.returnedBaseQuantity)).toBe(10);
    expect(Number(updatedItem.returnedRestockedBaseQuantity)).toBe(10);

    // 4. التحقق من عودة الرصيد المخزني للرف
    const finalStock = await stockOf(2);
    expect(finalStock).toBe(initialStock + 10);
  });

  // -------------------------------------------------------------------------
  // IT-INV-02: Repeat Return Exploitation Prevention
  // -------------------------------------------------------------------------
  it("IT-INV-02: رفض أي محاولة إرجاع إضافية بعد استنفاد كمية البند عبر السطور المقسمة", async () => {
    const shiftId = await openShift();

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 2, productUnitId: 2, quantity: "10" }],
        payment: { amount: "250.00", method: "CASH" },
      },
      cashierActor,
    );

    const [createdItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.variantId, 2));

    const caller = returnRouter.createCaller(context());

    // استنفاد كامل كمية الفاتورة (6 + 4 = 10)
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل تجربة" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: 2,
          invoiceItemId: createdItem.id,
          productName: "دفتر ملاحظات",
          quantity: 6,
          unitPrice: "25.00",
        },
        {
          variantId: 2,
          invoiceItemId: createdItem.id,
          productName: "دفتر ملاحظات",
          quantity: 4,
          unitPrice: "25.00",
        },
      ],
      settlement: { method: "CASH", totalAmount: "250.00", shiftId },
      clientRequestId: "it-split-exhaust-1",
    });

    // محاولة إرجاع قطعة إضافية على نفس الفاتورة: يجب الرفض الحاسم
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجربة" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: 2,
            invoiceItemId: createdItem.id,
            productName: "دفتر ملاحظات",
            quantity: 1,
            unitPrice: "25.00",
          },
        ],
        settlement: { method: "CASH", totalAmount: "25.00", shiftId },
        clientRequestId: "it-split-exhaust-attempt-2",
      }),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // IT-INV-03: Foreign Item Rejection When Invoice Specified
  // -------------------------------------------------------------------------
  it("IT-INV-03: رفض الصنف الأجنبي (variant 3) غير الموجود في الفاتورة المرجعية", async () => {
    const shiftId = await openShift();

    // بيع قلم حبر فقط (variant 1)
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "50.00", method: "CASH" },
      },
      cashierActor,
    );

    const caller = returnRouter.createCaller(context());

    // محاولة إرجاع ممحاة (variant 3) على فاتورة القلم
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجربة" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: 3,
            productName: "ممحاة خاصة",
            quantity: 1,
            unitPrice: "5.00",
          },
        ],
        settlement: { method: "CASH", totalAmount: "5.00", shiftId },
        clientRequestId: "it-foreign-rejection-1",
      }),
    ).rejects.toThrow(/العنصر غير موجود في الفاتورة المرجعية/);
  });

  // -------------------------------------------------------------------------
  // IT-INV-04: Mixed Cart (Valid Item + Foreign Item) Atomic Rejection
  // -------------------------------------------------------------------------
  it("IT-INV-04: السلة المختلطة (صنف صالح + صنف أجنبي) تفشل ذرياً بدون أي تغيير بالمخزون أو الفاتورة", async () => {
    const shiftId = await openShift();

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "50.00", method: "CASH" },
      },
      cashierActor,
    );

    const initialStockValid = await stockOf(1);
    const initialStockForeign = await stockOf(3);

    const caller = returnRouter.createCaller(context());

    // سلة تحوي قلماً صالحاً وممحاة أجنبية
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل تجربة" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: 1,
            productName: "قلم حبر",
            quantity: 2,
            unitPrice: "10.00",
          },
          {
            variantId: 3,
            productName: "ممحاة خاصة",
            quantity: 1,
            unitPrice: "5.00",
          },
        ],
        settlement: { method: "CASH", totalAmount: "25.00", shiftId },
        clientRequestId: "it-mixed-foreign-fail-1",
      }),
    ).rejects.toThrow(/العنصر غير موجود في الفاتورة المرجعية/);

    // التحقق من التراجع الذري التام: لم يتغير مخزون القلم أو الممحاة
    expect(await stockOf(1)).toBe(initialStockValid);
    expect(await stockOf(3)).toBe(initialStockForeign);

    // التحقق من بقاء returnedBaseQuantity عند 0 للبند الصالح
    const [invItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.variantId, 1));
    expect(Number(invItem.returnedBaseQuantity)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // IT-INV-05: Legitimate Walk-In Return Without Invoice
  // -------------------------------------------------------------------------
  it("IT-INV-05: المرتجع العابر بدون رقم فاتورة ينفذ بنجاح كمرتجع حر", async () => {
    const shiftId = await openShift();
    const initialStock = await stockOf(1);

    const caller = returnRouter.createCaller(context());

    // تنفيذ مرتجع بدون رقم فاتورة (مرتجع زبون عابر)
    const res = await caller.executeSalesReturnCart({
      invoiceNumber: undefined,
      customer: { name: "زبون عابر" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: 1,
          productName: "قلم حبر",
          quantity: 2,
          unitPrice: "10.00",
        },
      ],
      settlement: { method: "CASH", totalAmount: "20.00", shiftId },
      clientRequestId: "it-walkin-no-inv-1",
    });

    expect(res.returnNumber).toMatch(/^SR-/);
    expect(await stockOf(1)).toBe(initialStock + 2);
  });

  // -------------------------------------------------------------------------
  // IT-INV-06: Damaged Disposition Split Line Execution
  // -------------------------------------------------------------------------
  it("IT-INV-06: المرتجع التالف (DAMAGED) المقسم يرفع returnedBaseQuantity دون زيادة رصيد الرف", async () => {
    const shiftId = await openShift();

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "50.00", method: "CASH" },
      },
      cashierActor,
    );

    const [createdItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.variantId, 1));

    const initialStock = await stockOf(1);
    const caller = returnRouter.createCaller(context());

    // إرجاع تالف مقسم على سطرين: (2 + 1 = 3)
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل تجربة" },
      disposition: "DAMAGED",
      items: [
        {
          variantId: 1,
          invoiceItemId: createdItem.id,
          productName: "قلم حبر",
          quantity: 2,
          unitPrice: "10.00",
        },
        {
          variantId: 1,
          invoiceItemId: createdItem.id,
          productName: "قلم حبر",
          quantity: 1,
          unitPrice: "10.00",
        },
      ],
      settlement: { method: "CASH", totalAmount: "30.00", shiftId },
      clientRequestId: "it-damaged-split-1",
    });

    // رصيد الرف لا يجب أن يزيد
    expect(await stockOf(1)).toBe(initialStock);

    // في قاعدة البيانات: returnedBaseQuantity = 3، بينما returnedRestockedBaseQuantity = 0
    const [invItem] = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.id, createdItem.id));

    expect(Number(invItem.returnedBaseQuantity)).toBe(3);
    expect(Number(invItem.returnedRestockedBaseQuantity ?? 0)).toBe(0);
  });
});
