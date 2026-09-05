/**
 * نقطة البيع — الرؤية العربية
 * تصميم Odoo 19-style مع multi-tab، حاسبة ذكية، مسح باركود آني، وإدارة وردية كاملة.
 */
import { AppSelect } from "@/components/ui/AppSelect";
import { CashDropDialog } from "@/components/pos/CashDropDialog";
import { discardLegacyPosDrafts, loadPosTabsDraft, posTabsDraftKey, savePosTabsDraft, type PosDraftScope } from "@/lib/cartDraft";
import { newClientRequestId } from "@/lib/countQueue";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { notify, errMsg } from "@/lib/notify";
import { D, roundCashIQD, round2 } from "@/lib/money";
import { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter, printReceipt, printShiftOpen, getServerBridgeStatus, serverPrintTest, openCashDrawer } from "@/lib/printing/print";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMediaQuery } from "@/hooks/useMobile";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { offlineFindByBarcode, offlineSearchCatalog, useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import { allocateOfflineReceiptNumber, assertCanCapture, enqueueOfflineSale, getDeviceCode, isOfflineSaleEnabled, subscribeOutbox } from "@/lib/offline/outbox";
import { getOfflineProfile, saveOfflineProfile } from "@/lib/offline/pinLock";
import { getMeta, setMeta } from "@/lib/offline/db";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { DigitalCardsPickerDialog, type DigitalBasketCapture } from "@/components/pos/DigitalCardsPickerDialog";
import { DigitalFulfillmentDialog } from "@/components/pos/DigitalFulfillmentDialog";
import { digitalCheckoutReceiptLines } from "@/lib/printing/digitalReceiptLines";
import { parseScan } from "@/lib/scanRouter";
import { trpc } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Printer, Power, Globe, Check, Banknote, Vault } from "lucide-react";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { markPosTabsStockStale, reconcilePosTabsStock } from "@/lib/posStockRefresh";
import { ACTION_LABELS } from "@shared/actionLabels";
import { applyPosQuantityKey } from "@/lib/posQuantityEntry";
import { priceTierLabel } from "@/lib/labels";
import { createPortal } from "react-dom";
import {
  type Tier, type PaymentMethod, type NumMode, type PosRow, type CartItem, type POSTab, type Receipt, type ShiftData,
  type PosColors as C,
  lineIdOf, POS_COLORS, fmt, money, effectivePrice, itemTotal, buildSaleLine, createTab, CASHIER_INVOICE_DISCOUNT_MAX_PCT, buildBrandedReceipt, computeInvoiceDiscount,
} from "@/components/pos/posShared";
import { useSmartScanInput } from "@/components/pos/useSmartScanInput";
import { POSHeader } from "@/components/pos/POSHeader";
import { TabBar } from "@/components/pos/TabBar";
import { CartPanel } from "@/components/pos/CartPanel";
import { PaymentPanel } from "@/components/pos/PaymentPanel";
import { ReceiptOverlay } from "@/components/pos/ReceiptOverlay";
import { ShiftCloseDialog } from "@/components/pos/ShiftCloseDialog";
import { CreditApprovalDialog } from "@/components/pos/CreditApprovalDialog";
import { RetailPosHeaderActions } from "@/components/pos/RetailPosHeaderActions";

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
    if (digitalCheckoutRef.current?.tabId === id) return;
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
  // الاستجابات المتأخرة للكوبونات يجب ألا تغيّر أسعار سلة صار فيها رقميّ.
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
  const discountCalc = computeInvoiceDiscount({
    subtotalD,
    effectiveHeaderCapPctD,
    invoiceDiscountAllowed,
    type: activeTab.invoiceDiscountType ?? "percent",
    value: activeTab.invoiceDiscountValue ?? (activeTab.invoiceDiscountPct || ""),
  });
  const invoiceDiscountAmountD = discountCalc.discountAmountD;
  const invoiceDiscountAmount = discountCalc.discountAmount;
  const invoiceDiscountPctD = discountCalc.discountPctD;
  const maxDiscountAmount = discountCalc.maxDiscountAmount;
  const subtotal = round2(subtotalD).toNumber();
  // netAfterHeaderD = ما تفرضه محاسبة الفاتورة (يُخزَّن `discountAmount` و`total` بهذا). قد لا
  // يكون مضاعفاً للـ٢٥٠ ⇒ التقريب النقديّ يعمل عليه لاحقاً لِـcashFull.
  const netAfterHeaderD = subtotalD.minus(invoiceDiscountAmountD);
  const paidD   = D(activeTab.payInput || 0);
  // §٩ IQD denomination rounding: البيع النقديّ الكامل يُقرَّب على أقرب ٢٥٠ د.ع (سياسة المالك).
  // effectiveTotalD = ما **يقبضه الكاشير فعلياً** (ما تظهره الشاشة، ما يُرسَل payment.amount).
  // الفرق `netAfterHeaderD − effectiveTotalD` قيدُ ADJUST_ROUNDING خادمياً (§ ٥ من دليل النظام).
  const cashRoundedTotalD = activeTab.method === "CASH" && !cartHasDigital
    ? roundCashIQD(netAfterHeaderD.toFixed(2))
    : netAfterHeaderD;
  const cashRoundedPaidD = activeTab.method === "CASH" && !cartHasDigital ? roundCashIQD(paidD.toFixed(2)) : paidD;
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
    if (row.price == null) {
      notify.err(`لا سعر لـ ${row.productName} (${row.unitName}) في فئة ${priceTierLabel(effectiveTier)}`);
      return;
    }
    if (receipt) setReceipt(null);
    if (activeTab.couponCode) patchActive({ couponCode: null, couponLabel: null });
    // صفوف الكتالوج الأوفلايني القديمة لا تحمل branchId؛ نربط الصف المضاف بالفرع الحالي صراحةً.
    const currentRow = { ...row, branchId: row.branchId ?? branchId };
    setCart((raw) => {
      const prev = resetCouponItems(raw);
      const i = prev.findIndex((c) => !c.digital && c.row.productUnitId === currentRow.productUnitId);
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
  // تثبيت سياق الطلب: تبديل تبويب أثناء الشبكة لا يمسح سلة أخرى ولا يغيّر المبلغ.
  const digitalCheckoutRef = useRef<{
    tabId: number; requestId: string; total: string; received: string;
    method: "CASH" | "CARD"; customerId: number | null; customerName?: string; shiftId: number;
  } | null>(null);

  const digitalLines = cart.filter((c) => c.digital);

  /** بصمة سلّة الكروت: تربط النيّة بمحتواها فيُرفض إعادة استعمال المفتاح بسلّةٍ أخرى. */
  function digitalCartFingerprint(): string {
    const basis = JSON.stringify({ customerId: activeTab.customerId, tier: effectiveTier, lines: cart.map((c) => c.digital
      ? { ...c.digital, price: c.row.price, quantity: c.qty }
      : buildSaleLine(c)) });
    let h = 0;
    for (let i = 0; i < basis.length; i++) h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0;
    return `dc${(h >>> 0).toString(16)}${basis.length.toString(16)}`;
  }

  const prepareIntent = trpc.digitalCards.sales.prepare.useMutation({
    onSuccess: (r) => setFulfillIntentId(r.intentId),
    onError: (e) => { digitalCheckoutRef.current = null; notify.err(e); },
  });

  /** ش٨: التثبيت المالي — الفاتورة والقبض والتسوية والتفاصيل في معاملة خادمية واحدة. */
  const finalizeSale = trpc.digitalCards.sales.finalize.useMutation({
    onSuccess: (r) => {
      const checkout = digitalCheckoutRef.current;
      if (!checkout) return;
      const now = new Date();
      // §١٢.٣: الإيصال يُبنى من استجابة الخادم (السعر والمرجع وبيانات الطالب) لا من حالة React.
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        invoiceId: r.invoiceId,
        date: fmtDate(now),
        printDate: fmtDate(now),
        printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        cashierName: me.data?.name ?? undefined,
        shiftId: checkout.shiftId,
        customerName: checkout.customerName,
        lines: digitalCheckoutReceiptLines(r.receiptLines),
        total: D(r.total).toNumber(),
        received: D(checkout.received).toNumber(),
        change: D(checkout.received).gt(r.total) ? D(checkout.received).minus(r.total).toNumber() : 0,
        credit: 0,
        method: checkout.method,
        isCredit: false,
        digitalDetails: r.printDetails,
      };
      setFulfillIntentId(null);
      // مفتاح جديد للتبويب: الفاتورة التالية عمليةٌ مستقلّة (نفس اصطلاح البيع العادي).
      patchTab(checkout.tabId, { cart: [], selId: null, payInput: "", clientRequestId: crypto.randomUUID(), couponCode: null, couponLabel: null, paymentRef: "", externalPayment: null, invoiceDiscountPct: "" });
      digitalCheckoutRef.current = null;
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
    if (!shift || digitalCheckoutRef.current || prepareIntent.isPending || fulfillIntentId != null || finalizeSale.isPending) return;
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
    if (activeTab.payInput.trim() && paidD.lt(total)) {
      notify.err("فاتورة البطاقات تتطلب دفع المبلغ كاملاً؛ صحّح المقبوض أو امسح الحقل للدفع الكامل.");
      return;
    }
    digitalCheckoutRef.current = {
      tabId: activeTab.id, requestId: activeTab.clientRequestId, total: D(total).toFixed(2),
      received: paidD.gt(total) ? paidD.toFixed(2) : D(total).toFixed(2),
      method: activeTab.method, customerId: activeTab.customerId ?? null, customerName: selectedCustomer?.name, shiftId: shift.id,
    };
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
      customerId: activeTab.customerId,
      priceTier: effectiveTier,
      regularLines: cart.filter((c) => !c.digital).map((c) => ({ lineKey: `regular-${c.row.productUnitId}`, ...buildSaleLine(c) })),
      lines: digitalLines.map((c) => ({
        lineKey: c.digital!.lineKey,
        offeringId: c.digital!.offeringId,
        priceVersionId: c.digital!.priceVersionId,
        expectedSellPrice: String(c.row.price ?? "0"),
        providerReference: c.digital!.providerReference,
        providerBasketKey: c.digital!.providerBasketKey,
        student: c.digital!.student ?? null,
      })),
    });
  }

  /** إضافة السلة ذرّياً محلياً؛ كل بطاقة سطر مستقل مرتبط بعملية المزوّد. */
  function addDigitalBasket(basket: DigitalBasketCapture) {
    if (digitalCheckoutRef.current || digitalLines.length + basket.lines.length > 50) return;
    cartHasDigitalRef.current = true;
    if (receipt) setReceipt(null);
    patchActive({ couponCode: null, couponLabel: null, invoiceDiscountPct: "" });
    // المعرّف يُشتقّ من **السلة نفسها** لا من عدّاد في ref: السلة تبقى عبر إعادة تركيب الصفحة
    // (تبديل مسار/تبويب) بينما الـref يعود للصفر ⇒ تصادم مفاتيح React. أقلّ معرّف ناقص واحد.
    const firstLineId = Math.min(0, ...cart.map((c) => c.digital?.lineId ?? 0)) - 1;
    const added: CartItem[] = basket.lines.map(({ card, student }, index) => {
    const lineId = firstLineId - index;
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
    return {
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
          providerReference: basket.providerReference,
          providerBasketKey: basket.providerBasketKey,
          faceValue: card.faceValue,
          subscriptionDurationDays: card.subscriptionDurationDays,
          requiresStudentData: card.requiresStudentData,
          student,
        },
      };
    });
    setCart((raw) => [...resetCouponItems(raw), ...added]);
    setSelId(firstLineId);
    setSearch(""); setShowDrop(false);
  }

  // ── Barcode ───────────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(async (code: string) => {
    if (!code) return;
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
      if (cartHasDigitalRef.current) return;
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
    if (cartHasDigital) return notify.err("الكوبونات غير متاحة لفاتورة تحتوي بطاقات رقمية");
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
    // الفاتورة المختلطة تمر بالنواة الرقمية التي تثبت جميع بنودها في معاملة واحدة.
    if (cart.some((c) => c.digital)) {
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
      if (digitalCheckoutRef.current) return;
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt)      { if (e.key === "Escape" || e.key === "Enter") { setReceipt(null); setTimeout(() => searchRef.current?.focus(), 0); } return; }
      if (shifting)     { if (e.key === "Escape") setShifting(false); return; }
      if (cashDropping) { if (e.key === "Escape") setCashDropping(false); return; }
      // نافذة البطاقات مفتوحة: Escape تُغلقها وتتكفّل هي بمفاتيحها (لا تصل الاختصارات العامة).
      if (cardsOpen) { if (e.key === "Escape") setCardsOpen(false); return; }
      switch (e.key) {
        case "F2":  e.preventDefault(); searchRef.current?.focus(); break;
        // §٨.٧: مفتاح فتح شبكة الكروت. F4 محجوز للدفع وF9 للطباعة وF12 للتفريغ ⇒ F3.
        case "F3":  e.preventDefault(); if (!offline) setCardsOpen(true); break;
        case "F4":  e.preventDefault(); if (cart.length && !sale.isPending) submitSale(); break;
        case "F9":  e.preventDefault(); if (receipt) void printReceipt(buildBrandedReceipt(receipt)).then((printed) => {
          if (!printed.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
        }).catch((error) => notify.err(error)); break;
        case "F10":
          e.preventDefault();
          void openCashDrawer().then((res) => {
            if (res.ok) notify.ok("تم فتح درج النقود");
            else notify.err("تعذّر فتح الدرج", "تأكد من توصيل الطابعة الحرارية وربطها");
          });
          break;
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
  }, [cart, sale.isPending, receipt, creditPrompt, shifting, cashDropping, cardsOpen, offline, externalPaymentConfirmed]);

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
    (activeTab.payInput === "" || paid >= total || (!cartHasDigital && isCredit && activeTab.customerId != null)) &&
    externalPaymentConfirmed;

  return (
    <div className="retail-pos-surface" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>
      {prepareIntent.isPending && <div role="status" aria-live="polite" style={{ position: "fixed", inset: 0, zIndex: 63, background: C.overlay, display: "grid", placeItems: "center" }}><div style={{ background: C.card, border: `1px solid ${C.border}`, padding: 24 }}>{ACTION_LABELS.verifying} تثبيت بنود الفاتورة قبل تأكيد عمليات المزوّد.</div></div>}

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
        cardsDisabled={offline}
        cardsDisabledReason={offline ? "البيع الرقمي يحتاج اتصالاً بالخادم" : undefined}
        branchName={activeBranchName}
      />

      {headerActionsNode && createPortal(
        <RetailPosHeaderActions
          placement="inline"
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

      {cartHasDigital && (
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
          البطاقات والمنتجات في فاتورة واحدة. الدفع كامل نقداً أو ببطاقة، دون خصم فاتوري أو كوبون، مع اتصال بالخادم.
        </div>
      )}

      {/* شبكة البطاقات الرقمية (ش٥) — لا أثر ماليّ عند الإضافة، فقط سطرٌ في السلة بسعر الخادم. */}
      <DigitalCardsPickerDialog
        open={cardsOpen}
        branchId={branchId}
        offline={offline}
        onClose={() => setCardsOpen(false)}
        onPickBasket={addDigitalBasket}
        existingCardCount={digitalLines.length}
        existingReferences={digitalLines.map((c) => ({
          providerId: c.digital!.providerId,
          providerReference: c.digital!.providerReference,
        }))}
      />

      {/* خطوات التنفيذ الخارجيّ (ش٧) — كل كرت يُسجَّل نجاحه لحظةَ إصداره. */}
      <DigitalFulfillmentDialog
        intentId={fulfillIntentId}
        finalizing={finalizeSale.isPending} finalizeError={finalizeSale.error ? errMsg(finalizeSale.error) : null}
        onClose={() => { setFulfillIntentId(null); digitalCheckoutRef.current = null; }}
        onAllExecuted={(intentId) => {
          // كل الكروت صدرت ⇒ التثبيت المالي فوراً. المفتاح نفسه يجعل إعادة الإرسال تُعيد
          // الفاتورة ذاتها بدل إنشاء ثانية (idempotency على مستوى الخادم).
          const checkout = digitalCheckoutRef.current;
          if (finalizeSale.isPending || !checkout) return;
          finalizeSale.mutate({
            intentId,
            clientRequestId: checkout.requestId,
            paymentAmount: checkout.total,
            paymentMethod: checkout.method,
            customerId: checkout.customerId,
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
          setInvoiceDiscountPct={(v) => patchActive({ invoiceDiscountPct: v, invoiceDiscountValue: v, invoiceDiscountType: "percent" })}
          invoiceDiscountType={activeTab.invoiceDiscountType ?? "percent"}
          invoiceDiscountValue={activeTab.invoiceDiscountValue ?? (activeTab.invoiceDiscountPct || "")}
          onInvoiceDiscountChange={(val, typ) => {
            patchActive({
              invoiceDiscountValue: val,
              invoiceDiscountType: typ,
              invoiceDiscountPct: typ === "percent" ? val : (discountCalc.discountPct > 0 ? String(discountCalc.discountPct) : ""),
            });
          }}
          maxDiscountAmount={maxDiscountAmount}
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
          isPending={sale.isPending || prepareIntent.isPending || finalizeSale.isPending}
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
          couponPending={couponPreview.isPending || cartHasDigital}
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

