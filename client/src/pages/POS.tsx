import { digitalRecoveredReceiptMoney } from "@/components/pos/posShared";
import { DigitalWorkspaceRecovery, useDurableDigitalSale, type DigitalWorkspaceCommand } from "@/components/digitalCards/useDurableDigitalSale";
import { digitalWorkspaceScopes, loadFinancialIntent, type FinancialIntentScope } from "@/lib/persistedFinancialIntent";
import { deliveryFeeTenderForGoods } from "@/components/pos/feeTenderUi";
/**
 * نقطة البيع — الرؤية العربية
 * تصميم Odoo 19-style مع multi-tab، حاسبة ذكية، مسح باركود آني، وإدارة وردية كاملة.
 */
import { newClientRequestId } from "@/lib/countQueue";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { notify, errMsg } from "@/lib/notify";
import { D, round2 } from "@/lib/money";
import { usePOSShiftOpening } from "@/hooks/usePOSShiftOpening";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { printPosDeliveryShippingLabel, printCashDropReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { useInvoiceReceiptPrinter } from "@/hooks/useInvoiceReceiptPrinter";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { useMediaQuery } from "@/hooks/useMobile";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import { usePosCartPromotions } from "@/components/pos/usePosCartPromotions";
import {
  clearActiveOfflineCaptureGrant,
  getDeviceCode,
  setActiveOfflineCaptureGrant,
} from "@/lib/offline/outbox";
import {
  getCachedOfflinePermSnapshotSync,
  readCrossTabSessionEpoch,
  resolveOfflinePermSnapshot,
  subscribeOfflineUnlock,
} from "@/lib/offline/pinLock";
import { setMeta } from "@/lib/offline/db";
import { POSUnconfirmedSaleBanner } from "@/components/pos/POSUnconfirmedSaleBanner";
import { usePOSPreflightReconciliation } from "@/components/pos/usePOSPreflightReconciliation";
import {
  buildPosSaleReceiptContext,
  type POSSaleReceiptContext,
  restorePosReceiptContextFromPreflightIntent,
  usePOSOfflineCapture,
} from "@/components/pos/usePOSOfflineCapture";
import { usePOSExternalPayment } from "@/components/pos/usePOSExternalPayment";
import { DigitalCardsPickerDialog, type DigitalBasketCapture } from "@/components/pos/DigitalCardsPickerDialog";
import { RecipeVariantPickerDialog } from "@/components/recipe/RecipeVariantPickerDialog";
import { useRetailPosCustomizableLines } from "@/components/recipe/usePrintCustomizableLines";
import { DigitalFulfillmentDialog } from "@/components/pos/DigitalFulfillmentDialog";
import { digitalCheckoutReceiptLines } from "@/lib/printing/digitalReceiptLines";
import { trpc } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { reconcilePosTabsStock } from "@/lib/posStockRefresh";
import { ACTION_LABELS } from "@shared/actionLabels";
import { applyPosQuantityKey } from "@/lib/posQuantityEntry";
import { priceTierLabel } from "@/lib/labels";
import { applyCustomerIdentity, deliveryBlocksOfflineCapture, deliveryModeUnavailableReason, deliverySendsPayment, OFFLINE_DELIVERY_BLOCK, saleReceiptAmounts } from "@/components/pos/deliveryMode";
import { createPortal } from "react-dom";
import {
  type Tier, type PaymentMethod, type NumMode, type PosRow, type CartItem, type POSTab, type Receipt, type ShiftData,
  type PosColors as C,
  lineIdOf, nextCartLineId, POS_COLORS, fmt, money, buildSaleLine, createTab, buildPosReceiptPromoSummary,
} from "@/components/pos/posShared";
import { serializeRecipeSelectionsKey } from "@shared/recipeVariantSelection";
import { POSHeader } from "@/components/pos/POSHeader";
import { TabBar } from "@/components/pos/TabBar";
import { CartPanel } from "@/components/pos/CartPanel";
import { PaymentPanel } from "@/components/pos/PaymentPanel";
import { useCashierExtraCharges, savedCheckout } from "@/components/pos/useCashierExtraCharges";
import {checkoutExtraTotal,checkoutExtraPayload,clearedChargeOnlyTender,checkoutGoodsTenderAmount} from "@/components/pos/checkoutExtraAmounts";
import { POSOverlays } from "@/components/pos/POSOverlays";
import { RetailPosHeaderActions } from "@/components/pos/RetailPosHeaderActions";
import type { ManagerApprovalInput } from "@shared/managerApproval";
import { POSFundingBanner } from "@/components/pos/POSFundingBanner";
import { POSShiftOpenScreen } from "@/components/pos/POSShiftOpenScreen";
import { usePOSTabsDraft } from "@/components/pos/usePOSTabsDraft";
import { usePOSPrinter } from "@/components/pos/usePOSPrinter";
import { usePOSKeyboardShortcuts } from "@/components/pos/usePOSKeyboardShortcuts";
import {
  computePOSTotals,
  evaluatePosCreditPrompt,
  parsePosLegAmountD,
  validatePosSaleBeforeSubmit,
} from "@/components/pos/posTotals";
import { usePOSOfflineBoot } from "@/components/pos/usePOSOfflineBoot";
import { usePOSCatalogSearch } from "@/components/pos/usePOSCatalogSearch";
import { usePOSTabHelpers } from "@/components/pos/usePOSTabHelpers";
import { applyPosCouponPreviewToTabs, buildPosCouponPreviewInput, capturePosCouponPreviewSnapshot, isPosCouponPreviewFresh } from "@/components/pos/posCouponPreview";

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

  // ش٥ — إقلاع دون اتصال: هوية الجهاز وورديته من آخر جلسة أونلاين معلومة
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const { offlineBoot, offlineSaleOn } = usePOSOfflineBoot(me.data);
  const { printAuthorizedReceipt, printAuthorizedDocument, receiptPrinting } = useInvoiceReceiptPrinter(me.data, offlineBoot?.userId);
  const branchId = me.data?.branchId ?? offlineBoot?.branchId ?? pickedBranch ?? 1;
  const activeBranchName = (branches.data ?? []).find((branch) => Number(branch.id) === branchId)?.name ?? `فرع #${branchId}`;
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";
  const noAssignedBranch = me.data != null && me.data.branchId == null && offlineBoot?.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && pickedBranch == null;
  useOfflineCatalogSync(me.data ? branchId : null);

  const shiftQueryStartedEpochRef = useRef<number>(readCrossTabSessionEpoch());
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId, shiftType: "RETAIL" },
    {
      enabled: !offline,
      refetchInterval: !offline ? 15 * 60_000 : false,
      refetchOnWindowFocus: !offline,
    },
  );
  useEffect(() => {
    if (shiftQ.isFetching) {
      shiftQueryStartedEpochRef.current = readCrossTabSessionEpoch();
    }
  }, [shiftQ.isFetching]);
  useEffect(() => {
    if (!offline && me.data?.id) {
      shiftQueryStartedEpochRef.current = readCrossTabSessionEpoch();
      void shiftQ.refetch();
    }
  }, [offline, me.data?.id]);
  // العهدة لا تصل إلى الدرج بمجرد طلب المالك. نظهرها في محطة الكاشير نفسها كي
  // يؤكد الاستلام الفعلي، بدل الاعتماد على رابط إداري مخفي عن تنقله.
  const fundingRequestsQ = trpc.shifts.fundingRequests.useQuery(undefined, { enabled: me.data != null && !offline });
  const acceptFundingM = trpc.shifts.respondFunding.useMutation({
    onSuccess: async (res) => {
      if (res.status === "COMPLETED") void printCashDropReceipt({ dropNumber: res.referenceNumber, shiftId: res.shiftId, amount: res.amount, destinationLabel: "تمويل مستلم في عهدة الدرج", branchName: activeBranchName, cashierName: me.data?.name, reason: `سند استلام تمويل عهدة — ${res.evidenceNote}` }).catch(() => {}).finally(() => releaseReservedPrintWindow());
      else releaseReservedPrintWindow();
      notify.ok("أضيفت العهدة إلى الدرج بعد تأكيد الاستلام");
      await Promise.all([fundingRequestsQ.refetch(), shiftQ.refetch()]);
    },
    onError: (error) => { releaseReservedPrintWindow(); notify.errBig(error); },
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

  useEffect(() => {
    if (shiftQ.data?.id) {
      void setMeta("lastOpenShift", JSON.stringify({ id: shiftQ.data.id, branchId }));
      void setActiveOfflineCaptureGrant(shiftQ.data.offlineCaptureGrant ?? null, {
        expectedSessionEpoch: shiftQueryStartedEpochRef.current,
        expectedUserId: me.data?.id ?? null,
      });
    } else if (shiftQ.isSuccess && !shiftQ.data) {
      void setMeta("lastOpenShift", "");
      void clearActiveOfflineCaptureGrant("no_open_shift_on_server");
    }
  }, [shiftQ.data?.id, shiftQ.data?.offlineCaptureGrant, shiftQ.isSuccess, branchId, me.data?.id]);

  const viewerUserId = me.data?.id ?? offlineBoot?.userId ?? null;
  const viewerCanAdminReconcile = Boolean(
    me.data && (me.data.isOwner || me.data.role === "admin" || me.data.role === "manager"),
  );

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
  const rawCart   = activeTab.cart;

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
  const { printerReady, setPrinterReady, bridge, connectPrinter, testServerPrint } = usePOSPrinter();
  const [showCustPicker, setShowCustPicker] = useState(false);
  const [headerActionsNode, setHeaderActionsNode] = useState<HTMLElement | null>(null);
  const [confirmingLegId, setConfirmingLegId] = useState<string | null>(null);

  useEffect(() => {
    setHeaderActionsNode(document.getElementById("pos-header-actions"));
  }, []);

  // تحت 1024px (اللوحي/الأصغر) تُكدَّس لوحتا الكاشير عمودياً بدل الصفّ الأفقي ذي العرض الثابت.
  // القيد الحاكم عند زوم المتصفح هو الارتفاع لا العرض (الزوم يُقلّص المساحة بوحدات CSS)،
  // فتُضاف عتبة ارتفاع وإلّا بقيت البنية أفقيّةً في علبةٍ لا تتّسع لها.
  const stacked = useMediaQuery("(max-width: 1023px), (max-height: 620px)");

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyEntryRef = useRef({ tabId: activeId, lineId: null as number | null, replaceNextDigit: true });
  const cartRevisionRef = useRef(0);
  const couponReqSeqRef = useRef(0);
  // تثبيت سياق الطلب: تبديل تبويب أثناء الشبكة لا يمسح سلة أخرى ولا يغيّر المبلغ.
  const digitalCheckoutRef = useRef<{
    tabId: number; requestId: string; total: string; received: string;
    method: "CASH" | "CARD"; customerId: number | null; customerName?: string; shiftId: number;
  } | null>(null);

  // ── Tab helpers ───────────────────────────────────────────────────────────
  const {
    patchTab, patchActive, setCart, setPayInput, setSelId, setNumMode, setMethod,
    enableSplitPayment, disableSplitPayment, addPaymentLeg, updatePaymentLeg, removePaymentLeg, patchLegExternalPayment,
    resetCouponItems, clearAppliedCoupon, setCustId, setTierOvr, addTab, closeTab, numPress,
  } = usePOSTabHelpers({
    tabs, setTabs, activeId, setActiveId, activeIdRef, qtyEntryRef,
    digitalCheckoutRef, cartRevisionRef, activeTab, setSearch, setShowDrop, searchRef,
  });

  // ── Cart draft — عزل صريح بالفرع + المستخدم + الوردية ───────────────────
  const {restoredDraftKey}=usePOSTabsDraft({
    shiftId: shift?.id,
    userId: me.data?.id ?? offlineBoot?.userId,
    branchId,
    tabs,
    setTabs,
    activeId,
    setActiveId,
  });

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
  const isCashOnlyCustomer = selectedCustomer != null && selectedCustomer.creditLimit != null && Number(selectedCustomer.creditLimit) === 0;
  const effectiveTier: Tier =
    activeTab.tierOverride ??
    (selectedCustomer?.defaultPriceTier as Tier | undefined) ??
    "RETAIL";

  const onAutoFreeShipping = useCallback((d: NonNullable<POSTab["delivery"]>) => patchTab(activeTab.id, { delivery: d }), [activeTab.id, patchTab]);
  const { cart, freeShippingPromoName } = usePosCartPromotions({
    rawCart, branchId, effectiveTier, offline, couponCode: activeTab.couponCode,
    couponFreeShippingPromo: activeTab.couponFreeShippingPromo, tabId: activeTab.id, delivery: activeTab.delivery, onAutoFreeShipping,
  });

  // §٥: حساب الإجمالي/المدفوع/الباقي/الفكّة بدقّة Decimal (لا JS Number) عبر computePOSTotals
  const {
    subtotalD,
    subtotal,
    cartHasDigital,
    cartAllDigital,
    invoiceDiscountAllowed,
    referenceGrossD,
    effectiveHeaderCapPctD,
    discountCalc,
    invoiceDiscountAmountD,
    invoiceDiscountAmount,
    invoiceDiscountPctD,
    maxDiscountAmount,
    netAfterHeaderD,
    codMode,
    deliveryPayload,
    paidD,
    cashRoundedTotalD,
    cashRoundedPaidD,
    cashRoundedTotal,
    cashRoundedPaid,
    isCredit,
    isChange,
    effectiveTotalD,
    total,
    paid,
    change,
    credit,
    cashRoundingDelta,
    isSplitPayment,
    splitInvalidLeg,
    splitNonCashOverpay,
    externalPaymentAmount, deliveryFeeHeldD,
    externalPaymentFingerprint,
    externalPaymentConfirmed,
  } = computePOSTotals({ cart, activeTab });
  const offlinePermSnap = useSyncExternalStore(
    subscribeOfflineUnlock,
    () => getCachedOfflinePermSnapshotSync(offlineBoot?.userId ?? null),
    () => getCachedOfflinePermSnapshotSync(offlineBoot?.userId ?? null),
  );
  useEffect(() => {
    if (!me.data && offline && offlineBoot?.userId) {
      void resolveOfflinePermSnapshot(offlineBoot.userId, branchId).catch(() => null);
    }
  }, [me.data, offline, offlineBoot?.userId, branchId]);
  // v4 fail-closed: when `me.data` is absent offline, NEVER default `canSubmitSale` to true!
  // Require a valid, AAD-decrypted, non-expired `offlinePermSnap` authorizing retail sales.create.
  const canSubmitSale = me.data
    ? cartHasDigital
      ? lifecycleActionAllowed(me.data, "digitalCards.sales.prepare", true) &&
        lifecycleActionAllowed(me.data, "digitalCards.sales.finalize", true)
      : lifecycleActionAllowed(me.data, "sales.create", true)
    : Boolean(offline && !cartHasDigital && offlinePermSnap?.canCreateRetailSale === true);
  const cartHasDigitalRef = useRef(cartHasDigital);
  cartHasDigitalRef.current = cartHasDigital;

  // ── Cart ops ──────────────────────────────────────────────────────────────
  const retailCustom = useRetailPosCustomizableLines({
    branchId, offline, resetCouponItems, setCart, setSelId, onAdded: () => setAddTick((t) => t + 1),
  });
  function addRow(row: PosRow) {
    if (row.price == null) {
      notify.err(`لا سعر لـ ${row.productName} (${row.unitName}) في فئة ${priceTierLabel(effectiveTier)}`);
      return;
    }
    if (receipt) setReceipt(null);
    if (activeTab.couponCode) patchActive({ couponCode: null, couponLabel: null, couponFreeShippingPromo: null });
    retailCustom.addOrPromptRow(row);
    setSearch(""); setShowDrop(false);
    searchRef.current?.focus();
  }

  function changeItemUnit(oldLineId: number, newRow: PosRow) {
    if (receipt) setReceipt(null);
    if (activeTab.couponCode) patchActive({ couponCode: null, couponLabel: null, couponFreeShippingPromo: null });
    const currentRow = { ...newRow, branchId: newRow.branchId ?? branchId };
    let nextSelId = currentRow.productUnitId;
    setCart((raw) => {
      const prev = resetCouponItems(raw);
      const i = prev.findIndex((c) => !c.digital && lineIdOf(c) === oldLineId);
      if (i < 0) return prev;
      const target = prev[i];
      const targetKey = serializeRecipeSelectionsKey(target.recipeSelections);
      const dupIdx = prev.findIndex(
        (c, idx) =>
          idx !== i &&
          !c.digital &&
          c.row.productUnitId === currentRow.productUnitId &&
          serializeRecipeSelectionsKey(c.recipeSelections) === targetKey,
      );
      if (dupIdx >= 0) {
        const merged = { ...prev[dupIdx], qty: prev[dupIdx].qty + target.qty, row: currentRow };
        nextSelId = lineIdOf(merged);
        const next = prev.filter((_, idx) => idx !== i && idx !== dupIdx);
        next.unshift(merged);
        return next;
      }
      const next = [...prev];
      const updated = { ...target, row: currentRow, disc: undefined, origPrice: undefined };
      nextSelId = lineIdOf(updated);
      next[i] = updated;
      return next;
    });
    setSelId(nextSelId);
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

  const digitalScope: FinancialIntentScope | null = me.data?.id && branchId > 0 ? {companyId:me.data.companyId??null,userId:me.data.id,branchId,operation:"DIGITAL_POS",target:`tab:${activeId}`} : null;
  useEffect(()=>{
    if(!digitalScope || !restoredDraftKey)return;
    let live=true;
    void digitalWorkspaceScopes(digitalScope).then(scopes=>{if(live)setTabs(old=>{
      const missing=scopes.map(x=>Number(x.target.slice(4))).filter(id=>!old.some(tab=>tab.id===id));
      return missing.length?[...old,...missing.map(id=>createTab(id,`طلب ${id}`))]:old;
    });}).catch(notify.err);return()=>{live=false;};
  },[restoredDraftKey,branchId,me.data?.id,me.data?.companyId]);
  const durable=useDurableDigitalSale(digitalScope,{
    onError:(err)=>{releaseReservedPrintWindow();notify.err(err);},
    onNotAdmitted:()=>{patchTab(activeId,{clientRequestId:crypto.randomUUID()});notify.ok("أُغلق الطلب المرفوض بلا قبض؛ صحح السلة");},
    onRefunded:()=>{digitalCheckoutRef.current=null;patchTab(activeId,{cart:[],clientRequestId:crypto.randomUUID(),externalPayment:null,paymentRef:""});notify.ok("أُغلق أمر البيع بعد رد كامل القبض");},
    onCompleted:(r,c)=>{
      const checkout={tabId:activeId,received:c.received,method:c.prepare.paymentMethod as "CARD"|"CASH",shiftId:c.prepare.shiftId,customerName:c.customerName};
      const now = new Date();
      // §١٢.٣: الإيصال يُبنى من استجابة الخادم (السعر والمرجع وبيانات الطالب) لا من حالة React.
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        invoiceId: r.invoiceId,
        date: fmtDate(now),
        printDate: fmtDate(now),
        printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        cashierName: me.data?.name ?? undefined,
        shiftId: r.shiftId,
        customerName: checkout.customerName,
        lines: digitalCheckoutReceiptLines(r.receiptLines),
        ...digitalRecoveredReceiptMoney(r,c.received),
        digitalDetails: r.printDetails,
      };
      // مفتاح جديد للتبويب: الفاتورة التالية عمليةٌ مستقلّة (نفس اصطلاح البيع العادي).
      patchTab(checkout.tabId, { cart: [], selId: null, payInput: "", clientRequestId: crypto.randomUUID(), couponCode: null, couponLabel: null, paymentRef: "", externalPayment: null, invoiceDiscountPct: "" });
      digitalCheckoutRef.current = null;
      setReceipt(rec);
      notify.ok(`تمّت الفاتورة ${r.invoiceNumber}`, `الإجمالي ${r.total} د.ع — سُجِّلت الكروت وتسوية المزوّد.`);
      void utils.shifts.current.invalidate();
      void printAuthorizedReceipt(rec)
        .then((printed) => {
          if (!printed.ok) notify.warn("تعذّرت الطباعة التلقائية", "حجب المتصفح نافذة الطباعة — الفاتورة محفوظة ويمكن إعادة طباعتها.");
        })
        .catch((cause) => {
          notify.warn("الفاتورة محفوظة؛ تعذّرت الطباعة التلقائية", errMsg(cause));
        });
    },
  });

  /** يبدأ مسار البيع الرقميّ: تحقّقٌ خادميّ + حجز رصيد، **قبل** لمس جهاز المزوّد. */
  async function startDigitalFulfillment(bankProof?:{requestId:string;reference:string;deviceId:string}) {
    if (!shift || !durable.ready || durable.pending || durable.busy || !canSubmitSale) return;
    const validation=validatePosSaleBeforeSubmit({activeTab,cart,codMode,isSplitPayment,splitInvalidLeg,splitNonCashOverpay,externalPaymentConfirmed:bankProof?true:externalPaymentConfirmed,isCredit});
    if(validation || checkoutExtraTotal(activeTab.extraCharges).gt(0)){notify.err(validation??"أكمل الكروت قبل إضافة أجر خدمة مستقل");return;}
    // م١ PR-B (تدقيق Codex P1): نواةُ التثبيت الرقميّة لا تُنشئ إرساليّةَ توصيل — سلّةٌ رقميّة/مختلطة في
    // وضع التوصيل تُنتج فاتورةً ماديّةً بلا إسناد. نرفضها بدل إسقاط الإسناد صامتاً.
    if (codMode) { notify.err("التوصيل لا يشمل البطاقات الرقميّة", "أزِل البطاقات الرقميّة من السلّة، أو أوقِف وضع التوصيل لبيعها منفصلة."); return; }
    if (offline) {
      notify.errBig("لا بيع رقميّ دون اتصال", "الكروت تحتاج الخادم للتحقّق من السعر والتنفيذ.");
      return;
    }
    if (activeTab.method !== "CASH" && activeTab.method !== "CARD") { notify.err("البيع الرقميّ نقداً أو ببطاقة فقط"); return; }
    if (activeTab.method === "CARD" && !bankProof) { notify.err("أكّد دفع البطاقة الخارجي قبل بدء إصدار الكروت."); return; }
    if (activeTab.payInput.trim() && paidD.lt(total)) {
      notify.err("فاتورة البطاقات تتطلب دفع المبلغ كاملاً؛ صحّح المقبوض أو امسح الحقل للدفع الكامل.");
      return;
    }
    digitalCheckoutRef.current = {
      tabId: activeTab.id, requestId: activeTab.clientRequestId, total: D(total).toFixed(2),
      received: paidD.gt(total) ? paidD.toFixed(2) : D(total).toFixed(2),
      method: activeTab.method, customerId: activeTab.customerId ?? null, customerName: selectedCustomer?.name, shiftId: shift.id,
    };
    reservePrintWindow();
    const command: DigitalWorkspaceCommand = {proof:bankProof,received:digitalCheckoutRef.current.received,amount:digitalCheckoutRef.current.total,customerName:selectedCustomer?.name,prepare:{
      sourceType:"POS",clientRequestId: activeTab.clientRequestId,
      branchId,
      shiftId: shift.id,
      paymentMethod: activeTab.method,
      cartFingerprint: digitalCartFingerprint(),
      customerId: activeTab.customerId,
      priceTier: effectiveTier,
      regularLines: cart.filter((c) => !c.digital).map((c) => ({ lineKey: `regular-${lineIdOf(c)}`, ...buildSaleLine(c) })),
      lines: digitalLines.map((c) => ({
        lineKey: c.digital!.lineKey,
        offeringId: c.digital!.offeringId,
        priceVersionId: c.digital!.priceVersionId,
        expectedSellPrice: String(c.row.price ?? "0"),
        providerReference: c.digital!.providerReference,
        providerBasketKey: c.digital!.providerBasketKey,
        student: c.digital!.student ?? null,
      })),
    }};
    await durable.start(command); digitalCheckoutRef.current=null;
  }

  /** إضافة السلة ذرّياً محلياً؛ كل بطاقة سطر مستقل مرتبط بعملية المزوّد. */
  function addDigitalBasket(basket: DigitalBasketCapture) {
    if (digitalCheckoutRef.current || digitalLines.length + basket.lines.length > 50) return;
    cartHasDigitalRef.current = true;
    if (receipt) setReceipt(null);
    patchActive({ couponCode: null, couponLabel: null, couponFreeShippingPromo: null, invoiceDiscountPct: "" });
    // المعرّف يُشتقّ من **السلة نفسها** لا من عدّاد في ref: السلة تبقى عبر إعادة تركيب الصفحة
    // (تبديل مسار/تبويب) بينما الـref يعود للصفر ⇒ تصادم مفاتيح React. أقلّ معرّف ناقص واحد.
    const firstLineId = nextCartLineId(cart);
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

  // ── Barcode & Catalog Search ───────────────────────────────────────────────
  const {
    debouncedSearch,
    searchResults,
    offlineResults,
    offlineSearching,
    handleScanKeyDown,
  } = usePOSCatalogSearch({
    search,
    setSearch,
    branchId,
    effectiveTier,
    customerId: activeTab.customerId,
    offline,
    addRow,
    setCustId,
    scannerEnabled: !receipt && !shifting && !creditPrompt && !cashDropping,
  });

  // ── Sale ──────────────────────────────────────────────────────────────────
  // idempotency: لكل تبويب مفتاحه (activeTab.clientRequestId) ⇒ النقر المزدوج/إعادة الشبكة لا
  // يكرّر الفاتورة، ولا يتصادم بيع تبويب مع آخر. يتجدّد مفتاح التبويب بعد نجاح بيعه فقط.
  // لقطة البيع (تُلتقط لحظة الإرسال) تجمّد التبويب المُباع وأرقامه ⇒ يُبنى الإيصال ويُفرَّغ
  // التبويب الصحيح في onSuccess حتى لو بدّل الكاشير التبويب أثناء جريان البيع — عزل مالي تام.
  const saleCtxRef = useRef<POSSaleReceiptContext | null>(null);
  const saleLabelWinRef = useRef<Window | null>(null);

  function captureSaleCtx(): POSSaleReceiptContext {
    return buildPosSaleReceiptContext({
      activeTab, cart, subtotal, invoiceDiscountAmount, cashRoundingDelta,
      effectiveTotalD, cashRoundedPaidD, paidD, isCredit, codMode,
      selectedCustomer, cashierName: me.data?.name ?? offlineBoot?.name ?? undefined,
      deliveryPayload, freeShippingPromoName,
    });
  }

  const captureOfflineSale = usePOSOfflineCapture({
    activeTab,
    branchId,
    shift,
    cart,
    isCredit,
    effectiveTier,
    cashRoundedTotal,
    invoiceDiscountAmountD,
    capturedByUserId: viewerUserId,
    enforceOfflinePermPolicy: !me.data,
    captureSaleCtx,
    setSaleError,
    setReceipt,
    setLastInv,
    patchTab,
    releaseReservedPrintWindow,
    printAuthorizedReceipt,
  });

  const preflightRef = useRef<ReturnType<typeof usePOSPreflightReconciliation> | null>(null);

  const sale = trpc.sales.create.useMutation({
    onSuccess: async (r, submitted) => {
      const doneReqId = submitted.clientRequestId ?? activeTab.clientRequestId;
      await preflightRef.current?.handleMutationSuccess(doneReqId);
      const ctx = saleCtxRef.current;
      saleCtxRef.current = null;
      if (!ctx) return; // أمان — لا لقطة (لا يُفترض حدوثه)
      const completedCheckout=savedCheckout(r,submitted.clientRequestId??" ");
      if(completedCheckout)patchTab(ctx.tabId,{lastCheckout:completedCheckout});
      const now = new Date();
      const srvPromo = (r as { promotionSummary?: Parameters<typeof buildPosReceiptPromoSummary>[0]["serverSummary"] }).promotionSummary ?? null;
      const effDelivery = ctx.delivery && srvPromo?.freeShippingPromo ? { ...ctx.delivery, feeCollection: "SHOP" as const } : (ctx.delivery ?? null);
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        invoiceId:     r.invoiceId,
        date: fmtDateTime(now),
        printDate: fmtDate(now),
        printTime: fmtTime(now),
        cashierName: ctx.cashierName,
        customerName: ctx.customerName,
        shiftId: (r as { shiftId?: number | null }).shiftId ?? shift?.id ?? null,
        lines: ctx.lines,
        subtotal: ctx.subtotal,
        invoiceDiscount: ctx.invoiceDiscount,
        cashRounding: ctx.cashRounding,
        total: ctx.total, received: ctx.received, change: ctx.change,
        credit: ctx.credit, isCredit: ctx.isCredit,
        method: ctx.method, methodCode: ctx.methodCode,
        paymentLegs: ctx.paymentLegs,
        delivery: effDelivery,
        consignmentNumber: r.consignmentNumber ?? null,
        promoSummary: buildPosReceiptPromoSummary({ cart: ctx.cartSnapshot, invoiceDiscount: ctx.invoiceDiscount, delivery: effDelivery, freeShippingPromoName: ctx.freeShippingPromoName, couponLabel: ctx.couponLabel, serverSummary: srvPromo }),
        bounceBackCoupon: (r as { bounceBackCoupon?: Receipt["bounceBackCoupon"] }).bounceBackCoupon ?? null,
      };
      const serverTotal = r.total != null ? Number(r.total) : ctx.total;
      const alignedRec: Receipt = { ...rec, total: serverTotal };
      setReceipt(alignedRec);
      setLastInv({ num: r.invoiceNumber, total: serverTotal });
      const saleMsg = r.consignmentNumber
        ? `أُسند الطرد ${r.consignmentNumber} للتوصيل`
        : alignedRec.bounceBackCoupon ? `قسيمة هدية صادرة: ${alignedRec.bounceBackCoupon.code} (خصم ${alignedRec.bounceBackCoupon.discountText})` : "افتح من شريط «آخر فاتورة» أعلاه";
      notify.ok(`تم البيع — فاتورة ${r.invoiceNumber}`, saleMsg);
      patchTab(ctx.tabId, { extraCharges: undefined, cart: [], payInput: "", selId: null, couponInput: "", couponCode: null, couponLabel: null, couponFreeShippingPromo: null, clientRequestId: newClientRequestId(), paymentRef: "", externalPayment: null, paymentLegs: [], dueDate: "", invoiceDiscountPct: "", delivery: null });

      const lblWin = saleLabelWinRef.current; saleLabelWinRef.current = null;
      if (alignedRec.delivery || alignedRec.consignmentNumber) void printPosDeliveryShippingLabel({ ...alignedRec, customerPhone: ctx.customerPhone, delivery: alignedRec.delivery ? { ...alignedRec.delivery, ...ctx.labelMeta } : null }, printAuthorizedDocument, lblWin, false).catch(() => {});
      else { try { lblWin?.close(); } catch { /* noop */ } }
      try {
      const printed = await printAuthorizedReceipt(alignedRec);
      if (!printed.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
      else if (printed.via === "server") notify.ok("تمت الطباعة المباشرة", `فاتورة ${r.invoiceNumber} أُرسلت إلى طابعة الكاشير`);
      else if (printed.via === "thermal") notify.ok("تمت الطباعة الحرارية", `فاتورة ${r.invoiceNumber} أُرسلت إلى الطابعة المربوطة`);
      else notify.warn("الطابعة المباشرة غير متاحة", "افتُتحت نافذة الطباعة؛ اربط طابعة الكاشير من رمز الطابعة لتعمل مباشرة لاحقاً");
      } catch (cause) { notify.warn("الفاتورة محفوظة؛ تعذّرت الطباعة", errMsg(cause)); }
      await Promise.all([
        utils.catalog.posList.invalidate(),
        utils.catalog.stockByUnitIds.invalidate(),
        utils.customers.list.invalidate(),
        shiftQ.refetch(),
      ]);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd(""); setSaleError(null);
    },
    onError: (e, variables) => {
      const reqId = (variables as { clientRequestId?: string } | undefined)?.clientRequestId ?? activeTab.clientRequestId;
      try { saleLabelWinRef.current?.close(); } catch { /* noop */ } saleLabelWinRef.current = null;
      const offlineCapturable = !!shift && cart.length > 0 && !cart.some((c) => c.digital) && !isSplitPayment && activeTab.method === "CASH" && !isCredit && !activeTab.couponCode && !deliveryBlocksOfflineCapture(activeTab.delivery);
      preflightRef.current?.handleMutationError({
        err: e,
        reqId,
        offlineCapturable,
        captureOfflineSale,
        clearPendingSaleCtx: () => { saleCtxRef.current = null; },
      });
    },
  });

  const preflight = usePOSPreflightReconciliation({
    branchId,
    offline,
    viewerUserId,
    hasAuthenticatedUser: Boolean(me.data),
    viewerCanAdminReconcile,
    isSalePending: sale.isPending,
    utils,
    setLastInv,
    patchTab,
    setCreditPrompt,
    setSaleError,
    releaseReservedPrintWindow,
    onTriggerSameKeyReplay: (intent) => {
      saleCtxRef.current = restorePosReceiptContextFromPreflightIntent(
        intent,
        me.data?.name ?? offlineBoot?.name ?? undefined,
      );
      sale.mutate(intent.saleInput as Parameters<typeof sale.mutate>[0]);
    },
  });
  preflightRef.current = preflight;

  const extraCheckout=useCashierExtraCharges({
    channel:"POS",branchId,shiftId:shift?.id,token:activeTab.clientRequestId,tab:activeTab,splitLegs:isSplitPayment?activeTab.paymentLegs:undefined,
    enabled:canSubmitSale,connected:!offline,confirmed:externalPaymentConfirmed,cartLength:cart.length,
    goodsTender:(isSplitPayment?activeTab.paymentLegs?.[0]?.amount:checkoutGoodsTenderAmount({extraCharges:activeTab.extraCharges,method:activeTab.method,paidAmount:paidD.toFixed(2),codMode,fallbackAmount:activeTab.payInput||String(total)}))??"0",busy:sale.isPending,
    onChange:extraCharges=>patchActive({extraCharges,externalPayment:null,paymentLegs:(activeTab.paymentLegs??[]).map(leg=>({...leg,externalPayment:null}))}),
    onCommitted:(id,lastCheckout)=>patchTab(id,{extraCharges:undefined,...clearedChargeOnlyTender("POS"),clientRequestId:newClientRequestId(),lastCheckout}),
    refresh:()=>void shiftQ.refetch(),
  });
  const {submitChargesOnly}=extraCheckout;
  const { confirmCurrentExternalPayment, externalPaymentPending } = usePOSExternalPayment({
    branchId, shift, activeTab, cart, cartHasDigital, isSplitPayment, total,
    deliveryFeeHeldD, externalPaymentAmount, externalPaymentFingerprint,
    patchTab, patchLegExternalPayment, setConfirmingLegId, startDigitalFulfillment,
  });

  const couponPreview = trpc.crm.coupons.preview.useMutation();
  const couponLiveRef = useRef({ activeId, branchId, effectiveTier, cartHasDigital, activeTab });
  couponLiveRef.current = { activeId, branchId, effectiveTier, cartHasDigital, activeTab };

  async function applyCoupon() {
    if (cartHasDigital) return notify.err("الكوبونات غير متاحة لفاتورة تحتوي بطاقات رقمية");
    const code = activeTab.couponInput.trim();
    if (!code || !cart.length) return;
    const requestSeq = ++couponReqSeqRef.current;
    const snapshot = capturePosCouponPreviewSnapshot({ requestSeq, cartRevision: cartRevisionRef.current, tab: activeTab, branchId, effectiveTier });
    try {
      const result = await couponPreview.mutateAsync(buildPosCouponPreviewInput({ tab: activeTab, branchId, effectiveTier }));
      const liveMeta = () => ({ latestRequestSeq: couponReqSeqRef.current, cartRevision: cartRevisionRef.current, activeTabId: couponLiveRef.current.activeId, branchId: couponLiveRef.current.branchId, effectiveTier: couponLiveRef.current.effectiveTier, cartHasDigital: cartHasDigitalRef.current });
      if (!isPosCouponPreviewFresh(snapshot, { ...liveMeta(), tab: couponLiveRef.current.activeTab })) return;
      setTabs((prev) => applyPosCouponPreviewToTabs(prev, snapshot, liveMeta(), result));
      notify.ok(`تم تطبيق الكوبون — ${result.programName}`);
    } catch (error) {
      if (isPosCouponPreviewFresh(snapshot, { latestRequestSeq: couponReqSeqRef.current, cartRevision: cartRevisionRef.current, activeTabId: couponLiveRef.current.activeId, branchId: couponLiveRef.current.branchId, effectiveTier: couponLiveRef.current.effectiveTier, cartHasDigital: cartHasDigitalRef.current, tab: couponLiveRef.current.activeTab })) notify.err(error);
    }
  }

  async function submitSale(approval?: ManagerApprovalInput) {
    const isSameKeyManagerRetry = Boolean(
      approval &&
        preflight.unconfirmedSaleIntent &&
        preflight.unconfirmedSaleIntents.length === 1 &&
        preflight.unconfirmedSaleIntent.clientRequestId === activeTab.clientRequestId &&
        preflight.foreignOwnerPendingCount === 0 &&
        preflight.activeInOtherTabCount === 0,
    );
    if (!isSameKeyManagerRetry && preflight.hasBlockingConflict) {
      notify.errBig(preflight.getBlockingMessage());
      return;
    }
    if(durable.pending || durable.busy || (digitalScope && !durable.ready))return;
    if (!canSubmitSale) { notify.err("صلاحية تنفيذ البيع غير ممنوحة لحسابك"); setSaleError("صلاحية تنفيذ البيع غير ممنوحة لحسابك"); return; }
    setSaleError(null);
    if (!shift) return;
    if (!cart.length) { await submitChargesOnly(); return; }
    if (checkoutExtraTotal(activeTab.extraCharges).gt(0) && cartHasDigital) {
      notify.err(
        "أكمل عملية الكروت الرقمية قبل إضافة أجر الخدمة إلى عملية مستقلة",
      );
      return;
    }
    const validationErr = validatePosSaleBeforeSubmit({
      activeTab, cart, codMode, isSplitPayment, splitInvalidLeg, splitNonCashOverpay, externalPaymentConfirmed, isCredit,
    });
    if (validationErr) { notify.err(validationErr); return; }
    // الفاتورة المختلطة تمر بالنواة الرقمية التي تثبت جميع بنودها في معاملة واحدة.
    if (cart.some((c) => c.digital)) {
      startDigitalFulfillment();
      return;
    }
    // الحدّ قبل الوعد (١٩/٨): فحص سقف الائتمان وموافقة المدير قبل إرسال البيع بالآجل
    if (!approval && !codMode) {
      const creditMsg = evaluatePosCreditPrompt({ selectedCustomer, isCredit, creditAmount: credit });
      if (creditMsg) {
        setCreditPrompt(creditMsg);
        return;
      }
    }
    // ش٣ أوفلاين: الاتصال مقطوع ⇒ التقاط محلي (نقدي كامل فقط) بدل نداء سيفشل. سلّةُ التوصيل تُرفض
    // داخل captureOfflineSale نفسها (deliveryBlocksOfflineCapture) ⇒ حارسٌ واحدٌ يغطّي هذا المسار وquickPay.
    if (offline) {
      if (isSplitPayment) {
        notify.errBig("أثناء انقطاع الاتصال: البيع النقدي الكامل فقط — الدفع المقسّم يتطلّب اتصالاً بالخادم.");
        return;
      }
      reservePrintWindow(); void captureOfflineSale();
      return;
    }
    // §٩: التقريب النقدي IQD يُحسب على الخادم للبيع النقدي الكامل (يُسجَّل ADJUST لفرق التقريب).
    const submittedCtx = captureSaleCtx();
    saleCtxRef.current = submittedCtx;
    reservePrintWindow(); if (deliveryPayload) saleLabelWinRef.current = preopenShippingLabelWindow();
    const splitLegs = activeTab.paymentLegs ?? [];
    const deviceId = isSplitPayment
      ? (splitLegs.find((l) => l.method !== "CASH")?.externalPayment?.deviceId ?? (await getDeviceCode().catch(() => undefined)))
      : activeTab.method === "CASH" ? await getDeviceCode().catch(() => undefined) : activeTab.externalPayment?.deviceId;
    const cashFull =
      ((!isSplitPayment && activeTab.method === "CASH") ||
        (isSplitPayment &&
          splitLegs.length > 0 &&
          splitLegs.every((l) => l.method === "CASH"))) &&
      !isCredit &&
      !codMode;
    const payAmount = checkoutGoodsTenderAmount({extraCharges:activeTab.extraCharges,method:activeTab.method,paidAmount:paidD.toFixed(2),codMode,
      fallbackAmount:isCredit ? money(paid) : cashFull ? money(cashRoundedTotal) : money(total)});
    const sendsGoodsPayment =
      checkoutExtraTotal(activeTab.extraCharges).gt(0) ||
      isSplitPayment || !((codMode && !deliverySendsPayment(activeTab.method, paidD)) || (isCredit && paidD.eq(0)));
    const onlineSubmitPayload = {
      ...checkoutExtraPayload(activeTab.extraCharges),
      branchId, shiftId: shift.id, sourceType: "POS" as const, clientRequestId: activeTab.clientRequestId,
      ...(activeTab.salesRepId ? { salesRepId: activeTab.salesRepId, attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const } } : {}),
      deviceId,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map(buildSaleLine),
      ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
      ...(isSplitPayment
        ? {
            payments: splitLegs.map((l) => ({
              amount: parsePosLegAmountD(l.amount).toFixed(2),
              method: l.method,
              ...(l.method !== "CASH" ? { reference: l.paymentRef.trim(), externalPaymentAttemptId: l.externalPayment!.attemptId! } : {}),
            })),
          }
        : !sendsGoodsPayment
          ? {}
          : {
              payment: {
                amount: payAmount,
                method: activeTab.method,
                ...(activeTab.method !== "CASH" ? { externalPaymentAttemptId: activeTab.externalPayment!.attemptId! } : {}),
              },
            }),
      // م١ PR-B: الطرد يُسند داخل معاملة البيع نفسها؛ أجرة COUNTER تُقبض الآن أمانةً وتساوي الأجرة بالضبط.
      ...(deliveryPayload ? { delivery: deliveryPayload, ...(deliveryPayload.feeCollection === "COUNTER" ? { deliveryFeeHeld: deliveryPayload.fee, deliveryFeeTender: deliveryFeeTenderForGoods(isSplitPayment ? splitLegs[0].method : activeTab.method, sendsGoodsPayment) } : {}) } : {}),
      // تاريخ الاستحقاق للآجل فقط — يُحفظ invoices.dueDate ويصحّح أعمار الذمم والتذكيرات.
      ...(isCredit && activeTab.dueDate ? { dueDate: activeTab.dueDate } : {}),
      ...(activeTab.couponCode ? { couponCode: activeTab.couponCode } : {}),
      ...(cashFull ? { cashRoundIQD: true } : {}),
      ...(approval ? { managerApproval: approval } : {}),
    };
    await preflight.recordAndDispatchPreflightSale({
      clientRequestId: activeTab.clientRequestId,
      tabId: activeTab.id,
      shiftId: shift.id,
      total: money(cashFull ? cashRoundedTotal : total),
      saleInput: onlineSubmitPayload as unknown as Record<string, unknown>,
      receiptContext: submittedCtx as unknown as Record<string, unknown>,
      onPersistFailed: () => {
        saleCtxRef.current = null;
        try { saleLabelWinRef.current?.close(); } catch { /* noop */ }
        saleLabelWinRef.current = null;
        releaseReservedPrintWindow();
      },
      dispatch: () => sale.mutate(onlineSubmitPayload),
    });
  }

  async function quickPay() {
    if (preflight.hasBlockingConflict) {
      notify.errBig(preflight.getBlockingMessage());
      return;
    }
    if(durable.pending || durable.busy || (digitalScope && !durable.ready))return;
    if (checkoutExtraTotal(activeTab.extraCharges).gt(0)) {
      await submitSale();
      return;
    }
    if (!canSubmitSale) { notify.err("صلاحية تنفيذ البيع غير ممنوحة لحسابك"); setSaleError("صلاحية تنفيذ البيع غير ممنوحة لحسابك"); return; }
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
    if (offline) { reservePrintWindow(); void captureOfflineSale(); return; }
    // الدفع السريع = دفع كامل بطبيعته، لكن مبلغاً سالباً ظاهراً في الحقل يُرفض صراحةً (لا تجاهل صامت).
    if (activeTab.payInput.trim() !== "" && D(activeTab.payInput).lt(0)) {
      notify.err("المبلغ المقبوض لا يكون سالباً — صحّح المبلغ أو امسح الحقل للدفع الكامل.");
      return;
    }
    // الدفع السريع كامل؛ التقريب لفئة IQD يخص النقد وحده (نفس منطق submitSale أعلاه).
    const submittedCtx = captureSaleCtx();
    saleCtxRef.current = submittedCtx;
    reservePrintWindow();
    const deviceId = activeTab.method === "CASH" ? await getDeviceCode().catch(() => undefined) : activeTab.externalPayment?.deviceId;
    const payAmount = activeTab.method === "CASH" ? money(cashRoundedTotal) : money(total);
    const quickPayPayload = {
      branchId, shiftId: shift.id, sourceType: "POS" as const, clientRequestId: activeTab.clientRequestId,
      ...(activeTab.salesRepId ? { salesRepId: activeTab.salesRepId, attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const } } : {}),
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
      ...(activeTab.method === "CASH" ? { cashRoundIQD: true } : {}),
      ...(activeTab.couponCode ? { couponCode: activeTab.couponCode } : {}),
    };
    await preflight.recordAndDispatchPreflightSale({
      clientRequestId: activeTab.clientRequestId,
      tabId: activeTab.id,
      shiftId: shift.id,
      total: payAmount,
      saleInput: quickPayPayload as unknown as Record<string, unknown>,
      receiptContext: submittedCtx as unknown as Record<string, unknown>,
      onPersistFailed: () => {
        saleCtxRef.current = null;
        try { saleLabelWinRef.current?.close(); } catch { /* noop */ }
        saleLabelWinRef.current = null;
        releaseReservedPrintWindow();
      },
      dispatch: () => sale.mutate(quickPayPayload),
    });
  }

  // ── Shift open ────────────────────────────────────────────────────────────
  const openShift = usePOSShiftOpening({
    onOpened: () => shiftQ.refetch(), opening, cashierName: me.data?.name ?? "كاشير",
    branchName: (branches.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
  });

  // مرجعٌ حيٌّ لأحدث `submitSale`: مستمعُ F4 يُثبَّت مرّةً بتبعيّاتٍ لا تشمل `activeTab.delivery`
  // (exhaustive-deps مُعطَّل)، فنداءُ الإغلاق المُثبَّت مباشرةً كان قد يبيع سلّةَ توصيلٍ بلا رؤيتها.
  const submitSaleRef = useRef(submitSale); submitSaleRef.current = submitSale;

  // ── Keyboard ──────────────────────────────────────────────────────────────
  usePOSKeyboardShortcuts({
    isDigitalCheckoutPending: () => Boolean(digitalCheckoutRef.current || durable.pending || durable.busy),
    creditPrompt,
    setCreditPrompt,
    receipt,
    setReceipt,
    shifting,
    setShifting,
    cashDropping,
    setCashDropping,
    cardsOpen,
    setCardsOpen,
    cart,
    isSalePending: sale.isPending,
    offline,
    externalPaymentConfirmed,
    searchRef,
    onSubmitSale: () => submitSaleRef.current(),
    onClearCart: () => {
      if (preflight.hasBlockingConflict) {
        notify.errBig("لا يمكن مسح السلة أثناء وجود فاتورة غير مؤكدة بانتظار التحقق التلقائي من الخادم.");
        return;
      }
      setCart([]);
      setPayInput("");
      setSelId(null);
      patchActive({ invoiceDiscountPct: "", paymentLegs: [] });
    },
    setShowDrop,
  });

  // ── Shift open screen ─────────────────────────────────────────────────────
  if(digitalScope && (!durable.ready || durable.pending || durable.busy)) return <>
    <DigitalWorkspaceRecovery message={durable.error} busy={!durable.ready || durable.busy} retry={()=>void durable.retry()} closeRejected={durable.canCloseRejected?()=>void durable.closeRejected():undefined}/>
    <DigitalFulfillmentDialog intentId={durable.intentId} finalizing={durable.busy} finalizeError={durable.error}
      onClose={()=>{releaseReservedPrintWindow();durable.dismiss();}} onAllExecuted={id=>void durable.finish(id)}/>
  </>;
  if ((shiftQ.isLoading && !shift) || !shift) {
    return (
      <POSShiftOpenScreen
        C={C}
        isLoading={shiftQ.isLoading}
        noAssignedBranch={noAssignedBranch}
        isElevatedRole={isElevatedRole}
        pickedBranch={pickedBranch}
        setPickedBranch={setPickedBranch}
        branches={branches.data ?? []}
        opening={opening}
        setOpening={setOpening}
        bridgeEnabled={bridge.enabled}
        printerReady={printerReady}
        connectPrinter={connectPrinter}
        openPending={openShift.isPending}
        needsBranchChoice={needsBranchChoice}
        onOpenShift={() => openShift.mutate({ branchId, openingBalance: opening, shiftType: "RETAIL" })}
      />
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  // تدقيق ١٧/٧: أتِح زرّ الدفع للبيع الآجل الجزئي عند اختيار عميل — كان معطَّلاً لأي دفعة أقل من الإجمالي
  // فيستحيل إتمام الآجل الجزئي باللمس/الفأرة (F4 وحده كان يتجاوزه، وهو غائب على اللوحي).
  const canPay =
    !preflight.hasBlockingConflict &&
    canSubmitSale &&
    cart.length > 0 &&
    !(cartHasDigital && (isSplitPayment || (activeTab.method !== "CASH" && activeTab.method !== "CARD"))) &&
    !splitInvalidLeg &&
    !splitNonCashOverpay &&
    ((!isSplitPayment && activeTab.payInput === "") || paid >= total || (!cartHasDigital && isCredit && activeTab.customerId != null)) &&
    externalPaymentConfirmed &&
    // م١ PR-B: وضع التوصيل يشترط طرداً مكتملاً (جهة + عنوان) وعميلاً مربوطاً بالهاتف واتصالاً حيّاً.
    (!codMode || (deliveryPayload != null && activeTab.customerId != null && !offline));

  return (
    <div className="retail-pos-surface" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>
      {/* Header */}
      <POSHeader
        C={C}
        search={search} setSearch={setSearch}
        showDrop={showDrop} setShowDrop={setShowDrop}
        results={search.trim().length >= 2 ? offline ? offlineResults : (searchResults.data ?? []) : []}
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
        branchId={branchId}
        offline={offline}
      />

      {headerActionsNode && createPortal(
        <RetailPosHeaderActions
          placement="inline"
          C={C} shift={shift} userRole={me.data?.role}
          onCloseShift={() => setShifting(true)} onCashDrop={() => setCashDropping(true)}
          printerReady={printerReady} onConnectPrinter={connectPrinter}
          bridgeEnabled={bridge.enabled} bridgeDesc={bridge.description} onTestPrint={testServerPrint}
        />,
        headerActionsNode,
      )}

      <POSUnconfirmedSaleBanner
        unconfirmedSaleIntents={preflight.unconfirmedSaleIntents}
        foreignOwnerPendingCount={preflight.foreignOwnerPendingCount}
        activeInOtherTabCount={preflight.activeInOtherTabCount}
        canServerFence={!offline && Boolean(me.data)}
        onFenceIntent={(intent) => void preflight.fenceAndCancelUnconfirmedIntent(intent)}
      />

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
      <POSFundingBanner
        C={C} posFundingRequests={posFundingRequests} isPending={acceptFundingM.isPending}
        onAccept={(requestReceiptId) => { reservePrintWindow(); acceptFundingM.mutate({ requestReceiptId, decision: "ACCEPT" }); }}
      />

      {/* Tab Bar */}
      <TabBar C={C} tabs={tabs} activeId={activeId} onSwitch={setActiveId} onAdd={addTab} onClose={id=>{if(!digitalScope){closeTab(id);return;}void loadFinancialIntent({...digitalScope,target:`tab:${id}`}).then(saved=>saved?notify.warn("استعد العملية الرقمية قبل إغلاق التبويب"):closeTab(id)).catch(notify.err);}} />

      {/* Body */}
      <div style={{ flex: 1, display: "flex", flexDirection: stacked ? "column-reverse" : "row", overflow: "hidden", padding: "7px 8px 8px", gap: 7, minHeight: 0 }}>

        {/* Payment Panel (right in RTL) */}
        <PaymentPanel
          extraChargesSlot={extraCheckout.slot} chargeOnlyDue={!cart.length?checkoutExtraTotal(activeTab.extraCharges).toNumber():undefined}
          C={C}
          stacked={stacked}
          codMode={codMode}
          isCreditBlocked={isCashOnlyCustomer}
          total={total} deliveryFeeHeld={deliveryFeeHeldD.toNumber()} feeMethod={isSplitPayment ? activeTab.paymentLegs?.[0]?.method : activeTab.method}
          subtotal={subtotal}
          invoiceDiscountAmount={invoiceDiscountAmount}
          invoiceDiscountPct={activeTab.invoiceDiscountPct ?? ""}
          setInvoiceDiscountPct={(v) => patchActive({ invoiceDiscountPct: v, invoiceDiscountValue: v, invoiceDiscountType: "percent" })}
          invoiceDiscountType={activeTab.invoiceDiscountType ?? "percent"}
          invoiceDiscountValue={activeTab.invoiceDiscountValue ?? (activeTab.invoiceDiscountPct || "")}
          onInvoiceDiscountChange={(val, typ) => patchActive({ invoiceDiscountValue: val, invoiceDiscountType: typ, invoiceDiscountPct: typ === "percent" ? val : discountCalc.discountPct > 0 ? String(discountCalc.discountPct) : "",
            })}
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
          externalPaymentPending={externalPaymentPending}
          onConfirmExternalPayment={() => { void confirmCurrentExternalPayment(); }}
          dueDate={activeTab.dueDate ?? ""}
          setDueDate={(v) => patchActive({ dueDate: v })}
          numMode={activeTab.numMode} setNumMode={setNumMode}
          numPress={numPress}
          onPay={submitSale} onQuickPay={quickPay}
          cartLen={cart.length} selId={activeTab.selId}
          isPending={sale.isPending || durable.busy}
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
          splitPayment={!cartHasDigital ? {
            paymentLegs: activeTab.paymentLegs ?? [], onEnableSplit: () => enableSplitPayment(cart.length?total:checkoutExtraTotal(activeTab.extraCharges).toNumber()), onDisableSplit: disableSplitPayment,
            onAddLeg: () => addPaymentLeg(credit), onUpdateLeg: (legId, patch) => updatePaymentLeg(legId, patch, total), onRemoveLeg: removePaymentLeg,
            onConfirmLegExternalPayment: (legId) => { void confirmCurrentExternalPayment(legId); }, confirmingLegId, splitNonCashOverpay,
          } : undefined}
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
          onUnitChange={changeItemUnit}
          customizableVariantIds={retailCustom.customizableVariantIds}
          onEditRecipeSelections={retailCustom.openForCartItem}
          numMode={activeTab.numMode} setNumMode={setNumMode}
          customerId={activeTab.customerId}
          selectedCustomer={selectedCustomer}
          tierOverride={activeTab.tierOverride}
          effectiveTier={effectiveTier}
          setTierOvr={setTierOvr}
          showCustPicker={showCustPicker}
          setShowCustPicker={setShowCustPicker}
          setCustId={setCustId}
          tabId={activeTab.id}
          salesRepId={activeTab.salesRepId ?? null}
          onSalesRepChange={(id) => patchActive({ salesRepId: id })}
          delivery={activeTab.delivery ?? null} freeShippingPromoName={freeShippingPromoName}
          onDeliveryChange={(d) => patchActive({ delivery: d })}
          onDeliveryIdentity={(identity) => {
            // العميل المربوط بالهاتف يصير عميلَ التبويب (⛔ بلا فحص ائتمان — COD خادمياً)، والمستلم يُملأ منه.
            if (identity.customerId !== (activeTab.customerId ?? null)) setCustId(identity.customerId);
            if (activeTab.delivery) patchActive({ delivery: applyCustomerIdentity(activeTab.delivery, identity, activeTab.customerId ?? null) });
          }}
          deliveryDisabledReason={deliveryModeUnavailableReason(offline)}
          customerBalance={selectedCustomer?.currentBalance != null ? String(selectedCustomer.currentBalance) : null}
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
      <POSOverlays
        C={C}
        receipt={receipt}
        onDismissReceipt={() => {
          setReceipt(null);
          // ٢٣/٨ (بلاغ فحص UX): نعيد التركيز صراحةً إلى حقل البحث كي يستقبل المسحة التالية.
          setTimeout(() => searchRef.current?.focus(), 0);
        }}
        onPrintReceipt={() => {
          if (!receipt || receiptPrinting.current) return;
          reservePrintWindow();
          void printAuthorizedReceipt(receipt, true).then((printed) => { if (!printed.ok) notify.err("تعذّرت الطباعة", "حجب المتصفح نافذة الطباعة البديلة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة"); }).catch((error) => notify.err(error));
        }}
        onPrintLabel={receipt && (receipt.delivery || receipt.consignmentNumber) ? () => void printPosDeliveryShippingLabel({ ...receipt, customerPhone: selectedCustomer?.phone ?? null }, printAuthorizedDocument, undefined, true).catch((error) => notify.err(error)) : undefined}
        shifting={shifting}
        shift={shift}
        branchId={branchId}
        onCloseShifting={() => setShifting(false)}
        onClosedShifting={() => { setShifting(false); void shiftQ.refetch(); }}
        me={me.data}
        branches={branches.data}
        cashDropping={cashDropping}
        onCloseCashDropping={() => setCashDropping(false)}
        creditPrompt={creditPrompt}
        mgrEmail={mgrEmail}
        setMgrEmail={setMgrEmail}
        mgrPwd={mgrPwd}
        setMgrPwd={setMgrPwd}
        isSalePending={sale.isPending}
        onApproveCredit={(appr) => submitSale(appr ?? (mgrEmail && mgrPwd ? { email: mgrEmail, password: mgrPwd } : undefined))}
        onCancelCredit={() => setCreditPrompt(null)}
      />
      {retailCustom.picker && (
        <RecipeVariantPickerDialog
          open
          title={`تخصيص مواد الخدمة: ${retailCustom.picker.row.productName}`}
          lines={retailCustom.picker.lines}
          initialSelections={retailCustom.picker.initialSelections}
          quantity={retailCustom.picker.quantity}
          confirmLabel={retailCustom.picker.editingLineId != null ? "تحديث الاختيار" : "إضافة للسلة"}
          onCancel={retailCustom.closePicker}
          onConfirm={retailCustom.confirmPicker}
        />
      )}
    </div>
  );
}
