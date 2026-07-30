import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { withTx } from "../tx";
import { studentService } from "../digitalCards";

/**
 * البطاقات الرقمية — ش٦: ملفّات الطلاب.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٥.٨ + §٨.٤.
 */

const actor = { userId: 1, branchId: 1 };

const TABLES = ["studentProfiles", "auditLogs", "customers", "users", "branches"];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

function snap(over: Partial<studentService.StudentSnapshot> = {}): studentService.StudentSnapshot {
  return {
    studentName: "أحمد كريم",
    studentPhone: "07701234567",
    guardianPhone: "07709998888",
    address: "بغداد — الكرادة",
    mode: "UPDATE_PROFILE",
    ...over,
  };
}

async function profileOf(customerId: number) {
  const [p] = await db().select().from(s.studentProfiles).where(eq(s.studentProfiles.customerId, customerId));
  return p;
}
async function customerOf(customerId: number) {
  const [c] = await db().select().from(s.customers).where(eq(s.customers.id, customerId));
  return c;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("ش٦ — التطبيع والتحقّق", () => {
  it("الهواتف تُطبَّع إلى E.164 والحقول تُشذَّب", async () => {
    const { customerId } = await withTx((tx) => studentService.commitStudent(tx, snap({
      studentName: "  أحمد كريم  ", studentPhone: "0770 123 4567", guardianPhone: "+964 770 999 8888",
    }), actor));

    const p = await profileOf(customerId);
    const c = await customerOf(customerId);
    expect(p.studentPhone).toBe("+9647701234567");
    expect(p.guardianPhone).toBe("+9647709998888");
    expect(c.name).toBe("أحمد كريم");
    // نسخة الهاتف في العميل مطابقة للمطبَّعة في ملفّ الطالب (مصدر حقيقة واحد).
    expect(c.phone).toBe(p.studentPhone);
  });

  it("صِيَغ الكتابة المختلفة لنفس الرقم تتلاقى", () => {
    expect(studentService.samePhone("07701234567", "+9647701234567")).toBe(true);
    expect(studentService.samePhone("00964 770-123-4567", "07701234567")).toBe(true);
    expect(studentService.samePhone("07701234567", "07701234568")).toBe(false);
  });

  it("كل حقل مطلوب يُرفَض فارغاً، والرسالة بلا بيانات الطالب نفسها", async () => {
    const cases: [Partial<studentService.StudentSnapshot>, RegExp][] = [
      [{ studentName: "  " }, /اسم الطالب مطلوب/],
      [{ studentPhone: "" }, /هاتف الطالب مطلوب/],
      [{ guardianPhone: "" }, /هاتف ولي الأمر مطلوب/],
      [{ address: "" }, /عنوان الطالب مطلوب/],
    ];
    for (const [over, re] of cases) {
      await expect(withTx((tx) => studentService.commitStudent(tx, snap(over), actor))).rejects.toThrow(re);
    }
    // رقم قصير مرفوض، والرسالة لا تحمل الرقم (لا PII في الأخطاء).
    await expect(withTx((tx) => studentService.commitStudent(tx, snap({ studentPhone: "123" }), actor)))
      .rejects.toThrow(/غير صالح/);
    await expect(withTx((tx) => studentService.commitStudent(tx, snap({ studentPhone: "123" }), actor)))
      .rejects.not.toThrow(/123/);
  });
});

describe("ش٦ — الإنشاء والربط", () => {
  it("طالب جديد يُنشئ عميلاً «نقدي فقط» + ملفّ طالب في معاملة واحدة", async () => {
    const r = await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    expect(r.created).toBe(true);

    const c = await customerOf(r.customerId);
    expect(c.creditLimit).toBe("0.00");
    expect(c.address).toBe("بغداد — الكرادة");
    expect(await profileOf(r.customerId)).toBeTruthy();
  });

  it("فشل بعد إنشاء العميل يُرجِع كل شيء (ذرّية)", async () => {
    const before = (await db().select().from(s.customers)).length;
    await expect(
      withTx(async (tx) => {
        await studentService.commitStudent(tx, snap(), actor);
        throw new Error("فشل مُصطنع بعد الإنشاء");
      }),
    ).rejects.toThrow(/فشل مُصطنع/);
    expect((await db().select().from(s.customers)).length).toBe(before);
    expect((await db().select().from(s.studentProfiles)).length).toBe(0);
  });

  it("عميل قائم وحيد بنفس الهاتف يُربَط بدل إنشاء ازدواج", async () => {
    const res = await db().insert(s.customers).values({ name: "أحمد ك.", phone: "+9647701234567", creditLimit: "0" });
    const existingId = Number((res as unknown as { insertId: number }).insertId ?? (res as unknown as [{ insertId: number }])[0].insertId);

    const r = await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    expect(r.created).toBe(false);
    expect(r.customerId).toBe(existingId);
    expect((await db().select().from(s.customers)).length).toBe(1);
  });

  it("تعدّد العملاء بنفس الهاتف ⇒ رفضٌ صريح بلا دمج تلقائيّ (منع دمج الإخوة)", async () => {
    await db().insert(s.customers).values([
      { name: "أحمد", phone: "+9647701234567", creditLimit: "0" },
      { name: "محمد", phone: "07701234567", creditLimit: "0" },
    ]);
    await expect(withTx((tx) => studentService.commitStudent(tx, snap(), actor)))
      .rejects.toThrow(/لا دمج تلقائيّ/);
    expect((await db().select().from(s.studentProfiles)).length).toBe(0);
  });

  it("هاتف طالب مسجَّل لطالبٍ آخر يُرفَض برسالة مفهومة", async () => {
    await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    // طالب آخر باسم مختلف لكن بنفس الرقم ⇒ يُحلّ إلى الملفّ نفسه (عميل وحيد بذلك الرقم).
    const second = await withTx((tx) => studentService.commitStudent(tx, snap({ studentName: "سارة" }), actor));
    expect(second.created).toBe(false);

    // أمّا رقمٌ يخصّ طالباً آخر بالفعل فيُرفَض عند محاولة نقله لملفٍّ ثانٍ.
    const other = await withTx((tx) => studentService.commitStudent(tx, snap({
      studentName: "ليلى", studentPhone: "07705554444",
    }), actor));
    await expect(withTx((tx) => studentService.commitStudent(tx, snap({
      customerId: other.customerId, studentName: "ليلى", studentPhone: "07701234567",
    }), actor))).rejects.toThrow(/مسجَّل لطالبٍ آخر/);
  });
});

describe("ش٦ — وضعا التعديل", () => {
  it("UPDATE_PROFILE يكتب التعديل في الملفّ والعميل معاً", async () => {
    const r = await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    await withTx((tx) => studentService.commitStudent(tx, snap({
      customerId: r.customerId,
      studentName: "أحمد كريم الجبوري",
      guardianPhone: "07701110000",
      address: "بغداد — المنصور",
      mode: "UPDATE_PROFILE",
    }), actor));

    const c = await customerOf(r.customerId);
    const p = await profileOf(r.customerId);
    expect(c.name).toBe("أحمد كريم الجبوري");
    expect(c.address).toBe("بغداد — المنصور");
    expect(p.guardianPhone).toBe("+9647701110000");
  });

  it("INVOICE_ONLY لا يمسّ الملفّ إطلاقاً", async () => {
    const r = await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    const before = { c: await customerOf(r.customerId), p: await profileOf(r.customerId) };

    const res = await withTx((tx) => studentService.commitStudent(tx, snap({
      customerId: r.customerId,
      studentName: "اسم مختلف تماماً",
      guardianPhone: "07700000000",
      address: "عنوان آخر",
      mode: "INVOICE_ONLY",
    }), actor));
    expect(res.profileUpdated).toBe(false);

    const after = { c: await customerOf(r.customerId), p: await profileOf(r.customerId) };
    expect(after.c.name).toBe(before.c.name);
    expect(after.c.address).toBe(before.c.address);
    expect(after.p.guardianPhone).toBe(before.p.guardianPhone);
  });

  it("تغيير هاتف الطالب يحدّث customers.phone وstudentProfiles.studentPhone معاً", async () => {
    const r = await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    await withTx((tx) => studentService.commitStudent(tx, snap({
      customerId: r.customerId, studentPhone: "07712223333", mode: "UPDATE_PROFILE",
    }), actor));

    const c = await customerOf(r.customerId);
    const p = await profileOf(r.customerId);
    expect(c.phone).toBe("+9647712223333");
    expect(p.studentPhone).toBe("+9647712223333");
  });
});

describe("ش٦ — البحث والإخوة", () => {
  it("البحث بهاتف الطالب يجد ملفّه بأي صيغة كتابة", async () => {
    await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    expect(await studentService.searchStudents(db(), { studentPhone: "07701234567" })).toHaveLength(1);
    expect(await studentService.searchStudents(db(), { studentPhone: "+9647701234567" })).toHaveLength(1);
    expect(await studentService.searchStudents(db(), { studentPhone: "07700000000" })).toHaveLength(0);
  });

  it("البحث بهاتف الوليّ يعرض كل إخوته دون دمجهم", async () => {
    const guardian = "07709998888";
    await withTx((tx) => studentService.commitStudent(tx, snap({ studentName: "أحمد", studentPhone: "07701111111", guardianPhone: guardian }), actor));
    await withTx((tx) => studentService.commitStudent(tx, snap({ studentName: "سارة", studentPhone: "07702222222", guardianPhone: guardian }), actor));
    await withTx((tx) => studentService.commitStudent(tx, snap({ studentName: "بلا صلة", studentPhone: "07703333333", guardianPhone: "07705550000" }), actor));

    const sibs = await studentService.searchStudents(db(), { guardianPhone: guardian });
    expect(sibs.map((x) => x.studentName).sort()).toEqual(["أحمد", "سارة"]);
    // ملفّان منفصلان — لا دمج.
    expect(new Set(sibs.map((x) => x.customerId)).size).toBe(2);
    expect(await studentService.countSiblings(db(), guardian)).toBe(2);
  });

  it("البحث بلا معايير يعيد فارغاً بدل سرد كل الطلاب", async () => {
    await withTx((tx) => studentService.commitStudent(tx, snap(), actor));
    expect(await studentService.searchStudents(db(), {})).toHaveLength(0);
  });

  it("resolveByPhone يميّز الجديد/الوحيد/الملتبس", async () => {
    expect((await studentService.resolveStudentByPhone(db(), "07709990000")).kind).toBe("NEW");

    await db().insert(s.customers).values({ name: "أحمد", phone: "+9647701234567", creditLimit: "0" });
    expect((await studentService.resolveStudentByPhone(db(), "07701234567")).kind).toBe("LINK");

    await db().insert(s.customers).values({ name: "محمد", phone: "07701234567", creditLimit: "0" });
    const amb = await studentService.resolveStudentByPhone(db(), "07701234567");
    expect(amb.kind).toBe("AMBIGUOUS");
    if (amb.kind === "AMBIGUOUS") expect(amb.candidates.length).toBe(2);
  });
});
