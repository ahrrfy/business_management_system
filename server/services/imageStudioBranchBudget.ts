/**
 * سقف مزوّد الصور المدفوع **لكل فرع**.
 *
 * **العطب الذي يُغلقه:** `imageStudioUsageGuard` يحرس سقفاً يوميّاً واحداً للشركة كلّها
 * (`imageStudioUsageDaily` بمفتاح (اليوم، الخدمة)). ففرعٌ نشِط يستنفد الثلاثين نداءً قبل
 * الظهر، ويُردّ الفرع الآخر بـ«بلغ الاستوديو سقف الاستخدام اليوميّ» وهو لم يُجرِ نداءً
 * واحداً — ورسالةُ الخطأ نفسها لا تُفرّق، فيظنّ مديره أنّ الميزانية نفدت لا أنّ فرعاً
 * آخر ابتلعها.
 *
 * **السقف الشركيّ يبقى الأعلى:** الفرعيّ لا يرفعه أبداً، إنّما يقتطع منه حصّةً. ومجموعُ
 * الحصص قد يقلّ عن السقف الشركيّ (احتياطيّ) أو يفوقه (مشاركةٌ انتهازيّة على مبدأ من
 * سبق) — كلاهما قرارُ المدير، ولا يُفرَض تساوٍ ولا يُمنع تجاوزُ المجموع.
 *
 * **اختياريّ افتراضاً:** غياب صفّ الميزانية = بلا حدٍّ فرعيّ ⇒ صفر أثرٍ سلوكيّ حتى يُضبَط
 * صراحةً (اصطلاح `creditLimit`: null = بلا حدّ). لا نفترض سياسةَ توزيعٍ نيابةً عن المالك.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { branches, imageStudioBranchBudgets, imageStudioBranchUsageDaily } from "../../drizzle/schema";
import { requireDb, type withTx } from "./tx";

export type ImageStudioService = "REMOVEBG" | "AI";
type AnyTx = Parameters<Parameters<typeof withTx>[0]>[0];

/** سقفٌ لكل فرع يقبله الإعداد: صفرٌ = إيقافُ المزوّد المدفوع لهذا الفرع صراحةً. */
export const MIN_BRANCH_DAILY_LIMIT = 0;
export const MAX_BRANCH_DAILY_LIMIT = 100_000;

/**
 * يحجز نداءً واحداً على حصّة الفرع داخل **نفس معاملة** الحجز الشركيّ.
 *
 * التنفيذ داخل معاملة المستدعي مقصود: لو حُجز الشركيّ ثمّ فشل الفرعيّ في معاملةٍ منفصلة
 * لبقي النداء محسوباً على الشركة بلا مقابل — عدّادٌ ينزف على كل رفضٍ فرعيّ.
 *
 * `branchId` غيرُ معلومٍ (مستخدمٌ بلا فرع) = لا حصّة فرعية تُحاسَب: السقف الشركيّ وحده،
 * ولا نخترع فرعاً افتراضياً (`?? 1` هو بابُ IDOR التاريخيّ الذي يحرسه `check:branch`).
 */
export async function reserveBranchBudgetInTx(
  tx: AnyTx,
  service: ImageStudioService,
  branchId: number | null | undefined,
  usageDate: string,
  now: Date,
): Promise<{ limited: boolean; used: number; limit: number | null }> {
  if (branchId == null || !Number.isSafeInteger(Number(branchId)) || Number(branchId) < 1) {
    return { limited: false, used: 0, limit: null };
  }
  const branch = Number(branchId);
  const [budget] = await tx
    .select({ dailyLimit: imageStudioBranchBudgets.dailyLimit })
    .from(imageStudioBranchBudgets)
    .where(and(eq(imageStudioBranchBudgets.branchId, branch), eq(imageStudioBranchBudgets.service, service)))
    .limit(1);
  if (!budget) return { limited: false, used: 0, limit: null };

  // صفرٌ صريح: إيقافٌ كامل. نردّ قبل إنشاء صفّ العدّاد — لا عدّادَ لحصّةٍ لا تُصرَف.
  if (budget.dailyLimit <= 0) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "المزوّد المدفوع موقوفٌ لهذا الفرع بقرار الإدارة.",
    });
  }

  await tx
    .insert(imageStudioBranchUsageDaily)
    .values({ usageDate, service, branchId: branch, requestCount: 0, lastRequestedAt: now })
    .onDuplicateKeyUpdate({ set: { lastRequestedAt: sql`${imageStudioBranchUsageDaily.lastRequestedAt}` } });
  // القفل بعد ضمان وجود الصفّ: بدونه يمرّ نداءان متزامنان من الفرع نفسه على قراءةٍ واحدة.
  const [row] = await tx
    .select({ requestCount: imageStudioBranchUsageDaily.requestCount })
    .from(imageStudioBranchUsageDaily)
    .where(
      and(
        eq(imageStudioBranchUsageDaily.usageDate, usageDate),
        eq(imageStudioBranchUsageDaily.service, service),
        eq(imageStudioBranchUsageDaily.branchId, branch),
      ),
    )
    .for("update");
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر حجز حصّة الفرع" });
  if (row.requestCount >= budget.dailyLimit) {
    // الرسالة تُسمّي السبب الحقيقيّ: حصّةُ الفرع نفدت، لا ميزانيةُ الشركة.
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `بلغ هذا الفرع حصّته اليومية من الاستوديو المدفوع (${budget.dailyLimit}). راجع المدير لرفعها.`,
    });
  }
  await tx
    .update(imageStudioBranchUsageDaily)
    .set({ requestCount: row.requestCount + 1, lastRequestedAt: now })
    .where(
      and(
        eq(imageStudioBranchUsageDaily.usageDate, usageDate),
        eq(imageStudioBranchUsageDaily.service, service),
        eq(imageStudioBranchUsageDaily.branchId, branch),
      ),
    );
  return { limited: true, used: row.requestCount + 1, limit: budget.dailyLimit };
}

/** قراءةٌ للوحة الإعداد: كل فرعٍ بحصّته (أو null = بلا حدّ) واستهلاكه اليوم. */
export async function listBranchBudgets(usageDate: string) {
  const db = requireDb();
  const branchRows = await db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.isActive, true));
  const budgetRows = await db.select().from(imageStudioBranchBudgets);
  const usageRows = await db
    .select({
      service: imageStudioBranchUsageDaily.service,
      branchId: imageStudioBranchUsageDaily.branchId,
      requestCount: imageStudioBranchUsageDaily.requestCount,
    })
    .from(imageStudioBranchUsageDaily)
    .where(eq(imageStudioBranchUsageDaily.usageDate, usageDate));
  const key = (branchId: number, service: string) => `${branchId}:${service}`;
  const limitBy = new Map(budgetRows.map((row) => [key(Number(row.branchId), row.service), row.dailyLimit]));
  const usedBy = new Map(usageRows.map((row) => [key(Number(row.branchId), row.service), Number(row.requestCount)]));
  const services: ImageStudioService[] = ["REMOVEBG", "AI"];
  return branchRows.map((branch) => ({
    branchId: Number(branch.id),
    branchName: branch.name,
    services: services.map((service) => ({
      service,
      dailyLimit: limitBy.get(key(Number(branch.id), service)) ?? null,
      usedToday: usedBy.get(key(Number(branch.id), service)) ?? 0,
    })),
  }));
}

/** يضبط الحصّة أو يرفعها كلّياً (`dailyLimit = null` ⇒ حذف الصفّ = بلا حدٍّ فرعيّ). */
export async function setBranchBudget(actorUserId: number, branchId: number, service: ImageStudioService, dailyLimit: number | null) {
  const db = requireDb();
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  if (dailyLimit == null) {
    await db.delete(imageStudioBranchBudgets).where(and(eq(imageStudioBranchBudgets.branchId, branchId), eq(imageStudioBranchBudgets.service, service)));
    return { dailyLimit: null as number | null };
  }
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < MIN_BRANCH_DAILY_LIMIT || dailyLimit > MAX_BRANCH_DAILY_LIMIT) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حصّة غير صالحة" });
  }
  await db
    .insert(imageStudioBranchBudgets)
    .values({ branchId, service, dailyLimit, updatedBy: actorUserId })
    .onDuplicateKeyUpdate({ set: { dailyLimit, updatedBy: actorUserId } });
  return { dailyLimit };
}
