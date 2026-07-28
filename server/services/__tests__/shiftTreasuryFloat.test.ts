/**
 * العهدة الوسيطة (imprest) — إصلاح Codex P1 على #377 (قرار المالك ٢٨/٧/٢٦).
 *
 * الثابت المُختبَر: **الخزينة + مجموع أدراج الورديات المفتوحة متّسقان دائماً** عبر تمويل→فتح→بيع→إغلاق→
 * إعادة فتح، بلا ازدواجٍ وهميّ (فشل Codex) ولا نقدٍ متبخّر. النموذج: عهدة الفتح تُسحَب من الخزينة
 * (TREASURY OUT + قيد SHIFT_FLOAT_OUT)، وكامل المعدود يعود للخزينة عند الإغلاق فوراً (TREASURY IN
 * مكتمل + قيد CASH_HANDOVER). التمويل (رأس المال) يضخّ نقداً خارجياً (TREASURY IN + قيد TREASURY_FUNDING).
 * كل قيود الحركة revenue=cost=profit=0 (لا تمسّ P&L).
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { fundTreasury } from "../treasuryFundingService";
import { getDashboard } from "../treasury/dashboard";
import { truncateTables } from "./__testUtils__";

const TABLES = ["auditLogs", "accountingEntries", "idempotencyKeys", "expenses", "receipts", "shifts", "users", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const ADMIN = 1;
const MANAGER1 = 2; // فرع ١
const CASHIER1 = 3; // فرع ١
const CASHIER2 = 4; // فرع ١
const MANAGER2 = 5; // فرع ٢

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: ADMIN, openId: "l_admin", name: "أدمن", role: "admin", loginMethod: "local" },
    { id: MANAGER1, openId: "l_m1", name: "مدير١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: CASHIER1, openId: "l_c1", name: "كاشير١", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: CASHIER2, openId: "l_c2", name: "كاشير٢", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: MANAGER2, openId: "l_m2", name: "مدير٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

/** لقطة الخزينة + الدرج من لوحة القيادة الفعلية (المصدر الذي كشف Codex فكّه). */
async function dash(branchId: number) {
  const d = await getDashboard({ branchId }, { scopedBranchId: null, role: "admin", userId: ADMIN });
  const dr = d.drawerBalances.find((r) => r.branchId === branchId);
  const tr = d.treasuryBalances.find((r) => r.branchId === branchId);
  return {
    treasury: tr?.balance ?? "0.00",
    drawer: dr?.expectedCash ?? "0.00",
    openShifts: dr?.openShiftsCount ?? 0,
  };
}

/** محاكاة قبض نقديّ (بيع) داخل الوردية — إيصال درجٍ IN كما يكتبه createSale. */
async function sellCash(shiftId: number, branchId: number, amount: string, createdBy = CASHIER1) {
  await db().insert(s.receipts).values({
    branchId, shiftId, direction: "IN", amount, paymentMethod: "CASH", cashBucket: "DRAWER",
    status: "COMPLETED", createdBy,
  });
}

async function entriesOfType(entryType: string) {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, entryType as any));
}

describe("imprest — التمويل (fundTreasury)", () => {
  it("يرفع رصيد الخزينة + سند TF + قيد TREASURY_FUNDING محايد للربح", async () => {
    const r = await fundTreasury(
      { branchId: 1, amount: "200000", description: "رأس مال أوّليّ", clientRequestId: "fund-1" },
      { userId: MANAGER1, branchId: 1, role: "manager" },
    );
    expect(r.referenceNumber).toMatch(/^TF-1-\d{8}-0001$/);
    expect(r.treasuryBalanceAfter).toBe("200000.00");
    expect((await dash(1)).treasury).toBe("200000.00");

    const rec = (await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, r.referenceNumber)))[0];
    expect(rec).toMatchObject({ direction: "IN", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED" });
    expect(rec.shiftId).toBeNull();

    const entries = await entriesOfType("TREASURY_FUNDING");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: "200000.00", revenue: "0.00", cost: "0.00", profit: "0.00", branchId: 1 });
  });

  it("idempotent: نفس المفتاح لا يضاعف رأس المال", async () => {
    const a = await fundTreasury({ branchId: 1, amount: "200000", description: "رأس مال", clientRequestId: "dup" }, { userId: MANAGER1, branchId: 1, role: "manager" });
    const b = await fundTreasury({ branchId: 1, amount: "200000", description: "رأس مال", clientRequestId: "dup" }, { userId: MANAGER1, branchId: 1, role: "manager" });
    expect(b.receiptId).toBe(a.receiptId);
    expect((await dash(1)).treasury).toBe("200000.00");
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });

  it("حوكمة: الكاشير مرفوض، والمدير لا يموّل فرعاً آخر", async () => {
    await expect(
      fundTreasury({ branchId: 1, amount: "1000", description: "x", clientRequestId: "g1" }, { userId: CASHIER1, branchId: 1, role: "cashier" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      fundTreasury({ branchId: 2, amount: "1000", description: "x", clientRequestId: "g2" }, { userId: MANAGER1, branchId: 1, role: "manager" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // التبرير إلزاميّ.
    await expect(
      fundTreasury({ branchId: 1, amount: "1000", description: "   ", clientRequestId: "g3" }, { userId: MANAGER1, branchId: 1, role: "manager" }),
    ).rejects.toThrow(/تبرير/);
  });
});

describe("imprest — فتح الوردية يسحب العهدة من الخزينة", () => {
  it("TREASURY OUT + قيد SHIFT_FLOAT_OUT محايد؛ الخزينة تنقص بمقدار العهدة", async () => {
    await fundTreasury({ branchId: 1, amount: "200000", description: "رأس مال", clientRequestId: "f" }, { userId: MANAGER1, branchId: 1, role: "manager" });
    const res = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });
    expect(res.treasuryWarning).toBe(false);
    expect(res.treasuryBalanceAfter).toBe("150000.00");

    const d = await dash(1);
    expect(d.treasury).toBe("150000.00"); // 200000 − 50000
    expect(d.drawer).toBe("50000.00");    // العهدة في الدرج
    // مجموع النظام = خزينة 150000 + درج 50000 = 200000 (= المموَّل) — بلا ازدواج.

    const sf = (await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `SF-1-${res.shiftId}`)))[0];
    expect(sf).toMatchObject({ direction: "OUT", cashBucket: "TREASURY", amount: "50000.00", status: "COMPLETED" });
    expect(sf.shiftId).toBeNull();
    const entries = await entriesOfType("SHIFT_FLOAT_OUT");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ amount: "50000.00", revenue: "0.00", cost: "0.00", profit: "0.00" });
  });

  it("أوّل وردية بخزينة فارغة: تُفتَح بعجزٍ ظاهر لا حظر (allow + warning)", async () => {
    const res = await openShift({ branchId: 1, openingBalance: "30000" }, { userId: CASHIER1, branchId: 1 });
    expect(res.shiftId).toBeGreaterThan(0);            // لم يُحظَر
    expect(res.treasuryWarning).toBe(true);
    expect(res.treasuryBalanceAfter).toBe("-30000.00");
    expect((await dash(1)).treasury).toBe("-30000.00"); // العجز مرئيّ للمدير ليموّل
    expect((await db().select().from(s.shifts))).toHaveLength(1);
  });

  it("فتح بعهدة صفر: لا حركة خزينة ولا تحذير", async () => {
    const res = await openShift({ branchId: 1, openingBalance: "0" }, { userId: CASHIER1, branchId: 1 });
    expect(res.treasuryWarning).toBe(false);
    expect(res.treasuryBalanceAfter).toBeNull();
    expect(await entriesOfType("SHIFT_FLOAT_OUT")).toHaveLength(0);
    expect((await dash(1)).treasury).toBe("0.00");
  });
});

describe("imprest — الإغلاق يعيد كامل المعدود فوراً", () => {
  it("TREASURY IN مكتمل (=المعدود) + الدرج يُفرَّغ (closingDrawerCash=0)", async () => {
    await fundTreasury({ branchId: 1, amount: "200000", description: "رأس مال", clientRequestId: "f" }, { userId: MANAGER1, branchId: 1, role: "manager" });
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "50000" }, { userId: CASHIER1, branchId: 1 });
    await sellCash(shiftId, 1, "30000.00"); // بيع نقديّ ⇒ الدرج 80000

    const res = await closeShift(
      { shiftId, countedCash: "80000", enforceCashGovernance: true },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );
    expect(res.variance).toBe("0.00");
    expect(res.reconciliationStatus).toBe("MATCHED");
    expect(res.treasuryReturn).toBeTruthy();
    expect(res.treasuryReturn!.handoverNumber).toMatch(/^CH-1-\d{8}-0001$/);

    const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, shiftId)))[0];
    expect(sh.closingDrawerCash).toBe("0.00");

    // الخزينة = 200000 − 50000 (عهدة) + 80000 (إرجاع) = 230000 = 200000 مموَّل + 30000 مبيعات.
    const d = await dash(1);
    expect(d.treasury).toBe("230000.00");
    expect(d.drawer).toBe("0.00");
    expect(d.openShifts).toBe(0);

    // إيصال الإرجاع IN مكتملٌ فوراً (لا PENDING) + قيد CASH_HANDOVER محايد.
    const inn = (await db().select().from(s.receipts).where(and(eq(s.receipts.referenceNumber, res.treasuryReturn!.handoverNumber), eq(s.receipts.direction, "IN"))))[0];
    expect(inn).toMatchObject({ cashBucket: "TREASURY", status: "COMPLETED", amount: "80000.00" });
    const ch = await entriesOfType("CASH_HANDOVER");
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ amount: "80000.00", revenue: "0.00", cost: "0.00" });
  });

  it("إغلاق بمعدود صفر: لا إرجاع للخزينة", async () => {
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "0" }, { userId: CASHIER1, branchId: 1 });
    const res = await closeShift({ shiftId, countedCash: "0", enforceCashGovernance: true }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    expect(res.treasuryReturn).toBeNull();
    expect(await entriesOfType("CASH_HANDOVER")).toHaveLength(0);
  });
});

describe("imprest — الثابت الجوهريّ (منع ازدواج Codex + دورة كاملة)", () => {
  it("منع الازدواج (Codex P1): عهدة مُعادة ثم عهدة جديدة ⇒ لا خزينة+درج مضاعفان", async () => {
    await fundTreasury({ branchId: 1, amount: "100000", description: "رأس مال", clientRequestId: "f" }, { userId: MANAGER1, branchId: 1, role: "manager" });

    // وردية A: عهدة 100000 (الخزينة ⇒ 0)، بلا بيع، إغلاق بمعدود 100000 ⇒ الإرجاع يعيد الخزينة 100000.
    const a = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    expect((await dash(1)).treasury).toBe("0.00");
    await closeShift({ shiftId: a.shiftId, countedCash: "100000", enforceCashGovernance: true }, { userId: CASHIER1, branchId: 1, role: "cashier" });
    expect((await dash(1)).treasury).toBe("100000.00");

    // وردية B: عهدة جديدة 100000 (الخزينة ⇒ 0، الدرج ⇒ 100000).
    const b = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER2, branchId: 1 });
    expect(b.shiftId).toBeGreaterThan(0);

    // الثابت: خزينة 0 + درج 100000 = 100000 (النقد الحقيقيّ الوحيد) — **لا 200000 وهميّة** (فشل Codex).
    const d = await dash(1);
    expect(d.treasury).toBe("0.00");
    expect(d.drawer).toBe("100000.00");
    expect(Number(d.treasury) + Number(d.drawer)).toBe(100000);
  });

  it("سيناريو الحادثة الإنتاجية: عهدة 100k + بيع 351k ⇒ عدّ 451k ⇒ إغلاق مطابق ودرج صفر", async () => {
    await fundTreasury({ branchId: 1, amount: "500000", description: "رأس مال", clientRequestId: "f" }, { userId: MANAGER1, branchId: 1, role: "manager" });
    const { shiftId } = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER1, branchId: 1 });
    await sellCash(shiftId, 1, "351000.00"); // بيع نقديّ ⇒ الدرج 451000

    // الكاشير يعدّ الدرج كاملاً (451000) — لا التباس تسليم/عدّ (لا حقل تسليم أصلاً في النموذج التلقائيّ).
    const res = await closeShift(
      { shiftId, countedCash: "451000", enforceCashGovernance: true },
      { userId: CASHIER1, branchId: 1, role: "cashier" },
    );
    expect(res.reconciliationStatus).toBe("MATCHED"); // لا عجز وهميّ
    expect(res.variance).toBe("0.00");
    expect(res.expectedCash).toBe("451000.00");       // 100000 + 351000

    const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, shiftId)))[0];
    expect(sh.closingDrawerCash).toBe("0.00");        // الدرج صفر

    const d = await dash(1);
    expect(d.treasury).toBe("851000.00");             // 500000 − 100000 + 451000
    expect(d.drawer).toBe("0.00");

    // الوردية التالية تبدأ بعهدةٍ جديدة من الخزينة (استقلال تامّ).
    const next = await openShift({ branchId: 1, openingBalance: "100000" }, { userId: CASHIER2, branchId: 1 });
    expect(next.treasuryWarning).toBe(false);
    expect(next.treasuryBalanceAfter).toBe("751000.00"); // 851000 − 100000
  });

  it("دورة كاملة عبر فرعين: التمويل والأدراج معزولة بالفرع", async () => {
    await fundTreasury({ branchId: 1, amount: "100000", description: "ف١", clientRequestId: "f1" }, { userId: MANAGER1, branchId: 1, role: "manager" });
    await fundTreasury({ branchId: 2, amount: "60000", description: "ف٢", clientRequestId: "f2" }, { userId: MANAGER2, branchId: 2, role: "manager" });
    await openShift({ branchId: 1, openingBalance: "40000" }, { userId: CASHIER1, branchId: 1 });
    await openShift({ branchId: 2, openingBalance: "25000" }, { userId: MANAGER2, branchId: 2, role: "manager" } as any);

    const d1 = await dash(1);
    const d2 = await dash(2);
    expect(d1.treasury).toBe("60000.00");  // 100000 − 40000
    expect(d1.drawer).toBe("40000.00");
    expect(d2.treasury).toBe("35000.00");  // 60000 − 25000
    expect(d2.drawer).toBe("25000.00");
  });
});
