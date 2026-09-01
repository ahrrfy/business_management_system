/**
 * تدقيق جنائيّ (١/٩/٢٦) — بلاغ الموظّفين: «مرتجع الفواتير وهميّ ولا أثر له ويبتلع المخزن».
 *
 * هذه الاختبارات **تُعيد إنتاج البلاغ حرفياً** بدل الاكتفاء بوصفه. كلّ حالةٍ هنا تُثبت سلوكاً
 * قائماً في الشيفرة اليوم — لا سلوكاً مرغوباً. حين يُصلَح المسار، تُقلَب التوقّعات عمداً
 * وتصير هذه الحزمة حارساً على الإصلاح.
 *
 * ⚠️ الفرق الحاسم عن `salesControlRequests.test.ts` القائم: ذلك الملفّ يُهيّئ **مديرَين
 * مستقلَّين** (userId 1 و3) فيجد دائماً مُعتمِداً صالحاً — وهو عالمٌ لا يشبه مكتبةً بفرعين
 * يبيع فيها المدير نفسه. هنا نُهيّئ **العالم الحقيقيّ**: مديرٌ واحد يبيع ويطلب.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { approveSalesControlRequest, rejectSalesControlRequest, requestSalesControl, withdrawSalesControlRequest } from "../sale/controlRequests";
import { returnSaleAsOwner, returnSaleInTx } from "../returnService";
import { withTx } from "../tx";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "salesExchangeCommands", "salesControlRequests", "returnRequests", "idempotencyKeys",
  "auditLogs", "accountingEntries", "receipts", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

/** العالم الحقيقيّ: **مديرٌ واحد** في الفرع، هو نفسه من يبيع ومن يطلب المرتجع. */
const SOLE_MANAGER = { userId: 1, branchId: 1, role: "manager" };
/** أدمن المالك — عابرُ فروعٍ، وهو المخرج الأخير المتوقَّع حين لا يوجد مديرٌ ثانٍ. */
const OWNER_ADMIN = { userId: 4, branchId: 0, role: "admin" };
/** المالك الحقيقيّ (`users.isOwner`) — يُطبَّع إلى role="admin" في context.ts. */
const OWNER = { userId: 5, branchId: 1, role: "admin" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function stockOf(variantId = 1) {
  const row = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, variantId)))[0];
  return Number(row?.quantity ?? 0);
}

beforeEach(async () => {
  const d = db();
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${table}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير الفرع الوحيد", email: "m1@f.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "a1", name: "أدمن (غير مالك)", email: "a1@f.test", role: "admin", loginMethod: "local", branchId: null },
    { id: 5, openId: "o1", name: "المالك", email: "o1@f.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", phone: "+9647701111111", currentBalance: "0.00" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB", costPrice: "400.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, openingBalance: "10000", status: "OPEN" });
});

/** البيع الذي يجريه المدير نفسه — `invoices.createdBy = 1`. */
async function saleByManager() {
  return createSale({
    branchId: 1,
    shiftId: 1,
    sourceType: "POS",
    customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
    payment: { amount: "5000.00", method: "CASH" },
  }, SOLE_MANAGER);
}

describe("تدقيق جنائيّ: «المرتجع وهميّ ويبتلع المخزن»", () => {
  it("returns.create صفريّ الأثر: لا مخزون ولا قيد ولا فاتورة تتحرّك — البضاعة تبقى مخصومة", async () => {
    const created = await saleByManager();
    const stockAfterSale = await stockOf();
    expect(stockAfterSale).toBe(95); // خُصمت 5 عند البيع

    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
    const entriesBefore = (await db().select().from(s.accountingEntries)).length;
    const receiptsBefore = (await db().select().from(s.receipts)).length;

    // هذا **بالضبط** ما تفعله شاشة ReturnComposer عبر returnRouter.create.
    const requested = await requestSalesControl({
      requestKey: "ret-1",
      invoiceId: created.invoiceId,
      requestType: "SALES_RETURN",
      reason: "الزبون أعاد الدفاتر",
      payload: { lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }], restock: true },
    }, SOLE_MANAGER);
    expect(requested.status).toBe("PENDING");

    // البلاغ حرفياً: البضاعة رجعت للرفّ فعلياً، والنظام لا يعرف.
    expect(await stockOf()).toBe(95);
    expect((await db().select().from(s.accountingEntries)).length).toBe(entriesBefore);
    expect((await db().select().from(s.receipts)).length).toBe(receiptsBefore);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0];
    expect(inv.status).toBe("PAID");
    expect(Number(inv.returnedTotal ?? 0)).toBe(0);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, Number(items[0].id))))[0];
    expect(Number(item.returnedBaseQuantity ?? 0)).toBe(0);
  });

  it("⛔ الطريق المسدود: مديرٌ واحد باع وطلب ⇒ لا يعتمد ولا يرفض، والأدمن محجوبٌ أيضاً", async () => {
    const created = await saleByManager();
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
    const payload = { lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }], restock: true };

    const requested = await requestSalesControl({
      requestKey: "ret-deadlock",
      invoiceId: created.invoiceId,
      requestType: "SALES_RETURN",
      reason: "الزبون أعاد الدفاتر",
      payload,
    }, SOLE_MANAGER);

    // (١) الطالب لا يعتمد طلبه — فصل المهام.
    await expect(approveSalesControlRequest(Number(requested.id), SOLE_MANAGER))
      .rejects.toThrow(/لا تراجع طلبك/);
    // (٢) ولا يرفضه ليفتح الطريق — نفس الحارس مطبَّقٌ على الرفض.
    await expect(rejectSalesControlRequest(Number(requested.id), "تراجعتُ عن الطلب", SOLE_MANAGER))
      .rejects.toThrow(/لا تراجع طلبك/);
    // (٣) وأدمن المالك محجوبٌ لأنّه… لا، بل يُحجَب لأنّ الحارس يفحص منشئ الفاتورة والطالب فقط.
    //     الأدمن هنا ليس أيّاً منهما ⇒ يمرّ. نُثبت ذلك صراحةً: **الأدمن هو المخرج الوحيد**.
    const approved = await approveSalesControlRequest(Number(requested.id), OWNER_ADMIN);
    expect(approved.request.status).toBe("APPROVED");
    expect(await stockOf()).toBe(100); // عاد المخزون فعلاً عند الاعتماد
  });

  it("الأدمن هو البائع: لا اعتماد ولا رفض من أحد — والسحبُ هو المخرج الذي يُحرّر الفاتورة", async () => {
    // المالك يبيع بحسابه (أدمن) — وهو الواقع في مكتبةٍ يديرها صاحبها.
    const created = await createSale({
      branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      payment: { amount: "5000.00", method: "CASH" },
    }, OWNER_ADMIN);
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
    const payload = { lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }], restock: true };

    // المدير الوحيد يطلب المرتجع (الأدمن هو منشئ الفاتورة).
    const requested = await requestSalesControl({
      requestKey: "ret-nowayout",
      invoiceId: created.invoiceId,
      requestType: "SALES_RETURN",
      reason: "الزبون أعاد الدفاتر",
      payload,
    }, SOLE_MANAGER);

    // الطالب محجوب (طلبه)، والأدمن محجوب (منشئ الفاتورة) ⇒ **لا أحد في النظام يستطيع**.
    await expect(approveSalesControlRequest(Number(requested.id), SOLE_MANAGER)).rejects.toThrow(/لا تراجع طلبك/);
    await expect(approveSalesControlRequest(Number(requested.id), OWNER_ADMIN)).rejects.toThrow(/منشئ الفاتورة/);
    await expect(rejectSalesControlRequest(Number(requested.id), "أغلقوه", SOLE_MANAGER)).rejects.toThrow(/لا تراجع طلبك/);
    await expect(rejectSalesControlRequest(Number(requested.id), "أغلقوه", OWNER_ADMIN)).rejects.toThrow(/منشئ الفاتورة/);

    // والفهرس الفريد على activeInvoiceId يقفل الفاتورة ضدّ أيّ طلبٍ جديد ما دام الطلب معلّقاً.
    await expect(requestSalesControl({
      requestKey: "ret-nowayout-2",
      invoiceId: created.invoiceId,
      requestType: "SALES_RETURN",
      reason: "محاولة ثانية",
      payload,
    }, SOLE_MANAGER)).rejects.toThrow();

    // ⭐ **المخرج** (هجرة 0319): الطالبُ يسحب طلبه — صفريُّ الأثر، ويُحرّر الفاتورة.
    const withdrawn = await withdrawSalesControlRequest(Number(requested.id), "تعذّر إيجاد مراجعٍ مستقل", SOLE_MANAGER);
    expect(withdrawn.request.status).toBe("WITHDRAWN");
    // صفريّة الأثر محفوظة: لا مخزون ولا حالة فاتورة تتغيّر بالسحب.
    expect(await stockOf()).toBe(95);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0].status).toBe("PAID");

    // والفاتورة تحرّرت فعلاً: طلبٌ جديد يُقبَل الآن (activeInvoiceId صار NULL).
    const retry = await requestSalesControl({
      requestKey: "ret-nowayout-3",
      invoiceId: created.invoiceId,
      requestType: "SALES_RETURN",
      reason: "إعادة الطلب بعد السحب",
      payload,
    }, SOLE_MANAGER);
    expect(retry.status).toBe("PENDING");
  });

  /**
   * قرار المالك (١/٩/٢٦): المالكُ ينفّذ مرتجعَه فوراً بلا دورة اعتماد — فهو مالكُ المخاطرة
   * لا موظّفٌ يُراقَب، وفي مكتبةٍ يديرها صاحبُها لا وجود لمراجعٍ مستقلّ. والاختصارُ في
   * **الحوكمة** لا في المحاسبة: الأثر يمرّ بـ`returnSaleInTx` نفسها بكلّ قيودها.
   */
  it("⭐ المالك ينفّذ المرتجع فوراً: المخزون يعود والقيد يُكتب والفاتورة تُقفَل مرتجعة", async () => {
    const created = await createSale({
      branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      payment: { amount: "5000.00", method: "CASH" },
    }, OWNER);
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
    expect(await stockOf()).toBe(95);

    const out = await returnSaleAsOwner({
      invoiceId: created.invoiceId,
      lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }],
      restock: true,
      refund: { amount: "5000.00", method: "CASH", shiftId: 1 },
      ownerReason: "الزبون أعاد الدفاتر — تنفيذ المالك",
      clientRequestId: "owner-immediate-1",
    }, OWNER);

    // ثلاثةُ آثارٍ معاً — لا واحدٌ منها معلَّق.
    expect(await stockOf()).toBe(100);
    expect(out.fullyReturned).toBe(true);
    const returnEntries = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.invoiceId, created.invoiceId), eq(s.accountingEntries.entryType, "RETURN")));
    expect(returnEntries.length).toBe(1);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, created.invoiceId)))[0];
    expect(inv.status).toBe("RETURNED");
    // النقد خرج بإيصالٍ يمسّ الدرج (لا عجزٌ مكتوم في Z-report).
    const outReceipts = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, created.invoiceId), eq(s.receipts.direction, "OUT")));
    expect(outReceipts.length).toBe(1);
    expect(outReceipts[0].cashBucket).toBe("DRAWER");
  });

  it("المسار الفوريّ محصورٌ بمالكٍ نشط، ويشترط سبباً — لا اختصارَ بلا صفةٍ ولا مستند", async () => {
    const created = await saleByManager();
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
    const base = {
      invoiceId: created.invoiceId,
      lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }],
      restock: true,
    };

    // أدمن **غير مالك** ⇒ FORBIDDEN (إعادة القراءة داخل المعاملة لا رايةُ الجلسة).
    await expect(returnSaleAsOwner({ ...base, ownerReason: "محاولة أدمن", clientRequestId: "o-a" }, OWNER_ADMIN))
      .rejects.toThrow(/محصورٌ بحساب مالكٍ نشط/);
    // ومديرُ الفرع كذلك.
    await expect(returnSaleAsOwner({ ...base, ownerReason: "محاولة مدير", clientRequestId: "o-m" }, SOLE_MANAGER))
      .rejects.toThrow(/محصورٌ بحساب مالكٍ نشط/);
    // وسببٌ أقصر من ٣ أحرف يُرفَض قبل أيّ أثر.
    await expect(returnSaleAsOwner({ ...base, ownerReason: "ok", clientRequestId: "o-r" }, OWNER))
      .rejects.toThrow(/سبب المرتجع إلزاميّ للمالك/);
    // ومالكٌ مُعطَّل لا ينفّذ.
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 5));
    await expect(returnSaleAsOwner({ ...base, ownerReason: "مالكٌ معطَّل", clientRequestId: "o-i" }, OWNER))
      .rejects.toThrow(/محصورٌ بحساب مالكٍ نشط/);

    expect(await stockOf()).toBe(95); // صفر أثرٍ من كل المحاولات المرفوضة
  });

  it("السحب لصاحب الطلب وحده، ولا يُسحَب طلبٌ محسوم", async () => {
    const created = await saleByManager();
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));
    const requested = await requestSalesControl({
      requestKey: "ret-withdraw-authz",
      invoiceId: created.invoiceId,
      requestType: "SALES_RETURN",
      reason: "الزبون أعاد الدفاتر",
      payload: { lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }], restock: true },
    }, SOLE_MANAGER);

    // غيرُ الطالب لا يسحب — مساره الرفض بسببٍ موثَّق.
    await expect(withdrawSalesControlRequest(Number(requested.id), "أغلقه", OWNER_ADMIN))
      .rejects.toThrow(/السحب لصاحب الطلب وحده/);

    await withdrawSalesControlRequest(Number(requested.id), "سحبٌ أوّل", SOLE_MANAGER);
    // تكرارُ السحب بنفس السبب يُعاد تشغيله؛ وبسببٍ مختلف يُرفَض لأنّ الطلب محسوم.
    const replay = await withdrawSalesControlRequest(Number(requested.id), "سحبٌ أوّل", SOLE_MANAGER);
    expect(replay.replayed).toBe(true);
    await expect(withdrawSalesControlRequest(Number(requested.id), "سببٌ آخر", SOLE_MANAGER))
      .rejects.toThrow(/محسوم/);
  });

  /**
   * ⚠️ **عطبٌ كامنٌ لا واقع** — صحّحته مراجعةٌ عدائيّة: فاتورةُ WORKORDER **مختلطة** لا تُنشأ
   * في الإنتاج اليوم. مواضعُ `insert(invoiceItems)` الأربعة كلّها إمّا POS، وإمّا
   * (`workOrder/deliver.ts` و`delivery/dispatch.ts`) تُدرج **بنداً واحداً** هو `wo.baseVariantId`
   * الذي لم يُخصَم من المخزون أصلاً. فالحالة هنا **تركيبيّة** (نصنعها بـUPDATE مباشر).
   * قيمتُها أنّها تُثبّت السلوك: الإجبار على مستوى **الفاتورة** لا السطر ⇒ أوّل بندٍ مخزنيّ
   * يُضاف إلى فاتورة أمر شغل يُبتلَع صامتاً، ويُسكَت اختيار الموظّف بلا رسالة.
   */
  it("عطبٌ كامن: restock مُجبَرٌ على false للفاتورة كلّها لا للسطر — بندٌ مخزنيّ في فاتورة WORKORDER يُبتلَع صامتاً", async () => {
    const created = await saleByManager();
    // حالةٌ تركيبيّة: نحوّل فاتورة POS إلى WORKORDER لنكشف الإجبار على مستوى الفاتورة.
    await db().update(s.invoices).set({ sourceType: "WORKORDER" }).where(eq(s.invoices.id, created.invoiceId));
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, created.invoiceId));

    await withTx((tx) => returnSaleInTx(tx, {
      invoiceId: created.invoiceId,
      lines: [{ invoiceItemId: Number(items[0].id), baseQuantity: 5 }],
      restock: true, // الموظّف اختار «سليمة — تعود للرفّ» صراحةً
    }, SOLE_MANAGER));

    // الخدمة تتجاهل اختياره: الدفاتر لا تعود للمخزون.
    expect(await stockOf()).toBe(95);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, Number(items[0].id))))[0];
    expect(Number(item.returnedBaseQuantity ?? 0)).toBe(5);           // المرتجع سُجِّل
    expect(Number(item.returnedRestockedBaseQuantity ?? 0)).toBe(0);  // لكنّه لم يُعَد للرفّ
  });
});
