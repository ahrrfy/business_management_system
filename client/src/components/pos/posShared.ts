// أنواع الكاشير وثوابته ودوالّه النقيّة (Tier/CartItem/POSTab/Receipt/POS_COLORS/fmt/…).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { newClientRequestId } from "@/lib/countQueue";
import { D, round2 } from "@/lib/money";
import type { ReceiptBrowserData } from "@/lib/printing/print";
import type { StudentSnapshot } from "@/components/pos/StudentDetailsDialog";
import type { DigitalReceiptDetail } from "@/lib/printing/digitalReceiptLines";
import type { RouterOutputs } from "@/lib/trpc";

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

export type CartItem = {
  row: PosRow;
  /** لقطة السعر/العرض التلقائي قبل تطبيق كوبون، لاستعادتها عند تغيّر السلة أو إزالة الكوبون. */
  preCouponRow?: PosRow;
  qty: number;
  disc?: number;      // خصم % (0–100)
  origPrice?: number; // السعر الأصلي قبل الخصم
  digital?: DigitalLineMeta;
};

/** هوية السطر داخل السلة: البطاقة الرقمية بمعرّفها المستقلّ، وغيرها بـproductUnitId (السلوك القديم). */
export function lineIdOf(c: CartItem): number {
  return c.digital?.lineId ?? c.row.productUnitId;
}

export type POSTab = {
  id: number;
  label: string;
  cart: CartItem[];
  payInput: string;
  method: PaymentMethod;
  selId: number | null;   // productUnitId المحدد في السلة
  numMode: NumMode;
  customerId: number | null;
  tierOverride: Tier | null;
  clientRequestId: string; // مفتاح idempotency مستقلّ لكل تبويب — عزل مالي بين الفواتير
  couponInput: string;
  couponCode: string | null;
  couponLabel: string | null;
  /** مرجع عملية الدفع غير النقدي؛ يُثبّت أولاً في محاولة خادمية مستقلة. */
  paymentRef: string;
  externalPayment: ExternalPaymentDraft | null;
  /** تاريخ استحقاق البيع الآجل (YYYY-MM-DD، اختياري) — يصحّح أعمار الذمم والتذكيرات. */
  dueDate: string;
  /** خصم على رأس الفاتورة كنسبة مئوية (٠–١٥) أو كمبلغ ديناري. */
  invoiceDiscountPct: string;
  invoiceDiscountType?: "percent" | "amount";
  invoiceDiscountValue?: string;
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
  lines: { name: string; unit: string; qty: number; price: number; disc?: number; total: number }[];
  /** المجموع قبل خصم رأس الفاتورة. مساوٍ لـ`total` عند غياب الخصم. */
  subtotal?: number;
  /** مبلغ خصم رأس الفاتورة، إن وُجد. */
  invoiceDiscount?: number;
  /** تعديل التقريب النقديّ IQD (± د.ع، النقد الكامل فقط) — يطابق `cashRoundingAdj` الخادميّ. */
  cashRounding?: number;
  total: number;
  received: number;
  change: number;
  credit: number;
  method: string;
  /** كود الطريقة الخام (CASH/CARD/TRANSFER/WALLET) — للشارة الملوّنة والحفظ الأوفلاين. */
  methodCode?: string;
  isCredit: boolean;
  /** ش١٠: لقطات الكروت الرقمية من الخادم (اسم الكرت/المرجع/بيانات الطالب) — بلا أرقام داخلية. */
  digitalDetails?: DigitalReceiptDetail[] | null;
};

// ─── Colour Tokens — مَربوطة بـtokens.css لِتَتنفّس مع .dark بِلا MutationObserver ─

export const POS_COLORS = {
  bg:         "var(--pos-bg)",
  card:       "var(--pos-card)",
  border:     "var(--pos-border)",
  muted:      "var(--pos-muted)",
  mutedFg:    "var(--pos-muted-fg)",
  fg:         "var(--pos-fg)",
  primary:    "var(--pos-primary)",
  primaryH:   "var(--pos-primary-h)",
  primaryFg:  "var(--pos-primary-fg)",
  primarySoft:"var(--pos-primary-soft)",
  success:    "var(--pos-success)",
  successH:   "var(--pos-success-h)",
  amber:      "var(--pos-amber)",
  amberSoft:  "var(--pos-amber-soft)",
  danger:     "var(--pos-danger)",
  dangerSoft: "var(--pos-danger-soft)",
  modeActive: "var(--pos-mode-active)",
  modeBord:   "var(--pos-mode-bord)",
  modeFg:     "var(--pos-mode-fg)",
  numKey:     "var(--pos-numkey)",
  numKeyHov:  "var(--pos-numkey-hov)",
  delKey:     "var(--pos-delkey)",
  delFg:      "var(--pos-del-fg)",
  overlay:    "var(--pos-overlay)",
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
export const effectivePrice = (item: CartItem) => {
  if (item.digital) return D(item.row.price ?? 0).toNumber();
  const base = D((item.row as any).promotionEffectivePrice ?? item.row.price ?? 0);
  if (item.disc == null) return base.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
  const discounted = round2(base.times(D(100).minus(D(item.disc))).div(100));
  return discounted.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
};

export const itemTotal = (item: CartItem) => D(effectivePrice(item)).times(item.qty).toNumber();

// POS-ROUND (تدقيق ٢/٧): يبني سطر البيع للخادم بسعر وحدةٍ صحيح (دينار) مطابق تماماً لِما يعرضه
// ويحصّله الكاشير، مع تمرير الخصم كمبلغٍ صريح. كان العميل يرسل discountPercent فقط بينما يقرّب سعر
// الوحدة لدينار كامل، والخادم يحسب الخصم على إجمالي السطر بدقّة 2dp ⇒ invoices.total يخالف المبلغ
// المحصَّل (رفض بيع بطاقة/تحويل كامل، أو فرق درج في Z-report). بتثبيت unitPriceOverride=سعر القائمة
// الصحيح + discountAmount=(القائمة−الفعلي)×الكمية يصبح total الخادم = effectivePrice×qty حرفياً،
// ويبقى الخصم مسجَّلاً على بند الفاتورة.
export const buildSaleLine = (c: CartItem) => {
  const listWhole = D(c.row.price ?? 0).toDecimalPlaces(0, 4 /* HALF_UP */);
  const eff = D(effectivePrice(c));
  const discAmt = listWhole.minus(eff).times(c.qty);
  // promotions v2 (٨/٧/٢٦): إن كان الصفّ يحمل عرضاً من pos.ts، نمرّر `promotionId` كي يتحقّق الخادم
  // (idempotent) ويسجّل promotionId + promotionDiscount على invoiceItem. لو تغيّر العرض بين وقت
  // العرض والحفظ، الخادم يعامل الخصم كيدوي (لا رفض).
  const promotionId = (c.row as any).promotionId as number | null | undefined;
  return {
    variantId: c.row.variantId,
    productUnitId: c.row.productUnitId,
    quantity: String(c.qty),
    unitPriceOverride: listWhole.toFixed(2),
    ...(discAmt.gt(0) ? { discountAmount: discAmt.toFixed(2) } : {}),
    ...(promotionId != null ? { promotionId } : {}),
  };
};

export const createTab = (id: number, label?: string): POSTab => ({
  id, label: label ?? `طلب ${id}`,
  cart: [], payInput: "", method: "CASH",
  selId: null, numMode: "PAY",
  customerId: null, tierOverride: null,
  clientRequestId: newClientRequestId(),
  couponInput: "", couponCode: null, couponLabel: null,
  paymentRef: "", externalPayment: null, dueDate: "",
  invoiceDiscountPct: "",
  invoiceDiscountType: "percent",
  invoiceDiscountValue: "",
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
  const maxDiscountAmountD = (subtotalD.gt(0) && effectiveHeaderCapPctD.gt(0))
    ? round2(subtotalD.times(effectiveHeaderCapPctD).div(100))
    : D(0);

  if (!invoiceDiscountAllowed || !value || value.trim() === "" || subtotalD.lte(0)) {
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
  const discountForPrint = r.invoiceDiscount != null && r.invoiceDiscount > 0 ? r.invoiceDiscount : null;
  return {
    receiptNumber: r.invoiceNumber,
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
    cashRounding: r.cashRounding != null && r.cashRounding !== 0 ? r.cashRounding : null,
    total: r.total,
    paid: r.received,
    // «الباقي» يُطبع فقط حين يكون موجباً (فكّة فعلية) — كحارس الشاشة. الدفع المطابق/السريع
    // (بلا إدخال مبلغ) باقيه ٠ ⇒ لا سطر، بدل طباعة «الباقي: ‑الإجمالي» (باقٍ سالب لا معنى له).
    change: r.isCredit || r.change <= 0 ? null : r.change,
    credit: r.isCredit ? r.credit : null,
    paymentMethod: r.method,
    // ش١٠: تفاصيل الكروت تأتي من الخادم بعد التثبيت (§١٢.٣) — لا من حالة React قبل الحفظ.
    digitalDetails: r.digitalDetails ?? null,
  };
}
