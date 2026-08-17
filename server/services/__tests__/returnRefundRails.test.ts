/**
 * رافدا ردّ المرتجع: **نقدٌ أو بطاقة، مهما كان رافد القبض** (قرار المالك ١٧/٨/٢٦).
 *
 * العلّة الواقعية (INV-1-20260816-00118): فاتورةٌ مدفوعةٌ بالبطاقة لزبونٍ عابر (بلا عميل مسجَّل)
 * كانت **بلا أيّ مسار استرداد بنيوياً**:
 *   · النقد: سقفه = المقبوض نقداً = صفر ⇒ «يتجاوز المسموح (0.00)».
 *   · غير النقد: يتطلّب `customerId` ثمّ سند صرفٍ معلَّقاً باعتماد المالك ⇒ الزبون يغادر بلا مال.
 * وهو نقضٌ صريح للمبدأ المالي الحاكم: «مالٌ محتجَز يلزمه مسار خروجٍ ممكنٌ دائماً».
 *
 * الثوابت المحروسة هنا (لا تُضعَّف):
 *   ① الوعاء عابرٌ للطرق: Σ(المسترَدّ) ≤ Σ(المقبوض) مهما تعدّدت الرافد والمرتجعات الجزئية.
 *   ② الردّ بالبطاقة **يتجسّد** (يُنقص `paidAmount` ويُرحَّل PAYMENT_OUT) ولا يمسّ درجاً
 *      (`cashBucket = NULL`) ⇒ لا أثر كاذب على `expectedCash` وZ-report.
 *   ③ الردّ بالبطاقة يلزمه **مرجع الجهاز** (إثباتٌ لا إقفال).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { returnSale } from "../returnService";
import { loadRefundCaps } from "../returns/refundCaps";
import { createSale } from "../saleService";
import { getShiftReport } from "../shiftService";

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

/** بيعٌ نقديّ ثمّ إعادة وسم إيصال القبض بطاقةً — يحاكي فاتورة بطاقةٍ لزبونٍ عابر بلا فتح مسار قبضٍ حيّ. */
async function sellPaidByCard(shiftId: number, qty: number) {
  const sale = await createSale(
    {
      branchId: 1, shiftId, sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }],
      payment: { amount: `${qty * 10}.00`, method: "CASH" },
    },
    cashier,
  );
  await db().update(s.receipts)
    .set({ paymentMethod: "CARD", cashBucket: null, referenceNumber: "CARD-IN-1" })
    .where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "IN")));
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
  return { invoiceId: sale.invoiceId, itemId: Number(item.id) };
}

async function outReceipts(invoiceId: number) {
  return db().select().from(s.receipts).where(and(
    eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT"),
  ));
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("سقوف الردّ — الوعاء عابرٌ للطرق", () => {
  it("فاتورةُ بطاقةٍ لزبونٍ عابر: سقف النقد = سقف البطاقة = المقبوض (كان صفراً ⇒ لا مسار)", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId } = await sellPaidByCard(shift, 5); // 50.00 بالبطاقة

    const caps = await loadRefundCaps(db(), invoiceId);
    expect(caps.pool.toFixed(2)).toBe("50.00");
    expect(caps.capByMethod.get("CASH")!.toFixed(2)).toBe("50.00");
    expect(caps.capByMethod.get("CARD")!.toFixed(2)).toBe("50.00");
    // الإفصاح يبقى صادقاً: لم يُقبض نقداً شيء (يشرح للموظف مصدر المال).
    expect(caps.netByMethod.get("CASH")!.toFixed(2)).toBe("0.00");
    expect(caps.netByMethod.get("CARD")!.toFixed(2)).toBe("50.00");
  });

  it("ردٌّ نقديّ لفاتورة بطاقة: يخرج من الدرج المحدَّد ويظهر في Z-report صاحبه", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId, itemId } = await sellPaidByCard(shift, 5);

    await returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 5 }],
        refund: { amount: "50.00", method: "CASH", shiftId: shift },
        restock: true,
      },
      manager,
    );

    const [out] = await outReceipts(invoiceId);
    expect(out.paymentMethod).toBe("CASH");
    expect(out.cashBucket).toBe("DRAWER");
    expect(out.status).toBe("COMPLETED");
    const report = await getShiftReport(shift);
    const cashOut = (report?.payments ?? []).find((p) => p.method === "CASH" && p.direction === "OUT");
    expect(Number(cashOut?.total ?? 0)).toBeCloseTo(50, 2);
  });

  it("الوعاء يمنع الاسترداد المزدوج: ردٌّ نقديّ ثمّ محاولةُ ردٍّ بالبطاقة على ما تبقّى", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId, itemId } = await sellPaidByCard(shift, 10); // 100.00 بالبطاقة

    // مرتجعٌ جزئيّ ٥ قطع (50.00) نقداً ⇒ يستهلك نصف الوعاء.
    await returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 5 }],
        refund: { amount: "50.00", method: "CASH", shiftId: shift },
        restock: true,
      },
      manager,
    );

    const caps = await loadRefundCaps(db(), invoiceId);
    expect(caps.pool.toFixed(2)).toBe("50.00");
    // لولا حدّ الوعاء لبقي سقف البطاقة 100.00 (رافدُ قبضها لم يُمَسّ) ⇒ استردادٌ مزدوج.
    expect(caps.capByMethod.get("CARD")!.toFixed(2)).toBe("50.00");

    await expect(returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 5 }],
        refund: { amount: "60.00", method: "CARD", reference: "TERM-9" },
        restock: true,
      },
      manager,
    )).rejects.toThrowError(/يتجاوز المسموح/);
  });
});

describe("الردّ بالبطاقة — إثباتٌ لا إقفال، وأثرٌ حقيقيّ لا سندٌ معلَّق", () => {
  it("بلا مرجع الجهاز يُرفض", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId, itemId } = await sellPaidByCard(shift, 5);

    await expect(returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 5 }],
        refund: { amount: "50.00", method: "CARD" },
        restock: true,
      },
      manager,
    )).rejects.toThrowError(/مرجع العملية من جهاز الدفع/);

    expect(await outReceipts(invoiceId)).toHaveLength(0); // صفر أثر عند الرفض.
  });

  it("بمرجعٍ صحيح: إيصالٌ منفَّذٌ بلا دلو، يُنقص المقبوض، ولا يمسّ الدرج", async () => {
    const shift = await openShiftFor(2, "1000.00");
    const { invoiceId, itemId } = await sellPaidByCard(shift, 5);

    const res = await returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 5 }],
        refund: { amount: "50.00", method: "CARD", reference: "TERM-REFUND-77" },
        restock: true,
      },
      manager,
    );
    // لم يعد «معلَّقاً»: المال خرج فعلاً على الجهاز.
    expect(res.pendingRefundAmount).toBe("0.00");
    expect(res.pendingRefundVoucherNumber).toBeNull();

    const [out] = await outReceipts(invoiceId);
    expect(out.paymentMethod).toBe("CARD");
    expect(out.status).toBe("COMPLETED");
    expect(out.approvalStatus).toBe("APPROVED");
    expect(out.cashBucket).toBeNull(); // ② لا يمسّ درجاً
    expect(out.referenceNumber).toBe("TERM-REFUND-77");

    // يتجسّد: المقبوض يعود صفراً (لا يبقى 50 كأنّ المال لم يخرج).
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(Number(inv.paidAmount)).toBeCloseTo(0, 2);

    // قيدُ PAYMENT_OUT مُرحَّل — لا استردادٌ بلا قيدٍ مصنَّف.
    const entries = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, invoiceId),
      eq(s.accountingEntries.entryType, "PAYMENT_OUT"),
    ));
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amount)).toBeCloseTo(50, 2);

    // ولا أثر على درج الوردية (Z-report النقديّ نظيف).
    const report = await getShiftReport(shift);
    expect((report?.payments ?? []).some((p) => p.method === "CASH" && p.direction === "OUT")).toBe(false);
  });
});
