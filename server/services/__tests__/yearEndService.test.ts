/**
 * Year-End — اختبار إقفال سنوي + رولوفر Retained Earnings + قفل الفترة.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { money } from "../money";
import { closeYear, listSnapshots } from "../yearEndService";
import { getActiveLock } from "../periodLockService";
import { truncateTables } from "./__testUtils__";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  await truncateTables(["yearEndSnapshots", "financialPeriods", "accountingEntries", "expenses", "suppliers", "branches", "users"]);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
}

async function seedEntries(year: number) {
  const d = db();
  const Y = `${year}-06-15`;
  // SALE: revenue 1000، cogs 600 ⇒ ربح 400
  await d.insert(s.accountingEntries).values({
    entryType: "SALE", dedupeKey: `SALE:T-1-${year}`, branchId: 1,
    revenue: "1000.00", cost: "600.00", profit: "400.00", amount: "1000.00",
    entryDate: new Date(Y),
  });
  // مصروف نقديّ ACTIVE في سجلّ المصروفات: 100 — مصدر الحقيقة الذي يقرأه P&L (لا PAYMENT_OUT الخام).
  // (تدقيق ١٧/٧: توحيد الإقفال مع P&L ⇒ المصروف يُقرأ من جدول expenses كما في الإنتاج.)
  await d.insert(s.expenses).values({
    branchId: 1, expenseDate: new Date(Y), category: "OTHER", amount: "100.00",
    paymentMethod: "CASH", source: "CASH", status: "ACTIVE", createdBy: 1,
  });
  // WASTAGE (خسارة مخزنية بالكلفة): 50 — يُقرأ من الدفتر (سطر «نثرية وتلف»).
  await d.insert(s.accountingEntries).values({
    entryType: "WASTAGE", branchId: 1, cost: "50.00", amount: "50.00",
    entryDate: new Date(Y),
  });
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("yearEndService — إقفال سنوي + رولوفر Retained Earnings", () => {
  it("closeYear يحسب الأرقام + يكتب snapshot + يقفل الفترة + ينشر قيد RE", async () => {
    await seedEntries(2025);
    const result = await withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 }));

    expect(money(result.totalRevenue).toNumber()).toBe(1000);
    expect(money(result.totalCogs).toNumber()).toBe(600);
    expect(money(result.totalExpenses).toNumber()).toBe(150); // 100 + 50
    expect(money(result.netProfit).toNumber()).toBe(250); // 1000 - 600 - 150
    expect(result.snapshotId).toBeGreaterThan(0);
    expect(result.retainedEarningsEntryId).not.toBeNull();
    expect(result.periodLockId).toBeGreaterThan(0);

    // الفترة مُقفَلة عند 2025-12-31
    const lock = await withTx(async (tx) => getActiveLock(tx));
    expect(lock).not.toBeNull();
    expect(lock!.cutoffDate).toBe("2025-12-31");

    // قيد RE موجود وعلى Jan 1 2026
    const d = db();
    const reEntries = await d.select().from(s.accountingEntries).where(eq(s.accountingEntries.dedupeKey, "YEAR_CLOSE:2025:1"));
    expect(reEntries.length).toBe(1);
    expect(money(reEntries[0].profit ?? "0").toNumber()).toBe(250);
    expect(new Date(reEntries[0].entryDate).getUTCFullYear()).toBe(2026);
    expect(new Date(reEntries[0].entryDate).getUTCMonth()).toBe(0); // January
  });

  it("closeYear مرتين لنفس السنة ⇒ CONFLICT", async () => {
    await seedEntries(2025);
    await withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 }));
    await expect(
      withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("بعد الإقفال: محاولة كتابة قيد بـentryDate في السنة المُقفَلة ⇒ FORBIDDEN", async () => {
    await seedEntries(2025);
    await withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 }));
    // محاولة postEntry على 2025-06-15 ⇒ مرفوض (الفترة مُقفَلة حتى 2025-12-31)
    const { postEntry } = await import("../ledgerService");
    await expect(
      withTx(async (tx) => postEntry(tx, {
        entryType: "ADJUST", amount: money("100"),
        entryDate: new Date("2025-06-15T00:00:00Z"),
      })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("netProfit صفر ⇒ لا قيد RE (لا داعي)", async () => {
    // لا أصدر أي SALE — كل الأرقام صفر
    const result = await withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 }));
    expect(money(result.netProfit).toNumber()).toBe(0);
    expect(result.retainedEarningsEntryId).toBeNull();
    expect(result.snapshotId).toBeGreaterThan(0);
  });

  it("listSnapshots يُعيد الإقفالات", async () => {
    await seedEntries(2025);
    await withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 }));
    const list = await withTx(async (tx) => listSnapshots(tx));
    expect(list.length).toBe(1);
    expect(Number(list[0].year)).toBe(2025);
  });

  it("closeYear سنة خارج النطاق ⇒ BAD_REQUEST", async () => {
    await expect(
      withTx(async (tx) => closeYear(tx, { year: 1999, branchId: 1, closedBy: 1 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // تدقيق ١٧/٧ (خطر #1): الإقفال السنوي يجب أن يطابق قائمة الدخل P&L تماماً — كانت صيغته المستقلّة تنحرف.
  it("مطابقة (tie-out): أرقام closeYear = plSnapshot لنفس السنة، مع استبعاد مرتجع الشراء من COGS", async () => {
    const { plSnapshot } = await import("../reportsFinancialService");
    const Y = "2025-06-15";
    // بيع: إيراد ١٠٠٠ / تكلفة ٦٠٠.
    await db().insert(s.accountingEntries).values({
      entryType: "SALE", dedupeKey: "SALE:TIE", branchId: 1,
      revenue: "1000.00", cost: "600.00", profit: "400.00", amount: "1000.00", entryDate: new Date(Y),
    });
    // مورّد مرجعيّ لـFK (قبل قيد مرتجع الشراء).
    await db().insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "0.00" });
    // مرتجع شراء: RETURN بـsupplierId وcost سالب ⇒ كانت الصيغة القديمة تُخفّض COGS بـ٢٠٠ وتَنفخ الربح.
    // P&L (والإقفال الموحَّد) يستثنيه من COGS ⇒ يجب ألّا يؤثّر في cogs.
    await db().insert(s.accountingEntries).values({
      entryType: "RETURN", dedupeKey: "PRET:TIE", branchId: 1, supplierId: 1,
      revenue: "0.00", cost: "-200.00", profit: "200.00", amount: "-200.00", entryDate: new Date(Y),
    });
    // مصروف نقديّ ACTIVE: ٨٠.
    await db().insert(s.expenses).values({
      branchId: 1, expenseDate: new Date(Y), category: "RENT", amount: "80.00",
      paymentMethod: "CASH", source: "CASH", status: "ACTIVE", createdBy: 1,
    });

    const result = await withTx(async (tx) => closeYear(tx, { year: 2025, branchId: 1, closedBy: 1 }));
    const pl = await plSnapshot("2025-01-01", "2025-12-31", 1);

    // COGS = ٦٠٠ فقط (مرتجع الشراء لا يخفضها) — الثابت الجوهريّ للإصلاح.
    expect(money(result.totalCogs).toNumber()).toBe(600);
    // مطابقة كاملة مع محرّك P&L.
    expect(money(result.totalRevenue).toNumber()).toBe(money(pl.revenue).toNumber());
    expect(money(result.totalCogs).toNumber()).toBe(money(pl.cogs).toNumber());
    expect(money(result.totalExpenses).toNumber()).toBe(money(pl.totalExpenses).toNumber());
    expect(money(result.netProfit).toNumber()).toBe(money(pl.netProfit).toNumber());
  });
});
