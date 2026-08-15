/**
 * اختبارات تكامل (DB) لخدمة الترقيات/إنهاء الخدمات — وحدة الموارد البشرية.
 * تغطّي: اعتماد الترقية يحدّث مسمّى/راتب الموظف؛ إكمال إنهاء الخدمة يُصدِر **سند صرفٍ مُعلَّق**
 * للتسوية (فصل مهام #٦: بلا أثرٍ ماليّ حتى يعتمده مديرٌ آخر عبر approveVoucher بشرط SOD-04)
 * ويُنهي خدمته؛ المُنشئ لا يعتمد سنده؛ حارس عدم ترقية منتهي الخدمة؛ التسوية الصفرية لا تُنشئ سنداً.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createEmployee } from "../employeeService";
import {
  applyDuePromotions,
  approvePromotion,
  completeTermination,
  createPromotion,
  createTermination,
  listPromotions,
  listTerminations,
} from "../promotionService";
import { approveVoucher } from "../voucher/approval";
import { withTx } from "../tx";

const ACTOR = { userId: 1, branchId: 1, role: "admin" };
// مُنشئ ومدقّق مالك لاختبار فصل المهام (SOD-04): المُنشئ ≠ المالك المُعتمِد.
const MANAGER_A = { userId: 2, branchId: 1, role: "manager" };
const MANAGER_B = { userId: 3, branchId: 1, role: "manager" };
const MANAGER_BRANCH_2 = { userId: 4, branchId: 2, role: "manager" };

const TABLES = [
  "accountingEntries",
  "receipts",
  "hrDeviceUsers",
  "hrFingerprintDevices",
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "test-admin", name: "مدير", role: "admin", branchId: 1 },
    {
      id: 2,
      openId: "test-mgr-a",
      name: "مدير أ",
      role: "manager",
      branchId: 1,
    },
    {
      id: 3,
      openId: "test-mgr-b",
      name: "مدير ب",
      role: "manager",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 4,
      openId: "test-mgr-c",
      name: "مدير الفرع الثاني",
      role: "manager",
      branchId: 2,
    },
    {
      id: 5,
      openId: "test-linked-user",
      name: "موظف مرتبط",
      role: "cashier",
      branchId: 1,
      sessionsValidFrom: new Date("2026-01-01T00:00:00Z"),
    },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("promotionService — الترقيات", () => {
  it("اعتماد الترقية يحدّث مسمّى الموظف وراتبه", async () => {
    const emp = await createEmployee({
      firstName: "علي",
      lastName: "الكناني",
      payType: "monthly",
      salary: "800000",
      position: "محاسب",
      branchId: 1,
    });
    const p = await createPromotion(
      {
        employeeId: emp!.id,
        toTitle: "محاسب أول",
        toSalary: "1000000",
        effectiveDate: "2026-06-01",
      },
      ACTOR,
    );
    await approvePromotion(p!.id, ACTOR);
    const [e2] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, emp!.id));
    expect(e2.position).toBe("محاسب أول");
    expect(Number(e2.salary)).toBe(1000000);
  });

  it("لا تُعتمد ترقية موظف منتهي الخدمة", async () => {
    const emp = await createEmployee({
      firstName: "نور",
      lastName: "الساعدي",
      payType: "monthly",
      salary: "700000",
      branchId: 1,
    });
    const t = await createTermination(
      {
        employeeId: emp!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    await completeTermination(t!.id, ACTOR);
    const p = await createPromotion(
      {
        employeeId: emp!.id,
        toTitle: "أمين مخزن",
        effectiveDate: "2026-07-01",
      },
      ACTOR,
    );
    await expect(approvePromotion(p!.id, ACTOR)).rejects.toThrow();
  });

  it("فصل المهام (تدقيق ١٧/٧): المُنشئ غير الأدمن لا يعتمد ترقيته بنفسه", async () => {
    const emp = await createEmployee({
      firstName: "زيد",
      lastName: "الحسيني",
      payType: "monthly",
      salary: "800000",
      position: "بائع",
      branchId: 1,
    });
    const p = await createPromotion(
      {
        employeeId: emp!.id,
        toTitle: "مشرف",
        toSalary: "1100000",
        effectiveDate: "2026-01-01",
      },
      MANAGER_A,
    );
    await expect(approvePromotion(p!.id, MANAGER_A)).rejects.toThrow(
      /فصل المهام/,
    );
    const [e2] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, emp!.id));
    expect(e2.position).toBe("بائع"); // لم تُطبَّق
    expect(Number(e2.salary)).toBe(800000);
  });

  it("فصل المهام: مديرٌ آخر يعتمد الترقية ⇒ تُطبَّق", async () => {
    const emp = await createEmployee({
      firstName: "ليث",
      lastName: "الدليمي",
      payType: "monthly",
      salary: "800000",
      position: "بائع",
      branchId: 1,
    });
    const p = await createPromotion(
      {
        employeeId: emp!.id,
        toTitle: "مشرف",
        toSalary: "1100000",
        effectiveDate: "2026-01-01",
      },
      MANAGER_A,
    );
    await approvePromotion(p!.id, MANAGER_B);
    const [e2] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, emp!.id));
    expect(e2.position).toBe("مشرف");
    expect(Number(e2.salary)).toBe(1100000);
  });

  it("effectiveDate مستقبليّ (تدقيق ١٧/٧): الاعتماد يؤجّل التطبيق (appliedAt=null) حتى تُطبّقه كنسة applyDuePromotions", async () => {
    const emp = await createEmployee({
      firstName: "مروان",
      lastName: "الزبيدي",
      payType: "monthly",
      salary: "800000",
      position: "بائع",
      branchId: 1,
    });
    const p = await createPromotion(
      {
        employeeId: emp!.id,
        toTitle: "مدير فرع",
        toSalary: "1500000",
        effectiveDate: "2030-01-01",
      },
      MANAGER_A,
    );
    await approvePromotion(p!.id, MANAGER_B);

    // معتمَدة لكن مؤجَّلة: راتب الموظف لم يتغيّر، appliedAt=null.
    const [row] = await db()
      .select()
      .from(s.employeePromotions)
      .where(eq(s.employeePromotions.id, p!.id));
    expect(row.status).toBe("approved");
    expect(row.appliedAt).toBeNull();
    expect(
      Number(
        (
          await db()
            .select()
            .from(s.employees)
            .where(eq(s.employees.id, emp!.id))
        )[0].salary,
      ),
    ).toBe(800000);

    // كنسة بتاريخٍ قبل effectiveDate ⇒ لا تطبيق.
    expect(await withTx((tx) => applyDuePromotions(tx, "2029-12-31"))).toBe(0);
    expect(
      Number(
        (
          await db()
            .select()
            .from(s.employees)
            .where(eq(s.employees.id, emp!.id))
        )[0].salary,
      ),
    ).toBe(800000);

    // كنسة عند/بعد effectiveDate ⇒ تُطبَّق مرّة واحدة.
    expect(await withTx((tx) => applyDuePromotions(tx, "2030-01-01"))).toBe(1);
    const [e2] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, emp!.id));
    expect(Number(e2.salary)).toBe(1500000);
    expect(e2.position).toBe("مدير فرع");
    // appliedAt خُتم ⇒ كنسة ثانية لا تُعيد التطبيق.
    expect(await withTx((tx) => applyDuePromotions(tx, "2030-01-01"))).toBe(0);
  });

  it("SEC-03: مدير الفرع لا يرى/ينشئ/يعتمد ترقية موظف في فرع آخر، والأدمن يرى الكل", async () => {
    const own = await createEmployee({
      firstName: "موظف",
      lastName: "الأول",
      payType: "monthly",
      salary: "700000",
      branchId: 1,
    });
    const foreign = await createEmployee({
      firstName: "موظف",
      lastName: "الثاني",
      payType: "monthly",
      salary: "800000",
      branchId: 2,
    });
    const ownPromotion = await createPromotion(
      { employeeId: own!.id, toTitle: "مشرف أول", effectiveDate: "2026-01-01" },
      MANAGER_A,
    );
    const foreignPromotion = await createPromotion(
      {
        employeeId: foreign!.id,
        toTitle: "مشرف ثانٍ",
        effectiveDate: "2026-01-01",
      },
      MANAGER_BRANCH_2,
    );

    expect((await listPromotions(MANAGER_A)).map((p) => p.id)).toEqual([
      ownPromotion!.id,
    ]);
    expect((await listPromotions(ACTOR)).map((p) => p.id).sort()).toEqual(
      [ownPromotion!.id, foreignPromotion!.id].sort(),
    );
    await expect(
      createPromotion(
        {
          employeeId: foreign!.id,
          toTitle: "اختراق",
          effectiveDate: "2026-01-01",
        },
        MANAGER_A,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      approvePromotion(foreignPromotion!.id, MANAGER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [foreignAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, foreign!.id));
    expect(foreignAfter.position).toBeNull();
    const [promotionAfter] = await db()
      .select()
      .from(s.employeePromotions)
      .where(eq(s.employeePromotions.id, foreignPromotion!.id));
    expect(promotionAfter.status).toBe("pending");
  });

  it("SEC-03: مستخدم HR غير الأدمن بلا فرع يفشل مغلقاً ولا يرث الفرع الرئيسي", async () => {
    await expect(
      listPromotions({ userId: 99, branchId: null, role: "manager" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("promotionService — إنهاء الخدمة (تسوية بفصل مهام #٦)", () => {
  it("إكمال الإنهاء يُصدِر سند صرف مُعلَّق (PENDING) بلا أثرٍ ماليّ حتى الاعتماد، ويُنهي الخدمة", async () => {
    const emp = await createEmployee({
      firstName: "سعد",
      lastName: "الجبوري",
      payType: "monthly",
      salary: "900000",
      branchId: 1,
    });
    const t = await createTermination(
      {
        employeeId: emp!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        settlement: "1500000",
      },
      ACTOR,
    );
    const res = await completeTermination(t!.id, MANAGER_A);

    const [e2] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, emp!.id));
    expect(e2.employmentStatus).toBe("terminated");
    expect(e2.isActive).toBe(false);

    // سند صرف مُعلَّق أُصدِر — بلا قيد PAYMENT_OUT بعد.
    expect(res.settlementVoucher).not.toBeNull();
    const [rc] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, res.settlementVoucher!.receiptId));
    expect(rc.approvalStatus).toBe("PENDING_APPROVAL");
    expect(rc.direction).toBe("OUT");
    expect(Number(rc.amount)).toBe(1500000);
    expect(rc.voucherNumber).toBeTruthy();
    const before = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(before.length).toBe(0); // لا أثر ماليّ قبل الاعتماد

    // اعتماد مالكٍ آخر (SOD-04) ⇒ يُرحَّل PAYMENT_OUT للخزينة.
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "1500000", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-TERMINATION-FUND", createdBy: 3,
    });
    await approveVoucher(res.settlementVoucher!.receiptId, MANAGER_B);
    const [rc2] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, res.settlementVoucher!.receiptId));
    expect(rc2.approvalStatus).toBe("APPROVED");
    expect(rc2.approvedBy).toBe(3);
    const after = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(after.length).toBe(1);
    expect(Number(after[0].amount)).toBe(1500000);
    expect(Number(after[0].revenue)).toBe(0);
    expect(Number(after[0].branchId)).toBe(1);
  });

  it("المالك المُنشئ لا يعتمد سند تسويته بنفسه (فصل مهام SOD-04)", async () => {
    await db().insert(s.users).values({
      id: 6, openId: "self-approving-owner", name: "مالك منشئ", role: "manager",
      branchId: 1, loginMethod: "local", isOwner: true,
    });
    const ownerMaker = { userId: 6, branchId: 1, role: "manager" };
    const emp = await createEmployee({
      firstName: "هدى",
      lastName: "الطائي",
      payType: "monthly",
      salary: "800000",
      branchId: 1,
    });
    const t = await createTermination(
      {
        employeeId: emp!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "500000",
      },
      ACTOR,
    );
    const res = await completeTermination(t!.id, ownerMaker);
    await expect(
      approveVoucher(res.settlementVoucher!.receiptId, ownerMaker),
    ).rejects.toThrow(/صانع الطلب|أنشأته بنفسك/);
    // لا أثر ماليّ (لم يُعتمَد).
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries.length).toBe(0);
  });

  it("تسوية صفرية لا تُنشئ سنداً ولا قيداً", async () => {
    const emp = await createEmployee({
      firstName: "رنا",
      lastName: "العامري",
      payType: "monthly",
      salary: "600000",
      branchId: 1,
    });
    const t = await createTermination(
      {
        employeeId: emp!.id,
        terminationType: "تقاعد",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    const res = await completeTermination(t!.id, MANAGER_A);
    expect(res.settlementVoucher).toBeNull();
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries.length).toBe(0);
  });

  it("لا يُكمَل إنهاء خدمة موظف منتهٍ مسبقاً", async () => {
    const emp = await createEmployee({
      firstName: "كرار",
      lastName: "البديري",
      payType: "monthly",
      salary: "850000",
      branchId: 1,
    });
    const t1 = await createTermination(
      {
        employeeId: emp!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    await completeTermination(t1!.id, MANAGER_A);
    const t2 = await createTermination(
      {
        employeeId: emp!.id,
        terminationType: "استقالة",
        lastDay: "2026-07-15",
        settlement: "100000",
      },
      ACTOR,
    );
    await expect(completeTermination(t2!.id, MANAGER_A)).rejects.toThrow();
  });

  it("SEC-03: مدير الفرع لا يرى/ينشئ/يكمل إنهاء فرع آخر", async () => {
    const own = await createEmployee({
      firstName: "إنهاء",
      lastName: "الأول",
      payType: "monthly",
      salary: "600000",
      branchId: 1,
    });
    const foreign = await createEmployee({
      firstName: "إنهاء",
      lastName: "الثاني",
      payType: "monthly",
      salary: "650000",
      branchId: 2,
    });
    const ownTermination = await createTermination(
      {
        employeeId: own!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      MANAGER_A,
    );
    const foreignTermination = await createTermination(
      {
        employeeId: foreign!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      MANAGER_BRANCH_2,
    );

    expect((await listTerminations(MANAGER_A)).map((t) => t.id)).toEqual([
      ownTermination!.id,
    ]);
    expect((await listTerminations(ACTOR)).map((t) => t.id).sort()).toEqual(
      [ownTermination!.id, foreignTermination!.id].sort(),
    );
    await expect(
      createTermination(
        {
          employeeId: foreign!.id,
          terminationType: "فصل",
          lastDay: "2026-06-30",
          settlement: "0",
        },
        MANAGER_A,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      completeTermination(foreignTermination!.id, MANAGER_A),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [foreignAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, foreign!.id));
    expect(foreignAfter.employmentStatus).toBe("active");
    const [terminationAfter] = await db()
      .select()
      .from(s.employeeTerminations)
      .where(eq(s.employeeTerminations.id, foreignTermination!.id));
    expect(terminationAfter.status).toBe("pending");
  });

  it("SEC-03: الإكمال الذري يعطّل الحساب ويبطل الجلسات ويحرّر ربط الجهاز مع التسوية والحالة", async () => {
    const employee = await createEmployee({
      firstName: "مرتبط",
      lastName: "بالنظام",
      payType: "monthly",
      salary: "900000",
      branchId: 1,
    });
    await db()
      .update(s.employees)
      .set({ userId: 5 })
      .where(eq(s.employees.id, employee!.id));
    await db().insert(s.hrFingerprintDevices).values({
      id: 10,
      name: "جهاز الرئيسي",
      serialNumber: "SEC03-SUCCESS",
      protocol: "AIFACE_WS",
      enabled: true,
      branchId: 1,
    });
    await db().insert(s.hrDeviceUsers).values({
      deviceId: 10,
      enrollId: 7,
      employeeId: employee!.id,
      effectiveFrom: "2026-01-01",
    });
    const beforeUser = (
      await db().select().from(s.users).where(eq(s.users.id, 5))
    )[0];
    const termination = await createTermination(
      {
        employeeId: employee!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        settlement: "250000",
      },
      MANAGER_A,
    );

    const result = await completeTermination(termination!.id, MANAGER_A);
    expect(result.userDisabled).toBe(true);
    expect(result.deviceLinksReleased).toBe(1);
    expect(result.settlementVoucher).not.toBeNull();

    const [employeeAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, employee!.id));
    const [userAfter] = await db()
      .select()
      .from(s.users)
      .where(eq(s.users.id, 5));
    const [linkAfter] = await db()
      .select()
      .from(s.hrDeviceUsers)
      .where(eq(s.hrDeviceUsers.deviceId, 10));
    const [terminationAfter] = await db()
      .select()
      .from(s.employeeTerminations)
      .where(eq(s.employeeTerminations.id, termination!.id));
    expect(employeeAfter.employmentStatus).toBe("terminated");
    expect(employeeAfter.isActive).toBe(false);
    expect(userAfter.isActive).toBe(false);
    expect(new Date(userAfter.sessionsValidFrom).getTime()).toBeGreaterThan(
      new Date(beforeUser.sessionsValidFrom).getTime(),
    );
    expect(linkAfter.employeeId).toBeNull();
    expect(linkAfter.effectiveFrom).toBeNull();
    expect(terminationAfter.status).toBe("completed");
  });

  it("SEC-03: فشل سند التسوية يرجع كل آثار الإنهاء ولا يترك حالة نصفية", async () => {
    const employee = await createEmployee({
      firstName: "اختبار",
      lastName: "الرجوع",
      payType: "monthly",
      salary: "900000",
      branchId: 1,
    });
    await db()
      .update(s.employees)
      .set({ userId: 5 })
      .where(eq(s.employees.id, employee!.id));
    await db().insert(s.hrFingerprintDevices).values({
      id: 11,
      name: "جهاز الرجوع",
      serialNumber: "SEC03-ROLLBACK",
      protocol: "AIFACE_WS",
      enabled: true,
      branchId: 1,
    });
    await db().insert(s.hrDeviceUsers).values({
      deviceId: 11,
      enrollId: 8,
      employeeId: employee!.id,
      effectiveFrom: "2026-01-01",
    });
    const userBefore = (
      await db().select().from(s.users).where(eq(s.users.id, 5))
    )[0];
    const termination = await createTermination(
      {
        employeeId: employee!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "100000",
      },
      MANAGER_A,
    );

    // createdBy مرجعٌ أجنبي: الفاعل الوهمي يفشل عند إدراج سند التسوية بعد تنفيذ الآثار السابقة داخل tx.
    await expect(
      completeTermination(termination!.id, {
        userId: 999999,
        branchId: 1,
        role: "admin",
      }),
    ).rejects.toThrow();

    const [employeeAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, employee!.id));
    const [userAfter] = await db()
      .select()
      .from(s.users)
      .where(eq(s.users.id, 5));
    const [linkAfter] = await db()
      .select()
      .from(s.hrDeviceUsers)
      .where(eq(s.hrDeviceUsers.deviceId, 11));
    const [terminationAfter] = await db()
      .select()
      .from(s.employeeTerminations)
      .where(eq(s.employeeTerminations.id, termination!.id));
    expect(employeeAfter.employmentStatus).toBe("active");
    expect(employeeAfter.isActive).toBe(true);
    expect(userAfter.isActive).toBe(true);
    expect(new Date(userAfter.sessionsValidFrom).getTime()).toBe(
      new Date(userBefore.sessionsValidFrom).getTime(),
    );
    expect(linkAfter.employeeId).toBe(employee!.id);
    expect(linkAfter.effectiveFrom).toBe("2026-01-01");
    expect(terminationAfter.status).toBe("pending");
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("SEC-03: يمنع إنهاء السجل الشخصي وآخر مدير، ويرجع المعاملة كاملة", async () => {
    const selfEmployee = await createEmployee({
      firstName: "مدير",
      lastName: "ذاتي",
      payType: "monthly",
      salary: "900000",
      branchId: 1,
    });
    await db()
      .update(s.employees)
      .set({ userId: 2 })
      .where(eq(s.employees.id, selfEmployee!.id));
    const selfTermination = await createTermination(
      {
        employeeId: selfEmployee!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    await expect(
      completeTermination(selfTermination!.id, MANAGER_A),
    ).rejects.toThrow(/سجلّك الشخصيّ/);

    const adminEmployee = await createEmployee({
      firstName: "المدير",
      lastName: "الأخير",
      payType: "monthly",
      salary: "1000000",
      branchId: 1,
    });
    await db()
      .update(s.employees)
      .set({ userId: 1 })
      .where(eq(s.employees.id, adminEmployee!.id));
    const adminTermination = await createTermination(
      {
        employeeId: adminEmployee!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    await expect(
      completeTermination(adminTermination!.id, MANAGER_A),
    ).rejects.toThrow(/غير المدير أو المالك/);
    await expect(
      completeTermination(adminTermination!.id, { ...ACTOR, userId: 99 }),
    ).rejects.toThrow(/آخر مدير/);

    await db().insert(s.users).values({
      id: 6,
      openId: "termination-owner",
      name: "مالك النظام",
      role: "manager",
      branchId: 1,
      isOwner: true,
    });
    const ownerEmployee = await createEmployee({
      firstName: "مالك",
      lastName: "النظام",
      payType: "monthly",
      salary: "1000000",
      branchId: 1,
    });
    await db()
      .update(s.employees)
      .set({ userId: 6 })
      .where(eq(s.employees.id, ownerEmployee!.id));
    const ownerTermination = await createTermination(
      {
        employeeId: ownerEmployee!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    await expect(
      completeTermination(ownerTermination!.id, ACTOR),
    ).rejects.toThrow(/غير المالك/);

    const [selfAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, selfEmployee!.id));
    const [adminAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, adminEmployee!.id));
    const [ownerAfter] = await db()
      .select()
      .from(s.employees)
      .where(eq(s.employees.id, ownerEmployee!.id));
    expect(selfAfter.employmentStatus).toBe("active");
    expect(adminAfter.employmentStatus).toBe("active");
    expect(ownerAfter.employmentStatus).toBe("active");
    expect(
      (
        await db()
          .select()
          .from(s.employeeTerminations)
          .where(eq(s.employeeTerminations.id, selfTermination!.id))
      )[0].status,
    ).toBe("pending");
    expect(
      (
        await db()
          .select()
          .from(s.employeeTerminations)
          .where(eq(s.employeeTerminations.id, adminTermination!.id))
      )[0].status,
    ).toBe("pending");
    expect(
      (
        await db()
          .select()
          .from(s.employeeTerminations)
          .where(eq(s.employeeTerminations.id, ownerTermination!.id))
      )[0].status,
    ).toBe("pending");
  });

  it("SEC-03: سباق إنهاء آخر مديرَين لا يستطيع تعطيلهما معاً", async () => {
    await db()
      .insert(s.users)
      .values([
        {
          id: 6,
          openId: "race-admin-a",
          name: "مدير سباق أ",
          role: "admin",
          branchId: 1,
        },
        {
          id: 7,
          openId: "race-admin-b",
          name: "مدير سباق ب",
          role: "admin",
          branchId: 1,
        },
      ]);
    const first = await createEmployee({
      firstName: "مدير",
      lastName: "سباق أ",
      payType: "monthly",
      branchId: 1,
    });
    const second = await createEmployee({
      firstName: "مدير",
      lastName: "سباق ب",
      payType: "monthly",
      branchId: 1,
    });
    await db()
      .update(s.employees)
      .set({ userId: 6 })
      .where(eq(s.employees.id, first!.id));
    await db()
      .update(s.employees)
      .set({ userId: 7 })
      .where(eq(s.employees.id, second!.id));
    const firstTermination = await createTermination(
      {
        employeeId: first!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      MANAGER_A,
    );
    const secondTermination = await createTermination(
      {
        employeeId: second!.id,
        terminationType: "فصل",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      MANAGER_A,
    );
    // اجعل 6 و7 آخر مديرين نشطين فقط، ثم اضرب المسارين معاً.
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, 1));

    const outcomes = await Promise.allSettled([
      completeTermination(firstTermination!.id, ACTOR),
      completeTermination(secondTermination!.id, ACTOR),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);

    const activeAdmins = await db()
      .select({ id: s.users.id })
      .from(s.users)
      .where(and(eq(s.users.role, "admin"), eq(s.users.isActive, true)));
    expect(activeAdmins).toHaveLength(1);
    const employeeRows = await db()
      .select({ status: s.employees.employmentStatus })
      .from(s.employees)
      .where(sql`${s.employees.id} IN (${first!.id}, ${second!.id})`);
    expect(employeeRows.filter((e) => e.status === "terminated")).toHaveLength(
      1,
    );
  });
});
