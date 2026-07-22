/**
 * نقطة البيع — الرؤية العربية
 * تصميم Odoo 19-style مع multi-tab، حاسبة ذكية، مسح باركود آني، وإدارة وردية كاملة.
 */
import CustomerPicker from "@/components/CustomerPicker";
import { ShiftHandoverSection, buildHandoverPayload, handoverIncomplete, emptyHandover, type ShiftHandoverValue } from "@/components/pos/ShiftHandoverSection";
import { CashDropDialog } from "@/components/pos/CashDropDialog";
import { clearCartDraft } from "@/lib/cartDraft";
import { newClientRequestId } from "@/lib/countQueue";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { D, roundCashIQD, round2 } from "@/lib/money";
import { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter, printReceipt, printShiftOpen, printShiftClose, getServerBridgeStatus, serverPrintTest, type ReceiptBrowserData } from "@/lib/printing/print";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMediaQuery } from "@/hooks/useMobile";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { offlineFindByBarcode, offlineSearchCatalog, useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import { allocateOfflineReceiptNumber, assertCanCapture, enqueueOfflineSale, isOfflineSaleEnabled, readOutboxSummary, subscribeOutbox } from "@/lib/offline/outbox";
import { getOfflineProfile, saveOfflineProfile } from "@/lib/offline/pinLock";
import { getMeta, setMeta } from "@/lib/offline/db";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { parseScan } from "@/lib/scanRouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useOpeningContinuity, OpeningContinuityInline } from "@/components/treasury/useOpeningContinuity";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Printer, ShoppingCart, User, Power, Globe, Check, Store, Search, X, AlertTriangle, Banknote, CreditCard, RefreshCw, Zap, ChevronDown } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type NumMode = "QTY" | "DISC" | "PAY";
type PosRow = RouterOutputs["catalog"]["posList"][number];

type CartItem = {
  row: PosRow;
  /** لقطة السعر/العرض التلقائي قبل تطبيق كوبون، لاستعادتها عند تغيّر السلة أو إزالة الكوبون. */
  preCouponRow?: PosRow;
  qty: number;
  disc?: number;      // خصم % (0–100)
  origPrice?: number; // السعر الأصلي قبل الخصم
};

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
  lines: { name: string; unit: string; qty: number; price: number; disc?: number; total: number }[];
  total: number;
  received: number;
  change: number;
  credit: number;
  method: string;
  isCredit: boolean;
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
const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
};
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
});

// ─── useSmartScanInput ────────────────────────────────────────────────────────

function useSmartScanInput(onBarcode: (code: string) => Promise<void>) {
  const prevMsRef  = useRef(0);
  const bufRef     = useRef("");
  const inScanRef  = useRef(false);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fire = useCallback(
    (setValue: (s: string) => void) => {
      clearTimeout(timerRef.current);
      const code = bufRef.current;
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
  return {
    receiptNumber: r.invoiceNumber,
    date: r.printDate ?? r.date,
    time: r.printTime ?? null,
    cashierName: r.cashierName ?? null,
    customerName: r.customerName ?? null,
    items: r.lines.map((l) => ({
      name: `${l.name} (${l.unit})${l.disc ? ` −${l.disc}%` : ""}`,
      quantity: l.qty,
      price: l.price,
      total: l.total,
    })),
    subtotal: r.total,
    total: r.total,
    paid: r.received,
    // «الباقي» يُطبع فقط حين يكون موجباً (فكّة فعلية) — كحارس الشاشة. الدفع المطابق/السريع
    // (بلا إدخال مبلغ) باقيه ٠ ⇒ لا سطر، بدل طباعة «الباقي: ‑الإجمالي» (باقٍ سالب لا معنى له).
    change: r.isCredit || r.change <= 0 ? null : r.change,
    credit: r.isCredit ? r.credit : null,
    paymentMethod: r.method,
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
  const [offlineBoot, setOfflineBoot] = useState<{ branchId: number | null; shiftId: number | null; name: string | null } | null>(null);
  useEffect(() => {
    if (me.data) { setOfflineBoot(null); return; }
    void (async () => {
      const profile = await getOfflineProfile();
      let cachedShiftId: number | null = null;
      try {
        const raw = await getMeta("lastOpenShift");
        if (raw) cachedShiftId = Number((JSON.parse(raw) as { id?: number }).id) || null;
      } catch { /* كاش تالف ⇒ بلا وردية بديلة */ }
      setOfflineBoot({ branchId: profile?.branchId ?? null, shiftId: cachedShiftId, name: profile?.name ?? null });
    })();
  }, [me.data]);

  // الأدمن/المدير **بلا فرع مُسنَد** (نظريّ عادةً — الأدمن المبذور مُسنَد لفرع MAIN): بدل إسناد
  // مبيعاته صامتاً للفرع ١، نطلب اختيار الفرع صراحةً قبل فتح الوردية (الوردية تحمل الفرع، والبيع
  // يتبعها). لا يمسّ كاشيراً/مستخدماً له فرع (الشرط أدناه يسقط فوراً فيبقى branchId = فرعه).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = me.data?.branchId ?? offlineBoot?.branchId ?? pickedBranch ?? 1;
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

  // كاشير التجزئة: وردية RETAIL خاصّة (منفصلة عن درج خدمة الزبائن RECEPTION).
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RETAIL" });
  // ش٥: وردية بديلة للإقلاع الأوفلايني — آخر وردية مفتوحة معلومة على هذا الجهاز. تُفعِّل مسارات
  // الالتقاط فقط (الإغلاق/التقرير أونلاينيان، والخادم يتحقق من الوردية فعلياً عند الترحيل).
  const shift = shiftQ.data
    ?? (offline && offlineBoot?.shiftId
      ? ({ id: offlineBoot.shiftId } as NonNullable<typeof shiftQ.data>)
      : undefined);

  // ش٥: كاش آخر وردية مفتوحة (يتجدد أونلاين؛ يُمسح عند غيابها كي لا يُلتقط على وردية بائدة).
  useEffect(() => {
    if (shiftQ.data?.id) void setMeta("lastOpenShift", JSON.stringify({ id: shiftQ.data.id, branchId }));
    else if (shiftQ.isSuccess && !shiftQ.data) void setMeta("lastOpenShift", "");
  }, [shiftQ.data?.id, shiftQ.isSuccess, branchId]);

  // ── Multi-tab State ──────────────────────────────────────────────────────
  const [tabs,     setTabs]     = useState<POSTab[]>([createTab(1, "طلب 1")]);
  const [activeId, setActiveId] = useState(1);

  // مرجع حيّ للتبويب النشط: تستهدفه كل تعديلات السلّة/الطلب بدل activeId المُغلَق عليه، كي
  // تصيب التبويب الصحيح حتى حين تُستدعى من إغلاق قديم (مسح الباركود/HID). مُحدَّث في كل رسم.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cart      = activeTab.cart;

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
  const [draftRestored,  setDraftRestored]  = useState(false);

  // تحت 1024px (اللوحي/الأصغر) تُكدَّس لوحتا الكاشير عمودياً بدل الصفّ الأفقي ذي العرض الثابت.
  const stacked = useMediaQuery("(max-width: 1023px)");

  const searchRef = useRef<HTMLInputElement>(null);

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
  const setSelId   = (v: number | null) => patchActive({ selId: v });
  const setNumMode = (v: NumMode)        => patchActive({ numMode: v });
  const setMethod  = (v: PaymentMethod)  => patchActive({ method: v });
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

  // ── Cart draft (multi-tab: saved directly to localStorage) ───────────────
  const DRAFT_KEY = `alroya.posTabs.b${branchId}`;
  useEffect(() => {
    if (draftRestored) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as { tabs: POSTab[]; activeId: number };
        if (Array.isArray(d.tabs) && d.tabs.length) {
          // مسوّدة قديمة قد تفتقر clientRequestId ⇒ نملؤه كي يبقى مفتاح idempotency لكل تبويب صالحاً.
          setTabs(d.tabs.map((t) => ({ ...t, clientRequestId: t.clientRequestId ?? newClientRequestId() })));
          setActiveId(d.activeId);
        }
      }
    } catch { /* ignore */ }
    setDraftRestored(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, draftRestored]);

  useEffect(() => {
    if (!draftRestored) return;
    try {
      const hasCarts = tabs.some((t) => t.cart.length > 0);
      if (hasCarts) localStorage.setItem(DRAFT_KEY, JSON.stringify({ tabs, activeId }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, branchId, draftRestored]);

  // ── Derived ───────────────────────────────────────────────────────────────
  // S5 (٢٩/٦): العميل المختار = قراءة فورية من القائمة المحمَّلة (الشائع ≤٥٠٠ ⇒ بلا وميض تسعير)،
  // مع fallback إلى customers.get للعميل خارج أوّل ٥٠٠ (يُختار عبر باركود/بحث/مسودّة). يصلح علّة صحّة
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
  const totalD  = cart.reduce((s, c) => s.plus(D(itemTotal(c))), D(0));
  const paidD   = D(activeTab.payInput || 0);
  const changeD = paidD.minus(totalD);
  const creditD = totalD.minus(paidD);
  const total   = round2(totalD).toNumber();
  const paid    = round2(paidD).toNumber();
  const change  = round2(changeD).toNumber();
  const credit  = round2(creditD).toNumber();
  const isCredit = paidD.gt(0) && paidD.lt(totalD);
  const isChange = paidD.gt(0) && paidD.gte(totalD);

  // §٩ IQD denomination rounding: مبلغ نقدي يُرسل إلى الخادم بعد التقريب لأقرب ٢٥٠ د.ع.
  // الكاشير يرى المبلغ الفعلي الذي سيُسجَّل (شارة أسفل لوحة المفاتيح).
  // غير النقدي (CARD/TRANSFER/CHECK/WALLET) لا يُقرَّب — التحويلات قد تكون كسرية.
  const cashRoundedPaidD = activeTab.method === "CASH" ? roundCashIQD(paidD.toFixed(2)) : paidD;
  const cashRoundedTotalD = activeTab.method === "CASH" ? roundCashIQD(totalD.toFixed(2)) : totalD;
  const cashRoundedPaid = cashRoundedPaidD.toNumber();
  const cashRoundedTotal = cashRoundedTotalD.toNumber();
  const cashRoundingDelta = activeTab.method === "CASH" ? cashRoundedTotalD.minus(totalD).toNumber() : 0;

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
      staleTime: 15_000,
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
    void offlineSearchCatalog(debouncedSearch, effectiveTier, { limit: 20 }).then((rows) => {
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
    if (row.price == null) {
      notify.err(`لا سعر لـ ${row.productName} (${row.unitName}) في فئة ${TIER_LABEL[effectiveTier]}`);
      return;
    }
    if (receipt) setReceipt(null);
    if (activeTab.couponCode) patchActive({ couponCode: null, couponLabel: null });
    setCart((raw) => {
      const prev = resetCouponItems(raw);
      const i = prev.findIndex((c) => c.row.productUnitId === row.productUnitId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return next;
      }
      return [...prev, { row, qty: 1 }];
    });
    setSelId(row.productUnitId);
    setSearch(""); setShowDrop(false);
    searchRef.current?.focus();
  }

  function changeQty(id: number, qty: number) {
    if (activeTab.couponCode) clearAppliedCoupon();
    if (qty <= 0) {
      setCart((prev) => prev.filter((c) => c.row.productUnitId !== id));
      if (activeTab.selId === id) setSelId(null);
    } else {
      setCart((prev) => prev.map((c) => c.row.productUnitId === id ? { ...c, qty } : c));
    }
  }

  function removeRow(id: number) {
    if (activeTab.couponCode) clearAppliedCoupon();
    setCart((prev) => prev.filter((c) => c.row.productUnitId !== id));
    if (activeTab.selId === id) setSelId(null);
  }

  // ── Barcode ───────────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(async (code: string) => {
    if (!code) return;
    try {
      // ش٢ أوفلاين: أثناء الانقطاع تُخدَم المطابقة من النموذج المحلي (الأساسي + البدائل).
      const row = offline
        ? await offlineFindByBarcode(code, effectiveTier)
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
          if (c.row.productUnitId !== selId) return c;
          let s = String(c.qty);
          if (k === "⌫") s = s.length > 1 ? s.slice(0, -1) : "1";
          else if (k === "C") s = "1";
          else s = s === "0" ? k : s + k;
          return { ...c, qty: Math.max(1, parseInt(s, 10) || 1) };
        })
      );
    } else if (numMode === "DISC") {
      if (!selId) return;
      setCart((prev) =>
        prev.map((c) => {
          if (c.row.productUnitId !== selId) return c;
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
    total: number; received: number; change: number; credit: number;
    isCredit: boolean; method: string;
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
        date: now.toLocaleString("ar-IQ-u-nu-latn"),
        printDate: now.toLocaleDateString("en-GB"),
        printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        cashierName: ctx.cashierName,
        customerName: ctx.customerName,
        lines: ctx.lines,
        total: ctx.total, received: ctx.received, change: ctx.change,
        credit: ctx.credit, isCredit: ctx.isCredit,
        method: ctx.method,
      };
      // #2 (تدقيق التثبيت): إن رجع الخادم total (المُقرَّب المخزَّن فعلاً) نستعمله في الإيصال
      // كمصدر حقيقة أخير — يُغطّي أي انحراف تقريب مستقبليّ بين العميل والخادم (roundCashIQD مشتركة
      // حالياً، لكن الاعتماد على قيمة الخادم يحصّن الإيصال ضدّ أي تعديل مستقبلي على القاعدة).
      const serverTotal = r.total != null ? Number(r.total) : ctx.total;
      const alignedRec: Receipt = { ...rec, total: serverTotal };
      setReceipt(alignedRec);
      setLastInv({ num: r.invoiceNumber, total: serverTotal });
      clearCartDraft(branchId);
      notify.ok(`تم البيع — فاتورة ${r.invoiceNumber}`, "افتح من شريط «آخر فاتورة» أعلاه أو من صفحة الفواتير");
      // فرّغ التبويب المُباع تحديداً (لا التبويب النشط الحالي) وجدّد مفتاحه للبيع التالي.
      patchTab(ctx.tabId, { cart: [], payInput: "", selId: null, couponInput: "", couponCode: null, couponLabel: null, clientRequestId: newClientRequestId() });

      await printReceipt(buildBrandedReceipt(alignedRec));
      await Promise.all([
        utils.catalog.posList.invalidate(),
        utils.customers.list.invalidate(),
        shiftQ.refetch(),
      ]);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd(""); setSaleError(null);
    },
    onError: (e) => {
      const code = (e.data as unknown as { code?: string })?.code;
      // ش٣ أوفلاين — تدهور سلس: فشل نقل (لا كود tRPC بنيوي = الطلب لم يصل أصلاً) في أول بيعة
      // بعد انقطاعٍ لم يكتشفه المسبار بعد ⇒ حوّل تلقائياً للالتقاط المحلي بدل خطأ محيّر للكاشير.
      // نفس clientRequestId يبقى ⇒ لو كان الطلب وصل الخادم فعلاً وضاع الردّ، الترحيل اللاحق
      // يطابقه idempotent-ياً (لا ازدواج) ويعرض ربط OFF ↔ INV في درج المزامنة.
      if (!code) {
        saleCtxRef.current = null;
        void captureOfflineSale();
        return;
      }
      // #6 (تدقيق التثبيت): بوّابتا حدّ الائتمان (server/lib/credit.ts) والبيع دون التكلفة
      // (sale/create.ts) ترميان FORBIDDEN لا PRECONDITION_FAILED، فكان حوار موافقة المدير لا يُفتَح
      // على الكاشير الرئيسي (بخلاف PrintPOS عبر printSaleService) ⇒ يتعذّر البيع المُصرَّح ولو حضر
      // المدير. نطابق الرسالة كـSalesInvoiceNew:179 (مع إبقاء PRECONDITION_FAILED دفاعاً).
      if (code === "PRECONDITION_FAILED" || (e.message && (e.message.includes("حدّ الائتمان") || e.message.includes("بأقل من التكلفة"))))
        setCreditPrompt(e.message);
      // خطأ بيع حرج (نقص مخزون/رفض) ⇒ تنبيه بارز أكبر وأوضح يلتقطه الكاشير فوراً.
      else { notify.errBig(e); setSaleError(e.message); }
    },
  });

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
    const displayTotalD = cashFull ? cashRoundedTotalD : totalD;
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
      total: round2(displayTotalD).toNumber(),
      received: round2(finalReceivedD).toNumber(),
      change:   round2(finalChangeD).toNumber(),
      credit:   round2(finalCreditD).toNumber(),
      isCredit,
      method: METHOD_LABEL[activeTab.method],
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
    // ش٥ — بوابة التجربة (قرار مالك): الالتقاط معطَّل افتراضياً ويُفعَّل لكل جهاز على حدة.
    if (!(await isOfflineSaleEnabled())) {
      notify.errBig(
        "البيع دون اتصال غير مفعَّل على هذا الجهاز",
        "التصفح والاستعلام متاحان. تفعيل الالتقاط قرار إداري من «إعدادات الجهاز» في شارة المزامنة أسفل الشاشة.",
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
        payment: { amount: money(total), method: "CASH" },
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
      date: now.toLocaleString("ar-IQ-u-nu-latn"),
      printDate: now.toLocaleDateString("en-GB"),
      printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      cashierName: ctx.cashierName,
      customerName: ctx.customerName,
      lines: ctx.lines,
      total: ctx.total, received: ctx.received, change: ctx.change,
      credit: ctx.credit, isCredit: ctx.isCredit,
      method: ctx.method,
    };
    setReceipt(rec);
    setLastInv({ num: receiptNumber, total: ctx.total });
    clearCartDraft(branchId);
    notify.ok(`بيع دون اتصال — إيصال مؤقّت ${receiptNumber}`, "الرقم الرسمي يصدر تلقائياً عند عودة الاتصال (شارة المزامنة أسفل الشاشة)");
    patchTab(ctx.tabId, { cart: [], payInput: "", selId: null, couponInput: "", couponCode: null, couponLabel: null, clientRequestId: newClientRequestId() });
    await printReceipt(buildBrandedReceipt(rec));
  }

  function submitSale(approval?: { email: string; password: string }) {
    setSaleError(null);
    if (!shift || !cart.length) return;
    // تدقيق ١٧/٧: «0» صريح في حقل المقبوض كان يُسجّل البيع مدفوعاً نقداً بالكامل (isCredit=false ⇒
    // payAmount=total) بلا قبض فعليّ ⇒ عجز درج عند Z-report. ارفضه صراحةً بدل الإسقاط الصامت.
    if (activeTab.payInput.trim() !== "" && D(activeTab.payInput).eq(0)) {
      notify.err("أدخل المبلغ المقبوض، أو امسح الحقل للدفع النقدي الكامل. للبيع الآجل اختر عميلاً وأدخل المقدَّم.");
      return;
    }
    if (isCredit && activeTab.customerId == null) {
      notify.err("البيع الآجل يتطلّب اختيار عميل.");
      return;
    }
    // ش٣ أوفلاين: الاتصال مقطوع ⇒ التقاط محلي (نقدي كامل فقط) بدل نداء سيفشل.
    if (offline) {
      void captureOfflineSale();
      return;
    }
    // §٩: التقريب النقدي IQD يُحسب على الخادم للبيع النقدي الكامل (يُسجَّل ADJUST لفرق التقريب).
    // نرسل المبلغ غير المقرّب؛ الخادم يقرّبه ويُسجّل النقد المستلم = الإجمالي المقرّب.
    saleCtxRef.current = captureSaleCtx();
    const cashFull = activeTab.method === "CASH" && !isCredit;
    const payAmount = isCredit ? money(paid) : money(total);
    sale.mutate({
      branchId, shiftId: shift.id, sourceType: "POS", clientRequestId: activeTab.clientRequestId,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map(buildSaleLine),
      payment: { amount: payAmount, method: activeTab.method },
      ...(activeTab.couponCode ? { couponCode: activeTab.couponCode } : {}),
      ...(cashFull ? { cashRoundIQD: true } : {}),
      ...(approval ? { managerApproval: approval } : {}),
    });
  }

  function quickPay() {
    setSaleError(null);
    if (!shift || !cart.length) return;
    // ش٣ أوفلاين: الدفع السريع نقدي كامل بطبيعته ⇒ مؤهَّل للالتقاط المحلي مباشرة.
    if (offline) {
      void captureOfflineSale();
      return;
    }
    // §٩: quickPay دائماً CASH كامل ⇒ الخادم يقرّب لفئة IQD (لا تقريب على العميل في مبلغ الدفع).
    saleCtxRef.current = captureSaleCtx();
    const payAmount = money(total);
    sale.mutate({
      branchId, shiftId: shift.id, sourceType: "POS", clientRequestId: activeTab.clientRequestId, cashRoundIQD: true,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map(buildSaleLine),
      payment: { amount: payAmount, method: "CASH" },
      ...(activeTab.couponCode ? { couponCode: activeTab.couponCode } : {}),
    });
  }

  // ── Shift open ────────────────────────────────────────────────────────────
  const openShift = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
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

  // ①ج استمرارية نقد الورديات: المتوقَّع = متبقّي آخر وردية RETAIL مغلقة لهذا الفرع (يُطابق المُدخَل).
  const openingCont = useOpeningContinuity({ branchId, shiftType: "RETAIL", opening, enabled: !shift });

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt)      { if (e.key === "Escape" || e.key === "Enter") setReceipt(null); return; }
      if (shifting)     { if (e.key === "Escape") setShifting(false); return; }
      if (cashDropping) { if (e.key === "Escape") setCashDropping(false); return; }
      switch (e.key) {
        case "F2":  e.preventDefault(); searchRef.current?.focus(); break;
        case "F4":  e.preventDefault(); if (cart.length && !sale.isPending) submitSale(); break;
        case "F9":  e.preventDefault(); if (receipt) printReceipt(buildBrandedReceipt(receipt)); break;
        case "F12": e.preventDefault();
          if (cart.length) {
            void (async () => {
              if (!(await confirm({
                variant: "warning",
                title: "تفريغ السلّة",
                description: "ستُفقد كل المنتجات المُضافة في هذه السلّة. هل تتابع؟",
                confirmText: "تفريغ",
              }))) return;
              setCart([]); setPayInput(""); setSelId(null);
            })();
          }
          break;
        case "Escape": setShowDrop(false); break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sale.isPending, receipt, creditPrompt, shifting, cashDropping]);

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
        جارٍ التحميل…
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
              <select
                value={pickedBranch ?? ""}
                onChange={(e) => setPickedBranch(e.target.value ? Number(e.target.value) : null)}
                style={{ width: "100%", height: 48, border: `1.5px solid ${pickedBranch == null ? C.danger : C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, padding: "0 12px", outline: "none", boxSizing: "border-box" }}
              >
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
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
          <OpeningContinuityInline C={C} oc={openingCont} />
          <button
            disabled={openShift.isPending || needsBranchChoice || openingCont.blocked}
            onClick={() => openShift.mutate({ branchId, openingBalance: opening, shiftType: "RETAIL", openingDiscrepancyReason: openingCont.reasonPayload })}
            style={{ width: "100%", height: 52, background: openShift.isPending || needsBranchChoice || openingCont.blocked ? C.muted : C.primary, color: openShift.isPending || needsBranchChoice || openingCont.blocked ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 10, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: openShift.isPending || needsBranchChoice || openingCont.blocked ? "not-allowed" : "pointer" }}
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
    (activeTab.payInput === "" || paid >= total || (isCredit && activeTab.customerId != null));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>

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
        shift={shift}
        me={me.data}
        lastInv={lastInv}
        onCloseShift={() => setShifting(true)}
        onCashDrop={() => setCashDropping(true)}
        printerReady={printerReady}
        onConnectPrinter={connectPrinter}
        bridgeEnabled={bridge.enabled}
        bridgeDesc={bridge.description}
        onTestPrint={testServerPrint}
      />

      {/* Tab Bar */}
      <TabBar C={C} tabs={tabs} activeId={activeId} onSwitch={setActiveId} onAdd={addTab} onClose={closeTab} />

      {/* ش٣ أوفلاين: شارة/درج مزامنة المبيعات الملتقطة + إعدادات الجهاز (ش٥). */}
      <OfflineSyncChip userRole={me.data?.role} />

      {/* Body */}
      <div style={{ flex: 1, display: "flex", flexDirection: stacked ? "column-reverse" : "row", overflow: "hidden", padding: "7px 8px 8px", gap: 7, minHeight: 0 }}>

        {/* Payment Panel (right in RTL) */}
        <PaymentPanel
          C={C}
          stacked={stacked}
          total={total}
          payInput={activeTab.payInput}
          setPayInput={setPayInput}
          paid={paid} change={change} credit={credit}
          isChange={isChange} isOwing={isCredit}
          method={activeTab.method} setMethod={setMethod}
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
          openingActive={openingActive}
          openingEndsYmd={openingModeQ.data?.endsAtYmd ?? null}
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
            setCart([]); setSelId(null); setPayInput("");
          })()}
        />
      </div>

      {/* Overlays */}
      {receipt && (
        <ReceiptOverlay
          C={C} receipt={receipt}
          onDismiss={() => setReceipt(null)}
          onPrint={() => printReceipt(buildBrandedReceipt(receipt!))}
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
  shift: ShiftData;
  me: RouterOutputs["auth"]["me"] | undefined;
  lastInv: { num: string; total: number } | null;
  onCloseShift: () => void;
  onCashDrop: () => void;
  printerReady: boolean;
  onConnectPrinter: () => void;
  bridgeEnabled: boolean;
  bridgeDesc: string;
  onTestPrint: () => void;
}

function POSHeader({ C, search, setSearch, showDrop, setShowDrop, results, searching, searchSettled, addToCart, searchRef, handleScanKeyDown, shift, me, lastInv, onCloseShift, onCashDrop, printerReady, onConnectPrinter, bridgeEnabled, bridgeDesc, onTestPrint }: POSHeaderProps) {
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
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 14px", height: 64, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 40 }}>

      {/* Brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Store aria-hidden size={20} /></div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 11, color: C.mutedFg, lineHeight: 1.2 }}>نقطة البيع</div>
        </div>
      </div>

      <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />

      {/* Search with smart scan */}
      <div ref={wrapRef} style={{ flex: 1, maxWidth: 560, position: "relative" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <span style={{ position: "absolute", right: 13, zIndex: 1, color: C.mutedFg, display: "flex", pointerEvents: "none" }} aria-hidden><Search size={17} /></span>
          <input
            ref={searchRef} autoFocus
            placeholder="ابحث بالاسم أو SKU أو امسح الباركود… (F2)"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowDrop(true); }}
            onFocus={(e) => { if (search) setShowDrop(true); e.target.style.borderColor = C.primary; }}
            onBlur={(e) => (e.target.style.borderColor = C.border)}
            onKeyDown={(e) => {
              handleScanKeyDown(e, search, setSearch);
              if (e.defaultPrevented) return;
              // Enter يضيف أول نتيجة — فقط حين تطابق النتائج نصَّ البحث الحالي
              // (أثناء التأجيل/الجلب قد تكون النتائج لاستعلام أقدم ⇒ إضافة خاطئة).
              if (e.key === "Enter" && searchSettled && results.length > 0) addToCart(results[0]);
              if (e.key === "Escape") { setSearch(""); setShowDrop(false); }
            }}
            style={{ width: "100%", height: 50, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14.5, outline: "none", paddingRight: 44, paddingLeft: search ? 44 : 14 }}
          />
          {search && (
            <button onClick={() => { setSearch(""); setShowDrop(false); searchRef.current?.focus(); }}
              aria-label="مسح البحث"
              style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "flex", padding: 4 }}><X aria-hidden size={16} /></button>
          )}
        </div>

        {/* Dropdown — نتائج، أو حالة واضحة (قصير/جارٍ البحث/لا نتائج) بدل الصمت */}
        {showDrop && search.trim().length > 0 && (
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
                    {p.isService && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#0891b2", background: "#cffafe", padding: "1px 6px", borderRadius: 4, marginRight: 6, verticalAlign: "middle" }}>خِدمة</span>
                    )}
                    {p.isConsignment && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#b45309", background: "#fef3c7", padding: "1px 6px", borderRadius: 4, marginRight: 6, verticalAlign: "middle" }}>أمانة</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.mutedFg, marginTop: 2 }}>
                    {p.sku} · {p.unitName}
                    {!p.isService && (
                      <span style={{ marginRight: 10, color: stockColor(p.stockBase) }}>
                        مخزون: {fmt(p.stockBase)}
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

      <div style={{ flex: 1 }} />

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
            <CopyButton value={String(lastInv.total)} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}

      {/* Shift badge */}
      {shift && (
        <div style={{ background: C.muted, borderRadius: 8, padding: "4px 11px", fontSize: 12, color: C.mutedFg, fontWeight: 700, flexShrink: 0, border: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
          <span aria-hidden className="inline-block size-2 rounded-full bg-emerald-500" style={{ marginLeft: 6 }} />وردية #{shift.id}
        </div>
      )}

      {/* User */}
      {me && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, color: C.fg }}>{me.name}</div>
            <div style={{ fontSize: 10.5, color: C.mutedFg, lineHeight: 1.2 }}>
              {me.role === "admin" ? "مدير" : me.role === "manager" ? "مدير فرع" : "كاشير"}
            </div>
          </div>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, flexShrink: 0 }}>
            {me.name?.[0] ?? "م"}
          </div>
        </div>
      )}

      {/* جسر الطباعة على الخادم (طباعة صامتة) — يظهر حين يكون مفعّلاً؛ نقرة = تذكرة اختبار. */}
      {bridgeEnabled && (
        <button onClick={onTestPrint} title={`جسر طباعة صامت: ${bridgeDesc} — اضغط لطباعة تذكرة اختبار`}
          aria-label="جسر طباعة على الخادم — تذكرة اختبار"
          style={{ background: "none", border: `1.5px solid ${C.success}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", color: C.success, fontFamily: "inherit", fontWeight: 600, flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
          <Printer size={15} aria-hidden /><Globe size={13} aria-hidden />
        </button>
      )}

      {/* Printer (WebUSB) */}
      {isWebUsbSupported() && (
        <button onClick={onConnectPrinter} title={printerReady ? "الطابعة الافتراضية مربوطة (تلقائياً) — اضغط لتبديلها" : "اربط طابعة حرارية (تُربط تلقائياً بعدها)"}
          aria-label={printerReady ? "الطابعة الافتراضية مربوطة" : "ربط طابعة حرارية"}
          style={{ background: "none", border: `1.5px solid ${printerReady ? C.success : C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", color: printerReady ? C.success : C.mutedFg, fontFamily: "inherit", fontWeight: 600, flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
          <Printer size={15} aria-hidden />{printerReady && <Check size={13} aria-hidden strokeWidth={3} />}
        </button>
      )}

      {/* Cash drop — سحب نقديّ من الدرج إلى الخزينة أثناء الوردية (يقلّل مخاطرة تكدّس النقد) */}
      {shift && (
        <button onClick={onCashDrop} title="سحب نقديّ من الدرج إلى الخزينة أثناء الوردية"
          style={{ height: 44, padding: "0 12px", background: "transparent", border: `1.5px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
          <Banknote size={16} aria-hidden /> سحب نقدي
        </button>
      )}

      {/* Close shift */}
      <button onClick={onCloseShift}
        style={{ height: 44, padding: "0 14px", background: "transparent", border: `1.5px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        <Power size={16} aria-hidden /> إغلاق الوردية
      </button>
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
        <button onClick={onAdd}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, background: C.card, border: `1.5px dashed ${C.border}`, cursor: "pointer", fontSize: 22, color: C.mutedFg, flexShrink: 0 }}>+</button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CartPanel ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface CartPanelProps {
  C: C;
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
}

function CartPanel({ C, cart, total, selId, setSelId, changeQty, removeRow, numMode, setNumMode, customerId, selectedCustomer, tierOverride, effectiveTier, setTierOvr, setCustId, showCustPicker, setShowCustPicker, onClear, openingActive, openingEndsYmd }: CartPanelProps) {
  const itemCount = cart.reduce((s, c) => s + c.qty, 0);
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
  const stockState = (c: CartItem) => {
    const convFactor  = Number(c.row.conversionFactor) || 1;
    // مُنتج خِدمي: لا مَخزون ⇒ لا نَفاد ولا نَقص (الخَادم يَتجاوز فَحص المَخزون أيضاً).
    if (c.row.isService) {
      return { isOut: false, isShort: false, availInUnit: Number.POSITIVE_INFINITY };
    }
    const availBase   = c.row.stockBase ?? 0;
    const reqBase     = demandByVariant.get(c.row.variantId) ?? c.qty * convFactor; // إجمالي طلب الصنف
    const isOut       = availBase <= 0;                       // نافذ — لا رصيد
    const isShort     = !isOut && reqBase > availBase;        // الطلب يتجاوز المتاح
    const availInUnit = Math.floor(availBase / convFactor);  // المتاح بوحدة السطر
    return { isOut, isShort, availInUnit };
  };
  // ملخّص للشارة الدائمة في التذييل (كي لا يختفي التحذير حين ينزلق السطر المميَّز خارج الرؤية).
  let anyOut = false, flaggedCount = 0;
  for (const c of cart) {
    const s = stockState(c);
    if (s.isOut)        { anyOut = true; flaggedCount++; }
    else if (s.isShort) { flaggedCount++; }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>

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
                <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label style={{ fontSize: 12, color: C.mutedFg }}>فئة السعر:</label>
                    <select value={effectiveTier} onChange={(e) => setTierOvr(e.target.value as Tier)}
                      style={{ height: 30, border: `1px solid ${C.border}`, borderRadius: 6, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 12, padding: "0 6px", outline: "none" }}>
                      <option value="RETAIL">مفرد</option>
                      <option value="WHOLESALE">جملة</option>
                      <option value="GOVERNMENT">حكومي</option>
                    </select>
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

      {/* «وضع الافتتاح» — لافتة دائمة ما دامت النافذة فعّالة */}
      {openingActive && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: C.amberSoft, borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, color: "#7a5200", flexShrink: 0 }}>
          <AlertTriangle aria-hidden size={13} />
          وضع الافتتاح فعّال{openingEndsYmd ? ` حتى نهاية يوم ${openingEndsYmd}` : ""} — الصنف غير المجرود يُباع نقداً كاملاً حتى لو نفد (ينزل بالسالب حتى جرده الافتتاحي)؛ الآجل وغير النقدي صارمان.
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 540, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <th style={{ ...TH, width: 32 }}>#</th>
              <th style={{ ...TH, textAlign: "right" }}>المنتج</th>
              <th style={{ ...TH, width: 64 }}>الوحدة</th>
              <th style={{ ...TH, width: 110 }}>السعر</th>
              <th style={{ ...TH, width: 80 }}>المخزون</th>
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
              const selected = selId === c.row.productUnitId;
              // تمييز بصري + نصّ قبل محاولة الدفع (المنطق المُجمَّع للصنف في stockState أعلاه).
              const { isOut, isShort, availInUnit } = stockState(c);
              // «وضع الافتتاح»: الصنف غير المُفتتَح (openedAt فارغ) يُباع نقداً بالسالب — وسم كهرماني
              // مطمئن بدل «نافذ» الأحمر المخيف (الحارس الفعلي خادميّ؛ الآجل/غير النقدي سيُرفض هناك).
              const openingSellable = (isOut || isShort) && openingActive && c.row.openedAt == null && !c.row.isService;
              const rowBg  = selected ? C.primarySoft : openingSellable ? C.amberSoft : isOut ? C.dangerSoft : isShort ? C.amberSoft : "transparent";
              const accent = openingSellable ? C.amber : isOut ? C.danger : isShort ? C.amber : "transparent";
              return (
                <tr key={c.row.productUnitId}
                  onClick={() => { setSelId(c.row.productUnitId); setNumMode("QTY"); }}
                  style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: rowBg, transition: "background .08s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = selected ? C.primarySoft : isOut ? C.dangerSoft : isShort ? C.amberSoft : C.muted; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = rowBg; }}
                >
                  <td style={{ ...TD, color: C.mutedFg, fontWeight: 600, borderInlineStart: `4px solid ${accent}` }}>{i + 1}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: C.fg }}>
                    {c.row.productName}
                    <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 400, marginRight: 5 }}>{c.row.sku}</span>
                    {c.disc != null && c.disc > 0 && (
                      <span style={{ fontSize: 11, color: C.danger, fontWeight: 700, marginRight: 4 }}>−{c.disc}%</span>
                    )}
                    {openingSellable && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#241900", background: C.amber, fontWeight: 800, borderRadius: 6, padding: "2px 8px", marginRight: 6, whiteSpace: "nowrap" }}>
                        <AlertTriangle aria-hidden size={12} /> غير مجرود — يُباع نقداً بالسالب
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
                    {c.row.isService ? "∞" : fmt(availInUnit)}
                  </td>
                  <td style={{ ...TD, padding: "6px 6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.row.productUnitId, c.qty - 1); }}
                        style={{ width: 44, height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 22, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                      <span style={{ minWidth: 40, textAlign: "center", fontWeight: 800, fontSize: 15, direction: "ltr", color: C.fg }}>{c.qty}</span>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.row.productUnitId, c.qty + 1); }}
                        title={isOut || isShort ? "الزيادة تتجاوز المخزون المتاح" : undefined}
                        style={{ width: 44, height: 44, border: `1.5px solid ${isOut || isShort ? accent : C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 22, color: isOut || isShort ? accent : C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                    </div>
                  </td>
                  <td style={{ ...TD, direction: "ltr", fontWeight: 800, fontSize: 14.5, color: C.fg }}>{fmt(itemTotal(c))}</td>
                  <td style={{ ...TD, padding: "6px" }}>
                    <button onClick={(e) => { e.stopPropagation(); removeRow(c.row.productUnitId); }}
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
                <AlertTriangle aria-hidden size={13} /> {flaggedCount} صنف ناقص المخزون
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
  setPayInput: (updater: string | ((s: string) => string)) => void;
  paid: number; change: number; credit: number;
  isChange: boolean; isOwing: boolean;
  method: PaymentMethod; setMethod: (m: PaymentMethod) => void;
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

function PaymentPanel({ C, total, payInput, setPayInput, paid, change, credit, isChange, isOwing, method, setMethod, numMode, setNumMode, numPress, onPay, onQuickPay, cartLen, isPending, canPay, hasCustomer, saleError, onDismissError, stacked, couponInput, couponCode, couponLabel, setCouponInput, onApplyCoupon, onClearCoupon, couponPending }: PaymentPanelProps) {

  const modeStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: 54, minWidth: 70, padding: "0 8px",
    fontSize: 13, fontWeight: 800, cursor: "pointer",
    fontFamily: "inherit", borderRadius: 9,
    border: active ? `1.5px solid ${C.modeBord}` : `1.5px solid ${C.border}`,
    background: active ? C.modeActive : C.numKey,
    color: active ? C.modeFg : C.mutedFg,
    transition: "all .1s", userSelect: "none" as const, touchAction: "manipulation" as const,
  });

  const numKeyStyle = (del?: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: 54, fontSize: 21, fontWeight: 800,
    background: del ? C.delKey : C.numKey,
    color: del ? C.delFg : C.fg,
    border: `1.5px solid ${C.border}`,
    borderRadius: 9, cursor: "pointer",
    fontFamily: "inherit", direction: "ltr" as const,
    transition: "background .07s, transform .06s",
    userSelect: "none" as const, touchAction: "manipulation" as const,
  });

  const payMethodStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center",
    gap: 3, minHeight: 60, fontSize: 14, fontWeight: 800,
    border: `2px solid ${active ? C.primary : C.border}`,
    borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
    background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg,
    transition: "all .1s", userSelect: "none" as const,
    boxShadow: active ? `0 3px 10px oklch(0.488 0.243 264.376 / .28)` : "none",
  });

  const modeLabel = numMode === "QTY"  ? "الكمية — المنتج المحدد"
    : numMode === "DISC" ? "خصم % على المنتج"
    : "المبلغ المستلم";

  return (
    <div style={{ width: stacked ? "100%" : 420, maxWidth: "100%", flexShrink: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>

      {/* خطأ بيع حرِج ثابت (بديل toast العابر) — يبقى ظاهراً حتى محاولة جديدة/إغلاق يدوي */}
      {saleError && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 12px", background: C.dangerSoft, borderBottom: `1px solid ${C.danger}`, color: C.danger, fontSize: 12.5, fontWeight: 700, flexShrink: 0 }}>
          <AlertTriangle aria-hidden size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ flex: 1, lineHeight: 1.4 }}>{saleError}</span>
          <button onClick={onDismissError} aria-label="إغلاق التنبيه" style={{ background: "none", border: "none", cursor: "pointer", color: C.danger, lineHeight: 1, padding: 0, display: "inline-flex", flexShrink: 0 }}><X aria-hidden size={15} /></button>
        </div>
      )}

      {/* Total */}
      <div style={{ padding: "8px 13px", background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: C.mutedFg, fontWeight: 600 }}>إجمالي الفاتورة</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: 28, fontWeight: 900, direction: "ltr", letterSpacing: "-1px", color: C.fg }}>{fmt(total)}</span>
            <span style={{ fontSize: 12.5, color: C.mutedFg }}>د.ع</span>
          </div>
        </div>
      </div>

      {/* Amount display */}
      <div style={{ padding: "4px 11px 3px", flexShrink: 0 }}>
        <div style={{ background: C.muted, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "5px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 46 }}>
          <span style={{ fontSize: 12, color: C.mutedFg }}>{modeLabel}</span>
          <span style={{ fontSize: 24, fontWeight: 900, direction: "ltr", marginRight: 6, color: numMode === "PAY" && payInput ? (isOwing ? C.amber : C.primary) : C.fg }}>
            {numMode === "PAY" ? (payInput ? Number(payInput).toLocaleString("en-US") : "—") : "—"}
          </span>
        </div>
      </div>

      {/* Quick amounts */}
      {numMode === "PAY" && (
        <div style={{ padding: "3px 11px 2px", display: "flex", gap: 3, flexWrap: "wrap", flexShrink: 0 }}>
          {QUICK_AMTS.map((a) => (
            <button key={a} onClick={() => setPayInput(String(a))}
              style={{ height: 40, padding: "0 10px", background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.fg, fontFamily: "inherit" }}>
              {fmt(a)}
            </button>
          ))}
          {cartLen > 0 && (
            <button onClick={() => setPayInput(String(total))}
              style={{ height: 40, padding: "0 10px", background: C.card, border: `1.5px solid ${C.primary}`, borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.primary, fontFamily: "inherit" }}>
              = الكل
            </button>
          )}
        </div>
      )}

      {/* Odoo 19 Numpad — RTL: mode buttons on right visually */}
      {/* Grid: [mode | 3 | 2 | 1] / [mode | 6 | 5 | 4] / [mode | 9 | 8 | 7] / [⌫ | . | 0 | +/-] */}
      <div style={{ padding: "4px 11px 3px", flexShrink: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", gap: 4, direction: "rtl" }}>
          <button style={modeStyle(numMode === "QTY")}  onClick={() => setNumMode("QTY")}>الكمية</button>
          <button style={numKeyStyle()} onClick={() => numPress("3")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>3</button>
          <button style={numKeyStyle()} onClick={() => numPress("2")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>2</button>
          <button style={numKeyStyle()} onClick={() => numPress("1")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>1</button>

          <button style={modeStyle(numMode === "DISC")} onClick={() => setNumMode("DISC")}>%</button>
          <button style={numKeyStyle()} onClick={() => numPress("6")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>6</button>
          <button style={numKeyStyle()} onClick={() => numPress("5")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>5</button>
          <button style={numKeyStyle()} onClick={() => numPress("4")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>4</button>

          <button style={modeStyle(numMode === "PAY")}  onClick={() => setNumMode("PAY")}>المبلغ</button>
          <button style={numKeyStyle()} onClick={() => numPress("9")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>9</button>
          <button style={numKeyStyle()} onClick={() => numPress("8")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>8</button>
          <button style={numKeyStyle()} onClick={() => numPress("7")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>7</button>

          <button style={numKeyStyle(true)} onClick={() => numPress("⌫")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>⌫</button>
          <button style={numKeyStyle()}     onClick={() => numPress(".")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>.</button>
          <button style={numKeyStyle()}     onClick={() => numPress("0")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>0</button>
          <button style={{ ...numKeyStyle(), fontSize: 13 }} onClick={() => numPress("+/-")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>+/-</button>
        </div>
      </div>

      {/* كوبون CRM — تحقق خادمي ثم إعادة تحقق ذرّية عند البيع */}
      <div style={{ padding: "4px 11px 3px", flexShrink: 0 }}>
        <div style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, marginBottom: 4 }}>كوبون خصم</div>
        <div style={{ display: "flex", gap: 5 }}>
          <input
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") onApplyCoupon(); }}
            placeholder="اكتب أو امسح الرمز"
            disabled={!cartLen || couponPending}
            style={{ minWidth: 0, flex: 1, height: 40, border: `1.5px solid ${couponCode ? C.success : C.border}`, borderRadius: 8, background: C.muted, color: C.fg, padding: "0 9px", fontFamily: "inherit", fontWeight: 800, direction: "ltr" }}
          />
          {couponCode ? (
            <button onClick={onClearCoupon} style={{ height: 40, padding: "0 10px", border: `1px solid ${C.danger}`, borderRadius: 8, background: C.dangerSoft, color: C.danger, fontFamily: "inherit", fontWeight: 800, cursor: "pointer" }}>إزالة</button>
          ) : (
            <button disabled={!cartLen || !couponInput.trim() || couponPending} onClick={onApplyCoupon} style={{ height: 40, padding: "0 12px", border: 0, borderRadius: 8, background: C.primary, color: C.primaryFg, fontFamily: "inherit", fontWeight: 800, cursor: "pointer" }}>{couponPending ? "تحقق…" : "تطبيق"}</button>
          )}
        </div>
        {couponCode && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.success, fontWeight: 800, marginTop: 2 }}>
            <Check size={13} aria-hidden="true" />
            <span>{couponLabel ?? couponCode}</span>
          </div>
        )}
      </div>

      {/* Payment method */}
      <div style={{ padding: "4px 11px 3px", flexShrink: 0 }}>
        <div style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, marginBottom: 4 }}>طريقة الدفع</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={payMethodStyle(method === "CASH")}     onClick={() => setMethod("CASH")}>
            <Banknote aria-hidden size={22} />نقداً
          </button>
          <button style={payMethodStyle(method === "CARD")}     onClick={() => setMethod("CARD")}>
            <CreditCard aria-hidden size={22} />بطاقة
          </button>
          <button
            style={{ ...payMethodStyle(method === "TRANSFER" || method === "WALLET"), minHeight: 50, fontSize: 12 }}
            onClick={() => setMethod(method === "TRANSFER" ? "WALLET" : "TRANSFER")}>
            <RefreshCw aria-hidden size={18} />
            {method === "TRANSFER" ? "تحويل" : method === "WALLET" ? "محفظة" : "أخرى"}
          </button>
        </div>
      </div>

      {/* Change / owing indicator */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: "4px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 36, flexShrink: 0 }}>
        {!cartLen && <span style={{ fontSize: 13, color: C.mutedFg }}>أضف منتجات للبدء</span>}
        {cartLen > 0 && !payInput && <span style={{ fontSize: 12.5, color: C.mutedFg }}>أدخل المبلغ أو «إتمام» للدفع الكامل</span>}
        {cartLen > 0 && !!payInput && isChange && (
          <>
            <span style={{ fontSize: 13.5, color: C.mutedFg, fontWeight: 600 }}>الباقي للعميل</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12.5, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span>
              <CopyButton value={String(change)} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
            </span>
          </>
        )}
        {cartLen > 0 && !!payInput && isOwing && (
          <>
            <span style={{ fontSize: 13.5, color: C.amber, fontWeight: 600 }}>المتبقي للدفع</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 22, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12.5, fontWeight: 500 }}>د.ع</span></span>
              <CopyButton value={String(credit)} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" />
            </span>
          </>
        )}
      </div>

      {/* Quick pay — يُخفى عند اختيار عميل أو إدخال دفعة جزئية (نيّة غير «نقدي كامل») ⇒ يبقى CTA أساسي واحد
          فيمتنع الضغط الخاطئ الذي كان يُسجّل عميل الآجل «مدفوعاً نقداً بالكامل». الزرّ الأخضر يؤدّي الدفع الكامل أصلاً. */}
      {!hasCustomer && !isOwing && (<>
      <div style={{ padding: "4px 11px 2px", flexShrink: 0 }}>
        <button
          disabled={!cartLen || isPending}
          onClick={() => onQuickPay()}
          style={{
            width: "100%", height: 52,
            background: cartLen && !isPending ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))" : C.muted,
            color: cartLen && !isPending ? "#fff" : C.mutedFg,
            border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 15, fontWeight: 900,
            cursor: cartLen && !isPending ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            boxShadow: cartLen && !isPending ? "0 4px 14px oklch(0.60 0.18 50 / .38)" : "none",
            transition: "all .1s",
          }}>
          <Zap aria-hidden size={18} /> دفع سريع وطباعة — نقداً
        </button>
        <div style={{ textAlign: "center", marginTop: 2, fontSize: 10, color: C.mutedFg }}>للأوقات المزدحمة — يتجاوز كل الخطوات</div>
      </div>

      <div style={{ margin: "3px 11px", borderTop: `1.5px dashed ${C.border}` }} />
      </>)}

      {/* Regular pay */}
      <div style={{ padding: "2px 11px 10px", flexShrink: 0 }}>
        <button
          disabled={!canPay || isPending}
          onClick={() => onPay()}
          style={{
            width: "100%", height: 52,
            background: canPay && !isPending ? C.success : C.muted,
            color: canPay && !isPending ? "#fff" : C.mutedFg,
            border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 15, fontWeight: 900,
            cursor: canPay && !isPending ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            boxShadow: canPay && !isPending ? `0 3px 12px oklch(0.50 0.13 155 / .30)` : "none",
            transition: "all .1s",
          }}>
          {isPending
            ? "جارٍ…"
            : !cartLen
              ? "السلة فارغة"
              : <><Check aria-hidden size={18} strokeWidth={3} /> إتمام الدفع — {fmt(total)} د.ع</>}
        </button>
        <div style={{ textAlign: "center", marginTop: 4, fontSize: 10.5, color: C.mutedFg }}>F4 للدفع · F2 للبحث · F9 طباعة</div>
      </div>
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
                <CopyButton value={String(item.raw)} title={`نسخ ${item.label}`} successMessage={`تم نسخ ${item.label}`} />
              </div>
              <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 26, fontWeight: 900, direction: "ltr", color: item.color }}>{item.value}</div>
              <div style={{ fontSize: 11, color: C.mutedFg }}>د.ع</div>
            </div>
          ))}
        </div>

        {receipt.change > 0 && (
          <div style={{ background: "oklch(0.50 0.13 155 / .1)", border: "1.5px solid oklch(0.50 0.13 155 / .28)", borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.success }}>الباقي للعميل</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(receipt.change)} <span style={{ fontSize: 12 }}>د.ع</span></span>
              <CopyButton value={String(receipt.change)} title="نسخ الباقي" successMessage="تم نسخ الباقي" />
            </span>
          </div>
        )}

        {receipt.isCredit && receipt.credit > 0 && (
          <div style={{ background: "oklch(0.65 0.15 75 / .1)", border: "1.5px solid oklch(0.65 0.15 75 / .3)", borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.amber }}>آجل على {receipt.customerName ?? "العميل"}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(receipt.credit)} <span style={{ fontSize: 12 }}>د.ع</span></span>
              <CopyButton value={String(receipt.credit)} title="نسخ المتبقي الآجل" successMessage="تم نسخ المتبقي" />
            </span>
          </div>
        )}

        <div style={{ marginBottom: 20, fontSize: 13.5, color: C.mutedFg }}>
          طريقة الدفع: <strong style={{ color: C.fg }}>{receipt.method}</strong>
          &nbsp;·&nbsp; {receipt.lines.length} منتج
          {receipt.customerName && <>&nbsp;·&nbsp; <strong style={{ color: C.fg }}>{receipt.customerName}</strong></>}
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
        @keyframes pulse  { 0%,100%{ box-shadow:0 0 0 0 oklch(0.50 0.13 155/.4); } 60%{ box-shadow:0 0 0 14px oklch(0.50 0.13 155/0); } }
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
  const [handover, setHandover] = useState<ShiftHandoverValue>(emptyHandover);
  const utils = trpc.useUtils();
  const recipientsQ = trpc.shifts.handoverRecipients.useQuery(undefined, { enabled: !!shift });

  // ش٤ أوفلاين — حارس الطابور: إغلاق الوردية وثمة مبيعات غير مُزامنة يترك نقداً في الدرج بلا
  // فواتير في Z ⇒ محجوب افتراضياً؛ المدير/الأدمن يتجاوز بإقرار صريح (تُرحَّل لاحقاً وتدخل
  // الوردية موسومةً «مُزامنة لاحقاً» في التقرير).
  const [outboxQueued, setOutboxQueued] = useState({ count: 0, total: 0 });
  const [overrideAck, setOverrideAck] = useState(false);
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
  const isElevated = me?.role === "admin" || me?.role === "manager";
  const closeBlocked = outboxQueued.count > 0 && !(isElevated && overrideAck);

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
      });
      await utils.shifts.current.invalidate();
      onClosed();
    },
    onError: (e) => notify.errBig(e),
  });

  // النقد المتوقع = رصيد افتتاحي + كل CASH وارد (مبيعات) - كل CASH صادر (مصروفات).
  // §٥: نجمع ونطرح بدقّة Decimal (Number + reduce + sub يتراكم عليه الانجراف على مئات الدفعات).
  const cashInD     = (report?.payments ?? []).filter((p) => p.method === "CASH" && p.direction === "IN" ).reduce((s, p) => s.plus(D(p.total)), D(0));
  const cashOutD    = (report?.payments ?? []).filter((p) => p.method === "CASH" && p.direction === "OUT").reduce((s, p) => s.plus(D(p.total)), D(0));
  const openingD    = D(shift?.openingBalance ?? 0);
  // ش٤: النقد غير المُزامَن موجود فيزيائياً بالدرج ⇒ يدخل المتوقع المعروض للعدّ (الخادم عند
  // الإغلاق يحسب المُزامَن فقط، والفرق يُفسَّر لاحقاً بقسم «مُزامنة لاحقاً» في التقرير).
  const expectedD   = report != null ? openingD.plus(cashInD).minus(cashOutD).plus(D(outboxQueued.total)) : null;
  const countedD    = counted ? D(counted) : null;
  const diffD       = expectedD != null && countedD != null ? countedD.minus(expectedD) : null;
  // متغيّرات عددية للعرض ولتفادي تغييرات JSX الأكبر
  const cashIn      = cashInD.toNumber();
  const cashOut     = cashOutD.toNumber();
  const openingBal  = openingD.toNumber();
  const expectedNum = expectedD?.toNumber() ?? null;
  const countedNum  = countedD?.toNumber() ?? null;
  const diff        = diffD?.toNumber() ?? null;

  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgb(0 0 0/.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} ref={modalRef} role="dialog" aria-modal="true" aria-label="إغلاق الوردية"
        style={{ background: C.card, borderRadius: 18, padding: "26px 30px", width: 440, boxShadow: "0 24px 64px rgb(0 0 0/.32)", animation: "popIn .2s ease", maxHeight: "90vh", overflowY: "auto" }}>

        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 4, color: C.fg }}>إغلاق الوردية #{shift?.id}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 18 }}>
          {new Date().toLocaleDateString("ar-IQ-u-nu-latn", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
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
              ...(report != null ? [["النقد المتوقع بالصندوق", `${fmt(openingBal + cashIn - cashOut + outboxQueued.total)} د.ع`] as [string, string]] : []),
            ] as [string, string][]).map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.mutedFg }}>{l}</span>
                <span style={{ fontWeight: 700, color: C.fg }}>{v}</span>
              </div>
            ))}

            {/* Payment breakdown */}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).length > 0 && (
              <div style={{ margin: "10px 0 4px", fontSize: 12, color: C.mutedFg, fontWeight: 700 }}>تفصيل طرق الدفع:</div>
            )}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).map((p) => (
              <div key={`${p.method}-${p.direction}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: `1px dashed ${C.border}` }}>
                <span style={{ color: C.mutedFg }}>{p.method} {p.direction === "IN" ? "وارد" : "صادر"} ({p.count})</span>
                <span style={{ fontWeight: 600, color: p.direction === "OUT" ? C.danger : C.fg }}>{fmt(Number(p.total))} د.ع</span>
              </div>
            ))}

            {/* Counted cash */}
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>النقد المعدود في الصندوق (د.ع)</label>
              <input
                value={counted} onChange={(e) => setCounted(e.target.value)}
                dir="ltr" placeholder="0"
                style={{ width: "100%", height: 50, border: `1.5px solid ${C.border}`, borderRadius: 9, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 20, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box" }}
                onFocus={(e) => (e.target.style.borderColor = C.primary)}
                onBlur={(e)  => (e.target.style.borderColor = C.border)}
              />
              {diff !== null && (
                <div style={{ marginTop: 7, fontSize: 14, fontWeight: 700, color: diff >= 0 ? C.success : C.danger, display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span>الفرق: {diff >= 0 ? "+" : ""}{fmt(diff)} د.ع</span>
                  {diff === 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Check aria-hidden size={14} strokeWidth={3} /> مطابق تماماً</span>}
                  {diff > 0  && <span>(زيادة)</span>}
                  {diff < 0  && <span>(عجز)</span>}
                </div>
              )}
            </div>

            {/* تسليم نقد الدرج للخزينة (treasury-stage2) — اختياريّ، بيد مديرٍ مستلِم. */}
            <ShiftHandoverSection
              C={C}
              recipients={recipientsQ.data ?? []}
              value={handover}
              onChange={setHandover}
              loading={recipientsQ.isLoading}
            />

            {/* ش٤ أوفلاين: حارس الطابور غير المُزامَن — حجب الإغلاق (تجاوز مديري بإقرار صريح). */}
            {outboxQueued.count > 0 && (
              <div style={{ marginTop: 14, padding: "10px 12px", background: C.amberSoft, border: `1.5px solid ${C.amber}`, borderRadius: 9, fontSize: 12.5, color: C.fg }}>
                <div style={{ fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle aria-hidden size={15} /> توجد {outboxQueued.count} فاتورة غير مُزامنة ({fmt(outboxQueued.total)} د.ع)
                </div>
                <div style={{ marginTop: 4, color: C.mutedFg }}>
                  أكمل المزامنة قبل الإغلاق (شارة المزامنة أسفل الشاشة) — نقدها في الدرج ولن تظهر في Z قبل الترحيل.
                </div>
                {isElevated ? (
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 7, marginTop: 8, cursor: "pointer", fontWeight: 700 }}>
                    <input type="checkbox" checked={overrideAck} onChange={(e) => setOverrideAck(e.target.checked)} style={{ marginTop: 3 }} />
                    <span>إغلاق رغم ذلك — تُرحَّل لاحقاً وتدخل الوردية موسومةً «مُزامنة لاحقاً» في التقرير</span>
                  </label>
                ) : (
                  <div style={{ marginTop: 6, fontWeight: 700 }}>يستطيع المدير الإغلاق متجاوزاً عند الضرورة.</div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={onClose}
                style={{ flex: 1, height: 46, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.fg }}>
                إلغاء
              </button>
              <button
                disabled={!counted || closeShift.isPending || closeBlocked || handoverIncomplete(handover)}
                onClick={() => shift && closeShift.mutate({ shiftId: shift.id, countedCash: counted, handover: buildHandoverPayload(handover) })}
                style={{ flex: 1, height: 46, background: !counted || closeShift.isPending || closeBlocked ? C.muted : C.danger, color: !counted || closeShift.isPending || closeBlocked ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: !counted || closeShift.isPending || closeBlocked ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>
                {closeShift.isPending ? "جارٍ الإغلاق…" : closeBlocked ? "أكمل المزامنة أولاً" : "إغلاق وطباعة Z"}
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
        {[
          { label: "بريد المدير", value: mgrEmail, setter: setMgrEmail, type: "email",    placeholder: "manager@alroya.local" },
          { label: "كلمة المرور", value: mgrPwd,   setter: setMgrPwd,   type: "password", placeholder: "••••••••" },
        ].map((f) => (
          <div key={f.label} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>{f.label}</label>
            <input
              type={f.type} dir="ltr" value={f.value} placeholder={f.placeholder}
              onChange={(e) => f.setter(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPwd) onApprove(); }}
              style={{ width: "100%", height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 14, padding: "0 12px", outline: "none", boxSizing: "border-box" }}
            />
          </div>
        ))}
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
