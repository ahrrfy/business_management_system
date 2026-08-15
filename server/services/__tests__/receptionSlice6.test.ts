/**
 * ش٦ — الربط البينيّ والإنتاجية.
 *
 * المُثبَت:
 *  S1 (V15) — أمانة أجرة توصيل الطلب (deliveryFeeHeld): إيصال IN نقديّ DRAWER + قيد
 *      DELIVERY_FEE_HELD مع الفاتورة الحاملة ⇒ **الوردية تُغلق بفارغ صفر** (معيار القبول)،
 *      وإسناد COUNTER يمرّ مع الأمانة ويُرفض بدونها.
 *  S2 — تقريب السلّة المختلطة: فرق تقريب السلّة كلّها على الفاتورة الحاملة (ADJUST) والدرج
 *      يطابق المقرَّب؛ والدفعة الجزئية تبقى بلا تقريب (S3).
 *  S4 — كواشف D10 (مموّلة معلّقة >٢٤س) وD11 (تسديد فواتير الغير) وD12 (خفض بعد قبض).
 *  S5 — سطرا إقفال اليوم (مسوّدات مموّلة + خصم كل موظف).
 *  S6 (§٩.٣) — هويّة مُقِرّ السعر: سطر تدقيق reception.priceOverride داخل المعاملة.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { getAnomalyWatch } from "../reports/anomalyWatch";
import { getDayCloseReconciliation } from "../reportsDayCloseService";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { collectDeposit, collectOnReceptionInvoice, commitDraft, promoteDraft, syncDraft } from "../reception";

const TABLES = [
  "deliveryConsignments", "deliveryParties", "cardReconciliations", "orderPayments",
  "receptionDraftLines", "receptionDrafts", "auditLogs",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  await d.insert(s.deliveryParties).values([{ id: 1, name: "مندوب الاختبار", partyType: "INDIVIDUAL", defaultFee: "5000.00" }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

const GOODS_LINE = {
  lineKind: "GOODS" as const, variantId: 1, productUnitId: 1,
  quantity: "2", unitPrice: "1000.00", title: "دفتر (قطعة)",
};
const CUSTOM_LINE_45100 = {
  lineKind: "CUSTOM" as const, quantity: "1", unitPrice: "45100.00", title: "درع تكريم",
  printSpec: JSON.stringify({ laborCost: "0", priority: "NORMAL", hasDelivery: false }),
};
const uuid = (tag: string) => `${tag}-0000-4000-8000-000000000000`.slice(0, 36);

beforeEach(async () => {
  await reset();
  await seed();
});

describe("S1 — أمانة أجرة توصيل الطلب (deliveryFeeHeld) ترفع حظر COUNTER", () => {
  it("بضاعة 2,000 + أجرة 5,000 ⇒ إيصالان والوردية تُغلق بفارغ صفر، والإسناد COUNTER يمرّ؛ وبلا أمانةٍ يُرفض", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [GOODS_LINE] }, CASHIER);
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "2000.00", shiftId: shift.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
      deliveryFeeHeld: "5000.00",
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;

    const feeRcpt = (await db().select().from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `DLV-FEE-INV-${invoiceId}`)))[0];
    expect(feeRcpt).toBeTruthy();
    expect(feeRcpt.direction).toBe("IN");
    expect(feeRcpt.paymentMethod).toBe("CASH");
    expect(feeRcpt.cashBucket).toBe("DRAWER");
    expect(String(feeRcpt.amount)).toBe("5000.00");
    const heldEntry = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `DELIVERY_FEE_HELD:INV:${invoiceId}`)))[0];
    expect(heldEntry).toBeTruthy();
    expect(String(heldEntry.amount)).toBe("5000.00");
    expect(String(heldEntry.revenue ?? "0.00")).toBe("0.00");

    // معيار القبول: الدرج = البضاعة + الأمانة، والوردية تُغلق بفارغ **صفر**.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "7000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");

    // الإسناد COUNTER يمرّ (الأمانة تغطّي الأجرة)…
    const d1 = await dispatchInvoiceToDelivery(
      { invoiceId, partyId: 1, deliveryFee: "5000.00", feeCollection: "COUNTER", clientRequestId: uuid("s1d00001") },
      { userId: 1, branchId: 1, role: "manager" } as never,
    );
    expect(d1).toBeTruthy();

    // …وفاتورةٌ بلا أمانةٍ تُرفض بنفس الرسالة القديمة المحسَّنة.
    const shift2 = await openReception();
    const p2 = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [GOODS_LINE] }, CASHIER);
    const r2 = await commitDraft({
      draftId: p2.draftId, version: 0, expectedTotal: "2000.00", shiftId: shift2.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
    }, CASHIER);
    await expect(dispatchInvoiceToDelivery(
      { invoiceId: r2.regularSale!.invoiceId, partyId: 1, deliveryFee: "5000.00", feeCollection: "COUNTER", clientRequestId: uuid("s1d00002") },
      { userId: 1, branchId: 1, role: "manager" } as never,
    )).rejects.toThrowError(/تتطلّب قبض الأجرة/);
  });
});

describe("S2/S3 — تقريب السلّة المختلطة على الفاتورة الحاملة", () => {
  it("بضاعة 2,000 + تخصيص 45,100 = 47,100 ⇒ نقدي كامل 47,000: ADJUST −100 على فاتورة البضاعة والدرج مقرَّب", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [GOODS_LINE, CUSTOM_LINE_45100] }, CASHIER);
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47100.00", shiftId: shift.shiftId,
      collectNow: { amount: "47000.00", method: "CASH" },
      cashRoundIQD: true,
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(String(inv.total)).toBe("1900.00"); // 2,000 − 100 (فرق تقريب السلّة كلّها)
    const adj = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ADJUST:IQD:${invoiceId}`)))[0];
    expect(adj).toBeTruthy();
    expect(String(adj.amount)).toBe("-100.00");
    // العربون الموزَّع على أمر الشغل كامل قيمته.
    expect(r.workOrders[0].deposit).toBe("45100.00");
    // الدرج = المقرَّب بالضبط ⇒ الإغلاق بفارغ صفر.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "47000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });

  it("S3: دفعةٌ جزئية على سلّةٍ مختلطة تبقى بلا تقريب (الفاتورة بالخام)", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [GOODS_LINE, CUSTOM_LINE_45100] }, CASHIER);
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47100.00", shiftId: shift.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
      cashRoundIQD: true,
    }, CASHIER);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.regularSale!.invoiceId)))[0];
    expect(String(inv.total)).toBe("2000.00");
    const adj = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ADJUST:IQD:${r.regularSale!.invoiceId}`));
    expect(adj.length).toBe(0);
  });
});

describe("S4 — كواشف ش٦", () => {
  it("D10: مسوّدة مموّلة OPEN أقدم من ٢٤ ساعة تظهر صفاً إنذارياً", async () => {
    await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE_45100] }, CASHIER);
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("s4a00001") },
      CASHIER,
    );
    await db().update(s.receptionDrafts)
      .set({ createdAt: new Date(Date.now() - 30 * 3_600_000) })
      .where(eq(s.receptionDrafts.id, p.draftId));
    const today = new Date().toISOString().slice(0, 10);
    const aw = await getAnomalyWatch({ from: today, to: today, branchId: 1 });
    const row = aw.fundedStaleDrafts.rows.find((x) => x.draftId === p.draftId);
    expect(row).toBeTruthy();
    expect(Number(row!.heldNet)).toBe(10000);
    expect(row!.ageHours).toBeGreaterThanOrEqual(24);
    expect(aw.kpis.fundedStaleDrafts).toBeGreaterThanOrEqual(1);
  });

  it("D11: خمسة تسديداتٍ على فواتير أنشأها غير القابض ⇒ مُعلَّم", async () => {
    const shift = await openReception(2);
    for (let i = 0; i < 5; i += 1) {
      await db().insert(s.invoices).values({
        id: 9100 + i,
        invoiceNumber: `INV-S6-${i}`,
        sourceType: "POS",
        sourceId: `s6-${i}`,
        branchId: 1,
        customerId: 1,
        priceTier: "RETAIL",
        subtotal: "10000",
        total: "10000",
        paidAmount: "0",
        status: "PENDING",
        shiftId: shift.shiftId,
        createdBy: 1, // أنشأها المدير — والقابض الموظف 2
      });
      await collectOnReceptionInvoice(
        { invoiceId: 9100 + i, amount: "2000.00", method: "CASH", clientRequestId: uuid(`s4b0000${i}`) },
        { userId: 2, branchId: 1, role: "cashier" },
      );
    }
    await db().insert(s.receipts).values([
      {
        invoiceId: 9100, branchId: 1, shiftId: shift.shiftId, cashBucket: "DRAWER",
        direction: "IN", amount: "500000.00", paymentMethod: "CASH", status: "COMPLETED",
        approvalStatus: "PENDING_APPROVAL", createdBy: 2,
      },
      {
        invoiceId: 9100, branchId: 1, shiftId: shift.shiftId, cashBucket: "DRAWER",
        direction: "IN", amount: "400000.00", paymentMethod: "CASH", status: "COMPLETED",
        approvalStatus: "REJECTED", createdBy: 2,
      },
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const aw = await getAnomalyWatch({ from: today, to: today, branchId: 1 });
    const row = aw.othersCollections.rows.find((x) => x.userId === 2);
    expect(row).toBeTruthy();
    expect(row!.receiptCount).toBe(5);
    expect(Number(row!.totalAmount)).toBe(10000);
    expect(row!.flagged).toBe(true);
  });

  it("D12: خفض إجمالي مسوّدةٍ مموّلة يكتب حدث تدقيقٍ ويلتقطه الكاشف", async () => {
    await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE_45100] }, CASHIER);
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("s4c00001") },
      CASHIER,
    );
    // خفضٌ فوق المحتجز (مشروعٌ لكنه إشارة): 45,100 ← 20,000.
    await syncDraft({
      draftId: p.draftId,
      version: 0,
      header: { customerId: 1 },
      lines: [{ ...CUSTOM_LINE_45100, unitPrice: "20000.00" }],
    }, CASHIER);
    const evt = (await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "reception.fundedTotalReduced")))[0];
    expect(evt).toBeTruthy();
    const today = new Date().toISOString().slice(0, 10);
    const aw = await getAnomalyWatch({ from: today, to: today, branchId: 1 });
    const row = aw.fundedReductions.rows.find((x) => x.userId === 2);
    expect(row).toBeTruthy();
    expect(row!.eventCount).toBeGreaterThanOrEqual(1);
  });
});

describe("S5 — سطرا الاستقبال في إقفال اليوم", () => {
  it("مسوّدة مموّلة + فاتورة بخصمٍ يظهران في receptionExtras", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE_45100] }, CASHIER);
    await collectDeposit(
      { draftId: p.draftId, amount: "15000.00", method: "CASH", clientRequestId: uuid("s5a00001") },
      CASHIER,
    );
    // فاتورة بخصم سطرٍ دون عتبة الاعتماد (١٥٪) — يظهر في discountByUser بلا موافقة مدير.
    const p2 = await promoteDraft({
      branchId: 1, header: { customerId: 1 },
      lines: [{ ...GOODS_LINE, unitPrice: "1000.00", discountAmount: "200.00" }],
    }, CASHIER);
    await commitDraft({
      draftId: p2.draftId, version: 0, expectedTotal: "1800.00", shiftId: shift.shiftId,
      collectNow: { amount: "1800.00", method: "CASH" },
    }, CASHIER);

    const today = new Date().toISOString().slice(0, 10);
    const dc = await getDayCloseReconciliation({ date: today, branchId: 1 });
    expect(dc.receptionExtras.fundedDrafts.count).toBeGreaterThanOrEqual(1);
    expect(Number(dc.receptionExtras.fundedDrafts.heldNet)).toBeGreaterThanOrEqual(15000);
  });
});

describe("S6 — §٩.٣: هويّة مُقِرّ السعر تُدقَّق داخل المعاملة", () => {
  it("تثبيتٌ بأسطر override معتمدةٍ يكتب auditLogs: reception.priceOverride باسم المُقِرّ", async () => {
    const shift = await openReception(1);
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [GOODS_LINE] }, { userId: 1, branchId: 1, role: "manager" });
    await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "2000.00", shiftId: shift.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
      priceOverrideApproved: true,
      priceApprovedBy: 1,
    }, { userId: 1, branchId: 1, role: "manager" });
    const evt = (await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "reception.priceOverride")))[0];
    expect(evt).toBeTruthy();
    const payload = JSON.parse(String(evt.newValue ?? "{}"));
    expect(payload.approvedBy).toBe(1);
    expect(Array.isArray(payload.lines)).toBe(true);
  });
});
