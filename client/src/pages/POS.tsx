import CustomerPicker from "@/components/CustomerPicker";
import { clearCartDraft, loadCartDraft, saveCartDraft } from "@/lib/cartDraft";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isPaired, isWebUsbSupported, pairPrinter, printDoc, type PrintDoc } from "@/lib/printing/print";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { parseScan } from "@/lib/scanRouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
type PosRow = RouterOutputs["catalog"]["posList"][number];
type CartItem = { row: PosRow; qty: number };
type Receipt = {
  invoiceNumber: string;
  date: string;
  customerName?: string;
  lines: { name: string; unit: string; qty: number; price: number; total: number }[];
  total: number;
  received: number;
  change: number;
  credit: number;
  status: string;
};

const TIER_LABEL: Record<Tier, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };
const TIER_CLS: Record<Tier, string> = {
  RETAIL: "bg-emerald-100 text-emerald-700",
  WHOLESALE: "bg-blue-100 text-blue-700",
  GOVERNMENT: "bg-violet-100 text-violet-700",
};
const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "نقد",
  CARD: "بطاقة",
  CHECK: "صك",
  TRANSFER: "تحويل",
  WALLET: "محفظة",
};

const money = (n: number) => n.toFixed(2);
const SHOP = "الرؤية العربية";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function buildReceiptDoc(r: Receipt): PrintDoc {
  const totals: { label: string; value: string }[] = [
    { label: "الإجمالي", value: money(r.total) },
    { label: "المستلم", value: money(r.received) },
  ];
  if (r.credit > 0) totals.push({ label: "آجل/ذمة", value: money(r.credit) });
  else totals.push({ label: "الباقي", value: money(r.change) });
  return {
    kind: "receipt",
    title: SHOP,
    subtitle: r.customerName ? `عميل: ${r.customerName}` : "للتجارة العامة والقرطاسية",
    meta: [`فاتورة: ${r.invoiceNumber}`, r.date],
    columns: ["الصنف", "كمية", "سعر", "إجمالي"],
    rows: r.lines.map((l) => [`${l.name} (${l.unit})`, String(l.qty), money(l.price), money(l.total)]),
    totals,
    footer: "شكراً لتعاملكم معنا",
  };
}

export default function POS() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const utils = trpc.useUtils();

  const shiftQ = trpc.shifts.current.useQuery({ branchId });
  const shift = shiftQ.data;

  const [cart, setCart] = useState<CartItem[]>([]);
  const [barcode, setBarcode] = useState("");
  const [search, setSearch] = useState("");
  const [calc, setCalc] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastReceipt, setLastReceipt] = useState<Receipt | null>(null);
  const [lastInvoiceId, setLastInvoiceId] = useState<number | null>(null);
  const [printerReady, setPrinterReady] = useState(isPaired());
  const [opening, setOpening] = useState("0");
  // موافقة المدير على تجاوز حدّ الائتمان + اختصارات
  const [creditPrompt, setCreditPrompt] = useState<string | null>(null);
  const [mgrEmail, setMgrEmail] = useState("");
  const [mgrPassword, setMgrPassword] = useState("");
  const [showHotkeys, setShowHotkeys] = useState(false);
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Customer + tier (tier auto-syncs to customer.defaultPriceTier unless explicitly overridden).
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [tierOverride, setTierOverride] = useState<Tier | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const customers = trpc.customers.list.useQuery();

  // استرجاع مسوّدة السلّة عند فتح POS (لا فقد بعد تحديث/انقطاع).
  useEffect(() => {
    if (draftRestored) return;
    const d = loadCartDraft<CartItem>(branchId);
    if (d) {
      setCart(d.cart);
      if (d.customerId != null) setCustomerId(d.customerId);
      if (d.tierOverride) setTierOverride(d.tierOverride);
    }
    setDraftRestored(true);
  }, [branchId, draftRestored]);

  // حفظ المسوّدة تلقائياً عند أي تغيّر (بعد الاسترجاع الأوّل فقط).
  useEffect(() => {
    if (!draftRestored) return;
    saveCartDraft<CartItem>(branchId, { cart, customerId, tierOverride });
  }, [cart, customerId, tierOverride, branchId, draftRestored]);
  const selectedCustomer = useMemo(
    () => (customers.data ?? []).find((c) => c.id === customerId) ?? null,
    [customers.data, customerId]
  );
  const effectiveTier: Tier =
    tierOverride ?? (selectedCustomer?.defaultPriceTier as Tier | undefined) ?? "RETAIL";

  const total = cart.reduce((s, c) => s + Number(c.row.price ?? 0) * c.qty, 0);
  const received = Number(calc || 0);
  const change = received - total;
  const credit = total - received;
  const isCredit = received < total;

  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: effectiveTier, query: search, limit: 8 },
    { enabled: search.trim().length > 0 }
  );

  function addRow(row: PosRow) {
    if (row.price == null) {
      setMessage({ kind: "err", text: `لا سعر مُعرّف لـ ${row.productName} (${row.unitName}) في فئة ${TIER_LABEL[effectiveTier]}` });
      return;
    }
    setMessage(null);
    setCart((prev) => {
      const i = prev.findIndex((c) => c.row.productUnitId === row.productUnitId);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return next;
      }
      return [...prev, { row, qty: 1 }];
    });
  }
  function setQty(id: number, qty: number) {
    setCart((prev) => (qty <= 0 ? prev.filter((c) => c.row.productUnitId !== id) : prev.map((c) => (c.row.productUnitId === id ? { ...c, qty } : c))));
  }

  async function lookupProductBarcode(code: string) {
    if (!code) return;
    try {
      const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier: effectiveTier });
      if (!row) setMessage({ kind: "err", text: `باركود غير معروف: ${code}` });
      else addRow(row);
    } catch (e: any) {
      setMessage({ kind: "err", text: e?.message ?? "خطأ في المسح" });
    }
  }

  async function scanBarcode() {
    const code = barcode.trim();
    await lookupProductBarcode(code);
    setBarcode("");
  }

  // معالج ماسح HID — يُفرَّق بين أنواع الرموز تلقائياً (Strategy Pattern)
  const handleHidScan = useCallback(async (raw: string) => {
    const result = parseScan(raw);
    if (result.type === "product") {
      await lookupProductBarcode(result.barcode);
    } else if (result.type === "customer") {
      setCustomerId(result.id);
      setMessage({ kind: "ok", text: `تم تحديد العميل #${result.id}` });
    }
    // INV/WO/PO/QUO: لا إجراء في POS — تُعالَج من صفحاتها المختصة
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, effectiveTier]);

  // تفعيل ماسح HID تلقائياً — بعد تعريف handleHidScan، يُعطَّل عند فتح نافذة الإيصال
  useBarcodeScanner(handleHidScan, { enabled: !lastReceipt });

  async function connectPrinter() {
    try {
      await pairPrinter();
      setPrinterReady(true);
      setMessage({ kind: "ok", text: "تم ربط الطابعة الحرارية ✓" });
    } catch (e: any) {
      setMessage({ kind: "err", text: e?.message ?? "تعذّر ربط الطابعة" });
    }
  }

  const openShift = trpc.shifts.open.useMutation({
    onSuccess: async (res) => {
      await shiftQ.refetch();
      await printDoc({
        kind: "opening",
        title: SHOP,
        subtitle: "بيان الرصيد الافتتاحي",
        meta: [`وردية #${res.shiftId}`, new Date().toLocaleString("ar-IQ")],
        totals: [{ label: "الرصيد الافتتاحي", value: money(Number(opening || 0)) }],
        footer: "بداية الوردية",
      });
    },
    onError: (e) => setMessage({ kind: "err", text: e.message }),
  });

  const closeShift = trpc.shifts.close.useMutation({
    onSuccess: async (r) => {
      setMessage({ kind: "ok", text: `أُغلقت الوردية — المتوقع ${r.expectedCash}، المعدود ${r.countedCash}، الفروقات ${r.variance}` });
      await shiftQ.refetch();
      const rep = await utils.shifts.report.fetch({ shiftId: r.shiftId });
      const payRows = (rep?.payments ?? []).map((p) => [
        `${p.method} ${p.direction === "IN" ? "وارد" : "صادر"}`,
        String(p.count),
        money(Number(p.total)),
      ]);
      await printDoc({
        kind: "zreport",
        title: SHOP,
        subtitle: "تقرير نهاية الوردية (Z)",
        meta: [`وردية #${r.shiftId}`, new Date().toLocaleString("ar-IQ")],
        columns: ["الحركة", "عدد", "مبلغ"],
        rows: payRows.length ? payRows : [["لا حركات", "0", "0.00"]],
        totals: [
          { label: "عدد الفواتير", value: String(rep?.invoiceCount ?? 0) },
          { label: "إجمالي المبيعات", value: money(Number(rep?.salesTotal ?? 0)) },
          { label: "الرصيد الافتتاحي", value: r.openingBalance },
          { label: "النقد المتوقع", value: r.expectedCash },
          { label: "النقد المعدود", value: r.countedCash },
          { label: "الفروقات", value: r.variance },
        ],
        footer: "نهاية الوردية",
      });
    },
    onError: (e) => setMessage({ kind: "err", text: e.message }),
  });

  const sale = trpc.sales.create.useMutation({
    onSuccess: async (r) => {
      const finalReceived = isCredit ? received : total;
      const finalChange = isCredit ? 0 : received - total;
      const finalCredit = isCredit ? total - received : 0;
      const rec: Receipt = {
        invoiceNumber: r.invoiceNumber,
        date: new Date().toLocaleString("ar-IQ"),
        customerName: selectedCustomer?.name,
        lines: cart.map((c) => ({ name: c.row.productName, unit: c.row.unitName, qty: c.qty, price: Number(c.row.price), total: Number(c.row.price) * c.qty })),
        total,
        received: finalReceived,
        change: finalChange,
        credit: finalCredit,
        status: r.status,
      };
      setLastReceipt(rec);
      setLastInvoiceId(r.invoiceId);
      clearCartDraft(branchId); // بيع ناجح ⇒ امسح المسوّدة
      const tail = finalCredit > 0 ? ` — آجل ${money(finalCredit)} على ${selectedCustomer?.name ?? "العميل"}` : "";
      setMessage({ kind: "ok", text: `تم البيع ✓ فاتورة ${r.invoiceNumber} (${r.status})${tail}` });
      setCart([]);
      setCalc("");
      await printDoc(buildReceiptDoc(rec));
      await Promise.all([
        utils.catalog.posList.invalidate(),
        utils.customers.list.invalidate(),
        shiftQ.refetch(),
      ]);
      setCreditPrompt(null);
      setMgrEmail("");
      setMgrPassword("");
    },
    onError: (e) => {
      // تجاوز حدّ الائتمان ⇒ افتح نافذة موافقة المدير بدل رسالة خطأ عابرة.
      if ((e.data as { code?: string } | undefined)?.code === "PRECONDITION_FAILED") {
        setCreditPrompt(e.message);
      } else {
        setMessage({ kind: "err", text: e.message });
      }
    },
  });

  function submitSale(approval?: { email: string; password: string }) {
    if (!shift || !cart.length) return;
    setMessage(null);
    if (isCredit && customerId == null) {
      setMessage({ kind: "err", text: "البيع الآجل (دفع أقل من الإجمالي) يتطلّب اختيار عميل." });
      return;
    }
    const amount = isCredit ? money(received) : money(total);
    sale.mutate({
      branchId,
      shiftId: shift.id,
      sourceType: "POS",
      customerId: customerId ?? undefined,
      priceTier: effectiveTier,
      lines: cart.map((c) => ({ variantId: c.row.variantId, productUnitId: c.row.productUnitId, quantity: String(c.qty) })),
      payment: { amount, method },
      ...(approval ? { managerApproval: approval } : {}),
    });
  }
  const completeSale = () => submitSale();

  // اختصارات الكاشير: F2 بحث/مسح • F4 إتمام الدفع • F9 طباعة آخر فاتورة • F12 تفريغ السلّة • Esc إغلاق
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (creditPrompt) { if (e.key === "Escape") setCreditPrompt(null); return; }
      switch (e.key) {
        case "F2": e.preventDefault(); barcodeRef.current?.focus(); break;
        case "F4": e.preventDefault(); if (cart.length && !sale.isPending) completeSale(); break;
        case "F9": e.preventDefault(); if (lastReceipt) printDoc(buildReceiptDoc(lastReceipt)); break;
        case "F12": e.preventDefault(); if (cart.length && window.confirm("تفريغ السلّة؟")) { setCart([]); setCalc(""); } break;
        case "Escape": setShowHotkeys(false); setMessage(null); break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, sale.isPending, lastReceipt, creditPrompt, isCredit, customerId, received, total, method, effectiveTier]);

  if (shiftQ.isLoading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">جارٍ التحميل…</div>;

  if (!shift) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background">
        <Card className="w-full max-w-sm">
          <CardHeader><CardTitle>افتح وردية للبدء</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="opening">الرصيد الافتتاحي للصندوق</Label>
              <Input id="opening" dir="ltr" value={opening} onChange={(e) => setOpening(e.target.value)} />
            </div>
            {message && <p className={message.kind === "ok" ? "text-sm text-green-600" : "text-sm text-destructive"}>{message.text}</p>}
            <Button className="w-full" disabled={openShift.isPending} onClick={() => openShift.mutate({ branchId, openingBalance: opening })}>فتح الوردية</Button>
            <Link href="/" className="block text-center text-sm text-muted-foreground">← الرئيسية</Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00", "."];

  const completeBtnLabel = isCredit
    ? `إتمام بيع آجل (${money(received || 0)} ${METHOD_LABEL[method]} + ${money(credit)} على الذمة)`
    : `إتمام الدفع ${METHOD_LABEL[method]} (${money(total)})`;

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold">نقطة البيع — {SHOP}</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">وردية #{shift.id} مفتوحة</span>
          <Button variant="ghost" size="sm" onClick={() => setShowHotkeys((v) => !v)} title="اختصارات لوحة المفاتيح">؟ اختصارات</Button>
          <Button variant="outline" size="sm" disabled={closeShift.isPending}
            onClick={() => { const c = window.prompt("النقد المعدود في الصندوق:", "0"); if (c != null) closeShift.mutate({ shiftId: shift.id, countedCash: c }); }}>
            إغلاق الوردية
          </Button>
          <Link href="/" className="text-muted-foreground">الرئيسية</Link>
        </div>
      </div>

      {message && (
        <div className={`mb-3 text-sm flex items-center gap-3 ${message.kind === "ok" ? "text-green-600" : "text-destructive"}`}>
          <span>{message.text}</span>
          {message.kind === "ok" && lastInvoiceId != null && (
            <Link href={`/invoices/${lastInvoiceId}`} className="underline">فتح الفاتورة</Link>
          )}
        </div>
      )}

      {showHotkeys && (
        <div className="mb-3 rounded-md border bg-muted/40 p-3 text-xs grid grid-cols-2 md:grid-cols-5 gap-2">
          <span><kbd className="font-mono">F2</kbd> بحث/مسح</span>
          <span><kbd className="font-mono">F4</kbd> إتمام الدفع</span>
          <span><kbd className="font-mono">F9</kbd> طباعة آخر فاتورة</span>
          <span><kbd className="font-mono">F12</kbd> تفريغ السلّة</span>
          <span><kbd className="font-mono">Esc</kbd> إغلاق</span>
        </div>
      )}

      {creditPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCreditPrompt(null)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardHeader><CardTitle className="text-base text-amber-700">موافقة مدير مطلوبة</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{creditPrompt}</p>
              <div className="space-y-1">
                <Label>بريد المدير</Label>
                <Input dir="ltr" value={mgrEmail} onChange={(e) => setMgrEmail(e.target.value)} placeholder="manager@alroya.local" />
              </div>
              <div className="space-y-1">
                <Label>كلمة مرور المدير</Label>
                <Input type="password" dir="ltr" value={mgrPassword} onChange={(e) => setMgrPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && mgrEmail && mgrPassword) submitSale({ email: mgrEmail, password: mgrPassword }); }} />
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" disabled={!mgrEmail || !mgrPassword || sale.isPending}
                  onClick={() => submitSale({ email: mgrEmail, password: mgrPassword })}>
                  {sale.isPending ? "جارٍ…" : "اعتمد وأكمل البيع"}
                </Button>
                <Button variant="outline" onClick={() => setCreditPrompt(null)}>إلغاء</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          <Card>
            <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
              <CustomerPicker
                customerId={customerId}
                onCustomerChange={(id) => { setCustomerId(id); setTierOverride(null); }}
                balance={selectedCustomer?.currentBalance ?? null}
              />
              <div className="space-y-1">
                <Label>فئة السعر</Label>
                <div className="flex gap-2 items-center">
                  <select
                    className={selectCls + " flex-1"}
                    value={effectiveTier}
                    onChange={(e) => setTierOverride(e.target.value as Tier)}
                  >
                    <option value="RETAIL">مفرد</option>
                    <option value="WHOLESALE">جملة</option>
                    <option value="GOVERNMENT">حكومي</option>
                  </select>
                  <span className={`text-xs rounded-full px-2 py-0.5 ${TIER_CLS[effectiveTier]}`}>
                    {TIER_LABEL[effectiveTier]}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2 relative">
            <Input ref={barcodeRef} autoFocus placeholder="امسح الباركود ثم Enter (F2)" dir="ltr" value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") scanBarcode(); }} />
            <div className="relative w-64">
              <Input placeholder="بحث بالاسم/SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search.trim() && (searchResults.data?.length ?? 0) > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-64 overflow-auto">
                  {searchResults.data!.map((row) => (
                    <button key={row.productUnitId} className="block w-full text-right px-3 py-2 text-sm hover:bg-accent"
                      onClick={() => { addRow(row); setSearch(""); }}>
                      {row.productName} <span className="text-muted-foreground">({row.unitName})</span> — {row.price == null ? "بلا سعر" : money(Number(row.price))}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-right">
                    <th className="p-2">الصنف</th>
                    <th className="p-2">الوحدة</th>
                    <th className="p-2 text-left">السعر</th>
                    <th className="p-2 text-center">الكمية</th>
                    <th className="p-2 text-left">الإجمالي</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.length === 0 && (
                    <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">السلة فارغة — امسح باركوداً للإضافة.</td></tr>
                  )}
                  {cart.map((c) => (
                    <tr key={c.row.productUnitId} className="border-t">
                      <td className="p-2">{c.row.productName}</td>
                      <td className="p-2 text-muted-foreground">{c.row.unitName}</td>
                      <td className="p-2 text-left">{money(Number(c.row.price))}</td>
                      <td className="p-2">
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="outline" size="sm" onClick={() => setQty(c.row.productUnitId, c.qty - 1)}>−</Button>
                          <span className="w-7 text-center">{c.qty}</span>
                          <Button variant="outline" size="sm" onClick={() => setQty(c.row.productUnitId, c.qty + 1)}>+</Button>
                        </div>
                      </td>
                      <td className="p-2 text-left font-medium">{money(Number(c.row.price) * c.qty)}</td>
                      <td className="p-2 text-center"><Button variant="ghost" size="sm" onClick={() => setQty(c.row.productUnitId, 0)}>✕</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit sticky top-4">
          <CardHeader><CardTitle>الدفع</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-lg font-bold"><span>الإجمالي</span><span>{money(total)}</span></div>
            <div className="space-y-1">
              <Label>المبلغ المستلم الآن</Label>
              <div className="border rounded-md p-2 text-left text-xl font-mono tabular-nums">{calc || "0"}</div>
            </div>
            <div className="space-y-1">
              <Label>طريقة الدفع</Label>
              <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                <option value="CASH">نقد</option>
                <option value="CARD">بطاقة</option>
                <option value="TRANSFER">تحويل</option>
                <option value="CHECK">صك</option>
                <option value="WALLET">محفظة</option>
              </select>
            </div>
            {isCredit ? (
              <div className="flex justify-between text-sm">
                <span className="text-amber-700">آجل على {selectedCustomer?.name ?? "—"}</span>
                <span className="text-amber-700 font-semibold tabular-nums">{money(credit)}</span>
              </div>
            ) : (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">الباقي للعميل</span>
                <span className={change < 0 ? "text-destructive" : "text-green-600"}>{money(change)}</span>
              </div>
            )}
            {isCredit && customerId == null && (
              <p className="text-xs text-destructive">⚠ بيع آجل يتطلّب اختيار عميل.</p>
            )}

            <div className="grid grid-cols-3 gap-2">
              {keys.map((k) => (
                <Button key={k} variant="outline" className="h-11 text-lg" onClick={() => setCalc((p) => (k === "." && p.includes(".") ? p : p + k))}>{k}</Button>
              ))}
              <Button variant="outline" className="h-11" onClick={() => setCalc((p) => p.slice(0, -1))}>⌫</Button>
              <Button variant="outline" className="h-11" onClick={() => setCalc("")}>C</Button>
              <Button variant="outline" className="h-11" onClick={() => setCalc(money(total))}>= الإجمالي</Button>
            </div>

            <Button
              className="w-full h-12 text-base"
              disabled={!cart.length || sale.isPending || (isCredit && customerId == null)}
              onClick={completeSale}
            >
              {sale.isPending ? "جارٍ…" : completeBtnLabel}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={!lastReceipt} onClick={() => lastReceipt && printDoc(buildReceiptDoc(lastReceipt))}>
                طباعة آخر فاتورة
              </Button>
              {isWebUsbSupported() && (
                <Button variant="outline" className="flex-1" onClick={connectPrinter}>
                  {printerReady ? "طابعة مربوطة ✓" : "ربط طابعة حرارية"}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {printerReady ? "الطباعة عبر الطابعة الحرارية (USB)" : "الطباعة عبر حوار المتصفّح (بديل)"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
