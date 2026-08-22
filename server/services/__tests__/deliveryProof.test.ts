/**
 * إثبات التسليم بلا نقد — القنوات الثلاث الموازية للحقيقة (حملة ٢١/٨).
 *
 * السياق الجنائيّ: ٧٩/٨٤ طرداً جامداً «مُسنَد — لم يخرج» ٩-١٣ يوماً لأنّ تقدّم `parcelStatus`
 * حكرٌ على بوّابة مندوبٍ لا تملكها أغلبُ الجهات. الفعلُ الواقعيّ ينفصل زمنياً: «سُلِّم» اليومَ
 * والنقدُ بعد أيام — فالإثباتُ يجب أن يمشي وحده والنقدُ يلحقه بمساره المحروس.
 *
 * الثوابت المحروسة هنا:
 *  ① سطرُ الصفر في الكشف = إثباتُ تسليمٍ بلا نقد: يختم الطرد ولا يمسّ درجاً ولا يُنشئ توريداً.
 *  ② الكشف المختلط يورّد أسطرَ المال وحدها ويختم الجميع — سطرُ الصفر لا يُفجّر المرحلة ②.
 *  ③ نقدٌ معدود بلا سطر مالٍ يقابله يُرفض قبل أيّ كتابة (لا دينار بلا مسار — §٥).
 *  ④ الإثبات المستنديّ المستقلّ يرفع عهدة الجهة **بلا إيصال درج**، والتوريد اللاحق ينقلها.
 *  ⑤ الإثبات اليدويّ الاستثنائيّ يدوّن `MANUAL_PROOF` ودليلَه في حدث التسليم (أثرُ سلطةٍ يُراجَع).
 *  ⑥ الطرد COD=0 المُثبَت يختم أمرَ شغله DELIVERED — لا طلبَ يعلق «جاهزاً» بعد وصوله.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { dispatchToDelivery } from "../delivery/dispatch";
import {
  recordCompanyStatement,
  recordDeliveryProof,
  recordManualDeliveryProof,
} from "../delivery/companyStatement";
import { recordDeliveryRemittance } from "../delivery/remittance";
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

async function openReception(): Promise<number> {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    { userId: 2, branchId: 1 },
  );
  return shift.shiftId;
}

/** أمر توصيلٍ جاهز بقيمة salePrice؛ paidAmount يصير عربوناً ⇒ COD = salePrice − المدفوع. */
async function dispatchedOrder(
  shiftId: number,
  reqId: string,
  salePrice: string,
  paidAmount = "0",
) {
  const paid = round2(money(paidAmount));
  const r = await checkoutReception({
    branchId: 1, shiftId, customerId: 1,
    paidAmount: paid.toFixed(2),
    paymentMethod: paid.gt(0) ? "CASH" : undefined,
    clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice, materials: [],
      hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567",
    }],
  }, CASHIER);
  const woId = r.workOrders[0].workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  const d = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: `d-${reqId}` }, CASHIER);
  return { workOrderId: woId, consignmentId: d.consignmentId, invoiceId: d.invoiceId, codAmount: d.codAmount };
}

const balanceOf = async (id: number) =>
  Number((await db().select().from(s.customers).where(eq(s.customers.id, id)))[0].currentBalance);
const partyBalance = async () =>
  Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0].currentBalance);
const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const consignmentOf = async (id: number) =>
  (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0];
const receiptCount = async () => (await db().select().from(s.receipts)).length;
const deliveredEventOf = async (consignmentId: number) =>
  (await db().select().from(s.deliveryEvents)
    .where(eq(s.deliveryEvents.consignmentId, consignmentId)))
    .find((e) => e.eventType === "DELIVERED");

beforeEach(async () => {
  await reset();
  await seed();
});

describe("أسطر الصفر في كشف الشركة — إثبات تسليمٍ بلا نقد", () => {
  it("⭐ كشفٌ كلُّه أسطر صفرية: يختم الطرود بلا توريد ولا نقد، والمتبقّي ذمّةُ عميلٍ حيّة", async () => {
    const shiftId = await openReception();
    const a = await dispatchedOrder(shiftId, "z-1", "20000.00");
    const receiptsBefore = await receiptCount();

    const res = await recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "ZERO-001",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "0.00" }],
      countedCash: "0.00", clientRequestId: "stmt-zero-1",
    }, CASHIER);

    expect(res.proofOnly).toBe(true);
    expect(res.remittanceId).toBeNull();
    expect(res.remittanceNumber).toBeNull();
    expect(res.deliveriesConfirmed).toBe(1);
    expect(res.collectedTotal).toBe("0.00");
    expect(res.netRemitted).toBe("0.00");
    expect(res.statementNumber).toBe("ZERO-001");

    // الطرد مختوم — والمالُ لم يتحرّك قيد أنملة: لا سند توريد، لا إيصال، لا عهدة.
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("DELIVERED");
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
    expect(await receiptCount()).toBe(receiptsBefore);
    expect(await partyBalance()).toBe(0);

    // قرار المالك: المتبقّي يبقى على العميل — ذمّةٌ حيّة تُقبض كاونترياً لاحقاً.
    expect(await balanceOf(1)).toBe(20000);
    expect((await invoiceOf(a.invoiceId)).paidAmount).toBe("0.00");

    // ومصدر السلطة مدوَّن في حدث التسليم.
    const ev = await deliveredEventOf(a.consignmentId);
    expect(JSON.stringify(ev?.payload ?? {})).toContain("COMPANY_STATEMENT");
    expect(JSON.stringify(ev?.payload ?? {})).toContain("ZERO-001");
  });

  it("⭐ كشفٌ مختلط (صفري + مالي): يورّد المالي وحده ويختم الجميع", async () => {
    const shiftId = await openReception();
    const zero = await dispatchedOrder(shiftId, "mx-a", "20000.00");
    const paid = await dispatchedOrder(shiftId, "mx-b", "15000.00");

    const res = await recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "MIX-001",
      lines: [
        { consignmentId: zero.consignmentId, collectedAmount: "0.00" },
        { consignmentId: paid.consignmentId, collectedAmount: "15000.00" },
      ],
      countedCash: "15000.00", clientRequestId: "stmt-mix-1",
    }, CASHIER);

    expect(res.proofOnly).toBeUndefined();
    expect(res.remittanceId).not.toBeNull();
    expect(res.deliveriesConfirmed).toBe(2); // الكشف أثبت تسليم الطردين معاً
    expect(res.collectedTotal).toBe("15000.00");
    expect(res.netRemitted).toBe("15000.00");

    // كلاهما مختوم؛ الماليّ سُوّي، والصفريّ بقي متبقّيه ذمّةً حيّة بلا سطر توريد.
    const cnZero = await consignmentOf(zero.consignmentId);
    const cnPaid = await consignmentOf(paid.consignmentId);
    expect(cnZero.parcelStatus).toBe("DELIVERED");
    expect(cnZero.moneyStatus).toBe("UNSETTLED");
    expect(cnPaid.parcelStatus).toBe("DELIVERED");
    expect(cnPaid.moneyStatus).toBe("SETTLED");
    expect(await db().select().from(s.deliveryRemittanceLines)).toHaveLength(1);
    expect((await invoiceOf(paid.invoiceId)).status).toBe("PAID");
    expect(await balanceOf(1)).toBe(20000); // متبقّي الصفريّ وحده
    expect(await partyBalance()).toBe(0); // عهدة الماليّ أُبرئت بالتوريد
  });

  it("نقدٌ معدود > 0 مع أسطرٍ صفريةٍ فقط ⇒ يُرفض قبل أيّ كتابة", async () => {
    const shiftId = await openReception();
    const a = await dispatchedOrder(shiftId, "z-2", "20000.00");

    await expect(recordCompanyStatement({
      branchId: 1, partyId: 1, statementNumber: "ZERO-BAD",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "0.00" }],
      countedCash: "5000.00", clientRequestId: "stmt-zero-2",
    }, CASHIER)).rejects.toThrowError(/النقد المعدود/);

    // لا أثر: الطرد لم يُختم ولا سند أُنشئ — الرفض سبق الكتابة كلّها.
    expect((await consignmentOf(a.consignmentId)).parcelStatus).toBe("ASSIGNED");
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);
  });
});

describe("recordDeliveryProof — إثبات تسليمٍ مستنديّ مستقلّ (النقد يلحق لاحقاً)", () => {
  it("⭐ يرفع عهدة الجهة بلا إيصال درج، والتوريد اللاحق ينقلها إلى النقد", async () => {
    const shiftId = await openReception();
    const a = await dispatchedOrder(shiftId, "pf-1", "20000.00");
    const receiptsBefore = await receiptCount();

    const res = await recordDeliveryProof({
      branchId: 1, partyId: 1, statementNumber: "PRF-001",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "20000.00" }],
      clientRequestId: "proof-req-1",
    }, CASHIER);
    expect(res).toEqual({ deliveriesConfirmed: 1, alreadyDelivered: 0, statementNumber: "PRF-001" });

    // المال المُعلَن صار **عهدةً على الجهة** (النقد بيدها) — لا درج ولا سند توريد بعد.
    expect(await partyBalance()).toBe(20000);
    expect(await balanceOf(1)).toBe(0); // ذمّة العميل سقطت لحظة ثبوت التسليم
    expect((await invoiceOf(a.invoiceId)).status).toBe("PAID");
    expect(await receiptCount()).toBe(receiptsBefore); // بلا أيّ إيصال درج
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(0);

    // دفتر التوصيل يحمل قيد التحصيل — «لا دينار بلا مسار» حتى وهو خارج الدرج.
    const codEntries = (await db().select().from(s.deliveryLedgerEntries))
      .filter((e) => Number(e.consignmentId) === Number(a.consignmentId) && e.entryType === "COD_COLLECTED");
    expect(codEntries).toHaveLength(1);
    expect(round2(money(codEntries[0].amount)).toFixed(2)).toBe("20000.00");
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("DELIVERED");
    expect(cn.moneyStatus).toBe("UNSETTLED"); // النقد لم يُورَّد بعد

    // إعادة الإثبات نفسه ترتدّ بلا أثر — العملية idempotent بمفتاح (الكشف × الإرسالية).
    const replay = await recordDeliveryProof({
      branchId: 1, partyId: 1, statementNumber: "PRF-001",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "20000.00" }],
      clientRequestId: "proof-req-1b",
    }, CASHIER);
    expect(replay).toEqual({ deliveriesConfirmed: 0, alreadyDelivered: 1, statementNumber: "PRF-001" });
    expect(await partyBalance()).toBe(20000);

    // التوريد العاديّ اللاحق يُبرئ العهدة ويُدخل النقد الدرج فعلاً.
    const rem = await recordDeliveryRemittance({
      branchId: 1, partyId: 1,
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "20000.00" }],
      countedCash: "20000.00", clientRequestId: "rem-after-proof-1",
    }, CASHIER);
    expect(rem.netRemitted).toBe("20000.00");
    expect(await partyBalance()).toBe(0);
    expect((await consignmentOf(a.consignmentId)).moneyStatus).toBe("SETTLED");
    const remitIn = (await db().select().from(s.receipts))
      .filter((r) => r.direction === "IN" && r.referenceNumber === rem.remittanceNumber);
    expect(remitIn).toHaveLength(1);
    expect(round2(money(remitIn[0].amount)).toFixed(2)).toBe("20000.00");
  });

  it("⭐ الطرد COD=0 (مدفوعٌ سلفاً) المُثبَت يختم أمرَ شغله DELIVERED", async () => {
    const shiftId = await openReception();
    // مدفوعٌ كاملاً عند الاستقبال ⇒ لا شيء يُحصَّل عند الباب.
    const a = await dispatchedOrder(shiftId, "cod0-1", "12000.00", "12000.00");
    expect(a.codAmount).toBe("0.00");
    const receiptsBefore = await receiptCount();

    const res = await recordDeliveryProof({
      branchId: 1, partyId: 1, statementNumber: "PRF-COD0",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "0.00" }],
      clientRequestId: "proof-cod0-1",
    }, CASHIER);
    expect(res.deliveriesConfirmed).toBe(1);

    // الإثبات هو ما يُغلق دورة الطلب — كان يعلق «جاهزاً» للأبد بلا بوّابة مندوب.
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, a.workOrderId)))[0];
    expect(wo.status).toBe("DELIVERED");
    expect(wo.deliveredAt).not.toBeNull();
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("DELIVERED");
    expect(cn.status).toBe("DELIVERED"); // صفريّ ⇒ يُغلق كلّياً، لا توريد يُنتظَر
    expect(await partyBalance()).toBe(0);
    expect(await receiptCount()).toBe(receiptsBefore);
  });
});

describe("recordManualDeliveryProof — الإثبات اليدويّ الاستثنائيّ (دليلٌ + موافقة مدير)", () => {
  it("⭐ يدوّن MANUAL_PROOF ودليلَه في حدث التسليم، بنفس المسار الماليّ حرفياً", async () => {
    const shiftId = await openReception();
    const a = await dispatchedOrder(shiftId, "mn-1", "8000.00");

    const res = await recordManualDeliveryProof({
      consignmentId: a.consignmentId,
      collectedAmount: "8000.00",
      evidence: "اتصال الزبون وتأكيده الاستلام ٢١/٨",
      clientRequestId: "manual-1",
    }, CASHIER);
    expect(res.consignmentId).toBe(a.consignmentId);

    // مصدر السلطة MANUAL_PROOF ودليله معاً — الأثر الذي يُراجَع عند أيّ خلاف.
    const ev = await deliveredEventOf(a.consignmentId);
    const payload = JSON.stringify(ev?.payload ?? {});
    expect(payload).toContain("MANUAL_PROOF");
    expect(payload).toContain("MANUAL:اتصال الزبون");

    // ونفس الأثر الماليّ الذي تُنتجه البوّابة/الكشف — لا نسخة ثانية تنجرف.
    expect(await balanceOf(1)).toBe(0);
    expect(await partyBalance()).toBe(8000);
    expect((await invoiceOf(a.invoiceId)).status).toBe("PAID");
  });

  it("بلا دليلٍ مكتوب ⇒ يُرفض (نصّ المالك: «يحتاج دليلاً»)", async () => {
    const shiftId = await openReception();
    const a = await dispatchedOrder(shiftId, "mn-2", "8000.00");

    await expect(recordManualDeliveryProof({
      consignmentId: a.consignmentId,
      collectedAmount: "8000.00",
      evidence: "   ",
      clientRequestId: "manual-2",
    }, CASHIER)).rejects.toThrowError(/دليلاً مكتوباً/);
    expect((await consignmentOf(a.consignmentId)).parcelStatus).toBe("ASSIGNED");
  });
});
