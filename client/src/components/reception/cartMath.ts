import type { CustomizationData } from "@/components/CustomizationDialog";
import type { ReceiptBrowserData, WorkOrderReceiptData } from "@/lib/printing/print";
import type { RouterOutputs } from "@/lib/trpc";

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
  receipts: ReceiptBrowserData[];
  workOrders: WorkOrderReceiptData[];
  printFailures: number;
};
export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
  TELECOM: "رصيد زين", // ش٥ — أكواد كروت شحن زين (لا يلمس الدرج)
};
export type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };

export type CartLine = {
  key: string; // معرّف فريد للسطر (للأصناف المخصّصة المتعدّدة من نفس المنتج)
  row: PosRow;
  qty: number;
  origPrice?: number;
  disc?: number; // نسبة خصم
  custom?: CustomizationData; // إن كان مخصّصاً
  manualService?: boolean; // خدمة حرة لا ترتبط بمنتج/متغيّر من الكتالوج
};

// مبالغ سريعة بالقيمة الفعلية (د.ع). إصلاح P2 (٢٣/٦/٢٦): كان `setQuickAmt(v * 1000)` يجعل
// زرّ «5,000» يُدخل 5,000,000 ⇒ فكّةٌ خاطئة ١٠٠٠× — كارثة كاشير.
export const QUICK_AMTS = [1000, 5000, 10000, 25000];

export function effectivePrice(line: CartLine): number {
  // عرض/كوبون (catalog.posList.promotionEffectivePrice) يسبق السعر الأساس كنقطة انطلاق (نمط
  // POS.tsx effectivePrice) — الخصم اليدوي يُطبَّق فوقه لا بدلاً عنه. لا ينطبق على سطر مخصّص
  // (custom): تسعيره الإضافي بلا كتالوج ترويجيّ.
  const promoPrice = !line.custom ? line.row.promotionEffectivePrice : null;
  // التخصيص إضافيّ: سعر الوحدة للسطر المخصّص = سعر المنتج الأساس + سعر التخصيص (فوقه)، لا بديلاً عنه.
  const base = line.origPrice ?? (
    promoPrice != null ? Number(promoPrice) :
    line.custom
      ? Number(line.row.price ?? 0) + Number(line.custom.unitPrice ?? 0)
      : Number(line.row.price ?? 0)
  );
  if (line.disc && line.disc > 0) return base * (1 - line.disc / 100);
  return base;
}
export function lineTotal(line: CartLine): number {
  return effectivePrice(line) * line.qty;
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
    const availBase = line.row.stockBase ?? 0;
    const reqBase = demandByVariant.get(line.row.variantId) ?? line.qty * convFactor;
    const isOut = availBase <= 0;
    const isShort = !isOut && reqBase > availBase;
    const availInUnit = Math.floor(availBase / convFactor);
    return { isOut, isShort, availInUnit };
  };
}
