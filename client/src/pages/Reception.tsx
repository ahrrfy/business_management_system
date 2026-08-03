import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import {
  ArrowLeftRight,
  ArrowRight,
  Banknote,
  CalendarClock,
  Camera,
  Check,
  ClipboardList,
  CreditCard,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers,
  MessageCircle,
  Minus,
  Music,
  Package,
  Palette,
  Pencil,
  Phone,
  Plus,
  Printer,
  Ruler,
  Search,
  ShoppingCart,
  Store,
  Trash2,
  Truck,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { CustomizationDialog, type CustomizationData, composeCustomizationText, emptyCustomization } from "@/components/CustomizationDialog";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { parseScan } from "@/lib/scanRouter";
import { fmtDate } from "@/lib/date";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Contact360Panel } from "@/components/contacts/Contact360Panel";
import ReservationsHub from "@/pages/ReservationsHub";
import Inbox from "@/pages/Inbox";
import OrderFulfillment from "@/pages/OrderFulfillment";
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

type PosRow = NonNullable<RouterOutputs["catalog"]["posList"]>[number];
type NumMode = "QTY" | "DISC" | "PAY";
type PayMethod = "CASH" | "CARD" | "TRANSFER";
const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  CASH: "نقدي",
  CARD: "بطاقة",
  TRANSFER: "تحويل",
};
const RESERVATION_READ_ROLES = ["admin", "manager", "accountant", "cashier", "warehouse", "sales_rep", "auditor"] as const;
const CHANNEL_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor", "warehouse", "print_operator"] as const;
const STORE_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;
const CRM_READ_ROLES = ["admin", "manager", "cashier", "sales_rep", "accountant", "auditor"] as const;

type CartLine = {
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
const QUICK_AMTS = [1000, 5000, 10000, 25000];

function effectivePrice(line: CartLine): number {
  // التخصيص إضافيّ: سعر الوحدة للسطر المخصّص = سعر المنتج الأساس + سعر التخصيص (فوقه)، لا بديلاً عنه.
  const base = line.origPrice ?? (
    line.custom
      ? Number(line.row.price ?? 0) + Number(line.custom.unitPrice ?? 0)
      : Number(line.row.price ?? 0)
  );
  if (line.disc && line.disc > 0) return base * (1 - line.disc / 100);
  return base;
}
function lineTotal(line: CartLine): number {
  return effectivePrice(line) * line.qty;
}
function isCustomKind(line: CartLine): boolean {
  return !!line.custom;
}
/** الإجمالي الكامل لسطر مخصّص (سعر السطر + تكلفة التوصيل). يُستعمل لـsalePrice على workOrder
 *  ليطابق إجمالي الفاتورة عند التسليم (deliverWorkOrder يَحسبه من wo.salePrice وحده). */
function customLineGrand(line: CartLine): number {
  if (!line.custom) return lineTotal(line);
  const delivery = line.custom.hasDelivery ? Number(line.custom.deliveryCost || 0) : 0;
  return lineTotal(line) + delivery;
}

/** حالة المخزون للأصناف الجاهزة (المخصَّصة لا مَخزون لها — إنتاج). يَحسب الطلب الكلّي للصنف
 *  عبر كل وحداته في السلّة (رصيد الفرع مُشترك بين القطعة/الدرزن/الكرتون). نَمط مُطابق POS.tsx. */
function buildStockState(cart: CartLine[]) {
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
  const utils = trpc.useUtils();

  // وردية خدمة العملاء (RECEPTION): درج/رصيد افتتاحي/عرابين مستقلّة عن كاشير التجزئة (RETAIL).
  const branchesQ = trpc.branches.list.useQuery();
  const staffQ = trpc.workOrders.assignableStaff.useQuery({ branchId });
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RECEPTION" });
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

  // ───── الحالة ─────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [numMode, setNumMode] = useState<NumMode>("PAY");
  const [payInput, setPayInput] = useState("");
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [paymentReference, setPaymentReference] = useState(""); // P2 fix: مرجع البطاقة للعرابين
  const [showInbox, setShowInbox] = useState(false);
  const [showStoreOrders, setShowStoreOrders] = useState(false);
  const [customerContextId, setCustomerContextId] = useState<number | null>(null);
  const [showCustomization, setShowCustomization] = useState<{ row: PosRow; editingKey?: string } | null>(null);
  const [customer, setCustomer] = useState<SmartCustomerValue>({ customerId: null, name: "", phone: null, isNew: false });
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
  const paymentSectionRef = useRef<HTMLDivElement>(null);

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

  // الدفع موحّد على كامل السلة. البيع المباشر هو الحد الأدنى؛ وما زاد يصبح عربوناً لأوامر الطباعة.
  const expectedNowD = grandTotalD;
  const expectedNow = round2(expectedNowD).toNumber();

  // ما أدخله الكاشير في لوحة الأرقام (مع تكيّف Quick Pay).
  const paidD = D(payInput || 0);
  const paid = round2(paidD).toNumber();
  const changeD = paidD.minus(expectedNowD);
  const change = round2(changeD).toNumber();
  const remainingD = grandTotalD.minus(paidD);
  const remaining = round2(remainingD).toNumber();
  const isChange = method === "CASH" && paidD.gt(0) && paidD.gte(expectedNowD);
  const isOwing = paidD.gt(0) && paidD.lt(expectedNowD);

  const hasCustom = cart.some(isCustomKind);
  const needPaymentRef = method !== "CASH" && paidD.gt(0);

  // ───── البحث ──────────────────────────────────────────────────────────────
  const debounced = useDebouncedValue(search, 180);
  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: debounced, limit: 15, includeReceptionServices: true },
    { enabled: debounced.trim().length >= 2, placeholderData: keepPreviousData, staleTime: 15_000 },
  );
  const results = searchResults.data ?? [];
  const resultsEmpty = results.length === 0 && debounced.trim().length >= 2 && !searchResults.isFetching;

  // ───── السلّة ─────────────────────────────────────────────────────────────
  /** يضيف صنفاً جاهزاً (بلا تخصيص) بسعره العادي — يدمج مع سطرٍ مطابق غير مخصّص إن وُجد. */
  const addDirectLine = useCallback((row: PosRow) => {
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
    // إصلاح P2 (٢٣/٦/٢٦): حارس السعر **قبل** فتح نافذة التخصيص — كان يَسمح لمخصَّصٍ بلا سعر RETAIL
    // بالدخول للسلّة ثم يَفشل عند الإرسال (createWorkOrder يَرفض salePrice<=0) بَعد ما اَلتزَمت
    // فاتورة البيع — رحلةٌ بِنصف نتيجة. الحارس موحَّد للنوعين.
    if (row.price == null || Number(row.price) <= 0) {
      notify.err(`لا سعر RETAIL لـ ${row.productName} (${row.unitName}) — حدّد سعراً من /products أوّلاً`);
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
    setCart((prev) =>
      prev.map((c) => (c.key === key ? { ...c, qty: Math.max(1, c.qty + delta) } : c)),
    );
  }
  function removeRow(key: string) {
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
    setCart([]);
    setSelKey(null);
    setPayInput("");
  }

  // ───── الباركود ───────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(
    async (code: string) => {
      try {
        const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: "RETAIL" });
        if (!row) notify.err(`باركود غير معروف: ${code}`);
        else addRow(row);
      } catch (e: unknown) {
        notify.err(e, "خطأ في المسح");
      }
    },
    [branchId, addRow, utils],
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

  // ───── لوحة الأرقام ──────────────────────────────────────────────────────
  function numPress(k: string) {
    if (numMode === "QTY" && selKey) {
      const line = cart.find((c) => c.key === selKey);
      if (!line) return;
      setCart((prev) =>
        prev.map((c) => {
          if (c.key !== selKey) return c;
          let s = String(c.qty);
          if (k === "DEL") s = s.length > 1 ? s.slice(0, -1) : "1";
          else if (k === "C") s = "1";
          else s = s === "0" ? k : s + k;
          return { ...c, qty: Math.max(1, parseInt(s, 10) || 1) };
        }),
      );
    } else if (numMode === "DISC" && selKey) {
      const line = cart.find((c) => c.key === selKey);
      if (!line || isCustomKind(line)) return;
      setCart((prev) =>
        prev.map((c) => {
          if (c.key !== selKey) return c;
          const base = c.origPrice ?? Number(c.row.price ?? 0);
          let s = c.disc != null ? String(c.disc) : "";
          if (k === "DEL") s = s.slice(0, -1);
          else if (k === "C") s = "";
          else if (k === "." && s.includes(".")) return c;
          else s = s + k;
          const disc = Math.min(100, Math.max(0, parseFloat(s) || 0));
          return { ...c, origPrice: base, disc };
        }),
      );
    } else {
      setPayInput((prev) => {
        if (k === "DEL") return prev.slice(0, -1);
        if (k === "C") return "";
        if (k === "." && prev.includes(".")) return prev;
        return prev + k;
      });
    }
  }
  function setQuickAmt(v: number) {
    setNumMode("PAY");
    setPayInput(String(v));
  }
  function payAll() {
    setNumMode("PAY");
    setPayInput(String(grandTotal));
  }

  function goToWorkflowStep(step: number) {
    setWorkflowStep(step);
    requestAnimationFrame(() => {
      if (step === 1) customerSectionRef.current?.querySelector("input")?.focus();
      if (step === 2) searchRef.current?.focus();
      if (step === 3) cartSectionRef.current?.focus();
      if (step === 4) {
        setNumMode("PAY");
        paymentSectionRef.current?.focus();
      }
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

  // نقطة التزام خادمية واحدة للسلة الهجينة: بيع + طباعة + أوامر شغل.
  const checkoutM = trpc.workOrders.receptionCheckout.useMutation();

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

    const inputPaidD = opts.quickFullPay ? grandTotalD : paidD;
    const appliedPaidD = method === "CASH" && inputPaidD.gt(grandTotalD) ? grandTotalD : inputPaidD;

    // البطاقة والتحويل صالحان أيضاً كعربون، لكن بلا فكّة وبمرجع تتبّع إلزامي.
    if (method !== "CASH" && inputPaidD.gt(0) && !paymentReference.trim()) {
      notify.err(method === "CARD" ? "رقم عملية البطاقة مطلوب" : "رقم مرجع التحويل مطلوب");
      return;
    }
    if (method !== "CASH" && inputPaidD.gt(grandTotalD)) {
      notify.err(`لا يمكن أن يتجاوز مبلغ ${method === "CARD" ? "البطاقة" : "التحويل"} إجمالي الطلب (${fmt(grandTotalD.toFixed(2))} د.ع)`);
      return;
    }
    if (appliedPaidD.lt(sumDirectD)) {
      notify.err(`المبلغ المقبوض يجب أن يغطي المنتجات الجاهزة أولاً (${fmt(sumDirectD.toFixed(2))} د.ع). وما زاد يُوزّع عربوناً على أعمال الطباعة.`);
      return;
    }

    // تَفعيل قَفل الإرسال **قبل** ensureCustomerId لمنع سباق نَقر مَزدوج يُنشئ عميلاً مكرَّراً
    // (ensureCustomerId يَحتوي عميلية confirm() غير متزامنة).
    if (submitting) return;
    setSubmitting(true);

    let customerId: number | null = null;
    try {
      customerId = await ensureCustomerId();
    } catch (e: any) {
      setSubmitting(false);
      notify.err(e?.message || "تعذّر تجهيز العميل");
      return;
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
      const saleAmount = round2(regularLines.reduce((s, c) => s.plus(D(lineTotal(c))), D(0))).toFixed(2);
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
          // deliveryCost يَبقى في عمود مستقلّ للتقرير؛ salePrice الإجماليّ ضمّه فعلاً.
          deliveryCost: custom.hasDelivery ? D(custom.deliveryCost || 0).toFixed(2) : "0",
          designImages: custom.designImages.map((img, idx) => ({
            url: img.dataUrl,
            caption: img.name ?? null,
            sortOrder: idx,
          })),
        };
      });

      const result = await checkoutM.mutateAsync({
        branchId,
        shiftId: shift.id,
        customerId: customerId ?? undefined,
        paymentMethod: method,
        paymentReference: method === "CASH" ? undefined : paymentReference.trim(),
        paidAmount: round2(appliedPaidD).toFixed(2),
        clientRequestId: reqIdRef.current,
        regularSale: regularLines.length > 0 ? {
          amount: saleAmount,
          lines: regularLines.map((c) => ({
            variantId: c.row.variantId,
            productUnitId: c.row.productUnitId,
            quantity: String(c.qty),
            ...(c.disc != null && c.disc > 0 ? { discountPercent: String(c.disc) } : {}),
          })),
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

      if (result.regularSale) {
        receiptsToPrint.push({
          receiptNumber: result.regularSale.invoiceNumber,
          date: fmtDate(printedAt), time: printedAt.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" }),
          cashierName: me.data?.name ?? "موظف الخدمة", customerName,
          items: regularLines.map((c) => ({
            name: `${c.row.productName} (${c.row.unitName})`, quantity: c.qty,
            price: round2(D(effectivePrice(c))).toFixed(2), total: round2(D(lineTotal(c))).toFixed(2),
          })),
          subtotal: saleAmount, total: saleAmount, paid: saleAmount, change: 0,
          paymentMethod: PAY_METHOD_LABEL[method],
        });
      }
      if (result.printSale) {
        receiptsToPrint.push({
          receiptNumber: result.printSale.invoiceNumber,
          date: fmtDate(printedAt), time: printedAt.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" }),
          cashierName: me.data?.name ?? "موظف الخدمة", customerName,
          items: printLines.map((c) => ({
            name: `${c.row.productName} (${c.row.unitName})`, quantity: c.qty,
            price: round2(D(effectivePrice(c))).toFixed(2), total: round2(D(lineTotal(c))).toFixed(2),
          })),
          subtotal: printAmount, total: printAmount, paid: printAmount, change: 0,
          paymentMethod: PAY_METHOD_LABEL[method],
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
          notes: custom.hasDelivery
            ? `توصيل إلى: ${custom.deliveryAddress || "العنوان غير محدد"}`
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
      // لا توجد حالة التزام جزئي. عند غياب رد الشبكة قد تكون المعاملة كلها التزمت أو كلها
      // تراجعت؛ المفتاح الثابت يجعل إعادة الإرسال تستعيد النتيجة بلا تكرار.
      notify.err(e, checkoutCommitted
        ? "تم حفظ العملية كاملة، لكن تعذّر إكمال تجهيز المستندات؛ راجع الفواتير وأوامر الشغل"
        : "لم يصل تأكيد العملية؛ لا يمكن أن يكون جزء منها محفوظاً وحده. أعد المحاولة بأمان");
    } finally {
      setSubmitting(false);
    }
  }

  // إصلاح P2 (٢٣/٦/٢٦): F4 كان يُمسك إغلاقاً بياناتيّاً قديماً (payInput/method/customer/shift)
  // لأن الاعتماديّات لم تَشملها ⇒ نقرة F4 بعد تعديل المبلغ تَنفّذ بمبلغ قديم. الحل: ref يَحمل
  // أحدث `handleSubmit` ⇒ المُستَمع يَستدعي ref.current دائماً.
  const submitRef = useRef<(opts: { quickFullPay: boolean }) => void>(() => {});
  useEffect(() => {
    submitRef.current = handleSubmit;
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
      if (showStoreOrders) {
        if (e.key === "Escape") { e.preventDefault(); setShowStoreOrders(false); }
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        submitRef.current?.({ quickFullPay: false });
      } else if (e.key === "Escape") {
        if (showInbox) setShowInbox(false);
        else if (showDrop) setShowDrop(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showInbox, showDrop, showCustomization, showReservations, showStoreOrders, closeReservations]);

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
      {showStoreOrders && (
        <div className="absolute inset-0 z-30 overflow-y-auto bg-background p-4">
          <div className="mb-3 flex items-center justify-between rounded-xl border bg-card p-3">
            <div>
              <h1 className="font-extrabold">طلبات الموقع الواردة</h1>
              <p className="text-xs text-muted-foreground">راجع الطلب، ثبّته، جهّزه ثم أرسله للتوصيل.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowStoreOrders(false)}>
              <ArrowRight aria-hidden className="size-4 me-1" /> العودة إلى الطلب
            </Button>
          </div>
          <OrderFulfillment />
        </div>
      )}
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
      <div className="flex-shrink-0 space-y-2 border-b bg-card px-4 py-2.5">
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
          {channel !== "WALK_IN" && channelHandle.trim() && !customer.customerId && (
            <span className="text-[11px] font-semibold text-primary">سيُربط الرقم بعميل قائم أو يُحفظ كعميل عند إتمام الطلب</span>
          )}
          {customer.customerId && (
            <span className="text-[11px] font-semibold text-money-positive">تم ربط الطلب بالعميل: {customer.name}</span>
          )}
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
              if (e.key === "Enter" && results[0]) {
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
            onClick={() => setShowStoreOrders(true)}
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
      </div>

      {/* ─── الجسم: سلّة (يسار) + لوحة الدفع (يمين) ─── */}
      <div className="flex min-h-0 flex-1 flex-row-reverse gap-3 p-3">
        {/* ─ السلّة ─ */}
        <div ref={cartSectionRef} tabIndex={-1} className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card outline-none focus:ring-2 focus:ring-primary/30">
          <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm font-extrabold">
                <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] text-primary-foreground">٣</span>
                <ShoppingCart aria-hidden className="size-4" /> جدول سلة الطلب
              </span>
              {cart.length > 0 && (
                <Badge variant="default" className="text-[11px]">
                  {cart.length} بند · {cartCount} وحدة
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {cart.length > 0 && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void clearCart()}>
                  تفريغ
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {cart.length === 0 ? (
              <div className="grid h-full place-items-center px-4 py-10 text-center text-muted-foreground">
                <div>
                  <ShoppingCart aria-hidden className="mx-auto size-10 opacity-40" />
                  <div className="mt-2 text-sm font-bold">السلة فارغة</div>
                  <div className="mt-1 text-xs">امسح الباركود، ابحث عن منتج، أو أضف خدمة/أمر شغل</div>
                </div>
              </div>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-muted/50 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-2 text-center font-bold">#</th>
                    <th className="px-2 py-2 text-right font-bold">المنتج</th>
                    <th className="w-14 px-1 py-2 text-center font-bold">الوحدة</th>
                    <th className="w-24 px-1 py-2 text-center font-bold">السعر</th>
                    <th className="w-16 px-1 py-2 text-center font-bold">المخزون</th>
                    <th className="w-32 px-1 py-2 text-center font-bold">الكمية</th>
                    <th className="w-24 px-1 py-2 text-center font-bold">الإجمالي</th>
                    <th className="w-8 px-1 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const stockState = buildStockState(cart);
                    return cart.map((l, idx) => {
                    const isCustom = isCustomKind(l);
                    const total = isCustom ? customLineGrand(l) : lineTotal(l);
                    const selected = selKey === l.key;
                    const stock = stockState(l);
                    return (
                      <tr
                        key={l.key}
                        onClick={() => {
                          setSelKey(l.key);
                          if (!isCustom) setNumMode((m) => (m === "PAY" ? "QTY" : m));
                        }}
                        className={cn(
                          "cursor-pointer border-b align-top",
                          isCustom
                            ? "border-s-[3px] border-s-violet-500"
                            : stock.isOut
                              ? "border-s-[3px] border-s-destructive bg-destructive/5"
                              : stock.isShort
                                ? "border-s-[3px] border-s-amber-500 bg-amber-50"
                                : "border-s-[3px] border-s-emerald-500",
                          selected && "bg-primary/5",
                        )}
                      >
                        <td className="px-2 py-2.5 text-center text-xs font-bold text-muted-foreground">{idx + 1}</td>
                        <td className="px-2 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={cn(
                                "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                                isCustom ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                              )}
                            >
                              {isCustom ? "تخصيص" : "جاهز"}
                            </span>
                            <span className="text-lg font-extrabold">
                              {isCustom ? l.custom!.title : l.row.productName}
                            </span>
                            <span className="text-xs text-muted-foreground" dir="ltr">{l.row.sku}</span>
                            {!isCustom && stock.isOut && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[10px] font-extrabold text-destructive-foreground">
                                نافذ — لا مخزون
                              </span>
                            )}
                            {!isCustom && stock.isShort && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-extrabold text-amber-50">
                                {stock.availInUnit === 0
                                  ? "لا يكفي لوحدة"
                                  : `المتاح ${stock.availInUnit} فقط`}
                              </span>
                            )}
                          </div>
                          {isCustom && (
                            <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2.5">
                              <div className="flex flex-wrap gap-1.5">
                                {l.custom!.size && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                    <Ruler aria-hidden className="size-3" /> {l.custom!.size}
                                  </span>
                                )}
                                {l.custom!.material && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                    <Layers aria-hidden className="size-3" /> {l.custom!.material}
                                  </span>
                                )}
                                {l.custom!.dueDate && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold" dir="ltr">
                                    {l.custom!.dueDate}
                                  </span>
                                )}
                                {l.custom!.hasDelivery && (
                                  <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                    <Truck aria-hidden className="size-3" /> توصيل
                                    {Number(l.custom!.deliveryCost) > 0 && (
                                      <span dir="ltr">+{fmt(l.custom!.deliveryCost)}</span>
                                    )}
                                  </span>
                                )}
                                <span
                                  className={cn(
                                    "rounded-md border px-2 py-0.5 text-[11px] font-bold",
                                    l.custom!.priority === "URGENT" && "bg-destructive/10 text-destructive border-destructive/30",
                                    l.custom!.priority === "NORMAL" && "bg-[var(--sem-info)]/10 text-[var(--sem-info)] border-[var(--sem-info)]/30",
                                    l.custom!.priority === "LOW" && "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
                                  )}
                                >
                                  {l.custom!.priority === "URGENT" ? "عاجل" : l.custom!.priority === "NORMAL" ? "عادي" : "منخفض"}
                                </span>
                              </div>
                              {l.custom!.customizationText && (
                                <div className="mt-2 line-clamp-2 inline-flex items-start gap-1 text-[11px] leading-relaxed text-muted-foreground">
                                  <FileText aria-hidden className="size-3 mt-0.5 flex-shrink-0" />
                                  <span>{l.custom!.customizationText}</span>
                                </div>
                              )}
                              <div className="mt-2 flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] inline-flex items-center gap-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowCustomization({ row: l.row, editingKey: l.key });
                                  }}
                                >
                                  <Pencil aria-hidden className="size-3" /> تعديل التخصيص
                                </Button>
                                <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[11px] font-bold text-muted-foreground">
                                  <ImageIcon aria-hidden className="size-3" /> صور: {l.custom!.designImages.length}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-1 py-2.5 text-center text-xs text-muted-foreground">{l.row.unitName}</td>
                        <td className="px-1 py-2.5 text-center text-xs tabular-nums" dir="ltr">
                          {fmt(effectivePrice(l))}
                          {l.disc ? <div className="text-[10px] text-amber-600">−{l.disc}%</div> : null}
                        </td>
                        <td
                          className={cn(
                            "px-1 py-2.5 text-center text-xs font-bold tabular-nums",
                            isCustom ? "text-muted-foreground" : stock.isOut ? "text-destructive" : stock.isShort ? "text-amber-600" : "text-muted-foreground",
                          )}
                          dir="ltr"
                        >
                          {isCustom ? "—" : l.row.isService ? "∞" : stock.availInUnit}
                        </td>
                        <td className="px-1 py-1.5">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                changeQty(l.key, -1);
                              }}
                              className="grid size-8 place-items-center rounded-md border bg-card hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                              disabled={isCustom && l.qty <= 1}
                              title={isCustom && l.qty <= 1 ? "لا يُمكن تقليل كمية منتج مخصَّص دون ١ — احذف السطر بدلاً من ذلك" : "تقليل الكمية"}
                              aria-label="تقليل الكمية"
                            >
                              <Minus aria-hidden className="size-3.5" />
                            </button>
                            <span className="min-w-[28px] text-center text-sm font-extrabold tabular-nums" dir="ltr">{l.qty}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                changeQty(l.key, +1);
                              }}
                              className="grid size-8 place-items-center rounded-md border bg-card hover:bg-muted"
                              aria-label="زيادة الكمية"
                            >
                              <Plus aria-hidden className="size-3.5" />
                            </button>
                          </div>
                        </td>
                        <td className="px-1 py-2.5 text-center text-sm font-extrabold tabular-nums" dir="ltr">{fmt(total)}</td>
                        <td className="px-1 py-2.5 text-center">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeRow(l.key);
                            }}
                            className="text-muted-foreground hover:text-destructive"
                            aria-label="حذف المنتج"
                          >
                            <Trash2 aria-hidden className="size-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  });
                  })()}
                </tbody>
              </table>
            )}
          </div>

          {cart.length > 0 && (
            <div className="flex flex-shrink-0 items-center justify-between border-t bg-muted/40 px-4 py-2.5">
              <span className="text-xs text-muted-foreground">{cart.length} منتج · {cartCount} قطعة</span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs text-muted-foreground">المجموع:</span>
                <span className="text-2xl font-black tabular-nums" dir="ltr">{fmt(grandTotal)}</span>
                <span className="text-xs text-muted-foreground">د.ع</span>
              </div>
            </div>
          )}
        </div>

        {/* ─ لوحة الدفع ─ */}
        <div ref={paymentSectionRef} tabIndex={-1} onFocusCapture={() => setWorkflowStep(4)} className="flex w-[408px] flex-shrink-0 flex-col overflow-hidden rounded-xl border bg-card outline-none focus:ring-2 focus:ring-primary/30">
          {/* رأس الإجمالي + التقسيم الهجين */}
          <div className="flex-shrink-0 border-b bg-muted/40 p-3">
            <div className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-extrabold">
              <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] text-primary-foreground">٥</span>
              المبلغ والدفع
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">إجمالي الفاتورة</span>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-black tabular-nums tracking-tight" dir="ltr">{fmt(grandTotal)}</span>
                <span className="text-xs text-muted-foreground">د.ع</span>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2">
                <div className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700">
                  <ShoppingCart aria-hidden className="size-3" /> منتجات جاهزة
                </div>
                <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumDirect)}</div>
              </div>
              <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-2">
                <div className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-700">
                  <Printer aria-hidden className="size-3" /> خدمات وطباعة
                </div>
                <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumCustom)}</div>
              </div>
            </div>
          </div>

          {/* شاشة المبلغ */}
          <div className="flex-shrink-0 px-3 pb-1 pt-2">
            <div className="flex min-h-[44px] items-center justify-between rounded-lg border-[1.5px] bg-muted/40 px-3 py-1.5">
              <span className="text-xs text-muted-foreground">
                {numMode === "QTY" && "الكمية للسطر المحدّد"}
                {numMode === "DISC" && "خصم % للسطر المحدّد"}
                {numMode === "PAY" && "المبلغ المدفوع"}
              </span>
              <span
                className={cn(
                  "text-2xl font-black tabular-nums",
                  numMode === "PAY" && isOwing && "text-amber-600",
                  numMode === "PAY" && isChange && "text-emerald-600",
                )}
                dir="ltr"
              >
                {numMode === "QTY" ? (cart.find((c) => c.key === selKey)?.qty ?? "—") : numMode === "DISC" ? `${cart.find((c) => c.key === selKey)?.disc ?? 0}%` : payInput || "0"}
              </span>
            </div>
          </div>

          {/* مبالغ سريعة */}
          <div className="flex flex-shrink-0 flex-wrap gap-1.5 px-3 py-1">
            {QUICK_AMTS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setQuickAmt(v)}
                className="h-7 rounded-md border-[1.5px] bg-card px-2 text-[11px] font-bold tabular-nums hover:bg-muted"
                dir="ltr"
              >
                {v.toLocaleString("en-US")}
              </button>
            ))}
            <button
              type="button"
              onClick={payAll}
              className="h-7 rounded-md border-[1.5px] border-primary bg-card px-2 text-[11px] font-extrabold text-primary hover:bg-primary/10"
            >
              = الكل
            </button>
          </div>

          {/* لوحة الأرقام */}
          <div className="flex-shrink-0 px-3 py-1">
            <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-1.5" dir="rtl">
              <button onClick={() => setNumMode("QTY")} className={cn("h-12 min-w-[60px] rounded-lg border-[1.5px] text-xs font-extrabold", numMode === "QTY" ? "border-amber-400 bg-amber-100 text-amber-900" : "bg-card hover:bg-muted")}>الكمية</button>
              <NumKey k="3" onPress={numPress} />
              <NumKey k="2" onPress={numPress} />
              <NumKey k="1" onPress={numPress} />

              <button onClick={() => setNumMode("DISC")} className={cn("h-12 min-w-[60px] rounded-lg border-[1.5px] text-sm font-extrabold", numMode === "DISC" ? "border-amber-400 bg-amber-100 text-amber-900" : "bg-card hover:bg-muted")}>%</button>
              <NumKey k="6" onPress={numPress} />
              <NumKey k="5" onPress={numPress} />
              <NumKey k="4" onPress={numPress} />

              <button onClick={() => setNumMode("PAY")} className={cn("h-12 min-w-[60px] rounded-lg border-[1.5px] text-xs font-extrabold", numMode === "PAY" ? "border-amber-400 bg-amber-100 text-amber-900" : "bg-card hover:bg-muted")}>المبلغ</button>
              <NumKey k="9" onPress={numPress} />
              <NumKey k="8" onPress={numPress} />
              <NumKey k="7" onPress={numPress} />

              <button onClick={() => numPress("DEL")} className="grid h-12 place-items-center rounded-lg border-[1.5px] bg-red-50 text-red-700 hover:bg-red-100" aria-label="حذف">
                <X aria-hidden className="size-4" />
              </button>
              <NumKey k="." onPress={numPress} />
              <NumKey k="0" onPress={numPress} />
              <button onClick={() => numPress("C")} className="h-12 rounded-lg border-[1.5px] bg-card text-xs font-extrabold text-muted-foreground hover:bg-muted">C</button>
            </div>
          </div>

          {/* طريقة الدفع */}
          <div className="flex-shrink-0 px-3 py-1.5">
            <div className="mb-1 text-[11px] font-bold text-muted-foreground">طريقة الدفع</div>
            <div className="flex gap-1.5">
              {(
                [
                  { v: "CASH", label: "نقدي", Icon: Banknote },
                  { v: "CARD", label: "بطاقة", Icon: CreditCard },
                  { v: "TRANSFER", label: "تحويل", Icon: ArrowLeftRight },
                ] as const
              ).map((p) => (
                <button
                  key={p.v}
                  onClick={() => setMethod(p.v)}
                  className={cn(
                    "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border-2 py-2 text-xs font-extrabold transition-colors",
                    method === p.v
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card hover:bg-muted",
                  )}
                >
                  <p.Icon aria-hidden className="size-5" />
                  {p.label}
                </button>
              ))}
            </div>
            {needPaymentRef && (
              <Input
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder={method === "CARD" ? "أدخل رقم عملية البطاقة" : "أدخل رقم التحويل"}
                className="mt-2 h-9 text-xs"
                dir="ltr"
              />
            )}
          </div>

          {/* مؤشّر فكّة/متبقّي */}
          <div className="flex flex-shrink-0 items-center justify-between border-t px-3 py-1.5 text-xs">
            {isChange && paid > 0 && (
              <>
                <span className="font-semibold text-emerald-700">الفكّة:</span>
                <span className="text-xl font-black tabular-nums text-emerald-700" dir="ltr">
                  {fmt(change)} <span className="text-[10px] font-medium">د.ع</span>
                </span>
              </>
            )}
            {isOwing && (
              <>
                <span className="font-semibold text-amber-700">متبقّي:</span>
                <span className="text-xl font-black tabular-nums text-amber-700" dir="ltr">
                  {fmt(remaining)} <span className="text-[10px] font-medium">د.ع</span>
                </span>
              </>
            )}
            {!isChange && !isOwing && (
              <span className="text-muted-foreground">المتوقّع الآن: <span className="font-bold tabular-nums" dir="ltr">{fmt(expectedNow)} د.ع</span></span>
            )}
          </div>

          {/* الأزرار الكبيرة */}
          <div className="flex-shrink-0 space-y-1.5 px-3 pb-3 pt-1">
            <button
              type="button"
              disabled={cart.length === 0 || submitting || !shift}
              onClick={() => void handleSubmit({ quickFullPay: true })}
              className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500 text-sm font-black text-white shadow-md transition hover:bg-amber-600 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              <Zap aria-hidden className="size-4" /> تحصيل المطلوب الآن وطباعة
            </button>
            <button
              type="button"
              disabled={cart.length === 0 || submitting || !shift}
              onClick={() => void handleSubmit({ quickFullPay: false })}
              className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-sm font-black text-primary-foreground shadow-md transition hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              {submitting ? (
                "جارٍ الإرسال…"
              ) : sumCustom > 0 && sumDirect > 0 ? (
                <><Printer aria-hidden className="size-4" /> تثبيت البيع وإرسال الطباعة</>
              ) : sumCustom > 0 ? (
                <><Printer aria-hidden className="size-4" /> إرسال للمطبعة</>
              ) : (
                <><Check aria-hidden className="size-4" /> إتمام الطلب وطباعة</>
              )}
            </button>
            <div className="text-center text-[10px] text-muted-foreground">F4 دفع · F2 بحث</div>
          </div>
        </div>
      </div>

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
    </div>
  );
}

function NumKey({ k, onPress }: { k: string; onPress: (k: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPress(k)}
      className="h-12 rounded-lg border-[1.5px] bg-muted/40 text-lg font-extrabold tabular-nums hover:bg-muted"
      dir="ltr"
    >
      {k}
    </button>
  );
}
