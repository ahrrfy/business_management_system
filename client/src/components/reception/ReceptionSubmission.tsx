import { validateReceptionDigitalCart } from "@/components/reception/ReceptionDigitalValidation";
import type { RouterOutputs } from "@/lib/trpc";
import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import { isValidIqMobile } from "@/components/form/PhoneDigitsInput";
import { type CustomizationData } from "@/components/CustomizationDialog";

import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { receptionPaymentAmounts } from "./receptionPaymentAmounts";
import {
  POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE,
  isPosPaymentMethodEnabled,
} from "@shared/posPaymentPolicy";
import {
  customLineGrand,
  effectivePrice,
  isCustomKind,
  PAY_METHOD_LABEL,
  type CartLine,
  type PayMethod,
} from "@/components/reception/cartMath";

export interface ReceptionSubmissionInput {
  activeDraftRef: React.RefObject<{ id: number; version: number } | null>;
  activeDraft: { id: number; version: number } | null;
  couponCode: string | null;
  phoneResolution: import("@/components/customer/customerByPhoneMachine").PhoneResolution;
  phoneCustomer: { isPending: boolean };
  couponPreview: { isPending: boolean };
  method: import("@/components/reception/cartMath").PayMethod;
  cart: import("@/components/reception/cartMath").CartLine[];
  shift: RouterOutputs["shifts"]["current"];
  setSelKey: React.Dispatch<React.SetStateAction<string | null>>;
  offline: boolean;
  connState: import("@/lib/offline/connectivity").ConnState;
  orderDelivery: OrderDeliveryValue | null;
  deferred: boolean;
  rawInvoiceDiscountPctD: import("decimal.js").Decimal;
  opts: {
    quickFullPay: boolean;
    openingConfirmed?: boolean | undefined;
    isReservation?: boolean | undefined;
  };
  paidD: import("decimal.js").Decimal;
  payInput: string;
  sumDirectNetD: import("decimal.js").Decimal;
  expectedNowD: import("decimal.js").Decimal;
  paymentReference: string;
  mixedRoundEligible: boolean;
  heldD: import("decimal.js").Decimal;
  effectiveGrandD: import("decimal.js").Decimal;
  mixedDeltaD: import("decimal.js").Decimal;
  cashRoundActive: boolean;
  customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer;
  receptionPhone: string;
  customerSectionRef: React.RefObject<HTMLDivElement | null>;
  canCreateCustomer: boolean;
}
export async function prepareReceptionSubmission({
  activeDraftRef,
  activeDraft,
  couponCode,
  phoneResolution,
  phoneCustomer,
  couponPreview,
  method,
  cart,
  shift,
  setSelKey,
  offline,
  connState,
  orderDelivery,
  deferred,
  rawInvoiceDiscountPctD,
  opts,
  paidD,
  payInput,
  sumDirectNetD,
  expectedNowD,
  paymentReference,
  mixedRoundEligible,
  heldD,
  effectiveGrandD,
  mixedDeltaD,
  cashRoundActive,
  customer,
  receptionPhone,
  customerSectionRef,
  canCreateCustomer,
}: ReceptionSubmissionInput) {
  const draftAtSubmit = activeDraftRef.current ?? activeDraft;
  if (draftAtSubmit && couponCode) {
    notify.warn(
      "لا تثبّت طلباً محفوظاً مع كوبون",
      "أزل الكوبون؛ الطلب المحفوظ لا يملك عقد استهلاك كوبون ذرياً.",
    );
    return;
  }
  const hadActiveDraftAtSubmit = draftAtSubmit != null;
  if (
    phoneResolution === "CHECKING" ||
    phoneCustomer.isPending ||
    couponPreview.isPending
  ) {
    notify.warn(
      "انتظر اكتمال التحقق",
      "جارٍ حسم العميل أو الكوبون قبل التثبيت.",
    );
    return;
  }
  // Fail before customer creation/offline capture: a stale external method must not
  // leave an orphan customer when the checkout service rejects the payment.
  if (!isPosPaymentMethodEnabled(String(method))) {
    notify.err(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);
    return;
  }
  if (cart.length === 0) return;
  if (!shift) {
    notify.err("ابدأ الوردية أولاً قبل إتمام طلب العميل");
    return;
  }
  const invalidCustom = cart.find(
    (line) =>
      line.custom &&
      (!line.custom.title.trim() || D(effectivePrice(line)).lte(0)),
  );
  if (invalidCustom) {
    setSelKey(invalidCustom.key);
    notify.err("راجع تفاصيل أمر الشغل: العنوان وسعر البيع مطلوبان");
    return;
  }
  const directLines = cart.filter((c) => !isCustomKind(c));
  const digitalLines = directLines.filter((c) => c.digital);
  // فصل خدمات الطباعة (تُباع عبر createPrintSale) عن البيع العادي (sales.create).
  const regularLines = directLines.filter(
    (c) => !c.digital && !c.row.isPrintService,
  );
  const printLines = directLines.filter(
    (c) => !c.digital && c.row.isPrintService,
  );
  const customItems = cart.filter(isCustomKind);

  if (
    !validateReceptionDigitalCart({
      digitalLines,
      offline,
      connState,
      draftAtSubmit,
      customItems,
      printLines,
      orderDelivery,
      method,
      deferred,
      couponCode,
      rawInvoiceDiscountPctD,
      regularLines,
    })
  )
    return;
  // الطلب الخالص يثبت التوصيل على أمر الشغل؛ الفواتير تحمل الإسناد الذري.
  const hasCarrierInvoice = regularLines.length > 0 || printLines.length > 0;
  const routeDeliveryToWO = orderDelivery != null && !hasCarrierInvoice;
  // عند توجيه توصيل الطلب لأوامر الشغل، يحمل الأمر الأول الأجرة فقط.
  const effectiveWoDelivery = (custom: CustomizationData, idx: number) =>
    routeDeliveryToWO && orderDelivery
      ? {
          has: true,
          address: orderDelivery.address || custom.deliveryAddress || null,
          phone: orderDelivery.recipientPhone || custom.deliveryPhone || null,
          cost:
            idx === 0 ? round2(D(orderDelivery.fee || 0)).toFixed(2) : "0.00",
          feeColl: orderDelivery.feeCollection,
          partyName: orderDelivery.partyName as string | null,
        }
      : {
          has: custom.hasDelivery,
          address: custom.deliveryAddress || null,
          phone: custom.hasDelivery ? custom.deliveryPhone || null : null,
          cost: custom.hasDelivery
            ? round2(D(custom.deliveryCost || 0)).toFixed(2)
            : "0.00",
          feeColl: (custom.hasDelivery
            ? custom.deliveryFeeCollection
            : "COURIER") as "COURIER" | "COUNTER" | "SHOP",
          partyName: null as string | null,
        };

  // سعر كل أمر فقط؛ العربون لم يعد حقلاً على السطر، بل يوزّعه الخادم من دفعة الطلب الكلية.
  const customWithDeposits = customItems.map((c) => {
    const full = D(customLineGrand(c));
    return { c, depositStr: "0.00", salePriceStr: full.toFixed(2) };
  });

  const isReserve = !!opts.isReservation;
  if (isReserve && digitalLines.length > 0) {
    notify.err("لا يمكن حجز الكروت الرقمية؛ يجب إصدارها وتثبيتها فوراً.");
    return;
  }

  // ش٠ (V1): كل المقارنات على الإجمالي **الفعليّ** (المقرَّب عند سريان التقريب) — إرسال مبالغ
  // غير مقرَّبة مع علم التقريب كان يجعل الخادم يرى نقصاً (رفضٌ للزبون العابر) أو ذمّةً صامتة.
  // ش٤: المستحقّ الآن = الإجمالي − العربون المقبوض سلفاً (heldD) — الدفع الجديد يقاس عليه.
  // إذا لم يُدخل الكاشير مبلغاً مخصصاً في حقل المدفوع، نعتبر البيع المباشر مدفوعاً بالكامل نقداً
  const { inputPaidD, appliedPaidD } = receptionPaymentAmounts({
    paid: paidD.toFixed(2), expectedNow: expectedNowD.toFixed(2),
    hasExplicitAmount: Boolean(payInput), directNet: sumDirectNetD.toFixed(2),
    deferred, quickFullPay: opts.quickFullPay, isReservation: isReserve, method,
  });
  if (
    digitalLines.length > 0 &&
    !round2(appliedPaidD).eq(round2(expectedNowD))
  ) {
    notify.err(
      `الكروت الرقمية تتطلب تسديد كامل العملية: ${fmt(expectedNowD.toFixed(2))} د.ع.`,
    );
    return;
  }

  // غير النقد كلّه صالح كعربون، لكن بلا فكّة وبمرجع تتبّع إلزامي (كود الكارت لرصيد زين).
  if (method !== "CASH" && inputPaidD.gt(0) && !paymentReference.trim()) {
    notify.err(
      method === "CARD"
        ? "رقم عملية البطاقة مطلوب"
        : method === "WALLET"
          ? "رقم عملية المحفظة مطلوب"
          : method === "TELECOM"
            ? "أرقام كارت شحن زين (الكود) مطلوبة"
            : "رقم مرجع التحويل مطلوب",
    );
    return;
  }
  if (method !== "CASH" && inputPaidD.gt(expectedNowD)) {
    notify.err(
      `لا يمكن أن يتجاوز مبلغ ${PAY_METHOD_LABEL[method] ?? "الدفع"} المستحقّ الآن (${fmt(expectedNowD.toFixed(2))} د.ع)`,
    );
    return;
  }
  // ش٦ — التقريب المختلط يُحسم هنا: يسري فقط حين يُدفع المقرَّب **كاملاً** الآن (المرآة
  // الحرفية لشرط materialize خادمياً) — دفعةٌ جزئية تُرسَل بمبالغ خام بلا تقريب.
  const mixedRoundApplied =
    mixedRoundEligible &&
    round2(appliedPaidD.plus(heldD)).eq(round2(effectiveGrandD));
  const mixedDeltaAppliedD = mixedRoundApplied ? mixedDeltaD : D(0);
  // ٢٣/٨ — أرضيّة النقد الجزئيّ (Codex P1): تُقاس على `sumDirectNetD` (بعد خصم رأس الفاتورة)
  // لا على `sumDirectD` الخام. لولا التصحيح: خصمٌ ١٠٪ على سلّةٍ نقديّةٍ غير مقرَّبة أو بطاقةٍ/تحويلٍ
  // كان يعرض «الصافي» ٩٠٠٠ لكنّه يطالب بـ١٠٠٠٠ نقداً على الأرضيّة ⇒ تفشل عملية Quick Pay بلا سبب.
  const directFloorD = cashRoundActive
    ? effectiveGrandD
    : round2(sumDirectNetD.plus(mixedDeltaAppliedD));
  // مراجعة PR #495 — مرآة حارس الخادم حرفياً (`!input.delivery && applied.lt(directTotal)`):
  // طلبٌ يُسنَد لمندوبٍ **الدفعُ فيه عند الاستلام**، فاشتراط تغطية البضاعة نقداً الآن كان
  // يستحيل معه بيعُ COD أصلاً (وإدخالُ المبلغ لإسكات الحارس يسجّله نقداً في الدرج ⇒ عهدةُ
  // المندوب صفر ونقدٌ لم يُقبَض). المتبقّي يصير عهدةً عليه داخل نفس معاملة التثبيت.
  // بيع مباشر آجل (قرار المالك ١٠/٨): المتبقّي على البضاعة الجاهزة يصير ذمّةً على العميل المسجَّل.
  // مسار مباشر حصراً (لا مسوّدة — توزيعها يفترض دفعاً كاملاً، ولا توصيل — يُحصَّل عند الاستلام)،
  // ويلزمه عميلٌ مسجَّل (لا ذمّة بلا صاحب — createSaleInTx يرفض الآجل بلا customerId).
  if (deferred && !isReserve) {
    if (draftAtSubmit) {
      notify.err(
        "البيع الآجل غير متاح للطلب المحفوظ — ثبّته مباشرةً بلا حفظ مسوّدة",
      );
      return;
    }
    if (orderDelivery) {
      notify.err("طلب التوصيل يُحصَّل عند الاستلام — لا حاجة لوضع «آجل»");
      return;
    }
  }
  const hasCustomLines = customWithDeposits.length > 0;
  // طلب الدفع عند الاستلام يتطلب معرفة المستلم (اسمه وهاتفه)
  if (isReserve) {
    if (
      !customer.customerId &&
      (!isValidIqMobile(receptionPhone) || customer.name.trim().length < 2)
    ) {
      notify.err(
        "للدفع عند الاستلام يرجى إدخال اسم العميل ورقم هاتفه العراقي (١١ رقماً تبدأ بـ07)",
      );
      customerSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
      return;
    }
  }
  // رقم الهاتف إلزامي فقط لأوامر التخصيص/الطباعة — أما البيع المباشر النقدي فالعميل اختياري بالكامل!
  if (hasCustomLines) {
    if (!isValidIqMobile(receptionPhone)) {
      notify.err(
        "رقم هاتف العميل إلزامي لأوامر الشغل والتخصيص — أكمل ١١ رقماً عراقياً تبدأ بـ07",
      );
      customerSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
      return;
    }
    if (!canCreateCustomer) {
      notify.err(
        "دورك لا يملك بوابة ربط عميل الاستقبال — راجع إعداد صلاحية أوامر الشغل",
      );
      return;
    }
  } else if (
    receptionPhone &&
    receptionPhone.trim().length > 0 &&
    !isValidIqMobile(receptionPhone)
  ) {
    notify.err(
      "رقم الهاتف غير مكتمل — أكمل ١١ رقماً تبدأ بـ07 أو أفرغ الحقل للبيع النقدي العابر",
    );
    customerSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    return;
  }
  // الافتراضي يقبل الفواتير بدون ائتمان: وجود عميل مسجّل يحوّل أي نقص نقدي إلى آجل (ذمّة) تلقائياً.
  const directShortfallD = round2(
    directFloorD.minus(appliedPaidD).minus(heldD),
  );
  const hasDirectShortfall = directShortfallD.gt(0);
  const grandShortfallD = round2(
    effectiveGrandD.minus(appliedPaidD).minus(heldD),
  );
  const hasGrandShortfall = grandShortfallD.gt(0);

  const canAuthorizeShortfall =
    deferred ||
    isReserve ||
    (customer.customerId != null &&
      phoneResolution === "RESOLVED" &&
      !orderDelivery &&
      !draftAtSubmit);
  if (!orderDelivery && !canAuthorizeShortfall && hasDirectShortfall) {
    notify.errBig(
      `البضاعة الجاهزة تحتاج ${fmt(directFloorD.toFixed(2))} د.ع (ناقصٌ ${fmt(directShortfallD.toFixed(2))})`,
      "اربط عميلاً لتسجيل الفاتورة على حسابه (آجل)، أو أَضِف توصيلاً، أو أَكمل المبلغ الآن.",
    );
    customerSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    return;
  }

  // ش٥ (§٩.٤): رصيد زين بلا مُثبِتٍ خارجيّ — تأكيدٌ ثانٍ صريح قبل التسجيل (الزبون حاضر).
  if (method === "TELECOM" && appliedPaidD.gt(0)) {
    if (
      !(await confirm({
        variant: "warning",
        title: "تأكيد قبض رصيد زين",
        description: `تحقّقتَ أن رصيد ${fmt(round2(appliedPaidD).toNumber())} د.ع وصل فعلاً (كارت شحن ${paymentReference.trim() || "—"})؟ الكود يُقبل مرّةً واحدة ولا يدخل درج النقد.`,
        confirmText: "وصل الرصيد — سجّل",
      }))
    )
      return;
  }

  return {
    hadActiveDraftAtSubmit,
    hasCustomLines,
    isReserve,
    mixedRoundApplied,
    mixedDeltaAppliedD,
    printLines,
    customWithDeposits,
    effectiveWoDelivery,
    regularLines,
    hasGrandShortfall,
    hasDirectShortfall,
    appliedPaidD,
    routeDeliveryToWO,
    digitalLines,
    draftAtSubmit,
    inputPaidD,
  };
}
