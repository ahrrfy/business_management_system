import CustomerPicker from "@/components/CustomerPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { D, fmt, lineTotal, round2 } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

type Tier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
type PosRow = RouterOutputs["catalog"]["posList"][number];
type Line = {
  key: number;
  variantId: number;
  productUnitId: number;
  label: string;
  unitName: string;
  quantity: string;
  unitPrice: string;
};

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function QuotationNew() {
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const defaultBranch = me.data?.branchId ?? 1;

  const customers = trpc.customers.list.useQuery();
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [tierOverride, setTierOverride] = useState<Tier | null>(null);
  const [taxRate, setTaxRate] = useState("0");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [seq, setSeq] = useState(1);
  const [error, setError] = useState("");

  const selectedCustomer = useMemo(
    () => (customers.data ?? []).find((c) => c.id === customerId) ?? null,
    [customers.data, customerId]
  );
  const effectiveTier: Tier = tierOverride ?? (selectedCustomer?.defaultPriceTier as Tier | undefined) ?? "RETAIL";

  const results = trpc.catalog.posList.useQuery(
    { branchId: defaultBranch, tier: effectiveTier, query: search, limit: 10 },
    { enabled: search.trim().length > 0 }
  );

  const create = trpc.quotations.create.useMutation({
    onSuccess: async (r) => {
      await utils.quotations.list.invalidate();
      navigate(`/quotations/${r.quotationId}`);
    },
    onError: (e) => setError(e.message),
  });

  function addRow(row: PosRow) {
    setError("");
    setLines((prev) => {
      if (prev.some((l) => l.productUnitId === row.productUnitId)) return prev;
      return [
        ...prev,
        {
          key: seq,
          variantId: row.variantId,
          productUnitId: row.productUnitId,
          label: `${row.productName}${row.variantName ? " — " + row.variantName : ""} (${row.sku})`,
          unitName: row.unitName,
          quantity: "1",
          unitPrice: row.price ?? "0",
        },
      ];
    });
    setSeq((s) => s + 1);
    setSearch("");
  }
  const patch = (k: number, p: Partial<Line>) => setLines((prev) => prev.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const remove = (k: number) => setLines((prev) => prev.filter((l) => l.key !== k));

  const totals = useMemo(() => {
    const subtotal = lines.reduce((acc, l) => acc.plus(D(lineTotal(l.unitPrice, l.quantity))), D(0));
    const tax = round2(subtotal.times(D(taxRate).dividedBy(100)));
    return { subtotal: round2(subtotal).toFixed(2), tax: tax.toFixed(2), total: round2(subtotal.plus(tax)).toFixed(2) };
  }, [lines, taxRate]);

  function submit() {
    setError("");
    if (!lines.length) return setError("أضف صنفاً واحداً على الأقل.");
    for (const l of lines) {
      if (!D(l.quantity).gt(0)) return setError(`الكمية في «${l.label}» يجب أن تكون موجبة.`);
      if (D(l.unitPrice).lt(0)) return setError(`السعر في «${l.label}» غير صالح.`);
    }
    create.mutate({
      branchId: defaultBranch,
      customerId: customerId ?? undefined,
      priceTier: effectiveTier,
      validUntil: validUntil || undefined,
      taxRatePercent: taxRate || "0",
      notes: notes.trim() || undefined,
      lines: lines.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: D(l.quantity).toString(),
        unitPriceOverride: D(l.unitPrice).toFixed(2),
      })),
    });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">عرض سعر جديد</h1>
        <Link href="/quotations" className="text-sm text-muted-foreground">← رجوع للعروض</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">العميل والشروط</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <CustomerPicker
            customerId={customerId}
            onCustomerChange={(id) => { setCustomerId(id); setTierOverride(null); }}
            balance={selectedCustomer?.currentBalance ?? null}
          />
          <div className="space-y-1">
            <Label>فئة السعر</Label>
            <select className={selectCls} value={effectiveTier} onChange={(e) => setTierOverride(e.target.value as Tier)}>
              <option value="RETAIL">مفرد</option>
              <option value="WHOLESALE">جملة</option>
              <option value="GOVERNMENT">حكومي</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label>نسبة الضريبة %</Label>
            <Input dir="ltr" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1">
            <Label>صالح حتى</Label>
            <Input type="date" dir="ltr" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">البنود</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث عن صنف بالاسم/SKU/الباركود…" />
            {search.trim() && (results.data?.length ?? 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-64 overflow-auto">
                {results.data!.map((row) => (
                  <button key={row.productUnitId} className="block w-full text-right px-3 py-2 text-sm hover:bg-accent" onClick={() => addRow(row)}>
                    {row.productName} <span className="text-muted-foreground">({row.unitName})</span>
                    <span className="text-xs text-muted-foreground"> — {row.price == null ? "بلا سعر" : fmt(row.price)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الصنف</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2 w-24">الكمية</th>
                <th className="p-2 w-32">سعر الوحدة</th>
                <th className="p-2 text-left w-28">الإجمالي</th>
                <th className="p-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="border-t">
                  <td className="p-2">{l.label}</td>
                  <td className="p-2 text-muted-foreground">{l.unitName}</td>
                  <td className="p-2"><Input dir="ltr" className="h-8" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} /></td>
                  <td className="p-2"><Input dir="ltr" className="h-8" value={l.unitPrice} onChange={(e) => patch(l.key, { unitPrice: e.target.value })} /></td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{lineTotal(l.unitPrice, l.quantity)}</td>
                  <td className="p-2"><Button variant="ghost" size="sm" onClick={() => remove(l.key)}>✕</Button></td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">ابحث أعلاه لإضافة أصناف.</td></tr>
              )}
            </tbody>
          </table>
          <div className="space-y-1">
            <Label>ملاحظات</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 flex justify-end">
          <div className="w-64 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">المجموع</span><span dir="ltr">{fmt(totals.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">الضريبة</span><span dir="ltr">{fmt(totals.tax)}</span></div>
            <div className="flex justify-between font-semibold border-t pt-1"><span>الإجمالي</span><span dir="ltr">{fmt(totals.total)} د.ع</span></div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ عرض السعر"}</Button>
        <Link href="/quotations"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
