/**
 * اختبارات تكامل (DB) لخدمة الترقيات/إنهاء الخدمات — وحدة الموارد البشرية.
 * تغطّي: اعتماد الترقية يحدّث مسمّى/راتب الموظف؛ إكمال إنهاء الخدمة يُصدِر **سند صرفٍ مُعلَّق**
 * للتسوية (فصل مهام #٦: بلا أثرٍ ماليّ حتى يعتمده مديرٌ آخر عبر approveVoucher بشرط SOD-04)
 * ويُنهي خدمته؛ المُنشئ لا يعتمد سنده؛ حارس عدم ترقية منتهي الخدمة؛ التسوية الصفرية لا تُنشئ سنداً.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import { approvePromotion, completeTermination, createPromotion, createTermination } from "../promotionService";
import { approveVoucher } from "../voucher/approval";

const ACTOR = { userId: 1, branchId: 1 };
// مديران لاختبار فصل المهام (SOD-04): admin مُستثنى فلا يصلح لاختبار الرفض. المُنشئ ≠ المُعتمِد.
const MANAGER_A = { userId: 2, branchId: 1, role: "manager" };
const MANAGER_B = { userId: 3, branchId: 1, role: "manager" };

const TABLES = [
  "accountingEntries",
  "receipts",
  "employeePromotions",
  "employeeTerminations",
  "employees",
  "auditLogs",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 },
    { id: 2, openId: "test-mgr-a", name: "مدير أ", role: "manager", branchId: 1 },
    { id: 3, openId: "test-mgr-b", name: "مدير ب", role: "manager", branchId: 1 },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("promotionService — الترقيات", () => {
  it("اعتماد الترقية يحدّث مسمّى الموظف وراتبه", async () => {
    const emp = await createEmployee({ firstName: "علي", lastName: "الكناني", payType: "monthly", salary: "800000", position: "محاسب", branchId: 1 });
    const p = await createPromotion({ employeeId: emp!.id, toTitle: "محاسب أول", toSalary: "1000000", effectiveDate: "2026-06-01" });
    await approvePromotion(p!.id, ACTOR);
    const [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(e2.position).toBe("محاسب أول");
    expect(Number(e2.salary)).toBe(1000000);
  });

  it("لا تُعتمد ترقية موظف منتهي الخدمة", async () => {
    const emp = await createEmployee({ firstName: "نور", lastName: "الساعدي", payType: "monthly", salary: "700000", branchId: 1 });
    const t = await createTermination({ employeeId: emp!.id, terminationType: "فصل", lastDay: "2026-06-30", settlement: "0" });
    await completeTermination(t!.id, ACTOR);
    const p = await createPromotion({ employeeId: emp!.id, toTitle: "أمين مخزن", effectiveDate: "2026-07-01" });
    await expect(approvePromotion(p!.id, ACTOR)).rejects.toThrow();
  });
});

describe("promotionService — إنهاء الخدمة (تسوية بفصل مهام #٦)", () => {
  it("إكمال الإنهاء يُصدِر سند صرف مُعلَّق (PENDING) بلا أثرٍ ماليّ حتى الاعتماد، ويُنهي الخدمة", async () => {
    const emp = await createEmployee({ firstName: "سعد", lastName: "الجبوري", payType: "monthly", salary: "900000", branchId: 1 });
    const t = await createTermination({ employeeId: emp!.id, terminationType: "استقالة", lastDay: "2026-06-30", settlement: "1500000" });
    const res = await completeTermination(t!.id, MANAGER_A);

    const [e2] = await db().select().from(s.employees).where(eq(s.employees.id, emp!.id));
    expect(e2.employmentStatus).toBe("terminated");
    expect(e2.isActive).toBe(false);

    // سند صرف مُعلَّق أُصدِر — بلا قيد PAYMENT_OUT بعد.
    expect(res.settlementVoucher).not.toBeNull();
    const [rc] = await db().select().from(s.receipts).where(eq(s.receipts.id, res.settlementVoucher!.receiptId));
    expect(rc.approvalStatus).toBe("PENDING_APPROVAL");
    expect(rc.direction).toBe("OUT");
    expect(Number(rc.amount)).toBe(1500000);
    expect(rc.voucherNumber).toBeTruthy();
    const before = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(before.length).toBe(0); // لا أثر ماليّ قبل الاعتماد

    // اعتماد مديرٍ آخر (SOD-04) ⇒ يُرحَّل PAYMENT_OUT للخزينة.
    await approveVoucher(res.settlementVoucher!.receiptId, MANAGER_B);
    const [rc2] = await db().select().from(s.receipts).where(eq(s.receipts.id, res.settlementVoucher!.receiptId));
    expect(rc2.approvalStatus).toBe("APPROVED");
    expect(rc2.approvedBy).toBe(3);
    const after = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(after.length).toBe(1);
    expect(Number(after[0].amount)).toBe(1500000);
    expect(Number(after[0].revenue)).toBe(0);
    expect(Number(after[0].branchId)).toBe(1);
  });

  it("المُنشئ لا يعتمد سند تسويته بنفسه (فصل مهام SOD-04)", async () => {
    const emp = await createEmployee({ firstName: "هدى", lastName: "الطائي", payType: "monthly", salary: "800000", branchId: 1 });
    const t = await createTermination({ employeeId: emp!.id, terminationType: "فصل", lastDay: "2026-06-30", settlement: "500000" });
    const res = await completeTermination(t!.id, MANAGER_A);
    await expect(approveVoucher(res.settlementVoucher!.receiptId, MANAGER_A)).rejects.toThrow(/فصل المهام/);
    // لا أثر ماليّ (لم يُعتمَد).
    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries.length).toBe(0);
  });

  it("تسوية صفرية لا تُنشئ سنداً ولا قيداً", async () => {
    const emp = await createEmployee({ firstName: "رنا", lastName: "العامري", payType: "monthly", salary: "600000", branchId: 1 });
    const t = await createTermination({ employeeId: emp!.id, terminationType: "تقاعد", lastDay: "2026-06-30", settlement: "0" });
    const res = await completeTermination(t!.id, MANAGER_A);
    expect(res.settlementVoucher).toBeNull();
    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries.length).toBe(0);
  });

  it("لا يُكمَل إنهاء خدمة موظف منتهٍ مسبقاً", async () => {
    const emp = await createEmployee({ firstName: "كرار", lastName: "البديري", payType: "monthly", salary: "850000", branchId: 1 });
    const t1 = await createTermination({ employeeId: emp!.id, terminationType: "فصل", lastDay: "2026-06-30", settlement: "0" });
    await completeTermination(t1!.id, MANAGER_A);
    const t2 = await createTermination({ employeeId: emp!.id, terminationType: "استقالة", lastDay: "2026-07-15", settlement: "100000" });
    await expect(completeTermination(t2!.id, MANAGER_A)).rejects.toThrow();
  });
});
