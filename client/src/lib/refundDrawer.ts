/**
 * **اختيارُ درج الاسترداد النقديّ** — إغلاقُ بابٍ مسدود (٣١/٨).
 *
 * الخادم يقبل `refundShiftId` على كلّ مسارٍ يُخرج نقداً منذ مدّة، ويرفض صراحةً حين يتعدّد
 * الدرجُ المفتوح طالباً التحديد. لكنّ ثلاث شاشات **لم ترسله قطّ** — فالرسالة تطلب تحديد
 * الدرج والشاشة لا تملك حقلاً لتحديده:
 *
 *  · [`WorkOrderDetail`](../pages/WorkOrderDetail.tsx) — إلغاء الأمر + استرجاع التسليم
 *  · [`WorkOrders`](../pages/WorkOrders.tsx)           — إلغاء الأمر من اللوحة
 *  · [`DeliveryHub`](../pages/DeliveryHub.tsx)         — رجوع الطرد
 *
 * فأمرٌ بعربونٍ نقديّ يصير **غير قابلٍ للإلغاء طوال ساعات العمل** كلّما فُتحت ورديتان —
 * وهو نفسُ العطب الذي عولج مرّةً لـ`reception.refundDeposit` («كان الردّ النقديّ ميتاً
 * طوال ساعات العمل بورديتين»، [receptionRouter.ts](../../../server/routers/receptionRouter.ts))
 * ثمّ لم يُكنَس إلى أشقّائه.
 *
 * ⚠️ **الرافدان ليسا واحداً — لا توحّدهما:** مسارُ أمر الشغل يقصر الأدراج على
 * `shiftType='RECEPTION'` ([`cancel.ts`](../../../server/services/workOrder/cancel.ts)
 * `resolveLockedReceptionCashShift`)، بينما مسارُ التوصيل يقبل أيّ درجٍ مفتوح بالفرع
 * ([`shiftService.ts`](../../../server/services/shiftService.ts) `resolveBranchCashShiftTx`).
 * منتقٍ يعرض درج POS لمسار أمر الشغل يُعيد **نفس رسالة الرفض** بعد الاختيار — أي بابٌ
 * مسدودٌ ثانٍ يرتدي ثوب الحلّ. لذلك `requiredShiftType` معاملٌ إلزاميّ الذكر لا افتراضَ له.
 */

/** أقلُّ ما يلزم من بطاقة الوردية (`treasury.getOpenShifts`) لاختيار الدرج. */
export interface RefundDrawerOption {
  shiftId: number;
  userId: number;
  userName: string;
  shiftType: string;
  /**
   * النقدُ المتاح في الدرج الآن — `openingBalance + cashIn − cashOut` بنفس مُرشِّح
   * `MATERIALIZED_DRAWER_CASH` الذي يقيس به `assertCashOutAvailable` خادمياً، فالتقديرُ
   * هنا يطابق حكمَ الخادم ولا يخالفه.
   */
  expectedCash?: string | null;
}

/**
 * الأدراجُ المؤهَّلة فعلاً للمسار المطلوب.
 *
 * `requiredShiftType = null` ⇒ أيّ درجٍ مفتوح (مسار التوصيل/العربون).
 * وقيمةٌ نصّية ⇒ يُقصَر على نوعها (مسار أمر الشغل: RECEPTION وحدها).
 */
export function eligibleRefundDrawers<T extends { shiftType: string }>(
  drawers: readonly T[],
  requiredShiftType: string | null,
): T[] {
  if (requiredShiftType == null) return [...drawers];
  return drawers.filter((d) => d.shiftType === requiredShiftType);
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
 * `needed = false` (لا نقدَ يخرج: عربونٌ بطاقة، أو صفر) ⇒ لا حجبَ إطلاقاً. كان هذا جذرَ
 * بلاغٍ سابق في `ReturnComposer`: شاشةٌ تطلب درجاً لردّ نقدٍ لم يُقبض.
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
 * `assertCashOutAvailable` يرفض سحباً يتجاوز نقدَ الدرج الحاليّ؛ وهو حائطٌ يلقاه المعالِج
 * **بعد** الضغط بلا معرفةِ أيّ درجٍ يكفي. فنُظهر المتاحَ لكلّ درجٍ سلفاً، ونحذّر حين لا يكفي
 * المختار.
 *
 * ⛔ **ولا نحجب**: المبلغُ هنا **تقديرٌ** (العربون + الأمانة) وقد تُضيفُ إليه الخدمةُ حصصَ
 * عربونٍ مطبَّقة أو تُنقص منه. حجبُ الإرسال على تقديرٍ يصنع حائطاً ثانياً أسوأ من الأوّل —
 * فالخادمُ هو الحَكَم، ونحن نُنير الطريق قبله لا نُغلقه دونه.
 */
export function drawerShortfallWarning(args: {
  drawers: readonly RefundDrawerOption[];
  selectedShiftId: number | null;
  estimatedAmount: string | number | null | undefined;
}): { shiftId: number; availableCash: string; needed: string } | null {
  if (args.selectedShiftId == null) return null;
  const need = toFiniteAmount(args.estimatedAmount);
  if (need == null || need <= 0) return null;
  const picked = args.drawers.find((d) => d.shiftId === args.selectedShiftId);
  const available = toFiniteAmount(picked?.expectedCash);
  if (picked == null || available == null || available >= need) return null;
  return { shiftId: picked.shiftId, availableCash: String(picked.expectedCash ?? "0"), needed: String(need) };
}

/** تحويلٌ آمن لقيمةٍ ماليّة نصّية إلى رقمٍ للمقارنة وحدها (لا لحسابٍ يُخزَّن). */
function toFiniteAmount(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * هل يخرج ردُّ هذه الطريقة **نقداً من الدرج**؟
 *
 * `TELECOM` (رصيد زين) يُردّ نقداً رغم قبضه رصيداً: لا سكّةَ ردٍّ له — إيصالُ OUT بـTELECOM
 * يُنقص حساباً مشتقّاً بينما الرصيد الحقيقيّ لا يتحرّك
 * ([`cancel.ts`](../../../server/services/workOrder/cancel.ts)). إغفالُه هنا يُخفي المنتقي
 * عن حالةٍ تحتاجه فعلاً ⇒ البابُ المسدود يعود من بابٍ خلفيّ.
 */
export function refundExitsCashDrawer(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === "CASH" || paymentMethod === "TELECOM";
}

/**
 * هل يلزم إلغاءُ أمر الشغل درجَ نقدٍ؟ ثلاثةُ روافدَ تُخرج نقداً عند الإلغاء
 * ([`cancel.ts`](../../../server/services/workOrder/cancel.ts)):
 * العربونُ المقبوض نقداً/رصيداً · حصصُ العربون المطبَّقة · **وأمانةُ أجرة التوصيل — نقداً دائماً**.
 *
 * الأمانةُ وحدها كافية: طلبٌ بعربونِ بطاقةٍ وأجرةِ توصيلٍ نقديّة يحتاج الدرجَ رغم أنّ
 * «طريقة دفع العربون» ليست نقداً.
 *
 * ⚠️ يقبل `deposit` نصّاً (`decimal` من القاعدة) — القياسُ بـ`D` لا بـ`Number` (§٥).
 */
export function workOrderCancelNeedsCashDrawer(args: {
  deposit: string | number | null | undefined;
  paymentMethod: string | null | undefined;
  /** صافي أمانة أجرة التوصيل المحتجزة (`workOrders.deliveryFeeHeld`). */
  deliveryFeeHeldNet: string | number | null | undefined;
}): boolean {
  const gtZero = (v: string | number | null | undefined) => (toFiniteAmount(v) ?? 0) > 0;
  if (gtZero(args.deliveryFeeHeldNet)) return true;
  return gtZero(args.deposit) && refundExitsCashDrawer(args.paymentMethod);
}

/**
 * **تقديرُ** النقد الخارج عند إلغاء أمر الشغل — للإنارة لا للحساب.
 *
 * العربونُ النقديّ (أو رصيدُ زين) + أمانةُ أجرة التوصيل. قد تُضيف الخدمةُ حصصَ عربونٍ
 * مطبَّقة، فهو **حدٌّ أدنى** لا رقمٌ نهائيّ — ولذلك يُستعمَل في تحذيرٍ لا في حجب.
 */
export function estimatedWorkOrderCancelCashOut(args: {
  deposit: string | number | null | undefined;
  paymentMethod: string | null | undefined;
  deliveryFeeHeldNet: string | number | null | undefined;
}): number {
  const depositOut = refundExitsCashDrawer(args.paymentMethod) ? toFiniteAmount(args.deposit) ?? 0 : 0;
  return Math.max(0, depositOut) + Math.max(0, toFiniteAmount(args.deliveryFeeHeldNet) ?? 0);
}

/**
 * هل **ردّ الخادمُ بكودٍ صريح**؟ ⇒ النتيجة حتميّة ولا مجالَ لوصفها «مجهولة».
 *
 * الرفضُ `PRECONDITION_FAILED`/`FORBIDDEN`/`BAD_REQUEST` يقع قبل أيّ كتابة داخل `withTx`
 * ⇒ لم يحدث شيء، يقيناً. ووسمُه «لم نتأكّد من النتيجة؛ أعد المحاولة بالمعرّف نفسه» يدفع
 * الموظّف لتكرار محاولةٍ ستفشل بنفس الطريقة أبداً، ويَسِمُ المستند «بانتظار المالك» بلا
 * شيءٍ معلّق. الغموضُ حقيقيٌّ **فقط** حين لا يردّ الخادم بكودٍ أصلاً (انقطاعُ نقل).
 *
 * نفسُ الإصلاح جرى في [`Reception.tsx`](../pages/Reception.tsx) على بلاغٍ حيّ للمالك
 * (١٩/٨) ولم يُكنَس إلى شاشات أوامر الشغل — فتكرّر البلاغ.
 */
export function serverAnsweredDeterministically(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code != null;
}
