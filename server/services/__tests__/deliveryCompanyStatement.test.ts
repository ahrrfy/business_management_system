/**
 * كشف شركة التوصيل — مستند التسوية الموحّد (إطار المالك نسخة ٢، ١٩/٨).
 *
 * العقدة التي يفكّها، مُثبَتةً بالاختبار الأول: التوريد يشترط `parcelStatus = DELIVERED`،
 * وختمُ التسليم حصريٌّ ببوّابة المندوب (عضوية جهةٍ نشطة). وأغلب جهات التوصيل كيانُ بياناتٍ
 * **بلا حساب نظام** ⇒ لا سطر يُختَم مُسلَّماً ⇒ لا توريد ولا أجرة، والمال يعلق بلا مخرج.
 *
 * الثوابت المحروسة هنا:
 *  ① سطر الكشف يقود التسليم والتحصيل والتوريد معاً لجهةٍ **بلا حساب بوّابة**.
 *  ② رقم الكشف فريدٌ لكل جهة ⇒ إعادة إدخاله ترتدّ بدل مضاعفة القيود.
 *  ③ المسار الماليّ **واحد**: نتائج الكشف تطابق نتائج بوّابة المندوب حرفياً (ذمّة العميل
 *     تسقط، عهدة الجهة تُبرَّأ، النقد يدخل الدرج، الفاتورة تُسدَّد).
 *  ④ التحصيل الجزئيّ يُسجَّل كما وقع، والمتبقّي يبقى على العميل لا يُمحى.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { dispatchToDelivery } from "../delivery/dispatch";
import { recordCompanyStatement } from "../delivery/companyStatement";
import { money, round2 } from "../money";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

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
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  // ⭐ شركة توصيل **بلا أيّ حساب بوّابة** — الحالة الواقعية الغالبة التي كانت بلا مخرج.
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "شركة التوصيل السريع", partyKind: "COMPANY", currentBalance: "0.00", isActive: true },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

/** أمر توصيلٍ جاهز بقيمة salePrice، بلا عربون ⇒ كلّه COD على الشركة. */
async function dispatchedOrder(reqId: string, salePrice: string) {
  const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  const r = await checkoutReception({
    branchId: 1, shiftId: shift.shiftId, customerId: 1,
    paidAmount: "0", clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice, materials: [],
      hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567",
    }],
  }, CASHIER);
  const woId = r.workOrders[0].workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  const d = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: `d-${reqId}` }, CASHIER);
  return { workOrderId: woId, shiftId: shift.shiftId, consignmentId: d.consignmentId, invoiceId: d.invoiceId };
}

const balanceOf = async (id: number) =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, id)))[0].currentBalance);
const partyBalance = async () =>
  Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance);
const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];

beforeEach(async () => {
  await reset();
  await seed();
});

describe("كشف شركة التوصيل — الدليل البديل عن بوّابة المندوب", () => {
  it("⭐ شركةٌ بلا حساب بوّابة: الكشف يثبت التسليم ويحصّل ويورّد في عمليةٍ واحدة", async () => {
    const a = await dispatchedOrder("st-1", "20000.00");
    expect(await balanceOf(1)).toBe(20000); // الذمّة على العميل حتى إثبات التحصيل
    expect(await partyBalance()).toBe(0); // لا عهدة نقدية قبل التحصيل

    const res = await recordCompanyStatement({
      branchId: 1, partyId: 1,
      statementNumber: "STMT-2026-08-19-001",
      statementDate: "2026-08-19",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "20000.00" }],
      countedCash: "20000.00",
      clientRequestId: "stmt-req-1",
    }, CASHIER);

    expect(res.deliveriesConfirmed).toBe(1); // الكشف هو ما أثبت التسليم
    expect(res.collectedTotal).toBe("20000.00");

    // الأثر الماليّ كاملاً — مطابقٌ لما تفعله بوّابة المندوب حرفياً:
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    expect(cn.parcelStatus).toBe("DELIVERED");
    expect(cn.moneyStatus).toBe("SETTLED");
    expect(await balanceOf(1)).toBe(0); // ذمّة العميل سقطت
    expect(await partyBalance()).toBe(0); // العهدة ارتفعت ثمّ أُبرئت بالتوريد
    expect((await invoiceOf(a.invoiceId)).status).toBe("PAID");

    // المستند يحمل دليله: رقم الكشف وتاريخه على سند التوريد.
    const rm = (await db().select().from(s.deliveryRemittances))[0];
    expect(rm.companyStatementNumber).toBe("STMT-2026-08-19-001");
    expect(rm.netRemitted).toBe("20000.00");

    // وأثرُ السلطة مدوَّنٌ في حدث التسليم (يُراجَع عند أيّ خلاف).
    const ev = (await db().select().from(s.deliveryEvents)
      .where(eq(s.deliveryEvents.consignmentId, a.consignmentId)))
      .find((e) => e.eventType === "DELIVERED");
    expect(JSON.stringify(ev?.payload ?? {})).toContain("COMPANY_STATEMENT");
  });

  it("⭐ إعادة إدخال الكشف نفسه ترتدّ — لا قيود مضاعفة", async () => {
    const a = await dispatchedOrder("st-2", "15000.00");
    const line = [{ consignmentId: a.consignmentId, collectedAmount: "15000.00" }];

    await recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "DUP-001",
      lines: line, countedCash: "15000.00", clientRequestId: "stmt-req-2a",
    }, CASHIER);

    // مفتاحٌ تقنيّ مختلف عمداً (جهازٌ آخر/جلسةٌ أخرى) — يبقى رقم الكشف هو الحارس.
    await expect(recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "DUP-001",
      lines: line, countedCash: "15000.00", clientRequestId: "stmt-req-2b",
    }, CASHIER)).rejects.toThrowError(/مُسجَّلٌ سلفاً|مسجل سلفا/);

    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(1);
  });

  it("تحصيلٌ جزئيّ: يُسجَّل كما وقع، والمتبقّي يبقى على العميل", async () => {
    const a = await dispatchedOrder("st-3", "20000.00");

    await recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "PART-001",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "12000.00" }],
      countedCash: "12000.00", clientRequestId: "stmt-req-3",
    }, CASHIER);

    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    expect(cn.collectedAmount).toBe("12000.00");
    expect(cn.moneyStatus).toBe("PARTIAL");
    const inv = await invoiceOf(a.invoiceId);
    expect(inv.paidAmount).toBe("12000.00");
    expect(await balanceOf(1)).toBe(8000); // المتبقّي لم يُمحَ — يبقى مطالَباً به
  });

  it("⭐ الاستقطاع نقدٌ لم يدخل الدرج: يُطرح من الصافي ويُقيَّد مصروفاً — بلا مسّ ذمّة العميل", async () => {
    // ٢٠/٨ (تصويب مراجعة Codex): كان هذا الاختبار يُسلّم **كامل** الحصيلة نقداً ويُعلن
    // استقطاعاً ١٥٠٠ في الوقت نفسه — تناقضٌ يُسجّل نقداً لم يدخل الدرج ويترك الاستقطاع
    // خارج الدفتر. والهجرةُ نفسها تعرّفه «أجور التوصيل التي تحسمها الشركة **من الحصيلة**»
    // ⇒ المُسلَّم نقداً هو **الصافي**. والثابتُ الذي يحرسه اسمُ الاختبار باقٍ: ذمّةُ العميل
    // لا تُمَسّ — الاستقطاع مصروفُ شركةٍ لا تخفيضُ مطالبة.
    const a = await dispatchedOrder("st-4", "10000.00");

    await recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "DEDUCT-001",
      deductionsTotal: "1500.00", notes: "أجور توصيل حسمتها الشركة",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "10000.00" }],
      countedCash: "8500.00", clientRequestId: "stmt-req-4",
    }, CASHIER);

    const rm = (await db().select().from(s.deliveryRemittances))[0];
    expect(rm.deductionsTotal).toBe("1500.00");
    expect(rm.notes).toBe("أجور توصيل حسمتها الشركة");
    expect(round2(money(rm.netRemitted)).toFixed(2)).toBe("8500.00");

    // الزبون دفع كامل COD ⇒ ذمّته صفر، والفاتورة مدفوعة — الاستقطاع لا يمسّها.
    expect(await balanceOf(1)).toBe(0);
    expect((await invoiceOf(a.invoiceId)).status).toBe("PAID");

    // ولا يضيع بصمت (§٥): إيصالُ OUT بقيمته + قيدُ مصروفٍ مصنَّف.
    const dedOut = (await db().select().from(s.receipts))
      .filter((r) => r.direction === "OUT" && (r.description ?? "").includes("استقطاع"));
    expect(dedOut).toHaveLength(1);
    expect(round2(money(dedOut[0].amount)).toFixed(2)).toBe("1500.00");
    const expenseEntry = (await db().select().from(s.accountingEntries))
      .filter((e) => (e.dedupeKey ?? "").startsWith("DLV-STMT-DEDUCTION:"));
    expect(expenseEntry).toHaveLength(1);
    expect(round2(money(expenseEntry[0].amount)).toFixed(2)).toBe("1500.00");
  });

  it("استقطاعٌ يتجاوز المُحصَّل يُرفض قبل أيّ كتابة", async () => {
    const a = await dispatchedOrder("st-4b", "5000.00");
    await expect(recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "DEDUCT-TOOBIG",
      deductionsTotal: "6000.00",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "5000.00" }],
      countedCash: "0.00", clientRequestId: "stmt-req-4b",
    }, CASHIER)).rejects.toThrowError(/يتجاوز المُحصَّل/);
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
  });

  it("سطرٌ لجهةٍ أخرى أو فرعٍ آخر ⇒ يُرفض قبل أيّ كتابة", async () => {
    const a = await dispatchedOrder("st-5", "5000.00");
    await db().insert(s.deliveryParties).values([
      { id: 2, name: "جهة أخرى", partyKind: "COMPANY", currentBalance: "0.00", isActive: true },
    ]);

    await expect(recordCompanyStatement({
      branchId: 1, partyId: 2, statementNumber: "WRONG-PARTY",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "5000.00" }],
      countedCash: "5000.00", clientRequestId: "stmt-req-5",
    }, CASHIER)).rejects.toThrowError(/لا تخصّ هذه الجهة|لا تخص هذه الجهة/);

    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
  });
});
