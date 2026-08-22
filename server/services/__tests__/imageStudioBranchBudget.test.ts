import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { listBranchBudgets, reserveBranchBudgetInTx, setBranchBudget } from "../imageStudioBranchBudget";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

const DAY = "2026-08-20";
const NOW = new Date("2026-08-20T09:00:00.000Z");

beforeEach(async () => {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([{ id: 1, openId: "budget-admin", name: "المدير العام", role: "admin", branchId: 1 }]);
});

/** يحجز نداءً واحداً على حصّة الفرع عبر معاملةٍ حقيقية — نفس المسار الذي يسلكه الحارس. */
function reserve(branchId: number | null, service: "REMOVEBG" | "AI" = "REMOVEBG") {
  return withTx((tx) => reserveBranchBudgetInTx(tx, service, branchId, DAY, NOW), { gate: "NONE" });
}

describe("حصص المزوّد المدفوع لكل فرع", () => {
  it("بلا إعداد: لا حدّ فرعيّ ولا عدّاد — صفر أثرٍ سلوكيّ", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await reserve(1);
      expect(result).toEqual({ limited: false, used: 0, limit: null });
    }
    const rows = await db().select().from(s.imageStudioBranchUsageDaily);
    // لا يُنشَأ عدّادٌ لفرعٍ بلا حصّة: الجدول يبقى فارغاً تماماً.
    expect(rows).toHaveLength(0);
  });

  it("يمنع الفرع عند بلوغ حصّته ولا يمسّ الفرع الآخر", async () => {
    await setBranchBudget(1, 1, "REMOVEBG", 2);
    expect(await reserve(1)).toMatchObject({ limited: true, used: 1, limit: 2 });
    expect(await reserve(1)).toMatchObject({ limited: true, used: 2, limit: 2 });
    await expect(reserve(1)).rejects.toThrow(/حصّته اليومية/);
    // الفرع الثاني بلا حصّة مضبوطة ⇒ لا يتأثّر بنفاد الأوّل. هذا جوهر العطب المُغلَق:
    // قبله كان سقفٌ شركيّ واحد يجعل نفادَ فرعٍ نفاداً للجميع.
    expect(await reserve(2)).toEqual({ limited: false, used: 0, limit: null });
  });

  it("الحصص مستقلّة لكل خدمة", async () => {
    await setBranchBudget(1, 1, "REMOVEBG", 1);
    expect(await reserve(1, "REMOVEBG")).toMatchObject({ limited: true, used: 1 });
    await expect(reserve(1, "REMOVEBG")).rejects.toThrow(/حصّته اليومية/);
    // AI بلا حصّة ⇒ يمرّ رغم نفاد REMOVEBG.
    expect(await reserve(1, "AI")).toEqual({ limited: false, used: 0, limit: null });
  });

  it("صفرٌ صريح = إيقافٌ كامل بلا إنشاء عدّاد", async () => {
    await setBranchBudget(1, 1, "AI", 0);
    await expect(reserve(1, "AI")).rejects.toThrow(/موقوفٌ لهذا الفرع/);
    const rows = await db().select().from(s.imageStudioBranchUsageDaily);
    expect(rows).toHaveLength(0);
  });

  it("مستخدمٌ بلا فرع لا يُحاسَب فرعياً ولا يُنسَب إلى فرعٍ افتراضيّ", async () => {
    await setBranchBudget(1, 1, "REMOVEBG", 1);
    // `?? 1` هو بابُ IDOR التاريخيّ: null يجب أن يعني «لا حصّة فرعية»، لا «الفرع ١».
    expect(await reserve(null)).toEqual({ limited: false, used: 0, limit: null });
    expect(await reserve(1)).toMatchObject({ limited: true, used: 1, limit: 1 });
  });

  it("رفعُ الحصّة كلّياً بحذف الصفّ (null)، وضبطُها ثانيةً يُحدِّث لا يُكرِّر", async () => {
    await setBranchBudget(1, 1, "REMOVEBG", 1);
    await setBranchBudget(1, 1, "REMOVEBG", 9);
    const rows = await db()
      .select()
      .from(s.imageStudioBranchBudgets)
      .where(and(eq(s.imageStudioBranchBudgets.branchId, 1), eq(s.imageStudioBranchBudgets.service, "REMOVEBG")));
    expect(rows).toHaveLength(1);
    expect(rows[0].dailyLimit).toBe(9);
    expect(rows[0].updatedBy).toBe(1);

    expect(await setBranchBudget(1, 1, "REMOVEBG", null)).toEqual({ dailyLimit: null });
    expect(await reserve(1)).toEqual({ limited: false, used: 0, limit: null });
  });

  it("الرفض لا يُبقي الحجز محسوباً: العدّاد يقف عند الحصّة لا فوقها", async () => {
    await setBranchBudget(1, 1, "REMOVEBG", 1);
    await reserve(1);
    await expect(reserve(1)).rejects.toThrow();
    const [row] = await db()
      .select()
      .from(s.imageStudioBranchUsageDaily)
      .where(and(eq(s.imageStudioBranchUsageDaily.branchId, 1), eq(s.imageStudioBranchUsageDaily.usageDate, DAY)));
    expect(row.requestCount).toBe(1);
  });

  it("اللوحة تُظهر كل فرعٍ نشِط بحصّته واستهلاكه — والفراغ يُقرأ null لا صفراً", async () => {
    await setBranchBudget(1, 1, "REMOVEBG", 3);
    await reserve(1);
    const board = await listBranchBudgets(DAY);
    expect(board).toHaveLength(2);
    const main = board.find((row) => row.branchId === 1)!;
    const removebg = main.services.find((row) => row.service === "REMOVEBG")!;
    expect(removebg).toMatchObject({ dailyLimit: 3, usedToday: 1 });
    // «بلا حدّ» يجب أن يبقى null: عرضُه صفراً يقرأه المدير «موقوف» وهو مفتوح.
    expect(main.services.find((row) => row.service === "AI")).toMatchObject({ dailyLimit: null, usedToday: 0 });
    expect(board.find((row) => row.branchId === 2)!.services.every((row) => row.dailyLimit === null)).toBe(true);
  });

  it("يرفض فرعاً غير موجود بدل إنشاء حصّةٍ يتيمة", async () => {
    await expect(setBranchBudget(1, 999, "REMOVEBG", 5)).rejects.toThrow(/الفرع غير موجود/);
  });
});
