/**
 * مرتجعٌ بلا ردّ نقديّ — فاتورةٌ لم يُقبض عليها دينار (بلاغ المالك ١٨/٨).
 *
 * نصّ البلاغ: «عند المرتجعات النظام يجبر على اختيار درج لردّ النقود والعميل لم يدفع دينار
 * أو عربون أصلاً». الفحص أثبت أنّ **الخادم يقبل** المرتجع بلا ردّ (كتلة الإيصال تُتخطّى عند
 * صفر، وحارس الزبون العابر يمرّ لأنّ المستحقّ = صفر) — والحاجز كان في الشاشة وحدها: كلا
 * رافدَي الردّ يُوسَمان «محجوب» حين يكون وعاء المقبوض صفراً، فتُعطَّل زرّ التأكيد كلّياً.
 *
 * هذا الملف يثبّت **العقد الخادميّ** الذي بُنيت عليه الواجهة الجديدة، وهو ما لم يكن مغطّى
 * إطلاقاً: المرتجع الصفريّ الردّ يجب أن يمرّ، ويُخصَم من الذمّة والمتبقّي، بلا إيصال صرفٍ
 * ولا اشتراط وردية — مع بقاء حارس «لا يبقى مال العميل عندنا» صارماً حيث يجب.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";

const manager = { userId: 1, branchId: 1, role: "manager" };
const cashier = { userId: 2, branchId: 1 };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "suppliers", "branches", "users",
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
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مديرة الفرع", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "cashier1", name: "كاشير أحمد", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل آجل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "10.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
}

async function openShiftFor(userId: number, opening = "0"): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId: 1, userId, openingBalance: opening, status: "OPEN" });
  return extractInsertId(r);
}

/**
 * بيعٌ آجل: عميلٌ مسجَّل (بلا حدّ ائتمان)، والمقبوض جزئيّ أو صفر — الحالة موضع بلاغ المالك.
 * (البيع الآجل بلا عميلٍ مسجَّل ممنوعٌ بنيوياً — قرار المالك «لا ذمّة بلا صاحب».)
 */
async function sellOnCredit(shiftId: number, qty: number, paid?: string) {
  const sale = await createSale(
    {
      branchId: 1, shiftId, sourceType: "POS", customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }],
      ...(paid ? { payment: { amount: paid, method: "CASH" as const } } : {}),
    },
    cashier,
  );
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
  return { invoiceId: sale.invoiceId, itemId: Number(item.id) };
}

const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const balanceOf = async (id: number) =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, id)))[0].currentBalance);
const outReceipts = async (invoiceId: number) =>
  db().select().from(s.receipts).where(and(
    eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT"),
  ));

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("مرتجع بلا ردّ — فاتورة غير مدفوعة", () => {
  it("فاتورة آجلة بصفر مقبوض: مرتجعٌ كامل بلا ردّ ⇒ يمرّ، ويُسقط الذمّة، بلا إيصال صرف ولا درج", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId, itemId } = await sellOnCredit(shift, 5); // 50.00 ذمّة
    expect((await invoiceOf(invoiceId)).paidAmount).toBe("0.00");
    expect(await balanceOf(1)).toBe(50);

    // بلا `refund` إطلاقاً — لا رافد ولا درج ولا مرجع.
    const res = await returnSale(
      { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 5 }], restock: true },
      manager,
    );
    expect(res.fullyReturned).toBe(true);

    const inv = await invoiceOf(invoiceId);
    expect(inv.status).toBe("RETURNED");
    expect(inv.returnedTotal).toBe("50.00");
    expect(await balanceOf(1)).toBe(0); // الذمّة سقطت بكاملها
    expect(await outReceipts(invoiceId)).toHaveLength(0); // لا مال خرج ⇒ لا إيصال صرف
    // المخزون عاد فعلاً (المرتجع مستلَمٌ في الفرع).
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(Number(stock.quantity)).toBe(100);
  });

  it("مرتجعٌ جزئيّ على فاتورة آجلة: يخصم من الذمّة بقيمته ولا يطلب ردّاً", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId, itemId } = await sellOnCredit(shift, 10); // 100.00 ذمّة
    expect(await balanceOf(1)).toBe(100);

    await returnSale(
      { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 4 }], restock: true },
      manager,
    );

    const inv = await invoiceOf(invoiceId);
    expect(inv.returnedTotal).toBe("40.00");
    expect(inv.paidAmount).toBe("0.00");
    expect(await balanceOf(1)).toBe(60); // 100 − 40
    expect(await outReceipts(invoiceId)).toHaveLength(0);
  });

  it("فاتورةٌ مدفوعةٌ جزئياً والمرتجع تغطّيه الذمّة ⇒ لا ردّ ولا درج، والمقبوض لا يُمَسّ", async () => {
    const shift = await openShiftFor(2, "1000.00");
    // 100.00 إجمالاً، قُبض منها 20.00 ⇒ عليه 80.00.
    const { invoiceId, itemId } = await sellOnCredit(shift, 10, "20.00");
    expect(await balanceOf(1)).toBe(80);

    // مرتجعٌ بـ30.00: الصافي بعده 70.00 وما زال أكبر من المقبوض ⇒ لا شيء يُردّ للعميل.
    await returnSale(
      { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 3 }], restock: true },
      manager,
    );

    const inv = await invoiceOf(invoiceId);
    expect(inv.returnedTotal).toBe("30.00");
    expect(inv.paidAmount).toBe("20.00"); // المقبوض باقٍ كما هو — لم يخرج منه شيء
    expect(await balanceOf(1)).toBe(50); // 80 − 30
    expect(await outReceipts(invoiceId)).toHaveLength(0);
  });

  it("الحارس المقابل يبقى صارماً: زبونٌ عابر **دفع** ⇒ مرتجعٌ بلا ردّ مرفوض", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const sale = await createSale(
      {
        branchId: 1, shiftId: shift, sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "50.00", method: "CASH" },
      },
      cashier,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];

    // مالُه عندنا ولا ذمّة يُرحَّل إليها الفائض ⇒ لا يُحفَظ مرتجعٌ يُبقيه في المكتبة.
    await expect(returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 5 }], restock: true },
      manager,
    )).rejects.toThrowError();
  });
});
