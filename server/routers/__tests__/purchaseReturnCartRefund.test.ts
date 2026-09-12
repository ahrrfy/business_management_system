/**
 * مرتجع المشتريات بالسلة (`returns.executePurchaseReturnCart`) — سلامةُ المسار الماليّ لطرق
 * التسوية الثلاث، وتحديداً إغلاقُ فجوة CARD_TRANSFER التي بقيت حيّةً بعد PR #1084.
 *
 * السياق: #1084 (`sales_return_cash_reconciliation`) أزال أسطر posting الصفريّة (التي كانت
 * تُسقط الإجراء كلّه) وربط CASH_IN بدرجٍ (إيصال + PAYMENT_IN)، لكنّه لم يضف فرعاً لِـ
 * CARD_TRANSFER — فبقيَ المسار (وهو معروضٌ في PurchaseReturnPortal) يُرحّل قيد RETURN وحده
 * (يخصم AP) بلا إيصالٍ ولا PAYMENT_IN ولا مسّ الرصيد ⇒ انحرافُ `reconcileSupplierBalances`
 * بقيمة المرتجع + مردودٌ بلا مسار (يخالف مبدأ المالك §٥: لا دينار بلا مسار/تبويب).
 *
 * الإصلاح: فرعُ CARD_TRANSFER يُنشئ إيصال قبضٍ (IN, TRANSFER, بلا درج) + قيد PAYMENT_IN عاكساً
 * (debit CARD_BANK / credit AP) يُصافر خفضَ RETURN ⇒ صافي AP صفرٌ على الدفتر والرصيد معاً.
 * راجع ذاكرة purchase-return-cart-money-trail-2026-09-11.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { reconcileSupplierBalances } from "../../services/reconcileService";

const TABLES = [
  "accountingEntries",
  "receipts",
  "idempotencyKeys",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "auditLogs",
  "suppliers",
  "branches",
  "users",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "pr-cart-manager",
    name: "مدير المرتجعات",
    role: "manager",
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "5.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.suppliers).values({ id: 1, name: "مورد الاختبار", currentBalance: "0.00" });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  // وردية مفتوحة لمسار CASH_IN (يتطلّب درجاً صريحاً).
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    openingBalance: "0.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:1:RETAIL",
  });
}

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      role: "manager",
      branchId: 1,
      name: "مدير المرتجعات",
      email: "pr-cart@test.local",
      isActive: true,
      isOwner: false,
    } as TrpcContext["user"],
  };
}

const items = [{ variantId: 1, productName: "قلم", quantity: 60, unitCost: "5.00" }];

async function supplierBalance(id: number): Promise<string> {
  const rows = await db().select({ b: s.suppliers.currentBalance }).from(s.suppliers).where(eq(s.suppliers.id, id));
  return String(rows[0]?.b ?? "0.00");
}

async function entriesOfType(entryType: "RETURN" | "PAYMENT_IN") {
  return db()
    .select()
    .from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.entryType, entryType), eq(s.accountingEntries.supplierId, 1)));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("returns.executePurchaseReturnCart — سلامة المسار الماليّ لطرق التسوية", () => {
  it("⭐ CARD_TRANSFER: إيصال قبضٍ (IN/تحويل بلا درج) + قيد PAYMENT_IN(CARD_BANK) + reconcile نظيف + رصيد صافٍ صفر", async () => {
    const caller = returnRouter.createCaller(context());
    const res = await caller.executePurchaseReturnCart({
      supplierId: 1,
      items,
      settlement: { method: "CARD_TRANSFER", totalAmount: "300.00", reference: "TRX-9931" },
      reason: "استرداد بحوالة بنكية",
      clientRequestId: "pr-cart-transfer-1",
    });
    expect(res.ok).toBe(true);

    // (أ) إيصالُ قبضٍ غيرُ نقديّ لا يمسّ الدرج + قيد PAYMENT_IN مربوطٌ به.
    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.direction).toBe("IN");
    expect(receipt.paymentMethod).toBe("TRANSFER");
    expect(receipt.cashBucket).toBeNull();
    expect(receipt.shiftId).toBeNull();
    expect(receipt.partyType).toBe("SUPPLIER");
    expect(Number(receipt.partyId)).toBe(1);
    expect(String(receipt.amount)).toBe("300.00");

    const paymentIn = await entriesOfType("PAYMENT_IN");
    expect(paymentIn).toHaveLength(1);
    expect(String(paymentIn[0]!.amount)).toBe("300.00");
    expect(Number(paymentIn[0]!.receiptId)).toBe(Number(receipt.id));

    const ret = await entriesOfType("RETURN");
    expect(ret).toHaveLength(1);
    expect(String(ret[0]!.amount)).toBe("-300.00");

    // (ب) لا انحراف — الدفتر يطابق currentBalance (كان يحيد بقيمة المرتجع قبل الإصلاح).
    expect(await reconcileSupplierBalances()).toEqual([]);
    // (ج) رصيد صافٍ صفر: RETURN(−٣٠٠) يُصافره PAYMENT_IN(+٣٠٠) بلا مسّ currentBalance.
    expect(await supplierBalance(1)).toBe("0.00");

    const stock = await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    expect(Number(stock[0]?.q)).toBe(40);
  });

  it("CASH_IN (خطُّ الأساس القائم منذ #1084): إيصال قبضٍ (IN/DRAWER) + PAYMENT_IN + reconcile نظيف", async () => {
    const caller = returnRouter.createCaller(context());
    await caller.executePurchaseReturnCart({
      supplierId: 1,
      items,
      settlement: { method: "CASH_IN", totalAmount: "300.00", shiftId: 1 },
      reason: "مردود نقدي",
      clientRequestId: "pr-cart-cashin-1",
    });

    const receipts = await db().select().from(s.receipts);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.direction).toBe("IN");
    expect(receipt.paymentMethod).toBe("CASH");
    expect(receipt.cashBucket).toBe("DRAWER");
    expect(Number(receipt.shiftId)).toBe(1);

    expect(await entriesOfType("PAYMENT_IN")).toHaveLength(1);
    expect(await reconcileSupplierBalances()).toEqual([]);
    expect(await supplierBalance(1)).toBe("0.00");
  });

  it("CREDIT_OFFSET: يخصم ذمّة المورد بلا إيصالٍ ولا PAYMENT_IN + reconcile نظيف", async () => {
    const caller = returnRouter.createCaller(context());
    await caller.executePurchaseReturnCart({
      supplierId: 1,
      items,
      settlement: { method: "CREDIT_OFFSET", totalAmount: "300.00" },
      reason: "معادلة ذمة",
      clientRequestId: "pr-cart-credit-1",
    });

    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await entriesOfType("PAYMENT_IN")).toHaveLength(0);

    const ret = await entriesOfType("RETURN");
    expect(ret).toHaveLength(1);
    expect(String(ret[0]!.amount)).toBe("-300.00");

    expect(await reconcileSupplierBalances()).toEqual([]);
    expect(await supplierBalance(1)).toBe("-300.00");
  });
});
