/**
 * sessionContextService.ts — تركيبُ «سياق الجلسة» على الخادم (م٤ ق١: الاستنتاج قبل السؤال).
 *
 * ── لماذا خدمةٌ لا راوتر ─────────────────────────────────────────────────────
 * قاعدة الطبقات (§٢): الراوتر بلا منطق أعمال، والخدمة **لا تقرأ `ctx`** — تستقبل بصمةَ الفاعل
 * صراحةً. فالتركيبُ هنا يُعاد استعمالُه من أيّ قناة (ويب/أندرويد/أوفلاين) بنفس الحقيقة، ولا
 * يستطيع مستدعٍ أن يمنح نفسه سلطةً: `composeSessionContext` (shared/sessionContext.ts) تشتقّ
 * `canCrossBranches` و`scopedBranchId` بنفسها ولا تقبلهما مُدخَلاً.
 *
 * ── ما يُشتقّ ومن أين (كلّه مصادرُ قائمة، لا شيءَ مُعادُ اختراع) ───────────────
 *   • الفرع النشط: `users.branchId` ⇒ صفُّ `branches` (المعرّف والاسم معاً، أو `null` صريحة
 *     لعابر الفروع بلا فرعٍ مُسنَد). ⛔ لا فرعَ افتراضيّ: غيرُ العابر بلا فرعٍ يُرفَض هنا كما
 *     يرفضه `branchScopedProcedure` (server/trpc.ts) بـFORBIDDEN.
 *   • اليوم التشغيليّ: `baghdadToday()` (server/services/businessDay.ts) — يومُ الكاونتر لا يوم
 *     UTC، ولا ساعةُ الجهاز.
 *   • طرقُ القبض: `INBOUND_ENABLED_PAYMENT_METHODS` (shared/inboundPaymentPolicy.ts) — المصدر
 *     الحاكم الوحيد؛ الشاشةُ تعرضه ولا تُعيد اشتقاقه (درس #596).
 *   • الفئة السعرية الافتراضية: فئةُ العابر `RETAIL` — نفسُ افتراض إنشاء العميل
 *     (`customerService.ts`: `defaultPriceTier ?? "RETAIL"`). ليست قيداً: عميلُ الجملة يرفعها
 *     بقرارٍ صريح في شاشته.
 *   • سلطةُ العبور: `canCrossBranches` (server/lib/branchAuthority.ts) — القاعدة الحاكمة الوحيدة
 *     لِـ«مَن يعبُر الفروع» (admin/isOwner؛ مديرُ الفرع لا).
 *   • نطاقُ الموظّف `scopedOwnerId`: يأتي من الراوتر كما حقنه `branchScopedProcedure` حرفياً —
 *     قاعدةُ «المشرف = عابرٌ أو مدير» تعيش هناك وحدها، ونسخُها هنا هو الانجراف الذي تمنعه
 *     `shared/sessionContext.ts` صراحةً.
 *
 * ── الفروع القابلة للاختيار ──────────────────────────────────────────────────
 * الشاشةُ تعرض «اختر فرعاً من قائمةٍ خادميّة» حين لا فرعَ نشط. القائمةُ تُشتقّ هنا من السلطة
 * نفسها: عابرُ الفروع ⇒ كلُّ الفروع النشطة؛ غيرُه ⇒ فرعُه وحده (فلا يُعرَض عليه ما سيرفضه
 * الخادم أصلاً). `isActive=false` يُستبعَد من الاختيار الجديد ويبقى صالحاً كفرعٍ مُسنَدٍ قائم
 * (نمطُ branchService: تعطيلٌ منطقيّ لا حذف).
 */
import { TRPCError } from "@trpc/server";
import { asc } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { INBOUND_ENABLED_PAYMENT_METHODS } from "@shared/inboundPaymentPolicy";
import {
  composeSessionContext,
  type SessionActor,
  type SessionBranch,
  type SessionContext,
  type SessionPriceTier,
} from "@shared/sessionContext";
import { branches } from "../../drizzle/schema";
import { getDb } from "../db";
import { canCrossBranches } from "../lib/branchAuthority";
import { baghdadToday } from "./businessDay";

/** فئةُ العابر — الافتراضُ نفسُه الذي يضعه إنشاءُ العميل (`customerService.ts`). */
export const WALK_IN_PRICE_TIER: SessionPriceTier = "RETAIL";

/** ما يحتاجه التركيب من الفاعل — بلا `ctx`، وكلُّ حقلٍ إلزاميّ (حقلٌ اختياريّ يعني «قد يُخترع»). */
export interface SessionContextRequest {
  actor: SessionActor;
  /** الفرع المُسنَد في صفّ المستخدم (`users.branchId`) — `null` = لا فرعَ مُسنَد. */
  assignedBranchId: number | null;
  /** ما حقنه `branchScopedProcedure` — `null` = مشرفٌ يرى كلَّ سجلّات النطاق. */
  scopedOwnerId: number | null;
  /** لحظةُ الاشتقاق — تُمرَّر صراحةً كي يُثبَت اليومُ التشغيليّ في الاختبار بلا ساعةٍ حيّة. */
  now: Date;
}

/** ردُّ الخادم: السياقُ الموثَّق + قائمةُ الاختيار الخادميّة (للشاشة حين لا فرعَ نشط أو عند التجاوز). */
export interface SessionContextPayload {
  context: SessionContext;
  selectableBranches: SessionBranch[];
}

/**
 * يشتقّ سياقَ الجلسة للفاعل المُعطى. يرمي `TRPCError` بعقد «ماذا حدث · لماذا · ماذا تفعل»:
 *   • FORBIDDEN — غيرُ عابر الفروع بلا فرعٍ مُسنَد (مرآةُ `branchScopedProcedure`).
 *   • PRECONDITION_FAILED — الفرعُ المُسنَد لا صفَّ له (سلامةُ بيانات لا قرارُ صلاحية).
 */
export async function deriveSessionContext(
  request: SessionContextRequest,
): Promise<SessionContextPayload> {
  const db = getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  }

  const crossBranch = canCrossBranches(request.actor);
  if (request.assignedBranchId == null && !crossBranch) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "لا يمكن بدء العمل بلا فرع",
        why: "حسابك بلا فرعٍ مُسنَد وصلاحيتك لا تعبُر الفروع",
        doThis: "اطلب من المدير إسناد فرعٍ إلى حسابك ثم أعِد تحميل الصفحة",
      }),
    });
  }

  const rows = await db
    .select({ id: branches.id, name: branches.name, isActive: branches.isActive })
    .from(branches)
    .orderBy(asc(branches.id));

  let branch: SessionBranch | null = null;
  if (request.assignedBranchId != null) {
    const row = rows.find((r) => Number(r.id) === request.assignedBranchId);
    if (!row) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر تحديد فرع جلستك",
          why: `الفرع المُسنَد إلى حسابك (رقم ${request.assignedBranchId}) غير موجود`,
          doThis: "اطلب من المدير إسناد فرعٍ قائم إلى حسابك ثم سجّل الدخول مجدّداً",
        }),
      });
    }
    branch = { id: Number(row.id), name: row.name };
  }

  const context = composeSessionContext(
    {
      actor: request.actor,
      branch,
      businessDay: baghdadToday(request.now),
      allowedPaymentMethods: INBOUND_ENABLED_PAYMENT_METHODS,
      defaultPriceTier: WALK_IN_PRICE_TIER,
      scopedOwnerId: request.scopedOwnerId,
    },
    request.now,
  );

  const activeBranches: SessionBranch[] = rows
    .filter((r) => r.isActive !== false)
    .map((r) => ({ id: Number(r.id), name: r.name }));
  // القائمةُ تتبع السلطةَ المُشتقّة في السياق نفسه (لا `crossBranch` المحلّية) — مصدرٌ واحد للحكم.
  const selectableBranches = context.canCrossBranches
    ? activeBranches
    : branch
      ? [branch]
      : [];

  return { context, selectableBranches };
}
