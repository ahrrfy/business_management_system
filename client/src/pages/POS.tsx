/**
 * نقطة البيع — الرؤية العربية
 * تصميم Odoo 19-style مع multi-tab، حاسبة ذكية، مسح باركود آني، وإدارة وردية كاملة.
 */
import CustomerPicker from "@/components/CustomerPicker";
import { clearCartDraft } from "@/lib/cartDraft";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { D, roundCashIQD, round2 } from "@/lib/money";
import { isPaired, isWebUsbSupported, pairPrinter, tryReconnectPrinter, printDoc, printReceipt, getServerBridgeStatus, serverPrintTest, type ReceiptBrowserData } from "@/lib/printing/print";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { parseScan } from "@/lib/scanRouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type NumMode = "QTY" | "DISC" | "PAY";
type PosRow = RouterOutputs["catalog"]["posList"][number];

type CartItem = {
  row: PosRow;
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

// ─── Dark Mode ────────────────────────────────────────────────────────────────

function useDarkMode() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark"))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// ─── Colour Tokens ────────────────────────────────────────────────────────────

const LIGHT = {
  bg:         "oklch(0.985 0.002 247.858)",
  card:       "#fff",
  border:     "oklch(0.922 0.004 247.858)",
  muted:      "oklch(0.962 0.004 247.858)",
  mutedFg:    "oklch(0.552 0.016 285.938)",
  fg:         "oklch(0.235 0.015 65)",
  primary:    "oklch(0.488 0.243 264.376)",
  primaryH:   "oklch(0.43  0.243 264.376)",
  primaryFg:  "#fff",
  primarySoft:"oklch(0.94 0.04 264.376)",
  success:    "oklch(0.50  0.13 155)",
  successH:   "oklch(0.44  0.13 155)",
  amber:      "oklch(0.65  0.15 75)",
  danger:     "oklch(0.577 0.245 27.325)",
  modeActive: "oklch(0.90 0.10 72)",
  modeBord:   "oklch(0.72 0.14 72)",
  modeFg:     "oklch(0.38 0.14 60)",
  numKey:     "oklch(0.962 0.004 247.858)",
  numKeyHov:  "oklch(0.93 0.004 247.858)",
  delKey:     "oklch(0.92 0.05 20)",
  delFg:      "oklch(0.50 0.22 25)",
  overlay:    "oklch(0.15 0.01 265 / .88)",
};

const DARK = {
  bg:         "oklch(0.14 0.010 65)",
  card:       "oklch(0.20 0.012 65)",
  border:     "oklch(1 0 0 / 0.12)",
  muted:      "oklch(0.22 0.012 65)",
  mutedFg:    "oklch(0.72 0.010 247)",
  fg:         "oklch(1 0 0)",
  primary:    "oklch(0.55  0.22 264)",
  primaryH:   "oklch(0.50  0.22 264)",
  primaryFg:  "#fff",
  primarySoft:"oklch(0.28 0.06 264)",
  success:    "oklch(0.55  0.14 155)",
  successH:   "oklch(0.49  0.14 155)",
  amber:      "oklch(0.72  0.15 75)",
  danger:     "oklch(0.65  0.22 27)",
  modeActive: "oklch(0.30 0.10 72)",
  modeBord:   "oklch(0.55 0.14 72)",
  modeFg:     "oklch(0.85 0.12 72)",
  numKey:     "oklch(0.24 0.010 65)",
  numKeyHov:  "oklch(0.28 0.010 65)",
  delKey:     "oklch(0.26 0.05 20)",
  delFg:      "oklch(0.75 0.22 25)",
  overlay:    "oklch(0.08 0.01 265 / .92)",
};

type C = typeof LIGHT;

// ─── Constants ────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };
const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقد", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة",
};
const QUICK_AMTS = [5000, 10000, 25000, 50000, 100000];
const SHOP = "الرؤية العربية";
const SCAN_MS = 80;

// ─── Utility ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => Number(n || 0).toLocaleString("en-US");
const money = (n: number) => n.toFixed(2);

// §٥: سعر فعّال يحسب الخصم بدقّة Decimal (لا Number×float×Math.round) — يصون الفلوس
// عبر مضاعفات الخصم ١٠.٥٪، ٣٣.٣٣٪، إلخ. يُقرَّب 2dp ثم يعاد رقماً للعرض.
const effectivePrice = (item: CartItem) => {
  const price = D(item.row.price ?? 0);
  if (item.disc == null) return price.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
  const discounted = round2(price.times(D(100).minus(D(item.disc))).div(100));
  return discounted.toDecimalPlaces(0, 4 /* ROUND_HALF_UP */).toNumber();
};

const itemTotal = (item: CartItem) => effectivePrice(item) * item.qty;

let tabSeq = 2;
const createTab = (id: number, label?: string): POSTab => ({
  id, label: label ?? `طلب ${id}`,
  cart: [], payInput: "", method: "CASH",
  selId: null, numMode: "PAY",
  customerId: null, tierOverride: null,
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
      setValue("");
      if (code.length >= 4) onBarcode(code);
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
    change: r.isCredit ? null : r.change,
    credit: r.isCredit ? r.credit : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Main POS Component ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export default function POS() {
  const dark = useDarkMode();
  const C: C = dark ? DARK : LIGHT;

  const me       = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const utils    = trpc.useUtils();

  const shiftQ = trpc.shifts.current.useQuery({ branchId });
  const shift  = shiftQ.data;

  // ── Multi-tab State ──────────────────────────────────────────────────────
  const [tabs,     setTabs]     = useState<POSTab[]>([createTab(1, "طلب 1")]);
  const [activeId, setActiveId] = useState(1);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const cart      = activeTab.cart;

  // ── UI State ─────────────────────────────────────────────────────────────
  const [search,         setSearch]         = useState("");
  const [showDrop,       setShowDrop]       = useState(false);
  const [receipt,        setReceipt]        = useState<Receipt | null>(null);
  const [lastInv,        setLastInv]        = useState<{ num: string; total: number } | null>(null);
  const [shifting,       setShifting]       = useState(false);
  const [opening,        setOpening]        = useState("0");
  const [creditPrompt,   setCreditPrompt]   = useState<string | null>(null);
  const [mgrEmail,       setMgrEmail]       = useState("");
  const [mgrPwd,         setMgrPwd]         = useState("");
  const [printerReady,   setPrinterReady]   = useState(isPaired());
  const [bridge,         setBridge]         = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });
  const [showCustPicker, setShowCustPicker] = useState(false);
  const [draftRestored,  setDraftRestored]  = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ── Tab helpers ───────────────────────────────────────────────────────────
  function patchTab(id: number, patch: Partial<POSTab>) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
  function setCart(updater: CartItem[] | ((c: CartItem[]) => CartItem[])) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== activeId ? t :
        { ...t, cart: typeof updater === "function" ? updater(t.cart) : updater }
      )
    );
  }
  function setPayInput(updater: string | ((s: string) => string)) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id !== activeId ? t :
        { ...t, payInput: typeof updater === "function" ? updater(t.payInput) : updater }
      )
    );
  }
  const setSelId   = (v: number | null) => patchTab(activeId, { selId: v });
  const setNumMode = (v: NumMode)        => patchTab(activeId, { numMode: v });
  const setMethod  = (v: PaymentMethod)  => patchTab(activeId, { method: v });
  const setCustId  = (v: number | null)  => patchTab(activeId, { customerId: v, tierOverride: null });
  const setTierOvr = (v: Tier | null)    => patchTab(activeId, { tierOverride: v });

  function addTab() {
    const id = tabSeq++;
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
        if (Array.isArray(d.tabs) && d.tabs.length) { setTabs(d.tabs); setActiveId(d.activeId); }
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
  const customers = trpc.customers.list.useQuery();
  const selectedCustomer = useMemo(
    () => (customers.data ?? []).find((c) => c.id === activeTab.customerId) ?? null,
    [customers.data, activeTab.customerId]
  );
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
    { branchId, tier: effectiveTier, query: debouncedSearch, limit: 20 },
    {
      enabled: debouncedSearch.trim().length >= 2,
      placeholderData: keepPreviousData,
      staleTime: 15_000,
    }
  );

  // ── Cart ops ──────────────────────────────────────────────────────────────
  function addRow(row: PosRow) {
    if (row.price == null) {
      notify.err(`لا سعر لـ ${row.productName} (${row.unitName}) في فئة ${TIER_LABEL[effectiveTier]}`);
      return;
    }
    if (receipt) setReceipt(null);
    setCart((prev) => {
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
    if (qty <= 0) {
      setCart((prev) => prev.filter((c) => c.row.productUnitId !== id));
      if (activeTab.selId === id) setSelId(null);
    } else {
      setCart((prev) => prev.map((c) => c.row.productUnitId === id ? { ...c, qty } : c));
    }
  }

  function removeRow(id: number) {
    setCart((prev) => prev.filter((c) => c.row.productUnitId !== id));
    if (activeTab.selId === id) setSelId(null);
  }

  // ── Barcode ───────────────────────────────────────────────────────────────
  const lookupBarcode = useCallback(async (code: string) => {
    if (!code) return;
    try {
      const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: effectiveTier });
      if (!row) notify.err(`باركود غير معروف: ${code}`);
      else addRow(row);
    } catch (e: unknown) {
      notify.err(e, "خطأ في المسح");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, effectiveTier]);

  const { handleKeyDown: handleScanKeyDown } = useSmartScanInput(lookupBarcode);

  const handleHidScan = useCallback(async (raw: string) => {
    const result = parseScan(raw);
    if (result.type === "product") {
      await lookupBarcode(result.barcode);
      setSearch("");
    } else if (result.type === "customer") {
      setCustId(result.id);
      notify.ok(`تم تحديد العميل #${result.id}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupBarcode]);

  useBarcodeScanner(handleHidScan, { enabled: !receipt && !shifting && !creditPrompt });

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
  // idempotency: مفتاح ثابت لكل عملية بيع (يتجدّد بعد النجاح) ⇒ النقر المزدوج/إعادة الشبكة لا يكرّر الفاتورة.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const sale = trpc.sales.create.useMutation({
    onSuccess: async (r) => {
      // §٥: مبالغ الإيصال بدقّة Decimal — تُطبع على الإيصال الحراري والشاشة بلا انجراف float.
      const finalReceivedD = isCredit ? paidD : totalD;
      const finalChangeD   = isCredit ? D(0)  : paidD.minus(totalD);
      const finalCreditD   = isCredit ? totalD.minus(paidD) : D(0);
      const finalReceived  = round2(finalReceivedD).toNumber();
      const finalChange    = round2(finalChangeD).toNumber();
      const finalCredit    = round2(finalCreditD).toNumber();
      const now = new Date();
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        invoiceId:     r.invoiceId,
        date: now.toLocaleString("ar-IQ-u-nu-latn"),
        printDate: now.toLocaleDateString("en-GB"),
        printTime: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        cashierName: me.data?.name ?? undefined,
        customerName: selectedCustomer?.name,
        lines: cart.map((c) => ({
          name: c.row.productName, unit: c.row.unitName,
          qty: c.qty, price: effectivePrice(c),
          disc: c.disc, total: itemTotal(c),
        })),
        total, received: finalReceived, change: finalChange,
        credit: finalCredit, isCredit,
        method: METHOD_LABEL[activeTab.method],
      };
      setReceipt(rec);
      setLastInv({ num: r.invoiceNumber, total });
      clearCartDraft(branchId);
      notify.ok(`تم البيع ✓ فاتورة ${r.invoiceNumber}`, "افتح من شريط «آخر فاتورة» أعلاه أو من صفحة الفواتير");
      setCart([]); setPayInput(""); setSelId(null);
      setClientRequestId(crypto.randomUUID()); // مفتاح جديد للبيع التالي

      await printReceipt(buildBrandedReceipt(rec));
      await Promise.all([
        utils.catalog.posList.invalidate(),
        utils.customers.list.invalidate(),
        shiftQ.refetch(),
      ]);
      setCreditPrompt(null); setMgrEmail(""); setMgrPwd("");
    },
    onError: (e) => {
      if ((e.data as unknown as { code?: string })?.code === "PRECONDITION_FAILED")
        setCreditPrompt(e.message);
      else notify.err(e);
    },
  });

  function submitSale(approval?: { email: string; password: string }) {
    if (!shift || !cart.length) return;
    if (isCredit && activeTab.customerId == null) {
      notify.err("البيع الآجل يتطلّب اختيار عميل.");
      return;
    }
    // §٩: التقريب النقدي IQD يُحسب على الخادم للبيع النقدي الكامل (يُسجَّل ADJUST لفرق التقريب).
    // نرسل المبلغ غير المقرّب؛ الخادم يقرّبه ويُسجّل النقد المستلم = الإجمالي المقرّب.
    const cashFull = activeTab.method === "CASH" && !isCredit;
    const payAmount = isCredit ? money(paid) : money(total);
    sale.mutate({
      branchId, shiftId: shift.id, sourceType: "POS", clientRequestId,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map((c) => ({
        variantId: c.row.variantId,
        productUnitId: c.row.productUnitId,
        quantity: String(c.qty),
        ...(c.disc != null ? { discountPercent: String(c.disc) } : {}),
      })),
      payment: { amount: payAmount, method: activeTab.method },
      ...(cashFull ? { cashRoundIQD: true } : {}),
      ...(approval ? { managerApproval: approval } : {}),
    });
  }

  function quickPay() {
    if (!shift || !cart.length) return;
    // §٩: quickPay دائماً CASH كامل ⇒ الخادم يقرّب لفئة IQD (لا تقريب على العميل في مبلغ الدفع).
    const payAmount = money(total);
    sale.mutate({
      branchId, shiftId: shift.id, sourceType: "POS", clientRequestId, cashRoundIQD: true,
      customerId: activeTab.customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map((c) => ({
        variantId: c.row.variantId,
        productUnitId: c.row.productUnitId,
        quantity: String(c.qty),
        ...(c.disc != null ? { discountPercent: String(c.disc) } : {}),
      })),
      payment: { amount: payAmount, method: "CASH" },
    });
  }

  // ── Shift open ────────────────────────────────────────────────────────────
  const openShift = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      await printDoc({
        kind: "opening", title: SHOP,
        subtitle: "بيان الرصيد الافتتاحي",
        meta: [`وردية #${res.shiftId}`, new Date().toLocaleString("ar-IQ-u-nu-latn")],
        totals: [{ label: "الرصيد الافتتاحي", value: fmt(Number(opening || 0)) }],
        footer: "بداية الوردية",
      });
    },
    onError: (e) => notify.err(e),
  });

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      if (receipt)      { if (e.key === "Escape" || e.key === "Enter") setReceipt(null); return; }
      if (shifting)     { if (e.key === "Escape") setShifting(false); return; }
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
                description: "ستُفقد كل الأصناف المُضافة في هذه السلّة. هل تتابع؟",
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
  }, [cart, sale.isPending, receipt, creditPrompt, shifting]);

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
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, color: C.mutedFg, fontFamily: "'Cairo', system-ui, sans-serif", direction: "rtl" }}>
        جارٍ التحميل…
      </div>
    );
  }

  if (!shift) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "32px 36px", width: 380, boxShadow: "0 8px 32px rgb(0 0 0/.16)" }}>
          <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 6, color: C.fg }}>افتح وردية للبدء</div>
          <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 22 }}>لا يمكن البيع بدون وردية مفتوحة</div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13.5, fontWeight: 700, display: "block", marginBottom: 6, color: C.fg }}>الرصيد الافتتاحي للصندوق (د.ع)</label>
            <input
              dir="ltr" value={opening}
              onChange={(e) => setOpening(e.target.value)}
              style={{ width: "100%", height: 48, border: `1.5px solid ${C.border}`, borderRadius: 10, background: C.muted, color: C.fg, fontFamily: "inherit", fontSize: 18, fontWeight: 800, padding: "0 14px", outline: "none", textAlign: "right", boxSizing: "border-box" }}
            />
          </div>
          <button
            disabled={openShift.isPending}
            onClick={() => openShift.mutate({ branchId, openingBalance: opening })}
            style={{ width: "100%", height: 52, background: C.primary, color: C.primaryFg, border: "none", borderRadius: 10, fontFamily: "inherit", fontSize: 15, fontWeight: 800, cursor: "pointer" }}
          >
            {openShift.isPending ? "جارٍ الفتح…" : "فتح الوردية"}
          </button>
          <Link href="/" style={{ display: "block", textAlign: "center", marginTop: 14, fontSize: 13, color: C.mutedFg }}>← الرئيسية</Link>
        </div>
      </div>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  const canPay = cart.length > 0 && (activeTab.payInput === "" || paid >= total);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: C.bg, direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif", color: C.fg }}>

      {/* Header */}
      <POSHeader
        C={C} dark={dark}
        search={search} setSearch={setSearch}
        showDrop={showDrop} setShowDrop={setShowDrop}
        results={search.trim().length >= 2 ? (searchResults.data ?? []) : []}
        searching={searchResults.isFetching}
        searchSettled={!searchResults.isFetching && debouncedSearch.trim() === search.trim() && search.trim().length >= 2}
        addToCart={addRow}
        searchRef={searchRef}
        handleScanKeyDown={handleScanKeyDown}
        shift={shift}
        me={me.data}
        lastInv={lastInv}
        onCloseShift={() => setShifting(true)}
        printerReady={printerReady}
        onConnectPrinter={connectPrinter}
        bridgeEnabled={bridge.enabled}
        bridgeDesc={bridge.description}
        onTestPrint={testServerPrint}
      />

      {/* Tab Bar */}
      <TabBar C={C} tabs={tabs} activeId={activeId} onSwitch={setActiveId} onAdd={addTab} onClose={closeTab} />

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", padding: "7px 8px 8px", gap: 7, minHeight: 0 }}>

        {/* Payment Panel (right in RTL) */}
        <PaymentPanel
          C={C}
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
        />

        {/* Cart Panel */}
        <CartPanel
          C={C}
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
              description: "ستُفقد كل الأصناف المُضافة في هذه السلّة. هل تتابع؟",
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
  C: C; dark: boolean;
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
  printerReady: boolean;
  onConnectPrinter: () => void;
  bridgeEnabled: boolean;
  bridgeDesc: string;
  onTestPrint: () => void;
}

function POSHeader({ C, dark, search, setSearch, showDrop, setShowDrop, results, searching, searchSettled, addToCart, searchRef, handleScanKeyDown, shift, me, lastInv, onCloseShift, printerReady, onConnectPrinter, bridgeEnabled, bridgeDesc, onTestPrint }: POSHeaderProps) {
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
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: C.primary, color: C.primaryFg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 18 }}>🏪</div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800, lineHeight: 1.2, color: C.fg }}>{SHOP}</div>
          <div style={{ fontSize: 11, color: C.mutedFg, lineHeight: 1.2 }}>نقطة البيع</div>
        </div>
      </div>

      <div style={{ width: 1, height: 28, background: C.border, flexShrink: 0 }} />

      {/* Search with smart scan */}
      <div ref={wrapRef} style={{ flex: 1, maxWidth: 560, position: "relative" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <span style={{ position: "absolute", right: 13, zIndex: 1, color: C.mutedFg, display: "flex", pointerEvents: "none", fontSize: 17 }}>🔍</span>
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
              style={{ position: "absolute", left: 8, background: "none", border: "none", cursor: "pointer", fontSize: 16, color: C.mutedFg, display: "flex", padding: 4 }}>✕</button>
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
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: C.fg }}>{p.productName}</div>
                  <div style={{ fontSize: 11.5, color: C.mutedFg, marginTop: 2 }}>
                    {p.sku} · {p.unitName}
                    <span style={{ marginRight: 10, color: stockColor(p.stockBase) }}>
                      مخزون: {fmt(p.stockBase)}
                    </span>
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
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", background: dark ? "oklch(0.28 0.05 264)" : "oklch(0.96 0.012 264)", border: `1px solid ${dark ? "oklch(0.38 0.08 264)" : "oklch(0.88 0.04 264)"}`, borderRadius: 8, padding: "3px 12px", flexShrink: 0, lineHeight: 1.3 }}>
          <span style={{ fontSize: 10, color: C.mutedFg, fontWeight: 600 }}>آخر فاتورة</span>
          <span style={{ fontSize: 15, fontWeight: 900, direction: "ltr", color: C.primary }}>{fmt(lastInv.total)}</span>
          <span style={{ fontSize: 9.5, color: C.mutedFg }}>{lastInv.num}</span>
        </div>
      )}

      {/* Shift badge */}
      {shift && (
        <div style={{ background: C.muted, borderRadius: 8, padding: "4px 11px", fontSize: 12, color: C.mutedFg, fontWeight: 700, flexShrink: 0, border: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
          <span style={{ color: "#22c55e", marginLeft: 4 }}>●</span>وردية #{shift.id}
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
          style={{ background: "none", border: `1.5px solid ${C.success}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: C.success, fontFamily: "inherit", fontWeight: 600, flexShrink: 0 }}>
          🖨️🌐
        </button>
      )}

      {/* Printer (WebUSB) */}
      {isWebUsbSupported() && (
        <button onClick={onConnectPrinter} title={printerReady ? "الطابعة الافتراضية مربوطة (تلقائياً) — اضغط لتبديلها" : "اربط طابعة حرارية (تُربط تلقائياً بعدها)"}
          style={{ background: "none", border: `1.5px solid ${printerReady ? C.success : C.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: printerReady ? C.success : C.mutedFg, fontFamily: "inherit", fontWeight: 600, flexShrink: 0 }}>
          {printerReady ? "🖨️✓" : "🖨️"}
        </button>
      )}

      {/* Close shift */}
      <button onClick={onCloseShift}
        style={{ height: 44, padding: "0 14px", background: "transparent", border: `1.5px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, color: C.fg, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        ⏻ إغلاق الوردية
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
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", fontSize: 13, color: active ? "rgba(255,255,255,.7)" : C.mutedFg, lineHeight: 1 }}>✕</button>
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
  selectedCustomer: RouterOutputs["customers"]["list"][number] | null;
  tierOverride: Tier | null; effectiveTier: Tier;
  setTierOvr: (v: Tier | null) => void;
  setCustId: (id: number | null) => void;
  showCustPicker: boolean; setShowCustPicker: (v: boolean) => void;
  onClear: () => void;
}

function CartPanel({ C, cart, total, selId, setSelId, changeQty, removeRow, numMode, setNumMode, customerId, selectedCustomer, tierOverride, effectiveTier, setTierOvr, setCustId, showCustPicker, setShowCustPicker, onClear }: CartPanelProps) {
  const itemCount = cart.reduce((s, c) => s + c.qty, 0);
  const TH: React.CSSProperties = { padding: "9px 10px", fontWeight: 700, fontSize: 12.5, color: C.mutedFg, textAlign: "center", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", background: C.muted };
  const TD: React.CSSProperties = { padding: "10px 8px", textAlign: "center", fontSize: 14 };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", height: 46, background: C.muted, borderBottom: `1px solid ${C.border}`, flexShrink: 0, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 14.5, color: C.fg }}>🛒 سلة المشتريات</span>
          {cart.length > 0 && (
            <span style={{ background: C.primary, color: C.primaryFg, borderRadius: 12, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>
              {cart.length} صنف · {itemCount} قطعة
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Customer picker */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowCustPicker(!showCustPicker)}
              style={{ height: 34, padding: "0 11px", background: customerId ? C.primarySoft : C.card, border: `1.5px solid ${customerId ? C.primary : C.border}`, borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: customerId ? C.primary : C.mutedFg, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
              👤 {selectedCustomer ? selectedCustomer.name : "عميل نقدي"}
              {selectedCustomer && (
                <span style={{ fontSize: 11, opacity: 0.8 }}>({TIER_LABEL[effectiveTier]})</span>
              )}
              ▾
            </button>

            {showCustPicker && (
              <div onClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 340, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 40px rgb(0 0 0/.2)", zIndex: 50, padding: 12 }}>
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
                  style={{ position: "absolute", top: 8, left: 10, background: "none", border: "none", cursor: "pointer", fontSize: 16, color: C.mutedFg }}>✕</button>
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

      {/* Table */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <th style={{ ...TH, width: 32 }}>#</th>
              <th style={{ ...TH, textAlign: "right" }}>المنتج</th>
              <th style={{ ...TH, width: 64 }}>الوحدة</th>
              <th style={{ ...TH, width: 110 }}>السعر</th>
              <th style={{ ...TH, width: 150 }}>الكمية</th>
              <th style={{ ...TH, width: 115 }}>الإجمالي</th>
              <th style={{ ...TH, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {cart.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "56px 0", textAlign: "center", color: C.mutedFg }}>
                  <div style={{ fontSize: 38, marginBottom: 10 }}>🛒</div>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>السلة فارغة</div>
                  <div style={{ fontSize: 12.5, marginTop: 6 }}>ابحث أو امسح الباركود لإضافة المنتجات</div>
                </td>
              </tr>
            )}
            {cart.map((c, i) => {
              const ep       = effectivePrice(c);
              const selected = selId === c.row.productUnitId;
              return (
                <tr key={c.row.productUnitId}
                  onClick={() => { setSelId(c.row.productUnitId); setNumMode("QTY"); }}
                  style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: selected ? C.primarySoft : "transparent", transition: "background .08s" }}
                  onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = C.muted; }}
                  onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                >
                  <td style={{ ...TD, color: C.mutedFg, fontWeight: 600 }}>{i + 1}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: C.fg }}>
                    {c.row.productName}
                    <span style={{ fontSize: 11, color: C.mutedFg, fontWeight: 400, marginRight: 5 }}>{c.row.sku}</span>
                    {c.disc != null && c.disc > 0 && (
                      <span style={{ fontSize: 11, color: C.danger, fontWeight: 700, marginRight: 4 }}>−{c.disc}%</span>
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
                  <td style={{ ...TD, padding: "6px 6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.row.productUnitId, c.qty - 1); }}
                        style={{ width: 38, height: 38, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 20, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                      <span style={{ minWidth: 40, textAlign: "center", fontWeight: 800, fontSize: 15, direction: "ltr", color: C.fg }}>{c.qty}</span>
                      <button onClick={(e) => { e.stopPropagation(); changeQty(c.row.productUnitId, c.qty + 1); }}
                        style={{ width: 38, height: 38, border: `1.5px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 20, color: C.fg, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                    </div>
                  </td>
                  <td style={{ ...TD, direction: "ltr", fontWeight: 800, fontSize: 14.5, color: C.fg }}>{fmt(itemTotal(c))}</td>
                  <td style={{ ...TD, padding: "6px" }}>
                    <button onClick={(e) => { e.stopPropagation(); removeRow(c.row.productUnitId); }}
                      style={{ width: 36, height: 36, background: "none", border: "none", cursor: "pointer", fontSize: 17, color: C.mutedFg }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      {cart.length > 0 && (
        <div style={{ borderTop: `2px solid ${C.border}`, padding: "9px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.muted, flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: C.mutedFg }}>{cart.length} صنف · {itemCount} قطعة</span>
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
  isPending: boolean; canPay: boolean;
}

function PaymentPanel({ C, total, payInput, setPayInput, paid, change, credit, isChange, isOwing, method, setMethod, numMode, setNumMode, numPress, onPay, onQuickPay, cartLen, isPending, canPay }: PaymentPanelProps) {

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

  const modeLabel = numMode === "QTY"  ? "الكمية — الصنف المحدد"
    : numMode === "DISC" ? "خصم % على الصنف"
    : "المبلغ المستلم";

  return (
    <div style={{ width: 420, flexShrink: 0, display: "flex", flexDirection: "column", background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>

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
              style={{ height: 28, padding: "0 7px", background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 7, cursor: "pointer", fontSize: 11.5, fontWeight: 700, color: C.fg, fontFamily: "inherit" }}>
              {fmt(a)}
            </button>
          ))}
          {cartLen > 0 && (
            <button onClick={() => setPayInput(String(total))}
              style={{ height: 28, padding: "0 7px", background: C.card, border: `1.5px solid ${C.primary}`, borderRadius: 7, cursor: "pointer", fontSize: 11.5, fontWeight: 700, color: C.primary, fontFamily: "inherit" }}>
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

      {/* Payment method */}
      <div style={{ padding: "4px 11px 3px", flexShrink: 0 }}>
        <div style={{ fontSize: 11.5, color: C.mutedFg, fontWeight: 700, marginBottom: 4 }}>طريقة الدفع</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={payMethodStyle(method === "CASH")}     onClick={() => setMethod("CASH")}>
            <span style={{ fontSize: 22 }}>💵</span>نقداً
          </button>
          <button style={payMethodStyle(method === "CARD")}     onClick={() => setMethod("CARD")}>
            <span style={{ fontSize: 22 }}>💳</span>بطاقة
          </button>
          <button
            style={{ ...payMethodStyle(method === "TRANSFER" || method === "CHECK" || method === "WALLET"), minHeight: 50, fontSize: 12 }}
            onClick={() => setMethod(method === "TRANSFER" ? "CHECK" : method === "CHECK" ? "WALLET" : "TRANSFER")}>
            <span style={{ fontSize: 18 }}>🔄</span>
            {method === "TRANSFER" ? "تحويل" : method === "CHECK" ? "صك" : method === "WALLET" ? "محفظة" : "أخرى"}
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
            <span style={{ fontSize: 22, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(change)} <span style={{ fontSize: 12.5, fontWeight: 500, color: C.mutedFg }}>د.ع</span></span>
          </>
        )}
        {cartLen > 0 && !!payInput && isOwing && (
          <>
            <span style={{ fontSize: 13.5, color: C.amber, fontWeight: 600 }}>المتبقي للدفع</span>
            <span style={{ fontSize: 22, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(credit)} <span style={{ fontSize: 12.5, fontWeight: 500 }}>د.ع</span></span>
          </>
        )}
      </div>

      {/* ⚡ Quick pay */}
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
          ⚡ دفع سريع وطباعة — نقداً
        </button>
        <div style={{ textAlign: "center", marginTop: 2, fontSize: 10, color: C.mutedFg }}>للأوقات المزدحمة — يتجاوز كل الخطوات</div>
      </div>

      <div style={{ margin: "3px 11px", borderTop: `1.5px dashed ${C.border}` }} />

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
          {isPending ? "جارٍ…" : !cartLen ? "السلة فارغة" : `✓ إتمام الدفع — ${fmt(total)} د.ع`}
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

function ReceiptOverlay({ C, receipt, onDismiss, onPrint }: ReceiptOverlayProps) {
  return (
    <div onClick={onDismiss}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: C.overlay, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s ease", cursor: "pointer" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, borderRadius: 20, padding: "36px 44px 30px", width: 480, maxWidth: "92vw", boxShadow: "0 28px 72px rgb(0 0 0/.42)", animation: "popIn .22s ease", cursor: "default", textAlign: "center", direction: "rtl" }}>

        <div style={{ width: 76, height: 76, borderRadius: "50%", background: C.success, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", animation: "pulse 1.2s ease-out" }}>
          <span style={{ fontSize: 38, color: "#fff" }}>✓</span>
        </div>

        <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 4, color: C.fg }}>تم الدفع بنجاح</div>
        <div style={{ fontSize: 13, color: C.mutedFg, marginBottom: 24 }}>فاتورة: {receipt.invoiceNumber}</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[
            { label: "المبلغ المدفوع", value: fmt(receipt.received), color: C.primary },
            { label: "إجمالي الفاتورة", value: fmt(receipt.total),   color: C.fg },
          ].map((item) => (
            <div key={item.label} style={{ background: C.muted, borderRadius: 10, padding: "14px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 12, color: C.mutedFg, marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 26, fontWeight: 900, direction: "ltr", color: item.color }}>{item.value}</div>
              <div style={{ fontSize: 11, color: C.mutedFg }}>د.ع</div>
            </div>
          ))}
        </div>

        {receipt.change > 0 && (
          <div style={{ background: "oklch(0.50 0.13 155 / .1)", border: "1.5px solid oklch(0.50 0.13 155 / .28)", borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.success }}>الباقي للعميل</span>
            <span style={{ fontSize: 26, fontWeight: 900, color: C.success, direction: "ltr" }}>{fmt(receipt.change)} <span style={{ fontSize: 12 }}>د.ع</span></span>
          </div>
        )}

        {receipt.isCredit && receipt.credit > 0 && (
          <div style={{ background: "oklch(0.65 0.15 75 / .1)", border: "1.5px solid oklch(0.65 0.15 75 / .3)", borderRadius: 10, padding: "12px 18px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.amber }}>آجل على {receipt.customerName ?? "العميل"}</span>
            <span style={{ fontSize: 26, fontWeight: 900, color: C.amber, direction: "ltr" }}>{fmt(receipt.credit)} <span style={{ fontSize: 12 }}>د.ع</span></span>
          </div>
        )}

        <div style={{ marginBottom: 20, fontSize: 13.5, color: C.mutedFg }}>
          طريقة الدفع: <strong style={{ color: C.fg }}>{receipt.method}</strong>
          &nbsp;·&nbsp; {receipt.lines.length} صنف
          {receipt.customerName && <>&nbsp;·&nbsp; <strong style={{ color: C.fg }}>{receipt.customerName}</strong></>}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onPrint}
            style={{ flex: 1, height: 50, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, fontFamily: "inherit", fontSize: 14.5, fontWeight: 700, cursor: "pointer", color: C.fg }}>
            🖨️ طباعة الإيصال
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
}

function ShiftCloseDialog({ C, shift, branchId, onClose, onClosed }: ShiftCloseDialogProps) {
  const [counted, setCounted] = useState("");
  const utils = trpc.useUtils();

  const reportQ = trpc.shifts.report.useQuery(
    { shiftId: shift!.id },
    { enabled: !!shift }
  );
  const report = reportQ.data;

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      const rep = report;
      const payRows: [string, string, string][] = (rep?.payments ?? []).map((p) => [
        `${p.method} ${p.direction === "IN" ? "وارد" : "صادر"}`,
        String(p.count),
        String(p.total),
      ]);
      await printDoc({
        kind: "zreport", title: SHOP,
        subtitle: "تقرير نهاية الوردية (Z)",
        meta: [`وردية #${r.shiftId}`, new Date().toLocaleString("ar-IQ-u-nu-latn")],
        columns: ["الحركة", "عدد", "مبلغ"],
        rows: payRows.length ? payRows : [["لا حركات", "0", "0.00"]],
        totals: [
          { label: "عدد الفواتير",      value: String(rep?.invoiceCount ?? 0) },
          { label: "إجمالي المبيعات",   value: String(rep?.salesTotal ?? "0.00") },
          { label: "الرصيد الافتتاحي",  value: r.openingBalance },
          { label: "النقد المتوقع",      value: r.expectedCash },
          { label: "النقد المعدود",      value: r.countedCash },
          { label: "الفرق",             value: r.variance },
        ],
        footer: "نهاية الوردية — شكراً",
      });
      await utils.shifts.current.invalidate();
      onClosed();
    },
  });

  // النقد المتوقع = رصيد افتتاحي + كل CASH وارد (مبيعات) - كل CASH صادر (مصروفات).
  // §٥: نجمع ونطرح بدقّة Decimal (Number + reduce + sub يتراكم عليه الانجراف على مئات الدفعات).
  const cashInD     = (report?.payments ?? []).filter((p) => p.method === "CASH" && p.direction === "IN" ).reduce((s, p) => s.plus(D(p.total)), D(0));
  const cashOutD    = (report?.payments ?? []).filter((p) => p.method === "CASH" && p.direction === "OUT").reduce((s, p) => s.plus(D(p.total)), D(0));
  const openingD    = D(shift?.openingBalance ?? 0);
  const expectedD   = report != null ? openingD.plus(cashInD).minus(cashOutD) : null;
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
      <div onClick={(e) => e.stopPropagation()}
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
              ...(report != null ? [["النقد المتوقع بالصندوق", `${fmt(openingBal + cashIn - cashOut)} د.ع`] as [string, string]] : []),
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
                <div style={{ marginTop: 7, fontSize: 14, fontWeight: 700, color: diff >= 0 ? C.success : C.danger }}>
                  الفرق: {diff >= 0 ? "+" : ""}{fmt(diff)} د.ع
                  {diff === 0 && " ✓ مطابق تماماً"}
                  {diff > 0  && " (زيادة)"}
                  {diff < 0  && " (عجز)"}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button onClick={onClose}
                style={{ flex: 1, height: 46, background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: C.fg }}>
                إلغاء
              </button>
              <button
                disabled={!counted || closeShift.isPending}
                onClick={() => shift && closeShift.mutate({ shiftId: shift.id, countedCash: counted })}
                style={{ flex: 1, height: 46, background: !counted || closeShift.isPending ? C.muted : C.danger, color: !counted || closeShift.isPending ? C.mutedFg : "#fff", border: "none", borderRadius: 9, cursor: !counted || closeShift.isPending ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>
                {closeShift.isPending ? "جارٍ الإغلاق…" : "إغلاق وطباعة Z"}
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
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgb(0 0 0/.45)", display: "flex", alignItems: "center", justifyContent: "center", direction: "rtl", fontFamily: "'Cairo', system-ui, sans-serif" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, borderRadius: 16, padding: "24px 28px", width: 380, boxShadow: "0 20px 56px rgb(0 0 0/.3)", animation: "popIn .2s ease" }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4, color: C.amber }}>⚠ موافقة مدير مطلوبة</div>
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
