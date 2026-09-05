/**
 * م١ (PR-3) — الدفترُ الإلحاقيّ مصدرَ الحقيقة لـ«النقد بيد الجهة»: الثابتان وحارسُ التقادم.
 *
 * الثابت ١ (لكلّ طرد): **Σ أحداث التعرّض = 0 عند الإغلاق**
 *   exposure(cn) = COD_ASSIGNED − COD_COLLECTED − COD_RELEASED − SHORTFALL_ASSIGNED(الطرد)
 *   على السيناريوهات الأربعة: تسليم+توريد · إرجاعٌ فعليّ · إلغاءُ إسناد · عجزٌ+شطب.
 * الثابت ٢ (لكلّ جهة): **العهدةُ المشتقّة من الدفتر = العمود المخزَّن** بعد كلّ حركة
 *   (`deriveCashInHandFromLedger` ≡ `deliveryParties.currentBalance`) — وهو ما يُقلَب عليه العلَم.
 * الحارس (أ): `deliveryParties.version` يرتفع مع كلّ حركة عهدة ⇒ طلبُ شطبٍ فُتح قبل تغيّر العهدة
 *   يعود `STALE` عند الاعتماد بدل أن يُطبَّق على رصيدٍ لم يعد قائماً.
 *
 * حيث لا يصفر الثابت ⇒ يُصلَح الكاتب لا الاختبار.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { deriveCashInHandFromLedger } from "@shared/partyExposure";
import { createSale } from "../sale/create";
import { recordStaffDeliveryConfirmation } from "../delivery/companyStatement";
import { settleDailyTx } from "../delivery/dailySettlement";
import { returnConsignment } from "../delivery/returns";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { writeOffDeliveryShortfall } from "../delivery/settle";
import { approveDeliveryCodWriteOff, requestDeliveryCodWriteOff } from "../delivery/writeoffRequests";
import { reconcileDeliveryFloat } from "../reconcileService";
import { openShift } from "../shiftService";
import { withTx } from "../tx";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "deliveryCodWriteOffRequests",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
/** المالك (أدمن) — يفتح طلبات الشطب؛ وأدمنٌ ثانٍ يعتمدها (فصل المهام). */
const OWNER = { userId: 4, branchId: 1, role: "admin", isOwner: true };
const REVIEWER = { userId: 5, branchId: 1, role: "admin", reviewAuthorized: true as const };
const PARTY = 1;
const EVIDENCE = { evidenceNote: "محضر مطابقة عهدة موقع من طرفين" } as const;

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
    { id: 4, openId: "own", name: "مالك", email: "o@t.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 5, openId: "adm2", name: "أدمن ثانٍ", email: "a2@t.test", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.deliveryParties).values([
    { id: PARTY, name: "مندوب", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "0.00", maxOpenParcelAgeDays: 7 },
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
async function saleWithDelivery(reqId: string, quantity: string) {
  const r = await createSale({
    branchId: 1, sourceType: "POS", customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity }],
    delivery: { partyId: PARTY, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد" },
    clientRequestId: reqId,
  }, CASHIER);
  return { invoiceId: r.invoiceId, consignmentId: r.consignmentId! };
}
const confirm = (consignmentId: number, collectedAmount: string, shortfallReason?: string) =>
  recordStaffDeliveryConfirmation(
    { consignmentId, collectedAmount, evidence: "اتصال المندوب", clientRequestId: `staff-${consignmentId}`, shortfallReason },
    CASHIER,
  );
const settle = (countedCash: string, key: string, shortfallReason?: string) =>
  withTx((tx) => settleDailyTx(tx, { partyId: PARTY, branchId: 1, countedCash, shortfallReason, shiftType: "RECEPTION", clientRequestId: key }, CASHIER));

const EXPOSURE_SIGN: Record<string, number> = {
  COD_ASSIGNED: 1, COD_COLLECTED: -1, COD_RELEASED: -1, SHORTFALL_ASSIGNED: -1,
};
async function exposureOf(consignmentId: number): Promise<string> {
  const rows = await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.consignmentId, consignmentId));
  return rows.reduce((sum, e) => sum + (EXPOSURE_SIGN[e.entryType] ?? 0) * Number(e.amount), 0).toFixed(2);
}
async function partyLedgerVsStored(): Promise<{ ledger: string; stored: string }> {
  const rows = await db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.partyId, PARTY));
  const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, PARTY)))[0];
  return { ledger: deriveCashInHandFromLedger(rows.map((e) => ({ entryType: e.entryType, amount: e.amount }))), stored: String(party.currentBalance) };
}
async function expectBalanced(consignmentId: number) {
  expect(await exposureOf(consignmentId), "Σ التعرّض للطرد").toBe("0.00");
  const { ledger, stored } = await partyLedgerVsStored();
  expect(ledger, "العهدة المشتقّة = المخزَّنة").toBe(stored);
  expect(await reconcileDeliveryFloat()).toEqual([]);
}
const partyVersion = async () => Number((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, PARTY)))[0].version);

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ثابت الدفتر لكلّ طرد: Σ التعرّض = 0 عند الإغلاق، والعهدة المشتقّة = المخزَّنة", () => {
  it("تسليم + توريد", async () => {
    await openReception();
    const a = await saleWithDelivery("inv-a", "2"); // 2000
    expect(await exposureOf(a.consignmentId)).toBe("2000.00");
    await confirm(a.consignmentId, "2000");
    expect(await exposureOf(a.consignmentId)).toBe("0.00");
    expect((await partyLedgerVsStored()).ledger).toBe("2000.00");
    await settle("2000", "inv-a-settle");
    await expectBalanced(a.consignmentId);
    expect((await partyLedgerVsStored()).stored).toBe("0.00");
  });

  it("إرجاعٌ فعليّ لطردٍ لم يخرج", async () => {
    await openReception();
    const a = await saleWithDelivery("inv-b", "2");
    await returnConsignment(a.consignmentId, { ...MANAGER, clientRequestId: "ret-b", returnReason: "رفض العميل" });
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    expect(cn.status).toBe("RETURNED");
    await expectBalanced(a.consignmentId);
  });

  it("إلغاءُ إسناد", async () => {
    await openReception();
    const a = await saleWithDelivery("inv-c", "2");
    await cancelDeliveryAssignment({ consignmentId: a.consignmentId, reason: "أُسند خطأً", clientRequestId: "cancel-c" }, MANAGER);
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    expect(cn.status).toBe("CANCELLED");
    await expectBalanced(a.consignmentId);
  });

  it("عجزٌ عند التسليم + توريد + شطبُ العجز", async () => {
    await openReception();
    const a = await saleWithDelivery("inv-d", "3"); // 3000
    await confirm(a.consignmentId, "2500", "MERCHANT_REFUSED_COMMISSION");
    // التعرّض صفرٌ منذ التسليم: 3000 − 2500 مقبوضة − 500 عجزٌ على المندوب.
    expect(await exposureOf(a.consignmentId)).toBe("0.00");
    expect((await partyLedgerVsStored())).toEqual({ ledger: "3000.00", stored: "3000.00" });
    await settle("2500", "inv-d-settle");
    expect((await partyLedgerVsStored())).toEqual({ ledger: "500.00", stored: "500.00" });
    // الشطبُ المجمَّع للعجز (عهدةٌ سائبة بلا طردٍ مفتوح) — خسارةٌ مُثبَتة بمحضر.
    await writeOffDeliveryShortfall({ branchId: 1, partyId: PARTY, amount: "500", reason: "المندوب أقرّ بضياع النقد", ...EVIDENCE, clientRequestId: "wo-d" }, OWNER);
    await expectBalanced(a.consignmentId);
    expect((await partyLedgerVsStored())).toEqual({ ledger: "0.00", stored: "0.00" });
  });
});

describe("(أ) حارس STALE يحيا: version يرتفع مع كلّ حركة عهدة", () => {
  it("⭐ طلبُ شطبٍ فُتح ثمّ تغيّرت العهدة ⇒ الاعتماد يعود STALE ولا يُطبَّق", async () => {
    await openReception();
    const a = await saleWithDelivery("st-a", "2");
    await confirm(a.consignmentId, "2000"); // العهدة 2000
    const v0 = await partyVersion();
    // شطبٌ موجَّه إلى الطرد: عهدةُ الجهة كلُّها مسنودةٌ بطردٍ مُسلَّمٍ لم يُورَّد، والشطبُ المجمَّع
    // يمسّ العهدة السائبة وحدها (حارس `consignmentBackedBalance`) فيرفض هنا بحقّ.
    const req = await requestDeliveryCodWriteOff(
      { requestKey: "req-stale-1", branchId: 1, partyId: PARTY, consignmentId: a.consignmentId, amount: "2000", reason: "المندوب أقرّ بضياع النقد", ...EVIDENCE },
      OWNER,
    );
    expect(Number(req.basePartyVersion)).toBe(v0);

    // حركةُ عهدةٍ بعد فتح الطلب: تسليمٌ آخر يرفع العهدة — و`version` يرتفع معها.
    const b = await saleWithDelivery("st-b", "1");
    await confirm(b.consignmentId, "1000");
    expect(await partyVersion()).toBeGreaterThan(v0);

    // الاعتمادُ يَسِم الطلب STALE داخل المعاملة ثمّ يرفض بعدها برسالةٍ تسمّي السبب — لا يُطبَّق شيء.
    await expect(
      approveDeliveryCodWriteOff({ id: Number(req.id), expectedVersion: Number(req.basePartyVersion), decisionKey: "dec-stale-1" }, REVIEWER),
    ).rejects.toThrow(/وُسِم STALE/);
    const row = (await db().select().from(s.deliveryCodWriteOffRequests).where(eq(s.deliveryCodWriteOffRequests.id, Number(req.id))))[0];
    expect(row.status).toBe("STALE");
    // لم يُشطَب شيء: العهدة كما هي والدفتر يطابقها.
    expect((await partyLedgerVsStored())).toEqual({ ledger: "3000.00", stored: "3000.00" });
    expect((await db().select().from(s.deliveryLedgerEntries)).some((e) => e.entryType === "COD_WRITTEN_OFF")).toBe(false);
  });

  it("وبلا حركةٍ بين الفتح والاعتماد يُطبَّق الشطب عادةً (لا إنذار كاذب)", async () => {
    await openReception();
    const a = await saleWithDelivery("st-c", "2");
    await confirm(a.consignmentId, "2000");
    const req = await requestDeliveryCodWriteOff(
      // الشطبُ الموجَّه يكون بكامل متبقّي الطرد (2000) — قاعدةُ `writeOffDeliveryShortfallInTx`.
      { requestKey: "req-ok-1", branchId: 1, partyId: PARTY, consignmentId: a.consignmentId, amount: "2000", reason: "المندوب أقرّ بضياع النقد", ...EVIDENCE },
      OWNER,
    );
    const res = await approveDeliveryCodWriteOff({ id: Number(req.id), expectedVersion: Number(req.basePartyVersion), decisionKey: "dec-ok-1" }, REVIEWER);
    expect((res as { stale?: boolean }).stale).not.toBe(true);
    const row = (await db().select().from(s.deliveryCodWriteOffRequests).where(eq(s.deliveryCodWriteOffRequests.id, Number(req.id))))[0];
    expect(row.status).toBe("APPROVED");
    expect((await partyLedgerVsStored())).toEqual({ ledger: "0.00", stored: "0.00" });
    expect(await exposureOf(a.consignmentId), "Σ التعرّض للطرد المشطوب").toBe("0.00");
  });
});
