/**
 * ملاحظات مراجعة PR #495 — اختبارات انحدارٍ لكلّ إصلاح (ثابتٌ لكلّ ملاحظة).
 *
 *  R1 — عزل الفرع: كاشير فرعٍ لا يُرجع إرسالية فرعٍ آخر (كانت البوّابة بلا فحص ملكية).
 *  R2 — أمانة الأجرة لا تُصرف قبل التسليم وتُردّ مرّةً واحدة عند إرجاع الطرد.
 *  R3 — سقف عهدة المندوب يُنفَّذ على مسار **أمر الشغل** أيضاً (كان في مسار الفاتورة وحده).
 *  R4 — تقريب السلّة المختلطة يُشتقّ خادمياً: مبلغٌ عميليٌّ منخفض لا يخلق خصماً غير معتمد.
 *  R5 — مواد أمر الشغل من المسوّدة بالوحدة الأساس (× معامل التحويل)، والخدمة بلا مواد.
 *  R6 — ردّ حصص العربون النقدية لا يُضاعف خصم الدرج (رفضٌ زائف من الحصّة الثانية).
 *  R7 — بعد ردّ العربون كاملاً يعود حذف السطر ممكناً (moneyLocked اللاصق لم يعُد يقفله).
 *  R8 — رصيد زين أصلٌ في المركز المالي، وعربون المسوّدة المفتوحة التزامٌ مقابله.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { returnConsignment } from "../delivery/returns";
import { dispatchToDelivery } from "../delivery/dispatch";
import { getFinancialPosition } from "../reportsFinancialService";
import { collectDeposit, refundAppliedCollectionsForWorkOrder, refundDeposit } from "../reception/deposits";
import { promoteDraft, syncDraft } from "../reception/draft";
import { commitDraft } from "../reception/commit";
import { createWorkOrder } from "../workOrder/create";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";

const TABLES = [
  "deliveryRemittances", "deliveryConsignments", "deliveryParties",
  "orderPayments", "receptionDraftLines", "receptionDrafts", "auditLogs",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const CASHIER_B2 = { userId: 3, branchId: 2, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

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

/** فرعان + مندوبان + صنفٌ بوحدتين (قطعة/درزن ×١٢) + خدمة كتالوجية بلا مخزون. */
async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف ١", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "rc2", name: "موظف ٢", email: "r2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([
    { id: 1, name: "دفتر" },
    { id: 2, name: "تغليف حراريّ", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" },
    { id: 2, productId: 2, sku: "SV-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: 12, isBaseUnit: false },
    { id: 3, variantId: 2, unitName: "خدمة", conversionFactor: 1, isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "11000.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "3000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 500 },
    { variantId: 1, branchId: 2, quantity: 500 },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب الرئيسي", partyType: "INDIVIDUAL", branchId: 1, defaultFee: "5000.00", currentBalance: "0.00" },
    { id: 2, name: "مندوب المبيعات", partyType: "INDIVIDUAL", branchId: 2, defaultFee: "5000.00", currentBalance: "0.00" },
  ]);
}
const openReception = (userId: number, branchId: number) =>
  openShift({ branchId, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId });

const LINE = { variantId: 1, productUnitId: 1, quantity: "10" }; // ١٠٬٠٠٠

beforeEach(async () => {
  await reset();
  await seed();
});

describe("R1 — عزل الفرع في إرجاع الإرسالية", () => {
  it("كاشير الفرع ٢ لا يُرجع إرسالية الفرع ١ (FORBIDDEN)، وكاشير فرعها يُرجعها", async () => {
    const shift = await openReception(2, 1);
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "r1-scope",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const cn = (await db().select().from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.invoiceId, r.regularSale!.invoiceId)))[0];

    await expect(returnConsignment(Number(cn.id), { ...CASHIER_B2, clientRequestId: "r1-x" } as never))
      .rejects.toThrowError(/فرعاً آخر/);
    // ولا كتابةَ وقعت: الإرسالية ما زالت نافذة، ولا عهدة نقدية قبل إثبات التسليم.
    const still = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, Number(cn.id))))[0];
    expect(still.status).toBe("DISPATCHED");
    expect(Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance)).toBe(0);

    const ok = await returnConsignment(Number(cn.id), { ...CASHIER, clientRequestId: "r1-ok" } as never);
    expect(ok.reversed).toBe(true);
  });
});

describe("R2 — أمانة أجرة التوصيل لا تُصرف قبل التسليم ولا تُردّ مرّتين", () => {
  it("أجرة COUNTER تبقى أمانة عند الإسناد ثم تُردّ للزبون مرّةً واحدة عند الإرجاع", async () => {
    const shift = await openReception(2, 1);
    // فاتورة COD (تُدفَع عند الاستلام) + أجرةٌ قُبضت أمانةً في الاستقبال ولم يكتسبها المندوب بعد.
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      deliveryFeeHeld: "5000.00",
      clientRequestId: "r2-fee",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "5000.00", feeCollection: "COUNTER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    expect(cn.status).toBe("DISPATCHED");
    expect(cn.feeSettledAt).toBeNull();

    const outsBefore = (await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT"),
    ))).length;
    expect(outsBefore).toBe(0); // لا صرف قبل ثبوت التسليم

    const res = await returnConsignment(Number(cn.id), { ...CASHIER, clientRequestId: "r2-ret" } as never);
    expect((res as { feeAlreadyPaidToCourier?: boolean }).feeAlreadyPaidToCourier).toBe(false);

    // سند واحد فقط يردّ الأمانة للزبون، ولا يوجد أي صرف سابق للمندوب.
    const outs = await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT"),
    ));
    expect(outs.length).toBe(1);
    expect(outs.some((o) => String(o.referenceNumber ?? "") === `DLV-FEE-INV-${invoiceId}`)).toBe(true);

    // ثابت الأمانة: Σ(DELIVERY_FEE_HELD) = صفر (قبضٌ + صرفٌ)، لا −الأجرة.
    const held = (await db().select({ v: sql<string>`COALESCE(SUM(${s.accountingEntries.amount}), 0)` })
      .from(s.accountingEntries)
      .where(and(
        eq(s.accountingEntries.entryType, "DELIVERY_FEE_HELD"),
        eq(s.accountingEntries.invoiceId, invoiceId),
      )))[0];
    expect(Number(held?.v ?? 0)).toBe(0);
  });

  it("أمانةٌ لم تُصرف بعد ⇒ تُردّ للزبون عند الإرجاع كما كانت (حالة تاريخية)", async () => {
    const shift = await openReception(2, 1);
    // ٩/٨: التقاط أمانةٍ مع توصيل COURIER صار **مرفوضاً خادمياً** (أمانة يتيمة لا مسار تبرئة
    // لها إن نجح التوصيل — المندوب يقبض أجرته من الزبون ثانيةً). سلوك الردّ في returns.ts يبقى
    // ضرورياً للبيانات التاريخية السابقة للحارس ⇒ نبنيها مباشرةً في القاعدة كما كانت تُكتب.
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "r2-unsettled",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const legacyFee = await db().insert(s.receipts).values({
      branchId: 1, shiftId: shift.shiftId, invoiceId, direction: "IN", amount: "4000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED", partyType: "OTHER",
      referenceNumber: `DLV-FEE-INV-${invoiceId}`,
      description: "أجرة توصيل مقبوضة أمانةً (بيانات تاريخية)", createdBy: 2,
    });
    await db().insert(s.accountingEntries).values({
      entryType: "DELIVERY_FEE_HELD", dedupeKey: `DELIVERY_FEE_HELD:INV:${invoiceId}`,
      branchId: 1, invoiceId, receiptId: extractInsertId(legacyFee),
      amount: "4000.00",
      entryDate: sql`CURDATE()` as unknown as string,
      notes: "أمانة أجرة توصيل — تاريخية",
    });
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    expect(cn.feeSettledAt).toBeNull();

    await returnConsignment(Number(cn.id), { ...CASHIER, clientRequestId: "r2-u-ret" } as never);
    const feeOut = (await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, invoiceId),
      eq(s.receipts.direction, "OUT"),
      eq(s.receipts.referenceNumber, `DLV-FEE-INV-${invoiceId}`),
    )))[0];
    expect(feeOut).toBeTruthy();
    expect(String(feeOut.amount)).toBe("4000.00");
  });
});

describe("R3 — سقف عهدة المندوب على مسار أمر الشغل", () => {
  it("أمرُ شغلٍ جاهزٌ يتجاوز سقف المندوب ⇒ يُرفض بلا فاتورةٍ يتيمة", async () => {
    await db().update(s.deliveryParties).set({ floatLimit: "5000.00" }).where(eq(s.deliveryParties.id, 1));
    const shift = await openReception(2, 1);
    const wo = await createWorkOrder({
      branchId: 1, title: "لوحة مخصّصة", quantity: 1, materials: [],
      laborCost: "0", salePrice: "20000.00", deposit: "0",
      hasDelivery: true, deliveryAddress: "بغداد", shiftId: shift.shiftId,
    } as never, CASHIER as never);
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, Number(wo.workOrderId)));

    const invoicesBefore = (await db().select().from(s.invoices)).length;
    await expect(dispatchToDelivery({ workOrderId: Number(wo.workOrderId), partyId: 1, deliveryFee: "0" }, CASHIER as never))
      .rejects.toThrowError(/يتجاوز السقف/);
    // الرفض قبل أيّ كتابة ⇒ لا فاتورة ولا إرسالية ولا عهدة.
    expect((await db().select().from(s.invoices)).length).toBe(invoicesBefore);
    expect((await db().select().from(s.deliveryConsignments)).length).toBe(0);
    expect(Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance)).toBe(0);
  });
});

describe("R4 — تقريب السلّة المختلطة مُشتقٌّ خادمياً", () => {
  it("مبلغُ بيعٍ عميليٌّ منخفضٌ بـ٢٤٩ لا يصير خصماً — الخادم يعتمد أسطره وفرق التقريب وحده", async () => {
    const shift = await openReception(2, 1);
    // سلّة مختلطة: بضاعة ١٠٬٠٠٠ + أمر شغل ٥٠٥٠ ⇒ الخام ١٥٬٠٥٠، المقرَّب ١٥٬٠٠٠ (فرق −٥٠).
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      // المدفوع = مجموع ما ادّعاه العميل (٩٬٧٥١ + ٥٬٠٥٠) كي يمرّ حارس «يتجاوز إجمالي الطلب».
      paymentMethod: "CASH", paidAmount: "14801.00",
      cashRoundingOverride: "SALE",
      clientRequestId: "r4-round",
      // العميل يرسل مبلغاً مُخفَّضاً زوراً (٩٬٧٥١ بدل ٩٬٩٥٠) — يجب ألّا يؤثّر على إجمالي الفاتورة.
      regularSale: { lines: [LINE], amount: "9751.00" },
      workOrders: [{
        title: "تخصيص", quantity: 1, materials: [], laborCost: "0",
        salePrice: "5050.00", deposit: "0",
      }] as never,
    }, CASHIER);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.regularSale!.invoiceId)))[0];
    // الفاتورة = أسطرها الخادمية (١٠٬٠٠٠) + فرق تقريب السلّة المشتقّ (−٥٠) = ٩٬٩٥٠ — لا ٩٬٧٥١.
    expect(String(inv.total)).toBe("9950.00");
    // والنقص (١٩٩) يظهر **ذمّةً مرئية** لا خصماً صامتاً — «لا دينار بلا مسار وتبويب».
    expect(String(inv.paidAmount)).toBe("9751.00");
    expect(inv.status).not.toBe("PAID");
  });
});

describe("R5 — مواد أمر الشغل من المسوّدة بالوحدة الأساس", () => {
  it("درزنان (معامل ١٢) ⇒ استهلاك ٢٤ وحدةً أساس لا ٢، والخدمة الكتالوجية بلا مواد", async () => {
    const shift = await openReception(2, 1);
    const draft = await promoteDraft({
      branchId: 1,
      header: { customerId: null, contactName: "زبون", contactPhone: null, priceTier: "RETAIL", channel: "WALK_IN" },
      lines: [
        { lineKind: "CUSTOM", sortOrder: 0, variantId: 1, productUnitId: 2, quantity: "2", unitPrice: "11000.00", title: "دفاتر مخصّصة" },
        { lineKind: "CUSTOM", sortOrder: 1, variantId: 2, productUnitId: 3, quantity: "1", unitPrice: "3000.00", title: "تغليف" },
      ],
    } as never, CASHIER as never);

    const res = await commitDraft({
      draftId: draft.draftId, version: draft.version,
      expectedTotal: "25000.00", shiftId: shift.shiftId,
      collectNow: { amount: "25000.00", method: "CASH" },
    } as never, CASHIER as never);
    expect(res.workOrders.length).toBe(2);

    const mats = await db().select().from(s.workOrderMaterials);
    // أمر الدفاتر: ٢ درزن × ١٢ = ٢٤ وحدة أساس.
    const notebookMat = mats.find((m) => Number(m.variantId) === 1);
    expect(notebookMat).toBeTruthy();
    expect(Number(notebookMat!.baseQuantity)).toBe(24);
    // الخدمة الكتالوجية: لا صفَّ مادةٍ إطلاقاً (لا مخزون لها).
    expect(mats.some((m) => Number(m.variantId) === 2)).toBe(false);
  });
});

describe("R6 — ردّ حصص العربون النقدية لا يُضاعف خصم الدرج", () => {
  it("درجٌ فيه ١٠٠٬٠٠٠ وردّان ٤٠٬٠٠٠ ⇒ يمرّان معاً (كان الثاني يُرفض زوراً)", async () => {
    const shift = await openReception(2, 1);
    // مسوّدة بأمرَي شغل + عربونان نقديّان يُطبَّقان عليهما عند التثبيت.
    const draft = await promoteDraft({
      branchId: 1,
      header: { customerId: null, contactName: "زبون", contactPhone: null, priceTier: "RETAIL", channel: "WALK_IN" },
      lines: [
        { lineKind: "CUSTOM", sortOrder: 0, variantId: null, productUnitId: null, quantity: "1", unitPrice: "40000.00", title: "عمل ١" },
        { lineKind: "CUSTOM", sortOrder: 1, variantId: null, productUnitId: null, quantity: "1", unitPrice: "40000.00", title: "عمل ٢" },
      ],
    } as never, CASHIER as never);
    await collectDeposit({ draftId: draft.draftId, amount: "80000.00", method: "CASH", clientRequestId: "r6-dep" }, CASHIER as never);
    // نقدٌ إضافيّ في الدرج كي يكفي الردّان مجتمعَين (٨٠٬٠٠٠) بلا فائض وهميّ.
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: shift.shiftId, direction: "IN", amount: "20000.00",
      paymentMethod: "CASH", cashBucket: "DRAWER", status: "COMPLETED",
      referenceNumber: "SEED-CASH", createdBy: 2,
    });
    const committed = await commitDraft({
      draftId: draft.draftId, version: 0,
      expectedTotal: "80000.00", shiftId: shift.shiftId,
    } as never, CASHIER as never);
    expect(committed.workOrders.length).toBe(2);

    // ردّ حصص العربون لأمرٍ واحد ثم الآخر — كلاهما ٤٠٬٠٠٠ من نفس الدرج.
    for (const w of committed.workOrders) {
      const out = await withTx((tx) => refundAppliedCollectionsForWorkOrder(tx, {
        workOrderId: w.workOrderId, branchId: 1, customerId: null,
        actor: CASHIER as never, refundShiftId: shift.shiftId,
      }));
      expect(Number(out.refunded)).toBe(40000);
    }
  });
});

describe("R7 — حذف السطر بعد ردّ العربون كاملاً", () => {
  it("عربونٌ قُبض ثم رُدَّ بالكامل ⇒ إزالة سطرٍ خاطئ تُقبل (moneyLocked يبقى للتدقيق)", async () => {
    const shift = await openReception(2, 1);
    const draft = await promoteDraft({
      branchId: 1,
      header: { customerId: null, contactName: "زبون", contactPhone: null, priceTier: "RETAIL", channel: "WALK_IN" },
      lines: [
        { lineKind: "CUSTOM", sortOrder: 0, variantId: null, productUnitId: null, quantity: "1", unitPrice: "30000.00", title: "عمل" },
        { lineKind: "CUSTOM", sortOrder: 1, variantId: null, productUnitId: null, quantity: "1", unitPrice: "10000.00", title: "بند خاطئ" },
      ],
    } as never, CASHIER as never);
    const dep = await collectDeposit({ draftId: draft.draftId, amount: "10000.00", method: "CASH", clientRequestId: "r7-dep" }, CASHIER as never);

    // قبل الردّ: الحذف ممنوع (المال على السلّة بعينها).
    await expect(syncDraft({
      draftId: draft.draftId, version: 0,
      header: { customerId: null, contactName: "زبون", contactPhone: null, priceTier: "RETAIL", channel: "WALK_IN" },
      lines: [{ lineKind: "CUSTOM", sortOrder: 0, variantId: null, productUnitId: null, quantity: "1", unitPrice: "30000.00", title: "عمل" }],
    } as never, CASHIER as never)).rejects.toThrowError(/لا يُحذف بندٌ/);

    await refundDeposit({ paymentId: dep.paymentId, amount: "10000.00", reason: "خطأ إدخال", clientRequestId: "r7-ref" }, CASHIER as never);

    // بعد الردّ الكامل: heldNet = 0 ⇒ الحذف مسموح، والعَلَم اللاصق باقٍ للتدقيق.
    const after = await syncDraft({
      draftId: draft.draftId, version: 0,
      header: { customerId: null, contactName: "زبون", contactPhone: null, priceTier: "RETAIL", channel: "WALK_IN" },
      lines: [{ lineKind: "CUSTOM", sortOrder: 0, variantId: null, productUnitId: null, quantity: "1", unitPrice: "30000.00", title: "عمل" }],
    } as never, CASHIER as never);
    expect(after.version).toBe(1);
    const row = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, draft.draftId)))[0];
    expect(row.moneyLocked).toBe(true);
    void shift;
  });
});

describe("R8 — المركز المالي: رصيد زين أصلٌ، وعربون المسوّدة المفتوحة التزام", () => {
  it("قبضُ عربونٍ برصيد زين ⇒ أصلٌ ظاهر + التزامٌ مقابله ⇒ حقوق الملكية لا تتضخّم", async () => {
    const shift = await openReception(2, 1);
    const draft = await promoteDraft({
      branchId: 1,
      header: { customerId: null, contactName: "زبون", contactPhone: null, priceTier: "RETAIL", channel: "WALK_IN" },
      lines: [{ lineKind: "CUSTOM", sortOrder: 0, variantId: null, productUnitId: null, quantity: "1", unitPrice: "50000.00", title: "عمل" }],
    } as never, CASHIER as never);
    const before = await getFinancialPosition({ verify: false });

    await collectDeposit({
      draftId: draft.draftId, amount: "20000.00", method: "TELECOM",
      reference: "ZAIN-123456", clientRequestId: "r8-telecom",
    }, CASHIER as never);

    const pos = await getFinancialPosition({ verify: false });
    expect(Number(pos.telecom)).toBe(20000);        // كان صفراً (غائباً عن التجميع كلّه)
    expect(Number(pos.draftAdvances)).toBe(20000);  // التزامُ سُلفة عميلٍ مقابله
    expect(Number(pos.customerAdvances)).toBeGreaterThanOrEqual(20000);
    // الثابت: الأصلُ والالتزام يتحرّكان معاً ⇒ حقوق الملكية بلا تغيير.
    expect(Number(pos.equity)).toBe(Number(before.equity));
    void shift;
  });
});
