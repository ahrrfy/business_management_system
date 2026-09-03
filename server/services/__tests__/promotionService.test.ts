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
  createTermination as createTerminationRaw,
  listPromotions,
  listTerminations,
} from "../promotionService";
import { isLinkEffectiveOn } from "../hrDevices/punchStore";
import { approveVoucher } from "../voucher/approval";
import { withTx } from "../tx";
import { approveRun } from "../payroll/lifecycle";
import { PAYROLL_LEGAL_DEFAULTS } from "../payrollLegalService";
import { buildPayrollLegalPolicyEvidence } from "../payroll/legalSnapshot";

const ACTOR = { userId: 1, branchId: 1, role: "admin" };
// مُنشئ ومدقّق مالك لاختبار فصل المهام (SOD-04): المُنشئ ≠ المالك المُعتمِد.
const MANAGER_A = { userId: 2, branchId: 1, role: "manager" };
const MANAGER_B = { userId: 3, branchId: 1, role: "manager" };
const MANAGER_BRANCH_2 = { userId: 4, branchId: 2, role: "manager" };

type TestTerminationInput = Omit<
  Parameters<typeof createTerminationRaw>[0],
  "settlementEvidenceNote" | "zeroAmountsAttested"
> &
  Partial<
    Pick<
      Parameters<typeof createTerminationRaw>[0],
      "settlementEvidenceNote" | "zeroAmountsAttested"
    >
  >;
const createTermination = (
  input: TestTerminationInput,
  actor: Parameters<typeof createTerminationRaw>[1],
) =>
  createTerminationRaw(
    {
      ...input,
      settlementEvidenceNote:
        input.settlementEvidenceNote ?? "مراجعة بشرية موثقة للاختبار",
      zeroAmountsAttested: input.zeroAmountsAttested ?? true,
    },
    actor,
  );

const TABLES = [
  "terminationAdvanceAllocations",
  "payrollObligationAllocations",
  "payrollAccountingEvents",
  "payrollObligations",
  "payrollItems",
  "payrollRuns",
  "journalLines",
  "journalEntries",
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
    {
      id: 1,
      openId: "test-admin",
      name: "مدير",
      role: "admin",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 2,
      openId: "test-mgr-a",
      name: "مدير أ",
      role: "manager",
      branchId: 1,
      isOwner: true,
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
    await completeTermination(t!.id, MANAGER_A);
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
        breakdown: { otherSettlement: "1500000", otherSettlementLabel: "مكافأة تعاقدية" },
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

  // قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — المالكُ يعتمد سند تسويته الخاصّ بنفسه.
  it("المالك المُنشئ يعتمد سند تسويته بنفسه (قرار المالك ٣/٩/٢٦: لا اعتماد ثانٍ بعد المالك)", async () => {
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
        breakdown: { otherSettlement: "500000", otherSettlementLabel: "مكافأة تعاقدية" },
      },
      ACTOR,
    );
    const res = await completeTermination(t!.id, ownerMaker);
    // تمويلُ الخزينة (كنظير الاختبار أعلاه) — الاعتمادُ الذاتيّ لا يُعفي من فحص كفاية النقد.
    await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "500000", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-SELF-APPROVE-FUND", createdBy: 3,
    });
    const ap = await approveVoucher(res.settlementVoucher!.receiptId, ownerMaker);
    expect(ap.approvalStatus).toBe("APPROVED");
    const [rc] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, res.settlementVoucher!.receiptId));
    expect(rc.createdBy).toBe(6);
    expect(rc.approvedBy).toBe(6); // الأثر التدقيقيّ يبقى كاملاً رغم الاعتماد الذاتيّ.
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(entries.length).toBe(1);
    expect(Number(entries[0].amount)).toBe(500000);
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
        breakdown: { otherSettlement: "100000", otherSettlementLabel: "مكافأة تعاقدية" },
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
        breakdown: { otherSettlement: "250000", otherSettlementLabel: "مكافأة تعاقدية" },
      },
      ACTOR,
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
    /*
     * الربط يُحَدُّ ولا يُقطَع (بند ٢١): كان الإكمال يُصفّر `employeeId`/`effectiveFrom` فوراً،
     * ويومُ الإنهاء نفسه يومُ عملٍ وقع فعلاً ⇒ بصماتُه تصل بلا صاحبٍ فتُسجَّل صفر ساعات.
     * فالتأكيد هنا انتقل من **آليّة** القطع إلى **الخاصّيّة** التي كان القطع يخدمها.
     */
    expect(linkAfter.effectiveTo).toBe("2026-06-30");
    expect(linkAfter.employeeId).toBe(employee!.id);
    expect(linkAfter.effectiveFrom).toBe("2026-01-01");
    // وخاصّيّة SEC-03 نفسها ما زالت محروسة: ما بعد يوم الإنهاء لا يُنسَب إليه أبداً،
    // ويومُ الإنهاء يبقى منسوباً — وهو بالضبط ما جاء العمود لينقذه.
    expect(isLinkEffectiveOn(linkAfter, "2026-06-30")).toBe(true);
    expect(isLinkEffectiveOn(linkAfter, "2026-07-01")).toBe(false);
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
        breakdown: { otherSettlement: "100000", otherSettlementLabel: "مكافأة تعاقدية" },
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
      completeTermination(ownerTermination!.id, {
        userId: 6,
        branchId: 1,
        role: "manager",
      }),
    ).rejects.toThrow(/سجلّك الشخصيّ/);

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
      completeTermination(firstTermination!.id, MANAGER_B),
      completeTermination(secondTermination!.id, MANAGER_B),
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

  it("يفرض مالكاً مستقلاً ويرفض الإكمال قبل آخر يوم عمل بلا أي أثر", async () => {
    const sameMakerEmployee = await createEmployee({
      firstName: "فصل",
      lastName: "مهام",
      payType: "monthly",
      branchId: 1,
    });
    const sameMakerTermination = await createTermination(
      {
        employeeId: sameMakerEmployee!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        settlement: "0",
      },
      ACTOR,
    );
    await expect(
      completeTermination(sameMakerTermination!.id, ACTOR),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const futureEmployee = await createEmployee({
      firstName: "تاريخ",
      lastName: "مستقبلي",
      payType: "monthly",
      branchId: 1,
    });
    const futureTermination = await createTermination(
      {
        employeeId: futureEmployee!.id,
        terminationType: "استقالة",
        lastDay: "2099-12-31",
        settlement: "0",
      },
      ACTOR,
    );
    await expect(
      completeTermination(futureTermination!.id, MANAGER_A),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const untouchedEmployees = await db()
      .select({ employmentStatus: s.employees.employmentStatus })
      .from(s.employees)
      .where(
        sql`${s.employees.id} IN (${sameMakerEmployee!.id}, ${futureEmployee!.id})`,
      );
    expect(untouchedEmployees).toHaveLength(2);
    expect(
      untouchedEmployees.every((row) => row.employmentStatus === "active"),
    ).toBe(true);
    expect(await db().select().from(s.payrollAccountingEvents)).toHaveLength(0);
  });

  it("يمنع تكرار أجر مسيّر مع تسوية صفرية ويسمح ببند العمولة وحده", async () => {
    const wageEmployee = await createEmployee({
      firstName: "أجر",
      lastName: "مثبت",
      payType: "monthly",
      branchId: 1,
    });
    const commissionEmployee = await createEmployee({
      firstName: "عمولة",
      lastName: "فقط",
      payType: "monthly",
      branchId: 1,
    });
    await db().insert(s.payrollRuns).values({
      id: 90,
      period: "2026-06",
      status: "approved",
      revisionNo: 0,
      approvedBy: 3,
      approvedAt: new Date("2026-06-30T12:00:00.000Z"),
    });
    await db().insert(s.payrollItems).values([
      {
        id: 901,
        runId: 90,
        employeeId: wageEmployee!.id,
        branchIdSnapshot: 1,
        revisionNo: 0,
        payType: "monthly",
        gross: "500.00",
        overtime: "0.00",
        commission: "0.00",
        net: "500.00",
      },
      {
        id: 902,
        runId: 90,
        employeeId: commissionEmployee!.id,
        branchIdSnapshot: 1,
        revisionNo: 0,
        payType: "monthly",
        gross: "0.00",
        overtime: "0.00",
        commission: "200.00",
        net: "200.00",
      },
    ]);
    const wageTermination = await createTermination(
      {
        employeeId: wageEmployee!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        breakdown: { earnedGrossWages: "0" },
      },
      ACTOR,
    );
    const commissionTermination = await createTermination(
      {
        employeeId: commissionEmployee!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        breakdown: { earnedGrossWages: "0" },
      },
      ACTOR,
    );

    await expect(
      completeTermination(wageTermination!.id, MANAGER_A),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const commissionResult = await completeTermination(
      commissionTermination!.id,
      MANAGER_A,
    );
    expect(commissionResult.settlementVoucher).toBeNull();

    const [wageAfter] = await db()
      .select({ status: s.employees.employmentStatus })
      .from(s.employees)
      .where(eq(s.employees.id, wageEmployee!.id));
    const [commissionAfter] = await db()
      .select({ status: s.employees.employmentStatus })
      .from(s.employees)
      .where(eq(s.employees.id, commissionEmployee!.id));
    expect(wageAfter.status).toBe("active");
    expect(commissionAfter.status).toBe("terminated");
  });

  it("يسلسل سباق اعتماد المسيّر وإثبات الإنهاء بلا deadlock وينجح مسار واحد فقط", async () => {
    const employee = await createEmployee({
      firstName: "سباق",
      lastName: "راتب وإنهاء",
      payType: "monthly",
      branchId: 1,
    });
    const termination = await createTermination(
      {
        employeeId: employee!.id,
        terminationType: "استقالة",
        lastDay: "2026-06-30",
        breakdown: { earnedGrossWages: "500.00" },
      },
      ACTOR,
    );
    const legalPolicy = buildPayrollLegalPolicyEvidence(PAYROLL_LEGAL_DEFAULTS);
    await db().insert(s.payrollRuns).values({
      id: 93,
      period: "2026-06",
      branchId: 1,
      status: "draft",
      revisionNo: 0,
      employeeCount: 1,
      totalGross: "500.00",
      totalNet: "500.00",
      legalPolicySnapshot: legalPolicy.snapshot,
      legalPolicyHash: legalPolicy.hash,
      createdBy: 4,
    });
    await db().insert(s.payrollItems).values({
      id: 931,
      runId: 93,
      employeeId: employee!.id,
      branchIdSnapshot: 1,
      revisionNo: 0,
      payType: "monthly",
      gross: "500.00",
      net: "500.00",
    });

    const outcomes = await Promise.allSettled([
      approveRun(93, MANAGER_B),
      completeTermination(termination!.id, MANAGER_A),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    expect(String(rejected && "reason" in rejected ? rejected.reason : "")).not.toMatch(
      /ER_LOCK_DEADLOCK|Deadlock found/i,
    );

    const [runAfter] = await db()
      .select({ status: s.payrollRuns.status })
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.id, 93));
    const [terminationAfter] = await db()
      .select({ status: s.employeeTerminations.status })
      .from(s.employeeTerminations)
      .where(eq(s.employeeTerminations.id, termination!.id));
    expect(
      Number(runAfter.status === "approved") +
        Number(terminationAfter.status === "completed"),
    ).toBe(1);
  });
});
