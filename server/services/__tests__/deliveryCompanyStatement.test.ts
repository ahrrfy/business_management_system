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
    { id: 1, name: "شركة التوصيل السريع", partyType: "COMPANY", currentBalance: "0.00", isActive: true },
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
  const d = await dispatchToDelivery({
    workOrderId: woId,
    partyId: 1,
    clientRequestId: `d-${reqId}`,
    externalTrackingRef: `TRACK-${reqId}`,
  }, CASHIER);
  return { workOrderId: woId, shiftId: shift.shiftId, consignmentId: d.consignmentId, invoiceId: d.invoiceId };
}

const balanceOf = async (id: number) =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, id)))[0].currentBalance);
const partyBalance = async () =>
  Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance);
const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];

async function companyStatementStateSnapshot(consignmentId: number, invoiceId: number) {
  const accounting = await db().select().from(s.accountingEntries).orderBy(s.accountingEntries.id);
  return {
    consignment: (await db().select().from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, consignmentId)))[0],
    invoice: await invoiceOf(invoiceId),
    customerBalance: await balanceOf(1),
    partyBalance: await partyBalance(),
    remittances: await db().select().from(s.deliveryRemittances).orderBy(s.deliveryRemittances.id),
    ledger: await db().select().from(s.deliveryLedgerEntries).orderBy(s.deliveryLedgerEntries.id),
    events: await db().select().from(s.deliveryEvents).orderBy(s.deliveryEvents.id),
    idempotency: await db().select().from(s.idempotencyKeys).orderBy(s.idempotencyKeys.id),
    payments: accounting.filter((entry) => entry.entryType === "PAYMENT_IN"),
  };
}

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

  it("⭐ ذرّية الكشف كاملة: فشل مطابقة النقد في آخر المسار يعيد التسليم والتحصيل والقيود كلّها", async () => {
    const a = await dispatchedOrder("st-atomic", "7000.00");
    const beforeAccounting = (await db().select().from(s.accountingEntries)).length;
    const beforeLedger = (await db().select().from(s.deliveryLedgerEntries)).length;
    const beforeEvents = (await db().select().from(s.deliveryEvents)).length;

    // ختمُ التسليم وتحصيلُ الفاتورة يسبقان حارس النقد المعدود منطقياً. تعمّدُ عدم المطابقة
    // يُفشل التوريد في آخر السلسلة، ويجب أن يعيد المعاملةُ الواحدة كلَّ ما سبقه.
    await expect(recordCompanyStatement({
      branchId: 1,
      partyId: 1,
      statementNumber: "ATOMIC-ROLLBACK-001",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "7000.00" }],
      countedCash: "6999.00",
      clientRequestId: "stmt-atomic-rollback-1",
    }, CASHIER)).rejects.toThrow();

    const cn = (await db().select().from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    expect(cn.parcelStatus).toBe("OUT_FOR_DELIVERY");
    expect(cn.courierDeliveredAt).toBeNull();
    expect(cn.collectedAmount).toBe("0.00");
    expect(cn.moneyStatus).toBe("UNSETTLED");
    expect((await invoiceOf(a.invoiceId)).paidAmount).toBe("0.00");
    expect(await balanceOf(1)).toBe(7000);
    expect(await partyBalance()).toBe(0);
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(beforeAccounting);
    expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(beforeLedger);
    expect(await db().select().from(s.deliveryEvents)).toHaveLength(beforeEvents);
  });

  it("عقد idempotency: إعادة الطلب المطابق تعيد replay بلا أثر ماليّ مكرّر", async () => {
    const a = await dispatchedOrder("st-idem-replay", "9000.00");
    const input = {
      branchId: 1,
      partyId: 1,
      statementNumber: "IDEM-REPLAY-001",
      statementDate: "2026-09-17",
      notes: "كشف مطابق لإعادة الإرسال",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "9000.00" }],
      countedCash: "9000.00",
      clientRequestId: "stmt-idem-replay-1",
    };

    const first = await recordCompanyStatement(input, CASHIER);
    const beforeReplay = await companyStatementStateSnapshot(a.consignmentId, a.invoiceId);

    const replay = await recordCompanyStatement(input, CASHIER);

    expect(replay).toMatchObject({
      remittanceId: first.remittanceId,
      remittanceNumber: first.remittanceNumber,
      statementNumber: input.statementNumber,
      deliveriesConfirmed: 0,
      collectedTotal: first.collectedTotal,
      netRemitted: first.netRemitted,
      idempotentReplay: true,
    });
    expect(await companyStatementStateSnapshot(a.consignmentId, a.invoiceId)).toEqual(beforeReplay);
  });

  it("عقد idempotency: تغيير payload مع المفتاح نفسه يرفض CONFLICT بلا أثر", async () => {
    const a = await dispatchedOrder("st-idem-conflict", "11000.00");
    const input = {
      branchId: 1,
      partyId: 1,
      statementNumber: "IDEM-CONFLICT-001",
      statementDate: "2026-09-17",
      notes: "الحمولة الأصلية",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "11000.00" }],
      countedCash: "11000.00",
      clientRequestId: "stmt-idem-conflict-1",
    };

    await recordCompanyStatement(input, CASHIER);
    const beforeConflict = await companyStatementStateSnapshot(a.consignmentId, a.invoiceId);

    await expect(recordCompanyStatement({
      ...input,
      notes: "حمولة مختلفة بالمفتاح نفسه",
    }, CASHIER)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/بحمولةٍ مختلفة/),
    });

    expect(await companyStatementStateSnapshot(a.consignmentId, a.invoiceId)).toEqual(beforeConflict);
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

  it("تحصيلٌ جزئيّ: كشفٌ ثانٍ بـ8,000 يُكمل 12,000 إلى 20,000 بأثرٍ ماليّ مترابط", async () => {
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

    const completion = await recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "PART-002",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "8000.00" }],
      countedCash: "8000.00", clientRequestId: "stmt-req-3-complete",
    }, CASHIER);

    expect(completion.deliveriesConfirmed).toBe(0); // التسليم مثبتٌ من الكشف الأول
    expect(completion.collectedTotal).toBe("8000.00"); // مبلغُ الكشف الثاني دلتا، لا إجماليٌّ تراكمي
    expect(completion.netRemitted).toBe("8000.00");

    const completedCn = (await db().select().from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    expect(completedCn.collectedAmount).toBe("20000.00");
    expect(completedCn.moneyStatus).toBe("SETTLED");
    expect(completedCn.status).toBe("DELIVERED");

    const completedInvoice = await invoiceOf(a.invoiceId);
    expect(completedInvoice.paidAmount).toBe("20000.00");
    expect(completedInvoice.status).toBe("PAID");
    expect(await balanceOf(1)).toBe(0);
    expect(await partyBalance()).toBe(0);

    const remittances = await db().select().from(s.deliveryRemittances);
    expect(remittances).toHaveLength(2);
    expect(remittances.map((r) => r.companyStatementNumber).sort()).toEqual(["PART-001", "PART-002"]);
    expect(round2(remittances.reduce((sum, r) => sum.plus(money(r.collectedTotal)), money(0))).toFixed(2)).toBe("20000.00");

    const cashReceipts = (await db().select().from(s.receipts))
      .filter((r) => r.direction === "IN" && (r.description ?? "").includes("توريد تحصيلات مندوب"));
    expect(cashReceipts).toHaveLength(2);
    expect(round2(cashReceipts.reduce((sum, r) => sum.plus(money(r.amount)), money(0))).toFixed(2)).toBe("20000.00");

    const ledger = await db().select().from(s.deliveryLedgerEntries);
    const collectedLedger = ledger.filter((e) => e.entryType === "COD_COLLECTED");
    const remittedLedger = ledger.filter((e) => e.entryType === "COD_REMITTED");
    expect(round2(collectedLedger.reduce((sum, e) => sum.plus(money(e.amount)), money(0))).toFixed(2)).toBe("20000.00");
    expect(round2(remittedLedger.reduce((sum, e) => sum.plus(money(e.amount)), money(0))).toFixed(2)).toBe("20000.00");

    const invoicePayments = (await db().select().from(s.accountingEntries))
      .filter((e) => e.invoiceId === a.invoiceId && e.entryType === "PAYMENT_IN");
    expect(round2(invoicePayments.reduce((sum, e) => sum.plus(money(e.amount)), money(0))).toFixed(2)).toBe("20000.00");
  });

  it("ذرّية التحصيل المتمِّم: فشل نقد الكشف الثاني يعيد كلّ أثرٍ إلى لقطة 12,000", async () => {
    const a = await dispatchedOrder("st-supp-atomic", "20000.00");

    await recordCompanyStatement({
      branchId: 1,
      partyId: 1,
      statementNumber: "SUPP-ATOMIC-001",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "12000.00" }],
      countedCash: "12000.00",
      clientRequestId: "stmt-supp-atomic-1",
    }, CASHIER);

    const snapshotState = async () => ({
      consignment: (await db().select().from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, a.consignmentId)))[0],
      invoice: await invoiceOf(a.invoiceId),
      customerBalance: await balanceOf(1),
      partyBalance: await partyBalance(),
      ledger: await db().select().from(s.deliveryLedgerEntries).orderBy(s.deliveryLedgerEntries.id),
      events: await db().select().from(s.deliveryEvents).orderBy(s.deliveryEvents.id),
      idempotency: await db().select().from(s.idempotencyKeys).orderBy(s.idempotencyKeys.id),
      remittances: await db().select().from(s.deliveryRemittances).orderBy(s.deliveryRemittances.id),
    });

    const beforeFailure = await snapshotState();
    expect(beforeFailure.consignment.collectedAmount).toBe("12000.00");
    expect(beforeFailure.consignment.moneyStatus).toBe("PARTIAL");
    expect(beforeFailure.invoice.paidAmount).toBe("12000.00");
    expect(beforeFailure.customerBalance).toBe(8000);
    expect(beforeFailure.partyBalance).toBe(0);

    await expect(recordCompanyStatement({
      branchId: 1,
      partyId: 1,
      statementNumber: "SUPP-ATOMIC-002",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "8000.00" }],
      countedCash: "7999.00",
      clientRequestId: "stmt-supp-atomic-2",
    }, CASHIER)).rejects.toThrow();

    expect(await snapshotState()).toEqual(beforeFailure);
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
      { id: 2, name: "جهة أخرى", partyType: "COMPANY", currentBalance: "0.00", isActive: true },
    ]);

    await expect(recordCompanyStatement({
      branchId: 1, partyId: 2, statementNumber: "WRONG-PARTY",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "5000.00" }],
      countedCash: "5000.00", clientRequestId: "stmt-req-5",
    }, CASHIER)).rejects.toThrowError(/لا تخصّ هذه الجهة|لا تخص هذه الجهة/);

    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
  });
});
