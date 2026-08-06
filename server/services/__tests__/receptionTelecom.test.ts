/**
 * ش٥ — رصيد اتصال زين (TELECOM): طريقة دفعٍ خامسة بحسابٍ مشتقٍّ يُسوّى دورياً، بلا أن
 * تلمس الدرج، وبضوابطها معها لا بعدها (§٩.٤).
 *
 * المُثبَت:
 *  T1 (I15+I7) — عربون زين ثم تثبيتٌ ببقيةٍ زين: كل إيصالات TELECOM بcashBucket NULL،
 *      لا تدخل expectedCash، والوردية تُغلق بعدّ الدرج النقديّ وحده (صفر).
 *  T2 (I23) — INFORMATION_SCHEMA: receipts.paymentMethod يحوي TELECOM فعلاً.
 *  T3 (I24) — كل قيم enum طرق الدفع لها ترجمة عربية في الخرائط (خادميّة وعميليّة) —
 *      قيمة بلا ترجمة = مبلغ يظهر برمزٍ أعجميّ أو يختفي من التفكيك.
 *  T4 — كود الكارت أحاديّ الاستعمال: نفس الكود مرّتين ⇒ CONFLICT يسمّي الإيصال الأول.
 *  T5 — سقف العملية وسقف اليوم (ENV) يُنفَّذان برسائل صريحة.
 *  T6 — قفل تقادم المطابقة: أول قبضٍ قديمٌ بلا مطابقة ⇒ قفل؛ مطابقة زين حديثة تفتح؛
 *      مطابقة CARD لا تفتح حساب زين (عزل النوعين).
 *  T7 — الحساب المشتقّ المعمَّم: ملخّص TELECOM = Σ قبض زين، وملخّص CARD لا يختلط به،
 *      ومطابقة زين تُكتب بنوعها وتظهر في قائمتها وحدها.
 *  T8 (D9) — كاشف تركّز زين: موظفٌ نصف وارده زين وفوق الأرضية ⇒ مُعلَّم.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { getAnomalyWatch } from "../reports/anomalyWatch";
import { createCardReconciliation, getCardSummary, listCardReconciliations } from "../cardAccountService";
import { collectDeposit, commitDraft, promoteDraft } from "../reception";

const TABLES = [
  "cardReconciliations", "orderPayments", "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
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
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

const CUSTOM_LINE = {
  lineKind: "CUSTOM" as const, quantity: "1", unitPrice: "45000.00", title: "درع تكريم",
  printSpec: JSON.stringify({ laborCost: "0", priority: "NORMAL", hasDelivery: false }),
};
const GOODS_LINE = {
  lineKind: "GOODS" as const, variantId: 1, productUnitId: 1,
  quantity: "2", unitPrice: "1000.00", title: "دفتر (قطعة)",
};

const uuid = (tag: string) => `${tag}-0000-4000-8000-000000000000`.slice(0, 36);
const CODE = (n: number) => `ZAIN-${String(n).padStart(10, "0")}`;

const SAVED_ENV = { ...process.env };
beforeEach(async () => {
  await reset();
  await seed();
});
afterEach(() => {
  process.env.TELECOM_MAX_PER_TX_IQD = SAVED_ENV.TELECOM_MAX_PER_TX_IQD;
  process.env.TELECOM_MAX_PER_USER_DAY_IQD = SAVED_ENV.TELECOM_MAX_PER_USER_DAY_IQD;
  process.env.TELECOM_RECON_MAX_AGE_DAYS = SAVED_ENV.TELECOM_RECON_MAX_AGE_DAYS;
});

describe("T1 — I15: رصيد زين لا يلمس الدرج أبداً والوردية تُغلق بفارغ صفر", () => {
  it("عربون زين 20,000 ثم تثبيت الباقي 27,000 زين ⇒ كل الإيصالات bucket NULL والإغلاق على صفر نقد", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [GOODS_LINE, CUSTOM_LINE] }, CASHIER);
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "20000.00", method: "TELECOM", reference: CODE(1), clientRequestId: uuid("t1c00001") },
      CASHIER,
    );
    const depReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, dep.receiptId)))[0];
    expect(depReceipt.paymentMethod).toBe("TELECOM");
    expect(depReceipt.cashBucket).toBeNull();

    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId,
      collectNow: { amount: "27000.00", method: "TELECOM", reference: CODE(2) },
    }, CASHIER);
    expect(r.regularSale).not.toBeNull();
    const telecomIns = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.paymentMethod, "TELECOM"), eq(s.receipts.direction, "IN")));
    expect(telecomIns.length).toBeGreaterThanOrEqual(2);
    for (const rc of telecomIns) expect(rc.cashBucket).toBeNull();

    // I7: لا نقد في الدرج ⇒ العدّ صفر والفرق صفر.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "0.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("T2 — I23: قيمة الـenum وصلت القاعدة فعلاً", () => {
  it("INFORMATION_SCHEMA يؤكّد TELECOM في receipts.paymentMethod وworkOrders.woPaymentMethod", async () => {
    const res = await db().execute(sql`
      SELECT TABLE_NAME AS t, COLUMN_TYPE AS ct FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'receipts' AND COLUMN_NAME = 'paymentMethod')
          OR (TABLE_NAME = 'workOrders' AND COLUMN_NAME = 'woPaymentMethod'))
    `);
    const data = (res as unknown as [Array<{ t: string; ct: string }>])[0] ?? res;
    const rows = Array.isArray(data) ? data : [];
    expect(rows.length).toBe(2);
    for (const row of rows) expect(String(row.ct)).toContain("TELECOM");
  });
});

describe("T3 — I24: كل قيمة طريقة دفعٍ لها ترجمة عربية", () => {
  it("خرائط الخادم والعميل تغطّي كل قيم enum المخطط (قيمة بلا ترجمة = مبلغ يختفي)", async () => {
    const enumValues = ["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "EXCHANGE", "TELECOM"];
    const { PAY_METHOD_AR } = await import("../treasury/helpers");
    const { METHOD_LABEL } = await import("../../../client/src/lib/paymentMethod");
    const { PAY_METHOD_LABEL } = await import("../../../client/src/components/reception/cartMath");
    for (const v of enumValues) {
      if (v === "EXCHANGE") continue; // داخليّ (سند صيرفة) — خارج خرائط البيع عمداً
      expect(PAY_METHOD_AR[v], `treasury/helpers بلا ${v}`).toBeTruthy();
      expect((METHOD_LABEL as Record<string, string>)[v], `client paymentMethod بلا ${v}`).toBeTruthy();
    }
    for (const v of ["CASH", "CARD", "TRANSFER", "WALLET", "TELECOM"]) {
      expect((PAY_METHOD_LABEL as Record<string, string>)[v], `reception cartMath بلا ${v}`).toBeTruthy();
    }
  });
});

describe("T4 — كود الكارت أحاديّ الاستعمال", () => {
  it("نفس الكود مرّتين ⇒ CONFLICT، وكودٌ آخر يمرّ", async () => {
    await openReception();
    const p1 = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    await collectDeposit(
      { draftId: p1.draftId, amount: "10000.00", method: "TELECOM", reference: CODE(7), clientRequestId: uuid("t4c00001") },
      CASHIER,
    );
    const p2 = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    await expect(collectDeposit(
      { draftId: p2.draftId, amount: "5000.00", method: "TELECOM", reference: CODE(7), clientRequestId: uuid("t4c00002") },
      CASHIER,
    )).rejects.toThrowError(/سبق قبضُه/);
    const ok = await collectDeposit(
      { draftId: p2.draftId, amount: "5000.00", method: "TELECOM", reference: CODE(8), clientRequestId: uuid("t4c00003") },
      CASHIER,
    );
    expect(ok.idempotentReplay).toBe(false);
  });
});

describe("T5 — سقفا العملية واليوم", () => {
  it("فوق سقف العملية ⇒ رفض؛ وتجاوز السقف اليوميّ تراكمياً ⇒ رفض", async () => {
    process.env.TELECOM_MAX_PER_TX_IQD = "15000";
    process.env.TELECOM_MAX_PER_USER_DAY_IQD = "20000";
    await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    await expect(collectDeposit(
      { draftId: p.draftId, amount: "16000.00", method: "TELECOM", reference: CODE(11), clientRequestId: uuid("t5c00001") },
      CASHIER,
    )).rejects.toThrowError(/محدود/);

    await collectDeposit(
      { draftId: p.draftId, amount: "14000.00", method: "TELECOM", reference: CODE(12), clientRequestId: uuid("t5c00002") },
      CASHIER,
    );
    await expect(collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "TELECOM", reference: CODE(13), clientRequestId: uuid("t5c00003") },
      CASHIER,
    )).rejects.toThrowError(/سقفك اليوميّ/);
  });
});

describe("T6 — قفل تقادم المطابقة", () => {
  it("أول قبضٍ متقادم بلا مطابقة ⇒ قفل؛ مطابقة CARD لا تفتح؛ مطابقة TELECOM تفتح", async () => {
    await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    const first = await collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "TELECOM", reference: CODE(21), clientRequestId: uuid("t6c00001") },
      CASHIER,
    );
    // نُقادم أول قبضٍ (٩ أيام) — الحدّ الافتراضي ٧.
    await db().update(s.receipts)
      .set({ createdAt: new Date(Date.now() - 9 * 86_400_000) })
      .where(eq(s.receipts.id, first.receiptId));

    await expect(collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "TELECOM", reference: CODE(22), clientRequestId: uuid("t6c00002") },
      CASHIER,
    )).rejects.toThrowError(/لم يُطابَق|متقادمة/);

    // مطابقة CARD لا تخصّ حساب زين ⇒ القفل باقٍ (عزل النوعين).
    await createCardReconciliation(
      { branchId: 1, accountKind: "CARD", asOfDate: new Date().toISOString().slice(0, 10), statementBalance: "0.00" },
      { userId: 1, role: "manager", branchId: 1 },
    );
    await expect(collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "TELECOM", reference: CODE(23), clientRequestId: uuid("t6c00003") },
      CASHIER,
    )).rejects.toThrowError(/لم يُطابَق|متقادمة/);

    // مطابقة TELECOM حديثة ⇒ يُفتح القبض.
    await createCardReconciliation(
      { branchId: 1, accountKind: "TELECOM", asOfDate: new Date().toISOString().slice(0, 10), statementBalance: "5000.00" },
      { userId: 1, role: "manager", branchId: 1 },
    );
    const ok = await collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "TELECOM", reference: CODE(24), clientRequestId: uuid("t6c00004") },
      CASHIER,
    );
    expect(ok.idempotentReplay).toBe(false);
  });
});

describe("T7 — الحساب المشتقّ المعمَّم بلا اختلاط", () => {
  it("ملخّص TELECOM = قبض زين وحده، وملخّص CARD منفصل، والمطابقة بنوعها في قائمتها وحدها", async () => {
    await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    await collectDeposit(
      { draftId: p.draftId, amount: "12000.00", method: "TELECOM", reference: CODE(31), clientRequestId: uuid("t7c00001") },
      CASHIER,
    );
    await collectDeposit(
      { draftId: p.draftId, amount: "8000.00", method: "CARD", reference: "CARD-31", clientRequestId: uuid("t7c00002") },
      CASHIER,
    );

    const scope = { role: "manager", branchId: 1 };
    const telecom = await getCardSummary({ branchId: 1, accountKind: "TELECOM" }, scope);
    const card = await getCardSummary({ branchId: 1, accountKind: "CARD" }, scope);
    expect(telecom.balance).toBe("12000.00");
    expect(card.balance).toBe("8000.00");

    const rec = await createCardReconciliation(
      { branchId: 1, accountKind: "TELECOM", asOfDate: new Date().toISOString().slice(0, 10), statementBalance: "12000.00" },
      { userId: 1, role: "manager", branchId: 1 },
    );
    expect(rec.systemBalance).toBe("12000.00");
    expect(rec.difference).toBe("0.00");
    const telecomList = await listCardReconciliations({ branchId: 1, accountKind: "TELECOM" }, scope);
    const cardList = await listCardReconciliations({ branchId: 1, accountKind: "CARD" }, scope);
    expect(telecomList.length).toBe(1);
    expect(cardList.length).toBe(0);
    // ملخّص زين يحمل آخر مطابقته.
    const telecomAfter = await getCardSummary({ branchId: 1, accountKind: "TELECOM" }, scope);
    expect(telecomAfter.lastReconciliation?.difference).toBe("0.00");
  });
});

describe("T8 — D9: تركّز رصيد زين لدى موظف", () => {
  it("موظفٌ وارده 150,000 زين من 250,000 (60٪) ⇒ مُعلَّم", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [{ ...CUSTOM_LINE, unitPrice: "300000.00" }] }, CASHIER);
    await collectDeposit(
      { draftId: p.draftId, amount: "150000.00", method: "TELECOM", reference: CODE(41), clientRequestId: uuid("t8c00001") },
      CASHIER,
    );
    await collectDeposit(
      { draftId: p.draftId, amount: "100000.00", method: "CASH", clientRequestId: uuid("t8c00002") },
      CASHIER,
    );
    const today = new Date().toISOString().slice(0, 10);
    const aw = await getAnomalyWatch({ from: today, to: today, branchId: 1 });
    const row = aw.telecomShares.rows.find((x) => x.userId === 2);
    expect(row).toBeTruthy();
    expect(Number(row!.telecomIn)).toBe(150000);
    expect(row!.flagged).toBe(true);
    expect(aw.kpis.flaggedTelecomCollectors).toBe(1);
    // للنظافة: أغلق الوردية (نقد 100,000 وحده في الدرج).
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "100000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});
