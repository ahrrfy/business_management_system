/**
 * canCrossBranches — «هل يعبُر هذا الفاعل كلَّ الفروع؟»
 *
 * **نسخةُ `shared/`** من [`server/lib/branchAuthority.ts`](../../server/lib/branchAuthority.ts) —
 * دالّةٌ نقيّة بلا استيراد، صالحةٌ للعميل والخادم معاً. الأصلُ في `server/lib/` لا يُستورَد من العميل
 * (يجرّ رمزَ خادمٍ)، والعميل يكتب اليوم النسخة نفسها **يدوياً** في ≥١٠ ملفّات
 * (`role === "admin" || isOwner === true` بتنويعاتٍ) — راجع D2 في مقياس الاحتكاك (§٤).
 *
 * **القاعدة الحاكمة (قرار المالك ١٢/٨/٢٦: عزل مدير الفرع):**
 *   يعبُر كلَّ الفروع (قراءةً وكتابةً) = **admin** (تصحيح إداريّ) + **المالك isOwner** فقط.
 *   مدير الفرع (`role="manager"` بلا `isOwner`) **ليس منهم** ⇒ مقيَّدٌ بفرعه المُسنَد قراءةً وكتابةً.
 *
 * **دفاعٌ في العمق:** المالك يُطبَّع إلى `role="admin"` في `context.ts` (`normalizeOwnerAuthority`)
 * قبل أيّ middleware/خدمة، لذا في طبقة الخدمة (`actor.role` مُطبَّع) يكفي `role==="admin"`؛ ونُبقي
 * فحص `isOwner` صراحةً كي يبقى المسند صحيحاً عند تمرير البصمة كاملةً (كما في `ctx.user`) بلا تطبيع.
 *
 * ⚠️ **الإنفاذ النهائيّ خادميّ دائماً** (CLAUDE.md §٢). هذا المسند لأدوات العرض والاشتقاق فقط —
 * الشاشة تُخفي زرّاً بناءً عليه، والخادم يعيد فحصه في `branchScopedProcedure`.
 *
 * **لا يُوصَل في هذه الشريحة** — استخراجٌ إضافةٌ لا هدم (م٥). نسخةُ `server/lib/branchAuthority.ts`
 * تبقى تعمل حرفياً كما هي؛ الوصلُ يحدث في شريحةٍ لاحقة تحت `check:vocabulary`.
 */

/** الشكل الأدنى للفاعل الذي يكفي لاتّخاذ القرار — يتوافق مع `ctx.user` و`actor` معاً. */
export type BranchActor = {
  role?: string | null;
  isOwner?: boolean | null;
};

/**
 * ⭐ هل يعبُر هذا الفاعل كلَّ الفروع؟ (المالك/الأدمن نعم؛ مدير الفرع لا — قرار المالك ١٢/٨).
 *
 * @example
 *   canCrossBranches({ role: "admin" })                  // true
 *   canCrossBranches({ role: "manager", isOwner: true }) // true — المالك بأيّ دور
 *   canCrossBranches({ role: "manager" })                // false — مقيَّد بفرعه
 *   canCrossBranches({ role: "cashier" })                // false
 *   canCrossBranches(null)                               // false — لا فاعل ⇒ لا سلطة
 */
export function canCrossBranches(actor: BranchActor | null | undefined): boolean {
  if (!actor) return false;
  return actor.role === "admin" || actor.isOwner === true;
}
