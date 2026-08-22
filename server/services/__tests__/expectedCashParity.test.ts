import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import { getDayCloseReconciliation } from "../reportsDayCloseService";
import { getOpenShifts } from "../treasury/openShifts";
import { withTx } from "../tx";

/**
 * المسار ز من ورقة الإصلاحات (١٦/٨): «النقد المتوقَّع» يُحسب في ثلاثة مواضع بشروطٍ مختلفة.
 *
 * المرجع (`computeDrawerCashBalance`) يستبعد PENDING/FAILED وغير المعتمَد ويشترط النقد؛
 * بينما تقرير إقفال اليوم يُغفل الحالة والاعتماد، وبطاقات الورديات المفتوحة تُغفلها
 * **وتُغفل شرط النقد أيضاً**. النتيجة: إيصالٌ معلَّق أو غير معتمَد أو بطاقةٌ في الدرج
 * تجعل التقرير يقول رقماً وحارسُ الوردية يقول آخر ⇒ **اتهامٌ أو تبرئةٌ خاطئة لكاشير**.
 *
 * هذا اختبار تكافؤ: يفشل ما دامت الحسابات الثلاثة تفترق.
 */

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

const CASHIER = 61;
const BRANCH = 1;
const SHIFT = 1;
const OPENING = "100000";

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["receipts", "shifts", "users", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: BRANCH, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: CASHIER, openId: "ec-cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: BRANCH,
  });
  await d.insert(s.shifts).values({
    id: SHIFT, branchId: BRANCH, userId: CASHIER, openingBalance: OPENING,
    status: "OPEN", shiftType: "RETAIL",
  });

  const base = {
    branchId: BRANCH, shiftId: SHIFT, cashBucket: "DRAWER" as const,
    partyType: "OTHER" as const, createdBy: CASHIER,
  };
  await d.insert(s.receipts).values([
    // (١) نقدٌ حقيقيّ مكتمل ومعتمَد — الوحيد الذي يجب أن يُحسب.
    { ...base, direction: "IN", amount: "40000", paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED" },
    // (٢) معلَّق: لم يتحوّل نقداً بعد.
    { ...base, direction: "IN", amount: "70000", paymentMethod: "CASH", status: "PENDING", approvalStatus: "APPROVED" },
    // (٣) غير معتمَد: بانتظار موافقة.
    { ...base, direction: "IN", amount: "13000", paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "PENDING_APPROVAL" },
    // (٤) بطاقة في الدرج: ليست نقداً في الصندوق إطلاقاً.
    { ...base, direction: "IN", amount: "25000", paymentMethod: "CARD", status: "COMPLETED", approvalStatus: "APPROVED" },
  ]);
});

/** المتوقَّع الصحيح: الافتتاحيّ + النقد المكتمل المعتمَد وحده. */
const TRUTH = "140000.00";

describe("المسار ز — تكافؤ «النقد المتوقَّع» عبر مواضعه الثلاثة", () => {
  it("حارس الوردية (المرجع) يستبعد المعلَّق وغير المعتمَد وغير النقد", async () => {
    const v = await withTx((tx) => computeDrawerCashBalance(tx, SHIFT, OPENING));
    expect(v.toFixed(2)).toBe(TRUTH);
  });

  it("تقرير إقفال اليوم يطابق الحارس بالضبط", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rec = await getDayCloseReconciliation({ date: today, branchId: BRANCH });
    const line = rec.shifts.find((r) => Number(r.shiftId) === SHIFT);
    expect(line).toBeTruthy();
    expect(String(line!.expected)).toBe(TRUTH);
  });

  it("بطاقة الوردية المفتوحة تطابق الحارس بالضبط", async () => {
    const cards = await getOpenShifts({}, { scopedBranchId: null, role: "admin", userId: CASHIER });
    const card = cards.find((c) => Number(c.shiftId) === SHIFT);
    expect(card).toBeTruthy();
    // البطاقة تعرض المتوقَّع = الافتتاحيّ + داخل − خارج.
    const expected = (card as unknown as { expectedCash?: string }).expectedCash;
    expect(String(expected)).toBe(TRUTH);
  });
});
