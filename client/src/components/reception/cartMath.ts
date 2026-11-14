import { paymentMethodLabels } from "@shared/terms";
import type { CustomizationData } from "@/components/CustomizationDialog";
import type { DigitalCheckoutLineMeta } from "@/components/pos/digitalBasket";
import type { ReceiptBrowserData, WorkOrderReceiptData } from "@/lib/printing/print";
import type { RouterOutputs } from "@/lib/trpc";
import Decimal from "decimal.js";
import { D, round2 } from "@/lib/money";

/**
 * أنواع ودوال سلّة الاستقبال النقيّة — مصدر حقيقة مشترك بين صفحة Reception.tsx ومكوّناتها
 * (CartTable/PaymentPanel/ReceiptOverlay). نُقلت حرفياً من رأس الصفحة (تفكيك §١٣ ش١) بصفر
 * تغيير سلوكي.
 */

export type PosRow = NonNullable<RouterOutputs["catalog"]["posList"]>[number];
/** م٤ — ورش عمود العمل: السلة أساسٌ، والبقية تُركَّب داخله فلا تُغطّي لوحة الدفع أبداً (§٨.١). */
export type Workshop = "CART" | "INVOICES" | "ORDERS" | "STORE";
export type PayMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM";
/** ملخّص آخر عملية ناجحة — نافذة الإيصال + F9 (إعادة طباعة) + شارة «آخر فاتورة» (§٨.٦). */
export type LastSaleSummary = {
  invoiceNumbers: string[];
  workOrderNumbers: string[];
  totalStr: string;
  changeStr: string | null;
  creditStr: string | null;
  paymentMode?: "PREPAID" | "COD" | "CREDIT" | null;
  receipts: ReceiptBrowserData[];
  workOrders: WorkOrderReceiptData[];
  printFailures: number;
};
export const PAY_METHOD_LABEL: Record<PayMethod, string> = paymentMethodLabels(["CASH", "CARD", "TRANSFER", "WALLET", "TELECOM"] as const);
export type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };

export type CartLine = {
  key: string; // معرّف فريد للسطر (للأصناف المخصّصة المتعدّدة من نفس المنتج)
  row: PosRow;
  qty: number;
  origPrice?: number;
  /** سعر المنتج وحده قبل التخصيص والخصم، مستقل عن مرجع سعر السطر. */
  customBasePrice?: number | null;
  /** سعر الكوبون الملتقط للمسودة؛ منفصل عن السعر الأساس كي تعود إزالة الكوبون للسعر الصحيح. */
  couponPriceSnapshot?: number;
  /** خصم السطر الإجمالي للكوبون (دقيق لمنزلتين عشريتين لعروض الباقات/اشترِ واحصل/الكميات المتدرجة). */
  couponLineDiscount?: string;
  /** العرض التلقائي الذي كان على السطر قبل أن يستبدله الكوبون. */
  couponBasePromotion?: { promotionId: number | null; promotionName: string | null; promotionEffectivePrice: string | null };
  /** خصم السطر المطلق المثبَّت في المسوّدة عندما لا يقبل صافي السطر القسمة التامّة على الكمية. */
  draftLineDiscount?: string;
  /** إسناد العرض الترويجي المثبَّت في مسوّدة الاستقبال ليُتحقَّق منه سلطوياً عند التثبيت. */
  draftPromo?: { promotionId: number; promotionName?: string | null; promotionDiscount: string };
  /** التقييم الحيّ لعروض السلة التلقائية (غير مخزّن في sessionStorage). */
  cartPromo?: { promotionId: number; promotionName: string; lineDiscount: string } | null;
  disc?: number; // نسبة خصم
  custom?: CustomizationData; // إن كان مخصّصاً
  manualService?: boolean; // خدمة حرة لا ترتبط بمنتج/متغيّر من الكتالوج
  digital?: DigitalCheckoutLineMeta;
};

// مبالغ سريعة بالقيمة الفعلية (د.ع). إصلاح P2 (٢٣/٦/٢٦): كان `setQuickAmt(v * 1000)` يجعل
// زرّ «5,000» يُدخل 5,000,000 ⇒ فكّةٌ خاطئة ١٠٠٠× — كارثة كاشير.
export const QUICK_AMTS = [1000, 5000, 10000, 25000];

/**
 * يستخرج بيانات العرض الرسمي أو الكوبون المطبّق على سطر الاستقبال الجاهز (غير المخصّص/الرقمي/الطباعة).
 */
export function officialReceptionPromoInfo(
  line: CartLine,
): { promotionId: number; promotionName: string | null; promoDiscountD: Decimal } | null {
  if (line.custom || line.digital || line.row.isPrintService || line.manualService) return null;
  const listUnit = round2(D(line.row.price ?? 0));
  const listGross = round2(listUnit.times(line.qty));
  if (line.couponLineDiscount != null && line.row.promotionId != null) {
    const raw = D(line.couponLineDiscount);
    const capped = raw.gt(listGross) ? listGross : raw.lt(0) ? D(0) : round2(raw);
    return {
      promotionId: Number(line.row.promotionId),
      promotionName: line.row.promotionName ?? null,
      promoDiscountD: capped,
    };
  }
  if (line.couponPriceSnapshot != null && line.row.promotionId != null) {
    const snapD = D(line.couponPriceSnapshot);
    const d = listUnit.gt(snapD) ? round2(listUnit.minus(snapD).times(line.qty)) : D(0);
    return {
      promotionId: Number(line.row.promotionId),
      promotionName: line.row.promotionName ?? null,
      promoDiscountD: d,
    };
  }
  if (line.cartPromo !== undefined) {
    if (!line.cartPromo || !(line.cartPromo.promotionId > 0)) return null;
    const raw = D(line.cartPromo.lineDiscount);
    const capped = raw.gt(listGross) ? listGross : raw.lt(0) ? D(0) : round2(raw);
    return {
      promotionId: line.cartPromo.promotionId,
      promotionName: line.cartPromo.promotionName,
      promoDiscountD: capped,
    };
  }
  if (line.draftPromo != null && line.draftPromo.promotionId > 0) {
    const baseUnit = round2(D(line.origPrice ?? line.row.price ?? 0));
    const baseGross = round2(baseUnit.times(line.qty));
    const maxDisc = line.draftLineDiscount != null
      ? Decimal.min(baseGross, Decimal.max(D(0), round2(D(line.draftLineDiscount))))
      : baseGross;
    const raw = D(line.draftPromo.promotionDiscount);
    const capped = raw.gt(maxDisc) ? maxDisc : raw.lt(0) ? D(0) : round2(raw);
    if (capped.gt(0)) {
      return {
        promotionId: line.draftPromo.promotionId,
        promotionName: line.draftPromo.promotionName ?? null,
        promoDiscountD: capped,
      };
    }
    return null;
  }
  if (line.origPrice == null && line.row.promotionId != null && line.row.promotionEffectivePrice != null) {
    const promoUnit = D(line.row.promotionEffectivePrice);
    const d = listUnit.gt(promoUnit) ? round2(listUnit.minus(promoUnit).times(line.qty)) : D(0);
    return {
      promotionId: Number(line.row.promotionId),
      promotionName: line.row.promotionName ?? null,
      promoDiscountD: d,
    };
  }
  return null;
}

export function effectivePrice(line: CartLine): number {
  if (!line.custom && !line.digital && !line.row.isPrintService && line.qty > 0) {
    if (line.couponLineDiscount != null) {
      return round2(D(lineTotal(line)).div(line.qty)).toNumber();
    }
    if (line.cartPromo !== undefined && line.couponPriceSnapshot == null) {
      return round2(D(lineTotal(line)).div(line.qty)).toNumber();
    }
    if (line.draftLineDiscount != null && line.couponPriceSnapshot == null) {
      return round2(D(lineTotal(line)).div(line.qty)).toNumber();
    }
  }
  // عرض/كوبون (catalog.posList.promotionEffectivePrice) يسبق السعر الأساس كنقطة انطلاق (نمط
  // POS.tsx effectivePrice) — الخصم اليدوي يُطبَّق فوقه لا بدلاً عنه. لا ينطبق على سطر مخصّص
  // (custom): تسعيره الإضافي بلا كتالوج ترويجيّ.
  const promoPrice = !line.custom ? line.row.promotionEffectivePrice : null;
  // التخصيص إضافيّ: سعر الوحدة للسطر المخصّص = سعر المنتج الأساس + سعر التخصيص (فوقه)، لا بديلاً عنه.
  const base = line.couponPriceSnapshot ?? line.origPrice ?? (
    promoPrice != null ? Number(promoPrice) :
    line.custom
      ? D(line.customBasePrice ?? line.row.price).plus(D(line.custom.unitPrice)).toNumber()
      : Number(line.row.price ?? 0)
  );
  if (line.disc && line.disc > 0) return base * (1 - line.disc / 100);
  return base;
}
export function lineTotal(line: CartLine): number {
  if (!line.custom && !line.digital && !line.row.isPrintService) {
    if (line.couponLineDiscount != null) {
      const listGross = round2(round2(D(line.row.price ?? 0)).times(line.qty));
      const couponDisc = Decimal.min(listGross, Decimal.max(0, D(line.couponLineDiscount)));
      const afterCoupon = listGross.minus(couponDisc);
      if (line.disc && line.disc > 0) {
        return round2(afterCoupon.times(D(100).minus(line.disc)).div(100)).toNumber();
      }
      return round2(afterCoupon).toNumber();
    }
    if (line.draftLineDiscount != null && line.couponPriceSnapshot == null) {
      const baseUnit = round2(D(line.origPrice ?? line.row.promotionEffectivePrice ?? line.row.price ?? 0));
      const grossLine = round2(baseUnit.times(line.qty));
      const draftDisc = Decimal.min(grossLine, Decimal.max(0, D(line.draftLineDiscount)));
      const afterDraftDisc = grossLine.minus(draftDisc);
      if (line.disc && line.disc > 0) {
        return round2(afterDraftDisc.times(D(100).minus(line.disc)).div(100)).toNumber();
      }
      return round2(afterDraftDisc).toNumber();
    }
    if (line.cartPromo !== undefined && line.couponPriceSnapshot == null) {
      const hasHistoricalOverride =
        line.origPrice != null && !((line.disc ?? 0) > 0 && D(line.origPrice).eq(D(line.row.price ?? 0)));
      const baseUnit = hasHistoricalOverride ? D(line.origPrice!) : D(line.row.price ?? 0);
      const grossLine = baseUnit.times(line.qty);
      const promoDisc =
        !hasHistoricalOverride && line.cartPromo
          ? Decimal.min(grossLine, Decimal.max(0, D(line.cartPromo.lineDiscount)))
          : D(0);
      const afterPromo = grossLine.minus(promoDisc);
      if (line.disc && line.disc > 0) {
        return round2(afterPromo.times(D(100).minus(line.disc)).div(100)).toNumber();
      }
      return round2(afterPromo).toNumber();
    }
  }
  return effectivePrice(line) * line.qty;
}

/**
 * يستخرج سعر الوحدة وخصم السطر لمسوّدة الاستقبال بحيث يطابق `round2(unitPrice * qty - discount)`
 * صافي السطر المقوَّم تماماً حتى عندما لا يقبل الخصم القسمة التامّة على الكمية.
 */
export function resolveDraftGoodsPricing(
  line: CartLine,
): {
  unitPrice: Decimal;
  discountAmount?: Decimal;
  promotionId?: number;
  promotionDiscount?: Decimal;
  promotionName?: string | null;
} {
  const effUnit = round2(D(effectivePrice(line)));
  if (line.custom || line.digital || line.row.isPrintService || line.qty <= 0) {
    return { unitPrice: effUnit };
  }
  const exactNet = round2(D(lineTotal(line)));
  const promoInfo = officialReceptionPromoInfo(line);
  if (promoInfo && promoInfo.promotionId > 0 && promoInfo.promoDiscountD.gt(0)) {
    const promoBase = round2(
      D(line.draftPromo != null ? (line.origPrice ?? line.row.price ?? 0) : (line.row.price ?? 0)),
    );
    const promoGross = round2(promoBase.times(line.qty));
    if (promoGross.gt(exactNet)) {
      const totalDisc = round2(promoGross.minus(exactNet));
      const promoDisc = Decimal.min(totalDisc, round2(promoInfo.promoDiscountD));
      return {
        unitPrice: promoBase,
        discountAmount: totalDisc,
        ...(promoDisc.gt(0)
          ? {
              promotionId: promoInfo.promotionId,
              promotionDiscount: promoDisc,
              promotionName: promoInfo.promotionName ?? null,
            }
          : {}),
      };
    }
  }
  if (round2(effUnit.times(line.qty)).eq(exactNet)) {
    return { unitPrice: effUnit };
  }
  const candidateBase = round2(D(line.origPrice ?? line.row.price ?? 0));
  const candidateGross = round2(candidateBase.times(line.qty));
  if (candidateGross.gte(exactNet)) {
    return {
      unitPrice: candidateBase,
      discountAmount: round2(candidateGross.minus(exactNet)),
    };
  }
  const ceilingUnit = exactNet.div(line.qty).toDecimalPlaces(2, Decimal.ROUND_UP);
  const ceilingGross = round2(ceilingUnit.times(line.qty));
  return {
    unitPrice: ceilingUnit,
    discountAmount: round2(ceilingGross.minus(exactNet)),
  };
}
export function customizationBasePrice(line: CartLine): number | null {
  try {
    // null يعني مسودة قديمة بلا تفكيك موثوق؛ لا نستنتج أساس المنتج من صافيها بعد الخصم.
    if (line.customBasePrice === null || (line.customBasePrice === undefined && line.row.price == null)) return null;
    if (line.customBasePrice === undefined && line.origPrice != null) {
      const catalog = D(line.row.price), reference = D(line.origPrice);
      const provenReference = reference.eq(catalog.plus(D(line.custom?.unitPrice)))
        || ((line.disc ?? 0) > 0 && reference.eq(catalog));
      if (!provenReference) return null;
    }
    const price = D(line.customBasePrice ?? line.row.price);
    return price.isFinite() && price.gte(0) ? round2(price).toNumber() : null;
  } catch { return null; }
}

export function withReceptionLineDiscount(line: CartLine, pct: number | null): CartLine {
  if (line.digital) return line;
  const customBasePrice = line.custom ? customizationBasePrice(line) : null;
  if (line.custom && customBasePrice == null) return line;
  const normalized = line.custom ? { ...line, customBasePrice: customBasePrice!, origPrice: D(customBasePrice).plus(D(line.custom.unitPrice)).toNumber() } : line;
  if (pct == null || pct <= 0) {
    const clearCatalogMarker =
      !normalized.custom &&
      normalized.draftLineDiscount == null &&
      normalized.origPrice != null &&
      D(normalized.origPrice).eq(D(normalized.row.price ?? 0)) &&
      normalized.row.promotionEffectivePrice == null;
    return {
      ...normalized,
      origPrice: clearCatalogMarker ? undefined : normalized.origPrice,
      disc: undefined,
    };
  }
  return { ...normalized, origPrice: normalized.origPrice ?? D(normalized.row.price).toNumber(), disc: Math.min(100, pct) };
}

export function withReceptionLineQty(line: CartLine, rawQty: number): CartLine {
  if (line.digital) return line;
  const nextQty = Math.max(1, Math.trunc(rawQty) || 1);
  if (nextQty === line.qty) return line;
  if (line.draftLineDiscount != null && line.qty > 0) {
    const scaled = round2(D(line.draftLineDiscount).times(nextQty).div(line.qty));
    if (scaled.lte(0)) {
      const { draftLineDiscount: _d, draftPromo: _dp, ...rest } = line;
      return { ...rest, qty: nextQty };
    }
    if (line.draftPromo != null) {
      const scaledPromo = Decimal.min(
        scaled,
        round2(D(line.draftPromo.promotionDiscount).times(nextQty).div(line.qty)),
      );
      if (scaledPromo.lte(0)) {
        const { draftPromo: _dp, ...rest } = line;
        return { ...rest, qty: nextQty, draftLineDiscount: scaled.toFixed(2) };
      }
      return {
        ...line,
        qty: nextQty,
        draftLineDiscount: scaled.toFixed(2),
        draftPromo: { ...line.draftPromo, promotionDiscount: scaledPromo.toFixed(2) },
      };
    }
    return { ...line, qty: nextQty, draftLineDiscount: scaled.toFixed(2) };
  }
  return { ...line, qty: nextQty };
}
export function isCustomKind(line: CartLine): boolean {
  return !!line.custom;
}
/** ٥/٨ — سعر بيع السطر المخصّص: بضاعةٌ وخدمةٌ فقط. أجرة التوصيل **لا** تُجمَع هنا.
 *  كانت تُضمّ إلى salePrice ⇒ تصير إيراداً بهامش ١٠٠٪ في قيد SALE ونقداً في الدرج يُحاسَب عليه
 *  الموظّف عند الإغلاق، بينما أجرة المندوب الحقيقية رقمٌ آخر يُصرَف من مسارٍ مستقلّ. */
export function customLineGrand(line: CartLine): number {
  return lineTotal(line);
}
/** أجرة التوصيل المُثبَّتة على السطر (تمريرٌ للمندوب — خارج الفاتورة والإيراد دائماً). */
export function lineDeliveryFee(line: CartLine): number {
  if (!line.custom?.hasDelivery) return 0;
  return Number(line.custom.deliveryCost || 0);
}
/** الأجرة التي يقبضها **الكاشير الآن** أمانةً (وضع COUNTER وحده) ⇒ نقدٌ يدخل الدرج بإيصالٍ
 *  مستقلّ عن الفاتورة، ويخرج للمندوب عند الإرسال. غيرها لا يمرّ بالدرج إطلاقاً. */
export function lineCounterHeldFee(line: CartLine): number {
  return line.custom?.deliveryFeeCollection === "COUNTER" ? lineDeliveryFee(line) : 0;
}

/** حالة المخزون للأصناف الجاهزة (المخصَّصة لا مَخزون لها — إنتاج). يَحسب الطلب الكلّي للصنف
 *  عبر كل وحداته في السلّة (رصيد الفرع مُشترك بين القطعة/الدرزن/الكرتون). نَمط مُطابق POS.tsx. */
export function buildStockState(cart: CartLine[]) {
  const demandByVariant = new Map<number, number>();
  for (const l of cart) {
    if (l.custom) continue;
    const f = Number(l.row.conversionFactor) || 1;
    demandByVariant.set(l.row.variantId, (demandByVariant.get(l.row.variantId) ?? 0) + l.qty * f);
  }
  return (line: CartLine) => {
    if (line.custom || line.row.isService) {
      return { isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    }
    const convFactor = Number(line.row.conversionFactor) || 1;
    const availBase = line.row.availableBase ?? line.row.stockBase ?? 0;
    const reqBase = demandByVariant.get(line.row.variantId) ?? line.qty * convFactor;
    const isOut = availBase <= 0;
    const isShort = !isOut && reqBase > availBase;
    const availInUnit = Math.floor(availBase / convFactor);
    // «يُباع بالطلب» (0318): الخادم يقبله قبل التوريد إعفاءً دائماً، فوسمُه «نافذاً» يحجب سلّةً
    // ستُحفظ بنجاح. نُطفئ الوسم ونُبقي الرقم صادقاً — السالب هو عدّاد «مُباعٌ لم يُورَّد».
    if (line.row.allowBackorder) return { isOut: false, isShort: false, availInUnit };
    return { isOut, isShort, availInUnit };
  };
}
