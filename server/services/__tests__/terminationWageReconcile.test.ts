/**
 * مطابقةُ أجر الشهر الأخير في تسوية نهاية الخدمة بمحرّك الحضور (تدقيق ١٧/٨، بند ٤٣).
 *
 * العطب: `earnedGrossWages` مُدخَلٌ يدويّ محض بلا أيّ مقارنة — والمسيّر يعتمده «تغطيةً»
 * (`encodeTerminationWageCoverage`) فلا يدفع الشهر مرّتين. أي أن رقماً مكتوباً بالغلط يصير
 * **الأجر النهائيّ** بلا اعتراض، وهو نقيض قرارات الحضور الثلاثة (المحرّك مرجعُ الأجر).
 *
 * الثوابت المحروسة:
 *   م١) رقمٌ مطابقٌ لاشتقاق المحرّك يمرّ بلا سبب — وهو **أيضاً** إثباتُ القصّ: البذرة تغطّي
 *       الشهر كلَّه، فلولا قصُّ الخدمة عند يوم الإنهاء لاشتقّت شهراً تامّاً ورفضت المطابق.
 *   م٢) انحرافٌ فوق العتبة بلا سبب ⇒ يُرفض، والرسالة تُسمّي الرقمين والفارق.
 *   م٣) نفس الانحراف **مع سبب** ⇒ يمرّ، والسبب يُكتب في مستند الإثبات (أثرٌ لا يضيع).
 *   م٤) إنهاءٌ مخطَّطٌ في المستقبل ⇒ **لا يُلزم** (بصمات الأيام الباقية لم تصل، فالاشتقاق
 *       ناقصٌ بطبيعته) — لكنّ الفارق يُكتب في المستند فيُراجَع لاحقاً.
 *   م٥) الحدُّ الصريح يقصّ النافذة: أجرُ جزءٍ من شهر لا أجرُ شهرٍ تامّ (بدونه انحرافٌ كاذب
 *       في كل تسويةٍ منتصفَ الشهر).
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createTermination } from "../promotionService";
import { getEmployeeStatement } from "../hr/employeeStatement";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const ACTOR = { userId: 1, branchId: 1, role: "admin", isOwner: true } as never;
const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const LAST_DAY = "2026-06-15";
/**
 * البذرة تغطّي **الشهر كلَّه** لا حتى يوم الإنهاء — وهذا شرطُ صحّةِ الاختبار لا تفصيلَ إعداد:
 * القصُّ يستبعد أياماً **حضرها** الموظف بعد الحدّ؛ فإن لم تُبذر أيامٌ بعد الخامس عشر تساوى
 * المقصوصُ والكاملُ (الغياب أجرُه صفر) وصار «م٥» يقارن الرقم بنفسه فيمرّ بلا أن يُثبت شيئاً.
 */
const MONTH_END = "2026-06-30";

/** حضورٌ كامل من ١ حزيران حتى يومٍ محدَّد (الجمعة راحة). */
async function seedAttendanceThrough(employeeId: number, through: string) {
  const rows: Array<typeof s.attendance.$inferInsert> = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    if (date > through) break;
    if (DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] === "الجمعة") continue;
    rows.push({
      employeeId, attendanceDate: date, status: "PRESENT",
      checkIn: new Date(`${date}T08:00:00Z`), checkOut: new Date(`${date}T16:00:00Z`),
      hours: "8.00", hourlyRate: "0.00", amount: "0.00", source: "fingerprint",
    });
  }
  if (rows.length) await db().insert(s.attendance).values(rows);
}

const base = (over: Record<string, unknown> = {}) => ({
  employeeId: 1,
  terminationType: "استقالة",
  lastDay: LAST_DAY,
  settlementEvidenceNote: "مراجعة الموارد البشرية رقم ١٢٣",
  zeroAmountsAttested: true as const,
  ...over,
});

beforeEach(async () => {
  await truncateTables([
    "employeeTerminations", "attendance", "hrAttendanceSettings", "employees", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.employees).values({
    id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "0",
    employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2025-01-01",
  });
  await d.insert(s.hrAttendanceSettings).values({ id: 1, attendancePayEnabled: true, attendancePayFrom: "2026-01-01" });
  await seedAttendanceThrough(1, MONTH_END);
});

/** ما يقوله المحرّك — مصدرُ التوقّع نفسه الذي يستعمله الخادم، لا رقمٌ مكتوبٌ بيدي. */
async function engineWage(): Promise<string> {
  const st = await getEmployeeStatement({ employeeId: 1, period: "2026-06", employmentEndOverride: LAST_DAY });
  return st!.expectedEarnedGrossWages;
}

async function evidenceOf(id: number) {
  const [row] = await db()
    .select({ note: s.employeeTerminations.settlementEvidenceNote })
    .from(s.employeeTerminations)
    .where(eq(s.employeeTerminations.id, id));
  return String(row.note);
}

describe("مطابقة أجر نهاية الخدمة بسجلّ الحضور", () => {
  it("م٥) الحدُّ الصريح يقصّ النافذة — أجرُ نصف شهرٍ لا شهرٍ تامّ", async () => {
    // شرطُ صحّة المقارنة أولاً: لا بدّ من أيام حضورٍ **بعد** يوم الإنهاء ليكون للقصّ ما يقصّه.
    // بدونها يتساوى الطرفان بحقٍّ (الغياب أجرُه صفر) فيمرّ الاختبار بلا أن يُثبت القصّ.
    const [{ after }] = await db()
      .select({ after: sql<number>`count(*)` })
      .from(s.attendance)
      .where(and(eq(s.attendance.employeeId, 1), gt(s.attendance.attendanceDate, LAST_DAY)));
    expect(Number(after)).toBeGreaterThan(0);

    const half = Number(await engineWage());
    const full = Number(
      (await getEmployeeStatement({ employeeId: 1, period: "2026-06" }))!.expectedEarnedGrossWages,
    );
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full); // بلا الحدّ لَقُورن نصفُ شهرٍ بشهرٍ تامّ ⇒ انحرافٌ كاذب
  });

  it("م١) رقمٌ مطابقٌ يمرّ بلا سبب", async () => {
    const t = await createTermination(
      base({ breakdown: { earnedGrossWages: await engineWage() } }) as never,
      ACTOR,
    );
    expect(t).toBeTruthy();
  });

  it("م٢) انحرافٌ فوق العتبة بلا سبب ⇒ يُرفض، والرسالة تُسمّي الرقمين", async () => {
    const wrong = (Number(await engineWage()) + 250_000).toFixed(2);
    await expect(
      createTermination(base({ breakdown: { earnedGrossWages: wrong } }) as never, ACTOR),
    ).rejects.toThrow(/سجلّ الحضور|فارق/);
  });

  it("م٣) نفس الانحراف مع سببٍ صريح ⇒ يمرّ، والسبب يُكتب في مستند الإثبات", async () => {
    const wrong = (Number(await engineWage()) + 250_000).toFixed(2);
    const t = await createTermination(
      base({
        breakdown: { earnedGrossWages: wrong },
        wageDivergenceReason: "بدل إجازةٍ متراكمة غير مسجّل في الحضور",
      }) as never,
      ACTOR,
    );
    const note = await evidenceOf(Number((t as { id: number }).id));
    expect(note).toContain("مطابقة الحضور");
    expect(note).toContain("بدل إجازةٍ متراكمة");
  });

  it("م٤) إنهاءٌ مخطَّطٌ مستقبلاً لا يُلزم — لكنّ الفارق يُكتب في المستند", async () => {
    const future = "2099-06-15";
    const t = await createTermination(
      base({ lastDay: future, breakdown: { earnedGrossWages: "5000000" } }) as never,
      ACTOR,
    );
    const note = await evidenceOf(Number((t as { id: number }).id));
    expect(note).toContain("إنهاءٌ مخطَّط");
  });
});
