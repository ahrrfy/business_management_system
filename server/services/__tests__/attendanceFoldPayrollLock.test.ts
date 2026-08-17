/**
 * قفل المسيّر على مسار طيّ البصمات (تدقيق ١٧/٨) — server/services/hrDevices/attendanceFold.ts
 *
 * **العطب المحروس هنا:** `recordAttendance` يرفض الكتابة على شهرٍ مسيّرُه معتمد/مدفوع. وكان
 * الطيّ يصنّف ذلك الرفض **عابراً** (لأن التصنيف كان مطابقةَ نصوصٍ عربية لم تكن رسالةُ القفل
 * منها) ⇒ نتيجتان معاً:
 *   ١) البصمة تبقى `processedAt=NULL` و`processNote=NULL` ⇒ «بالانتظار» في شاشة الأجهزة بلا
 *      أيّ تنبيه ⇒ أجرُ يومٍ يضيع صامتاً (نقضُ §٥: «لا دينار يضيع بصمت»).
 *   ٢) `scheduleFoldRetry` يعيد المحاولة كل ١٥ ثانية **بلا نهاية**، وكلّ دورةٍ تمسح الدفعة
 *      كاملةً؛ ومع تراكم العالقات يتوقّف المسح عند سقف الدفعة فتتعطّل البصمات الجديدة.
 *
 * الثوابت المحروسة (الاتجاهان معاً — العطب لا يقع، والسليم لم ينكسر):
 *   ق١) شهرٌ مقفل ⇒ البصمة **مركونةٌ موسومة** (processedAt مضبوط + ملاحظةٌ تشرح)، لا معلَّقة.
 *   ق٢) المركونة لا تعود إلى طابور المسح ما دام الشهر مقفلاً ⇒ لا حلقة ولا تجويع.
 *   ق٣) إلغاء اعتماد المسيّر **يستأنفها تلقائياً** فيُكتب اليوم وأجره — وإلّا كانت الملاحظة
 *       وعداً كاذباً (لا مسار إعادة طيٍّ يدويّ في المستودع كلّه).
 *   ق٤) صفر انحدار: شهرٌ غير مقفل يُطوى كما كان، وقفلُ شهرٍ لا يمسّ شهراً آخر.
 *   ق٥) **عقدُ الرسائل عبر الملفّات:** التصنيف يعتمد نصوصاً ترميها `attendanceService.ts`
 *       (ملفٌّ آخر). نمرّ بالخدمة الحيّة ونؤكّد الرمز ⇒ أيّ إعادة صياغةٍ هناك تُحمّر هنا
 *       بدل أن تكسر التصنيف صامتاً كما وقع فعلاً.
 */
import { eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { recordAttendance } from "../attendanceService";
import {
  classifyFoldError,
  FOLD_ERROR_CODES,
  processPendingFolds,
} from "../hrDevices/attendanceFold";
import { ingestPunches } from "../hrDevices/punchStore";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const SN = "ZXLOCKTEST01";
/** ٢٠٢٦-٠٧-٠١ أربعاء؛ سعرُ الأربعاء في ملفّ الموظف ٥٠٠٠ ⇒ ٨.٥ ساعة = ٤٢٥٠٠. */
const LOCKED_DAY = "2026-07-01";
const LOCKED_PERIOD = "2026-07";

beforeEach(async () => {
  await truncateTables([
    "nativePushOutbox",
    "appNotifications",
    "hrAttendancePunches",
    "hrDeviceUsers",
    "hrFingerprintDevices",
    "attendance",
    "payrollItems",
    "payrollRuns",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "lock-a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    {
      id: 1,
      firstName: "أحمد",
      fatherName: "علي",
      lastName: "الجبوري",
      payType: "hourly",
      employmentStatus: "active",
      branchId: 1,
      dayRates: { الأحد: 5000, الاثنين: 5000, الثلاثاء: 5000, الأربعاء: 5000, الخميس: 5500, الجمعة: 7500, السبت: 6000 },
    },
    {
      id: 2,
      firstName: "زينب",
      fatherName: "حسن",
      lastName: "الربيعي",
      payType: "hourly",
      employmentStatus: "terminated",
      branchId: 1,
    },
  ]);
  await d.insert(s.hrFingerprintDevices).values({
    id: 10,
    name: "جهاز الرئيسي",
    serialNumber: SN,
    protocol: "AIFACE_WS",
    branchId: 1,
    enabled: true,
    migrated: true,
    ip: "127.0.0.1",
  });
  await d.insert(s.hrDeviceUsers).values({ deviceId: 10, enrollId: 7, name: "احمد جهاز", employeeId: 1 });
});

async function device() {
  const [row] = await db().select().from(s.hrFingerprintDevices).where(eq(s.hrFingerprintDevices.id, 10)).limit(1);
  return row;
}

async function approveRunFor(period: string) {
  await db().insert(s.payrollRuns).values({ period, status: "approved", branchId: 1 });
}

/** إلغاء الاعتماد كما يفعل revertRun: الشهر يعود مسودّةً ⇒ لم يعد مقفلاً. */
async function reopenRunFor(period: string) {
  await db().update(s.payrollRuns).set({ status: "draft" }).where(eq(s.payrollRuns.period, period));
}

async function punchesOfEnroll(enrollId: number) {
  return db().select().from(s.hrAttendancePunches).where(eq(s.hrAttendancePunches.enrollId, enrollId));
}

async function pendingCount() {
  const rows = await db().select().from(s.hrAttendancePunches).where(isNull(s.hrAttendancePunches.processedAt));
  return rows.length;
}

describe("الطيّ وشهرٌ مسيّرُه معتمد (ق١–ق٤)", () => {
  it("يركن البصمة موسومةً بدل تركها «بالانتظار» أبداً، ولا يعيد مسحها ما دام الشهر مقفلاً", async () => {
    await approveRunFor(LOCKED_PERIOD);
    const dev = await device();
    await ingestPunches(dev, [
      { enrollId: 7, punchAt: `${LOCKED_DAY} 08:00:00` },
      { enrollId: 7, punchAt: `${LOCKED_DAY} 16:30:00` },
    ]);

    const res = await processPendingFolds();
    // ق١: نهائيّ موسوم لا عابر مُهمَل.
    expect(res).toEqual({ days: 0, parked: 1 });
    const punches = await punchesOfEnroll(7);
    expect(punches).toHaveLength(2);
    for (const p of punches) {
      expect(p.processedAt).toBeTruthy();
      expect(p.processNote).toContain("شهر مقفل بمسيّر رواتب معتمد");
      expect(p.processNote).toContain(LOCKED_PERIOD);
      // الملاحظة تُقرأ في شاشة الأجهزة (عمود «مركونة» + title) ⇒ لا بدّ أن تدلّ على الفعل.
      expect(p.processNote).toContain("إلغاء اعتماد المسيّر");
    }
    // لا سجل حضور كُتب على شهرٍ مصروف — القفل هو الحقيقة.
    expect(await db().select().from(s.attendance)).toHaveLength(0);
    // ق١ (النصف الثاني): صفر معلَّق ⇒ لا شيء «بالانتظار» بلا تنبيه.
    expect(await pendingCount()).toBe(0);

    // ق٢: دورةٌ ثانية لا تلتقطها أصلاً ⇒ لا حلقة إعادة محاولة ولا تجويع لسقف الدفعة.
    expect(await processPendingFolds()).toEqual({ days: 0, parked: 0 });
  });

  it("إلغاء اعتماد المسيّر يستأنف المركونة تلقائياً فيُكتب اليوم وأجره (ق٣)", async () => {
    await approveRunFor(LOCKED_PERIOD);
    const dev = await device();
    await ingestPunches(dev, [
      { enrollId: 7, punchAt: `${LOCKED_DAY} 08:00:00` },
      { enrollId: 7, punchAt: `${LOCKED_DAY} 16:30:00` },
    ]);
    expect((await processPendingFolds()).parked).toBe(1);

    await reopenRunFor(LOCKED_PERIOD);
    const res = await processPendingFolds();

    expect(res.days).toBe(1);
    const [att] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(att).toBeTruthy();
    expect(String(att.hours)).toBe("8.50");
    expect(String(att.amount)).toBe("42500.00"); // ٨.٥ × ٥٠٠٠ (سعر الأربعاء من ملفّ الموظف)
    expect(att.source).toBe("fingerprint");
    // وسمُ القفل يُمحى بعد النجاح ⇒ لا يعود شرطُ الاستئناف يلتقطها (لا دوران).
    for (const p of await punchesOfEnroll(7)) {
      expect(p.processedAt).toBeTruthy();
      expect(p.processNote).toBeNull();
    }
    expect(await processPendingFolds()).toEqual({ days: 0, parked: 0 });
  });

  it("قفلُ شهرٍ لا يمنع طيّ شهرٍ آخر، والشهر غير المقفل يُطوى كما كان (ق٤ — صفر انحدار)", async () => {
    await approveRunFor(LOCKED_PERIOD);
    const dev = await device();
    await ingestPunches(dev, [
      { enrollId: 7, punchAt: `${LOCKED_DAY} 08:00:00` },
      { enrollId: 7, punchAt: `${LOCKED_DAY} 16:30:00` },
      // آب غير مقفل — ٢٠٢٦-٠٨-٠١ سبت: ٦٠٠٠ × ٦ ساعات = ٣٦٠٠٠.
      { enrollId: 7, punchAt: "2026-08-01 09:00:00" },
      { enrollId: 7, punchAt: "2026-08-01 15:00:00" },
    ]);

    const res = await processPendingFolds();
    expect(res).toEqual({ days: 1, parked: 1 });
    const rows = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(rows).toHaveLength(1);
    expect(String(rows[0].attendanceDate)).toContain("2026-08-01");
    expect(String(rows[0].hours)).toBe("6.00");
    expect(String(rows[0].amount)).toBe("36000.00");
    expect(await pendingCount()).toBe(0);
  });

  it("منتهي الخدمة يبقى مركوناً برسالته هو لا برسالة القفل (صفر انحدار في مجموعة النهائيّ)", async () => {
    await db().insert(s.hrDeviceUsers).values({ deviceId: 10, enrollId: 8, employeeId: 2 });
    const dev = await device();
    await ingestPunches(dev, [{ enrollId: 8, punchAt: `${LOCKED_DAY} 08:00:00` }]);

    expect((await processPendingFolds()).parked).toBe(1);
    const [punch] = await punchesOfEnroll(8);
    expect(punch.processedAt).toBeTruthy();
    expect(punch.processNote).toContain("منتهي الخدمة");
    expect(punch.processNote).not.toContain("شهر مقفل");
  });
});

describe("عقد رسائل attendanceService ⇄ تصنيف الطيّ (ق٥)", () => {
  it("رسالة قفل المسيّر الحيّة تُصنَّف PAYROLL_PERIOD_LOCKED", async () => {
    await approveRunFor(LOCKED_PERIOD);
    const thrown = await recordAttendance({
      employeeId: 1,
      attendanceDate: LOCKED_DAY,
      hours: 8,
      status: "PRESENT",
      source: "fingerprint",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(classifyFoldError(thrown)).toBe(FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED);
  });

  it("رسالتا «منتهي الخدمة» و«الموظف غير موجود» الحيّتان تبقيان نهائيّتين", async () => {
    const terminated = await recordAttendance({
      employeeId: 2,
      attendanceDate: LOCKED_DAY,
      hours: 8,
      status: "PRESENT",
      source: "fingerprint",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(classifyFoldError(terminated)).toBe(FOLD_ERROR_CODES.EMPLOYEE_TERMINATED);

    const missing = await recordAttendance({
      employeeId: 999_999,
      attendanceDate: LOCKED_DAY,
      hours: 8,
      status: "PRESENT",
      source: "fingerprint",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(classifyFoldError(missing)).toBe(FOLD_ERROR_CODES.EMPLOYEE_NOT_FOUND);
  });

  it("رسالة الساعات السالبة الحيّة تُصنَّف HOURS_INVALID (رفضُ شكلٍ لا عطلَ نقل)", async () => {
    const negative = await recordAttendance({
      employeeId: 1,
      attendanceDate: LOCKED_DAY,
      hours: -3,
      status: "PRESENT",
      source: "fingerprint",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(classifyFoldError(negative)).toBe(FOLD_ERROR_CODES.HOURS_INVALID);
  });

  it("العطل الحقيقيّ العابر يبقى TRANSIENT — لا يُوسَم يومٌ حيٌّ بالخطأ", () => {
    // انقطاع/قفل قاعدة: أخطاء mysql2 تحمل code مثل ER_LOCK_DEADLOCK — قبولُها رمزاً نهائياً
    // كان سيُضيّع يوماً قابلاً للنجاح بإعادة المحاولة.
    expect(classifyFoldError(Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK" }))).toBe(
      FOLD_ERROR_CODES.TRANSIENT,
    );
    expect(classifyFoldError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(
      FOLD_ERROR_CODES.TRANSIENT,
    );
    expect(classifyFoldError(new Error("connect ETIMEDOUT"))).toBe(FOLD_ERROR_CODES.TRANSIENT);
    expect(classifyFoldError(undefined)).toBe(FOLD_ERROR_CODES.TRANSIENT);
  });

  it("الرمز المُعلَن على الخطأ يتقدّم على النصّ (الطريق الذي يُغني عن المطابقة النصّية)", () => {
    // حين ترمي attendanceService خطأً مرقَّماً (تغييرٌ خارج ملكية هذا الملف) يُصنَّف برمزه
    // مهما كانت صياغته — وهو المخرج النهائيّ من هشاشة مطابقة النصّ العربيّ.
    const coded = Object.assign(new Error("أيّ صياغة جديدة كانت"), {
      foldCode: FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED,
    });
    expect(classifyFoldError(coded)).toBe(FOLD_ERROR_CODES.PAYROLL_PERIOD_LOCKED);
  });
});
