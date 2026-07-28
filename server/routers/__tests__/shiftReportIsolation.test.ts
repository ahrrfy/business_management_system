/**
 * عزل الفرع في shifts.report (H2 — تدقيق ٢٧/٧): كان الحارس ميتاً لأنّه يقرأ `report.branchId`
 * (جذر) = undefined بينما فرعُ الوردية مُعشَّشٌ تحت `report.shift.branchId` — فيمرّ دائماً ⇒
 * أيّ مستخدمٍ بـ treasury:READ يقرأ Z-report أيّ فرعٍ بمعرفة shiftId (IDOR ماليّ). الإصلاح يقرأ
 * المسار الصحيح المُنمَّط، فيُحصَر غيرُ المرتفعين بفرعهم ويمرّ المرتفعون (admin/manager).
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";

function ctxWith(role: string, branchId: number | null): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = (role: string, branchId: number | null) => appRouter.createCaller(ctxWith(role, branchId));

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables(["receipts", "invoices", "shifts", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  // مستخدمٌ id=1 يطابق فاعل ctxWith — لازمٌ لأنّ FK `shifts_userId_users_id_fk` يفرضه
  // (truncate يمسح users، فبدون بذرٍ صريح يفشل إدراج الوردية بـ ER_NO_REFERENCED_ROW_2
  // متى لم ينجُ صفٌّ id=1 من حالةٍ سابقة ⇒ تقلقُل في تشغيلة pnpm test الكاملة).
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "t", email: "t@t", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  // ورديةٌ في كل فرع (لا حاجة لفواتير/سندات — getShiftReport يُعيد أصفاراً بأمان).
  // مستخدمٌ id=1 مرجعٌ لـshifts.userId (FK): بدونه يفشل الإدراج بـER_NO_REFERENCED_ROW_2. كان
  // الاختبار يعتمد ضمناً على تسرّب FOREIGN_KEY_CHECKS=0 من اختبارٍ سابق (هشّ/ترتيبيّ) — نبذره صراحةً.
  await d.insert(s.users).values([
    { id: 1, openId: "shiftrep-u1", name: "t", email: "shiftrep@t.test", role: "admin", loginMethod: "local", branchId: 1 },
  ]).onDuplicateKeyUpdate({ set: { branchId: 1 } });
  await d.insert(s.shifts).values([
    { id: 10, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0.00" },
    { id: 20, userId: 1, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "1:2", openingBalance: "0.00" },
  ]);
});

describe("shifts.report — عزل الفرع (H2)", () => {
  it("كاشير فرع ١ يقرأ تقرير ورديته (فرعه)", async () => {
    const report = await caller("cashier", 1).shifts.report({ shiftId: 10 });
    expect(report).not.toBeNull();
    expect(report!.shift.branchId).toBe(1);
  });

  it("كاشير فرع ١ ممنوعٌ من قراءة تقرير وردية فرع ٢ (الحارس الذي كان ميتاً)", async () => {
    await expect(
      caller("cashier", 1).shifts.report({ shiftId: 20 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("المدير (مرتفع، scopedBranchId=null) يقرأ تقرير أيّ فرع — مرورٌ حرّ", async () => {
    const report = await caller("manager", 1).shifts.report({ shiftId: 20 });
    expect(report).not.toBeNull();
    expect(report!.shift.branchId).toBe(2);
  });
});
