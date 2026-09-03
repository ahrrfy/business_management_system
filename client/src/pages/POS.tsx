/**
 * نقطة البيع — الرؤية العربية
 * تصميم Odoo 19-style مع multi-tab، حاسبة ذكية، مسح باركود آني، وإدارة وردية كاملة.
 */
import CustomerPicker from "@/components/CustomerPicker";
import { AppSelect } from "@/components/ui/AppSelect";
import { CashDropDialog } from "@/components/pos/CashDropDialog";
import {
  discardLegacyPosDrafts,
  loadPosTabsDraft,
  posTabsDraftKey,
  savePosTabsDraft,
  type PosDraftScope,
} from "@/lib/cartDraft";
import { newClientRequestId } from "@/lib/countQueue";
import { variantDisplayName } from "@shared/variantDisplay";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { D, formatIqd, roundCashIQD, round2 } from "@/lib/money";
import { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter, printReceipt, printShiftOpen, printShiftClose, getServerBridgeStatus, serverPrintTest, type ReceiptBrowserData } from "@/lib/printing/print";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMediaQuery } from "@/hooks/useMobile";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { offlineFindByBarcode, offlineSearchCatalog, useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import { allocateOfflineReceiptNumber, assertCanCapture, enqueueOfflineSale, getDeviceCode, isOfflineSaleEnabled, readOutboxSummary, subscribeOutbox } from "@/lib/offline/outbox";
import { getOfflineProfile, saveOfflineProfile } from "@/lib/offline/pinLock";
import { getMeta, setMeta } from "@/lib/offline/db";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { DigitalCardsPickerDialog, type ConfirmedCard, type DigitalSaleCapture } from "@/components/pos/DigitalCardsPickerDialog";
import { DigitalFulfillmentDialog } from "@/components/pos/DigitalFulfillmentDialog";
import type { StudentSnapshot } from "@/components/pos/StudentDetailsDialog";
import type { DigitalReceiptDetail } from "@/lib/printing/digitalReceiptLines";
import { parseScan } from "@/lib/scanRouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Printer, ShoppingCart, User, Power, Globe, Check, Store, Search, X, AlertTriangle, Banknote, CreditCard, Zap, ChevronDown, ChevronUp, Send, Wallet, Percent, Calculator, PackagePlus } from "lucide-react";
import { paymentMethodLabel, paymentMethodClass } from "@/lib/paymentMethod";
import { markPosTabsStockStale, reconcilePosTabsStock } from "@/lib/posStockRefresh";
import { CopyButton } from "@/components/CopyButton";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PasswordInput } from "@/components/form/PasswordInput";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { POS_EXTERNAL_PAYMENT_PROOF_HINT } from "@shared/posPaymentPolicy";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { ACTION_LABELS } from "@shared/actionLabels";
import { applyPosQuantityKey } from "@/lib/posQuantityEntry";
import { createPortal } from "react-dom";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type NumMode = "QTY" | "DISC" | "PAY";
type PosRow = RouterOutputs["catalog"]["posList"][number];

type ExternalPaymentDraft = {
  attemptId: number | null;
  requestId: string;
  fingerprint: string;
  state: "INITIATED" | "CONFIRMED";
  deviceId?: string;
};

const DIGITAL_CART_BLOCKS_REGULAR_MESSAGE =
  "السلة الحالية للبطاقات الرقمية فقط. أفرغ السلة أو أكمل بيعها قبل إضافة منتج عادي.";
const REGULAR_CART_BLOCKS_DIGITAL_MESSAGE =
  "السلة الحالية للمنتجات العادية فقط. أفرغ السلة أو أكمل بيعها قبل إضافة بطاقة رقمية.";

/** وسم سطر بطاقة رقمية (ش٥). كل مثيل مستقلّ حتى لو تكرّرت الفئة نفسها في السلة. */
type DigitalLineMeta = {
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
  requiresStudentData: boolean;
  /** لقطة بيانات الطالب (ش٦) — تُثبَّت داخل معاملة البيع لاحقاً، لا عند الإضافة للسلة. */
  student?: StudentSnapshot;
};

type CartItem = {
  row: PosRow;
  /** لقطة السعر/العرض التلقائي قبل تطبيق كوبون، لاستعادتها عند تغيّر السلة أو إزالة الكوبون. */
  preCouponRow?: PosRow;
  qty: number;
  disc?: number;      // خصم % (0–100)
  origPrice?: number; // السعر الأصلي قبل الخصم
  digital?: DigitalLineMeta;
};

/** هوية السطر داخل السلة: البطاقة الرقمية بمعرّفها المستقلّ، وغيرها بـproductUnitId (السلوك القديم). */
function lineIdOf(c: CartItem): number {
  return c.digital?.lineId ?? c.row.productUnitId;
}

type POSTab = {
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
  /** خصم على رأس الفاتورة كنسبة مئوية (٠–١٥). سلطة الكاشير مقصورة على هذا السقف؛ ما فوقه
   *  بوّابة مدير خادمياً (`invoiceDiscountExceedsThreshold`). فارغ ⇒ لا خصم. */
  invoiceDiscountPct: string;
};

type Receipt = {
  invoiceNumber: string;
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

const POS_COLORS = {
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

type C = typeof POS_COLORS;

// ─── Constants ────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };
// METHOD_LABEL انتقل إلى lib/paymentMethod.ts — مصدر واحد مع Invoices/InvoiceDetail/حوار الوردية.
const QUICK_AMTS = [5000, 10000, 25000, 50000, 100000];
const SHOP = "الرؤية العربية";
const SCAN_MS = 80;

// ─── Utility ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
const money = (n: number) => n.toFixed(2);

// §٥: سعر فعّال يحسب الخصم بدقّة Decimal (لا Number×float×Math.round) — يصون الفلوس
// عبر مضاعفات الخصم ١٠.٥٪، ٣٣.٣٣٪، إلخ. يُقرَّب 2dp ثم يعاد رقماً للعرض.
// promotions v2 (٨/٧/٢٦): إن مرّر pos.ts `promotionEffectivePrice` (السعر بعد الخصم الترويجي)،
// نستعمله كنقطة انطلاق (بدل السعر الأصلي) قبل تطبيق أي خصم يدوي من الكاشير. الترتيب: العرض أوّلاً
// ثم الخصم اليدوي — بحيث لا يُلغي الكاشير العرض بلا وعي (يمكنه إضافة خصم فوقه).
const effectivePrice = (item: CartItem) => {
  const base = D((item.row as any).promotionEffectivePrice ?? item.row.price ?? 0);
  if (item.disc == null) return base.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
  const discounted = round2(base.times(D(100).minus(D(item.disc))).div(100));
  return discounted.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
};

const itemTotal = (item: CartItem) => effectivePrice(item) * item.qty;

// POS-ROUND (تدقيق ٢/٧): يبني سطر البيع للخادم بسعر وحدةٍ صحيح (دينار) مطابق تماماً لِما يعرضه
// ويحصّله الكاشير، مع تمرير الخصم كمبلغٍ صريح. كان العميل يرسل discountPercent فقط بينما يقرّب سعر
// الوحدة لدينار كامل، والخادم يحسب الخصم على إجمالي السطر بدقّة 2dp ⇒ invoices.total يخالف المبلغ
// المحصَّل (رفض بيع بطاقة/تحويل كامل، أو فرق درج في Z-report). بتثبيت unitPriceOverride=سعر القائمة
// الصحيح + discountAmount=(القائمة−الفعلي)×الكمية يصبح total الخادم = effectivePrice×qty حرفياً،
// ويبقى الخصم مسجَّلاً على بند الفاتورة.
const buildSaleLine = (c: CartItem) => {
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

const createTab = (id: number, label?: string): POSTab => ({
  id, label: label ?? `طلب ${id}`,
  cart: [], payInput: "", method: "CASH",
  selId: null, numMode: "PAY",
  customerId: null, tierOverride: null,
  clientRequestId: newClientRequestId(),
  couponInput: "", couponCode: null, couponLabel: null,
  paymentRef: "", externalPayment: null, dueDate: "",
  invoiceDiscountPct: "",
});

/** السقف الأعلى لخصم رأس الفاتورة اليدويّ عند الكاشير (قرار المالك). فوقه يستلزم اعتماد مدير
 *  خادمياً؛ الشاشة تُقصّه هنا لتجنّب رفضٍ متأخّر أمام العميل. */
const CASHIER_INVOICE_DISCOUNT_MAX_PCT = 15;

// ─── useSmartScanInput ────────────────────────────────────────────────────────

function useSmartScanInput(onBarcode: (code: string) => Promise<void>) {
  const prevMsRef  = useRef(0);
  const bufRef     = useRef("");
  const inScanRef  = useRef(false);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fire = useCallback(
    (setValue: (s: string) => void) => {
      clearTimeout(timerRef.current);
      const code = normalizeBarcodeScannerInput(bufRef.current);
      bufRef.current = "";
      inScanRef.current = false;
      if (code.length >= 4) {
        setValue("");
        onBarcode(code);
      } else {
        // إدخال بشري قصير أُسيء تصنيفه كمسح (نقرتان سريعتان <٨٠مي، وليس باركوداً ≥٤ خانات) —
        // أعِد النصّ المكتوب بدل ابتلاعه صامتاً. لا يمسّ مسار المسح الحقيقي إطلاقاً (≥٤ يُمسح ويُبحث كالسابق).
        setValue(code);
      }
    },
    [onBarcode]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, curVal: string, setValue: (s: string) => void) => {
      const now = Date.now();
      const prevMs = prevMsRef.current;
      prevMsRef.current = now;
      const gap = now - prevMs;

      if (e.key === "Enter") {
        clearTimeout(timerRef.current);
        if (inScanRef.current && bufRef.current.length >= 4) {
          e.preventDefault();
          fire(setValue);
        }
        return;
      }
      if (e.key === "Escape") {
        clearTimeout(timerRef.current);
        bufRef.current = "";
        inScanRef.current = false;
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;

      if (inScanRef.current) {
        e.preventDefault();
        bufRef.current += e.key;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fire(setValue), SCAN_MS * 6);
        return;
      }

      if (prevMs > 0 && gap < SCAN_MS) {
        e.preventDefault();
        bufRef.current = curVal + e.key;
        inScanRef.current = true;
        setValue("");
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fire(setValue), SCAN_MS * 6);
      }
    },
    [fire]
  );

  return { handleKeyDown };
}

// ─── Receipt builder ──────────────────────────────────────────────────────────

/** تحويل إيصال الكاشير لبيانات الإيصال المُعلَّم — يُطبع بالتصميم المعتمد نفسه على كل النواقل. */
function buildBrandedReceipt(r: Receipt): ReceiptBrowserData {
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

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Main POS Component ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export default function POS() {
  const C: C = POS_COLORS;

  const me       = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const utils    = trpc.useUtils();

  // «وضع الافتتاح» (ش٥): لافتة + وسم «غير مجرود» — مرآة عرضية فقط، الحارس الفعلي خادميّ في sale/create.
  const openingModeQ = trpc.system.getOpeningMode.useQuery(undefined, { staleTime: 60_000 });
  const openingActive = openingModeQ.data?.active === true;

  // ش٢ أوفلاين: حالة الاتصال + مزامنة النموذج المحلي (كتالوج/مخزون/عملاء) دورياً وعند العودة.
  const connState = useConnectivity();
  const offline = isDisconnected(connState);

  // ش٥ — إقلاع دون اتصال: هوية الجهاز وورديته من آخر جلسة أونلاين معلومة (ملف الجهاز +
  // كاش آخر وردية مفتوحة) ⇒ الكاشير يواصل البيع بعد إعادة تشغيل الجهاز والقطع مستمر.
  const [offlineBoot, setOfflineBoot] = useState<{ userId: number | null; branchId: number | null; shiftId: number | null; name: string | null } | null>(null);
  useEffect(() => {
    if (me.data) { setOfflineBoot(null); return; }
    void (async () => {
      const profile = await getOfflineProfile();
      let cachedShiftId: number | null = null;
      try {
        const raw = await getMeta("lastOpenShift");
        if (raw) cachedShiftId = Number((JSON.parse(raw) as { id?: number }).id) || null;
      } catch { /* كاش تالف ⇒ بلا وردية بديلة */ }
      setOfflineBoot({ userId: profile?.userId ?? null, branchId: profile?.branchId ?? null, shiftId: cachedShiftId, name: profile?.name ?? null });
    })();
  }, [me.data]);

  // الأدمن/المدير **بلا فرع مُسنَد** (نظريّ عادةً — الأدمن المبذور مُسنَد لفرع MAIN): بدل إسناد
  // مبيعاته صامتاً للفرع ١، نطلب اختيار الفرع صراحةً قبل فتح الوردية (الوردية تحمل الفرع، والبيع
  // يتبعها). لا يمسّ كاشيراً/مستخدماً له فرع (الشرط أدناه يسقط فوراً فيبقى branchId = فرعه).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = me.data?.branchId ?? offlineBoot?.branchId ?? pickedBranch ?? 1;
  const activeBranchName = (branches.data ?? []).find((branch) => Number(branch.id) === branchId)?.name ?? `فرع #${branchId}`;
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";
  const noAssignedBranch = me.data != null && me.data.branchId == null && offlineBoot?.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && pickedBranch == null;
  useOfflineCatalogSync(me.data ? branchId : null);

  // ش٥: حفظ ملف الجهاز عند كل جلسة أونلاين — وقود بوابة PIN والإقلاع الأوفلايني.
  useEffect(() => {
    if (me.data) {
      void saveOfflineProfile({
        id: me.data.id,
        name: me.data.name ?? "",
        role: me.data.role ?? "",
        branchId: me.data.branchId ?? null,
      });
    }
  }, [me.data]);

  // ش٥: مفتاح تجربة البيع الأوفلايني (لكل جهاز، افتراضياً معطَّل — قرار مالك).
  const [offlineSaleOn, setOfflineSaleOn] = useState(false);
  useEffect(() => {
    void isOfflineSaleEnabled().then(setOfflineSaleOn);
    const off = subscribeOutbox(() => void isOfflineSaleEnabled().then(setOfflineSaleOn));
    return off;
  }, []);

  // كاشير التجزئة: وردية RETAIL خاصّة (منفصلة عن درج خدمة العملاء RECEPTION).
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RETAIL" });
  // العهدة لا تصل إلى الدرج بمجرد طلب المالك. نظهرها في محطة الكاشير نفسها كي
  // يؤكد الاستلام الفعلي، بدل الاعتماد على رابط إداري مخفي عن تنقله.
  const fundingRequestsQ = trpc.shifts.fundingRequests.useQuery(undefined, {
    enabled: me.data != null && !offline,
  });
  const acceptFundingM = trpc.shifts.respondFunding.useMutation({
    onSuccess: async () => {
      notify.ok("أضيفت العهدة إلى الدرج بعد تأكيد الاستلام");
      await Promise.all([fundingRequestsQ.refetch(), shiftQ.refetch()]);
    },
    onError: (error) => notify.errBig(error),
  });
  // ش٥: وردية بديلة للإقلاع الأوفلايني — آخر وردية مفتوحة معلومة على هذا الجهاز. تُفعِّل مسارات
  // الالتقاط فقط (الإغلاق/التقرير أونلاينيان، والخادم يتحقق من الوردية فعلياً عند الترحيل).
  const shift = shiftQ.data
    ?? (offline && offlineBoot?.shiftId
      ? ({ id: offlineBoot.shiftId } as NonNullable<typeof shiftQ.data>)
      : undefined);
  // قد يملك الموظف أدراجاً مستقلة RETAIL/RECEPTION/PRINT_SERVICES. محطة POS تعرض عهدة درجها الحالي
  // وحدها حتى لا يؤكد الكاشير نقداً مسلماً لدرج آخر.
  const posFundingRequests = (fundingRequestsQ.data ?? []).filter(
    (request) => shift?.id != null && Number(request.shiftId) === Number(shift.id),
  );

  // ش٥: كاش آخر وردية مفتوحة (يتجدد أونلاين؛ يُمسح عند غيابها كي لا يُلتقط على وردية بائدة).
  useEffect(() => {
    if (shiftQ.data?.id) void setMeta("lastOpenShift", JSON.stringify({ id: shiftQ.data.id, branchId }));
    else if (shiftQ.isSuccess && !shiftQ.data) void setMeta("lastOpenShift", "");
  }, [shiftQ.data?.id, shiftQ.isSuccess, branchId]);

  // ── Multi-tab State ──────────────────────────────────────────────────────
  const [tabs,     setTabs]     = useState<POSTab[]>([createTab(1, "طلب 1")]);
  const [activeId, setActiveId] = useState(1);
  // ٢٣/٨ (Codex P2) — عدّاد إضافة صريح: يزيد فقط عند `addRow` (شامل رفع الكمية على السطر الأصل).
  // لا يزيد عند حذف/تعديل كمية/تبديل تبويب ⇒ لا يقفز الجدول من دون فعل الكاشير، وإعادة مسح
  // السطر المحدَّد نفسه تشغّل التمرير أيضاً (بلاغ Codex «rescan لا يحرّك التأثير»).
  const [addTick, setAddTick] = useState(0);

  // مرجع حيّ للتبويب النشط: تستهدفه كل تعديلات السلّة/الطلب بدل activeId المُغلَق عليه، كي
  // تصيب التبويب الصحيح حتى حين تُستدعى من إغلاق قديم (مسح الباركود/HID). مُحدَّث في كل رسم.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cart      = activeTab.cart;

  // السلال والمسودات تحفظ السعر والكمية، لكنها لا تملك الرصيد. نعيد قراءة رصيد كل الوحدات
  // الموجودة في جميع التبويبات من الخادم دورياً؛ بذلك لا يبقى حساب على لقطة سبقت بيعاً/جرداً.
  const cartUnitIds = useMemo(
    () => Array.from(new Set(tabs.flatMap((tab) => tab.cart.map((item) => item.row.productUnitId)))).slice(0, 500),
    [tabs],
  );
  const liveCartStockQ = trpc.catalog.stockByUnitIds.useQuery(
    { branchId, productUnitIds: cartUnitIds },
    {
      enabled: !offline && cartUnitIds.length > 0,
      staleTime: 0,
      refetchInterval: !offline && cartUnitIds.length > 0 ? 15_000 : false,
      refetchOnWindowFocus: true,
    },
  );
  useEffect(() => {
    const snapshot = liveCartStockQ.data;
    if (!snapshot) return;
    setTabs((current) => reconcilePosTabsStock(current, snapshot.rows, snapshot.branchId));
  }, [liveCartStockQ.data]);

  // ── UI State ─────────────────────────────────────────────────────────────
  const [search,         setSearch]         = useState("");
  const [showDrop,       setShowDrop]       = useState(false);
  const [receipt,        setReceipt]        = useState<Receipt | null>(null);
  // خطأ بيع حرِج ثابت (نقص مخزون/رفض) — بديلٌ دائم عن toast العابر: يبقى في لوحة الدفع حتى يبدأ الكاشير محاولة جديدة أو يُغلقه.
  const [saleError,      setSaleError]      = useState<string | null>(null);
  const [lastInv,        setLastInv]        = useState<{ num: string; total: number } | null>(null);
  const [shifting,       setShifting]       = useState(false);
  const [cashDropping,   setCashDropping]   = useState(false);
  const [opening,        setOpening]        = useState("0");
  const [creditPrompt,   setCreditPrompt]   = useState<string | null>(null);
  const [mgrEmail,       setMgrEmail]       = useState("");
  const [mgrPwd,         setMgrPwd]         = useState("");
  const [printerReady,   setPrinterReady]   = useState(isPaired());
  const [bridge,         setBridge]         = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });
  const [showCustPicker, setShowCustPicker] = useState(false);
  const [restoredDraftKey, setRestoredDraftKey] = useState<string | null>(null);
  const [headerActionsNode, setHeaderActionsNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHeaderActionsNode(document.getElementById("pos-header-actions"));
  }, []);

  // تحت 1024px (اللوحي/الأصغر) تُكدَّس لوحتا الكاشير عمودياً بدل الصفّ الأفقي ذي العرض الثابت.
  // القيد الحاكم عند زوم المتصفح هو الارتفاع لا العرض (الزوم يُقلّص المساحة بوحدات CSS)،
  // فتُضاف عتبة ارتفاع وإلّا بقيت البنية أفقيّةً في علبةٍ لا تتّسع لها.
  const stacked = useMediaQuery("(max-width: 1023px), (max-height: 620px)");

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyEntryRef = useRef({ tabId: activeId, lineId: null as number | null, replaceNextDigit: true });

  // ── Tab helpers ───────────────────────────────────────────────────────────
  // كل التعديلات على التبويب النشط تمرّ عبر activeIdRef.current (لا activeId المُغلَق عليه)
  // ⇒ تصيب التبويب الصحيح دائماً حتى من إغلاق قديم (مسح باركود/HID) — عزل تبويبات تام.
  function patchTab(id: number, patch: Partial<POSTab>) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function patchActive(patch: Partial<POSTab>) {
    patchTab(activeIdRef.current, patch);
  }
  function setCart(updater: CartItem[] | ((c: CartItem[]) => CartItem[])) {
    const id = activeIdRef.current;
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== id ? t :
        { ...t, cart: typeof updater === "function" ? updater(t.cart) : updater }
      )
    );
  }
  function setPayInput(updater: string | ((s: string) => string)) {
    const id = activeIdRef.current;
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== id ? t :
        { ...t, payInput: typeof updater === "function" ? updater(t.payInput) : updater }
      )
    );
  }
  const setSelId = (v: number | null) => {
    qtyEntryRef.current = { tabId: activeIdRef.current, lineId: v, replaceNextDigit: true };
    patchActive({ selId: v });
  };
  const setNumMode = (v: NumMode) => {
    if (v === "QTY") {
      qtyEntryRef.current = { tabId: activeIdRef.current, lineId: activeTab.selId, replaceNextDigit: true };
    }
    patchActive({ numMode: v });
  };
  const setMethod  = (v: PaymentMethod)  => patchActive({ method: v, externalPayment: null });
  const resetCouponItems = (items: CartItem[]) => items.map((item) => item.preCouponRow ? { ...item, row: item.preCouponRow, preCouponRow: undefined, disc: undefined } : item);
  const clearAppliedCoupon = () => {
    setCart((items) => resetCouponItems(items));
    patchActive({ couponCode: null, couponLabel: null });
  };
  const setCustId  = (v: number | null)  => {
    clearAppliedCoupon();
    patchActive({ customerId: v, tierOverride: null });
  };
  const setTierOvr = (v: Tier | null)    => patchActive({ tierOverride: v });

  function addTab() {
    // معرّف فريد مشتقّ من التبويبات الحالية (لا عدّاد وحدة يُصفَّر عند إعادة التحميل) ⇒ لا تصادم
    // معرّفات بعد استرجاع المسوّدة (تصادم المعرّف يخلط تبويبين).
    const id = (tabs.length ? Math.max(...tabs.map((t) => t.id)) : 0) + 1;
    setTabs((prev) => [...prev, createTab(id)]);
    setActiveId(id);
    setSearch(""); setShowDrop(false);
    setTimeout(() => searchRef.current?.focus(), 80);
  }
  function closeTab(id: number) {
    if (tabs.length <= 1) return;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  }

  // ── Cart draft — عزل صريح بالفرع + المستخدم + الوردية ───────────────────
  const draftScope: PosDraftScope | null = shift?.id && (me.data?.id ?? offlineBoot?.userId)
    ? { branchId, userId: (me.data?.id ?? offlineBoot!.userId)!, shiftId: shift.id }
    : null;
  const DRAFT_KEY = draftScope ? posTabsDraftKey(draftScope) : null;

  useEffect(() => {
    if (!draftScope || !DRAFT_KEY) {
      // إغلاق الوردية/تبديل الهوية يزيل الفاتورة من الذاكرة فوراً؛ لا تنتظر فتح
      // الوردية التالية كي تُصفّر حالة React القديمة.
      if (restoredDraftKey !== null) {
        setTabs([createTab(1, "طلب 1")]);
        setActiveId(1);
        setRestoredDraftKey(null);
      }
      return;
    }
    if (restoredDraftKey === DRAFT_KEY) return;

    // الصيغ الفرعية القديمة مجهولة المالك، ولذلك تُتلف ولا تُهاجر إلى النطاق الجديد.
    discardLegacyPosDrafts(localStorage, branchId);
    const saved = loadPosTabsDraft<POSTab>(localStorage, draftScope);
    if (saved) {
      const hadLegacyDigital = saved.tabs.some((t) => t.cart.some((c) => c.digital && (!c.digital.providerReference || !c.digital.providerId)));
      // المسوّدات الأقدم لا تحمل paymentRef/dueDate — تُستكمل بفراغ كي لا تُرسَل undefined.
      setTabs(markPosTabsStockStale(saved.tabs.map((t) => ({
        ...t,
        cart: t.cart.filter((c) => !c.digital || (!!c.digital.providerReference && !!c.digital.providerId)),
        clientRequestId: t.clientRequestId ?? newClientRequestId(),
        // لا نُعيد إحياء طريقة/محاولة خارجية قديمة من localStorage بعد إغلاق السطح.
        method: "CASH" as PaymentMethod,
        paymentRef: "",
        externalPayment: null,
        dueDate: t.dueDate ?? "",
      }))));
      if (hadLegacyDigital) notify.warn("أُزيلت كروت قديمة غير مكتملة من المسودة", "أعد إضافتها مع رقم العملية قبل البيع.");
      setActiveId(saved.tabs.some((t) => t.id === saved.activeId) ? saved.activeId : saved.tabs[0].id);
    } else {
      setTabs([createTab(1, "طلب 1")]);
      setActiveId(1);
    }
    setRestoredDraftKey(DRAFT_KEY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DRAFT_KEY]);

  useEffect(() => {
    // لا تحفظ حالة الوردية السابقة تحت مفتاح الوردية الجديدة أثناء رسم الانتقال.
    if (!draftScope || !DRAFT_KEY || restoredDraftKey !== DRAFT_KEY) return;
    savePosTabsDraft(localStorage, draftScope, tabs, activeId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, DRAFT_KEY, restoredDraftKey]);

  // ── Derived ───────────────────────────────────────────────────────────────
  // S5 (٢٩/٦): العميل المختار = قراءة فورية من القائمة المحمَّلة (الشائع ≤٥٠٠ ⇒ بلا وميض تسعير)،
  // مع fallback إلى customers.get للعميل خارج أوّل ٥٠٠ (يُختار عبر باركود/بحث/مسوّدة). يصلح علّة صحّة
  // عند ١٠٠×: قبلُ كان selectedCustomer=null لغير المحمَّل ⇒ تسعير RETAIL خاطئ + فقدان الرصيد.
  // (تحويل القائمة المنسدلة نفسها لبحث شريحة لاحقة يُلغي تحميل ٥٠٠ عند الإقلاع.)
  const customers = trpc.customers.list.useQuery();
  const fromList = useMemo(
    () => (customers.data ?? []).find((c) => c.id === activeTab.customerId) ?? null,
    [customers.data, activeTab.customerId]
  );
  const needFetch = activeTab.customerId != null && !fromList;
  const fetchedCustomer = trpc.customers.get.useQuery(
    { customerId: activeTab.customerId ?? 0 },
    { enabled: needFetch, staleTime: 60_000 },
  );
  const selectedCustomer = fromList ?? fetchedCustomer.data ?? null;
  const effectiveTier: Tier =
    activeTab.tierOverride ??
    (selectedCustomer?.defaultPriceTier as Tier | undefined) ??
    "RETAIL";

  // §٥: حساب الإجمالي/المدفوع/الباقي/الفكّة بدقّة Decimal (لا JS Number) — يصون المبالغ
  // على المطبوعات (إيصال + شاشة) ويلغي انجراف 0.1+0.2=0.30000000000000004.
  const subtotalD = cart.reduce((s, c) => s.plus(D(itemTotal(c))), D(0));
  // البطاقات الرقميّة (§٧) — لا يُطبَّق خصم رأس فاتورة على سلّة كروتٍ أصلاً:
  // مسار `startDigitalFulfillment` يمرّ عبر `digitalCards.sales.finalize` الذي **لا يعرف
  // `invoiceDiscount`** — لو مرّرناه محلياً لأعرض الكاشير 2,520 وينفَّذ 2,800 (درج ناقص + رفض
  // مطابقة `expectedTotal` على البطاقات المدفوعة). البوّابة تفصل الحالتين قبل الإرسال.
  const cartHasDigital = cart.some((c) => c.digital);
  const cartHasRegular = cart.some((c) => !c.digital);
  // يقرأ مسار الباركود/HID الحالة الحيّة من المرجع؛ callback البحث async وقد يبقى من رسم سابق.
  const cartHasDigitalRef = useRef(cartHasDigital);
  cartHasDigitalRef.current = cartHasDigital;
  const cartAllDigital = cart.length > 0 && cart.every((c) => c.digital);
  const invoiceDiscountAllowed = !cartAllDigital && !cartHasDigital;
  // خصم رأس الفاتورة (٢٢/٨) — نسبة يُدخلها الكاشير، مقصوصة إلى [0, CASHIER_INVOICE_DISCOUNT_MAX_PCT].
  // قصٌّ محلّي أمام العين (ما فوق ١٥٪ يُرفض خادمياً بلا اعتماد مدير) + قصّ ثانٍ إلى subtotal
  // كي لا يُنشئ صافياً سالباً لو أُدخلت نسبة كبيرة على سلة تتبدّل. مساوٍ لعقد الخادم
  // (`computeInvoiceTotals` يقصّ الخصم إلى `[0, subtotal]` ويرفض السالب صراحةً).
  // كذلك — نطرح **الانحرافَ الأصليّ للأسطر** من سقفنا: بوّابة الخادم `invoiceDiscountExceedsThreshold`
  // تقيس (refGross − invoiceNet)/refGross مقابل ١٥٪، وترى انحراف السطر (عرض/خصم يدويّ) والرأس معاً.
  // لولا هذا: سلّةٌ عليها عرضٌ ١٠٪ + خصمُ رأسٍ ١٠٪ = انحراف ١٩٪ ⇒ رفضٌ خادميّ يُفاجأ به الكاشير.
  const referenceGrossD = cart.reduce((s, c) => {
    // بدون خصم يدويّ = سعرُ القائمة (سعر السطر الأصل) × الكمية. البطاقات الرقمية مستثناةٌ من الحساب
    // مثلها في الخادم (بوابةُ الرأس تتخطّى `digital` أصلاً — التسعير عقدٌ خارجيّ لا انحرافٌ يدويّ).
    if (c.digital) return s;
    const refUnit = D((c.row as any).contractUnitPrice ?? c.row.price ?? 0);
    return s.plus(refUnit.times(c.qty));
  }, D(0));
  const rawInvoiceDiscountPctD = D(activeTab.invoiceDiscountPct || 0);
  const clampedByFieldD = rawInvoiceDiscountPctD.lt(0)
    ? D(0)
    : rawInvoiceDiscountPctD.gt(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      ? D(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      : rawInvoiceDiscountPctD;
  // **السقف الفعّال المتبقّي**: عتبةُ الخادم ١٥٪ تُقاس على المرجع، فإن كان في السلّة انحرافٌ سطريّ
  // مسبق (`refGross − subtotal`)، فسلطةُ الكاشير على الرأس = ١٥٪ − (نسبةُ الانحراف المسبقة)،
  // مقيسةً على الصافي الحاليّ (subtotal). قيمةٌ سالبةٌ ⇒ صفرٌ (لا سلطة).
  const priorDeviationRatioD = referenceGrossD.gt(0)
    ? referenceGrossD.minus(subtotalD).div(referenceGrossD)
    : D(0);
  const remainingHeaderAuthorityFractionD = D(0.15).minus(priorDeviationRatioD);
  const remainingHeaderPctOnSubtotalD = (subtotalD.gt(0) && referenceGrossD.gt(0))
    ? remainingHeaderAuthorityFractionD.times(referenceGrossD).div(subtotalD).times(100)
    : D(CASHIER_INVOICE_DISCOUNT_MAX_PCT);
  const effectiveHeaderCapPctD = (remainingHeaderPctOnSubtotalD.lt(0)
    ? D(0)
    : remainingHeaderPctOnSubtotalD.gt(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      ? D(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      : remainingHeaderPctOnSubtotalD).toDecimalPlaces(2, 1 /* ROUND_DOWN */);
  const invoiceDiscountPctD = invoiceDiscountAllowed
    ? (clampedByFieldD.gt(effectiveHeaderCapPctD) ? effectiveHeaderCapPctD : clampedByFieldD)
    : D(0);
  const invoiceDiscountAmountD = round2(subtotalD.times(invoiceDiscountPctD).div(100));
  const invoiceDiscountAmount = invoiceDiscountAmountD.toNumber();
  const subtotal = round2(subtotalD).toNumber();
  // netAfterHeaderD = ما تفرضه محاسبة الفاتورة (يُخزَّن `discountAmount` و`total` بهذا). قد لا
  // يكون مضاعفاً للـ٢٥٠ ⇒ التقريب النقديّ يعمل عليه لاحقاً لِـcashFull.
  const netAfterHeaderD = subtotalD.minus(invoiceDiscountAmountD);
  const paidD   = D(activeTab.payInput || 0);
  // §٩ IQD denomination rounding: البيع النقديّ الكامل يُقرَّب على أقرب ٢٥٠ د.ع (سياسة المالك).
  // effectiveTotalD = ما **يقبضه الكاشير فعلياً** (ما تظهره الشاشة، ما يُرسَل payment.amount).
  // الفرق `netAfterHeaderD − effectiveTotalD` قيدُ ADJUST_ROUNDING خادمياً (§ ٥ من دليل النظام).
  const cashRoundedTotalD = activeTab.method === "CASH"
    ? roundCashIQD(netAfterHeaderD.toFixed(2))
    : netAfterHeaderD;
  const cashRoundedPaidD = activeTab.method === "CASH" ? roundCashIQD(paidD.toFixed(2)) : paidD;
  const cashRoundedTotal = cashRoundedTotalD.toNumber();
  const cashRoundedPaid = cashRoundedPaidD.toNumber();
  // isCredit يُقاس على **الإجمالي الفعّال** (المقرَّب حين النقد الكامل) — مطابقاً لحساب الخادم.
  // قبل الآن كان يُقاس على غير المقرَّب، فمبلغٌ يغطّي المقرَّب لكنّه دون غير المقرَّب صار «آجلاً» صامتاً.
  const isCredit = paidD.gt(0) && paidD.lt(cashRoundedTotalD);
  const isChange = paidD.gt(0) && paidD.gte(cashRoundedTotalD);
  // effectiveTotalD = ما **يعرضه الكاشير للعميل**. للنقد الكامل: المقرَّب. غير ذلك: غير المقرَّب.
  const effectiveTotalD = (activeTab.method === "CASH" && !isCredit) ? cashRoundedTotalD : netAfterHeaderD;
  const total   = round2(effectiveTotalD).toNumber();
  const paid    = round2(paidD).toNumber();
  const change  = round2(paidD.minus(effectiveTotalD)).toNumber();
  const credit  = round2(effectiveTotalD.minus(paidD)).toNumber();
  const cashRoundingDelta = activeTab.method === "CASH" ? cashRoundedTotalD.minus(netAfterHeaderD).toNumber() : 0;
  const externalPaymentAmount = money(isCredit ? paid : total);
  const externalPaymentFingerprint = `${activeTab.method}|${externalPaymentAmount}|${(activeTab.paymentRef ?? "").trim().toUpperCase()}`;
  const externalPaymentConfirmed = activeTab.method === "CASH"
    || (activeTab.externalPayment?.state === "CONFIRMED"
      && activeTab.externalPayment.fingerprint === externalPaymentFingerprint
      && activeTab.externalPayment.attemptId != null);

  // ── Search ────────────────────────────────────────────────────────────────
  // بحث ذكي: تأجيل ١٨٠ms (طلب واحد بعد استقرار الكتابة لا مع كل حرف) + إبقاء النتائج
  // السابقة أثناء الجلب (لا وميض) + التفعيل من حرفين (التطبيع/الترتيب على الخادم).
  const debouncedSearch = useDebouncedValue(search, 180);
  const searchResults = trpc.catalog.posList.useQuery(
    // بند 12ب (٧/٧): تمرير العميل — صاحب سعر تعاقدي يرى سعره (يثبَّت لاحقاً override بمسار POS-ROUND القائم).
    { branchId, tier: effectiveTier, query: debouncedSearch, limit: 20, customerId: activeTab.customerId },
    {
      enabled: !offline && debouncedSearch.trim().length >= 2,
      placeholderData: keepPreviousData,
      staleTime: 0,
    }
  );
  // ش٢ أوفلاين: أثناء الانقطاع يُخدَم البحث من النموذج المحلي (Dexie) بنفس شكل PosRow —
  // بقية الشاشة (addRow/السلة/الأسعار) لا تعرف الفرق. العروض/التعاقدي معطّلة أوفلاين بالخطة.
  const [offlineResults, setOfflineResults] = useState<PosRow[]>([]);
  const [offlineSearching, setOfflineSearching] = useState(false);
  useEffect(() => {
    if (!offline || debouncedSearch.trim().length < 2) {
      setOfflineResults([]);
      setOfflineSearching(false);
      return;
    }
    let cancelled = false;
    setOfflineSearching(true);
    void offlineSearchCatalog(debouncedSearch, effectiveTier, branchId, { limit: 20 }).then((rows) => {
      if (cancelled) return;
      setOfflineResults(rows as PosRow[]);
      setOfflineSearching(false);
    });
    return () => {
      cancelled = true;
    };
  }, [offline, debouncedSearch, effectiveTier]);

  // ── Cart ops ──────────────────────────────────────────────────────────────
  function addRow(row: PosRow) {
    if (cartHasDigitalRef.current) {
      notify.warn("لا يمكن خلط المنتجات مع البطاقات الرقمية", DIGITAL_CART_BLOCKS_REGULAR_MESSAGE);
      return;
    }
    if (row.price == null) {
      notify.err(`لا سعر لـ ${row.productName} (${row.unitName}) في فئة ${TIER_LABEL[effectiveTier]}`);
      return;
    }
    if (receipt) setReceipt(null);
    if (activeTab.couponCode) patchActive({ couponCode: null, couponLabel: null });
    // صفوف الكتالوج الأوفلايني القديمة لا تحمل branchId؛ نربط الصف المضاف بالفرع الحالي صراحةً.
    const currentRow = { ...row, branchId: row.branchId ?? branchId };
    setCart((raw) => {
      const prev = resetCouponItems(raw);
      const i = prev.findIndex((c) => c.row.productUnitId === currentRow.productUnitId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], row: currentRow, qty: next[i].qty + 1 };
        return next;
      }
      return [...prev, { row: currentRow, qty: 1 }];
    });
    setSelId(currentRow.productUnitId);
    // ٢٣/٨ (Codex P2): اِرفع عدّاد الإضافة — يُشغّل التمرير حتى لو أُعيد مسح السطر المحدَّد نفسه.
    setAddTick((t) => t + 1);
    setSearch(""); setShowDrop(false);
    searchRef.current?.focus();
  }

  function changeQty(id: number, qty: number) {
    if (activeTab.couponCode) clearAppliedCoupon();
    qtyEntryRef.current = {
      tabId: activeIdRef.current,
      lineId: qty <= 0 ? null : id,
      replaceNextDigit: true,
    };
    if (qty <= 0) {
      setCart((prev) => prev.filter((c) => lineIdOf(c) !== id));
      if (activeTab.selId === id) setSelId(null);
    } else {
      // §٨.٦: كمّية الكرت الرقميّ ثابتة عند ١ — الزيادة تكون بإضافة بطاقة أخرى (مرجع تنفيذ مستقلّ).
      setCart((prev) => prev.map((c) => (lineIdOf(c) === id && !c.digital ? { ...c, qty } : c)));
    }
  }

  function removeRow(id: number) {
    if (activeTab.couponCode) clearAppliedCoupon();
    setCart((prev) => prev.filter((c) => lineIdOf(c) !== id));
    if (activeTab.selId === id) setSelId(null);
  }

  // ── البطاقات الرقمية (ش٥) ─────────────────────────────────────────────────
  const [cardsOpen, setCardsOpen] = useState(false);
  /** النيّة قيد التنفيذ الخارجيّ (ش٧) — تُفتح بها نافذة خطوات إصدار الكروت. */
  const [fulfillIntentId, setFulfillIntentId] = useState<number | null>(null);

  const digitalLines = cart.filter((c) => c.digital);

  /** بصمة سلّة الكروت: تربط النيّة بمحتواها فيُرفض إعادة استعمال المفتاح بسلّةٍ أخرى. */
  function digitalCartFingerprint(): string {
    const basis = digitalLines
      .map((c) => `${c.digital!.lineKey}:${c.digital!.offeringId}:${c.digital!.priceVersionId}:${c.digital!.providerReference}:${c.row.price}`)
      .sort()
      .join("|");
    let h = 0;
    for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0;
    return `dc${(h >>> 0).toString(16)}${basis.length.toString(16)}`;
  }

  const prepareIntent = trpc.digitalCards.sales.prepare.useMutation({
    onSuccess: (r) => setFulfillIntentId(r.intentId),
    onError: (e) => notify.err(e),
  });

  /** ش٨: التثبيت المالي — الفاتورة والقبض والتسوية والتفاصيل في معاملة خادمية واحدة. */
  const finalizeSale = trpc.digitalCards.sales.finalize.useMutation({
    onSuccess: (r) => {
      const now = new Date();
      // §١٢.٣: الإيصال يُبنى من استجابة الخادم (السعر والمرجع وبيانات الطالب) لا من حالة React.
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        invoiceId: r.invoiceId,
        date: fmtDate(now),
        printDate: fmtDate(now),
        printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        cashierName: me.data?.name ?? undefined,
        shiftId: shift?.id ?? null,
        lines: [],
        total: Number(r.total),
        received: Number(r.total),
        change: 0,
        credit: 0,
        method: activeTab.method,
        isCredit: false,
        digitalDetails: r.printDetails,
      };
      setFulfillIntentId(null);
      setCart([]);
      setSelId(null);
      setPayInput("");
      // مفتاح جديد للتبويب: الفاتورة التالية عمليةٌ مستقلّة (نفس اصطلاح البيع العادي).
      patchActive({ clientRequestId: crypto.randomUUID(), couponCode: null, couponLabel: null, paymentRef: "", externalPayment: null, invoiceDiscountPct: "" });
      setReceipt(rec);
      notify.ok(`تمّت الفاتورة ${r.invoiceNumber}`, `الإجمالي ${r.total} د.ع — سُجِّلت الكروت وتسوية المزوّد.`);
      void utils.shifts.current.invalidate();
      void printReceipt(buildBrandedReceipt(rec))
        .then((printed) => {
          if (!printed.ok) notify.warn("تعذّرت الطباعة التلقائية", "حجب المتصفح نافذة الطباعة — الفاتورة محفوظة ويمكن إعادة طباعتها.");
        })
        .catch(() => {
          notify.warn("تعذّرت الطباعة التلقائية", "الفاتورة محفوظة — أعِد الطباعة من شاشة الفواتير.");
        });
    },
    onError: (e) => notify.err(e),
  });

  /** يبدأ مسار البيع الرقميّ: تحقّقٌ خادميّ + حجز رصيد، **قبل** لمس جهاز المزوّد. */
  function startDigitalFulfillment() {
    if (!shift) return;
    if (offline) {
      notify.errBig("لا بيع رقميّ دون اتصال", "الكروت تحتاج الخادم للتحقّق من السعر والتنفيذ.");
      return;
    }
    if (activeTab.method !== "CASH" && activeTab.method !== "CARD") {
      notify.err("البيع الرقميّ نقداً أو ببطاقة فقط");
      return;
    }
    if (activeTab.method === "CARD" && !externalPaymentConfirmed) {
      notify.err("أكّد دفع البطاقة الخارجي قبل بدء إصدار الكروت.");
      return;
    }
    prepareIntent.mutate({
      clientRequestId: activeTab.clientRequestId,
      branchId,
      shiftId: shift.id,
      paymentMethod: activeTab.method,
      ...(activeTab.method === "CARD" ? {
        externalPaymentAttemptId: activeTab.externalPayment!.attemptId!,
        externalPaymentDeviceId: activeTab.externalPayment?.deviceId,
      } : {}),
      cartFingerprint: digitalCartFingerprint(),
      lines: digitalLines.map((c) => ({
        lineKey: c.digital!.lineKey,
        offeringId: c.digital!.offeringId,
        priceVersionId: c.digital!.priceVersionId,
        expectedSellPrice: String(c.row.price ?? "0"),
        providerReference: c.digital!.providerReference,
        student: c.digital!.student ?? null,
      })),
    });
  }

  /** يُضيف **مثيلاً مستقلاً** دائماً — لا دمج مع سطر موجود من الفئة نفسها (§٨.٣). */
  function addDigitalCard(card: ConfirmedCard, capture: DigitalSaleCapture) {
    if (cartHasRegular) {
      notify.warn("لا يمكن خلط البطاقات الرقمية مع المنتجات", REGULAR_CART_BLOCKS_DIGITAL_MESSAGE);
      return;
    }
    if (receipt) setReceipt(null);
    if (activeTab.couponCode) patchActive({ couponCode: null, couponLabel: null });
    // المعرّف يُشتقّ من **السلة نفسها** لا من عدّاد في ref: السلة تبقى عبر إعادة تركيب الصفحة
    // (تبديل مسار/تبويب) بينما الـref يعود للصفر ⇒ تصادم مفاتيح React. أقلّ معرّف ناقص واحد.
    const lineId = Math.min(0, ...cart.map((c) => c.digital?.lineId ?? 0)) - 1;
    const row: PosRow = {
      branchId,
      productId: card.productId,
      productName: card.name,
      variantId: card.variantId,
      variantName: null,
      color: null,
      colorHex: null,
      size: null,
      // سطر السلة يعرض الـSKU بجانب الاسم؛ الكرت الرقميّ بلا SKU مفيد ⇒ فراغ بدل رمز داخليّ.
      sku: "",
      productUnitId: card.productUnitId,
      unitName: "بطاقة",
      conversionFactor: "1.0000",
      barcode: null,
      isBaseUnit: true,
      price: card.sellPrice,
      // خدمة بلا مخزون: الأصفار تُبقي حسابات المخزون في الواجهة محايدةً تماماً.
      stockBase: 0,
      reservedBase: 0,
      availableBase: 0,
      openedAt: null,
      isService: true,
      allowBackorder: false, // الكرت الرقميّ خدمةٌ أصلاً — لا معنى لبيعٍ بالطلب عليه.
      isCustomizable: false,
      isPrintService: false,
      isContractPrice: false,
      isBundle: false,
      isConsignment: false,
      // لا عروض ولا كوبونات على الكرت الرقميّ — سعره سعر اليوم المنشور حصراً.
      promotionId: null,
      promotionName: null,
      promotionDiscountForUnit: "0.00",
      promotionEffectivePrice: null,
      // الكاشير لا يرى التكلفة (يُحجب خادمياً عبر redactPosCost في الحقيقيّ) — الكرت الرقميّ
      // خدمة بلا تكلفة صنف؛ null متّسق مع نتائج البحث المُحجَبة.
      costPriceBase: null,
    };
    setCart((raw) => [
      ...resetCouponItems(raw),
      {
        row,
        qty: 1,
        digital: {
          offeringId: card.offeringId,
          providerId: card.providerId,
          priceVersionId: card.priceVersionId,
          lineKey: crypto.randomUUID(),
          lineId,
          offeringType: card.offeringType,
          providerName: card.providerName,
          providerReference: capture.providerReference,
          requiresStudentData: card.requiresStudentData,
          student: capture.student,
        },
      },
    ]);
    setSelId(lineId);
    setSearch(""); setShowDrop(false);
  }

  // ── Barcode ───────────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(async (code: string) => {
    if (!code) return;
    // رفضٌ قبل طلب الشبكة، ثم يعيد addRow الفحص بعد اكتماله للحماية من تغيّر السلة أثناء الطلب.
    if (cartHasDigitalRef.current) {
      notify.warn("لا يمكن خلط المنتجات مع البطاقات الرقمية", DIGITAL_CART_BLOCKS_REGULAR_MESSAGE);
      return;
    }
    try {
      // ش٢ أوفلاين: أثناء الانقطاع تُخدَم المطابقة من النموذج المحلي (الأساسي + البدائل).
      const row = offline
        ? await offlineFindByBarcode(code, effectiveTier, branchId)
        : await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: effectiveTier, customerId: activeTab.customerId });
      if (!row) notify.err(`باركود غير معروف: ${code}`);
      else addRow(row as PosRow);
    } catch (e: unknown) {
      notify.err(e, "خطأ في المسح");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, effectiveTier, activeTab.customerId, offline]);

  const { handleKeyDown: handleScanKeyDown } = useSmartScanInput(lookupBarcode);

  const handleHidScan = useCallback(async (raw: string) => {
    const result = parseScan(raw);
    if (result.type === "product") {
      await lookupBarcode(result.barcode);
      setSearch("");
    } else if (result.type === "customer") {
      setCustId(result.id);
      notify.ok(`تم تحديد العميل #${result.id}`);
    } else if (result.type === "employee" || result.type === "user") {
      // كود موظف/مستخدم لا ينطبق على نقطة البيع — أبلغ بدل ابتلاع المسح صامتاً.
      notify.err("كود موظف/مستخدم — افتح البحث الشامل (Ctrl+K) لعرضه؛ لا ينطبق على نقطة البيع.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupBarcode]);

  useBarcodeScanner(handleHidScan, { enabled: !receipt && !shifting && !creditPrompt && !cashDropping });

  // ── Numpad ────────────────────────────────────────────────────────────────
  function numPress(k: string) {
    const { numMode, selId } = activeTab;
    if (numMode === "QTY") {
      if (!selId) return;
      setCart((prev) =>
        prev.map((c) => {
          // §٨.٦: لا كمّية ولا خصم يدويّ على كرت رقميّ من لوحة الأرقام.
          if (lineIdOf(c) !== selId || c.digital) return c;
          const entry = qtyEntryRef.current;
          const replaceNextDigit = entry.tabId !== activeIdRef.current || entry.lineId !== selId
            ? true
            : entry.replaceNextDigit;
          const result = applyPosQuantityKey(c.qty, k, replaceNextDigit);
          qtyEntryRef.current = {
            tabId: activeIdRef.current,
            lineId: selId,
            replaceNextDigit: result.replaceNextDigit,
          };
          return { ...c, qty: result.quantity };
        })
      );
    } else if (numMode === "DISC") {
      if (!selId) return;
      setCart((prev) =>
        prev.map((c) => {
          if (lineIdOf(c) !== selId || c.digital) return c;
          const base = c.origPrice ?? Number(c.row.price ?? 0);
          let s = c.disc != null ? String(c.disc) : "";
          if (k === "⌫") s = s.slice(0, -1);
          else if (k === "C") s = "";
          else if (k === "." && s.includes(".")) return c;
          else s = s + k;
          const disc = Math.min(100, Math.max(0, parseFloat(s) || 0));
          return { ...c, origPrice: base, disc };
        })
      );
    } else {
      setPayInput((prev) => {
        if (k === "⌫") return prev.slice(0, -1);
        if (k === "C") return "";
        if (k === "." && prev.includes(".")) return prev;
        if (k === "+/-") return prev ? (prev.startsWith("-") ? prev.slice(1) : "-" + prev) : prev;
        if (prev === "" && k === "00") return "0";
        return prev + k;
      });
    }
  }

  // ── Sale ──────────────────────────────────────────────────────────────────
  // idempotency: لكل تبويب مفتاحه (activeTab.clientRequestId) ⇒ النقر المزدوج/إعادة الشبكة لا
  // يكرّر الفاتورة، ولا يتصادم بيع تبويب مع آخر. يتجدّد مفتاح التبويب بعد نجاح بيعه فقط.
  // لقطة البيع (تُلتقط لحظة الإرسال) تجمّد التبويب المُباع وأرقامه ⇒ يُبنى الإيصال ويُفرَّغ
  // التبويب الصحيح في onSuccess حتى لو بدّل الكاشير التبويب أثناء جريان البيع — عزل مالي تام.
  const saleCtxRef = useRef<{
    tabId: number;
    lines: Receipt["lines"];
    subtotal: number;
    invoiceDiscount: number;
    cashRounding: number;
    total: number; received: number; change: number; credit: number;
    isCredit: boolean; method: string; methodCode?: string;
    customerName?: string; cashierName?: string;
  } | null>(null);

  const sale = trpc.sales.create.useMutation({
    onSuccess: async (r) => {
      const ctx = saleCtxRef.current;
      saleCtxRef.current = null;
      if (!ctx) return; // أمان — لا لقطة (لا يُفترض حدوثه)
      const now = new Date();
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        invoiceId:     r.invoiceId,
        date: fmtDateTime(now),
        printDate: fmtDate(now),
        printTime: fmtTime(now),
        cashierName: ctx.cashierName,
        customerName: ctx.customerName,
        // Codex P2: تفضيل shiftId من الفاتورة المُثبَّتة (idempotent replay بعد إغلاق وردية).
        shiftId: (r as { shiftId?: number | null }).shiftId ?? shift?.id ?? null,
        lines: ctx.lines,
        subtotal: ctx.subtotal,
        invoiceDiscount: ctx.invoiceDiscount,
        cashRounding: ctx.cashRounding,
        total: ctx.total, received: ctx.received, change: ctx.change,
        credit: ctx.credit, isCredit: ctx.isCredit,
        method: ctx.method, methodCode: ctx.methodCode,
      };
      // #2 (تدقيق التثبيت): إن رجع الخادم total (المُقرَّب المخزَّن فعلاً) نستعمله في الإيصال
      // كمصدر حقيقة أخير — يُغطّي أي انحراف تقريب مستقبليّ بين العميل والخادم (roundCashIQD مشتركة
      // حالياً، لكن الاعتماد على قيمة الخادم يحصّن الإيصال ضدّ أي تعديل مستقبلي على القاعدة).
      const serverTotal = r.total != null ? Number(r.total) : ctx.total;
      const alignedRec: Receipt = { ...rec, total: serverTotal };
      setReceipt(alignedRec);
      setLastInv({ num: r.invoiceNumber, total: serverTotal });
      notify.ok(`تم البيع — فاتورة ${r.invoiceNumber}`, "افتح من شريط «آخر فاتورة» أعلاه أو من صفحة الفواتير");
      // فرّغ التبويب المُباع تحديداً (لا التبويب النشط الحالي) وجدّد مفتاحه للبيع التالي.
      patchTab(ctx.tabId, { cart: [], payInput: "", selId: null, couponInput: "", couponCode: null, couponLabel: null, clientRequestId: newClientRequestId(), paymentRef: "", externalPayment: null, dueDate: "", invoiceDiscountPct: "" });

      const printed = await printReceipt(buildBrandedReceipt(alignedRec));
      if (!printed.ok) {
        notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
      } else if (printed.via === "server") {
        notify.ok("تمت الطباعة المباشرة", `فاتورة ${r.invoiceNumber} أُرسلت إلى طابعة الكاشير`);
      } else if (printed.via === "thermal") {
        notify.ok("تمت الطباعة الحرارية", `فاتورة ${r.invoiceNumber} أُرسلت إلى الطابعة المربوطة`);
      } else {
        notify.warn("الطابعة المباشرة غير متاحة", "افتُتحت نافذة الطباعة؛ اربط طابعة الكاشير من رمز الطابعة لتعمل مباشرة لاحقاً");
      }
      await Promise.all([
        utils.catalog.posList.invalidate(),
        utils.catalog.stockByUnitIds.invalidate(),
        utils.customers.list.invalidate(),
        shiftQ.refetch(),
      ]);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd(""); setSaleError(null);
    },
    onError: (e) => {
      const errData = e.data as unknown as { code?: string; httpStatus?: number } | null | undefined;
      const code = errData?.code;
      // ش٣ أوفلاين — تدهور سلس: فشل نقل (لا كود tRPC بنيوي = الطلب لم يصل أصلاً) في أول بيعة
      // بعد انقطاعٍ لم يكتشفه المسبار بعد ⇒ حوّل تلقائياً للالتقاط المحلي بدل خطأ محيّر للكاشير.
      // نفس clientRequestId يبقى ⇒ لو كان الطلب وصل الخادم فعلاً وضاع الردّ، الترحيل اللاحق
      // يطابقه idempotent-ياً (لا ازدواج) ويعرض ربط OFF ↔ INV في درج المزامنة.
      //
      // فحص الحمل ٣١/٨/٢٦ — **503 يُلتقَط أيضاً**: حارس الحِمل الزائد يردّ 503 قبل أن يبلغ
      // الطلبُ tRPC إطلاقاً (`onShed` بدل `next()`)، لكنه يحمل `code: INTERNAL_SERVER_ERROR`
      // فكان يمرّ من هذا الشرط ويصل الكاشيرَ خطأً أحمرَ والزبونُ واقف — رغم أنّ البيعة **لم
      // تُكتب قطعاً**. و`clientRequestId` يحرس من أيّ ازدواج.
      //
      // ⚠️ **بشرط أن تكون السلّة قابلةً للالتقاط فعلاً** (مراجعة عدائية ٣١/٨): شروط
      // `captureOfflineSale` كلّها تفترض انقطاعَ الشبكة، فتحويلُ سلّةِ **بطاقة** إليها يبتلع
      // رسالة الخادم الصحيحة («الخادم مشغول — أعد المحاولة») ويضع مكانها «الاتصال مقطوع،
      // نقداً فقط» — وهي **تعليمةٌ خاطئة وخطِرة**: البطاقة تكون قد خُصمت فعلاً قبل
      // `sales.create` (يشترطها `externalPaymentConfirmed`)، فيُدفع الكاشير إلى تحصيلٍ مكرّر
      // أو ترك عمليةٍ مخصومة معلَّقة. ما لا يُلتقَط يسقط للمسار العاديّ برسالة الخادم كما هي.
      const offlineCapturable =
        !!shift &&
        cart.length > 0 &&
        !cart.some((c) => c.digital) &&
        activeTab.method === "CASH" &&
        !isCredit &&
        !activeTab.couponCode;
      if (!code || (errData?.httpStatus === 503 && offlineCapturable)) {
        saleCtxRef.current = null;
        void captureOfflineSale();
        return;
      }
      // #6 (تدقيق التثبيت): بوّابتا حدّ الائتمان (server/lib/credit.ts) والبيع دون التكلفة
      // (sale/create.ts) ترميان FORBIDDEN لا PRECONDITION_FAILED، فكان حوار موافقة المدير لا يُفتَح
      // على الكاشير الرئيسي (بخلاف PrintPOS عبر printSaleService) ⇒ يتعذّر البيع المُصرَّح ولو حضر
      // المدير. نطابق الرسالة كـSalesInvoiceNew:179 (مع إبقاء PRECONDITION_FAILED دفاعاً).
      // H6 (٢٧/٧): بوّابة الخصم اليدويّ فوق التكلفة ترمي «...يتطلب موافقة مدير» ⇒ نطابق العبارة
      // الجامعة «موافقة مدير» ليُفتَح الحوار لأيّ بوّابة اعتمادٍ لاحقة أيضاً (لا رسالةً بعينها).
      if (code === "PRECONDITION_FAILED" || (e.message && (e.message.includes("حدّ الائتمان") || e.message.includes("بأقل من التكلفة") || e.message.includes("موافقة مدير"))))
        setCreditPrompt(e.message);
      // خطأ بيع حرج (نقص مخزون/رفض) ⇒ تنبيه بارز أكبر وأوضح يلتقطه الكاشير فوراً.
      else { notify.errBig(e); setSaleError(e.message); }
    },
  });

  const initiateExternalPayment = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternalPaymentMutation = trpc.sales.confirmExternalPayment.useMutation();

  async function confirmCurrentExternalPayment() {
    if (!shift || !cart.length || activeTab.method === "CASH") return;
    const tabId = activeTab.id;
    const reference = (activeTab.paymentRef ?? "").trim();
    if (!reference) {
      notify.err("أدخل مرجع الدفع الخارجي أولاً.");
      return;
    }
    if (activeTab.payInput.trim() !== "" && D(activeTab.payInput).lte(0)) {
      notify.err("مبلغ الدفع يجب أن يكون موجباً قبل تأكيد العملية الخارجية.");
      return;
    }

    const fingerprint = externalPaymentFingerprint;
    const prior = activeTab.externalPayment?.fingerprint === fingerprint ? activeTab.externalPayment : null;
    const requestId = prior?.requestId ?? newClientRequestId();
    let deviceId = prior?.deviceId;
    if (!deviceId) {
      try {
        deviceId = await getDeviceCode();
      } catch {
        notify.err("تعذّر تحديد جهاز الكاشير — لا يمكن تأكيد دفع خارجي بلا هوية جهاز.");
        return;
      }
    }
    patchTab(tabId, {
      externalPayment: {
        attemptId: prior?.attemptId ?? null,
        requestId,
        fingerprint,
        state: prior?.state ?? "INITIATED",
        deviceId,
      },
    });

    try {
      let attemptId = prior?.attemptId ?? null;
      if (!attemptId) {
        const initiated = await initiateExternalPayment.mutateAsync({
          branchId,
          method: activeTab.method,
          amount: externalPaymentAmount,
          reference,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        patchTab(tabId, { externalPayment: { attemptId, requestId, fingerprint, state: "INITIATED", deviceId } });
      }
      await confirmExternalPaymentMutation.mutateAsync({ branchId, attemptId, deviceId });
      patchTab(tabId, { externalPayment: { attemptId, requestId, fingerprint, state: "CONFIRMED", deviceId } });
      notify.ok("تأكّد الدفع الخارجي", `ثُبّت المرجع ${reference} وأصبح جاهزاً للاستهلاك مرةً واحدة.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذّر تثبيت تأكيد الدفع الخارجي";
      notify.err(message);
    }
  }

  const couponPreview = trpc.crm.coupons.preview.useMutation({
    onSuccess: (result) => {
      const byUnit = new Map(result.lines.map((line) => [Number(line.productUnitId), line]));
      setCart((items) => items.map((item) => {
        const base = item.preCouponRow ?? item.row;
        const applied = byUnit.get(Number(base.productUnitId));
        if (!applied) return { ...item, row: base, preCouponRow: undefined };
        return {
          ...item,
          disc: undefined,
          preCouponRow: base,
          row: {
            ...base,
            promotionId: applied.promotionId,
            promotionName: applied.promotionName,
            promotionDiscountForUnit: applied.promotionDiscountForUnit,
            promotionEffectivePrice: applied.promotionEffectivePrice,
          },
        };
      }));
      patchActive({ couponInput: result.code, couponCode: result.code, couponLabel: result.programName });
      notify.ok(`تم تطبيق الكوبون — ${result.programName}`);
    },
    onError: (error) => notify.err(error),
  });

  function applyCoupon() {
    const code = activeTab.couponInput.trim();
    if (!code || !cart.length) return;
    const baseItems = resetCouponItems(cart);
    couponPreview.mutate({
      code,
      branchId,
      customerId: activeTab.customerId ?? undefined,
      customerTier: effectiveTier,
      lines: baseItems.map((item) => ({
        productId: item.row.productId,
        variantId: item.row.variantId,
        productUnitId: item.row.productUnitId,
        unitPrice: String(item.row.price ?? "0"),
        quantity: item.qty,
        hasContractPrice: item.row.isContractPrice,
      })),
    });
  }

  // §٥: لقطة مبالغ/منتجات البيع بدقّة Decimal لحظة الإرسال (لا وقت النجاح) ⇒ تثبّت على التبويب
  // المُباع ولا تنجرف لو بدّل الكاشير التبويب. نفس صيغ الحساب القديمة (لا تغيير سلوك).
  function captureSaleCtx(): NonNullable<typeof saleCtxRef.current> {
    // #2 (تدقيق التثبيت): البيع النقدي الكامل يستعمل الإجمالي المُقرَّب لأقرب ٢٥٠ د.ع كما يفعل
    // الخادم — كان الإيصال يعرض total غير مقرَّب فينجرف صندوق Z-report بالفرق (~٥٠ د.ع لكل بيعة
    // غير مضاعف ٢٥٠) ويُلام عليه الكاشير. roundCashIQD نفس الدالة المُطبَّقة خادمياً ⇒ اتّفاق حتميّ.
    const cashFull = activeTab.method === "CASH" && !isCredit;
    // effectiveTotalD = ما يعرضه الكاشير للعميل. حين النقد الكامل هو المقرَّب (مطابقاً لِـcaptureSaleCtx القديم).
    const displayTotalD = effectiveTotalD;
    const displayPaidD = cashFull ? cashRoundedPaidD : paidD;
    const finalReceivedD = isCredit ? displayPaidD : displayTotalD;
    const finalChangeD   = isCredit ? D(0)  : displayPaidD.minus(displayTotalD);
    const finalCreditD   = isCredit ? displayTotalD.minus(displayPaidD) : D(0);
    return {
      tabId: activeTab.id,
      lines: cart.map((c) => ({
        name: c.row.productName, unit: c.row.unitName,
        qty: c.qty, price: effectivePrice(c),
        disc: c.disc, total: itemTotal(c),
      })),
      subtotal: subtotal,
      invoiceDiscount: invoiceDiscountAmount,
      cashRounding: cashRoundingDelta,
      total: round2(displayTotalD).toNumber(),
      received: round2(finalReceivedD).toNumber(),
      change:   round2(finalChangeD).toNumber(),
      credit:   round2(finalCreditD).toNumber(),
      isCredit,
      method: paymentMethodLabel(activeTab.method),
      methodCode: activeTab.method,
      customerName: selectedCustomer?.name,
      cashierName: me.data?.name ?? offlineBoot?.name ?? undefined,
    };
  }

  // ── التقاط البيع دون اتصال (ش٣) ─────────────────────────────────────────────
  // نقدي كامل فقط (قرار مالك): يُحفظ البيع في طابور Dexie بنفس clientRequestId الذي كان
  // سيستعمله أونلاين، يُطبع إيصال مؤقّت OFF-... بنفس التصميم، ويُرحَّل تلقائياً عند عودة
  // الاتصال عبر offline.replaySale (idempotent — لا ازدواج حتى مع بيعٍ نصف-ناجح قبل القطع).
  async function captureOfflineSale() {
    if (!shift || !cart.length) return;
    // البطاقات الرقمية ش٥: البيع الرقميّ **محظور أوفلاين** (مسألة مؤجَّلة صراحةً في §٢٤ من وثيقة
    // التصميم) — السعر والتنفيذ الخارجيّ واستهلاك المحفظة كلّها تحتاج الخادم لحظةَ البيع.
    if (cart.some((c) => c.digital)) {
      notify.errBig("لا بيع رقميّ دون اتصال", "الكروت والاشتراكات تحتاج الخادم للتحقّق من السعر والتنفيذ. أزِلها من السلة.");
      return;
    }
    // الالتقاط مفعَّلٌ تلقائياً على كل جهاز (قرار مالك ١٦/٨). لا يصل هنا إلّا جهازٌ **عُطِّل
    // صراحةً** من إعدادات الجهاز — فالرسالة تشرح ذلك بدل مطالبة الكاشير بتفعيلٍ مسبق.
    if (!(await isOfflineSaleEnabled())) {
      notify.errBig(
        "البيع دون اتصال مُعطَّل على هذا الجهاز",
        "عُطِّل يدوياً من «إعدادات الجهاز» في شارة المزامنة أسفل الشاشة — أعِد تفعيله ليقبل النقد أثناء الانقطاع.",
      );
      return;
    }
    if (activeTab.method !== "CASH" || isCredit) {
      notify.errBig("أثناء انقطاع الاتصال: البيع النقدي الكامل فقط — الآجل والبطاقة يتطلبان اتصالاً بالخادم.");
      return;
    }
    if (activeTab.couponCode) {
      notify.errBig("الكوبونات والعروض غير متاحة دون اتصال — أزل الكوبون أولاً.");
      return;
    }
    // صمّاما الأمان: عمر الأسعار المحلية + سقف قيمة الطابور.
    const gate = await assertCanCapture(cashRoundedTotal);
    if (!gate.ok) {
      notify.errBig(gate.reason);
      return;
    }
    const ctx = captureSaleCtx();
    const receiptNumber = await allocateOfflineReceiptNumber(branchId);
    const ok = await enqueueOfflineSale({
      payload: {
        branchId,
        shiftId: shift.id,
        customerId: activeTab.customerId ?? undefined,
        priceTier: effectiveTier,
        // promotionId يُسقَط عمداً — العروض معطّلة أوفلاين (الخادم يرفض غير المعروف في مخططه).
        lines: cart.map(buildSaleLine).map(({ promotionId: _p, ...rest }) => rest),
        ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
        // نفس منطق submitSale: نرسل المقرَّب لأنّه ما قبضه الكاشير فعلياً (الأوفلاين نقديّ كامل بحكم القرار).
        payment: { amount: money(cashRoundedTotal), method: "CASH" },
        clientRequestId: activeTab.clientRequestId,
        cashRoundIQD: true,
      },
      offlineReceiptNumber: receiptNumber,
      total: money(cashRoundedTotal),
    });
    if (!ok) {
      notify.errBig("تعذّر حفظ البيع محلياً (مساحة المتصفح؟) — لا تُسلّم البضاعة قبل عودة الاتصال.");
      return;
    }
    const now = new Date();
    const rec: Receipt = {
      invoiceNumber: receiptNumber,
      invoiceId: 0, // لا فاتورة رسمية بعد — الطباعة تستعمل الرقم فقط.
      date: fmtDateTime(now),
      printDate: fmtDate(now),
      printTime: fmtTime(now),
      cashierName: ctx.cashierName,
      customerName: ctx.customerName,
      shiftId: shift?.id ?? null,
      lines: ctx.lines,
      subtotal: ctx.subtotal,
      invoiceDiscount: ctx.invoiceDiscount,
      total: ctx.total, received: ctx.received, change: ctx.change,
      credit: ctx.credit, isCredit: ctx.isCredit,
      method: ctx.method, methodCode: ctx.methodCode,
    };
    setReceipt(rec);
    setLastInv({ num: receiptNumber, total: ctx.total });
    notify.ok(`بيع دون اتصال — إيصال مؤقّت ${receiptNumber}`, "الرقم الرسمي يصدر تلقائياً عند عودة الاتصال (شارة المزامنة أسفل الشاشة)");
    patchTab(ctx.tabId, { cart: [], payInput: "", selId: null, couponInput: "", couponCode: null, couponLabel: null, clientRequestId: newClientRequestId(), paymentRef: "", externalPayment: null, dueDate: "", invoiceDiscountPct: "" });
    const printed = await printReceipt(buildBrandedReceipt(rec));
    if (!printed.ok) {
      notify.err("تعذّرت طباعة الإيصال المؤقت", "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
    } else if (printed.via === "browser") {
      notify.warn("الطابعة المباشرة غير متاحة", "افتُتحت نافذة الطباعة للإيصال المؤقت");
    }
  }

  async function submitSale(approval?: { email: string; password: string }) {
    setSaleError(null);
    if (!shift || !cart.length) return;
    if (activeTab.method !== "CASH" && !externalPaymentConfirmed) {
      notify.err("أدخل مرجع العملية وثبّت نجاح الدفع لدى المزوّد قبل إتمام البيع.");
      return;
    }
    // ش٥: البطاقة تُضاف للسلة بلا أثر ماليّ. مسار البيع الرقميّ (نية التنفيذ الخارجيّ ثم التثبيت
    // الذرّي) هو شريحةٌ لاحقة؛ حتى ذلك الحين **يُمنع** تمرير كرت رقميّ عبر مسار البيع العادي —
    // وإلا بِيع كرتٌ بلا استهلاك محفظة ولا ذمّة مزوّد (ثقبٌ ماليّ صامت).
    if (cart.some((c) => c.digital)) {
      // ش٧: الكرت الرقميّ لا يمرّ عبر مسار البيع العادي إطلاقاً — له مسارُ نيّةٍ وتنفيذٍ خارجيّ.
      // سلّة مختلطة (كروت + بضاعة) غير مدعومة بعد ⇒ رفضٌ صريح بدل بيعٍ ناقص.
      if (cart.some((c) => !c.digital)) {
        notify.err("لا تُخلط الكروت مع بضاعة في فاتورة واحدة — أتمّها في فاتورتين.");
        return;
      }
      startDigitalFulfillment();
      return;
    }
    // تدقيق ١٧/٧: «0» صريح في حقل المقبوض كان يُسجّل البيع مدفوعاً نقداً بالكامل (isCredit=false ⇒
    // payAmount=total) بلا قبض فعليّ ⇒ عجز درج عند Z-report. ارفضه صراحةً بدل الإسقاط الصامت.
    if (activeTab.payInput.trim() !== "" && D(activeTab.payInput).eq(0)) {
      notify.err("أدخل المبلغ المقبوض، أو امسح الحقل للدفع النقدي الكامل. للبيع الآجل اختر عميلاً وأدخل المقدَّم.");
      return;
    }
    // المبلغ المقبوض السالب (مفتاح +/- بلوحة الأرقام): رفضٌ صريح — كان يُعامَل صامتاً كدفعٍ
    // كامل (سالب ⇒ ليس آجلاً ولا مطابقاً ⇒ payAmount=الإجمالي) فيُسجَّل قبضٌ لم يقع فعلاً.
    if (activeTab.payInput.trim() !== "" && D(activeTab.payInput).lt(0)) {
      notify.err("المبلغ المقبوض لا يكون سالباً — صحّح المبلغ أو امسح الحقل للدفع الكامل.");
      return;
    }
    if (isCredit && activeTab.customerId == null) {
      notify.err("البيع الآجل يتطلّب اختيار عميل.");
      return;
    }
    // الحدّ قبل الوعد (١٩/٨): الشاشة كانت تفحص **وجود** العميل وحده ثمّ ترسل،
    // فيردّ الخادم بـFORBIDDEN بعد أن أتمّ الموظّف السلة والزبون واقفٌ أمامه. وحدُّ
    // صفرٍ هو **الافتراضي** لكلّ عميلٍ يُنشأ من الكاشير ⤇ الحالة الغالبة لا النادرة.
    if (isCredit && selectedCustomer != null && Number(selectedCustomer.creditLimit ?? 0) === 0
        && selectedCustomer.creditLimit != null) {
      notify.errBig(
        "هذا العميل نقديٌّ فقط (حدّ ائتمانه صفر) — حصّل كامل المبلغ، أو اطلب من المدير رفع حدّه من ملف العميل",
      );
      return;
    }
    // ش٣ أوفلاين: الاتصال مقطوع ⇒ التقاط محلي (نقدي كامل فقط) بدل نداء سيفشل.
    if (offline) {
      void captureOfflineSale();
      return;
    }
    // §٩: التقريب النقدي IQD يُحسب على الخادم للبيع النقدي الكامل (يُسجَّل ADJUST لفرق التقريب).
    // نرسل **المبلغ المقرَّب** كتَسليم (ما يقبضه الكاشير فعلياً من الزبون، وما تُظهره الشاشة كصافي).
    // كان يُرسَل غير المقرَّب، فأيّ إجمالٍ يُقرَّب صعوداً (2,380 ⇒ 2,500) يجعل الخادم يرى القبضَ ناقصاً
    // فيرفضه كبيعٍ آجلٍ بلا عميل. الخادم يحسب `cashRoundingAdj` من فرق الإجمالي/المقرَّب ⇒ الفارق موثَّق.
    saleCtxRef.current = captureSaleCtx();
    const deviceId = activeTab.method === "CASH"
      ? await getDeviceCode().catch(() => undefined)
      : activeTab.externalPayment?.deviceId;
    const cashFull = activeTab.method === "CASH" && !isCredit;
    const payAmount = isCredit ? money(paid) : (cashFull ? money(cashRoundedTotal) : money(total));
    sale.mutate({
      branchId, shiftId: shift.id, sourceType: "POS", clientRequestId: activeTab.clientRequestId,
      deviceId,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map(buildSaleLine),
      ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
      payment: {
        amount: payAmount,
        method: activeTab.method,
        ...(activeTab.method !== "CASH" ? { externalPaymentAttemptId: activeTab.externalPayment!.attemptId! } : {}),
      },
      // تاريخ الاستحقاق للآجل فقط — يُحفظ invoices.dueDate ويصحّح أعمار الذمم والتذكيرات.
      ...(isCredit && activeTab.dueDate ? { dueDate: activeTab.dueDate } : {}),
      ...(activeTab.couponCode ? { couponCode: activeTab.couponCode } : {}),
      ...(cashFull ? { cashRoundIQD: true } : {}),
      ...(approval ? { managerApproval: approval } : {}),
    });
  }

  async function quickPay() {
    setSaleError(null);
    if (!shift || !cart.length) return;
    if (activeTab.method !== "CASH" && !externalPaymentConfirmed) {
      notify.err("أدخل مرجع العملية وثبّت نجاح الدفع لدى المزوّد قبل الدفع السريع.");
      return;
    }
    if (cart.some((c) => c.digital)) {
      // ش٧: الكرت الرقميّ لا يمرّ عبر مسار البيع العادي إطلاقاً — له مسارُ نيّةٍ وتنفيذٍ خارجيّ.
      // سلّة مختلطة (كروت + بضاعة) غير مدعومة بعد ⇒ رفضٌ صريح بدل بيعٍ ناقص.
      if (cart.some((c) => !c.digital)) {
        notify.err("لا تُخلط الكروت مع بضاعة في فاتورة واحدة — أتمّها في فاتورتين.");
        return;
      }
      startDigitalFulfillment();
      return;
    }
    // ش٣ أوفلاين: الدفع السريع نقدي كامل بطبيعته ⇒ مؤهَّل للالتقاط المحلي مباشرة.
    if (offline) {
      void captureOfflineSale();
      return;
    }
    // الدفع السريع = دفع كامل بطبيعته، لكن مبلغاً سالباً ظاهراً في الحقل يُرفض صراحةً (لا تجاهل صامت).
    if (activeTab.payInput.trim() !== "" && D(activeTab.payInput).lt(0)) {
      notify.err("المبلغ المقبوض لا يكون سالباً — صحّح المبلغ أو امسح الحقل للدفع الكامل.");
      return;
    }
    // الدفع السريع كامل؛ التقريب لفئة IQD يخص النقد وحده (نفس منطق submitSale أعلاه).
    saleCtxRef.current = captureSaleCtx();
    const deviceId = activeTab.method === "CASH"
      ? await getDeviceCode().catch(() => undefined)
      : activeTab.externalPayment?.deviceId;
    const payAmount = activeTab.method === "CASH" ? money(cashRoundedTotal) : money(total);
    sale.mutate({
      branchId, shiftId: shift.id, sourceType: "POS", clientRequestId: activeTab.clientRequestId,
      deviceId,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map(buildSaleLine),
      ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
      // Quick pay means full payment; it must not silently replace CARD/TRANSFER/WALLET with CASH.
      payment: {
        amount: payAmount,
        method: activeTab.method,
        ...(activeTab.method !== "CASH" ? { externalPaymentAttemptId: activeTab.externalPayment!.attemptId! } : {}),
      },
      ...(activeTab.method === "CASH" ? { cashRoundIQD: true } : {}),
      ...(activeTab.couponCode ? { couponCode: activeTab.couponCode } : {}),
    });
  }

  // ── Shift open ────────────────────────────────────────────────────────────
  const openShift = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      // العهدة الوسيطة: تحذيرٌ لينٌ إن سحبت العهدة الخزينة إلى العجز (الضابط التعويضي لقرار «الفتح مسموح
      // مع تحذير»). الرصيد يظهر للمرتفعين فقط (محجوبٌ عن الكاشير خادمياً ⇒ null).
      if (res.treasuryWarning) {
        notify.warn(
          "تنبيه: عجز الخزينة",
          res.treasuryBalanceAfter != null
            ? `عهدة الافتتاح فاقت رصيد الخزينة — الرصيد الآن ${fmt(Number(res.treasuryBalanceAfter))} د.ع. موّل الخزينة.`
            : "عهدة الافتتاح فاقت رصيد الخزينة (عجز). أبلغ المدير لتمويل الخزينة.",
        );
      }
      void printShiftOpen({
        shiftId:        res.shiftId,
        openingBalance: Number(opening || 0),
        cashierName:    me.data?.name ?? "كاشير",
        branchName:     (branches.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
        openedAt:       new Date(),
      });
    },
    onError: (e) => notify.err(e),
  });


  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt)      { if (e.key === "Escape" || e.key === "Enter") { setReceipt(null); setTimeout(() => searchRef.current?.focus(), 0); } return; }
      if (shifting)     { if (e.key === "Escape") setShifting(false); return; }
      if (cashDropping) { if (e.key === "Escape") setCashDropping(false); return; }
      // نافذة البطاقات مفتوحة: Escape تُغلقها وتتكفّل هي بمفاتيحها (لا تصل الاختصارات العامة).
      if (cardsOpen) { if (e.key === "Escape") setCardsOpen(false); return; }
      switch (e.key) {
        case "F2":  e.preventDefault(); searchRef.current?.focus(); break;
        // §٨.٧: مفتاح فتح شبكة الكروت. F4 محجوز للدفع وF9 للطباعة وF12 للتفريغ ⇒ F3.
        case "F3":  e.preventDefault(); if (!offline && !cartHasRegular) setCardsOpen(true); break;
        case "F4":  e.preventDefault(); if (cart.length && !sale.isPending) submitSale(); break;
        case "F9":  e.preventDefault(); if (receipt) void printReceipt(buildBrandedReceipt(receipt)).then((printed) => {
          if (!printed.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
        }).catch((error) => notify.err(error)); break;
        case "F12": e.preventDefault();
          if (cart.length) {
            void (async () => {
              if (!(await confirm({
                variant: "warning",
                title: "تفريغ السلّة",
                description: "ستُفقد كل المنتجات المُضافة في هذه السلّة. هل تتابع؟",
                confirmText: "تفريغ",
              }))) return;
              setCart([]); setPayInput(""); setSelId(null); patchActive({ invoiceDiscountPct: "" });
            })();
          }
          break;
        case "Escape": setShowDrop(false); break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sale.isPending, receipt, creditPrompt, shifting, cashDropping, cardsOpen, offline, cartHasRegular, externalPaymentConfirmed]);

  const connectPrinter = async () => {
    try { await pairPrinter(); setPrinterReady(true); notify.ok("تم ربط الطابعة"); }
    catch (e: unknown) { notify.err(e, "تعذّر ربط الطابعة"); }
  };

  // حالة جسر الطباعة على الخادم (إن ضُبط PRINT_TARGET ⇒ طباعة صامتة لأي طابعة، بلا WebUSB).
  useEffect(() => {
    getServerBridgeStatus().then(setBridge).catch(() => { /* تجاهل */ });
  }, []);

  // ربط تلقائي صامت بالطابعة الافتراضية: إن سبق ربطها (إذن WebUSB محفوظ للأصل) يُعاد
  // الربط بلا نافذة اختيار عند فتح الكاشير، وكذلك عند توصيلها لاحقاً (حدث connect).
  useEffect(() => {
    if (!isWebUsbSupported()) return;
    tryReconnectPrinter().then((ok) => { if (ok) setPrinterReady(true); }).catch(() => { /* تجاهل */ });
    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    if (!usb) return;
    const onConnect = () => {
      tryReconnectPrinter().then((ok) => { if (ok) setPrinterReady(true); }).catch(() => { /* تجاهل */ });
    };
    usb.addEventListener("connect", onConnect);
    return () => usb.removeEventListener("connect", onConnect);
  }, []);

  const testServerPrint = async () => {
    const r = await serverPrintTest();
    if (r.ok) notify.ok("أُرسلت تذكرة اختبار للطابعة عبر الخادم");
    else notify.err(r.error ?? "فشل اختبار الطباعة");
  };

  // ── Shift open screen ─────────────────────────────────────────────────────
  if (shiftQ.isLoading) {
    return (
      <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.mutedFg, fontFamily: "'Cairo', system-ui, sans-serif", direction: "rtl" }}>
        {ACTION_LABELS.loading}
      </div>
    );
  }

  if (!shift) {
    return (
      <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "32px 36px", width: 380, boxShadow: "0 8px 32px rgb(0 0 0/.16)" }}>
          <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 6, color: C.fg }}>افتح وردية للبدء</div>
          <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 22 }}>لا يمكن البيع بدون وردية مفتوحة</div>
          {noAssignedBranch && isElevatedRole && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8, padding: "8px 12px", background: C.amberSoft, border: `1px solid ${C.amber}`, borderRadius: 9, fontSize: 12, color: C.fg, fontWeight: 700 }}>
                حسابك بلا فرعٍ مُسنَد — اختر الفرع الذي تعمل منه كي لا تُنسَب المبيعات لفرعٍ خاطئ.
              </div>
              <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الفرع</label>
              <AppSelect
                value={String(pickedBranch ?? "")}
                onValueChange={(value) => setPickedBranch(value ? Number(value) : null)}
                style={{ width: "100%", height: 48, border: `1.5px solid ${pickedBranch == null ? C.danger : C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, padding: "0 12px", outline: "none", boxSizing: "border-box" }}
              >
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AppSelect>
            </div>
          )}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الرصيد الافتتاحي للصندوق (د.ع)</label>
            <input
              dir="ltr" value={opening}
              onChange={(e) => setOpening(e.target.value)}
              style={{ width: "100%", height: 48, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 18, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box" }}
            />
          </div>
          {/* اربط الطابعة الحرارية هنا **قبل** فتح الوردية كي يُطبَع إيصال الافتتاح صامتاً فوراً
              بدل نافذة طباعة المتصفّح (كانت لا تظهر إلا بعد فتح الوردية داخل رأس الكاشير). */}
          {isWebUsbSupported() && !bridge.enabled && (
            <button
              type="button" onClick={connectPrinter}
              title={printerReady ? "الطابعة الحرارية مربوطة — اضغط لتبديلها" : "اربط طابعة حرارية كي يُطبع إيصال فتح الوردية عليها مباشرة"}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: 40, marginBottom: 12, borderRadius: 9, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: "none", border: `1.5px solid ${printerReady ? C.success : C.border}`, color: printerReady ? C.success : C.mutedFg }}
            >
              <Printer size={14} aria-hidden />
              {printerReady
                ? <>الطابعة الحرارية مربوطة <Check size={13} aria-hidden strokeWidth={3} /></>
                : "اربط الطابعة الحرارية لطباعة إيصال الوردية"}
            </button>
          )}
          <button
            disabled={openShift.isPending || needsBranchChoice}
            onClick={() => openShift.mutate({ branchId, openingBalance: opening, shiftType: "RETAIL" })}
            style={{ width: "100%", height: 52, background: openShift.isPending || needsBranchChoice ? C.muted : C.primary, color: openShift.isPending || needsBranchChoice ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 10, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: openShift.isPending || needsBranchChoice ? "not-allowed" : "pointer" }}
          >
            {openShift.isPending ? "جارٍ الفتح…" : needsBranchChoice ? "اختر الفرع أولاً" : "فتح الوردية"}
          </button>
          <Link href="/" style={{ display: "block", textAlign: "center", marginTop: 14, fontSize: 13, color: C.mutedFg }}>← الرئيسية</Link>
        </div>
      </div>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  // تدقيق ١٧/٧: أتِح زرّ الدفع للبيع الآجل الجزئي عند اختيار عميل — كان معطَّلاً لأي دفعة أقل من الإجمالي
  // فيستحيل إتمام الآجل الجزئي باللمس/الفأرة (F4 وحده كان يتجاوزه، وهو غائب على اللوحي).
  const canPay =
    cart.length > 0 &&
    (activeTab.payInput === "" || paid >= total || (isCredit && activeTab.customerId != null)) &&
    externalPaymentConfirmed;

  return (
    <div className="retail-pos-surface" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>

      {/* Header */}
      <POSHeader
        C={C}
        search={search} setSearch={setSearch}
        showDrop={showDrop} setShowDrop={setShowDrop}
        results={search.trim().length >= 2 ? (offline ? offlineResults : (searchResults.data ?? [])) : []}
        searching={offline ? offlineSearching : searchResults.isFetching}
        searchSettled={(offline ? !offlineSearching : !searchResults.isFetching) && debouncedSearch.trim() === search.trim() && search.trim().length >= 2}
        addToCart={addRow}
        searchRef={searchRef}
        handleScanKeyDown={handleScanKeyDown}
        lastInv={lastInv}
        onOpenCards={() => setCardsOpen(true)}
        cardsDisabled={offline || cartHasRegular}
        cardsDisabledReason={cartHasRegular
          ? REGULAR_CART_BLOCKS_DIGITAL_MESSAGE
          : offline
            ? "البيع الرقمي يحتاج اتصالاً بالخادم"
            : undefined}
        regularProductsDisabled={cartHasDigital}
        branchName={activeBranchName}
      />

      {headerActionsNode && createPortal(
        <RetailPosHeaderActions
          C={C}
          shift={shift}
          userRole={me.data?.role}
          onCloseShift={() => setShifting(true)}
          onCashDrop={() => setCashDropping(true)}
          printerReady={printerReady}
          onConnectPrinter={connectPrinter}
          bridgeEnabled={bridge.enabled}
          bridgeDesc={bridge.description}
          onTestPrint={testServerPrint}
        />,
        headerActionsNode,
      )}

      {cart.length > 0 && (
        <div
          role="status"
          data-testid="pos-cart-mode-guard"
          style={{
            margin: "6px 8px 0",
            border: `1px solid ${C.border}`,
            background: C.muted,
            color: C.mutedFg,
            borderRadius: 8,
            padding: "7px 10px",
            fontSize: 12.5,
            fontWeight: 700,
          }}
        >
          {cartHasDigital ? DIGITAL_CART_BLOCKS_REGULAR_MESSAGE : REGULAR_CART_BLOCKS_DIGITAL_MESSAGE}
        </div>
      )}

      {/* شبكة البطاقات الرقمية (ش٥) — لا أثر ماليّ عند الإضافة، فقط سطرٌ في السلة بسعر الخادم. */}
      <DigitalCardsPickerDialog
        open={cardsOpen}
        branchId={branchId}
        offline={offline}
        onClose={() => setCardsOpen(false)}
        onPick={addDigitalCard}
        existingReferences={digitalLines.map((c) => ({
          providerId: c.digital!.providerId,
          providerReference: c.digital!.providerReference,
        }))}
      />

      {/* خطوات التنفيذ الخارجيّ (ش٧) — كل كرت يُسجَّل نجاحه لحظةَ إصداره. */}
      <DigitalFulfillmentDialog
        intentId={fulfillIntentId}
        onClose={() => setFulfillIntentId(null)}
        onAllExecuted={(intentId) => {
          // كل الكروت صدرت ⇒ التثبيت المالي فوراً. المفتاح نفسه يجعل إعادة الإرسال تُعيد
          // الفاتورة ذاتها بدل إنشاء ثانية (idempotency على مستوى الخادم).
          if (finalizeSale.isPending) return;
          finalizeSale.mutate({
            intentId,
            clientRequestId: activeTab.clientRequestId,
            paymentAmount: String(total),
            paymentMethod: activeTab.method === "CARD" ? "CARD" : "CASH",
          });
        }}
      />

      {posFundingRequests.length > 0 && (
        <div
          data-testid="pos-shift-funding-banner"
          style={{
            margin: "6px 8px 0",
            border: `1px solid ${C.amber}`,
            background: C.amberSoft,
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 13 }}>عهدة نقدية بانتظار استلامك</div>
            <div style={{ fontSize: 12, color: C.mutedFg }}>
              لا تُضاف إلى الدرج إلا بعد عدّ النقد فعلياً وتأكيد الاستلام.
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {posFundingRequests.map((request) => (
              <div key={request.requestReceiptId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 13 }}>{fmt(Number(request.amount))} د.ع</span>
                <button
                  type="button"
                  disabled={acceptFundingM.isPending}
                  onClick={() =>
                    acceptFundingM.mutate({
                      requestReceiptId: request.requestReceiptId,
                      decision: "ACCEPT",
                    })
                  }
                  style={{
                    border: 0,
                    borderRadius: 6,
                    padding: "6px 10px",
                    background: C.success,
                    color: "white",
                    fontWeight: 900,
                    cursor: acceptFundingM.isPending ? "not-allowed" : "pointer",
                  }}
                >
                  {acceptFundingM.isPending ? "جارٍ التثبيت…" : "استلمت النقد"}
                </button>
              </div>
            ))}
            <Link
              href="/shifts"
              style={{
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                padding: "6px 10px",
                color: C.fg,
                fontSize: 12,
                fontWeight: 800,
                textDecoration: "none",
                background: C.card,
              }}
            >
              مراجعة الطلب أو رفضه
            </Link>
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <TabBar C={C} tabs={tabs} activeId={activeId} onSwitch={setActiveId} onAdd={addTab} onClose={closeTab} />

      {/* Body */}
      <div style={{ flex: 1, display: "flex", flexDirection: stacked ? "column-reverse" : "row", overflow: "hidden", padding: "7px 8px 8px", gap: 7, minHeight: 0 }}>

        {/* Payment Panel (right in RTL) */}
        <PaymentPanel
          C={C}
          stacked={stacked}
          total={total}
          subtotal={subtotal}
          invoiceDiscountAmount={invoiceDiscountAmount}
          invoiceDiscountPct={activeTab.invoiceDiscountPct ?? ""}
          setInvoiceDiscountPct={(v) => patchActive({ invoiceDiscountPct: v })}
          invoiceDiscountAllowed={invoiceDiscountAllowed}
          effectiveHeaderCapPct={effectiveHeaderCapPctD.toNumber()}
          cashRoundingDelta={cashRoundingDelta}
          payInput={activeTab.payInput}
          setPayInput={setPayInput}
          paid={paid} change={change} credit={credit}
          isChange={isChange} isOwing={isCredit}
          method={activeTab.method} setMethod={setMethod}
          paymentRef={activeTab.paymentRef ?? ""}
          setPaymentRef={(v) => patchActive({ paymentRef: v, externalPayment: null })}
          externalPaymentConfirmed={externalPaymentConfirmed}
          externalPaymentPending={initiateExternalPayment.isPending || confirmExternalPaymentMutation.isPending}
          onConfirmExternalPayment={() => { void confirmCurrentExternalPayment(); }}
          dueDate={activeTab.dueDate ?? ""}
          setDueDate={(v) => patchActive({ dueDate: v })}
          numMode={activeTab.numMode} setNumMode={setNumMode}
          numPress={numPress}
          onPay={submitSale} onQuickPay={quickPay}
          cartLen={cart.length} selId={activeTab.selId}
          isPending={sale.isPending}
          canPay={canPay}
          hasCustomer={selectedCustomer != null}
          saleError={saleError}
          onDismissError={() => setSaleError(null)}
          couponInput={activeTab.couponInput}
          couponCode={activeTab.couponCode}
          couponLabel={activeTab.couponLabel}
          setCouponInput={(value) => patchActive({ couponInput: value })}
          onApplyCoupon={applyCoupon}
          onClearCoupon={clearAppliedCoupon}
          couponPending={couponPreview.isPending}
        />

        {/* Cart Panel */}
        <CartPanel
          C={C}
          branchId={branchId}
          branchName={activeBranchName}
          openingActive={openingActive}
          openingEndsYmd={openingModeQ.data?.endsAtYmd ?? null}
          addTick={addTick}
          cart={cart} total={total}
          selId={activeTab.selId} setSelId={setSelId}
          changeQty={changeQty} removeRow={removeRow}
          numMode={activeTab.numMode} setNumMode={setNumMode}
          customerId={activeTab.customerId}
          selectedCustomer={selectedCustomer}
          tierOverride={activeTab.tierOverride}
          effectiveTier={effectiveTier}
          setTierOvr={setTierOvr}
          showCustPicker={showCustPicker}
          setShowCustPicker={setShowCustPicker}
          setCustId={setCustId}
          onClear={() => void (async () => {
            if (!(await confirm({
              variant: "warning",
              title: "تفريغ السلّة",
              description: "ستُفقد كل المنتجات المُضافة في هذه السلّة. هل تتابع؟",
              confirmText: "تفريغ",
            }))) return;
            setCart([]); setSelId(null); setPayInput(""); patchActive({ invoiceDiscountPct: "" });
          })()}
        />
      </div>

      {/* Overlays */}
      {receipt && (
        <ReceiptOverlay
          C={C} receipt={receipt}
          onDismiss={() => {
            setReceipt(null);
            // ٢٣/٨ (بلاغ فحص UX): `useModalFocus` يعيد التركيز إلى «الزرّ الذي فتح الحوار» =
            // زرّ الدفع. سكانر الباركود التالي يكتب حروفه في الزرّ فيبتلعها بلا أثر (يوم كاملٌ
            // بمخزونٍ مضطرب دون تنبيه). نعيد التركيز صراحةً إلى حقل البحث كي يستقبل المسحة التالية.
            setTimeout(() => searchRef.current?.focus(), 0);
          }}
          onPrint={() => printReceipt(buildBrandedReceipt(receipt!)).then((printed) => {
            if (!printed.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
          }).catch((error) => notify.err(error))}
        />
      )}
      {shifting && (
        <ShiftCloseDialog
          C={C} shift={shift} branchId={branchId}
          onClose={() => setShifting(false)}
          onClosed={() => { setShifting(false); shiftQ.refetch(); }}
          me={me.data}
          branches={branches.data}
        />
      )}
      {cashDropping && shift && (
        <CashDropDialog
          C={C}
          shiftId={shift.id}
          onClose={() => setCashDropping(false)}
        />
      )}
      {creditPrompt && (
        <CreditApprovalDialog
          C={C} message={creditPrompt}
          mgrEmail={mgrEmail} setMgrEmail={setMgrEmail}
          mgrPwd={mgrPwd} setMgrPwd={setMgrPwd}
          isPending={sale.isPending}
          onApprove={() => submitSale({ email: mgrEmail, password: mgrPwd })}
          onCancel={() => setCreditPrompt(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── POSHeader ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type ShiftData = RouterOutputs["shifts"]["current"];

function RetailPosHeaderActions({
  C,
  shift,
  userRole,
  onCloseShift,
  onCashDrop,
  printerReady,
  onConnectPrinter,
  bridgeEnabled,
  bridgeDesc,
  onTestPrint,
}: {
  C: C;
  shift: ShiftData;
  userRole?: string | null;
  onCloseShift: () => void;
  onCashDrop: () => void;
  printerReady: boolean;
  onConnectPrinter: () => void;
  bridgeEnabled: boolean;
  bridgeDesc: string;
  onTestPrint: () => void;
}) {
  return (
    <>
      {shift && (
        <span className="inline-flex h-[var(--ui-control)] shrink-0 items-center rounded-lg border bg-muted/40 px-2.5 text-xs font-bold text-muted-foreground">
          <span aria-hidden className="me-1.5 size-2 rounded-full bg-[var(--sem-pos)]" />
          وردية #{shift.id}
        </span>
      )}
      {bridgeEnabled && (
        <button
          type="button"
          onClick={onTestPrint}
          title={`جسر طباعة صامت: ${bridgeDesc} — اضغط لطباعة تذكرة اختبار`}
          aria-label="اختبار جسر الطباعة"
          className="inline-flex size-[var(--ui-control)] shrink-0 items-center justify-center rounded-lg border border-[var(--sem-pos)] text-[var(--sem-pos)]"
        >
          <Globe aria-hidden size={16} />
        </button>
      )}
      {isWebUsbSupported() && (
        <button
          type="button"
          onClick={onConnectPrinter}
          title={printerReady ? "الطابعة الافتراضية مربوطة — اضغط لتبديلها" : "ربط الطابعة الحرارية"}
          aria-label={printerReady ? "الطابعة الافتراضية مربوطة" : "ربط الطابعة الحرارية"}
          className="inline-flex size-[var(--ui-control)] shrink-0 items-center justify-center rounded-lg border"
          style={{ color: printerReady ? C.success : C.mutedFg, borderColor: printerReady ? C.success : C.border }}
        >
          <Printer aria-hidden size={16} />
        </button>
      )}
      {shift && (
        <button
          type="button"
          onClick={onCashDrop}
          title="سحب نقدي من الدرج إلى الخزينة"
          className="inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-xs font-bold"
        >
          <Banknote aria-hidden size={16} />
          <span className="hidden 2xl:inline">سحب نقدي</span>
        </button>
      )}
      <button
        type="button"
        onClick={onCloseShift}
        title="إغلاق الوردية"
        className="inline-flex h-[var(--ui-control)] shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-xs font-bold"
      >
        <Power aria-hidden size={16} />
        <span className="hidden 2xl:inline">إغلاق الوردية</span>
      </button>
      <OfflineSyncChip userRole={userRole} placement="inline" />
    </>
  );
}

interface POSHeaderProps {
  C: C;
  search: string; setSearch: (s: string) => void;
  showDrop: boolean; setShowDrop: (v: boolean) => void;
  results: RouterOutputs["catalog"]["posList"];
  searching: boolean;
  /** النتائج مطابقة لنص البحث الحالي (لا طلب معلّقاً ولا تأجيلاً) ⇒ Enter آمن */
  searchSettled: boolean;
  addToCart: (row: RouterOutputs["catalog"]["posList"][number]) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  handleScanKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, curVal: string, setValue: (s: string) => void) => void;
  lastInv: { num: string; total: number } | null;
  /** فتح شبكة «الكروت والاشتراكات» (ش٥) — معطَّل أثناء الانقطاع (البيع الرقميّ أونلاين حصراً). */
  onOpenCards: () => void;
  cardsDisabled: boolean;
  cardsDisabledReason?: string;
  /** البحث/المسح العاديان يتوقفان حين تكون السلة رقمية. */
  regularProductsDisabled: boolean;
  branchName: string;
}

function POSHeader({ C, search, setSearch, showDrop, setShowDrop, results, searching, searchSettled, addToCart, searchRef, handleScanKeyDown, lastInv, onOpenCards, cardsDisabled, cardsDisabledReason, regularProductsDisabled, branchName }: POSHeaderProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setShowDrop(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [setShowDrop]);

  const stockColor = (stock: number) =>
    stock < 5 ? C.danger : stock < 15 ? C.amber : C.mutedFg;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "7px 14px", minHeight: 64, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 40 }}>

      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Store aria-hidden size={20} /></div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 11, color: C.mutedFg, lineHeight: 1.2 }}>نقطة البيع</div>
        </div>
      </div>

      <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />

      {/* الكروت والاشتراكات (ش٥) — مدخل نافذة البطاقات الرقمية داخل نفس نقطة البيع والوردية */}
      <button
        onClick={onOpenCards}
        disabled={cardsDisabled}
        title={cardsDisabled ? cardsDisabledReason : "الكروت والاشتراكات (F3)"}
        style={{
          height: 50, padding: "0 14px", borderRadius: 10, flexShrink: 0, fontFamily: "inherit",
          fontSize: 14, fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 7,
          border: `1.5px solid ${cardsDisabled ? C.border : C.primary}`,
          background: cardsDisabled ? C.muted : C.primarySoft,
          color: cardsDisabled ? C.mutedFg : C.fg,
          cursor: cardsDisabled ? "not-allowed" : "pointer",
        }}
      >
        <CreditCard aria-hidden size={18} /> الكروت والاشتراكات
      </button>

      {/* Search with smart scan */}
      <div ref={wrapRef} style={{ flex: "1 1 460px", minWidth: 240, position: "relative" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <span style={{ position: "absolute", right: 13, zIndex: 1, color: C.mutedFg, display: "flex", pointerEvents: "none" }} aria-hidden><Search size={17} /></span>
          <input
            ref={searchRef} autoFocus
            disabled={regularProductsDisabled}
            title={regularProductsDisabled ? DIGITAL_CART_BLOCKS_REGULAR_MESSAGE : undefined}
            placeholder={regularProductsDisabled
              ? "أكمل بيع البطاقات الرقمية أو أفرغ السلة أولاً"
              : "ابحث بالاسم أو SKU أو امسح الباركود… (F2)"}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowDrop(true); }}
            onFocus={(e) => { if (search) setShowDrop(true); e.target.style.borderColor = C.primary; }}
            onBlur={(e) => (e.target.style.borderColor = C.primary)}
            onKeyDown={(e) => {
              handleScanKeyDown(e, search, setSearch);
              if (e.defaultPrevented) return;
              // Enter يضيف أول نتيجة — فقط حين تطابق النتائج نصَّ البحث الحالي
              // (أثناء التأجيل/الجلب قد تكون النتائج لاستعلام أقدم ⇒ إضافة خاطئة).
              if (e.key === "Enter" && searchSettled && results.length > 0) addToCart(results[0]);
              if (e.key === "Escape") { setSearch(""); setShowDrop(false); }
            }}
            style={{ width: "100%", height: 50, border: `2px solid ${regularProductsDisabled ? C.border : C.primary}`, borderRadius: 10, background: regularProductsDisabled ? C.muted : C.primarySoft, boxShadow: regularProductsDisabled ? "none" : `inset 0 0 0 1px ${C.primary}22`, color: regularProductsDisabled ? C.mutedFg : C.fg, cursor: regularProductsDisabled ? "not-allowed" : "text", fontFamily: "inherit", fontSize: 14.5, outline: "none", paddingRight: 44, paddingLeft: search ? 44 : 14 }}
          />
          {search && (
            <button onClick={() => { setSearch(""); setShowDrop(false); searchRef.current?.focus(); }}
              aria-label="مسح البحث"
              style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "flex", padding: 4 }}><X aria-hidden size={16} /></button>
          )}
        </div>

        {/* Dropdown — نتائج، أو حالة واضحة (قصير/جارٍ البحث/لا نتائج) بدل الصمت */}
        {showDrop && !regularProductsDisabled && search.trim().length > 0 && (
          <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, left: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 10px 36px rgb(0 0 0/.18)", zIndex: 60, maxHeight: "60vh", overflowY: "auto" }}>
            {results.length === 0 && (
              <div style={{ padding: "14px 16px", fontSize: 12.5, color: C.mutedFg, textAlign: "center" }}>
                {search.trim().length < 2
                  ? "اكتب حرفين فأكثر للبحث…"
                  : searching
                    ? "جارٍ البحث…"
                    : `لا نتائج لـ «${search.trim()}» — جرّب كلمة أقصر أو امسح الباركود`}
              </div>
            )}
            {results.map((p) => (
              <div key={p.productUnitId} onClick={() => addToCart(p)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, minHeight: 60 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.muted)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: C.fg }}>
                    {p.productName}
                    {/* شارتا نوع السطر: «خِدمة» معلومة و«أمانة» تنبيهٌ محاسبيّ ⇒ توكنا
                        `--sem-info`/`--sem-warn` مع خلفيّتيهما: زوجٌ مُعايَرٌ على ≥٤.٥:١ نصّاً في
                        الوضعين، بينما زوج الكاشير `C.amber` على `C.amberSoft` يبلغ ~٣.٢:١ في
                        الفاتح فلا يصلح نصّاً هنا. دلالةٌ لا هويّةَ سطحٍ ⇒ لا تكسران لوحة الكاشير. */}
                    {p.isService && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sem-info)", background: "var(--sem-info-bg)", padding: "1px 6px", borderRadius: 4, marginRight: 6, verticalAlign: "middle" }}>خِدمة</span>
                    )}
                    {p.isConsignment && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sem-warn)", background: "var(--sem-warn-bg)", padding: "1px 6px", borderRadius: 4, marginRight: 6, verticalAlign: "middle" }}>أمانة</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.mutedFg, marginTop: 2 }}>
                    {p.sku} · {p.unitName}
                    {!p.isService && (
                      <span style={{ marginRight: 10, color: stockColor(p.availableBase ?? p.stockBase) }}>
                        {branchName} · فعلي: {fmt(p.stockBase)} · محجوز: {fmt(p.reservedBase ?? 0)} · متاح للبيع: {fmt(p.availableBase ?? p.stockBase)}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "left", flexShrink: 0, marginRight: 16 }}>
                  {p.price == null
                    ? <span style={{ fontSize: 12, color: C.danger }}>بلا سعر</span>
                    : <>
                        <div style={{ fontWeight: 900, color: C.primary, fontSize: 17, direction: "ltr" }}>{fmt(Number(p.price))}</div>
                        <div style={{ fontSize: 11, color: C.mutedFg, textAlign: "center" }}>د.ع</div>
                      </>
                  }
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Last invoice badge */}
      {lastInv && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--pos-branch-bg)", border: "1px solid var(--pos-branch-bord)", borderRadius: 8, padding: "3px 6px 3px 12px", flexShrink: 0, lineHeight: 1.3 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
            <span style={{ fontSize: 15, fontWeight: 900, direction: "ltr", color: C.primary }}>{fmt(lastInv.total)}</span>
            <span style={{ fontSize: 9.5, color: C.mutedFg }}>{lastInv.num}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <CopyButton value={lastInv.num} title="نسخ رقم آخر فاتورة" successMessage="تم نسخ رقم الفاتورة" />
            <CopyButton value={lastInv.total} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TabBar ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface TabBarProps {
  C: C; tabs: POSTab[]; activeId: number;
  onSwitch: (id: number) => void;
  onAdd: () => void;
  onClose: (id: number) => void;
}

function TabBar({ C, tabs, activeId, onSwitch, onAdd, onClose }: TabBarProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: C.bg, borderBottom: `1px solid ${C.border}`, flexShrink: 0, overflowX: "auto" }}>
      {tabs.map((tab) => {
        const tabTotal = tab.cart.reduce((s, c) => s + itemTotal(c), 0);
        const items    = tab.cart.reduce((s, c) => s + c.qty, 0);
        const active   = tab.id === activeId;
        return (
          <div key={tab.id} onClick={() => onSwitch(tab.id)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 8, background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg, border: `${active ? "2px" : "1.5px"} solid ${active ? C.primary : C.border}`, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap", fontSize: 13, fontWeight: 700, transition: "all .12s" }}>
            <span>{tab.label}</span>
            {tabTotal > 0 && (
              <span style={{ fontSize: 12, fontWeight: 800, direction: "ltr", opacity: active ? 1 : 0.75 }}>
                {fmt(tabTotal)} د.ع
              </span>
            )}
            {items > 0 && (
              <span style={{ background: active ? "rgba(255,255,255,.25)" : C.muted, color: active ? "#fff" : C.mutedFg, borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
                {items}
              </span>
            )}
            {tabs.length > 1 && (
              <button onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                aria-label="إغلاق التبويب"
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: active ? "rgba(255,255,255,.7)" : C.mutedFg, lineHeight: 1, display: "inline-flex" }}><X aria-hidden size={13} /></button>
            )}
          </div>
        );
      })}
      {tabs.length < 8 && (
        <button
          aria-label="طلب جديد"
          onClick={onAdd}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: 8, background: C.card, border: `1.5px dashed ${C.border}`, cursor: "pointer", fontSize: 22, color: C.mutedFg, flexShrink: 0 }}
        >+</button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CartPanel ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface CartPanelProps {
  C: C;
  branchId: number;
  branchName: string;
  cart: CartItem[]; total: number;
  selId: number | null; setSelId: (id: number | null) => void;
  changeQty: (id: number, qty: number) => void;
  removeRow: (id: number) => void;
  numMode: NumMode; setNumMode: (m: NumMode) => void;
  customerId: number | null;
  selectedCustomer:
    | RouterOutputs["customers"]["list"][number]
    | NonNullable<RouterOutputs["customers"]["get"]>
    | null;
  tierOverride: Tier | null; effectiveTier: Tier;
  setTierOvr: (v: Tier | null) => void;
  setCustId: (id: number | null) => void;
  showCustPicker: boolean; setShowCustPicker: (v: boolean) => void;
  onClear: () => void;
  /** «وضع الافتتاح» فعّال الآن (لافتة + وسم «غير مجرود» بدل «نافذ» المخيف). */
  openingActive: boolean;
  openingEndsYmd: string | null;
  /** ٢٣/٨ (Codex P2) — عدّاد إضافةٍ صريحٌ من الأب: يشغّل التمريرَ إلى السطر المُدرَج/المزاد
   *  فقط عند فعل الإضافة (لا عند حذف/تعديل كمّية/تبديل تبويب). */
  addTick: number;
}

function CartPanel({ C, branchId, branchName, cart, total, selId, setSelId, changeQty, removeRow, numMode, setNumMode, customerId, selectedCustomer, tierOverride, effectiveTier, setTierOvr, setCustId, showCustPicker, setShowCustPicker, onClear, openingActive, openingEndsYmd, addTick }: CartPanelProps) {
  const itemCount = cart.reduce((s, c) => s + c.qty, 0);

  // ٢٣/٨ — تمريرٌ تلقائيّ لآخر منتجٍ مُضاف (بلاغ المالك «لا يظهر المنتج المضاف حتى أنزل يدوياً»):
  // `addRow` يضبط selId على المنتج المُدرَج/المزاد كمّياً؛ نحرك السلّة كي يظهر ذلك السطر في مجال
  // الرؤية. المسح المتوالي أو النقر لا يجبر الكاشير على التمرير. `block: nearest` يمنع القفزات
  // العدوانيّة (إن كان السطر ظاهراً أصلاً لا يتحرّك). `behavior: smooth` يجعل الحركة ناعمةً
  // فيتتبّعها الكاشير بصرياً.
  //
  // ٢٣/٨ (Codex P2): الاعتماد على `selId + cart.length` يشغّل التمرير عند حذف صفٍّ آخر (يعيدنا
  // إلى السطر المحدَّد ولو كان بعيداً)، ولا يشغّله عند إعادة مسح السطر المحدَّد نفسه (لا selId
  // يتغيّر ولا الطول). العدّادُ الصريحُ `addTick` يعالج الحالتين: يزيد **فقط** عند فعل الإضافة.
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (selId == null) return;
    // rAF: التمرير بعد الرسم كي نضمن أنّ الصفَّ في DOM وارتفاعه محسوب.
    const raf = requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addTick]);
  const TH: React.CSSProperties = { padding: "9px 10px", fontWeight: 700, fontSize: 12.5, color: C.mutedFg, textAlign: "center", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: C.muted };
  const TD: React.CSSProperties = { padding: "10px 8px", textAlign: "center", fontSize: 14 };

  // حارس مخزون ليّن (إشارة بصرية فقط؛ الذرّية يفرضها الخادم في applyMovement). نجمع الطلب بالوحدة
  // الأساس لكل صنف (variant) عبر كل وحداته في السلّة، لأنّ رصيد الفرع (stockBase) واحدٌ للصنف
  // ويُشترَك بين وحداته (قطعة/درزن/كرتون). المقارنة بالمجموع لا بكل سطر ⇒ يُكتشف النقص حتى حين
  // يُباع الصنف نفسه بوحدات متعددة (١ درزن + ١ قطعة قد يتجاوزان المتاح رغم أنّ كلّ سطر وحده لا يتجاوزه).
  const demandByVariant = new Map<number, number>();
  for (const c of cart) {
    const f = Number(c.row.conversionFactor) || 1;
    demandByVariant.set(c.row.variantId, (demandByVariant.get(c.row.variantId) ?? 0) + c.qty * f);
  }
  const reservationVariantIds = Array.from(new Set(cart.filter((item) => !item.row.isService && !item.digital).map((item) => item.row.variantId)));
  const allocationsQ = trpc.reservations.activeAllocations.useQuery(
    { branchId, variantIds: reservationVariantIds },
    { enabled: reservationVariantIds.length > 0, staleTime: 15_000 },
  );
  const allocationsByVariant = new Map<number, NonNullable<typeof allocationsQ.data>>();
  for (const allocation of allocationsQ.data ?? []) {
    const list = allocationsByVariant.get(allocation.variantId) ?? [];
    list.push(allocation);
    allocationsByVariant.set(allocation.variantId, list);
  }
  const stockState = (c: CartItem) => {
    const convFactor  = Number(c.row.conversionFactor) || 1;
    // مُنتج خِدمي: لا مَخزون ⇒ لا نَفاد ولا نَقص (الخَادم يَتجاوز فَحص المَخزون أيضاً).
    if (c.row.isService) {
      return { isKnown: true, isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    }
    // ⚠ عقدٌ محفوظ (Codex P1 على PR #733): عرضُ `stockBase` أوفلاين كـ«متاحٍ للبيع» **يكذب**
    // بشأن الحجوزات — لقطةُ الأوفلاين تحمل الرصيد الفعليّ بلا reservationStock. صنفٌ رصيدُه ١٠
    // وحجوزاتٌ نشطة ١٠ يظهر «متاح ١٠» ⇒ الكاشير يقبض ثمّ يفشل الترحيل عند العودة. `isKnown` لا
    // يوسَّع؛ إصلاحُ حقيقيّ لبلاغ الأوفلاين يستلزم إثراءَ لقطة `buildStockSnapshot` بالحجز.
    const isKnown = c.row.branchId === branchId && c.row.availableBase != null;
    if (!isKnown) return { isKnown: false, isOut: false, isShort: false, availInUnit: 0 };
    const availBase   = c.row.availableBase ?? c.row.stockBase ?? 0;
    const reqBase     = demandByVariant.get(c.row.variantId) ?? c.qty * convFactor; // إجمالي طلب الصنف
    const isOut       = availBase <= 0;                       // نافذ — لا رصيد
    const isShort     = !isOut && reqBase > availBase;        // الطلب يتجاوز المتاح
    const availInUnit = Math.floor(availBase / convFactor);  // المتاح بوحدة السطر
    // «يُباع بالطلب» (0318): الخادم يُعفيه من حارس النفاد إعفاءً دائماً (`applyMovement`)، فوسمُه
    // «نافذاً» يكذب على الكاشير ويحجب زرّاً يعمل. نُطفئ **الوسم وحده** ونُبقي `availInUnit`
    // صادقاً كما هو — رصيدُه السالب هو عدّاد «مُباعٌ لم يُورَّد»، وإخفاؤه خلف ∞ يطمس الفائدة.
    if (c.row.allowBackorder) return { isKnown: true, isOut: false, isShort: false, availInUnit };
    return { isKnown: true, isOut, isShort, availInUnit };
  };
  // ملخّص للشارة الدائمة في التذييل (كي لا يختفي التحذير حين ينزلق السطر المميَّز خارج الرؤية).
  let anyOut = false, flaggedCount = 0;
  for (const c of cart) {
    const s = stockState(c);
    if (s.isOut)        { anyOut = true; flaggedCount++; }
    else if (s.isShort) { flaggedCount++; }
  }

  // minHeight:0 لازمٌ في الوضع المكدَّس: min-height:auto الافتراضيّ يمنع الانكماش
  // دون ارتفاع المحتوى، فيفيض العمود ويُقصّ ما تحته.
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", height: 46, background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, color: C.fg, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ShoppingCart size={17} aria-hidden /> سلة المشتريات
          </span>
          {cart.length > 0 && (
            <span style={{ background: C.primary, color: C.primaryFg, borderRadius: 12, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>
              {cart.length} منتج · {itemCount} قطعة
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Customer picker */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowCustPicker(!showCustPicker)}
              style={{ height: 34, padding: "0 11px", background: customerId ? C.primarySoft : C.card, border: `1.5px solid ${customerId ? C.primary : C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: customerId ? C.primary : C.mutedFg, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
              <User size={14} aria-hidden /> {selectedCustomer ? selectedCustomer.name : "عميل نقدي"}
              {selectedCustomer && (
                <span style={{ fontSize: 11, opacity: 0.8 }}>({TIER_LABEL[effectiveTier]})</span>
              )}
              <ChevronDown aria-hidden size={14} />
            </button>

            {showCustPicker && (
              <div onClick={(e) => e.stopPropagation()}
                // الفتح لليمين (داخل اللوحة الواسعة) لا لليسار: الزر في الجزء الأيسر من شريط
                // السلّة، وleft:0 يمنع تجاوز الحافّة وقصّ المحتوى بـoverflow:hidden للّوحة.
                // maxHeight + تمرير يصون الارتفاع إن فُتح نموذج إضافة عميل (لا اقتطاع عمودي).
                style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: 340, maxHeight: "calc(100vh - 140px)", overflowY: "auto", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 40px rgb(0 0 0/.2)", zIndex: 50, padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: C.fg }}>اختر عميلاً</div>
                <CustomerPicker
                  customerId={customerId}
                  onCustomerChange={(id) => { setCustId(id); setShowCustPicker(false); }}
                  balance={selectedCustomer?.currentBalance ?? null}
                />
                {selectedCustomer != null && selectedCustomer.creditLimit != null
                  && Number(selectedCustomer.creditLimit) === 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: C.mutedFg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 6px" }}>
                    نقديٌّ فقط — لا يقبل الآجل (حدّ ائتمانه صفر)
                  </div>
                )}
                <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label style={{ fontSize: 12, color: C.mutedFg }}>فئة السعر:</label>
                    <AppSelect value={effectiveTier} onValueChange={(value) => setTierOvr(value as Tier)}
                      style={{ height: 30, border: `1px solid ${C.border}`, borderRadius: 6, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 12, padding: "0 6px", outline: "none" }}>
                      <option value="RETAIL">مفرد</option>
                      <option value="WHOLESALE">جملة</option>
                      <option value="GOVERNMENT">حكومي</option>
                    </AppSelect>
                    {tierOverride && (
                      <button onClick={() => setTierOvr(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: C.mutedFg }}>↩</button>
                    )}
                  </div>
                  {customerId && (
                    <button onClick={() => { setCustId(null); setShowCustPicker(false); }}
                      style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, color: C.danger, fontFamily: "inherit" }}>
                      إلغاء العميل
                    </button>
                  )}
                </div>
                <button onClick={() => setShowCustPicker(false)}
                  aria-label="إغلاق منتقي العميل"
                  style={{ position: "absolute", top: 8, left: 10, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex" }}><X aria-hidden size={16} /></button>
              </div>
            )}
          </div>

          <span style={{ fontSize: 11.5, color: C.mutedFg }}>F2 · F4 · F12</span>
          {cart.length > 0 && (
            <button onClick={onClear}
              style={{ height: 34, padding: "0 10px", background: "none", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12.5, color: C.danger, fontFamily: "inherit", fontWeight: 700 }}>
              تفريغ
            </button>
          )}
        </div>
      </div>

      {/* «وضع الافتتاح» — لافتة دائمة ما دامت النافذة فعّالة.
          حبر اللافتة `C.modeFg` (حبر الكهرمان في لوحة الكاشير) لا `C.amber`: الأخير سطحٌ
          متوسّط اللمعان في الوضعين فيهبط تباينُه على `C.amberSoft` دون ٤.٥:١، بينما
          `--pos-mode-fg` يُظلم فاتحاً ويُفتِح داكناً فيصمد في الحالتين. */}
      {openingActive && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: C.amberSoft, borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: C.modeFg, flexShrink: 0 }}>
          <AlertTriangle aria-hidden size={13} />
          وضع الافتتاح فعّال{openingEndsYmd ? ` حتى نهاية يوم ${openingEndsYmd}` : ""} — المنتج غير المجرود يُباع حتى لو نفد رصيده (ينزل بالسالب حتى جرده الافتتاحي): نقداً/بطاقةً بسدادٍ كامل، أو آجلاً لعميلٍ محدَّد (يُسجَّل ذمّةً كاملة). البيع بلا عميلٍ محدَّد يبقى صارماً.
        </div>
      )}

      {/* سلّة الكاشير: شبكةُ تحرير (‎−/+‎ وحذفٌ لكل سطر) بتصميمٍ مخصّصٍ بأنماطٍ سطرية
          (لا Tailwind) لأنّ سطحَ الكاشير مضبوطٌ لشاشة اللمس وحجم الخطّ الكبير.
          `DataTable` أداةُ عرضٍ فلا تُطبَّق هنا. */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 540, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <th style={{ ...TH, width: 32 }}>#</th>
              <th style={{ ...TH, textAlign: "right" }}>المنتج</th>
              <th style={{ ...TH, width: 64 }}>الوحدة</th>
              <th style={{ ...TH, width: 110 }}>السعر</th>
              <th style={{ ...TH, width: 80 }}>المتاح للبيع</th>
              <th style={{ ...TH, width: 150 }}>الكمية</th>
              <th style={{ ...TH, width: 115 }}>الإجمالي</th>
              <th style={{ ...TH, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {cart.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: "56px 0", textAlign: "center", color: C.mutedFg }}>
                  <div style={{ marginBottom: 10, display: "flex", justifyContent: "center", opacity: 0.55 }}>
                    <ShoppingCart size={42} strokeWidth={1.5} aria-hidden />
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>السلة فارغة</div>
                  <div style={{ fontSize: 12.5, marginTop: 6 }}>ابحث أو امسح الباركود لإضافة المنتجات</div>
                </td>
              </tr>
            )}
            {cart.map((c, i) => {
              const ep       = effectivePrice(c);
              const lineId   = lineIdOf(c);
              const selected = selId === lineId;
              // تمييز بصري + نصّ قبل محاولة الدفع (المنطق المُجمَّع للصنف في stockState أعلاه).
              const { isKnown, isOut, isShort, availInUnit } = stockState(c);
              const allocations = allocationsByVariant.get(c.row.variantId) ?? [];
              // «وضع الافتتاح»: الصنف غير المُفتتَح (openedAt فارغ) يُباع نقداً بالسالب — وسم كهرماني
              // مطمئن بدل «نافذ» الأحمر المخيف (الحارس الفعلي خادميّ؛ الآجل/غير النقدي سيُرفض هناك).
              const openingSellable = (isOut || isShort) && openingActive && c.row.openedAt == null && !c.row.isService;
              const rowBg  = selected ? C.primarySoft : openingSellable ? C.amberSoft : isOut ? C.dangerSoft : isShort ? C.amberSoft : "transparent";
              const accent = openingSellable ? C.amber : isOut ? C.danger : isShort ? C.amber : "transparent";
              return (
                <tr key={lineId}
                  ref={selected ? selectedRowRef : undefined}
                  onClick={() => { setSelId(lineId); setNumMode("QTY"); }}
                  style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: rowBg, transition: "background .08s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = selected ? C.primarySoft : isOut ? C.dangerSoft : isShort ? C.amberSoft : C.muted; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = rowBg; }}
                >
                  <td style={{ ...TD, color: C.mutedFg, fontWeight: 600, borderInlineStart: `4px solid ${accent}` }}>{i + 1}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 800, fontSize: 19, lineHeight: 1.35, color: C.fg }}>
                    {/* م٣: الاسم الموحّد يُظهر اللون/القياس أو اسم البديل — كان يعرض اسم المنتج وحده. */}
                    {variantDisplayName({ productName: c.row.productName, variantName: c.row.variantName, color: c.row.color, size: c.row.size })}
                    <span style={{ fontSize: 13, color: C.mutedFg, fontWeight: 500, marginRight: 5 }}>{c.row.sku}</span>
                    {!c.row.isService && !isKnown && (
                      <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 700, marginRight: 5 }}>
                        جارٍ التحقق من الرصيد
                      </span>
                    )}
                    {c.disc != null && c.disc > 0 && (
                      <span style={{ fontSize: 11, color: C.danger, fontWeight: 700, marginRight: 4 }}>−{c.disc}%</span>
                    )}
                    {c.digital && (
                      // §٨.٦: شارة السطر — «كرت رقمي»، أو «تعليمي — اسم الطالب» حين تُلتقط بياناته.
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: C.primaryFg, background: C.primary, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <CreditCard aria-hidden size={12} />
                        {c.digital.student
                          ? `تعليمي — ${c.digital.student.studentName}`
                          : c.digital.requiresStudentData ? "اشتراك تعليمي" : "كرت رقمي"}
                      </span>
                    )}
                    {!c.digital && !c.row.isService && isKnown && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", marginTop: 5, fontSize: 11.5, fontWeight: 700, color: C.mutedFg }}>
                        <span>{branchName}</span>
                        <span>فعلي {fmt(c.row.stockBase ?? 0)}</span>
                        <span style={{ color: (c.row.reservedBase ?? 0) > 0 ? C.amber : C.mutedFg }}>
                          محجوز {fmt(c.row.reservedBase ?? 0)}
                        </span>
                        <span>متاح للبيع {fmt(c.row.availableBase ?? c.row.stockBase ?? 0)}</span>
                      </div>
                    )}
                    {allocations.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                        {allocations.map((allocation) => (
                          <span
                            key={allocation.reservationId}
                            style={{ border: `1px solid ${C.amber}`, background: C.amberSoft, color: C.modeFg, borderRadius: 5, padding: "2px 7px", fontSize: 11.5, fontWeight: 800 }}
                          >
                            حجز باسم {allocation.customerName} · {fmt(allocation.remainingBase)} وحدة أساس
                          </span>
                        ))}
                      </div>
                    )}
                    {c.digital && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 5, fontSize: 12.5, fontWeight: 800, color: C.fg }}>
                        <span dir="ltr">
                          {c.digital.requiresStudentData ? "ID الاشتراك" : "ID العملية"}: {c.digital.providerReference}
                        </span>
                        {c.digital.student && <span>{c.digital.student.studentName} · <span dir="ltr">{c.digital.student.studentPhone}</span></span>}
                      </div>
                    )}
                    {openingSellable && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} /> غير مجرود — يُباع نقداً بالسالب
                      </span>
                    )}
                    {/* «يُباع بالطلب» (0318): الصنف مسموحٌ بيعه قبل توريده — نُصرّح بذلك بدل ترك
                        الكاشير يظنّ الرصيدَ الصفريّ/السالب عطباً. الرقم في العمود يبقى الحقيقة. */}
                    {c.row.allowBackorder && (c.row.availableBase ?? 0) <= 0 && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <PackagePlus aria-hidden size={12} /> يُباع بالطلب — يُورَّد لاحقاً
                      </span>
                    )}
                    {!openingSellable && isOut && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#fff", background: C.danger, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} /> نافذ — لا مخزون
                      </span>
                    )}
                    {!openingSellable && isShort && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} />
                        {availInUnit === 0
                          ? "لا يكفي لوحدة كاملة"
                          : `المتاح ${fmt(availInUnit)} ${c.row.unitName} فقط`}
                      </span>
                    )}
                  </td>
                  <td style={{ ...TD, color: C.mutedFg, fontSize: 12.5 }}>{c.row.unitName}</td>
                  <td style={{ ...TD, direction: "ltr", color: C.mutedFg }}>
                    {c.disc != null && c.disc > 0
                      ? <>
                          <span style={{ textDecoration: "line-through", fontSize: 12, opacity: 0.6 }}>{fmt(Number(c.row.price ?? 0))}</span>
                          &nbsp;
                          <span style={{ color: C.danger, fontWeight: 700 }}>{fmt(ep)}</span>
                        </>
                      : fmt(ep)
                    }
                  </td>
                  {/* عمود المخزون: ∞ للخدمات، رقم بلون أحمر/أصفر/طبيعي حسب الحالة. */}
                  <td style={{ ...TD, direction: "ltr", fontWeight: 700, color: isOut ? C.danger : isShort ? C.amber : C.mutedFg }}>
                    {c.row.isService ? "∞" : isKnown ? fmt(availInUnit) : "…"}
                  </td>
                  <td style={{ ...TD, padding: "6px 6px" }}>
                    {c.digital ? (
                      // §٨.٦: كمّية الكرت الرقميّ ثابتة — لا أزرار زيادة/نقصان؛ الزيادة بإضافة بطاقة أخرى.
                      <div style={{ textAlign: "center", fontWeight: 800, fontSize: 15, direction: "ltr", color: C.mutedFg }} title="لزيادة العدد أضِف بطاقة أخرى — كل كرت له مرجع تنفيذ مستقلّ">1</div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                        <button onClick={(e) => { e.stopPropagation(); changeQty(lineId, c.qty - 1); }}
                          style={{ width: 44, height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 22, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                        <span style={{ minWidth: 40, textAlign: "center", fontWeight: 800, fontSize: 15, direction: "ltr", color: C.fg }}>{c.qty}</span>
                        <button onClick={(e) => { e.stopPropagation(); changeQty(lineId, c.qty + 1); }}
                          title={isOut || isShort ? "الزيادة تتجاوز المخزون المتاح" : undefined}
                          style={{ width: 44, height: 44, border: `1.5px solid ${isOut || isShort ? accent : C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 22, color: isOut || isShort ? accent : C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, direction: "ltr", fontWeight: 800, fontSize: 14.5, color: C.fg }}>{fmt(itemTotal(c))}</td>
                  <td style={{ ...TD, padding: "6px" }}>
                    <button onClick={(e) => { e.stopPropagation(); removeRow(lineId); }}
                      aria-label="حذف السطر"
                      style={{ width: 44, height: 44, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X aria-hidden size={18} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      {cart.length > 0 && (
        <div style={{ borderTop: `2px solid ${C.border}`, padding: "9px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.muted, flexShrink: 0, gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 13, color: C.mutedFg, whiteSpace: "nowrap" }}>{cart.length} منتج · {itemCount} قطعة</span>
            {flaggedCount > 0 && (
              // شارة دائمة تلخّص أصناف نقص المخزون كي لا يختفي التحذير حين ينزلق سطره خارج الرؤية.
              <span style={{ background: anyOut ? C.danger : C.amber, color: anyOut ? "#fff" : "#241900", borderRadius: 8, padding: "3px 10px", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <AlertTriangle aria-hidden size={13} /> {flaggedCount} منتج ناقص المخزون
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
            <span style={{ fontSize: 13.5, color: C.mutedFg }}>المجموع:</span>
            <span style={{ fontSize: 28, fontWeight: 900, direction: "ltr", color: C.fg }}>{fmt(total)}</span>
            <span style={{ fontSize: 13, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PaymentPanel ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface PaymentPanelProps {
  C: C;
  total: number; payInput: string;
  /** المجموع قبل خصم رأس الفاتورة (subtotal). = total إن كان الخصم صفراً. */
  subtotal: number;
  /** مبلغ خصم رأس الفاتورة المُحتسَب من النسبة، للعرض والتحقّق البصريّ. */
  invoiceDiscountAmount: number;
  /** نصّ نسبة خصم رأس الفاتورة (٠–١٥) — سلسلة كي تقبل حالة «فارغ = صفر». */
  invoiceDiscountPct: string;
  setInvoiceDiscountPct: (value: string) => void;
  /** false ⇒ الحقل غير مسموحٍ (مثلاً سلّة كرت رقميّ) — يُعطَّل بصرياً وتبطل قيمته الفعلية. */
  invoiceDiscountAllowed: boolean;
  /** السقفُ الفعّال المتبقّي بالنقاط المئوية (يُقصّ سلطةَ الكاشير حين توجد خصوماتُ سطرٍ مسبقة). */
  effectiveHeaderCapPct: number;
  /** فرقُ التقريب النقديّ الحاليّ (± د.ع) — يُعرض إفصاحاً حين لا يكون صفراً. */
  cashRoundingDelta: number;
  setPayInput: (updater: string | ((s: string) => string)) => void;
  paid: number; change: number; credit: number;
  isChange: boolean; isOwing: boolean;
  method: PaymentMethod; setMethod: (m: PaymentMethod) => void;
  paymentRef: string; setPaymentRef: (v: string) => void;
  externalPaymentConfirmed: boolean; externalPaymentPending: boolean; onConfirmExternalPayment: () => void;
  dueDate: string; setDueDate: (v: string) => void;
  numMode: NumMode; setNumMode: (m: NumMode) => void;
  numPress: (k: string) => void;
  onPay: () => void; onQuickPay: () => void;
  cartLen: number; selId: number | null;
  isPending: boolean; canPay: boolean; hasCustomer: boolean;
  saleError: string | null; onDismissError: () => void;
  stacked: boolean;
  couponInput: string; couponCode: string | null; couponLabel: string | null;
  setCouponInput: (value: string) => void; onApplyCoupon: () => void; onClearCoupon: () => void;
  couponPending: boolean;
}

function PaymentPanel({ C, total, subtotal, invoiceDiscountAmount, invoiceDiscountPct, setInvoiceDiscountPct, invoiceDiscountAllowed, effectiveHeaderCapPct, cashRoundingDelta, payInput, setPayInput, paid, change, credit, isChange, isOwing, method, setMethod, paymentRef, setPaymentRef, externalPaymentConfirmed, externalPaymentPending, onConfirmExternalPayment, dueDate, setDueDate, numMode, setNumMode, numPress, onPay, onQuickPay, cartLen, isPending, canPay, hasCustomer, saleError, onDismissError, stacked, couponInput, couponCode, couponLabel, setCouponInput, onApplyCoupon, onClearCoupon, couponPending }: PaymentPanelProps) {

  // ── الاحتواء الديناميكي: تركيبٌ متكيّف قبل المقياس ───────────────────────────
  // شاشات الكاشير الفيزيائية صغيرة، والمطلوب وضوحٌ وكِبَرٌ لا انكماش. لذلك عند ضيق
  // الارتفاع **يُحذف الثانويّ** (رقائق المبالغ، الكوبون، سطور التلميح) ويُعاد تركيب
  // طرق الدفع صفّاً واحداً — بدل تصغير الأساسيّ. الحدّ الأدنى للمفتاح 44px (هدف
  // اللمس المعياريّ) فلا ينزل تحته مهما ضاقت المساحة، والتمرير يبقى شبكة أمانٍ
  // أخيرة لا تُبلَغ في مدى التشغيل الفعليّ.
  const dense = useMediaQuery("(max-height: 820px)");
  const ultra = useMediaQuery("(max-height: 660px)");
  // ٢٣/٨ (Codex P1 v2): حقلُ المبلغ يفصل «العرض» (raw ما يكتبه الكاشير) عن «القيمة الملتزمة»
  // (`payInput` المطبَّعة). عقد التطبيع من `shared/numberNormalize` هو المرجع — `1,5` ⇒ `1.5`،
  // `1,234` ⇒ `1234`، `1،5` كذلك. الحالات الوسطى الملتبسة تبقى في العرض ولا تُلتزم كي لا تتحطّم
  // `D()` عليها. الأزرارُ السريعة/`+/-` تكتب على `payInput` مباشرةً؛ نُزامن العرضَ حينها.
  const [displayPay, setDisplayPay] = useState(payInput);
  useEffect(() => {
    try {
      const norm = normalizeNumberInput(displayPay).normalized;
      if (norm !== payInput) setDisplayPay(payInput);
    } catch { setDisplayPay(payInput); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payInput]);
  const [couponOpen, setCouponOpen] = useState(false);
  // الكوبون يظهر دائماً وهو مُطبَّق (لا يُخفى خصمٌ سارٍ)، أو عند طلبه صراحةً.
  const showCoupon = !dense || !!couponCode || couponOpen;
  // ٢٣/٨ — طيّ لوحة الأرقام: الشاشات القصيرة (dense) كانت تُخفي طرقَ الدفع تحت التمرير لأنّ
  // اللوحةَ داخل منطقة تمرير مشتركة. الطيّ يُعيد ~٢٠٠px عمودياً فتظهر الأزرارُ كلّها بلا تمرير.
  // الافتراضي: مطويّة على dense، مفتوحة على الشاشات الطويلة. القرارُ محفوظٌ في localStorage
  // فيبقى تفضيلُ الكاشير بين الجلسات. حقلُ المبلغ يقبل الكتابةَ المباشرة بلوحة المفاتيح (بلا حاجة
  // إلى النمباد أصلاً على أجهزة الديسك)، والأزرارُ الثلاثة (كمية/%/مبلغ) تُبقي اللمس ممكناً
  // بفتح اللوحة تلقائياً عند اختيار وضعِ كميةٍ أو خصم.
  const [numpadOpen, setNumpadOpen] = useState<boolean>(() => {
    try {
      const stored = typeof window !== "undefined" ? window.localStorage.getItem("pos.numpadOpen") : null;
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch { /* localStorage may be blocked */ }
    return !dense;
  });
  const persistNumpad = (open: boolean) => {
    setNumpadOpen(open);
    try { window.localStorage.setItem("pos.numpadOpen", open ? "1" : "0"); } catch { /* ignore */ }
  };
  // فتحٌ تلقائيّ عند اختيار وضع «الكمية» أو «%»: بلا نمباد لا سبيل لتعديلهما هنا (مجهود لمس)،
  // فيُفتح تلقائياً كي لا يعمى الكاشير عن مدخلٍ لا يراه. وضعُ «المبلغ» يبقى قابلاً للطيّ لأنّ
  // الحقل نفسه صار `<input>` يقبل الكتابة المباشرة.
  const setNumModeAndReveal = (m: NumMode) => {
    setNumMode(m);
    if ((m === "QTY" || m === "DISC") && !numpadOpen) persistNumpad(true);
  };
  const showQuickPay = !hasCustomer && !isOwing;
  // حشوة الكتل الداخلية تضيق في أضيق مستوى — آخر ما يُقتطع بعد حذف الثانويّ،
  // ولا يمسّ مقاسات الأزرار نفسها (تبقى ≥44px).
  const blockPad = ultra ? "2px 11px 0" : "4px 11px 3px";

  // `cqh` تقيس ارتفاع اللوحة الفعليّ (لا الشاشة) ⇒ تتبع الزوم والدقّة والنافذة
  // بآليّةٍ واحدة. مكدَّساً يحدّد المحتوى ارتفاع اللوحة و`contain:size` الذي
  // يستلزمه container-type كان يطويها ⇒ نقيس هناك بالشاشة.
  const HU = stacked ? "vh" : "cqh";
  const fluid = (min: number, ratio: number, max: number) => `clamp(${min}px, ${ratio}${HU}, ${max}px)`;

  const modeStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: fluid(44, 6.6, 58), minWidth: 70, padding: "0 8px",
    fontSize: 13.5, fontWeight: 800, cursor: "pointer",
    fontFamily: "inherit", borderRadius: 9,
    border: active ? `1.5px solid ${C.modeBord}` : `1.5px solid ${C.border}`,
    background: active ? C.modeActive : C.numKey,
    color: active ? C.modeFg : C.mutedFg,
    // ⚠ لا تُعِدها `all`: مع ارتفاعٍ بوحدات الحاوية يُبقي كروم القيمة القديمة عند تغيّر
    // حجم الحاوية (الانتقال لا يُعيد حلّ الوحدة) فيثبت الزرّ على مقاسٍ بائد.
    transition: "background .1s, color .1s, border-color .1s", userSelect: "none" as const, touchAction: "manipulation" as const,
  });

  const numKeyStyle = (del?: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: fluid(44, 6.6, 58), fontSize: fluid(19, 2.7, 24), fontWeight: 800,
    background: del ? C.delKey : C.numKey,
    color: del ? C.delFg : C.fg,
    border: `1.5px solid ${C.border}`,
    borderRadius: 9, cursor: "pointer",
    fontFamily: "inherit", direction: "ltr" as const,
    transition: "background .07s, transform .06s",
    userSelect: "none" as const, touchAction: "manipulation" as const,
  });

  const payMethodStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center",
    gap: 3, minHeight: fluid(46, 6.6, 60), fontSize: dense ? 13 : 14, fontWeight: 800,
    border: `2px solid ${active ? C.primary : C.border}`,
    borderRadius: 9, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
    background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg,
    transition: "background .1s, color .1s, border-color .1s, box-shadow .1s", userSelect: "none" as const,
    boxShadow: active ? `0 3px 10px color-mix(in oklch, ${C.primary} 28%, transparent)` : "none",
    opacity: disabled ? 0.55 : 1,
  });

  const modeLabel = numMode === "QTY"  ? "الكمية — المنتج المحدد"
    : numMode === "DISC" ? "خصم % على المنتج"
    : "المبلغ المستلم";

  return (
    <div style={{
      width: stacked ? "100%" : 420, maxWidth: "100%",
      // مكدَّساً: تشارك المساحة وتنكمش. كانت flexShrink:0 بارتفاعها الطبيعيّ ⇒ تفيض فتُقصّ.
      ...(stacked ? { flex: "1 1 auto" } : { flexShrink: 0 }),
      minHeight: 0,
      display: "flex", flexDirection: "column",
      containerType: stacked ? undefined : "size",
      background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden",
    }}>

      {/* خطأ بيع حرِج ثابت (بديل toast العابر) — يبقى ظاهراً حتى محاولة جديدة/إغلاق يدوي */}
      {saleError && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 12px", background: C.dangerSoft, borderBottom: `1px solid ${C.danger}`, color: C.danger, fontSize: 12.5, fontWeight: 700, flexShrink: 0 }}>
          <AlertTriangle aria-hidden size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ flex: 1, lineHeight: 1.4 }}>{saleError}</span>
          <button onClick={onDismissError} aria-label="إغلاق التنبيه" style={{ background: "none", border: "none", cursor: "pointer", color: C.danger, lineHeight: 1, padding: 0, display: "inline-flex", flexShrink: 0 }}><X aria-hidden size={15} /></button>
        </div>
      )}

      {/* Total */}
      <div style={{ padding: ultra ? "4px 13px" : "8px 13px", background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {/* المجموع قبل الخصم — يُعرض فقط عند تطبيق خصم رأس فاتورة، ليتحقّق الكاشير من الفرق أمام العميل. */}
        {invoiceDiscountAmount > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
            <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 600 }}>المجموع قبل الخصم</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, direction: "ltr", color: C.mutedFg, textDecoration: "line-through" }}>{fmt(subtotal)}</span>
              <span style={{ fontSize: 11, color: C.mutedFg }}>د.ع</span>
            </div>
          </div>
        )}
        {/* خصم على الفاتورة (٢٢/٨) — سلطة الكاشير مقصورة على ١٥٪ (قرار المالك)؛ فوقه بوّابة مدير خادمياً.
            صار (٢٣/٨) بارزاً بصرياً: بلاغُ المالك «الخصم غير ظاهر» — الحقلُ كان ١١٫٥px بعرضٍ ٤٢px
            يبتلعه رأس الإجمالي. أعِيدَ تصميمُه بأيقونةٍ ولوحةٍ صريحة و`title` تصف السقف، فيراه
            الكاشير عند كلّ حساب. سقفٌ فعّال ديناميّ يقصّ الانحرافَ المسبق (عرض/خصم يدويّ). */}
        <div
          role="group"
          aria-label="خصم على الفاتورة"
          title={invoiceDiscountAllowed
            ? `اكتب نسبة الخصم (0 إلى ${Number.isInteger(effectiveHeaderCapPct) ? effectiveHeaderCapPct : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "")}٪) — فوق السقف يلزم اعتماد مدير`
            : "خصم رأس الفاتورة غير متاح لسلّة الكروت الرقمية"}
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 4, gap: 8,
            padding: "6px 10px",
            borderRadius: 8,
            border: `${invoiceDiscountAmount > 0 ? 2 : 1.5}px ${invoiceDiscountAmount > 0 ? "solid" : "dashed"} ${invoiceDiscountAmount > 0 ? C.amber : C.border}`,
            background: invoiceDiscountAmount > 0 ? C.amberSoft : C.card,
            transition: "border-color .12s, background .12s",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: invoiceDiscountAmount > 0 ? C.amber : C.fg, fontWeight: 800, flexShrink: 0 }}>
            <Percent aria-hidden size={14} strokeWidth={2.5} />
            خصم على الفاتورة
            {invoiceDiscountAllowed ? (
              <span style={{ color: C.mutedFg, fontWeight: 600, fontSize: 11 }}>
                (0–{Number.isInteger(effectiveHeaderCapPct) ? effectiveHeaderCapPct : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "")}٪)
              </span>
            ) : (
              <span style={{ color: C.mutedFg, fontWeight: 500, fontSize: 11 }}>(غير متاحٍ للكروت)</span>
            )}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {invoiceDiscountAmount > 0 && (
              <>
                <span style={{ fontSize: 12.5, color: C.amber, fontWeight: 900, direction: "ltr" }}>
                  −{fmt(invoiceDiscountAmount)}
                </span>
                <button
                  type="button"
                  onClick={() => setInvoiceDiscountPct("")}
                  aria-label="إزالة خصم الفاتورة"
                  title="إزالة الخصم"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, border: "none", background: "transparent", color: C.amber, cursor: "pointer", padding: 0, borderRadius: 4 }}
                >
                  <X aria-hidden size={14} strokeWidth={2.5} />
                </button>
              </>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 2, border: `2px solid ${invoiceDiscountAmount > 0 ? C.amber : C.primary}`, borderRadius: 8, background: C.card, height: 32, padding: "0 6px", boxShadow: invoiceDiscountAmount > 0 ? `0 0 0 3px color-mix(in oklch, ${C.amber} 35%, transparent)` : "none" }}>
              <input
                type="text"
                inputMode="decimal"
                value={invoiceDiscountPct}
                onChange={(e) => {
                  // القبول الصارم: لا نمسح المحارف الممنوعة بصمت. `-` أو أيّ رمزٍ غير مسموح يُرَدّ
                  // إلى القيمة السابقة (لا تحويل صامت لسالبٍ إلى موجب). الفاصلةُ العربية/الأوروبية `،/,`
                  // تُطبَّع إلى نقطةٍ (نفس معنى الفاصل العشريّ)، ولا نقطتان.
                  // ٢٣/٨ — Codex P1: نمنع `.` منفرداً كي لا يمرّ لـD() فيرمي.
                  const src = e.target.value;
                  if (src === "") { setInvoiceDiscountPct(""); return; }
                  const norm = src.replace(/[،,]/g, ".");
                  if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(norm)) return;
                  const n = Number(norm);
                  if (!Number.isFinite(n) || n < 0) return;
                  if (n > effectiveHeaderCapPct) {
                    const capStr = Number.isInteger(effectiveHeaderCapPct)
                      ? String(effectiveHeaderCapPct)
                      : effectiveHeaderCapPct.toFixed(2).replace(/\.?0+$/, "");
                    setInvoiceDiscountPct(capStr);
                    return;
                  }
                  setInvoiceDiscountPct(norm);
                }}
                onBlur={(e) => {
                  // تنظيف على الترك: قصّ الأصفار الرائدة وتوحيد التمثيل.
                  const raw = e.target.value.trim();
                  if (raw === "" || raw === "0" || raw === "0.") { setInvoiceDiscountPct(""); return; }
                  const n = Number(raw);
                  if (!Number.isFinite(n) || n <= 0) { setInvoiceDiscountPct(""); return; }
                }}
                placeholder="0"
                aria-label="نسبة خصم الفاتورة"
                disabled={!invoiceDiscountAllowed}
                style={{
                  width: 52, height: 28, border: "none", outline: "none",
                  background: "transparent", color: C.fg,
                  fontSize: 15, fontWeight: 900, textAlign: "center",
                  direction: "ltr", fontFamily: "inherit",
                }}
              />
              <span style={{ fontSize: 13.5, color: invoiceDiscountAmount > 0 ? C.amber : C.mutedFg, fontWeight: 800 }}>%</span>
            </div>
          </div>
        </div>
        {/* تقريبٌ نقديٌّ IQD — يظهر حين يجعل الصافيَ غير مضاعفٍ لـ٢٥٠ (النقد الكامل فقط، سياسة المالك).
            الإفصاحُ يجعل حسابَ الشاشة يطابق ما يُطبع على الإيصال (subtotal − discount ± rounding = total). */}
        {cashRoundingDelta !== 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
            <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 600 }}>تقريب نقديّ IQD</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, direction: "ltr", color: C.mutedFg }}>
                {cashRoundingDelta > 0 ? "+" : ""}{fmt(cashRoundingDelta)}
              </span>
              <span style={{ fontSize: 11, color: C.mutedFg }}>د.ع</span>
            </div>
          </div>
        )}
        {/* الصافي — الرقم الكبير هو ما يقبضه الكاشير فعلياً من الزبون (بعد التقريب النقديّ). */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.mutedFg, fontWeight: 600 }}>
            {invoiceDiscountAmount > 0 || cashRoundingDelta !== 0 ? "الصافي المستحقّ" : "إجمالي الفاتورة"}
          </span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: fluid(24, 3.6, 32), fontWeight: 900, direction: "ltr", letterSpacing: "-1px", color: C.fg }}>{fmt(total)}</span>
            <span style={{ fontSize: 12.5, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      </div>

      {/* منطقة الإدخال — الوحيدة القابلة للتمرير. شبكة الأمان: مهما ضاق الارتفاع
          (زوم/دقّة/تكبير خطّ النظام) تُمرَّر هذه وحدها، ويبقى الإجمالي فوقها وأزرار
          الدفع تحتها ظاهرَين دائماً. بلا هذا كان الفائض يُقصّ بصمت بلا شريط تمرير. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>

      {/* Amount display — ٢٣/٨: صار `<input>` حقيقياً في وضع «المبلغ» فيقبل الكتابة المباشرة
          من لوحة المفاتيح دون الحاجة إلى النمباد. زرّ الطيّ إلى جواره يُخفي النمباد لتظهر
          طرقُ الدفع بلا تمرير. القبولُ الصارم: أرقامٌ ونقطةٌ واحدة، تُطبَّع الفواصلُ العربية
          والأوروبية إلى نقطة. */}
      <div style={{ padding: blockPad, flexShrink: 0 }}>
        <div style={{ background: C.muted, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "3px 8px 3px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, minHeight: fluid(ultra ? 36 : 40, 5.6, 50) }}>
          <span style={{ fontSize: 12.5, color: C.mutedFg, flexShrink: 0 }}>{modeLabel}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, justifyContent: "flex-end" }}>
            {numMode === "PAY" ? (
              <input
                type="text"
                inputMode="decimal"
                value={displayPay}
                onChange={(e) => {
                  // ٢٣/٨ — Codex P1 v2: العقدُ المشترك `normalizeNumberInput` هو الحكم.
                  // العرض يعكس ما يكتبه الكاشير حرفياً (`displayPay`)، والقيمةُ الملتزمة
                  // (`payInput`) لا تُحدَّث إلّا إن كان التطبيع غير ملتبس. الحالات الوسطى
                  // (`1,`، `1.`، `.5`) تظهر في الحقل لكن لا تصل إلى `D()` كي لا تتحطّم.
                  const src = e.target.value;
                  setDisplayPay(src);
                  if (src === "") { setPayInput(""); return; }
                  // حدُّ محارف: أرقام + فواصل شائعة (بادئة سالب للتصحيح). غير ذلك يُترك دون التزام.
                  if (!/^[\d.,،٫\-]*$/.test(src)) return;
                  const result = normalizeNumberInput(src);
                  if (result.ambiguous) return;
                  const n = result.normalized;
                  if (!n) return;
                  if (!/^-?\d+\.?\d*$|^-?\d*\.\d+$/.test(n)) return;
                  if (!Number.isFinite(Number(n))) return;
                  setPayInput(n);
                }}
                onFocus={(e) => e.currentTarget.select()}
                placeholder="0"
                aria-label="المبلغ المستلم من الزبون"
                style={{
                  flex: 1, minWidth: 0, maxWidth: 200,
                  border: "none", outline: "none", background: "transparent",
                  fontSize: fluid(20, 3, 26), fontWeight: 900, direction: "ltr",
                  textAlign: "left", fontFamily: "inherit",
                  color: payInput ? (isOwing ? C.amber : C.primary) : C.fg,
                }}
              />
            ) : (
              <span style={{ fontSize: fluid(20, 3, 26), fontWeight: 900, direction: "ltr", marginRight: 6, color: C.mutedFg }}>—</span>
            )}
            <button
              type="button"
              onClick={() => persistNumpad(!numpadOpen)}
              aria-label={numpadOpen ? "إخفاء لوحة الأرقام" : "إظهار لوحة الأرقام"}
              title={numpadOpen ? "إخفاء لوحة الأرقام لتوسيع طرق الدفع" : "إظهار لوحة الأرقام للكاشير اللمسيّ"}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 8px",
                border: `1.5px solid ${numpadOpen ? C.primary : C.border}`,
                borderRadius: 7,
                background: numpadOpen ? C.primary : C.card,
                color: numpadOpen ? C.primaryFg : C.mutedFg,
                fontFamily: "inherit", fontSize: 11.5, fontWeight: 800, cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <Calculator aria-hidden size={13} />
              {numpadOpen ? <ChevronUp aria-hidden size={13} /> : <ChevronDown aria-hidden size={13} />}
            </button>
          </div>
        </div>
      </div>

      {/* Quick amounts — تُحذف عند ضيق الارتفاع: لوحة الأرقام تُغني عنها، وتركُ
          الفراغ لها يُبقي المفاتيح كبيرة (الأولوية: وضوحٌ وكِبَر لا كثافة). */}
      {numMode === "PAY" && !dense && (
        <div style={{ padding: "3px 11px 2px", display: "flex", gap: 3, flexWrap: "wrap", flexShrink: 0 }}>
          {QUICK_AMTS.map((a) => (
            <button key={a} onClick={() => setPayInput(String(a))}
              style={{ height: fluid(30, 4.7, 40), padding: "0 10px", background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.fg, fontFamily: "inherit" }}>
              {fmt(a)}
            </button>
          ))}
          {cartLen > 0 && (
            <button onClick={() => setPayInput(String(total))}
              style={{ height: fluid(30, 4.7, 40), padding: "0 10px", background: C.card, border: `1.5px solid ${C.primary}`, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.primary, fontFamily: "inherit" }}>
              = الكل
            </button>
          )}
        </div>
      )}

      {/* Odoo 19 Numpad — RTL: mode buttons on right visually.
          ٢٣/٨: صار قابلاً للطيّ. مفتوحاً افتراضياً على الشاشات الطويلة، مطويّاً على القصيرة
          (dense) كي لا تُخفي الأزرارَ التالية تحت التمرير. أزرار الوضع (كمية/%/مبلغ) تبقى
          مرئيّةً في صفٍّ مضغوط حتى وهي مطويّة كي يعرف الكاشير أنّ اللوحة قابلةٌ للاستدعاء
          — وبعضُها (كميّة/خصم) يفتحها تلقائياً لأنّ لا سبيلَ للمس دونها. */}
      {numpadOpen ? (
        <div style={{ padding: blockPad, flexShrink: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", gap: ultra ? 3 : 4, direction: "rtl" }}>
            <button style={modeStyle(numMode === "QTY")}  onClick={() => setNumModeAndReveal("QTY")}>الكمية</button>
            <button style={numKeyStyle()} onClick={() => numPress("3")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>3</button>
            <button style={numKeyStyle()} onClick={() => numPress("2")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>2</button>
            <button style={numKeyStyle()} onClick={() => numPress("1")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>1</button>

            <button style={modeStyle(numMode === "DISC")} onClick={() => setNumModeAndReveal("DISC")}>%</button>
            <button style={numKeyStyle()} onClick={() => numPress("6")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>6</button>
            <button style={numKeyStyle()} onClick={() => numPress("5")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>5</button>
            <button style={numKeyStyle()} onClick={() => numPress("4")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>4</button>

            <button style={modeStyle(numMode === "PAY")}  onClick={() => setNumModeAndReveal("PAY")}>المبلغ</button>
            <button style={numKeyStyle()} onClick={() => numPress("9")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>9</button>
            <button style={numKeyStyle()} onClick={() => numPress("8")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>8</button>
            <button style={numKeyStyle()} onClick={() => numPress("7")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>7</button>

            <button style={numKeyStyle(true)} onClick={() => numPress("⌫")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>⌫</button>
            <button style={numKeyStyle()}     onClick={() => numPress(".")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>.</button>
            <button style={numKeyStyle()}     onClick={() => numPress("0")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>0</button>
            <button style={{ ...numKeyStyle(), fontSize: 13 }} onClick={() => numPress("+/-")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>+/-</button>
          </div>
        </div>
      ) : (
        // شريطُ الأوضاع المضغوط — يظهر مكانَ اللوحة المطويّة كي تبقى الأوضاع قابلةً للتبديل
        // بلا استرداد اللوحة. اختيارُ «الكمية» أو «%» يعيد فتحها تلقائياً (لا مدخل لمس بديل).
        <div style={{ padding: blockPad, flexShrink: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            <button style={{ ...modeStyle(numMode === "QTY"), height: 34, fontSize: 12 }} onClick={() => setNumModeAndReveal("QTY")}>الكمية</button>
            <button style={{ ...modeStyle(numMode === "DISC"), height: 34, fontSize: 12 }} onClick={() => setNumModeAndReveal("DISC")}>خصم %</button>
            <button style={{ ...modeStyle(numMode === "PAY"), height: 34, fontSize: 12 }} onClick={() => setNumModeAndReveal("PAY")}>المبلغ</button>
          </div>
        </div>
      )}

      {/* كوبون CRM — تحقق خادمي ثم إعادة تحقق ذرّية عند البيع.
          عند ضيق الارتفاع يُطوى خلف زرٍّ (نادر الاستعمال ⇒ تشتيتٌ دائم بلا داعٍ)،
          لكنّه يبقى مفتوحاً دائماً وهو مُطبَّق فلا يُخفى خصمٌ سارٍ عن الكاشير. */}
      {showCoupon && (
      <div style={{ padding: "4px 11px 3px", flexShrink: 0 }}>
        <div style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, marginBottom: 4 }}>كوبون خصم</div>
        <div style={{ display: "flex", gap: 5 }}>
          <input
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") onApplyCoupon(); }}
            placeholder="اكتب أو امسح الرمز"
            disabled={!cartLen || couponPending}
            style={{ minWidth: 0, flex: 1, height: fluid(30, 4.7, 40), border: `1.5px solid ${couponCode ? C.success : C.border}`, borderRadius: 8, background: C.muted, color: C.fg, padding: "0 9px", fontFamily: "inherit", fontWeight: 800, direction: "ltr" }}
          />
          {couponCode ? (
            <button onClick={onClearCoupon} style={{ height: fluid(30, 4.7, 40), padding: "0 10px", border: `1px solid ${C.danger}`, borderRadius: 8, background: C.dangerSoft, color: C.danger, fontFamily: "inherit", fontWeight: 800, cursor: "pointer" }}>إزالة</button>
          ) : (
            <button disabled={!cartLen || !couponInput.trim() || couponPending} onClick={onApplyCoupon} style={{ height: fluid(30, 4.7, 40), padding: "0 12px", border: 0, borderRadius: 8, background: C.primary, color: C.primaryFg, fontFamily: "inherit", fontWeight: 800, cursor: "pointer" }}>{couponPending ? "تحقق…" : "تطبيق"}</button>
          )}
        </div>
        {couponCode && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.success, fontWeight: 800, marginTop: 2 }}>
            <Check size={13} aria-hidden="true" />
            <span>{couponLabel ?? couponCode}</span>
          </div>
        )}
      </div>
      )}

      {/* Payment method — ٤ أزرار صريحة متساوية: نقرة واحدة = طريقة واحدة، لا تبديل ضمني.
          كان زر «أخرى» يبدّل بين TRANSFER/WALLET بنقرة ⇒ كاشير يضغطه ظنّاً أنّه «تحويل» وهو «محفظة»
          (أو العكس) فيُحفظ في السجل خطأً. البنية الصريحة تُلغي مصدر الخطأ البشريّ.
          الترتيب واللقب مركزيّان في `lib/paymentMethod.ts` ⇒ مصدر حقيقة واحد مع باقي الشاشات. */}
      <div style={{ padding: blockPad, flexShrink: 0 }}>
        {/* سطر العنوان يستضيف زرّ فتح الكوبون عند طيّه ⇒ يوفّر صفّاً كاملاً (~٤٠px)
            دون فقد الوصول إليه على الشاشات الصغيرة. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, minHeight: 18 }}>
          <span style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700 }}>طريقة الدفع</span>
          {!showCoupon && (
            <button onClick={() => setCouponOpen(true)}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: C.primary }}>
              <ChevronDown aria-hidden size={13} /> كوبون خصم
            </button>
          )}
        </div>
        {/* صفٌّ واحد بأربعة أعمدة عند ضيق الارتفاع: يوفّر صفّاً كاملاً (~٦٦px) بلا
            تصغير الأزرار — الأربعة تبقى ≥46px ارتفاعاً و~١٠٠px عرضاً. */}
        <div style={{ display: "grid", gridTemplateColumns: dense ? "1fr 1fr 1fr 1fr" : "1fr 1fr", gap: 6 }}>
          <button style={payMethodStyle(method === "CASH")}     onClick={() => setMethod("CASH")}>
            <Banknote aria-hidden size={22} />نقدي
          </button>
          <button style={payMethodStyle(method === "CARD")}     onClick={() => setMethod("CARD")}>
            <CreditCard aria-hidden size={22} />بطاقة
          </button>
          <button style={payMethodStyle(method === "TRANSFER")} onClick={() => setMethod("TRANSFER")}>
            <Send aria-hidden size={22} />تحويل
          </button>
          <button style={payMethodStyle(method === "WALLET")}   onClick={() => setMethod("WALLET")}>
            <Wallet aria-hidden size={22} />محفظة
          </button>
        </div>
        {method !== "CASH" && (
          // البوّابة ليست إقفالاً بل إثبات: مرجعٌ + تأكيدٌ خادميّ قبل فتح زرّ الإتمام.
          <div id="pos-external-payment-proof" role="status" style={{ marginTop: 6, display: "flex", alignItems: "flex-start", gap: 5, color: C.mutedFg, fontSize: 11.5, fontWeight: 700, lineHeight: 1.5 }}>
            <AlertTriangle aria-hidden size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{POS_EXTERNAL_PAYMENT_PROOF_HINT}</span>
          </div>
        )}
      </div>

      {/* مرجع ومحاولة الدفع غير النقدي — لا يُفتح الإتمام قبل CONFIRMED خادمية. */}
      <PaymentReferenceField
        value={paymentRef}
        onChange={setPaymentRef}
        method={method}
        confirmed={externalPaymentConfirmed}
        confirming={externalPaymentPending}
        onConfirm={onConfirmExternalPayment}
        inputId="pos-payment-reference"
        colors={{ border: C.border, muted: C.muted, mutedFg: C.mutedFg, fg: C.fg, amber: C.amber, success: C.success }}
        style={{ padding: blockPad, flexShrink: 0 }}
      />

      {/* تاريخ استحقاق الآجل (اختياري) — يظهر مع دفعة جزئية فقط، يُحفظ invoices.dueDate */}
      {isOwing && (
        <div style={{ padding: blockPad, flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="pos-due-date" style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, whiteSpace: "nowrap" }}>
            تاريخ استحقاق الآجل (اختياري)
          </label>
          <input
            id="pos-due-date"
            type="date"
            dir="ltr"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            style={{ flex: 1, minWidth: 0, height: 36, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 13, fontWeight: 700, padding: "0 9px", outline: "none", boxSizing: "border-box" }}
          />
        </div>
      )}

      </div>{/* ← نهاية منطقة الإدخال القابلة للتمرير */}

      {/* منطقة الفعل — خارج التمرير ولا تنكمش أبداً: الباقي/المتبقي + زرّا الدفع.
          هذه هي الضمانة الصلبة بأنّ زرّ الدفع لا يختفي مهما بلغ الزوم. */}
      <div style={{ flexShrink: 0, background: C.card }}>

      {/* Change / owing indicator */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: "4px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: ultra ? 28 : 36, flexShrink: 0 }}>
        {!cartLen && <span style={{ fontSize: 13, color: C.mutedFg }}>أضف منتجات للبدء</span>}
        {cartLen > 0 && !payInput && <span style={{ fontSize: 12.5, color: C.mutedFg }}>أدخل المبلغ أو «إتمام» للدفع الكامل</span>}
        {cartLen > 0 && !!payInput && isChange && (
          <>
            <span style={{ fontSize: 13.5, color: C.mutedFg, fontWeight: 600 }}>الباقي للعميل</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12.5, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span>
              <CopyButton value={change} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
            </span>
          </>
        )}
        {cartLen > 0 && !!payInput && isOwing && (
          <>
            <span style={{ fontSize: 13.5, color: C.amber, fontWeight: 600 }}>المتبقي للدفع</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12.5, fontWeight: 500 }}>د.ع</span></span>
              <CopyButton value={credit} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" />
            </span>
          </>
        )}
      </div>

      {/* أزرار الفعل. «دفع سريع» يُخفى عند اختيار عميل أو دفعة جزئية (نيّة غير «نقدي كامل»)
          ⇒ يبقى CTA أساسي واحد فيمتنع الضغط الخاطئ الذي كان يُسجّل عميل الآجل «مدفوعاً
          نقداً بالكامل». الزرّ الأخضر يؤدّي الدفع الكامل أصلاً.
          عند ضيق الارتفاع يصطفّ الزرّان في **صفٍّ واحد** (نمط شاشة الطباعة نفسه) فيوفّران
          صفّاً كاملاً (~٥٨px) دون فقد ميزة «الدفع السريع» على الشاشات الصغيرة التي تحتاجها
          أكثر — والارتفاع يبقى ≥50px لكليهما. */}
      <div style={{ padding: dense ? "4px 11px 9px" : "4px 11px 10px", flexShrink: 0, display: "flex", flexDirection: dense ? "row" : "column", gap: dense ? 7 : 0 }}>

        {showQuickPay && (
          <button
            disabled={!canPay || isPending}
            onClick={() => onQuickPay()}
            title={
              // ٢٣/٨ (بلاغ Codex P2): كان يذكر «مرجع البطاقة» على دفعةٍ نقديّةٍ جزئيّةٍ بلا عميل —
              // لا حقلَ كذلك أصلاً. صار يميّز الحالات الثلاثة.
              isPending ? ACTION_LABELS.saving :
              !cartLen ? "أضف منتجاً أوّلاً" :
              isOwing && !hasCustomer ? "الدفعة الجزئيّة (الآجل) تحتاج عميلاً مرتبطاً — أو حصّل المبلغ كاملاً" :
              method !== "CASH" && !externalPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
              !canPay ? "أكمل بيانات الدفع" :
              `دفع سريع وطباعة — ${paymentMethodLabel(method)}`
            }
            style={{
              ...(dense ? { width: 128, flexShrink: 0 } : { width: "100%", marginBottom: 7 }),
              height: fluid(50, 6.6, 58),
              background: canPay && !isPending ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))" : C.muted,
              color: canPay && !isPending ? "#fff" : C.mutedFg,
              border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: dense ? 13.5 : 15, fontWeight: 900,
              cursor: canPay && !isPending ? "pointer" : "not-allowed",
              display: "flex", alignItems: "center", justifyContent: "center", gap: dense ? 5 : 7,
              boxShadow: canPay && !isPending ? "0 4px 14px oklch(0.60 0.18 50 / .38)" : "none",
              transition: "background .1s, color .1s, box-shadow .1s",
            }}>
            <Zap aria-hidden size={18} />{dense ? "دفع سريع" : `دفع سريع وطباعة — ${paymentMethodLabel(method)}`}
          </button>
        )}

        <button
          disabled={!canPay || isPending}
          onClick={() => onPay()}
          title={
            isPending ? ACTION_LABELS.saving :
            !cartLen ? "أضف منتجاً أوّلاً" :
            isOwing && !hasCustomer ? "الدفعة الجزئيّة (الآجل) تحتاج عميلاً مرتبطاً — أو حصّل المبلغ كاملاً" :
            method !== "CASH" && !externalPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
            !canPay ? "أكمل بيانات الدفع" :
            `إتمام الدفع — ${fmt(total)} د.ع`
          }
          style={{
            ...(dense && showQuickPay ? { flex: 1, minWidth: 0 } : { width: "100%" }),
            height: fluid(50, 6.6, 58),
            background: canPay && !isPending ? C.success : C.muted,
            color: canPay && !isPending ? "#fff" : C.mutedFg,
            border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 15, fontWeight: 900,
            cursor: canPay && !isPending ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            boxShadow: canPay && !isPending ? `0 3px 12px color-mix(in oklch, ${C.success} 30%, transparent)` : "none",
            transition: "background .1s, color .1s, box-shadow .1s",
          }}>
          {isPending
            ? "جارٍ…"
            : !cartLen
              ? "السلة فارغة"
              : <><Check aria-hidden size={18} strokeWidth={3} /> إتمام الدفع — {fmt(total)} د.ع</>}
        </button>
      </div>

      {/* ٢٣/٨ (بلاغ فحص UX): تلميحُ الاختصارات كان يُخفى على الشاشات القصيرة (dense) — وهي تحديداً
          شاشات الكاشير اللوحيّة ١٣٦٦×٧٦٨ حيث يعطي الاختصار أعظم قيمة (لا ماوس، لوحة مفاتيح فقط).
          نُبقيه ظاهراً مع خطٍّ أصغر على dense كي لا يزاحم أزرار الدفع. */}
      <div style={{ textAlign: "center", padding: dense ? "0 11px 4px" : "0 11px 8px", fontSize: dense ? 9.5 : 10.5, color: C.mutedFg, flexShrink: 0 }}>F4 للدفع · F2 للبحث · F9 طباعة · F12 تفريغ</div>

      </div>{/* ← نهاية منطقة الفعل */}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ReceiptOverlay ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface ReceiptOverlayProps {
  C: C;
  receipt: Receipt;
  onDismiss: () => void;
  onPrint: () => void;
}

// فخّ تركيز موحّد للنوافذ اليدوية (position:fixed): يُركّز أوّل عنصر عند الفتح، يحبس Tab داخلها،
// ويعيد التركيز للعنصر السابق عند الإغلاق (WCAG 2.4.3 focus-trap). النوافذ تُركَّب فقط وهي مفتوحة.
function useModalFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const list = () => Array.from(node.querySelectorAll<HTMLElement>(SEL)).filter((el) => el.offsetParent !== null);
    list()[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const items = list();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    node.addEventListener("keydown", onKey);
    return () => { node.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return ref;
}

function ReceiptOverlay({ C, receipt, onDismiss, onPrint }: ReceiptOverlayProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  return (
    <div onClick={onDismiss}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: C.overlay, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s ease", cursor: "pointer" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="تم الدفع بنجاح"
        style={{ background: C.card, borderRadius: 20, padding: "36px 44px 30px", width: 480, maxWidth: "92vw", boxShadow: "0 28px 72px rgb(0 0 0/.42)", animation: "popIn .22s ease", cursor: "default", textAlign: "center", direction: "rtl" }}>

        <div style={{ width: 76, height: 76, borderRadius: "50%", background: C.success, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", animation: "pulse 1.2s ease-out", color: "#fff" }}>
          <Check aria-hidden size={42} strokeWidth={3} />
        </div>

        <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 4, color: C.fg }}>تم الدفع بنجاح</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 24, display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
          <span>فاتورة: {receipt.invoiceNumber}</span>
          <CopyButton value={receipt.invoiceNumber} title="نسخ رقم الفاتورة" successMessage="تم نسخ رقم الفاتورة" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[
            { label: "المبلغ المدفوع", raw: receipt.received, value: fmt(receipt.received), color: C.primary },
            { label: "إجمالي الفاتورة", raw: receipt.total,    value: fmt(receipt.total),    color: C.fg },
          ].map((item) => (
            <div key={item.label} style={{ background: C.muted, borderRadius: 10, padding: "14px 10px", textAlign: "center", position: "relative" }}>
              <div style={{ position: "absolute", top: 4, left: 4 }}>
                <CopyButton value={item.raw} title={`نسخ ${item.label}`} successMessage={`تم نسخ ${item.label}`} />
              </div>
              <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 26, fontWeight: 900, direction: "ltr", color: item.color }}>{item.value}</div>
              <div style={{ fontSize: 11, color: C.mutedFg }}>د.ع</div>
            </div>
          ))}
        </div>

        {receipt.change > 0 && (
          <div style={{ background: `color-mix(in oklch, ${C.success} 10%, transparent)`, border: `1.5px solid color-mix(in oklch, ${C.success} 28%, transparent)`, borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.success }}>الباقي للعميل</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(receipt.change)} <span style={{ fontSize: 12 }}>د.ع</span></span>
              <CopyButton value={receipt.change} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
            </span>
          </div>
        )}

        {receipt.isCredit && receipt.credit > 0 && (
          <div style={{ background: `color-mix(in oklch, ${C.amber} 10%, transparent)`, border: `1.5px solid color-mix(in oklch, ${C.amber} 30%, transparent)`, borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.amber }}>آجل على {receipt.customerName ?? "العميل"}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(receipt.credit)} <span style={{ fontSize: 12 }}>د.ع</span></span>
              <CopyButton value={receipt.credit} title="نسخ المتبقي الآجل" successMessage="تم نسخ المتبقي" />
            </span>
          </div>
        )}

        <div style={{ marginBottom: 20, fontSize: 13.5, color: C.mutedFg, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexWrap: "wrap" }}>
          <span>طريقة الدفع:</span>
          <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${paymentMethodClass(receipt.methodCode)}`}>
            {receipt.method}
          </span>
          <span>·</span><span>{receipt.lines.length} منتج</span>
          {receipt.customerName && <><span>·</span><strong style={{ color: C.fg }}>{receipt.customerName}</strong></>}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onPrint}
            style={{ flex: 1, height: 50, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Printer size={18} aria-hidden /> طباعة الإيصال
          </button>
          <button onClick={onDismiss}
            style={{ flex: 1, height: 50, background: C.primary, border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.primaryFg }}>
            فاتورة جديدة
          </button>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, color: C.mutedFg }}>المس الشاشة في أي مكان للمتابعة</div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        @keyframes popIn  { from { opacity:0; transform:scale(.88); } to { opacity:1; transform:scale(1); } }
        @keyframes pulse  { 0%,100%{ box-shadow:0 0 0 0 color-mix(in oklch, ${C.success} 40%, transparent); } 60%{ box-shadow:0 0 0 14px color-mix(in oklch, ${C.success} 0%, transparent); } }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ShiftCloseDialog ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface ShiftCloseDialogProps {
  C: C;
  shift: ShiftData;
  branchId: number;
  onClose: () => void;
  onClosed: () => void;
  me: RouterOutputs["auth"]["me"] | undefined;
  branches: RouterOutputs["branches"]["list"] | undefined;
}

function ShiftCloseDialog({ C, shift, branchId, onClose, onClosed, me, branches }: ShiftCloseDialogProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  const [counted, setCounted] = useState("");
  const [countEntered, setCountEntered] = useState(false);
  const utils = trpc.useUtils();

  // ش٤ أوفلاين — حارس الطابور: إغلاق الوردية وثمة مبيعات غير مُزامنة يترك نقداً في الدرج بلا
  // فواتير في Z ⇒ محجوب افتراضياً؛ المدير/الأدمن يتجاوز بإقرار صريح (تُرحَّل لاحقاً وتدخل
  // الوردية موسومةً «مُزامنة لاحقاً» في التقرير).
  const [outboxQueued, setOutboxQueued] = useState({ count: 0, total: 0 });
  useEffect(() => {
    let alive = true;
    const load = () => {
      void readOutboxSummary().then((s) => {
        if (alive) setOutboxQueued({ count: s.queued, total: s.queuedTotal });
      });
    };
    load();
    const off = subscribeOutbox(load);
    return () => { alive = false; off(); };
  }, []);
  const closeBlocked = outboxQueued.count > 0;

  const reportQ = trpc.shifts.report.useQuery(
    { shiftId: shift!.id },
    { enabled: !!shift }
  );
  const report = reportQ.data;

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = report;
      void printShiftClose({
        shiftId:        r.shiftId,
        openedAt:       shift?.openedAt ?? null,
        closedAt:       new Date(),
        cashierName:    me?.name ?? "كاشير",
        branchName:     (branches ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
        openingBalance: r.openingBalance,
        invoiceCount:   rep?.invoiceCount ?? 0,
        salesTotal:     rep?.salesTotal ?? "0",
        payments:       (rep?.payments ?? []).map((p) => ({
          method:    p.method,
          direction: p.direction as "IN" | "OUT",
          count:     Number(p.count),
          total:     p.total,
        })),
        expectedCash: r.expectedCash,
        countedCash:  r.countedCash,
        variance:     r.variance,
        treasuryReturn: r.treasuryReturn
          ? {
              amount: r.countedCash,
              referenceNumber: r.treasuryReturn.handoverNumber,
            }
          : null,
      });
      if (r.treasuryReturn) {
        notify.ok(
          `أُغلقت الوردية ورُحّل ${formatIqd(r.countedCash)} إلى الخزينة تلقائياً`,
          `سند الترحيل ${r.treasuryReturn.handoverNumber}`,
        );
      }
      await utils.shifts.current.invalidate();
      onClosed();
    },
    onError: (e) => notify.errBig(e),
  });

  // النقد المتوقع يأتي من نفس مصدر حقيقة closeShift على الخادم (DRAWER حصراً).
  const openingD    = D(shift?.openingBalance ?? 0);
  // ش٤: النقد غير المُزامَن موجود فيزيائياً بالدرج ⇒ يدخل المتوقع المعروض للعدّ (الخادم عند
  // الإغلاق يحسب المُزامَن فقط، والفرق يُفسَّر لاحقاً بقسم «مُزامنة لاحقاً» في التقرير).
  const expectedD   = report != null ? D(report.expectedCash).plus(D(outboxQueued.total)) : null;
  const countedD    = counted ? D(counted) : null;
  // فقدان التركيز من حقل المعدود يُثبّت انتهاء الإدخال ويكشف المطابقة تلقائياً بلا زر إضافي.
  const isElevatedRole = me?.role === "admin" || me?.role === "manager";
  const showExpected = isElevatedRole || countEntered;
  const diffD       = showExpected && expectedD != null && countedD != null ? countedD.minus(expectedD) : null;
  const hasVariance = diffD != null && diffD.abs().gt("0.005");
  const closeDisabled = !counted || closeShift.isPending || closeBlocked || hasVariance;
  const closeLabel = closeShift.isPending
    ? ACTION_LABELS.closing
    : closeBlocked
      ? "أكمل المزامنة أولاً"
      : hasVariance
        ? "الإغلاق مرفوض لوجود فرق"
        : "إغلاق وطباعة Z";
  // متغيّرات عددية للعرض ولتفادي تغييرات JSX الأكبر
  const openingBal  = openingD.toNumber();
  const diff        = diffD?.toNumber() ?? null;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgb(0 0 0/.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="إغلاق الوردية"
        style={{ background: C.card, borderRadius: 18, padding: "26px 30px", width: 440, boxShadow: "0 24px 64px rgb(0 0 0/.32)", animation: "popIn .2s ease", maxHeight: "90vh", overflowY: "auto" }}>

        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 4, color: C.fg }}>إغلاق الوردية #{shift?.id}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 18 }}>
          {fmtDate(new Date())}
        </div>

        {reportQ.isLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل التقرير…</div>
        ) : (
          <>
            {([
              ["عدد الفواتير",     `${report?.invoiceCount ?? 0} فاتورة`],
              ["إجمالي المبيعات",  `${fmt(Number(report?.salesTotal ?? 0))} د.ع`],
              ["الرصيد الافتتاحي", `${fmt(openingBal)} د.ع`],
              ...(outboxQueued.count > 0
                ? [["مبيعات غير مُزامنة (نقدها بالدرج)", `${outboxQueued.count} فاتورة · ${fmt(outboxQueued.total)} د.ع`] as [string, string]]
                : []),
              ...(report != null && showExpected
                ? [["النقد المتوقع بالصندوق", `${fmt(expectedD?.toNumber() ?? 0)} د.ع`] as [string, string]]
                : []),
            ] as [string, string][]).map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.mutedFg }}>{l}</span>
                <span style={{ fontWeight: 700, color: C.fg }}>{v}</span>
              </div>
            ))}

            {/* Payment breakdown — كل طريقة بلقب عربيّ + شارة ملوّنة، ليَفهَم الكاشير أنّ مبيعات
                البطاقة/التحويل/المحفظة لا تدخل نقد الدرج المتوقّع (الخادم يحسبه CASH+DRAWER فقط).
                هذا يزيل حَيرة «لماذا الفرق؟» — الفرق ليس عجزاً، البطاقة لا تُقاس بعدّ النقد. */}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).length > 0 && (
              <div style={{ margin: "10px 0 4px", fontSize: 12, color: C.mutedFg, fontWeight: 700 }}>تفصيل طرق الدفع:</div>
            )}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).map((p) => (
              <div key={`${p.method}-${p.direction}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "5px 0", borderBottom: `1px dashed ${C.border}` }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${paymentMethodClass(p.method)}`}>
                    {paymentMethodLabel(p.method)}
                  </span>
                  <span style={{ color: C.mutedFg }}>{p.direction === "IN" ? "وارد" : "صادر"} ({p.count})</span>
                </span>
                <span style={{ fontWeight: 700, color: p.direction === "OUT" ? C.danger : C.fg, direction: "ltr" }}>{fmt(Number(p.total))} د.ع</span>
              </div>
            ))}
            {/* تلميح تعليميّ للكاشير: يظهر فقط عند وجود مبيعات غير نقدية — يزيل حَيرة «العجز الوهميّ». */}
            {(report?.payments ?? []).some((p) => p.direction === "IN" && p.method !== "CASH" && Number(p.total) > 0) && (
              <div style={{ marginTop: 8, padding: "8px 10px", background: "color-mix(in oklch, var(--sem-info) 8%, transparent)", border: "1px solid color-mix(in oklch, var(--sem-info) 25%, transparent)", borderRadius: 7, fontSize: 11.5, color: C.mutedFg, lineHeight: 1.55 }}>
                <strong style={{ color: C.fg }}>ملاحظة:</strong> مبيعات البطاقة/التحويل/المحفظة لا تدخل عدّ نقد الدرج. عدّ النقد الفعليّ فقط — النظام يعلم بها ولن يُظهر عجزاً بسببها.
              </div>
            )}

            <div
              style={{ marginTop: 16 }}
              onBlur={() => setCountEntered(counted.trim() !== "")}
            >
              <label htmlFor="pos-counted-cash" style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 800, color: C.fg }}>
                النقد المعدود (د.ع)
              </label>
              <MoneyInput
                id="pos-counted-cash"
                value={counted}
                onChange={(value) => {
                  setCounted(value);
                  setCountEntered(false);
                }}
                placeholder="0"
                ariaLabel="النقد المعدود عند إغلاق الوردية"
                className="h-12 text-center text-lg font-extrabold"
              />
              {!showExpected && (
                <div style={{ marginTop: 6, fontSize: 12, color: C.mutedFg }}>
                  أدخل ما عددته فعلياً في الصندوق لتظهر نتيجة المطابقة.
                </div>
              )}
              {diff !== null && (
                <div style={{ marginTop: 7, fontSize: 14, fontWeight: 700, color: diff >= 0 ? C.success : C.danger, display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span>الفرق: {diff >= 0 ? "+" : ""}{fmt(diff)} د.ع</span>
                  {diff === 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Check aria-hidden size={14} strokeWidth={3} /> مطابق تماماً</span>}
                  {diff > 0  && <span>(زيادة)</span>}
                  {diff < 0  && <span>(عجز)</span>}
                </div>
              )}
            </div>

            {hasVariance && (
              <div style={{ marginTop: 14, padding: 12, border: `1.5px solid ${C.danger}`, borderRadius: 9, background: C.dangerSoft }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.danger }}>
                  لا يمكن إغلاق الوردية: النقد المعدود لا يساوي الرصيد الافتتاحي مضافاً إليه صافي المبيعات النقدية المسجّلة.
                </div>
                <div style={{ marginTop: 6, fontSize: 12.5, color: C.mutedFg }}>
                  أعد العد، ثم راجع الفواتير والمرتجعات والمزامنة. إذا بقي الفرق فاستدعِ المدير لتصحيح العملية من وحدتها المختصة؛ لا يمكن اعتماد مال بلا مصدر من شاشة الإغلاق.
                </div>
              </div>
            )}

            {/* ش٤ أوفلاين: لا مصدر مالي قبل ترحيل الفاتورة، لذلك لا يوجد تجاوز للإغلاق. */}
            {outboxQueued.count > 0 && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: C.amberSoft, border: `1.5px solid ${C.amber}`, borderRadius: 9, fontSize: 12.5, color: C.fg }}>
                <div style={{ fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle aria-hidden size={15} /> توجد {outboxQueued.count} فاتورة غير مُزامنة ({fmt(outboxQueued.total)} د.ع)
                </div>
                <div style={{ marginTop: 4, color: C.mutedFg }}>
                  أكمل المزامنة قبل الإغلاق (شارة المزامنة أسفل الشاشة) — نقدها في الدرج ولن تظهر في Z قبل الترحيل.
                </div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>
                  لا يمكن الإغلاق قبل مزامنة الفواتير، حتى بصلاحية المدير.
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={onClose}
                style={{ flex: 1, height: 46, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.fg }}>
                إلغاء
              </button>
              <button
                disabled={closeDisabled}
                onClick={() => shift && closeShift.mutate({
                  shiftId: shift.id,
                  countedCash: counted,
                })}
                style={{ flex: 1, height: 46, background: closeDisabled ? C.muted : C.danger, color: closeDisabled ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: closeDisabled ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>
                {closeLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CreditApprovalDialog ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface CreditApprovalDialogProps {
  C: C;
  message: string;
  mgrEmail: string; setMgrEmail: (s: string) => void;
  mgrPwd: string;   setMgrPwd:   (s: string) => void;
  isPending: boolean;
  onApprove: () => void;
  onCancel: () => void;
}

function CreditApprovalDialog({ C, message, mgrEmail, setMgrEmail, mgrPwd, setMgrPwd, isPending, onApprove, onCancel }: CreditApprovalDialogProps) {
  const modalRef = useModalFocus<HTMLDivElement>();
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgb(0 0 0/.45)", display: "flex", alignItems: "center", justifyContent: "center", direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="موافقة مدير مطلوبة"
        style={{ background: C.card, borderRadius: 16, padding: "24px 28px", width: 380, boxShadow: "0 20px 56px rgb(0 0 0/.3)", animation: "popIn .2s ease" }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4, color: C.amber, display: "inline-flex", alignItems: "center", gap: 6 }}><AlertTriangle aria-hidden size={18} /> موافقة مدير مطلوبة</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 18 }}>{message}</div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>بريد المدير</label>
          <input
            type="email" dir="ltr" value={mgrEmail} placeholder="manager@alroya.local"
            onChange={(e) => setMgrEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPwd) onApprove(); }}
            style={{ width: "100%", height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 14, padding: "0 12px", outline: "none", boxSizing: "border-box" }}
          />
        </div>
        {/* PasswordInput الموحّد (عين إظهار/إخفاء — نفس مكوّن شاشة الدخول) بدل input نصيّ عارٍ.
            Enter يعتمد ويُكمل — يُلتقط على الحاوية لأن المكوّن لا يكشف onKeyDown. */}
        <div style={{ marginBottom: 12 }} onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPwd) onApprove(); }}>
          <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>كلمة المرور</label>
          <PasswordInput value={mgrPwd} onChange={setMgrPwd} autoComplete="current-password" />
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            disabled={!mgrEmail || !mgrPwd || isPending}
            onClick={onApprove}
            style={{ flex: 1, height: 46, background: !mgrEmail || !mgrPwd || isPending ? C.muted : C.primary, color: !mgrEmail || !mgrPwd || isPending ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: !mgrEmail || !mgrPwd || isPending ? "not-allowed" : "pointer" }}>
            {isPending ? "جارٍ…" : "اعتمد وأكمل البيع"}
          </button>
          <button onClick={onCancel}
            style={{ height: 46, padding: "0 18px", background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", color: C.fg }}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
