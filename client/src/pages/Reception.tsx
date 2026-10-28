import {useReceptionCheckoutCharges} from "@/components/reception/useReceptionCheckoutCharges";
import {checkoutExtraPayload,checkoutExtraTotal} from "@/components/pos/checkoutExtraAmounts";
import type {CheckoutChargesInput} from "@shared/checkoutCharges";
import { useSplitTender } from "@/components/payments/useSplitTender";
import { FulfillmentShortcuts } from "@/components/fulfillment/FulfillmentShortcuts";
import { useReceptionCartEditing } from "@/components/reception/useReceptionCartEditing";
import { useReceptionScanner } from "@/components/reception/useReceptionScanner";
import { useReceptionPrinter } from "@/components/reception/useReceptionPrinter";
import { presentReceptionCheckout } from "@/components/reception/presentReceptionCheckout";
import { ReceptionWorkspaceHeader } from "@/components/reception/ReceptionWorkspaceHeader";
import { ReceptionOpenShift } from "@/components/reception/ReceptionOpenShift";
import { ReceptionResumeDraft } from "@/components/reception/ReceptionResumeDraft";
import { ReceptionRestoreWorkspace } from "@/components/reception/ReceptionRestoreWorkspace";
import { ReceptionDraftTicket } from "@/components/reception/ReceptionDraftTicket";
import { buildReceptionCheckoutReceipts } from "@/components/reception/ReceptionCheckoutReceipts";
import { ReceptionOfflineCapture } from "@/components/reception/ReceptionOfflineCapture";
import { ReceptionBranchGate } from "@/components/reception/ReceptionBranchGate";
import { buildReceptionCheckoutPayload } from "@/components/reception/ReceptionCheckoutPayload";
import { useDeliveryFeeTender } from "@/components/reception/useDeliveryFeeTender";
import { receptionPaymentAmounts } from "@/components/reception/receptionPaymentAmounts";
import { useReceptionShortcuts } from "@/components/reception/ReceptionShortcuts";
import { prepareReceptionSubmission } from "@/components/reception/ReceptionSubmission";
import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import { useReceptionAmounts } from "@/components/reception/ReceptionAmounts";
import type { StartOrderFromConversation } from "@/pages/Inbox";
import { type WorkOrderChannel } from "@shared/receptionChannel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { CheckCircle2, FilePenLine, ShoppingCart, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isValidIqMobile } from "@/components/form/PhoneDigitsInput";
import { useCustomerByPhone } from "@/components/customer/useCustomerByPhone";
import { CustomizationDialog, emptyCustomization } from "@/components/CustomizationDialog";
import { useInvoiceReceiptPrinter } from "@/hooks/useInvoiceReceiptPrinter";
import { receptionOperationAllowed, receptionCheckoutPaths, receptionDeliveryAuthorityRequired } from "@/lib/receptionOperationAccess";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMediaQuery } from "@/hooks/useMobile";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { offlineSearchCatalog, useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { buildDraftPayload } from "@/components/reception/draftPayloadBuilder";
import { DigitalCardsPickerDialog } from "@/components/pos/DigitalCardsPickerDialog";
import { DigitalFulfillmentDialog } from "@/components/pos/DigitalFulfillmentDialog";
import { toDigitalPrepareLine } from "@/components/pos/digitalBasket";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";
import { ReceptionCartDuplicateAlert } from "@/components/reception/ReceptionCartDuplicateAlert";
import { applyReceptionCouponPreview, clearReceptionCouponPricing, createReceptionDraftSyncQueue, isDefinitiveReceptionPromotionRejection, prepareReceptionConversationStart, prepareReceptionDepositDraft, type ReceptionDraftSyncOutcome as DraftSyncOutcome, type ReceptionDraftSyncQueue, type ReceptionLocalWorkspaceSnapshot, type ReceptionServerDraftPointer, useReceptionWorkspacePersistence } from "@/lib/receptionWorkspaceState";
import { isCustomKind, type CartLine, type LastSaleSummary, type PayMethod, type PosRow, type Tier, withReceptionLineDiscount } from "@/components/reception/cartMath";
import { CartTable } from "@/components/reception/CartTable";
import { PaymentPanel } from "@/components/reception/PaymentPanel";
import { ReceiptOverlay } from "@/components/reception/ReceiptOverlay";
import { triggerReceptionShippingLabel } from "@/components/reception/receptionShippingLabel";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { reservePrintWindow, releaseReservedPrintWindow } from "@/lib/printing/brand";
import { digitalCheckoutReceiptLines } from "@/lib/printing/digitalReceiptLines";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { type Receipt } from "@/components/pos/posShared";
import type { DeliveryDepartureData } from "@/components/delivery/DeliveryDepartureOverlay";
import { buildReceptionDepartureData } from "@/components/reception/receptionDepartureHelper";
import { ManagerApprovalDialog, type ManagerApprovalInput } from "@/components/reception/ManagerApprovalDialog";
import { ReceptionShiftCloseDialog } from "@/components/reception/ReceptionShiftCloseDialog";
import DepositDialog from "@/components/reception/DepositDialog";
import { CashDropDialog, type PosTokens } from "@/components/pos/CashDropDialog";
import { isPaired, printShiftOpen, printWorkOrderReceipt } from "@/lib/printing/print";

/**
 * شاشة الاستقبال — نقطة بيع هجينة لخدمة العملاء.
 *
 * الجاهز يُباع فوراً (فاتورة POS عبر saleRouter)، والمخصّص يدخل طابور المطبعة (workOrders.create
 * أمر مستقلّ لكل صنف). ربط بـcatalog.posList/byBarcode للبحث والمسح، وعرض هجين للإجماليّات.
 *
 * مسار: /work-orders/reception. الدور: cashier فأعلى. يلزم وردية مفتوحة (saleRouter).
 *
 * شريحة customer-service-reception (٢٣/٦/٢٦) — README §5.1.
 */

/** رموز ألوان CashDropDialog (بنية PosTokens المشتركة). */
const RECEPTION_TOKENS: PosTokens = {
  card: "#ffffff", border: "#e2e8f0", muted: "#f1f5f9", mutedFg: "#64748b",
  fg: "#0f172a", primary: "#7c3aed", danger: "#dc2626",
};
const RESERVATION_READ_ROLES = ["admin", "manager", "accountant", "cashier", "warehouse", "sales_rep", "auditor"] as const;
const CHANNEL_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor", "warehouse", "print_operator"] as const;
/** مرآة قائمة أدوار customersCashierProcedure الخادمية (server/trpc.ts) — لا تنجرف عنها. */
const CUSTOMER_CREATE_ROLES = ["cashier", "manager", "sales_rep", "print_operator"] as const;
/** مرآة POS_STATION_GATES.RECEPTION.allowedRoles — بوّابة محطة الاستقبال الثانية (workorders=FULL).
 *  (١٢/٨) كاشير الاستقبال بدور مخصّص حُدَّت فيه crm يدوياً يبقى قادراً على حفظ العميل لأنه شرطُ إكمال
 *  طلب/حجز/تسليم — تعايشُ الازدواج يطابق customerReceptionCreateAllowed الخادميّة. */
const RECEPTION_STATION_ROLES = ["cashier", "manager", "print_operator"] as const;
const STORE_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;
const CRM_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;

export default function Reception() {
  return <ReceptionBranchGate>{(branchId) => <ReceptionWorkspace key={branchId} branchId={branchId} />}</ReceptionBranchGate>;
}

function ReceptionWorkspace({ branchId }: { branchId: number }) {
  const [, navigate] = useLocation();
  const pageSearch = useSearch();
  const me = trpc.auth.me.useQuery();
  const { printAuthorizedReceipt, printAuthorizedReceiptData, printAuthorizedDocument } = useInvoiceReceiptPrinter(me.data, me.data?.id);
  const canAction = (path: string) => receptionOperationAllowed(me.data, path);
  const canActionRef = useRef(canAction); canActionRef.current = canAction;
  function requireAction(path: string) { if (!canActionRef.current(path)) throw new Error("هذه العملية غير مفوضة لحسابك"); }
  /**
   * ١٩/٨ (طلب المالك): اللوحاتُ الخمس خرجت من رأس المحطّة إلى **الصفحة الرئيسية** — رأسُ
   * الكاشير كان صفّاً واحداً من ثمانية أزرارٍ متساوية الوزن يفيض أفقياً بشريط تمرير. صار
   * الرأسُ للوردية وحدها، والدخولُ إلى اللوحة يقع من بطاقتها في الرئيسية عبر `?workspace=`.
   */
  const requestedWorkspace = useMemo(
    () => new URLSearchParams(pageSearch).get("workspace") ?? "",
    [pageSearch],
  );
  const canReadChannels = canAction("conversations.list");
  const canReadCustomerContext = canAction("customers.get");
  const canCreateCustomer = canAction("customers.receptionResolveByPhone");
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";

  const connState = useConnectivity();
  const offline = isDisconnected(connState);
  useOfflineCatalogSync(me.data && branchId > 0 ? branchId : null);
  const utils = trpc.useUtils();
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: canAction("branches.list") });
  const staffQ = trpc.workOrders.assignableStaff.useQuery({ branchId }, { enabled: branchId > 0 && canAction("workOrders.assignableStaff") });
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RECEPTION" }, { enabled: branchId > 0 && canAction("shifts.current") });
  const shift = shiftQ.data ?? null;
  const [opening, setOpening] = useState("0"), [closing, setClosing] = useState(false);
  const branchName = useMemo(
    () => (branchesQ.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
    [branchesQ.data, branchId],
  );

  const openShiftM = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      if (res.treasuryWarning) {
        notify.warn(
          "تنبيه: عجز الخزينة",
          res.treasuryBalanceAfter != null
            ? `عهدة الافتتاح فاقت رصيد الخزينة — الرصيد الآن ${fmt(Number(res.treasuryBalanceAfter))} د.ع. موّل الخزينة.`
            : "عهدة الافتتاح فاقت رصيد الخزينة (عجز). أبلغ المدير لتمويل الخزينة.",
        );
      }
      void printShiftOpen({
        shiftId: res.shiftId,
        openingBalance: Number(opening || 0),
        cashierName: me.data?.name ?? "موظف الخدمة",
        branchName,
        openedAt: new Date(),
      }).finally(() => releaseReservedPrintWindow());
    },
    onError: (e) => { releaseReservedPrintWindow(); notify.err(e); },
  });


  const compactHeader = useMediaQuery("(max-height: 900px)");

  const [cart, setCart] = useState<CartLine[]>([]); const [checkoutCharges,setCheckoutCharges]=useState<CheckoutChargesInput>({}); const extraChargeAmount=checkoutExtraTotal(checkoutCharges);
  const [addTick, setAddTick] = useState(0), [selKey, setSelKey] = useState<string | null>(null), [search, setSearch] = useState(""), [showDrop, setShowDrop] = useState(false);
  const [payInput, setPayInput] = useState("");
  const [deferred, setDeferred] = useState(false);
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [paymentReference, setPaymentReference] = useState(""); // P2 fix: مرجع البطاقة للعرابين
  const [showInbox, setShowInbox] = useState(false);
  /**
   * تطبيقُ اللوحة المطلوبة من الرابط **مرّةً واحدة لكل قيمة** — لا في كل رسم، وإلّا لم
   * يستطع الموظّف الرجوع إلى السلّة ما دام الرابط يحمل اللوحة. والرابط يُنظَّف بعد التطبيق
   * (`replace`) فلا يبقى في التاريخ ولا يُعيد فتح اللوحة عند التحديث.
   */
  /**
   * ١٩/٨ — لم يبقَ من `?workspace=` إلا **المحادثة**: الفواتير والطلبات وطلبات الموقع
   * والحجوزات صارت **شاشاتٍ قائمةً بذاتها** (طلب المالك)، والمحادثةُ تبقى **أداةَ سلّة**
   * (تملأ رأس الطلب) لا وجهةً — فمكانُها طبقةٌ فوق السلّة لا صفحةٌ تُغادر إليها.
   */
  const appliedWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (requestedWorkspace !== "inbox" || appliedWorkspaceRef.current === requestedWorkspace) return;
    appliedWorkspaceRef.current = requestedWorkspace;
    if (canReadChannels) setShowInbox(true);
    navigate("/pos?mode=RECEPTION", { replace: true });
  }, [requestedWorkspace, navigate, canReadChannels]);
  const [lastSale, setLastSale] = useState<LastSaleSummary | null>(null), [showReceiptOverlay, setShowReceiptOverlay] = useState(false), [deliveryDeparture, setDeliveryDeparture] = useState<DeliveryDepartureData | null>(null), [cashDropping, setCashDropping] = useState(false);
  const [depositMenuOpen, setDepositMenuOpen] = useState(false);
  const [discountFor, setDiscountFor] = useState<string | null>(null);
  const [approvalAsk, setApprovalAsk] = useState<{ lineKey: string; pct: number } | null>(null);
  /** اعتماد المدير للخصم >١٠٪ — يُحمل حتى الإرسال (يتحقّق خادمياً عند الالتزام). */
  const mgrCredsRef = useRef<ManagerApprovalInput | null>(null);
  const [activeDraft, setActiveDraft] = useState<{ id: number; version: number } | null>(null);
  const activeDraftRef = useRef(activeDraft); useEffect(() => { activeDraftRef.current = activeDraft; }, [activeDraft]);
  const draftSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null), draftResumeEpochRef = useRef(0); const draftSyncQueueRef = useRef<ReceptionDraftSyncQueue<ReturnType<typeof buildDraftPayload>> | null>(null), draftPromotionFlightRef = useRef(false), draftRecoveryPromptRef = useRef(false);
  const [draftTransitionPending, setDraftTransitionPending] = useState(false), [draftPromotionPending, setDraftPromotionPending] = useState(false), [draftPromotionShiftId, setDraftPromotionShiftId] = useState<number | null>(null), [workspaceSafetyBlocked, setWorkspaceSafetyBlocked] = useState(false), [detachedRecoveryPending, setDetachedRecoveryPending] = useState(false), [draftRestoreRecovery, setDraftRestoreRecovery] = useState<{ snapshot: ReceptionServerDraftPointer; serverAvailable: boolean } | null>(null); useEffect(() => () => { draftResumeEpochRef.current += 1; activeDraftRef.current = null; draftSyncQueueRef.current?.reset(); }, []);
  const [draftHeld, setDraftHeld] = useState("0.00");
  const [draftInfo, setDraftInfo] = useState<{ draftNumber: string } | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [orderDelivery] = useState<OrderDeliveryValue | null>(null);
  const setOrderDelivery = (_v: OrderDeliveryValue | null) => {};
  const deliveryDialogOpen = false;
  const setDeliveryDialogOpen = (_v: boolean) => {};
  const partiesQ = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { enabled: canAction("delivery.listParties") && (deliveryDialogOpen || orderDelivery != null), staleTime: 60_000 },
  );
  const [customerContextId, setCustomerContextId] = useState<number | null>(null);
  const [showCustomization, setShowCustomization] = useState<{ row: PosRow; editingKey?: string } | null>(null);
  const pendingDeferredRestoreRef = useRef(false), suppressHydratedPhoneResetRef = useRef(false);
  const phoneCustomer = useCustomerByPhone({ onPhoneChange: () => {
    if (suppressHydratedPhoneResetRef.current) { suppressHydratedPhoneResetRef.current = false; return; }
    pendingDeferredRestoreRef.current = false; setDeferred(false);
  } });
  const {
    customer, setCustomer, phone: receptionPhone, setPhone: setReceptionPhone,
    resolution: phoneResolution, error: phoneResolutionError,
    tier: resolvedCustomerTier, resolve: resolveReceptionCustomer, creditLimit: customerCreditLimit, setCreditLimit: setCustomerCreditLimit, deferredEligible: phoneDeferredEligible,
  } = phoneCustomer;
  useEffect(() => { if (pendingDeferredRestoreRef.current && phoneResolution === "RESOLVED") { pendingDeferredRestoreRef.current = false; setDeferred(phoneDeferredEligible); if (!phoneDeferredEligible) notify.warn("لم تُستعد طريقة الآجل", "العميل لم يعد مؤهلاً للبيع الآجل؛ اختر طريقة دفع أخرى."); } }, [phoneDeferredEligible, phoneResolution]);
  const [tierOverride, setTierOverride] = useState<Tier | null>(null);
  const [hydratedAutomaticTier, setHydratedAutomaticTier] = useState<Tier | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponOpen, setCouponOpen] = useState(false);
  const [invoiceDiscountPct, setInvoiceDiscountPct] = useState("");
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [couponLabel, setCouponLabel] = useState<string | null>(null);
  const [channel, setChannel] = useState<WorkOrderChannel>("WALK_IN");
  const [channelHandle, setChannelHandle] = useState("");
  /** المحادثة التي وُلد منها الطلب (ش١) — تُرسَل مع الرأس فيُربَط أمرُ الشغل بها ذرّيّاً. */
  const [linkedConversationId, setLinkedConversationId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cardsOpen, setCardsOpen] = useState(false);
  const [fulfillIntentId, setFulfillIntentId] = useState<number | null>(null);
  const [digitalFinalizeError, setDigitalFinalizeError] = useState<string | null>(null);
  const digitalCheckoutRef = useRef<{ appliedPaidD: import("decimal.js").Decimal; customerId: number | null; customerName: string | null; shiftId: number } | null>(null);
  const resetScreen = () => {
    draftResumeEpochRef.current += 1; if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    draftSyncQueueRef.current?.reset(); setDraftTransitionPending(false); setDraftPromotionPending(false); setDraftPromotionShiftId(null); setWorkspaceSafetyBlocked(false); setDraftRestoreRecovery(null); setDetachedRecoveryPending(false);
    mgrCredsRef.current = null; pendingDeferredRestoreRef.current = false; suppressHydratedPhoneResetRef.current = false;
    setDiscountFor(null); setApprovalAsk(null);
    setCheckoutCharges({}); setCart([]); setAddTick(0); setSelKey(null); setSearch("");
    setPayInput(""); setDeferred(false); setMethod("CASH"); setPaymentReference("");
    activeDraftRef.current = null; setActiveDraft(null); setDraftHeld("0.00"); setDraftInfo(null);
    setOrderDelivery(null); setCustomerContextId(null);
    setTierOverride(null); setHydratedAutomaticTier(null); setInvoiceDiscountPct("");
    setCouponInput(""); setCouponCode(null); setCouponLabel(null);
    setChannel("WALK_IN"); setChannelHandle(""); setLinkedConversationId(null);
    setCustomer({ customerId: null, name: "", phone: null, isNew: false }); setReceptionPhone(""); setCustomerCreditLimit("");
  };

  const prepareIntent = trpc.digitalCards.sales.prepare.useMutation();
  const finalizeSale = trpc.digitalCards.sales.finalize.useMutation({
    onMutate: () => setDigitalFinalizeError(null),
    onSuccess: (r) => {
      const checkout = digitalCheckoutRef.current;
      const now = new Date();
      const received = checkout ? round2(checkout.appliedPaidD).toNumber() : D(r.total).toNumber();
      const totalNum = D(r.total).toNumber();
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber, invoiceId: r.invoiceId, date: fmtDateTime(now), printDate: fmtDate(now), printTime: fmtTime(now),
        cashierName: me.data?.name ?? undefined, shiftId: checkout?.shiftId ?? shift?.id ?? null, customerName: checkout?.customerName ?? undefined,
        lines: digitalCheckoutReceiptLines(r.receiptLines), total: totalNum, received,
        change: received > totalNum ? D(received).minus(totalNum).toNumber() : 0, credit: 0, method: "CASH", isCredit: false, digitalDetails: r.printDetails,
      };
      setFulfillIntentId(null);
      digitalCheckoutRef.current = null;
      notify.ok("تم إتمام الطلب والبطاقات الرقمية واعتماد الفاتورة");
      void printAuthorizedReceipt(rec).then((printed) => {
        if (!printed.ok) notify.warn("تعذّرت الطباعة التلقائية", "حجب المتصفح نافذة الطباعة — الفاتورة محفوظة ويمكن إعادة طباعتها.");
      }).catch(() => notify.warn("الفاتورة محفوظة؛ تعذّرت الطباعة التلقائية"));
      void utils.sales.list.invalidate();
      void utils.shifts.current.invalidate();
      resetAfterCommittedWorkspace();
    },
    onError: (err) => { releaseReservedPrintWindow(); setDigitalFinalizeError(err.message); },
  });

  const [printerReady, setPrinterReady] = useState(isPaired());
  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({
    enabled: false,
    description: "",
  });

  const reqIdRef = useRef<string>(crypto.randomUUID());
  const searchRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const customerSectionRef = useRef<HTMLDivElement>(null);
  const cartSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!searchWrapRef.current?.contains(e.target as Node)) setShowDrop(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const fetchedCustomer = trpc.customers.get.useQuery(
    { customerId: customer.customerId ?? 0 },
    { enabled: !!customer.customerId && canReadCustomerContext, staleTime: 60_000 },
  );
  const effectiveTier: Tier =
    tierOverride ?? hydratedAutomaticTier ?? resolvedCustomerTier ?? ((fetchedCustomer.data?.defaultPriceTier as Tier | undefined) ?? "RETAIL");
  const barcodePricingContextRef = useRef("");
  barcodePricingContextRef.current = `${branchId}:${customer.customerId ?? "walk-in"}:${effectiveTier}`;
  useEffect(() => { if (hydratedAutomaticTier && phoneResolution === "RESOLVED" && resolvedCustomerTier) setHydratedAutomaticTier(null); }, [hydratedAutomaticTier, phoneResolution, resolvedCustomerTier]);
  const prevCustomerIdRef = useRef<number | null>(customer.customerId);
  useEffect(() => {
    if (prevCustomerIdRef.current === customer.customerId) return;
    prevCustomerIdRef.current = customer.customerId;
    setTierOverride(null);
    setHydratedAutomaticTier(null);
    if (couponCode) {
      setCouponCode(null);
      setCouponLabel(null);
      setCouponInput("");
      setCart(clearReceptionCouponPricing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.customerId]);

  const restoreCouponPreviewM = trpc.crm.coupons.preview.useMutation();
  const restoreCustomerM = trpc.customers.receptionResolveByPhone.useMutation();
  const resolvePromotionM = trpc.reception.draftResolvePromotion.useMutation();
  async function restoreLocalWorkspace(snapshot: ReceptionLocalWorkspaceSnapshot, isCurrent: () => boolean, preserveStoredPrices = false): Promise<boolean> { return ReceptionRestoreWorkspace({ branchId, setDraftPromotionPending, setDraftPromotionShiftId, resolvePromotionM, attachResolvedPromotion, setDraftRestoreRecovery, restoreCustomerM, utils, restoreCouponPreviewM, isElevatedRole, prevCustomerIdRef, pendingDeferredRestoreRef, suppressHydratedPhoneResetRef, receptionPhone, setCheckoutCharges, setCart, setSelKey, setReceptionPhone, setCustomer, setCustomerCreditLimit, setTierOverride, setHydratedAutomaticTier, setInvoiceDiscountPct, setPayInput, setMethod, setPaymentReference, setDeferred, setCouponInput, setCouponCode, setCouponLabel, setChannel, setChannelHandle, setLinkedConversationId, setDetachedRecoveryPending, activeDraftRef, setActiveDraft, setDraftHeld, setDraftInfo, mgrCredsRef }, snapshot, isCurrent, preserveStoredPrices); }

  const { clearPersistedWorkspace, markDraftPromotionPending, workspaceState, workspaceDirty, persistenceDegraded } = useReceptionWorkspacePersistence({
    companyId: me.data === undefined ? undefined : (me.data?.companyId ?? null),
    userId: me.data?.id != null ? Number(me.data.id) : null,
    branchId,
    activeDraftId: activeDraft?.id ?? null, activeDraftVersion: activeDraft?.version ?? null, clientRequestIdRef: reqIdRef,
    local: {
      cart, checkoutCharges,
      customer: { customerId: customer.customerId ?? null, name: customer.name, phone: customer.phone ?? null, isNew: customer.isNew },
      phoneInput: receptionPhone, customerCreditLimit, tierOverride, effectiveTier, draftPromotionPending, draftPromotionShiftId, detachedRecoveryPending, payInput, method, deferred,
      invoiceDiscountPct, couponInput, couponCode, couponLabel,
      channel, channelHandle, linkedConversationId,
    },
    paymentReference, draftHeld, onRestoreLocal: restoreLocalWorkspace, onWorkspaceChange: resetScreen,
    onRestoreServerDraft: (snapshot: ReceptionServerDraftPointer, isCurrent) => resumeDraft(snapshot.activeDraftId, isCurrent, false, snapshot.legacyIdentityOnly ? undefined : snapshot),
    onStorageError: () => notify.warn("تعذّر حفظ سلة الاستقبال مؤقتاً", "قد تكون مساحة المتصفح ممتلئة؛ أبقِ الشاشة مفتوحة أو احفظ الطلب كمسوّدة خادمية."),
  });
  function resetAfterCommittedWorkspace(): boolean { if (!clearPersistedWorkspace()) { setWorkspaceSafetyBlocked(true); notify.warn("تمت العملية، لكن تعذّر تنظيف حالتها المحلية", "لا تعِد الإرسال. أعد تحميل الصفحة أو فرّغ الحالة المحفوظة قبل عملية جديدة."); return false; } feePayment.reset(); splitTender.reset(true); reqIdRef.current = crypto.randomUUID(); resetScreen(); return true; }
  const { connectPrinter, testServerPrint } = useReceptionPrinter({ setPrinterReady, setBridge });
  const splitTender = useSplitTender({ branchId, ownerId: me.data?.id, sessionKey: reqIdRef.current, channel: "RECEPTION", additionalFirstPaymentAmount:cart.length?extraChargeAmount.toFixed(2):"0", canConfirm: canAction("reception.initiateExternalPayment") && canAction("reception.confirmExternalPayment"), disabled: offline || submitting || cart.some(line => line.digital) });
  const splitPayInput = splitTender.active ? splitTender.tendered : payInput;
  const { expectedNow, sumDirectNetD, sumCustomD, hasCustom, heldD, hasDigitalCards, rawInvoiceDiscountPctD, paidD, expectedNowD, mixedRoundEligible, effectiveGrandD, mixedDeltaD, cashRoundActive, regularSumRawD, invoiceDiscountAmountD, mixedCarrier, orderFeeHeldD, grandTotalD, heldDelivery, sumDirectD, cartCount, grandTotal, deferredAvailable, deferredDisabledReason, needPaymentRef, cashRoundingDelta, sumDirect, sumCustom, cashDueNow, deliveryDisclosure, paid, invoiceDiscountAmount, invoiceDiscountAllowed, CASHIER_INVOICE_DISCOUNT_MAX_PCT, change, remaining, isChange, isOwing } = useReceptionAmounts({ cart, orderDelivery, activeDraft, offline, invoiceDiscountPct, draftHeld, method, payInput: splitPayInput, splitPayment: splitTender.active ? { hasCash: splitTender.hasCash, hasNonCash: splitTender.hasNonCash } : undefined, customer, phoneResolution, deferred, setDeferred });
  const paymentPreview = receptionPaymentAmounts({ paid: paidD.toFixed(2), expectedNow: expectedNowD.toFixed(2), hasExplicitAmount: Boolean(splitPayInput), directNet: sumDirectNetD.toFixed(2), deferred, quickFullPay: false, isReservation: false, method: splitTender.active ? "CASH" : method });
  const feePayment = useDeliveryFeeTender({ branchId,ownerId:me.data?.id, method, goodsAmount: splitTender.active ? "0.00" : paymentPreview.appliedPaidD.toFixed(2), feeHeld: D(heldDelivery).plus(!splitTender.active?extraChargeAmount:0).toFixed(2), reference: paymentReference, clientRequestId: reqIdRef.current });

  useEffect(()=>{if(feePayment.restoredReference&&!paymentReference)setPaymentReference(feePayment.restoredReference);},[feePayment.restoredReference,paymentReference]);
  const extraCheckout=useReceptionCheckoutCharges({branchId,shiftId:shift?.id,customerId:customer.customerId??null,token:reqIdRef.current,value:checkoutCharges,setValue:setCheckoutCharges,disabled:offline||submitting||hasDigitalCards||!canAction("workOrders.receptionCheckout")||draftTransitionPending||draftPromotionPending||detachedRecoveryPending,goodsTender:paymentPreview.appliedPaidD.toFixed(2),cartLength:cart.length,onSubmit:()=>void handleSubmit({quickFullPay:true}),onSplit:()=>{if(!splitTender.active)splitTender.enable(extraChargeAmount.toFixed(2));splitTender.setEditorOpen(true);},resetCommitted:resetAfterCommittedWorkspace});
  const assignsDelivery = receptionDeliveryAuthorityRequired(me.data, orderDelivery != null && cart.some((line) => !isCustomKind(line) && !line.digital));
  const submitAllowed = receptionCheckoutPaths(hasDigitalCards, !!activeDraft, offline, assignsDelivery).every(canAction);
  // ───── البحث ──────────────────────────────────────────────────────────────
  const debounced = useDebouncedValue(search, 180);
  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: effectiveTier, query: debounced, limit: 15, includeReceptionServices: true, customerId: customer.customerId ?? undefined },
    { enabled: branchId > 0 && canAction("catalog.posList") && !offline && debounced.trim().length >= 2, staleTime: 15_000 },
  );
  // أوفلاين: البحث يُخدَم من النموذج المحلي بنفس شكل PosRow — بقية الشاشة (addRow/السلة/الأسعار)
  // لا تعرف الفرق. خدمات الطباعة مشمولة (includePrintServices) مطابقةً لـincludeReceptionServices
  // أونلاين. العروض/الكوبون/الأسعار التعاقدية معطّلة أوفلاين (الخطة الأصلية، نمط POS.tsx).
  const [offlineResults, setOfflineResults] = useState<PosRow[]>([]);
  useEffect(() => {
    if (!canActionRef.current("catalog.posList") || !offline || debounced.trim().length < 2) {
      setOfflineResults([]);
      return;
    }
    let cancelled = false;
    void offlineSearchCatalog(debounced, effectiveTier, branchId, { limit: 15, includePrintServices: true }).then((rows) => {
      if (!cancelled) setOfflineResults(rows as PosRow[]);
    });
    return () => {
      cancelled = true;
    };
  }, [offline, debounced, effectiveTier]);
  const results = !canAction("catalog.posList") ? [] : offline ? offlineResults : (searchResults.data ?? []);
  const resultsEmpty = results.length === 0 && debounced.trim().length >= 2 && !(offline || searchResults.isFetching);
  // ش٠ — حارس سباق البحث (نمط POS searchSettled): Enter لا يضيف أول نتيجة إلا بعد استقرار
  // النتائج على النصّ الحاليّ — كان يضيف منتجاً خاطئاً من استعلامٍ أقدم أثناء الكتابة السريعة.
  const searchSettled = debounced.trim() === search.trim()
    && search.trim().length >= 2
    && (offline || !searchResults.isFetching);

  // ───── السلّة ─────────────────────────────────────────────────────────────
  /** أيّ تعديلٍ على السلة يُسقط كوبوناً مُطبَّقاً سابقاً (نمط POS.tsx clearAppliedCoupon) — أسعار
   *  الكوبون محسوبة على تركيبة سلّةٍ بعينها، وتعديلها بلا إعادة تطبيق يعني تحصيلاً بسعرٍ فات أوانه. */
  const clearCouponIfApplied = useCallback(() => {
    setCouponCode((prev) => {
      if (!prev) return prev;
      setCouponLabel(null);
      setCart(clearReceptionCouponPricing);
      return null;
    });
  }, []);

  /** يضيف صنفاً جاهزاً (بلا تخصيص) بسعره العادي — يدمج مع سطرٍ مطابق ويصعّده لأول السلة ليبقى ظاهراً للكاشير. */
  const { addRow, addManualService, changeQty, removeRow, addPlainFromCustomization, changeLineUnit, addDirectLine, saveCustomization, addDigitalBasket } = useReceptionCartEditing({ clearCouponIfApplied, setCart, setSelKey, setAddTick, canActionRef, offline, activeDraft, branchId, setInvoiceDiscountPct, setCardsOpen, effectiveTier, setShowCustomization, setSearch, setShowDrop, searchRef, showCustomization, cartSectionRef, selKey });
  async function clearCart() {
    if (draftTransitionPending || draftPromotionFlightRef.current || cart.length === 0) return;
    if (draftPromotionPending) { notify.warn("لا تفرّغ محاولة حفظ غير محسومة", "اضغط حفظ الطلب مرة أخرى للتحقق من نتيجتها أولاً؛ التفريغ الآن قد يتيح إنشاء طلب مكرر."); return; }
    if (!(await confirm({
      variant: "warning",
      title: "تفريغ السلّة",
      description: "سيُمسح كلّ ما في الطلب الحالي. متابعة؟",
      confirmText: "تفريغ",
    }))) return;
    await draftSyncQueueRef.current?.supersedeAndDrain();
    if (!clearPersistedWorkspace()) return;
    reqIdRef.current = crypto.randomUUID(); draftResumeEpochRef.current += 1; setDetachedRecoveryPending(false); setDraftRestoreRecovery(null);
    setCouponCode(null); setCouponLabel(null); setCouponInput("");
    // يفكّ الارتباط قبل مسح السلة حتى لا تمسح مزامنة مؤجلة المسودة البعيدة.
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    activeDraftRef.current = null; setActiveDraft(null); setDraftHeld("0.00"); setDraftInfo(null);
    setCheckoutCharges({}); setCart([]); setSelKey(null); setPayInput(""); setDeferred(false);
    setMethod("CASH"); setPaymentReference("");
    // ٢٣/٨ — تفريغ خصم رأس الفاتورة مع تفريغ السلّة كي لا يُطبَّق سهواً على سلّةٍ جديدةٍ لعميلٍ آخر.
    setInvoiceDiscountPct("");
  }

  // ───── الباركود ───────────────────────────────────────────────────────────
  const { blockingDialogOpen, handleSearchScan } = useReceptionScanner({ paymentEditorOpen: splitTender.editorOpen, draftResumeEpochRef, barcodePricingContextRef, requireAction, offline, effectiveTier, branchId, utils, customer, addRow, draftPromotionFlightRef, draftTransitionPending, setSearch, setCustomer, depositOpen, cardsOpen, fulfillIntentId, closing, deliveryDialogOpen, customerContextId, showInbox, showCustomization, cashDropping, approvalAsk, showReceiptOverlay, submitting, setShowDrop });
  // إصلاح (٧/٨، طلب مالك): أزرار الفواتير/الطلبات/الحجوزات/الوردية… تنتقل إلى الشريط العلوي
  // المشترك بين الأوضاع الثلاثة (بجانب زرّ «الفواتير» الأصلي، الذي تستبدله محطة الاستقبال بنسخةٍ
  // أغنى) — عبر portal إلى المُقبس `#pos-header-actions` الذي يرسمه PointOfSale.tsx. الـportal
  // يُبقي كل الحالة والمنطق هنا (لا رفع state لأعلى، لا تكرار استعلامات وردية/طابعة في الغلاف
  // المشترك بين POS/PrintPOS/Reception)، ويُلحق العرض فقط بموضعٍ خارج شجرة المكوّن.
  const [headerActionsNode, setHeaderActionsNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderActionsNode(document.getElementById("pos-header-actions"));
  }, []);

  // ───── لوحة المبلغ (م٤ — مبلغٌ فقط، لا أوضاع ولا أزرار فئات نقدية ثابتة) ────────────
  function payAll() {
    // ش٠: «= الكل» يملأ الإجمالي **الفعليّ** (المقرَّب لفئة ٢٥٠ في البيع المباشر النقديّ الخالص).
    setPayInput(String(expectedNow));
  }
  /** م٤ — الكمية داخل الصفّ: مدخلٌ رقميّ مباشر (والزرّان ± يبقيان للمس السريع). */
  function setQty(key: string, qty: number) {
    clearCouponIfApplied();
    setCart((prev) => prev.map((c) => (c.key === key && !c.digital ? { ...c, qty: Math.max(1, Math.trunc(qty) || 1) } : c)));
  }
  /** م٤ — الخصم داخل الصفّ (Popover خلية السعر): نسبةٌ 0..100، null = إزالة الخصم. */
  function setLineDiscount(key: string, pct: number | null) {
    clearCouponIfApplied();
    setCart((prev) => prev.map((c) => c.key === key ? withReceptionLineDiscount(c, pct) : c));
  }
  /** م٦: سقف الخصم الحرّ ١٠٪ — فوقه اعتمادُ مديرٍ استباقيّ (لا انتظار رفض الخادم).
   *  تُمرَّر لـCartTable — مسار الاعتماد قرارُ الصفحة (mgrCredsRef/approvalAsk ملكها). */
  function applyLineDiscount(lineKey: string, pct: number | null) {
    if (pct != null && pct > 10 && !isElevatedRole && !mgrCredsRef.current) {
      setApprovalAsk({ lineKey, pct });
    } else {
      setLineDiscount(lineKey, pct);
    }
  }
  /** عربون ▾ (§٨.٣): تعبئة سريعة = الجاهز كاملاً + نسبة من المخصّص (الخوارزمية الجشعة الخادمية
   *  تُغطّي البيع المباشر أولاً ثم توزّع الفائض عرابين — هذه الأزرار تملأ المبلغ وفقها بلا حساب يدويّ).
   *  ٢٣/٨ — Codex P1: «الجاهز» = `sumDirectNetD` (بعد خصم رأس الفاتورة) لا الخام، وإلّا عبَّأت
   *  اقتراحاً يفوق المستحقّ بمقدار الخصم فيصير الفارقُ عربوناً خفياً على المخصّص بغير علم الكاشير. */
  function fillDeposit(pctOfCustom: number) {
    const v = round2(sumDirectNetD.plus(sumCustomD.times(pctOfCustom)));
    setPayInput(v.toFixed(0));
    setDepositMenuOpen(false);
  }
  /** ش٤ — «قبض عربون الآن»: يقبض مبلغاً **فوراً بإيصالٍ وسند** على الطلب المحفوظ (يُرقّى تلقائياً
   *  إن لزم — §٨.٢/أ: قبض العربون سببُ ترقيةٍ حقيقيّ). يختلف عن أزرار التعبئة (تملأ الحقل فقط). */
  async function openDepositCollect() {
    setDepositMenuOpen(false); if (detachedRecoveryPending) { notify.warn("راجع النسخة المستعادة أولاً", "احفظها كطلب محفوظ جديد قبل قبض أي مبلغ كي لا يتكرر طلب خادمي أقدم."); return; }
    if (draftPromotionPending) { notify.warn("نتيجة حفظ الطلب غير محسومة", "أعد الضغط على حفظ الطلب للتحقق قبل قبض أي مبلغ."); return; }
    if (couponCode) { notify.warn("الكوبون لا يُحفظ داخل طلب محفوظ", "أزل الكوبون لقبض عربون، أو ثبّت البيع مباشرةً ليُتحقق من الكوبون ويُستهلك ذرّياً."); return; }
    if (offline) { notify.errBig("لا قبض عربون دون اتصال", "العربون يحتاج إيصالاً خادمياً — أعد المحاولة عند عودة الاتصال."); return; }
    if (phoneResolution === "CHECKING" || phoneCustomer.isPending || couponPreview.isPending) { notify.warn("انتظر اكتمال التحقق", "جارٍ حسم العميل أو الكوبون قبل قبض العربون."); return; }
    if (cart.length === 0) { notify.warn("السلة فارغة", "أضف ما يريده الزبون ثم اقبض العربون"); return; }
    if (!shift) { notify.errBig("افتح وردية استقبال أولاً", "العربون يدخل درجك وتُحاسَب عليه عند الإغلاق."); return; }
    if (draftPromotionFlightRef.current) return;
    const draftBeforeDeposit = activeDraftRef.current ?? activeDraft, promotingForDeposit = draftBeforeDeposit == null;
    if (promotingForDeposit && !markDraftPromotionPending(shift.id)) { notify.warn("تعذّر تأمين حفظ الطلب", "لم نرسل الطلب لأن مفتاح منع التكرار لم يُحفظ محلياً."); return; }
    if (promotingForDeposit) { setDraftPromotionPending(true); setDraftPromotionShiftId(shift.id); }
    const transitionEpoch = ++draftResumeEpochRef.current;
    draftPromotionFlightRef.current = true; setDraftTransitionPending(true);
    try {
      const result = await prepareReceptionDepositDraft({ active: draftBeforeDeposit,
        isCurrent: () => transitionEpoch === draftResumeEpochRef.current, flush: () => flushActiveDraft(),
        promote: () => promoteM.mutateAsync({ branchId, shiftId: shift.id, clientRequestId: reqIdRef.current, ...getDraftPayload() }) });
      if (!result.ok) {
        if (result.reason === "SYNC") notify.warn("تعذّرت مزامنة الطلب قبل القبض", "تحقّق من الاتصال ثم أعد المحاولة");
        else if (result.reason === "PROMOTE") { if (isDefinitiveReceptionPromotionRejection(result.error)) { setDraftPromotionPending(false); setDraftPromotionShiftId(null); notify.err(result.error, "رفض الخادم حفظ الطلب؛ صحّح البيانات ثم أعد المحاولة"); } else notify.warn("لم يُحسم حفظ الطلب قبل قبض العربون", "لم يُقبض شيء. اضغط حفظ الطلب للتحقق من محاولة الحفظ قبل المتابعة."); void utils.reception.draftList.invalidate(); }
        else void utils.reception.draftList.invalidate(); return; }
      if (result.idempotentReplay) {
        await attachResolvedPromotion({ draftId: result.draft.id, version: result.draft.version, draftNumber: result.draftNumber! }); return;
      }
      if (result.promoted) { setDraftPromotionPending(false); setDraftPromotionShiftId(null); activeDraftRef.current = result.draft; setActiveDraft(result.draft); setDraftInfo({ draftNumber: result.draftNumber! }); setDraftHeld("0.00"); setDetachedRecoveryPending(false); void utils.reception.draftList.invalidate(); }
      setDepositOpen(true);
    } finally { draftPromotionFlightRef.current = false; if (transitionEpoch === draftResumeEpochRef.current) setDraftTransitionPending(false); }
  }
  /** خيارات «عربون» المنسدلة — تُحسب هنا (sumDirectD/sumCustomD ملك الصفحة) وتستهلكها PaymentPanel.
   *  خيارات التعبئة النسبية للمخصّص فقط؛ القبض الفوريّ لأيّ سلة (م٢: عربونٌ على أيّ طلب). */
  const depositOptions = [
    ...(hasCustom
      ? ([["٢٥٪", 0.25], ["٥٠٪", 0.5], ["المخصّص كاملاً", 1]] as const).map(([label, pct]) => ({
          label,
          // ٢٣/٨ — Codex P1: العرض على `sumDirectNetD` (بعد الخصم) كي يطابق ما تعبّئه fillDeposit.
          amountLabel: fmt(round2(sumDirectNetD.plus(sumCustomD.times(pct))).toNumber()),
          onPick: () => fillDeposit(pct),
        }))
      : []),
    // قبضٌ فعليّ لا تعبئة — يظهر دائماً ما دامت السلة غير فارغة (م٥: بلا شرط نسبة).
    { label: "قبض عربون الآن (سند)", amountLabel: "إيصال فوري", onPick: () => void openDepositCollect() },
    // سجلّ العرابين + الردّ — للطلب المحفوظ النشط المموّل فقط.
    ...(activeDraft && heldD.gt(0)
      ? [{ label: "سجلّ العرابين / ردّ", amountLabel: fmt(round2(heldD).toNumber()), onPick: () => { setDepositMenuOpen(false); setPaymentsOpen(true); } }]
      : []),
  ];

  // ───── حسم هوية العميل قبل الالتزام ─────────────────────────────────────
  // كل قنوات الاستقبال تمر بالهاتف العراقي نفسه. endpoint واحد يبحث أو ينشئ ويحسم سباق التكرار.
  async function ensureCustomerId(): Promise<number | null> {
    if (customer.customerId) return customer.customerId;
    if (!isValidIqMobile(receptionPhone)) throw new Error("أكمل رقم الهاتف العراقي المكوّن من ١١ رقماً");
    const name = customer.name.trim();
    if (name.length < 2) throw new Error("اكتب اسم العميل بحرفين على الأقل");
    const resolved = await resolveReceptionCustomer(name, false);
    const id = Number(resolved?.customerId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(phoneResolutionError || "تعذّر حفظ العميل وربطه بالطلب");
    }
    return id;
  }

  // الكوبون للبيع المباشر الجاهز فقط؛ أي تعديل لاحق للسلة يسقطه ولا يعيد معاينته تلقائياً.
  const couponPreview = trpc.crm.coupons.preview.useMutation();
  const couponContextRef = useRef("");
  couponContextRef.current = JSON.stringify([branchId, couponInput.trim(), customer.customerId, effectiveTier, cart.map((c) => [c.key, c.row.productId, c.row.variantId, c.row.productUnitId, c.qty, c.row.price, !!c.row.isContractPrice, c.row.promotionEffectivePrice, c.origPrice, c.disc, c.custom?.unitPrice, c.digital?.sellPriceSnapshot])]);
  async function applyCoupon() {
    const code = couponInput.trim();
    if (!code || draftTransitionPending || draftPromotionFlightRef.current) return;
    if (activeDraftRef.current) { notify.warn("الكوبون غير متاح للطلب المحفوظ", "ثبّت الطلب المحفوظ أولاً أو افتح سلة جديدة؛ الكوبون يُستهلك فقط مع البيع المباشر."); return; }
    const eligible = cart.filter((c) => !c.custom && !c.row.isPrintService && !c.digital);
    if (eligible.length === 0) {
      notify.err("أضف صنفاً جاهزاً غير خدمة طباعة أولاً — الكوبون لا ينطبق على المخصّص/الطباعة");
      return;
    }
    if (eligible.some((line) => (line.disc ?? 0) > 0)) { notify.warn("أزل خصم السطر أولاً", "لا يُدمج الكوبون مع خصم يدوي على السطر كي يبقى السعر المعروض مطابقاً للتثبيت."); return; }
    const transitionEpoch = draftResumeEpochRef.current, context = couponContextRef.current;
    try {
      const result = await couponPreview.mutateAsync({ code, branchId, customerId: customer.customerId ?? undefined, customerTier: effectiveTier,
        lines: eligible.map((c) => ({
        productId: c.row.productId,
        variantId: c.row.variantId,
        productUnitId: c.row.productUnitId,
        unitPrice: String(c.row.price ?? "0"),
        quantity: c.qty,
        hasContractPrice: !!c.row.isContractPrice,
        })),
      });
      if (transitionEpoch !== draftResumeEpochRef.current || context !== couponContextRef.current) return;
      setCart((items) => applyReceptionCouponPreview(items, result)); setCouponCode(result.code); setCouponLabel(result.programName);
      notify.ok(`تم تطبيق الكوبون — ${result.programName}`);
    } catch (error) {
      if (transitionEpoch === draftResumeEpochRef.current && context === couponContextRef.current) notify.err(error, "تعذّر تطبيق الكوبون");
    }
  }
  function clearCoupon() { setCouponCode(null); setCouponLabel(null); setCouponInput(""); setCart(clearReceptionCouponPricing); }
  // نقطة التزام خادمية واحدة للسلة الهجينة: بيع + طباعة + أوامر شغل + **إسناد التوصيل** (PR #495).
  const checkoutM = trpc.workOrders.receptionCheckout.useMutation();
  // ───── ش٢: المسوّدة المُرقّاة (حفظ/استئناف/مزامنة) ─────────────────────────
  /** تحويل السلّة الحالية إلى حمولة مسوّدة (الخصم اليدويّ مطويّ في unitPrice الفعّال).
   *  `customerIdOverride` (مراجعة PR #495): عند «احفظه كعميل» أثناء التثبيت يعود المعرّف من
   *  `ensureCustomerId()` فوراً بينما `setCustomer` **لا يُحدِّث** المتغيّر الملتقَط في هذا
   *  الاستدعاء (React لا يزامن الحالة داخل نفس الدورة) ⇒ كانت المسوّدة تُزامَن بـ`customerId:null`
   *  فتُثبَّت الفاتورة/أوامر الشغل باسمٍ عابرٍ لا بالعميل الذي أُنشئ للتوّ. نمرّره صراحةً. */
  /**
   * ش١ (١٩/٨) — **من الرسالة إلى السلّة بنقرتين**: خيطُ المحادثة يملأ رأس الطلب (العميل،
   * القناة، معرّفها) ويُغلق طبقةَ الوارد، فيبقى للموظّف اختيارُ ما يريده الزبون وحده.
   *
   * لا يُنشئ عميلاً: محادثةٌ بلا عميلٍ مربوط تملأ **الاسم والهاتف** فقط ويبقى القرار للموظّف
   * (زرّ «+ عميل جديد» بنقرةٍ حيث يلزم) — إنشاءٌ صامتٌ من رسالةٍ واردة يُلوّث الكتالوج
   * بعملاء وهميّين لكل من راسل المكتبة مرّة.
   */
  function startOrderFromConversation(v: StartOrderFromConversation) {
    const prepared = prepareReceptionConversationStart(v);
    setLinkedConversationId(prepared.linkedConversationId);
    setChannel(prepared.channel); setChannelHandle(prepared.channelHandle);
    if (prepared.localPhone) setReceptionPhone(prepared.localPhone);
    setCustomer(prepared.customer); setShowInbox(false);
    notify.ok(`فُتح طلبٌ من محادثة ${v.displayName ?? v.channelHandle} — أضف ما يطلبه الزبون`);
  }
  const getDraftPayload = (customerIdOverride?: number | null) => buildDraftPayload({ customer, effectiveTier, channel, channelHandle, linkedConversationId, cart, checkoutCharges, customerIdOverride });
  const promoteM = trpc.reception.draftPromote.useMutation(), syncM = trpc.reception.draftSync.useMutation();
  async function attachResolvedPromotion(result: { draftId: number; version: number; draftNumber: string }): Promise<boolean> { const draft = { id: result.draftId, version: result.version }; setDraftPromotionPending(false); setDraftPromotionShiftId(null); activeDraftRef.current = draft; setActiveDraft(draft);
    if (!(await resumeDraft(result.draftId, () => true, true))) { setWorkspaceSafetyBlocked(true); notify.warn("تعذّر التحقق من الطلب المحفوظ", "حُجبت السلة لمنع قبض أو تثبيت مكرر. أعد التحميل ثم تحقق من الطلب المحفوظ."); return false; }
    setDetachedRecoveryPending(false); void utils.reception.draftList.invalidate(); return true; }
  if (!draftSyncQueueRef.current) {
    draftSyncQueueRef.current = createReceptionDraftSyncQueue({ getActive: () => activeDraftRef.current,
      sync: ({ draftId, version, payload }) => { requireAction("reception.draftSync"); return syncM.mutateAsync({ draftId, version, ...payload }); },
      applyVersion: (draftId, version) => {
        const current = activeDraftRef.current; if (current?.id !== draftId) return;
        const next = { ...current, version }; activeDraftRef.current = next; setActiveDraft(next); },
    });
  }
  function handleDraftSyncFailure(outcome: Extract<DraftSyncOutcome, { ok: false }>) {
    if (outcome.reason !== "FAILED" || outcome.draftId == null || activeDraftRef.current?.id !== outcome.draftId) return;
    const error = outcome.error as { data?: { code?: string }; message?: string }, code = error?.data?.code, message = error?.message ?? "تعذّرت مزامنة الطلب المحفوظ";
    if (code === "CONFLICT") {
      notify.warn("تعارضت نسخة الطلب المحفوظ", "احتفظنا بتعديلاتك المحلية ولم نستبدل السلة. افتح الطلب من جهاز واحد ثم أعد المحاولة أو فرّغه صراحةً."); void utils.reception.draftList.invalidate();
    } else if (code === "PRECONDITION_FAILED") {
      const i3Guard = /مبلغٌ مقبوض|المقبوض سلفاً/.test(message);
      notify.warn(i3Guard ? "الطلب عليه مبلغ مقبوض" : "توقّفت مزامنة الطلب المحفوظ", message);
      void utils.reception.draftList.invalidate();
    } else {
      notify.warn("لم تصل آخر تعديلات الطلب إلى الخادم", "احتفظنا بها على هذا الجهاز؛ أبقِ الطلب مفتوحاً أو أعد الاتصال لتُزامَن تلقائياً.");
    }
    if ((code === "CONFLICT" || code === "PRECONDITION_FAILED") && !draftRecoveryPromptRef.current) {
      draftRecoveryPromptRef.current = true;
      void confirm({ variant: "warning", title: "هل تُهمِل التعديلات المحلية؟", description: `${message}\n\nاختر «تحميل نسخة الخادم» فقط إن كنت موافقاً على استبدال السلة المحلية الحالية.`, confirmText: "تحميل نسخة الخادم" })
        .then((accepted) => accepted && activeDraftRef.current?.id === outcome.draftId ? resumeDraft(outcome.draftId!, () => true, true) : false)
        .finally(() => { draftRecoveryPromptRef.current = false; });
    }
    // عطل النقل يبقي الربط؛ التعديل/المحاولة التالية يعيدان الإرسال ولا يُستبدل الطلب محلياً.
  }
  const queueActiveDraftSync = (customerIdOverride?: number | null) => draftSyncQueueRef.current!.enqueue(activeDraftRef.current?.id ?? null, getDraftPayload(customerIdOverride));
  async function flushActiveDraft(customerIdOverride?: number | null, handleFailure = true): Promise<DraftSyncOutcome> {
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current); draftSyncTimer.current = null;
    const outcome = await queueActiveDraftSync(customerIdOverride);
    if (!outcome.ok && handleFailure) handleDraftSyncFailure(outcome); return outcome;
  }
  async function saveDraft() {
    if (cart.length === 0 || !!activeDraftRef.current || offline || promoteM.isPending || draftPromotionFlightRef.current) return;
    if (phoneResolution === "CHECKING" || phoneCustomer.isPending || couponPreview.isPending) { notify.warn("انتظر اكتمال التحقق", "جارٍ حسم العميل أو الكوبون قبل حفظ الطلب."); return; }
    if (couponCode) { notify.warn("لا يمكن حفظ طلب عليه كوبون", "أزل الكوبون ثم احفظ، أو ثبّت البيع مباشرةً ليُعاد التحقق من الكوبون ويُستهلك ذرّياً."); return; }
    if (cart.some((line) => line.digital)) { notify.err("الكروت والاشتراكات لا تُحفظ كمسودة؛ يجب تنفيذها وتثبيتها فوراً مع اتصال فعّال."); return; }
    if (draftPromotionPending) {
      if (!canActionRef.current("reception.draftResolvePromotion")) return notify.err("التحقق من نتيجة الحفظ غير مفوض لحسابك");
      try { const payload = getDraftPayload(), resolved = await resolvePromotionM.mutateAsync({ branchId, shiftId: draftPromotionShiftId, clientRequestId: reqIdRef.current, ...payload }); if (resolved?.payloadMatches) { await attachResolvedPromotion(resolved); return; } if (resolved) { if (!clearPersistedWorkspace(true)) { setWorkspaceSafetyBlocked(true); return; } reqIdRef.current = crypto.randomUUID(); setDraftPromotionPending(false); setDraftPromotionShiftId(null); setDetachedRecoveryPending(true); notify.warn("فُصلت هذه السلة عن محاولة جهاز آخر", "المفتاح استُعمل بحمولة مختلفة؛ بقي الطلب الخادمي محفوظاً وهذه نسخة محلية جديدة للمراجعة والحفظ."); return; } }
      catch { notify.warn("تعذّر التحقق من محاولة الحفظ", "أبقينا السلة محجوبة؛ تحقق من الاتصال ثم اضغط الزر مرة أخرى."); return; }
    }
    const promotionShiftId = shift?.id ?? null;
    if (!canActionRef.current("reception.draftPromote")) return notify.err("حفظ طلب جديد غير مفوض لحسابك");
    if (!markDraftPromotionPending(promotionShiftId)) { notify.warn("تعذّر تأمين محاولة الحفظ", "لم نرسل الطلب لأن المتصفح لم يستطع حفظ مفتاح منع التكرار؛ حرّر مساحة التخزين أو أعد تحميل الصفحة."); return; }
    setDraftPromotionPending(true); setDraftPromotionShiftId(promotionShiftId); const epoch = ++draftResumeEpochRef.current;
    draftPromotionFlightRef.current = true; setDraftTransitionPending(true);
    try {
      const r = await promoteM.mutateAsync({ branchId, shiftId: shift?.id ?? null, clientRequestId: reqIdRef.current, ...getDraftPayload() });
      if (epoch !== draftResumeEpochRef.current) { void utils.reception.draftList.invalidate(); return; }
      setDraftPromotionPending(false); setDraftPromotionShiftId(null);
      if (r.idempotentReplay) {
        await attachResolvedPromotion(r); return;
      }
      const draft = { id: r.draftId, version: r.version }; activeDraftRef.current = draft; setActiveDraft(draft);
      setDraftInfo({ draftNumber: r.draftNumber }); setDraftHeld("0.00"); setDetachedRecoveryPending(false);
      notify.ok(`حُفظ الطلب — ${r.draftNumber}`, "يُزامَن تلقائياً مع كل تعديل، ويستطيع زميلك إكماله من جهازه");
      void utils.reception.draftList.invalidate();
    } catch (error) { if (epoch === draftResumeEpochRef.current) { if (isDefinitiveReceptionPromotionRejection(error)) { setDraftPromotionPending(false); setDraftPromotionShiftId(null); notify.err(error, "رفض الخادم حفظ الطلب؛ صحّح البيانات ثم أعد المحاولة"); } else notify.warn("لم يُحسم وصول طلب الحفظ", "لا تقبض ولا تثبّت ولا تعدّل السلة؛ أعد الضغط على حفظ الطلب ليفحص الخادم المفتاح نفسه."); void utils.reception.draftList.invalidate(); } }
    finally { draftPromotionFlightRef.current = false; if (epoch === draftResumeEpochRef.current) setDraftTransitionPending(false); }
  }
  /** ش٣ — التثبيت الذرّي من المسوّدة نفسها (يستبدل جسر «الطيّ» المؤقّت من ش٢). */
  const commitDraftM = trpc.reception.draftCommit.useMutation();

  /** مزامنة بالجملة بdebounce (§٦ — لا سطراً-سطراً: مسح ١٢ باركوداً متتابعاً يمرّ بلا CONFLICT).
   *  النسخة تُقرأ من ref **لحظة الإطلاق** لا من closure الجدولة (مراجعة عدائية — سباق ذاتي المنشأ). */
  useEffect(() => {
    if (!activeDraft || !canActionRef.current("reception.draftSync") || offline || draftTransitionPending) return;
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    draftSyncTimer.current = setTimeout(() => { void flushActiveDraft(); }, 800);
    return () => { if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, checkoutCharges, customer.customerId, customer.name, customer.phone, effectiveTier, channel, channelHandle, linkedConversationId, activeDraft?.id, offline, draftTransitionPending]);

  /** استئناف مسوّدة (من هذا الجهاز أو جهاز زميل): صفوفٌ حيّة عبر catalog.byUnitIds + مواصفة CUSTOM من printSpec. */
  async function resumeDraft(draftId: number, isHydrationCurrent: () => boolean = () => true, forceReload = false, shadow?: ReceptionServerDraftPointer): Promise<boolean> { return ReceptionResumeDraft({ onCommittedRecovery:(id)=>extraCheckout.recoverDraft(id), branchId, offline, activeDraftRef, phoneResolution, phoneCustomer, couponPreview, draftResumeEpochRef, setDraftTransitionPending, draftSyncTimer, draftSyncQueueRef, workspaceDirty, flushActiveDraft, utils, handleDraftSyncFailure, setActiveDraft, setDraftRestoreRecovery, restoreLocalWorkspace, setDraftHeld, setDraftInfo, setDetachedRecoveryPending, clearCouponIfApplied, setCheckoutCharges, setCart, setReceptionPhone, prevCustomerIdRef, setCustomer, setTierOverride, setChannel, setChannelHandle, setLinkedConversationId, setPayInput, setMethod, setPaymentReference, setDeferred, setCustomerCreditLimit, setInvoiceDiscountPct, setCouponInput, onPaymentScopeChanged: workspaceState !== "HYDRATING" ? () => { splitTender.reset(); reqIdRef.current = crypto.randomUUID(); } : undefined }, draftId, isHydrationCurrent, forceReload, shadow); }

  async function recoverDraftFromServer() { const recovery = draftRestoreRecovery; if (!recovery?.serverAvailable || !(await resumeDraft(recovery.snapshot.activeDraftId, () => true, true))) return; if (!clearPersistedWorkspace(true)) { setWorkspaceSafetyBlocked(true); return; } setDraftRestoreRecovery(null); setDetachedRecoveryPending(false); notify.ok("حُمّلت نسخة الخادم", "أُهملت النسخة المحلية بعد اختيارك ولم تعد قابلة للتثبيت المكرر."); }
  async function recoverDraftAsLocalCopy() { const recovery = draftRestoreRecovery; if (!recovery || !(await restoreLocalWorkspace(recovery.snapshot.pendingLocal, () => true, true))) return; reqIdRef.current = crypto.randomUUID(); if (!clearPersistedWorkspace(true)) { setWorkspaceSafetyBlocked(true); return; } setDraftRestoreRecovery(null); setDetachedRecoveryPending(true); notify.warn("استُعيدت نسخة محلية منفصلة", "راجعها واحفظها كطلب جديد قبل قبض مبلغ أو التثبيت؛ قد تكون بعض تعديلات النسخة القديمة وصلت إلى الخادم."); }

  async function printDraftTicketById(draftId: number) { return ReceptionDraftTicket({ utils }, draftId); }

  async function handleSubmit(opts: { quickFullPay: boolean; openingConfirmed?: boolean; isReservation?: boolean }) {
    if (blockingDialogOpen) return;
    if(extraChargeAmount.gt(0)&&(offline||hasDigitalCards))return notify.err("الأجور الإضافية تحتاج اتصالاً بالخادم ولا تشمل الكروت الرقمية");
    if (!receptionCheckoutPaths(hasDigitalCards, !!activeDraftRef.current, offline, assignsDelivery).every(canActionRef.current)) return notify.err("تفويضات تنفيذ هذه العملية غير مكتملة");
    if (draftTransitionPending || draftPromotionFlightRef.current) return; if (draftPromotionPending) { notify.warn("نتيجة حفظ الطلب غير محسومة", "أعد الضغط على حفظ الطلب للتحقق قبل أي تثبيت."); return; } if (detachedRecoveryPending) { notify.warn("لا تثبّت نسخة الاسترداد مباشرةً", "راجعها ثم احفظها كطلب محفوظ جديد؛ هذا يمنع تكرار طلب ربما وصلت بعض تعديلاته إلى الخادم."); return; }
    if (splitTender.active && (offline || hasDigitalCards)) return notify.err("تقسيم الدفع يحتاج اتصالاً بالخادم ولا يشمل الكروت الرقمية.");
    const splitPayments = splitTender.active ? splitTender.payments((cart.length?expectedNowD:extraChargeAmount).toFixed(2)) : undefined;
    if (splitTender.active && !splitPayments) return notify.err(splitTender.problem((cart.length?expectedNowD:extraChargeAmount).toFixed(2)) ?? "راجع الدفعات المقسّمة.");
    if(!cart.length&&extraChargeAmount.gt(0)){if(phoneResolution==="CHECKING"||phoneCustomer.isPending)return notify.warn("انتظر اكتمال حسم العميل قبل القبض");if(activeDraftRef.current)return notify.err("أكمل بنود الطلب المحفوظ أو فرغه قبل قبض أجور منفصلة");await extraCheckout.submitOnly({payments:splitPayments??undefined,method,payInput,proof:feePayment.tender,confirmed:splitTender.active||feePayment.confirmed});return;}
    const preparation = await prepareReceptionSubmission({ activeDraftRef, activeDraft, couponCode, phoneResolution, phoneCustomer, couponPreview, method: splitTender.active ? "CASH" : method, cart, shift, setSelKey, offline, connState, orderDelivery, deferred, rawInvoiceDiscountPctD, opts: splitTender.active ? { ...opts, quickFullPay: false } : opts, paidD, payInput: splitPayInput, sumDirectNetD, expectedNowD, paymentReference, mixedRoundEligible, heldD, effectiveGrandD, mixedDeltaD, cashRoundActive, customer, receptionPhone, customerSectionRef, canCreateCustomer });
    if (!preparation || !shift) return;
    const { hadActiveDraftAtSubmit, hasCustomLines, isReserve, mixedRoundApplied, mixedDeltaAppliedD, printLines, customWithDeposits, effectiveWoDelivery, regularLines, hasGrandShortfall, hasDirectShortfall, appliedPaidD, routeDeliveryToWO, digitalLines, draftAtSubmit, inputPaidD } = preparation;
    // تَفعيل قَفل الإرسال **قبل** ensureCustomerId لمنع سباق نَقر مَزدوج يُنشئ عميلاً مكرَّراً
    if ((heldDelivery > 0 || extraChargeAmount.gt(0)) && (!feePayment.confirmed || (!splitTender.active && method !== "CASH" && !D(feePayment.goodsAmount).eq(appliedPaidD)))) {
      setPayInput(appliedPaidD.toFixed(2));
      notify.warn("أكّد مبلغ القبض قبل التثبيت", "راجع مبلغ البضاعة وأجرة التوصيل، ثم أكّد عملية الدفع الظاهرة وأعد التثبيت.");
      return;
    }
    // (ensureCustomerId يَحتوي عميلية confirm() غير متزامنة).
    if (submitting) return;
    setSubmitting(true);

    // انقطاعٌ معلوم: لا نُرسل ثم ننتظر مهلة — نلتقط فوراً. (الالتقاط نفسه يفرض شروطه:
    // بلا أوامر شغل، نقديّ كامل، بلا كوبون/توصيل، والجهاز مُفعَّل للالتقاط.)
    if (isDisconnected(connState)) {
      if (!customer.customerId) {
        notify.err("إضافة عميل جديد وربطه تحتاج اتصالاً بالخادم — أعد الاتصال ثم أكمل الطلب");
        setSubmitting(false);
        return;
      }
      reservePrintWindow();
      if (!(await captureOfflineReception(hadActiveDraftAtSubmit))) releaseReservedPrintWindow();
      setSubmitting(false);
      return;
    }

    reservePrintWindow();
    const receptionLabelWin = orderDelivery && !routeDeliveryToWO ? preopenShippingLabelWindow() : null;

    // هوية العميل: في البيع النقدي العابر اختياري، وفي التخصيص أو عند إدخال هاتف صحيح يُربط بالعميل
    let customerId: number | null = customer.customerId ?? null;
    if (customerId == null && isValidIqMobile(receptionPhone)) {
      try {
        customerId = await ensureCustomerId();
      } catch (e: unknown) {
        if (hasCustomLines || deferred || isReserve) {
          releaseReservedPrintWindow();
          try { receptionLabelWin?.close(); } catch { /* noop */ }
          setSubmitting(false);
          notify.err(e instanceof Error ? e.message : "تعذّر حفظ العميل");
          return;
        }
      }
    }

    let checkoutCommitted = false;
    let builtDeparture: DeliveryDepartureData | null = null;
    try {
      const printedAt = new Date();
      const receiptPhone = receptionPhone;
      const rawCustomerName = customer.name.trim();
      const customerName = rawCustomerName && rawCustomerName.replace(/\D/g, "") !== receiptPhone?.replace(/\D/g, "")
        ? rawCustomerName
        : receiptPhone ? `عميل ${receiptPhone}` : null;
      // ش٠ (V1): عند سريان التقريب (بيع مباشر خالص) يُرسَل مبلغ البيع **مقرَّباً** — الخادم يعيد
      // التقريب بنفس الدالة فيتطابقان، ويقيّد الفرق ADJUST. السلة الخالصة ⇒ مجموع الأسطر = الإجمالي.
      // ش٦: عند التقريب المختلط يُبيَّت فرق السلّة كلّها في مبلغ الفاتورة الحاملة، ويُسمّى
      // للخادم بـcashRoundingOverride فيقيّد الفرق ADJUST عليها.
      // ٢٣/٨: مبلغُ البيع = صافي أسطر البيع بعد خصم رأس الفاتورة (regularSumRawD − invoiceDiscountAmountD)
      // + فرق التقريب إن وُجد. الخادم يستقبل الخصمَ مطلقاً في `regularSale.invoiceDiscount` ويعيد
      // computeInvoiceTotals، فينتج نفس الرقم بالضبط ⇒ توزيعُ المدفوع لا يُخطئ التخصيص.
      const { directCheckoutPayload, deliveryPayload, saleAmount, printAmount, checkoutPaymentMode, hasCarrierInvoice } = buildReceptionCheckoutPayload({ payments: splitPayments ?? (extraChargeAmount.gt(0)?[{amount:inputPaidD.toFixed(2),method:method as "CASH"|"CARD"|"TRANSFER"|"WALLET",externalPaymentAttemptId:feePayment.tender?.externalPaymentAttemptId,externalPaymentDeviceId:feePayment.tender?.externalPaymentDeviceId}]:undefined), checkoutCharges, heldDelivery: D(heldDelivery).toFixed(2), deliveryFeeTender:heldDelivery>0?feePayment.tender:null, branchId, cashRoundActive, effectiveGrandD, regularSumRawD, invoiceDiscountAmountD, mixedRoundApplied, mixedCarrier, mixedDeltaAppliedD, printLines, customWithDeposits, effectiveWoDelivery, method, paymentReference, channel, channelHandle, receptionPhone, regularLines, orderDelivery, hasGrandShortfall, isReserve, hasDirectShortfall, deferred, customer, shift, customerId, customerName, receiptPhone, appliedPaidD, orderFeeHeldD, routeDeliveryToWO, opts, mgrCredsRef, reqIdRef, effectiveTier, couponCode });
      if (digitalLines.length > 0) {
        try { receptionLabelWin?.close(); } catch { /* noop */ }
        const prepared = await prepareIntent.mutateAsync({
          branchId,
          shiftId: shift.id,
          clientRequestId: reqIdRef.current,
          paymentMethod: "CASH",
          cartFingerprint: reqIdRef.current,
          customerId: customerId ?? undefined,
          priceTier: effectiveTier,
          sourceType: "RECEPTION",
          // لا نخزّن بيانات اعتماد المدير داخل لقطة النيّة. هذا المسار يمنع الخصومات أصلاً.
          sourcePayload: { ...directCheckoutPayload, managerApproval: undefined, deferredDirect: false },
          regularLines: regularLines.map((line, index) => ({
            lineKey: `regular:${index}:${line.row.productUnitId}`,
            variantId: line.row.variantId,
            productUnitId: line.row.productUnitId,
            quantity: String(line.qty),
          })),
          lines: digitalLines.map((line) => toDigitalPrepareLine(line.digital!)),
        });
        digitalCheckoutRef.current = { appliedPaidD, customerId, customerName, shiftId: shift.id };
        setDigitalFinalizeError(null);
        setFulfillIntentId(prepared.intentId);
        return;
      }

      // ش٣: طلبٌ محفوظٌ (مسوّدة نشطة) يُثبَّت **من مسوّدته** ذرّياً عبر reception.draftCommit —
      // idempotency ثلاثية (version + FOR UPDATE + commitRequestId الخادمي). قبله «تفريغُ
      // مزامنةٍ» متزامنٌ يقتل سباق «عدّلتُ ثم ثبّتُّ قبل نبضة الـdebounce»، وexpectedTotal
      // (الخام قبل تقريب IQD) حزام أمانٍ ضدّ انجراف العرض.
      const result = draftAtSubmit
        ? await (async () => {
            if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
            const live = activeDraftRef.current ?? draftAtSubmit;
            // تفريغ المزامنة قبل التثبيت (يقتل سباق التعديل قبل نبضة debounce). مراجعة عدائية:
            // إن رُفض بـ«ثُبِّتت فاتورةً» (فُقد ردُّ تثبيتٍ سابق) **نتابع** إلى commitDraft —
            // الخادم يعيد النتيجة المبنيّة من مفاتيح idempotency، لا نفكّ الربط فنزدوج بمسارٍ مباشر.
            let commitVersion = live.version;
            const syncOutcome = await flushActiveDraft(customerId, false);
            if (syncOutcome.ok) {
              commitVersion = syncOutcome.version;
            } else {
              const code = (syncOutcome.error as { data?: { code?: string } })?.data?.code;
              if (code !== "PRECONDITION_FAILED") {
                handleDraftSyncFailure(syncOutcome);
                throw syncOutcome.error;
              }
              const currentDraft = await utils.reception.draftGet.fetch({ draftId: live.id }, { staleTime: 0 });
              if (currentDraft.status !== "COMMITTED") { handleDraftSyncFailure(syncOutcome); throw syncOutcome.error; }
              // COMMITTED فقط: commitDraft يعيد النتيجة نفسها (rebuild يسبق فحص version).
            }
            const committed = await commitDraftM.mutateAsync({
              draftId: live.id,
              version: commitVersion,
              expectedTotal: round2(grandTotalD).toFixed(2),
              shiftId: shift.id,
              ...checkoutExtraPayload(checkoutCharges),
              payments: directCheckoutPayload.payments,
              collectNow: !directCheckoutPayload.payments && appliedPaidD.gt(0)
                ? { amount: round2(appliedPaidD).toFixed(2), method, reference: method === "CASH" ? undefined : paymentReference.trim() }
                : null,
              // ش٦: العلم يشمل المختلط — materialize خادمياً يعيد اشتقاق الهدف والفرق من الأسطر.
              cashRoundIQD: cashRoundActive || mixedRoundApplied,
              // ش٦ (V15): أجرة توصيل الطلب المقبوضة الآن — إيصال أمانةٍ نقديّ مع الفاتورة.
              deliveryFeeHeld: heldDelivery > 0 ? D(heldDelivery).toFixed(2) : undefined,
              deliveryFeeTender: heldDelivery>0?(feePayment.tender??undefined):undefined,
              // مراجعة PR #495: الإسناد داخل نفس معاملة التثبيت (لا نداءً لاحقاً).
              delivery: deliveryPayload,
              // الاستقبال (٨/٨): تأكيد توفّر الأصناف غير المجرودة فيزيائياً (بيع بالسالب لطلب COD في الافتتاح).
              openingSellUnavailableConfirmed: opts.openingConfirmed === true,
              managerApproval: mgrCredsRef.current ?? undefined,
            });
            setActiveDraft(null);
            setDraftHeld("0.00");
            setDraftInfo(null);
            void utils.reception.draftList.invalidate();
            return committed;
          })()
        : await checkoutM.mutateAsync(directCheckoutPayload);
      checkoutCommitted = true; extraCheckout.committed(result,reqIdRef.current);

      const invoiceId = result.regularSale?.invoiceId ?? result.printSale?.invoiceId ?? null;
      const createdWoIds = result.workOrders.map((order) => order.workOrderId);

      // مراجعة PR #495 — الإسناد **جزءٌ من الالتزام نفسه** (لا نداء لاحق): إن فشل لم يُلتزَم
      // شيءٌ أصلاً ووصلت رسالة الخادم للكاشير قبل الطباعة. هنا لا يبقى إلا إعلانُ النتيجة.
      if (orderDelivery) {
        const dispatched = (result as { dispatch?: { consignmentNumber: string; codAmount: string } | null }).dispatch;
        if (dispatched) {
          notify.ok(
            `أُسند الطلب للتوصيل — ${orderDelivery.partyName}`,
            `إرسالية ${dispatched.consignmentNumber} — يُحصَّل عند الاستلام ${fmt(dispatched.codAmount)} د.ع`,
          );
          void utils.delivery.invalidate();
          const pObj = (partiesQ.data ?? []).find((p) => Number(p.id) === Number(orderDelivery.partyId));
          builtDeparture = buildReceptionDepartureData({
            dispatched, result, cart, customerName, receiptPhone, orderDelivery, courierPhone: pObj?.phone,
          });
          setDeliveryDeparture(builtDeparture);
        } else if (routeDeliveryToWO) {
          // ٨/٨ — أمر شغلٍ خالص: التوصيل مُثبَّتٌ على الأمر نفسه (لا إرسالية الآن — يُسنَد
          // للمندوب من طابور الطلبات عند الجاهزية). نجاحٌ لا تحذير («وكأنه غير موجود» سابقاً).
          notify.ok(
            `التوصيل مُثبَّتٌ على الطلب — ${orderDelivery.partyName}`,
            "يُسنَد للمندوب من طابور الطلبات عند جاهزية الطلب — العنوان والأجرة وطريقة قبضها محفوظة على الأمر.",
          );
          void utils.workOrders.list.invalidate();
        } else {
          notify.warn(
            "لم يُسنَد التوصيل تلقائياً",
            invoiceId == null
              ? "الطلب أوامر شغلٍ فقط بلا فاتورة — التوصيل يُرتَّب على بند الطلب نفسه أو عند التسليم"
              : "الطلب سبق تثبيته (إعادة إرسال) — أسنده من زرّ «إسناد للتوصيل» على فاتورته",
          );
        }
        setOrderDelivery(null);
      }

      // ٥/٨ — إيصال الاستقبال كان يُبنى بقيمٍ مثبَّتة (paid = الإجمالي دائماً، change = 0 دائماً،
      // بلا خصمٍ ولا هاتفٍ ولا آجل) فيخرج ناقص المعلومات مقارنةً بإيصال التجزئة الذي يمرّ بمُحوّلٍ
      // موحّد. صار يُبنى بمُحوّلٍ واحد هنا يحمل الحقيقة كاملةً: الخصم على السطر، هاتف الزبون،
      // الفكّة الحقيقية على أول إيصال، والمتبقّي آجلاً إن وُجد.
      const { printedChange, printedCredit, receiptsToPrint, workOrdersToPrint } = buildReceptionCheckoutReceipts({ customerName, receiptPhone, method: splitTender.active && splitTender.hasCash ? "CASH" : method, inputPaidD, expectedNowD, appliedPaidD, result, shift, orderDelivery, printLines, regularLines, saleAmount, printAmount, checkoutPaymentMode, printedAt, me, hasCarrierInvoice, invoiceDiscountAmountD, customWithDeposits, effectiveWoDelivery });
      // نجاح الحفظ لا يُلغى إذا تعذّرت الطابعة. نحاول المسارات بالترتيب الموحّد:
      // جسر الخادم ← WebUSB ← نافذة طباعة المتصفح، ثم نُفرغ السلة دائماً.
      await presentReceptionCheckout({ receiptsToPrint, printAuthorizedReceiptData, workOrdersToPrint, invoiceId, createdWoIds, isReserve, result, setLastSale, effectiveGrandD, printedChange, printedCredit, checkoutPaymentMode, setShowReceiptOverlay, resetAfterCommittedWorkspace, utils });
      releaseReservedPrintWindow();
      if (builtDeparture) {
        const autoSummary: LastSaleSummary = { invoiceNumbers: [result.regularSale?.invoiceNumber, result.printSale?.invoiceNumber].filter(Boolean) as string[], workOrderNumbers: result.workOrders.map((o) => o.orderNumber).filter(Boolean), totalStr: round2(effectiveGrandD).toFixed(2), changeStr: printedChange, creditStr: printedCredit, paymentMode: checkoutPaymentMode, receipts: receiptsToPrint, workOrders: workOrdersToPrint, printFailures: 0 };
        const renderAutoLabel = async () => { const lblRes = await triggerReceptionShippingLabel(autoSummary, builtDeparture, receiptPhone, { into: receptionLabelWin, isReprint: false }); return lblRes.ok ? { ok: true as const, via: "browser" as const } : { ok: false as const, via: "browser" as const, reason: "popup-blocked" as const }; };
        if (!workOrdersToPrint.length && invoiceId) void printAuthorizedDocument(invoiceId, "SHIPPING_LABEL", false, renderAutoLabel).catch(() => {});
        else void renderAutoLabel().catch(() => {});
      } else { try { receptionLabelWin?.close(); } catch { /* noop */ } }
    } catch (e: unknown) {
      try { receptionLabelWin?.close(); } catch { /* noop */ }
      // الاستقبال (٨/٨): حاصر البيع بالسالب في وضع الافتتاح — الصنف غير مجرود (رصيد سالب) وطلبٌ
      // بتوصيل COD. أثناء الافتتاح السالب يعني «لم يُعدّ» لا «نافد»، والمندوب يحمل الصنف الموجود
      // فعلياً. نعرض تأكيداً صريحاً (توفّر فيزيائيّ) مرّةً واحدة ثم نعيد بنفس opts + العلم.
      const errMsg = e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? "");
      const isOpeningNegativeBlock = !checkoutCommitted && !opts.openingConfirmed
        && (errMsg.includes("المخزون غير كافٍ") || errMsg.includes("البيع بالسالب"))
        && errMsg.includes("الافتتاح");
      if (isOpeningNegativeBlock) {
        releaseReservedPrintWindow();
        setSubmitting(false);
        const ok = await confirm({
          variant: "warning",
          title: "صنفٌ غير مجرود في وضع الافتتاح",
          description: "أحد الأصناف رصيده سالب (لم يُجرَد بعد). أكّد أنه **متوفّر فيزيائياً** لتسليمه — سيُباع بالسالب ويُصحَّح رصيده عند الجرد الافتتاحيّ. لا تؤكّد إن لم يكن الصنف موجوداً فعلاً.",
          confirmText: "مؤكَّد — الصنف متوفّر، أكمِل البيع",
        });
        if (ok) void submitRef.current?.({ ...opts, openingConfirmed: true });
        return;
      }
      // فخّ «النقرة الأولى» بعد قطعٍ صامت: المتصفّح لم يُحدِّث حالة الاتصال بعد, فيفشل النقل
      // بلا كود tRPC. تدهورٌ سلس: نلتقط بدل أن نُعيد خطأً غامضاً والنقد بيد الموظّف.
      // شرطٌ حاسم: **لم يلتزم شيء** (checkoutCommitted=false) — وإلا لَازدوجت العملية.
      const isTransportFailure = !checkoutCommitted && !hadActiveDraftAtSubmit
        && (e as { data?: { code?: string } } | null)?.data?.code == null;
      if (isTransportFailure && !extraChargeAmount.gt(0) && (await captureOfflineReception())) {
        return;
      }
      releaseReservedPrintWindow();
      // لا توجد حالة التزام جزئي. عند غياب رد الشبكة قد تكون المعاملة كلها التزمت أو كلها
      // تراجعت؛ المفتاح الثابت يجعل إعادة الإرسال تستعيد النتيجة بلا تكرار.
      //
      // ⚠️ ١٩/٨ (بلاغ حيّ من المالك): كانت جملة «لم يصل تأكيد العملية… أعد المحاولة بأمان»
      // تُلحَق بـ**كل** خطأ — بما فيه الرفض السياسيّ الواضح (حدّ ائتمان، صلاحية، شرط عمل).
      // فيقرأ الموظّف رسالتين متناقضتين: الخادم يقول «العميل نقديّ فقط» والشاشة تقول «غالباً
      // شبكة، أعد المحاولة» — فيعيد المحاولة بلا جدوى بدل أن يحصّل أو يستأذن المدير.
      // الغموضُ حقيقيٌّ **فقط** حين لا يردّ الخادم بكودٍ أصلاً؛ ومع كودٍ صريح تُعرَض رسالته وحدها.
      const serverAnswered = (e as { data?: { code?: string } } | null)?.data?.code != null;
      notify.err(e, checkoutCommitted
        ? "تم حفظ العملية كاملة، لكن تعذّر إكمال تجهيز المستندات؛ راجع الفواتير وأوامر الشغل"
        : serverAnswered
          ? undefined
          : "لم يصل تأكيد العملية؛ لا يمكن أن يكون جزء منها محفوظاً وحده. أعد المحاولة بأمان");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * التقاط سلّة الاستقبال دون اتصال — تعميم الأوفلاين على كاشير خدمات الزبائن.
   *
   * ما يُلتقَط: بضاعةٌ جاهزة و/أو خدمات طباعة، **مدفوعةٌ نقداً بالكامل**، بلا عميلٍ آجل.
   * ما لا يُلتقَط ويُرفَض صراحةً: **أوامر الشغل** — ترقيمها تسلسليّ خادميّ تحت قفل، وصورها
   * قد تبلغ ميغابايتات، وإسنادها وعربونها الجزئيّ قرارات خادمية. التقاطها كان سيُنتج طابوراً
   * يفشل ترحيله بصمت أو أرقاماً متصادمة من جهازين. الرفض هنا **أصدق** من التقاطٍ يكذب.
   *
   * النقد المقبوض يُطبَع عليه إيصالٌ مؤقّت OFF-… ويُرحَّل تلقائياً عبر offline.replayReception
   * بنفس clientRequestId ⇒ لا ازدواج حتى لو كان الالتزام قد وصل الخادم قبل انقطاع الردّ.
   */
    async function captureOfflineReception(hadActiveDraft = false): Promise<boolean> {
    if (splitTender.active) { notify.err("الدفعات المقسّمة لا تُرحّل دون اتصال؛ أعد التحقق بنفس العملية بعد عودة الاتصال."); return false; }
    return ReceptionOfflineCapture({ canActionRef, shift, cart, me, activeDraftRef, method, couponCode, heldDelivery, orderDelivery, payInput, grandTotalD, branchId, customer, effectiveTier, invoiceDiscountAmountD, reqIdRef, printAuthorizedReceiptData, sumDirectD, sumCustomD, resetAfterCommittedWorkspace }, hadActiveDraft);
  }

  // إصلاح P2 (٢٣/٦/٢٦): F4 كان يُمسك إغلاقاً بياناتيّاً قديماً (payInput/method/customer/shift)
  // لأن الاعتماديّات لم تَشملها ⇒ نقرة F4 بعد تعديل المبلغ تَنفّذ بمبلغ قديم. الحل: ref يَحمل
  // أحدث `handleSubmit` ⇒ المُستَمع يَستدعي ref.current دائماً.
  const submitRef = useRef<(opts: { quickFullPay: boolean; openingConfirmed?: boolean }) => void>(() => {});
  useEffect(() => {
    submitRef.current = handleSubmit;
  });

  /** F9 — إعادة طباعة مستندات آخر عملية (من أيّ مكان، حتى بعد إغلاق النافذة). */
  const reprintLastRef = useRef<() => void>(() => {});
  useEffect(() => {
    reprintLastRef.current = () => {
      if (!lastSale) {
        notify.warn("لا عملية سابقة لإعادة طباعتها");
        return;
      }
      reservePrintWindow();
      void (async () => {
        try {
          let failures = 0;
          for (const r of lastSale.receipts) {
            try {
              const printed = await printAuthorizedReceiptData(r, true);
              if (!printed.ok) failures += 1;
            } catch { failures += 1; }
          }
          for (const w of lastSale.workOrders) {
            try { await printWorkOrderReceipt(w); } catch { failures += 1; }
          }
          if (failures > 0) notify.err(`تعذّرت طباعة ${failures} مستند`);
          else notify.ok("أُعيدت طباعة مستندات آخر عملية");
        } finally {
          releaseReservedPrintWindow();
        }
      })();
    };
  });

  useReceptionShortcuts({ draftTransitionPending, blockingDialogOpen, showCustomization: !!showCustomization,
    showReceiptOverlay, cashDropping, approvalOpen: !!approvalAsk, showInbox, depositMenuOpen,
    discountOpen: !!discountFor, showDrop, cardsOpen, offline, depositOpen,
    canOpenCards: canAction("digitalCards.pos.listCards"), onReprint: () => reprintLastRef.current?.(),
    onFocusSearch: () => searchRef.current?.focus(), onSubmit: () => submitRef.current?.({ quickFullPay: false }),
    onClear: () => { void clearCartRef.current?.(); }, onCloseApproval: () => setApprovalAsk(null),
    onCloseDiscount: () => setDiscountFor(null), setShowReceiptOverlay, setCashDropping, setCardsOpen,
    setDepositOpen, setShowInbox, setDepositMenuOpen, setShowDrop });

  /** F12 — تفريغ بتأكيد (clearCart تُعرَّف بعد هذا الأثر ⇒ ref يحمل أحدث نسخة). */
  const clearCartRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    clearCartRef.current = clearCart;
  });

  // اقتراح الكاشير: لا يبني الواجهة قبل توفّر الفرع.
  if (me.isLoading || shiftQ.isLoading || workspaceState === "HYDRATING" || draftTransitionPending) return <div className="p-8 text-center text-muted-foreground">{draftTransitionPending ? "جارٍ حفظ الطلب والتحقق منه…" : ACTION_LABELS.loading}</div>;
  if (workspaceState === "BLOCKED" || workspaceSafetyBlocked) return <div className="flex h-full items-center justify-center bg-background p-4" dir="rtl"><div className="max-w-lg rounded-xl border bg-card p-6 text-center"><p className="mb-4 font-bold">{draftPromotionPending ? "محاولة حفظ غير محسومة ولا يجوز تفريغها. أعد الاتصال ثم تحقق منها أولاً." : draftRestoreRecovery ? "توجد نسخة محلية لمسوّدة تغيّرت على الخادم. لم نحذفها؛ اختر بوضوح أي نسخة تريد متابعتها." : "تعذّر استعادة الطلب المحفوظ بأمان. أعد تحميل الصفحة للمحاولة، أو ابدأ طلباً جديداً بعد تفريغه صراحةً."}</p><div className="flex flex-wrap justify-center gap-2">{draftPromotionPending ? <Button onClick={() => window.location.reload()}>إعادة التحقق</Button> : <>{draftRestoreRecovery?.serverAvailable && <Button onClick={() => void recoverDraftFromServer()}>تحميل نسخة الخادم</Button>}{draftRestoreRecovery && <Button variant="outline" onClick={() => void recoverDraftAsLocalCopy()}>استعادة المحلي للمراجعة</Button>}<Button variant="outline" onClick={() => { if (clearPersistedWorkspace()) { reqIdRef.current = crypto.randomUUID(); resetScreen(); } }}>تفريغ الحالة المحفوظة</Button></>}</div></div></div>;
  if (draftPromotionPending) return <div className="flex h-full items-center justify-center bg-background p-4" dir="rtl"><div className="max-w-lg rounded-xl border border-[var(--sem-warn)] bg-card p-6 text-center"><p className="mb-4 font-bold">محاولة حفظ الطلب لم يُحسم ردّها. السلة محجوبة عن التعديل والقبض والتثبيت حتى نتحقق كي لا يتكرر الطلب.</p><Button onClick={() => void saveDraft()} disabled={offline || promoteM.isPending}>التحقق وإعادة حفظ الطلب</Button></div></div>;

  // بوّابة وردية خدمة العملاء: لا عمل بلا وردية RECEPTION مفتوحة (درج/رصيد افتتاحي مستقلّ).
  if (!shift) {
    return (
      <ReceptionOpenShift branchId={branchId} opening={opening} setOpening={setOpening} bridge={bridge} connectPrinter={connectPrinter} printerReady={printerReady} canAction={canAction} openShiftM={{ isPending: openShiftM.isPending, mutate: (input) => { reservePrintWindow(); openShiftM.mutate(input); } }} canActionRef={canActionRef} />
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background" dir="rtl">
      {persistenceDegraded && <div role="alert" className="border-b border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] px-4 py-2 text-center text-xs font-bold text-[var(--sem-warn)]">الحفظ المحلي غير متاح الآن؛ أبقِ الشاشة مفتوحة واحفظ الطلب كمسودة خادمية قبل المغادرة.</div>}{detachedRecoveryPending && <div role="alert" className="border-b border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] px-4 py-2 text-center text-xs font-bold text-[var(--sem-warn)]">هذه نسخة استرداد منفصلة للمراجعة؛ احفظها كطلب جديد قبل القبض أو التثبيت.</div>}
      {/* نافذة إغلاق وردية خدمة العملاء (Z-report مستقلّ) */}
      {closing && shift && (
        <ReceptionShiftCloseDialog
          open={closing}
          onClose={() => setClosing(false)}
          shift={shift}
          branchName={branchName}
          cashierName={me.data?.name ?? "موظف الخدمة"}
          isElevatedRole={isElevatedRole}
        />
      )}
      {/* أربع مناطق حقيقية: تفاصيل أمر الشغل جزء من السلة، فلا نكررها كمرحلة مستقلة. */}
      <ReceptionWorkspaceHeader compactHeader={compactHeader} customerSectionRef={customerSectionRef} canReadChannels={canReadChannels} setShowInbox={setShowInbox} channel={channel} setChannel={setChannel} setChannelHandle={setChannelHandle} channelHandle={channelHandle} phoneCustomer={phoneCustomer} canCreateCustomer={canCreateCustomer} canReadCustomerContext={canReadCustomerContext} effectiveTier={effectiveTier} tierOverride={tierOverride} setTierOverride={setTierOverride} setHydratedAutomaticTier={setHydratedAutomaticTier} setDeferred={setDeferred} clearCouponIfApplied={clearCouponIfApplied} setCustomerContextId={setCustomerContextId} searchWrapRef={searchWrapRef} searchRef={searchRef} search={search} setSearch={setSearch} setShowDrop={setShowDrop} handleSearchScan={handleSearchScan} searchSettled={searchSettled} results={results} addRow={addRow} showDrop={showDrop} debounced={debounced} resultsEmpty={resultsEmpty} addManualService={addManualService} canActionRef={canActionRef} setCardsOpen={setCardsOpen} offline={offline} canAction={canAction} headerActionsNode={headerActionsNode} bridge={bridge} testServerPrint={testServerPrint} connectPrinter={connectPrinter} printerReady={printerReady} lastSale={lastSale} setCashDropping={setCashDropping} setClosing={setClosing} shift={shift} branchId={branchId} me={me} activeDraft={activeDraft} cart={cart} hasDigitalCards={hasDigitalCards} draftPromotionPending={draftPromotionPending} saveDraft={saveDraft} resumeDraft={resumeDraft} printDraftTicketById={printDraftTicketById} />

      {/* ─── الجسم: عمود السلة يملأ العرض؛ لوحة الدفع شريطٌ مستقلّ أسفله (خارج الحشوة، حافّة-لحافّة) ─── */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 pb-0">
        <ReceptionCartDuplicateAlert branchId={branchId} phone={receptionPhone || customer.phone || ""} customerId={customer.customerId}
          channel={channel} cart={cart} total={round2(grandTotalD).toFixed(2)} draftId={activeDraft?.id}
          disabled={hasDigitalCards} onVerify={() => void saveDraft()} />
        {/* ─ عمود العمل: تبويبات الورش تركب رأس السلة (§٨.١ — صفر تكلفة عمودية) ─ */}
        <div ref={cartSectionRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card outline-none focus:ring-2 focus:ring-primary/30">
          <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold">
              <ShoppingCart aria-hidden className="size-3.5" />
              {cart.length > 0 ? `السلة (${cart.length})` : "السلة"}
            </span>
            {cart.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="hidden text-[11px] text-muted-foreground sm:inline">{cartCount} وحدة</span>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void clearCart()}>
                  تفريغ
                </Button>
              </div>
            )}
            {/* مخارجُ الموظّف من شاشة عمله (المحطّة بلا شريطٍ جانبيّ). */}<div className="ms-auto flex flex-wrap items-center gap-1.5"><FulfillmentShortcuts branchId={branchId} offline={offline} /><a href="/reception/workflow?section=edit" className="inline-flex items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/5 px-2 py-1 text-xs font-extrabold text-primary hover:bg-primary/10"><FilePenLine aria-hidden className="size-3.5" /> تعديل فاتورة</a>
              <a
                href="/reception/handover"
                className="inline-flex items-center gap-1.5 rounded-lg border border-green-500 bg-green-50 px-2 py-1 text-xs font-extrabold text-green-700 hover:bg-green-100"
                title="تسليم الطلبات الجاهزة للزبون مباشرة"
              >
                <CheckCircle2 aria-hidden className="size-3.5" /> تسليم مباشر
              </a>
              <a
                href="/reception/workflow"
                className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-extrabold hover:bg-muted"
                title="إسناد للمندوب والتوصيل"
              >
                <Truck aria-hidden className="size-3.5" /> إسناد وتوصيل
              </a>
            </div>
          </div>

            <CartTable
              branchId={branchId}
              customerId={customer.customerId}
              cart={cart}
              selKey={selKey}
              onSelect={setSelKey}
              discountFor={discountFor}
              setDiscountFor={setDiscountFor}
              isElevated={isElevatedRole}
              onApplyDiscount={applyLineDiscount}
              changeQty={changeQty}
              setQty={setQty}
              removeRow={removeRow}
              onEditCustomization={(row, editingKey) => setShowCustomization({ row, editingKey })}
              onAddPlainCustomizationPiece={addPlainFromCustomization}
              grandTotal={grandTotal}
              cartCount={cartCount}
              addTick={addTick}
              effectiveTier={effectiveTier}
              onUnitChange={changeLineUnit}
            />
        </div>
      </div>

      {/* ─ لوحة الدفع — شريطٌ ثابتٌ حافّة-لحافّة أسفل الصفحة (خارج حشوة عمود السلة) ─
          آخر عنصرٍ في عمود الصفحة الجذر (flex-col)؛ منطقة السلة أعلاه وحدها flex-1/تُمرَّر،
          فزرّا الدفع لا يُدفَعان خارج الشاشة أبداً مهما ضاق الارتفاع أو تغيّر تكبير المتصفّح. */}
      <PaymentPanel chargesOnly={!cart.length&&extraChargeAmount.gt(0)} extraChargesSlot={extraCheckout.slot} extraChargeAmount={extraChargeAmount.toNumber()}
        deliveryFeePayment={heldDelivery > 0 || (!splitTender.active&&extraChargeAmount.gt(0)) ? feePayment : undefined}
        payInput={splitPayInput}
        setPayInput={setPayInput}
        deferred={deferred}
        setDeferred={setDeferred}
        deferredAvailable={deferredAvailable}
        deferredDisabledReason={deferredDisabledReason}
        deferredCustomerName={customer.customerId != null ? customer.name : null}
        method={method}
        setMethod={setMethod}
        paymentReference={paymentReference}
        setPaymentReference={setPaymentReference}
        needPaymentRef={splitTender.active ? heldDelivery > 0 && method !== "CASH" : needPaymentRef}
        splitTender={splitTender}
        splitDisabledReason={offline ? "تقسيم الدفع يحتاج اتصالاً بالخادم." : hasDigitalCards ? "الكروت الرقمية تتبع مسار تسديد مستقل." : null}
        grandTotal={grandTotal}
        expectedNow={cart.length?expectedNow:extraChargeAmount.toNumber()}
        cashRoundingDelta={cashRoundingDelta}
        sumDirect={sumDirect}
        sumCustom={sumCustom}
        heldDelivery={heldDelivery}
        cashDueNow={cashDueNow}
        orderDelivery={deliveryDisclosure}
        heldDeposit={round2(heldD).toNumber()}
        paid={paid}
        invoiceDiscountPct={invoiceDiscountPct}
        setInvoiceDiscountPct={setInvoiceDiscountPct}
        invoiceDiscountAmount={invoiceDiscountAmount}
        invoiceDiscountAllowed={invoiceDiscountAllowed}
        invoiceDiscountMaxPct={CASHIER_INVOICE_DISCOUNT_MAX_PCT}
        change={change}
        remaining={remaining}
        isChange={isChange}
        isOwing={isOwing}
        hasCustom={hasCustom}
        depositMenuOpen={depositMenuOpen}
        setDepositMenuOpen={setDepositMenuOpen}
        depositOptions={depositOptions}
        payAll={cart.length?payAll:()=>setPayInput(extraChargeAmount.toFixed(2))}
        couponCode={couponCode}
        couponLabel={couponLabel}
        couponInput={couponInput}
        setCouponInput={setCouponInput}
        couponOpen={couponOpen}
        setCouponOpen={setCouponOpen}
        applyCoupon={applyCoupon}
        clearCoupon={clearCoupon}
        couponPending={couponPreview.isPending}
        submitting={submitting||extraCheckout.pending} submitAllowed={submitAllowed}
        cartEmpty={cart.length === 0&&!extraChargeAmount.gt(0)}
        hasShift={!!shift}
        onSubmit={(opts) => void handleSubmit(opts)}
      />

      {/* شارة المزامنة */}
      <OfflineSyncChip userRole={me.data?.role} />

      {/* سحب نقدي من الدرج */}
      {cashDropping && shift && canAction("shifts.cashDrop") && (
        <CashDropDialog
          C={RECEPTION_TOKENS}
          shiftId={shift.id}
          onClose={() => setCashDropping(false)}
        />
      )}

      {/* ─── ش٤: حوار قبض العربون (على الطلب المحفوظ النشط) ─── */}
      {depositOpen && activeDraft && <DepositDialog draftId={activeDraft.id} draftNumber={draftInfo?.draftNumber ?? `طلب #${activeDraft.id}`} contactName={customer.name?.trim() || null} orderTotal={round2(grandTotalD).toFixed(2)} heldTotal={draftHeld} suggestedAmount={paidD.gt(0) ? round2(paidD).toFixed(2) : round2(sumCustomD.times(0.25)).toFixed(0)} currentShiftId={shift?.id ?? null} branchName={branchName} cashierName={me.data?.name ?? null} onClose={() => setDepositOpen(false)} onCollected={(total) => { setDraftHeld(total); setPayInput(""); void utils.reception.draftList.invalidate(); }} />}

      {/* ─── نافذة التخصيص ─── */}
      {showCustomization && <CustomizationDialog open productName={showCustomization.row.productName} price={showCustomization.row.price ?? "0"} quantity={showCustomization.editingKey ? cart.find((c) => c.key === showCustomization.editingKey)?.qty ?? 1 : 1} initial={showCustomization.editingKey ? cart.find((c) => c.key === showCustomization.editingKey)?.custom : emptyCustomization(showCustomization.row.productName)} staff={(staffQ.data ?? []).map((member) => ({ id: Number(member.id), name: member.name ?? null, role: member.role ?? null }))} canEditInternalCost={isElevatedRole} onAddPlain={!showCustomization.editingKey && showCustomization.row.variantId !== 0 ? () => { addDirectLine(showCustomization.row); setShowCustomization(null); searchRef.current?.focus(); } : undefined} onCancel={() => setShowCustomization(null)} onSave={saveCustomization} />}

      {customerContextId != null && <Contact360Panel kind="customer" id={customerContextId} onClose={() => setCustomerContextId(null)} onOpenContact={(kind, id) => { if (kind === "customer") setCustomerContextId(id); }} />}

      {/* ش١ (§٨.٦) — نافذة الإيصال بعد الإتمام */}
      {showReceiptOverlay && lastSale && <ReceiptOverlay lastSale={lastSale} deliveryDeparture={deliveryDeparture} onCloseDeliveryDeparture={() => setDeliveryDeparture(null)} onReprint={() => reprintLastRef.current?.()} onReprintLabel={() => { const render = async () => { const result = await triggerReceptionShippingLabel(lastSale, deliveryDeparture, customer.phone, { isReprint: true }); return result.ok ? { ok: true as const, via: "browser" as const } : { ok: false as const, via: "browser" as const, reason: "popup-blocked" as const }; }; if (!lastSale.workOrders.length) void printAuthorizedDocument(lastSale.receipts[0]?.invoiceId ?? 0, "SHIPPING_LABEL", true, render).catch((error) => notify.err(error)); else void render(); }} onClose={() => setShowReceiptOverlay(false)} />}

      {/* م٦ — اعتماد المدير للخصم >١٠٪ */}
      {approvalAsk && <ManagerApprovalDialog pct={approvalAsk.pct} onCancel={() => setApprovalAsk(null)} onApprove={(appr) => { mgrCredsRef.current = appr; setLineDiscount(approvalAsk.lineKey, approvalAsk.pct); setApprovalAsk(null); notify.ok(`خصم ${approvalAsk.pct}٪ بانتظار اعتماد المدير عند التثبيت`, "تُفحص بيانات المدير خادمياً لحظة إتمام الطلب"); }} />}

      <DigitalCardsPickerDialog
        open={cardsOpen}
        branchId={branchId}
        offline={offline}
        onClose={() => setCardsOpen(false)}
        onPickBasket={addDigitalBasket}
        existingReferences={cart.flatMap((line) => line.digital
          ? [{ providerId: line.digital.providerId, providerReference: line.digital.providerReference }]
          : [])}
        existingCardCount={cart.filter((line) => line.digital).length}
      />
      <DigitalFulfillmentDialog
        intentId={fulfillIntentId}
        finalizing={finalizeSale.isPending}
        finalizeError={digitalFinalizeError}
        onClose={() => { releaseReservedPrintWindow(); setFulfillIntentId(null); digitalCheckoutRef.current = null; }}
        onAllExecuted={(id: number) => {
          if (!canActionRef.current("digitalCards.sales.finalize")) { notify.err("تثبيت البيع الرقمي غير مفوض لحسابك"); return; }
          if (!finalizeSale.isPending && digitalCheckoutRef.current) finalizeSale.mutate({
            intentId: id,
            clientRequestId: reqIdRef.current,
            paymentAmount: round2(digitalCheckoutRef.current.appliedPaidD).toFixed(2),
            paymentMethod: "CASH",
            customerId: digitalCheckoutRef.current.customerId ?? undefined,
          });
        }}
      />
    </div>
  );
}
