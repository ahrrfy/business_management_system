import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../../services/tx";
import { truncateTables } from "./__testUtils__";
import { syncExpenseCategoriesToVouchersInTx } from "../voucher/syncExpenses";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

describe("مزامنة فئات المصروفات إلى فئات السندات", () => {
  beforeEach(async () => {
    await truncateTables([
      "receipts",
      "expenseCategories",
      "voucherCategories",
    ]);
  });

  it("يُزامن فئات المصروفات النشطة إلى فئات السندات ويربط كل دلو بدوره المعتمد ذرياً ويدعم idempotency", async () => {
    // 1. بذر فئات مصروفات نشطة
    await db().insert(s.expenseCategories).values([
      {
        id: 1,
        name: "إيجار المعرض والمخزن",
        bucket: "RENT",
        description: "إيجار الفرع الرئيسي",
        sortOrder: 10,
        isActive: true,
      },
      {
        id: 2,
        name: "اشتراك مولّدة أهلية",
        bucket: "UTILITIES",
        description: "كهرباء ومولدة",
        sortOrder: 20,
        isActive: true,
      },
      {
        id: 3,
        name: "أحبار وأوراق طباعة",
        bucket: "SUPPLIES",
        description: "مستهلكات طباعة",
        sortOrder: 30,
        isActive: true,
      },
      {
        id: 4,
        name: "رواتب عمال الطباعة",
        bucket: "SALARY",
        description: "أجور يومية وشهرية",
        sortOrder: 40,
        isActive: true,
      },
      {
        id: 5,
        name: "فئة معطلة قديمة",
        bucket: "OTHER",
        description: "غير مستعملة",
        sortOrder: 50,
        isActive: false,
      },
    ]);

    // 2. إدخال فئة قائمة في السندات بلا حساب مقابل لمطابقتها
    await db().insert(s.voucherCategories).values({
      id: 10,
      name: "إيجار المعرض والمخزن",
      direction: "OUT",
      postingRole: null,
      isActive: true,
      sortOrder: 10,
    });

    // 3. تنفيذ المزامنة لأول مرة
    const firstRun = await withTx((tx) => syncExpenseCategoriesToVouchersInTx(tx));

    expect(firstRun.mapped).toContain("إيجار المعرض والمخزن");
    expect(firstRun.inserted).toEqual(
      expect.arrayContaining([
        "اشتراك مولّدة أهلية",
        "أحبار وأوراق طباعة",
        "رواتب عمال الطباعة",
      ]),
    );
    expect(firstRun.inserted).not.toContain("فئة معطلة قديمة");

    // 4. التحقق من السجلات في جدول voucherCategories
    const allVouchers = await db().select().from(s.voucherCategories);
    const byName = new Map(allVouchers.map((row) => [row.name, row]));

    const rentCat = byName.get("إيجار المعرض والمخزن");
    expect(rentCat?.postingRole).toBe("RENT");
    expect(rentCat?.direction).toBe("OUT");

    const utilCat = byName.get("اشتراك مولّدة أهلية");
    expect(utilCat?.postingRole).toBe("UTILITIES");
    expect(utilCat?.direction).toBe("OUT");

    const supplyCat = byName.get("أحبار وأوراق طباعة");
    expect(supplyCat?.postingRole).toBe("OPERATING_EXPENSE");
    expect(supplyCat?.direction).toBe("OUT");

    const salaryCat = byName.get("رواتب عمال الطباعة");
    expect(salaryCat?.postingRole).toBe("SALARIES");
    expect(salaryCat?.direction).toBe("OUT");

    // 5. التحقق من الـ Idempotency في التشغيل الثاني
    const secondRun = await withTx((tx) => syncExpenseCategoriesToVouchersInTx(tx));
    expect(secondRun.inserted).toHaveLength(0);
    expect(secondRun.mapped).toHaveLength(0);
    expect(secondRun.skipped.length).toBeGreaterThanOrEqual(4);
  });
});
