/**
 * إنهاءُ الخدمة يَحدُّ ربطَ الجهاز ولا يقطعه (تدقيق ١٧/٨ بند ٢١ · هجرة 0204).
 *
 * كان `setEmploymentStatus('terminated')` يُصفّر `employeeId` **فوراً** أياً كان تاريخ الإنهاء،
 * وهو يقع طبيعياً يومَ العمل الأخير ⇒ بصماتُ ذلك اليوم بلا صاحبٍ فيُسجَّل صفر ساعات لليوم.
 *
 * الثوابت المحروسة (الاتجاهان):
 *   د١) الإنهاء بتاريخٍ صريح ⇒ `effectiveTo` = ذلك التاريخ، و`employeeId` **يبقى**.
 *   د٢) الإنهاء بلا تاريخ ⇒ يقع على اليوم التجاريّ ببغداد لا على `null` (ربطٌ بلا نهاية
 *       يُدخل بصماتِ وارثِ الرقم في راتب المغادر — عطب 0136 معكوساً).
 *   د٣) **إعادةُ التفعيل ترفع الحدّ** — وإلّا أُهملت بصماتُ العائد صامتةً. (هذه الحالة أُمسكت
 *       أثناء الكتابة: الدالّة تعود مبكراً قبل لمس الربط، فكان الحدُّ يبقى مضروباً.)
 *   د٤) `effectiveFrom` لا يُمسّ عند الإنهاء — حدُّ المباشرة يبقى حارساً.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { setEmploymentStatus } from "../employeeService";
import { baghdadToday } from "../businessDay";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const HIRE = "2025-01-01";

async function linkRow() {
  const [row] = await db()
    .select({ employeeId: s.hrDeviceUsers.employeeId, effectiveFrom: s.hrDeviceUsers.effectiveFrom, effectiveTo: s.hrDeviceUsers.effectiveTo })
    .from(s.hrDeviceUsers)
    .where(eq(s.hrDeviceUsers.enrollId, 7));
  return row;
}

beforeEach(async () => {
  await truncateTables(["hrAttendancePunches", "hrDeviceUsers", "hrFingerprintDevices", "employees", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values({
    id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000",
    employmentStatus: "active", isActive: true, branchId: 1, hireDate: HIRE,
  });
  await d.insert(s.hrFingerprintDevices).values({ id: 1, name: "جهاز الرئيسي", branchId: 1 });
  // رقم ٧ — نفس الرقم الذي يذكره تعليق 0136 مثالاً على إعادة الاستعمال.
  await d.insert(s.hrDeviceUsers).values({ deviceId: 1, enrollId: 7, employeeId: 1, effectiveFrom: HIRE });
});

describe("إنهاء الخدمة يَحدُّ ربطَ الجهاز ولا يقطعه", () => {
  it("د١) بتاريخٍ صريح ⇒ الحدُّ ذلك التاريخ والربط باقٍ", async () => {
    await setEmploymentStatus(1, "terminated", { terminationDate: "2026-08-17", actorUserId: 1 });
    const link = await linkRow();
    expect(Number(link.employeeId)).toBe(1); // ← جوهر الإصلاح: لم يُقطع
    expect(String(link.effectiveTo)).toBe("2026-08-17");
  });

  it("د٢) بلا تاريخ ⇒ يقع على اليوم التجاريّ ببغداد لا يبقى مفتوحاً", async () => {
    await setEmploymentStatus(1, "terminated", { actorUserId: 1 });
    const link = await linkRow();
    expect(link.effectiveTo).not.toBeNull();
    expect(String(link.effectiveTo)).toBe(baghdadToday());
  });

  it("د٣) إعادةُ التفعيل ترفع الحدّ — وإلّا أُهملت بصماتُ العائد صامتةً", async () => {
    await setEmploymentStatus(1, "terminated", { terminationDate: "2026-08-17", actorUserId: 1 });
    expect(String((await linkRow()).effectiveTo)).toBe("2026-08-17");

    await setEmploymentStatus(1, "active", { actorUserId: 1 });
    const link = await linkRow();
    expect(link.effectiveTo).toBeNull();
    expect(Number(link.employeeId)).toBe(1);
  });

  it("د٤) الإنهاء لا يمسّ حدَّ المباشرة", async () => {
    await setEmploymentStatus(1, "terminated", { terminationDate: "2026-08-17", actorUserId: 1 });
    expect(String((await linkRow()).effectiveFrom)).toBe(HIRE);
  });
});
