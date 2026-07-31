// حوكمة ربط الموظف بجهاز الحضور (0136) — الحدّ الزمنيّ للربط + التقابل الأحاديّ لكل جهاز.
//
// السياق: الجهاز لا يرسل هويةً بل رقماً داخلياً (enrollId) يُحلّ إلى موظف عبر hrDeviceUsers.
// وأرقام الأجهزة **تُعاد استعمالها**: رقمٌ يخصّ اليوم موظفاً جديداً قد يحمل في ذاكرة الجهاز
// (عشرات آلاف السجلات) حضورَ موظفٍ سابق. سحب التاريخ (getalllog) بلا حدٍّ كان ينسبه للاحق
// فيتحوّل إلى أيام حضور ويدخل مسيّر رواتبه.
//
// الثوابت المحروسة:
//   ح١) الاستلام يحترم السريان: بصمة أقدم من effectiveFrom تُخزَّن بلا موظف (طابور مراجعة، لا تُرمى).
//   ح٢) الإلحاق الرجعيّ محدود: mapUser لا يطالب إلا بالبصمات من تاريخ السريان فصاعداً.
//   ح٣) الحدّ الافتراضيّ لا يُسقط بصمةً مشروعة: ما بعد تاريخ المباشرة يُنسب كاملاً.
//   ح٤) فكّ الربط يمسح السريان — وإلا حكم حدٌّ قديم ربطاً لاحقاً بموظف آخر بصمت.
//   ح٥) تقابل أحاديّ لكل جهاز: رقمان لموظفٍ واحد على الجهاز نفسه مرفوضان بنيوياً
//       (كانا يُنتجان يومَي حضور منفصلين لنفس الشخص فتتضاعف ساعاته في الراتب)،
//       بينما جهازان لموظفٍ واحد (فرعان) مسموحان.
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { ingestPunches, mapDeviceUserToEmployee } from "../hrDevices/punchStore";
import { isDupEntry, toArabicMessage } from "@shared/errorMap.ar";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const SN = "ZXRBLINK0001";
const SN2 = "ZXRBLINK0002";
const DEVICE = { id: 10, serialNumber: SN } as const;

/** بصمة خام بالشكل الذي يسلّمه السائق (توقيت حائط نصّي من ساعة الجهاز). */
function punch(enrollId: number, punchAt: string) {
  return { enrollId, punchAt, mode: "face", inOut: null, raw: null };
}

async function punchRows(enrollId: number) {
  return db()
    .select({ punchAt: s.hrAttendancePunches.punchAt, employeeId: s.hrAttendancePunches.employeeId })
    .from(s.hrAttendancePunches)
    .where(eq(s.hrAttendancePunches.enrollId, enrollId))
    .orderBy(s.hrAttendancePunches.punchAt);
}

beforeEach(async () => {
  await truncateTables([
    "hrDeviceCommands",
    "hrAttendancePunches",
    "hrDeviceUsers",
    "hrFingerprintDevices",
    "attendance",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    // الموظف الحالي: باشر ٢٠٢٦-٠٣-٠١ — كل ما قبله في ذاكرة الجهاز ليس له.
    { id: 1, firstName: "أحمد", fatherName: "علي", lastName: "الجبوري", payType: "hourly", employmentStatus: "active", hireDate: "2026-03-01" },
    { id: 2, firstName: "زينب", fatherName: "حسن", lastName: "الربيعي", payType: "hourly", employmentStatus: "active", hireDate: "2026-01-01" },
  ]);
  await d.insert(s.hrFingerprintDevices).values([
    { id: 10, name: "جهاز الرئيسي", serialNumber: SN, protocol: "AIFACE_WS", enabled: true, branchId: 1 },
    { id: 11, name: "جهاز المبيعات", serialNumber: SN2, protocol: "AIFACE_WS", enabled: true, branchId: 2 },
  ]);
});

describe("حوكمة ربط الموظف بجهاز الحضور (0136)", () => {
  it("ح١) الاستلام يحترم سريان الربط: الأقدم من التاريخ يُخزَّن بلا موظف والأحدث يُنسب", async () => {
    await db().insert(s.hrDeviceUsers).values({ deviceId: 10, enrollId: 7, employeeId: 1, effectiveFrom: "2026-03-01" });

    await ingestPunches(DEVICE as never, [
      punch(7, "2026-02-20 08:00:00"), // موظف سابق حمل الرقم نفسه
      punch(7, "2026-02-28 23:59:59"), // اليوم السابق مباشرةً للمباشرة — حدّ حادّ
      punch(7, "2026-03-01 08:00:00"), // أول يوم مباشرة — يُنسب
      punch(7, "2026-05-10 08:00:00"),
    ]);

    const rows = await punchRows(7);
    expect(rows).toHaveLength(4); // لا بصمة تُرمى — الأقدم تنتظر في طابور المراجعة
    expect(rows.map((r) => r.employeeId)).toEqual([null, null, 1, 1]);
  });

  it("ح٢) الإلحاق الرجعيّ محدود بالسريان: البصمات القديمة تبقى بلا موظف بعد الربط", async () => {
    // بصمات وصلت قبل الربط (سحب تاريخ الجهاز) — كلها بلا موظف.
    await ingestPunches(DEVICE as never, [
      punch(7, "2025-11-05 08:00:00"),
      punch(7, "2026-02-10 08:00:00"),
      punch(7, "2026-03-05 08:00:00"),
      punch(7, "2026-04-02 08:00:00"),
    ]);
    expect((await punchRows(7)).every((r) => r.employeeId == null)).toBe(true);

    const backfilled = await mapDeviceUserToEmployee(10, 7, 1, "2026-03-01");

    expect(backfilled).toBe(2); // الاثنتان بعد المباشرة فقط
    const rows = await punchRows(7);
    expect(rows.map((r) => r.employeeId)).toEqual([null, null, 1, 1]);

    // السريان مخزَّن ⇒ الدفعات اللاحقة تحترمه أيضاً (لا حدّ في الذاكرة فقط).
    const [link] = await db()
      .select({ effectiveFrom: s.hrDeviceUsers.effectiveFrom })
      .from(s.hrDeviceUsers)
      .where(and(eq(s.hrDeviceUsers.deviceId, 10), eq(s.hrDeviceUsers.enrollId, 7)));
    expect(link.effectiveFrom).toBe("2026-03-01");
  });

  it("ح٣) بلا حدّ (null) يُلحق كل التاريخ — السلوك القديم يبقى متاحاً صراحةً", async () => {
    await ingestPunches(DEVICE as never, [punch(9, "2024-01-01 08:00:00"), punch(9, "2026-06-01 08:00:00")]);

    const backfilled = await mapDeviceUserToEmployee(10, 9, 2, null);

    expect(backfilled).toBe(2);
    expect((await punchRows(9)).every((r) => r.employeeId === 2)).toBe(true);
  });

  it("ح٤) فكّ الربط يُصفّر الموظف والسريان معاً (لا حدّ قديم يحكم ربطاً لاحقاً)", async () => {
    await mapDeviceUserToEmployee(10, 7, 1, "2026-03-01");
    await mapDeviceUserToEmployee(10, 7, null);

    const [link] = await db()
      .select({ employeeId: s.hrDeviceUsers.employeeId, effectiveFrom: s.hrDeviceUsers.effectiveFrom })
      .from(s.hrDeviceUsers)
      .where(and(eq(s.hrDeviceUsers.deviceId, 10), eq(s.hrDeviceUsers.enrollId, 7)));
    expect(link.employeeId).toBeNull();
    expect(link.effectiveFrom).toBeNull();

    // وبعد فكّ الربط لا تُنسب البصمات الجديدة لأحد.
    await ingestPunches(DEVICE as never, [punch(7, "2026-07-01 08:00:00")]);
    const [row] = await punchRows(7);
    expect(row.employeeId).toBeNull();
  });

  it("ح٥) تقابل أحاديّ: رقمان لموظفٍ واحد على الجهاز نفسه مرفوضان، وجهازان مسموحان", async () => {
    await mapDeviceUserToEmployee(10, 7, 1, "2026-03-01");

    // نفس الموظف برقم آخر على الجهاز نفسه ⇒ يومَا حضور منفصلان وساعات مضاعفة ⇒ يُرفض بنيوياً.
    const err = await mapDeviceUserToEmployee(10, 8, 1, "2026-03-01").catch((e) => e);
    expect(isDupEntry(err)).toBe(true);
    // والرسالة تُفكَّك بالعربية عبر UNIQUE_AR بدل «قيمة مكرّرة» العامة (يراها المستخدم في الواجهة).
    expect(toArabicMessage({ cause: err })).toContain("رقمٌ واحد لكل جهاز");

    // لكن الفرع الثاني بجهازه مسموح — الموظف قد يبصم في الفرعين.
    await expect(mapDeviceUserToEmployee(11, 3, 1, "2026-03-01")).resolves.toBeTypeOf("number");
    const links = await db()
      .select({ deviceId: s.hrDeviceUsers.deviceId })
      .from(s.hrDeviceUsers)
      .where(eq(s.hrDeviceUsers.employeeId, 1));
    expect(links.map((l) => l.deviceId).sort()).toEqual([10, 11]);
  });

  it("ح٦) عدّة موظفين غير مربوطين على الجهاز نفسه لا يتصادمون (تعدّد NULL مسموح)", async () => {
    await ingestPunches(DEVICE as never, [punch(20, "2026-06-01 08:00:00"), punch(21, "2026-06-01 08:05:00")]);
    const unlinked = await db()
      .select({ enrollId: s.hrAttendancePunches.enrollId })
      .from(s.hrAttendancePunches)
      .where(isNull(s.hrAttendancePunches.employeeId));
    expect(unlinked).toHaveLength(2);

    // ومرآتا مستخدمَين غير مربوطَين تتعايشان تحت uq_devuser_device_employee.
    await db().insert(s.hrDeviceUsers).values([
      { deviceId: 10, enrollId: 20, employeeId: null },
      { deviceId: 10, enrollId: 21, employeeId: null },
    ]);
    const mirrors = await db()
      .select({ enrollId: s.hrDeviceUsers.enrollId })
      .from(s.hrDeviceUsers)
      .where(and(eq(s.hrDeviceUsers.deviceId, 10), isNull(s.hrDeviceUsers.employeeId)));
    expect(mirrors).toHaveLength(2);
  });
});
