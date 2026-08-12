/**
 * إلغاء فاتورة بيع (قرار مالك ١٢/٨/٢٦) — «الفاتورة كأنّها لم تكن»:
 *   ثابت ١ (صافي الدفتر): Σ(revenue) = Σ(cost) = Σ(profit) = ٠ على invoiceId ⇐ عكسٌ كاملٌ للقيد.
 *   ثابت ٢ (إرجاع مخزون): كل بند رصيده يعود لما كان قبل البيع (RETURN بكمّية remainingBase الفعليّة).
 *   ثابت ٣ (استرداد بجهة صرف): PAYMENT_OUT بمبلغ paidAmount + receipt.direction=OUT بطريقةٍ مُصرَّحة.
 *   ثابت ٤ (حراس): خارج الفترة/لغير المدير على فرع آخر/فاتورة ملغاة أو مرتجعة/كروت رقمية/أمر شغل ⇒ رفض.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelSale } from "../sale/cancel";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { lockPeriod } from "../periodLockService";
import { money } from "../money";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const manager = { userId: 2, branchId: 1, role: "manager" as const };
const managerOtherBranch = { userId: 3, branchId: 2, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "financialPeriods",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "mgr", name: "manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgr2", name: "manager2", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "400.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
  // وردية مفتوحة للمدير على الفرع ١ (يسمح باسترداد نقديّ من DRAWER أو TREASURY حسب الحالة).
  await d.insert(s.shifts).values({
    id: 1,
    userId: 2,
    branchId: 1,
    status: "OPEN",
    openedAt: new Date(),
    openGuard: "2:1",
    openingBalance: "0",
  });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

async function stockOf(variantId: number, branchId: number): Promise<number> {
  const row = (
    await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(sql`${s.branchStock.variantId}=${variantId} AND ${s.branchStock.branchId}=${branchId}`)
      .limit(1)
  )[0];
  return Number(row?.q ?? 0);
}

async function sumCol(invoiceId: number, col: "revenue" | "cost" | "profit" | "amount"): Promise<number> {
  const rows = await db()
    .select({ v: s.accountingEntries[col] })
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.invoiceId, invoiceId));
  return rows.reduce((t, r) => t + Number(r.v), 0);
}

async function customerBalance(customerId: number): Promise<string> {
  const row = (
    await db().select({ b: s.customers.currentBalance }).from(s.customers).where(eq(s.customers.id, customerId)).limit(1)
  )[0];
  return String(row?.b ?? "0");
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("cancelSale — ثابت ١ + ٢: صافي الدفتر صفر + رصيد المخزون يعود كاملاً", () => {
  it("بيعٌ آجل (٥ قطع) ⇒ إلغاء ⇒ Σ(revenue)=Σ(cost)=Σ(profit)=٠ ورصيد المخزون يعود ١٠", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      },
      admin,
    );
    // بيع ٥ قطع × ١٠٠٠ = ٥٠٠٠ إيراد، ٥ × ٤٠٠ = ٢٠٠٠ تكلفة، ربح ٣٠٠٠.
    expect(await stockOf(1, 1)).toBe(5);
    expect(money(await sumCol(sale.invoiceId, "revenue")).toFixed(2)).toBe("5000.00");
    expect(money(await sumCol(sale.invoiceId, "profit")).toFixed(2)).toBe("3000.00");

    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "خطأ إدخال" },
      admin,
    );
    expect(res.refundAmount).toBe("0.00"); // لم يُدفع شيء (آجل)
    expect(res.refundVoucherNumber).toBeNull();

    // صافي الدفتر صفر (الثابت الحاكم).
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "cost")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "profit")).isZero()).toBe(true);

    // المخزون يعود كاملاً.
    expect(await stockOf(1, 1)).toBe(10);

    // الفاتورة CANCELLED + لقطة تدقيق.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).toBe("CANCELLED");
    expect(inv.cancelledBy).toBe(1);
    expect(inv.cancelledByNameSnapshot).toBe("admin");
    expect(inv.cancelledAt).toBeTruthy();

    // ذمّة العميل تعود لصفر (كانت +٥٠٠٠ ثم أُسقطت).
    expect(money(await customerBalance(1)).toFixed(2)).toBe("0.00");
  });
});

describe("cancelSale — ثابت ٣: استرداد بجهة صرف نقديّ + PAYMENT_OUT", () => {
  it("بيعٌ نقديّ كامل ⇒ إلغاء ⇒ سند صرفٍ OUT بمبلغ paidAmount + PAYMENT_OUT + المخزون يعود", async () => {
    await setStock(1, 1, 10);
    // بيع نقديّ كامل: paidNow = 5000
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "5000.00", method: "CASH" },
      },
      manager,
    );
    const invBefore = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(invBefore.paidAmount).toBe("5000.00");

    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "طلب زبون" },
      manager,
    );
    expect(res.refundAmount).toBe("5000.00");
    expect(res.refundVoucherNumber).toBeTruthy();

    // receipts.direction=OUT بالمبلغ الصحيح + طريقة الدفع + shiftId (drawer) + voucherNumber.
    const outs = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`);
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe("5000.00");
    expect(outs[0].paymentMethod).toBe("CASH");
    expect(outs[0].cashBucket).toBe("DRAWER"); // مدير له وردية مفتوحة
    expect(outs[0].shiftId).toBe(1);
    expect(outs[0].voucherNumber).toBe(res.refundVoucherNumber);
    expect(outs[0].partyType).toBe("CUSTOMER");

    // قيد PAYMENT_OUT مرتبط بالفاتورة.
    const payOut = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='PAYMENT_OUT'`)
    )[0];
    expect(payOut).toBeTruthy();
    expect(payOut!.amount).toBe("5000.00");

    // المخزون يعود كاملاً + الفاتورة CANCELLED + paidAmount صار صفراً.
    expect(await stockOf(1, 1)).toBe(10);
    const invAfter = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(invAfter.status).toBe("CANCELLED");
    expect(invAfter.paidAmount).toBe("0.00");
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "cost")).isZero()).toBe(true);
  });

  it("إلغاء بطريقة استرداد غير النقد (TRANSFER) ⇒ receipt بلا cashBucket + المبلغ صحيح", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      admin,
    );
    // دفعة تحويل جزئيّة على الفاتورة (٢٠٠٠ من أصل ٢٠٠٠).
    const invRow = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    await db().update(s.invoices).set({ paidAmount: "2000.00", status: "PAID" }).where(eq(s.invoices.id, sale.invoiceId));
    await db().insert(s.receipts).values({
      invoiceId: sale.invoiceId,
      branchId: 1,
      direction: "IN",
      amount: "2000.00",
      paymentMethod: "TRANSFER",
      status: "COMPLETED",
      createdBy: 1,
    });

    const res = await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin);
    expect(res.refundAmount).toBe("2000.00");

    const outs = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`);
    expect(outs).toHaveLength(1);
    expect(outs[0].paymentMethod).toBe("TRANSFER");
    expect(outs[0].cashBucket).toBeNull(); // TRANSFER لا يمسّ صندوقاً
    expect(outs[0].voucherNumber).toBeTruthy();

    // صافي الدفتر صفر.
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "cost")).isZero()).toBe(true);
    void invRow;
  });
});

describe("cancelSale — ثابت ٤: الحراس (رفض خارج الفترة/عبر الفرع/فاتورة ملغاة أو مرتجعة)", () => {
  it("خارج الفترة المفتوحة (assertPeriodOpen) ⇒ FORBIDDEN من postEntry، لا كتابات جانبية", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    // اقفل الفترة على تاريخ اليوم — أي قيد جديد اليوم (تاريخ RETURN الافتراضي) يُرفض.
    await db().transaction(async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      await lockPeriod(tx as any, { cutoffDate: today, lockedBy: 1 });
    });

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);

    // الفاتورة لم تتغيّر (لا CANCELLED) + المخزون لم يعُد.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).not.toBe("CANCELLED");
    expect(await stockOf(1, 1)).toBe(9); // لم يُعَد.
  });

  it("مدير فرع آخر ⇒ FORBIDDEN «الفاتورة لا تخصّ فرعك»", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, managerOtherBranch),
    ).rejects.toThrow(/لا تخصّ فرعك/);
  });

  it("فاتورة CANCELLED مسبقاً ⇒ رفض «ملغاة مسبقاً» (idempotency بلا مفتاح)", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin);
    // محاولة إلغاء ثانية بلا clientRequestId ⇒ رفض صريح.
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/ملغاة مسبقاً/);
  });

  it("فاتورة RETURNED بالكامل ⇒ رفض «لا حاجة للإلغاء»", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        refund: null,
        restock: true,
      },
      admin,
    );
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/مُرتجَعة بالكامل/);
  });

  it("فاتورة WORKORDER ⇒ رفض «استعمل مسار إلغاء أمر الشغل»", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "WORKORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/إلغاء أمر الشغل/);
  });

  it("idempotency: نفس clientRequestId ⇒ replay بلا أثر ثانٍ", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const key = "cancel-key-" + Date.now();
    const r1 = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", clientRequestId: key },
      admin,
    );
    expect(r1.idempotentReplay).toBeFalsy();
    const stockAfter1 = await stockOf(1, 1);
    const revAfter1 = await sumCol(sale.invoiceId, "revenue");

    // Replay بنفس المفتاح: لا يعيد الإرجاع ولا يعكس شيئاً — يُعيد وسم idempotentReplay.
    const r2 = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", clientRequestId: key },
      admin,
    );
    expect(r2.idempotentReplay).toBe(true);
    expect(await stockOf(1, 1)).toBe(stockAfter1);
    expect(await sumCol(sale.invoiceId, "revenue")).toBe(revAfter1);
  });
});
