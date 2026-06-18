/**
 * اختبارات تكامل (DB) لخدمة الموظفين — وحدة الموارد البشرية.
 * تغطّي: الإنشاء (مع الاسم الكامل والحقول الغنية)، القائمة بفلاتر، التعديل، وتغيير حالة التوظيف.
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee, listEmployees, setEmploymentStatus, updateEmployee } from "../employeeService";
import { truncateTables } from "./__testUtils__";

const TABLES = ["assetMaintenance", "assetCustodyLog", "assetDocuments", "fixedAssets", "attendance", "employees", "auditLogs", "branches", "users"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await truncateTables(TABLES);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("employeeService — createEmployee", () => {
  it("ينشئ موظفاً شهرياً بالاسم الكامل والحقول الغنية", async () => {
    const e = await createEmployee({
      firstName: "علي", fatherName: "حسين", grandfatherName: "كاظم", lastName: "العبيدي",
      department: "المبيعات والكاشير", position: "مدير المبيعات", branchId: 1,
      payType: "monthly", salary: "1250000", allowances: "150000",
      gender: "ذكر", nationality: "عراقي", nationalId: "199012345678",
      education: [{ degree: "بكالوريوس", major: "إدارة أعمال", school: "جامعة بغداد", year: 2012, gpa: "جيد جداً" }],
      annualLeaveBalance: 14,
    });
    expect(e).toBeTruthy();
    expect(e!.fullName).toBe("علي حسين كاظم العبيدي");
    expect(e!.payType).toBe("monthly");
    expect(Number(e!.salary)).toBe(1250000);
    expect(Number(e!.allowances)).toBe(150000);
    expect(e!.branchName).toBe("الفرع الرئيسي");
    expect(Array.isArray(e!.education)).toBe(true);
    expect((e!.education as { degree: string }[])[0].degree).toBe("بكالوريوس");
    expect(e!.employmentStatus).toBe("active");
  });

  it("ينشئ موظف ساعة مع جدول سعر الساعة لكل يوم", async () => {
    const e = await createEmployee({
      firstName: "حيدر", lastName: "الزيدي", department: "الطباعة", payType: "hourly",
      dayRates: { "الأحد": 5000, "الجمعة": 7500 },
    });
    expect(e!.payType).toBe("hourly");
    expect((e!.dayRates as Record<string, number>)["الجمعة"]).toBe(7500);
  });
});

describe("employeeService — list + update + status", () => {
  it("القائمة تُرشّح بالقسم والحالة، والبحث بالاسم", async () => {
    await createEmployee({ firstName: "زينب", lastName: "الموسوي", department: "المحاسبة", payType: "monthly", salary: "1100000" });
    await createEmployee({ firstName: "عمر", lastName: "الجبوري", department: "المخزن", payType: "monthly", salary: "850000" });
    const acc = await listEmployees({ department: "المحاسبة" });
    expect(acc.total).toBe(1);
    expect(acc.rows[0].fullName).toBe("زينب الموسوي");
    const byName = await listEmployees({ q: "عمر" });
    expect(byName.rows.some((r) => r.fullName.includes("عمر"))).toBe(true);
  });

  it("التعديل يحفظ التغييرات", async () => {
    const e = await createEmployee({ firstName: "نور", lastName: "الساعدي", payType: "monthly", salary: "800000" });
    const up = await updateEmployee(e!.id, { firstName: "نور الهدى", lastName: "الساعدي", position: "كاشير", payType: "monthly", salary: "900000" });
    expect(up!.fullName).toBe("نور الهدى الساعدي");
    expect(up!.position).toBe("كاشير");
    expect(Number(up!.salary)).toBe(900000);
  });

  it("إنهاء الخدمة يضبط الحالة والتاريخ ويعطّل، والإعادة تُفعّل", async () => {
    const e = await createEmployee({ firstName: "كرار", lastName: "البديري", payType: "hourly", dayRates: { "الأحد": 5000 } });
    const term = await setEmploymentStatus(e!.id, "terminated", { terminationDate: "2026-04-30", terminationReason: "انتهاء عقد" });
    expect(term!.employmentStatus).toBe("terminated");
    expect(term!.isActive).toBe(false);
    expect(String(term!.terminationDate)).toBe("2026-04-30");
    // مُستبعَد من القائمة الافتراضية (النشطون فقط)
    const active = await listEmployees();
    expect(active.rows.find((r) => r.id === e!.id)).toBeUndefined();
    const back = await setEmploymentStatus(e!.id, "active");
    expect(back!.employmentStatus).toBe("active");
    expect(back!.isActive).toBe(true);
    expect(back!.terminationDate).toBeNull();
  });
});
