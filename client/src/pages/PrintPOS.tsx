/**
 * نقطة بيع قسم الطباعة والاستنساخ — شاشة خدمات باللمسة الواحدة.
 * تصميم Claude Design المعتمد: السلة فوق ← الدفع/لوحة الأرقام تحتها (عمود واحد يمين) ← الخدمات بطاقات يسار.
 * تُباع الخدمات بنقرة (بلا باركود)، السعر قابل للتعديل، والمواد (ورق/حبر) تُخصم بصمت خلف الكواليس
 * (الكلفة شأن إداري لا يراه الكاشير). إيصال حراري ٨٠mm + وردية + تقريب نقدي IQD — كنظامك تماماً.
 */
import { confirm } from "@/lib/confirm";
import { D, roundCashIQD } from "@/lib/money";
import {
  printDoc, printReceipt, isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter,
  getServerBridgeStatus, serverPrintTest, type ReceiptBrowserData,
} from "@/lib/printing/print";
import { categoryIcon, isCustomPriceSku, serviceIcon } from "@/lib/printServices";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useOpeningContinuity, OpeningContinuityInline } from "@/components/treasury/useOpeningContinuity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Printer, Search, Sun, Moon, Power, Globe, Check, X, Receipt as ReceiptIcon, User, Banknote, CreditCard, RefreshCw, Zap, AlertTriangle, Pencil } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { notify } from "@/lib/notify";
import { ShiftHandoverSection, buildHandoverPayload, handoverIncomplete, emptyHandover, type ShiftHandoverValue } from "@/components/pos/ShiftHandoverSection";

// ─── Types ──────────────────────────────────────────────────────────────────
type PaymentMethod = "CASH" | "CARD" | "TRANSFER";
type Svc = RouterOutputs["printPos"]["services"][number];
type ShiftData = RouterOutputs["shifts"]["current"];

type CartLine = { uid: number; svc: Svc; qty: number; price: number };
type Tab = {
  id: number;
  label: string;
  cart: CartLine[];
  payInput: string;
  method: PaymentMethod;
  customerId: number | null;
  selUid: number | null;
};

type Receipt = {
  num: string;
  invoiceId: number;
  date: string;
  printDate: string;
  printTime: string;
  cashier?: string;
  customer?: string;
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

// ─── رموز الألوان (مطابقة لـ POS.tsx) ─────────────────────────────────────────
const LIGHT = {
  bg: "oklch(0.985 0.002 247.858)", card: "#fff", border: "oklch(0.922 0.004 247.858)",
  muted: "oklch(0.962 0.004 247.858)", mutedFg: "oklch(0.552 0.016 285.938)", fg: "oklch(0.235 0.015 65)",
  primary: "oklch(0.488 0.243 264.376)", primaryFg: "#fff", primarySoft: "oklch(0.94 0.04 264.376)",
  success: "oklch(0.50 0.13 155)", amber: "oklch(0.65 0.15 75)", danger: "oklch(0.577 0.245 27.325)",
  numKey: "oklch(0.962 0.004 247.858)", delKey: "oklch(0.92 0.05 20)", delFg: "oklch(0.50 0.22 25)",
  overlay: "oklch(0.15 0.01 265 / .88)",
};
const DARK = {
  bg: "oklch(0.14 0.010 65)", card: "oklch(0.20 0.012 65)", border: "oklch(1 0 0 / 0.12)",
  muted: "oklch(0.22 0.012 65)", mutedFg: "oklch(0.72 0.010 247)", fg: "oklch(1 0 0)",
  primary: "oklch(0.55 0.22 264)", primaryFg: "#fff", primarySoft: "oklch(0.28 0.06 264)",
  success: "oklch(0.55 0.14 155)", amber: "oklch(0.72 0.15 75)", danger: "oklch(0.65 0.22 27)",
  numKey: "oklch(0.24 0.010 65)", delKey: "oklch(0.26 0.05 20)", delFg: "oklch(0.75 0.22 25)",
  overlay: "oklch(0.08 0.01 265 / .92)",
};
type C = typeof LIGHT;

const SHOP = "الرؤية العربية";
const DEPT = "قسم الطباعة والاستنساخ";
const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "نقدي", CARD: "بطاقة", TRANSFER: "تحويل" };
const QUICK = [5000, 10000, 25000, 50000];
const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
const riqd = (n: number) => roundCashIQD(n).toNumber();

let TAB_SEQ = 2;
let UID = 1;
const newTab = (id: number, label?: string): Tab => ({
  id, label: label ?? `طلب ${id}`, cart: [], payInput: "", method: "CASH", customerId: null, selUid: null,
});

function brandedReceipt(r: Receipt): ReceiptBrowserData {
  return {
    receiptNumber: r.num, date: r.printDate, time: r.printTime,
    cashierName: r.cashier ?? null, customerName: r.customer ?? null,
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

  // قسم الطباعة: بيع فوري عبر درج التجزئة (RETAIL).
  const shiftQ = trpc.shifts.current.useQuery({ branchId, shiftType: "RETAIL" });
  const shift = shiftQ.data;

  const servicesQ = trpc.printPos.services.useQuery({ tier: "RETAIL" });
  const services = useMemo(() => servicesQ.data ?? [], [servicesQ.data]);

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
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cart = tab.cart;
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);

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
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [printerReady, setPrinterReady] = useState(isPaired());
  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });
  const searchRef = useRef<HTMLInputElement>(null);
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

  // ── تبويبات ──
  const patch = (p: Partial<Tab>) => setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, ...p } : t)));
  const setCart = (u: CartLine[] | ((c: CartLine[]) => CartLine[])) =>
    setTabs((prev) => prev.map((t) => (t.id !== activeId ? t : { ...t, cart: typeof u === "function" ? u(t.cart) : u })));
  const setPayInput = (u: string | ((s: string) => string)) =>
    setTabs((prev) => prev.map((t) => (t.id !== activeId ? t : { ...t, payInput: typeof u === "function" ? u(t.payInput) : u })));

  function addTab() { const id = TAB_SEQ++; setTabs((p) => [...p, newTab(id)]); setActiveId(id); }
  function closeTab(id: number) {
    if (tabs.length <= 1) return;
    setTabs((p) => { const n = p.filter((t) => t.id !== id); if (activeId === id) setActiveId(n[n.length - 1].id); return n; });
  }

  // ── عمليات السلة ──
  function addService(svc: Svc) {
    if (receipt) setReceipt(null);
    setMessage(null);
    const custom = isCustomPriceSku(svc.sku);
    setCart((prev) => {
      const i = prev.findIndex((c) => c.svc.productUnitId === svc.productUnitId);
      if (i >= 0 && !custom) { const n = [...prev]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; }
      const uid = UID++;
      if (custom) setTimeout(() => setEditPriceUid(uid), 30);
      patch({ selUid: uid });
      return [...prev, { uid, svc, qty: 1, price: Number(svc.price ?? 0) }];
    });
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
        date: now.toLocaleString("ar-IQ-u-nu-latn"),
        printDate: now.toLocaleDateString("en-GB"),
        printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        cashier: me.data?.name ?? undefined, customer: p?.customerName,
        lines: p?.lines ?? [],
        total: p?.cashTotal ?? 0, received: p?.received ?? 0, change: p?.change ?? 0,
        credit: p?.credit ?? 0, method: METHOD_LABEL[p?.method ?? "CASH"], isCredit: p?.isCredit ?? false,
      };
      setReceipt(rec);
      setLastInv({ num: r.invoiceNumber, total: p?.cashTotal ?? 0 });
      setMessage({ kind: "ok", text: `تمّ البيع — فاتورة ${r.invoiceNumber}` });
      setCart([]); setPayInput(""); patch({ selUid: null });
      setClientRequestId(crypto.randomUUID());
      await printReceipt(brandedReceipt(rec));
      await Promise.all([utils.printPos.services.invalidate(), shiftQ.refetch()]);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
    },
    onError: (e) => {
      if ((e.data as { code?: string } | undefined)?.code === "PRECONDITION_FAILED") setCreditPrompt(e.message);
      else setMessage({ kind: "err", text: e.message });
    },
  });

  function submit(forceCashFull: boolean, approval?: { email: string; password: string }) {
    if (!shift || !cart.length || sale.isPending) return;
    setMessage(null);
    const method: PaymentMethod = forceCashFull ? "CASH" : tab.method;
    const cashTotal = method === "CASH" ? riqd(total) : total;
    const paid = forceCashFull ? cashTotal : Number(tab.payInput || 0);
    const isCredit = !forceCashFull && paid > 0 && paid < cashTotal;
    if (isCredit && tab.customerId == null) {
      setMessage({ kind: "err", text: "البيع الآجل يتطلّب اختيار عميل." });
      return;
    }
    const cashFull = method === "CASH" && !isCredit;
    const amount = isCredit ? paid.toFixed(2) : total.toFixed(2);
    // النقد المُسلَّم فعلاً: للدفع الكامل بلا إدخال = الإجمالي المقرّب (لا باقي)؛ ومع إدخالٍ صريح = المُدخَل.
    const tendered = forceCashFull ? cashTotal : (tab.payInput === "" ? cashTotal : paid);
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
      customerId: tab.customerId ?? undefined, priceTier: "RETAIL",
      lines: cart.map((c) => ({
        variantId: c.svc.variantId, productUnitId: c.svc.productUnitId,
        quantity: String(c.qty), unitPriceOverride: c.price.toFixed(2),
      })),
      payment: { amount, method },
      ...(cashFull ? { cashRoundIQD: true } : {}),
      ...(approval ? { managerApproval: approval } : {}),
    });
  }

  const openShift = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      await printDoc({
        kind: "opening", title: SHOP, subtitle: "بيان الرصيد الافتتاحي — قسم الطباعة",
        meta: [`وردية #${res.shiftId}`, new Date().toLocaleString("ar-IQ-u-nu-latn")],
        totals: [{ label: "الرصيد الافتتاحي", value: fmt(Number(opening || 0)) }],
        footer: "بداية الوردية",
      });
    },
    onError: (e) => setMessage({ kind: "err", text: e.message }),
  });

  // ①ج استمرارية نقد الورديات: المتوقَّع = متبقّي آخر وردية RETAIL مغلقة لهذا الفرع (يُطابق المُدخَل).
  const openingCont = useOpeningContinuity({ branchId, shiftType: "RETAIL", opening, enabled: !shift });

  // ── اختصارات ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt) { if (e.key === "Escape" || e.key === "Enter") setReceipt(null); return; }
      if (shifting) { if (e.key === "Escape") setShifting(false); return; }
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "F4") { e.preventDefault(); submit(false); }
      else if (e.key === "F12") { e.preventDefault(); void clearCart(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sale.isPending, receipt, creditPrompt, shifting, tab.method, tab.payInput, total]);

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
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.mutedFg, fontFamily: "'Cairo', system-ui, sans-serif", direction: "rtl" }}>جارٍ التحميل…</div>;
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
              <select
                value={pickedBranch ?? ""}
                onChange={(e) => setPickedBranch(e.target.value ? Number(e.target.value) : null)}
                style={{ width: "100%", height: 48, border: `1.5px solid ${pickedBranch == null ? C.danger : C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 15, fontWeight: 700, padding: "0 12px", outline: "none", boxSizing: "border-box", marginBottom: 16 }}
              >
                <option value="">— اختر الفرع —</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الرصيد الافتتاحي للصندوق (د.ع)</label>
          <input dir="ltr" value={opening} onChange={(e) => setOpening(e.target.value.replace(/[^0-9]/g, ""))}
            style={{ width: "100%", height: 48, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 18, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box", marginBottom: 16 }} />
          {message && <div style={{ fontSize: 13, color: message.kind === "ok" ? C.success : C.danger, marginBottom: 12 }}>{message.text}</div>}
          <OpeningContinuityInline C={C} oc={openingCont} />
          <button disabled={openShift.isPending || needsBranchChoice || openingCont.blocked} onClick={() => openShift.mutate({ branchId, openingBalance: opening || "0", shiftType: "RETAIL", openingDiscrepancyReason: openingCont.reasonPayload })}
            style={{ width: "100%", height: 52, background: openShift.isPending || needsBranchChoice || openingCont.blocked ? C.muted : C.primary, color: openShift.isPending || needsBranchChoice || openingCont.blocked ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 10, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: openShift.isPending || needsBranchChoice || openingCont.blocked ? "not-allowed" : "pointer" }}>
            {openShift.isPending ? "جارٍ الفتح…" : needsBranchChoice ? "اختر الفرع أولاً" : "فتح الوردية"}
          </button>
          <Link href="/" style={{ display: "block", textAlign: "center", marginTop: 14, fontSize: 13, color: C.mutedFg }}>← الرئيسية</Link>
        </div>
      </div>
    );
  }

  // ── الشاشة الرئيسية ──
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>
      <Header C={C} dark={dark} toggleDark={toggleDark} search={search} setSearch={setSearch} searchRef={searchRef}
        me={me.data} shiftId={shift.id} lastInv={lastInv} onCloseShift={() => setShifting(true)}
        printerReady={printerReady} onConnectPrinter={connectPrinter}
        bridgeEnabled={bridge.enabled} bridgeDesc={bridge.description} onTestPrint={testServerPrint} />

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
        {tabs.length < 6 && <button onClick={addTab} style={{ width: 34, height: 34, borderRadius: 9, background: C.card, border: `1.5px dashed ${C.border}`, cursor: "pointer", fontSize: 22, color: C.mutedFg, flexShrink: 0 }}>+</button>}
      </div>

      {message && (
        <div style={{ padding: "4px 16px", background: message.kind === "ok" ? "oklch(0.95 0.05 155)" : "oklch(0.95 0.05 27)", color: message.kind === "ok" ? C.success : C.danger, fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span>{message.text}</span>
          {message.kind === "ok" && receipt && <Link href={`/invoices/${receipt.invoiceId}`} style={{ color: C.primary, textDecoration: "underline", fontSize: 12 }}>فتح الفاتورة</Link>}
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
          payInput={tab.payInput} setPayInput={setPayInput} method={tab.method} setMethod={(m) => patch({ method: m })}
          numPress={numPress} onPay={() => submit(false)} onQuickPay={() => submit(true)} isPending={sale.isPending}
        />
        <ServiceGrid C={C} services={services} loading={servicesQ.isLoading} cats={cats} catId={effectiveCatId} setCatId={setCatId} search={search} onAdd={addService} />
      </div>

      {receipt && <ReceiptOverlay C={C} r={receipt} onDismiss={() => setReceipt(null)} onPrint={() => printReceipt(brandedReceipt(receipt))} />}
      {shifting && <ShiftCloseDialog C={C} shift={shift} onClose={() => setShifting(false)} onClosed={() => { setShifting(false); shiftQ.refetch(); }} />}
      {creditPrompt && (
        <CreditApprovalDialog C={C} message={creditPrompt} mgrEmail={mgrEmail} setMgrEmail={setMgrEmail} mgrPwd={mgrPwd} setMgrPwd={setMgrPwd}
          isPending={sale.isPending} onApprove={() => submit(false, { email: mgrEmail, password: mgrPwd })} onCancel={() => setCreditPrompt(null)} />
      )}
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function Header({ C, dark, toggleDark, search, setSearch, searchRef, me, shiftId, lastInv, onCloseShift,
  printerReady, onConnectPrinter, bridgeEnabled, bridgeDesc, onTestPrint }: {
  C: C; dark: boolean; toggleDark: () => void; search: string; setSearch: (s: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>; me: RouterOutputs["auth"]["me"] | undefined;
  shiftId: number; lastInv: { num: string; total: number } | null; onCloseShift: () => void;
  printerReady: boolean; onConnectPrinter: () => void;
  bridgeEnabled: boolean; bridgeDesc: string; onTestPrint: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 14px", height: 64, flexShrink: 0, background: C.card, borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 40 }}>
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
      <div style={{ flex: 1, maxWidth: 440, position: "relative", display: "flex", alignItems: "center" }}>
        <span style={{ position: "absolute", right: 13, color: C.mutedFg, pointerEvents: "none", display: "flex", alignItems: "center" }} aria-hidden>
          <Search size={16} />
        </span>
        <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن خدمة بالاسم… (F2)"
          style={{ width: "100%", height: 46, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14, outline: "none", paddingRight: 42, paddingLeft: search ? 36 : 14 }}
          onFocus={(e) => (e.target.style.borderColor = C.primary)} onBlur={(e) => (e.target.style.borderColor = C.border)} />
        {search && <button onClick={() => setSearch("")} aria-label="مسح البحث" style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", color: C.mutedFg, padding: 4, display: "inline-flex" }}><X aria-hidden size={15} /></button>}
      </div>
      <div style={{ flex: 1 }} />
      {lastInv && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, background: C.primarySoft, border: `1px solid ${C.primary}`, borderRadius: 9, padding: "3px 6px 3px 13px", flexShrink: 0, lineHeight: 1.3 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
            <span style={{ fontSize: 15, fontWeight: 900, direction: "ltr", color: C.primary }}>{fmt(lastInv.total)} د.ع</span>
            <span style={{ fontSize: 9.5, color: C.mutedFg }}>{lastInv.num}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <CopyButton value={lastInv.num} title="نسخ رقم آخر فاتورة" successMessage="تم نسخ رقم الفاتورة" />
            <CopyButton value={String(lastInv.total)} title="نسخ إجمالي آخر فاتورة" successMessage="تم نسخ الإجمالي" />
          </div>
        </div>
      )}
      <div style={{ background: C.muted, borderRadius: 8, padding: "5px 11px", fontSize: 12, color: C.mutedFg, fontWeight: 700, flexShrink: 0, border: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
        <span aria-hidden className="inline-block size-2 rounded-full bg-emerald-500" style={{ marginLeft: 6 }} />وردية #{shiftId}
      </div>
      <button onClick={toggleDark} title="تبديل الوضع الليلي" aria-label="تبديل الوضع الليلي" style={{ width: 42, height: 42, borderRadius: 9, background: "none", border: `1.5px solid ${C.border}`, cursor: "pointer", color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
      </button>
      {me && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, color: C.fg }}>{me.name}</div>
            <div style={{ fontSize: 10.5, color: C.mutedFg, lineHeight: 1.2 }}>{me.role}</div>
          </div>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, flexShrink: 0 }}>{me.name?.[0] ?? "?"}</div>
        </div>
      )}
      {/* جسر الطباعة على الخادم (طباعة صامتة) — يظهر حين يكون مفعّلاً؛ نقرة = تذكرة اختبار. */}
      {bridgeEnabled && (
        <button onClick={onTestPrint} title={`جسر طباعة صامت: ${bridgeDesc} — اضغط لطباعة تذكرة اختبار`}
          aria-label="جسر طباعة على الخادم — تذكرة اختبار"
          style={{ background: "none", border: `1.5px solid ${C.success}`, borderRadius: 9, padding: "7px 11px", cursor: "pointer", color: C.success, fontFamily: "inherit", fontWeight: 700, flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
          <Printer size={16} aria-hidden /><Globe size={14} aria-hidden />
        </button>
      )}
      {/* الطابعة الحرارية (WebUSB) — ربط/تبديل الطابعة الافتراضية للإيصال الحراري. */}
      {isWebUsbSupported() && (
        <button onClick={onConnectPrinter} title={printerReady ? "الطابعة الافتراضية مربوطة (تلقائياً) — اضغط لتبديلها" : "اربط طابعة حرارية للفواتير (تُربط تلقائياً بعدها)"}
          style={{ background: "none", border: `1.5px solid ${printerReady ? C.success : C.border}`, borderRadius: 9, padding: "7px 11px", cursor: "pointer", color: printerReady ? C.success : C.mutedFg, fontFamily: "inherit", fontWeight: 700, flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}
          aria-label={printerReady ? "الطابعة مربوطة" : "ربط الطابعة الحرارية"}>
          <Printer size={16} aria-hidden />{printerReady && <Check size={14} aria-hidden strokeWidth={3} />}
        </button>
      )}
      <button onClick={onCloseShift} style={{ height: 42, padding: "0 13px", background: "transparent", border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        <Power size={15} aria-hidden /> إغلاق الوردية
      </button>
    </div>
  );
}

// ─── ServiceGrid ─────────────────────────────────────────────────────────────
function ServiceGrid({ C, services, loading, cats, catId, setCatId, search, onAdd }: {
  C: C; services: Svc[]; loading: boolean; cats: { id: number; name: string }[]; catId: number | null;
  setCatId: (id: number) => void; search: string; onAdd: (s: Svc) => void;
}) {
  const q = search.trim();
  const list = useMemo(() => {
    if (q) return services.filter((s) => s.productName.includes(q));
    // print-catalog: catId=0 هو تبويب «أخرى» (الخدمات بلا فئة، categoryId == null).
    return services.filter((s) => (catId === 0 ? s.categoryId == null : s.categoryId === catId));
  }, [services, q, catId]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      {!q && (
        <div style={{ display: "flex", gap: 6, padding: "10px 11px", overflowX: "auto", borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.muted }}>
          {cats.map((ct) => {
            const active = ct.id === catId;
            return (
              <button key={ct.id} onClick={() => setCatId(ct.id)}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 17px", height: 50, borderRadius: 10, whiteSpace: "nowrap", cursor: "pointer", fontFamily: "inherit", fontSize: 14.5, fontWeight: 800, flexShrink: 0, touchAction: "manipulation", background: active ? C.primary : C.card, color: active ? C.primaryFg : C.fg, border: `${active ? 2 : 1.5}px solid ${active ? C.primary : C.border}` }}>
                {(() => { const CIcon = categoryIcon(ct.name); return <CIcon aria-hidden size={19} />; })()}
                {ct.name}
              </button>
            );
          })}
        </div>
      )}
      {q && <div style={{ padding: "11px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.mutedFg, background: C.muted }}>نتائج البحث عن «<strong style={{ color: C.fg }}>{q}</strong>» — {list.length} خدمة</div>}
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {loading ? (
          <div style={{ padding: "60px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل الخدمات…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: "60px 0", textAlign: "center", color: C.mutedFg }}>
            <div style={{ marginBottom: 10, display: "flex", justifyContent: "center", opacity: 0.55 }}><Search aria-hidden size={40} strokeWidth={1.5} /></div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{q ? "لا توجد خدمة بهذا الاسم" : "لا خدمات في هذه الفئة"}</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(186px, 1fr))", gap: 11 }}>
            {list.map((s) => {
              const custom = isCustomPriceSku(s.sku);
              return (
                <button key={s.productUnitId} onClick={() => onAdd(s)}
                  style={{ height: 132, display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "space-between", padding: "15px 15px", borderRadius: 11, cursor: "pointer", fontFamily: "inherit", textAlign: "right", background: C.card, border: `1.5px solid ${C.border}`, transition: "transform .07s, border-color .1s, box-shadow .1s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.primary; e.currentTarget.style.boxShadow = `0 4px 14px ${C.primarySoft}`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "none"; }}
                  onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.96)")}
                  onMouseUp={(e) => (e.currentTarget.style.transform = "")}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                    {(() => { const SIcon = serviceIcon(s.sku); return <SIcon aria-hidden size={28} strokeWidth={1.6} />; })()}
                    {custom && <span style={{ fontSize: 10, fontWeight: 800, color: C.amber, background: `color-mix(in oklch, ${C.amber} 14%, transparent)`, padding: "2px 7px", borderRadius: 20 }}>سعر يدوي</span>}
                  </div>
                  <div style={{ width: "100%" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.fg, lineHeight: 1.3, marginBottom: 3 }}>{s.productName}</div>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: C.mutedFg }}>/ {s.unitName}</span>
                      <span style={{ fontSize: 17, fontWeight: 900, color: C.primary, direction: "ltr" }}>{s.price == null ? "—" : fmt(Number(s.price))}<span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}> د.ع</span></span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * منتقي عميل مضغوط ببحثٍ **خادميّ** — بديل `<select>` كان يُغذّى من `customers.list` المقصوصة
 * عند ٥٠٠ صفّاً: العميل رقم ٥٠١ لم يكن يظهر في القائمة إطلاقاً ⇒ **يتعذّر بيعه آجلاً** من هذه
 * الشاشة (البيع الآجل يشترط عميلاً — انظر حارس `isCredit && customerId == null`)، بلا أيّ مؤشّر.
 * مُنسَّق بـinline styles على توكنات `C` لأن هذه الشاشة لمسية بتصميمها الخاص (لا Tailwind).
 */
function CustomerCombo({ C, customerId, setCustomerId }: { C: C; customerId: number | null; setCustomerId: (id: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dq = useDebouncedValue(q.trim(), 250);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // البحث لا يُطلَق إلا والقائمة مفتوحة ⇒ صفر تحميل عند الإقلاع (كان يجلب ٥٠٠ عميل دائماً).
  const search = trpc.customers.search.useQuery(
    { q: dq || undefined, limit: 20 },
    { enabled: open, staleTime: 30_000 },
  );
  // اسم المختار بـid مستقلاً عن نتائج البحث (قد يكون خارجها أو خارج أيّ سقف).
  const picked = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );
  const rows = search.data?.rows ?? [];
  const label = customerId == null ? "عميل نقدي" : (picked.data?.name ?? `#${customerId}`);
  const active = customerId != null;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="اختيار العميل"
        style={{ height: 36, borderRadius: 9, border: `1.5px solid ${active ? C.primary : C.border}`, background: active ? C.primarySoft : C.card, color: active ? C.primary : C.mutedFg, fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, padding: "0 8px", outline: "none", cursor: "pointer", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </button>
      {open && (
        <div role="listbox" style={{ position: "absolute", top: 40, left: 0, minWidth: 240, zIndex: 50, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,.18)", overflow: "hidden" }}>
          <div style={{ padding: 7 }}>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ابحث بالاسم أو الهاتف…"
              style={{ width: "100%", height: 32, borderRadius: 7, border: `1px solid ${C.border}`, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 12.5, padding: "0 8px", outline: "none" }}
            />
          </div>
          <div style={{ maxHeight: 210, overflowY: "auto" }}>
            <div
              role="option"
              aria-selected={customerId == null}
              onClick={() => { setCustomerId(null); setOpen(false); setQ(""); }}
              style={{ padding: "8px 10px", cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: C.mutedFg, borderBottom: `1px solid ${C.border}` }}
            >
              عميل نقدي
            </div>
            {search.isFetching && rows.length === 0 && (
              <div style={{ padding: "12px 10px", textAlign: "center", fontSize: 12, color: C.mutedFg }}>جارٍ البحث…</div>
            )}
            {!search.isFetching && rows.length === 0 && (
              <div style={{ padding: "12px 10px", textAlign: "center", fontSize: 12, color: C.mutedFg }}>لا نتائج</div>
            )}
            {rows.map((c) => (
              <div
                key={c.id}
                role="option"
                aria-selected={c.id === customerId}
                onClick={() => { setCustomerId(c.id); setOpen(false); setQ(""); }}
                style={{ padding: "8px 10px", cursor: "pointer", fontSize: 12.5, borderBottom: `1px solid ${C.border}`, background: c.id === customerId ? C.primarySoft : "transparent", color: C.fg }}
              >
                <div style={{ fontWeight: 700 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: C.mutedFg }}>{c.phone || "بلا هاتف"}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CheckoutColumn = CartList (فوق) + PaymentBlock (تحت) ─────────────────────
interface CheckoutProps {
  C: C; cart: CartLine[]; total: number; selUid: number | null; setSelUid: (id: number | null) => void;
  changeQty: (uid: number, q: number) => void; removeRow: (uid: number) => void; onClear: () => void;
  setPrice: (uid: number, p: number) => void; editPriceUid: number | null; setEditPriceUid: (id: number | null) => void;
  customerId: number | null; setCustomerId: (id: number | null) => void;
  payInput: string; setPayInput: (u: string | ((s: string) => string)) => void; method: PaymentMethod; setMethod: (m: PaymentMethod) => void;
  numPress: (k: string) => void; onPay: () => void; onQuickPay: () => void; isPending: boolean;
}

function CheckoutColumn(props: CheckoutProps) {
  const { C } = props;
  return (
    <div style={{ width: 466, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <CartList {...props} />
      <PaymentBlock {...props} />
    </div>
  );
}

function CartList({ C, cart, selUid, setSelUid, changeQty, removeRow, onClear, setPrice, editPriceUid, setEditPriceUid, customerId, setCustomerId }: CheckoutProps) {
  const items = cart.reduce((s, c) => s + c.qty, 0);
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 11px", height: 48, background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, color: C.fg, display: "inline-flex", alignItems: "center", gap: 6 }}><ReceiptIcon aria-hidden size={17} /> الفاتورة</span>
          {cart.length > 0 && <span style={{ background: C.primary, color: C.primaryFg, borderRadius: 12, padding: "2px 9px", fontSize: 11.5, fontWeight: 700 }}>{cart.length} · {items}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: customerId != null ? C.primary : C.mutedFg }} aria-hidden><User size={14} /></span>
          <CustomerCombo C={C} customerId={customerId} setCustomerId={setCustomerId} />
          {cart.length > 0 && <button onClick={onClear} style={{ height: 36, padding: "0 11px", background: "none", border: `1px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontSize: 12.5, color: C.danger, fontFamily: "inherit", fontWeight: 700 }}>تفريغ</button>}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: cart.length ? 9 : 0 }}>
        {cart.length === 0 ? (
          <div style={{ padding: "50px 0", textAlign: "center", color: C.mutedFg }}>
            <div style={{ marginBottom: 10, display: "flex", justifyContent: "center", opacity: 0.55 }}><ReceiptIcon aria-hidden size={40} strokeWidth={1.5} /></div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>الفاتورة فارغة</div>
            <div style={{ fontSize: 12.5, marginTop: 6 }}>اضغط على خدمة من اليسار</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {cart.map((c) => {
              const sel = selUid === c.uid;
              const editing = editPriceUid === c.uid;
              return (
                <div key={c.uid} onClick={() => setSelUid(c.uid)}
                  style={{ borderRadius: 11, border: `1.5px solid ${sel ? C.primary : C.border}`, background: sel ? C.primarySoft : C.card, padding: "9px 11px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: C.fg, lineHeight: 1.3, display: "flex", alignItems: "center", gap: 6 }}>
                      {(() => { const SIcon = serviceIcon(c.svc.sku); return <SIcon aria-hidden size={16} />; })()}
                      {c.svc.productName}
                      <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 500 }}>/ {c.svc.unitName}</span>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeRow(c.uid); }} aria-label="حذف السطر" style={{ width: 34, height: 34, flexShrink: 0, background: "none", border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", color: C.mutedFg, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><X aria-hidden size={15} /></button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div onClick={(e) => { e.stopPropagation(); setSelUid(c.uid); setEditPriceUid(c.uid); }} style={{ minWidth: 78 }}>
                      {editing ? (
                        <input autoFocus dir="ltr" inputMode="numeric" defaultValue={c.price}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setPrice(c.uid, Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, ""), 10) || 0))}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditPriceUid(null); }}
                          onBlur={() => setEditPriceUid(null)}
                          style={{ width: 84, height: 36, textAlign: "center", border: `1.5px solid ${C.primary}`, borderRadius: 8, background: C.card, color: C.fg, fontFamily: "inherit", fontSize: 14, fontWeight: 800, outline: "none", direction: "ltr" }} />
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, direction: "ltr", color: isCustomPriceSku(c.svc.sku) ? C.amber : C.mutedFg, fontWeight: isCustomPriceSku(c.svc.sku) ? 800 : 600, fontSize: 13.5, padding: "5px 9px", borderRadius: 8, border: `1px dashed ${isCustomPriceSku(c.svc.sku) ? C.amber : C.border}` }}>
                          {fmt(c.price)}<Pencil aria-hidden size={10} style={{ opacity: 0.7 }} />
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.uid, c.qty - 1); }} style={{ width: 44, height: 44, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, cursor: "pointer", fontSize: 24, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>−</button>
                      <span style={{ minWidth: 34, textAlign: "center", fontWeight: 900, fontSize: 18, direction: "ltr", color: C.fg }}>{c.qty}</span>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.uid, c.qty + 1); }} style={{ width: 44, height: 44, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.card, cursor: "pointer", fontSize: 24, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", touchAction: "manipulation" }}>+</button>
                    </div>
                    <span style={{ direction: "ltr", fontWeight: 900, fontSize: 16, color: C.fg, minWidth: 64, textAlign: "left" }}>{fmt(c.price * c.qty)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentBlock({ C, total, payInput, setPayInput, method, setMethod, numPress, onPay, onQuickPay, cart, customerId, isPending }: CheckoutProps) {
  const cartLen = cart.length;
  const paid = Number(payInput || 0);
  const cashTotal = method === "CASH" ? riqd(total) : total;
  const change = paid - cashTotal;
  const credit = cashTotal - paid;
  const isChange = paid > 0 && paid >= cashTotal;
  const isOwing = paid > 0 && paid < cashTotal;
  // حارس: لا بيع بسطرٍ بسعر صفر (خدمة سعرها يدوي لم يُدخَل) — يمنع فاتورة مجانية بالخطأ.
  const hasZeroLine = cart.some((c) => c.price <= 0);
  const canPay = cartLen > 0 && !hasZeroLine && (payInput === "" || paid >= cashTotal) && (!isOwing || customerId != null);

  const Key = ({ k, del }: { k: string; del?: boolean }) => (
    <button onClick={() => numPress(k)} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.95)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")} onMouseLeave={(e) => (e.currentTarget.style.transform = "")}
      style={{ height: 44, fontSize: 20, fontWeight: 800, background: del ? C.delKey : C.numKey, color: del ? C.delFg : C.fg, border: `1.5px solid ${C.border}`, borderRadius: 10, cursor: "pointer", fontFamily: "inherit", direction: "ltr", userSelect: "none", touchAction: "manipulation" }}>{k}</button>
  );
  const Method = ({ m, Icon, label }: { m: PaymentMethod; Icon: React.ComponentType<{ "aria-hidden"?: boolean; size?: number }>; label: string }) => (
    <button onClick={() => setMethod(m)}
      style={{ flex: 1, minHeight: 46, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: `2px solid ${method === m ? C.primary : C.border}`, borderRadius: 10, background: method === m ? C.primary : C.card, color: method === m ? C.primaryFg : C.fg, fontWeight: 800, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", touchAction: "manipulation" }}>
      <Icon aria-hidden size={19} />{label}
    </button>
  );

  return (
    <div style={{ flexShrink: 0, background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ padding: "7px 16px", background: C.primary, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13.5, color: C.primaryFg, fontWeight: 700, opacity: 0.92 }}>الإجمالي</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span style={{ fontSize: 27, fontWeight: 900, direction: "ltr", letterSpacing: "-1px", color: C.primaryFg }}>{fmt(total)}</span>
          <span style={{ fontSize: 12.5, color: C.primaryFg, opacity: 0.85 }}>د.ع</span>
        </div>
      </div>
      <div style={{ padding: "7px 10px 9px" }}>
        <div style={{ background: C.muted, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "5px 13px", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 38, marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: C.mutedFg }}>المبلغ المستلم</span>
          <span style={{ fontSize: 22, fontWeight: 900, direction: "ltr", color: payInput ? (isOwing ? C.amber : C.primary) : C.mutedFg }}>{payInput ? Number(payInput).toLocaleString("en-US") : "—"}</span>
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
          {QUICK.map((a) => <button key={a} onClick={() => setPayInput(String(a))} style={{ flex: 1, height: 34, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 800, color: C.fg, fontFamily: "inherit", touchAction: "manipulation" }}>{fmt(a)}</button>)}
          <button onClick={() => setPayInput(String(cashTotal))} disabled={!cartLen} style={{ flex: 0.7, height: 34, background: C.primarySoft, border: `1.5px solid ${C.primary}`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 800, color: C.primary, fontFamily: "inherit", touchAction: "manipulation" }}>= الكل</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, direction: "ltr", marginBottom: 6 }}>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => <Key key={k} k={k} />)}
          <Key k="00" /><Key k="0" /><Key k="⌫" del />
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <Method m="CASH" Icon={Banknote} label="نقداً" />
          <Method m="CARD" Icon={CreditCard} label="بطاقة" />
          <Method m="TRANSFER" Icon={RefreshCw} label="تحويل" />
        </div>
        <div style={{ minHeight: 24, display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          {!cartLen && <span style={{ fontSize: 12.5, color: C.mutedFg }}>اختر خدمة للبدء</span>}
          {cartLen > 0 && hasZeroLine && <span style={{ fontSize: 12, color: C.amber, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>أدخل سعراً للخدمات ذات السعر اليدوي (<Pencil aria-hidden size={11} />)</span>}
          {cartLen > 0 && !hasZeroLine && !payInput && <span style={{ fontSize: 12, color: C.mutedFg }}>{method === "CASH" && cashTotal !== total ? `نقداً يُقرَّب إلى ${fmt(cashTotal)} د.ع` : "أدخل المبلغ أو «إتمام» للدفع الكامل"}</span>}
          {cartLen > 0 && !!payInput && isChange && (<><span style={{ fontSize: 13, color: C.mutedFg, fontWeight: 600 }}>الباقي للعميل</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 21, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span><CopyButton value={String(change)} title="نسخ الباقي" successMessage="تم نسخ الباقي" /></span></>)}
          {cartLen > 0 && !!payInput && isOwing && (<><span style={{ fontSize: 13, color: C.amber, fontWeight: 600 }}>المتبقي (آجل)</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 21, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12, fontWeight: 500 }}>د.ع</span></span><CopyButton value={String(credit)} title="نسخ المتبقي" successMessage="تم نسخ المتبقي" /></span></>)}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <button disabled={!cartLen || hasZeroLine || isPending} onClick={onQuickPay}
            style={{ width: 116, height: 52, background: cartLen && !hasZeroLine && !isPending ? "linear-gradient(135deg, oklch(0.62 0.18 50), oklch(0.56 0.20 40))" : C.muted, color: cartLen && !hasZeroLine && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 11, fontFamily: "inherit", fontSize: 13.5, fontWeight: 900, cursor: cartLen && !hasZeroLine && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, touchAction: "manipulation" }}>
            <Zap aria-hidden size={17} />دفع سريع
          </button>
          <button disabled={!canPay || isPending} onClick={onPay}
            style={{ flex: 1, height: 52, background: canPay && !isPending ? C.success : C.muted, color: canPay && !isPending ? "#fff" : C.mutedFg, border: "none", borderRadius: 11, fontFamily: "inherit", fontSize: 16, fontWeight: 900, cursor: canPay && !isPending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, touchAction: "manipulation" }}>
            {isPending
              ? "جارٍ…"
              : !cartLen
                ? "الفاتورة فارغة"
                : <><Check aria-hidden size={18} strokeWidth={3} /> إتمام الدفع</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ReceiptOverlay ──────────────────────────────────────────────────────────
function ReceiptOverlay({ C, r, onDismiss, onPrint }: { C: C; r: Receipt; onDismiss: () => void; onPrint: () => void }) {
  return (
    <div onClick={onDismiss} style={{ position: "fixed", inset: 0, zIndex: 100, background: C.overlay, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: 20, padding: "34px 42px 28px", width: 460, maxWidth: "92vw", boxShadow: "0 28px 72px rgb(0 0 0/.42)", cursor: "default", textAlign: "center" }}>
        <div style={{ width: 74, height: 74, borderRadius: "50%", background: C.success, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", color: "#fff" }}><Check aria-hidden size={42} strokeWidth={3} /></div>
        <div style={{ fontSize: 23, fontWeight: 900, marginBottom: 3, color: C.fg }}>تمّت العملية بنجاح</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 22, display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
          <span>فاتورة: {r.num}</span>
          <CopyButton value={r.num} title="نسخ رقم الفاتورة" successMessage="تم نسخ رقم الفاتورة" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          {[{ l: "المبلغ المدفوع", v: r.received, c: C.primary }, { l: "إجمالي الفاتورة", v: r.total, c: C.fg }].map((it) => (
            <div key={it.l} style={{ background: C.muted, borderRadius: 10, padding: "13px 10px", position: "relative" }}>
              <div style={{ position: "absolute", top: 4, left: 4 }}>
                <CopyButton value={String(it.v)} title={`نسخ ${it.l}`} successMessage={`تم نسخ ${it.l}`} />
              </div>
              <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 3 }}>{it.l}</div>
              <div style={{ fontSize: 25, fontWeight: 900, direction: "ltr", color: it.c }}>{fmt(it.v)}</div>
              <div style={{ fontSize: 11, color: C.mutedFg }}>د.ع</div>
            </div>
          ))}
        </div>
        {r.change > 0 && <Bar C={C} c={C.success} k="الباقي للعميل" v={r.change} copyTitle="نسخ الباقي" />}
        {r.credit > 0 && <Bar C={C} c={C.amber} k={`آجل على ${r.customer ?? "العميل"}`} v={r.credit} copyTitle="نسخ المتبقي الآجل" />}
        <div style={{ marginBottom: 18, fontSize: 13, color: C.mutedFg }}>الدفع: <strong style={{ color: C.fg }}>{r.method}</strong> · {r.lines.length} خدمة</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onPrint} style={{ flex: 1, height: 50, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.fg, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Printer size={18} aria-hidden /> طباعة الإيصال
          </button>
          <button onClick={onDismiss} style={{ flex: 1, height: 50, background: C.primary, border: "none", borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.primaryFg }}>فاتورة جديدة</button>
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: C.mutedFg }}>المس الشاشة في أي مكان للمتابعة</div>
      </div>
    </div>
  );
}
function Bar({ C, c, k, v, copyTitle }: { C: C; c: string; k: string; v: number; copyTitle?: string }) {
  return (
    <div style={{ background: `color-mix(in oklch, ${c} 12%, transparent)`, border: `1.5px solid color-mix(in oklch, ${c} 30%, transparent)`, borderRadius: 10, padding: "11px 18px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: c }}>{k}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 25, fontWeight: 900, color: c, direction: "ltr" }}>{fmt(v)} <span style={{ fontSize: 12 }}>د.ع</span></span>
        <CopyButton value={String(v)} title={copyTitle ?? `نسخ ${k}`} successMessage={`تم نسخ ${k}`} />
      </span>
    </div>
  );
}

// ─── ShiftCloseDialog (نقد ومبيعات فقط — بلا كلفة) ───────────────────────────
function ShiftCloseDialog({ C, shift, onClose, onClosed }: { C: C; shift: NonNullable<ShiftData>; onClose: () => void; onClosed: () => void }) {
  const [counted, setCounted] = useState("");
  const [handover, setHandover] = useState<ShiftHandoverValue>(emptyHandover);
  const utils = trpc.useUtils();
  const reportQ = trpc.shifts.report.useQuery({ shiftId: shift.id });
  const report = reportQ.data;
  const recipientsQ = trpc.shifts.handoverRecipients.useQuery();

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const payRows: [string, string, string][] = (report?.payments ?? []).map((p) => [`${p.method} ${p.direction === "IN" ? "وارد" : "صادر"}`, String(p.count), String(p.total)]);
      await printDoc({
        kind: "zreport", title: SHOP, subtitle: "تقرير نهاية الوردية (Z) — قسم الطباعة",
        meta: [`وردية #${r.shiftId}`, new Date().toLocaleString("ar-IQ-u-nu-latn")],
        columns: ["الحركة", "عدد", "مبلغ"], rows: payRows.length ? payRows : [["لا حركات", "0", "0.00"]],
        totals: [
          { label: "عدد الفواتير", value: String(report?.invoiceCount ?? 0) },
          { label: "إجمالي المبيعات", value: String(report?.salesTotal ?? "0.00") },
          { label: "الرصيد الافتتاحي", value: r.openingBalance },
          { label: "النقد المتوقع", value: r.expectedCash },
          { label: "النقد المعدود", value: r.countedCash },
          { label: "الفرق", value: r.variance },
        ],
        footer: "نهاية الوردية — شكراً",
      });
      await utils.shifts.current.invalidate();
      onClosed();
    },
    onError: (e) => notify.err(e),
  });

  const cashIn = (report?.payments ?? []).filter((p) => p.method === "CASH" && p.direction === "IN").reduce((s, p) => s.plus(D(p.total)), D(0));
  const cashOut = (report?.payments ?? []).filter((p) => p.method === "CASH" && p.direction === "OUT").reduce((s, p) => s.plus(D(p.total)), D(0));
  const openingBal = D(shift.openingBalance ?? 0).toNumber();
  const expected = report != null ? D(shift.openingBalance ?? 0).plus(cashIn).minus(cashOut).toNumber() : null;
  const diff = expected != null && counted ? Number(counted) - expected : null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgb(0 0 0/.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: 18, padding: "24px 28px", width: 460, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 24px 64px rgb(0 0 0/.32)" }}>
        <div style={{ fontWeight: 900, fontSize: 19, marginBottom: 3, color: C.fg }}>إغلاق الوردية #{shift.id}</div>
        <div style={{ fontSize: 12.5, color: C.mutedFg, marginBottom: 16 }}>{new Date().toLocaleDateString("ar-IQ-u-nu-latn", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
        {reportQ.isLoading ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: C.mutedFg }}>جارٍ تحميل التقرير…</div>
        ) : (
          <>
            {([["عدد الفواتير", `${report?.invoiceCount ?? 0} فاتورة`], ["إجمالي المبيعات", `${fmt(Number(report?.salesTotal ?? 0))} د.ع`], ["الرصيد الافتتاحي", `${fmt(openingBal)} د.ع`], ...(expected != null ? [["النقد المتوقع بالصندوق", `${fmt(expected)} د.ع`] as [string, string]] : [])] as [string, string][]).map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ color: C.mutedFg }}>{l}</span><span style={{ fontWeight: 700, color: C.fg }}>{v}</span></div>
            ))}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).length > 0 && <div style={{ margin: "10px 0 4px", fontSize: 12, color: C.mutedFg, fontWeight: 700 }}>تفصيل طرق الدفع:</div>}
            {(report?.payments ?? []).filter((p) => Number(p.total) > 0).map((p) => (
              <div key={`${p.method}-${p.direction}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "4px 0", borderBottom: `1px dashed ${C.border}` }}><span style={{ color: C.mutedFg }}>{p.method} {p.direction === "IN" ? "وارد" : "صادر"} ({p.count})</span><span style={{ fontWeight: 600, color: p.direction === "OUT" ? C.danger : C.fg }}>{fmt(Number(p.total))} د.ع</span></div>
            ))}
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>النقد المعدود في الصندوق (د.ع)</label>
              <input value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^0-9]/g, ""))} dir="ltr" placeholder="0"
                style={{ width: "100%", height: 48, border: `1.5px solid ${C.border}`, borderRadius: 9, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 19, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box" }} />
              {diff !== null && (
                <div style={{ marginTop: 7, fontSize: 14, fontWeight: 700, color: diff >= 0 ? C.success : C.danger, display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                  <span>الفرق: {diff >= 0 ? "+" : ""}{fmt(diff)} د.ع</span>
                  {diff === 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Check aria-hidden size={14} strokeWidth={3} /> مطابق</span>}
                  {diff > 0 && <span>(زيادة)</span>}
                  {diff < 0 && <span>(عجز)</span>}
                </div>
              )}
            </div>
            <ShiftHandoverSection
              C={C}
              recipients={recipientsQ.data ?? []}
              value={handover}
              onChange={setHandover}
              loading={recipientsQ.isLoading}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={onClose} style={{ flex: 1, height: 46, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.fg }}>إلغاء</button>
              <button disabled={!counted || closeShift.isPending || handoverIncomplete(handover)} onClick={() => closeShift.mutate({ shiftId: shift.id, countedCash: counted, handover: buildHandoverPayload(handover) })}
                style={{ flex: 1, height: 46, background: !counted || closeShift.isPending ? C.muted : C.danger, color: !counted || closeShift.isPending ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: !counted || closeShift.isPending ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>{closeShift.isPending ? "جارٍ الإغلاق…" : "إغلاق وطباعة Z"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── CreditApprovalDialog ────────────────────────────────────────────────────
function CreditApprovalDialog({ C, message, mgrEmail, setMgrEmail, mgrPwd, setMgrPwd, isPending, onApprove, onCancel }: {
  C: C; message: string; mgrEmail: string; setMgrEmail: (s: string) => void; mgrPwd: string; setMgrPwd: (s: string) => void;
  isPending: boolean; onApprove: () => void; onCancel: () => void;
}) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgb(0 0 0/.45)", display: "flex", alignItems: "center", justifyContent: "center", direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: 16, padding: "24px 28px", width: 380, boxShadow: "0 20px 56px rgb(0 0 0/.3)" }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4, color: C.amber, display: "inline-flex", alignItems: "center", gap: 6 }}><AlertTriangle aria-hidden size={18} /> موافقة مدير مطلوبة</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 18 }}>{message}</div>
        {[{ label: "بريد المدير", value: mgrEmail, setter: setMgrEmail, type: "email", placeholder: "manager@alroya.local" }, { label: "كلمة المرور", value: mgrPwd, setter: setMgrPwd, type: "password", placeholder: "••••••••" }].map((f) => (
          <div key={f.label} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 700, display: "block", marginBottom: 5, color: C.fg }}>{f.label}</label>
            <input type={f.type} dir="ltr" value={f.value} placeholder={f.placeholder} onChange={(e) => f.setter(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPwd) onApprove(); }}
              style={{ width: "100%", height: 44, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 14, padding: "0 12px", outline: "none", boxSizing: "border-box" }} />
          </div>
        ))}
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button disabled={!mgrEmail || !mgrPwd || isPending} onClick={onApprove}
            style={{ flex: 1, height: 46, background: !mgrEmail || !mgrPwd || isPending ? C.muted : C.primary, color: !mgrEmail || !mgrPwd || isPending ? C.mutedFg : C.primaryFg, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: !mgrEmail || !mgrPwd || isPending ? "not-allowed" : "pointer" }}>{isPending ? "جارٍ…" : "اعتمد وأكمل البيع"}</button>
          <button onClick={onCancel} style={{ height: 46, padding: "0 18px", background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 8, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer", color: C.fg }}>إلغاء</button>
        </div>
      </div>
    </div>
  );
}
