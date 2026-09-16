/**
 * نقطة بيع قسم الطباعة والاستنساخ — شاشة خدمات باللمسة الواحدة.
 * تصميم Claude Design المعتمد: السلة فوق ← الدفع/لوحة الأرقام تحتها (عمود واحد يمين) ← الخدمات بطاقات يسار.
 * تُباع الخدمات بنقرة (بلا باركود)، السعر قابل للتعديل، والمواد (ورق/حبر) تُخصم بصمت خلف الكواليس
 * (الكلفة شأن إداري لا يراه الكاشير). إيصال حراري ٨٠mm + وردية + تقريب نقدي IQD — كنظامك تماماً.
 */
import { confirm } from "@/lib/confirm";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/date";
import { D, roundCashIQD, formatIqd } from "@/lib/money";
import {
  printShiftOpen, printReceipt, openCashDrawer, isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter,
  getServerBridgeStatus, serverPrintTest,
} from "@/lib/printing/print";
import { isCustomPriceSku } from "@/lib/printServices";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { isDisconnected, useConnectivity } from "@/lib/offline/connectivity";
import { useOfflineCatalogSync } from "@/lib/offline/catalogSync";
import { cachePrintServices, readCachedPrintServices } from "@/lib/offline/printServicesCache";
import {
  allocateOfflineReceiptNumber,
  assertCanCapture,
  enqueueOfflineItem,
  getDeviceCode,
  isOfflineSaleEnabled,
  type OfflinePrintSalePayload,
} from "@/lib/offline/outbox";
import { OfflineSyncChip } from "@/components/offline/OfflineSyncChip";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Printer, Search, Sun, Moon, Power, Globe, Check, X, Receipt as ReceiptIcon, Banknote, CreditCard, RefreshCw, Zap, AlertTriangle, Pencil, Vault, Clock, Undo2 } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { normalizeNumberInput } from "@shared/numberNormalize";
import { CopyButton } from "@/components/CopyButton";
import { notify } from "@/lib/notify";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { loadPosTabsDraft, posTabsDraftKey, savePosTabsDraft, type PosDraftScope } from "@/lib/cartDraft";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { normalizeSearchText } from "@shared/searchNormalize";
import { POS_EXTERNAL_PAYMENT_PROOF_HINT } from "@shared/posPaymentPolicy";
import { ReceiptOverlay } from "@/components/pos/ReceiptOverlay";
import { CreditApprovalDialog } from "@/components/pos/CreditApprovalDialog";
import { buildBrandedReceipt, type Receipt, POS_COLORS } from "@/components/pos/posShared";
import { ShiftCloseDialog } from "@/components/pos/ShiftCloseDialog";
import { PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";
import { PrintServiceGrid } from "@/components/printPos/PrintServiceGrid";
import { type OrderChannel } from "@/components/print-pos/PrintChannelCustomerBar";
import { HeldOrdersDrawer, type HeldSaleOrder } from "@/components/print-pos/HeldOrdersDrawer";
import { PrintPosHeader, PrintPosHeaderActions } from "@/components/print-pos/PrintPosHeader";
import { CheckoutColumn, type PaymentMethod, type EditingInvoiceInfo } from "@/components/print-pos/PrintPosCheckout";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { createPortal } from "react-dom";

// ─── Types ──────────────────────────────────────────────────────────────────
type Svc = RouterOutputs["printPos"]["services"][number];
type ShiftData = RouterOutputs["shifts"]["current"];

type ExternalPaymentDraft = {
  attemptId: number | null;
  requestId: string;
  fingerprint: string;
  state: "INITIATED" | "CONFIRMED";
  deviceId?: string;
};

type Tab = {
  id: number;
  label: string;
  cart: CartLine[];
  payInput: string;
  method: PaymentMethod;
  customerId: number | null;
  contactName: string;
  contactPhone: string;
  channel: OrderChannel;
  editingInvoice: EditingInvoiceInfo | null;
  selUid: number | null;
  /** مرجع ومحاولة الدفع غير النقدي المؤكدة خادمياً. */
  paymentRef: string;
  externalPayment: ExternalPaymentDraft | null;
};

// ─── Dark mode (يتبع الوضع العام للنظام عبر صنف <html>) ──────────────────────
function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// ─── رموز الألوان — موحَّدة مع ثيم النظام (بلاغ المالك «الثيم مختلفٌ عن بقيّة النظام») ─────
//
// ٢٤/٨: كانت `LIGHT/DARK` قيماً `oklch` مثبَّتة بحُوَيْة زرقاء (٢٤٧-٢٦٤) بينما بقيّة النظام
// دافئة (٧٨-٨٢). النتيجة: هذه الشاشة تبدو باردةً غريبةً بجوار الفواتير والتقارير. الحلّ:
// إشارات مباشرة إلى CSS variables (`var(--background)` إلخ) — نفس المتغيّرات المستعملة في
// Tailwind (`bg-card`, `text-foreground`…). التبديل الحيّ Light↔Dark محكومٌ بـ`data-theme` /
// `.dark` على `<html>` كما كان.
const LIGHT = {
  bg: "var(--background)", card: "var(--card)", border: "var(--border)",
  muted: "var(--muted)", mutedFg: "var(--muted-foreground)", fg: "var(--foreground)",
  primary: "var(--primary)", primaryFg: "var(--primary-foreground)", primarySoft: "color-mix(in oklch, var(--primary) 14%, transparent)",
  success: "var(--sem-pos)", amber: "var(--sem-warn)", danger: "var(--destructive)",
  numKey: "var(--muted)", delKey: "color-mix(in oklch, var(--destructive) 12%, var(--card))", delFg: "var(--destructive)",
  overlay: "color-mix(in oklch, var(--foreground) 78%, transparent)",
};
// نفس التوكنات — DARK يعمل تلقائياً حين يحمل `<html>` صنف `.dark` أو `data-theme="dark"` (توكنات
// index.css تعيد تعريف نفسها). نُبقي DARK رمزياً للـtype لكن قيمته هي LIGHT نفسه.
const DARK = LIGHT;
type C = typeof LIGHT;

const SHOP = "الرؤية العربية";
const DEPT = "قسم الطباعة والاستنساخ";
const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل" };
const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
const riqd = (n: number) => roundCashIQD(n).toNumber();

let TAB_SEQ = 2;
let UID = 1;
const newTab = (id: number, label?: string): Tab => ({
  id,
  label: label ?? `طلب ${id}`,
  cart: [],
  payInput: "",
  method: "CASH",
  customerId: null,
  contactName: "",
  contactPhone: "",
  channel: "WALK_IN",
  editingInvoice: null,
  selUid: null,
  paymentRef: "",
  externalPayment: null,
});

// ═══════════════════════════════════════════════════════════════════════════
export default function PrintPOS() {
  const dark = useDarkMode();
  const C: C = dark ? DARK : LIGHT;

  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  // الأدمن/المدير بلا فرع مُسنَد: اختيار الفرع صريحاً قبل فتح الوردية بدل الإسناد الصامت للفرع ١
  // (نظريّ — الأدمن المبذور مُسنَد لفرع). لا يمسّ مستخدماً له فرع (الشرط يسقط فيبقى branchId=فرعه).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = me.data?.branchId ?? pickedBranch ?? 1;
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";
  const noAssignedBranch = me.data != null && me.data.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && pickedBranch == null;
  const utils = trpc.useUtils();

  // قسم الطباعة: درج/وردية مستقلّة (PRINT_SERVICES) — فصلٌ كامل عن كاشير التجزئة (قرار المالك ٢٣/٧/٢٦).
  // كان يبيع سابقاً عبر درج التجزئة نفسه (RETAIL) ⇒ لا محاسبة نقدية منفصلة.
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "PRINT_SERVICES" });
  const shift = shiftQ.data;

  // ── طبقة القراءة المحليّة (تعميم الأوفلاين على كاشير الطباعة) ───────────────
  // البلاطات كانت تأتي من الخادم مباشرةً، فالشاشة تُظلم تماماً عند الانقطاع قبل أن يصل
  // الموظّف إلى زرّ الدفع أصلاً. الآن: تُحفَظ آخر قائمةٍ وصلت، وتُقدَّم كما هي عند الانقطاع.
  const connState = useConnectivity();
  const offline = isDisconnected(connState);
  // نبض مزامنة الكتالوج: يُبقي ختم `lastSyncAt` حيّاً — وهو صمّام صلاحية الأسعار الذي
  // يستعمله `assertCanCapture` (أسعارٌ أقدم من ٤٨ ساعة ⇒ لا التقاط).
  useOfflineCatalogSync(me.data ? branchId : null);

  const servicesQ = trpc.printPos.services.useQuery({ tier: "RETAIL" }, { enabled: !offline });
  const [cachedServices, setCachedServices] = useState<typeof servicesQ.data>(undefined);
  useEffect(() => {
    if (servicesQ.data?.length) void cachePrintServices("RETAIL", servicesQ.data);
  }, [servicesQ.data]);
  useEffect(() => {
    if (!offline) return;
    let cancelled = false;
    void readCachedPrintServices<NonNullable<typeof servicesQ.data>[number]>("RETAIL").then((snap) => {
      if (!cancelled) setCachedServices(snap?.items);
    });
    return () => { cancelled = true; };
  }, [offline]);
  const services = useMemo(
    () => (offline ? cachedServices ?? [] : servicesQ.data ?? []),
    [offline, cachedServices, servicesQ.data],
  );

  // الفئات (تبويبات) مشتقّة من الخدمات مع حفظ ترتيب أول ظهور.
  // print-catalog: تبويب «أخرى» (id=0) للخدمات بلا فئة — وإلا تُحجَب من الشبكة كُلّياً
  // (الفئة اختيارية في شاشة تعريف الخدمة، فلا يجوز أن تختفي خدمة صالحة).
  const cats = useMemo(() => {
    const seen = new Map<number, string>();
    let hasUncategorized = false;
    for (const s of services) {
      if (s.categoryId != null) {
        if (!seen.has(s.categoryId)) seen.set(s.categoryId, s.categoryName ?? "خدمات");
      } else hasUncategorized = true;
    }
    const out = Array.from(seen, ([id, name]) => ({ id, name }));
    if (hasUncategorized) out.push({ id: 0, name: "أخرى" });
    return out;
  }, [services]);

  // ── حالة ──
  const [tabs, setTabs] = useState<Tab[]>([newTab(1, "طلب 1")]);
  const [activeId, setActiveId] = useState(1);
  // ٢٤/٨ (تدقيق ذاتيّ، مرآة POS/Reception): عدّاد إضافةٍ صريح — يزيد فقط عند فعل الإضافة (شامل
  // رفعَ الكمية على السطر الأصل). لا يزيد عند حذفٍ/تعديل كمية/تبديل تبويب ⇒ الجدول يتّبع السطر
  // المُضاف/المزاد فوراً بلا قفزاتٍ من حذفٍ آخر (Codex P2 على PR #721).
  const [addTick, setAddTick] = useState(0);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cart = tab.cart;
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const paymentInputAmount = Number(tab.payInput || 0);
  const paymentIsCredit = paymentInputAmount > 0 && paymentInputAmount < total;
  const externalPaymentAmount = (paymentIsCredit ? paymentInputAmount : total).toFixed(2);
  const externalPaymentFingerprint = `${tab.method}|${externalPaymentAmount}|${(tab.paymentRef ?? "").trim().toUpperCase()}`;
  const externalFullPaymentFingerprint = `${tab.method}|${total.toFixed(2)}|${(tab.paymentRef ?? "").trim().toUpperCase()}`;
  const externalPaymentConfirmed = tab.method === "CASH"
    || (tab.externalPayment?.state === "CONFIRMED" && tab.externalPayment.fingerprint === externalPaymentFingerprint && tab.externalPayment.attemptId != null);
  const externalFullPaymentConfirmed = tab.method === "CASH"
    || (tab.externalPayment?.state === "CONFIRMED" && tab.externalPayment.fingerprint === externalFullPaymentFingerprint && tab.externalPayment.attemptId != null);

  const [catId, setCatId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lastInv, setLastInv] = useState<{ num: string; total: number } | null>(null);
  const [shifting, setShifting] = useState(false);
  const [opening, setOpening] = useState("0");
  const [editPriceUid, setEditPriceUid] = useState<number | null>(null);
  const [creditPrompt, setCreditPrompt] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPwd, setMgrPwd] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [printerReady, setPrinterReady] = useState(isPaired());
  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });
  const [headerActionsNode, setHeaderActionsNode] = useState<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [heldDrawerOpen, setHeldDrawerOpen] = useState(false);
  const heldSalesQ = trpc.printPos.listHeldSales.useQuery(
    { branchId },
    { refetchInterval: 15_000 },
  );
  const heldCount = heldSalesQ.data?.length ?? 0;

  useEffect(() => {
    setHeaderActionsNode(document.getElementById("pos-header-actions"));
  }, []);
  // لقطة الإيصال تُلتقط لحظة الإرسال بقيم متّسقة مع ما يسجّله الخادم (نقد مقرّب) ⇒ لا إعادة حساب
  // من حالة لاحقة/سلة مُفرَّغة، ولا «باقي/آجل» وهميّ من فرق التقريب.
  const pendingRef = useRef<{
    lines: Receipt["lines"]; customerName?: string; method: PaymentMethod;
    cashTotal: number; rawTotal: number; cashRounding: number; received: number; change: number; credit: number; isCredit: boolean;
  } | null>(null);

  const effectiveCatId = catId ?? cats[0]?.id ?? null;
  // اسم العميل للإيصال — بـid مباشرةً لا بحثاً في قائمةٍ مقصوصة عند ٥٠٠: العميل ٥٠١ كان يُطبَع
  // إيصاله **بلا اسم** بصمت. (لا خطر «وميض تسعير» هنا بخلاف الكاشير الرئيسي: هذه الشاشة تُثبّت
  // priceTier="RETAIL" ولا تشتقّ فئة السعر من العميل.)
  const selectedCustomerQ = trpc.customers.get.useQuery(
    { customerId: tab.customerId ?? 0 },
    { enabled: tab.customerId != null, staleTime: 60_000 },
  );
  const selectedCustomer = tab.customerId == null ? null : selectedCustomerQ.data ?? null;

  // ── مسوّدة التبويبات (localStorage) — نفس نمط كاشير التجزئة (cartDraft) بنطاق فرع+مستخدم+وردية ──
  // وردية الطباعة PRINT_SERVICES صفٌّ مستقلّ في جدول الورديات (id فريد عبر الأنواع) ⇒ لا تصادم
  // مفتاح مع مسوّدة كاشير التجزئة على نفس الجهاز.
  const draftScope: PosDraftScope | null = shift?.id && me.data?.id
    ? { branchId, userId: me.data.id, shiftId: shift.id }
    : null;
  const DRAFT_KEY = draftScope ? posTabsDraftKey(draftScope) : null;
  const [restoredDraftKey, setRestoredDraftKey] = useState<string | null>(null);

  useEffect(() => {
    if (!draftScope || !DRAFT_KEY) {
      // إغلاق الوردية/تبديل الهوية يزيل الفاتورة من الذاكرة فوراً (لا انتظار للوردية التالية).
      if (restoredDraftKey !== null) {
        setTabs([newTab(1, "طلب 1")]);
        setActiveId(1);
        setRestoredDraftKey(null);
      }
      return;
    }
    if (restoredDraftKey === DRAFT_KEY) return;
    const saved = loadPosTabsDraft<Tab>(localStorage, draftScope);
    if (saved) {
      // عدّادا الوحدة (TAB_SEQ/UID) يُصفَّران عند إعادة التحميل — يُقدَّمان فوق أقصى معرّف
      // مستعاد كي لا تتصادم مفاتيح التبويبات/الأسطر الجديدة مع المستعادة.
      const maxTab = Math.max(0, ...saved.tabs.map((t) => t.id));
      const maxUid = Math.max(0, ...saved.tabs.flatMap((t) => t.cart.map((c) => c.uid)));
      if (TAB_SEQ <= maxTab) TAB_SEQ = maxTab + 1;
      if (UID <= maxUid) UID = maxUid + 1;
      // المسوّدات الأقدم لا تحمل حالة المحاولة — تُستكمل بلا ادّعاء تأكيد.
      setTabs(saved.tabs.map((t) => ({
        ...t,
        // لا نُعيد إحياء طريقة/محاولة خارجية قديمة من localStorage بعد إغلاق السطح.
        method: "CASH" as PaymentMethod,
        paymentRef: "",
        externalPayment: null,
      })));
      setActiveId(saved.tabs.some((t) => t.id === saved.activeId) ? saved.activeId : saved.tabs[0].id);
    } else {
      setTabs([newTab(1, "طلب 1")]);
      setActiveId(1);
    }
    setRestoredDraftKey(DRAFT_KEY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DRAFT_KEY]);

  useEffect(() => {
    // لا تحفظ حالة وردية سابقة تحت مفتاح الوردية الجديدة أثناء رسم الانتقال.
    if (!draftScope || !DRAFT_KEY || restoredDraftKey !== DRAFT_KEY) return;
    savePosTabsDraft(localStorage, draftScope, tabs, activeId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId, DRAFT_KEY, restoredDraftKey]);

  // ── تبويبات ──
  const patch = (p: Partial<Tab>) => setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, ...p } : t)));
  const patchTab = (id: number, p: Partial<Tab>) => setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const setCart = (u: CartLine[] | ((c: CartLine[]) => CartLine[])) =>
    setTabs((prev) => prev.map((t) => (t.id !== activeId ? t : { ...t, cart: typeof u === "function" ? u(t.cart) : u })));
  const setPayInput = (u: string | ((s: string) => string)) =>
    setTabs((prev) => prev.map((t) => (t.id !== activeId ? t : { ...t, payInput: typeof u === "function" ? u(t.payInput) : u })));

  function addTab() { const id = TAB_SEQ++; setTabs((p) => [...p, newTab(id)]); setActiveId(id); }
  function closeTab(id: number) {
    if (tabs.length <= 1) return;
    setTabs((p) => { const n = p.filter((t) => t.id !== id); if (activeId === id) setActiveId(n[n.length - 1].id); return n; });
  }

  // ٢٥/٨ (بلاغ المالك «ميّز الخدمات الأكثر استعمالاً»): تتبّعُ آخر ١٠ خدماتٍ فريدة أُضيفت — بمفتاحٍ
  // لكاشير+فرع (`printpos.recentSKUs.<userId>.<branchId>`)، وتُعرض في شريطٍ لونيٍّ أعلى شبكة الخدمات
  // مع بروزٍ بصريّ (لون + أيقونة لهب). محلّية لا خادميّة (بيانات استعمال ⇒ لا معنى لمزامنتها).
  //
  // المفتاح يُبنى فقط حين تتوفّر الهوّية كاملةً (userId + branchId) — بلا `?? 0` (حارس check:branch)،
  // وفي غيابها يبقى `null` فيتخطّى الحفظ/القراءة (لا معنى لسجلّ استعمالٍ عائمٍ بلا كاشيرٍ محدَّد).
  const recentKey = useMemo(() => {
    const uid = me.data?.id;
    if (uid == null || !Number.isFinite(branchId)) return null;
    return `printpos.recentSKUs.${uid}.${branchId}`;
  }, [me.data?.id, branchId]);
  const [recentIds, setRecentIds] = useState<number[]>([]);
  useEffect(() => {
    if (!recentKey) { setRecentIds([]); return; }
    try {
      if (typeof window === "undefined") return;
      const stored = window.localStorage.getItem(recentKey);
      const parsed = stored ? JSON.parse(stored) : [];
      setRecentIds(Array.isArray(parsed) ? parsed.filter((n) => Number.isFinite(n)).slice(0, 10) : []);
    } catch { /* ignore */ }
  }, [recentKey]);
  function bumpRecent(productUnitId: number) {
    if (!recentKey) return;
    setRecentIds((prev) => {
      const next = [productUnitId, ...prev.filter((id) => id !== productUnitId)].slice(0, 10);
      try { window.localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  // ── عمليات السلة ──
  function addService(svc: Svc) {
    if (receipt) setReceipt(null);
    setMessage(null);
    bumpRecent(svc.productUnitId);
    const custom = isCustomPriceSku(svc.sku);
    setCart((prev) => {
      const i = prev.findIndex((c) => c.svc.productUnitId === svc.productUnitId);
      if (i >= 0 && !custom) {
        const n = [...prev];
        n[i] = { ...n[i], qty: n[i].qty + 1 };
        // ٢٤/٨: نُبرز السطرَ المزادَ كمّية أيضاً — الكاشير يرى ما تأثّر بنقرته الآن.
        patch({ selUid: n[i].uid });
        return n;
      }
      const uid = UID++;
      if (custom) setTimeout(() => setEditPriceUid(uid), 30);
      patch({ selUid: uid });
      return [...prev, { uid, svc, qty: 1, price: Number(svc.price ?? 0) }];
    });
    // ٢٤/٨: أشِر إلى الجدول أنّ إضافةً حدثت — يشمل حالة رفع الكمية على السطر الأصل.
    setAddTick((t) => t + 1);
  }
  function changeQty(uid: number, q: number) {
    if (q <= 0) { setCart((p) => p.filter((c) => c.uid !== uid)); if (tab.selUid === uid) patch({ selUid: null }); }
    else setCart((p) => p.map((c) => (c.uid === uid ? { ...c, qty: q } : c)));
  }
  function removeRow(uid: number) { setCart((p) => p.filter((c) => c.uid !== uid)); if (tab.selUid === uid) patch({ selUid: null }); }
  function setPrice(uid: number, price: number) { setCart((p) => p.map((c) => (c.uid === uid ? { ...c, price } : c))); }
  async function clearCart() {
    if (!cart.length) return;
    if (!(await confirm({ variant: "warning", title: "تفريغ الفاتورة", description: "ستُفقد كل الخدمات المُضافة. هل تتابع؟", confirmText: "تفريغ" }))) return;
    setCart([]); setPayInput(""); patch({ selUid: null });
  }

  // ── الدفع ──
  const numPress = (k: string) => setPayInput((prev) => (k === "⌫" ? prev.slice(0, -1) : prev + k));

  const sale = trpc.printPos.createSale.useMutation({
    onSuccess: async (r) => {
      // الإيصال من اللقطة الملتقطة لحظة الإرسال (متّسقة مع الخادم) لا من إعادة حساب على حالة لاحقة.
      const p = pendingRef.current;
      const now = new Date();
      const rec: Receipt = {
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        num: r.invoiceNumber,
        date: fmtDateTime(now),
        printDate: fmtDate(now),
        printTime: fmtTime(now),
        cashierName: me.data?.name ?? undefined,
        customerName: p?.customerName,
        // Codex P2: تفضيل shiftId من الفاتورة المُثبَّتة (idempotent replay بعد إغلاق وردية).
        shiftId: (r as { shiftId?: number | null }).shiftId ?? shift?.id ?? null,
        lines: (p?.lines ?? []).map((l) => ({ ...l, disc: undefined })),
        subtotal: p?.rawTotal ?? p?.cashTotal ?? 0,
        cashRounding: p?.cashRounding,
        total: p?.cashTotal ?? 0,
        received: p?.received ?? 0,
        change: p?.change ?? 0,
        credit: p?.credit ?? 0,
        method: METHOD_LABEL[p?.method ?? "CASH"],
        methodCode: p?.method,
        isCredit: p?.isCredit ?? false,
      };
      setReceipt(rec);
      setLastInv({ num: r.invoiceNumber, total: p?.cashTotal ?? 0 });
      setCart([]); setPayInput(""); patch({ selUid: null, paymentRef: "", externalPayment: null });
      setClientRequestId(crypto.randomUUID());
      const printed = await printReceipt(buildBrandedReceipt(rec));
      setMessage({
        kind: !printed.ok ? "err" : printed.via === "browser" ? "warn" : "ok",
        text: !printed.ok
          ? `تمّ البيع، لكن حجب المتصفح نافذة الطباعة — اسمح بالنوافذ المنبثقة وأعد طباعة الفاتورة ${r.invoiceNumber}`
          : printed.via === "server"
          ? `تمّ البيع والطباعة المباشرة — فاتورة ${r.invoiceNumber}`
          : printed.via === "thermal"
            ? `تمّ البيع والطباعة على الطابعة الحرارية — فاتورة ${r.invoiceNumber}`
            : `تمّ البيع — افتُتحت نافذة الطباعة لأن الطابعة المباشرة غير متاحة (${r.invoiceNumber})`,
      });
      await Promise.all([utils.printPos.services.invalidate(), shiftQ.refetch()]);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      // فخّ «النقرة الأولى» بعد قطعٍ صامت: المتصفّح لم يُحدِّث حالة الاتصال بعد، فيفشل النقل
      // بلا كود tRPC. لا التزام جزئيّ هنا (المعاملة ذرّية) ⇒ الالتقاط آمن، وclientRequestId
      // الثابت يجعل الترحيل idempotent لو كان الطلب قد وصل الخادم فعلاً قبل انقطاع الردّ.
      if (code == null) {
        void captureOfflinePrintSale(pendingRef.current?.isCredit === false).then((captured) => {
          if (!captured) setMessage({ kind: "err", text: e.message });
        });
        return;
      }
      // بوّابات الاعتماد على هذه القناة ترمي FORBIDDEN لا PRECONDITION_FAILED (بيعٌ تحت التكلفة،
      // وانحرافُ السعر اليدويّ H6) ⇒ مطابقةُ الرمز وحدها كانت تُظهر خطأً جامداً بلا حوارِ موافقة،
      // فيعجز كاشير الطباعة عن إتمام بيعٍ مشروعٍ باعتماد مدير. نطابق العبارة الجامعة كما في POS.
      if (code === "PRECONDITION_FAILED" || (e.message && e.message.includes("موافقة مدير"))) setCreditPrompt(e.message);
      else setMessage({ kind: "err", text: e.message });
    },
  });

  const initiateExternalPayment = trpc.printPos.initiateExternalPayment.useMutation();
  const confirmExternalPaymentMutation = trpc.printPos.confirmExternalPayment.useMutation();

  async function confirmCurrentExternalPayment() {
    if (!shift || !cart.length || tab.method === "CASH") return;
    const tabId = tab.id;
    const reference = (tab.paymentRef ?? "").trim();
    if (!reference) {
      setMessage({ kind: "err", text: "أدخل مرجع الدفع الخارجي أولاً." });
      return;
    }
    if (tab.payInput.trim() !== "" && Number(tab.payInput) <= 0) {
      setMessage({ kind: "err", text: "مبلغ الدفع يجب أن يكون موجباً قبل تأكيد العملية الخارجية." });
      return;
    }

    const fingerprint = externalPaymentFingerprint;
    const prior = tab.externalPayment?.fingerprint === fingerprint ? tab.externalPayment : null;
    const requestId = prior?.requestId ?? crypto.randomUUID();
    let deviceId = prior?.deviceId;
    if (!deviceId) {
      try {
        deviceId = await getDeviceCode();
      } catch {
        setMessage({ kind: "err", text: "تعذّر تحديد جهاز الكاشير — لا يمكن تأكيد دفع خارجي بلا هوية جهاز." });
        return;
      }
    }
    patchTab(tabId, { externalPayment: {
      attemptId: prior?.attemptId ?? null,
      requestId,
      fingerprint,
      state: prior?.state ?? "INITIATED",
      deviceId,
    } });

    try {
      let attemptId = prior?.attemptId ?? null;
      if (!attemptId) {
        const initiated = await initiateExternalPayment.mutateAsync({
          branchId,
          method: tab.method,
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
      setMessage({ kind: "ok", text: `تأكّد الدفع الخارجي وثُبّت المرجع ${reference}.` });
    } catch (error) {
      setMessage({ kind: "err", text: error instanceof Error ? error.message : "تعذّر تثبيت تأكيد الدفع الخارجي" });
    }
  }

  const correctSaleMut = trpc.printPos.correctHeldSale.useMutation({
    onSuccess: async (r) => {
      const now = new Date();
      const rec: Receipt = {
        invoiceId: r.correctedInvoiceId,
        invoiceNumber: r.correctedInvoiceNumber,
        num: r.correctedInvoiceNumber,
        date: fmtDateTime(now),
        printDate: fmtDate(now),
        printTime: fmtTime(now),
        cashierName: me.data?.name ?? undefined,
        customerName: selectedCustomer?.name ?? (tab.contactName || undefined),
        shiftId: shift?.id ?? null,
        lines: cart.map((c) => ({ name: c.svc.productName, unit: c.svc.unitName, qty: c.qty, price: c.price, total: c.price * c.qty })),
        subtotal: total,
        cashRounding: 0,
        total: Number(r.total),
        received: Number(tab.editingInvoice?.preCollected || 0) + Number(tab.payInput || 0),
        change: 0,
        credit: Math.max(0, Number(r.total) - (Number(tab.editingInvoice?.preCollected || 0) + Number(tab.payInput || 0))),
        method: METHOD_LABEL[tab.method],
        methodCode: tab.method,
        isCredit: Number(r.total) > (Number(tab.editingInvoice?.preCollected || 0) + Number(tab.payInput || 0)),
      };
      setReceipt(rec);
      setLastInv({ num: r.correctedInvoiceNumber, total: Number(r.total) });
      patch({
        editingInvoice: null,
        cart: [],
        payInput: "",
        contactName: "",
        contactPhone: "",
        selUid: null,
        paymentRef: "",
        externalPayment: null,
      });
      setClientRequestId(crypto.randomUUID());
      const printed = await printReceipt(buildBrandedReceipt(rec));
      setMessage({
        kind: "ok",
        text: `تم تعديل الفاتورة بنجاح وإصدار الفاتورة البديلة ${r.correctedInvoiceNumber}${!printed.ok ? " (فشلت الطباعة المباشرة)" : ""}`,
      });
      await Promise.all([
        utils.printPos.listHeldSales.invalidate(),
        utils.printPos.services.invalidate(),
        shiftQ.refetch(),
      ]);
    },
    onError: (e) => setMessage({ kind: "err", text: e.message || "فشل تعديل الطلب المحجوز" }),
  });

  function handleEditHeldOrder(order: HeldSaleOrder) {
    const lines: CartLine[] = order.lines.map((l) => {
      const matchedSvc: Svc = services.find((s) => s.productUnitId === l.productUnitId) ?? {
        productUnitId: l.productUnitId,
        variantId: l.variantId,
        productId: 0,
        productName: l.itemNameSnapshot || "خدمة طباعة",
        unitName: "خدمة",
        sku: "",
        price: String(l.unitPrice),
        categoryId: null,
        categoryName: null,
      };
      return {
        uid: UID++,
        svc: matchedSvc,
        qty: Number(l.quantity),
        price: Number(l.unitPrice),
      };
    });

    let ch: OrderChannel = "WALK_IN";
    if (order.notes?.includes("واتساب")) ch = "WHATSAPP";
    else if (order.notes?.includes("تليغرام")) ch = "TELEGRAM";
    else if (order.notes?.includes("هاتف")) ch = "PHONE";

    patch({
      cart: lines,
      customerId: order.customerId,
      contactName: order.contactName ?? "",
      contactPhone: order.contactPhone ?? "",
      channel: ch,
      editingInvoice: {
        id: order.id,
        invoiceNumber: order.invoiceNumber,
        preCollected: order.paidAmount,
        originalTotal: order.total,
      },
      payInput: "",
      selUid: lines[0]?.uid ?? null,
    });
    setHeldDrawerOpen(false);
    notify.ok(`تم تحميل الفاتورة #${order.invoiceNumber} للتعديل`);
  }

  function cancelEditingHeldOrder() {
    patch({
      editingInvoice: null,
      cart: [],
      payInput: "",
      contactName: "",
      contactPhone: "",
      channel: "WALK_IN",
      customerId: null,
      selUid: null,
    });
    notify.info("تم إلغاء التعديل وتفريغ السلة");
  }

  useBarcodeScanner(async (code) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const found = await utils.printPos.getSaleByNumber.fetch({ orderNumber: trimmed });
      if (found) {
        if (found.status === "PENDING" || found.status === "PARTIALLY_PAID") {
          notify.ok(`تم العثور على الطلب المحجوز #${found.invoiceNumber}`);
          handleEditHeldOrder(found as any);
          return;
        } else {
          notify.info(`الفاتورة #${found.invoiceNumber} مكتملة وليست قيد الحجز`);
          return;
        }
      }
    } catch {
      // ليس رقم فاتورة، تحقق من مطابقة SKU لخدمات الطباعة
    }
    const matchedSvc = services.find((s) => s.sku === trimmed);
    if (matchedSvc) {
      addService(matchedSvc);
    }
  }, { enabled: !shifting && !receipt && !creditPrompt });

  /**
   * التقاط بيع خدمات طباعةٍ دون اتصال.
   *
   * نقديّ كامل فقط: الآجل يحتاج ذمّة العميل وسقفه من الخادم، والبطاقة تحتاج مرجع عمليّةٍ
   * يُتحقَّق منه. المواد تُستهلك عند الترحيل لا عند الالتقاط — وهذا مقبول: `createPrintSale`
   * يخصمها بـallowNegative أصلاً، فالاستهلاك يبقى متعقَّباً حتى لو نفدت المادة دفترياً.
   */
  async function captureOfflinePrintSale(forceFullPayment: boolean): Promise<boolean> {
    if (!shift || !cart.length) return false;
    if (!(await isOfflineSaleEnabled())) {
      setMessage({
        kind: "err",
        text: "البيع دون اتصال مُعطَّل على هذا الجهاز — أعِد تفعيله من «إعدادات الجهاز» في شارة المزامنة (الافتراضي مفعَّل).",
      });
      return false;
    }
    if (tab.method !== "CASH") {
      setMessage({ kind: "err", text: "أثناء انقطاع الاتصال: النقد فقط — البطاقة والتحويل يتطلبان الخادم." });
      return false;
    }
    const cashTotal = riqd(total);
    const paid = forceFullPayment ? cashTotal : Number(tab.payInput || 0);
    if (paid < cashTotal) {
      // كان رقماً خاماً بلا فواصل آلاف (١,٨٩٦,٥٠٠ ← 1896500.00) في شريطٍ ظاهرٍ دائماً أثناء
      // الانقطاع، لا Toast عابر — formatIqd المستوردة أصلاً في هذا الملف تكفي.
      setMessage({ kind: "err", text: `دون اتصال: الدفع الكامل فقط — المطلوب ${formatIqd(cashTotal)}.` });
      return false;
    }
    const gate = await assertCanCapture(cashTotal);
    if (!gate.ok) {
      setMessage({ kind: "err", text: gate.reason });
      return false;
    }

    const receiptNumber = await allocateOfflineReceiptNumber(branchId);
    const payload: OfflinePrintSalePayload = {
      branchId,
      shiftId: shift.id,
      ...(tab.customerId ? { customerId: tab.customerId } : {}),
      priceTier: "RETAIL",
      lines: cart.map((c) => ({
        variantId: c.svc.variantId,
        productUnitId: c.svc.productUnitId,
        quantity: String(c.qty),
        // السعر الملتقَط إلزاميّ: النقد قُبض بالسعر المطبوع — لا إعادة تسعيرٍ صامتة عند الترحيل.
        unitPriceOverride: c.price.toFixed(2),
      })),
      payment: { amount: total.toFixed(2), method: "CASH" },
      clientRequestId,
      cashRoundIQD: true,
    };
    const stored = await enqueueOfflineItem({
      kind: "PRINT_SALE",
      payload,
      offlineReceiptNumber: receiptNumber,
      total: cashTotal.toFixed(2),
    });
    if (!stored) {
      setMessage({ kind: "err", text: "تعذّر حفظ العملية محلياً (مساحة المتصفح؟) — لا تُسلّم العمل قبل عودة الاتصال." });
      return false;
    }

    const now = new Date();
    const rec: Receipt = {
      invoiceId: 0, // لا فاتورة رسميّة بعد — الطباعة تستعمل الرقم المؤقّت.
      invoiceNumber: receiptNumber,
      num: receiptNumber,
      date: fmtDateTime(now),
      printDate: fmtDate(now),
      printTime: fmtTime(now),
      cashierName: me.data?.name ?? undefined,
      customerName: selectedCustomer?.name,
      shiftId: shift?.id ?? null,
      lines: cart.map((c) => ({ name: c.svc.productName, unit: c.svc.unitName, qty: c.qty, price: c.price, total: c.price * c.qty })),
      subtotal: total,
      cashRounding: cashTotal - total,
      total: cashTotal,
      received: paid,
      change: Math.max(0, paid - cashTotal),
      credit: 0,
      method: METHOD_LABEL.CASH,
      methodCode: "CASH",
      isCredit: false,
    };
    setReceipt(rec);
    setLastInv({ num: receiptNumber, total: cashTotal });
    setCart([]); setPayInput(""); patch({ selUid: null, paymentRef: "", externalPayment: null });
    setClientRequestId(crypto.randomUUID());
    setMessage({
      kind: "ok",
      text: `بيع دون اتصال — إيصال مؤقّت ${receiptNumber}. الرقم الرسميّ يصدر تلقائياً عند عودة الاتصال.`,
    });
    void printReceipt(buildBrandedReceipt(rec)).then((printed) => {
      if (!printed.ok) setMessage({ kind: "err", text: `حُفظ الإيصال المؤقت ${receiptNumber}، لكن حجب المتصفح نافذة الطباعة` });
    }).catch(() => { /* فشل الطابعة لا يُلغي التقاطاً التزم محلياً */ });
    return true;
  }

  function submit(forceFullPayment: boolean, approval?: { email: string; password: string }, isReservation?: boolean) {
    if (!shift || !cart.length || sale.isPending || correctSaleMut.isPending) return;
    setMessage(null);

    // إذا كانت هناك فاتورة محجوزة قيد التعديل
    if (tab.editingInvoice) {
      const additionalPaid = Number(tab.payInput || 0);
      const additionalAmount = additionalPaid > 0 ? additionalPaid.toFixed(2) : undefined;
      correctSaleMut.mutate({
        originalInvoiceId: tab.editingInvoice.id,
        customerId: tab.customerId,
        contactName: tab.contactName.trim() || undefined,
        contactPhone: tab.contactPhone.trim() || undefined,
        priceTier: "RETAIL",
        lines: cart.map((c) => ({
          variantId: c.svc.variantId,
          productUnitId: c.svc.productUnitId,
          quantity: String(c.qty),
          unitPriceOverride: c.price.toFixed(2),
        })),
        reason: "تعديل بنود الفاتورة المحجوزة من كاشير الطباعة",
        additionalPayment: additionalAmount ? {
          amount: additionalAmount,
          method: tab.method as any,
          reference: tab.paymentRef || undefined,
          externalPaymentAttemptId: tab.externalPayment?.attemptId,
          externalPaymentDeviceId: tab.externalPayment?.deviceId,
        } : null,
        overpayHandling: "CASH_REFUND",
        clientRequestId,
      });
      return;
    }

    if (offline) {
      if (isReservation) {
        setMessage({ kind: "err", text: "حجز الفواتير والبيع الآجل يتطلب الاتصال بالخادم." });
        return;
      }
      void captureOfflinePrintSale(forceFullPayment);
      return;
    }

    // Quick pay means full payment, not a forced change of the selected method to CASH.
    const method: PaymentMethod = tab.method;
    const confirmedForAmount = forceFullPayment ? externalFullPaymentConfirmed : externalPaymentConfirmed;
    if (method !== "CASH" && !confirmedForAmount && !isReservation) {
      setMessage({ kind: "err", text: "أدخل مرجع العملية وثبّت نجاح الدفع لدى المزوّد للمبلغ الحالي قبل الإتمام." });
      return;
    }
    const cashTotal = method === "CASH" ? riqd(total) : total;
    const paid = forceFullPayment ? cashTotal : Number(tab.payInput || 0);
    const isCredit = !forceFullPayment && !isReservation && paid < cashTotal;

    if (isReservation) {
      if (tab.customerId == null && !tab.contactName.trim() && !tab.contactPhone.trim()) {
        setMessage({ kind: "err", text: "حجز الطلب يتطلّب تحديد عميل مسجل أو إدخال اسم/هاتف الزبون." });
        return;
      }
    } else if (isCredit && tab.customerId == null) {
      setMessage({ kind: "err", text: "البيع الآجل يتطلّب اختيار عميل مسجّل ذو ذمة وحساب." });
      return;
    }

    const cashFull = method === "CASH" && !isCredit && !isReservation;
    const amount = isReservation ? (paid > 0 ? paid.toFixed(2) : "0.00") : (isCredit ? paid.toFixed(2) : total.toFixed(2));
    // النقد المُسلَّم فعلاً: للدفع الكامل بلا إدخال = الإجمالي المقرّب (لا باقي)؛ ومع إدخالٍ صريح = المُدخَل.
    const tendered = forceFullPayment ? cashTotal : (tab.payInput === "" ? cashTotal : paid);
    const finalTotal = cashFull ? cashTotal : total;
    pendingRef.current = {
      lines: cart.map((c) => ({ name: c.svc.productName, unit: c.svc.unitName, qty: c.qty, price: c.price, total: c.price * c.qty })),
      customerName: selectedCustomer?.name ?? (tab.contactName || undefined),
      method,
      cashTotal: finalTotal,
      rawTotal: total,
      cashRounding: cashFull ? cashTotal - total : 0,
      received: isReservation || isCredit ? paid : finalTotal, // ما يسجّله الخادم paidAmount (نقد كامل = المقرّب)
      change: isReservation || isCredit ? 0 : Math.max(0, tendered - finalTotal),
      credit: isReservation || isCredit ? Math.max(0, total - paid) : 0,
      isCredit: Boolean(isCredit || isReservation),
    };
    sale.mutate({
      branchId, shiftId: shift.id, clientRequestId,
      ...(method !== "CASH" && tab.externalPayment?.deviceId ? { deviceId: tab.externalPayment.deviceId } : {}),
      customerId: tab.customerId ?? undefined,
      contactName: tab.contactName.trim() || undefined,
      contactPhone: tab.contactPhone.trim() || undefined,
      channel: tab.channel,
      isReservation: isReservation ? true : undefined,
      priceTier: "RETAIL",
      lines: cart.map((c) => ({
        variantId: c.svc.variantId, productUnitId: c.svc.productUnitId,
        quantity: String(c.qty), unitPriceOverride: c.price.toFixed(2),
      })),
      payment: {
        amount,
        method,
        ...(method !== "CASH" && tab.externalPayment?.attemptId ? { externalPaymentAttemptId: tab.externalPayment.attemptId } : {}),
      },
      ...(cashFull ? { cashRoundIQD: true } : {}),
      ...(approval ? { managerApproval: approval } : {}),
    });
  }

  const openShift = trpc.shifts.open.useMutation({
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
        shiftId:        res.shiftId,
        openingBalance: Number(opening || 0),
        cashierName:    me.data?.name ?? "كاشير",
        branchName:     (branches.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId}`,
        openedAt:       new Date(),
        departmentName: "خدمات طباعة",
      });
    },
    onError: (e) => setMessage({ kind: "err", text: e.message }),
  });


  // ── اختصارات ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt) { if (e.key === "Escape" || e.key === "Enter") { setReceipt(null); setTimeout(() => searchRef.current?.focus(), 0); } return; }
      if (shifting) { if (e.key === "Escape") setShifting(false); return; }
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "F4") { e.preventDefault(); submit(false); }
      else if (e.key === "F10") {
        e.preventDefault();
        void openCashDrawer().then((res) => {
          if (res.ok) notify.ok("تم فتح درج النقود");
          else notify.err("تعذّر فتح الدرج", "تأكد من توصيل الطابعة الحرارية وربطها");
        });
      }
      else if (e.key === "F12") { e.preventDefault(); void clearCart(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sale.isPending, receipt, creditPrompt, shifting, tab.method, tab.payInput, total, externalPaymentConfirmed, externalFullPaymentConfirmed]);

  // ── الطابعة الحرارية (WebUSB) + جسر الخادم ──
  const connectPrinter = async () => {
    try { await pairPrinter(); setPrinterReady(true); }
    catch (e: unknown) { setMessage({ kind: "err", text: (e as Error)?.message ?? "تعذّر ربط الطابعة" }); }
  };

  const testServerPrint = async () => {
    const r = await serverPrintTest();
    setMessage(r.ok
      ? { kind: "ok", text: "أُرسلت تذكرة اختبار للطابعة عبر الخادم" }
      : { kind: "err", text: r.error ?? "فشل اختبار الطباعة" });
  };

  // حالة جسر الطباعة على الخادم (إن ضُبط PRINT_TARGET ⇒ طباعة صامتة لأي طابعة، بلا WebUSB).
  useEffect(() => {
    getServerBridgeStatus().then(setBridge).catch(() => { /* تجاهل */ });
  }, []);

  // ربط تلقائي صامت بالطابعة الافتراضية: إن سبق ربطها (إذن WebUSB محفوظ للأصل) يُعاد
  // الربط بلا نافذة اختيار عند فتح الشاشة، وكذلك عند توصيلها لاحقاً (حدث connect).
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

  const toggleDark = () => document.documentElement.classList.toggle("dark");

  // ── شاشة فتح الوردية ──
  if (shiftQ.isLoading) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.mutedFg, fontFamily: "'Cairo', system-ui, sans-serif", direction: "rtl" }}>{ACTION_LABELS.loading}</div>;
  }
  if (!shift) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "32px 36px", width: 380, boxShadow: "0 8px 32px rgb(0 0 0/.16)" }}>
          <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 6, color: C.fg }}>افتح وردية للبدء</div>
          <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 22 }}>{DEPT} — لا يمكن البيع بدون وردية مفتوحة</div>
          {noAssignedBranch && isElevatedRole && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8, padding: "8px 12px", background: C.muted, border: `1px solid ${C.amber}`, borderRadius: 9, fontSize: 12, color: C.fg, fontWeight: 700 }}>
                حسابك بلا فرعٍ مُسنَد — اختر الفرع الذي تعمل منه كي لا تُنسَب المبيعات لفرعٍ خاطئ.
              </div>
              <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الفرع</label>
              <AppSelect
                value={String(pickedBranch ?? "")}
                onValueChange={(value) => setPickedBranch(value ? Number(value) : null)}
                style={{ width: "100%", height: 48, border: `1.5px solid ${pickedBranch == null ? C.danger : C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, padding: "0 12px", outline: "none", boxSizing: "border-box", marginBottom: 16 }}
              >
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AppSelect>
            </div>
          )}
          <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الرصيد الافتتاحي للصندوق (د.ع)</label>
          <input dir="ltr" value={opening} onChange={(e) => setOpening(e.target.value.replace(/[^0-9]/g, ""))}
            style={{ width: "100%", height: 48, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 18, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box", marginBottom: 16 }} />
          {message && <div style={{ fontSize: 13, color: message.kind === "ok" ? C.success : message.kind === "warn" ? C.amber : C.danger, marginBottom: 12 }}>{message.text}</div>}
          {/* اربط الطابعة الحرارية هنا **قبل** فتح الوردية كي يُطبَع إيصال الافتتاح صامتاً فوراً
              بدل نافذة طباعة المتصفّح (كانت لا تظهر إلا بعد فتح الوردية داخل رأس الشاشة الرئيسية). */}
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
          <button disabled={openShift.isPending || needsBranchChoice} onClick={() => openShift.mutate({ branchId, openingBalance: opening || "0", shiftType: "PRINT_SERVICES" })}
            style={{ width: "100%", height: 52, background: openShift.isPending || needsBranchChoice ? C.muted : C.primary, color: openShift.isPending || needsBranchChoice ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 10, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: openShift.isPending || needsBranchChoice ? "not-allowed" : "pointer" }}>
            {openShift.isPending ? "جارٍ الفتح…" : needsBranchChoice ? "اختر الفرع أولاً" : "فتح الوردية"}
          </button>
          <Link href="/" style={{ display: "block", textAlign: "center", marginTop: 14, fontSize: 13, color: C.mutedFg }}>← الرئيسية</Link>
        </div>
      </div>
    );
  }

  // ── الشاشة الرئيسية ──
  return (
    <div className="print-pos-surface" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>
      <PrintPosHeader C={C} dark={dark} toggleDark={toggleDark} search={search} setSearch={setSearch} searchRef={searchRef}
        lastInv={lastInv} />

      {headerActionsNode && createPortal(
        <PrintPosHeaderActions
          C={C}
          shiftId={shift.id}
          userRole={me.data?.role}
          onCloseShift={() => setShifting(true)}
          printerReady={printerReady}
          onConnectPrinter={connectPrinter}
          bridgeEnabled={bridge.enabled}
          bridgeDesc={bridge.description}
          onTestPrint={testServerPrint}
        />,
        headerActionsNode,
      )}

      {/* شريط الطلبات */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", background: C.bg, borderBottom: `1px solid ${C.border}`, flexShrink: 0, overflowX: "auto" }}>
        {tabs.map((t) => {
          const tt = t.cart.reduce((s, c) => s + c.price * c.qty, 0);
          const items = t.cart.reduce((s, c) => s + c.qty, 0);
          const active = t.id === activeId;
          return (
            <div key={t.id} onClick={() => setActiveId(t.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 9, background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg, border: `${active ? 2 : 1.5}px solid ${active ? C.primary : C.border}`, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap", fontSize: 13, fontWeight: 700 }}>
              <span>{t.label}</span>
              {tt > 0 && <span style={{ fontSize: 12, fontWeight: 800, direction: "ltr", opacity: active ? 1 : 0.75 }}>{fmt(tt)} د.ع</span>}
              {items > 0 && <span style={{ background: active ? "rgba(255,255,255,.25)" : C.muted, color: active ? "#fff" : C.mutedFg, borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: 700 }}>{items}</span>}
              {tabs.length > 1 && <button onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} aria-label="إغلاق التبويب" style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: active ? "rgba(255,255,255,.7)" : C.mutedFg, lineHeight: 1, display: "inline-flex" }}><X aria-hidden size={13} /></button>}
            </div>
          );
        })}
        {tabs.length < 6 && (
          <button
            type="button"
            aria-label="طلب طباعة جديد"
            onClick={addTab}
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: C.card,
              border: `1.5px dashed ${C.border}`,
              cursor: "pointer",
              fontSize: 18,
              color: C.mutedFg,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              transition: "all 0.15s ease",
            }}
          >
            +
          </button>
        )}
      </div>

      {/* ٢٤/٨ (Codex P2 على PR #741): الأرضيّة كانت `oklch(0.95 ...)` مثبَّتة فاتحة، والفَون
          `--sem-pos/--sem-warn/--destructive` صار فاتحاً في Dark ⇒ فاتحٌ على فاتح غير مقروء.
          الآن `--sem-pos-bg/--sem-warn-bg/--sem-neg-bg` (المُقرَّرة في `tokens.css` لكلا الوضعَين). */}
      {message && (
        <div style={{ padding: "4px 16px", background: message.kind === "ok" ? "var(--sem-pos-bg)" : message.kind === "warn" ? "var(--sem-warn-bg)" : "var(--sem-neg-bg)", color: message.kind === "ok" ? C.success : message.kind === "warn" ? C.amber : C.danger, fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span>{message.text}</span>
          {message.kind !== "err" && receipt && <Link href={`/invoices/${receipt.invoiceId}`} style={{ color: C.primary, textDecoration: "underline", fontSize: 12 }}>فتح الفاتورة</Link>}
          <button onClick={() => setMessage(null)} aria-label="إغلاق التنبيه" style={{ marginRight: "auto", background: "none", border: "none", cursor: "pointer", color: C.mutedFg, display: "inline-flex" }}><X aria-hidden size={14} /></button>
        </div>
      )}

      {/* الجسم: عمود الطلب/الدفع (يمين) ← الخدمات (يسار) */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", padding: 8, gap: 8, minHeight: 0 }}>
        <CheckoutColumn
          C={C} cart={cart} total={total}
          selUid={tab.selUid} setSelUid={(id) => patch({ selUid: id })}
          changeQty={changeQty} removeRow={removeRow} onClear={clearCart}
          setPrice={setPrice} editPriceUid={editPriceUid} setEditPriceUid={setEditPriceUid}
          customerId={tab.customerId} setCustomerId={(id) => patch({ customerId: id })}
          contactName={tab.contactName} setContactName={(name) => patch({ contactName: name })}
          contactPhone={tab.contactPhone} setContactPhone={(phone) => patch({ contactPhone: phone })}
          channel={tab.channel} setChannel={(c) => patch({ channel: c })}
          editingInvoice={tab.editingInvoice} onCancelEdit={cancelEditingHeldOrder}
          heldCount={heldCount} onOpenHeldDrawer={() => setHeldDrawerOpen(true)}
          payInput={tab.payInput} setPayInput={setPayInput} method={tab.method} setMethod={(m) => patch({ method: m, externalPayment: null })}
          paymentRef={tab.paymentRef ?? ""} setPaymentRef={(v) => patch({ paymentRef: v, externalPayment: null })}
          externalPaymentConfirmed={externalPaymentConfirmed}
          externalFullPaymentConfirmed={externalFullPaymentConfirmed}
          externalPaymentPending={initiateExternalPayment.isPending || confirmExternalPaymentMutation.isPending}
          onConfirmExternalPayment={() => { void confirmCurrentExternalPayment(); }}
          numPress={numPress}
          onPay={() => submit(false)}
          onQuickPay={() => submit(true)}
          onReserve={() => submit(false, undefined, true)}
          isPending={sale.isPending || correctSaleMut.isPending}
          addTick={addTick}
        />
        <PrintServiceGrid C={C} services={services} loading={servicesQ.isLoading} cats={cats} catId={effectiveCatId} setCatId={setCatId} search={search} onAdd={addService} recentIds={recentIds} />
      </div>

      {receipt && (
        <ReceiptOverlay
          C={C}
          receipt={receipt}
          onDismiss={() => {
            // ٢٤/٨ (تدقيق ذاتيّ، مرآة POS.tsx): useModalFocus يعيد التركيز إلى «الزرّ الذي فتح الحوار»
            // = زرّ الدفع. سكانرُ/كيبورد الكاشير التالي يبتلعه الزرّ بلا أثر ⇒ إعادةٌ صريحة للبحث.
            setReceipt(null);
            setTimeout(() => searchRef.current?.focus(), 0);
          }}
          onPrint={() => {
            void printReceipt(buildBrandedReceipt(receipt)).then((printed) => {
              if (!printed.ok) setMessage({ kind: "err", text: "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة" });
            }).catch((error) => setMessage({ kind: "err", text: error instanceof Error ? error.message : "تعذّرت الطباعة" }));
          }}
        />
      )}
      {shifting && (
        <ShiftCloseDialog
          C={POS_COLORS}
          shift={shift}
          branchId={branchId}
          onClose={() => setShifting(false)}
          onClosed={() => {
            setShifting(false);
            void shiftQ.refetch();
          }}
          me={me.data}
          branches={branches.data}
        />

      )}
      {creditPrompt && (
        <CreditApprovalDialog C={C as any} message={creditPrompt} mgrEmail={mgrEmail} setMgrEmail={setMgrEmail} mgrPwd={mgrPwd} setMgrPwd={setMgrPwd}
          isPending={sale.isPending} onApprove={() => submit(false, { email: mgrEmail, password: mgrPwd })} onCancel={() => setCreditPrompt(null)} />
      )}
      <HeldOrdersDrawer
        open={heldDrawerOpen}
        onClose={() => setHeldDrawerOpen(false)}
        branchId={branchId}
        onEditOrder={handleEditHeldOrder}
        cashierName={me.data?.name ?? undefined}
        shiftId={shift?.id}
      />
    </div>
  );
}
