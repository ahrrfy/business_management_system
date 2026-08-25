// أنماط CSS موحّدة لعناصر النموذج الأصيلة (native form controls).
// كانت ~٩٠ شاشةً تُكرّر النصّ نفسه (`selectCls`) محلياً بانحرافات دقيقة:
// h-9 vs h-8 · px-3 vs px-2 · مع/بلا w-full · shadow-xs vs shadow-sm ⇒ تدرّجٌ بصريّ بلا حاكم.
// المصدر الواحد هنا يضمن الاتّساق ويسهّل تعديل المقاس/الحافّة مركزياً.
//
// الأخصّ يفوز: للـ<select> استعمل `AppSelect` من مكوّنات النموذج. هذه للحالات التي يبقى
// فيها العنصر أصيلاً (كأن يكون مضمّناً بشدّة في `<label>` أو تحتاج فتحاً طبيعياً لمنصّة).

/** حقل اختيار قياسيّ (h-9). العرض يتحدَّد من الأب (grid/flex). */
export const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** حقل اختيار قياسيّ يملأ عرض الأب — للحقول داخل bocxs عمودية بلا شبكة. */
export const selectClsFull =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** حقل اختيار مضغوط (h-8) — لصفوف الفلاتر داخل الجداول والقوائم. */
export const selectClsSm =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
