/**
 * sessionContextRouter.ts — إجراءٌ واحد `sessionContext.get`: ما يعرفه الخادم عن **هذه** الجلسة.
 *
 * الغرض (م٤ ق١، برنامج v2): ٢٣٨ عقدَ راوترٍ يطلب `branchId` من العميل بينما الخادم يعرفه؛
 * هذا الإجراء يعيد المُشتَقَّ الخادميّ كاملاً (الفرع · اليوم التشغيليّ · طرق القبض · الفئة
 * السعرية · سلطة العبور · نطاق الرؤية) فتعرضه الشاشة عبر `<InferredField>` بدل أن تسأله —
 * ولا تخترع «الفرع ١» (بابُ IDOR الذي يحرسه `check:branch`).
 *
 * ── البوّابة: `selfServiceProcedure` مُلحَقةً بـ`branchScopedProcedure` — ولماذا ─────────
 *   • `selfServiceProcedure` (server/trpc.ts): «المعالِجُ يشتقّ الموضوعَ من `ctx.user` ولا يقبل
 *     معرّفَ مستخدمٍ من المستدعي» — وهذا الإجراءُ بلا مُدخَلٍ أصلاً؛ موضوعُه الفاعلُ نفسه.
 *     ⛔ ولا بوّابةَ وحدة له عمداً: لا وحدةَ يملكها **كلُّ** دورٍ (المحاسب بلا `products`،
 *     المشتريات بلا `sales`، فنّي المطبعة بلا `inventory`)، وأيُّ وحدةٍ تُختار تحجب الحقلَ
 *     المستنتَج عن دورٍ يخدمه الخادم فعلاً في شاشاته — «الشاشة تحجب ما يملكه الخادم».
 *   • `.concat(branchScopedProcedure)`: يحقن `scopedBranchId`/`scopedOwnerId` من **الوسيط الوحيد
 *     المصرَّح به** (§٢: لا فحصَ صلاحيةٍ جديد). قاعدةُ «المشرف = عابرٌ أو مدير» تعيش هناك وحدها؛
 *     نسخُها في راوترٍ أو خدمةٍ هو الانجراف الذي ترفضه `shared/sessionContext.ts` صراحةً.
 *     ويرثُ عنه رفضَ غير العابر بلا فرعٍ مُسنَد (FORBIDDEN) قبل بلوغ المعالِج.
 *   • لماذا لا `branchScopedProcedure` عاريةً: قراءةٌ عليها بلا وحدةٍ تُعلَّم
 *     `READ_WITHOUT_MODULE_GATE` في جرد الصلاحيات (`scripts/authz-inventory.mjs`) فيحمرّ
 *     `authz-guard` في CI — والإجراءُ ليس قراءةَ وحدةٍ بل قراءةَ ذاتٍ.
 *
 * الراوتر بلا منطق أعمال: يمرّر بصمةَ الفاعل إلى `deriveSessionContext` (الخدمة لا تقرأ `ctx`).
 */
import { deriveSessionContext } from "../services/sessionContextService";
import { branchScopedProcedure, router, selfServiceProcedure } from "../trpc";

export const sessionContextRouter = router({
  get: selfServiceProcedure.concat(branchScopedProcedure).query(({ ctx }) =>
    deriveSessionContext({
      actor: {
        userId: Number(ctx.user.id),
        role: String(ctx.user.role),
        isOwner: ctx.user.isOwner === true,
      },
      assignedBranchId: ctx.user.branchId == null ? null : Number(ctx.user.branchId),
      scopedOwnerId: ctx.scopedOwnerId,
      now: new Date(),
    }),
  ),
});
