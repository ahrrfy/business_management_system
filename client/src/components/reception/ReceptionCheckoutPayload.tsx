import type { ManagerApprovalInput } from "@/components/reception/ManagerApprovalDialog";
import type { RouterOutputs } from "@/lib/trpc";
import type { ReceptionDeliveryFeeTender } from "./useDeliveryFeeTender";
import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import {
  type CustomizationData,
  composeCustomizationText,
} from "@/components/CustomizationDialog";
import { D, round2 } from "@/lib/money";
import {
  effectivePrice,
  lineTotal,
  type CartLine,
  type PayMethod,
  type Tier,
} from "@/components/reception/cartMath";

export interface ReceptionCheckoutPayloadInput {
  heldDelivery: string;
  deliveryFeeTender: ReceptionDeliveryFeeTender | null;
  branchId: number;
  cashRoundActive: boolean;
  effectiveGrandD: import("decimal.js").Decimal;
  regularSumRawD: import("decimal.js").Decimal;
  invoiceDiscountAmountD: import("decimal.js").Decimal;
  mixedRoundApplied: boolean;
  mixedCarrier: "SALE" | "PRINT" | null;
  mixedDeltaAppliedD: import("decimal.js").Decimal;
  printLines: import("@/components/reception/cartMath").CartLine[];
  customWithDeposits: {
    c: import("@/components/reception/cartMath").CartLine;
    depositStr: string;
    salePriceStr: string;
  }[];
  effectiveWoDelivery: (
    custom: import("@/components/CustomizationDialog").CustomizationData,
    idx: number,
  ) => {
    has: boolean;
    address: string | null;
    phone: string | null;
    cost: string;
    feeColl: "COURIER" | "COUNTER" | "SHOP";
    partyName: string | null;
  };
  method: import("@/components/reception/cartMath").PayMethod;
  paymentReference: string;
  channel: "OTHER" | "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE";
  channelHandle: string;
  receptionPhone: string;
  regularLines: import("@/components/reception/cartMath").CartLine[];
  orderDelivery:
    | import("@/components/reception/ReceptionTypes").OrderDeliveryValue
    | null;
  hasGrandShortfall: boolean;
  isReserve: boolean;
  hasDirectShortfall: boolean;
  deferred: boolean;
  customer: import("@/components/customer/customerByPhoneMachine").PhoneCustomer;
  shift: NonNullable<RouterOutputs["shifts"]["current"]>;
  customerId: number | null;
  customerName: string | null;
  receiptPhone: string;
  appliedPaidD: import("decimal.js").Decimal;
  orderFeeHeldD: import("decimal.js").Decimal;
  routeDeliveryToWO: boolean;
  opts: {
    quickFullPay: boolean;
    openingConfirmed?: boolean | undefined;
    isReservation?: boolean | undefined;
  };
  mgrCredsRef: React.RefObject<ManagerApprovalInput | null>;
  reqIdRef: React.RefObject<string>;
  effectiveTier: import("@/components/reception/cartMath").Tier;
  couponCode: string | null;
}
export function buildReceptionCheckoutPayload({
  heldDelivery,
  deliveryFeeTender,
  branchId,
  cashRoundActive,
  effectiveGrandD,
  regularSumRawD,
  invoiceDiscountAmountD,
  mixedRoundApplied,
  mixedCarrier,
  mixedDeltaAppliedD,
  printLines,
  customWithDeposits,
  effectiveWoDelivery,
  method,
  paymentReference,
  channel,
  channelHandle,
  receptionPhone,
  regularLines,
  orderDelivery,
  hasGrandShortfall,
  isReserve,
  hasDirectShortfall,
  deferred,
  customer,
  shift,
  customerId,
  customerName,
  receiptPhone,
  appliedPaidD,
  orderFeeHeldD,
  routeDeliveryToWO,
  opts,
  mgrCredsRef,
  reqIdRef,
  effectiveTier,
  couponCode,
}: ReceptionCheckoutPayloadInput) {
  const saleAmount = cashRoundActive
    ? round2(effectiveGrandD).toFixed(2)
    : round2(
        regularSumRawD
          .minus(invoiceDiscountAmountD)
          .plus(
            mixedRoundApplied && mixedCarrier === "SALE"
              ? mixedDeltaAppliedD
              : D(0),
          ),
      ).toFixed(2);
  const printAmount = round2(
    printLines
      .reduce((s, c) => s.plus(D(lineTotal(c))), D(0))
      .plus(
        mixedRoundApplied && mixedCarrier === "PRINT"
          ? mixedDeltaAppliedD
          : D(0),
      ),
  ).toFixed(2);
  const workOrderPayloads = customWithDeposits.map((x, woIndex) => {
    const c = x.c;
    const custom = c.custom!;
    const finalText = composeCustomizationText(custom);
    const eff = effectiveWoDelivery(custom, woIndex);
    // إصلاح P1 (٢٣/٦/٢٦): المنتجات المخصّصة ذات المخزون كانت تَخرج بلا materials ⇒ المخزون
    // لا يَنخفض و COGS صفر، وعند التسليم الفاتورة تُنشَأ بسطر للمنتج الأساس بدون خصم سابق
    // ⇒ بيعٌ بلا تكلفة، أرباح مُبالَغة، رصيدٌ مُبالَغ في المخزون.
    // الحل: لو المنتج Service (بلا مخزون) ⇒ لا مواد. غير ذلك ⇒ المنتج الأساس يَستهلك
    // baseQuantity = qty * conversionFactor (يُقرَّب لعدد صحيح لمطابقة فحص createWorkOrder).
    const materials: { variantId: number; baseQuantity: number }[] = [];
    if (!c.row.isService) {
      const factor = Number(c.row.conversionFactor) || 1;
      const baseQty = Math.max(1, Math.round(c.qty * factor));
      materials.push({ variantId: c.row.variantId, baseQuantity: baseQty });
    }
    return {
      baseVariantId: c.manualService ? null : c.row.variantId,
      baseProductUnitId: c.manualService ? null : c.row.productUnitId,
      title: custom.title.trim() || c.row.productName,
      customizationText: finalText || null,
      quantity: c.qty,
      materials,
      laborCost: D(custom.laborCost || 0).toFixed(2),
      // ٥/٨ — salePrice = بضاعة/خدمة فقط؛ أجرة التوصيل في عمودها المستقلّ (تمريرٌ لا إيراد).
      salePrice: x.salePriceStr,
      dueDate: custom.dueDate || null,
      priority: custom.priority,
      assignedTo: custom.assignedTo ?? undefined,
      deposit: x.depositStr,
      paymentMethod: D(x.depositStr).gt(0) ? method : null,
      paymentReference:
        D(x.depositStr).gt(0) && method !== "CASH"
          ? paymentReference.trim()
          : null,
      paymentReceiptUrl: custom.paymentReceiptImages[0]?.dataUrl || null,
      receptionChannel: channel,
      channelHandle:
        (channel === "INSTAGRAM" || channel === "TIKTOK"
          ? channelHandle
          : receptionPhone) || null,
      // ٨/٨ — التوصيل الفعّال (من «توصيل هذا الطلب» المُوجَّه للأمر، أو من كتلة التخصيص).
      hasDelivery: eff.has,
      deliveryAddress: eff.address,
      // ٥/٨ — الأجرة في عمودها وحدها: تمريرٌ للمندوب خارج salePrice/الفاتورة/الإيراد.
      deliveryCost: eff.has ? eff.cost : "0",
      deliveryFeeCollection: eff.has ? eff.feeColl : "COURIER",
      // اِستقبال (تكامل التوصيل، ٤/٨): هاتف المستلم كعمود مستقلّ قابل للاستعلام — كان
      // مُضمَّناً كنصٍّ حرٍّ داخل customizationText فقط (composeCustomizationText أدناه ما زال
      // يُضيفه للنصّ أيضاً — تكرارٌ مقصود: عرضٌ للفنّي في النص + مصدر حقيقة للتوصيل في العمود).
      deliveryPhone: eff.has ? eff.phone : null,
      designImages: custom.designImages.map((img, idx) => ({
        url: img.dataUrl,
        caption: img.name ?? null,
        sortOrder: idx,
      })),
    };
  });

  // ش٧ + مراجعة PR #495 — **الإسناد داخل معاملة التثبيت**: كانت الواجهة تُتمّ الطلب ثم
  // تنادي `delivery.dispatchInvoice` في معاملةٍ تالية، فتُنتج نافذةً تكون فيها الفاتورة بلا
  // دافعٍ ولا حاملِ عهدة (وفشلُ الإسناد يتركها يتيمةً بلا مندوب). الخادم يدعم `delivery`
  // على المسارين (receptionCheckout/draftCommit) منذ ش٧ — نمرّرها الآن فيصيران ذرّةً واحدة:
  // إمّا (فاتورة + عهدة مندوب) معاً وإمّا لا شيء. أوامر الشغل وحدها بلا فاتورةٍ حاملة
  // تبقى استثناءً مُعلَناً (تحذيرٌ بعد التثبيت) — الخادم يرفض `delivery` بلا فاتورة.
  const hasCarrierInvoice = regularLines.length > 0 || printLines.length > 0;
  const deliveryPayload =
    orderDelivery && hasCarrierInvoice
      ? {
          partyId: orderDelivery.partyId,
          fee: orderDelivery.fee?.trim() ? orderDelivery.fee : "0",
          feeCollection: orderDelivery.feeCollection,
          recipientName: orderDelivery.recipientName || undefined,
          recipientPhone: orderDelivery.recipientPhone || undefined,
          address: orderDelivery.address || undefined,
          externalTrackingRef:
            orderDelivery.externalTrackingRef?.trim() || undefined,
        }
      : undefined;

  const checkoutPaymentMode: "PREPAID" | "COD" | "CREDIT" = !hasGrandShortfall
    ? "PREPAID"
    : isReserve || orderDelivery
      ? "COD"
      : "CREDIT";

  const sendDeferredDirect =
    hasDirectShortfall &&
    (deferred || isReserve || (customer.customerId != null && !orderDelivery));

  const directCheckoutPayload = {
    branchId,
    shiftId: shift.id,
    customerId: customerId ?? undefined,
    contactName: customerId == null ? (customerName ?? undefined) : undefined,
    contactPhone: customerId == null ? (receiptPhone ?? undefined) : undefined,
    paymentMethod: appliedPaidD.gt(0) ? method : undefined,
    paymentReference:
      appliedPaidD.gt(0) && method !== "CASH"
        ? paymentReference.trim()
        : undefined,
    paidAmount: round2(appliedPaidD).toFixed(2),
    paymentMode: checkoutPaymentMode,
    cashRoundIQD: cashRoundActive,
    cashRoundingOverride: mixedRoundApplied
      ? (mixedCarrier ?? undefined)
      : undefined,
    deliveryFeeHeld: D(heldDelivery).gt(0) ? heldDelivery : undefined,
    deliveryFeeTender: deliveryFeeTender ?? undefined,
    delivery: deliveryPayload,
    openingSellUnavailableConfirmed: opts.openingConfirmed === true,
    deferredDirect: sendDeferredDirect,
    managerApproval: mgrCredsRef.current ?? undefined,
    clientRequestId: reqIdRef.current,
    priceTier: effectiveTier,
    couponCode: couponCode ?? undefined,
    regularSale:
      regularLines.length > 0
        ? {
            amount: saleAmount,
            ...(invoiceDiscountAmountD.gt(0)
              ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) }
              : {}),
            lines: regularLines.map((c) => {
              if (c.row.promotionEffectivePrice != null) {
                const listWhole = D(c.row.price ?? 0).toDecimalPlaces(0, 4);
                const discAmt = listWhole
                  .minus(D(c.row.promotionEffectivePrice))
                  .times(c.qty);
                return {
                  variantId: c.row.variantId,
                  productUnitId: c.row.productUnitId,
                  quantity: String(c.qty),
                  unitPriceOverride: listWhole.toFixed(2),
                  ...(discAmt.gt(0)
                    ? { discountAmount: discAmt.toFixed(2) }
                    : {}),
                  ...(c.row.promotionId != null
                    ? { promotionId: c.row.promotionId }
                    : {}),
                };
              }
              return {
                variantId: c.row.variantId,
                productUnitId: c.row.productUnitId,
                quantity: String(c.qty),
                ...(c.disc != null && c.disc > 0
                  ? { discountPercent: String(c.disc) }
                  : {}),
              };
            }),
          }
        : null,
    printSale:
      printLines.length > 0
        ? {
            amount: printAmount,
            lines: printLines.map((c) => ({
              variantId: c.row.variantId,
              productUnitId: c.row.productUnitId,
              quantity: String(c.qty),
              unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
            })),
          }
        : null,
    workOrders: workOrderPayloads,
  };

  return {
    directCheckoutPayload,
    deliveryPayload,
    saleAmount,
    printAmount,
    checkoutPaymentMode,
    hasCarrierInvoice,
  };
}
