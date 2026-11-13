// أنواع الكاشير وثوابته ودوالّه النقيّة (Tier/CartItem/POSTab/Receipt/POS_COLORS/fmt/…).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { invoicePrintAmounts } from "@/lib/printing/receiptLayoutInvoiceAmounts";
import { newClientRequestId } from "@/lib/countQueue";
import { D, round2 } from "@/lib/money";
import type { ReceiptBrowserData } from "@/lib/printing/print";
import type { PromoPrintSummary } from "@/lib/printing/promoPrintSummary";
import type { StudentSnapshot } from "@/components/pos/StudentDetailsDialog";
import type { DigitalReceiptDetail } from "@/lib/printing/digitalReceiptLines";
import type { RouterOutputs } from "@/lib/trpc";
import type { DeliveryFeeCollection } from "@shared/deliveryFeeCollection";
import type { DeliveryDraft } from "./deliveryMode";

export type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
export type NumMode = "QTY" | "DISC" | "PAY";
export type PosRow = RouterOutputs["catalog"]["posList"][number];

export type ExternalPaymentDraft = {
  attemptId: number | null;
  requestId: string;
  fingerprint: string;
  state: "INITIATED" | "CONFIRMED";
  deviceId?: string;
};

export type PosPaymentLegDraft = {
  id: string;
  method: PaymentMethod;
  amount: string;
  paymentRef: string;
  externalPayment: ExternalPaymentDraft | null;
};

/** وسم سطر بطاقة رقمية (ش٥). كل مثيل مستقلّ حتى لو تكرّرت الفئة نفسها في السلة. */
export type DigitalLineMeta = {
  offeringId: number;
  providerId: number;
  priceVersionId: number;
  /** مفتاح داخلي (UUID) يميّز مثيل البطاقة في السلة عن رقم عملية المزوّد. */
  lineKey: string;
  /** هوية عدديّة محليّة للسلة فقط (سالبة كي لا تصطدم بـproductUnitId). */
  lineId: number;
  offeringType: string;
  providerName: string;
  providerReference: string;
  providerBasketKey?: string;
  faceValue?: string | null;
  subscriptionDurationDays?: number | null;
  requiresStudentData: boolean;
  /** لقطة بيانات الطالب (ش٦) — تُثبَّت داخل معاملة البيع لاحقاً، لا عند الإضافة للسلة. */
  student?: StudentSnapshot;
};

export type CartPromoAllocation = {
  promotionId: number;
  promotionName: string;
  /** إجمالي الخصم الترويجي المخصص لهذا السطر بالكامل بدقة 2dp */
  lineDiscount: string;
};

export type CartItem = {
  row: PosRow;
  /** لقطة السعر/العرض التلقائي قبل تطبيق كوبون، لاستعادتها عند تغيّر السلة أو إزالة الكوبون. */
  preCouponRow?: PosRow;
  /** تخصيص العرض الحيّ على مستوى السلة (يدعم BUNDLE_PRICE, BOGO, TIERED_QTY, FIXED_PRICE, PERCENT, AMOUNT والكوبونات). */
  cartPromo?: CartPromoAllocation | null;
  qty: number;
  disc?: number; // خصم % (0–100)
  origPrice?: number; // السعر الأصلي قبل الخصم
  digital?: DigitalLineMeta;
};

/** هوية السطر داخل السلة: البطاقة الرقمية بمعرّفها المستقلّ، وغيرها بـproductUnitId (السلوك القديم). */
export function lineIdOf(c: CartItem): number {
  return c.digital?.lineId ?? c.row.productUnitId;
}

export type POSTab = {
  extraCharges?: import("@shared/checkoutCharges").CheckoutChargesInput;
  lastCheckout?: {
    result: import("@shared/checkoutCharges").CheckoutChargesResult;
    recoveryToken: string;
  };
  id: number;
  label: string;
  cart: CartItem[];
  payInput: string;
  method: PaymentMethod;
  selId: number | null; // productUnitId المحدد في السلة
  numMode: NumMode;
  customerId: number | null;
  tierOverride: Tier | null;
  clientRequestId: string; // مفتاح idempotency مستقلّ لكل تبويب — عزل مالي بين الفواتير
  couponInput: string;
  couponCode: string | null;
  couponLabel: string | null;
  couponFreeShippingPromo?: string | null;
  /** مرجع عملية الدفع غير النقدي؛ يُثبّت أولاً في محاولة خادمية مستقلة. */
  paymentRef: string;
  externalPayment: ExternalPaymentDraft | null;
  /** دفعات متعدّدة (دفع مختلط: نقدي + بطاقة/تحويل/محفظة). فارغة أو غائبة = وضع الدفعة الواحدة الافتراضي. */
  paymentLegs?: PosPaymentLegDraft[];
  /** تاريخ استحقاق البيع الآجل (YYYY-MM-DD، اختياري) — يصحّح أعمار الذمم والتذكيرات. */
  dueDate: string;
  /** خصم على رأس الفاتورة كنسبة مئوية (٠–١٥) أو كمبلغ ديناري. */
  invoiceDiscountPct: string;
  invoiceDiscountType?: "percent" | "amount";
  invoiceDiscountValue?: string;
  /** وضع «توصيل» (م١ PR-B): مسوّدة الطرد لهذا التبويب؛ null/غائب = بيعٌ عاديّ. يُحفظ مع المسوّدة. */
  delivery?: DeliveryDraft | null;
  /** إسناد موظف صالة العرض / بائع الصالة (R2 / F5). */
  salesRepId?: number | null;
};

export type Receipt = {
  invoiceNumber: string;
  num?: string;
  invoiceId: number;
  date: string;
  /** تاريخ/وقت/كاشير للإيصال المطبوع المُعلَّم (date يبقى للعرض على الشاشة) */
  printDate?: string;
  printTime?: string;
  cashierName?: string;
  customerName?: string;
  /** G3 (١١/٨): رقم الوردية — يُطبع في ترويسة الإيصال لتوثيق أصل المعاملة (invoices.shiftId). */
  shiftId?: number | null;
  lines: {
    name: string;
    unit: string;
    qty: number;
    price: number;
    disc?: number;
    total: number;
  }[];
  /** المجموع قبل خصم رأس الفاتورة. مساوٍ لـ`total` عند غياب الخصم. */
  subtotal?: number;
  /** مبلغ خصم رأس الفاتورة، إن وُجد. */
  invoiceDiscount?: number;
  /** تعديل التقريب النقديّ IQD (± د.ع، النقد الكامل فقط) — يطابق `cashRoundingAdj` الخادميّ. */
  cashRounding?: number;
  total: number;
  returnedTotal?: string;
  status?: string;
  received: number;
  change: number;
  credit: number;
  method: string;
  /** كود الطريقة الخام (CASH/CARD/TRANSFER/WALLET/MIXED) — للشارة الملوّنة والحفظ الأوفلاين. */
  methodCode?: string;
  /** تفصيل دفعات الفاتورة عند الدفع المختلط (MIXED) */
  paymentLegs?: ReceiptBrowserData["paymentLegs"];
  isCredit: boolean;
  /** ش١٠: لقطات الكروت الرقمية من الخادم (اسم الكرت/المرجع/بيانات الطالب) — بلا أرقام داخلية. */
  digitalDetails?: DigitalReceiptDetail[] | null;
  /** م١ PR-B: كتلة التوصيل على الإيصال (إفصاحٌ للزبون: الجهة/الأجرة/مَن يقبض/العنوان). */
  delivery?: {
    partyName: string;
    fee: string;
    feeCollection: DeliveryFeeCollection;
    address?: string | null;
  } | null;
  /** م١ PR-B: رقم الطرد المُنشأ في معاملة البيع (يظهر في نافذة الإيصال مع رابط إدارة التوصيل). */
  consignmentNumber?: string | null;
  /** قسيمة عودة تلقائية (Bounce-Back Coupon) تُطبع بأسفل الإيصال */
  bounceBackCoupon?: ReceiptBrowserData["bounceBackCoupon"];
  /** ملخص المزايا والعروض الترويجية للطباعة التسويقية على الإيصال الحراري وملصق الطرد */
  promoSummary?: PromoPrintSummary | null;
};

// ─── Colour Tokens — مَربوطة بـtokens.css لِتَتنفّس مع .dark بِلا MutationObserver ─

export const POS_COLORS = {
  bg: "var(--pos-bg)",
  card: "var(--pos-card)",
  border: "var(--pos-border)",
  muted: "var(--pos-muted)",
  mutedFg: "var(--pos-muted-fg)",
  fg: "var(--pos-fg)",
  primary: "var(--pos-primary)",
  primaryH: "var(--pos-primary-h)",
  primaryFg: "var(--pos-primary-fg)",
  primarySoft: "var(--pos-primary-soft)",
  success: "var(--pos-success)",
  successH: "var(--pos-success-h)",
  amber: "var(--pos-amber)",
  amberSoft: "var(--pos-amber-soft)",
  danger: "var(--pos-danger)",
  dangerSoft: "var(--pos-danger-soft)",
  modeActive: "var(--pos-mode-active)",
  modeBord: "var(--pos-mode-bord)",
  modeFg: "var(--pos-mode-fg)",
  numKey: "var(--pos-numkey)",
  numKeyHov: "var(--pos-numkey-hov)",
  delKey: "var(--pos-delkey)",
  delFg: "var(--pos-del-fg)",
  overlay: "var(--pos-overlay)",
} as const;

export type PosColors = typeof POS_COLORS;

// ─── Constants ────────────────────────────────────────────────────────────────

// METHOD_LABEL انتقل إلى lib/paymentMethod.ts — مصدر واحد مع Invoices/InvoiceDetail/حوار الوردية.
export const QUICK_AMTS = [5000, 10000, 25000, 50000, 100000];
export const SHOP = "الرؤية العربية";
export const SCAN_MS = 80;

// ─── Utility ──────────────────────────────────────────────────────────────────

export const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
export const money = (n: number) => n.toFixed(2);

// §٥: سعر فعّال يحسب الخصم بدقّة Decimal (لا Number×float×Math.round) — يصون الفلوس
// عبر مضاعفات الخصم ١٠.٥٪، ٣٣.٣٣٪، إلخ. يُقرَّب 2dp ثم يعاد رقماً للعرض.
// promotions v2 (٨/٧/٢٦): إن مرّر pos.ts `promotionEffectivePrice` (السعر بعد الخصم الترويجي)،
// نستعمله كنقطة انطلاق (بدل السعر الأصلي) قبل تطبيق أي خصم يدوي من الكاشير. الترتيب: العرض أوّلاً
// ثم الخصم اليدوي — بحيث لا يُلغي الكاشير العرض بلا وعي (يمكنه إضافة خصم فوقه).
export const officialPromoDiscountOfItem = (item: CartItem) => {
  if (item.digital) return D(0);
  const listWhole = D(item.row.price ?? 0).toDecimalPlaces(0, 4 /* ROUND_HALF_UP */);
  const listGross = listWhole.times(item.qty);
  if (item.cartPromo !== undefined) {
    if (item.cartPromo == null) return D(0);
    const raw = round2(D(item.cartPromo.lineDiscount));
    return raw.lte(0) ? D(0) : raw.gt(listGross) ? listGross : raw;
  }
  const promotionId = (item.row as any).promotionId as number | null | undefined;
  const promoPrice = (item.row as any).promotionEffectivePrice != null
    ? D((item.row as any).promotionEffectivePrice).toDecimalPlaces(0, 4 /* ROUND_HALF_UP */)
    : listWhole;
  return promotionId != null && listWhole.gt(promoPrice)
    ? listWhole.minus(promoPrice).times(item.qty)
    : D(0);
};

export const effectivePrice = (item: CartItem): number => {
  if (item.digital) return D(item.row.price ?? 0).toNumber();
  if (item.cartPromo !== undefined) {
    if (item.qty <= 0) return D(item.row.price ?? 0).toDecimalPlaces(0, 4).toNumber();
    return round2(D(itemTotal(item)).div(item.qty)).toNumber();
  }
  const base = D(
    (item.row as any).promotionEffectivePrice ?? item.row.price ?? 0,
  );
  if (item.disc == null)
    return base.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
  const discounted = round2(base.times(D(100).minus(D(item.disc))).div(100));
  return discounted.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
};

export const itemTotal = (item: CartItem): number => {
  if (item.digital) return D(item.row.price ?? 0).times(item.qty).toNumber();
  if (item.cartPromo !== undefined) {
    const listWhole = D(item.row.price ?? 0).toDecimalPlaces(0, 4 /* ROUND_HALF_UP */);
    const listGross = listWhole.times(item.qty);
    const promoDisc = officialPromoDiscountOfItem(item);
    const afterPromo = round2(listGross.minus(promoDisc));
    if (item.disc == null || item.disc <= 0) return afterPromo.toNumber();
    const cashierDisc = round2(afterPromo.times(D(item.disc)).div(100));
    const net = round2(afterPromo.minus(cashierDisc));
    return (net.lt(0) ? D(0) : net).toNumber();
  }
  return D(effectivePrice(item)).times(item.qty).toNumber();
};

// POS-ROUND (تدقيق ٢/٧): يبني سطر البيع للخادم بسعر وحدةٍ صحيح (دينار) مطابق تماماً لِما يعرضه
// ويحصّله الكاشير، مع تمرير الخصم كمبلغٍ صريح.
export const buildSaleLine = (c: CartItem) => {
  const listWhole = D(c.row.price ?? 0).toDecimalPlaces(0, 4 /* HALF_UP */);
  const listGross = listWhole.times(c.qty);
  if (c.cartPromo !== undefined) {
    const promotionId = c.cartPromo?.promotionId ?? null;
    const promoDiscount = officialPromoDiscountOfItem(c);
    const lineNet = round2(D(itemTotal(c)));
    const discAmt = round2(listGross.minus(lineNet));
    const cashierDiscount = discAmt.gt(promoDiscount)
      ? round2(discAmt.minus(promoDiscount))
      : D(0);
    return {
      variantId: c.row.variantId,
      productUnitId: c.row.productUnitId,
      quantity: String(c.qty),
      unitPriceOverride: listWhole.toFixed(2),
      ...(discAmt.gt(0) ? { discountAmount: discAmt.toFixed(2) } : {}),
      ...(promotionId != null && promoDiscount.gt(0) ? { promotionId } : {}),
      ...(promoDiscount.gt(0) ? { promotionDiscount: promoDiscount.toFixed(2) } : {}),
      ...(cashierDiscount.gt(0) ? { cashierDiscountAmount: cashierDiscount.toFixed(2) } : {}),
    };
  }
  const promoPrice = (c.row as any).promotionEffectivePrice != null
    ? D((c.row as any).promotionEffectivePrice).toDecimalPlaces(0, 4 /* HALF_UP */)
    : listWhole;
  const eff = D(effectivePrice(c));
  const discAmt = listWhole.minus(eff).times(c.qty);
  const promotionId = (c.row as any).promotionId as number | null | undefined;

  const promoDiscount = promotionId != null && listWhole.gt(promoPrice)
    ? listWhole.minus(promoPrice).times(c.qty)
    : D(0);
  const cashierDiscount = promoPrice.gt(eff)
    ? promoPrice.minus(eff).times(c.qty)
    : D(0);

  return {
    variantId: c.row.variantId,
    productUnitId: c.row.productUnitId,
    quantity: String(c.qty),
    unitPriceOverride: listWhole.toFixed(2),
    ...(discAmt.gt(0) ? { discountAmount: discAmt.toFixed(2) } : {}),
    ...(promotionId != null ? { promotionId } : {}),
    ...(promoDiscount.gt(0) ? { promotionDiscount: promoDiscount.toFixed(2) } : {}),
    ...(cashierDiscount.gt(0) ? { cashierDiscountAmount: cashierDiscount.toFixed(2) } : {}),
  };
};

export const createTab = (id: number, label?: string): POSTab => ({
  id,
  label: label ?? `طلب ${id}`,
  cart: [],
  payInput: "",
  method: "CASH",
  selId: null,
  numMode: "PAY",
  customerId: null,
  tierOverride: null,
  clientRequestId: newClientRequestId(),
  couponInput: "",
  couponCode: null,
  couponLabel: null,
  couponFreeShippingPromo: null,
  paymentRef: "",
  externalPayment: null,
  paymentLegs: [],
  dueDate: "",
  invoiceDiscountPct: "",
  invoiceDiscountType: "percent",
  invoiceDiscountValue: "",
  delivery: null,
  salesRepId: null,
});

/** السقف الأعلى لخصم رأس الفاتورة اليدويّ عند الكاشير (قرار المالك). فوقه يستلزم اعتماد مدير
 *  خادمياً؛ الشاشة تُقصّه هنا لتجنّب رفضٍ متأخّر أمام العميل. */
export const CASHIER_INVOICE_DISCOUNT_MAX_PCT = 15;

export type InvoiceDiscountType = "percent" | "amount";

export interface InvoiceDiscountResult {
  discountType: InvoiceDiscountType;
  discountValue: string;
  discountAmountD: ReturnType<typeof D>;
  discountAmount: number;
  discountPctD: ReturnType<typeof D>;
  discountPct: number;
  maxDiscountAmountD: ReturnType<typeof D>;
  maxDiscountAmount: number;
}

/** حساب خصم الفاتورة بمرونة: نسبة مئوية (٠–١٥٪) أو مبلغ ثابت بالدينار مقصوصاً بالسقف المالي. */
export function computeInvoiceDiscount({
  subtotalD,
  effectiveHeaderCapPctD,
  invoiceDiscountAllowed,
  type = "percent",
  value = "",
}: {
  subtotalD: ReturnType<typeof D>;
  effectiveHeaderCapPctD: ReturnType<typeof D>;
  invoiceDiscountAllowed: boolean;
  type?: InvoiceDiscountType;
  value?: string;
}): InvoiceDiscountResult {
  const maxDiscountAmountD =
    subtotalD.gt(0) && effectiveHeaderCapPctD.gt(0)
      ? round2(subtotalD.times(effectiveHeaderCapPctD).div(100))
      : D(0);

  if (
    !invoiceDiscountAllowed ||
    !value ||
    value.trim() === "" ||
    subtotalD.lte(0)
  ) {
    return {
      discountType: type,
      discountValue: value,
      discountAmountD: D(0),
      discountAmount: 0,
      discountPctD: D(0),
      discountPct: 0,
      maxDiscountAmountD,
      maxDiscountAmount: maxDiscountAmountD.toNumber(),
    };
  }

  const norm = value.replace(/[،,]/g, ".");
  const rawNum = Number(norm);
  if (!Number.isFinite(rawNum) || rawNum <= 0) {
    return {
      discountType: type,
      discountValue: value,
      discountAmountD: D(0),
      discountAmount: 0,
      discountPctD: D(0),
      discountPct: 0,
      maxDiscountAmountD,
      maxDiscountAmount: maxDiscountAmountD.toNumber(),
    };
  }

  if (type === "percent") {
    const rawPctD = D(norm);
    const clampedPctD = rawPctD.gt(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      ? D(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      : rawPctD;
    const effectivePctD = clampedPctD.gt(effectiveHeaderCapPctD)
      ? effectiveHeaderCapPctD
      : clampedPctD;
    const discountAmountD = round2(subtotalD.times(effectivePctD).div(100));
    return {
      discountType: "percent",
      discountValue: value,
      discountAmountD,
      discountAmount: discountAmountD.toNumber(),
      discountPctD: effectivePctD,
      discountPct: effectivePctD.toNumber(),
      maxDiscountAmountD,
      maxDiscountAmount: maxDiscountAmountD.toNumber(),
    };
  } else {
    const rawAmtD = D(norm);
    const clampedAmtD = rawAmtD.gt(subtotalD) ? subtotalD : rawAmtD;
    const effectiveAmtD = clampedAmtD.gt(maxDiscountAmountD)
      ? maxDiscountAmountD
      : clampedAmtD;
    const discountAmountD = round2(effectiveAmtD);
    const discountPctD = subtotalD.gt(0)
      ? round2(discountAmountD.times(100).div(subtotalD))
      : D(0);
    return {
      discountType: "amount",
      discountValue: value,
      discountAmountD,
      discountAmount: discountAmountD.toNumber(),
      discountPctD,
      discountPct: discountPctD.toNumber(),
      maxDiscountAmountD,
      maxDiscountAmount: maxDiscountAmountD.toNumber(),
    };
  }
}

export type ShiftData = RouterOutputs["shifts"]["current"];

/** دالّة مقاسٍ سائل (clamp بوحدات الحاوية/الشاشة) — يبنيها PaymentPanel ويمرّرها لأجزائه. */
export type FluidFn = (min: number, ratio: number, max: number) => string;

// ─── Receipt builder ──────────────────────────────────────────────────────────

/** تحويل إيصال الكاشير لبيانات الإيصال المُعلَّم — يُطبع بالتصميم المعتمد نفسه على كل النواقل. */
export function buildBrandedReceipt(r: Receipt): ReceiptBrowserData {
  const subtotalForPrint = r.subtotal ?? r.total;
  const discountForPrint =
    r.invoiceDiscount != null && r.invoiceDiscount > 0
      ? r.invoiceDiscount
      : null;
  return {
    receiptNumber: r.invoiceNumber,
    invoiceId: r.invoiceId,
    date: r.printDate ?? r.date,
    time: r.printTime ?? null,
    cashierName: r.cashierName ?? null,
    customerName: r.customerName ?? null,
    shiftId: r.shiftId ?? null,
    items: r.lines.map((l) => ({
      name: `${l.name} (${l.unit})${l.disc ? ` −${l.disc}%` : ""}`,
      quantity: l.qty,
      price: l.price,
      total: l.total,
    })),
    subtotal: subtotalForPrint,
    discount: discountForPrint,
    cashRounding:
      r.cashRounding != null && r.cashRounding !== 0 ? r.cashRounding : null,
    total: r.total,
    paid: r.received,
    returnedTotal: r.returnedTotal,
    status: r.status,
    // «الباقي» يُطبع فقط حين يكون موجباً (فكّة فعلية) — كحارس الشاشة. الدفع المطابق/السريع
    // (بلا إدخال مبلغ) باقيه ٠ ⇒ لا سطر، بدل طباعة «الباقي: ‑الإجمالي» (باقٍ سالب لا معنى له).
    change: r.isCredit || r.change <= 0 ? null : r.change,
    credit: r.isCredit ? r.credit : null,
    paymentMode: r.delivery ? "COD" : null,
    paymentMethod: r.method,
    paymentLegs: r.paymentLegs ?? null,
    // ش١٠: تفاصيل الكروت تأتي من الخادم بعد التثبيت (§١٢.٣) — لا من حالة React قبل الحفظ.
    digitalDetails: r.digitalDetails ?? null,
    // م١ PR-B: كتلة التوصيل تُطبع بالراسم القائم نفسه (٨/٨) — الأجرة تمريرٌ لا إيراد.
    delivery: r.delivery ?? null,
    promoSummary: r.promoSummary ?? null,
    bounceBackCoupon: r.bounceBackCoupon ?? null,
  };
}

export function buildPosReceiptPromoSummary(opts: {
  cart: CartItem[];
  invoiceDiscount: number;
  delivery?: Receipt["delivery"];
  freeShippingPromoName?: string | null;
  couponLabel?: string | null;
  serverSummary?: {
    totalMerchandiseDiscount: string;
    offerNames: string[];
    freeShippingPromo: { promotionName: string; waivedAmount: string } | null;
  } | null;
}): PromoPrintSummary | null {
  const namesSet = new Set<string>();
  for (const n of opts.serverSummary?.offerNames ?? []) {
    if (n?.trim()) namesSet.add(n.trim());
  }
  let localMerchD = D(0);
  for (const c of opts.cart) {
    const discD = officialPromoDiscountOfItem(c);
    if (discD.gt(0)) {
      localMerchD = localMerchD.plus(discD);
      const pName = c.cartPromo?.promotionName ?? c.row.promotionName;
      if (pName?.trim()) namesSet.add(pName.trim());
    }
  }
  if (opts.couponLabel?.trim()) namesSet.add(opts.couponLabel.trim());

  const merchD =
    opts.serverSummary != null
      ? D(opts.serverSummary.totalMerchandiseDiscount || "0")
      : localMerchD;

  const serverFreeShip = opts.serverSummary?.freeShippingPromo ?? null;
  const isFreeShipping =
    Boolean(serverFreeShip) ||
    Boolean(
      opts.delivery &&
        opts.delivery.feeCollection === "SHOP" &&
        opts.freeShippingPromoName,
    );
  const fsName =
    serverFreeShip?.promotionName?.trim() ||
    opts.freeShippingPromoName?.trim() ||
    null;
  if (isFreeShipping && fsName) namesSet.add(fsName);

  const offerNames = Array.from(namesSet);
  if (merchD.lte(0) && !isFreeShipping && offerNames.length === 0) {
    return null;
  }

  const waivedD = serverFreeShip
    ? D(serverFreeShip.waivedAmount || "0")
    : isFreeShipping && opts.delivery
      ? D(opts.delivery.fee || "0")
      : D(0);
  const invDiscD = D(opts.invoiceDiscount || 0);
  const totalSavingsD = round2(merchD.plus(invDiscD).plus(waivedD));

  return {
    offerNames,
    merchandiseSavings: merchD.gt(0) ? round2(merchD).toFixed(2) : null,
    invoiceDiscount: invDiscD.gt(0) ? round2(invDiscD).toFixed(2) : null,
    freeShipping: isFreeShipping,
    waivedDeliveryAmount: waivedD.gt(0) ? round2(waivedD).toFixed(2) : null,
    totalSavings: totalSavingsD.gt(0) ? totalSavingsD.toFixed(2) : null,
  };
}


/** Settlement/return facts win over the original tender on recovered digital sales. */
export function digitalRecoveredReceiptMoney(sale: {
  total:string;paidAmount:string;paymentMethod:string;returnedTotal:string;invoiceStatus:string;cashRoundingAdjustment:string;
  settledCapture:{capturedAmount:string;refundAmount:string}|null;
}, tender:string) {
  const facts=invoicePrintAmounts({total:sale.total,paidAmount:sale.paidAmount,returnedTotal:sale.returnedTotal,status:sale.invoiceStatus});
  const revised=!!sale.settledCapture || D(sale.returnedTotal).gt(0) || facts.dead;
  const credit=D(facts.remainingAmount);
  const received=!revised && sale.paymentMethod==="CASH"?D(tender):D(sale.paidAmount);
  return {total:D(sale.total).toNumber(),received:received.toNumber(),
    change:!revised && sale.paymentMethod==="CASH"?received.minus(sale.total).clamp(0,Infinity).toNumber():0,
    credit:credit.toNumber(),isCredit:credit.gt(0),method:sale.paymentMethod,methodCode:sale.paymentMethod,
    cashRounding:D(sale.cashRoundingAdjustment).toNumber(),returnedTotal:sale.returnedTotal,status:sale.invoiceStatus};
}
