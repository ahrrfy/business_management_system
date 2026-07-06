/**
 * اختبارات تكامل (DB) للأهداف الشهرية + كنسة الوعاء المشتركة — وحدة الأهداف والعمولات (S2).
 * تغطّي:
 *  - الشبكة: المؤهَّلون فقط (مرتبط بمستخدم + غير منتهي الخدمة).
 *  - «فعليّ الشهر السابق» من كنسة base.ts: إسناد WORKORDER لمنشئ أمر الشغل لا المُسلِّم،
 *    وطرح المرتجع، واستبعاد شهرٍ آخر — أول تحقّق مالي من الإسناد الذكي.
 *  - saveAll: upsert على uq_target_emp_period + حذف بـnull + رفض ≤ 0 وبلا-حساب.
 *  - copyFromPrevious: لا سابقَ ⇒ رفض؛ نسخ؛ قائمٌ بلا overwrite ⇒ CONFLICT؛ overwrite يكتب.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { copyTargetsFromPrevious, getTargetsGrid, saveTargets } from "../commissions/targets";

const ACTOR = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "workOrders",
  "invoices",
  "salesTargets",
  "commissionAssignments",
  "commissionPlanTiers",
  "commissionPlans",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

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

/** U3 = البائع (موظف 11 مؤهَّل)، U4 = المُسلِّم (موظفه 13 منتهي الخدمة ⇒ خارج الشبكة). */
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "t-admin", name: "مدير النظام", role: "admin", branchId: 1 },
    { id: 3, openId: "t-seller", name: "بائع الاستقبال", role: "cashier", branchId: 1 },
    { id: 4, openId: "t-deliverer", name: "مُسلِّم", role: "cashier", branchId: 1 },
  ]);
  await d.insert(s.employees).values([
    { id: 11, userId: 3, branchId: 1, firstName: "علي", lastName: "البائع", payType: "monthly", salary: "1000000" },
    { id: 12, userId: null, branchId: 1, firstName: "أرشيفي", lastName: "بلا حساب", payType: "monthly", salary: "500000" },
    { id: 13, userId: 4, branchId: 1, firstName: "منتهي", lastName: "الخدمة", payType: "monthly", salary: "500000", employmentStatus: "terminated" },
  ]);
}

/** دفتر 2026-06: بيع POS لـU3 + بيع WORKORDER سلّمه U4 لكن أمرَ الشغل أنشأه U3 + مرتجع جزئي + بيع خارج الشهر. */
async function seedJuneLedger() {
  const d = db();
  await d.insert(s.invoices).values([
    { id: 100, invoiceNumber: "INV-100", sourceType: "POS", sourceId: "t-100", branchId: 1, subtotal: "800000", total: "800000", paidAmount: "800000", status: "PAID", createdBy: 3 },
    { id: 101, invoiceNumber: "INV-101", sourceType: "WORKORDER", sourceId: "WO-500", branchId: 1, subtotal: "2000000", total: "2000000", paidAmount: "2000000", status: "PAID", createdBy: 4 },
    { id: 102, invoiceNumber: "INV-102", sourceType: "POS", sourceId: "t-102", branchId: 1, subtotal: "999999", total: "999999", paidAmount: "999999", status: "PAID", createdBy: 3 },
  ]);
  await d.insert(s.workOrders).values([
    { id: 500, orderNumber: "WO-500", branchId: 1, title: "درع تخرج", salePrice: "2000000", status: "DELIVERED", invoiceId: 101, createdBy: 3 },
  ]);
  await d.insert(s.accountingEntries).values([
    { entryType: "SALE", branchId: 1, invoiceId: 100, revenue: "800000", cost: "0", profit: "800000", amount: "800000", entryDate: new Date("2026-06-10") },
    { entryType: "SALE", branchId: 1, invoiceId: 101, revenue: "2000000", cost: "0", profit: "2000000", amount: "2000000", entryDate: new Date("2026-06-12") },
    // مرتجع جزئي من فاتورة U3 في نفس الشهر (revenue سالبة بدلالة الدفتر).
    { entryType: "RETURN", branchId: 1, invoiceId: 100, revenue: "-200000", cost: "0", profit: "-200000", amount: "-200000", entryDate: new Date("2026-06-20") },
    // بيع في شهر آخر يجب ألّا يدخل وعاء يونيو.
    { entryType: "SALE", branchId: 1, invoiceId: 102, revenue: "999999", cost: "0", profit: "999999", amount: "999999", entryDate: new Date("2026-05-10") },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("commissionTargets — الشبكة وكنسة الوعاء", () => {
  it("الشبكة تعرض المؤهَّلين فقط (لا بلا-حساب ولا منتهي الخدمة) بهدف فارغ ابتداءً", async () => {
    const grid = await getTargetsGrid("2026-07");
    expect(grid.length).toBe(1);
    expect(grid[0].employeeId).toBe(11);
    expect(grid[0].target).toBeNull();
  });

  it("فعليّ الشهر السابق يتبع الإسناد الذكي (WORKORDER لمنشئ أمر الشغل) ويطرح المرتجع ويستبعد شهراً آخر", async () => {
    await seedJuneLedger();
    const grid = await getTargetsGrid("2026-07");
    const ali = grid.find((r) => r.employeeId === 11)!;
    // 800,000 (POS) + 2,000,000 (WORKORDER أنشأه U3 وسلّمه U4) − 200,000 (مرتجع) = 2,600,000
    // بيع 2026-05 (999,999) مستبعَد.
    expect(Number(ali.lastMonthActual)).toBe(2600000);
  });

  it("saveAll: إدراج ثم تحديث (upsert) ثم حذف بـnull", async () => {
    const r1 = await saveTargets({ period: "2026-07", rows: [{ employeeId: 11, target: "5000000" }] }, ACTOR);
    expect(r1.saved).toBe(1);
    let [row] = await db().select().from(s.salesTargets).where(and(eq(s.salesTargets.employeeId, 11), eq(s.salesTargets.period, "2026-07")));
    expect(Number(row.targetAmount)).toBe(5000000);

    const r2 = await saveTargets({ period: "2026-07", rows: [{ employeeId: 11, target: "7000000" }] }, ACTOR);
    expect(r2.saved).toBe(1);
    [row] = await db().select().from(s.salesTargets).where(and(eq(s.salesTargets.employeeId, 11), eq(s.salesTargets.period, "2026-07")));
    expect(Number(row.targetAmount)).toBe(7000000);
    const all = await db().select().from(s.salesTargets);
    expect(all.length).toBe(1); // upsert لا تكرار.

    const r3 = await saveTargets({ period: "2026-07", rows: [{ employeeId: 11, target: null }] }, ACTOR);
    expect(r3.removed).toBe(1);
    const after = await db().select().from(s.salesTargets);
    expect(after.length).toBe(0);
  });

  it("saveAll يرفض هدفاً صفرياً/سالباً وموظفاً بلا حساب", async () => {
    await expect(saveTargets({ period: "2026-07", rows: [{ employeeId: 11, target: "0" }] }, ACTOR)).rejects.toThrow(/أكبر من صفر/);
    await expect(saveTargets({ period: "2026-07", rows: [{ employeeId: 12, target: "1000" }] }, ACTOR)).rejects.toThrow(/بلا حساب/);
  });

  it("copyFromPrevious: لا سابق ⇒ رفض؛ نسخ؛ قائم بلا overwrite ⇒ CONFLICT؛ overwrite يكتب", async () => {
    await expect(copyTargetsFromPrevious({ period: "2026-07", overwrite: false }, ACTOR)).rejects.toThrow(/لا أهداف/);

    await saveTargets({ period: "2026-06", rows: [{ employeeId: 11, target: "4000000" }] }, ACTOR);
    const c1 = await copyTargetsFromPrevious({ period: "2026-07", overwrite: false }, ACTOR);
    expect(c1.copied).toBe(1);
    let [row] = await db().select().from(s.salesTargets).where(and(eq(s.salesTargets.employeeId, 11), eq(s.salesTargets.period, "2026-07")));
    expect(Number(row.targetAmount)).toBe(4000000);

    // عدّل هدف يوليو ثم انسخ بلا overwrite ⇒ CONFLICT، وبـoverwrite ⇒ يعود 4,000,000.
    await saveTargets({ period: "2026-07", rows: [{ employeeId: 11, target: "9000000" }] }, ACTOR);
    await expect(copyTargetsFromPrevious({ period: "2026-07", overwrite: false }, ACTOR)).rejects.toMatchObject({ code: "CONFLICT" });
    const c2 = await copyTargetsFromPrevious({ period: "2026-07", overwrite: true }, ACTOR);
    expect(c2.copied).toBe(1);
    [row] = await db().select().from(s.salesTargets).where(and(eq(s.salesTargets.employeeId, 11), eq(s.salesTargets.period, "2026-07")));
    expect(Number(row.targetAmount)).toBe(4000000);
  });
});
