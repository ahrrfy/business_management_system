import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { PageHeader } from "@/components/PageHeader";
import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Landmark } from "lucide-react";

/**
 * مصروف جديد — v3 add-screens.
 *
 * تصميم:
 *  - الحقول الأساسية (الفرع/الفئة/المبلغ/الدفع/التاريخ) — كما كانت.
 *  - حقول جديدة: جهة الصرف (payee)، مركز التكلفة (costCenter)، مصروف متكرّر (toggle + دورية).
 *  - المتكرّر للوصف فقط — لا يُولّد قيوداً مستقبليّة هنا (ميزة لاحقة).
 */

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const CATEGORIES: { value: string; label: string }[] = [
  { value: "RENT", label: "إيجار" },
  { value: "UTILITIES", label: "خدمات/فواتير (كهرباء/ماء/إنترنت)" },
  { value: "SUPPLIES", label: "لوازم تشغيل" },
  { value: "SALARY", label: "مرتبات/أجور" },
  { value: "TRANSPORT", label: "مواصلات/شحن" },
  { value: "MAINTENANCE", label: "صيانة" },
  { value: "MARKETING", label: "تسويق/إعلان" },
  { value: "OTHER", label: "أخرى" },
];

const METHODS: { value: string; label: string }[] = [
  { value: "CASH", label: "نقدي" },
  { value: "CARD", label: "بطاقة" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "WALLET", label: "محفظة" },
];

const COST_CENTERS = ["المبيعات", "الإدارة والتشغيل", "التسويق", "الصيانة", "عام"];
const FREQS: { value: string; label: string }[] = [
  { value: "DAILY", label: "يومي" },
  { value: "WEEKLY", label: "أسبوعي" },
  { value: "MONTHLY", label: "شهري" },
  { value: "QUARTERLY", label: "ربع سنوي" },
  { value: "YEARLY", label: "سنوي" },
];

let _itemKey = 1;
type StockLine = {
  key: number; variantId: number; productName: string; sku: string;
  costPriceBase: string; stockBase: number; units: PurchaseRow[];
  productUnitId: number; conversionFactor: string; qty: string;
};
function mkStockLine(v: PurchaseRow, units: PurchaseRow[]): StockLine {
  return {
    key: _itemKey++, variantId: v.variantId, productName: v.productName, sku: v.sku,
    costPriceBase: String(v.costPriceBase ?? "0"), stockBase: Number(v.stockBase ?? 0),
    units: units.length ? units : [v], productUnitId: v.productUnitId,
    conversionFactor: String(v.conversionFactor ?? "1"), qty: "1",
  };
}
function baseQtyOf(l: StockLine) { return D(l.qty).times(D(l.conversionFactor)); }
function stockLineValid(l: StockLine): boolean { const b = baseQtyOf(l); return b.gt(0) && b.isInteger(); }

const SOURCE_TABS: { value: "CASH" | "INTERNAL_USE" | "WASTAGE"; label: string; hint: string }[] = [
  { value: "CASH", label: "نقدي", hint: "صرف نقد من الصندوق" },
  { value: "INTERNAL_USE", label: "نثرية (من المخزون)", hint: "استهلاك منتج داخلياً ⇒ مصروف بالكلفة" },
  { value: "WASTAGE", label: "تلف (من المخزون)", hint: "منتج تالف ⇒ خسارة بالكلفة" },
];

export default function ExpenseNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();

  const [branchId, setBranchId] = useState<number | "">("");
  const [category, setCategory] = useState("RENT");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [expenseDate, setExpenseDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [payee, setPayee] = useState("");
  const [costCenter, setCostCenter] = useState("الإدارة والتشغيل");
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState("MONTHLY");
  const [error, setError] = useState("");
  // idempotency: مفتاح ثابت للنموذج — يمنع ازدواج الصرف عند النقر المزدوج/إعادة الشبكة. يتجدّد بعد نجاح كل تسجيل.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());

  // production-slice: مصدر الصرف — نقدي أو صرف من المخزون (نثرية/تلف).
  const [source, setSource] = useState<"CASH" | "INTERNAL_USE" | "WASTAGE">("CASH");
  const isStock = source !== "CASH";
  const [items, setItems] = useState<StockLine[]>([]);
  const itemsTotal = useMemo(
    () => items.reduce((acc, l) => acc.plus(round2(D(l.costPriceBase).times(baseQtyOf(l)))), D(0)),
    [items]
  );

  const effectiveBranch = branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1);
  const openShift = trpc.shifts.current.useQuery(
    { branchId: Number(effectiveBranch) },
    { enabled: !!effectiveBranch }
  );

  const create = trpc.expenses.create.useMutation({
    onSuccess: async () => {
      setClientRequestId(crypto.randomUUID());
      await utils.expenses.list.invalidate();
      notify.ok("تم تسجيل المصروف");
      navigate("/expenses");
    },
    onError: (e) => { setError(e.message); notify.err(e); },
  });

  async function submit() {
    setError("");
    if (!effectiveBranch) return setError("اختر الفرع.");

    // production-slice: صرف من المخزون (نثرية/تلف) — يُخصَم بالكلفة بلا صندوق.
    if (isStock) {
      if (items.length === 0) return setError("أضِف منتجاً واحداً على الأقل.");
      for (const l of items) if (!stockLineValid(l)) return setError(`كمية «${l.productName}» يجب أن تُنتج عدداً صحيحاً موجباً.`);
      const ok = await confirm({
        variant: "danger",
        title: source === "WASTAGE" ? "تسجيل تلف من المخزون" : "تسجيل نثرية من المخزون",
        description: `سيُخصَم ${items.length} منتج من المخزون ويُسجَّل ${source === "WASTAGE" ? "خسارةً" : "مصروفاً"} بقيمة ${fmt(itemsTotal.toString())} د.ع (لا يلمس الصندوق النقدي). متابعة؟`,
        confirmText: source === "WASTAGE" ? "تسجيل التلف" : "تسجيل النثرية",
      });
      if (!ok) return;
      create.mutate({
        branchId: Number(effectiveBranch),
        expenseDate: expenseDate || undefined,
        category: category as any,
        amount: "0",
        paymentMethod: "CASH",
        source: "STOCK",
        stockReason: source,
        items: items.map((l) => ({ variantId: l.variantId, productUnitId: l.productUnitId, quantity: D(l.qty).toFixed(4) })),
        description: description.trim() || null,
        clientRequestId,
      });
      return;
    }

    // نقدي (CASH).
    if (!amount.trim() || D(amount).lte(0)) return setError("المبلغ مطلوب وموجب.");
    if (category === "OTHER" && !description.trim()) return setError("وصف المصروف مطلوب لفئة «أخرى».");

    // cash-treasury-mode: مدير/مسؤول يسجّل مصروفاً نقدياً بلا وردية مفتوحة ⇒ يُكتب في الخزينة الإدارية.
    // تأكيد صريح قبل المتابعة (الكاشير مَحجوب أصلاً بزرّ مُعطَّل، فلا يصل هنا).
    const role = me.data?.role;
    const isElevated = role === "admin" || role === "manager";
    if (paymentMethod === "CASH" && !openShift.data && isElevated) {
      const ok = await confirm({
        variant: "warning",
        title: "مصروف نقدي بلا وردية مفتوحة",
        description: `تسجيل مصروف نقدي بقيمة ${fmt(D(amount).toFixed(2))} د.ع بلا وردية مفتوحة (خزينة إدارية). متابعة؟`,
        confirmText: "تسجيل المصروف",
      });
      if (!ok) return;
    }

    create.mutate({
      branchId: Number(effectiveBranch),
      shiftId: openShift.data?.id ? Number(openShift.data.id) : null,
      expenseDate: expenseDate || undefined,
      category: category as any,
      amount: D(amount).toFixed(2),
      paymentMethod: paymentMethod as any,
      description: description.trim() || null,
      referenceNumber: referenceNumber.trim() || null,
      payee: payee.trim() || null,
      costCenter: costCenter || null,
      isRecurring,
      recurringFrequency: isRecurring ? (recurringFrequency as any) : null,
      clientRequestId,
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مصروف جديد"
        actions={<Link href="/expenses" className="text-sm text-muted-foreground">← رجوع للمصروفات</Link>}
      />

      {/* مصدر الصرف: نقدي أو صرف من المخزون (نثرية/تلف) */}
      <Card>
        <CardContent className="pt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {SOURCE_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => { setSource(t.value); setError(""); if (t.value === "INTERNAL_USE") setCategory("SUPPLIES"); if (t.value === "WASTAGE") setCategory("OTHER"); }}
                className={cn("rounded-full px-4 py-1.5 text-sm border transition", source === t.value ? "bg-primary text-primary-foreground border-primary" : "bg-transparent hover:bg-accent")}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{SOURCE_TABS.find((t) => t.value === source)?.hint}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات المصروف</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
          <div className="space-y-1 md:col-span-2 lg:col-span-1">
            <Label>الفرع *</Label>
            <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {(() => {
              // cash-treasury-mode (تدقيق ١٧/٦):
              //  - admin/manager بلا وردية + نقدي ⇒ شارة زرقاء «خزينة إدارية» (مشروع، يُحفَظ).
              //  - cashier/warehouse بلا وردية + نقدي ⇒ تحذير أحمر + زر مُعطَّل.
              const role = me.data?.role;
              const isElevated = role === "admin" || role === "manager";
              if (openShift.data) {
                return <p className="text-xs text-money-positive">سيُربط بوردية #{Number(openShift.data.id)} المفتوحة (drawer).</p>;
              }
              if (!isStock && paymentMethod === "CASH") {
                if (isElevated) {
                  return (
                    <p className="text-xs text-[var(--status-pending)] inline-flex items-center gap-1">
                      <Landmark aria-hidden className="size-4" />
                      <span>يُسجَّل في <strong>الخزينة الإدارية</strong> — يَظهر في تقرير «النقد خارج الوردية» مفصولاً عن تَسوية درج الكاشير.</span>
                    </p>
                  );
                }
                return (
                  <p className="text-xs text-destructive">
                    لا وردية مفتوحة — الكاشير يجب أن يَفتح وردية قبل المصروف النقدي. <Link href="/shifts" className="underline">افتح وردية</Link> أو غيِّر طريقة الدفع لغير نقدية.
                  </p>
                );
              }
              return <p className="text-xs text-muted-foreground">لا توجد وردية مفتوحة لهذا الفرع — سيُسجَّل بلا ربط (طريقة دفع غير نقدية).</p>;
            })()}
          </div>
          <div className="space-y-1">
            <Label>التاريخ *</Label>
            <Input type="date" dir="ltr" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>الفئة *</Label>
            <select className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          {!isStock && (
            <>
              <div className="space-y-1">
                <Label>طريقة الدفع *</Label>
                <select className={selectCls} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="expense-amount">المبلغ *</Label>
                <MoneyInput id="expense-amount" value={amount} onChange={setAmount} placeholder="0" />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label>رقم مرجعي (اختياري)</Label>
            <Input dir="ltr" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder="فاتورة/إيصال" />
          </div>
          <div className="space-y-1 md:col-span-2 lg:col-span-3">
            <Label>الوصف{category === "OTHER" ? " *" : " (اختياري)"}</Label>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="تفصيل المصروف…" />
          </div>
        </CardContent>
      </Card>

      {/* منتجات الصرف من المخزون (نثرية/تلف) */}
      {isStock && (
        <Card>
          <CardHeader><CardTitle className="text-base">المنتجات المُستهلَكة من المخزون</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <ProductSearchPicker branchId={Number(effectiveBranch)} placeholder="ابحث عن منتج…" onPick={(v, u) => setItems((p) => [...p, mkStockLine(v, u)])} />
            {items.map((l) => {
              const base = baseQtyOf(l);
              const valid = stockLineValid(l);
              const over = base.gt(l.stockBase);
              return (
                <div key={l.key} className="grid grid-cols-12 gap-2 items-center border rounded-md p-2">
                  <div className="col-span-4"><div className="font-medium text-sm">{l.productName}</div><div className="text-xs text-muted-foreground font-mono" dir="ltr">{l.sku}</div></div>
                  <div className="col-span-3">
                    <select className={selectCls} value={l.productUnitId} onChange={(e) => { const u = l.units.find((x) => x.productUnitId === Number(e.target.value)); setItems((p) => p.map((x) => x.key === l.key ? { ...x, productUnitId: Number(e.target.value), conversionFactor: String(u?.conversionFactor ?? "1") } : x)); }}>
                      {l.units.map((u) => <option key={u.productUnitId} value={u.productUnitId}>{u.unitName}{u.isBaseUnit ? " (أساس)" : ` × ${u.conversionFactor}`}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2"><Input dir="ltr" value={l.qty} onChange={(e) => setItems((p) => p.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))} /></div>
                  <div className="col-span-2 text-left text-sm tabular-nums" dir="ltr">{fmt(round2(D(l.costPriceBase).times(base)).toString())}</div>
                  <div className="col-span-1 text-left"><button type="button" className="text-destructive text-sm" onClick={() => setItems((p) => p.filter((x) => x.key !== l.key))}>حذف</button></div>
                  {!valid && <div className="col-span-12 text-xs text-destructive">الكمية يجب أن تُنتج عدداً صحيحاً موجباً.</div>}
                  {over && <div className="col-span-12 text-xs text-stock-low">المتاح {Number(l.stockBase).toLocaleString("en-US")} فقط — سيُرفض إن لم يكفِ.</div>}
                </div>
              );
            })}
            {items.length === 0 && <p className="text-xs text-muted-foreground">لم تُضف منتجات بعد.</p>}
            <div className="flex justify-end text-sm">
              <span className="text-muted-foreground">سيُسجَّل {source === "WASTAGE" ? "خسارةً" : "مصروفاً"}:&nbsp;</span>
              <span className="font-bold text-money-negative tabular-nums" dir="ltr">{fmt(itemsTotal.toString())}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {!isStock && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <Card>
        <CardHeader><CardTitle className="text-base">جهة الصرف ومركز التكلفة</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="payee">جهة الصرف</Label>
            <Input id="payee" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="مثال: شركة الكهرباء، صاحب العقار" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cc">مركز التكلفة</Label>
            <select id="cc" className={selectCls} value={costCenter} onChange={(e) => setCostCenter(e.target.value)}>
              {COST_CENTERS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">مصروف متكرّر</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={isRecurring} onCheckedChange={setIsRecurring} id="recurring" />
            <Label htmlFor="recurring" className="cursor-pointer">
              {isRecurring ? "نعم — مصروف متكرّر" : "لا — مرة واحدة"}
            </Label>
          </div>
          <div className={cn("grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity", isRecurring ? "opacity-100" : "opacity-50 pointer-events-none")}>
            <div className="space-y-1">
              <Label htmlFor="freq">الدورية</Label>
              <select id="freq" className={selectCls} value={recurringFrequency} onChange={(e) => setRecurringFrequency(e.target.value)}>
                {FREQS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <p className="text-[11px] text-muted-foreground">
                للتوثيق الآن — الإصدارات المستقبلية ستولّد قيوداً تلقائياً.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {(() => {
        // cash-treasury-mode: التعطيل صارم لـcashier/warehouse فقط؛ admin/manager يَكتبون
        // معاملاتهم في الخزينة الإدارية (TREASURY) بَدلاً من تَعطيل الزرّ عليهم.
        const role = me.data?.role;
        const isElevated = role === "admin" || role === "manager";
        const cashNeedsShift = !isStock && paymentMethod === "CASH" && !openShift.data && !openShift.isLoading;
        const hardBlock = cashNeedsShift && !isElevated;
        return (
          <div className="flex gap-2">
            <Button onClick={submit} disabled={create.isPending || hardBlock} title={hardBlock ? "الكاشير يجب أن يَفتح وردية قبل مصروف نقدي" : undefined}>
              {create.isPending ? "جارٍ الحفظ…" : "حفظ المصروف"}
            </Button>
            <Link href="/expenses"><Button variant="outline">إلغاء</Button></Link>
          </div>
        );
      })()}
    </div>
  );
}
