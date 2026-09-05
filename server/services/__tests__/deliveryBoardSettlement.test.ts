/**
 * م١ (PR-2) — لوحةُ جهات التوصيل + التسويةُ اليوميّة + اقتراحُ الجهة بالمنطقة.
 *
 * ما تحرسه:
 *  ① اللوحة: الدلاء تتحرّك مع دورة الطرد (مُسنَد ⇒ سُلِّم غير مورَّد ⇒ مورَّد)، والنقدُ بيد الجهة
 *     مشتقّاً من الدفتر **يطابق** العمود المخزَّن (انحراف صفر) على كلّ خطوة، وصافي المسؤوليّة
 *     لا يحسب الطرد المقبوض غير المورَّد مرّتين (`ledgerCustody`).
 *  ② المعاينة: «المتوقَّع محسوبٌ سلفاً» = Σ المتبقّي الحيّ للطرود المُسلَّمة غير المورَّدة.
 *  ③ التسوية بتأكيدٍ واحد: مطابقة ⇒ BALANCED؛ عجزٌ بسبب ⇒ SHORT + `SHORTFALL_ASSIGNED` ذمّةً على
 *     الجهة وإيصالُ الدرج بما دخل فعلاً وصيغةُ مطابقة العهدة متوازنة؛ عجزٌ بلا سبب ⇒ رفض؛
 *     زيادة ⇒ رفض؛ لا شيء يُسوَّى ⇒ رفض.
 *  ④ الاقتراح بالمنطقة: من تاريخ الإسناد الفعليّ، بأجرة المنطقة إن وُجدت قاعدة وإلّا الافتراضية،
 *     و`null` بصدق بلا تاريخ، ولا يُقترَح مَن يرفضه حارسُ SLA.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { recordStaffDeliveryConfirmation } from "../delivery/companyStatement";
import { listPartyBoardTx, suggestPartyForZoneTx } from "../delivery/board";
import { previewDailySettlementTx, settleDailyTx } from "../delivery/dailySettlement";
import { reconcileDeliveryFloat } from "../reconcileService";
import { openShift } from "../shiftService";
import { withTx } from "../tx";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "deliveryPricingRules", "deliveryZones",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const PARTY = 1;

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
    { id: 2, openId: "csh", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: PARTY, name: "مندوب", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "1500.00", maxOpenParcelAgeDays: 7 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

async function openReception(): Promise<number> {
  const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
  return shift.shiftId;
}
/** بيعٌ بتوصيلٍ عبر نواة البيع (PR-1): الفاتورة + الإرسالية + COD_ASSIGNED في معاملةٍ واحدة. */
async function saleWithDelivery(reqId: string, quantity: string, governorate: string | null = "baghdad") {
  const r = await createSale({
    branchId: 1, sourceType: "POS", customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity }],
    delivery: { partyId: PARTY, fee: "1500", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد", governorate },
    clientRequestId: reqId,
  }, CASHIER);
  return { invoiceId: r.invoiceId, consignmentId: r.consignmentId! };
}
async function confirmDelivered(consignmentId: number, collectedAmount: string, shortfallReason?: string) {
  return recordStaffDeliveryConfirmation(
    { consignmentId, collectedAmount, evidence: "اتصال المندوب", clientRequestId: `staff-${consignmentId}`, shortfallReason },
    CASHIER,
  );
}
const board = () => withTx((tx) => listPartyBoardTx(tx, { branchId: 1, canCrossBranches: false }, CASHIER));
const preview = () => withTx((tx) => previewDailySettlementTx(tx, { partyId: PARTY, branchId: 1 }, CASHIER));
const settle = (countedCash: string, shortfallReason?: string, key = `settle-${countedCash}-${shortfallReason ?? "none"}`) =>
  withTx((tx) => settleDailyTx(tx, { partyId: PARTY, branchId: 1, countedCash, shortfallReason, shiftType: "RECEPTION", clientRequestId: key }, CASHIER));
const suggest = (governorate: string) => withTx((tx) => suggestPartyForZoneTx(tx, { governorate, branchId: 1 }));
const partyBalance = async () =>
  String((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, PARTY)))[0].currentBalance);
const consignmentOf = async (id: number) =>
  (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0];
const ledger = async () => db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.partyId, PARTY));

beforeEach(async () => {
  await reset();
  await seed();
});

describe("لوحة الجهات — الدلاء الخمسة والنقد بمصدرَيه", () => {
  it("⭐ مُسنَد ⇒ سُلِّم غير مورَّد ⇒ مورَّد: الدلاء تتحرّك، والدفتر يطابق المخزَّن على كلّ خطوة", async () => {
    await openReception();
    const a = await saleWithDelivery("b-1", "2"); // 2000
    const b = await saleWithDelivery("b-2", "3"); // 3000
    let rows = await board();
    expect(rows).toHaveLength(1);
    let row = rows[0];
    expect(row.partyId).toBe(PARTY);
    expect(row.assigned).toEqual({ count: 2, amount: "5000.00" });
    expect(row.inTransit.count).toBe(0);
    expect(row.deliveredUnremitted.count).toBe(0);
    expect(row.cashInHandLedger).toBe("0.00");
    expect(row.cashInHandStored).toBe("0.00");
    expect(row.cashInHandDrift).toBe("0.00");
    expect(row.feesOwed).toBe("0.00");
    expect(row.net).toBe("5000.00");
    expect(row.staleOpenParcels).toBe(0);

    await confirmDelivered(a.consignmentId, "2000");
    rows = await board();
    row = rows[0];
    expect(row.assigned).toEqual({ count: 1, amount: "3000.00" });
    expect(row.deliveredUnremitted).toEqual({ count: 1, amount: "2000.00" });
    expect(row.cashInHandLedger).toBe("2000.00");
    expect(row.cashInHandStored).toBe("2000.00");
    expect(row.cashInHandDrift).toBe("0.00");
    // الأجرة COURIER: استُحقّت ودُفعت مباشرةً من الزبون ⇒ لا شيء علينا.
    expect(row.feesOwed).toBe("0.00");
    // ⭐ لا ازدواج: الطرد المقبوض غير المورَّد نقدٌ بيد الجهة (2000) لا «سُلِّم لم يُحصَّل» أيضاً.
    expect(row.net).toBe("5000.00");

    const res = await settle("2000");
    expect(res.status).toBe("BALANCED");
    rows = await board();
    row = rows[0];
    expect(row.deliveredUnremitted.count).toBe(0);
    expect(row.assigned).toEqual({ count: 1, amount: "3000.00" });
    expect(row.cashInHandLedger).toBe("0.00");
    expect(row.cashInHandStored).toBe("0.00");
    expect(row.net).toBe("3000.00");
    expect(await consignmentOf(b.consignmentId).then((c) => c.parcelStatus)).toBe("ASSIGNED");
  });

  it("جهةٌ بلا فرعٍ مُسنَد لغير العابر ⇒ رفضٌ صريح", async () => {
    await expect(withTx((tx) => listPartyBoardTx(tx, { branchId: null, canCrossBranches: false }, CASHIER)))
      .rejects.toThrow(/غير مُسنَدٍ إلى فرع/);
  });
});

describe("التسوية اليوميّة — المتوقَّع محسوبٌ سلفاً والتأكيدُ واحد", () => {
  it("المعاينة تُدرج الطرود المُسلَّمة غير المورَّدة بمتبقّيها الحيّ فقط", async () => {
    await openReception();
    const a = await saleWithDelivery("p-1", "2"); // 2000
    await saleWithDelivery("p-2", "3"); // 3000 — لم يُسلَّم بعد
    await confirmDelivered(a.consignmentId, "2000");
    const p = await preview();
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].consignmentId).toBe(a.consignmentId);
    expect(p.lines[0].remaining).toBe("2000.00");
    expect(p.lines[0].customerName).toBe("عميل");
    expect(p.expectedCash).toBe("2000.00");
    expect(p.feeDue).toBe("0.00");
    expect(p.deductions).toBe("0.00");
    expect(p.net).toBe("2000.00");
    expect(p.returnsAwaitingReceipt).toBe(0);
  });

  it("⭐ عجزٌ بسببٍ مصنَّف ⇒ SHORT: ذمّةٌ فوريّة على الجهة، إيصالُ الدرج بما دخل فعلاً، ومطابقةُ العهدة متوازنة", async () => {
    const shiftId = await openReception();
    const a = await saleWithDelivery("s-1", "3"); // 3000
    await confirmDelivered(a.consignmentId, "3000");
    expect(await partyBalance()).toBe("3000.00");

    await expect(settle("2500")).rejects.toThrow(/بلا سببٍ مصنَّف/);
    await expect(settle("2500", "NOT_A_REASON")).rejects.toThrow(/بلا سببٍ مصنَّف/);
    expect(await partyBalance()).toBe("3000.00");

    const res = await settle("2500", "CUSTOMER_REQUESTED_DISCOUNT");
    expect(res.status).toBe("SHORT");
    expect(res.shortfallTotal).toBe("500.00");
    expect(res.receiptId).toEqual(expect.any(Number));

    // الجهة تدين بالعجز، والطرد أُغلق، والدرج استلم 2500 لا 3000.
    expect(await partyBalance()).toBe("500.00");
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.moneyStatus).toBe("SETTLED");
    expect(cn.status).toBe("DELIVERED");
    const rm = (await db().select().from(s.deliveryRemittances).where(eq(s.deliveryRemittances.id, res.remittanceId)))[0];
    expect(rm.status).toBe("SHORT");
    expect(rm.shortfallTotal).toBe("500.00");
    expect(rm.collectedTotal).toBe("3000.00");
    const receipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, res.receiptId!)))[0];
    expect(receipt.direction).toBe("IN");
    expect(receipt.amount).toBe("2500.00");
    expect(Number(receipt.shiftId)).toBe(shiftId);
    const shortfall = (await ledger()).find((e) => e.entryType === "SHORTFALL_ASSIGNED");
    expect(shortfall?.amount).toBe("500.00");
    expect(shortfall?.shortfallReason).toBe("CUSTOMER_REQUESTED_DISCOUNT");
    expect(Number(shortfall?.remittanceId)).toBe(res.remittanceId);
    // الدفتر = المخزَّن، وصيغة المطابقة (DISPATCH − REMIT − WRITEOFF = currentBalance) بلا انحراف.
    const row = (await board())[0];
    expect(row.cashInHandLedger).toBe("500.00");
    expect(row.cashInHandDrift).toBe("0.00");
    expect(await reconcileDeliveryFloat()).toEqual([]);
  });

  it("⭐ طردٌ ختم تسليمَه بعجزٍ مصنَّف (DFP1): التسوية تطالب بما قبضته الجهة فقط، وتُغلق الطرد بلا عجزٍ ثانٍ", async () => {
    await openReception();
    const a = await saleWithDelivery("d-1", "3"); // 3000
    // الكاشير أثبت التسليم: قُبض 2500 من 3000، والعجز 500 على المندوب بسببٍ مصنَّف (قرار المالك ٣٠/٨).
    await confirmDelivered(a.consignmentId, "2500", "MERCHANT_REFUSED_COMMISSION");
    expect(await partyBalance()).toBe("3000.00"); // 2500 نقد + 500 عجز
    const p = await preview();
    expect(p.lines[0].remaining).toBe("2500.00");
    expect(p.expectedCash).toBe("2500.00");
    const res = await settle("2500");
    expect(res.status).toBe("BALANCED");
    expect(res.shortfallTotal).toBe("0.00");
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.moneyStatus).toBe("SETTLED");
    expect(cn.status).toBe("DELIVERED");
    // العجز الأصليّ وحده يبقى ذمّةً على الجهة — لا يُقيَّد ثانيةً عند التوريد.
    expect(await partyBalance()).toBe("500.00");
    expect((await ledger()).filter((e) => e.entryType === "SHORTFALL_ASSIGNED")).toHaveLength(1);
    expect((await board())[0].cashInHandDrift).toBe("0.00");
    expect(await reconcileDeliveryFloat()).toEqual([]);
  });

  it("زيادةٌ على المتوقَّع ⇒ رفض (تحتاج مصدراً)، ولا شيء يُسوَّى ⇒ رفض", async () => {
    await openReception();
    await expect(settle("100")).rejects.toThrow(/لا شيء يُسوَّى/);
    const a = await saleWithDelivery("o-1", "2"); // 2000
    await confirmDelivered(a.consignmentId, "2000");
    await expect(settle("2500")).rejects.toThrow(/النقد المعدود يزيد/);
    expect(await partyBalance()).toBe("2000.00");
    expect((await db().select().from(s.deliveryRemittances)).length).toBe(0);
  });

  it("②-ب إعادةُ الطلب بنفس المفتاح (BALANCED) تعيد السند نفسه بلا تسويةٍ ثانية", async () => {
    await openReception();
    const a = await saleWithDelivery("rp-1", "2"); // 2000
    await confirmDelivered(a.consignmentId, "2000");
    const key = "settle-daily-replay-balanced";
    const first = await settle("2000", undefined, key);
    expect(first.status).toBe("BALANCED");
    expect(first.receiptId).toEqual(expect.any(Number));

    // لقطةُ الحالة بعد التسوية الأولى — إعادةُ الطلب يجب ألّا تحرّك شيئاً منها.
    const before = {
      balance: await partyBalance(),
      remittances: (await db().select().from(s.deliveryRemittances)).length,
      ledger: (await ledger()).length,
      receipts: (await db().select().from(s.receipts)).length,
    };
    expect(before.remittances).toBe(1);

    // نقرٌ مزدوج / إعادةُ شبكة بنفس المفتاح ⇒ نفس SettleDailyResult حرفياً، ولا أثرٌ جديد.
    const again = await settle("2000", undefined, key);
    expect(again).toEqual(first);
    expect(await partyBalance()).toBe(before.balance);
    expect((await db().select().from(s.deliveryRemittances)).length).toBe(before.remittances);
    expect((await ledger()).length).toBe(before.ledger);
    expect((await db().select().from(s.receipts)).length).toBe(before.receipts);
  });

  it("②-ب إعادةُ الطلب بنفس المفتاح (SHORT) تعيد العجزَ المخزَّن بلا تحميلٍ مزدوجٍ على الجهة", async () => {
    await openReception();
    const a = await saleWithDelivery("rp-2", "3"); // 3000
    await confirmDelivered(a.consignmentId, "3000");
    const key = "settle-daily-replay-short";
    const first = await settle("2500", "CUSTOMER_REQUESTED_DISCOUNT", key);
    expect(first.status).toBe("SHORT");
    expect(first.shortfallTotal).toBe("500.00");
    expect(await partyBalance()).toBe("500.00");

    // الإعادةُ تعيد العجزَ نفسه، ولا تُقيّده ثانيةً: نفس الرصيد، سندٌ واحد، قيدُ عجزٍ واحد.
    const again = await settle("2500", "CUSTOMER_REQUESTED_DISCOUNT", key);
    expect(again).toEqual(first);
    expect(await partyBalance()).toBe("500.00");
    expect((await db().select().from(s.deliveryRemittances)).length).toBe(1);
    expect((await ledger()).filter((e) => e.entryType === "SHORTFALL_ASSIGNED")).toHaveLength(1);
  });

  it("②-ب إعادةُ الطلب بنفس المفتاح لكن بحمولةٍ مختلفة ⇒ CONFLICT لا قبولٌ صامتٌ يكذب على الأثر", async () => {
    await openReception();
    const a = await saleWithDelivery("rp-3", "3"); // 3000
    await confirmDelivered(a.consignmentId, "3000");
    const key = "settle-daily-tampered";
    const first = await settle("3000", undefined, key);
    expect(first.status).toBe("BALANCED");
    expect(await partyBalance()).toBe("0.00");

    // نفس المفتاح لكن نقدٌ معدودٌ وسببُ عجزٍ مختلفان ⇒ حمولةٌ مختلفة ⇒ تعارضٌ **قبل** أيّ أثر
    // (لا يُعاد السند القديم صامتاً فيكذب الأثرُ على «2500 بعجز» بينما المخزَّن «3000 متوازن»).
    await expect(settle("2500", "CUSTOMER_REQUESTED_DISCOUNT", key)).rejects.toMatchObject({ code: "CONFLICT" });
    // ولا سندَ ثانٍ، ولا عجزٌ زائفٌ قُيِّد على الجهة.
    expect((await db().select().from(s.deliveryRemittances)).length).toBe(1);
    expect(await partyBalance()).toBe("0.00");
    expect((await ledger()).filter((e) => e.entryType === "SHORTFALL_ASSIGNED")).toHaveLength(0);
  });
});

describe("اقتراح الجهة بالمنطقة — دليلٌ لا تخمين", () => {
  it("من تاريخ الإسناد الفعليّ، بالأجرة الافتراضية للجهة حين لا قاعدةَ منطقة", async () => {
    await openReception();
    await saleWithDelivery("z-1", "1", "baghdad");
    expect(await suggest("baghdad")).toEqual({ partyId: PARTY, partyName: "مندوب", fee: "1500.00" });
    expect(await suggest("basra")).toBeNull();
    expect(await suggest("   ")).toBeNull();
  });

  it("قاعدةُ تسعير المنطقة الفعّالة تغلب الأجرة الافتراضية", async () => {
    await openReception();
    await saleWithDelivery("z-2", "1", "baghdad");
    await db().insert(s.deliveryZones).values([{ id: 1, code: "baghdad", name: "بغداد", isActive: true }]);
    await db().insert(s.deliveryPricingRules).values([{ zoneId: 1, ruleType: "FLAT_FEE", baseFee: "2500.00", isActive: true }]);
    expect(await suggest("Baghdad")).toEqual({ partyId: PARTY, partyName: "مندوب", fee: "2500.00" });
  });

  it("جهةٌ يرفضها حارسُ SLA (طردٌ متأخّر بلا توريد) لا تُقترَح", async () => {
    await openReception();
    const a = await saleWithDelivery("z-3", "1", "baghdad");
    await db().execute(sql`UPDATE deliveryConsignments SET dispatchedAt = DATE_SUB(NOW(), INTERVAL 10 DAY) WHERE id = ${a.consignmentId}`);
    expect(await suggest("baghdad")).toBeNull();
    expect((await board())[0].staleOpenParcels).toBe(1);
  });
});
