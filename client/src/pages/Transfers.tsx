import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmtInt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { ArrowRightLeft, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const REASONS = [
  { value: "REBALANCE", label: "إعادة توزيع المخزون" },
  { value: "STOCKOUT", label: "نفاد في الفرع المستلم" },
  { value: "BRANCH_REQ", label: "طلب من الفرع" },
  { value: "SEASONAL", label: "تجهيز موسمي" },
  { value: "RETURN_HQ", label: "إرجاع للمخزن الرئيسي" },
  { value: "OTHER", label: "أخرى" },
] as const;

type Variant = {
  variantId: number;
  productName: string;
  variantName: string | null;
  color: string | null;
  sku: string;
  stockBase: number;
  unitName: string;
};
type Line = Variant & { qty: string };

function genTrf(): string {
  const d = new Date();
  const y = String(d.getFullYear()).slice(-2);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `TRF-${y}${m}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

export default function Transfers() {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();

  const [fromBranchId, setFromBranchId] = useState<number | "">("");
  const [toBranchId, setToBranchId] = useState<number | "">("");
  const [reason, setReason] = useState<string>("REBALANCE");
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [trf, setTrf] = useState(() => genTrf());
  const searchRef = useRef<HTMLInputElement>(null);

  // فروع افتراضية بعد التحميل: المصدر = فرع المستخدم أو الأول، الوجهة = أول فرع مختلف.
  const effectiveFrom =
    fromBranchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 0);
  const effectiveTo =
    toBranchId ||
    (branches.data?.find((b) => Number(b.id) !== Number(effectiveFrom))
      ? Number(branches.data.find((b) => Number(b.id) !== Number(effectiveFrom))!.id)
      : 0);

  const catalog = trpc.catalog.forPurchase.useQuery(
    { branchId: Number(effectiveFrom), query: query.trim() || undefined, limit: 200 },
    { enabled: !!effectiveFrom && query.trim().length > 0 }
  );

  const variants = useMemo<Variant[]>(() => {
    const byVariant = new Map<number, Variant>();
    for (const r of catalog.data ?? []) {
      if (!byVariant.has(r.variantId) || r.isBaseUnit) {
        byVariant.set(r.variantId, {
          variantId: r.variantId,
          productName: r.productName,
          variantName: r.variantName,
          color: r.color,
          sku: r.sku,
          stockBase: r.stockBase,
          unitName: r.unitName,
        });
      }
    }
    return Array.from(byVariant.values());
  }, [catalog.data]);

  // F2 يركّز البحث (اختصار الكاشير).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // تبديل فرع المصدر يُفرغ السلة (الأرصدة تختلف بين الفروع).
  function changeFrom(v: number | "") { setFromBranchId(v); setCart([]); }
  function swap() {
    const f = Number(effectiveFrom), t = Number(effectiveTo);
    setFromBranchId(t); setToBranchId(f); setCart([]);
  }

  function addToCart(v: Variant) {
    setCart((prev) => {
      if (prev.some((l) => l.variantId === v.variantId)) return prev; // موجود — لا تكرّر
      return [...prev, { ...v, qty: "1" }];
    });
    setQuery("");
    searchRef.current?.focus();
  }
  function setQty(variantId: number, qty: string) {
    setCart((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, qty } : l)));
  }
  function removeLine(variantId: number) {
    setCart((prev) => prev.filter((l) => l.variantId !== variantId));
  }

  const transfer = trpc.inventory.transferBatch.useMutation({
    onSuccess: async (res) => {
      setDone(`تمّ تنفيذ سند التحويل (${res.lines} صنف) من ${fromName} إلى ${toName}.`);
      setError("");
      setCart([]); setNotes(""); setTrf(genTrf());
      await Promise.all([
        utils.catalog.forPurchase.invalidate(),
        utils.inventory.movements.invalidate(),
        utils.inventory.movementsRich?.invalidate?.(),
      ]);
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  const fromName = branches.data?.find((b) => Number(b.id) === Number(effectiveFrom))?.name ?? "—";
  const toName = branches.data?.find((b) => Number(b.id) === Number(effectiveTo))?.name ?? "—";

  const lineErrors = cart.map((l) => {
    const q = Math.trunc(Number(l.qty || "0"));
    if (!Number.isInteger(q) || q <= 0) return "كمية غير صالحة";
    if (q > l.stockBase) return `يتجاوز المتاح (${l.stockBase})`;
    return "";
  });
  const totalUnits = cart.reduce((a, l) => a + (Math.trunc(Number(l.qty || "0")) || 0), 0);
  const valid = cart.length > 0 && lineErrors.every((e) => !e) && effectiveFrom && effectiveTo && effectiveFrom !== effectiveTo;

  async function submit() {
    setError(""); setDone("");
    if (!effectiveFrom || !effectiveTo) return setError("اختر فرعَي المصدر والوجهة.");
    if (effectiveFrom === effectiveTo) return setError("لا يمكن التحويل لنفس الفرع.");
    if (cart.length === 0) return setError("أضِف صنفاً واحداً على الأقل للسند.");
    const bad = lineErrors.findIndex((e) => e);
    if (bad >= 0) return setError(`الصنف «${cart[bad].productName}»: ${lineErrors[bad]}.`);
    if (
      !(await confirm({
        variant: "danger",
        title: `سند تحويل ${trf}: من ${fromName} إلى ${toName}`,
        description: `تنفيذ سند التحويل (${fmtInt(cart.length)} صنف، ${fmtInt(totalUnits)} وحدة) يؤثّر على أرصدة فرعين مباشرة. متابعة؟`,
        confirmText: "تنفيذ",
      }))
    )
      return;
    transfer.mutate({
      fromBranchId: Number(effectiveFrom),
      toBranchId: Number(effectiveTo),
      reason: reason as any,
      notes: notes.trim() || undefined,
      items: cart.map((l) => ({ variantId: l.variantId, baseQuantity: Math.trunc(Number(l.qty)) })),
    });
  }

  const branchOption = (b: any) => (
    <option key={b.id} value={b.id}>{b.name}{b.code ? ` (${b.code})` : ""}</option>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="تحويل بين الفروع"
        description="سند تحويل مخزني بأسطر متعددة (TRANSFER_OUT/IN) — ذرّي، بلا قيد محاسبي."
        actions={<Link href="/inventory" className="text-sm text-muted-foreground">حركات المخزون ←</Link>}
      />

      {/* الفروع: من → إلى + عكس */}
      <Card>
        <CardHeader><CardTitle className="text-base">الفروع</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <div className="space-y-1">
              <Label>من فرع *</Label>
              <select className={selectCls} value={effectiveFrom || ""} onChange={(e) => changeFrom(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— اختر —</option>
                {(branches.data ?? []).map(branchOption)}
              </select>
            </div>
            <div className="flex justify-center pb-1">
              <Button type="button" variant="outline" size="icon" title="عكس الاتجاه" onClick={swap} className="rounded-full">
                <ArrowRightLeft className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-1">
              <Label>إلى فرع *</Label>
              <select className={selectCls} value={effectiveTo || ""} onChange={(e) => setToBranchId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— اختر —</option>
                {(branches.data ?? []).filter((b) => Number(b.id) !== Number(effectiveFrom)).map(branchOption)}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* رأس السند: رقم/تاريخ/سبب/مسؤول */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>سند تحويل مخزني</span>
            <span className="text-xs font-mono text-muted-foreground" dir="ltr">{trf}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label>سبب التحويل</Label>
            <select className={selectCls} value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>المسؤول عن التحويل</Label>
            <Input value={me.data?.name ?? "—"} readOnly dir="rtl" className="bg-muted/40" />
          </div>
          <div className="space-y-1">
            <Label>ملاحظات</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اختياري" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        {/* البحث + سلة الأصناف */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">أصناف السند</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="absolute right-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث بالاسم أو SKU أو امسح الباركود لإضافة صنف للتحويل…  (F2)"
                className="pr-8"
                dir="rtl"
              />
              {query.trim() && (
                <div className="absolute z-10 mt-1 w-full border rounded-md bg-popover shadow-md max-h-72 overflow-auto divide-y">
                  {variants.map((v) => {
                    const inCart = cart.some((l) => l.variantId === v.variantId);
                    return (
                      <button
                        key={v.variantId}
                        type="button"
                        disabled={inCart || v.stockBase <= 0}
                        className="w-full text-right p-2 text-sm hover:bg-accent flex items-center justify-between gap-2 disabled:opacity-40"
                        onClick={() => addToCart(v)}
                      >
                        <span>
                          {v.productName}{v.variantName ? ` — ${v.variantName}` : v.color ? ` — ${v.color}` : ""}
                          <span className="text-xs text-muted-foreground"> · {v.unitName}</span>
                          {inCart ? <span className="text-[10px] text-primary mr-1">(مُضاف)</span> : null}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono shrink-0" dir="ltr">{v.sku} · متاح {fmtInt(v.stockBase)}</span>
                      </button>
                    );
                  })}
                  {catalog.isFetched && variants.length === 0 && (
                    <div className="p-3 text-center text-xs text-muted-foreground">لا نتائج في {fromName}.</div>
                  )}
                </div>
              )}
            </div>

            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="p-2 px-3">الصنف</th>
                    <th className="p-2 text-center w-28">المتاح (مصدر)</th>
                    <th className="p-2 w-32">الكمية (أساس)</th>
                    <th className="p-2 text-center w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((l, i) => (
                    <tr key={l.variantId} className="border-t">
                      <td className="p-2 px-3">
                        <div className="font-medium">{l.productName}{l.variantName ? ` — ${l.variantName}` : ""}</div>
                        <div className="text-[11px] text-muted-foreground font-mono" dir="ltr">{l.sku} · {l.unitName}</div>
                      </td>
                      <td className="p-2 text-center tabular-nums" dir="ltr">{fmtInt(l.stockBase)}</td>
                      <td className="p-2">
                        <Input
                          dir="ltr" value={l.qty} inputMode="numeric"
                          onChange={(e) => setQty(l.variantId, e.target.value.replace(/[^\d]/g, ""))}
                          className={`h-8 text-center ${lineErrors[i] ? "border-destructive" : ""}`}
                        />
                        {lineErrors[i] && <p className="text-[10px] text-destructive mt-0.5 text-center">{lineErrors[i]}</p>}
                      </td>
                      <td className="p-2 text-center">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(l.variantId)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {cart.length === 0 && (
                    <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">ابحث عن صنف أعلاه لإضافته إلى سند التحويل.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ملخّص التحويل (لاصق) */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader className="pb-2"><CardTitle className="text-base">ملخّص التحويل</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">من</span><span className="font-medium">{fromName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">إلى</span><span className="font-medium">{toName}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">عدد الأصناف</span><span className="font-semibold tabular-nums" dir="ltr">{fmtInt(cart.length)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">إجمالي الوحدات</span><span className="font-semibold tabular-nums" dir="ltr">{fmtInt(totalUnits)}</span></div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {done && <p className="text-sm text-money-positive">{done}</p>}
            <Button className="w-full" onClick={submit} disabled={transfer.isPending || !valid}>
              {transfer.isPending ? "جارٍ التنفيذ…" : "تنفيذ التحويل"}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => { setCart([]); setNotes(""); setError(""); setDone(""); }}>تفريغ السند</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
