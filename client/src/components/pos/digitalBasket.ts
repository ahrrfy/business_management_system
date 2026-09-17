/**
 * العقد العميليّ المشترك لسلة الكروت بين التجزئة والاستقبال والفاتورة المتقدمة.
 * يحفظ كل ما يحتاجه `digitalCards.sales.prepare`؛ إسقاط أي حقل هنا كان يجعل الشاشة
 * تعرض الكرت ثم تفشل عند التثبيت أو تسجله كبند خدمة عادي.
 */
export type DigitalStudentSnapshot = {
  studentName: string;
  studentPhone: string;
};

export type DigitalBasketCard = {
  offeringId: number;
  providerId: number;
  priceVersionId: number | null;
  sellPrice: string | null;
  providerName: string;
  offeringType: string;
  faceValue: string | null;
  subscriptionDurationDays: number | null;
  requiresStudentData: boolean;
};

export type DigitalBasketCapture<TCard extends DigitalBasketCard = DigitalBasketCard> = {
  providerBasketKey: string;
  providerReference: string;
  lines: Array<{ card: TCard; student?: DigitalStudentSnapshot }>;
};

export type DigitalCheckoutLineMeta = {
  offeringId: number;
  providerId: number;
  priceVersionId: number;
  sellPriceSnapshot: string;
  lineKey: string;
  providerName: string;
  offeringType: string;
  providerReference: string;
  providerBasketKey: string;
  faceValue: string | null;
  subscriptionDurationDays: number | null;
  requiresStudentData: boolean;
  student?: DigitalStudentSnapshot;
};

export type DigitalInvoiceSettlement = {
  paymentAmount: string;
  paymentMethod: "CASH" | "CARD" | "CREDIT";
};

export function resolveDigitalInvoiceSettlement(input: {
  paymentTerms: string;
  paymentMethod: string;
  paidTotal: string;
}): DigitalInvoiceSettlement {
  if (input.paymentTerms !== "CASH" || input.paymentMethod !== "CASH") {
    throw new Error("الكروت والاشتراكات الرقمية تُباع نقداً حالياً.");
  }
  return {
    paymentAmount: round2(D(input.paidTotal)).toFixed(2),
    paymentMethod: "CASH",
  };
}

export function captureDigitalBasketLines<TCard extends DigitalBasketCard>(
  basket: DigitalBasketCapture<TCard>,
  createLineKey: () => string = () => globalThis.crypto.randomUUID(),
): Array<{ card: TCard; digital: DigitalCheckoutLineMeta }> {
  const providerBasketKey = basket.providerBasketKey.trim();
  const providerReference = basket.providerReference.trim();
  if (!providerBasketKey || !providerReference) {
    throw new Error("سلة الكروت تفتقد معرّفها أو رقم عملية المزوّد");
  }

  return basket.lines.map(({ card, student }) => {
    if (card.priceVersionId == null || card.sellPrice == null) {
      throw new Error(`البطاقة ${card.offeringId} بلا سعر نافذ صالح للبيع`);
    }
    return {
      card,
      digital: {
        offeringId: card.offeringId,
        providerId: card.providerId,
        priceVersionId: card.priceVersionId,
        sellPriceSnapshot: card.sellPrice,
        lineKey: createLineKey(),
        providerName: card.providerName,
        offeringType: card.offeringType,
        providerReference,
        providerBasketKey,
        faceValue: card.faceValue,
        subscriptionDurationDays: card.subscriptionDurationDays,
        requiresStudentData: card.requiresStudentData,
        student,
      },
    };
  });
}

export function toDigitalPrepareLine(meta: DigitalCheckoutLineMeta) {
  return {
    lineKey: meta.lineKey,
    providerBasketKey: meta.providerBasketKey,
    offeringId: meta.offeringId,
    priceVersionId: meta.priceVersionId,
    expectedSellPrice: meta.sellPriceSnapshot,
    providerReference: meta.providerReference,
    student: meta.student ?? null,
  };
}

type DigitalInvoiceBasketCard = DigitalBasketCard & {
  productId: number;
  variantId: number;
  productUnitId: number;
  name: string;
};

export function captureDigitalInvoiceBasketItems<TCard extends DigitalInvoiceBasketCard>(
  basket: DigitalBasketCapture<TCard>,
) {
  return captureDigitalBasketLines(basket).map(({ card, digital }) => ({
    productId: card.productId,
    variantId: card.variantId,
    productUnitId: card.productUnitId,
    name: card.name,
    sku: "",
    barcode: null,
    unit: "بطاقة",
    qty: 1,
    conversionFactor: "1",
    stockBase: 0,
    isService: true,
    price: digital.sellPriceSnapshot,
    costBase: "0",
    discount: "0",
    discountType: "amount" as const,
    note: "",
    digital,
  }));
}

export function captureDigitalReceptionCartLines<TCard extends DigitalInvoiceBasketCard>(
  basket: DigitalBasketCapture<TCard>,
  branchId: number,
) {
  return captureDigitalBasketLines(basket).map(({ card, digital }) => ({
    key: digital.lineKey,
    row: {
      branchId,
      productId: card.productId,
      productName: card.name,
      variantId: card.variantId,
      variantName: null,
      color: null,
      colorHex: null,
      size: null,
      sku: "",
      productUnitId: card.productUnitId,
      unitName: "بطاقة",
      conversionFactor: "1.0000",
      barcode: null,
      isBaseUnit: true,
      price: digital.sellPriceSnapshot,
      stockBase: 0,
      isService: true,
    },
    qty: 1,
    digital,
  }));
}

type DigitalInvoiceValidationLine = {
  name: string;
  qty: number;
  isGift?: boolean;
  discount: string;
  price: string;
  digital?: DigitalCheckoutLineMeta;
};

export function validateDigitalInvoiceCheckout(
  lines: readonly DigitalInvoiceValidationLine[],
  input: {
    isCorrection: boolean;
    hasOpenShift: boolean;
    paymentTerms: string;
    paymentMethod: string;
    paidTotal: string;
    grandTotal: string;
    globalDiscount: string;
    shippingFree: boolean;
    shipping: string;
    taxEnabled: boolean;
    totalTax: string;
  },
): string | null {
  const digitalLines = lines.filter((line) => line.digital);
  if (digitalLines.length === 0) return null;
  if (input.isCorrection) return "لا تُضاف الكروت الرقمية إلى فاتورة تصحيح؛ أنشئ فاتورة بيع جديدة.";
  if (!input.hasOpenShift) return "يلزم فتح وردية في فرع الفاتورة قبل بيع الكروت والاشتراكات.";
  if (input.paymentTerms !== "CASH") return "الكروت والاشتراكات الرقمية لا تدعم البيع الآجل أو الأقساط؛ يجب قبض الفاتورة كاملة قبل الإصدار.";
  if (input.paymentMethod !== "CASH") return "الكروت الرقمية داخل فاتورة البيع تُقبض نقداً حالياً؛ الدفع بالبطاقة موقوف حتى يكتمل الربط الذري قبل القبض.";
  if (!round2(D(input.paidTotal)).eq(round2(D(input.grandTotal)))) return "الكروت والاشتراكات تتطلب تسديد كامل الفاتورة قبل الإصدار.";
  if (D(input.globalDiscount).gt(0)) return "لا يُطبّق الخصم الإجمالي على فاتورة تحتوي كروتاً رقمية.";
  if (input.shippingFree || D(input.shipping).gt(0)) return "افصل أجرة التوصيل في فاتورة أخرى عند بيع الكروت الرقمية.";
  if (input.taxEnabled && D(input.totalTax).gt(0)) return "افصل الفاتورة الضريبية عن بيع الكروت الرقمية.";
  const changed = digitalLines.find((line) => line.qty !== 1 || line.isGift === true || D(line.discount).gt(0) || !D(line.price).eq(line.digital!.sellPriceSnapshot));
  return changed ? `بيانات «${changed.name}» الرقمية تغيّرت؛ احذفها وأعد إضافتها من سلة المزوّد.` : null;
}

export function toDigitalPrepareRegularLine(line: {
  productUnitId: number;
  variantId: number;
  qty: number;
  price: string;
  discountType: string;
  discount: string;
  isGift?: boolean;
}, index: number) {
  return {
    lineKey: `regular:${index}:${line.productUnitId}`,
    variantId: line.variantId,
    productUnitId: line.productUnitId,
    quantity: String(line.qty),
    unitPriceOverride: line.price,
    discountPercent: line.discountType === "percent" ? line.discount : undefined,
    discountAmount: line.discountType === "amount" ? line.discount : undefined,
    isGift: line.isGift === true,
  };
}
import { D, round2 } from "@/lib/money";
