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
  it("R1+R2: إدراج سند قبض مباشر (RV) بمبلغ 3,540,950 د.ع يرفع المتوقَّع ويطابق النقد الفعلي 13,568,250 د.ع بلا فائض صامت", async () => {
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

    // التحقق من المجاميع الكاملة: تشمل الوردية + التدفق المباشر
    expect(res.totals.shiftExpected).toBe("10027300.00");
    expect(res.totals.directNetCash).toBe("3540950.00");
    expect(res.totals.collectionsCash).toBe("3540950.00");
    expect(res.totals.cashIn).toBe("3568250.00"); // 27,300 مبيعات وردية + 3,540,950 تحصيل مباشر
    // المتوقَّع الشامل = 10,027,300 + 3,540,950 = 13,568,250 د.ع (يطابق النقد الفعلي تماماً!)
    expect(res.totals.expected).toBe("13568250.00");
    expect(res.totals.closedExpected).toBe("13568250.00");
    expect(res.totals.physicalDrawerCash).toBe("13568250.00");

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
    expect(res.totals.physicalDrawerCash).toBe("3540950.00");
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

    // تقرير الغد يرى حركة 900,000
    const resTomorrow = await getDayCloseReconciliation({ date: nextDateStr, branchId: 1 });
    expect(resTomorrow.directOperations.collectionsCash).toBe("900000.00");
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
});

