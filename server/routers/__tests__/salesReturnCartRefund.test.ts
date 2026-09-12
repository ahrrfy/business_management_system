/**
 * مرتجع المبيعات بالسلة (`returns.executeSalesReturnCart`) — سلامةُ المسار الماليّ لطرق التسوية
 * الثلاث (CASH / CARD / STORE_CREDIT)، ومطابقةُ ذمّة العميل للدفتر (`reconcileCustomerBalances`
 * نظيف)، وإثباتُ الإيصال + قيد PAYMENT_OUT للرافدَين النقديّ والبطاقة.
 *
 * الخلفية (متابعة task_1118d928، الشقيق `executePurchaseReturnCart`): الاختبار الوحيد السابق
 * (`returnsAuditScenarios.test.ts`) نصّيٌّ محضٌ (يطابق سلاسل في المصدر) ولا يُشغّل المسار قطّ.
 * commit f5982a2d أزال الأسطر الصفرية من `postingIntent` وربط النقد بالدرج ذرّياً؛ يبقى إثباتُ
 * السلوك فعلياً + سدُّ فجوة «مرتجعٌ لعميلٍ بلا فاتورةٍ مطابقة» التي يبلغها reconcile:
 *   • CASH/CARD + عميلٌ + بلا فاتورةٍ مطابقة: قيد PAYMENT_OUT بـcustomerId وinvoiceId=NULL
 *     يُحسَب في `voucherSum` (سندُ صرفٍ يرفع AR) بينما `customers.currentBalance` لم يتحرّك ⇒
 *     انحرافٌ = المبلغ.
 *   • STORE_CREDIT بلا فاتورةٍ مطابقة: `adjustCustomerBalance(-amount)` يُنزل الرصيد بلا مُسنَدٍ
 *     في الدفتر (لا فاتورةَ returnedTotal ولا سند) ⇒ انحرافٌ = المبلغ.
 * راجع ذاكرة returns-refund-rails-2026-08-17 و purchase-return-cart-money-trail-2026-09-11.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { createSale } from "../../services/saleService";
import { reconcileCustomerBalances } from "../../services/reconcileService";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
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
  for (const table of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: 2,
    openId: "cart-cashier",
    name: "كاشير المرتجعات",
    role: "cashier",
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "10.00" });
  await d.insert(s.customers).values({ id: 1, name: "زبون مسجّل", currentBalance: "0.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
}

const cashier = { userId: 2, branchId: 1, role: "cashier" as const };

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
    openingBalance: "0.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:2:RETAIL",
  });
  return Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 1);
}

/** بيعٌ نقديٌّ كامل لـ`qty` قطعة (١٠.٠٠ للقطعة) لعميلٍ مسجّل على الوردية — يموّل الدرج ويُنشئ فاتورة. */
async function sellCashToCustomer(shiftId: number, customerId: number, qty: number) {
  const sale = await createSale(
    {
      branchId: 1,
      shiftId,
      customerId,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }],
      payment: { amount: (qty * 10).toFixed(2), method: "CASH" },
    },
    cashier,
  );
  return sale;
}

async function customerBalance(id: number): Promise<string> {
  const rows = await db()
    .select({ b: s.customers.currentBalance })
    .from(s.customers)
    .where(eq(s.customers.id, id));
  return String(rows[0]?.b ?? "0.00");
}

async function entriesOfType(entryType: "RETURN" | "PAYMENT_OUT") {
  return db()
    .select()
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.entryType, entryType));
}

const cartItems = [{ variantId: 1, productName: "قلم", quantity: 3, unitPrice: "10.00" }];

beforeEach(async () => {
  await reset();
  await seed();
});

describe("returns.executeSalesReturnCart — سلامة المسار الماليّ (فاتورةٌ مطابقة)", () => {
  it("⭐ CASH: إيصالُ صرفٍ (OUT/DRAWER) + قيد PAYMENT_OUT + reconcile نظيف + رصيد العميل صفر", async () => {
    const shiftId = await openShift();
    const sale = await sellCashToCustomer(shiftId, 1, 3); // ٣٠.٠٠ نقداً في الدرج
    // خطُّ الأساس: بيعٌ نقديٌّ مسدَّدٌ كاملاً ⇒ لا انحراف ولا رصيد على العميل.
    expect(await reconcileCustomerBalances()).toEqual([]);
    expect(await customerBalance(1)).toBe("0.00");

    const caller = returnRouter.createCaller(context());
    const res = await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "زبون مسجّل" },
      disposition: "RESTOCK",
      items: cartItems,
      settlement: { method: "CASH", totalAmount: "30.00", shiftId },
      clientRequestId: "sr-cart-cash-1",
    });
    expect(res.returnNumber).toMatch(/^SR-/);

    // (أ) إيصالُ صرفٍ نقديٍّ من الدرج + قيد PAYMENT_OUT مربوطٌ به وبالفاتورة.
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(outReceipts).toHaveLength(1);
    const receipt = outReceipts[0]!;
    expect(receipt.paymentMethod).toBe("CASH");
    expect(receipt.cashBucket).toBe("DRAWER");
    expect(Number(receipt.shiftId)).toBe(shiftId);
    expect(receipt.partyType).toBe("CUSTOMER");
    expect(Number(receipt.partyId)).toBe(1);
    expect(String(receipt.amount)).toBe("30.00");

    const paymentOut = await entriesOfType("PAYMENT_OUT");
    expect(paymentOut).toHaveLength(1);
    expect(String(paymentOut[0]!.amount)).toBe("30.00");
    expect(Number(paymentOut[0]!.receiptId)).toBe(Number(receipt.id));

    // (ب) قيدُ RETURN عاكسٌ للإيراد.
    const ret = await entriesOfType("RETURN");
    expect(ret).toHaveLength(1);
    expect(String(ret[0]!.amount)).toBe("-30.00");

    // (ج) لا انحراف في ذمم العملاء — الدفتر يطابق currentBalance، والرصيد صفرٌ (نقدٌ خرج مقابل نقدٍ دخل).
    expect(await reconcileCustomerBalances()).toEqual([]);
    expect(await customerBalance(1)).toBe("0.00");

    // البضاعة عادت للرف.
    const stock = await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stock[0]?.q)).toBe(100); // بيع ٣ ثم إرجاع ٣.
  });

  it("CARD: إيصالُ صرفٍ (OUT/بطاقة بلا درج) + قيد PAYMENT_OUT + reconcile نظيف + رصيد العميل صفر", async () => {
    const shiftId = await openShift();
    const sale = await sellCashToCustomer(shiftId, 1, 3);

    const caller = returnRouter.createCaller(context());
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "زبون مسجّل" },
      disposition: "RESTOCK",
      items: cartItems,
      settlement: { method: "CARD", totalAmount: "30.00", reference: "AUTH-99" },
      clientRequestId: "sr-cart-card-1",
    });

    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(outReceipts).toHaveLength(1);
    const receipt = outReceipts[0]!;
    expect(receipt.paymentMethod).toBe("CARD");
    // غيرُ النقد لا يمسّ الدرج (الثابت المحاسبيّ): cashBucket=NULL و shiftId=NULL.
    expect(receipt.cashBucket).toBeNull();
    expect(receipt.shiftId).toBeNull();
    expect(Number(receipt.partyId)).toBe(1);

    const paymentOut = await entriesOfType("PAYMENT_OUT");
    expect(paymentOut).toHaveLength(1);
    expect(String(paymentOut[0]!.amount)).toBe("30.00");

    expect(await reconcileCustomerBalances()).toEqual([]);
    expect(await customerBalance(1)).toBe("0.00");
  });

  it("STORE_CREDIT: رصيد العميل يصير سالباً (رصيد متجر) + reconcile نظيف + بلا إيصالٍ نقديّ/بطاقة", async () => {
    const shiftId = await openShift();
    const sale = await sellCashToCustomer(shiftId, 1, 3);

    const caller = returnRouter.createCaller(context());
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "زبون مسجّل" },
      disposition: "RESTOCK",
      items: cartItems,
      settlement: { method: "STORE_CREDIT", totalAmount: "30.00" },
      clientRequestId: "sr-cart-credit-1",
    });

    // إيداعُ رصيد متجرٍ لا يُحرّك نقداً ⇒ لا إيصال قبض/صرف ولا قيد PAYMENT_OUT.
    expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);
    expect(await entriesOfType("PAYMENT_OUT")).toHaveLength(0);

    // الرصيد سالبٌ بقيمة المرتجع (المتجر يدين للعميل)، والدفتر يطابقه.
    expect(await customerBalance(1)).toBe("-30.00");
    expect(await reconcileCustomerBalances()).toEqual([]);
  });
});

describe("returns.executeSalesReturnCart — عميلٌ مسجّلٌ بلا فاتورةٍ مطابقة (فجوة reconcile)", () => {
  it("⭐ CASH + عميلٌ + بلا فاتورة: reconcile نظيف ولا انحراف يُنسَب للعميل", async () => {
    const shiftId = await openShift();
    // تمويلُ الدرج مباشرةً (بلا بيع) كي يتّسع للصرف — إيصالٌ بلا قيدٍ فلا يمسّ reconcile.
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId,
      direction: "IN",
      amount: "100.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      partyType: "OTHER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: 2,
    });

    const caller = returnRouter.createCaller(context());
    await caller.executeSalesReturnCart({
      // بلا invoiceNumber — الشاشة تُرسله undefined حين لا تُدخَل فاتورة.
      customer: { customerId: 1, name: "زبون مسجّل" },
      disposition: "RESTOCK",
      items: cartItems,
      settlement: { method: "CASH", totalAmount: "30.00", shiftId },
      clientRequestId: "sr-cart-cash-noinv-1",
    });

    // لا فاتورةَ تنقص AR ولا رصيدَ تغيّر ⇒ يجب أن يبقى reconcile نظيفاً (صرفٌ نقديٌّ محضٌ للزبون).
    expect(await reconcileCustomerBalances()).toEqual([]);
    expect(await customerBalance(1)).toBe("0.00");
  });

  it("STORE_CREDIT بلا فاتورة: يُرفَض (رصيد المتجر يلزمه بيعٌ موثَّق) + لا أثر ولا انحراف", async () => {
    const caller = returnRouter.createCaller(context());
    // رصيدُ المتجر التزامٌ دائمٌ ⇒ يجب أن يُسنَد لفاتورةٍ مُرتجَعة. بلا فاتورةٍ مطابقة يُرفَض صراحةً
    // (لا يُنشأ رصيدٌ دائنٌ بلا مُسنَد فينحرف الدفتر). المرتجعُ العابر مساره ردٌّ نقديّ/بطاقة.
    await expect(
      caller.executeSalesReturnCart({
        customer: { customerId: 1, name: "زبون مسجّل" },
        disposition: "RESTOCK",
        items: cartItems,
        settlement: { method: "STORE_CREDIT", totalAmount: "30.00" },
        clientRequestId: "sr-cart-credit-noinv-1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // صفر أثر (المعاملة ذرّية): الرصيد صفرٌ، لا حركة مخزون، لا قيود، وreconcile نظيف.
    expect(await customerBalance(1)).toBe("0.00");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await reconcileCustomerBalances()).toEqual([]);
  });
});

describe("returns.executeSalesReturnCart — عزلُ الفرع (لا افتراضُ فرعٍ صامت)", () => {
  it("⭐ مشرفٌ بلا فرعٍ مُسنَد ⇒ FORBIDDEN، ولا يسقط صامتاً إلى الفرع 1", async () => {
    await openShift(); // وردية على الفرع 1 — لو سقط `?? 1` صامتاً لَصرَف منها.
    const adminNoBranch: TrpcContext = {
      req: { headers: {} } as TrpcContext["req"],
      res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
      user: {
        id: 2,
        role: "admin",
        branchId: null,
        name: "مشرفٌ بلا فرع",
        email: "admin-nobranch@test.local",
        isActive: true,
        isOwner: true,
      } as unknown as TrpcContext["user"],
    };
    const caller = returnRouter.createCaller(adminNoBranch);
    await expect(
      caller.executeSalesReturnCart({
        customer: { customerId: 1, name: "زبون مسجّل" },
        disposition: "RESTOCK",
        items: cartItems,
        settlement: { method: "CASH", totalAmount: "30.00", shiftId: 1 },
        clientRequestId: "sr-cart-admin-nobranch",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // لا سقوطَ صامتٌ إلى الفرع 1: صفرُ قيودٍ وصفرُ إيصالات صرف.
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(
      await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(0);
  });
});
