// حوكمة الأجر — إغلاق مسارات رفع الأجر بفاعلٍ واحد.
//
// الثوابت المحروسة:
//   ل١) الأجر لا يُغيَّر من شاشة تعديل الموظف لغير المدير — مسار الترقيات وحده
//       (يفرض معتمِداً ثانياً وتاريخ سريان وسجلّاً تاريخياً).
//   ل٢) المدير (admin) يُغيّره، والتغيير يُعيد بصمته قبل/بعد ليُسجَّل في التدقيق
//       (كان السجلّ يقول «employee.update — الاسم» فقط ⇒ قفزةُ الرواتب بلا تفسير).
//   ل٣) التعديل بلا مسّ الأجر يمرّ لغير المدير كما كان (صفر انحدار).
//   ل٤) لا يسجّل أحدٌ ساعات نفسه يدوياً — الساعات تتحوّل أجراً مباشرةً.
//   ل٥) الطيّ التلقائي من الجهاز لا فاعل بشريّ له فلا يتأثّر بالحارس.
//   ل٦) «الأجر» = **البصمة الأجرية** لا حقلا الراتب/البدلات وحدهما: جدول الدوام
//       (ساعاتٍ وأسعاراً)، وأسعار أيام الساعيّ، والإعفاء من الحضور، وطريقة الأجر —
//       كلُّها تُحدّد المبلغ المدفوع فعلياً بعد نموذج الأجر بالحضور (0138-0141).
//   ل٧) الحارس يقارن **القيم الفعّالة** لا الحمولة الخام: النموذج يرسل جدولاً كاملاً
//       لكل موظف حتى لو كان جدولُه NULL، فالمقارنة الخام كانت ستمنع تعديل رقم هاتف.
//   ل٨) الترقية تحمل الحزمة كاملةً (0143) فيبقى لكل تغييرٍ مسارٌ مشروع — باعتمادٍ ثانٍ.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { updateEmployee } from "../employeeService";
import { recordAttendance } from "../attendanceService";
import { applyDuePromotions, approvePromotion, createPromotion } from "../promotionService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const MANAGER = { userId: 2, role: "manager" };
const MANAGER2 = { userId: 3, role: "manager" };
const ADMIN = { userId: 1, role: "admin" };
const actorOf = (a: { userId: number; role: string }) => ({ ...a, branchId: 1 });

const DAY_RATES = { الأحد: 5000, الاثنين: 5000, الثلاثاء: 5000, الأربعاء: 5000, الخميس: 5500, الجمعة: 7500, السبت: 6000 };
/** نفس الجدول الافتراضي الذي يستعمله المسيّر (`DEFAULT_WORK_SCHEDULE`) ويرسله النموذج. */
const DEFAULT_SCHED: Record<string, { hours: number; rate: number | null }> = {
  الأحد: { hours: 8, rate: null }, الاثنين: { hours: 8, rate: null }, الثلاثاء: { hours: 8, rate: null },
  الأربعاء: { hours: 8, rate: null }, الخميس: { hours: 8, rate: null }, الجمعة: { hours: 0, rate: null },
  السبت: { hours: 8, rate: null },
};
const schedWith = (over: Record<string, { hours: number; rate?: number | null }>) => ({ ...DEFAULT_SCHED, ...over });

/** حمولة تعديل كاملة (النموذج يرسل كل الحقول دائماً). */
function payload(over: Record<string, unknown> = {}) {
  return {
    firstName: "أحمد", lastName: "الجبوري", payType: "monthly" as const,
    salary: "900000", allowances: "50000", phone: "07700000001",
    ...over,
  };
}

beforeEach(async () => {
  await truncateTables(["attendance", "employeePromotions", "employees", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "b", name: "مدير فرع", role: "manager", loginMethod: "local" },
    { id: 3, openId: "c", name: "مدير آخر", role: "manager", loginMethod: "local" },
  ]);
  await d.insert(s.employees).values([
    // الموظف ١ مربوط بحساب المدير نفسه (مسار المنح الذاتي).
    { id: 1, firstName: "أحمد", lastName: "الجبوري", payType: "monthly", salary: "900000", allowances: "50000", employmentStatus: "active", isActive: true, branchId: 1, userId: 2, hireDate: "2026-01-01", position: "محاسب" },
    { id: 2, firstName: "زينب", lastName: "الربيعي", payType: "hourly", dayRates: { ...DAY_RATES }, employmentStatus: "active", isActive: true, branchId: 1, hireDate: "2026-01-01" },
  ]);
});

describe("تغيير الأجر — الراتب والبدلات (ل١–ل٣)", () => {
  it("ل١) المدير غير الأدمن لا يرفع الراتب من شاشة الموظف", async () => {
    await expect(updateEmployee(1, payload({ salary: "1400000" }) as never, MANAGER)).rejects.toThrow(/الترقيات/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("900000.00"); // لم يتغيّر
  });

  it("ل١) والبدلات كذلك (بابُ التفافٍ ثانٍ على الوعاء)", async () => {
    await expect(updateEmployee(1, payload({ allowances: "500000" }) as never, MANAGER)).rejects.toThrow(/الترقيات/);
  });

  it("ل٢) الأدمن يُغيّره، والتغيير يُعيد بصمته للتدقيق", async () => {
    const r = await updateEmployee(1, payload({ salary: "1400000" }) as never, ADMIN);
    expect(r.wageChange).toBeTruthy();
    expect(r.wageChange!.fields).toContain("salary");
    expect(r.wageChange!.from.salary).toBe("900000.00");
    expect(r.wageChange!.to.salary).toBe("1400000.00");
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("1400000.00");
  });

  it("ل٣) تعديل بلا مسّ الأجر يمرّ لغير الأدمن ولا يُعلَّم كتغيير أجر", async () => {
    const r = await updateEmployee(1, payload({ phone: "07709999999" }) as never, MANAGER);
    expect(r.wageChange).toBeNull();
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(e.phone).toBe("07709999999");
    expect(String(e.salary)).toBe("900000.00");
  });

  it("بلا actor (مسارات داخلية) لا يُفرض الحارس — سلوك محفوظ", async () => {
    const r = await updateEmployee(1, payload({ salary: "1000000" }) as never);
    expect(r.wageChange!.to.salary).toBe("1000000.00");
  });
});

describe("تغيير الأجر — بقية الحقول الحاملة له (ل٦)", () => {
  it("ل٦) خفضُ ساعات جدول الدوام ممنوع — يرفع سعر الساعة ويُحوّل الحضور أوفر تايم بالسعر الأعلى", async () => {
    await expect(
      updateEmployee(1, payload({ workSchedule: schedWith({ الأحد: { hours: 4, rate: null } }) }) as never, MANAGER),
    ).rejects.toThrow(/الترقيات/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(e.workSchedule).toBeNull(); // لم يُكتب شيء
  });

  it("ل٦) وتثبيتُ سعر ساعةٍ صريح ممنوع — يضرب الساعات مباشرةً", async () => {
    await expect(
      updateEmployee(1, payload({ workSchedule: schedWith({ الخميس: { hours: 8, rate: 25000 } }) }) as never, MANAGER),
    ).rejects.toThrow(/الترقيات/);
  });

  it("ل٦) وأسعارُ أيام الموظف الساعيّ ممنوعة — هي أجرُه حرفياً", async () => {
    await expect(
      updateEmployee(
        2,
        payload({ firstName: "زينب", lastName: "الربيعي", payType: "hourly", salary: undefined, allowances: "0", dayRates: { ...DAY_RATES, الأحد: 20000 } }) as never,
        MANAGER,
      ),
    ).rejects.toThrow(/الترقيات/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 2));
    expect((e.dayRates as Record<string, number>).الأحد).toBe(5000);
  });

  it("ل٦) والإعفاء من الحضور ممنوع — راتبٌ كاملٌ بلا حضور", async () => {
    await expect(updateEmployee(1, payload({ attendanceExempt: true }) as never, MANAGER)).rejects.toThrow(/الترقيات/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(e.attendanceExempt).toBe(false);
  });

  it("ل٦) وتبديلُ طريقة الأجر ممنوع — يبدّل نموذج الاحتساب كلَّه", async () => {
    await expect(
      updateEmployee(1, payload({ payType: "hourly", salary: undefined, allowances: "0", dayRates: { ...DAY_RATES } }) as never, MANAGER),
    ).rejects.toThrow(/الترقيات/);
  });

  it("ل٦) والأدمن يُغيّرها ويُسمّي الحقل المتغيّر في بصمة التدقيق", async () => {
    const r = await updateEmployee(1, payload({ workSchedule: schedWith({ الأحد: { hours: 4, rate: null } }) }) as never, ADMIN);
    expect(r.wageChange!.fields).toEqual(["workSchedule"]);
    expect(r.wageChange!.to.workSchedule.الأحد).toEqual({ hours: 4, rate: null });
  });
});

describe("الحارس يقارن القيم الفعّالة لا الحمولة الخام (ل٧)", () => {
  it("ل٧) إرسالُ الجدول الافتراضي لموظفٍ جدولُه NULL ليس تغييراً — تعديلُ الهاتف يمرّ", async () => {
    const r = await updateEmployee(1, payload({ phone: "07701111111", workSchedule: DEFAULT_SCHED }) as never, MANAGER);
    expect(r.wageChange).toBeNull();
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(e.phone).toBe("07701111111");
  });

  /*
   * ل٧-ب) أسعارُ الأيام **لا** تحتاط بجدولٍ مكتوبٍ في الكود (PR #446): الساعيّ بلا سعرٍ
   * يُدفع له صفر. فلو ادّعت البصمة «٥٠٠٠» لموظفٍ سعرُه الفعليّ صفر، مرّ تعيينُ تلك القيم
   * بالضبط كـ«لا تغيير» بينما الأجر يقفز من صفرٍ إلى سعرٍ كامل — ثغرةٌ صامتة.
   */
  it("ل٧-ب) تعيينُ أسعارٍ لساعيٍّ بلا أسعارٍ مخزّنة تغييرٌ يُمنع (لا احتياط لجدول الكود)", async () => {
    await db().update(s.employees).set({ dayRates: null }).where(eq(s.employees.id, 2));
    const hourly = { firstName: "زينب", lastName: "الربيعي", payType: "hourly" as const, allowances: "0" };
    await expect(
      updateEmployee(2, { ...hourly, dayRates: { ...DAY_RATES } } as never, MANAGER),
    ).rejects.toThrow(/الترقيات/);
    // وإرسالُ أصفارٍ (وهو ما يعرضه المحرّر فعلاً) ليس تغييراً.
    const zeros = Object.fromEntries(Object.keys(DAY_RATES).map((d) => [d, 0]));
    const r = await updateEmployee(2, { ...hourly, dayRates: zeros, phone: "07704444444" } as never, MANAGER);
    expect(r.wageChange).toBeNull();
  });

  it("ل٧) وسعرُ صفرٍ/فارغٍ في يومٍ = «يُشتقّ من الراتب» فلا يُعدّ تغييراً", async () => {
    const r = await updateEmployee(
      1,
      payload({ workSchedule: schedWith({ الأحد: { hours: 8, rate: 0 } }) }) as never,
      MANAGER,
    );
    expect(r.wageChange).toBeNull();
  });

  it("ل٧) وحذفُ dayRates من حمولة الشهريّ لا يمحو أسعاره المخزّنة (كان `?? null` يمحوها)", async () => {
    await db().update(s.employees).set({ dayRates: { ...DAY_RATES, الأحد: 4000 } }).where(eq(s.employees.id, 1));
    const r = await updateEmployee(1, payload({ phone: "07702222222" }) as never, MANAGER);
    expect(r.wageChange).toBeNull();
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect((e.dayRates as Record<string, number>).الأحد).toBe(4000);
  });

  it("ل٧) وحذفُ workSchedule لا يمحو الجدول المخزّن", async () => {
    await db().update(s.employees).set({ workSchedule: schedWith({ الجمعة: { hours: 4, rate: null } }) }).where(eq(s.employees.id, 1));
    const r = await updateEmployee(1, payload({ phone: "07703333333" }) as never, MANAGER);
    expect(r.wageChange).toBeNull();
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect((e.workSchedule as Record<string, { hours: number }>).الجمعة.hours).toBe(4);
  });
});

describe("الترقية تحمل حزمة الأجر كاملةً (ل٨)", () => {
  it("ل٨) مديرٌ يطلب تغيير الجدول/الأسعار/البدلات/الإعفاء، ومديرٌ آخر يعتمد فيُطبَّق", async () => {
    const p = await createPromotion(
      {
        employeeId: 1,
        effectiveDate: "2026-01-01",
        wage: {
          salary: "1000000",
          allowances: "75000",
          attendanceExempt: true,
          workSchedule: schedWith({ الجمعة: { hours: 4, rate: 12000 } }),
        },
      },
      actorOf(MANAGER),
    );
    expect(p!.status).toBe("pending");
    // المسمّى يبقى كما هو في التغيير الأجريّ البحت.
    expect(p!.toTitle).toBe("محاسب");

    await approvePromotion(p!.id, actorOf(MANAGER2));

    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("1000000.00");
    expect(String(e.allowances)).toBe("75000.00");
    expect(e.attendanceExempt).toBe(true);
    expect((e.workSchedule as Record<string, { hours: number; rate: number | null }>).الجمعة).toEqual({ hours: 4, rate: 12000 });
    // ما لم يُمرَّر يبقى كما كان (الطلب يُخزَّن هدفاً كاملاً مبنيّاً على الحالة الراهنة).
    expect((e.workSchedule as Record<string, { hours: number }>).الأحد.hours).toBe(8);
  });

  it("ل٨) وتغييرٌ أجريٌّ لموظفٍ بلا مسمّى لا يخترع له مسمّى — `position` لا يُمسّ", async () => {
    const p = await createPromotion(
      { employeeId: 2, effectiveDate: "2026-01-01", wage: { dayRates: { ...DAY_RATES, الأحد: 9000 } } },
      actorOf(MANAGER),
    );
    expect(p!.toTitle).toBe("");
    await approvePromotion(p!.id, actorOf(MANAGER2));
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 2));
    expect(e.position).toBeNull();
    expect((e.dayRates as Record<string, number>).الأحد).toBe(9000);
  });

  it("ل٨) وفصلُ المهام محفوظ — مُنشئ الطلب لا يعتمده بنفسه", async () => {
    const p = await createPromotion(
      { employeeId: 1, effectiveDate: "2026-01-01", wage: { salary: "2000000" } },
      actorOf(MANAGER),
    );
    await expect(approvePromotion(p!.id, actorOf(MANAGER))).rejects.toThrow(/فصل المهام/);
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("900000.00");
  });

  it("ل٨) وتاريخُ سريانٍ مستقبليّ يُؤجّل التطبيق حتى تلتقطه كنسة المسيّر", async () => {
    const p = await createPromotion(
      { employeeId: 1, effectiveDate: "2099-01-01", wage: { salary: "1200000", allowances: "0" } },
      actorOf(MANAGER),
    );
    await approvePromotion(p!.id, actorOf(MANAGER2));
    let [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("900000.00"); // لم يسرِ بعد

    await withTx((tx) => applyDuePromotions(tx, "2099-01-31"));
    [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("1200000.00");
    expect(String(e.allowances)).toBe("0.00");
  });

  /*
   * ل٩) طلبان معلَّقان على نفس الموظف (مراجعة Codex P1): كلٌّ يحمل **لقطةً كاملة** وقت
   * إنشائه، فتطبيقُ اللقطة بحذافيرها كان يجعل آخرَهما يمحو ما اعتمده الأوّل صامتاً.
   * التطبيق صار محصوراً بما تغيّر فعلاً عن `fromWage` ⇒ يتراكبان بلا تدمير.
   */
  describe("ل٩) طلبان متزامنان لا يمحو أحدهما الآخر", () => {
    it("طلبُ راتبٍ وطلبُ جدولٍ أُنشئا معاً ⇒ كلاهما يبقى بعد اعتمادهما", async () => {
      const pSalary = await createPromotion(
        { employeeId: 1, effectiveDate: "2026-01-01", wage: { salary: "1500000" } },
        actorOf(MANAGER),
      );
      // أُنشئ **قبل** تطبيق الأوّل ⇒ لقطتُه تحمل الراتب القديم ٩٠٠ ألف.
      const pSched = await createPromotion(
        { employeeId: 1, effectiveDate: "2026-01-01", wage: { workSchedule: schedWith({ السبت: { hours: 0, rate: null } }) } },
        actorOf(MANAGER),
      );

      await approvePromotion(pSalary!.id, actorOf(MANAGER2));
      await approvePromotion(pSched!.id, actorOf(MANAGER2));

      const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
      expect(String(e.salary)).toBe("1500000.00"); // لم يُرجِعه طلبُ الجدول
      expect((e.workSchedule as Record<string, { hours: number }>).السبت.hours).toBe(0);
    });

    it("وطلبُ أجرٍ بحتٍ لا يُرجِع مسمّى غيّرته ترقيةٌ سبقته", async () => {
      const pWage = await createPromotion(
        { employeeId: 1, effectiveDate: "2026-01-01", wage: { allowances: "90000" } },
        actorOf(MANAGER),
      );
      const pTitle = await createPromotion(
        { employeeId: 1, toTitle: "مدير مالي", effectiveDate: "2026-01-01" },
        actorOf(MANAGER),
      );
      await approvePromotion(pTitle!.id, actorOf(MANAGER2));
      await approvePromotion(pWage!.id, actorOf(MANAGER2));

      const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
      expect(e.position).toBe("مدير مالي"); // لقطةُ طلب الأجر كانت «محاسب»
      expect(String(e.allowances)).toBe("90000.00");
    });
  });

  /*
   * ل١٠) سعرُ ساعة الساعيّ يُجمَّد في صفّ الحضور لحظة تسجيله، والترقيات المؤجَّلة تُطبَّق
   * داخل توليد المسيّر — أي بعد تسجيل حضور الشهر كلِّه ⇒ تاريخُ سريانٍ مستقبليٌّ عليها
   * وعدٌ لا يصل. يُرفض عند الإنشاء بدل أن يُدفع الشهر بالسعر القديم صامتاً.
   */
  it("ل١٠) أسعارُ الساعيّ ترفض تاريخ سريانٍ مستقبليّ", async () => {
    await expect(
      createPromotion(
        { employeeId: 2, effectiveDate: "2099-01-01", wage: { dayRates: { ...DAY_RATES, الأحد: 8000 } } },
        actorOf(MANAGER),
      ),
    ).rejects.toThrow(/سجلّ الحضور/);
  });

  it("ل١٠) وتقبله للشهريّ (الراتب/الجدول يُحتسبان وقت التوليد لا وقت التسجيل)", async () => {
    const p = await createPromotion(
      { employeeId: 1, effectiveDate: "2099-01-01", wage: { workSchedule: schedWith({ السبت: { hours: 0, rate: null } }) } },
      actorOf(MANAGER),
    );
    expect(p!.status).toBe("pending");
  });

  it("ل٨) والترقية القديمة (بلا حزمة) تبقى تُطبّق الراتب وحده — صفر أثرٍ رجعيّ", async () => {
    const p = await createPromotion(
      { employeeId: 1, toTitle: "محاسب أول", toSalary: "950000", effectiveDate: "2026-01-01" },
      actorOf(MANAGER),
    );
    const [row] = await db().select().from(s.employeePromotions).where(eq(s.employeePromotions.id, p!.id));
    expect(row.toWage).toBeNull();
    await approvePromotion(p!.id, actorOf(MANAGER2));
    const [e] = await db().select().from(s.employees).where(eq(s.employees.id, 1));
    expect(String(e.salary)).toBe("950000.00");
    expect(e.position).toBe("محاسب أول");
    expect(String(e.allowances)).toBe("50000.00"); // لم تُمسّ
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
