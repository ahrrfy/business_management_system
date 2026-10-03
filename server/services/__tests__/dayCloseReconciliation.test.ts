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
  await d.insert(s.receipts).values([
    {
      branchId: 1,
      direction: "IN",
      amount: "1000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-DAY-CLOSE-1",
      createdBy: ADMIN,
    },
    {
      branchId: 2,
      direction: "IN",
      amount: "1000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-DAY-CLOSE-2",
      createdBy: ADMIN,
    },
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

    // إغلاق: يعود كامل المعدود (151000) للخزينة تلقائياً. المتوقَّع (قبل الإرجاع) = 100000 + 78000 − 27000 = 151000.
    await closeShift(
      { shiftId, countedCash: "151000" },
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
    expect(l.handoversCash).toBe("151000.00"); // العهدة الوسيطة: يعود كامل المعدود للخزينة تلقائياً

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
    // العهدة الوسيطة: الدرج يُفرَّغ كاملاً عند الإغلاق ⇒ المتبقّي صفر
    expect(l.retainedInDrawer).toBe("0.00");

    const res = await report(1);
    expect(res.balancedCount).toBe(1);
    expect(res.driftCount).toBe(0);

    // التحقق من قائمة الحركات المفصلة
    expect(l.movements).toBeDefined();
    expect(l.movements.length).toBe(7);
    const saleMov = l.movements.find((m) => m.categoryType === "SALE");
    expect(saleMov?.amount).toBe("50000.00");
    const collMov = l.movements.find((m) => m.categoryType === "COLLECTION");
    expect(collMov?.documentNumber).toBe("RV-1-20260722-00001");
    const expMov = l.movements.find((m) => m.categoryType === "EXPENSE");
    expect(expMov?.documentNumber).toBe("PV-1-20260722-00001");
  });

  it("V.E.R.I.F.Y: تفاصيل الحركات تُظهر من أين جاء الإيراد ولمن صُرف المصروف بدقة كاملة", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });

    // إنشاء عميل ومورد
    await db().insert(s.customers).values({ id: 101, name: "شركة النور للطباعة", phone: "07700000001" });
    await db().insert(s.suppliers).values({ id: 201, name: "مكتب المأمون للتجهيزات", phone: "07700000002" });

    // 1) مصروف مع جهة صرف وفئة صريحة
    await db().insert(s.expenseCategories).values({ id: 301, name: "أحبار ومطبوعات", bucket: "SUPPLIES" });

    await db().insert(s.receipts).values({
      id: 991, shiftId, branchId: 1, direction: "OUT", amount: "155750.00", paymentMethod: "CASH", cashBucket: "DRAWER",
      status: "COMPLETED", approvalStatus: "APPROVED", createdBy: CASHIER1,
      voucherNumber: "PV-1-20260927-00720", partyType: "SUPPLIER", partyId: 201,
      description: "شراء أحبار للمطبعة",
    });
    await db().insert(s.expenses).values({
      id: 881, branchId: 1, shiftId, expenseDate: DATE, category: "SUPPLIES", expenseCategoryId: 301,
      amount: "155750.00", paymentMethod: "CASH", cashBucket: "DRAWER", source: "CASH",
      payee: "مكتب المأمون للتجهيزات", description: "شراء أحبار للمطبعة", receiptId: 991,
    });

    // 2) تحصيل إيراد من عميل صريح
    await insertReceipt({
      shiftId, branchId: 1, direction: "IN", amount: "102000.00",
      voucherNumber: "RV-1-20260927-00720", partyType: "CUSTOMER", partyId: 101,
      description: "تسديد دفعة حساب نقداً",
    });

    const l = line(await report(1), shiftId);
    expect(l.operatingOut).toBe("155750.00");
    expect(l.expensesCash).toBe("155750.00");
    expect(l.cashIn).toBe("102000.00");
    expect(l.collectionsCash).toBe("102000.00");

    // التحقق من تفاصيل الحركات: لمن صرف ومن أين جاء
    const expItem = l.movements.find((m) => m.categoryType === "EXPENSE");
    expect(expItem).toBeDefined();
    expect(expItem?.payee).toBe("مكتب المأمون للتجهيزات");
    expect(expItem?.partyName).toBe("مكتب المأمون للتجهيزات");
    expect(expItem?.description).toBe("شراء أحبار للمطبعة");
    expect(expItem?.classification).toBe("أحبار ومطبوعات");
    expect(expItem?.documentNumber).toBe("PV-1-20260927-00720");
    expect(expItem?.amount).toBe("155750.00");

    const inItem = l.movements.find((m) => m.categoryType === "COLLECTION");
    expect(inItem).toBeDefined();
    expect(inItem?.partyName).toBe("شركة النور للطباعة");
    expect(inItem?.description).toBe("تسديد دفعة حساب نقداً");
    expect(inItem?.documentNumber).toBe("RV-1-20260927-00720");
    expect(inItem?.amount).toBe("102000.00");
  });

  it("I3: تسليم الخزينة لا يُطرَح من المتوقَّع (لا فائض وهميّ)", async () => {
    // درجٌ افتتاحيّ فقط، ثم إغلاق بتسليم 40000 والمعدود = الافتتاحيّ كاملاً (بلا حركة).
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await closeShift(
      { shiftId, countedCash: "100000" },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );

    const l = line(await report(1), shiftId);
    expect(l.expected).toBe("100000.00");     // الإرجاع لا يُطرَح من المتوقَّع
    expect(l.counted).toBe("100000.00");
    expect(l.drift).toBe("0.00");              // مطابق — لا فائض وهميّ +40000
    expect(l.handoversCash).toBe("100000.00"); // العهدة الوسيطة: يعود كامل المعدود للخزينة
    expect(l.retainedInDrawer).toBe("0.00");
    expect(l.expected).toBe(l.storedExpectedCash);
  });
});

describe("getDayCloseReconciliation — الفرق (drift)", () => {
  it("I2: مطابقة + عجز + وردية مفتوحة (لا تُحتسَب في المعدود)", async () => {
    // مطابقة: افتتاحيّ 50000 + بيع 30000 ⇒ متوقَّع ومعدود 80000
    const a = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });
    const invA = await seedInvoice(1);
    await insertReceipt({ shiftId: a.shiftId, branchId: 1, direction: "IN", amount: "30000.00", invoiceId: invA });
    await closeShift({ shiftId: a.shiftId, countedCash: "80000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });

    // عجز: عهدة مستقلة 85000 + بيع 20000 ⇒ متوقَّع 105000، معدود 102000 ⇒ −3000
    const b = await openShift({ branchId: 1, openingBalance: "85000" }, { userId: CASHIER2, branchId: 1 });
    const invB = await seedInvoice(1);
    await insertReceipt({ shiftId: b.shiftId, branchId: 1, direction: "IN", amount: "20000.00", invoiceId: invB, createdBy: CASHIER2 });
    await closeShift({ shiftId: b.shiftId, countedCash: "102000" }, { userId: CASHIER2, branchId: 1, role: "cashier" });

    // مفتوحة: عهدة مستقلة 102000 + بيع 5000 ⇒ counted/drift = null، expected حيّ 107000
    const c = await openShift({ branchId: 1, openingBalance: "102000" }, { userId: CASHIER1, branchId: 1 });
    const invC = await seedInvoice(1);
    await insertReceipt({ shiftId: c.shiftId, branchId: 1, direction: "IN", amount: "5000.00", invoiceId: invC });

    const res = await report(1);

    const la = line(res, a.shiftId);
    expect(la.expected).toBe("80000.00");
    expect(la.drift).toBe("0.00");
    expect(la.storedVariance).toBe("0.00");

    const lb = line(res, b.shiftId);
    expect(lb.expected).toBe("105000.00");
    expect(lb.drift).toBe("-3000.00");
    expect(lb.storedVariance).toBe("-3000.00");

    const lc = line(res, c.shiftId);
    expect(lc.status).toBe("OPEN");
    expect(lc.counted).toBeNull();
    expect(lc.drift).toBeNull();
    expect(lc.retainedInDrawer).toBeNull();
    expect(lc.expected).toBe("107000.00"); // متوقَّع حيّ للوردية المفتوحة

    // الإجماليات: المعدود يجمع المغلقتين فقط، والفرق = +5000 − 3000 = +2000
    expect(res.totals.shiftCount).toBe(3);
    expect(res.totals.openCount).toBe(1);
    expect(res.totals.closedCount).toBe(2);
    expect(res.totals.counted).toBe("182000.00");
    expect(res.totals.drift).toBe("-3000.00");
    expect(res.balancedCount).toBe(1);
    expect(res.driftCount).toBe(1);
    expect(res.overCount).toBe(0);
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
    const old = await openShift({ branchId: 1, openingBalance: "10000" }, { userId: CASHIER2, branchId: 1 });
    await closeShift({ shiftId: old.shiftId, countedCash: "10000" }, { userId: CASHIER2, branchId: 1, role: "cashier" });
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

  it("المدير بلا تحديد فرع يُقصَر على فرعه ويرى ترحيل الخزينة المكتمل", async () => {
    // وردية فرع١ + وردية فرع٢ في نفس اليوم
    const a = await openShift({ branchId: 1, openingBalance: "3000" }, { userId: CASHIER1, branchId: 1 });
    await closeShift({ shiftId: a.shiftId, countedCash: "3000" }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    const bShift = await openShift({ branchId: 2, openingBalance: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" } as any);
    await closeShift({ shiftId: bShift.shiftId, countedCash: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" });

    // مدير الفرع١ بلا branchId ⇒ يُقصَر على فرعه (١) فلا يرى وردية فرع٢، بينما يظهر
    // مبلغ وردية فرعه لأن نقد الإغلاق رُحّل إلى الخزينة مباشرةً بلا عهدة معلّقة.
    const caller = appRouter.createCaller(makeCtx({ id: MANAGER1, role: "manager", branchId: 1, name: "مدير الفرع١" }));
    const res = await caller.reports.dayCloseReconciliation({ date: DATE });
    expect(res.branchId).toBe(1);
    expect(res.shifts.map((x) => x.shiftId)).toEqual([a.shiftId]);
    expect(res.withheldBlindCountShiftCount).toBe(0);
    expect(res.totals.handoversCash).toBe("3000.00");
  });

  it("admin يرى الفرع المطلوب", async () => {
    const bShift = await openShift({ branchId: 2, openingBalance: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" } as any);
    await closeShift({ shiftId: bShift.shiftId, countedCash: "5000" }, { userId: MANAGER2, branchId: 2, role: "manager" });

    const caller = appRouter.createCaller(makeCtx({ id: ADMIN, role: "admin", branchId: null, name: "المدير العام" }));
    const res = await caller.reports.dayCloseReconciliation({ date: DATE, branchId: 2 });
    expect(res.shifts.map((x) => x.shiftId)).toEqual([bShift.shiftId]);
  });
});

describe("مطابقة النقد المباشر والخزينة — منع الفائض الصامت (Zero Silent Cash Leakage)", () => {
  it("يعرض الرصيد المرحّل حتى في يوم بلا حركة ولا وردية", async () => {
    const res = await report(1);

    expect(res.shifts).toEqual([]);
    expect(res.directOperations.receiptCount).toBe(0);
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "1000000.00",
      expectedDrawersCash: "0.00",
      cashInTransit: "0.00",
      expectedCashOnHand: "1000000.00",
      isReadyForFinalCount: true,
    });
  });

  it("يجمع الموقف النقدي النهائي لكل الفروع في العرض الافتراضي", async () => {
    const res = await report();

    expect(res.cashPosition).toMatchObject({
      branchCount: 2,
      expectedTreasuryCash: "2000000.00",
      expectedDrawersCash: "0.00",
      cashInTransit: "0.00",
      expectedCashOnHand: "2000000.00",
      isReadyForFinalCount: true,
    });
  });

  it("يحفظ معادلة الموقع أثناء الوردية: خزينة + درج مفتوح + عهدة بالطريق", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    const invoiceId = await seedInvoice(1);
    await insertReceipt({ shiftId, branchId: 1, direction: "IN", amount: "50000.00", invoiceId, approvalStatus: "APPROVED" });
    await insertReceipt({ shiftId, branchId: 1, direction: "OUT", amount: "40000.00", referenceNumber: "CD-1-POSITION", approvalStatus: "APPROVED" });
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "40000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "PENDING",
      approvalStatus: "APPROVED",
      referenceNumber: "CD-1-POSITION",
      createdBy: CASHIER1,
    });

    const res = await report(1);
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "900000.00",
      expectedDrawersCash: "110000.00",
      cashInTransit: "40000.00",
      expectedCashOnHand: "1050000.00",
      isReadyForFinalCount: false,
    });
  });

  it("يحجب الموقف النقدي إذا كانت عهدة عد أعمى من وردية يوم سابق ما تزال معلقة", async () => {
    const priorDay = new Date(new Date(`${DATE}T10:00:00.000Z`).getTime() - 86_400_000);
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await db().update(s.shifts).set({ openedAt: priorDay }).where(eq(s.shifts.id, shiftId));
    await insertReceipt({
      shiftId,
      branchId: 1,
      direction: "OUT",
      amount: "40000.00",
      referenceNumber: "CH-PRIOR-BLIND-POSITION",
      approvalStatus: "APPROVED",
      createdAt: priorDay,
    });
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "40000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "PENDING",
      approvalStatus: "APPROVED",
      referenceNumber: "CH-PRIOR-BLIND-POSITION",
      createdBy: CASHIER1,
      createdAt: priorDay,
    });

    const res = await getDayCloseReconciliation({
      date: DATE,
      branchId: 1,
      actor: { userId: MANAGER1, branchId: 1, role: "manager" },
    });
    expect(res.shifts).toEqual([]);
    expect(res.withheldBlindCountShiftCount).toBe(0);
    expect(res.cashPosition).toBeNull();
  });

  it("يبقي التحويل النقدي بين الفروع ضمن النقد بالطريق حتى الاستلام", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "125000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "CT-1-POSITION-IN-TRANSIT",
      createdBy: ADMIN,
      createdAt: new Date(`${DATE}T12:00:00.000Z`),
    });
    const sentReceipt = (await db().select({ id: s.receipts.id }).from(s.receipts)
      .where(eq(s.receipts.referenceNumber, "CT-1-POSITION-IN-TRANSIT")).limit(1))[0]!;
    await db().insert(s.cashTransfers).values({
      transferNumber: "CT-1-POSITION-IN-TRANSIT",
      fromBranchId: 1,
      toBranchId: 2,
      amount: "125000.00",
      status: "IN_TRANSIT",
      sentBy: ADMIN,
      sentReceiptId: Number(sentReceipt.id),
      sentAt: new Date(`${DATE}T12:00:00.000Z`),
    });

    const res = await report(1);
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "875000.00",
      expectedDrawersCash: "0.00",
      cashInTransit: "125000.00",
      expectedCashOnHand: "1000000.00",
      isReadyForFinalCount: false,
    });
  });

  it("يشتق عبور تحويل الفروع من لحظات الإيصالات المرتبطة لا حقول دورة الحالة", async () => {
    const beforeCutoff = new Date(`${DATE}T12:00:00.000Z`);
    const afterCutoff = new Date(new Date(`${DATE}T12:00:00.000Z`).getTime() + 86_400_000);
    await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "80000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CT-1-EVENT-CUTOFF", createdBy: ADMIN, createdAt: beforeCutoff,
    });
    const sentReceipt = (await db().select({ id: s.receipts.id }).from(s.receipts)
      .where(eq(s.receipts.referenceNumber, "CT-1-EVENT-CUTOFF")).limit(1))[0]!;
    await db().insert(s.receipts).values({
      branchId: 2, direction: "IN", amount: "80000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CT-1-EVENT-CUTOFF", createdBy: ADMIN, createdAt: afterCutoff,
    });
    const linkedReceipts = await db().select({ id: s.receipts.id, branchId: s.receipts.branchId })
      .from(s.receipts).where(eq(s.receipts.referenceNumber, "CT-1-EVENT-CUTOFF"));
    const receivedReceipt = linkedReceipts.find((row) => Number(row.branchId) === 2)!;
    await db().insert(s.cashTransfers).values({
      transferNumber: "CT-1-EVENT-CUTOFF",
      fromBranchId: 1,
      toBranchId: 2,
      amount: "80000.00",
      status: "RECEIVED",
      sentBy: ADMIN,
      receivedBy: MANAGER2,
      sentReceiptId: Number(sentReceipt.id),
      receivedReceiptId: Number(receivedReceipt.id),
      // حقلا الحالة كلاهما قبل القطع عمداً؛ الدليل المالي المرتبط وحده بعد القطع.
      sentAt: beforeCutoff,
      receivedAt: beforeCutoff,
    });

    const res = await report(1);
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "920000.00",
      cashInTransit: "80000.00",
      expectedCashOnHand: "1000000.00",
      isReadyForFinalCount: false,
    });
  });

  it("يحجب الرقم النهائي عند وجود نقد مادي غير منسوب إلى خزينة أو وردية", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      direction: "IN",
      amount: "12345.00",
      paymentMethod: "CASH",
      cashBucket: null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "LEGACY-UNSCOPED-CASH",
      createdBy: ADMIN,
    });

    const res = await report(1);
    expect(res.cashPosition).toBeNull();
  });

  it("لا يُسقط نقداً متبقياً في درج وردية مغلقة تاريخية ولا يسمح باعتباره جرداً نهائياً", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    const invoiceId = await seedInvoice(1);
    await insertReceipt({ shiftId, branchId: 1, direction: "IN", amount: "50000.00", invoiceId, approvalStatus: "APPROVED" });
    await insertReceipt({ shiftId, branchId: 1, direction: "OUT", amount: "100000.00", referenceNumber: "CH-LEGACY-PARTIAL", approvalStatus: "APPROVED" });
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "CH-LEGACY-PARTIAL",
      createdBy: ADMIN,
    });
    await db().update(s.shifts).set({
      status: "CLOSED",
      openedAt: new Date(new Date(`${DATE}T09:00:00.000Z`).getTime() - 86_400_000),
      closedAt: new Date(new Date(`${DATE}T18:00:00.000Z`).getTime() - 86_400_000),
      countedCash: "150000.00",
      expectedCash: "150000.00",
      variance: "0.00",
      reconciliationStatus: "MATCHED",
    }).where(eq(s.shifts.id, shiftId));
    await db().update(s.receipts).set({
      createdAt: new Date(new Date(`${DATE}T17:00:00.000Z`).getTime() - 86_400_000),
      approvedAt: new Date(new Date(`${DATE}T17:00:00.000Z`).getTime() - 86_400_000),
    }).where(eq(s.receipts.shiftId, shiftId));
    await db().update(s.receipts).set({
      createdAt: new Date(new Date(`${DATE}T18:00:00.000Z`).getTime() - 86_400_000),
      approvedAt: new Date(new Date(`${DATE}T18:00:00.000Z`).getTime() - 86_400_000),
    }).where(eq(s.receipts.referenceNumber, "CH-LEGACY-PARTIAL"));

    const res = await report(1);
    expect(res.shifts).toEqual([]);
    expect(res.totals.retainedInDrawer).toBe("0.00");
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "1000000.00",
      expectedDrawersCash: "50000.00",
      cashInTransit: "0.00",
      expectedCashOnHand: "1050000.00",
      isReadyForFinalCount: false,
    });
  });

  it("يعيد بناء الدرج عند حد اليوم ولا يسقطه بسبب إغلاق وتسليم حدثا في اليوم التالي", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    const nextDay = new Date(new Date(`${DATE}T18:00:00.000Z`).getTime() + 86_400_000);
    await insertReceipt({
      shiftId,
      branchId: 1,
      direction: "OUT",
      amount: "100000.00",
      referenceNumber: "CH-NEXT-DAY-CUTOFF",
      approvalStatus: "APPROVED",
      createdAt: nextDay,
      approvedAt: nextDay,
    });
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "100000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "CH-NEXT-DAY-CUTOFF",
      createdBy: ADMIN,
      approvedBy: ADMIN,
      createdAt: nextDay,
      approvedAt: nextDay,
    });
    await db().update(s.shifts).set({
      status: "CLOSED",
      closedAt: nextDay,
      countedCash: "100000.00",
      expectedCash: "100000.00",
      variance: "0.00",
      reconciliationStatus: "MATCHED",
    }).where(eq(s.shifts.id, shiftId));

    const res = await report(1);
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "900000.00",
      expectedDrawersCash: "100000.00",
      cashInTransit: "0.00",
      expectedCashOnHand: "1000000.00",
      isReadyForFinalCount: false,
    });
  });

  it("R1+R2: يفصل حركة اليوم عن موضع النقد النهائي بعد إقفال الوردية", async () => {
    // تمويل الخزينة لتغطية عهدة افتتاح الوردية (مستبعد من الإيرادات المباشرة عبر بادئة TEST-TREASURY)
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "20000000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-FUND-R1",
      createdBy: ADMIN,
    });

    // وردية إغلاق اعتيادية: متوقَّع ومعدود 10,027,300 د.ع
    const shift = await openShift({ branchId: 1, openingBalance: "10000000" }, { userId: CASHIER1, branchId: 1 });
    const inv = await seedInvoice(1);
    await insertReceipt({ shiftId: shift.shiftId, branchId: 1, direction: "IN", amount: "27300.00", invoiceId: inv });
    await closeShift({ shiftId: shift.shiftId, countedCash: "10027300" }, { userId: CASHIER1, branchId: 1, role: "cashier" });

    // تدفق نقدي مباشر مشروع وصل للفرع/الخزينة خارج الوردية (سند قبض RV من الإدارة): 3,540,950 د.ع
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "IN",
      amount: "3540950.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "RV-1-20261001-00001",
      partyType: "CUSTOMER",
      description: "تحصيل مباشر من عميل",
      createdBy: ADMIN,
    });

    const res = await report(1);

    // التحقق من التفكيك المباشر
    expect(res.directOperations.collectionsCash).toBe("3540950.00");
    expect(res.directOperations.cashIn).toBe("3540950.00");
    expect(res.directOperations.netCash).toBe("3540950.00");
    expect(res.directOperations.receiptCount).toBe(1);

    // حركة اليوم تشرح ما وقع، لكنها ليست الرصيد النقدي التراكمي الموجود في الفرع.
    expect(res.totals.shiftExpected).toBe("10027300.00");
    expect(res.totals.directNetCash).toBe("3540950.00");
    expect(res.totals.collectionsCash).toBe("3540950.00");
    expect(res.totals.cashIn).toBe("3568250.00"); // 27,300 مبيعات وردية + 3,540,950 تحصيل مباشر
    // صافي حركة اليوم = 10,027,300 + 3,540,950 = 13,568,250 د.ع.
    expect(res.totals.expected).toBe("13568250.00");
    expect(res.totals.closedExpected).toBe("10027300.00");
    expect(res.totals.physicalDrawerCash).toBe("0.00");

    // الرصيد النهائي تراكمي: مليون مرحّل + 20 مليون تمويل - 10 ملايين عهدة
    // + 10,027,300 إغلاق وردية + 3,540,950 تحصيل مباشر.
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "24568250.00",
      expectedDrawersCash: "0.00",
      cashInTransit: "0.00",
      expectedCashOnHand: "24568250.00",
      isReadyForFinalCount: true,
    });

    // ثوابت الجمع الشاملة
    expect(Number(res.totals.salesCash) + Number(res.totals.collectionsCash) + Number(res.totals.otherIn)).toBe(Number(res.totals.cashIn));
    expect(Number(res.totals.opening) + Number(res.totals.cashIn) - Number(res.totals.operatingOut)).toBe(Number(res.totals.expected));
  });

  it("R2: يوم بلا أي وردية مفتوحة — تظهر التدفقات النقدية المباشرة ولا يُعاد تقرير صفري", async () => {
    // لا ورديات لفرع ٢ اليوم، فقط سند قبض مباشر في الخزينة
    await db().insert(s.receipts).values({
      branchId: 2,
      direction: "IN",
      amount: "3540950.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "RV-2-20261001-00001",
      partyType: "CUSTOMER",
      createdBy: ADMIN,
    });

    const res = await report(2);
    expect(res.shifts.length).toBe(0);
    expect(res.totals.shiftCount).toBe(0);
    expect(res.directOperations.collectionsCash).toBe("3540950.00");
    expect(res.totals.collectionsCash).toBe("3540950.00");
    expect(res.totals.cashIn).toBe("3540950.00");
    expect(res.totals.expected).toBe("3540950.00");
    expect(res.totals.physicalDrawerCash).toBe("0.00");
    expect(res.cashPosition).toMatchObject({
      expectedTreasuryCash: "4540950.00",
      expectedDrawersCash: "0.00",
      cashInTransit: "0.00",
      expectedCashOnHand: "4540950.00",
      isReadyForFinalCount: true,
    });
  });

  it("R2: تفكيك الحركات المباشرة المتعددة (بيع، تحصيل، مرتجع، مصروف) مع حفظ التوازن", async () => {
    const inv = await seedInvoice(1);
    // بيع مباشر (فاتورة بلا سند)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "500000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      invoiceId: inv, createdBy: ADMIN,
    });
    // تحصيل مباشر (سند RV)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "200000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-20261001-00099", createdBy: ADMIN,
    });
    // مرتجع مباشر (فاتورة OUT)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "50000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      invoiceId: inv, createdBy: ADMIN,
    });
    // مصروف مباشر (سند صرف PV)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "100000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "PV-1-20261001-00001", createdBy: ADMIN,
    });

    const res = await report(1);
    expect(res.directOperations.salesCash).toBe("500000.00");
    expect(res.directOperations.collectionsCash).toBe("200000.00");
    expect(res.directOperations.cashIn).toBe("700000.00");
    expect(res.directOperations.returnsCash).toBe("50000.00");
    expect(res.directOperations.expensesCash).toBe("100000.00");
    expect(res.directOperations.operatingOut).toBe("150000.00");
    expect(res.directOperations.netCash).toBe("550000.00");
    expect(res.directMovements).toMatchObject({
      count: 4,
      in: "700000.00",
      out: "150000.00",
      net: "550000.00",
    });

    expect(Number(res.totals.salesCash) + Number(res.totals.collectionsCash) + Number(res.totals.otherIn)).toBe(Number(res.totals.cashIn));
    expect(Number(res.totals.returnsCash) + Number(res.totals.expensesCash) + Number(res.totals.otherOut)).toBe(Number(res.totals.operatingOut));
    expect(Number(res.totals.opening) + Number(res.totals.cashIn) - Number(res.totals.operatingOut)).toBe(Number(res.totals.expected));
  });

  it("R2: التحويلات الداخلية وتمويل الخزينة (CH- / CD- / SF- / CT- / TF-) لا تُحسب كإيراد خارجي مباشر", async () => {
    // حركة تسليم داخلي في الخزينة CH-
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "100000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CH-1-20261001-0001", createdBy: ADMIN,
    });
    // حركة سحب داخلي CD-
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "50000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CD-1-20261001-0001", createdBy: ADMIN,
    });
    // تحويل نقدي بين الفروع CT-
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "250000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CT-2-20261001-0001", createdBy: ADMIN,
    });
    // إلغاء تحويل بين الفروع CANCEL-CT-
    await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "250000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "CANCEL-CT-2-20261001-0001", createdBy: ADMIN,
    });
    // تمويل رأس مال الخزينة TF-
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "5000000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TF-1-20261001-0001", createdBy: ADMIN,
    });

    const res = await report(1);
    // كافة التحويلات الداخلية ورؤوس الأموال مستبعدة ولا تُضخِّم إيراد أو مصروف اليوم
    expect(res.directOperations.receiptCount).toBe(0);
    expect(res.directOperations.cashIn).toBe("0.00");
    expect(res.directOperations.operatingOut).toBe("0.00");
    expect(res.directOperations.netCash).toBe("0.00");
  });

  it("R2: عزل الفروع في التدفقات النقدية المباشرة (Direct Cash Branch Isolation)", async () => {
    // سند قبض لفرع ١
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "3540950.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-20261001-00055", createdBy: ADMIN,
    });
    // سند قبض لفرع ٢
    await db().insert(s.receipts).values({
      branchId: 2, direction: "IN", amount: "1000000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-2-20261001-00056", createdBy: ADMIN,
    });

    // تقرير فرع ١ يرى مبلغه فقط
    const res1 = await report(1);
    expect(res1.directOperations.collectionsCash).toBe("3540950.00");
    expect(res1.totals.collectionsCash).toBe("3540950.00");

    // تقرير فرع ٢ يرى مبلغه فقط
    const res2 = await report(2);
    expect(res2.directOperations.collectionsCash).toBe("1000000.00");
    expect(res2.totals.collectionsCash).toBe("1000000.00");

    // تقرير الإدارة العامة (الكل) يجمع الفرعين بدقة
    const caller = appRouter.createCaller(makeCtx({ id: ADMIN, role: "admin", branchId: null, name: "المدير العام" }));
    const resAll = await caller.reports.dayCloseReconciliation({ date: DATE });
    expect(resAll.directOperations.collectionsCash).toBe("4540950.00");
    expect(resAll.totals.collectionsCash).toBe("4540950.00");
  });

  it("R2: إلغاء وعكس السندات المباشرة (Compensating Reversal Vouchers) يُصافَر بدقة تامة", async () => {
    // سند قبض مباشر أصلي تم عكسه
    await db().insert(s.receipts).values({
      id: 8881, branchId: 1, direction: "IN", amount: "400000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "REVERSED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-20261001-00777", createdBy: ADMIN,
    });
    // سند صرف تعويضي معاكس من إلغاء السند
    await db().insert(s.receipts).values({
      id: 8882, branchId: 1, direction: "OUT", amount: "400000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "PV-1-20261001-00777", referenceNumber: "CANCEL-VCH-8881", createdBy: ADMIN,
    });

    const res = await report(1);
    expect(res.directOperations.collectionsCash).toBe("400000.00");
    expect(res.directOperations.expensesCash).toBe("400000.00");
    expect(res.directOperations.cashIn).toBe("400000.00");
    expect(res.directOperations.operatingOut).toBe("400000.00");
    // الأثر الصافي = صفر تماماً
    expect(res.directOperations.netCash).toBe("0.00");
    expect(res.totals.expected).toBe("0.00");
  });

  it("R2 (Adversarial): حدود التوقيت ومنتصف الليل (Date Boundaries & Midnight Transitions)", async () => {
    const nextDateObj = new Date(Date.UTC(Number(DATE.slice(0, 4)), Number(DATE.slice(5, 7)) - 1, Number(DATE.slice(8, 10)) + 1));
    const nextDateStr = nextDateObj.toISOString().slice(0, 10);

    // حركة مباشرة في آخر ثانية من اليوم التجاري (23:59:59Z)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "500000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-MIDNIGHT-IN", createdAt: new Date(`${DATE}T23:59:59.000Z`),
      createdBy: ADMIN,
    });

    // حركة مباشرة في أول ثانية من اليوم التالي (00:00:00Z)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "750000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-NEXTDAY-IN", createdAt: new Date(`${nextDateStr}T00:00:00.000Z`),
      createdBy: ADMIN,
    });

    // تقرير تاريخ اليوم (DATE) يتضمن حركة 23:59:59 ويستبعد تماماً 00:00:00 لليوم التالي
    const resToday = await report(1);
    expect(resToday.directOperations.collectionsCash).toBe("500000.00");
    expect(resToday.totals.collectionsCash).toBe("500000.00");

    // تقرير اليوم التالي (nextDateStr) يتضمن حركة 00:00:00
    const resNext = await getDayCloseReconciliation({ date: nextDateStr, branchId: 1 });
    expect(resNext.directOperations.collectionsCash).toBe("750000.00");
  });

  it("R2 (Adversarial): تدفقات صرف نقدية مباشرة (Direct PV Expenses Out) وتأثيرها على صافي المتوقع", async () => {
    // سند قبض مباشر
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "1000000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-DIR-EXP-IN", createdBy: ADMIN,
    });

    // سند صرف مباشر بالخزينة (PV)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "OUT", amount: "250000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "PV-1-DIR-EXP-OUT", createdBy: ADMIN,
    });

    const res = await report(1);
    expect(res.directOperations.collectionsCash).toBe("1000000.00");
    expect(res.directOperations.expensesCash).toBe("250000.00");
    expect(res.directOperations.cashIn).toBe("1000000.00");
    expect(res.directOperations.operatingOut).toBe("250000.00");
    expect(res.directOperations.netCash).toBe("750000.00");
    expect(res.totals.cashIn).toBe("1000000.00");
    expect(res.totals.operatingOut).toBe("250000.00");
    expect(res.totals.expected).toBe("750000.00");
  });

  it("R2 (Adversarial): تحقّق التدفق النقدي عند الاعتماد (Maker-Checker cashEventAt Delay Across Dates)", async () => {
    const prevDateObj = new Date(Date.UTC(Number(DATE.slice(0, 4)), Number(DATE.slice(5, 7)) - 1, Number(DATE.slice(8, 10)) - 1));
    const prevDateStr = prevDateObj.toISOString().slice(0, 10);
    const nextDateObj = new Date(Date.UTC(Number(DATE.slice(0, 4)), Number(DATE.slice(5, 7)) - 1, Number(DATE.slice(8, 10)) + 1));
    const nextDateStr = nextDateObj.toISOString().slice(0, 10);

    // ١) سند أُنشئ بالأمس لكن اعتُمِد اليوم: يدخل تقرير اليوم (لحظة تحقق النقد الفعلي)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "600000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-DELAYED-TODAY",
      createdAt: new Date(`${prevDateStr}T20:00:00.000Z`),
      approvedAt: new Date(`${DATE}T10:00:00.000Z`),
      approvedBy: ADMIN,
      createdBy: ADMIN,
    });

    // ٢) سند أُنشئ اليوم لكن اعتُمِد غداً: يُستبعد من تقرير اليوم ويدخل تقرير الغد
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "900000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-DELAYED-TOMORROW",
      createdAt: new Date(`${DATE}T21:00:00.000Z`),
      approvedAt: new Date(`${nextDateStr}T11:00:00.000Z`),
      approvedBy: ADMIN,
      createdBy: ADMIN,
    });

    const resToday = await report(1);
    // تقرير اليوم يرى حركة 600,000 المعتمدة اليوم، ويستبعد 900,000 المعتمدة غداً
    expect(resToday.directOperations.collectionsCash).toBe("600000.00");
    expect(resToday.totals.collectionsCash).toBe("600000.00");
    expect(resToday.directMovements).toMatchObject({ count: 1, net: "600000.00" });
    expect(resToday.directMovements.details[0]?.time.slice(0, 10)).toBe(DATE);

    // تقرير الغد يرى حركة 900,000
    const resTomorrow = await getDayCloseReconciliation({ date: nextDateStr, branchId: 1 });
    expect(resTomorrow.directOperations.collectionsCash).toBe("900000.00");
    expect(resTomorrow.directMovements).toMatchObject({ count: 1, net: "900000.00" });
    expect(resTomorrow.directMovements.details[0]?.time.slice(0, 10)).toBe(nextDateStr);
  });

  it("R2 (Adversarial): عدم استبعاد سندات القبض/الصرف الرسمية بسبب تطابق مرجعي مصادف (CT-/TF- with voucherNumber)", async () => {
    // سند قبض رسمي مع ملاحظة/مرجع يبدأ بـ CT- (كأن يشير المحاسب لتحويل بنكي أو مرجع خارجي)
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "3540950.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-20261001-COINCIDENTAL",
      referenceNumber: "CT-EXTERNAL-PAYMENT-REF",
      createdBy: ADMIN,
    });

    const res = await report(1);
    // يجب شمول السند كاملاً بلا إسقاط صامت لأن له رقم سند رسمي
    expect(res.directOperations.collectionsCash).toBe("3540950.00");
    expect(res.directOperations.receiptCount).toBe(1);
    expect(res.totals.collectionsCash).toBe("3540950.00");
    expect(res.totals.expected).toBe("3540950.00");
  });

  it("R2 (Adversarial): مناعة الأحرف الصغيرة والمسافات في التحويلات وتسليمات العهدة (Case-Insensitive & Trim)", async () => {
    // ١) تحويل داخلي بحروف صغيرة ومسافات: يجب استبعاده من النقد المباشر
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "500000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "  ct-internal-transfer-001  ",
      createdBy: ADMIN,
    });

    const resDirect = await report(1);
    expect(resDirect.directOperations.receiptCount).toBe(0);
    expect(resDirect.directOperations.cashIn).toBe("0.00");

    // ٢) تسليم عهدة إغلاق بحروف صغيرة ومسافات: يجب تصنيفه كـ HANDOVER وعدم طرحه من المتوقع (Invariant I3)
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });
    await insertReceipt({ shiftId, branchId: 1, direction: "IN", amount: "100000.00" });
    // تسليم عهدة بحروف صغيرة
    await db().insert(s.receipts).values({
      branchId: 1, shiftId, direction: "OUT", amount: "150000.00", paymentMethod: "CASH",
      cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: " ch-shift-close-001 ",
      createdBy: ADMIN,
    });
    // إغلاق الوردية بعد تسليم كامل النقد
    await db().update(s.shifts).set({
      status: "CLOSED", countedCash: "150000.00", expectedCash: "150000.00", variance: "0.00",
    }).where(eq(s.shifts.id, shiftId));

    const resShift = await report(1);
    const shLine = line(resShift, shiftId);
    expect(shLine.handoversCash).toBe("150000.00");
    expect(shLine.expected).toBe("150000.00");
    expect(shLine.drift).toBe("0.00");
    const handoverMov = shLine.movements.find((m) => m.referenceNumber?.includes("ch-shift-close"));
    expect(handoverMov).toBeDefined();
    expect(handoverMov!.categoryType).toBe("HANDOVER");
  });

  it("R2 (Adversarial): عدم تسرب نقد الأدراج (DRAWER bucket) من ورديات غير مشمولة إلى العمليات المباشرة", async () => {
    const prevDateObj = new Date(Date.UTC(Number(DATE.slice(0, 4)), Number(DATE.slice(5, 7)) - 1, Number(DATE.slice(8, 10)) - 1));
    const prevDateStr = prevDateObj.toISOString().slice(0, 10);
    const yesterdayShiftId = 99991;

    // وردية فُتحت بالأمس
    await db().insert(s.shifts).values({
      id: yesterdayShiftId,
      branchId: 1,
      userId: CASHIER1,
      openedAt: new Date(`${prevDateStr}T10:00:00.000Z`),
      status: "OPEN",
      openingBalance: "50000.00",
    });

    // حركة درج بحساب DRAWER لوردية الأمس وقعت اليوم
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: yesterdayShiftId, direction: "IN", amount: "800000.00", paymentMethod: "CASH",
      cashBucket: "DRAWER", status: "COMPLETED", approvalStatus: "APPROVED",
      createdBy: ADMIN,
    });

    const res = await report(1);
    // نقد الدرج للوردية غير المعروضة اليوم لا يتسرب إطلاقاً إلى النقد المباشر
    expect(res.directOperations.receiptCount).toBe(0);
    expect(res.directOperations.cashIn).toBe("0.00");
  });

  it("R3 (Regression): استبعاد سندات صرف الرواتب والتحويلات القانونية النقدية من العمليات المباشرة وحماية المتوقع من أن يصبح سالباً", async () => {
    // تمويل الخزينة لتغطية افتتاح الوردية وصرف الرواتب
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "50000000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-PAYROLL-FUND", createdBy: ADMIN,
    });

    // ١) وردية كاشير اعتيادية: رصيد افتتاحي 10,000,000 + مبيعات 27,300
    const shift = await openShift({ branchId: 1, openingBalance: "10000000" }, { userId: CASHIER1, branchId: 1 });
    const inv = await seedInvoice(1);
    await insertReceipt({ shiftId: shift.shiftId, branchId: 1, direction: "IN", amount: "27300.00", invoiceId: inv });
    await closeShift({ shiftId: shift.shiftId, countedCash: "10027300.00" }, { userId: CASHIER1, branchId: 1 });

    // ٢) عمليات مباشرة مشروعة بالتزامن مع صرف الرواتب:
    // تحصيل مباشر (RV) بمبلغ 2,779,500 د.ع
    await db().insert(s.receipts).values({
      id: 70001, branchId: 1, direction: "IN", amount: "2779500.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "RV-1-20261001-LEGIT", partyType: "CUSTOMER", description: "تحصيل مباشر مشروع",
      createdBy: ADMIN,
    });
    // مصروف تشغيلي مباشر مشروع (PV) بمبلغ 150,000 د.ع
    await db().insert(s.receipts).values({
      id: 70002, branchId: 1, direction: "OUT", amount: "150000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      voucherNumber: "PV-1-20261001-LEGIT", description: "مصروف صيانة مباشر",
      createdBy: ADMIN,
    });

    // ٣) محاكاة دقيقة لحالة الإنتاج: صرف رواتب وتحويلات قانونية نقدية من الخزينة (26,167,825 د.ع إجمالي)
    // بـ referenceNumber = null (وفق assertPayrollPaymentEvidence عند الدفع النقدي)
    const payrollReceipts = [
      { id: 70101, amount: "20000000.00", desc: "صافي رواتب نقدية من الخزينة", kind: "SALARY_PAYMENT" as const },
      { id: 70102, amount: "2167825.00", desc: "تحويل ضريبة الدخل نقداً", kind: "TAX_REMITTANCE" as const },
      { id: 70103, amount: "3000000.00", desc: "تحويل الضمان الاجتماعي نقداً", kind: "SOCIAL_SECURITY_REMITTANCE" as const },
      { id: 70104, amount: "1000000.00", desc: "تسوية مكافأة نهاية الخدمة نقداً", kind: "EOS_SETTLEMENT" as const },
    ];

    for (const pr of payrollReceipts) {
      await db().insert(s.receipts).values({
        id: pr.id,
        branchId: 1,
        shiftId: null,
        cashBucket: "TREASURY",
        direction: "OUT",
        amount: pr.amount,
        paymentMethod: "CASH",
        referenceNumber: null, // لا يوجد رقم مرجع للدفع النقدي
        voucherNumber: null,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: ADMIN,
        approvedAt: new Date(),
        description: pr.desc,
        createdBy: ADMIN,
      });

      await db().insert(s.accountingEntries).values({
        id: pr.id,
        entryType: "PAYMENT_OUT",
        branchId: 1,
        amount: pr.amount,
        entryDate: new Date(),
      });

      await db().insert(s.payrollAccountingEvents).values({
        id: pr.id,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: pr.kind,
        accountingEntryId: pr.id,
        receiptId: pr.id,
        sourceKey: `PAYROLL:TEST:${pr.kind}:${pr.id}`,
        sourceHash: "a".repeat(64),
        occurredAt: new Date(),
        createdBy: ADMIN,
      });
    }

    const res = await report(1);

    // أ) التحقق الحاسم من استبعاد كافة سندات صرف الرواتب والتحويلات القانونية من directOperations
    expect(res.directOperations.receiptCount).toBe(2); // فقط التحصيل المشروع RV ومصروف الصيانة PV
    expect(res.directOperations.collectionsCash).toBe("2779500.00");
    expect(res.directOperations.expensesCash).toBe("150000.00");
    expect(res.directOperations.cashIn).toBe("2779500.00");
    // الخارج التشغيلي المباشر يحوي فقط الـ 150,000 المشروعة، ولا يحتوي الـ 26,167,825 د.ع للرواتب
    expect(res.directOperations.operatingOut).toBe("150000.00");
    expect(res.directOperations.netCash).toBe("2629500.00"); // 2,779,500 - 150,000 = +2,629,500 د.ع

    // ب) حماية رصيد المتوقع والنقد الفعلي من الانهيار بالسالب
    // المتوقع = الوردية (10,027,300) + صافي المباشر (2,629,500) = 12,656,800 د.ع (موجب ومطابق تماماً!)
    expect(res.totals.shiftExpected).toBe("10027300.00");
    expect(res.totals.directNetCash).toBe("2629500.00");
    expect(res.totals.expected).toBe("12656800.00");
    expect(res.totals.closedExpected).toBe("10027300.00");
    expect(res.totals.physicalDrawerCash).toBe("0.00");

    // ج) الحفاظ على العمليات المشروعة في المجاميع الكلية
    expect(res.totals.collectionsCash).toBe("2779500.00");
    expect(res.totals.salesCash).toBe("27300.00");
    expect(res.totals.expensesCash).toBe("150000.00");
  });

  it("R3 (Regression): استبعاد عكوس ومردودات الرواتب (SALARY_PAYMENT_RETURN / REMITTANCE_RETURN / EOS_SETTLEMENT_REVERSAL) من التدفقات المباشرة", async () => {
    // ١) إنشاء أحداث أصلية تُعكَس (لتوافق قيد chk_payroll_event_reversal_shape)
    const baseEvents = [
      { id: 70211, kind: "SALARY_PAYMENT" as const },
      { id: 70212, kind: "TAX_REMITTANCE" as const },
      { id: 70213, kind: "EOS_SETTLEMENT" as const },
    ];
    for (const be of baseEvents) {
      await db().insert(s.accountingEntries).values({
        id: be.id,
        entryType: "PAYMENT_OUT",
        branchId: 1,
        amount: "500000.00",
        entryDate: new Date(),
      });
      await db().insert(s.payrollAccountingEvents).values({
        id: be.id,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: be.kind,
        accountingEntryId: be.id,
        sourceKey: `PAYROLL:TEST:BASE:${be.id}`,
        sourceHash: "0".repeat(64),
        occurredAt: new Date(),
        createdBy: ADMIN,
      });
    }

    // ٢) سندات مردودات وعكوس رواتب نقدية واردة للخزينة
    const returnEvents = [
      { id: 70201, amount: "500000.00", kind: "SALARY_PAYMENT_RETURN" as const, reversalOfId: 70211 },
      { id: 70202, amount: "200000.00", kind: "REMITTANCE_RETURN" as const, reversalOfId: 70212 },
      { id: 70203, amount: "300000.00", kind: "EOS_SETTLEMENT_REVERSAL" as const, reversalOfId: 70213 },
    ];

    for (const re of returnEvents) {
      await db().insert(s.receipts).values({
        id: re.id,
        branchId: 1,
        shiftId: null,
        cashBucket: "TREASURY",
        direction: "IN",
        amount: re.amount,
        paymentMethod: "CASH",
        referenceNumber: null,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: ADMIN,
        approvedAt: new Date(),
        description: `مردود/عكس نقدي حدث ${re.kind}`,
        createdBy: ADMIN,
      });

      await db().insert(s.accountingEntries).values({
        id: re.id,
        entryType: "PAYMENT_IN",
        branchId: 1,
        amount: re.amount,
        entryDate: new Date(),
      });

      await db().insert(s.payrollAccountingEvents).values({
        id: re.id,
        branchIdSnapshot: 1,
        revisionNo: 0,
        eventKind: re.kind,
        accountingEntryId: re.id,
        receiptId: re.id,
        reversalOfId: re.reversalOfId,
        sourceKey: `PAYROLL:TEST:RET:${re.kind}:${re.id}`,
        sourceHash: "b".repeat(64),
        occurredAt: new Date(),
        createdBy: ADMIN,
      });
    }

    // حركة بيع مباشرة مشروعة بالتزامن
    const inv = await seedInvoice(1);
    await db().insert(s.receipts).values({
      id: 70204, branchId: 1, direction: "IN", amount: "400000.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      invoiceId: inv, createdBy: ADMIN,
    });

    const res = await report(1);

    // العكوس والمردودات لا تُحسب كإيراد مباشر ولا ترفع المتوقع كذباً
    expect(res.directOperations.receiptCount).toBe(1); // فقط البيع المباشر المشروع
    expect(res.directOperations.salesCash).toBe("400000.00");
    expect(res.directOperations.cashIn).toBe("400000.00");
    expect(res.directOperations.otherIn).toBe("0.00");
    expect(res.totals.cashIn).toBe("400000.00");
    expect(res.totals.expected).toBe("400000.00");
  });

  it("R3 (Adversarial): شمولية الاستبعاد لرواتب ذات مرجع صريح وبقاء السندات المباشرة عديمة المرجع مشمولة", async () => {
    // ١) سند تسوية نهاية خدمة يحمل referenceNumber صريح (TERM-SETTLEMENT-99-1) مرتبط بحدث رواتب
    await db().insert(s.receipts).values({
      id: 70301,
      branchId: 1,
      shiftId: null,
      cashBucket: "TREASURY",
      direction: "OUT",
      amount: "1500000.00",
      paymentMethod: "CASH",
      referenceNumber: "TERM-SETTLEMENT-99-1",
      voucherNumber: null,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      approvedBy: ADMIN,
      approvedAt: new Date(),
      description: "صرف نهاية خدمة بمرجع صريح",
      createdBy: ADMIN,
    });
    await db().insert(s.accountingEntries).values({
      id: 70301,
      entryType: "PAYMENT_OUT",
      branchId: 1,
      amount: "1500000.00",
      entryDate: new Date(),
    });
    await db().insert(s.payrollAccountingEvents).values({
      id: 70301,
      branchIdSnapshot: 1,
      revisionNo: 0,
      eventKind: "EOS_SETTLEMENT",
      accountingEntryId: 70301,
      receiptId: 70301,
      sourceKey: "PAYROLL:TEST:EOS:70301",
      sourceHash: "c".repeat(64),
      occurredAt: new Date(),
      createdBy: ADMIN,
    });

    // ٢) سند قبض مباشر مشروع (RV) لكن referenceNumber = null
    await db().insert(s.receipts).values({
      id: 70302,
      branchId: 1,
      direction: "IN",
      amount: "250000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: null,
      voucherNumber: "RV-NOREF-1",
      partyType: "CUSTOMER",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: ADMIN,
      description: "قبض مباشر بدون مرجع خارجي",
    });

    // ٣) سند صرف مباشر مشروع (PV) لكن referenceNumber = null
    await db().insert(s.receipts).values({
      id: 70303,
      branchId: 1,
      direction: "OUT",
      amount: "50000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: null,
      voucherNumber: "PV-NOREF-1",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      createdBy: ADMIN,
      description: "صرف مباشر بدون مرجع خارجي",
    });

    const res = await report(1);

    // الراتب بمرجع صريح مستبعد حتماً
    // السندات المشروعة غير المرتبطة بأحداث الرواتب مشمولة بالكامل حتى لو كان referenceNumber = null
    expect(res.directOperations.receiptCount).toBe(2);
    expect(res.directOperations.collectionsCash).toBe("250000.00");
    expect(res.directOperations.expensesCash).toBe("50000.00");
    expect(res.directOperations.netCash).toBe("200000.00");
    expect(res.totals.expected).toBe("200000.00");
  });
});

