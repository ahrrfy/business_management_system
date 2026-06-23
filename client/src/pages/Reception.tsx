import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { CustomizationDialog, type CustomizationData, composeCustomizationText, emptyCustomization } from "@/components/CustomizationDialog";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { parseScan } from "@/lib/scanRouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

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

type CartLine = {
  key: string; // معرّف فريد للسطر (للأصناف المخصّصة المتعدّدة من نفس المنتج)
  row: PosRow;
  qty: number;
  origPrice?: number;
  disc?: number; // نسبة خصم
  custom?: CustomizationData; // إن كان مخصّصاً
};

const QUICK_AMTS = [1000, 5000, 10000, 25000];
const CHANNEL_BADGE_COLORS = {
  WHATSAPP: "bg-emerald-500",
  INSTAGRAM: "bg-pink-500",
  TIKTOK: "bg-rose-500",
  PHONE: "bg-sky-500",
  WALK_IN: "bg-slate-500",
  OTHER: "bg-violet-500",
} as const;

function effectivePrice(line: CartLine): number {
  const base = line.origPrice ?? Number(line.row.price ?? 0);
  if (line.disc && line.disc > 0) return base * (1 - line.disc / 100);
  return base;
}
function lineTotal(line: CartLine): number {
  return effectivePrice(line) * line.qty;
}
function isCustomKind(line: CartLine): boolean {
  return !!line.custom;
}

export default function Reception() {
  const me = trpc.auth.me.useQuery();
  const branchId = useMemo(() => Number(me.data?.branchId ?? 1), [me.data?.branchId]);
  const utils = trpc.useUtils();

  // وردية مفتوحة لازمة لتسجيل البيع (saleRouter).
  const shiftQ = trpc.shifts.current.useQuery({ branchId });
  const shift = shiftQ.data ?? null;

  // ───── الحالة ─────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [numMode, setNumMode] = useState<NumMode>("PAY");
  const [payInput, setPayInput] = useState("");
  const [method, setMethod] = useState<PayMethod>("CASH");
  const [showInbox, setShowInbox] = useState(false);
  const [showCustomization, setShowCustomization] = useState<{ row: PosRow; editingKey?: string } | null>(null);
  const [customer, setCustomer] = useState<SmartCustomerValue>({ customerId: null, name: "", phone: null, isNew: false });
  const [channel, setChannel] = useState<keyof typeof CHANNEL_BADGE_COLORS>("WALK_IN");
  const [channelHandle, setChannelHandle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // idempotency: مفتاح واحد لكل دورة إرسال — يتجدّد بعد النجاح.
  const reqIdRef = useRef<string>(crypto.randomUUID());
  const searchRef = useRef<HTMLInputElement>(null);

  // ───── حسابات هجينة ───────────────────────────────────────────────────────
  const cartCount = cart.reduce((s, c) => s + c.qty, 0);
  const sumDirectD = cart.filter((c) => !isCustomKind(c)).reduce((s, c) => s.plus(D(lineTotal(c))), D(0));
  const sumCustomD = cart.filter((c) => isCustomKind(c)).reduce((s, c) => {
    const base = D(lineTotal(c));
    const delivery = c.custom?.hasDelivery ? D(c.custom.deliveryCost || 0) : D(0);
    return s.plus(base).plus(delivery);
  }, D(0));
  const grandTotalD = sumDirectD.plus(sumCustomD);
  const grandTotal = round2(grandTotalD).toNumber();
  const sumDirect = round2(sumDirectD).toNumber();
  const sumCustom = round2(sumCustomD).toNumber();

  // العربون الإجمالي من نوافذ التخصيص.
  const totalDepositsD = cart
    .filter(isCustomKind)
    .reduce((s, c) => s.plus(D(c.custom?.deposit || 0)), D(0));
  // المبلغ المتوقّع دفعه فوراً = بيع مباشر (كامل) + عربون المخصّص.
  const expectedNowD = sumDirectD.plus(totalDepositsD);
  const expectedNow = round2(expectedNowD).toNumber();

  // ما أدخله الكاشير في لوحة الأرقام (مع تكيّف Quick Pay).
  const paidD = D(payInput || 0);
  const paid = round2(paidD).toNumber();
  const changeD = paidD.minus(expectedNowD);
  const change = round2(changeD).toNumber();
  const remainingD = expectedNowD.minus(paidD);
  const remaining = round2(remainingD).toNumber();
  const isChange = paidD.gt(0) && paidD.gte(expectedNowD);
  const isOwing = paidD.gt(0) && paidD.lt(expectedNowD);

  // ───── البحث ──────────────────────────────────────────────────────────────
  const debounced = useDebouncedValue(search, 180);
  const searchResults = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: debounced, limit: 15 },
    { enabled: debounced.trim().length >= 2, placeholderData: keepPreviousData, staleTime: 15_000 },
  );
  const results = searchResults.data ?? [];
  const resultsEmpty = results.length === 0 && debounced.trim().length >= 2 && !searchResults.isFetching;

  // ───── السلّة ─────────────────────────────────────────────────────────────
  const addRow = useCallback((row: PosRow) => {
    // المنتج المخصّص (products.isCustomizable=true) ⇒ افتح نافذة التخصيص.
    // الموجود مسبقاً في السلّة كمخصّص نتركه — لإضافة آخر، يضيفه المستخدم سطراً جديداً.
    if (row.isCustomizable) {
      setShowCustomization({ row });
      setSearch("");
      setShowDrop(false);
      return;
    }
    if (row.price == null) {
      notify.err(`لا سعر لـ ${row.productName} (${row.unitName})`);
      return;
    }
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
    setSearch("");
    setShowDrop(false);
    searchRef.current?.focus();
  }, []);

  function saveCustomization(data: CustomizationData) {
    if (!showCustomization) return;
    const { row, editingKey } = showCustomization;
    if (editingKey) {
      setCart((prev) => prev.map((c) => (c.key === editingKey ? { ...c, custom: data, qty: 1 } : c)));
    } else {
      const key = `c-${row.productUnitId}-${Date.now()}`;
      setCart((prev) => [...prev, { key, row, qty: 1, custom: data }]);
      setSelKey(key);
    }
    setShowCustomization(null);
    searchRef.current?.focus();
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
  function clearCart() {
    if (cart.length === 0) return;
    if (!confirm("تفريغ السلّة؟ سيُمسح كلّ ما في الطلب الحالي.")) return;
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
          if (k === "⌫") s = s.length > 1 ? s.slice(0, -1) : "1";
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
          if (k === "⌫") s = s.slice(0, -1);
          else if (k === "C") s = "";
          else if (k === "." && s.includes(".")) return c;
          else s = s + k;
          const disc = Math.min(100, Math.max(0, parseFloat(s) || 0));
          return { ...c, origPrice: base, disc };
        }),
      );
    } else {
      setPayInput((prev) => {
        if (k === "⌫") return prev.slice(0, -1);
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
    setPayInput(String(expectedNow));
  }

  // ───── الإرسال (هجين) ─────────────────────────────────────────────────────
  const saleM = trpc.sales.create.useMutation();
  const woM = trpc.workOrders.create.useMutation();

  async function handleSubmit(opts: { quickFullPay: boolean }) {
    if (cart.length === 0) return;
    if (!shift) {
      notify.err("لا توجد وردية مفتوحة — افتح الوردية من /pos أو /shifts");
      return;
    }

    const directLines = cart.filter((c) => !isCustomKind(c));
    const customItems = cart.filter(isCustomKind);

    // عربون كل صنف مخصّص: Quick = كامل سعر الصنف+التوصيل؛ غير ذلك = ما حفظه في النافذة.
    const customWithDeposits = customItems.map((c) => {
      const base = D(lineTotal(c));
      const delivery = c.custom!.hasDelivery ? D(c.custom!.deliveryCost || 0) : D(0);
      const full = base.plus(delivery);
      const deposit = opts.quickFullPay ? full.toFixed(2) : (c.custom?.deposit || "0");
      return { c, depositStr: deposit, fullStr: full.toFixed(2), deliveryStr: delivery.toFixed(2) };
    });

    // الدفع المتوقّع لهذا التنفيذ.
    const expectedDepositsD = customWithDeposits.reduce((s, x) => s.plus(D(x.depositStr)), D(0));
    const expectedTotalD = round2(sumDirectD.plus(expectedDepositsD));
    const inputPaidD = opts.quickFullPay ? expectedTotalD : paidD;

    if (!opts.quickFullPay) {
      if (inputPaidD.lt(sumDirectD)) {
        notify.err("المبلغ المُدخَل أقلّ من إجمالي البيع المباشر — لا بدّ من دفع البيع الجاهز كاملاً.");
        return;
      }
    }

    const customerId = customer.customerId ?? undefined;

    setSubmitting(true);
    try {
      let invoiceId: number | null = null;
      const createdWoIds: number[] = [];

      // ١) فاتورة البيع المباشر (إن وُجدت).
      if (directLines.length > 0) {
        const lines = directLines.map((c) => {
          const base: any = {
            variantId: c.row.variantId,
            productUnitId: c.row.productUnitId,
            quantity: String(c.qty),
          };
          if (c.disc != null && c.disc > 0) base.discountPercent = String(c.disc);
          return base;
        });
        const saleAmount = round2(sumDirectD).toFixed(2);
        const res = await saleM.mutateAsync({
          branchId,
          shiftId: shift.id,
          sourceType: "POS",
          customerId,
          lines,
          payment: { amount: saleAmount, method },
          clientRequestId: `${reqIdRef.current}-sale`,
        });
        invoiceId = res.invoiceId ?? null;
      }

      // ٢) أمر شغل لكل صنف مخصّص.
      for (const x of customWithDeposits) {
        const c = x.c;
        const custom = c.custom!;
        const finalText = composeCustomizationText(custom);
        const salePrice = D(lineTotal(c)).toFixed(2); // السعر الأساس بلا توصيل (deliveryCost عمود مستقل)
        const res = await woM.mutateAsync({
          branchId,
          customerId,
          baseVariantId: c.row.variantId,
          title: custom.title.trim() || c.row.productName,
          customizationText: finalText || null,
          quantity: c.qty,
          materials: [],
          laborCost: "0",
          salePrice,
          dueDate: custom.dueDate || null,
          priority: custom.priority,
          deposit: x.depositStr,
          paymentMethod: method === "TRANSFER" ? "CASH" : method,
          receptionChannel: channel,
          channelHandle: channelHandle || null,
          hasDelivery: custom.hasDelivery,
          deliveryAddress: custom.deliveryAddress || null,
          deliveryCost: x.deliveryStr,
          designImages: custom.designImages.map((img, idx) => ({
            url: img.dataUrl,
            caption: img.name ?? null,
            sortOrder: idx,
          })),
          clientRequestId: `${reqIdRef.current}-wo-${c.key}`,
        });
        const woId = (res as { workOrderId?: number }).workOrderId;
        if (woId) createdWoIds.push(woId);
      }

      // إفراغ + إشعار + تجديد idempotency key
      const summary = [
        invoiceId ? `فاتورة #${invoiceId}` : null,
        createdWoIds.length > 0 ? `${createdWoIds.length} أمر شغل` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      notify.ok(`تمّ ${summary}`);
      setCart([]);
      setSelKey(null);
      setPayInput("");
      reqIdRef.current = crypto.randomUUID();
      // تحديث القوائم.
      utils.workOrders.list.invalidate().catch(() => {});
      utils.shifts.current.invalidate().catch(() => {});
    } catch (e: unknown) {
      notify.err(e, "تعذّر إتمام الاستلام");
    } finally {
      setSubmitting(false);
    }
  }

  // اختصارات لوحة المفاتيح: F2 بحث، F4 دفع، Esc إغلاق درج/نافذة.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (showCustomization) return;
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        if (cart.length > 0 && !submitting) void handleSubmit({ quickFullPay: false });
      } else if (e.key === "Escape") {
        if (showInbox) setShowInbox(false);
        else if (showDrop) setShowDrop(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInbox, showDrop, showCustomization, cart.length, submitting, expectedNow]);

  // اقتراح الكاشير: لا يبني الواجهة قبل توفّر الفرع.
  if (me.isLoading) {
    return <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>;
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden bg-background" dir="rtl">
      {/* ─── شريط البحث + جسر الطباعة + الوارد ─── */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b bg-card px-4 py-2.5">
        <div className="relative max-w-[640px] flex-1">
          <span className="pointer-events-none absolute inset-y-0 end-3 grid place-items-center text-base text-muted-foreground">🔍</span>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setShowDrop(true)}
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
                      "grid size-10 flex-shrink-0 place-items-center rounded-lg text-lg",
                      r.isCustomizable ? "bg-violet-100" : "bg-emerald-100",
                    )}
                  >
                    {r.isCustomizable ? "🎨" : "📦"}
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

        <div className="ms-auto flex items-center gap-2">
          {shift ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-700">
              <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
              وردية #{shift.id}
            </div>
          ) : (
            <Button size="sm" variant="outline" asChild>
              <Link href="/pos">افتح وردية أولاً</Link>
            </Button>
          )}
          <button
            type="button"
            onClick={() => setShowInbox(true)}
            className="flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-bold hover:bg-muted/60"
          >
            💬 الوارد
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold text-muted-foreground">قريباً</span>
          </button>
        </div>
      </div>

      {/* ─── الجسم: سلّة (يسار) + لوحة الدفع (يمين) ─── */}
      <div className="flex min-h-0 flex-1 flex-row-reverse gap-3 p-3">
        {/* ─ السلّة ─ */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-extrabold">🛒 الطلب الحالي</span>
              {cart.length > 0 && (
                <Badge variant="default" className="text-[11px]">
                  {cart.length} منتج · {cartCount} قطعة
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <SmartCustomerInput value={customer} onChange={setCustomer} className="w-56" placeholder="عميل نقدي" />
              {cart.length > 0 && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={clearCart}>
                  تفريغ
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {cart.length === 0 ? (
              <div className="grid h-full place-items-center px-4 py-10 text-center text-muted-foreground">
                <div>
                  <div className="text-4xl opacity-40">🛒</div>
                  <div className="mt-2 text-sm font-bold">السلة فارغة</div>
                  <div className="mt-1 text-xs">امسح الباركود أو ابحث لإضافة المنتجات</div>
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
                    <th className="w-32 px-1 py-2 text-center font-bold">الكمية</th>
                    <th className="w-24 px-1 py-2 text-center font-bold">الإجمالي</th>
                    <th className="w-8 px-1 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {cart.map((l, idx) => {
                    const isCustom = isCustomKind(l);
                    const total = lineTotal(l);
                    const selected = selKey === l.key;
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
                            <span className="text-sm font-bold">
                              {isCustom ? l.custom!.title : l.row.productName}
                            </span>
                            <span className="text-[10px] text-muted-foreground" dir="ltr">{l.row.sku}</span>
                          </div>
                          {isCustom && (
                            <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2.5">
                              <div className="flex flex-wrap gap-1.5">
                                {l.custom!.size && (
                                  <span className="rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">📐 {l.custom!.size}</span>
                                )}
                                {l.custom!.material && (
                                  <span className="rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">🧱 {l.custom!.material}</span>
                                )}
                                {l.custom!.dueDate && (
                                  <span className="rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold" dir="ltr">⏱ {l.custom!.dueDate}</span>
                                )}
                                {l.custom!.hasDelivery && (
                                  <span className="rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">🚚 توصيل</span>
                                )}
                                <span
                                  className={cn(
                                    "rounded-md border px-2 py-0.5 text-[11px] font-bold",
                                    l.custom!.priority === "URGENT" && "bg-destructive/10 text-destructive border-destructive/30",
                                    l.custom!.priority === "NORMAL" && "bg-sky-500/10 text-sky-700 border-sky-500/30",
                                    l.custom!.priority === "LOW" && "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
                                  )}
                                >
                                  {l.custom!.priority === "URGENT" ? "عاجل" : l.custom!.priority === "NORMAL" ? "عادي" : "منخفض"}
                                </span>
                              </div>
                              {l.custom!.customizationText && (
                                <div className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                                  📝 {l.custom!.customizationText}
                                </div>
                              )}
                              <div className="mt-2 flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px]"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShowCustomization({ row: l.row, editingKey: l.key });
                                  }}
                                >
                                  ✎ تعديل التخصيص
                                </Button>
                                <span className="rounded-md border bg-card px-2 py-1 text-[11px] font-bold text-muted-foreground">
                                  🖼 صور: {l.custom!.designImages.length}
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
                        <td className="px-1 py-1.5">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                changeQty(l.key, -1);
                              }}
                              className="grid size-8 place-items-center rounded-md border bg-card text-base hover:bg-muted disabled:opacity-40"
                              disabled={isCustom && l.qty <= 1}
                            >
                              −
                            </button>
                            <span className="min-w-[28px] text-center text-sm font-extrabold tabular-nums" dir="ltr">{l.qty}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                changeQty(l.key, +1);
                              }}
                              className="grid size-8 place-items-center rounded-md border bg-card text-base hover:bg-muted"
                            >
                              +
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
                            className="text-base text-muted-foreground hover:text-destructive"
                            aria-label="حذف الصنف"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
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
        <div className="flex w-[408px] flex-shrink-0 flex-col overflow-hidden rounded-xl border bg-card">
          {/* رأس الإجمالي + التقسيم الهجين */}
          <div className="flex-shrink-0 border-b bg-muted/40 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">إجمالي الفاتورة</span>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-black tabular-nums tracking-tight" dir="ltr">{fmt(grandTotal)}</span>
                <span className="text-xs text-muted-foreground">د.ع</span>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-2">
                <div className="text-[10px] font-bold text-emerald-700">🛒 بيع مباشر</div>
                <div className="mt-0.5 text-sm font-extrabold tabular-nums" dir="ltr">{fmt(sumDirect)}</div>
              </div>
              <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-2">
                <div className="text-[10px] font-bold text-violet-700">🖨 أوامر مطبعة</div>
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
                onClick={() => setQuickAmt(v * 1000)}
                className="h-7 rounded-md border-[1.5px] bg-card px-2 text-[11px] font-bold tabular-nums hover:bg-muted"
                dir="ltr"
              >
                {v},000
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

              <button onClick={() => numPress("⌫")} className="h-12 rounded-lg border-[1.5px] bg-red-50 text-lg font-extrabold text-red-700 hover:bg-red-100">⌫</button>
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
                  { v: "CASH", label: "نقداً", icon: "💵" },
                  { v: "CARD", label: "بطاقة", icon: "💳" },
                  { v: "TRANSFER", label: "تحويل", icon: "🔄" },
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
                  <span className="text-lg">{p.icon}</span>
                  {p.label}
                </button>
              ))}
            </div>
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
              className="h-11 w-full rounded-lg bg-amber-500 text-sm font-black text-white shadow-md transition hover:bg-amber-600 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              ⚡ دفع سريع وطباعة
            </button>
            <button
              type="button"
              disabled={cart.length === 0 || submitting || !shift}
              onClick={() => void handleSubmit({ quickFullPay: false })}
              className="h-12 w-full rounded-lg bg-primary text-sm font-black text-primary-foreground shadow-md transition hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
            >
              {submitting ? "جارٍ الإرسال…" : sumCustom > 0 && sumDirect > 0
                ? "🖨 إرسال أوامر الشغل ودفع البيع"
                : sumCustom > 0
                ? "🖨 إرسال للمطبعة"
                : "✓ إتمام الدفع وطباعة"}
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
          initial={
            showCustomization.editingKey
              ? cart.find((c) => c.key === showCustomization.editingKey)?.custom
              : emptyCustomization(showCustomization.row.productName, showCustomization.row.price ?? "0")
          }
          onCancel={() => setShowCustomization(null)}
          onSave={saveCustomization}
        />
      )}

      {/* ─── درج الوارد (Stub) ─── */}
      {showInbox && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setShowInbox(false)} />
          <aside className="fixed inset-y-0 end-0 z-50 flex w-[360px] max-w-[92vw] flex-col bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b p-4">
              <div className="flex items-center gap-2 font-extrabold">💬 صندوق الوارد الموحّد</div>
              <button onClick={() => setShowInbox(false)} className="grid size-8 place-items-center rounded-md bg-muted text-lg hover:bg-muted/80" aria-label="إغلاق">×</button>
            </div>
            <div className="border-b bg-primary/5 p-3 text-xs leading-relaxed">
              ℹ️ تكامل القنوات (واتساب Business / انستغرام / المتجر) <b>قيد التنفيذ</b> — هذه معاينة فقط.
              عند الاكتمال، يُمكنك الردّ على العميل وتحويل محادثته إلى طلب خدمة من هنا مباشرة.
            </div>
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              <div>
                <div className="text-4xl opacity-40">💬</div>
                <div className="mt-3 font-bold">لا محادثات بعد</div>
                <div className="mt-1 text-xs">تظهر هنا تلقائياً عند ربط القنوات.</div>
              </div>
            </div>
            <div className="border-t bg-muted/30 p-3">
              <div className="text-[11px] text-muted-foreground">قناة الطلب الحالي</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE"] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setChannel(c)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] font-bold transition-colors",
                      channel === c ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted",
                    )}
                  >
                    {c === "WALK_IN" ? "🏪 مباشر" : c === "WHATSAPP" ? "💬 واتساب" : c === "INSTAGRAM" ? "📷 انستغرام" : c === "TIKTOK" ? "🎵 تيك توك" : "📞 اتصال"}
                  </button>
                ))}
              </div>
              {channel !== "WALK_IN" && (
                <input
                  value={channelHandle}
                  onChange={(e) => setChannelHandle(e.target.value)}
                  placeholder="معرّف القناة (رقم/يوزر)"
                  className="mt-2 h-9 w-full rounded-md border bg-card px-2 text-xs"
                  dir="ltr"
                />
              )}
            </div>
          </aside>
        </>
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
