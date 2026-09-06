/**
 * م١ PR-C ٢/٢ — الإجراءات الرقيقة الأربعة في `deliveryRouter` على قاعدةٍ حقيقيّة (لا mocks):
 * `partyBoard` · `settlementPreview` · `settleDaily` · `suggestPartyForZone`.
 *
 * ما تحرسه (فوق اختبار الخدمات `deliveryBoardSettlement.test.ts` الذي يثبت الحساب):
 *  ① عزل الفرع عبر `branchScopedProcedure`: كاشير الفرع ١ يرى جهته، وكاشير الفرع ٢ لا يراها
 *     ولا يعاين تسويتها (FORBIDDEN لا تسريب).
 *  ② التسوية اليوميّة من الراوتر بمفتاح idempotency: النقرة الثانية بنفس المفتاح تُعيد النتيجة
 *     نفسها بلا سندٍ ثانٍ، والأعمدة **تصفر** على اللوحة بعد الإقفال.
 *  ③ العجز بسبب ⇒ SHORT + `SHORTFALL_ASSIGNED` ذمّةً على الجهة؛ بلا سبب ⇒ رفضٌ بعقد
 *     appErrorMessage؛ الزيادة ⇒ رفض (رسالة الخادم تصل الشاشة كما هي).
 *  ④ الاقتراح بالمنطقة يمرّ عبر `z.enum(GOVERNORATE_IDS)`: رمزٌ غير معروف يُرفض BAD_REQUEST،
 *     والمعروف يعيد الجهة المعتادة بأجرتها.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../../services/sale/create";
import { recordStaffDeliveryConfirmation } from "../../services/delivery/companyStatement";
import { openShift } from "../../services/shiftService";
import { deliveryRouter } from "../deliveryRouter";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "deliveryPricingRules", "deliveryZones",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const PARTY = 1;
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
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "csh2", name: "كاشير الفرع ٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.deliveryParties).values([
    { id: PARTY, name: "مندوب", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "1500.00", maxOpenParcelAgeDays: 7 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

/** مستدعٍ بسياقٍ حقيقيّ الشكل (كما يبنيه createContext) لمستخدمٍ مبذور — بلا كوكي ولا كلمة مرور. */
function callerFor(user: { id: number; role: string; branchId: number }) {
  return deliveryRouter.createCaller({
    req: { headers: { "user-agent": "vitest" }, ip: "127.0.0.1", method: "POST" },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: { id: user.id, role: user.role, branchId: user.branchId, permissionsOverride: null, totpEnabledAt: new Date(), isActive: true },
  } as never);
}
const cashier = () => callerFor({ id: 2, role: "cashier", branchId: 1 });
const otherBranchCashier = () => callerFor({ id: 3, role: "cashier", branchId: 2 });

async function saleWithDelivery(reqId: string, quantity: string, governorate = "baghdad") {
  const r = await createSale({
    branchId: 1, sourceType: "POS", customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity }],
    delivery: { partyId: PARTY, fee: "1500", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد", governorate },
    clientRequestId: reqId,
  }, CASHIER);
  return { invoiceId: r.invoiceId, consignmentId: r.consignmentId! };
}
const confirmDelivered = (consignmentId: number, collectedAmount: string) =>
  recordStaffDeliveryConfirmation(
    { consignmentId, collectedAmount, evidence: "اتصال المندوب", clientRequestId: `staff-${consignmentId}` },
    CASHIER,
  );
const partyBalance = async () =>
  String((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, PARTY)))[0].currentBalance);
const ledgerTypes = async () =>
  (await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.partyId, PARTY))).map((e) => e.entryType);

beforeEach(async () => {
  await reset();
  await seed();
  await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
});

describe("deliveryRouter — لوحة الخمسة أعمدة والتسوية اليوميّة (م١ PR-C)", () => {
  it("① عزل الفرع: كاشير الفرع ١ يرى الجهة على اللوحة ويعاينها؛ كاشير الفرع ٢ لا يراها ولا يعاينها", async () => {
    const a = await saleWithDelivery("r-1", "2"); // COD 2000
    await confirmDelivered(a.consignmentId, "2000");

    const rows = await cashier().partyBoard();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partyId: PARTY, partyName: "مندوب", partyType: "INDIVIDUAL" });
    expect(rows[0].deliveredUnremitted).toEqual({ count: 1, amount: "2000.00" });
    expect(rows[0].cashInHandLedger).toBe("2000.00");
    expect(rows[0].cashInHandDrift).toBe("0.00");
    expect(rows[0].staleOpenParcels).toBe(0);

    const preview = await cashier().settlementPreview({ partyId: PARTY });
    expect(preview).toMatchObject({ partyId: PARTY, branchId: 1, expectedCash: "2000.00", deductions: "0.00", net: "2000.00" });
    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0]).toMatchObject({ consignmentId: a.consignmentId, remaining: "2000.00" });

    expect(await otherBranchCashier().partyBoard()).toEqual([]);
    await expect(otherBranchCashier().settlementPreview({ partyId: PARTY })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("② إقفالٌ بتأكيدٍ واحد: مطابق ⇒ BALANCED، والأعمدة تصفر، ولا سندَ فارغاً بعده", async () => {
    const a = await saleWithDelivery("r-2", "2"); // 2000
    const b = await saleWithDelivery("r-3", "3"); // 3000
    await confirmDelivered(a.consignmentId, "2000");
    await confirmDelivered(b.consignmentId, "3000");
    expect((await cashier().settlementPreview({ partyId: PARTY })).net).toBe("5000.00");

    const first = await cashier().settleDaily({ partyId: PARTY, countedCash: "5000.00", clientRequestId: "settle-daily-balanced-0001" });
    expect(first.status).toBe("BALANCED");
    expect(first.shortfallTotal).toBe("0.00");
    expect(first.receiptId).not.toBeNull();
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(1);

    const rows = await cashier().partyBoard();
    expect(rows[0].deliveredUnremitted).toEqual({ count: 0, amount: "0.00" });
    expect(rows[0].cashInHandLedger).toBe("0.00");
    expect(rows[0].cashInHandStored).toBe("0.00");
    expect(rows[0].net).toBe("0.00");
    expect(await partyBalance()).toBe("0.00");
    // لا شيء يُسوَّى بعد الإقفال ⇒ رفضٌ صريح لا سندٌ فارغ.
    await expect(cashier().settleDaily({ partyId: PARTY, countedCash: "0.00", clientRequestId: "settle-daily-empty-0001" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  /**
   * إعادةُ الطلب بنفس مفتاح idempotency بعد نجاحه (نقرٌ مزدوج · إعادةُ شبكة · إعادةُ محاولة الراوتر على
   * ER_DUP): يجب أن تعيد **السند نفسه** لا أن تُرفض PRECONDITION_FAILED. الجذر كان تقديمَ فحص «لا شيء
   * يُسوَّى» على فحص idempotency (يعيش داخل «recordDeliveryRemittanceInTx»)؛ أُصلح بنقل فحص المفتاح
   * قبل تحميل الأسطر في «settleDailyTx» (server/services/delivery/dailySettlement.ts). كان هذا
   * الاختبار «it.fails» يثبّت الفجوة، وصار «it» بعد إغلاقها — حارسُ انحدارٍ بصدق.
   */
  it("②-ب إعادةُ الطلب بنفس مفتاح idempotency تعيد السند نفسه (نقرٌ مزدوج/إعادةُ شبكة)", async () => {
    const a = await saleWithDelivery("r-6", "2");
    await confirmDelivered(a.consignmentId, "2000");
    const key = "settle-daily-replay-0001";
    const first = await cashier().settleDaily({ partyId: PARTY, countedCash: "2000.00", clientRequestId: key });
    const again = await cashier().settleDaily({ partyId: PARTY, countedCash: "2000.00", clientRequestId: key });
    expect(again.remittanceId).toBe(first.remittanceId);
    // العائدُ متطابقٌ حرفياً (نفس SettleDailyResult) — لا نجاحٌ صامتٌ بقيمٍ مختلفة.
    expect(again).toEqual(first);
    // ولا سندَ توريدٍ ثانٍ في القاعدة.
    expect(await db().select().from(s.deliveryRemittances)).toHaveLength(1);
  });

  it("③ العجز: بسببٍ مصنَّف ⇒ SHORT + SHORTFALL_ASSIGNED ذمّةً على الجهة؛ بلا سبب ⇒ رفض؛ الزيادة ⇒ رفض", async () => {
    const a = await saleWithDelivery("r-4", "2"); // 2000
    await confirmDelivered(a.consignmentId, "2000");

    await expect(cashier().settleDaily({ partyId: PARTY, countedCash: "1950.00", clientRequestId: "settle-daily-noreason-01" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("سبب") });
    await expect(cashier().settleDaily({ partyId: PARTY, countedCash: "2500.00", clientRequestId: "settle-daily-over-0001" }))
      .rejects.toBeTruthy();

    const res = await cashier().settleDaily({
      partyId: PARTY, countedCash: "1950.00", shortfallReason: "OTHER", shortfallNotes: "فرق عدّ",
      clientRequestId: "settle-daily-short-0001",
    });
    expect(res.status).toBe("SHORT");
    expect(res.shortfallTotal).toBe("50.00");
    expect(await ledgerTypes()).toContain("SHORTFALL_ASSIGNED");
    expect(await partyBalance()).toBe("50.00");

    const rows = await cashier().partyBoard();
    expect(rows[0].deliveredUnremitted.count).toBe(0);
    // note-J (Codex #1012 P2): العجزُ ذمّةٌ **غير نقديّة** — يُطرَح من «نقد بيده» (يبقى ماديّاً وحده)
    // ويظهر في عموده الخامس المستقلّ `shortfallOwed`. العهدةُ الكلّية (نقد 0 + عجز 50) تطابق المخزَّن.
    expect(rows[0].cashInHandLedger).toBe("0.00");
    expect(rows[0].shortfallOwed).toBe("50.00");
    expect(rows[0].cashInHandDrift).toBe("0.00");
  });

  it("④ اقتراح الجهة للمنطقة: من تاريخ الإسناد الفعليّ بأجرة الجهة الافتراضية؛ رمزٌ غير معروف يُرفض؛ منطقةٌ بلا تاريخ ⇒ null", async () => {
    await saleWithDelivery("r-5", "1", "baghdad");
    const hit = await cashier().suggestPartyForZone({ governorate: "baghdad" });
    expect(hit).toEqual({ partyId: PARTY, partyName: "مندوب", fee: "1500.00" });
    expect(await cashier().suggestPartyForZone({ governorate: "basra" })).toBeNull();
    await expect(cashier().suggestPartyForZone({ governorate: "atlantis" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
