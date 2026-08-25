/**
 * تصفية خروج الموظّف — الثابت الحاكم: **لا يغادر موظّفٌ وله أثرٌ ماليّ أو مادّيّ أو صلاحيةٌ قائمة.**
 *
 * كل بندٍ هنا يمثّل وحدةً مستقلّة لا تعرف بالأخريات؛ ما يُختبَر هو أنّ التجميع يراها كلّها،
 * وأنّه يفرّق بين ما يمنع الخروج (أثرٌ قائم) وما يُنبّه فقط (يزول بإجراءٍ إداريّ).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getEmployeeClearance } from "../hr/offboarding";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "commissionRunLines", "commissionRuns", "commissionPlans",
    "deliveryPartyMembers", "deliveryParties",
    "employeeAdvances", "fixedAssets", "userSessions", "shifts",
    "employees", "users", "branches",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
    { id: 2, openId: "cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.employees).values({
    id: 10, userId: 2, branchId: 1, firstName: "علي", lastName: "حسن", isActive: true,
  });
  await d.insert(s.branches).values({ id: 2, name: "الفرع الثاني", code: "BR2", type: "SALES" });
  await d.insert(s.employees).values({
    id: 20, userId: null, branchId: 2, firstName: "ليلى", lastName: "سالم", isActive: true,
  });
}

beforeEach(reset);

describe("تصفية خروج الموظّف", () => {
  it("موظّفٌ نظيف: لا بنود ويجوز إنهاء خدمته", async () => {
    const c = await getEmployeeClearance(10);
    expect(c.employeeName).toBe("علي حسن");
    expect(c.items).toHaveLength(0);
    expect(c.blockingCount).toBe(0);
    expect(c.clearedToExit).toBe(true);
  });

  it("نطاق الفرع يمنع قراءة تصفية موظف من فرع آخر", async () => {
    await expect(getEmployeeClearance(20, { branchId: 1 })).rejects.toThrow("الموظّف غير موجود");
    await expect(getEmployeeClearance(20, { branchId: null })).resolves.toMatchObject({ employeeId: 20 });
  });

  it("وردية مفتوحة تمنع الخروج — نقدٌ في درجٍ لا يُغلق بعد مغادرته", async () => {
    await db().insert(s.shifts).values({
      branchId: 1, userId: 2, openingBalance: "50000.00", status: "OPEN", openedAt: new Date(),
    });
    const c = await getEmployeeClearance(10);
    const item = c.items.find((i) => i.key === "OPEN_SHIFT")!;
    expect(item.severity).toBe("BLOCKING");
    expect(item.count).toBe(1);
    expect(item.resolvePath).toBe("/shifts");
    expect(c.clearedToExit).toBe(false);
  });

  it("عهدة أصولٍ تمنع الخروج وتُسمّي الأصل", async () => {
    await db().insert(s.fixedAssets).values({
      id: 1, code: "AST-1", name: "لابتوب ديل", custodianId: 10, branchId: 1,
      purchaseValue: "1000000.00", purchaseDate: "2026-01-01", usefulLifeYears: 5,
    });
    const c = await getEmployeeClearance(10);
    const item = c.items.find((i) => i.key === "ASSET_CUSTODY")!;
    expect(item.severity).toBe("BLOCKING");
    expect(item.details[0]).toContain("لابتوب ديل");
    expect(item.details[0]).toContain("AST-1");
    expect(c.clearedToExit).toBe(false);
  });

  it("سلفةٌ قائمة تمنع الخروج بمجموع المتبقّي بدقّة decimal", async () => {
    await db().insert(s.employeeAdvances).values([
      { employeeId: 10, branchId: 1, amount: "300000.00", remaining: "125000.50", status: "ACTIVE", createdBy: 1 },
      { employeeId: 10, branchId: 1, amount: "100000.00", remaining: "74999.50", status: "ACTIVE", createdBy: 1 },
      // مسوَّاة ⇒ لا تُحتسَب.
      { employeeId: 10, branchId: 1, amount: "50000.00", remaining: "0.00", status: "SETTLED", createdBy: 1 },
    ]);
    const c = await getEmployeeClearance(10);
    const item = c.items.find((i) => i.key === "OUTSTANDING_ADVANCE")!;
    expect(item.count).toBe(2);
    expect(item.amount).toBe("200000.00");
    expect(c.clearedToExit).toBe(false);
  });

  it("عضوية جهة توصيل نشطة تمنع الخروج — البوّابة تبقى مفتوحة لمن غادر", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "مندوب أ", createdBy: 1 });
    await db().insert(s.deliveryPartyMembers).values({
      partyId: 1, userId: 2, memberRole: "DRIVER", isActive: true, createdBy: 1,
    });
    const c = await getEmployeeClearance(10);
    const item = c.items.find((i) => i.key === "DELIVERY_MEMBERSHIP")!;
    expect(item.severity).toBe("BLOCKING");
    expect(item.details[0]).toContain("مندوب أ");
    expect(c.clearedToExit).toBe(false);
  });

  it("الجلسات الحيّة تُنبّه ولا تمنع — تزول بإبطالٍ إداريّ بلا أثرٍ ماليّ", async () => {
    const future = new Date(Date.now() + 3_600_000);
    await db().insert(s.userSessions).values([
      { userId: 2, sid: "live-1", fingerprint: "fp1", expiresAt: future },
      // منتهية ومُبطَلة ⇒ لا تُحتسَبان.
      { userId: 2, sid: "old-1", fingerprint: "fp2", expiresAt: new Date(Date.now() - 1000) },
      { userId: 2, sid: "rev-1", fingerprint: "fp3", expiresAt: future, revokedAt: new Date() },
    ]);
    const c = await getEmployeeClearance(10);
    const item = c.items.find((i) => i.key === "ACTIVE_SESSIONS")!;
    expect(item.severity).toBe("WARNING");
    expect(item.count).toBe(1);
    // التحذير وحده لا يمنع الخروج.
    expect(c.blockingCount).toBe(0);
    expect(c.clearedToExit).toBe(true);
  });

  it("موظّفٌ بلا حساب دخول: تُتخطّى البنود المرتبطة بالحساب ولا تنكسر التصفية", async () => {
    await db().insert(s.employees).values({
      id: 11, userId: null, branchId: 1, firstName: "سارة", lastName: "كريم", isActive: true,
    });
    await db().insert(s.fixedAssets).values({
      id: 2, code: "AST-2", name: "طابعة", custodianId: 11, branchId: 1,
      purchaseValue: "500000.00", purchaseDate: "2026-01-01", usefulLifeYears: 5,
    });
    const c = await getEmployeeClearance(11);
    expect(c.userId).toBeNull();
    // العهدة تُرى (لا تعتمد على الحساب)، وما يعتمد على الحساب لا يُستعلَم أصلاً.
    expect(c.items.map((i) => i.key)).toEqual(["ASSET_CUSTODY"]);
  });

  it("بنودٌ متعدّدة تُجمَع معاً — الصورة الكاملة في نداءٍ واحد لا ستّ شاشات", async () => {
    await db().insert(s.shifts).values({
      branchId: 1, userId: 2, openingBalance: "0.00", status: "OPEN", openedAt: new Date(),
    });
    await db().insert(s.employeeAdvances).values({
      employeeId: 10, branchId: 1, amount: "100000.00", remaining: "100000.00", status: "ACTIVE", createdBy: 1,
    });
    await db().insert(s.userSessions).values({
      userId: 2, sid: "live-2", fingerprint: "fp", expiresAt: new Date(Date.now() + 3_600_000),
    });
    const c = await getEmployeeClearance(10);
    expect(c.items.map((i) => i.key).sort()).toEqual(
      ["ACTIVE_SESSIONS", "OPEN_SHIFT", "OUTSTANDING_ADVANCE"].sort(),
    );
    expect(c.blockingCount).toBe(2);
    expect(c.clearedToExit).toBe(false);
  });
});
