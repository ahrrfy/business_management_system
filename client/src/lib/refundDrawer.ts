/**
 * **منطقُ درج الاسترداد العميليّ** — ما تبقّى بعد أن صار الخادمُ مصدرَ الحقيقة.
 *
 * كان هذا الملفّ يُقرّر **بالتخمين** هل يخرج نقدٌ وكم ومن أيّ درج. ومراجعةُ Codex على #920
 * أثبتت أنّ التخمين يُنتج حوائطَ جديدة (بطاقةٌ كاملة تُعطَّل · طردٌ بلا نقدٍ يُعطَّل · عربونُ
 * مسوّدةٍ يُخفي المنتقي) — فانتقل القرارُ كلُّه إلى
 * [`shared/refundPreflight.ts`](../../../shared/refundPreflight.ts) ونقطتَي التمهيد الخادميّتين.
 *
 * الباقي هنا **عرضٌ خالص**: أيُّ درجٍ يُختار افتراضاً، ومتى يُحجَب الإرسال، ومتى يُحذَّر من عجز.
 */
import { D } from "@/lib/money";

/**
 * تحويلٌ آمنٌ إلى `Decimal` — **`decimal.js` يرمي** على مدخلٍ غير رقميّ (`Invalid argument`)،
 * وقيمُ هذه الدالّة تأتي من الشبكة فقد تصل تالفةً. أمسكه اختبارُ «تقديرٌ معطوب»: استثناءٌ هنا
 * كان سيُسقط الحوار كلَّه بدل تخطّي تحذيرٍ تجميليّ.
 */
function safeDecimal(v: string | number | null | undefined): ReturnType<typeof D> | null {
  if (v == null || v === "") return null;
  try {
    const d = D(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** درجٌ مؤهَّلٌ كما يُعيده التمهيد — مُصفّى خادمياً بالفرع والنوع. */
export interface RefundDrawerOption {
  shiftId: number;
  userId: number;
  userName: string;
  shiftType: string;
  expectedCash?: string | null;
}

/**
 * الدرجُ الافتراضيّ — **درج المنفّذ نفسه إن كان مفتوحاً** (قرار المالك، نمط
 * [`ReturnComposer`](../components/returns/ReturnComposer.tsx))، وإلّا الوحيدُ المفتوح.
 *
 * وحين يتعدّد الدرجُ ولا يملك المنفّذ واحداً ⇒ `null`: **لا تخمين**. نسبةُ نقدٍ خارجٍ إلى
 * درجٍ لم يخرج منه تُفسد تسوية درجَين معاً (§٥ — لكلّ دينارٍ مسارٌ منسوبٌ لفاعله).
 */
export function pickDefaultRefundDrawer(
  drawers: readonly RefundDrawerOption[],
  currentUserId: number | null | undefined,
): number | null {
  if (drawers.length === 0) return null;
  if (currentUserId != null) {
    const mine = drawers.find((d) => d.userId === currentUserId);
    if (mine) return mine.shiftId;
  }
  return drawers.length === 1 ? drawers[0].shiftId : null;
}

/**
 * سببُ حجب الإرسال — نصٌّ يُعرَض **قبل** الضغط بدل رفضٍ متأخّر من الخادم.
 *
 * `needed = false` (التمهيد يقول لا نقدَ يخرج) ⇒ **لا حجبَ إطلاقاً** ولو لم تكن ثمّة وردية
 * مفتوحة — وهذا بالضبط ما كان معطوباً: إرجاعٌ بلا نقدٍ واسترجاعُ فاتورةٍ بطاقية كانا يُعطَّلان.
 */
export function refundDrawerBlockReason(args: {
  needed: boolean;
  drawers: readonly RefundDrawerOption[];
  selectedShiftId: number | null;
  /** وصفُ نوع الدرج المطلوب في رسالة «لا يوجد» — مثلاً «وردية استقبال». */
  emptyLabel: string;
}): string | null {
  if (!args.needed) return null;
  if (args.drawers.length === 0) {
    return `لا توجد ${args.emptyLabel} مفتوحة في هذا الفرع — افتح ورديةً أولاً ليخرج منها النقد.`;
  }
  if (args.selectedShiftId == null) return "حدّد الدرج الذي سيخرج منه النقد فعلياً.";
  if (!args.drawers.some((d) => d.shiftId === args.selectedShiftId)) {
    return "الدرج المحدَّد لم يعد مفتوحاً — اختر درجاً آخر.";
  }
  return null;
}

/**
 * **تحذيرُ عجزِ الدرج — لا حجب.**
 *
 * `assertCashOutAvailable` يرفض سحباً يتجاوز نقدَ الدرج؛ وهو حائطٌ يلقاه المعالِج **بعد**
 * الضغط بلا معرفةِ أيّ درجٍ يكفي. فنُظهر المتاحَ سلفاً ونحذّر حين لا يكفي المختار.
 *
 * ⚠️ **المقارنةُ بـ`Decimal` لا بـ`Number`** (مراجعة Codex P2): جمعُ `0.10 + 0.20` بالعائم
 * يُنتج `0.30000000000000004` فيُعلَن عجزٌ كاذبٌ أمام درجٍ فيه `0.30` بالضبط. والقاعدةُ في
 * §٥ صريحة: لا `parseFloat`/`Number` على مال.
 *
 * ⛔ **ولا يحجب**: المبلغُ تقديرُ الخادم قبل المعاملة وقد يتغيّر بينها؛ حجبُ الإرسال عليه
 * يصنع حائطاً ثانياً أسوأ من الأوّل — فالخادمُ هو الحَكَم، ونحن نُنير الطريق قبله.
 */
export function drawerShortfallWarning(args: {
  drawers: readonly RefundDrawerOption[];
  selectedShiftId: number | null;
  estimatedAmount: string | number | null | undefined;
}): { shiftId: number; availableCash: string; needed: string } | null {
  if (args.selectedShiftId == null) return null;
  const raw = args.estimatedAmount;
  const need = safeDecimal(raw);
  if (need == null || need.lte(0)) return null;
  const picked = args.drawers.find((d) => d.shiftId === args.selectedShiftId);
  if (!picked) return null;
  const available = safeDecimal(picked.expectedCash);
  if (available == null || available.gte(need)) return null;
  return { shiftId: picked.shiftId, availableCash: String(picked.expectedCash), needed: String(raw) };
}

/**
 * هل **ردّ الخادمُ بكودٍ صريح**؟ ⇒ النتيجة حتميّة ولا مجالَ لوصفها «مجهولة».
 *
 * الرفضُ `PRECONDITION_FAILED`/`FORBIDDEN`/`BAD_REQUEST` يقع قبل أيّ كتابة داخل `withTx`
 * ⇒ لم يحدث شيء، يقيناً. ووسمُه «لم نتأكّد من النتيجة؛ أعد المحاولة بالمعرّف نفسه» يدفع
 * الموظّف لتكرار محاولةٍ ستفشل بنفس الطريقة أبداً. الغموضُ حقيقيٌّ **فقط** حين لا يردّ
 * الخادم بكودٍ أصلاً (انقطاعُ نقل). نفسُ الإصلاح في [`Reception.tsx`](../pages/Reception.tsx) (١٩/٨).
 */
export function serverAnsweredDeterministically(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code != null;
}
