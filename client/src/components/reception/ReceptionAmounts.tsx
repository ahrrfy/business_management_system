import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import { useEffect } from "react";
import { D, round2, roundCashIQD } from "@/lib/money";
import {
  customLineGrand,
  isCustomKind,
  lineCounterHeldFee,
  lineTotal,
  type CartLine,
  type PayMethod,
} from "@/components/reception/cartMath";

export interface ReceptionAmountsInput {
  cart: import("@/components/reception/cartMath").CartLine[];
  orderDelivery: OrderDeliveryValue | null;
  activeDraft: { id: number; version: number } | null;
  offline: boolean;
  invoiceDiscountPct: string;
  draftHeld: string;
  method: import("@/components/reception/cartMath").PayMethod;
  splitPayment?: { hasCash: boolean; hasNonCash: boolean };
  payInput: string;
  customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer;
  phoneResolution: import("@/components/customer/customerByPhoneMachine").PhoneResolution;
  deferred: boolean;
  setDeferred: React.Dispatch<React.SetStateAction<boolean>>;
}
export function useReceptionAmounts({
  cart,
  orderDelivery,
  activeDraft,
  offline,
  invoiceDiscountPct,
  draftHeld,
  method,
  splitPayment,
  payInput,
  customer,
  phoneResolution,
  deferred,
  setDeferred,
}: ReceptionAmountsInput) {
  const allCash = splitPayment ? splitPayment.hasCash && !splitPayment.hasNonCash : method === "CASH";
  const cartCount = cart.reduce((s, c) => s + c.qty, 0);
  const hasDigitalCards = cart.some((line) => line.digital);
  const sumDirectD = cart
    .filter((c) => !isCustomKind(c))
    .reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  // ٢٣/٨ — البيع الخالص (لا طباعة ولا تخصيص) هو وحده وعاء خصم رأس الفاتورة: عقد الخادم
  // (workOrderRouter.receptionCheckout.regularSale.invoiceDiscount) يمرّره لـcreateSaleInTx
  // الذي يحسبه على فاتورة البيع فقط. `printSale` فاتورةٌ مستقلّة و«التخصيص» أمرُ شغلٍ (workOrder).
  const regularSumRawD = cart
    .filter((c) => !isCustomKind(c) && !c.row.isPrintService && !c.digital)
    .reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumCustomD = cart
    .filter((c) => isCustomKind(c))
    .reduce((s, c) => s.plus(D(customLineGrand(c))), D(0));
  // ٢٣/٨ — خصمُ رأس الفاتورة (سلطة الكاشير ٠–١٥٪ كما في POS): يُطبَّق **قبل** حساب grandTotal
  // ⇒ التقريب النقديّ والعربون المحتجَز والمقبوض النقديّ كلّها تُقاس على الصافي بعد الخصم بلا مسّ
  // أيّ حاسوبٍ خلفيّ. `regularSale.invoiceDiscount` يُبعث للخادم مبلغاً مطلقاً لينفّذ الحماية نفسها
  // على invoice.discountAmount (invoiceDiscountExceedsThreshold على الإجماليّ).
  //
  // **السقف الفعّال المتبقّي** (مرآة POS.tsx حرفياً): بوّابة الخادم تقيس (refGross − invoiceNet)/refGross
  // مقابل ١٥٪، وترى انحراف السطر (عرض/كوبون/خصم يدويّ) والرأس معاً. لولا هذا: سلّةٌ عليها عرضٌ ١٠٪
  // + خصمُ رأسٍ ١٠٪ = انحراف ١٩٪ ⇒ رفضٌ خادميّ يُفاجأ به الكاشير (بلاغ Codex P1).
  // الكروت الرقمية ثابتة السعر ولا تدخل وعاء خصم رأس الفاتورة.
  const CASHIER_INVOICE_DISCOUNT_MAX_PCT = 15;
  const regularReferenceGrossD = cart
    .filter((c) => !isCustomKind(c) && !c.row.isPrintService && !c.digital)
    .reduce((s, c) => {
      // بلا خصمٍ يدويّ = سعرُ القائمة (السعرُ الأصل قبل الخصم) × الكمية. `origPrice` يُضبَط من
      // Popover خصم السطر ⇒ نستعمله مرجعاً كي يحسب الانحراف السطريّ المسبق.
      const refUnit = D(c.origPrice ?? c.row.price ?? 0);
      return s.plus(refUnit.times(c.qty));
    }, D(0));
  const priorLineDeviationRatioD = regularReferenceGrossD.gt(0)
    ? regularReferenceGrossD.minus(regularSumRawD).div(regularReferenceGrossD)
    : D(0);
  const remainingHeaderAuthorityFractionD = D(0.15).minus(
    priorLineDeviationRatioD,
  );
  const remainingHeaderPctOnSubtotalD =
    regularSumRawD.gt(0) && regularReferenceGrossD.gt(0)
      ? remainingHeaderAuthorityFractionD
          .times(regularReferenceGrossD)
          .div(regularSumRawD)
          .times(100)
      : D(CASHIER_INVOICE_DISCOUNT_MAX_PCT);
  const effectiveHeaderCapPctD = (
    remainingHeaderPctOnSubtotalD.lt(0)
      ? D(0)
      : remainingHeaderPctOnSubtotalD.gt(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
        ? D(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
        : remainingHeaderPctOnSubtotalD
  ).toDecimalPlaces(2, 1 /* ROUND_DOWN */);
  const effectiveHeaderCapPct = effectiveHeaderCapPctD.toNumber();
  // فخّ decimal.js (Codex P1): `D(".") throws`. لا نمرّر إلى `D()` إلّا سلسلةً قابلةً للتحليل.
  // الشاشة تحرس الإدخال أيضاً، لكنّ هذا الفحص هنا الحدّ الأخير قبل عمليات الرياضيات.
  const rawInvoiceDiscountPctD = (() => {
    if (!invoiceDiscountPct) return D(0);
    const num = Number(invoiceDiscountPct);
    if (!Number.isFinite(num) || num < 0) return D(0);
    try {
      return D(invoiceDiscountPct);
    } catch {
      return D(0);
    }
  })();
  const clampedInvoiceDiscountPctD = rawInvoiceDiscountPctD.gt(
    effectiveHeaderCapPctD,
  )
    ? effectiveHeaderCapPctD
    : rawInvoiceDiscountPctD;
  // ٢٣/٨ — Codex P1: خصمُ رأس الفاتورة لا يعبر المسوّدة حالياً — `buildDraftPayload` ليس لديه
  // حقلٌ يحمله، وعقدُ `commitDraft` يعيد بناء الإجمالي من الأسطر الخام فيرفض التثبيت لأنّ الصافي
  // لا يطابق. إخفاءُ الحقل عند وجود مسوّدة يمنع تسرّبَه لعقدٍ لا يفهمه — الشريحة الأوسع (توسيع
  // عقد المسوّدة) شغلٌ منفصل بمهاجرةٍ وحقولٍ خادميّة إضافيّة.
  const invoiceDiscountAllowed =
    regularSumRawD.gt(0) && !activeDraft && !hasDigitalCards;
  const invoiceDiscountAmountD = invoiceDiscountAllowed
    ? round2(regularSumRawD.times(clampedInvoiceDiscountPctD).div(100))
    : D(0);
  const invoiceDiscountAmount = invoiceDiscountAmountD.toNumber();
  const regularSumNetD = regularSumRawD.minus(invoiceDiscountAmountD);
  const sumDirectNetD = sumDirectD.minus(invoiceDiscountAmountD);
  const grandTotalD = sumDirectNetD.plus(sumCustomD);
  const grandTotal = round2(grandTotalD).toNumber();
  const sumDirect = round2(sumDirectD).toNumber();
  const sumCustom = round2(sumCustomD).toNumber();
  // ٥/٨ — أجرة توصيلٍ تُقبض الآن أمانةً للمندوب: نقدٌ يدخل الدرج **خارج** الفاتورة (ليست بيعاً).
  // تُعرَض منفصلةً كي يعرف الموظّف كم يستلم فعلاً، ولا تُخلَط بإجمالي الفاتورة ولا بالمبلغ المُطبَّق.
  // ش٦: أجرة توصيل **الطلب** (COUNTER) تنضمّ لنفس العرض — نفس أمانة الدرج بالضبط.
  const orderFeeHeldD =
    orderDelivery?.feeCollection === "COUNTER"
      ? round2(D(orderDelivery.fee || 0))
      : D(0);
  const heldDeliveryD = round2(
    (orderDelivery && !cart.some((line) => !isCustomKind(line))
      ? D(0)
      : cart.reduce((s, c) => s.plus(D(lineCounterHeldFee(c))), D(0)))
      .plus(orderFeeHeldD),
  );
  const heldDelivery = heldDeliveryD.toNumber();
  const cashDueNow = round2(grandTotalD.plus(heldDeliveryD)).toNumber();
  // ٨/٨ — شفافية أجرة التوصيل في الشريط السفليّ لكلّ المسارات: من «توصيل هذا الطلب» إن وُجِد،
  // وإلّا من كتل التخصيص التي فُعِّل فيها التوصيل (COURIER/SHOP كانت تختفي كلياً على مسار التخصيص).
  // COUNTER يُعرَض عبر heldDelivery أعلاه (لا يُكرَّر هنا). الأجرة عرضٌ فقط — لا تدخل إيراداً أبداً.
  const customDeliveryLinesD = cart.filter(
    (c) =>
      isCustomKind(c) &&
      c.custom?.hasDelivery &&
      D(c.custom.deliveryCost || 0).gt(0),
  );
  const deliveryDisclosure = orderDelivery
    ? {
        fee: round2(D(orderDelivery.fee || 0)).toNumber(),
        feeCollection: orderDelivery.feeCollection,
        partyName: orderDelivery.partyName ?? "",
      }
    : customDeliveryLinesD.length > 0
      ? {
          fee: round2(
            customDeliveryLinesD.reduce(
              (s, c) => s.plus(D(c.custom!.deliveryCost || 0)),
              D(0),
            ),
          ).toNumber(),
          feeCollection: customDeliveryLinesD[0].custom!.deliveryFeeCollection,
          partyName: "التوصيل",
        }
      : null;

  // ش٠ (٥/٨، V1) — تقريب نقدي IQD لأقرب ٢٥٠ (نمط POS حرفياً): للبيع المباشر **الخالص** النقديّ
  // فقط (لا تخصيص ولا خدمات طباعة — السلة المختلطة بلا تقريبٍ حتى ش٦)، وأونلاين فقط: مسار
  // الالتقاط الأوفلايني يلتقط المبالغ غير المقرَّبة، فتفعيل التقريب معه يفصل ما رآه الزبون عمّا
  // سيُرحَّل (فرقٌ في الدرج يمنع الإغلاق). roundCashIQD نفس دالة الخادم ⇒ اتفاقٌ حتميّ على الفرق
  // الذي يقيّده الخادم قيدَ ADJUST.
  const hasPrintInCart = cart.some(
    (c) => !isCustomKind(c) && c.row.isPrintService,
  );
  // مراجعة ش٤: مرآة شرط الخادم — لو أنزل التقريبُ الإجماليَّ إلى/تحت العربون المقبوض سلفاً
  // لَسُدَّ الطريق النقديّ (المتوقّع 0 والخادم يطالب بالفارق الخام) ⇒ يسقط التقريب حينها.
  const draftHeldEarlyD = D(draftHeld || 0);
  const splitRoundingEligible = !splitPayment || (!deferred && D(payInput || 0).plus(draftHeldEarlyD).gte(roundCashIQD(grandTotalD.toFixed(2))));
  const roundedWouldTrapHeld =
    draftHeldEarlyD.gt(0) &&
    roundCashIQD(grandTotalD.toFixed(2)).lte(draftHeldEarlyD);
  const cashRoundActive =
    allCash &&
    splitRoundingEligible &&
    cart.length > 0 &&
    !hasDigitalCards &&
    !cart.some(isCustomKind) &&
    !hasPrintInCart &&
    !offline &&
    !roundedWouldTrapHeld;
  // ش٦ — تقريب السلّة المختلطة (مرآة materialize/checkout حرفياً): فرق تقريب السلّة كلّها
  // يُحمَّل على الفاتورة الحاملة (بضاعة ثم طباعة). يسري **فقط** حين يُدفع المقرَّب كاملاً نقداً
  // الآن (يُحسم عند الإرسال) — هنا نحسب أهليّته ونعرض المقرَّب لأن المسار الاعتيادي دفعٌ كامل.
  const sumGoodsRawD = cart
    .filter((c) => !isCustomKind(c) && !c.row.isPrintService)
    .reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumPrintRawD = cart
    .filter((c) => !isCustomKind(c) && c.row.isPrintService)
    .reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const mixedCarrier: "SALE" | "PRINT" | null = sumGoodsRawD.gt(0)
    ? "SALE"
    : sumPrintRawD.gt(0)
      ? "PRINT"
      : null;
  const mixedDeltaD = round2(
    roundCashIQD(grandTotalD.toFixed(2)).minus(grandTotalD),
  );
  const mixedRoundEligible =
    allCash &&
    splitRoundingEligible &&
    cart.length > 0 &&
    !hasDigitalCards &&
    !cashRoundActive &&
    !offline &&
    !roundedWouldTrapHeld &&
    (cart.some(isCustomKind) || hasPrintInCart) &&
    mixedCarrier != null &&
    !mixedDeltaD.isZero() &&
    (mixedCarrier === "SALE" ? sumGoodsRawD : sumPrintRawD)
      .plus(mixedDeltaD)
      .gt(0);
  const roundingDisplayActive = cashRoundActive || mixedRoundEligible;
  const effectiveGrandD = roundingDisplayActive
    ? roundCashIQD(grandTotalD.toFixed(2))
    : grandTotalD;
  const cashRoundingDelta = roundingDisplayActive
    ? round2(effectiveGrandD.minus(grandTotalD)).toNumber()
    : 0;

  // ش٤: العربون المقبوض سلفاً على الطلب المحفوظ يقلّص «المتوقّع الآن» — الزبون دفعه فعلاً
  // وإيصاله قائم؛ collectNow عند التثبيت هو الجزء الجديد وحده (I5).
  const heldD = draftHeldEarlyD;
  // الدفع موحّد على كامل السلة. البيع المباشر هو الحد الأدنى؛ وما زاد يصبح عربوناً لأوامر الطباعة.
  const dueNowRawD = effectiveGrandD.minus(heldD);
  const expectedNowD = dueNowRawD.lt(0) ? D(0) : dueNowRawD;
  const expectedNow = round2(expectedNowD).toNumber();

  // ما أدخله الكاشير في لوحة الأرقام (مع تكيّف Quick Pay).
  const paidD = D(payInput || 0);
  const paid = round2(paidD).toNumber();
  const changeD = paidD.minus(expectedNowD);
  const change = round2(changeD).toNumber();
  const remainingD = expectedNowD.minus(paidD);
  const remaining = round2(remainingD).toNumber();
  const isChange = (splitPayment ? splitPayment.hasCash : method === "CASH") && paidD.gt(0) && paidD.gte(expectedNowD);
  const isOwing = paidD.gt(0) && paidD.lt(expectedNowD);

  const hasCustom = cart.some(isCustomKind);
  // البيع متاح لكل عميل مرتبط بلا قيود حد ائتمان — التحصيل والنقود لها شاشات مستقلة
  const deferredAvailable =
    customer.customerId != null &&
    phoneResolution === "RESOLVED" &&
    !activeDraft &&
    !orderDelivery &&
    sumDirect > 0;
  // سبب تعطيل زرّ «بدون عربون» عند عدم توفّره.
  const deferredDisabledReason: string | null = deferredAvailable
    ? null
    : sumDirect === 0 && sumCustom > 0
      ? "لا حاجة لعربون — طلبٌ مخصّص، اضغط «إتمام الطلب» مباشرةً"
      : activeDraft
        ? "الآجل غير متاح لطلبٍ محفوظ — ثبّته مباشرةً بلا حفظ مسوّدة"
        : orderDelivery
          ? "طلب التوصيل يُحصَّل عند الاستلام — لا حاجة لوضع «آجل»"
          : customer.customerId == null || phoneResolution !== "RESOLVED"
            ? "اربط عميلاً بهاتفٍ عراقيٍّ أوّلاً"
            : "غير متاح الآن";
  useEffect(() => {
    if (deferred && !deferredAvailable) setDeferred(false);
  }, [deferred, deferredAvailable]);
  // مراجعة عدائية ٦/٨: الحقل يظهر فور اختيار طريقةٍ غير نقدية وسلّةٍ غير فارغة — كان مشروطاً
  // بمبلغٍ مُدخَل، فالمسار السريع (تحصيل المطلوب الآن) يطلب المرجع/الكود وحقله مخفيّ.
  const needPaymentRef =
    method !== "CASH" && (paidD.gt(0) || expectedNowD.gt(0));

  return {
    expectedNow,
    sumDirectNetD,
    sumCustomD,
    hasCustom,
    heldD,
    hasDigitalCards,
    rawInvoiceDiscountPctD,
    paidD,
    expectedNowD,
    mixedRoundEligible,
    effectiveGrandD,
    mixedDeltaD,
    cashRoundActive,
    regularSumRawD,
    invoiceDiscountAmountD,
    mixedCarrier,
    orderFeeHeldD,
    grandTotalD,
    heldDelivery,
    sumDirectD,
    cartCount,
    grandTotal,
    deferredAvailable,
    deferredDisabledReason,
    needPaymentRef,
    cashRoundingDelta,
    sumDirect,
    sumCustom,
    cashDueNow,
    deliveryDisclosure,
    paid,
    invoiceDiscountAmount,
    invoiceDiscountAllowed,
    CASHIER_INVOICE_DISCOUNT_MAX_PCT,
    change,
    remaining,
    isChange,
    isOwing,
  };
}
