/**
 * م١ (PR-4) — مساراتُ العجز الثلاثة تلتقي في مسارٍ ماليّ واحد (`confirmConsignmentDelivery`):
 *
 *  (ج) **بوّابةُ المندوب**: `collectedAmount` اختياريّ — غيابُه = المتبقّي كاملاً كما كان؛ وقيمةٌ أقلّ
 *      تلزمها `shortfallReason` وإلّا رُفض الختم بالعبارة المتعاقَد عليها («بلا سبب مصنَّف»)، وبها
 *      يُقيَّد `SHORTFALL_ASSIGNED` ذمّةً فوريّة على الجهة والفاتورةُ تُقفَل مسدَّدة.
 *  (كشف الشركة) سطرٌ يحمل `shortfallReason` يقيّد العجزَ كالمسارَين الآخرَين ويُغلق الطرد عند
 *      التوريد (المُحصَّل + العجزُ المُقيَّد = COD)؛ وسطرٌ بلا سبب يُبقي قرار المالك (٢١/٨):
 *      المتبقّي ذمّةُ عميلٍ حيّة — لا تغييرَ صامت في السلوك القائم.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { confirmConsignmentDelivery } from "../delivery/courier";
import { recordCompanyStatement } from "../delivery/companyStatement";
import { openShift } from "../shiftService";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const DRIVER_USER = 6;
const PARTY = 1;
const CUSTOMER = 1;

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
    { id: DRIVER_USER, openId: "drv", name: "مندوب", email: "d@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: CUSTOMER, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.deliveryParties).values([
    { id: PARTY, name: "شركة توصيل", partyType: "COMPANY", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "0.00", maxOpenParcelAgeDays: 7 },
  ]);
  await d.insert(s.deliveryPartyMembers).values([{ partyId: PARTY, userId: DRIVER_USER, memberRole: "DRIVER", isActive: true }]);
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
/** بيعٌ بثلاث قطع (3000) مُسنَدٌ للتوصيل داخل المعاملة نفسها (PR-1). */
async function saleWithDelivery(reqId: string) {
  const r = await createSale({
    branchId: 1, sourceType: "POS", customerId: CUSTOMER,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
    delivery: { partyId: PARTY, fee: "0", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد" },
    clientRequestId: reqId,
  }, CASHIER);
  return { invoiceId: r.invoiceId, consignmentId: r.consignmentId! };
}
/** سلسلةُ البوّابة تُختصر: الختمُ من البوّابة يشترط «خرج للتوصيل». */
const markOutForDelivery = (consignmentId: number) =>
  db().execute(sql`UPDATE deliveryConsignments SET parcelStatus = 'OUT_FOR_DELIVERY' WHERE id = ${consignmentId}`);

const consignmentOf = async (id: number) =>
  (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0];
const invoiceOf = async (id: number) =>
  (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
const ledgerOf = async (consignmentId: number) =>
  db().select().from(s.deliveryLedgerEntries).where(eq(s.deliveryLedgerEntries.consignmentId, consignmentId));
const partyBalance = async () =>
  String((await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, PARTY)))[0].currentBalance);
const customerBalance = async () =>
  String((await db().select().from(s.customers).where(eq(s.customers.id, CUSTOMER)))[0].currentBalance);

beforeEach(async () => {
  await reset();
  await seed();
});

describe("(ج) بوّابةُ المندوب — عجزٌ بسببٍ إلزاميّ", () => {
  it("⭐ collectedAmount أقلّ من المتبقّي + سبب مصنَّف ⇒ COD_COLLECTED + SHORTFALL_ASSIGNED، الفاتورة PAID، ذمّة العميل صفر", async () => {
    const a = await saleWithDelivery("portal-short");
    await markOutForDelivery(a.consignmentId);

    const res = await confirmConsignmentDelivery(
      { consignmentId: a.consignmentId, clientRequestId: "portal-short-confirm", collectedAmount: "2500", shortfallReason: "MERCHANT_REFUSED_COMMISSION" },
      { userId: DRIVER_USER },
    );
    expect(res.alreadyDelivered).toBeFalsy();

    const ledger = await ledgerOf(a.consignmentId);
    expect(ledger.find((e) => e.entryType === "COD_COLLECTED")?.amount).toBe("2500.00");
    const shortfall = ledger.find((e) => e.entryType === "SHORTFALL_ASSIGNED");
    expect(shortfall?.amount).toBe("500.00");
    expect(shortfall?.shortfallReason).toBe("MERCHANT_REFUSED_COMMISSION");
    // المندوبُ المدينُ البديل: عهدته 3000 (2500 نقداً + 500 عجزاً)، والعميل بريء الذمّة.
    expect(await partyBalance()).toBe("3000.00");
    expect(await customerBalance()).toBe("0.00");
    const inv = await invoiceOf(a.invoiceId);
    expect(inv.paidAmount).toBe("3000.00");
    expect(inv.status).toBe("PAID");
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("DELIVERED");
    expect(cn.status).toBe("DISPATCHED"); // الإغلاق الماليّ ينتظر التوريد
  });

  it("collectedAmount أقلّ من المتبقّي بلا سبب ⇒ رفضٌ بالعبارة المتعاقَد عليها ولا أثرَ ماليّ", async () => {
    const a = await saleWithDelivery("portal-noreason");
    await markOutForDelivery(a.consignmentId);
    await expect(
      confirmConsignmentDelivery(
        { consignmentId: a.consignmentId, clientRequestId: "portal-noreason-confirm", collectedAmount: "2500" },
        { userId: DRIVER_USER },
      ),
    ).rejects.toThrow(/بلا سبب مصنَّف/);
    expect((await ledgerOf(a.consignmentId)).map((e) => e.entryType)).toEqual(["COD_ASSIGNED"]);
    expect(await partyBalance()).toBe("0.00");
    expect((await consignmentOf(a.consignmentId)).parcelStatus).toBe("OUT_FOR_DELIVERY");
  });

  it("collectedAmount أكثر من المتبقّي ⇒ رفضٌ (لا زائدَ بلا مستند)", async () => {
    const a = await saleWithDelivery("portal-over");
    await markOutForDelivery(a.consignmentId);
    await expect(
      confirmConsignmentDelivery(
        { consignmentId: a.consignmentId, clientRequestId: "portal-over-confirm", collectedAmount: "3500", shortfallReason: "MERCHANT_REFUSED_COMMISSION" },
        { userId: DRIVER_USER },
      ),
    ).rejects.toThrow(/أكثر من المتبقّي/);
  });

  it("بلا collectedAmount ⇒ الختمُ يعني قبض المتبقّي كاملاً كما كان (لا انحدار)", async () => {
    const a = await saleWithDelivery("portal-full");
    await markOutForDelivery(a.consignmentId);
    await confirmConsignmentDelivery({ consignmentId: a.consignmentId, clientRequestId: "portal-full-confirm" }, { userId: DRIVER_USER });
    const ledger = await ledgerOf(a.consignmentId);
    expect(ledger.find((e) => e.entryType === "COD_COLLECTED")?.amount).toBe("3000.00");
    expect(ledger.find((e) => e.entryType === "SHORTFALL_ASSIGNED")).toBeUndefined();
    expect(await partyBalance()).toBe("3000.00");
    expect((await invoiceOf(a.invoiceId)).status).toBe("PAID");
  });
});

describe("كشفُ الشركة — العجزُ اختيارٌ في السطر لا في الشيفرة", () => {
  it("⭐ سطرٌ بسببٍ مصنَّف ⇒ SHORTFALL_ASSIGNED يُقيَّد، والتوريدُ يُغلق الطرد (المُحصَّل + العجز = COD)", async () => {
    await openReception();
    const a = await saleWithDelivery("stmt-short");
    const res = await recordCompanyStatement({
      branchId: 1, partyId: PARTY, statementNumber: "ST-SHORT-1",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "2500", shortfallReason: "MERCHANT_REFUSED_COMMISSION" }],
      countedCash: "2500", clientRequestId: "stmt-short-1",
    }, CASHIER);
    expect(res.deliveriesConfirmed).toBe(1);
    expect(res.collectedTotal).toBe("2500.00");

    const ledger = await ledgerOf(a.consignmentId);
    expect(ledger.find((e) => e.entryType === "SHORTFALL_ASSIGNED")?.amount).toBe("500.00");
    expect(ledger.find((e) => e.entryType === "COD_COLLECTED")?.amount).toBe("2500.00");
    expect(ledger.find((e) => e.entryType === "COD_REMITTED")?.amount).toBe("2500.00");
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.status).toBe("DELIVERED");
    expect(cn.moneyStatus).toBe("SETTLED");
    // ما بقي بذمّة الجهة هو العجز وحده — نقدٌ لم تقبضه لكنّها تحمّلته.
    expect(await partyBalance()).toBe("500.00");
    expect(await customerBalance()).toBe("0.00");
    expect((await invoiceOf(a.invoiceId)).status).toBe("PAID");
  });

  it("سطرٌ بلا سبب ⇒ السلوك القائم (قرار المالك ٢١/٨): لا عجزٌ على الجهة والمتبقّي ذمّةُ عميلٍ حيّة", async () => {
    await openReception();
    const a = await saleWithDelivery("stmt-legacy");
    await recordCompanyStatement({
      branchId: 1, partyId: PARTY, statementNumber: "ST-LEGACY-1",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "2500" }],
      countedCash: "2500", clientRequestId: "stmt-legacy-1",
    }, CASHIER);
    const ledger = await ledgerOf(a.consignmentId);
    expect(ledger.find((e) => e.entryType === "SHORTFALL_ASSIGNED")).toBeUndefined();
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.status).toBe("PARTIAL");
    expect(cn.moneyStatus).toBe("PARTIAL");
    expect(await partyBalance()).toBe("0.00");
    expect(await customerBalance()).toBe("500.00");
    const inv = await invoiceOf(a.invoiceId);
    expect(inv.paidAmount).toBe("2500.00");
    expect(inv.status).toBe("PARTIALLY_PAID");
  });

  it("سطرٌ بسببٍ خارج القائمة ⇒ رفضٌ صريح بلا أثر", async () => {
    await openReception();
    const a = await saleWithDelivery("stmt-badreason");
    await expect(recordCompanyStatement({
      branchId: 1, partyId: PARTY, statementNumber: "ST-BAD-1",
      lines: [{ consignmentId: a.consignmentId, collectedAmount: "2500", shortfallReason: "NOT_A_REASON" }],
      countedCash: "2500", clientRequestId: "stmt-bad-1",
    }, CASHIER)).rejects.toThrow(/غير معروف في القائمة/);
    expect((await ledgerOf(a.consignmentId)).map((e) => e.entryType)).toEqual(["COD_ASSIGNED"]);
    expect((await consignmentOf(a.consignmentId)).parcelStatus).toBe("ASSIGNED");
  });
});
