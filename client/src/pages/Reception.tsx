import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import {
  ArrowRight,
  CalendarClock,
  Camera,
  Check,
  ClipboardList,
  Copy,
  Globe,
  HandCoins,
  MessageCircle,
  Music,
  Package,
  Palette,
  Phone,
  Printer,
  Receipt as ReceiptIcon,
  Search,
  ShoppingCart,
  Store,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { CustomizationDialog, type CustomizationData, composeCustomizationText, emptyCustomization } from "@/components/CustomizationDialog";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMediaQuery } from "@/hooks/useMobile";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { offlineFindByBarcode, offlineSearchCatalog, useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import {
  allocateOfflineReceiptNumber,
  assertCanCapture,
  enqueueOfflineItem,
  isOfflineSaleEnabled,
  type OfflineReceptionPayload,
} from "@/lib/offline/outbox";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2, roundCashIQD } from "@/lib/money";
import { notify } from "@/lib/notify";
import { parseScan } from "@/lib/scanRouter";
import { fmtDate } from "@/lib/date";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";
import ReservationsHub from "@/pages/ReservationsHub";
import Inbox from "@/pages/Inbox";
import OrderFulfillment from "@/pages/OrderFulfillment";
import ReceptionOrderQueue from "@/components/reception/ReceptionOrderQueue";
import { ReceptionInvoiceQueue } from "@/components/reception/ReceptionInvoiceQueue";
import { DraftStrip } from "@/components/reception/DraftStrip";
import { printDraftTicket } from "@/lib/printing/draftTicket";
// تفكيك §١٣ ش١ (٥/٨): الأنواع/الدوال النقيّة والمكوّنات الثقيلة (السلة/الدفع/الإيصال) صارت
// وحدات مستقلّة تحت components/reception — نقلٌ حرفيّ بصفر تغيير سلوكي.
import {
  customLineGrand,
  effectivePrice,
  isCustomKind,
  lineCounterHeldFee,
  lineTotal,
  PAY_METHOD_LABEL,
  TIER_LABEL,
  type CartLine,
  type LastSaleSummary,
  type PayMethod,
  type PosRow,
  type Tier,
  type Workshop,
} from "@/components/reception/cartMath";
import { CartTable } from "@/components/reception/CartTable";
import { PaymentPanel } from "@/components/reception/PaymentPanel";
import { ReceiptOverlay } from "@/components/reception/ReceiptOverlay";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import { WsTab } from "@/components/reception/WsTab";
import type { DispatchParty } from "@/components/delivery/DispatchDialog";
import { AppSelect } from "@/components/ui/AppSelect";
import { CashDropDialog } from "@/components/pos/CashDropDialog";
import type { PosTokens } from "@/components/pos/ShiftHandoverSection";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import {
  getServerBridgeStatus,
  isPaired,
  isWebUsbSupported,
  pairPrinter,
  printReceipt,
  printShiftClose,
  printShiftOpen,
  printWorkOrderReceipt,
  serverPrintTest,
  tryReconnectPrinter,
  type ReceiptBrowserData,
  type WorkOrderReceiptData,
} from "@/lib/printing/print";

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
const CUSTOMER_CREATE_ROLES = ["cashier", "manager", "sales_rep"] as const;
const STORE_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;
const CRM_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;

export default function Reception() {
  const [, navigate] = useLocation();
  const pageSearch = useSearch();
  const me = trpc.auth.me.useQuery();
  const reservationsRequested = useMemo(
    () => new URLSearchParams(pageSearch).get("workspace") === "reservations",
    [pageSearch],
  );
  const reservationPermissions = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const canReadReservations = me.data != null && moduleAccessAllowed(
    me.data.role,
    reservationPermissions,
    "reservations",
    "READ",
    RESERVATION_READ_ROLES,
  );
  const canReadChannels = me.data != null && moduleAccessAllowed(
    me.data.role, reservationPermissions, "channels", "READ", CHANNEL_READ_ROLES,
  );
  // مرآة بوّابة customers.create الخادمية بالضبط (customersCashierProcedure =
  // moduleProcedure(["cashier","manager","sales_rep"], "crm", "FULL") — server/trpc.ts).
  // مطابقتها هنا تُظهر/تُخفي زرّ «احفظه كعميل» بدل أن يفاجئ الموظّفَ رفضٌ في منتصف الدفع.
  const canCreateCustomer = me.data != null && moduleAccessAllowed(
    me.data.role, reservationPermissions, "crm", "FULL", CUSTOMER_CREATE_ROLES,
  );
  const canReadStoreOrders = me.data != null && moduleAccessAllowed(
    me.data.role, reservationPermissions, "store", "READ", STORE_READ_ROLES,
  );
  const canReadCustomerContext = me.data != null && moduleAccessAllowed(
    me.data.role, reservationPermissions, "crm", "READ", CRM_READ_ROLES,
  );
  const showReservations = reservationsRequested && canReadReservations;
  const openReservations = useCallback(
    () => navigate("/pos?mode=RECEPTION&workspace=reservations", { replace: true }),
    [navigate],
  );
  const closeReservations = useCallback(
    () => navigate("/pos?mode=RECEPTION", { replace: true }),
    [navigate],
  );

  useEffect(() => {
    if (!reservationsRequested || me.isLoading || canReadReservations) return;
    notify.err("لا تملك صلاحية قراءة الحجوزات");
    closeReservations();
  }, [reservationsRequested, me.isLoading, canReadReservations, closeReservations]);
  // الأدمن/المدير بلا فرع مُسنَد: يختار الفرع صراحةً قبل فتح وردية الخدمة بدل الإسناد الصامت للفرع ١
  // (نمط POS/PrintPOS، #274 — الوردية تحمل الفرع والطلبات تتبعها). لا يمسّ مستخدماً له فرع (يبقى فرعه).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = useMemo(
    () => Number(me.data?.branchId ?? pickedBranch ?? 1),
    [me.data?.branchId, pickedBranch],
  );
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";
  const noAssignedBranch = me.data != null && me.data.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && pickedBranch == null;

  // طبقة أوفلاين للقراءة فقط (نمط POS.tsx ش٢): أثناء انقطاع الاتصال يُخدَم البحث/الباركود من
  // النموذج المحلي (Dexie)، والكتابة (checkoutReception) تبقى أونلاين حصراً — قرار الخطة الأصلية
  // (لا عربون/تسليم أوفلاين للاستقبال، خلافاً للكاشير الذي يلتقط بيعاً نقدياً كاملاً أوفلاين).
  const connState = useConnectivity();
  const offline = isDisconnected(connState);
  useOfflineCatalogSync(me.data ? branchId : null);
  const utils = trpc.useUtils();

  // وردية خدمة العملاء (RECEPTION): درج/رصيد افتتاحي/عرابين مستقلّة عن كاشير التجزئة (RETAIL).
  const branchesQ = trpc.branches.list.useQuery();
  const staffQ = trpc.workOrders.assignableStaff.useQuery({ branchId });
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RECEPTION" });
  // اِستقبال (تكامل التوصيل، ٤/٨): عدّاد «جاهز» على زرّ طابور الطلبات — مؤشّر سريع بلا فتح الطابور.
  const woCountsQ = trpc.workOrders.counts.useQuery({ branchId });
  const woReadyCount = woCountsQ.data?.ready ?? 0;
  const shift = shiftQ.data ?? null;
  const [opening, setOpening] = useState("0");
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState("");
  const [countEntered, setCountEntered] = useState(false);
  const branchName = useMemo(
    () => (branchesQ.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
    [branchesQ.data, branchId],
  );

  const openShiftM = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      // العهدة الوسيطة: تحذيرٌ لينٌ عند عجز الخزينة (الضابط التعويضي لقرار «الفتح مسموح مع تحذير»).
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
      });
    },
    onError: (e) => notify.err(e),
  });


  // تقرير الوردية (Z) — يُحمَّل فقط عند فتح نافذة الإغلاق.
  const reportQ = trpc.shifts.report.useQuery({ shiftId: shift?.id ?? 0 }, { enabled: closing && !!shift });

  const closeShiftM = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = reportQ.data;
      void printShiftClose({
        shiftId: r.shiftId,
        openedAt: shift?.openedAt ?? null,
        closedAt: new Date(),
        cashierName: me.data?.name ?? "موظف الخدمة",
        branchName,
        openingBalance: r.openingBalance,
        invoiceCount: rep?.invoiceCount ?? 0,
        salesTotal: rep?.salesTotal ?? "0",
        payments: (rep?.payments ?? []).map((p) => ({
          method: p.method,
          direction: p.direction as "IN" | "OUT",
          count: Number(p.count),
          total: p.total,
        })),
        expectedCash: r.expectedCash,
        countedCash: r.countedCash,
        variance: r.variance,
      });
      setClosing(false);
      setCounted("");
      setCountEntered(false);
      await utils.shifts.current.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  // سلّم الاحتواء الديناميكي (ResizeObserver + درجات الكثافة) صار داخل PaymentPanel نفسه
  // (تفكيك §١٣ ش١) — الصفحة تحتفظ بالـref للتركيز فقط (goToWorkflowStep خطوة ٤).
  const paymentSectionRef = useRef<HTMLDivElement>(null);
  // ترويسة الصفحة تُقاس بالنافذة عمداً (لا باللوحة): تقليصها يُطيل اللوحة، فقياسها باللوحة
  // يصنع حلقة «يُخفى ⇒ تتّسع ⇒ يظهر ⇒ تضيق». النافذة مقياسٌ مستقلّ عن هذا التغذّي الراجع.
  const compactHeader = useMediaQuery("(max-height: 900px)");

  // ───── الحالة ─────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  // م٤: لوحة الأرقام صارت لوحة **مبلغٍ** خالصة — أوضاع الكمية/الخصم حُذفت (الكمية داخل الصفّ،
  // والخصم Popover في خلية السعر). لا وضعيّة خفيّة بعد اليوم: اللوحة تعني المبلغ دائماً.
  const [payInput, setPayInput] = useState("");
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [paymentReference, setPaymentReference] = useState(""); // P2 fix: مرجع البطاقة للعرابين
  const [showInbox, setShowInbox] = useState(false);
  // ش١ (§٨.١): ورش عمود العمل — الفواتير/الطلبات/طلبات الموقع تُركَّب داخل عمود السلة
  // (لوحة الدفع لا تُغطّى أبداً). الحجوزات/الرسائل تبقيان طبقتين (قرار §١٤.٦).
  const [workshop, setWorkshop] = useState<Workshop>("CART");
  // ش١: نافذة الإيصال بعد الإتمام + سحب نقدي + خصم داخل الصفّ + اعتماد مدير للخصم >١٠٪.
  const [lastSale, setLastSale] = useState<LastSaleSummary | null>(null);
  const [showReceiptOverlay, setShowReceiptOverlay] = useState(false);
  const [cashDropping, setCashDropping] = useState(false);
  const [depositMenuOpen, setDepositMenuOpen] = useState(false);
  const [discountFor, setDiscountFor] = useState<string | null>(null);
  const [approvalAsk, setApprovalAsk] = useState<{ lineKey: string; pct: number } | null>(null);
  /** اعتماد المدير للخصم >١٠٪ — يُحمل حتى الإرسال (يتحقّق خادمياً عند الالتزام). */
  const mgrCredsRef = useRef<{ email: string; password: string } | null>(null);
  // ش٢ (§٨.٢): المسوّدة المُرقّاة — السلّة محليّةٌ بالافتراض، وتترقّى بحفظٍ صريح؛ بعدها تُزامَن
  // بالجملة بdebounce ~٨٠٠مث وversion تفاؤليّ (تعارضُ زميلٍ ⇒ إعادة تحميلٍ لا طمس).
  const [activeDraft, setActiveDraft] = useState<{ id: number; version: number } | null>(null);
  const draftSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ش١: جهات التوصيل لورشة الفواتير (الإسناد من الصفّ) — تُجلب عند فتح الورشة فقط.
  const partiesQ = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { enabled: workshop === "INVOICES", staleTime: 60_000 },
  );
  const [customerContextId, setCustomerContextId] = useState<number | null>(null);
  const [showCustomization, setShowCustomization] = useState<{ row: PosRow; editingKey?: string } | null>(null);
  const [customer, setCustomer] = useState<SmartCustomerValue>({ customerId: null, name: "", phone: null, isNew: false });
  // فئة السعر: تلقائية من فئة العميل الافتراضية، وقابلة للتجاوز يدوياً (نمط POS.tsx effectiveTier).
  const [tierOverride, setTierOverride] = useState<Tier | null>(null);
  const [couponInput, setCouponInput] = useState("");
  // الكوبون مطويّ افتراضياً في الدرجات الضيّقة؛ هذه الراية تفتحه بطلب الموظّف.
  const [couponOpen, setCouponOpen] = useState(false);
  // ٥/٨ — «احفظه كعميل»: اختياريّ صراحةً. بلا تفعيله يبقى الاسم/الهاتف مرجعاً على الفاتورة فقط.
  const [saveAsCustomer, setSaveAsCustomer] = useState(false);
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [couponLabel, setCouponLabel] = useState<string | null>(null);
  const [channel, setChannel] = useState<"WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE">("WALK_IN");
  const [channelHandle, setChannelHandle] = useState("");
  const [workflowStep, setWorkflowStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [printerReady, setPrinterReady] = useState(isPaired());
  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({
    enabled: false,
    description: "",
  });

  // idempotency: مفتاح واحد لكل دورة إرسال — يتجدّد بعد النجاح.
  const reqIdRef = useRef<string>(crypto.randomUUID());
  const searchRef = useRef<HTMLInputElement>(null);
  const customerSectionRef = useRef<HTMLDivElement>(null);
  const cartSectionRef = useRef<HTMLDivElement>(null);

  // فئة العميل الافتراضية (لحلّ الفئة التلقائية — نمط POS.tsx fetchedCustomer/effectiveTier).
  const fetchedCustomer = trpc.customers.get.useQuery(
    { customerId: customer.customerId ?? 0 },
    { enabled: !!customer.customerId, staleTime: 60_000 },
  );
  const effectiveTier: Tier =
    tierOverride ?? ((fetchedCustomer.data?.defaultPriceTier as Tier | undefined) ?? "RETAIL");
  // تبديل العميل يُسقط أيّ تجاوز فئة يدوي سابق (تعلّق بعميلٍ آخر) وأيّ كوبون مُطبَّق (أسعاره
  // قد تختلف بفئة العميل الجديد — يلزم إعادة تطبيق).
  const prevCustomerIdRef = useRef<number | null>(customer.customerId);
  useEffect(() => {
    if (prevCustomerIdRef.current === customer.customerId) return;
    prevCustomerIdRef.current = customer.customerId;
    setTierOverride(null);
    if (couponCode) {
      setCouponCode(null);
      setCouponLabel(null);
      setCouponInput("");
      setCart((prev) => prev.map((c) => (c.custom ? c : { ...c, row: { ...c.row, promotionId: null, promotionName: null, promotionEffectivePrice: null } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.customerId]);

  const channelCustomerQ = trpc.customers.smartSearch.useQuery(
    { q: channelHandle.trim(), limit: 6 },
    { enabled: channel !== "WALK_IN" && channelHandle.replace(/\D/g, "").length >= 6, staleTime: 30_000 },
  );

  useEffect(() => {
    if (customer.customerId || channel === "WALK_IN") return;
    const digits = channelHandle.replace(/\D/g, "");
    if (digits.length < 6) return;
    const match = channelCustomerQ.data?.find((candidate) => (candidate.phone ?? "").replace(/\D/g, "") === digits);
    if (match) setCustomer({ customerId: Number(match.id), name: match.name, phone: match.phone ?? null, isNew: false });
  }, [channelCustomerQ.data, channelHandle, channel, customer.customerId]);

  const connectPrinter = async () => {
    try {
      await pairPrinter();
      setPrinterReady(true);
      notify.ok("تم ربط طابعة الإيصالات");
    } catch (e: unknown) {
      notify.err(e, "تعذّر ربط الطابعة");
    }
  };

  const testServerPrint = async () => {
    try {
      const result = await serverPrintTest();
      if (result.ok) notify.ok("أُرسلت تذكرة اختبار للطابعة عبر الخادم");
      else notify.err(result.error ?? "تعذّر اختبار الطابعة");
    } catch (e: unknown) {
      notify.err(e, "تعذّر اختبار جسر الطباعة");
    }
  };

  // نفس تكامل الطابعة في كاشير التجزئة وكاشير الطباعة: حالة جسر الخادم،
  // وإعادة ربط WebUSB الصامتة عند فتح الشاشة أو إعادة توصيل الطابعة.
  useEffect(() => {
    getServerBridgeStatus().then(setBridge).catch(() => { /* الجسر اختياري */ });
  }, []);

  useEffect(() => {
    if (!isWebUsbSupported()) return;
    tryReconnectPrinter()
      .then((ok) => setPrinterReady(ok))
      .catch(() => setPrinterReady(false));

    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    if (!usb) return;
    const onConnect = () => {
      tryReconnectPrinter()
        .then((ok) => setPrinterReady(ok))
        .catch(() => setPrinterReady(false));
    };
    const onDisconnect = () => setPrinterReady(false);
    usb.addEventListener("connect", onConnect);
    usb.addEventListener("disconnect", onDisconnect);
    return () => {
      usb.removeEventListener("connect", onConnect);
      usb.removeEventListener("disconnect", onDisconnect);
    };
  }, []);

  // ───── حسابات هجينة ───────────────────────────────────────────────────────
  const cartCount = cart.reduce((s, c) => s + c.qty, 0);
  const sumDirectD = cart.filter((c) => !isCustomKind(c)).reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumCustomD = cart.filter((c) => isCustomKind(c)).reduce((s, c) => s.plus(D(customLineGrand(c))), D(0));
  const grandTotalD = sumDirectD.plus(sumCustomD);
  const grandTotal = round2(grandTotalD).toNumber();
  const sumDirect = round2(sumDirectD).toNumber();
  const sumCustom = round2(sumCustomD).toNumber();
  // ٥/٨ — أجرة توصيلٍ تُقبض الآن أمانةً للمندوب: نقدٌ يدخل الدرج **خارج** الفاتورة (ليست بيعاً).
  // تُعرَض منفصلةً كي يعرف الموظّف كم يستلم فعلاً، ولا تُخلَط بإجمالي الفاتورة ولا بالمبلغ المُطبَّق.
  const heldDeliveryD = round2(cart.reduce((s, c) => s.plus(D(lineCounterHeldFee(c))), D(0)));
  const heldDelivery = heldDeliveryD.toNumber();
  const cashDueNow = round2(grandTotalD.plus(heldDeliveryD)).toNumber();

  // ش٠ (٥/٨، V1) — تقريب نقدي IQD لأقرب ٢٥٠ (نمط POS حرفياً): للبيع المباشر **الخالص** النقديّ
  // فقط (لا تخصيص ولا خدمات طباعة — السلة المختلطة بلا تقريبٍ حتى ش٦)، وأونلاين فقط: مسار
  // الالتقاط الأوفلايني يلتقط المبالغ غير المقرَّبة، فتفعيل التقريب معه يفصل ما رآه الزبون عمّا
  // سيُرحَّل (فرقٌ في الدرج يمنع الإغلاق). roundCashIQD نفس دالة الخادم ⇒ اتفاقٌ حتميّ على الفرق
  // الذي يقيّده الخادم قيدَ ADJUST.
  const hasPrintInCart = cart.some((c) => !isCustomKind(c) && c.row.isPrintService);
  const cashRoundActive = method === "CASH" && cart.length > 0 && !cart.some(isCustomKind) && !hasPrintInCart && !offline;
  const effectiveGrandD = cashRoundActive ? roundCashIQD(grandTotalD.toFixed(2)) : grandTotalD;
  const cashRoundingDelta = cashRoundActive ? round2(effectiveGrandD.minus(grandTotalD)).toNumber() : 0;

  // الدفع موحّد على كامل السلة. البيع المباشر هو الحد الأدنى؛ وما زاد يصبح عربوناً لأوامر الطباعة.
  const expectedNowD = effectiveGrandD;
  const expectedNow = round2(expectedNowD).toNumber();

  // ما أدخله الكاشير في لوحة الأرقام (مع تكيّف Quick Pay).
  const paidD = D(payInput || 0);
  const paid = round2(paidD).toNumber();
  const changeD = paidD.minus(expectedNowD);
  const change = round2(changeD).toNumber();
  const remainingD = effectiveGrandD.minus(paidD);
  const remaining = round2(remainingD).toNumber();
  const isChange = method === "CASH" && paidD.gt(0) && paidD.gte(expectedNowD);
  const isOwing = paidD.gt(0) && paidD.lt(expectedNowD);

  const hasCustom = cart.some(isCustomKind);
  const needPaymentRef = method !== "CASH" && paidD.gt(0);

  // ───── البحث ──────────────────────────────────────────────────────────────
  const debounced = useDebouncedValue(search, 180);
  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: effectiveTier, query: debounced, limit: 15, includeReceptionServices: true },
    { enabled: !offline && debounced.trim().length >= 2, placeholderData: keepPreviousData, staleTime: 15_000 },
  );
  // أوفلاين: البحث يُخدَم من النموذج المحلي بنفس شكل PosRow — بقية الشاشة (addRow/السلة/الأسعار)
  // لا تعرف الفرق. خدمات الطباعة مشمولة (includePrintServices) مطابقةً لـincludeReceptionServices
  // أونلاين. العروض/الكوبون/الأسعار التعاقدية معطّلة أوفلاين (الخطة الأصلية، نمط POS.tsx).
  const [offlineResults, setOfflineResults] = useState<PosRow[]>([]);
  useEffect(() => {
    if (!offline || debounced.trim().length < 2) {
      setOfflineResults([]);
      return;
    }
    let cancelled = false;
    void offlineSearchCatalog(debounced, effectiveTier, { limit: 15, includePrintServices: true }).then((rows) => {
      if (!cancelled) setOfflineResults(rows as PosRow[]);
    });
    return () => {
      cancelled = true;
    };
  }, [offline, debounced, effectiveTier]);
  const results = offline ? offlineResults : (searchResults.data ?? []);
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
      setCart((c) => c.map((line) => (line.custom ? line : { ...line, row: { ...line.row, promotionId: null, promotionName: null, promotionEffectivePrice: null } })));
      return null;
    });
  }, []);

  /** يضيف صنفاً جاهزاً (بلا تخصيص) بسعره العادي — يدمج مع سطرٍ مطابق غير مخصّص إن وُجد. */
  const addDirectLine = useCallback((row: PosRow) => {
    clearCouponIfApplied();
    setCart((prev) => {
      // دمج كميّات الصنف الجاهز المُكرَّر (لا تكرار سطر).
      const i = prev.findIndex((c) => !isCustomKind(c) && c.row.productUnitId === row.productUnitId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        setSelKey(next[i].key);
        return next;
      }
      const key = `d-${row.productUnitId}-${Date.now()}`;
      setSelKey(key);
      return [...prev, { key, row, qty: 1 }];
    });
    setWorkflowStep(3);
  }, []);

  const addRow = useCallback((row: PosRow) => {
    // إصلاح P2 (٢٣/٦/٢٦): حارس السعر **قبل** فتح نافذة التخصيص — كان يَسمح لمخصَّصٍ بلا سعرٍ
    // بالدخول للسلّة ثم يَفشل عند الإرسال (createWorkOrder يَرفض salePrice<=0) بَعد ما اَلتزَمت
    // فاتورة البيع — رحلةٌ بِنصف نتيجة. الحارس موحَّد للنوعين.
    if (row.price == null || Number(row.price) <= 0) {
      notify.err(`لا سعر ${TIER_LABEL[effectiveTier]} لـ ${row.productName} (${row.unitName}) — حدّد سعراً من /products أوّلاً`);
      return;
    }
    // المنتج المخصّص (products.isCustomizable=true) ⇒ افتح نافذة التخصيص (وفيها خيار «بلا تخصيص»
    // لعميلٍ يريد القطعة كما هي — انظر onAddPlain أدناه، إصلاح ٣/٨).
    if (row.isCustomizable) {
      setShowCustomization({ row });
      setSearch("");
      setShowDrop(false);
      return;
    }
    addDirectLine(row);
    setSearch("");
    setShowDrop(false);
    searchRef.current?.focus();
  }, [addDirectLine]);

  /** العميل يريد هذه القطعة تحديداً بلا تخصيص (بسعرها العادي) رغم أنّ صنفها قابلٌ للتخصيص — يسمح
   *  بمزج قطعةٍ مخصّصة وأخرى جاهزة من نفس المنتج في طلبٍ واحد. */
  function addPlain(row: PosRow) {
    addDirectLine(row);
    setShowCustomization(null);
    searchRef.current?.focus();
  }

  /** خدمة حرة كانت تُنشأ من صفحة «طلب خدمة جديد». أصبحت الآن سطراً داخل السلة نفسها. */
  function addManualService() {
    const row = {
      variantId: 0,
      productUnitId: 0,
      productName: "خدمة / أمر شغل",
      sku: "SERVICE",
      unitName: "خدمة",
      conversionFactor: "1",
      price: "0",
      stockBase: 0,
      isService: true,
      isPrintService: false,
      isCustomizable: true,
    } as PosRow;
    setShowCustomization({ row });
    setSearch("");
    setShowDrop(false);
  }

  function saveCustomization(data: CustomizationData) {
    if (!showCustomization) return;
    const { row, editingKey } = showCustomization;
    if (editingKey) {
      setCart((prev) => prev.map((c) => (c.key === editingKey ? { ...c, custom: data } : c)));
    } else {
      const key = `c-${row.productUnitId}-${Date.now()}`;
      setCart((prev) => [...prev, { key, row, qty: 1, custom: data, manualService: row.variantId === 0 }]);
      setSelKey(key);
    }
    setShowCustomization(null);
    setWorkflowStep(3);
    requestAnimationFrame(() => cartSectionRef.current?.focus());
  }

  function changeQty(key: string, delta: number) {
    clearCouponIfApplied();
    setCart((prev) =>
      prev.map((c) => (c.key === key ? { ...c, qty: Math.max(1, c.qty + delta) } : c)),
    );
  }
  function removeRow(key: string) {
    clearCouponIfApplied();
    setCart((prev) => prev.filter((c) => c.key !== key));
    if (selKey === key) setSelKey(null);
  }
  async function clearCart() {
    if (cart.length === 0) return;
    if (!(await confirm({
      variant: "warning",
      title: "تفريغ السلّة",
      description: "سيُمسح كلّ ما في الطلب الحالي. متابعة؟",
      confirmText: "تفريغ",
    }))) return;
    setCouponCode(null);
    setCouponLabel(null);
    setCouponInput("");
    // ش٢: التفريغ يفكّ ارتباط المسوّدة **قبل** مسح السلة (وإلا زامنت المزامنة المؤجَّلة أسطراً
    // فارغة فمُحيت المسوّدة المحفوظة عن بُعد) — المسوّدة تبقى سليمة في الشريط.
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    setActiveDraft(null);
    setCart([]);
    setSelKey(null);
    setPayInput("");
  }

  // ───── الباركود ───────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(
    async (code: string) => {
      try {
        // أوفلاين: المطابقة من النموذج المحلي (الباركود الأساسي + البدائل)، نمط POS.tsx.
        const row = offline
          ? await offlineFindByBarcode(code, effectiveTier)
          : await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: effectiveTier });
        if (!row) notify.err(`باركود غير معروف: ${code}`);
        else addRow(row as PosRow);
      } catch (e: unknown) {
        notify.err(e, "خطأ في المسح");
      }
    },
    [branchId, addRow, utils, effectiveTier, offline],
  );
  const handleHidScan = useCallback(
    async (raw: string) => {
      const r = parseScan(raw);
      if (r.type === "product") {
        await lookupBarcode(r.barcode);
        setSearch("");
      } else if (r.type === "customer") {
        setCustomer({ customerId: r.id, name: `عميل #${r.id}`, phone: null, isNew: false });
        notify.ok(`تم تحديد العميل #${r.id}`);
      }
    },
    [lookupBarcode],
  );
  useBarcodeScanner(handleHidScan, { enabled: !showCustomization && !submitting });

  // ───── لوحة المبلغ (م٤ — مبلغٌ فقط، لا أوضاع) ────────────────────────────
  function numPress(k: string) {
    setPayInput((prev) => {
      if (k === "DEL") return prev.slice(0, -1);
      if (k === "C") return "";
      if (k === "000") return prev ? `${prev}000` : "";
      if (k === "." && prev.includes(".")) return prev;
      return prev + k;
    });
  }
  function setQuickAmt(v: number) {
    setPayInput(String(v));
  }
  function payAll() {
    // ش٠: «= الكل» يملأ الإجمالي **الفعليّ** (المقرَّب لفئة ٢٥٠ في البيع المباشر النقديّ الخالص).
    setPayInput(String(expectedNow));
  }
  /** م٤ — الكمية داخل الصفّ: مدخلٌ رقميّ مباشر (والزرّان ± يبقيان للمس السريع). */
  function setQty(key: string, qty: number) {
    clearCouponIfApplied();
    setCart((prev) => prev.map((c) => (c.key === key ? { ...c, qty: Math.max(1, Math.trunc(qty) || 1) } : c)));
  }
  /** م٤ — الخصم داخل الصفّ (Popover خلية السعر): نسبةٌ 0..100، null = إزالة الخصم. */
  function setLineDiscount(key: string, pct: number | null) {
    clearCouponIfApplied();
    setCart((prev) =>
      prev.map((c) => {
        if (c.key !== key) return c;
        if (pct == null || pct <= 0) return { ...c, disc: undefined };
        const base = c.origPrice ?? Number(c.row.price ?? 0);
        return { ...c, origPrice: base, disc: Math.min(100, pct) };
      }),
    );
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
   *  تُغطّي البيع المباشر أولاً ثم توزّع الفائض عرابين — هذه الأزرار تملأ المبلغ وفقها بلا حساب يدويّ). */
  function fillDeposit(pctOfCustom: number) {
    const v = round2(sumDirectD.plus(sumCustomD.times(pctOfCustom)));
    setPayInput(v.toFixed(0));
    setDepositMenuOpen(false);
  }
  /** خيارات «عربون» المنسدلة — تُحسب هنا (sumDirectD/sumCustomD ملك الصفحة) وتستهلكها PaymentPanel. */
  const depositOptions = ([["٢٥٪", 0.25], ["٥٠٪", 0.5], ["المخصّص كاملاً", 1]] as const).map(([label, pct]) => ({
    label,
    amountLabel: fmt(round2(sumDirectD.plus(sumCustomD.times(pct))).toNumber()),
    onPick: () => fillDeposit(pct),
  }));

  function goToWorkflowStep(step: number) {
    setWorkflowStep(step);
    requestAnimationFrame(() => {
      if (step === 1) customerSectionRef.current?.querySelector("input")?.focus();
      if (step === 2) searchRef.current?.focus();
      if (step === 3) cartSectionRef.current?.focus();
      if (step === 4) paymentSectionRef.current?.focus();
    });
  }

  // ───── إنشاء العميل عند الحاجة (ensureCustomerId) ────────────────────────
  // إصلاح P2 (٢٣/٦/٢٦): قبل الإصلاح كان customer.customerId=null يُسقط الاسم/الهاتف ⇒ فاتورة وأمر
  // شغل بلا عميل (تَسليم آجل لاحقاً يَفشل بـ«طلب الخدمة الآجل يتطلب عميلاً محدداً»).
  const createCustomerM = trpc.customers.create.useMutation();
  async function ensureCustomerId(): Promise<number | null> {
    if (customer.customerId) return customer.customerId;
    const channelPhone = channel !== "WALK_IN" && channelHandle.replace(/\D/g, "").length >= 6
      ? channelHandle.trim()
      : null;
    const phone = customer.phone?.trim() || channelPhone;
    const rawName = customer.name?.trim() || "";
    const name = rawName && rawName.replace(/\D/g, "") !== phone?.replace(/\D/g, "")
      ? rawName
      : phone ? `عميل ${phone}` : "";
    if (!name) return null;
    if (!(await confirm({
      variant: "warning",
      title: "إنشاء عميل جديد",
      description: `سيُحفظ «${name}»${phone ? ` برقم ${phone}` : ""} كعميل ويرتبط بهذا الطلب. متابعة؟`,
      confirmText: "إنشاء العميل",
    }))) {
      throw new Error("ألغى المستخدم إنشاء العميل");
    }
    const created = await createCustomerM.mutateAsync({
      name,
      phone: phone || null,
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
    });
    // عَقد الراوتر يُرجع {id, customerId} كلاهما (للتوافق). نَحرس ضدّ NaN لو تَغيّر العقد.
    const id = Number((created as any).id ?? (created as any).customerId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("تعذّر قراءة مُعرّف العميل الجديد من الخادم");
    }
    // عكس الاختيار في الواجهة بعد الإنشاء.
    setCustomer({ customerId: id, name, phone: phone ?? null, isNew: false });
    return id;
  }

  // كوبون خصم (نمط POS.tsx couponPreview) — يُطبَّق على أصناف البيع الجاهزة (المباشرة) فقط، لا
  // خدمات الطباعة (لا كوبون خادمياً هناك) ولا الأصناف المخصّصة (تسعيرها إضافيّ لا كتالوجيّ). أيّ
  // تعديلٍ لاحق على السلة يُسقطه (clearCouponIfApplied) — لا إعادة معاينة تلقائية.
  const couponPreview = trpc.crm.coupons.preview.useMutation({
    onSuccess: (result) => {
      const byUnit = new Map(result.lines.map((line) => [Number(line.productUnitId), line]));
      setCart((items) => items.map((item) => {
        if (item.custom || item.row.isPrintService) return item;
        const applied = byUnit.get(Number(item.row.productUnitId));
        if (!applied) return item;
        return {
          ...item,
          row: {
            ...item.row,
            promotionId: applied.promotionId,
            promotionName: applied.promotionName,
            promotionEffectivePrice: applied.promotionEffectivePrice,
          },
        };
      }));
      setCouponCode(result.code);
      setCouponLabel(result.programName);
      notify.ok(`تم تطبيق الكوبون — ${result.programName}`);
    },
    onError: (e) => notify.err(e, "تعذّر تطبيق الكوبون"),
  });

  function applyCoupon() {
    const code = couponInput.trim();
    if (!code) return;
    const eligible = cart.filter((c) => !c.custom && !c.row.isPrintService);
    if (eligible.length === 0) {
      notify.err("أضف صنفاً جاهزاً غير خدمة طباعة أولاً — الكوبون لا ينطبق على المخصّص/الطباعة");
      return;
    }
    couponPreview.mutate({
      code,
      branchId,
      customerId: customer.customerId ?? undefined,
      customerTier: effectiveTier,
      lines: eligible.map((c) => ({
        productId: c.row.productId,
        variantId: c.row.variantId,
        productUnitId: c.row.productUnitId,
        unitPrice: String(c.row.price ?? "0"),
        quantity: c.qty,
        hasContractPrice: !!c.row.isContractPrice,
      })),
    });
  }
  function clearCoupon() {
    setCouponCode(null);
    setCouponLabel(null);
    setCouponInput("");
    setCart((prev) => prev.map((c) => (c.custom ? c : { ...c, row: { ...c.row, promotionId: null, promotionName: null, promotionEffectivePrice: null } })));
  }

  // نقطة التزام خادمية واحدة للسلة الهجينة: بيع + طباعة + أوامر شغل.
  const checkoutM = trpc.workOrders.receptionCheckout.useMutation();

  // ───── ش٢: المسوّدة المُرقّاة (حفظ/استئناف/مزامنة) ─────────────────────────
  /** تحويل السلّة الحالية إلى حمولة مسوّدة (الخصم اليدويّ مطويّ في unitPrice الفعّال). */
  function buildDraftPayload() {
    const header = {
      customerId: customer.customerId ?? null,
      contactName: customer.customerId == null ? (customer.name.trim() || null) : null,
      contactPhone: customer.customerId == null ? (customer.phone?.trim() || null) : null,
      priceTier: effectiveTier,
      channel,
    };
    const lines = cart.map((c, i) => {
      const eff = round2(D(effectivePrice(c))).toFixed(2);
      if (c.custom) {
        return {
          lineKind: "CUSTOM" as const,
          sortOrder: i,
          variantId: c.manualService ? null : (c.row.variantId || null),
          productUnitId: c.manualService ? null : (c.row.productUnitId || null),
          quantity: String(c.qty),
          unitPrice: eff,
          title: c.custom.title.trim() || c.row.productName,
          customizationText: composeCustomizationText(c.custom) || null,
          designImages: c.custom.designImages.length
            ? JSON.stringify(c.custom.designImages.map((img, ix) => ({ url: img.dataUrl, caption: img.name ?? null, sortOrder: ix })))
            : null,
          // المواصفة كاملةً عدا الصور — الاستئناف الوفيّ (I22: الصور في عمودها وحدها).
          printSpec: JSON.stringify({ ...c.custom, designImages: [], paymentReceiptImages: [] }),
          dueDate: c.custom.dueDate || null,
          assignedTo: c.custom.assignedTo ?? null,
        };
      }
      return {
        lineKind: c.row.isPrintService ? ("PRINT" as const) : ("GOODS" as const),
        sortOrder: i,
        variantId: c.row.variantId,
        productUnitId: c.row.productUnitId,
        quantity: String(c.qty),
        unitPrice: eff,
        title: `${c.row.productName} (${c.row.unitName})`,
      };
    });
    return { header, lines };
  }

  const promoteM = trpc.reception.draftPromote.useMutation({
    onSuccess: (r) => {
      setActiveDraft({ id: r.draftId, version: r.version });
      notify.ok(`حُفظ الطلب — ${r.draftNumber}`, "يُزامَن تلقائياً مع كل تعديل، ويستطيع زميلك إكماله من جهازه");
      void utils.reception.draftList.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const syncM = trpc.reception.draftSync.useMutation({
    onSuccess: (r) => setActiveDraft((prev) => (prev ? { ...prev, version: r.version } : prev)),
    onError: (e) => {
      // تعارضُ زميل (I9) أو انغلاق المسوّدة ⇒ فكّ الارتباط بلا طمس، والرسالة تشرح.
      notify.warn("توقّفت مزامنة الطلب المحفوظ", e.message);
      setActiveDraft(null);
      void utils.reception.draftList.invalidate();
    },
  });

  function saveDraft() {
    if (cart.length === 0 || !!activeDraft || offline) return;
    promoteM.mutate({ branchId, shiftId: shift?.id ?? null, ...buildDraftPayload() });
  }
  /** ش٣ — التثبيت الذرّي من المسوّدة نفسها (يستبدل جسر «الطيّ» المؤقّت من ش٢). */
  const commitDraftM = trpc.reception.draftCommit.useMutation();

  /** مزامنة بالجملة بdebounce (§٦ — لا سطراً-سطراً: مسح ١٢ باركوداً متتابعاً يمرّ بلا CONFLICT). */
  useEffect(() => {
    if (!activeDraft || offline) return;
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    draftSyncTimer.current = setTimeout(() => {
      if (!activeDraft) return;
      syncM.mutate({ draftId: activeDraft.id, version: activeDraft.version, ...buildDraftPayload() });
    }, 800);
    return () => {
      if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, customer.customerId, customer.name, customer.phone, effectiveTier, channel, activeDraft?.id]);

  /** استئناف مسوّدة (من هذا الجهاز أو جهاز زميل): صفوفٌ حيّة عبر catalog.byUnitIds + مواصفة CUSTOM من printSpec. */
  async function resumeDraft(draftId: number) {
    try {
      const d = await utils.reception.draftGet.fetch({ draftId });
      const unitIds = Array.from(new Set(d.lines.map((l) => Number(l.productUnitId)).filter((n) => n > 0)));
      const live = unitIds.length
        ? await utils.catalog.byUnitIds.fetch({ branchId, tier: (d.priceTier as Tier) ?? "RETAIL", productUnitIds: unitIds })
        : [];
      const byUnit = new Map(live.map((r) => [Number(r.productUnitId), r as PosRow]));
      let skipped = 0;
      const newCart: CartLine[] = [];
      for (const l of d.lines) {
        const qty = Math.max(1, Math.trunc(Number(l.quantity)));
        if (l.lineKind === "CUSTOM") {
          let spec: Partial<CustomizationData> = {};
          let imgs: Array<{ url: string; caption?: string | null }> = [];
          try { spec = l.printSpec ? JSON.parse(l.printSpec) : {}; } catch { /* مواصفة تالفة ⇒ افتراضي */ }
          try { imgs = l.designImages ? JSON.parse(l.designImages) : []; } catch { /* صور تالفة ⇒ بلا صور */ }
          const custom: CustomizationData = {
            ...emptyCustomization(l.title ?? ""),
            ...spec,
            designImages: imgs.map((im, ix) => ({ id: `r-${l.id}-${ix}`, dataUrl: im.url, name: im.caption ?? undefined, isPrimary: ix === 0 })),
            paymentReceiptImages: [],
          };
          const row = byUnit.get(Number(l.productUnitId)) ?? ({
            variantId: Number(l.variantId ?? 0), productUnitId: Number(l.productUnitId ?? 0),
            productName: l.title ?? "خدمة / أمر شغل", sku: "SERVICE", unitName: "خدمة",
            conversionFactor: "1", price: "0", stockBase: 0,
            isService: true, isPrintService: false, isCustomizable: true,
          } as PosRow);
          newCart.push({ key: `r-${l.id}`, row, qty, custom, manualService: l.variantId == null });
          continue;
        }
        const row = byUnit.get(Number(l.productUnitId));
        if (!row) { skipped += 1; continue; }
        const line: CartLine = { key: `r-${l.id}`, row, qty };
        // السعر المخزَّن (الفعّال وقت الحفظ) يُثبَّت — تغيّر سعر الكتالوج لا يُعيد التسعير صامتاً.
        if (Number(l.unitPrice) !== Number(row.price ?? 0)) line.origPrice = Number(l.unitPrice);
        newCart.push(line);
      }
      clearCouponIfApplied();
      setCart(newCart);
      setCustomer({ customerId: d.customerId != null ? Number(d.customerId) : null, name: d.contactName ?? "", phone: d.contactPhone ?? null, isNew: false });
      setTierOverride((d.priceTier as Tier) ?? null);
      setActiveDraft({ id: draftId, version: Number(d.version) });
      setWorkshop("CART");
      notify.ok(
        `فُتحت المسوّدة ${d.draftNumber}`,
        skipped > 0 ? `تنبيه: ${skipped} بند تعذّر استرجاعه (منتج غير متاح)` : "تعديلاتك تُزامَن وتُسجَّل باسمك",
      );
    } catch (e) {
      notify.err(e, "تعذّر فتح المسوّدة");
    }
  }

  async function printDraftTicketById(draftId: number) {
    try {
      const d = await utils.reception.draftGet.fetch({ draftId });
      await printDraftTicket({
        draftNumber: d.draftNumber,
        date: fmtDate(new Date(d.createdAt as unknown as string)),
        contactName: d.contactName,
        contactPhone: d.contactPhone,
        items: d.lines.map((l) => ({ name: l.title ?? "بند", quantity: Number(l.quantity), total: String(l.lineTotal) })),
        total: String(d.total),
        notes: d.notes,
      });
    } catch (e) {
      notify.err(e, "تعذّرت طباعة تذكرة المسوّدة");
    }
  }

  async function handleSubmit(opts: { quickFullPay: boolean }) {
    if (cart.length === 0) return;
    if (!shift) {
      notify.err("ابدأ العمل أولاً قبل إتمام طلب العميل");
      return;
    }
    const invalidCustom = cart.find((line) => {
      if (!line.custom) return false;
      const unitTotal = D(line.row.price || 0).plus(D(line.custom.unitPrice || 0));
      return !line.custom.title.trim() || unitTotal.lte(0);
    });
    if (invalidCustom) {
      setSelKey(invalidCustom.key);
      notify.err("راجع تفاصيل أمر الشغل: العنوان وسعر البيع مطلوبان");
      return;
    }
    const directLines = cart.filter((c) => !isCustomKind(c));
    // فصل خدمات الطباعة (تُباع عبر createPrintSale) عن البيع العادي (sales.create).
    const regularLines = directLines.filter((c) => !c.row.isPrintService);
    const printLines = directLines.filter((c) => c.row.isPrintService);
    const customItems = cart.filter(isCustomKind);

    // سعر كل أمر فقط؛ العربون لم يعد حقلاً على السطر، بل يوزّعه الخادم من دفعة الطلب الكلية.
    const customWithDeposits = customItems.map((c) => {
      const full = D(customLineGrand(c));
      return { c, depositStr: "0.00", salePriceStr: full.toFixed(2) };
    });

    // ش٠ (V1): كل المقارنات على الإجمالي **الفعليّ** (المقرَّب عند سريان التقريب) — إرسال مبالغ
    // غير مقرَّبة مع علم التقريب كان يجعل الخادم يرى نقصاً (رفضٌ للزبون العابر) أو ذمّةً صامتة.
    const inputPaidD = opts.quickFullPay ? effectiveGrandD : paidD;
    const appliedPaidD = method === "CASH" && inputPaidD.gt(effectiveGrandD) ? effectiveGrandD : inputPaidD;

    // البطاقة والتحويل صالحان أيضاً كعربون، لكن بلا فكّة وبمرجع تتبّع إلزامي.
    if (method !== "CASH" && inputPaidD.gt(0) && !paymentReference.trim()) {
      notify.err(method === "CARD" ? "رقم عملية البطاقة مطلوب" : "رقم مرجع التحويل مطلوب");
      return;
    }
    if (method !== "CASH" && inputPaidD.gt(effectiveGrandD)) {
      notify.err(`لا يمكن أن يتجاوز مبلغ ${method === "CARD" ? "البطاقة" : "التحويل"} إجمالي الطلب (${fmt(effectiveGrandD.toFixed(2))} د.ع)`);
      return;
    }
    const directFloorD = cashRoundActive ? effectiveGrandD : sumDirectD;
    if (appliedPaidD.lt(directFloorD)) {
      notify.err(`المبلغ المقبوض يجب أن يغطي المنتجات الجاهزة أولاً (${fmt(directFloorD.toFixed(2))} د.ع). وما زاد يُوزّع عربوناً على أعمال الطباعة.`);
      return;
    }

    // تَفعيل قَفل الإرسال **قبل** ensureCustomerId لمنع سباق نَقر مَزدوج يُنشئ عميلاً مكرَّراً
    // (ensureCustomerId يَحتوي عميلية confirm() غير متزامنة).
    if (submitting) return;
    setSubmitting(true);

    // انقطاعٌ معلوم: لا نُرسل ثم ننتظر مهلة — نلتقط فوراً. (الالتقاط نفسه يفرض شروطه:
    // بلا أوامر شغل، نقديّ كامل، بلا كوبون/توصيل، والجهاز مُفعَّل للالتقاط.)
    if (isDisconnected(connState)) {
      await captureOfflineReception();
      setSubmitting(false);
      return;
    }

    // ٥/٨ — إنشاء العميل لم يعُد شرطاً لإتمام الطلب. الاسم والهاتف يُحفظان مرجعاً نصّياً على
    // الفاتورة وأمر الشغل (contactName/contactPhone)، ولا يُنشَأ سجلّ عميلٍ إلا بطلبٍ صريح
    // («احفظه كعميل») ومن يملك صلاحيته. سابقاً كان كلّ بيعٍ يمرّ بـcustomers.create فيفشل
    // الطلب كلّه بـFORBIDDEN لأدوارٍ تفتح محطة الاستقبال بلا crm=FULL (فنّي المطبعة مثلاً).
    let customerId: number | null = customer.customerId ?? null;
    if (customerId == null && saveAsCustomer && canCreateCustomer) {
      try {
        customerId = await ensureCustomerId();
      } catch (e: any) {
        setSubmitting(false);
        notify.err(e?.message || "تعذّر حفظ العميل");
        return;
      }
    }

    let checkoutCommitted = false;
    try {
      const receiptsToPrint: ReceiptBrowserData[] = [];
      const workOrdersToPrint: WorkOrderReceiptData[] = [];
      const printedAt = new Date();
      const receiptPhone = customer.phone?.trim()
        || (channel !== "WALK_IN" && channelHandle.replace(/\D/g, "").length >= 6 ? channelHandle.trim() : null);
      const rawCustomerName = customer.name.trim();
      const customerName = rawCustomerName && rawCustomerName.replace(/\D/g, "") !== receiptPhone?.replace(/\D/g, "")
        ? rawCustomerName
        : receiptPhone ? `عميل ${receiptPhone}` : null;
      // ش٠ (V1): عند سريان التقريب (بيع مباشر خالص) يُرسَل مبلغ البيع **مقرَّباً** — الخادم يعيد
      // التقريب بنفس الدالة فيتطابقان، ويقيّد الفرق ADJUST. السلة الخالصة ⇒ مجموع الأسطر = الإجمالي.
      const saleAmount = cashRoundActive
        ? round2(effectiveGrandD).toFixed(2)
        : round2(regularLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0))).toFixed(2);
      const printAmount = round2(printLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0))).toFixed(2);
      const workOrderPayloads = customWithDeposits.map((x) => {
        const c = x.c;
        const custom = c.custom!;
        const finalText = composeCustomizationText(custom);
        // إصلاح P1 (٢٣/٦/٢٦): المنتجات المخصّصة ذات المخزون كانت تَخرج بلا materials ⇒ المخزون
        // لا يَنخفض و COGS صفر، وعند التسليم الفاتورة تُنشَأ بسطر للمنتج الأساس بدون خصم سابق
        // ⇒ بيعٌ بلا تكلفة، أرباح مُبالَغة، رصيدٌ مُبالَغ في المخزون.
        // الحل: لو المنتج Service (بلا مخزون) ⇒ لا مواد. غير ذلك ⇒ المنتج الأساس يَستهلك
        // baseQuantity = qty * conversionFactor (يُقرَّب لعدد صحيح لمطابقة فحص createWorkOrder).
        const materials: { variantId: number; baseQuantity: number }[] = [];
        if (!c.row.isService) {
          const factor = Number(c.row.conversionFactor) || 1;
          const baseQty = Math.max(1, Math.round(c.qty * factor));
          materials.push({ variantId: c.row.variantId, baseQuantity: baseQty });
        }
        return {
          baseVariantId: c.manualService ? null : c.row.variantId,
          title: custom.title.trim() || c.row.productName,
          customizationText: finalText || null,
          quantity: c.qty,
          materials,
          laborCost: D(custom.laborCost || 0).toFixed(2),
          // ملاحظة: salePrice الآن يَضمّ التوصيل (إصلاح P1 — حتى يَتطابق مع deliverWorkOrder).
          salePrice: x.salePriceStr,
          dueDate: custom.dueDate || null,
          priority: custom.priority,
          assignedTo: custom.assignedTo ?? undefined,
          deposit: x.depositStr,
          paymentMethod: D(x.depositStr).gt(0) ? method : null,
          paymentReference: D(x.depositStr).gt(0) && method !== "CASH" ? paymentReference.trim() : null,
          paymentReceiptUrl: custom.paymentReceiptImages[0]?.dataUrl || null,
          receptionChannel: channel,
          channelHandle: channelHandle || null,
          hasDelivery: custom.hasDelivery,
          deliveryAddress: custom.deliveryAddress || null,
          // ٥/٨ — الأجرة في عمودها وحدها: تمريرٌ للمندوب خارج salePrice/الفاتورة/الإيراد.
          deliveryCost: custom.hasDelivery ? D(custom.deliveryCost || 0).toFixed(2) : "0",
          deliveryFeeCollection: custom.hasDelivery ? custom.deliveryFeeCollection : "COURIER",
          // اِستقبال (تكامل التوصيل، ٤/٨): هاتف المستلم كعمود مستقلّ قابل للاستعلام — كان
          // مُضمَّناً كنصٍّ حرٍّ داخل customizationText فقط (composeCustomizationText أدناه ما زال
          // يُضيفه للنصّ أيضاً — تكرارٌ مقصود: عرضٌ للفنّي في النص + مصدر حقيقة للتوصيل في العمود).
          deliveryPhone: custom.hasDelivery ? (custom.deliveryPhone || null) : null,
          designImages: custom.designImages.map((img, idx) => ({
            url: img.dataUrl,
            caption: img.name ?? null,
            sortOrder: idx,
          })),
        };
      });

      // ش٣: طلبٌ محفوظٌ (مسوّدة نشطة) يُثبَّت **من مسوّدته** ذرّياً عبر reception.draftCommit —
      // idempotency ثلاثية (version + FOR UPDATE + commitRequestId الخادمي). قبله «تفريغُ
      // مزامنةٍ» متزامنٌ يقتل سباق «عدّلتُ ثم ثبّتُّ قبل نبضة الـdebounce»، وexpectedTotal
      // (الخام قبل تقريب IQD) حزام أمانٍ ضدّ انجراف العرض.
      const result = activeDraft
        ? await (async () => {
            if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
            const synced = await syncM.mutateAsync({
              draftId: activeDraft.id,
              version: activeDraft.version,
              ...buildDraftPayload(),
            });
            const committed = await commitDraftM.mutateAsync({
              draftId: activeDraft.id,
              version: synced.version,
              expectedTotal: round2(grandTotalD).toFixed(2),
              shiftId: shift.id,
              collectNow: appliedPaidD.gt(0)
                ? { amount: round2(appliedPaidD).toFixed(2), method, reference: method === "CASH" ? undefined : paymentReference.trim() }
                : null,
              cashRoundIQD: cashRoundActive,
              managerApproval: mgrCredsRef.current ?? undefined,
            });
            setActiveDraft(null);
            void utils.reception.draftList.invalidate();
            return committed;
          })()
        : await checkoutM.mutateAsync({
        branchId,
        shiftId: shift.id,
        customerId: customerId ?? undefined,
        // مرجع الزبون العابر: يُكتب على الفاتورة وأمر الشغل حتى بلا سجلّ عميل.
        contactName: customerId == null ? (customerName ?? undefined) : undefined,
        contactPhone: customerId == null ? (receiptPhone ?? undefined) : undefined,
        paymentMethod: method,
        paymentReference: method === "CASH" ? undefined : paymentReference.trim(),
        paidAmount: round2(appliedPaidD).toFixed(2),
        cashRoundIQD: cashRoundActive,
        // م٦: اعتماد المدير للخصم >١٠٪ — التُقط استباقياً عند التطبيق ويُتحقَّق خادمياً الآن.
        managerApproval: mgrCredsRef.current ?? undefined,
        clientRequestId: reqIdRef.current,
        priceTier: effectiveTier,
        couponCode: couponCode ?? undefined,
        regularSale: regularLines.length > 0 ? {
          amount: saleAmount,
          lines: regularLines.map((c) => {
            // كوبون/عرض: سعر قائمة صحيح الدينار + خصمٌ صريح (نمط POS.tsx buildSaleLine) — الخادم
            // يتحقّق منه مقابل العرض الفعلي بلا رفضٍ لو تغيّر بين المعاينة والحفظ.
            if (c.row.promotionEffectivePrice != null) {
              const listWhole = D(c.row.price ?? 0).toDecimalPlaces(0, 4);
              const discAmt = listWhole.minus(D(c.row.promotionEffectivePrice)).times(c.qty);
              return {
                variantId: c.row.variantId,
                productUnitId: c.row.productUnitId,
                quantity: String(c.qty),
                unitPriceOverride: listWhole.toFixed(2),
                ...(discAmt.gt(0) ? { discountAmount: discAmt.toFixed(2) } : {}),
                ...(c.row.promotionId != null ? { promotionId: c.row.promotionId } : {}),
              };
            }
            return {
              variantId: c.row.variantId,
              productUnitId: c.row.productUnitId,
              quantity: String(c.qty),
              ...(c.disc != null && c.disc > 0 ? { discountPercent: String(c.disc) } : {}),
            };
          }),
        } : null,
        printSale: printLines.length > 0 ? {
          amount: printAmount,
          lines: printLines.map((c) => ({
            variantId: c.row.variantId,
            productUnitId: c.row.productUnitId,
            quantity: String(c.qty),
            unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
          })),
        } : null,
        workOrders: workOrderPayloads,
      });
      checkoutCommitted = true;

      const invoiceId = result.regularSale?.invoiceId ?? result.printSale?.invoiceId ?? null;
      const createdWoIds = result.workOrders.map((order) => order.workOrderId);

      // ٥/٨ — إيصال الاستقبال كان يُبنى بقيمٍ مثبَّتة (paid = الإجمالي دائماً، change = 0 دائماً،
      // بلا خصمٍ ولا هاتفٍ ولا آجل) فيخرج ناقص المعلومات مقارنةً بإيصال التجزئة الذي يمرّ بمُحوّلٍ
      // موحّد. صار يُبنى بمُحوّلٍ واحد هنا يحمل الحقيقة كاملةً: الخصم على السطر، هاتف الزبون،
      // الفكّة الحقيقية على أول إيصال، والمتبقّي آجلاً إن وُجد.
      const receiptCustomerName = customerName && receiptPhone
        ? `${customerName} — ${receiptPhone}`
        : customerName ?? (receiptPhone ? `عميل ${receiptPhone}` : null);
      const changeD2 = round2(appliedPaidD.minus(effectiveGrandD));
      const printedChange = method === "CASH" && changeD2.gt(0) ? changeD2.toFixed(2) : null;
      const creditD = round2(effectiveGrandD.minus(appliedPaidD));
      const printedCredit = creditD.gt(0) ? creditD.toFixed(2) : null;
      const receiptLine = (c: CartLine) => ({
        name: `${c.row.productName} (${c.row.unitName})${c.disc ? ` −${c.disc}%` : ""}`,
        quantity: c.qty,
        price: round2(D(effectivePrice(c))).toFixed(2),
        total: round2(D(lineTotal(c))).toFixed(2),
      });
      const receiptHead = {
        date: fmtDate(printedAt),
        time: printedAt.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" }),
        cashierName: me.data?.name ?? "موظف الخدمة",
        customerName: receiptCustomerName,
        paymentMethod: PAY_METHOD_LABEL[method],
      };
      if (result.regularSale) {
        receiptsToPrint.push({
          ...receiptHead,
          receiptNumber: result.regularSale.invoiceNumber,
          items: regularLines.map(receiptLine),
          subtotal: saleAmount, total: saleAmount, paid: saleAmount,
          // الفكّة تُطبع مرّةً واحدةً على أول إيصال (هي فكّة الطلب كله لا فكّة فاتورةٍ بعينها).
          change: printedChange,
          credit: printedCredit,
        });
      }
      if (result.printSale) {
        receiptsToPrint.push({
          ...receiptHead,
          receiptNumber: result.printSale.invoiceNumber,
          items: printLines.map(receiptLine),
          subtotal: printAmount, total: printAmount, paid: printAmount,
          change: result.regularSale ? null : printedChange,
          credit: result.regularSale ? null : printedCredit,
        });
      }

      customWithDeposits.forEach((x, index) => {
        const c = x.c;
        const custom = c.custom!;
        const finalText = composeCustomizationText(custom);
        workOrdersToPrint.push({
          orderNumber: result.workOrders[index]?.orderNumber ?? "",
          orderDate: fmtDate(printedAt),
          dueDate: custom.dueDate || null,
          status: "RECEIVED",
          customerName,
          customerPhone: receiptPhone,
          jobTitle: custom.title.trim() || c.row.productName,
          quantity: c.qty,
          specs: finalText || null,
          total: x.salePriceStr,
          // ٥/٨ — أجرة التوصيل تُطبع صراحةً على التذكرة **خارج الإجمالي**، مع مَن يقبضها:
          // يمنع سوءَ الفهم الذي كان يجعل الموظّف والزبون يظنّانها جزءاً من قيمة الطلب.
          notes: custom.hasDelivery
            ? [
                `توصيل إلى: ${custom.deliveryAddress || "العنوان غير محدد"}`,
                custom.deliveryPhone ? `هاتف المستلم: ${custom.deliveryPhone}` : null,
                D(custom.deliveryCost || 0).gt(0)
                  ? `أجرة التوصيل ${fmt(custom.deliveryCost)} د.ع (${
                      custom.deliveryFeeCollection === "COUNTER" ? "مقبوضة في الاستقبال"
                      : custom.deliveryFeeCollection === "SHOP" ? "على المكتبة"
                      : "تُدفع للمندوب عند الاستلام"
                    }) — خارج قيمة الطلب`
                  : null,
              ].filter(Boolean).join(" · ")
            : null,
        });
      });

      // نجاح الحفظ لا يُلغى إذا تعذّرت الطابعة. نحاول المسارات بالترتيب الموحّد:
      // جسر الخادم ← WebUSB ← نافذة طباعة المتصفح، ثم نُفرغ السلة دائماً.
      let browserFallbacks = 0;
      let printFailures = 0;
      for (const receipt of receiptsToPrint) {
        try {
          const result = await printReceipt(receipt);
          if (result.via === "browser") browserFallbacks += 1;
        } catch {
          printFailures += 1;
        }
      }
      for (const workOrder of workOrdersToPrint) {
        try {
          const result = await printWorkOrderReceipt(workOrder);
          if (result.via === "browser") browserFallbacks += 1;
        } catch {
          printFailures += 1;
        }
      }

      // إفراغ + إشعار + تجديد idempotency key (نَجاح كامل فقط).
      const summary = [
        invoiceId ? `فاتورة #${invoiceId}` : null,
        createdWoIds.length > 0 ? `${createdWoIds.length} أمر شغل` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      const printDescription = printFailures > 0
        ? `تم الحفظ، لكن تعذّرت طباعة ${printFailures} مستند`
        : browserFallbacks > 0
          ? "فُتحت نافذة الطباعة لأن الطابعة المباشرة غير متصلة"
          : "أُرسلت المستندات إلى الطابعة مباشرة";
      notify.ok(`تمّ ${summary}`, printDescription);
      // ش١ (§٨.٦): نافذة الإيصال — الفكّة بخطٍّ ضخم + أرقام المستندات + إعادة الطباعة (F9)،
      // ولافتةٌ تسمّي ما لم يُطبَع (كان يُبتلَع في toast عابرٍ بلا أيّ سبيلٍ لإعادة الطباعة).
      setLastSale({
        invoiceNumbers: [result.regularSale?.invoiceNumber, result.printSale?.invoiceNumber].filter(Boolean) as string[],
        workOrderNumbers: result.workOrders.map((o) => o.orderNumber).filter(Boolean),
        totalStr: round2(effectiveGrandD).toFixed(2),
        changeStr: printedChange,
        creditStr: printedCredit,
        receipts: receiptsToPrint,
        workOrders: workOrdersToPrint,
        printFailures,
      });
      setShowReceiptOverlay(true);
      mgrCredsRef.current = null;
      setDiscountFor(null);
      setApprovalAsk(null);
      setCart([]);
      setSelKey(null);
      setPayInput("");
      setPaymentReference("");
      setCustomer({ customerId: null, name: "", phone: null, isNew: false });
      setChannel("WALK_IN");
      setChannelHandle("");
      setWorkflowStep(1);
      reqIdRef.current = crypto.randomUUID();
      // تحديث القوائم.
      utils.workOrders.list.invalidate().catch(() => {});
      utils.shifts.current.invalidate().catch(() => {});
    } catch (e: unknown) {
      // فخّ «النقرة الأولى» بعد قطعٍ صامت: المتصفّح لم يُحدِّث حالة الاتصال بعد، فيفشل النقل
      // بلا كود tRPC. تدهورٌ سلس: نلتقط بدل أن نُعيد خطأً غامضاً والنقد بيد الموظّف.
      // شرطٌ حاسم: **لم يلتزم شيء** (checkoutCommitted=false) — وإلا لَازدوجت العملية.
      const isTransportFailure = !checkoutCommitted
        && (e as { data?: { code?: string } } | null)?.data?.code == null;
      if (isTransportFailure && (await captureOfflineReception())) {
        return;
      }
      // لا توجد حالة التزام جزئي. عند غياب رد الشبكة قد تكون المعاملة كلها التزمت أو كلها
      // تراجعت؛ المفتاح الثابت يجعل إعادة الإرسال تستعيد النتيجة بلا تكرار.
      notify.err(e, checkoutCommitted
        ? "تم حفظ العملية كاملة، لكن تعذّر إكمال تجهيز المستندات؛ راجع الفواتير وأوامر الشغل"
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
  async function captureOfflineReception(): Promise<boolean> {
    if (!shift || cart.length === 0) return false;
    const directLines = cart.filter((c) => !isCustomKind(c));
    const regularLines = directLines.filter((c) => !c.row.isPrintService);
    const printLines = directLines.filter((c) => c.row.isPrintService);
    const customItems = cart.filter(isCustomKind);
    if (customItems.length > 0) {
      notify.errBig(
        "أوامر الشغل تحتاج اتصالاً",
        "ترقيم أمر الشغل وإسناده ورفع صوره تتمّ على الخادم. أزل بنود التخصيص من السلّة لإتمام البيع نقداً الآن، أو انتظر عودة الاتصال.",
      );
      return false;
    }
    if (!(await isOfflineSaleEnabled())) {
      notify.errBig(
        "البيع دون اتصال غير مفعَّل على هذا الجهاز",
        "التصفّح والاستعلام متاحان. تفعيل الالتقاط قرار إداريّ من «إعدادات الجهاز» في شارة المزامنة أسفل الشاشة.",
      );
      return false;
    }
    if (method !== "CASH") {
      notify.errBig("أثناء انقطاع الاتصال: النقد فقط — البطاقة والتحويل يتطلبان الخادم للتحقّق من المرجع.");
      return false;
    }
    if (couponCode) {
      notify.errBig("الكوبونات غير متاحة دون اتصال — أزل الكوبون أولاً.");
      return false;
    }
    if (heldDelivery > 0) {
      notify.errBig("أجرة التوصيل أمانةً تحتاج اتصالاً", "إسناد المندوب وصرف الأجرة عمليّتان خادميّتان — أتمّ الطلب بلا توصيل الآن.");
      return false;
    }
    // الدفع الكامل شرطٌ: الأوفلاين لا يُقيّم ذمّة عميل ولا سقف ائتمانه من نسخةٍ محليّة.
    const paidNowD = round2(D(payInput || 0));
    const fullyPaid = paidNowD.gte(grandTotalD);
    if (!fullyPaid) {
      notify.errBig("دون اتصال: الدفع الكامل فقط", `المطلوب ${fmt(grandTotalD.toFixed(2))} د.ع — الآجل والعربون الجزئيّ يتطلبان اتصالاً.`);
      return false;
    }
    const gate = await assertCanCapture(grandTotalD.toNumber());
    if (!gate.ok) {
      notify.errBig(gate.reason);
      return false;
    }

    const receiptNumber = await allocateOfflineReceiptNumber(branchId);
    const payload: OfflineReceptionPayload = {
      branchId,
      shiftId: shift.id,
      ...(customer.customerId ? { customerId: customer.customerId } : {}),
      ...(customer.name.trim() ? { contactName: customer.name.trim() } : {}),
      ...(customer.phone?.trim() ? { contactPhone: customer.phone.trim() } : {}),
      priceTier: effectiveTier,
      paymentMethod: "CASH",
      paidAmount: round2(grandTotalD).toFixed(2),
      regularSale: regularLines.length > 0 ? {
        // السعر الملتقَط إلزاميّ: النقد قُبض بالسعر المطبوع — لا إعادة تسعيرٍ صامتة عند الترحيل.
        lines: regularLines.map((c) => ({
          variantId: c.row.variantId,
          productUnitId: c.row.productUnitId,
          quantity: String(c.qty),
          unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
        })),
        amount: round2(regularLines.reduce((sum, c) => sum.plus(D(lineTotal(c))), D(0))).toFixed(2),
      } : null,
      printSale: printLines.length > 0 ? {
        lines: printLines.map((c) => ({
          variantId: c.row.variantId,
          productUnitId: c.row.productUnitId,
          quantity: String(c.qty),
          unitPriceOverride: round2(D(effectivePrice(c))).toFixed(2),
        })),
        amount: round2(printLines.reduce((sum, c) => sum.plus(D(lineTotal(c))), D(0))).toFixed(2),
      } : null,
      clientRequestId: reqIdRef.current,
    };
    const stored = await enqueueOfflineItem({
      kind: "RECEPTION",
      payload,
      offlineReceiptNumber: receiptNumber,
      total: round2(grandTotalD).toFixed(2),
    });
    if (!stored) {
      notify.errBig("تعذّر حفظ العملية محلياً (مساحة المتصفح؟) — لا تُسلّم البضاعة قبل عودة الاتصال.");
      return false;
    }

    // إيصالٌ مؤقّت بنفس تصميم الإيصال الرسميّ — الزبون يخرج بورقةٍ قابلة للبحث برقمها.
    const now = new Date();
    const cashierName = me.data?.name ?? "موظف الخدمة";
    const contact = customer.name.trim() || (customer.phone?.trim() ?? "");
    void printReceipt({
      receiptNumber,
      date: fmtDate(now),
      time: now.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" }),
      cashierName,
      customerName: contact || null,
      items: [...regularLines, ...printLines].map((c) => ({
        name: `${c.row.productName} (${c.row.unitName})${c.disc ? ` −${c.disc}%` : ""}`,
        quantity: c.qty,
        price: round2(D(effectivePrice(c))).toFixed(2),
        total: round2(D(lineTotal(c))).toFixed(2),
      })),
      subtotal: round2(grandTotalD).toFixed(2),
      total: round2(grandTotalD).toFixed(2),
      paid: round2(paidNowD).toFixed(2),
      change: paidNowD.gt(grandTotalD) ? round2(paidNowD.minus(grandTotalD)).toFixed(2) : null,
      paymentMethod: PAY_METHOD_LABEL.CASH,
    }).catch(() => { /* فشل الطابعة لا يُلغي التقاطاً التزم محلياً */ });

    notify.ok(
      `بيع دون اتصال — إيصال مؤقّت ${receiptNumber}`,
      "الرقم الرسميّ يصدر تلقائياً عند عودة الاتصال (شارة المزامنة أسفل الشاشة)",
    );
    setCart([]);
    setSelKey(null);
    setPayInput("");
    setPaymentReference("");
    setCustomer({ customerId: null, name: "", phone: null, isNew: false });
    setChannel("WALK_IN");
    setChannelHandle("");
    setWorkflowStep(1);
    reqIdRef.current = crypto.randomUUID();
    return true;
  }

  // إصلاح P2 (٢٣/٦/٢٦): F4 كان يُمسك إغلاقاً بياناتيّاً قديماً (payInput/method/customer/shift)
  // لأن الاعتماديّات لم تَشملها ⇒ نقرة F4 بعد تعديل المبلغ تَنفّذ بمبلغ قديم. الحل: ref يَحمل
  // أحدث `handleSubmit` ⇒ المُستَمع يَستدعي ref.current دائماً.
  const submitRef = useRef<(opts: { quickFullPay: boolean }) => void>(() => {});
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
      void (async () => {
        let failures = 0;
        for (const r of lastSale.receipts) {
          try { await printReceipt(r); } catch { failures += 1; }
        }
        for (const w of lastSale.workOrders) {
          try { await printWorkOrderReceipt(w); } catch { failures += 1; }
        }
        if (failures > 0) notify.err(`تعذّرت طباعة ${failures} مستند`);
        else notify.ok("أُعيدت طباعة مستندات آخر عملية");
      })();
    };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showCustomization) return;
      if (showReservations) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeReservations();
        }
        return;
      }
      if (showReceiptOverlay) {
        if (e.key === "Escape") { e.preventDefault(); setShowReceiptOverlay(false); }
        if (e.key === "F9") { e.preventDefault(); reprintLastRef.current?.(); }
        return;
      }
      if (cashDropping || approvalAsk) {
        if (e.key === "Escape") { e.preventDefault(); setCashDropping(false); setApprovalAsk(null); }
        return;
      }
      if (workshop !== "CART") {
        if (e.key === "Escape") { e.preventDefault(); setWorkshop("CART"); }
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        submitRef.current?.({ quickFullPay: false });
      } else if (e.key === "F9") {
        e.preventDefault();
        reprintLastRef.current?.();
      } else if (e.key === "F12") {
        e.preventDefault();
        void clearCartRef.current?.();
      } else if (e.key === "Escape") {
        if (showInbox) setShowInbox(false);
        else if (depositMenuOpen) setDepositMenuOpen(false);
        else if (discountFor) setDiscountFor(null);
        else if (showDrop) setShowDrop(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showInbox, showDrop, showCustomization, showReservations, workshop, showReceiptOverlay, cashDropping, approvalAsk, depositMenuOpen, discountFor, closeReservations]);

  /** F12 — تفريغ بتأكيد (clearCart تُعرَّف بعد هذا الأثر ⇒ ref يحمل أحدث نسخة). */
  const clearCartRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    clearCartRef.current = clearCart;
  });

  // اقتراح الكاشير: لا يبني الواجهة قبل توفّر الفرع.
  if (me.isLoading || shiftQ.isLoading) {
    return <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>;
  }

  // بوّابة وردية خدمة العملاء: لا عمل بلا وردية RECEPTION مفتوحة (درج/رصيد افتتاحي مستقلّ).
  if (!shift) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-4" dir="rtl">
        <div className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-lg">
          <div className="mb-1 flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-violet-100 text-violet-700">
              <Palette aria-hidden className="size-5" />
            </span>
            <h2 className="text-xl font-extrabold">ابدأ العمل</h2>
          </div>
          <p className="mb-5 text-sm text-muted-foreground">
            أدخل المبلغ الموجود في درج النقدية، ثم ابدأ استقبال العملاء والطلبات.
          </p>
          {/* الأدمن/المدير بلا فرع مُسنَد يختار الفرع صراحةً (#274) — بدل إسناد الطلبات صامتاً للفرع ١. */}
          {needsBranchChoice && (
            <div className="mb-3">
              <label htmlFor="rec-branch" className="mb-1.5 block text-sm font-bold">الفرع <span className="text-destructive">*</span></label>
              <select
                id="rec-branch"
                className="h-12 w-full rounded-md border border-input bg-transparent px-3 text-base shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={pickedBranch ?? ""}
                onChange={(e) => setPickedBranch(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— اختر الفرع —</option>
                {(branchesQ.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <label className="mb-1.5 block text-sm font-bold">المبلغ الموجود في الدرج الآن (د.ع)</label>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            className="mb-3 h-12 text-end text-lg font-extrabold tabular-nums"
          />
          {/* اربط الطابعة الحرارية هنا **قبل** فتح الوردية كي يُطبَع إيصال الافتتاح صامتاً فوراً
              بدل نافذة طباعة المتصفّح (كانت لا تظهر إلا بعد فتح الوردية داخل رأس الشاشة الرئيسية). */}
          {isWebUsbSupported() && !bridge.enabled && (
            <button
              type="button"
              onClick={() => void connectPrinter()}
              title={printerReady ? "الطابعة الحرارية مربوطة — اضغط لتبديلها" : "اربط طابعة حرارية كي يُطبع إيصال فتح الوردية عليها مباشرة"}
              className={cn(
                "mb-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border text-xs font-bold transition-colors hover:bg-muted/60",
                printerReady ? "border-[var(--money-positive)] text-money-positive" : "text-muted-foreground",
              )}
            >
              <Printer aria-hidden className="size-3.5" />
              {printerReady
                ? <>الطابعة الحرارية مربوطة <Check aria-hidden className="size-3.5" strokeWidth={3} /></>
                : "اربط الطابعة الحرارية لطباعة إيصال الوردية"}
            </button>
          )}
          <Button
            className="h-12 w-full text-base font-bold"
            disabled={openShiftM.isPending || needsBranchChoice}
            onClick={() => openShiftM.mutate({ branchId, openingBalance: opening || "0", shiftType: "RECEPTION" })}
          >
            {openShiftM.isPending ? "جارٍ البدء…" : needsBranchChoice ? "اختر الفرع أولاً" : "بدء العمل"}
          </Button>
          <Link href="/" className="mt-3 block text-center text-sm text-muted-foreground">← الرئيسية</Link>
        </div>
      </div>
    );
  }

  // رقم الخادم نفسه الذي يفرضه closeShift (DRAWER فقط)؛ لا نعيد تركيب المعادلة من تقرير طرق الدفع.
  const recExpected = Number(reportQ.data?.expectedCash ?? shift.openingBalance ?? 0);
  // فقدان التركيز من حقل المعدود يُثبّت انتهاء الإدخال ويكشف المطابقة تلقائياً بلا زر إضافي.
  const showRecExpected = isElevatedRole || countEntered;
  const recDiff = showRecExpected && counted ? Number(counted) - recExpected : null;
  const hasRecVariance = recDiff != null && Math.abs(recDiff) >= 0.01;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background" dir="rtl">
      {/* مساحة الحجوزات جزء من شاشة الاستقبال نفسها؛ تبقى السلة محفوظة خلفها عند الرجوع. */}
      {showReservations && (
        <div className="absolute inset-0 z-30 bg-background">
          <ReservationsHub embedded fixedBranchId={branchId} onClose={closeReservations} />
        </div>
      )}
      {/* ش١ (§٨.١): ورشتا الطلبات وطلبات الموقع لم تعودا طبقتين تُغطّيان لوحة الدفع —
          صارتا تبويبين داخل عمود العمل أدناه (زرّ التثبيت وشارة الوردية مرئيان دائماً). */}
      {/* نافذة إغلاق وردية خدمة العملاء (Z-report مستقلّ) */}
      {closing && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          dir="rtl"
          onClick={() => setClosing(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-lg font-extrabold">إنهاء العمل وعدّ النقدية</h3>
            <p className="mb-4 text-xs text-muted-foreground">
              {fmtDate(new Date())}
            </p>
            {reportQ.isLoading ? (
              <div className="py-6 text-center text-muted-foreground">جارٍ تجهيز ملخص اليوم…</div>
            ) : (
              <>
                {(
                  [
                    ["عدد الفواتير", `${reportQ.data?.invoiceCount ?? 0}`],
                    ["إجمالي المبيعات", `${fmt(Number(reportQ.data?.salesTotal ?? 0))} د.ع`],
                    ["المبلغ عند بدء العمل", `${fmt(Number(shift.openingBalance ?? 0))} د.ع`],
                    ...(showRecExpected
                      ? [["المبلغ المفترض وجوده في الدرج", `${fmt(recExpected)} د.ع`] as [string, string]]
                      : []),
                  ] as [string, string][]
                ).map(([l, v]) => (
                  <div key={l} className="flex justify-between border-b py-2 text-sm">
                    <span className="text-muted-foreground">{l}</span>
                    <span className="font-bold tabular-nums" dir="ltr">{v}</span>
                  </div>
                ))}
                <div
                  className="my-4 space-y-1.5"
                  onBlur={() => setCountEntered(counted.trim() !== "")}
                >
                  <label htmlFor="rec-counted-cash" className="block text-sm font-bold">
                    المبلغ الذي عددته في الدرج (د.ع)
                  </label>
                  <MoneyInput
                    id="rec-counted-cash"
                    value={counted}
                    onChange={(value) => {
                      setCounted(value);
                      setCountEntered(false);
                    }}
                    placeholder="0"
                    ariaLabel="النقد المعدود عند إغلاق الوردية"
                    className="h-12 text-center text-lg font-extrabold"
                  />
                  {!showRecExpected && (
                    <p className="text-xs text-muted-foreground">
                      أدخل ما عددته فعلياً في الصندوق لتظهر نتيجة المطابقة.
                    </p>
                  )}
                </div>
                {recDiff !== null && (
                  <div
                    className={cn(
                      "mt-2 inline-flex flex-wrap items-center gap-1 text-sm font-bold",
                      recDiff < 0 ? "text-destructive" : "text-emerald-600",
                    )}
                  >
                    <span>الفرق: {recDiff >= 0 ? "+" : ""}{fmt(recDiff)} د.ع</span>
                    {recDiff === 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Check aria-hidden className="size-3.5" /> مطابق تماماً
                      </span>
                    )}
                    {recDiff > 0 && <span>(زيادة)</span>}
                    {recDiff < 0 && <span>(عجز)</span>}
                  </div>
                )}
                {hasRecVariance && (
                  <div className="mt-4 space-y-2 rounded-xl border border-destructive/60 bg-destructive/10 p-3">
                    <p className="text-sm font-extrabold text-destructive">
                      لا يمكن إنهاء العمل لأن المبلغ المعدود لا يطابق المبلغ المسجّل في النظام.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      أعد عدّ النقدية وراجع عمليات البيع والإرجاع. إذا بقي الفرق، اطلب من المدير المراجعة.
                    </p>
                  </div>
                )}
                {/* العهدة الوسيطة (imprest، ٢٨/٧/٢٦): يعود كامل النقد المعدود للخزينة تلقائياً عند الإغلاق. */}
                <div className="mt-3.5 rounded-lg border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
                  عند التأكيد سيُسجّل النظام تسليم كامل المبلغ المعدود، ويبدأ العمل القادم بمبلغ جديد.
                </div>
                <div className="mt-5 flex gap-2.5">
                  <Button variant="outline" className="flex-1" onClick={() => setClosing(false)}>
                    إلغاء
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={!counted || closeShiftM.isPending || hasRecVariance}
                    onClick={() => closeShiftM.mutate({
                      shiftId: shift.id,
                      countedCash: counted,
                    })}
                  >
                    {closeShiftM.isPending ? "جارٍ الإنهاء…" : hasRecVariance ? "لا يمكن الإنهاء قبل حل الفرق" : "تأكيد الإنهاء وطباعة الملخص"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* أربع مناطق حقيقية: تفاصيل أمر الشغل جزء من السلة، فلا نكررها كمرحلة مستقلة. */}
      <div className={cn("flex-shrink-0 border-b bg-card px-4", compactHeader ? "space-y-1.5 py-1.5" : "space-y-2 py-2.5")}>
        {/* شريط التسلسل إرشاديٌّ لا وظيفيّ (الانتقال متاح بالنقر على المناطق نفسها وبـF2/F4)،
            فهو أول ما يُحذف عند ضيق الارتفاع ليعود ~٣٠px إلى لوحة الدفع والسلة. */}
        {!compactHeader && (
        <div className="flex items-center gap-1 overflow-x-auto text-[11px] font-bold text-muted-foreground" aria-label="تسلسل إنشاء الطلب">
          {["العميل والطلب", "إضافة المطلوب", "السلة وتفاصيل الطباعة", "الدفع والطباعة"].map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => goToWorkflowStep(index + 1)}
              className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted", workflowStep === index + 1 && "text-primary")}
              aria-current={workflowStep === index + 1 ? "step" : undefined}
            >
              <span className={cn(
                "grid size-5 place-items-center rounded-full border text-[10px]",
                workflowStep === index + 1 ? "border-primary bg-primary text-primary-foreground" : "bg-muted/50",
              )}>{index + 1}</span>
              <span>{label}</span>
              {index < 3 && <span className="mx-1 text-border">←</span>}
            </button>
          ))}
        </div>
        )}

        <div ref={customerSectionRef} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/25 p-2">
          <span className="shrink-0 text-xs font-extrabold">١. العميل وطريقة وصول الطلب</span>
          <SmartCustomerInput value={customer} onChange={setCustomer} className="w-60" placeholder="عميل نقدي أو ابحث عن عميل" />
          {customer.customerId && canReadCustomerContext && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => setCustomerContextId(customer.customerId)}>
              معلومات العميل
            </Button>
          )}
          <div className="flex flex-wrap gap-1">
            {(
              [
                { v: "WALK_IN", label: "مباشر", Icon: Store },
                { v: "WHATSAPP", label: "واتساب", Icon: MessageCircle },
                { v: "INSTAGRAM", label: "انستغرام", Icon: Camera },
                { v: "TIKTOK", label: "تيك توك", Icon: Music },
                { v: "PHONE", label: "اتصال", Icon: Phone },
              ] as const
            ).map((item) => (
              <button
                key={item.v}
                type="button"
                onClick={() => setChannel(item.v)}
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[11px] font-bold",
                  channel === item.v ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted",
                )}
              >
                <item.Icon aria-hidden className="size-3.5" /> {item.label}
              </button>
            ))}
          </div>
          {channel !== "WALK_IN" && (
            <Input
              value={channelHandle}
              onChange={(e) => {
                setChannelHandle(e.target.value);
                setWorkflowStep(1);
              }}
              placeholder="رقم الهاتف أو اسم حساب العميل"
              className="h-8 min-w-48 flex-1 text-xs"
              dir="ltr"
            />
          )}
          {/* ٥/٨ — اسم الزبون وهاتفه يُحفظان مرجعاً على الفاتورة دائماً (يُطبَعان ويُستعملان عند
              التحويل للتوصيل) بلا إنشاء سجلّ عميل. إنشاء العميل صار فعلاً صريحاً مستقلاً. */}
          {!customer.customerId && (customer.name.trim() || customer.phone?.trim()) && (
            canCreateCustomer ? (
              <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={saveAsCustomer}
                  onChange={(e) => setSaveAsCustomer(e.target.checked)}
                />
                احفظه كعميل دائم
              </label>
            ) : (
              <span className="text-[11px] font-semibold text-muted-foreground">
                يُحفظ الاسم والهاتف مرجعاً على الفاتورة (حفظه كعميل دائم يحتاج صلاحية إدارة العملاء)
              </span>
            )
          )}
          {customer.customerId && (
            <span className="text-[11px] font-semibold text-money-positive">تم ربط الطلب بالعميل: {customer.name}</span>
          )}
          <div className="flex items-center gap-1.5 border-s ps-2">
            <label className="text-[11px] font-semibold text-muted-foreground">فئة السعر:</label>
            <AppSelect
              value={effectiveTier}
              onValueChange={(v) => { setTierOverride(v as Tier); clearCouponIfApplied(); }}
              aria-label="فئة السعر"
              className="h-7 w-24 text-[11px] font-bold"
            >
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </AppSelect>
            {tierOverride && (
              <button
                type="button"
                onClick={() => setTierOverride(null)}
                title="عودة لفئة العميل الافتراضية"
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                ↩
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-extrabold">٢. أضف ما يريده العميل</span>
        <div className="relative max-w-[640px] flex-1">
          <Search aria-hidden className="pointer-events-none absolute inset-y-0 end-3 my-auto size-4 text-muted-foreground" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => { setShowDrop(true); setWorkflowStep(2); }}
            onBlur={() => setTimeout(() => setShowDrop(false), 160)}
            onKeyDown={(e) => {
              // ش٠: searchSettled يمنع إضافة نتيجةٍ من استعلامٍ أقدم أثناء الكتابة/المسح السريع.
              if (e.key === "Enter" && searchSettled && results[0]) {
                e.preventDefault();
                addRow(results[0]);
              }
            }}
            placeholder="امسح الباركود أو ابحث بالاسم / SKU…  (F2)"
            className="h-11 w-full rounded-xl border-[1.5px] border-primary/35 bg-muted/40 px-4 pe-11 text-sm font-semibold outline-none focus:border-primary"
          />
          {showDrop && debounced.trim().length >= 2 && (
            <div className="absolute inset-x-0 top-[calc(100%+6px)] z-40 max-h-[340px] overflow-y-auto rounded-xl border bg-card p-1.5 shadow-xl">
              {resultsEmpty && (
                <div className="p-5 text-center text-xs text-muted-foreground">
                  لا نتائج — جرّب اسماً آخر أو SKU
                </div>
              )}
              {results.map((r) => (
                <button
                  key={r.productUnitId}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addRow(r);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg p-2 text-right hover:bg-muted/60"
                >
                  <div
                    className={cn(
                      "grid size-10 flex-shrink-0 place-items-center rounded-lg",
                      r.isCustomizable ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                    )}
                  >
                    {r.isCustomizable ? <Palette aria-hidden className="size-5" /> : <Package aria-hidden className="size-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.productName}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
                          r.isCustomizable ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                        )}
                      >
                        {r.isCustomizable ? "تخصيص" : "جاهز"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground" dir="ltr">
                      <span className="text-right">{r.sku} · {r.unitName}</span>
                      {r.stockBase != null && r.stockBase > 0 && (
                        <span className="ms-2">· متوفّر: {r.stockBase}</span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-bold tabular-nums" dir="ltr">
                    {r.price ? fmt(r.price) : "—"}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={addManualService}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border-2 border-violet-500 bg-violet-50 px-4 text-xs font-extrabold text-violet-700 transition-colors hover:bg-violet-100"
        >
          <ClipboardList aria-hidden className="size-4" /> إضافة خدمة / أمر شغل
        </button>

        <button
          type="button"
          onClick={() => setWorkshop("ORDERS")}
          className="relative inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border px-4 text-xs font-extrabold transition-colors hover:bg-muted/60"
        >
          <Truck aria-hidden className="size-4" /> طابور الطلبات والتوصيل
          {woReadyCount > 0 && (
            <Badge variant="secondary" className="ms-0.5 tabular-nums">{woReadyCount}</Badge>
          )}
        </button>

        {canReadReservations && (
          <button
            type="button"
            onClick={openReservations}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border-2 border-primary bg-primary/5 px-4 text-xs font-extrabold text-primary transition-colors hover:bg-primary/10"
          >
            <CalendarClock aria-hidden className="size-4" /> الحجوزات
          </button>
        )}

        {canReadStoreOrders && (
          <button
            type="button"
            onClick={() => setWorkshop("STORE")}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border px-4 text-xs font-extrabold transition-colors hover:bg-muted/60"
          >
            <Package aria-hidden className="size-4" /> طلبات الموقع
          </button>
        )}

        <div className="ms-auto flex items-center gap-2">
          {bridge.enabled && (
            <button
              type="button"
              onClick={() => void testServerPrint()}
              title={`جسر طباعة صامت: ${bridge.description} — اضغط لطباعة تذكرة اختبار`}
              aria-label="جسر طباعة على الخادم — تذكرة اختبار"
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-emerald-500 bg-card px-2.5 text-emerald-600 hover:bg-emerald-500/10"
            >
              <Printer aria-hidden className="size-4" />
              <Globe aria-hidden className="size-3.5" />
            </button>
          )}
          {isWebUsbSupported() && (
            <button
              type="button"
              onClick={() => void connectPrinter()}
              title={printerReady
                ? "الطابعة الافتراضية مربوطة تلقائياً — اضغط لتبديلها"
                : "اربط طابعة حرارية — ستُربط تلقائياً في المرات القادمة"}
              aria-label={printerReady ? "الطابعة الافتراضية مربوطة" : "ربط طابعة حرارية"}
              className={cn(
                "inline-flex h-9 items-center gap-1 rounded-lg border bg-card px-2.5 hover:bg-muted/60",
                printerReady
                  ? "border-emerald-500 text-emerald-600"
                  : "border-border text-muted-foreground",
              )}
            >
              <Printer aria-hidden className="size-4" />
              {printerReady && <Check aria-hidden className="size-3.5" strokeWidth={3} />}
            </button>
          )}
          {/* ش١: شارة «آخر فاتورة» + نسخ الرقم — أكثر ما يُطلَب بعد إغلاق النافذة. */}
          {lastSale && lastSale.invoiceNumbers[0] && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(lastSale.invoiceNumbers[0]);
                notify.ok("نُسخ رقم الفاتورة", lastSale.invoiceNumbers[0]);
              }}
              title="آخر فاتورة — اضغط لنسخ الرقم (F9 لإعادة الطباعة)"
              className="inline-flex h-9 items-center gap-1 rounded-lg border bg-card px-2.5 text-[11px] font-bold text-muted-foreground hover:bg-muted/60"
              dir="ltr"
            >
              <Copy aria-hidden className="size-3" /> {lastSale.invoiceNumbers[0]}
            </button>
          )}
          {/* ش١ (§٨.٦): سحبٌ نقديّ من الدرج — درج الاستقبال يتراكم فيه بيعٌ وعرابين وأجرةٌ أمانة. */}
          <button
            type="button"
            onClick={() => setCashDropping(true)}
            title="سحب نقدي من الدرج إلى الخزينة"
            className="inline-flex h-9 items-center gap-1 rounded-lg border bg-card px-2.5 text-[11px] font-bold hover:bg-muted/60"
          >
            <HandCoins aria-hidden className="size-4" /> سحب نقدي
          </button>
          <div className="flex items-center gap-1.5 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-700">
            <span className="size-2 animate-pulse rounded-full bg-violet-500" />
            العمل مفتوح #{shift.id}
          </div>
          <Button size="sm" variant="outline" onClick={() => setClosing(true)}>
            إنهاء العمل
          </Button>
          {canReadChannels && (
            <button
              type="button"
              onClick={() => setShowInbox(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-bold hover:bg-muted/60"
            >
              <MessageCircle aria-hidden className="size-4" /> رسائل وطلبات العملاء
            </button>
          )}
        </div>
        </div>
        {/* ش٢ (§٨.٢): شريط الطلبات المحفوظة — يدخل سُلَّم الاحتواء: تحت compactHeader ينكمش
            إلى زرٍّ منسدلٍ واحد (V18) فلا يموّل نفسه من لوحة الدفع. */}
        <DraftStrip
          branchId={branchId}
          meUserId={Number(me.data?.id ?? 0)}
          activeDraftId={activeDraft?.id ?? null}
          offline={offline}
          compact={compactHeader}
          canSave={cart.length > 0}
          onSave={saveDraft}
          onResume={(id) => void resumeDraft(id)}
          onPrintTicket={(id) => void printDraftTicketById(id)}
        />
      </div>

      {/* ─── الجسم: سلّة (يسار) + لوحة الدفع (يمين) ─── */}
      <div className="flex min-h-0 flex-1 flex-row-reverse gap-3 p-3">
        {/* ─ عمود العمل: تبويبات الورش تركب رأس السلة (§٨.١ — صفر تكلفة عمودية) ─ */}
        <div ref={cartSectionRef} tabIndex={-1} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card outline-none focus:ring-2 focus:ring-primary/30">
          <div className="flex h-12 flex-shrink-0 items-center gap-1 border-b bg-muted/40 px-2" role="tablist" aria-label="ورش المحطة">
            <WsTab active={workshop === "CART"} onClick={() => setWorkshop("CART")} Icon={ShoppingCart}
              label={cart.length > 0 ? `السلة (${cart.length})` : "السلة"} />
            <WsTab active={workshop === "INVOICES"} onClick={() => setWorkshop("INVOICES")} Icon={ReceiptIcon} label="الفواتير" />
            <WsTab active={workshop === "ORDERS"} onClick={() => setWorkshop("ORDERS")} Icon={Truck} label="الطلبات" badge={woReadyCount} />
            {canReadStoreOrders && (
              <WsTab active={workshop === "STORE"} onClick={() => setWorkshop("STORE")} Icon={Package} label="طلبات الموقع" />
            )}
            <div className="ms-auto flex items-center gap-2">
              {workshop === "CART" && cart.length > 0 && (
                <>
                  <span className="hidden text-[11px] text-muted-foreground sm:inline">{cartCount} وحدة</span>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void clearCart()}>
                    تفريغ
                  </Button>
                </>
              )}
            </div>
          </div>

          {workshop === "INVOICES" ? (
            <ReceptionInvoiceQueue
              branchId={branchId}
              currentShiftId={shift ? Number(shift.id) : null}
              branchName={branchName}
              parties={(partiesQ.data ?? []) as DispatchParty[]}
              canFulfill={me.data?.role === "cashier" || isElevatedRole}
              isManager={isElevatedRole}
            />
          ) : workshop === "ORDERS" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <ReceptionOrderQueue branchId={branchId} onClose={() => setWorkshop("CART")} />
            </div>
          ) : workshop === "STORE" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <OrderFulfillment />
            </div>
          ) : (
            <CartTable
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
              grandTotal={grandTotal}
              cartCount={cartCount}
            />
          )}
        </div>

        {/* ─ لوحة الدفع ─ */}
        <PaymentPanel
          ref={paymentSectionRef}
          onFocusStep={() => setWorkflowStep(4)}
          payInput={payInput}
          setPayInput={setPayInput}
          method={method}
          setMethod={setMethod}
          paymentReference={paymentReference}
          setPaymentReference={setPaymentReference}
          needPaymentRef={needPaymentRef}
          grandTotal={grandTotal}
          expectedNow={expectedNow}
          cashRoundingDelta={cashRoundingDelta}
          sumDirect={sumDirect}
          sumCustom={sumCustom}
          heldDelivery={heldDelivery}
          cashDueNow={cashDueNow}
          paid={paid}
          change={change}
          remaining={remaining}
          isChange={isChange}
          isOwing={isOwing}
          hasCustom={hasCustom}
          depositMenuOpen={depositMenuOpen}
          setDepositMenuOpen={setDepositMenuOpen}
          depositOptions={depositOptions}
          numPress={numPress}
          payAll={payAll}
          setQuickAmt={setQuickAmt}
          couponCode={couponCode}
          couponLabel={couponLabel}
          couponInput={couponInput}
          setCouponInput={setCouponInput}
          couponOpen={couponOpen}
          setCouponOpen={setCouponOpen}
          applyCoupon={applyCoupon}
          clearCoupon={clearCoupon}
          couponPending={couponPreview.isPending}
          submitting={submitting}
          cartEmpty={cart.length === 0}
          hasShift={!!shift}
          onSubmit={(opts) => void handleSubmit(opts)}
        />
      </div>

      {/* شارة المزامنة — تُركَّب في كلّ شاشات الكاشير: تعرض حالة الاتصال وطابور الالتقاط،
          وتُفرّغ **كلّ** الأنواع (تجزئة/طباعة/استقبال) لا نوع هذه الشاشة وحده. */}
      <OfflineSyncChip userRole={me.data?.role} />

      {/* ─── نافذة التخصيص ─── */}
      {showCustomization && (
        <CustomizationDialog
          open
          productName={showCustomization.row.productName}
          price={showCustomization.row.price ?? "0"}
          quantity={
            showCustomization.editingKey
              ? cart.find((c) => c.key === showCustomization.editingKey)?.qty ?? 1
              : 1
          }
          initial={
            showCustomization.editingKey
              ? cart.find((c) => c.key === showCustomization.editingKey)?.custom
              : emptyCustomization(showCustomization.row.productName)
          }
          staff={(staffQ.data ?? []).map((member) => ({
            id: Number(member.id),
            name: member.name ?? null,
            role: member.role ?? null,
          }))}
          canEditInternalCost={isElevatedRole}
          onAddPlain={
            !showCustomization.editingKey && showCustomization.row.variantId !== 0
              ? () => addPlain(showCustomization.row)
              : undefined
          }
          onCancel={() => setShowCustomization(null)}
          onSave={saveCustomization}
        />
      )}

      {/* صندوق القنوات الحقيقي داخل محطة الاستقبال؛ يعود الموظف إلى السلة من دون فقد محتواها. */}
      {showInbox && (
        <div className="absolute inset-0 z-40 overflow-hidden bg-background p-4">
          <div className="mb-3 flex items-center justify-between rounded-xl border bg-card p-3">
            <div>
              <h1 className="inline-flex items-center gap-2 font-extrabold"><MessageCircle aria-hidden className="size-4" /> رسائل وطلبات العملاء</h1>
              <p className="text-xs text-muted-foreground">تابع رسائل واتساب والاتصالات، واربطها بالعميل عند الحاجة.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowInbox(false)}>
              <ArrowRight aria-hidden className="size-4 me-1" /> العودة إلى الطلب
            </Button>
          </div>
          <Inbox />
        </div>
      )}
      {customerContextId != null && (
        <Contact360Panel
          kind="customer"
          id={customerContextId}
          onClose={() => setCustomerContextId(null)}
          onOpenContact={(kind, id) => { if (kind === "customer") setCustomerContextId(id); }}
        />
      )}

      {/* ش١ (§٨.٦) — نافذة الإيصال بعد الإتمام: الفكّة بخطٍّ ضخم + المستندات + إعادة الطباعة. */}
      {showReceiptOverlay && lastSale && (
        <ReceiptOverlay
          lastSale={lastSale}
          onReprint={() => reprintLastRef.current?.()}
          onClose={() => setShowReceiptOverlay(false)}
        />
      )}

      {/* م٦ — اعتماد المدير للخصم >١٠٪ (استباقيّ): يُتحقَّق خادمياً لحظة الالتزام. */}
      {approvalAsk && (
        <ManagerApprovalDialog
          pct={approvalAsk.pct}
          onCancel={() => setApprovalAsk(null)}
          onApprove={(email, password) => {
            mgrCredsRef.current = { email, password };
            setLineDiscount(approvalAsk.lineKey, approvalAsk.pct);
            setApprovalAsk(null);
            notify.ok(`خصم ${approvalAsk.pct}٪ بانتظار اعتماد المدير عند التثبيت`, "تُفحص بيانات المدير خادمياً لحظة إتمام الطلب");
          }}
        />
      )}

      {cashDropping && shift && (
        <CashDropDialog
          C={RECEPTION_TOKENS}
          shiftId={shift.id}
          onClose={() => setCashDropping(false)}
        />
      )}
    </div>
  );
}
