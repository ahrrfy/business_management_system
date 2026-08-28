import type { StartOrderFromConversation } from "@/pages/Inbox";
import { toWorkOrderChannel, WORK_ORDER_CHANNELS, type WorkOrderChannel } from "@shared/receptionChannel";
import { ChannelMark } from "@/components/ChannelBadge";
import { receptionChannelOptions } from "@shared/receptionChannel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Check,
  ClipboardList,
  Copy,
  Globe,
  HandCoins,
  Instagram,
  LoaderCircle,
  MessageCircle,
  Music2,
  Package,
  Palette,
  Phone,
  Printer,
  Receipt as ReceiptIcon,
  Search,
  ShoppingCart,
  Store,
  Truck,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { isValidIqMobile, PhoneDigitsInput, toLocalIqMobileDigits } from "@/components/form/PhoneDigitsInput";
import { CustomizationDialog, type CustomizationData, composeCustomizationText, emptyCustomization } from "@/components/CustomizationDialog";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
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
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE, isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";
import Inbox from "@/pages/Inbox";
import { ReceptionInvoiceQueue } from "@/components/reception/ReceptionInvoiceQueue";
import { DraftStrip } from "@/components/reception/DraftStrip";
import { printDraftTicket } from "@/lib/printing/draftTicket";
import { receptionCheckoutReceiptMeta } from "@/lib/printing/receptionReceiptMeta";
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
} from "@/components/reception/cartMath";
import { CartTable } from "@/components/reception/CartTable";
import { PaymentPanel } from "@/components/reception/PaymentPanel";
import { ReceiptOverlay } from "@/components/reception/ReceiptOverlay";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import DepositDialog from "@/components/reception/DepositDialog";
import DraftPaymentsDialog from "@/components/reception/DraftPaymentsDialog";
import OrderDeliveryDialog, { type OrderDeliveryValue } from "@/components/reception/OrderDeliveryDialog";
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
const CUSTOMER_CREATE_ROLES = ["cashier", "manager", "sales_rep", "print_operator"] as const;
/** مرآة POS_STATION_GATES.RECEPTION.allowedRoles — بوّابة محطة الاستقبال الثانية (workorders=FULL).
 *  (١٢/٨) كاشير الاستقبال بدور مخصّص حُدَّت فيه crm يدوياً يبقى قادراً على حفظ العميل لأنه شرطُ إكمال
 *  طلب/حجز/تسليم — تعايشُ الازدواج يطابق customerReceptionCreateAllowed الخادميّة. */
const RECEPTION_STATION_ROLES = ["cashier", "manager", "print_operator"] as const;
const STORE_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;
const CRM_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;

export default function Reception() {
  const [, navigate] = useLocation();
  const pageSearch = useSearch();
  const me = trpc.auth.me.useQuery();
  /**
   * ١٩/٨ (طلب المالك): اللوحاتُ الخمس خرجت من رأس المحطّة إلى **الصفحة الرئيسية** — رأسُ
   * الكاشير كان صفّاً واحداً من ثمانية أزرارٍ متساوية الوزن يفيض أفقياً بشريط تمرير. صار
   * الرأسُ للوردية وحدها، والدخولُ إلى اللوحة يقع من بطاقتها في الرئيسية عبر `?workspace=`.
   */
  const requestedWorkspace = useMemo(
    () => new URLSearchParams(pageSearch).get("workspace") ?? "",
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
  const canReadCustomerContext = me.data != null && moduleAccessAllowed(
    me.data.role, reservationPermissions, "crm", "READ", CRM_READ_ROLES,
  );
  // مرآة بوّابة customers.create الخادمية بالضبط (customerReceptionCreateAllowed في server/trpc.ts):
  // crm=FULL (الأدوار القياسية) **أو** workorders=FULL (بوّابة محطة الاستقبال). قرار المالك العاجل
  // (١٢/٨): يُلغى حاجز crm≥READ من مراجعة Codex — كاشير الاستقبال يحفظ العميل ويبيع بلا عربون
  // ولو كان دوره المخصّص بلا صلاحيّة CRM أصلاً. CONFLICT الهاتف نظريّ: يحدث فقط عند تكرار هاتفٍ
  // حرفياً، ورسالة الخادم توضّح فيصعّد الموظّف للمدير عندها.
  const canCreateCustomer = me.data != null && (
    moduleAccessAllowed(
      me.data.role, reservationPermissions, "crm", "FULL", CUSTOMER_CREATE_ROLES,
    ) || moduleAccessAllowed(
      me.data.role, reservationPermissions, "workorders", "FULL", RECEPTION_STATION_ROLES,
    )
  );
  const canReadStoreOrders = me.data != null && moduleAccessAllowed(
    me.data.role, reservationPermissions, "store", "READ", STORE_READ_ROLES,
  );
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
        // ش٤ (I14): إفصاح عرابين الطلبات غير المُثبَّتة على Z المطبوع أيضاً.
        heldDepositsCount: rep?.heldDepositsCount ?? 0,
        heldDepositsTotal: rep?.heldDepositsTotal ?? "0",
      });
      setClosing(false);
      setCounted("");
      setCountEntered(false);
      await utils.shifts.current.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  // ترويسة الصفحة تُقاس بالنافذة عمداً (لا باللوحة): تقليصها يُطيل اللوحة، فقياسها باللوحة
  // يصنع حلقة «يُخفى ⇒ تتّسع ⇒ يظهر ⇒ تضيق». النافذة مقياسٌ مستقلّ عن هذا التغذّي الراجع.
  const compactHeader = useMediaQuery("(max-height: 900px)");

  // ───── الحالة ─────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  // ٢٣/٨ (Codex P2) — عدّاد إضافةٍ صريح: يزيد فقط عند فعل الإضافة (`addDirectLine`) ولو أدّى
  // إلى رفع كمّية سطرٍ قائم — إعادة مسح نفس السطر تُشغّل التمرير أيضاً. لا يزيد عند حذف/تعديل
  // كمّية/تحميل مسوّدة ⇒ لا يقفز الجدول من دون فعل الكاشير.
  const [addTick, setAddTick] = useState(0);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  // م٤: لوحة الأرقام صارت لوحة **مبلغٍ** خالصة — أوضاع الكمية/الخصم حُذفت (الكمية داخل الصفّ،
  // والخصم Popover في خلية السعر). لا وضعيّة خفيّة بعد اليوم: اللوحة تعني المبلغ دائماً.
  const [payInput, setPayInput] = useState("");
  // بيع مباشر آجل (قرار المالك ١٠/٨): المقبوض أقلّ من إجمالي البضاعة الجاهزة ⇒ المتبقّي ذمّة على
  // العميل المسجَّل. يتطلّب عميلاً مسجَّلاً، ومسارٌ مباشر (لا مسوّدة/توصيل). حدّ الائتمان يُفرَض خادمياً.
  const [deferred, setDeferred] = useState(false);
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [paymentReference, setPaymentReference] = useState(""); // P2 fix: مرجع البطاقة للعرابين
  const [showInbox, setShowInbox] = useState(false);
  // ش١ (§٨.١): ورش عمود العمل — الفواتير/الطلبات/طلبات الموقع تُركَّب داخل عمود السلة
  // (لوحة الدفع لا تُغطّى أبداً). الحجوزات/الرسائل تبقيان طبقتين (قرار §١٤.٦).
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
  // ش٤: صافي العربون المقبوض على الطلب المحفوظ النشط — يقلّص «المتوقّع الآن» ويظهر في اللوحة.
  const [draftHeld, setDraftHeld] = useState("0.00");
  const [draftInfo, setDraftInfo] = useState<{ draftNumber: string } | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  // ش٦ — توصيل الطلب على مستوى السلة: يُملأ قبل التثبيت ويُنفَّذ إسناداً تلقائياً بعده.
  // حالةُ سلةٍ محلية (لا تُحفظ مع المسوّدة — من استأنف مسوّدةً يعيد إدخال التوصيل).
  const [orderDelivery, setOrderDelivery] = useState<OrderDeliveryValue | null>(null);
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false);
  // ش١: جهات التوصيل لورشة الفواتير (الإسناد من الصفّ) — تُجلب عند فتح الورشة فقط.
  const partiesQ = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { enabled: deliveryDialogOpen || orderDelivery != null, staleTime: 60_000 },
  );
  const [customerContextId, setCustomerContextId] = useState<number | null>(null);
  const [showCustomization, setShowCustomization] = useState<{ row: PosRow; editingKey?: string } | null>(null);
  const [customer, setCustomer] = useState<SmartCustomerValue>({ customerId: null, name: "", phone: null, isNew: false });
  const [receptionPhone, setReceptionPhone] = useState("");
  const [phoneResolution, setPhoneResolution] = useState<"EMPTY" | "INCOMPLETE" | "CHECKING" | "NEEDS_NAME" | "RESOLVED" | "ERROR">("EMPTY");
  /**
   * أهليّة **البيع الآجل** للعميل المربوط — مصدرها الخادم (`deferredEligible`) لا استنتاجُ
   * الشاشة (١٩/٨، بلاغ المالك الحيّ): كانت الشارة تَعِد بالآجل لكل عميلٍ مرتبط، ثمّ يرفضه
   * `assertCreditLimit` لأنّ حدّه صفر — وهو **افتراضي كل عميلٍ جديد** بقرار المالك.
   */
  const [customerDeferredEligible, setCustomerDeferredEligible] = useState(false);
  const [phoneResolutionError, setPhoneResolutionError] = useState<string | null>(null);
  const [resolvedCustomerTier, setResolvedCustomerTier] = useState<Tier | null>(null);
  // فئة السعر: تلقائية من فئة العميل الافتراضية، وقابلة للتجاوز يدوياً (نمط POS.tsx effectiveTier).
  const [tierOverride, setTierOverride] = useState<Tier | null>(null);
  const [couponInput, setCouponInput] = useState("");
  // الكوبون مطويّ افتراضياً في الدرجات الضيّقة؛ هذه الراية تفتحه بطلب الموظّف.
  const [couponOpen, setCouponOpen] = useState(false);
  // ٢٣/٨ — خصمُ رأس الفاتورة على البيع المباشر: يقبل الكاشير ٠–١٥٪ (سلطته الافتراضية بقرار المالك،
  // مرآةً لـPOS)، وفوقه اعتمادُ مدير خادميّ عبر invoiceDiscountExceedsThreshold. سلسلةٌ فارغة = لا خصم.
  const [invoiceDiscountPct, setInvoiceDiscountPct] = useState("");
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [couponLabel, setCouponLabel] = useState<string | null>(null);
  // النوعُ من القاموس المشترك لا اتّحاداً مكتوباً بيد: كان يُسقِط `OTHER` فتُصبّ عليه
  // قناةُ المتجر/غيرِها قسراً إلى `WALK_IN` (تصويب مراجعة Codex ٢٠/٨).
  const [channel, setChannel] = useState<WorkOrderChannel>("WALK_IN");
  // معرّف القناة مستقل عن الهاتف: رقم الهاتف هو هوية العميل الإلزامية في جميع القنوات.
  const [channelHandle, setChannelHandle] = useState("");
  /** المحادثة التي وُلد منها الطلب (ش١) — تُرسَل مع الرأس فيُربَط أمرُ الشغل بها ذرّيّاً. */
  const [linkedConversationId, setLinkedConversationId] = useState<number | null>(null);
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

  // فئة العميل الافتراضية: دور الاستقبال قد لا يملك CRM READ، لذلك تأتي الفئة من endpoint الهوية
  // الضيّق. الاستعلام العام يبقى فقط لمن يملك صلاحية قراءة سياق العميل.
  const fetchedCustomer = trpc.customers.get.useQuery(
    { customerId: customer.customerId ?? 0 },
    { enabled: !!customer.customerId && canReadCustomerContext, staleTime: 60_000 },
  );
  const effectiveTier: Tier =
    tierOverride ?? resolvedCustomerTier ?? ((fetchedCustomer.data?.defaultPriceTier as Tier | undefined) ?? "RETAIL");
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

  const resolveReceptionCustomerM = trpc.customers.receptionResolveByPhone.useMutation();
  const resolveReceptionCustomerByPhone = resolveReceptionCustomerM.mutateAsync;
  const phoneLookupSequence = useRef(0);

  const resolveReceptionCustomer = useCallback(async (name?: string, announce = false) => {
    if (!isValidIqMobile(receptionPhone)) return null;
    const sequence = ++phoneLookupSequence.current;
    setPhoneResolution("CHECKING");
    setPhoneResolutionError(null);
    try {
      const result = await resolveReceptionCustomerByPhone({
        phone: receptionPhone,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });
      if (sequence !== phoneLookupSequence.current) return null;
      if (result.status === "NEEDS_NAME") {
        setCustomer((previous) => ({ customerId: null, name: previous.name, phone: receptionPhone, isNew: true }));
        setResolvedCustomerTier(null);
        setCustomerDeferredEligible(false);
        setPhoneResolution("NEEDS_NAME");
        return result;
      }
      setCustomer({
        customerId: Number(result.customerId),
        name: result.name ?? name?.trim() ?? "",
        phone: receptionPhone,
        isNew: false,
      });
      setResolvedCustomerTier(result.defaultPriceTier as Tier);
      setCustomerDeferredEligible(!!result.deferredEligible);
      setPhoneResolution("RESOLVED");
      if (announce) notify.ok(result.created ? "تم إنشاء العميل وربطه بالطلب" : "تم ربط العميل الموجود بالطلب");
      return result;
    } catch (error: any) {
      if (sequence !== phoneLookupSequence.current) return null;
      const message = error?.message || "تعذّر التحقق من رقم العميل";
      setPhoneResolutionError(message);
      setPhoneResolution("ERROR");
      if (announce) notify.err(message);
      return null;
    }
  }, [receptionPhone, resolveReceptionCustomerByPhone]);

  // لا نبحث قبل اكتمال الخانات الإحدى عشرة. بعد الاكتمال يتحول الهاتف إلى مفتاح هوية واحد:
  // عميل موجود يُربط فوراً، ورقم جديد يفتح الاسم فقط.
  useEffect(() => {
    phoneLookupSequence.current += 1;
    setDeferred(false);
    setResolvedCustomerTier(null);
    if (!receptionPhone) {
      setPhoneResolution("EMPTY");
      setPhoneResolutionError(null);
      setCustomer({ customerId: null, name: "", phone: null, isNew: false });
      return;
    }
    if (!isValidIqMobile(receptionPhone)) {
      setPhoneResolution("INCOMPLETE");
      setPhoneResolutionError(null);
      setCustomer({ customerId: null, name: "", phone: receptionPhone, isNew: false });
      return;
    }
    setCustomer({ customerId: null, name: "", phone: receptionPhone, isNew: true });
    const timer = window.setTimeout(() => { void resolveReceptionCustomer(); }, 180);
    return () => window.clearTimeout(timer);
  }, [receptionPhone, resolveReceptionCustomer]);

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
  // ٢٣/٨ — البيع الخالص (لا طباعة ولا تخصيص) هو وحده وعاء خصم رأس الفاتورة: عقد الخادم
  // (workOrderRouter.receptionCheckout.regularSale.invoiceDiscount) يمرّره لـcreateSaleInTx
  // الذي يحسبه على فاتورة البيع فقط. `printSale` فاتورةٌ مستقلّة و«التخصيص» أمرُ شغلٍ (workOrder).
  const regularSumRawD = cart.filter((c) => !isCustomKind(c) && !c.row.isPrintService).reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumCustomD = cart.filter((c) => isCustomKind(c)).reduce((s, c) => s.plus(D(customLineGrand(c))), D(0));
  // ٢٣/٨ — خصمُ رأس الفاتورة (سلطة الكاشير ٠–١٥٪ كما في POS): يُطبَّق **قبل** حساب grandTotal
  // ⇒ التقريب النقديّ والعربون المحتجَز والمقبوض النقديّ كلّها تُقاس على الصافي بعد الخصم بلا مسّ
  // أيّ حاسوبٍ خلفيّ. `regularSale.invoiceDiscount` يُبعث للخادم مبلغاً مطلقاً لينفّذ الحماية نفسها
  // على invoice.discountAmount (invoiceDiscountExceedsThreshold على الإجماليّ).
  //
  // **السقف الفعّال المتبقّي** (مرآة POS.tsx حرفياً): بوّابة الخادم تقيس (refGross − invoiceNet)/refGross
  // مقابل ١٥٪، وترى انحراف السطر (عرض/كوبون/خصم يدويّ) والرأس معاً. لولا هذا: سلّةٌ عليها عرضٌ ١٠٪
  // + خصمُ رأسٍ ١٠٪ = انحراف ١٩٪ ⇒ رفضٌ خادميّ يُفاجأ به الكاشير (بلاغ Codex P1).
  // بيع الاستقبال بلا مسار «كرت رقميّ» — عقد الخادم يرفضها بنيوياً — فلا استثناءٌ يخصمها.
  const CASHIER_INVOICE_DISCOUNT_MAX_PCT = 15;
  const regularReferenceGrossD = cart
    .filter((c) => !isCustomKind(c) && !c.row.isPrintService)
    .reduce((s, c) => {
      // بلا خصمٍ يدويّ = سعرُ القائمة (السعرُ الأصل قبل الخصم) × الكمية. `origPrice` يُضبَط من
      // Popover خصم السطر ⇒ نستعمله مرجعاً كي يحسب الانحراف السطريّ المسبق.
      const refUnit = D(c.origPrice ?? c.row.price ?? 0);
      return s.plus(refUnit.times(c.qty));
    }, D(0));
  const priorLineDeviationRatioD = regularReferenceGrossD.gt(0)
    ? regularReferenceGrossD.minus(regularSumRawD).div(regularReferenceGrossD)
    : D(0);
  const remainingHeaderAuthorityFractionD = D(0.15).minus(priorLineDeviationRatioD);
  const remainingHeaderPctOnSubtotalD = (regularSumRawD.gt(0) && regularReferenceGrossD.gt(0))
    ? remainingHeaderAuthorityFractionD.times(regularReferenceGrossD).div(regularSumRawD).times(100)
    : D(CASHIER_INVOICE_DISCOUNT_MAX_PCT);
  const effectiveHeaderCapPctD = (remainingHeaderPctOnSubtotalD.lt(0)
    ? D(0)
    : remainingHeaderPctOnSubtotalD.gt(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      ? D(CASHIER_INVOICE_DISCOUNT_MAX_PCT)
      : remainingHeaderPctOnSubtotalD).toDecimalPlaces(2, 1 /* ROUND_DOWN */);
  const effectiveHeaderCapPct = effectiveHeaderCapPctD.toNumber();
  // فخّ decimal.js (Codex P1): `D(".") throws`. لا نمرّر إلى `D()` إلّا سلسلةً قابلةً للتحليل.
  // الشاشة تحرس الإدخال أيضاً، لكنّ هذا الفحص هنا الحدّ الأخير قبل عمليات الرياضيات.
  const rawInvoiceDiscountPctD = (() => {
    if (!invoiceDiscountPct) return D(0);
    const num = Number(invoiceDiscountPct);
    if (!Number.isFinite(num) || num < 0) return D(0);
    try { return D(invoiceDiscountPct); } catch { return D(0); }
  })();
  const clampedInvoiceDiscountPctD = rawInvoiceDiscountPctD.gt(effectiveHeaderCapPctD)
    ? effectiveHeaderCapPctD
    : rawInvoiceDiscountPctD;
  // ٢٣/٨ — Codex P1: خصمُ رأس الفاتورة لا يعبر المسوّدة حالياً — `buildDraftPayload` ليس لديه
  // حقلٌ يحمله، وعقدُ `commitDraft` يعيد بناء الإجمالي من الأسطر الخام فيرفض التثبيت لأنّ الصافي
  // لا يطابق. إخفاءُ الحقل عند وجود مسوّدة يمنع تسرّبَه لعقدٍ لا يفهمه — الشريحة الأوسع (توسيع
  // عقد المسوّدة) شغلٌ منفصل بمهاجرةٍ وحقولٍ خادميّة إضافيّة.
  const invoiceDiscountAllowed = regularSumRawD.gt(0) && !activeDraft;
  const invoiceDiscountAmountD = invoiceDiscountAllowed
    ? round2(regularSumRawD.times(clampedInvoiceDiscountPctD).div(100))
    : D(0);
  const invoiceDiscountAmount = invoiceDiscountAmountD.toNumber();
  const regularSumNetD = regularSumRawD.minus(invoiceDiscountAmountD);
  const sumDirectNetD = sumDirectD.minus(invoiceDiscountAmountD);
  const grandTotalD = sumDirectNetD.plus(sumCustomD);
  const grandTotal = round2(grandTotalD).toNumber();
  const sumDirect = round2(sumDirectD).toNumber();
  const sumCustom = round2(sumCustomD).toNumber();
  // ٥/٨ — أجرة توصيلٍ تُقبض الآن أمانةً للمندوب: نقدٌ يدخل الدرج **خارج** الفاتورة (ليست بيعاً).
  // تُعرَض منفصلةً كي يعرف الموظّف كم يستلم فعلاً، ولا تُخلَط بإجمالي الفاتورة ولا بالمبلغ المُطبَّق.
  // ش٦: أجرة توصيل **الطلب** (COUNTER) تنضمّ لنفس العرض — نفس أمانة الدرج بالضبط.
  const orderFeeHeldD = orderDelivery?.feeCollection === "COUNTER" ? round2(D(orderDelivery.fee || 0)) : D(0);
  const heldDeliveryD = round2(cart.reduce((s, c) => s.plus(D(lineCounterHeldFee(c))), D(0)).plus(orderFeeHeldD));
  const heldDelivery = heldDeliveryD.toNumber();
  const cashDueNow = round2(grandTotalD.plus(heldDeliveryD)).toNumber();
  // ٨/٨ — شفافية أجرة التوصيل في الشريط السفليّ لكلّ المسارات: من «توصيل هذا الطلب» إن وُجِد،
  // وإلّا من كتل التخصيص التي فُعِّل فيها التوصيل (COURIER/SHOP كانت تختفي كلياً على مسار التخصيص).
  // COUNTER يُعرَض عبر heldDelivery أعلاه (لا يُكرَّر هنا). الأجرة عرضٌ فقط — لا تدخل إيراداً أبداً.
  const customDeliveryLinesD = cart.filter((c) => isCustomKind(c) && c.custom?.hasDelivery && D(c.custom.deliveryCost || 0).gt(0));
  const deliveryDisclosure = orderDelivery
    ? { fee: round2(D(orderDelivery.fee || 0)).toNumber(), feeCollection: orderDelivery.feeCollection, partyName: orderDelivery.partyName }
    : customDeliveryLinesD.length > 0
      ? {
          fee: round2(customDeliveryLinesD.reduce((s, c) => s.plus(D(c.custom!.deliveryCost || 0)), D(0))).toNumber(),
          feeCollection: customDeliveryLinesD[0].custom!.deliveryFeeCollection,
          partyName: "التوصيل",
        }
      : null;

  // ش٠ (٥/٨، V1) — تقريب نقدي IQD لأقرب ٢٥٠ (نمط POS حرفياً): للبيع المباشر **الخالص** النقديّ
  // فقط (لا تخصيص ولا خدمات طباعة — السلة المختلطة بلا تقريبٍ حتى ش٦)، وأونلاين فقط: مسار
  // الالتقاط الأوفلايني يلتقط المبالغ غير المقرَّبة، فتفعيل التقريب معه يفصل ما رآه الزبون عمّا
  // سيُرحَّل (فرقٌ في الدرج يمنع الإغلاق). roundCashIQD نفس دالة الخادم ⇒ اتفاقٌ حتميّ على الفرق
  // الذي يقيّده الخادم قيدَ ADJUST.
  const hasPrintInCart = cart.some((c) => !isCustomKind(c) && c.row.isPrintService);
  // مراجعة ش٤: مرآة شرط الخادم — لو أنزل التقريبُ الإجماليَّ إلى/تحت العربون المقبوض سلفاً
  // لَسُدَّ الطريق النقديّ (المتوقّع 0 والخادم يطالب بالفارق الخام) ⇒ يسقط التقريب حينها.
  const draftHeldEarlyD = D(draftHeld || 0);
  const roundedWouldTrapHeld = draftHeldEarlyD.gt(0) && roundCashIQD(grandTotalD.toFixed(2)).lte(draftHeldEarlyD);
  const cashRoundActive = method === "CASH" && cart.length > 0 && !cart.some(isCustomKind) && !hasPrintInCart && !offline && !roundedWouldTrapHeld;
  // ش٦ — تقريب السلّة المختلطة (مرآة materialize/checkout حرفياً): فرق تقريب السلّة كلّها
  // يُحمَّل على الفاتورة الحاملة (بضاعة ثم طباعة). يسري **فقط** حين يُدفع المقرَّب كاملاً نقداً
  // الآن (يُحسم عند الإرسال) — هنا نحسب أهليّته ونعرض المقرَّب لأن المسار الاعتيادي دفعٌ كامل.
  const sumGoodsRawD = cart.filter((c) => !isCustomKind(c) && !c.row.isPrintService).reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumPrintRawD = cart.filter((c) => !isCustomKind(c) && c.row.isPrintService).reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const mixedCarrier: "SALE" | "PRINT" | null = sumGoodsRawD.gt(0) ? "SALE" : sumPrintRawD.gt(0) ? "PRINT" : null;
  const mixedDeltaD = round2(roundCashIQD(grandTotalD.toFixed(2)).minus(grandTotalD));
  const mixedRoundEligible =
    method === "CASH" && cart.length > 0 && !cashRoundActive && !offline && !roundedWouldTrapHeld
    && (cart.some(isCustomKind) || hasPrintInCart) && mixedCarrier != null && !mixedDeltaD.isZero()
    && (mixedCarrier === "SALE" ? sumGoodsRawD : sumPrintRawD).plus(mixedDeltaD).gt(0);
  const roundingDisplayActive = cashRoundActive || mixedRoundEligible;
  const effectiveGrandD = roundingDisplayActive ? roundCashIQD(grandTotalD.toFixed(2)) : grandTotalD;
  const cashRoundingDelta = roundingDisplayActive ? round2(effectiveGrandD.minus(grandTotalD)).toNumber() : 0;

  // ش٤: العربون المقبوض سلفاً على الطلب المحفوظ يقلّص «المتوقّع الآن» — الزبون دفعه فعلاً
  // وإيصاله قائم؛ collectNow عند التثبيت هو الجزء الجديد وحده (I5).
  const heldD = draftHeldEarlyD;
  // الدفع موحّد على كامل السلة. البيع المباشر هو الحد الأدنى؛ وما زاد يصبح عربوناً لأوامر الطباعة.
  const dueNowRawD = effectiveGrandD.minus(heldD);
  const expectedNowD = dueNowRawD.lt(0) ? D(0) : dueNowRawD;
  const expectedNow = round2(expectedNowD).toNumber();

  // ما أدخله الكاشير في لوحة الأرقام (مع تكيّف Quick Pay).
  const paidD = D(payInput || 0);
  const paid = round2(paidD).toNumber();
  const changeD = paidD.minus(expectedNowD);
  const change = round2(changeD).toNumber();
  const remainingD = expectedNowD.minus(paidD);
  const remaining = round2(remainingD).toNumber();
  const isChange = method === "CASH" && paidD.gt(0) && paidD.gte(expectedNowD);
  const isOwing = paidD.gt(0) && paidD.lt(expectedNowD);

  const hasCustom = cart.some(isCustomKind);
  const deferredAvailable = customer.customerId != null
    && phoneResolution === "RESOLVED"
    // حدُّ الائتمان جزءٌ من الأهليّة لا شرطٌ يُكتشَف بالرفض بعد الضغط.
    && customerDeferredEligible
    && !activeDraft
    && !orderDelivery
    && sumDirect > 0;
  // ٢٣/٨ (بلاغ المالك): رسالةٌ محدَّدة تشرح السبب الفعليّ لتعطيل زرّ «بدون عربون» — بدل «اربط عميلاً»
  // المضلِّلة. الترتيب من الأقلّ صعوبةً في الحلّ إلى الأكثر: طلبٌ مخصّصٌ ⇒ يكفي «إتمام»، مسوّدةٌ ⇒
  // ثبّت مباشرةً، توصيلٌ ⇒ التحصيل عند الاستلام، لا عميل ⇒ اربطه، حدّ الائتمان صفر ⇒ راجع المدير.
  const deferredDisabledReason: string | null = deferredAvailable
    ? null
    : sumDirect === 0 && sumCustom > 0
      ? "لا حاجة لعربون — طلبٌ مخصّص، اضغط «إتمام الطلب» مباشرةً"
      : activeDraft
        ? "الآجل غير متاح لطلبٍ محفوظ — ثبّته مباشرةً بلا حفظ مسوّدة"
        : orderDelivery
          ? "طلب التوصيل يُحصَّل عند الاستلام — لا حاجة لوضع «آجل»"
          : customer.customerId == null || phoneResolution !== "RESOLVED"
            ? "اربط عميلاً بهاتفٍ عراقيٍّ أوّلاً"
            : !customerDeferredEligible
              ? "حدُّ الائتمان للعميل صفر (نقديّ فقط) — راجع المدير لرفعه"
              : "غير متاح الآن";
  useEffect(() => {
    if (deferred && !deferredAvailable) setDeferred(false);
  }, [deferred, deferredAvailable]);
  // مراجعة عدائية ٦/٨: الحقل يظهر فور اختيار طريقةٍ غير نقدية وسلّةٍ غير فارغة — كان مشروطاً
  // بمبلغٍ مُدخَل، فالمسار السريع (تحصيل المطلوب الآن) يطلب المرجع/الكود وحقله مخفيّ.
  const needPaymentRef = method !== "CASH" && (paidD.gt(0) || expectedNowD.gt(0));

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
    void offlineSearchCatalog(debounced, effectiveTier, branchId, { limit: 15, includePrintServices: true }).then((rows) => {
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
    // ٢٣/٨ (Codex P2): أشِر إلى الجدول أنّ إضافةً حدثت — يشمل رفع الكمّية على السطر الأصل.
    setAddTick((t) => t + 1);
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
    // فارغة فمُحيت المسوّدة المحفوظة عن بُعد) — المسوّدة تبقى سليمة في الشريط (ومعها عربونها).
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    setActiveDraft(null);
    setDraftHeld("0.00");
    setDraftInfo(null);
    setCart([]);
    setSelKey(null);
    setPayInput("");
    setDeferred(false);
    // ٢٣/٨ — تفريغ خصم رأس الفاتورة مع تفريغ السلّة كي لا يُطبَّق سهواً على سلّةٍ جديدةٍ لعميلٍ آخر.
    setInvoiceDiscountPct("");
  }

  // ───── الباركود ───────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(
    async (code: string) => {
      try {
        // أوفلاين: المطابقة من النموذج المحلي (الباركود الأساسي + البدائل)، نمط POS.tsx.
        const row = offline
          ? await offlineFindByBarcode(code, effectiveTier, branchId)
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
  // مطابقة الماسح داخل حقل البحث المركَّز عبر hook مخصّص (PR #501): توقيتُ الحرف نفسه + تطبيع
  // مسح لوحة المفاتيح العربية (normalizeBarcodeScannerInput) — يحلّ خطأ «الباركود لا يُضاف
  // تلقائياً» بلا الاعتماد على استقرار البحث المؤجَّل، ويصحّح المسح حين تكون اللوحة عربيةً.
  const barcodeInput = useBarcodeInput((code) => {
    setSearch("");
    void lookupBarcode(code);
  });

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
    setDepositMenuOpen(false);
    if (offline) { notify.errBig("لا قبض عربون دون اتصال", "العربون يحتاج إيصالاً خادمياً — أعد المحاولة عند عودة الاتصال."); return; }
    if (cart.length === 0) { notify.warn("السلة فارغة", "أضف ما يريده الزبون ثم اقبض العربون"); return; }
    if (!shift) { notify.errBig("افتح وردية استقبال أولاً", "العربون يدخل درجك وتُحاسَب عليه عند الإغلاق."); return; }
    try {
      if (!activeDraft) {
        const p = await promoteM.mutateAsync({ branchId, shiftId: shift?.id ?? null, ...buildDraftPayload() });
        setDraftInfo({ draftNumber: p.draftNumber });
      } else {
        // مراجعة ش٤: تفريغ المزامنة المؤجَّلة قبل فتح الحوار (نمط مسار التثبيت) — سقف الحوار
        // من السلة الحيّة بينما الخادم يحسب على أسطره؛ بلا التفريغ يُرفض عربونٌ مشروع بعد
        // إضافة صنفٍ للتوّ، والتقادم يدوم بعد عطل نقلٍ عابر (لا نبضة إلا بتغيير السلة).
        if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
        const live = activeDraftRef.current ?? activeDraft;
        try {
          await syncM.mutateAsync({ draftId: live.id, version: live.version, ...buildDraftPayload() });
        } catch {
          // syncM.onError عالج (CONFLICT ⇒ إعادة ربط، انغلاق ⇒ فكّ) — لا نفتح على أسطرٍ متقادمة.
          notify.warn("تعذّرت مزامنة الطلب قبل القبض", "تحقّق من الاتصال ثم أعد المحاولة");
          return;
        }
      }
      setDepositOpen(true);
    } catch {
      /* promoteM.onError أبلغ */
    }
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
    setLinkedConversationId(v.conversationId);
    // ⛔ لا تحويلَ `OTHER → WALK_IN`: محادثةُ المتجر/غيرِها كانت تُسجَّل **طلبَ حضورٍ
    // شخصيّ** فتكذب نسبةُ القنوات وتقريرُها — والقاموس المشترك يعرّف `STORE → OTHER` صراحةً.
    setChannel(toWorkOrderChannel(v.channel));
    setChannelHandle(v.channelHandle);
    // ⚠ الرقم يصل من القناة بصيغة E.164 (`+9647…`) وحقلُ المحطّة يطلب المحليّة
    // (`07…`) ويحرسها `isValidIqMobile` عند الإتمام ⤇ بلا هذا التطبيع يفتح الموظّف الطلب
    // ويملأ السلّة ثمّ يصطدم بـ«رقم الهاتف إلزامي» رغم أنّ الرقم وصل مع المحادثة.
    // (ومعرّفُ إنستغرام/تيك توك ليس هاتفاً ⤇ يُترك الحقل ليملأه الموظّف.)
    const localPhone = toLocalIqMobileDigits(v.channelHandle);
    if (isValidIqMobile(localPhone)) setReceptionPhone(localPhone);
    setCustomer({
      customerId: v.customerId,
      name: v.displayName ?? "",
      phone: isValidIqMobile(localPhone) ? localPhone : null,
      isNew: false,
    });
    setShowInbox(false);
    notify.ok(`فُتح طلبٌ من محادثة ${v.displayName ?? v.channelHandle} — أضف ما يطلبه الزبون`);
  }

  function buildDraftPayload(customerIdOverride?: number | null) {
    const effectiveCustomerId = customerIdOverride ?? customer.customerId ?? null;
    const header = {
      customerId: effectiveCustomerId,
      contactName: effectiveCustomerId == null ? (customer.name.trim() || null) : null,
      contactPhone: effectiveCustomerId == null ? (customer.phone?.trim() || null) : null,
      priceTier: effectiveTier,
      channel,
      // ش١: المعرّف والمحادثة يسافران مع الرأس — وإلّا ضاع رقم مُرسِل الطلب عند التثبيت.
      channelHandle: channelHandle.trim() || null,
      conversationId: linkedConversationId,
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
      setDraftInfo({ draftNumber: r.draftNumber });
      setDraftHeld("0.00"); // طلبٌ جديد — لا مقبوض عليه بعد
      notify.ok(`حُفظ الطلب — ${r.draftNumber}`, "يُزامَن تلقائياً مع كل تعديل، ويستطيع زميلك إكماله من جهازه");
      void utils.reception.draftList.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const syncM = trpc.reception.draftSync.useMutation({
    onSuccess: (r) => setActiveDraft((prev) => (prev ? { ...prev, version: r.version } : prev)),
    onError: (e, vars) => {
      // مراجعة عدائية (٥/٨): التمييز بالكود — فكُّ الربط على كل خطأ كان يترك مسوّداتٍ يتيمةً
      // OPEN لبيعٍ أُتمّ (زميل يثبّتها = ازدواج) ويقطع الحفظ على عطل شبكةٍ عابر.
      const code = (e as { data?: { code?: string } }).data?.code;
      if (code === "CONFLICT") {
        // تعارض زميل (I9) أو نسخة closure قديمة ⇒ أعد الجلب والربط بالنسخة الحيّة بلا طمس.
        notify.warn("حُدِّث الطلب المحفوظ", "أُعيد تحميله بأحدث نسخة — راجعه ثم تابع");
        void resumeDraft(vars.draftId);
      } else if (code === "PRECONDITION_FAILED") {
        // انغلقت (ثُبِّتت/أُلغيت/انقضت) أو حارس I3 (مموّلة: حذف بند/خفض دون المقبوض) ⇒ الرسالة تشرح.
        // حارس I3 لا يفكّ الربط — الطلب حيٌّ والموظّف يصحّح (يعيد البند أو يردّ العربون).
        const i3Guard = /مبلغٌ مقبوض|المقبوض سلفاً/.test(e.message);
        notify.warn(i3Guard ? "الطلب عليه مبلغ مقبوض" : "توقّفت مزامنة الطلب المحفوظ", e.message);
        if (!i3Guard) {
          setActiveDraft(null);
          setDraftHeld("0.00");
          setDraftInfo(null);
          void utils.reception.draftList.invalidate();
        } else if (activeDraftRef.current) {
          // استرجع النسخة الخادمية الصادقة (البنود قبل الحذف المرفوض).
          void resumeDraft(activeDraftRef.current.id);
        }
      }
      // عطل نقلٍ عابر (code فارغ): أبقِ الربط — النبضة القادمة تعيد المحاولة.
    },
  });
  // نسخة المسوّدة في ref — المؤقّت المجدول أثناء ذهابِ مزامنةٍ سابقة كان يحمل closure قديمة
  // فيطلق CONFLICT «ذاتيّ المنشأ» (توست «حدّثها زميل» بلا زميل).
  const activeDraftRef = useRef(activeDraft);
  useEffect(() => {
    activeDraftRef.current = activeDraft;
  }, [activeDraft]);

  function saveDraft() {
    if (cart.length === 0 || !!activeDraft || offline) return;
    promoteM.mutate({ branchId, shiftId: shift?.id ?? null, ...buildDraftPayload() });
  }
  /** ش٣ — التثبيت الذرّي من المسوّدة نفسها (يستبدل جسر «الطيّ» المؤقّت من ش٢). */
  const commitDraftM = trpc.reception.draftCommit.useMutation();

  /** مزامنة بالجملة بdebounce (§٦ — لا سطراً-سطراً: مسح ١٢ باركوداً متتابعاً يمرّ بلا CONFLICT).
   *  النسخة تُقرأ من ref **لحظة الإطلاق** لا من closure الجدولة (مراجعة عدائية — سباق ذاتي المنشأ). */
  useEffect(() => {
    if (!activeDraft || offline) return;
    if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    draftSyncTimer.current = setTimeout(() => {
      const live = activeDraftRef.current;
      if (!live) return;
      syncM.mutate({ draftId: live.id, version: live.version, ...buildDraftPayload() });
    }, 800);
    return () => {
      if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, customer.customerId, customer.name, customer.phone, effectiveTier, channel, channelHandle, linkedConversationId, activeDraft?.id]);

  /** استئناف مسوّدة (من هذا الجهاز أو جهاز زميل): صفوفٌ حيّة عبر catalog.byUnitIds + مواصفة CUSTOM من printSpec. */
  async function resumeDraft(draftId: number) {
    try {
      // staleTime:0 إلزاميّ (مراجعة ش٤): الافتراض العام ٦٠ث كان يعيد نسخة الكاش بعد CONFLICT/
      // حارس I3 — heldTotal وversion وبنوداً متقادمة دقيقةً كاملة ⇒ حلقة CONFLICT وتحصيلٌ زائد.
      const d = await utils.reception.draftGet.fetch({ draftId }, { staleTime: 0 });
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
      setReceptionPhone(toLocalIqMobileDigits(d.contactPhone ?? ""));
      setTierOverride((d.priceTier as Tier) ?? null);
      setActiveDraft({ id: draftId, version: Number(d.version) });
      // ش٤: صافي المقبوض سلفاً يرافق الاستئناف — «المتوقّع الآن» يهبط به فوراً.
      setDraftHeld(String((d as { heldTotal?: string }).heldTotal ?? "0.00"));
      setDraftInfo({ draftNumber: d.draftNumber });
      const heldNote = Number((d as { heldTotal?: string }).heldTotal ?? 0) > 0
        ? ` — عليها عربون مقبوض ${fmt(Number((d as { heldTotal?: string }).heldTotal))} د.ع`
        : "";
      notify.ok(
        `فُتحت المسوّدة ${d.draftNumber}${heldNote}`,
        skipped > 0 ? `تنبيه: ${skipped} بند تعذّر استرجاعه (منتج غير متاح)` : "تعديلاتك تُزامَن وتُسجَّل باسمك",
      );
    } catch (e) {
      notify.err(e, "تعذّر فتح المسوّدة");
    }
  }

  async function printDraftTicketById(draftId: number) {
    try {
      const d = await utils.reception.draftGet.fetch({ draftId }, { staleTime: 0 });
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

  async function handleSubmit(opts: { quickFullPay: boolean; openingConfirmed?: boolean }) {
    // Fail before customer creation/offline capture: a stale external method must not
    // leave an orphan customer when the checkout service rejects the payment.
    if (!isPosPaymentMethodEnabled(String(method))) {
      notify.err(POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE);
      return;
    }
    if (cart.length === 0) return;
    if (!shift) {
      notify.err("ابدأ الوردية أولاً قبل إتمام طلب العميل");
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

    // ٨/٨ (طلب المالك: التوصيل «غير موجود» لأمر شغلٍ خالص) — «توصيل هذا الطلب» كان يُبنى إسناداً
    // على الفاتورة الحاملة (dispatchInvoice)، وأمرُ الشغل الخالص بلا فاتورةٍ عند التثبيت ⇒ الخادم
    // يرفض والتوصيل يسقط بتحذيرٍ يُبتلَع. الحلّ: نوجّه التوصيل إلى **حقول أمر الشغل نفسه** —
    // فيحمله الأمر (hasDelivery + عنوان + هاتف + أجرة + مَن يقبض)، ويُطبَع، ويظهر في الطابور،
    // ويُسنَد للمندوب من طابور الطلبات عند الجاهزية (delivery.dispatch يشترط hasDelivery=true).
    const hasCarrierInvoice = regularLines.length > 0 || printLines.length > 0;
    const routeDeliveryToWO = orderDelivery != null && !hasCarrierInvoice;
    // القبض الآن (COUNTER) على أمر شغلٍ **محفوظٍ** (مسوّدة) غير مدعومٍ خادمياً (collectNow لا
    // يغطّيه بنيوياً — reception/commit.ts) ⇒ نمنعه برسالةٍ واضحة بدل خطأ خادميّ غامض.
    if (routeDeliveryToWO && activeDraft && orderDelivery?.feeCollection === "COUNTER") {
      notify.err(
        "قبض أجرة التوصيل الآن غير متاح لطلبٍ محفوظ",
        "اجعل المندوب يقبضها من الزبون، أو المكتبة تتحمّلها — أو أتمّ الطلب مباشرةً (بلا حفظ المسوّدة) لقبضها الآن.",
      );
      return;
    }
    // توصيلٌ فعّالٌ لكلّ أمر: من «توصيل هذا الطلب» إن وُجِّه للأوامر (طلب خالص)، وإلّا من كتلة
    // التخصيص. الأجرة على **أوّل أمرٍ فقط** عند التوجيه (طلبٌ واحدٌ = توصيلٌ واحد) كيلا تتضاعف
    // الأمانة/المصروف عبر عدّة أوامر. تُستعمل في حمولة الحفظ وفي طباعة التذكرة معاً (مصدرٌ واحد).
    const effectiveWoDelivery = (custom: CustomizationData, idx: number) =>
      routeDeliveryToWO && orderDelivery
        ? {
            has: true,
            address: orderDelivery.address || custom.deliveryAddress || null,
            phone: orderDelivery.recipientPhone || custom.deliveryPhone || null,
            cost: idx === 0 ? round2(D(orderDelivery.fee || 0)).toFixed(2) : "0.00",
            feeColl: orderDelivery.feeCollection,
            partyName: orderDelivery.partyName as string | null,
          }
        : {
            has: custom.hasDelivery,
            address: custom.deliveryAddress || null,
            phone: custom.hasDelivery ? custom.deliveryPhone || null : null,
            cost: custom.hasDelivery ? round2(D(custom.deliveryCost || 0)).toFixed(2) : "0.00",
            feeColl: (custom.hasDelivery ? custom.deliveryFeeCollection : "COURIER") as "COURIER" | "COUNTER" | "SHOP",
            partyName: null as string | null,
          };

    // سعر كل أمر فقط؛ العربون لم يعد حقلاً على السطر، بل يوزّعه الخادم من دفعة الطلب الكلية.
    const customWithDeposits = customItems.map((c) => {
      const full = D(customLineGrand(c));
      return { c, depositStr: "0.00", salePriceStr: full.toFixed(2) };
    });

    // ش٠ (V1): كل المقارنات على الإجمالي **الفعليّ** (المقرَّب عند سريان التقريب) — إرسال مبالغ
    // غير مقرَّبة مع علم التقريب كان يجعل الخادم يرى نقصاً (رفضٌ للزبون العابر) أو ذمّةً صامتة.
    // ش٤: المستحقّ الآن = الإجمالي − العربون المقبوض سلفاً (heldD) — الدفع الجديد يقاس عليه.
    const inputPaidD = opts.quickFullPay ? expectedNowD : paidD;
    const appliedPaidD = method === "CASH" && inputPaidD.gt(expectedNowD) ? expectedNowD : inputPaidD;

    // غير النقد كلّه صالح كعربون، لكن بلا فكّة وبمرجع تتبّع إلزامي (كود الكارت لرصيد زين).
    if (method !== "CASH" && inputPaidD.gt(0) && !paymentReference.trim()) {
      notify.err(
        method === "CARD" ? "رقم عملية البطاقة مطلوب"
        : method === "WALLET" ? "رقم عملية المحفظة مطلوب"
        : method === "TELECOM" ? "أرقام كارت شحن زين (الكود) مطلوبة"
        : "رقم مرجع التحويل مطلوب",
      );
      return;
    }
    if (method !== "CASH" && inputPaidD.gt(expectedNowD)) {
      notify.err(`لا يمكن أن يتجاوز مبلغ ${PAY_METHOD_LABEL[method] ?? "الدفع"} المستحقّ الآن (${fmt(expectedNowD.toFixed(2))} د.ع)`);
      return;
    }
    // ش٦ — التقريب المختلط يُحسم هنا: يسري فقط حين يُدفع المقرَّب **كاملاً** الآن (المرآة
    // الحرفية لشرط materialize خادمياً) — دفعةٌ جزئية تُرسَل بمبالغ خام بلا تقريب.
    const mixedRoundApplied = mixedRoundEligible
      && round2(appliedPaidD.plus(heldD)).eq(round2(effectiveGrandD));
    const mixedDeltaAppliedD = mixedRoundApplied ? mixedDeltaD : D(0);
    // ٢٣/٨ — أرضيّة النقد الجزئيّ (Codex P1): تُقاس على `sumDirectNetD` (بعد خصم رأس الفاتورة)
    // لا على `sumDirectD` الخام. لولا التصحيح: خصمٌ ١٠٪ على سلّةٍ نقديّةٍ غير مقرَّبة أو بطاقةٍ/تحويلٍ
    // كان يعرض «الصافي» ٩٠٠٠ لكنّه يطالب بـ١٠٠٠٠ نقداً على الأرضيّة ⇒ تفشل عملية Quick Pay بلا سبب.
    const directFloorD = cashRoundActive
      ? effectiveGrandD
      : round2(sumDirectNetD.plus(mixedDeltaAppliedD));
    // مراجعة PR #495 — مرآة حارس الخادم حرفياً (`!input.delivery && applied.lt(directTotal)`):
    // طلبٌ يُسنَد لمندوبٍ **الدفعُ فيه عند الاستلام**، فاشتراط تغطية البضاعة نقداً الآن كان
    // يستحيل معه بيعُ COD أصلاً (وإدخالُ المبلغ لإسكات الحارس يسجّله نقداً في الدرج ⇒ عهدةُ
    // المندوب صفر ونقدٌ لم يُقبَض). المتبقّي يصير عهدةً عليه داخل نفس معاملة التثبيت.
    // بيع مباشر آجل (قرار المالك ١٠/٨): المتبقّي على البضاعة الجاهزة يصير ذمّةً على العميل المسجَّل.
    // مسار مباشر حصراً (لا مسوّدة — توزيعها يفترض دفعاً كاملاً، ولا توصيل — يُحصَّل عند الاستلام)،
    // ويلزمه عميلٌ مسجَّل (لا ذمّة بلا صاحب — createSaleInTx يرفض الآجل بلا customerId).
    if (deferred) {
      if (activeDraft) { notify.err("البيع الآجل غير متاح للطلب المحفوظ — ثبّته مباشرةً بلا حفظ مسوّدة"); return; }
      if (orderDelivery) { notify.err("طلب التوصيل يُحصَّل عند الاستلام — لا حاجة لوضع «آجل»"); return; }
    }
    if (!isValidIqMobile(receptionPhone)) {
      notify.err("رقم هاتف العميل إلزامي — أكمل ١١ رقماً عراقياً تبدأ بـ07");
      customerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (!canCreateCustomer) {
      notify.err("دورك لا يملك بوابة ربط عميل الاستقبال — راجع إعداد صلاحية أوامر الشغل");
      return;
    }
    if (!orderDelivery && !deferred && appliedPaidD.plus(heldD).lt(directFloorD)) {
      // ٢٣/٨ (بلاغ المالك): رسالة الخطأ صارت تقترح مساراتٍ عمليّة بدل مجرّد الحظر.
      // الكاشير كان يحدّق في الرسالة دون معرفة كيف يخرج من الحال.
      const shortfall = round2(directFloorD.minus(appliedPaidD).minus(heldD));
      notify.errBig(
        `البضاعة الجاهزة تحتاج ${fmt(directFloorD.toFixed(2))} د.ع (ناقصٌ ${fmt(shortfall.toFixed(2))})`,
        deferredAvailable
          ? "اختر «بدون عربون» لتسجيله ذمّةً على العميل، أو أَضِف مبلغاً يغطّي البضاعة الجاهزة."
          : customer.customerId == null
            ? "اربط عميلاً بحدّ ائتمانٍ لبيعٍ آجل، أو أَضِف توصيلاً (التحصيل عند الاستلام)، أو أَكمل المبلغ الآن."
            : !customerDeferredEligible
              ? "حدّ ائتمان العميل صفر — أَكمل المبلغ نقداً، أو راجع المدير لرفع الحدّ، أو أَضِف توصيلاً."
              : "أَكمل المبلغ الآن، أو أَضِف توصيلاً للتحصيل عند الاستلام."
      );
      return;
    }

    // ش٥ (§٩.٤): رصيد زين بلا مُثبِتٍ خارجيّ — تأكيدٌ ثانٍ صريح قبل التسجيل (الزبون حاضر).
    if (method === "TELECOM" && appliedPaidD.gt(0)) {
      if (!(await confirm({
        variant: "warning",
        title: "تأكيد قبض رصيد زين",
        description: `تحقّقتَ أن رصيد ${fmt(round2(appliedPaidD).toNumber())} د.ع وصل فعلاً (كارت شحن ${paymentReference.trim() || "—"})؟ الكود يُقبل مرّةً واحدة ولا يدخل درج النقد.`,
        confirmText: "وصل الرصيد — سجّل",
      }))) return;
    }

    // تَفعيل قَفل الإرسال **قبل** ensureCustomerId لمنع سباق نَقر مَزدوج يُنشئ عميلاً مكرَّراً
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
      await captureOfflineReception();
      setSubmitting(false);
      return;
    }

    // هوية العميل جزء من عملية الاستقبال وليست خياراً جانبياً: حسم الهاتف/الاسم يسبق أي فاتورة.
    let customerId: number | null = customer.customerId ?? null;
    if (customerId == null) {
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
      const saleAmount = cashRoundActive
        ? round2(effectiveGrandD).toFixed(2)
        : round2(
            regularSumRawD.minus(invoiceDiscountAmountD)
              .plus(mixedRoundApplied && mixedCarrier === "SALE" ? mixedDeltaAppliedD : D(0)),
          ).toFixed(2);
      const printAmount = round2(
        printLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0))
          .plus(mixedRoundApplied && mixedCarrier === "PRINT" ? mixedDeltaAppliedD : D(0)),
      ).toFixed(2);
      const workOrderPayloads = customWithDeposits.map((x, woIndex) => {
        const c = x.c;
        const custom = c.custom!;
        const finalText = composeCustomizationText(custom);
        const eff = effectiveWoDelivery(custom, woIndex);
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
          // ٥/٨ — salePrice = بضاعة/خدمة فقط؛ أجرة التوصيل في عمودها المستقلّ (تمريرٌ لا إيراد).
          salePrice: x.salePriceStr,
          dueDate: custom.dueDate || null,
          priority: custom.priority,
          assignedTo: custom.assignedTo ?? undefined,
          deposit: x.depositStr,
          paymentMethod: D(x.depositStr).gt(0) ? method : null,
          paymentReference: D(x.depositStr).gt(0) && method !== "CASH" ? paymentReference.trim() : null,
          paymentReceiptUrl: custom.paymentReceiptImages[0]?.dataUrl || null,
          receptionChannel: channel,
          channelHandle: (channel === "INSTAGRAM" || channel === "TIKTOK" ? channelHandle : receptionPhone) || null,
          // ٨/٨ — التوصيل الفعّال (من «توصيل هذا الطلب» المُوجَّه للأمر، أو من كتلة التخصيص).
          hasDelivery: eff.has,
          deliveryAddress: eff.address,
          // ٥/٨ — الأجرة في عمودها وحدها: تمريرٌ للمندوب خارج salePrice/الفاتورة/الإيراد.
          deliveryCost: eff.has ? eff.cost : "0",
          deliveryFeeCollection: eff.has ? eff.feeColl : "COURIER",
          // اِستقبال (تكامل التوصيل، ٤/٨): هاتف المستلم كعمود مستقلّ قابل للاستعلام — كان
          // مُضمَّناً كنصٍّ حرٍّ داخل customizationText فقط (composeCustomizationText أدناه ما زال
          // يُضيفه للنصّ أيضاً — تكرارٌ مقصود: عرضٌ للفنّي في النص + مصدر حقيقة للتوصيل في العمود).
          deliveryPhone: eff.has ? eff.phone : null,
          designImages: custom.designImages.map((img, idx) => ({
            url: img.dataUrl,
            caption: img.name ?? null,
            sortOrder: idx,
          })),
        };
      });

      // ش٧ + مراجعة PR #495 — **الإسناد داخل معاملة التثبيت**: كانت الواجهة تُتمّ الطلب ثم
      // تنادي `delivery.dispatchInvoice` في معاملةٍ تالية، فتُنتج نافذةً تكون فيها الفاتورة بلا
      // دافعٍ ولا حاملِ عهدة (وفشلُ الإسناد يتركها يتيمةً بلا مندوب). الخادم يدعم `delivery`
      // على المسارين (receptionCheckout/draftCommit) منذ ش٧ — نمرّرها الآن فيصيران ذرّةً واحدة:
      // إمّا (فاتورة + عهدة مندوب) معاً وإمّا لا شيء. أوامر الشغل وحدها بلا فاتورةٍ حاملة
      // تبقى استثناءً مُعلَناً (تحذيرٌ بعد التثبيت) — الخادم يرفض `delivery` بلا فاتورة.
      const hasCarrierInvoice = regularLines.length > 0 || printLines.length > 0;
      const deliveryPayload = orderDelivery && hasCarrierInvoice
        ? {
            partyId: orderDelivery.partyId,
            fee: orderDelivery.fee?.trim() ? orderDelivery.fee : "0",
            feeCollection: orderDelivery.feeCollection,
            recipientName: orderDelivery.recipientName || undefined,
            recipientPhone: orderDelivery.recipientPhone || undefined,
            address: orderDelivery.address || undefined,
          }
        : undefined;

      // ش٣: طلبٌ محفوظٌ (مسوّدة نشطة) يُثبَّت **من مسوّدته** ذرّياً عبر reception.draftCommit —
      // idempotency ثلاثية (version + FOR UPDATE + commitRequestId الخادمي). قبله «تفريغُ
      // مزامنةٍ» متزامنٌ يقتل سباق «عدّلتُ ثم ثبّتُّ قبل نبضة الـdebounce»، وexpectedTotal
      // (الخام قبل تقريب IQD) حزام أمانٍ ضدّ انجراف العرض.
      const result = activeDraft
        ? await (async () => {
            if (draftSyncTimer.current) clearTimeout(draftSyncTimer.current);
            const live = activeDraftRef.current ?? activeDraft;
            // تفريغ المزامنة قبل التثبيت (يقتل سباق التعديل قبل نبضة debounce). مراجعة عدائية:
            // إن رُفض بـ«ثُبِّتت فاتورةً» (فُقد ردُّ تثبيتٍ سابق) **نتابع** إلى commitDraft —
            // الخادم يعيد النتيجة المبنيّة من مفاتيح idempotency، لا نفكّ الربط فنزدوج بمسارٍ مباشر.
            let commitVersion = live.version;
            try {
              const synced = await syncM.mutateAsync({
                draftId: live.id,
                version: live.version,
                // مراجعة PR #495: العميل المُنشأ للتوّ يُمرَّر صراحةً (حالة React لم تُحدَّث بعد).
                ...buildDraftPayload(customerId),
              });
              commitVersion = synced.version;
            } catch (syncErr) {
              const code = (syncErr as { data?: { code?: string } }).data?.code;
              if (code !== "PRECONDITION_FAILED") throw syncErr; // CONFLICT/نقل ⇒ المسار العام
              // مسوّدة مغلقة: إن كانت COMMITTED فcommitDraft يعيد النتيجة نفسها (rebuild يسبق فحص version).
            }
            const committed = await commitDraftM.mutateAsync({
              draftId: live.id,
              version: commitVersion,
              expectedTotal: round2(grandTotalD).toFixed(2),
              shiftId: shift.id,
              collectNow: appliedPaidD.gt(0)
                ? { amount: round2(appliedPaidD).toFixed(2), method, reference: method === "CASH" ? undefined : paymentReference.trim() }
                : null,
              // ش٦: العلم يشمل المختلط — materialize خادمياً يعيد اشتقاق الهدف والفرق من الأسطر.
              cashRoundIQD: cashRoundActive || mixedRoundApplied,
              // ش٦ (V15): أجرة توصيل الطلب المقبوضة الآن — إيصال أمانةٍ نقديّ مع الفاتورة.
              deliveryFeeHeld: orderFeeHeldD.gt(0) && !routeDeliveryToWO ? orderFeeHeldD.toFixed(2) : undefined,
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
        : await checkoutM.mutateAsync({
        branchId,
        shiftId: shift.id,
        customerId: customerId ?? undefined,
        // مرجع الزبون العابر: يُكتب على الفاتورة وأمر الشغل حتى بلا سجلّ عميل.
        contactName: customerId == null ? (customerName ?? undefined) : undefined,
        contactPhone: customerId == null ? (receiptPhone ?? undefined) : undefined,
        // صدق طريقة الدفع (١٨/٨): الطريقة تُرسَل **فقط حين يُقبض مالٌ الآن**. كانت تُرسل دائماً
        // فتُختَم «نقدي» على فاتورةٍ آجلة/COD لم يدخلها دينار (بلاغ المالك)، وتسقط من فلتر «آجل».
        paymentMethod: appliedPaidD.gt(0) ? method : undefined,
        paymentReference: appliedPaidD.gt(0) && method !== "CASH" ? paymentReference.trim() : undefined,
        paidAmount: round2(appliedPaidD).toFixed(2),
        cashRoundIQD: cashRoundActive,
        // ش٦: تسمية الفاتورة الحاملة لفرق التقريب المختلط (المبلغ مُبيَّتٌ فيها أعلاه).
        cashRoundingOverride: mixedRoundApplied ? mixedCarrier ?? undefined : undefined,
        // ش٦ (V15): أجرة توصيل الطلب المقبوضة الآن — إيصال أمانةٍ نقديّ مع الفاتورة.
        deliveryFeeHeld: orderFeeHeldD.gt(0) && !routeDeliveryToWO ? orderFeeHeldD.toFixed(2) : undefined,
        // مراجعة PR #495: الإسناد داخل نفس معاملة البيع (ذرّية الفاتورة + عهدة المندوب).
        delivery: deliveryPayload,
        // الاستقبال (٨/٨): تأكيد توفّر الأصناف غير المجرودة فيزيائياً (بيع بالسالب لطلب COD في الافتتاح).
        openingSellUnavailableConfirmed: opts.openingConfirmed === true,
        // بيع مباشر آجل (قرار المالك ١٠/٨): المقبوض أقلّ من البضاعة الجاهزة بلا توصيل ⇒ المتبقّي ذمّة
        // على العميل المسجَّل (حدّ الائتمان نافذ خادمياً). مسار مباشر فقط (لا مسوّدة، لا توصيل).
        deferredDirect: deferred,
        // م٦: اعتماد المدير للخصم >١٠٪ — التُقط استباقياً عند التطبيق ويُتحقَّق خادمياً الآن.
        managerApproval: mgrCredsRef.current ?? undefined,
        clientRequestId: reqIdRef.current,
        priceTier: effectiveTier,
        couponCode: couponCode ?? undefined,
        regularSale: regularLines.length > 0 ? {
          amount: saleAmount,
          // ٢٣/٨ — خصمُ رأس الفاتورة (سلطة الكاشير ٠–١٥٪): يمرَّر مطلقاً لـcreateSaleInTx على البيع
          // المباشر فقط (لا يمسّ printSale ولا workOrders). فوقَ الحدّ يرفضه الخادم بـmanualGate إلّا
          // باعتمادِ مديرٍ (POS.tsx يفعل نفس الشيء). صفر ⇒ حذفٌ من الحمولة.
          ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
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
      const receiptCustomerName = customerName && receiptPhone
        ? `${customerName} — ${receiptPhone}`
        : customerName ?? (receiptPhone ? `عميل ${receiptPhone}` : null);
      // ش٤: الفكّة والمتبقّي يقاسان على المستحقّ الآن (بعد خصم العربون السابق heldD).
      const changeD2 = round2(appliedPaidD.minus(expectedNowD));
      const printedChange = method === "CASH" && changeD2.gt(0) ? changeD2.toFixed(2) : null;
      const creditD = round2(expectedNowD.minus(appliedPaidD));
      const printedCredit = creditD.gt(0) ? creditD.toFixed(2) : null;
      const receiptLine = (c: CartLine) => ({
        name: `${c.row.productName} (${c.row.unitName})${c.disc ? ` −${c.disc}%` : ""}`,
        quantity: c.qty,
        price: round2(D(effectivePrice(c))).toFixed(2),
        total: round2(D(lineTotal(c))).toFixed(2),
      });
      // G3 (١١/٨) — إصلاح Codex P2:
      // (١) heldDeposits من ردّ الخادم لا الحالة المحلّية: `customWithDeposits[i].depositStr` مسوّدة
      //     "0.00" دائماً — الخادم يوزّع العرابين الحقيقيّة ويعيدها في `result.workOrders[i].deposit`
      //     (نفس النمط المستعمل أدناه لتذكرة أمر الشغل السطر ١٥٨٤).
      // (٢) shiftId من الفاتورة المُثبَّتة لا من scope الحيّ: عند idempotent replay بعد إغلاق الوردية
      //     الأصليّة وفتح جديدة، `result.regularSale.shiftId` يحمل رقم الوردية الحقيقيّة للفاتورة.
      //     الرجوع لـ`shift?.id` احتياطاً لمسار الأمر الشغل الخالص (لا فاتورة).
      const receiptServerMeta = receptionCheckoutReceiptMeta(result, shift?.id);
      const receiptHead = {
        date: fmtDate(printedAt),
        time: printedAt.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" }),
        cashierName: me.data?.name ?? "موظف الخدمة",
        customerName: receiptCustomerName,
        paymentMethod: PAY_METHOD_LABEL[method],
        shiftId: receiptServerMeta.shiftId,
        heldDeposits: receiptServerMeta.heldDeposits,
      };
      // ٨/٨ — إفصاح التوصيل على إيصال البيع المباشر: كان لا يُطبَع إطلاقاً («لم تظهر بالطباعة»).
      // يُوضَع على الفاتورة الحاملة للإرسالية (البضاعة إن وُجِدت وإلّا الطباعة). الأجرة تمريرٌ لا
      // إيراد ⇒ خارج الإجمالي؛ الإيصال يعرض «يدفع الزبون شاملاً التوصيل» شفافيةً.
      const receiptDelivery = orderDelivery && hasCarrierInvoice
        ? {
            partyName: orderDelivery.partyName,
            fee: round2(D(orderDelivery.fee || 0)).toFixed(2),
            feeCollection: orderDelivery.feeCollection,
            address: orderDelivery.address || null,
          }
        : null;
      if (result.regularSale) {
        // ٢٣/٨ — Codex P1: خصمُ رأس الفاتورة يُطبع صراحةً على الإيصال. لولا هذا يظهر subtotal
        // = total (الصافي) بينما الأسطر تُظهر أسعارها الخام ⇒ الإيصال لا يُطابق حسابياً والزبون يسأل
        // عن الفارق. `subtotal` صار الخام (`regularSumRawD`)، `discount` يعلن الخصم، والصافي `total`.
        const regularGrossD = regularLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
        receiptsToPrint.push({
          ...receiptHead,
          receiptNumber: result.regularSale.invoiceNumber,
          items: regularLines.map(receiptLine),
          subtotal: round2(regularGrossD).toFixed(2),
          discount: invoiceDiscountAmountD.gt(0) ? invoiceDiscountAmountD.toFixed(2) : null,
          total: saleAmount,
          paid: saleAmount,
          // الفكّة تُطبع مرّةً واحدةً على أول إيصال (هي فكّة الطلب كله لا فكّة فاتورةٍ بعينها).
          change: printedChange,
          credit: printedCredit,
          delivery: receiptDelivery,
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
          // الإرسالية على البضاعة إن وُجِدت؛ إيصال الطباعة يحمل التوصيل فقط حين لا بضاعة.
          delivery: result.regularSale ? null : receiptDelivery,
        });
      }

      customWithDeposits.forEach((x, index) => {
        const c = x.c;
        const custom = c.custom!;
        const finalText = composeCustomizationText(custom);
        const eff = effectiveWoDelivery(custom, index);
        // ش٤ (§١٠): العربون الموزَّع على الأمر من ردّ الخادم (الجشع الخادميّ هو الحقيقة) —
        // التذكرة تحمل «مدفوع مقدماً/المتبقّي عند الاستلام» فلا يخرج الزبون بورقةٍ لا تُثبت عربونه.
        const woDeposit = (result.workOrders[index] as { deposit?: string } | undefined)?.deposit ?? "0.00";
        const woBalance = round2(D(x.salePriceStr).minus(D(woDeposit)));
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
          paidUpfront: Number(woDeposit) > 0 ? woDeposit : null,
          balanceDue: Number(woDeposit) > 0 ? woBalance.toFixed(2) : null,
          // ٥/٨ + ٨/٨ — أجرة التوصيل تُطبع صراحةً على التذكرة **خارج الإجمالي**، مع الجهة ومَن
          // يقبضها: يمنع سوءَ الفهم الذي كان يجعل الموظّف والزبون يظنّانها جزءاً من قيمة الطلب،
          // ويُظهر التوصيل حتى حين جاء من زرّ «توصيل هذا الطلب» (كان لا يُطبَع إطلاقاً قبل الإصلاح).
          notes: eff.has
            ? [
                `توصيل إلى: ${eff.address || "العنوان غير محدد"}`,
                eff.phone ? `هاتف المستلم: ${eff.phone}` : null,
                eff.partyName ? `جهة التوصيل: ${eff.partyName}` : null,
                D(eff.cost || 0).gt(0)
                  ? `أجرة التوصيل ${fmt(eff.cost)} د.ع (${
                      eff.feeColl === "COUNTER" ? "مقبوضة في الاستقبال أمانةً"
                      : eff.feeColl === "SHOP" ? "على المكتبة — مجاناً للزبون"
                      : "يقبضها المندوب من الزبون عند الاستلام"
                    }) — خارج قيمة الطلب`
                  : "توصيل — بلا أجرة",
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
          if (!result.ok) printFailures += 1;
          else if (result.via === "browser") browserFallbacks += 1;
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
      setDeferred(false);
      // ٢٣/٨ — تفريغ خصم رأس الفاتورة بعد البيع الناجح كي لا يمرَّ سهواً إلى العميل التالي.
      setInvoiceDiscountPct("");
      setCustomer({ customerId: null, name: "", phone: null, isNew: false });
      setReceptionPhone("");
      setChannel("WALK_IN");
    setLinkedConversationId(null);
      setChannelHandle("");
      reqIdRef.current = crypto.randomUUID();
      // تحديث القوائم.
      utils.workOrders.list.invalidate().catch(() => {});
      utils.shifts.current.invalidate().catch(() => {});
    } catch (e: unknown) {
      // الاستقبال (٨/٨): حاصر البيع بالسالب في وضع الافتتاح — الصنف غير مجرود (رصيد سالب) وطلبٌ
      // بتوصيل COD. أثناء الافتتاح السالب يعني «لم يُعدّ» لا «نافد»، والمندوب يحمل الصنف الموجود
      // فعلياً. نعرض تأكيداً صريحاً (توفّر فيزيائيّ) مرّةً واحدة ثم نعيد بنفس opts + العلم.
      const errMsg = e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? "");
      const isOpeningNegativeBlock = !checkoutCommitted && !opts.openingConfirmed
        && (errMsg.includes("المخزون غير كافٍ") || errMsg.includes("البيع بالسالب"))
        && errMsg.includes("الافتتاح");
      if (isOpeningNegativeBlock) {
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
      const isTransportFailure = !checkoutCommitted
        && (e as { data?: { code?: string } } | null)?.data?.code == null;
      if (isTransportFailure && (await captureOfflineReception())) {
        return;
      }
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
  async function captureOfflineReception(): Promise<boolean> {
    if (!shift || cart.length === 0) return false;
    const capturedByUserId = me.data?.id;
    if (!Number.isInteger(capturedByUserId) || Number(capturedByUserId) <= 0) {
      notify.errBig("تعذّر تثبيت هوية الموظف — أعد تسجيل الدخول قبل قبض نقد دون اتصال");
      return false;
    }
    // مراجعة عدائية (٥/٨) — **حاصرة**: طلبٌ محفوظ (مسوّدة) لا يُلتقَط أوفلاينياً أبداً.
    // التثبيت يلتزم خادمياً بمفتاح المسوّدة (commitRequestId) بينما الالتقاط كان سيرحّل
    // بمفتاح الواجهة (reqIdRef) المختلف ⇒ uq_invoice_source عاجزٌ عن صدّ فاتورةٍ ثانية
    // إذا كان الالتزام وصل قبل انقطاع الردّ. المسوّدة الخادمية **هي** الأثر الناجي.
    if (activeDraftRef.current) {
      notify.errBig(
        "طلبك محفوظٌ على الخادم — لا يُلتقَط دون اتصال",
        "عند عودة الاتصال افتح الطلب من «طلبات محفوظة» واضغط التثبيت — لن يتكرّر ولن يضيع.",
      );
      return false;
    }
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
        "البيع دون اتصال مُعطَّل على هذا الجهاز",
        "عُطِّل يدوياً من «إعدادات الجهاز» في شارة المزامنة أسفل الشاشة — الافتراضي مفعَّل، فأعِد تفعيله ليقبل النقد أثناء الانقطاع.",
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
    // مراجعة PR #495: بعد أن صار الإسناد **داخل** معاملة التثبيت، التقاطٌ أوفلاينيّ لطلبٍ مُسنَدٍ
    // لمندوب كان سيُرحّل فاتورةً بلا إرسالية — إسنادٌ يسقط صامتاً (والحارس القديم يمسك أجرة
    // COUNTER وحدها). الرفض صريحٌ الآن: الترقيم والعهدة والأقفال كلّها خادميّة.
    if (orderDelivery) {
      notify.errBig(
        "إسناد التوصيل يحتاج اتصالاً",
        "ترقيم الإرسالية وعهدة المندوب يُكتبان مع الفاتورة في معاملةٍ واحدة على الخادم — أزل التوصيل لإتمام البيع نقداً الآن، أو انتظر عودة الاتصال.",
      );
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
        // ٢٣/٨ — الصافي = الأسطر الخام − خصمُ رأس الفاتورة الملتقَط. الخادم يعيد الحساب بنفس المدخلات
        // عند الترحيل (replayOfflineReception → checkoutReception → createSaleInTx) فينتج نفس الرقم.
        amount: round2(regularLines.reduce((sum, c) => sum.plus(D(lineTotal(c))), D(0)).minus(invoiceDiscountAmountD)).toFixed(2),
        ...(invoiceDiscountAmountD.gt(0) ? { invoiceDiscount: invoiceDiscountAmountD.toFixed(2) } : {}),
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
      capturedByUserId: Number(capturedByUserId),
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
      // ٢٣/٨ — Codex P1: subtotal يعرض الخام (`sumDirect + sumCustom`) وdiscount يعلن الخصم
      // صراحةً على الإيصال المؤقّت — لولا هذا يظهر إجماليٌّ أقلّ من مجموع الأسطر بلا سبب.
      subtotal: round2(sumDirectD.plus(sumCustomD)).toFixed(2),
      discount: invoiceDiscountAmountD.gt(0) ? invoiceDiscountAmountD.toFixed(2) : null,
      total: round2(grandTotalD).toFixed(2),
      paid: round2(paidNowD).toFixed(2),
      change: paidNowD.gt(grandTotalD) ? round2(paidNowD.minus(grandTotalD)).toFixed(2) : null,
      paymentMethod: PAY_METHOD_LABEL.CASH,
    }).then((printed) => {
      if (!printed.ok) notify.err("تعذّرت طباعة الإيصال المؤقت", "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة");
    }).catch(() => { /* فشل الطابعة لا يُلغي التقاطاً التزم محلياً */ });

    notify.ok(
      `بيع دون اتصال — إيصال مؤقّت ${receiptNumber}`,
      "الرقم الرسميّ يصدر تلقائياً عند عودة الاتصال (شارة المزامنة أسفل الشاشة)",
    );
    setCart([]);
    setSelKey(null);
    setPayInput("");
    setPaymentReference("");
    // ٢٣/٨ — Codex P1: تفريغ الخصم بعد الالتقاط الأوفلايني كي لا يتسرّب لعميل التالي.
    setInvoiceDiscountPct("");
    setCustomer({ customerId: null, name: "", phone: null, isNew: false });
    setReceptionPhone("");
    setChannel("WALK_IN");
    setLinkedConversationId(null);
    setChannelHandle("");
    reqIdRef.current = crypto.randomUUID();
    return true;
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
      void (async () => {
        let failures = 0;
        for (const r of lastSale.receipts) {
          try {
            const printed = await printReceipt(r);
            if (!printed.ok) failures += 1;
          } catch { failures += 1; }
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
      if (showReceiptOverlay) {
        if (e.key === "Escape") { e.preventDefault(); setShowReceiptOverlay(false); }
        if (e.key === "F9") { e.preventDefault(); reprintLastRef.current?.(); }
        return;
      }
      if (cashDropping || approvalAsk) {
        if (e.key === "Escape") { e.preventDefault(); setCashDropping(false); setApprovalAsk(null); }
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
  }, [showInbox, showDrop, showCustomization, showReceiptOverlay, cashDropping, approvalAsk, depositMenuOpen, discountFor]);

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
            <h2 className="text-xl font-extrabold">ابدأ الوردية</h2>
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
            {openShiftM.isPending ? "جارٍ البدء…" : needsBranchChoice ? "اختر الفرع أولاً" : "بدء الوردية"}
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
      {/* ١٩/٨: طبقةُ الحجوزات زالت — لها **شاشتُها** `/reservations` (طلب المالك: لكل مفهومٍ
          شاشةٌ واحدة). وهذه الشاشة صارت ما اسمُها: سلّةُ بيعٍ ودفع. */}
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
            <h3 className="mb-1 text-lg font-extrabold">إنهاء الوردية وعدّ النقدية</h3>
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
                    // إفصاح (مراجعة ٥/٨): فواتير تسليم الطلبات ضمن الإجمالي أعلاه، لكن عرابينها
                    // قُبضت في ورديات سابقة — السطر يمنع قراءة «مبيعاتي ≠ درجي» كعجز.
                    ...(Number(reportQ.data?.woInvoicesCount ?? 0) > 0
                      ? [[
                          `منها فواتير تسليم طلبات (${reportQ.data?.woInvoicesCount})`,
                          `${fmt(Number(reportQ.data?.woInvoicesTotal ?? 0))} د.ع`,
                        ] as [string, string]]
                      : []),
                    // ش٤ (I14): عرابين قُبضت على هذه الوردية لطلباتٍ لم تُثبَّت بعد — نقدٌ في الدرج
                    // بلا فاتورة؛ السطر يمنع قراءته «فائضاً مجهولاً» ولا يمنع الإغلاق.
                    ...(Number(reportQ.data?.heldDepositsCount ?? 0) > 0
                      ? [[
                          `عرابين طلبات لم تُثبَّت (${reportQ.data?.heldDepositsCount})`,
                          `${fmt(Number(reportQ.data?.heldDepositsTotal ?? 0))} د.ع`,
                        ] as [string, string]]
                      : []),
                    // توصيل (١٠/٨): توريدات المناديب وأجورهم كانت تذوب في «نقدي وارد/صادر» —
                    // السطران يفسّران وارداً متضخماً ليس مبيعات هذا الدرج وصادرَ أجورٍ ليس مصروفاً عاماً.
                    ...(Number(reportQ.data?.deliveryInCount ?? 0) > 0
                      ? [[
                          `منها توريدات مناديب (${reportQ.data?.deliveryInCount})`,
                          `${fmt(Number(reportQ.data?.deliveryInTotal ?? 0))} د.ع`,
                        ] as [string, string]]
                      : []),
                    ...(Number(reportQ.data?.deliveryOutCount ?? 0) > 0
                      ? [[
                          `مدفوعات توصيل صادرة (${reportQ.data?.deliveryOutCount})`,
                          `${fmt(Number(reportQ.data?.deliveryOutTotal ?? 0))} د.ع`,
                        ] as [string, string]]
                      : []),
                    ["المبلغ عند بدء الوردية", `${fmt(Number(shift.openingBalance ?? 0))} د.ع`],
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
                      recDiff < 0 ? "text-destructive" : "text-[var(--sem-pos)]",
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
                      لا يمكن إنهاء الوردية لأن المبلغ المعدود لا يطابق المبلغ المسجّل في النظام.
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
        {/* إصلاح (٧/٨): شريط التسلسل العلوي (١-٤ بأسماء مختلفة) حُذف — كان يكرّر حرفياً نفس
            ترقيم «١. العميل…» و«٢. أضف…» أدناه بتسميةٍ ثانية، بلا وظيفةٍ فريدة (الانتقال يبقى
            متاحاً بالنقر على المناطق نفسها وبـF2/F4). إزالته توفّر مساحة رأسية دائماً، لا عند
            ضيق الارتفاع فقط. */}
        <div
          ref={customerSectionRef}
          className="grid gap-2 rounded-xl border border-border/80 bg-muted/20 p-2 xl:grid-cols-[minmax(280px,0.9fr)_minmax(390px,1.15fr)_minmax(300px,0.95fr)]"
        >
          {/* ١ — قناة الوصول: قرار سريع واضح، مع إبقاء هوية العميل عند تبديل القناة. */}
          <section className="rounded-lg border bg-card p-2" aria-labelledby="reception-channel-title">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-black text-primary-foreground">١</span>
              <h2 id="reception-channel-title" className="text-xs font-black">قناة وصول الطلب</h2>
              {/* ١٩/٨ — مدخلُ المحادثة **سياقيّ** لا زرٌّ في الرأس: الوارد هنا **أداةُ سلّة**
                  تملأ رأس الطلب (ش١)، لا وجهةً يُغادَر إليها — ووجهتُه شاشةُ `/crm?tab=inbox`.
                  ووضعُه بجوار القناة هو موضعُه المنطقيّ: منه تُعرَف القناة ومعرّفُها. */}
              {canReadChannels && (
                <button
                  type="button"
                  onClick={() => setShowInbox(true)}
                  className="ms-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-extrabold text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="افتح طلباً من رسالة زبون"
                >
                  <MessageCircle aria-hidden className="size-3" /> من محادثة
                </button>
              )}
            </div>
            <div className="grid grid-cols-5 gap-1">
              {receptionChannelOptions(WORK_ORDER_CHANNELS).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={channel === value}
                  onClick={() => {
                    setChannel(value);
                    if (value !== "INSTAGRAM" && value !== "TIKTOK") setChannelHandle("");
                  }}
                  className={cn(
                    "flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border text-[9px] font-extrabold transition-colors",
                    channel === value
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  <ChannelMark channel={value} />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
            {(channel === "INSTAGRAM" || channel === "TIKTOK") && (
              <Input
                value={channelHandle}
                onChange={(event) => setChannelHandle(event.target.value)}
                placeholder="معرّف الحساب (اختياري)"
                aria-label="معرّف حساب القناة"
                className="mt-1.5 h-7 text-[11px]"
                dir="ltr"
              />
            )}
          </section>

          {/* ٢ — الهاتف هو مفتاح الهوية في كل القنوات، لا حقل تابع لواتساب وحده. */}
          <section className="rounded-lg border bg-card p-2" aria-labelledby="reception-phone-title">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-black text-primary-foreground">٢</span>
                <h2 id="reception-phone-title" className="text-xs font-black">رقم هاتف العميل</h2>
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[9px] font-black text-destructive">إلزامي</span>
              </div>
              {phoneResolution === "CHECKING" && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-muted-foreground">
                  <LoaderCircle aria-hidden className="size-3 animate-spin" /> جارٍ التحقق
                </span>
              )}
            </div>
            <PhoneDigitsInput
              value={receptionPhone}
              onChange={setReceptionPhone}
              ariaLabel="رقم هاتف العميل العراقي"
              className="max-w-full"
            />
            <div className="mt-1.5 min-h-4 text-[10px] font-semibold">
              {phoneResolution === "EMPTY" && <span className="text-muted-foreground">اكتب ١١ رقماً؛ سنبحث عن العميل تلقائياً.</span>}
              {phoneResolution === "INCOMPLETE" && <span className="text-[var(--sem-warn)]">أكمل الرقم العراقي الذي يبدأ بـ07.</span>}
              {phoneResolution === "NEEDS_NAME" && <span className="text-[var(--sem-info)]">الرقم جديد — بقي اسم العميل فقط.</span>}
              {phoneResolution === "RESOLVED" && <span className="text-money-positive">تم العثور على العميل وربطه بالطلب.</span>}
              {phoneResolution === "ERROR" && <span className="text-destructive">{phoneResolutionError}</span>}
            </div>
          </section>

          {/* ٣ — نتيجة واحدة: بطاقة عميل مرتبطة أو حقل الاسم للرقم الجديد. لا قوائم عائمة فوق البحث. */}
          <section className="rounded-lg border bg-card p-2" aria-labelledby="reception-customer-title">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-black text-primary-foreground">٣</span>
                <h2 id="reception-customer-title" className="text-xs font-black">هوية العميل</h2>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-semibold text-muted-foreground">فئة السعر</span>
                <AppSelect
                  value={effectiveTier}
                  onValueChange={(value) => { setTierOverride(value as Tier); clearCouponIfApplied(); }}
                  aria-label="فئة السعر"
                  className="h-7 w-20 text-[10px] font-bold"
                >
                  <option value="RETAIL">مفرد</option>
                  <option value="WHOLESALE">جملة</option>
                  <option value="GOVERNMENT">حكومي</option>
                </AppSelect>
              </div>
            </div>

            {customer.customerId ? (
              <div className="flex min-h-12 items-center gap-2 rounded-md border border-money-positive/40 bg-money-positive/10 px-2.5 py-1.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-money-positive/15 text-money-positive">
                  <UserRound aria-hidden className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-black">{customer.name}</span>
                    <BadgeCheck aria-label="عميل موثوق" className="size-3.5 shrink-0 text-money-positive" />
                  </div>
                  <div className="text-[10px] font-semibold text-muted-foreground" dir="ltr">{receptionPhone}</div>
                  <div className={cn("text-[9px] font-bold", customerDeferredEligible ? "text-money-positive" : "text-[var(--sem-warn)]")}>
                    {customerDeferredEligible ? "مرتبط · البيع بدون عربون متاح" : "مرتبط · نقديٌّ فقط (حدّ ائتمانه صفر)"}
                  </div>
                </div>
                {canReadCustomerContext && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => setCustomerContextId(customer.customerId)}>
                    الملف
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex min-h-12 items-center gap-1.5">
                <Input
                  value={customer.name}
                  onChange={(event) => setCustomer((previous) => ({ ...previous, name: event.target.value, phone: receptionPhone, isNew: true }))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && customer.name.trim().length >= 2 && phoneResolution === "NEEDS_NAME") {
                      event.preventDefault();
                      void resolveReceptionCustomer(customer.name, true);
                    }
                  }}
                  disabled={!isValidIqMobile(receptionPhone) || phoneResolution === "CHECKING"}
                  placeholder={isValidIqMobile(receptionPhone) ? "اسم العميل الجديد" : "أكمل الهاتف أولاً"}
                  aria-label="اسم العميل"
                  className="h-9 min-w-0 flex-1 text-xs font-bold"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={phoneResolution !== "NEEDS_NAME" || customer.name.trim().length < 2 || resolveReceptionCustomerM.isPending || !canCreateCustomer}
                  onClick={() => void resolveReceptionCustomer(customer.name, true)}
                  className="h-9 shrink-0 px-3 text-[11px] font-black"
                >
                  حفظ وربط
                </Button>
              </div>
            )}
            {!canCreateCustomer && (
              <p className="mt-1 text-[10px] font-bold text-destructive">صلاحية ربط عميل الاستقبال غير مفعّلة لهذا الدور.</p>
            )}
          </section>
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-xs font-extrabold">٢. أضف ما يريده العميل</span>
        <div className="relative w-full flex-1 sm:max-w-[640px] sm:min-w-72">
          <Search aria-hidden className="pointer-events-none absolute inset-y-0 end-3 my-auto size-4 text-muted-foreground" />
          <input
            ref={searchRef}
            autoFocus
            id="reception-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 160)}
            onKeyDown={(e) => {
              // مطابقة الماسح بتوقيت الحرف + تطبيع اللوحة العربية أولاً (PR #501، لا تعتمد استقرار البحث).
              barcodeInput.handleKeyDown(e, setSearch);
              if (e.defaultPrevented) return;
              // ش٠: searchSettled يمنع إضافة نتيجةٍ من استعلامٍ أقدم أثناء الكتابة/المسح السريع.
              if (e.key === "Enter" && searchSettled && results[0]) {
                e.preventDefault();
                addRow(results[0]);
              }
            }}
            placeholder="امسح الباركود أو ابحث بالاسم / SKU…  (F2)"
            className={cn("h-11 w-full rounded-xl border-[1.5px] px-4 pl-11 text-sm font-semibold outline-none focus:border-primary", barcodeSearchInputClass)}
          />
          <BarcodeSearchCue />
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
                      r.isCustomizable ? "bg-violet-100 text-violet-700" : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
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
                          r.isCustomizable ? "bg-violet-100 text-violet-700" : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
                        )}
                      >
                        {r.isCustomizable ? "تخصيص" : "جاهز"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground" dir="ltr">
                      <span className="text-right">{r.sku} · {r.unitName}</span>
                      {!r.isService && (
                        <span className="ms-2">
                          · فعلي: {r.stockBase ?? 0} · محجوز: {r.reservedBase ?? 0} · متاح: {r.availableBase ?? r.stockBase ?? 0}
                        </span>
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

        {/* ش٦ — توصيل هذا الطلب: طلبٌ هاتفيّ بخطوة واحدة (سلة + توصيل + تثبيت ⇒ إسناد تلقائيّ). */}
        <button
          type="button"
          onClick={() => setDeliveryDialogOpen(true)}
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border-2 px-4 text-xs font-extrabold transition-colors",
            orderDelivery
              ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
              : "hover:bg-muted/60",
          )}
        >
          <Truck aria-hidden className="size-4" />
          {orderDelivery ? `توصيل: ${orderDelivery.partyName}` : "توصيل هذا الطلب"}
        </button>

        </div>

        {/* إصلاح (٧/٨، طلب مالك): كل أزرار محطة الاستقبال العابرة للورش (فواتير/طلبات/طلبات
            الموقع/حجوزات/رسائل/سحب نقدي/طابعة/آخر فاتورة/حالة الوردية) تُرسَل بـportal إلى
            الشريط العلوي المشترك — بجانب موضع زرّ «الفواتير» الأصلي — بدل تكديسها هنا. تُبقي كل
            الحالة والمنطق داخل هذا المكوّن (شرط الـportal: نفس شجرة React، موضعٌ مختلف في DOM). */}
        {/* ١٩/٨ (طلب المالك): **اللوحاتُ الخمس خرجت من هنا** — «الفواتير» و«الطلبات» و«طلبات
            الموقع» و«الحجوزات» و«رسائل وطلبات العملاء» صارت بطاقاتٍ في الصفحة الرئيسية
            (`CashierHome`) تفتح المحطّة على لوحتها عبر `?workspace=`.

            السبب مقيس: كان الرأس صفّاً واحداً من ثمانية أزرارٍ **متساوية الوزن** يفيض أفقياً
            بشريط تمرير، فيختلط فيه ما يُفتَح مرّةً في اليوم (الحجوزات) بما يُضغَط كل دقيقة
            (إنهاء الوردية). وثلاثةٌ من أسمائها كانت تصطدم بأسماء أخرى في نفس الشاشة
            («الطلبات» مقابل «متابعة الطلبات» مقابل «تصفّح الطلبات»).

            ما بقي هنا **أدواتُ الوردية وحدها**: الطابعة · آخر فاتورة · سحب نقديّ · إنهاء
            الوردية — أي ما يخصّ الجلسة لا ما يخصّ المستندات. */}
        {headerActionsNode && createPortal(
          <>

            {bridge.enabled && (
              <button
                type="button"
                onClick={() => void testServerPrint()}
                title={`جسر طباعة صامت: ${bridge.description} — اضغط لطباعة تذكرة اختبار`}
                aria-label="جسر طباعة على الخادم — تذكرة اختبار"
                className="inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border border-[var(--sem-pos)] bg-card px-2.5 text-[var(--sem-pos)] hover:bg-[var(--sem-pos-bg)]"
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
                  "inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border bg-card px-2.5 hover:bg-muted/60",
                  printerReady ? "border-[var(--sem-pos)] text-[var(--sem-pos)]" : "border-border text-muted-foreground",
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
                className="inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border bg-card px-2.5 text-xs font-bold text-muted-foreground hover:bg-muted/60"
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
              className="inline-flex h-[var(--ui-control)] items-center gap-1 rounded-lg border bg-muted/40 px-2.5 text-sm font-bold hover:bg-muted"
            >
              <HandCoins aria-hidden className="size-4" />
              <span className="hidden lg:inline">سحب نقدي</span>
            </button>
            {/* G1 (طلب المالك): شارة «الوردية #{id}» حُذفت — كانت مكرِّرةً لزرّ «إنهاء الوردية»
                المجاور (وجوده يعني وردية مفتوحة). رقم الوردية يبقى مرئياً في نافذة الإغلاق
                (عنوان الحوار وZ-report) وعلى الإيصال المطبوع الجديد (G3 أدناه — حقل `shiftId`). */}
            <Button size="sm" variant="outline" onClick={() => setClosing(true)} title={`إنهاء وردية الاستقبال #${shift.id}`}>
              إنهاء الوردية
            </Button>
          </>,
          headerActionsNode,
        )}

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

      {/* ─── الجسم: عمود السلة يملأ العرض؛ لوحة الدفع شريطٌ مستقلّ أسفله (خارج الحشوة، حافّة-لحافّة) ─── */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 pb-0">
        {/* ─ عمود العمل: تبويبات الورش تركب رأس السلة (§٨.١ — صفر تكلفة عمودية) ─ */}
        <div ref={cartSectionRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card outline-none focus:ring-2 focus:ring-primary/30">
          {/* إصلاح (٧/٨، طلب مالك): تبويبات الورش («الفواتير»/«الطلبات»/«طلبات الموقع») حُذفت من
              هنا — نقاط الدخول إليها صارت في الشريط العلوي المشترك (بجانب زرّ «الفواتير» الأصلي،
              انظر portal أدناه) بدل التكرار. هذا الصفّ الآن مؤشّر «أين أنا» فقط: اسم السلّة
              وأدواتها حين workshop=CART، أو زرّ رجوعٍ موحَّد لأي ورشةٍ أخرى. */}
          {/* ١٩/٨ (طلب المالك: «لكل بطاقة شاشة خاصّة بها») — **الورش الثلاث حُذفت من هنا**.
              كانت «الفواتير» و«الطلبات» و«طلبات الموقع» تُركَّب داخل عمود السلّة، فيصير للمفهوم
              الواحد مكانان: لوحةٌ هنا وصفحةٌ في الشريط الجانبيّ. صار لكلٍّ **شاشتُه**:
              `/reception/invoices` · `/reception/orders` · `/store-admin?tab=orders`.
              وهذه الشاشة صارت ما اسمُها: **سلّة بيع**. */}
          <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b bg-muted/40 px-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold">
              <ShoppingCart aria-hidden className="size-4" />
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
            {/* مخارجُ الموظّف من شاشة عمله (المحطّة بلا شريطٍ جانبيّ). */}
            <div className="ms-auto flex items-center gap-1.5">
              <a
                href="/reception/orders"
                className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-extrabold hover:bg-muted"
                title="طابور التسليم والإسناد"
              >
                <ClipboardList aria-hidden className="size-3.5" /> طلبات محطّتي
              </a>
              <a
                href="/reception/invoices"
                className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-extrabold hover:bg-muted"
                title="ما عليه مبلغٌ متبقٍّ"
              >
                <ReceiptIcon aria-hidden className="size-3.5" /> فواتير للتحصيل
              </a>
            </div>
          </div>

            <CartTable
              branchId={branchId}
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
              addTick={addTick}
            />
        </div>
      </div>

      {/* ─ لوحة الدفع — شريطٌ ثابتٌ حافّة-لحافّة أسفل الصفحة (خارج حشوة عمود السلة) ─
          آخر عنصرٍ في عمود الصفحة الجذر (flex-col)؛ منطقة السلة أعلاه وحدها flex-1/تُمرَّر،
          فزرّا الدفع لا يُدفَعان خارج الشاشة أبداً مهما ضاق الارتفاع أو تغيّر تكبير المتصفّح. */}
      <PaymentPanel
        payInput={payInput}
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
        needPaymentRef={needPaymentRef}
        grandTotal={grandTotal}
        expectedNow={expectedNow}
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
        payAll={payAll}
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

      {/* شارة المزامنة — تُركَّب في كلّ شاشات الكاشير: تعرض حالة الاتصال وطابور الالتقاط،
          وتُفرّغ **كلّ** الأنواع (تجزئة/طباعة/استقبال) لا نوع هذه الشاشة وحده. */}
      <OfflineSyncChip userRole={me.data?.role} />

      {/* ─── ش٤: حوار قبض العربون (على الطلب المحفوظ النشط) ─── */}
      {depositOpen && activeDraft && (
        <DepositDialog
          draftId={activeDraft.id}
          draftNumber={draftInfo?.draftNumber ?? `طلب #${activeDraft.id}`}
          contactName={customer.name?.trim() || null}
          orderTotal={round2(grandTotalD).toFixed(2)}
          heldTotal={draftHeld}
          suggestedAmount={paidD.gt(0) ? round2(paidD).toFixed(2) : round2(sumCustomD.times(0.25)).toFixed(0)}
          currentShiftId={shift?.id ?? null}
          branchName={branchName}
          cashierName={me.data?.name ?? null}
          onClose={() => setDepositOpen(false)}
          onCollected={(total) => {
            setDraftHeld(total);
            setPayInput("");
            void utils.reception.draftList.invalidate();
          }}
        />
      )}

      {/* ─── ش٤: سجلّ عرابين الطلب النشط + الردّ ─── */}
      {paymentsOpen && activeDraft && (
        <DraftPaymentsDialog
          draftId={activeDraft.id}
          draftNumber={draftInfo?.draftNumber ?? `طلب #${activeDraft.id}`}
          branchId={branchId}
          onClose={() => setPaymentsOpen(false)}
          onChanged={(heldNet) => {
            setDraftHeld(heldNet);
            void utils.reception.draftList.invalidate();
          }}
        />
      )}

      {/* ─── ش٦: كتلة توصيل الطلب (إسنادٌ تلقائيّ بعد التثبيت) ─── */}
      {deliveryDialogOpen && (
        <OrderDeliveryDialog
          parties={(partiesQ.data ?? []) as DispatchParty[]}
          initial={orderDelivery}
          defaultRecipientName={customer.name || null}
          defaultRecipientPhone={customer.phone || null}
          onSave={setOrderDelivery}
          onClear={() => setOrderDelivery(null)}
          onClose={() => setDeliveryDialogOpen(false)}
        />
      )}

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
          <Inbox onStartOrder={startOrderFromConversation} />
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
