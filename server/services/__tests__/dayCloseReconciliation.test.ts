/**
 * اختبارات تكامل لـreportsDayCloseService.getDayCloseReconciliation — مطابقة إقفال اليوم للنقد.
 *
 * الثوابت المُختبَرة:
 *  I1) expected = opening + cashIn − operatingOut = shifts.expectedCash المخزَّن حرفياً (تطابق Z-report).
 *  I2) drift = counted − expected = shifts.variance المخزَّن (صفر/فائض/عجز).
 *  I3) تسليم الخزينة (CH-…) لا يُطرَح من المتوقَّع — يُعرَض منفصلاً (لا فائض وهميّ).
 *  I4) التفكيك متماسك: Σ الأجزاء (sales/collections/otherIn) = cashIn، و(returns/expenses/otherOut) = operatingOut.
 *  I5) عزل الفرع + حدود اليوم (businessDay): وردية فرعٍ/يومٍ آخر مُستبعَدة.
 *  I6) الحوكمة: reportViewerProcedure يحجب الكاشير، ويُقصر غير-admin على فرعه (scopedBranchId).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { getDayCloseReconciliation } from "../reportsDayCloseService";
import { appRouter } from "../../routers";

function makeCtx(user: any) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ADMIN = 1;
const MANAGER1 = 2;
const CASHIER1 = 3;
const CASHIER2 = 4;
const MANAGER2 = 5;

// يوم اليوم (UTC) — تُفتَح الورديات بـopenedAt=now فتقع فيه. النطاق عبر businessDay في الخدمة.
const DATE = new Date().toISOString().slice(0, 10);

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: ADMIN, openId: "local_admin", name: "المدير العام", role: "admin", loginMethod: "local" },
    { id: MANAGER1, openId: "local_mgr1", name: "مدير الفرع١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER1, openId: "local_c1", name: "كاشير١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: CASHIER2, openId: "local_c2", name: "كاشير٢", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER2, openId: "local_mgr2", name: "مدير الفرع٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
}

let invSeq = 0;
/** فاتورة صغرى لربط إيصالات البيع/المرتجع (FK receipts.invoiceId). */
async function seedInvoice(branchId: number): Promise<number> {
  const id = ++invSeq;
  await db().insert(s.invoices).values({
    id,
    invoiceNumber: `INV-TEST-${id}`,
    sourceType: "POS",
    branchId,
    subtotal: "0.00",
    total: "0.00",
  });
  return id;
}

type ReceiptOverride = Partial<typeof s.receipts.$inferInsert> & {
  shiftId: number;
  branchId: number;
  direction: "IN" | "OUT";
  amount: string;
};
/** إيصال نقدي درج (DRAWER/CASH/COMPLETED) افتراضاً — يُخصَّص بالتجاوزات. */
async function insertReceipt(o: ReceiptOverride) {
  await db().insert(s.receipts).values({
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    createdBy: CASHIER1,
    ...o,
  });
}

async function report(branchId?: number) {
  return getDayCloseReconciliation({ date: DATE, branchId });
}

function line(res: Awaited<ReturnType<typeof report>>, shiftId: number) {
  const l = res.shifts.find((x) => x.shiftId === shiftId);
  if (!l) throw new Error(`shift ${shiftId} not in report`);
  return l;
}

beforeEach(async () => {
  invSeq = 0;
  await seedBase();
});

describe("getDayCloseReconciliation — التفكيك والثوابت", () => {
  it("I1+I4: التفكيك الكامل يطابق cashIn/operatingOut، والمتوقَّع = shifts.expectedCash المخزَّن", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    const inv = await seedInvoice(1);

    // داخل: بيع 50000 (فاتورة) + تحصيل 20000 (سند RV) + عربون 8000 (بلا فاتورة/سند ⇒ أخرى)
    await insertReceipt({ shiftId, branchId: 1, direction: "IN", amount: "50000.00", invoiceId: inv });
    await insertReceipt({ shiftId, branchId: 1, direction: "IN", amount: "20000.00", voucherNumber: "RV-1-20260722-00001", partyType: "CUSTOMER" });
    await insertReceipt({ shiftId, branchId: 1, direction: "IN", amount: "8000.00", workOrderId: 777 });
    // خارج تشغيليّ: مرتجع 10000 (فاتورة) + مصروف 15000 (سند PV) + صرف متفرّق 2000 (بلا شيء ⇒ أخرى)
    await insertReceipt({ shiftId, branchId: 1, direction: "OUT", amount: "10000.00", invoiceId: inv });
    await insertReceipt({ shiftId, branchId: 1, direction: "OUT", amount: "15000.00", voucherNumber: "PV-1-20260722-00001" });
    await insertReceipt({ shiftId, branchId: 1, direction: "OUT", amount: "2000.00", description: "صرف متفرّق" });

    // إغلاق + تسليم 30000 للخزينة. المتوقَّع (قبل التسليم) = 100000 + 78000 − 27000 = 151000.
    await closeShift(
      { shiftId, countedCash: "151000", handover: { amount: "30000", handoverTo: MANAGER1 } },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );

    const l = line(await report(1), shiftId);

    // التفكيك
    expect(l.opening).toBe("100000.00");
    expect(l.salesCash).toBe("50000.00");
    expect(l.collectionsCash).toBe("20000.00");
    expect(l.otherIn).toBe("8000.00");
    expect(l.cashIn).toBe("78000.00");
    expect(l.returnsCash).toBe("10000.00");
    expect(l.expensesCash).toBe("15000.00");
    expect(l.otherOut).toBe("2000.00");
    expect(l.operatingOut).toBe("27000.00");
    expect(l.handoversCash).toBe("30000.00");

    // I4: ثوابت الجمع
    expect(Number(l.salesCash) + Number(l.collectionsCash) + Number(l.otherIn)).toBe(Number(l.cashIn));
    expect(Number(l.returnsCash) + Number(l.expensesCash) + Number(l.otherOut)).toBe(Number(l.operatingOut));

    // I1: المتوقَّع = opening + cashIn − operatingOut = 151000 = المخزَّن
    expect(l.expected).toBe("151000.00");
    expect(l.storedExpectedCash).toBe("151000.00");
    expect(l.expected).toBe(l.storedExpectedCash);

    // I2: المطابقة
    expect(l.counted).toBe("151000.00");
    expect(l.drift).toBe("0.00");
    expect(l.drift).toBe(l.storedVariance);
    // المتبقّي بعد التسليم = 151000 − 30000
    expect(l.retainedInDrawer).toBe("121000.00");

    const res = await report(1);
    expect(res.balancedCount).toBe(1);
    expect(res.driftCount).toBe(0);
  });

  it("I3: تسليم الخزينة لا يُطرَح من المتوقَّع (لا فائض وهميّ)", async () => {
    // درجٌ افتتاحيّ فقط، ثم إغلاق بتسليم 40000 والمعدود = الافتتاحيّ كاملاً (بلا حركة).
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await closeShift(
      { shiftId, countedCash: "100000", handover: { amount: "40000", handoverTo: MANAGER1 } },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );

    const l = line(await report(1), shiftId);
    expect(l.expected).toBe("100000.00");     // ليس 60000 — التسليم لا يُطرَح
    expect(l.counted).toBe("100000.00");
    expect(l.drift).toBe("0.00");              // مطابق — لا فائض وهميّ +40000
    expect(l.handoversCash).toBe("40000.00");
    expect(l.retainedInDrawer).toBe("60000.00");
    expect(l.expected).toBe(l.storedExpectedCash);
  });
});

describe("getDayCloseReconciliation — الفرق (drift)", () => {
  it("I2: فائض + عجز + وردية مفتوحة (لا تُحتسَب في المعدود)", async () => {
    // فائض: افتتاحيّ 50000 + بيع 30000 ⇒ متوقَّع 80000، معدود 85000 ⇒ +5000
    const a = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });
    const invA = await seedInvoice(1);
    await insertReceipt({ shiftId: a.shiftId, branchId: 1, direction: "IN", amount: "30000.00", invoiceId: invA });
    await closeShift({ shiftId: a.shiftId, countedCash: "85000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });

    // عجز: افتتاحيّ 40000 + بيع 20000 ⇒ متوقَّع 60000، معدود 57000 ⇒ −3000
    const b = await openShift({ branchId: 1, openingBalance: "40000" }, { userId: CASHIER2, branchId: 1 });
    const invB = await seedInvoice(1);
    await insertReceipt({ shiftId: b.shiftId, branchId: 1, direction: "IN", amount: "20000.00", invoiceId: invB, createdBy: CASHIER2 });
    await closeShift({ shiftId: b.shiftId, countedCash: "57000" }, { userId: CASHIER2, branchId: 1, role: "cashier" });

    // مفتوحة: افتتاحيّ 10000 + بيع 5000 (تبقى مفتوحة) ⇒ counted/drift = null، expected حيّ 15000
    const c = await openShift({ branchId: 1, openingBalance: "10000" }, { userId: CASHIER1, branchId: 1 });
    const invC = await seedInvoice(1);
    await insertReceipt({ shiftId: c.shiftId, branchId: 1, direction: "IN", amount: "5000.00", invoiceId: invC });

    const res = await report(1);

    const la = line(res, a.shiftId);
    expect(la.expected).toBe("80000.00");
    expect(la.drift).toBe("5000.00");
    expect(la.storedVariance).toBe("5000.00");

    const lb = line(res, b.shiftId);
    expect(lb.expected).toBe("60000.00");
    expect(lb.drift).toBe("-3000.00");
    expect(lb.storedVariance).toBe("-3000.00");

    const lc = line(res, c.shiftId);
    expect(lc.status).toBe("OPEN");
    expect(lc.counted).toBeNull();
    expect(lc.drift).toBeNull();
    expect(lc.retainedInDrawer).toBeNull();
    expect(lc.expected).toBe("15000.00"); // متوقَّع حيّ للوردية المفتوحة

    // الإجماليات: المعدود يجمع المغلقتين فقط، والفرق = +5000 − 3000 = +2000
    expect(res.totals.shiftCount).toBe(3);
    expect(res.totals.openCount).toBe(1);
    expect(res.totals.closedCount).toBe(2);
    expect(res.totals.counted).toBe("142000.00");
    expect(res.totals.drift).toBe("2000.00");
    expect(res.balancedCount).toBe(0);
    expect(res.driftCount).toBe(2);
    expect(res.overCount).toBe(1);
    expect(res.shortCount).toBe(1);
  });
});

describe("getDayCloseReconciliation — عزل الفرع وحدود اليوم (I5)", () => {
  it("يُقصِر على الفرع المطلوب ويستبعد يوماً آخر", async () => {
    // وردية فرع١ اليوم
    const a = await openShift({ branchId: 1, openingBalance: "10000" }, { userId: CASHIER1, branchId: 1 });
    await closeShift({ shiftId: a.shiftId, countedCash: "10000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    // وردية فرع٢ اليوم
    const bShift = await openShift({ branchId: 2, openingBalance: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" } as any);
    await closeShift({ shiftId: bShift.shiftId, countedCash: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" });
    // وردية فرع١ «أمس» — نُزيح openedAt ٣٦ ساعة للوراء (ملف اختبار ⇒ خارج حارس التاريخ)
    const old = await openShift({ branchId: 1, openingBalance: "9999" }, { userId: CASHIER2, branchId: 1 });
    await closeShift({ shiftId: old.shiftId, countedCash: "9999" }, { userId: CASHIER2, branchId: 1, role: "cashier" });
    await db().update(s.shifts).set({ openedAt: new Date(Date.now() - 36 * 3600 * 1000) }).where(eq(s.shifts.id, old.shiftId));

    // فرع١ فقط ⇒ الوردية اليومية فقط (لا فرع٢، لا الأمس)
    const r1 = await report(1);
    expect(r1.shifts.map((x) => x.shiftId).sort()).toEqual([a.shiftId]);

    // فرع٢ فقط
    const r2 = await report(2);
    expect(r2.shifts.map((x) => x.shiftId)).toEqual([bShift.shiftId]);

    // كل الفروع ⇒ الورديتان اليوميتان فقط (لا الأمس)
    const rAll = await report(undefined);
    expect(rAll.shifts.map((x) => x.shiftId).sort((m, n) => m - n)).toEqual([a.shiftId, bShift.shiftId].sort((m, n) => m - n));
  });
});

describe("dayCloseReconciliation — الحوكمة عبر الراوتر (I6)", () => {
  it("الكاشير محجوب (reportViewerProcedure)", async () => {
    const caller = appRouter.createCaller(makeCtx({ id: CASHIER1, role: "cashier", branchId: 1, name: "كاشير١" }));
    await expect(caller.reports.dayCloseReconciliation({ date: DATE })).rejects.toThrow();
  });

  it("المدير يُرفَض (forensic) إن طلب فرعاً غير فرعه", async () => {
    const caller = appRouter.createCaller(makeCtx({ id: MANAGER1, role: "manager", branchId: 1, name: "مدير الفرع١" }));
    await expect(caller.reports.dayCloseReconciliation({ date: DATE, branchId: 2 })).rejects.toThrow(/فرع آخر/);
  });

  it("المدير بلا تحديد فرع يُقصَر على فرعه (scopedBranchId)", async () => {
    // وردية فرع١ + وردية فرع٢ في نفس اليوم
    const a = await openShift({ branchId: 1, openingBalance: "3000" }, { userId: CASHIER1, branchId: 1 });
    await closeShift({ shiftId: a.shiftId, countedCash: "3000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    const bShift = await openShift({ branchId: 2, openingBalance: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" } as any);
    await closeShift({ shiftId: bShift.shiftId, countedCash: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" });

    // مدير الفرع١ بلا branchId ⇒ يُقصَر على فرعه (١) فلا يرى وردية فرع٢
    const caller = appRouter.createCaller(makeCtx({ id: MANAGER1, role: "manager", branchId: 1, name: "مدير الفرع١" }));
    const res = await caller.reports.dayCloseReconciliation({ date: DATE });
    expect(res.branchId).toBe(1);
    expect(res.shifts.map((x) => x.shiftId)).toEqual([a.shiftId]);
  });

  it("admin يرى الفرع المطلوب", async () => {
    const bShift = await openShift({ branchId: 2, openingBalance: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" } as any);
    await closeShift({ shiftId: bShift.shiftId, countedCash: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" });

    const caller = appRouter.createCaller(makeCtx({ id: ADMIN, role: "admin", branchId: null, name: "المدير العام" }));
    const res = await caller.reports.dayCloseReconciliation({ date: DATE, branchId: 2 });
    expect(res.shifts.map((x) => x.shiftId)).toEqual([bShift.shiftId]);
  });
});
