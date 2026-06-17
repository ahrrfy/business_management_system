// تقرير «النقد خارج الوردية» — يَفصل TREASURY (إداري مشروع) عن TRUE_ORPHAN (تاريخي/خَلل).
// يُثبّت أن المعاملات الإدارية الجديدة تَدخل countTreasury، والسجلات بـcashBucket=NULL/DRAWER
// تَدخل countTrueOrphan، وأن totalIn/Out مفصولة بدقّة.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createExpense } from "../expenseService";
import { getCashOrphansReport } from "../reportsTreasuryService";

const adminActor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "expenseStockItems", "expenses",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "أحمد المدير", role: "admin", loginMethod: "local", branchId: 1 });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("cashOrphans يَفصل TREASURY عن TRUE_ORPHAN", () => {
  it("admin بـcashBucket=TREASURY يَدخل countTreasury، والسجلّ التاريخي بـNULL يَدخل countTrueOrphan", async () => {
    // ١) مصروف admin (TREASURY) ⇒ يُكتَب تلقائياً بـcashBucket='TREASURY'.
    await createExpense(
      { branchId: 1, category: "RENT", amount: "500000", paymentMethod: "CASH", description: "إيجار طارئ" },
      adminActor
    );
    // ٢) محاكاة سجلّ تاريخي قبل الهجرة: receipt مباشر بـcashBucket=NULL + shiftId=null.
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      cashBucket: null,
      direction: "OUT",
      amount: "300000",
      paymentMethod: "CASH",
      status: "COMPLETED",
      createdBy: 1,
    });
    // ٣) محاكاة سجلّ خَلل: receipt بـcashBucket='DRAWER' لكن shiftId=null (مُربك ⇒ يُصنَّف TRUE_ORPHAN).
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      cashBucket: "DRAWER",
      direction: "IN",
      amount: "100000",
      paymentMethod: "CASH",
      status: "COMPLETED",
      createdBy: 1,
    });

    const r = await getCashOrphansReport({});

    expect(r.count).toBe(3);
    expect(r.countTreasury).toBe(1); // المصروف admin فقط
    expect(r.countTrueOrphan).toBe(2); // التاريخي + الخَلل

    expect(r.totalOutTreasury).toBe("500000.00");
    expect(r.totalInTreasury).toBe("0.00");
    expect(r.netTreasury).toBe("-500000.00");

    expect(r.totalOutTrueOrphan).toBe("300000.00");
    expect(r.totalInTrueOrphan).toBe("100000.00");
    expect(r.netTrueOrphan).toBe("-200000.00");

    // الإجمالي الكلّي = خزينة + يتيم
    expect(r.totalOut).toBe("800000.00");
    expect(r.totalIn).toBe("100000.00");
  });

  it("فلتر category=TREASURY يَقصِر النتائج", async () => {
    await createExpense(
      { branchId: 1, category: "RENT", amount: "500000", paymentMethod: "CASH", description: "إيجار" },
      adminActor
    );
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: null, cashBucket: null,
      direction: "OUT", amount: "300000", paymentMethod: "CASH", status: "COMPLETED", createdBy: 1,
    });

    const treasury = await getCashOrphansReport({ category: "TREASURY" });
    expect(treasury.rows).toHaveLength(1);
    expect(treasury.rows[0].category).toBe("TREASURY");
    expect(treasury.rows[0].cashBucket).toBe("TREASURY");

    const orphan = await getCashOrphansReport({ category: "TRUE_ORPHAN" });
    expect(orphan.rows).toHaveLength(1);
    expect(orphan.rows[0].category).toBe("TRUE_ORPHAN");
  });

  it("createdByRole يَظهر في كل صفّ ليُمكِّن شارة الدور في الواجهة", async () => {
    await createExpense(
      { branchId: 1, category: "RENT", amount: "500000", paymentMethod: "CASH", description: "إيجار" },
      adminActor
    );
    const r = await getCashOrphansReport({});
    expect(r.rows[0].createdByRole).toBe("admin");
    expect(r.rows[0].createdByName).toBe("أحمد المدير");
  });

  it("لا معاملات شرعيّة ولا تاريخية ⇒ كل العدّادات صفر", async () => {
    const r = await getCashOrphansReport({});
    expect(r.count).toBe(0);
    expect(r.countTreasury).toBe(0);
    expect(r.countTrueOrphan).toBe(0);
    expect(r.totalIn).toBe("0.00");
    expect(r.totalOut).toBe("0.00");
  });
});
