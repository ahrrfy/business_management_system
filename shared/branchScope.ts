/**
 * shared/branchScope.ts — نطاق الفرع متعدّد القيم (ش٦ RBAC).
 *
 * ⚠️ **أساسٌ خاملٌ مؤجَّل التفعيل** (تدقيق ٢٤/٧): عزل الفرع في النظام يمسّ ٧٣ ملفاً ومئات النقاط
 * المبنيّة على `ctx.user.branchId` المفردة و`elevated=admin||manager`. تحويلها كلّها إلى فحص عضوية
 * `IN(allowedBranchIds)` مطلبٌ صلبٌ لتفعيل «فروع محدّدة» — وأيّ نقطةٍ تُغفَل = ثغرة IDOR (وصول/كتابة
 * عبر الفروع). لذا هذا الملف **مُحلِّلٌ نقيّ مُختبَر فقط** غير موصولٍ بأي مخنق بعد ⇒ صفر أثر سلوكيّ.
 * التفعيل حملةٌ مخصّصة واعية يقرّرها المالك (هل حاجةُ «مدير الفرعين/الكاشير المتنقّل» فعلية الآن؟).
 *
 * النموذج: النطاق الفعليّ لحسابٍ = دالةٌ على (دوره، فرعه المفرد، صفوف roleBranches لدوره):
 *  - admin: كل الفروع (null = بلا قيد) — كما هو اليوم.
 *  - دورٌ له صفوف roleBranches صريحة ⇒ يُقيَّد بتلك المجموعة (فحص عضوية).
 *  - غير ذلك ⇒ فرعه المفرد فقط (السلوك الحاليّ حرفياً) — لا رفعَ مديريّ ضمنيّ من النطاق.
 */

/** allowedBranchIds=null ⇒ كل الفروع (admin أو «كل الفروع» الصريح)؛ مصفوفة ⇒ العضوية المسموحة. */
export type AllowedBranches = number[] | null;

export interface BranchScopeInput {
  role: string;
  /** فرع المستخدم المفرد المخزَّن (users.branchId). */
  userBranchId: number | null;
  /** فروع الدور الصريحة (roleBranches) — فارغة = لا قيد دور، فيُستعمَل فرعه المفرد. */
  roleBranchIds?: number[];
  /** هل مُنح الدور «كل الفروع» صراحةً؟ (قرارٌ مُدقَّق منفصلٌ عن الرفع المديريّ). */
  allBranches?: boolean;
}

/**
 * يشتقّ النطاق الفعليّ (AllowedBranches). null = كل الفروع. مصفوفة = العضوية.
 * ملاحظة أمنية (تصحيح المراجعة العدائية): «كل الفروع» **قرارٌ صريح** (admin أو allBranches) لا يُشتقّ
 * من كون الدور مديرياً — فدورٌ أساسه manager بفروعٍ محدّدة يبقى مقيّداً بها، لا يقفز إلى «كل الفروع».
 */
export function deriveAllowedBranches(input: BranchScopeInput): AllowedBranches {
  if (input.role === "admin" || input.allBranches) return null;
  if (input.roleBranchIds && input.roleBranchIds.length > 0) {
    return Array.from(new Set(input.roleBranchIds));
  }
  return input.userBranchId != null ? [input.userBranchId] : [];
}

/** هل الفرع المطلوب ضمن النطاق المسموح؟ null ⇒ نعم دائماً (كل الفروع). */
export function isBranchAllowed(allowed: AllowedBranches, branchId: number | null | undefined): boolean {
  if (allowed === null) return true;
  if (branchId == null) return false;
  return allowed.includes(Number(branchId));
}
