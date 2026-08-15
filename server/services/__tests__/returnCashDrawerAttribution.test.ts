/**
 * إسناد الاسترداد النقدي للمرتجع إلى الدرج الفعليّ — لا وردية الفاعل بالضرورة (بلاغ مالك ٢/٨/٢٦).
 *
 * المشكلة: `returns.create` صلاحية مدير (salesManagerProcedure) — مُنفِّذ المرتجع غالباً شخصٌ مختلف
 * عن الكاشير الذي يُشغّل الدرج الذي سيخرج منه النقد فعلياً. قبل هذا الإصلاح كان الاسترداد النقدي
 * يُنسَب لوردية *الفاعل* نفسه (openShiftIdTx) — فإن خلَت (المدير بلا وردية) رُفض الاسترداد كاملاً
 * رغم أنّ درج الكاشير جاهز، وإن كانت للمدير وردية خاصّة منفصلة (احتساب/استقبال) انتسب الاسترداد إليها
 * فاختفى من Z-report صاحب الدرج الحقيقيّ ⇒ عجزٌ لا يفهم الكاشير سببه عند إغلاق ورديته.
 *
 * الحلّ (resolveBranchCashShiftTx في shiftService.ts): نبحث في ورديات *الفرع* المفتوحة كلّها —
 * درجٌ واحدٌ مفتوح ⇒ يُستعمَل تلقائياً (بلا احتكاك)، تعدّدٌ ⇒ يتطلّب refund.shiftId صريحاً.
 *
 * حدّ الدرج (متابعة بلاغ المالك — «لا عجز أثناء العمل»): سقف الفاتورة (refundCap، موجودٌ أصلاً)
 * يضمن فقط أنّ المسترَد ≤ ما دُفع بهذه الطريقة على *هذه الفاتورة تحديداً* — لا يضمن أنّ الدرج
 * المستهدَف يحمل هذا المبلغ *الآن* (سحبٌ نقديّ/مصروفٌ آخر في نفس الوردية قد يكون أنقصه). أضفنا فحصاً
 * ثانياً (نمط cashDropService: currentDrawerCash ≥ المطلوب) يرفض الاسترداد *أثناء* تنفيذه لا أن
 * يظهر عجزٌ لاحقاً عند إغلاق الوردية فقط.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { getShiftReport, resolveBranchCashShiftTx } from "../shiftService";
import { withTx } from "../tx";

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
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مديرة الفرع", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "cashier1", name: "كاشير أحمد", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

async function openShiftFor(userId: number, branchId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return extractInsertId(r);
}

/** بيع نقديّ كامل لقطعة واحدة (١٠.٠٠) من الفرع ١، على وردية shiftId، بفاعل الكاشير. */
async function sellOneCash(shiftId: number) {
  await setStock(1, 1, 10);
  const sale = await createSale(
    {
      branchId: 1,
      shiftId,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "10.00", method: "CASH" },
    },
    cashier,
  );
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
  return { invoiceId: sale.invoiceId, itemId: Number(item.id) };
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("returnSale — إسناد الاسترداد النقدي لدرج الفرع الفعليّ (لا وردية الفاعل)", () => {
  it("المديرة بلا وردية + وردية الكاشير هي الوحيدة المفتوحة ⇒ الاسترداد يُنسَب لها تلقائياً (لا رفض)", async () => {
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift);

    // قبل الإصلاح: openShiftIdTx(actor=المديرة) يُعيد null (لا وردية لها) ⇒ PRECONDITION_FAILED.
    await returnSale(
      { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } },
      manager,
    );

    const report = await getShiftReport(cashierShift);
    const cashOut = (report?.payments ?? []).find((p) => p.method === "CASH" && p.direction === "OUT");
    expect(Number(cashOut?.total ?? 0)).toBeCloseTo(10, 2); // ظهر في Z-report صاحب الدرج الحقيقيّ.
  });

  it("وردية خاصّة للمديرة + وردية الكاشير مفتوحتان معاً ⇒ الاسترداد بلا تحديد صريح يُرفَض (تعدّد الدرج)", async () => {
    const mgrShift = await openShiftFor(1, 1);
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift);

    await expect(
      returnSale(
        { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } },
        manager,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // صفر أثر: لا إيصال أُنشئ على أيّ من الدرجين.
    const mgrReport = await getShiftReport(mgrShift);
    expect((mgrReport?.payments ?? []).some((p) => p.direction === "OUT" && p.method === "CASH")).toBe(false);
  });

  it("تعدّد الدرج + refund.shiftId صريح لوردية الكاشير ⇒ ينجح وينتسب لها لا لوردية المديرة", async () => {
    const mgrShift = await openShiftFor(1, 1);
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift);

    await returnSale(
      {
        invoiceId,
        lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
        refund: { amount: "10.00", method: "CASH", shiftId: cashierShift },
      },
      manager,
    );

    const cashierReport = await getShiftReport(cashierShift);
    const mgrReport = await getShiftReport(mgrShift);
    const outOnCashier = (cashierReport?.payments ?? []).find((p) => p.method === "CASH" && p.direction === "OUT");
    const outOnMgr = (mgrReport?.payments ?? []).some((p) => p.method === "CASH" && p.direction === "OUT");
    expect(Number(outOnCashier?.total ?? 0)).toBeCloseTo(10, 2);
    expect(outOnMgr).toBe(false); // لم يَنتسب خطأً لوردية المديرة رغم أنها الفاعلة.
  });

  it("refund.shiftId صريح لا يخصّ الفرع/غير مفتوح ⇒ يُرفَض", async () => {
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift);

    await expect(
      returnSale(
        {
          invoiceId,
          lines: [{ invoiceItemId: itemId, baseQuantity: 1 }],
          refund: { amount: "10.00", method: "CASH", shiftId: 999999 },
        },
        manager,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("لا وردية مفتوحة بالفرع إطلاقاً ⇒ الاسترداد النقدي يُرفَض (مطابقٌ لسلوك G9 السابق)", async () => {
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift);
    await db().update(s.shifts).set({ status: "CLOSED" }).where(eq(s.shifts.id, cashierShift));

    await expect(
      returnSale(
        { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } },
        manager,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("الدرج استُنزف بمصروفٍ سابق في نفس الوردية ⇒ استرداد يتجاوز المتاح حالياً يُرفَض (لا عجز أثناء العمل)", async () => {
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift); // بيع نقديّ ١٠.٠٠ على هذا الدرج
    // مصروفٌ نقديّ لاحق (بلا علاقة بهذه الفاتورة) يستنزف الدرج تقريباً بالكامل — يحاكي سحباً/مصروفاً
    // وقع قبل محاولة الاسترداد. سقف الفاتورة (refundCap) وحده لا يرصد هذا (invoiceId مختلف).
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: cashierShift,
      direction: "OUT",
      amount: "9.00",
      paymentMethod: "CASH",
      cashBucket: "DRAWER",
      status: "COMPLETED",
      createdBy: 2,
    });
    // المتاح الآن = ١٠.٠٠ − ٩.٠٠ = ١.٠٠، لكن المرتجع يطلب كامل قيمة الفاتورة (١٠.٠٠).
    await expect(
      returnSale(
        { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } },
        manager,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // صفر أثر: لا مخزون تحرّك ولا قيد RETURN كُتب (الرفض قبل أي كتابة تُلمَس بصرياً هنا خارج الفحص التالي).
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, itemId)))[0];
    expect(item.returnedBaseQuantity).toBe(0);
  });

  it("الدرج يحمل ما يكفي (مبيعاتٌ إضافية في نفس الوردية) ⇒ الاسترداد الكامل ينجح رغم مصروفٍ جزئيّ", async () => {
    const cashierShift = await openShiftFor(2, 1);
    const { invoiceId, itemId } = await sellOneCash(cashierShift); // ١٠.٠٠ (يترك ٩ بالمخزون)
    // بيعٌ نقديّ إضافي يرفع رصيد الدرج فيتّسع للاسترداد رغم مصروفٍ سابق.
    await createSale(
      { branchId: 1, shiftId: cashierShift, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], payment: { amount: "10.00", method: "CASH" } },
      cashier,
    );
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: cashierShift, direction: "OUT", amount: "5.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", createdBy: 2,
    });
    // المتاح الآن = ١٠+١٠−٥ = ١٥.٠٠ — يكفي استرداد ١٠.٠٠ بالكامل.
    await returnSale(
      { invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 1 }], refund: { amount: "10.00", method: "CASH" } },
      manager,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, itemId)))[0];
    expect(item.returnedBaseQuantity).toBe(1);
  });
});

describe("resolveBranchCashShiftTx", () => {
  it("وردية واحدة مفتوحة بالفرع ⇒ تُستعمل تلقائياً (مع openingBalance)", async () => {
    const id = await openShiftFor(2, 1);
    const resolved = await withTx((tx) => resolveBranchCashShiftTx(tx, 1, null));
    expect(resolved.shiftId).toBe(id);
    expect(resolved.openingBalance).toBe("0.00");
  });

  it("صفر ورديات مفتوحة بالفرع ⇒ يرمي PRECONDITION_FAILED", async () => {
    await expect(withTx((tx) => resolveBranchCashShiftTx(tx, 1, null))).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("ورديتان مفتوحتان بلا تحديد صريح ⇒ يرمي PRECONDITION_FAILED", async () => {
    await openShiftFor(1, 1);
    await openShiftFor(2, 1);
    await expect(withTx((tx) => resolveBranchCashShiftTx(tx, 1, null))).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("ورديتان + تحديدٌ صريح صالح ⇒ يُستعمَل بعينه", async () => {
    await openShiftFor(1, 1);
    const id2 = await openShiftFor(2, 1);
    const resolved = await withTx((tx) => resolveBranchCashShiftTx(tx, 1, id2));
    expect(resolved.shiftId).toBe(id2);
  });

  it("تحديدٌ صريح لوردية مفتوحة في فرعٍ آخر ⇒ يرمي (لا يعبُر عزل الفرع)", async () => {
    const otherBranchShift = await openShiftFor(2, 2);
    await expect(
      withTx((tx) => resolveBranchCashShiftTx(tx, 1, otherBranchShift)),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
