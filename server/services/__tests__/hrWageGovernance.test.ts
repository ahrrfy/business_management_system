// حوكمة الأجر — إغلاق مسارَي رفع الأجر بفاعلٍ واحد.
//
// الثوابت المحروسة:
//   ل١) الأجر لا يُغيَّر من شاشة تعديل الموظف لغير المدير — مسار الترقيات وحده
//       (يفرض معتمِداً ثانياً وتاريخ سريان وسجلّاً تاريخياً).
//   ل٢) المدير (admin) يُغيّره، والتغيير يُعيد قيمتَيه قبل/بعد ليُسجَّلا في التدقيق
//       (كان السجلّ يقول «employee.update — الاسم» فقط ⇒ قفزةُ الرواتب بلا تفسير).
//   ل٣) التعديل بلا مسّ الأجر يمرّ لغير المدير كما كان (صفر انحدار).
//   ل٤) لا يسجّل أحدٌ ساعات نفسه يدوياً — الساعات تتحوّل أجراً مباشرةً.
//   ل٥) الطيّ التلقائي من الجهاز لا فاعل بشريّ له فلا يتأثّر بالحارس.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { updateEmployee } from "../employeeService";
import { recordAttendance } from "../attendanceService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const MANAGER = { userId: 2, role: "manager" };
const ADMIN = { userId: 1, role: "admin" };

/** حمولة تعديل كاملة (النموذج يرسل كل الحقول دائماً). */
function payload(over: Record<string, unknown> = {}) {
  return {
    firstName: "أحمد", lastName: "الجبوري", payType: "monthly" as const,
    salary: "900000", allowances: "50000", phone: "07700000001",
    ...over,
  };
}

beforeEach(async () => {
  await truncateTables(["attendance", "employees", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "b", name: "مدير فرع", role: "manager", loginMethod: "local" },
  ]);
  await d.insert(s.employees).values([
    // الموظف ١ مربوط بحساب المدير نفسه (مسار المنح الذاتي).
    { id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "50000", employmentStatus: "active", isActive: true, branchId: 1, userId: 2, hireDate: "2026-01-01" },
    { id: 2, firstName: "زينب", lastName: "الربيعي", payType: "hourly", dayRates: { الأحد: 5000, الاثنين: 5000, الثلاثاء: 5000, الأربعاء: 5000, الخميس: 5000, الجمعة: 7500, السبت: 5000 }, employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2026-01-01" },
  ]);
});

describe("تغيير الأجر (ل١–ل٣)", () => {
  it("ل١) المدير غير الأدمن لا يرفع الراتب من شاشة الموظف", async () => {
    await expect(updateEmployee(1, payload({ salary: "1400000" }) as never, MANAGER)).rejects.toThrow(/الترقيات/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("900000.00"); // لم يتغيّر
  });

  it("ل١) والبدلات كذلك (بابُ التفافٍ ثانٍ على الوعاء)", async () => {
    await expect(updateEmployee(1, payload({ allowances: "500000" }) as never, MANAGER)).rejects.toThrow(/الترقيات/);
  });

  it("ل٢) الأدمن يُغيّره، والتغيير يُعيد قيمتَيه للتدقيق", async () => {
    const r = await updateEmployee(1, payload({ salary: "1400000" }) as never, ADMIN);
    expect(r.salaryChange).toBeTruthy();
    expect(String(r.salaryChange!.fromSalary)).toBe("900000.00");
    expect(String(r.salaryChange!.toSalary)).toBe("1400000.00");
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("1400000.00");
  });

  it("ل٣) تعديل بلا مسّ الأجر يمرّ لغير الأدمن ولا يُعلَّم كتغيير أجر", async () => {
    const r = await updateEmployee(1, payload({ phone: "07709999999" }) as never, MANAGER);
    expect(r.salaryChange).toBeNull();
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(e.phone).toBe("07709999999");
    expect(String(e.salary)).toBe("900000.00");
  });

  it("بلا actor (مسارات داخلية) لا يُفرض الحارس — سلوك محفوظ", async () => {
    const r = await updateEmployee(1, payload({ salary: "1000000" }) as never);
    expect(String(r.salaryChange!.toSalary)).toBe("1000000.00");
  });
});

describe("تسجيل الحضور اليدوي (ل٤–ل٥)", () => {
  it("ل٤) لا يسجّل المستخدم ساعات نفسه", async () => {
    await expect(
      recordAttendance({ employeeId: 1, attendanceDate: "2026-07-15", hours: "12", source: "manual", actor: MANAGER }),
    ).rejects.toThrow(/حضور نفسك/);
    const rows = await db().select().from(s.attendance);
    expect(rows).toHaveLength(0);
  });

  it("ل٤) ويسجّل لغيره بلا اعتراض", async () => {
    await recordAttendance({ employeeId: 2, attendanceDate: "2026-07-15", hours: "8", source: "manual", actor: MANAGER });
    const [row] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 2));
    expect(String(row.hours)).toBe("8.00");
  });

  it("ل٤) الأدمن مُستثنى للتصحيح الإداري", async () => {
    await db().update(s.employees).set({ userId: 1 }).where(eq(s.employees.id, 2));
    await recordAttendance({ employeeId: 2, attendanceDate: "2026-07-16", hours: "8", source: "manual", actor: ADMIN });
    const [row] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 2));
    expect(String(row.hours)).toBe("8.00");
  });

  it("ل٥) الطيّ التلقائي (بلا actor) لا يتأثّر", async () => {
    await recordAttendance({ employeeId: 1, attendanceDate: "2026-07-17", hours: "8", source: "fingerprint" });
    const [row] = await db().select().from(s.attendance).where(eq(s.attendance.employeeId, 1));
    expect(row.source).toBe("fingerprint");
  });
});
