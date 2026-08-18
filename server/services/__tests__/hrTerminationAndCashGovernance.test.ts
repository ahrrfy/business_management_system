// حوكمة الفصل والنقد في الموارد البشرية — سدّ ثلاث ثغرات استخراج/وصول بفاعلٍ واحد.
//
// الثوابت المحروسة:
//   ط١) إنهاء الخدمة يُعطّل حساب النظام المرتبط ويُبطل جلساته فوراً (كان المفصول يدخل من الغد).
//   ط٢) إنهاء الخدمة يُحرّر ربط جهاز الحضور (رقم الجهاز يُعاد استعماله ⇒ بصمات الموظف
//       الجديد كانت تُنسب للمفصول)، ويُبقي صفّ المرآة ورقمه (تاريخ لا يُمحى).
//   ط٣) لا يُقفَل النظام على نفسه: آخر مدير نشط، ومَن ينهي خدمة سجلّه الشخصيّ.
//   ط٤) لا تُلغى سلفة وسند صرفها سارٍ — إلغاؤها وحده يمحو التزام السداد والنقد بالخارج.
//   ط٥) لا يمنح المستخدم سلفةً لنفسه (المانح ≠ المستفيد).
//   ط٦) سقف تراكميّ على غير المسدَّد — تقسيم السلف لا يلتفّ على عتبة الاعتماد الثنائي.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelAdvance, grantAdvance } from "../advancesService";
import { setEmploymentStatus } from "../employeeService";
import { approveVoucher } from "../voucher/approval";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const ADMIN = { userId: 1, branchId: 1, role: "admin" };
const HR = { userId: 2, branchId: 1, role: "manager" };

beforeEach(async () => {
  await truncateTables([
    "advanceSettlements",
    "employeeAdvances",
    "idempotencyKeys",
    "receipts",
    "hrDeviceUsers",
    "hrAttendancePunches",
    "hrFingerprintDevices",
    "attendance",
    "employees",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  // sessionsValidFrom قديم صراحةً: القيمة الافتراضية «الآن» تساوي لحظة الفصل بدقّة الثانية
  // فلا يُثبت الفرق شيئاً — الثابت المقصود هو أن الفصل **يدفعها للأمام** فيُبطل الجلسات.
  const OLD_VALID_FROM = new Date("2026-01-01T00:00:00Z");
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "المدير", role: "admin", loginMethod: "local", isActive: true },
    // مديرٌ ثانٍ نشط كي لا يصطدم الفصل بحارس «آخر مدير».
    { id: 9, openId: "b", name: "مدير احتياط", role: "admin", loginMethod: "local", isActive: true, isOwner: true },
    { id: 2, openId: "c", name: "كاشير", role: "cashier", loginMethod: "local", isActive: true, sessionsValidFrom: OLD_VALID_FROM },
  ]);
  await d.insert(s.employees).values([
    { id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", employmentStatus: "active", isActive: true, branchId: 1, userId: 2, hireDate: "2026-01-01" },
    { id: 2, firstName: "زينب", lastName: "الربيعي", payType: "monthly", salary: "800000", employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2026-01-01" },
  ]);
  await d.insert(s.receipts).values({
    branchId: 1,
    direction: "IN",
    amount: "10000000",
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 9,
  });
  await d.insert(s.hrFingerprintDevices).values({ id: 10, name: "جهاز الرئيسي", serialNumber: "SNTERM1", protocol: "AIFACE_WS", enabled: true, branchId: 1 });
  await d.insert(s.hrDeviceUsers).values({ deviceId: 10, enrollId: 7, name: "احمد", employeeId: 1, effectiveFrom: "2026-01-01" });
});

async function grantAndApprove(input: Parameters<typeof grantAdvance>[0]) {
  const pending = await grantAdvance(input, ADMIN as never);
  expect(pending.status).toBe("PENDING_APPROVAL");
  await approveVoucher(Number(pending.receiptId), { userId: 9, branchId: 1, role: "admin" });
  const [active] = await db().select().from(s.employeeAdvances)
    .where(eq(s.employeeAdvances.receiptId, Number(pending.receiptId)));
  return active!;
}

describe("حوكمة إنهاء الخدمة", () => {
  it("ط١+ط٢) الفصل يُعطّل الحساب ويُبطل جلساته ويَحدُّ ربط الجهاز بيوم الإنهاء", async () => {
    const before = (await db().select().from(s.users).where(eq(s.users.id, 2)))[0];
    const beforeValidFrom = new Date(before.sessionsValidFrom as unknown as string).getTime();

    const r = await setEmploymentStatus(1, "terminated", { terminationDate: "2026-07-31", actorUserId: 1 });

    expect(r.userDisabled).toBe(true);
    expect(r.deviceLinksReleased).toBe(1);

    const [u] = await db().select().from(s.users).where(eq(s.users.id, 2));
    expect(u.isActive).toBe(false);
    // إبطال الجلسات القائمة فوراً — الختم يُدفَع للأمام فتسقط كل كوكيّة أقدم منه.
    expect(new Date(u.sessionsValidFrom as unknown as string).getTime()).toBeGreaterThan(beforeValidFrom);

    /*
     * ⚠️ **تُحدِّث هذه التوقّعات عمداً** (0207، بند ٢١). كانت تُثبّت `employeeId=null` —
     * وهي آليّةُ العطب نفسها: القطعُ الفوريّ يقع يومَ العمل الأخير فتصل بصماتُ ذلك اليوم بلا
     * صاحبٍ ويُسجَّل صفر ساعات. والسلوكُ الذي كانت تحرسه حقاً («لا تُنسب بصماتُ الرقم للمفصول
     * بعد مغادرته») محفوظٌ بالحدّ، ويحرسه الاختبار التالي (ط٢) صراحةً.
     */
    const [link] = await db().select().from(s.hrDeviceUsers).where(eq(s.hrDeviceUsers.deviceId, 10));
    expect(link.enrollId).toBe(7);
    expect(link.name).toBe("احمد");
    expect(Number(link.employeeId)).toBe(1); // الربط باقٍ — لا يُقطع
    expect(String(link.effectiveTo)).toBe("2026-07-31"); // محدودٌ بيوم الإنهاء
    expect(link.effectiveFrom).not.toBeNull(); // حدّ المباشرة لم يُمسّ
  });

  it("ط٢أ) بصمةُ **يوم الإنهاء نفسه** تُنسَب — وهي التي كانت تضيع (بند ٢١)", async () => {
    await setEmploymentStatus(1, "terminated", { terminationDate: "2026-07-31", actorUserId: 1 });
    const { ingestPunches } = await import("../hrDevices/punchStore");
    await ingestPunches({ id: 10, serialNumber: "SNTERM1" } as never, [
      { enrollId: 7, punchAt: "2026-07-31 16:00:00", mode: "face", inOut: null, raw: null },
    ]);
    const [p] = await db().select().from(s.hrAttendancePunches).where(eq(s.hrAttendancePunches.enrollId, 7));
    expect(Number(p.employeeId)).toBe(1); // قبل 0207 كانت null ⇒ يومُ عملٍ بصفر ساعات
  });

  it("ط٢) بعد الفصل لا تُنسب بصمات الرقم نفسه لأحد (يُعاد استعماله لموظف جديد)", async () => {
    await setEmploymentStatus(1, "terminated", { terminationDate: "2026-07-31", actorUserId: 1 });
    const { ingestPunches } = await import("../hrDevices/punchStore");
    await ingestPunches({ id: 10, serialNumber: "SNTERM1" } as never, [
      { enrollId: 7, punchAt: "2026-08-05 08:00:00", mode: "face", inOut: null, raw: null },
    ]);
    const [p] = await db().select().from(s.hrAttendancePunches).where(eq(s.hrAttendancePunches.enrollId, 7));
    expect(p.employeeId).toBeNull(); // طابور مراجعة، لا إسناد للمفصول
  });

  it("ط٣) لا يُنهي المستخدم خدمة سجلّه الشخصيّ (كان يُعطّل حسابه ويطرد نفسه)", async () => {
    await expect(setEmploymentStatus(1, "terminated", { actorUserId: 2 })).rejects.toThrow(/سجلّك الشخصيّ/);
    // ولا شيء تغيّر — المعاملة رجعت كاملةً.
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(e.employmentStatus).toBe("active");
    const [u] = await db().select().from(s.users).where(eq(s.users.id, 2));
    expect(u.isActive).toBe(true);
  });

  it("ط٣) آخر مدير نشط لا يُعطَّل بالفصل", async () => {
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 9));
    await db().update(s.employees).set({ userId: 1 }).where(eq(s.employees.id, 2));
    await db().update(s.employees).set({ userId: null }).where(eq(s.employees.id, 1));

    await expect(
      setEmploymentStatus(2, "terminated", { actorUserId: 9, actorRole: "admin" }),
    ).rejects.toThrow(/آخر مدير/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 2));
    expect(e.employmentStatus).toBe("active");
  });

  it("ط٣) غير المدير لا يعطّل مديراً عبر تغيير حالة الموظف", async () => {
    await db().update(s.employees).set({ userId: 1 }).where(eq(s.employees.id, 2));

    await expect(
      setEmploymentStatus(2, "terminated", { actorUserId: 2, actorRole: "manager" }),
    ).rejects.toThrow(/غير المدير أو المالك/);

    const [employee] = await db().select().from(s.employees).where(eq(s.employees.id, 2));
    const [admin] = await db().select().from(s.users).where(eq(s.users.id, 1));
    expect(employee.employmentStatus).toBe("active");
    expect(admin.isActive).toBe(true);
  });

  it("ط٣) غير المالك لا يعطّل مالكاً عبر تغيير حالة الموظف", async () => {
    await db().update(s.users).set({ isOwner: true }).where(eq(s.users.id, 1));
    await db().update(s.employees).set({ userId: 1 }).where(eq(s.employees.id, 2));

    await expect(
      setEmploymentStatus(2, "terminated", { actorUserId: 9, actorRole: "admin" }),
    ).rejects.toThrow(/غير المالك/);

    const [employee] = await db().select().from(s.employees).where(eq(s.employees.id, 2));
    const [owner] = await db().select().from(s.users).where(eq(s.users.id, 1));
    expect(employee.employmentStatus).toBe("active");
    expect(owner.isActive).toBe(true);
  });

  it("الحالات غير النهائية لا تمسّ الحساب ولا الربط", async () => {
    const r = await setEmploymentStatus(1, "leave", { actorUserId: 1 });
    expect(r.userDisabled).toBe(false);
    expect(r.deviceLinksReleased).toBe(0);
    const [u] = await db().select().from(s.users).where(eq(s.users.id, 2));
    expect(u.isActive).toBe(true);
    const [link] = await db().select().from(s.hrDeviceUsers).where(eq(s.hrDeviceUsers.deviceId, 10));
    expect(link.employeeId).toBe(1);
  });
});

describe("حوكمة نقد السلف", () => {
  it("ط٥) لا يمنح المستخدم سلفةً لنفسه", async () => {
    // الموظف ١ مربوط بالمستخدم ٢ ⇒ المستخدم ٢ لا يمنحه.
    await expect(
      grantAdvance({ employeeId: 1, branchId: 1, amount: "100000", clientRequestId: "self-1" }, HR as never),
    ).rejects.toThrow(/لنفسك/);
    const rows = await db().select().from(s.employeeAdvances);
    expect(rows).toHaveLength(0); // ولا سند صرف ولا صفّ سلفة
  });

  it("ط٤) لا تُلغى سلفة وسند صرفها سارٍ — والإلغاء يمرّ بعد عكس السند", async () => {
    const adv = await grantAndApprove(
      { employeeId: 2, branchId: 1, amount: "100000", clientRequestId: "adv-1" },
    );
    expect(adv.receiptId).toBeTruthy();

    await expect(cancelAdvance({ advanceId: Number(adv.id) }, ADMIN as never)).rejects.toThrow(/سند صرفها ما زال سارياً/);
    const [still] = await db().select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, Number(adv.id)));
    expect(still.status).toBe("ACTIVE"); // الالتزام لم يسقط

    // بعد عكس السند (يتمّ من شاشة السندات بفصل مهامها) يُقبل الإلغاء.
    await db().update(s.receipts).set({ status: "REVERSED" }).where(eq(s.receipts.id, Number(adv.receiptId)));
    const res = await cancelAdvance({ advanceId: Number(adv.id) }, ADMIN as never);
    expect(res.status).toBe("CANCELLED");
  });

  it("ط٦) السقف التراكميّ يمنع تقسيم السلف للالتفاف على عتبة الاعتماد", async () => {
    // هجوم التقسيم الواقعيّ: مبالغ صغيرة متتالية تصل إلى ٨٠٠ ألف، ثم طلب يجعل
    // الإجمالي يتجاوز سقف المليون بدينار واحد. الوصول إلى السقف نفسه مسموح؛ تجاوزه مرفوض.
    for (let i = 1; i <= 4; i++) {
      await grantAndApprove({ employeeId: 2, branchId: 1, amount: "200000", clientRequestId: `acc-${i}` });
    }
    const fifth = await grantAdvance(
      { employeeId: 2, branchId: 1, amount: "200001", clientRequestId: "acc-5" },
      ADMIN as never,
    );
    await expect(
      approveVoucher(Number(fifth.receiptId), { userId: 9, branchId: 1, role: "admin" }),
    ).rejects.toThrow(/غير المسدَّدة/);
    const [stillPending] = await db().select().from(s.receipts)
      .where(eq(s.receipts.id, Number(fifth.receiptId)));
    expect(stillPending).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL" });
    const rows = await db().select().from(s.employeeAdvances);
    expect(rows).toHaveLength(4);
  });
});
