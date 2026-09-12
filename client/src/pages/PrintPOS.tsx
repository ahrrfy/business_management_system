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
  printDoc, printReceipt, isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter,
  getServerBridgeStatus, serverPrintTest, type ReceiptBrowserData,
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
import { Printer, Search, Sun, Moon, Power, Globe, Check, X, Receipt as ReceiptIcon, Banknote, CreditCard, RefreshCw, Zap, AlertTriangle, Pencil } from "lucide-react";
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
import { PrintCartList, type PrintCartLine as CartLine } from "@/components/printPos/PrintCartList";
import { PrintServiceGrid } from "@/components/printPos/PrintServiceGrid";
import { PrintShiftCloseDialog } from "@/components/printPos/PrintShiftCloseDialog";
import { createPortal } from "react-dom";

// ─── Types ──────────────────────────────────────────────────────────────────
type PaymentMethod = "CASH" | "CARD" | "TRANSFER";
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
  selUid: number | null;
  /** مرجع ومحاولة الدفع غير النقدي المؤكدة خادمياً. */
  paymentRef: string;
  externalPayment: ExternalPaymentDraft | null;
};

type Receipt = {
  num: string;
  invoiceId: number;
  date: string;
  printDate: string;
  printTime: string;
  cashier?: string;
  customer?: string;
  /** G3 (١١/٨): رقم وردية الطباعة — يُطبع في ترويسة الإيصال. */
  shiftId?: number | null;
  lines: { name: string; unit: string; qty: number; price: number; total: number }[];
  total: number;
  received: number;
  change: number;
  credit: number;
  method: string;
  isCredit: boolean;
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
  id, label: label ?? `طلب ${id}`, cart: [], payInput: "", method: "CASH", customerId: null, selUid: null, paymentRef: "", externalPayment: null,
});

function brandedReceipt(r: Receipt): ReceiptBrowserData {
  return {
    receiptNumber: r.num, date: r.printDate, time: r.printTime,
    cashierName: r.cashier ?? null, customerName: r.customer ?? null,
    shiftId: r.shiftId ?? null,
    items: r.lines.map((l) => ({ name: `${l.name} (${l.unit})`, quantity: l.qty, price: l.price, total: l.total })),
    subtotal: r.total, total: r.total, paid: r.received,
    change: r.isCredit ? null : r.change, credit: r.isCredit ? r.credit : null,
  };
}

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

  useEffect(() => {
    setHeaderActionsNode(document.getElementById("pos-header-actions"));
  }, []);
  // لقطة الإيصال تُلتقط لحظة الإرسال بقيم متّسقة مع ما يسجّله الخادم (نقد مقرّب) ⇒ لا إعادة حساب
  // من حالة لاحقة/سلة مُفرَّغة، ولا «باقي/آجل» وهميّ من فرق التقريب.
  const pendingRef = useRef<{
    lines: Receipt["lines"]; customerName?: string; method: PaymentMethod;
    cashTotal: number; received: number; change: number; credit: number; isCredit: boolean;
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
        num: r.invoiceNumber, invoiceId: r.invoiceId,
        date: fmtDateTime(now),
        printDate: fmtDate(now),
        printTime: fmtTime(now),
        cashier: me.data?.name ?? undefined, customer: p?.customerName,
        // Codex P2: تفضيل shiftId من الفاتورة المُثبَّتة (idempotent replay بعد إغلاق وردية).
        shiftId: (r as { shiftId?: number | null }).shiftId ?? shift?.id ?? null,
        lines: p?.lines ?? [],
        total: p?.cashTotal ?? 0, received: p?.received ?? 0, change: p?.change ?? 0,
        credit: p?.credit ?? 0, method: METHOD_LABEL[p?.method ?? "CASH"], isCredit: p?.isCredit ?? false,
      };
      setReceipt(rec);
      setLastInv({ num: r.invoiceNumber, total: p?.cashTotal ?? 0 });
      setCart([]); setPayInput(""); patch({ selUid: null, paymentRef: "", externalPayment: null });
      setClientRequestId(crypto.randomUUID());
      const printed = await printReceipt(brandedReceipt(rec));
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
      num: receiptNumber,
      invoiceId: 0, // لا فاتورة رسميّة بعد — الطباعة تستعمل الرقم المؤقّت.
      date: fmtDateTime(now),
      printDate: fmtDate(now),
      printTime: fmtTime(now),
      cashier: me.data?.name ?? undefined,
      customer: selectedCustomer?.name,
      shiftId: shift?.id ?? null,
      lines: cart.map((c) => ({ name: c.svc.productName, unit: c.svc.unitName, qty: c.qty, price: c.price, total: c.price * c.qty })),
      total: cashTotal,
      received: paid,
      change: Math.max(0, paid - cashTotal),
      credit: 0,
      method: METHOD_LABEL.CASH,
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
    void printReceipt(brandedReceipt(rec)).then((printed) => {
      if (!printed.ok) setMessage({ kind: "err", text: `حُفظ الإيصال المؤقت ${receiptNumber}، لكن حجب المتصفح نافذة الطباعة` });
    }).catch(() => { /* فشل الطابعة لا يُلغي التقاطاً التزم محلياً */ });
    return true;
  }

  function submit(forceFullPayment: boolean, approval?: { email: string; password: string }) {
    if (!shift || !cart.length || sale.isPending) return;
    setMessage(null);
    if (offline) {
      void captureOfflinePrintSale(forceFullPayment);
      return;
    }
    // Quick pay means full payment, not a forced change of the selected method to CASH.
    const method: PaymentMethod = tab.method;
    const confirmedForAmount = forceFullPayment ? externalFullPaymentConfirmed : externalPaymentConfirmed;
    if (method !== "CASH" && !confirmedForAmount) {
      setMessage({ kind: "err", text: "أدخل مرجع العملية وثبّت نجاح الدفع لدى المزوّد للمبلغ الحالي قبل الإتمام." });
      return;
    }
    const cashTotal = method === "CASH" ? riqd(total) : total;
    const paid = forceFullPayment ? cashTotal : Number(tab.payInput || 0);
    const isCredit = !forceFullPayment && paid > 0 && paid < cashTotal;
    if (isCredit && tab.customerId == null) {
      setMessage({ kind: "err", text: "البيع الآجل يتطلّب اختيار عميل." });
      return;
    }
    const cashFull = method === "CASH" && !isCredit;
    const amount = isCredit ? paid.toFixed(2) : total.toFixed(2);
    // النقد المُسلَّم فعلاً: للدفع الكامل بلا إدخال = الإجمالي المقرّب (لا باقي)؛ ومع إدخالٍ صريح = المُدخَل.
    const tendered = forceFullPayment ? cashTotal : (tab.payInput === "" ? cashTotal : paid);
    pendingRef.current = {
      lines: cart.map((c) => ({ name: c.svc.productName, unit: c.svc.unitName, qty: c.qty, price: c.price, total: c.price * c.qty })),
      customerName: selectedCustomer?.name,
      method, cashTotal,
      received: isCredit ? paid : cashTotal, // ما يسجّله الخادم paidAmount (نقد كامل = المقرّب)
      change: isCredit ? 0 : Math.max(0, tendered - cashTotal),
      credit: isCredit ? cashTotal - paid : 0,
      isCredit,
    };
    sale.mutate({
      branchId, shiftId: shift.id, clientRequestId,
      ...(method !== "CASH" && tab.externalPayment?.deviceId ? { deviceId: tab.externalPayment.deviceId } : {}),
      customerId: tab.customerId ?? undefined, priceTier: "RETAIL",
      lines: cart.map((c) => ({
        variantId: c.svc.variantId, productUnitId: c.svc.productUnitId,
        quantity: String(c.qty), unitPriceOverride: c.price.toFixed(2),
      })),
      payment: {
        amount,
        method,
        ...(method !== "CASH" ? { externalPaymentAttemptId: tab.externalPayment!.attemptId! } : {}),
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
      await printDoc({
        kind: "opening", title: SHOP, subtitle: "بيان الرصيد الافتتاحي — قسم الطباعة",
        meta: [`وردية #${res.shiftId}`, fmtDateTime(new Date())],
        totals: [{ label: "الرصيد الافتتاحي", value: fmt(Number(opening || 0)) }],
        footer: "بداية الوردية",
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
      <Header C={C} dark={dark} toggleDark={toggleDark} search={search} setSearch={setSearch} searchRef={searchRef}
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
        {tabs.length < 6 && <button aria-label="طلب طباعة جديد" onClick={addTab} style={{ width: 44, height: 44, borderRadius: 9, background: C.card, border: `1.5px dashed ${C.border}`, cursor: "pointer", fontSize: 22, color: C.mutedFg, flexShrink: 0 }}>+</button>}
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
          payInput={tab.payInput} setPayInput={setPayInput} method={tab.method} setMethod={(m) => patch({ method: m, externalPayment: null })}
          paymentRef={tab.paymentRef ?? ""} setPaymentRef={(v) => patch({ paymentRef: v, externalPayment: null })}
          externalPaymentConfirmed={externalPaymentConfirmed}
          externalFullPaymentConfirmed={externalFullPaymentConfirmed}
          externalPaymentPending={initiateExternalPayment.isPending || confirmExternalPaymentMutation.isPending}
          onConfirmExternalPayment={() => { void confirmCurrentExternalPayment(); }}
          numPress={numPress} onPay={() => submit(false)} onQuickPay={() => submit(true)} isPending={sale.isPending}
          addTick={addTick}
        />
        <PrintServiceGrid C={C} services={services} loading={servicesQ.isLoading} cats={cats} catId={effectiveCatId} setCatId={setCatId} search={search} onAdd={addService} recentIds={recentIds} />
      </div>

      {receipt && <ReceiptOverlay C={C} receipt={receipt} onDismiss={() => {
        // ٢٤/٨ (تدقيق ذاتيّ، مرآة POS.tsx): useModalFocus يعيد التركيز إلى «الزرّ الذي فتح الحوار»
        // = زرّ الدفع. سكانرُ/كيبورد الكاشير التالي يبتلعه الزرّ بلا أثر ⇒ إعادةٌ صريحة للبحث.
        setReceipt(null);
        setTimeout(() => searchRef.current?.focus(), 0);
      }} onPrint={() => printReceipt(brandedReceipt(receipt)).then((printed) => {
        if (!printed.ok) setMessage({ kind: "err", text: "حجب المتصفح نافذة الطباعة؛ اسمح بالنوافذ المنبثقة ثم أعد المحاولة" });
      }).catch((error) => setMessage({ kind: "err", text: error instanceof Error ? error.message : "تعذّرت الطباعة" }))} />}
      {shifting && <PrintShiftCloseDialog C={C} shift={shift} isElevatedRole={isElevatedRole} onClose={() => setShifting(false)} onClosed={() => { setShifting(false); shiftQ.refetch(); }} />}
      {creditPrompt && (
        <CreditApprovalDialog C={C as any} message={creditPrompt} mgrEmail={mgrEmail} setMgrEmail={setMgrEmail} mgrPwd={mgrPwd} setMgrPwd={setMgrPwd}
          isPending={sale.isPending} onApprove={() => submit(false, { email: mgrEmail, password: mgrPwd })} onCancel={() => setCreditPrompt(null)} />
      )}
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function PrintPosHeaderActions({
  C,
  shiftId,
  userRole,
  onCloseShift,
  printerReady,
  onConnectPrinter,
  bridgeEnabled,
  bridgeDesc,
  onTestPrint,
}: {
  C: C;
  shiftId: number;
  userRole?: string | null;
  onCloseShift: () => void;
  printerReady: boolean;
  onConnectPrinter: () => void;
  bridgeEnabled: boolean;
  bridgeDesc: string;
  onTestPrint: () => void;
}) {
  return (
    <>
      <span className="inline-flex h-[var(--ui-control)] shrink-0 items-center rounded-lg border bg-muted/40 px-2.5 text-xs font-bold text-muted-foreground">
        <span aria-hidden className="me-1.5 size-2 rounded-full bg-[var(--sem-pos)]" />
        وردية #{shiftId}
      </span>
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
          aria-label={printerReady ? "الطابعة مربوطة" : "ربط الطابعة الحرارية"}
          className="inline-flex size-[var(--ui-control)] shrink-0 items-center justify-center rounded-lg border"
          style={{ color: printerReady ? C.success : C.mutedFg, borderColor: printerReady ? C.success : C.border }}
        >
          <Printer aria-hidden size={16} />
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

function Header({ C, dark, toggleDark, search, setSearch, searchRef, lastInv }: {
  C: C; dark: boolean; toggleDark: () => void; search: string; setSearch: (s: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  lastInv: { num: string; total: number } | null;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "7px 14px", minHeight: 64, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 40 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden>
          <Printer size={20} />
        </div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 11, color: C.mutedFg, lineHeight: 1.3 }}>{DEPT}</div>
        </div>
      </div>
      <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />
      <div style={{ flex: "1 1 460px", minWidth: 240, position: "relative", display: "flex", alignItems: "center" }}>
        <span style={{ position: "absolute", right: 13, color: C.mutedFg, pointerEvents: "none", display: "flex", alignItems: "center" }} aria-hidden>
          <Search size={16} />
        </span>
        {/* ٢٤/٨ (تدقيق ذاتيّ): `autoFocus` مفقود — POS و Reception يُركّزان الحقل، لكن PrintPOS
            كان يُلزم الكاشير بالنقر قبل أوّل مسحٍ/كتابة. توحيدُ السلوك عبر الشاشات الثلاث. */}
        <input ref={searchRef} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن خدمة بالاسم أو الرمز… (F2)"
          style={{ width: "100%", height: 46, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14, outline: "none", paddingRight: 42, paddingLeft: search ? 36 : 14 }}
          onFocus={(e) => (e.target.style.borderColor = C.primary)} onBlur={(e) => (e.target.style.borderColor = C.border)} />
        {search && <button onClick={() => setSearch("")} aria-label="مسح البحث" style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, padding: 4, display: "inline-flex" }}><X aria-hidden size={15} /></button>}
      </div>
      {lastInv && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, background: C.primarySoft, border: `1px solid ${C.primary}`, borderRadius: 9, padding: "3px 6px 3px 13px", flexShrink: 0, lineHeight: 1.3 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
            <span style={{ fontSize: 15, fontWeight: 900, direction: "ltr", color: C.primary }}>{fmt(lastInv.total)} د.ع</span>
            <span style={{ fontSize: 9.5, color: C.mutedFg }}>{lastInv.num}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <CopyButton value={lastInv.num} title="نسخ رقم آخر فاتورة" successMessage="تم نسخ رقم الفاتورة" />
            <CopyButton value={lastInv.total} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}
      <button onClick={toggleDark} title="تبديل الوضع الليلي" aria-label="تبديل الوضع الليلي" style={{ width: 42, height: 42, borderRadius: 9, background: "none", border: `1.5px solid ${C.border}`, cursor: "pointer", color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
      </button>
    </div>
  );
}

// ─── CheckoutColumn = PrintCartList (فوق) + PaymentBlock (تحت) ───────────────
interface CheckoutProps {
  C: C; cart: CartLine[]; total: number; selUid: number | null; setSelUid: (id: number | null) => void;
  changeQty: (uid: number, q: number) => void; removeRow: (uid: number) => void; onClear: () => void;
  setPrice: (uid: number, p: number) => void; editPriceUid: number | null; setEditPriceUid: (id: number | null) => void;
  customerId: number | null; setCustomerId: (id: number | null) => void;
  payInput: string; setPayInput: (u: string | ((s: string) => string)) => void; method: PaymentMethod; setMethod: (m: PaymentMethod) => void;
  paymentRef: string; setPaymentRef: (v: string) => void;
  externalPaymentConfirmed: boolean; externalFullPaymentConfirmed: boolean;
  externalPaymentPending: boolean; onConfirmExternalPayment: () => void;
  numPress: (k: string) => void; onPay: () => void; onQuickPay: () => void; isPending: boolean;
  /** ٢٤/٨ — عدّاد إضافةٍ صريح: يشغّل التمريرَ إلى السطر الفعّال في `CartList`. */
  addTick: number;
}

const fluid = (min: number, ratio: number, max: number) => `clamp(${min}px, ${ratio}vh, ${max}px)`;

function CheckoutColumn(props: CheckoutProps) {
  return (
    <div style={{ width: 480, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <PrintCartList {...props} />
      <PaymentBlock {...props} />
    </div>
  );
}

function PaymentBlock({ C, total, payInput, setPayInput, method, setMethod, paymentRef, setPaymentRef, externalPaymentConfirmed, externalFullPaymentConfirmed, externalPaymentPending, onConfirmExternalPayment, onPay, onQuickPay, cart, customerId, isPending }: CheckoutProps) {
  // ٢٥/٨ (بلاغ المالك): أُزيلت الحاسبة (numpad + QUICK + Calculator toggle) كلّياً — الحقلُ نصّيٌّ
  // يقبل الكتابة المباشرة من لوحة المفاتيح، والقبول اللمسيّ عبر الكيبورد الافتراضي
  // (inputMode="decimal"). الفضاء المُحرَّر يصعد إلى السلّة وأزرار الدفع الأساسية.
  //
  // ٢٤/٨ (Codex P1 v2 على PR #741): حقلُ المبلغ يفصل «العرض» عن «القيمة الملتزمة» — نفس نمط
  // POS/Reception. أثناء الكتابة الوسيطة (`1,` قبل `1,5`) الحرفُ يبقى في الحقل والقيمةُ الملتزمة
  // (`payInput` المُرسَلة إلى الحساب) لا تتغيّر إلّا حين تكون غير ملتبسة. لولا هذا: `1` ثمّ `,` ثمّ
  // `5` كان يُلتزم `15` بدل `1.5` (React يعيد رسمَ الحقل بـpayInput=`1` فيبتلع `,`).
  const [displayPay, setDisplayPay] = useState(payInput);
  useEffect(() => {
    try {
      const norm = normalizeNumberInput(displayPay).normalized;
      if (norm !== payInput) setDisplayPay(payInput);
    } catch { setDisplayPay(payInput); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payInput]);
  const cartLen = cart.length;
  const paid = Number(payInput || 0);
  const cashTotal = method === "CASH" ? riqd(total) : total;
  const change = paid - cashTotal;
  const credit = cashTotal - paid;
  const isChange = paid > 0 && paid >= cashTotal;
  const isOwing = paid > 0 && paid < cashTotal;
  // حارس: لا بيع بسطرٍ بسعر صفر (خدمة سعرها يدوي لم يُدخَل) — يمنع فاتورة مجانية بالخطأ.
  const hasZeroLine = cart.some((c) => c.price <= 0);
  // حافظ على عقد PrintPOS السابق: الدفعة الجزئية لا تُنشأ من هذه الشاشة؛ الحارس الجديد
  // يضيف تأكيد غير النقدي فقط ولا يوسّع سلوك النقد/الآجل.
  const canPay = cartLen > 0 && !hasZeroLine && (payInput === "" || paid >= cashTotal) && (!isOwing || customerId != null) && externalPaymentConfirmed;
  const canQuickPay = cartLen > 0 && !hasZeroLine && externalFullPaymentConfirmed;

  const Method = ({ m, Icon, label, disabled = false }: { m: PaymentMethod; Icon: React.ComponentType<{ "aria-hidden"?: boolean; size?: number }>; label: string; disabled?: boolean }) => (
    <button onClick={disabled ? undefined : () => setMethod(m)} disabled={disabled}
      aria-describedby={disabled ? "print-pos-external-payment-proof" : undefined}
      title={disabled ? POS_EXTERNAL_PAYMENT_PROOF_HINT : label}
      style={{ flex: 1, minHeight: fluid(44, 5.6, 50), display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: `2px solid ${method === m ? C.primary : C.border}`, borderRadius: 10, background: method === m ? C.primary : C.card, color: method === m ? C.primaryFg : C.fg, fontWeight: 800, fontSize: 13.5, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, fontFamily: "inherit", touchAction: "manipulation" }}>
      <Icon aria-hidden size={19} />{label}
    </button>
  );

  // ٢٥/٨: بعد إزالة الحاسبة، PaymentBlock صار مضغوطاً — يكفيه ~٢٤٠px (إجمالي + حقل + طرق دفع +
  // مرجع + أزرار الإتمام). السقفُ ٣٥٪ يترك ٦٥٪ للسلّة (كانت ٥٦-٤٢٪ سابقاً) ⇒ السلّة تحصل على
  // ~٤٠-٥٠٪ زيادة في الارتفاع، وأزرار الدفع/التحصيل/الطباعة تبقى بارزة لا مضغوطة.
  return (
    <div style={{ flexShrink: 0, minHeight: 240, maxHeight: "38%", display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ padding: "7px 16px", background: C.primary, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 13.5, color: C.primaryFg, fontWeight: 700, opacity: 0.92 }}>الإجمالي</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: fluid(20, 2.9, 27), fontWeight: 900, direction: "ltr", letterSpacing: "-1px", color: C.primaryFg }}>{fmt(total)}</span>
          <span style={{ fontSize: 12.5, color: C.primaryFg, opacity: 0.85 }}>د.ع</span>
        </div>
      </div>
      {/* منطقة الإدخال — الوحيدة القابلة للتمرير؛ الإجمالي فوقها وأزرار الدفع تحتها ثابتان. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "8px 12px 0" }}>
        {/* ٢٥/٨: أُزيلت الحاسبة كاملةً — الحقل نصّيٌّ مباشر يقبل الكتابة من الكيبورد أو اللمس
            عبر inputMode="decimal". زرّ «=الكل» يبقى أعلى الحقل لتعبئة المبلغ الإجمالي بضغطة. */}
        <div style={{ background: C.muted, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "5px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: fluid(38, 5, 46), marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: C.mutedFg, flexShrink: 0, fontWeight: 700 }}>المبلغ المستلم</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setPayInput(String(cashTotal))}
              disabled={!cartLen}
              title="عبّئ المبلغ الإجماليّ"
              style={{ height: 30, padding: "0 10px", border: `1.5px solid ${C.primary}`, borderRadius: 8, background: C.primarySoft, color: C.primary, fontFamily: "inherit", fontSize: 12, fontWeight: 800, cursor: cartLen ? "pointer" : "not-allowed", opacity: cartLen ? 1 : 0.5, flexShrink: 0, touchAction: "manipulation" }}
            >
              = الكل
            </button>
            <input
              type="text"
              inputMode="decimal"
              value={displayPay}
              onChange={(e) => {
                const src = e.target.value;
                setDisplayPay(src);
                if (src === "") { setPayInput(""); return; }
                if (!/^[\d.,،٫]*$/.test(src)) return;
                const result = normalizeNumberInput(src);
                if (result.ambiguous) return;
                const n = result.normalized;
                if (!n) return;
                if (!/^\d+\.?\d*$|^\d*\.\d+$/.test(n)) return;
                if (!Number.isFinite(Number(n))) return;
                setPayInput(n);
              }}
              onFocus={(e) => e.currentTarget.select()}
              placeholder="0"
              aria-label="المبلغ المستلم"
              style={{ flex: 1, minWidth: 0, maxWidth: 200, border: "none", outline: "none", background: "transparent", fontSize: fluid(19, 2.6, 24), fontWeight: 900, direction: "ltr", textAlign: "left", fontFamily: "inherit", color: payInput ? (isOwing ? C.amber : C.primary) : C.fg }}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <Method m="CASH" Icon={Banknote} label="نقدي" />
          <Method m="CARD" Icon={CreditCard} label="بطاقة" />
          <Method m="TRANSFER" Icon={RefreshCw} label="تحويل" />
        </div>
        {method !== "CASH" && (
          <div id="print-pos-external-payment-proof" role="status" style={{ marginBottom: 6, display: "flex", alignItems: "flex-start", gap: 5, color: C.mutedFg, fontSize: 11.5, fontWeight: 700, lineHeight: 1.5 }}>
            <AlertTriangle aria-hidden size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{POS_EXTERNAL_PAYMENT_PROOF_HINT}</span>
          </div>
        )}
        {/* مرجع ومحاولة الدفع غير النقدي — CONFIRMED قبل إنشاء الفاتورة. */}
        <PaymentReferenceField
          value={paymentRef}
          onChange={setPaymentRef}
          method={method}
          confirmed={externalPaymentConfirmed}
          confirming={externalPaymentPending}
          onConfirm={onConfirmExternalPayment}
          inputId="print-pos-payment-reference"
          colors={{ border: C.border, muted: C.muted, mutedFg: C.mutedFg, fg: C.fg, amber: C.amber, success: C.success }}
          style={{ marginBottom: 6 }}
        />

        </div>{/* ← نهاية منطقة الإدخال القابلة للتمرير */}

        {/* منطقة الفعل — خارج التمرير ولا تنكمش: زرّا الدفع يبقيان ظاهرَين مهما بلغ الزوم. */}
        <div style={{ flexShrink: 0, padding: "6px 10px 9px", borderTop: `1px solid ${C.border}` }}>
        <div style={{ minHeight: 24, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          {!cartLen && <span style={{ fontSize: 12.5, color: C.mutedFg }}>اختر خدمة للبدء</span>}
          {cartLen > 0 && hasZeroLine && <span style={{ fontSize: 12, color: C.amber, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>أدخل سعراً للخدمات ذات السعر اليدوي (<Pencil aria-hidden size={11} />)</span>}
          {cartLen > 0 && !hasZeroLine && !payInput && <span style={{ fontSize: 12, color: C.mutedFg }}>{method === "CASH" && cashTotal !== total ? `نقداً يُقرَّب إلى ${fmt(cashTotal)} د.ع` : "أدخل المبلغ أو «إتمام» للدفع الكامل"}</span>}
          {cartLen > 0 && !!payInput && isChange && (<><span style={{ fontSize: 13, color: C.mutedFg, fontWeight: 600 }}>الباقي للعميل</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 21, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span><CopyButton value={change} title="نسخ الباقي" successMessage="تم نسخ الباقي" /></span></>)}
          {cartLen > 0 && !!payInput && isOwing && (<><span style={{ fontSize: 13, color: C.amber, fontWeight: 600 }}>المتبقي (آجل)</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 21, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12, fontWeight: 500 }}>د.ع</span></span><CopyButton value={credit} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" /></span></>)}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <button disabled={!canQuickPay || isPending} onClick={onQuickPay}
            title={
              // ٢٤/٨ (نمط Odoo — بلاغ فحص UX): `title` يعلن سبب التعطيل بدل الحيرة.
              isPending ? ACTION_LABELS.saving :
              !cartLen ? "أضف خدمة أوّلاً" :
              hasZeroLine ? "أدخل سعراً للخدمات ذات السعر اليدوي" :
              !externalFullPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
              `دفع سريع وطباعة — ${METHOD_LABEL[method]}`
            }
            style={{ width: 116, height: fluid(48, 6, 54), background: canQuickPay && !isPending ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))" : C.muted, color: canQuickPay && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 11, fontFamily: "inherit", fontSize: 13.5, fontWeight: 900, cursor: canQuickPay && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, touchAction: "manipulation" }}>
            <Zap aria-hidden size={17} />دفع سريع ({METHOD_LABEL[method]})
          </button>
          <button disabled={!canPay || isPending} onClick={onPay}
            title={
              isPending ? ACTION_LABELS.saving :
              !cartLen ? "أضف خدمة أوّلاً" :
              hasZeroLine ? "أدخل سعراً للخدمات ذات السعر اليدوي" :
              isOwing && customerId == null ? "الآجل يحتاج عميلاً مرتبطاً — أو اكمل المبلغ" :
              !externalPaymentConfirmed ? "أكمل مرجع الدفع الخارجي وتأكيده" :
              `إتمام الدفع — ${fmt(total)} د.ع`
            }
            style={{ flex: 1, height: fluid(48, 6, 54), background: canPay && !isPending ? C.success : C.muted, color: canPay && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 11, fontFamily: "inherit", fontSize: 16, fontWeight: 900, cursor: canPay && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, touchAction: "manipulation" }}>
            {isPending
              ? "جارٍ…"
              : !cartLen
                ? "الفاتورة فارغة"
                : <><Check aria-hidden size={18} strokeWidth={3} /> إتمام الدفع <kbd style={{ background: "rgba(255,255,255,.22)", color: "#fff", borderRadius: 4, padding: "1px 6px", fontFamily: "monospace", fontSize: 10, fontWeight: 700 }}>F4</kbd></>}
          </button>
        </div>
        {/* ٢٤/٨ (تدقيق ذاتيّ): تلميحُ الاختصارات ظاهرٌ على كلّ الأحجام — الكاشير يحتاجها يومياً. */}
        <div style={{ textAlign: "center", marginTop: 4, fontSize: 10, color: C.mutedFg, opacity: 0.85 }}>
          F4 للدفع · F2 للبحث · F12 للتفريغ · Esc للإغلاق
        </div>
      </div>
    </div>
  );
}

