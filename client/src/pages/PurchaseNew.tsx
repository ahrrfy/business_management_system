import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { D, fmt, lineTotal, round2, toBase } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

type Line = {
  key: number;
  variantId: number;
  productUnitId: number;
  label: string;
  unitName: string;
  conversionFactor: string;
  quantity: string;
  unitPrice: string;
};

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PurchaseNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();

  const suppliers = trpc.suppliers.list.useQuery();
  const branches = trpc.branches.list.useQuery();

  const [supplierId, setSupplierId] = useState<number | "">("");
  const [branchId, setBranchId] = useState<number | "">("");
  const [taxRate, setTaxRate] = useState("0");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [seq, setSeq] = useState(1);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  // inline new-supplier
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupName, setNewSupName] = useState("");
  const [newSupPhone, setNewSupPhone] = useState("");

  const effectiveBranch = branchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 1);
  const catalog = trpc.catalog.forPurchase.useQuery(
    { branchId: Number(effectiveBranch), query: query.trim() || undefined, limit: 50 },
    { enabled: !!effectiveBranch }
  );

  const createSupplier = trpc.suppliers.create.useMutation({
    onSuccess: async (r) => {
      await utils.suppliers.list.invalidate();
      setSupplierId(r.id);
      setShowNewSupplier(false);
      setNewSupName("");
      setNewSupPhone("");
    },
    onError: (e) => setError(e.message),
  });

  const create = trpc.purchases.createOrder.useMutation({
    onSuccess: async (r) => {
      await utils.purchases.list.invalidate();
      navigate(`/purchases/${r.purchaseOrderId}/receive`);
    },
    onError: (e) => setError(e.message),
  });

  function addLine(row: NonNullable<typeof catalog.data>[number]) {
    setLines((prev) => {
      if (prev.some((l) => l.productUnitId === row.productUnitId)) return prev;
      const label = `${row.productName}${row.variantName ? " — " + row.variantName : row.color ? " — " + row.color : ""} (${row.sku})`;
      // Prefill purchase-unit price = base-unit cost × conversion factor (keeps last-cost stable on receipt).
      const prefill = round2(D(row.costPriceBase).times(D(row.conversionFactor))).toFixed(2);
      return [
        ...prev,
        {
          key: seq,
          variantId: row.variantId,
          productUnitId: row.productUnitId,
          label,
          unitName: row.unitName,
          conversionFactor: String(row.conversionFactor),
          quantity: "1",
          unitPrice: prefill,
        },
      ];
    });
    setSeq((s) => s + 1);
  }
  const patchLine = (key: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: number) => setLines((prev) => prev.filter((l) => l.key !== key));

  const totals = useMemo(() => {
    const subtotal = lines.reduce(
      (acc, l) => acc.plus(D(lineTotal(l.unitPrice, l.quantity))),
      D(0)
    );
    const tax = round2(subtotal.times(D(taxRate).dividedBy(100)));
    const total = round2(subtotal.plus(tax));
    return { subtotal: round2(subtotal).toFixed(2), tax: tax.toFixed(2), total: total.toFixed(2) };
  }, [lines, taxRate]);

  function submit() {
    setError("");
    if (!supplierId) return setError("اختر المورد.");
    if (!effectiveBranch) return setError("اختر الفرع.");
    if (!lines.length) return setError("أضف صنفاً واحداً على الأقل.");
    for (const l of lines) {
      if (!D(l.quantity).gt(0)) return setError(`الكمية في «${l.label}» يجب أن تكون موجبة.`);
      if (l.unitPrice.trim() === "" || D(l.unitPrice).lt(0)) return setError(`سعر الشراء في «${l.label}» غير صالح.`);
      const base = toBase(l.quantity, l.conversionFactor);
      if (!base.isInteger()) return setError(`الكمية في «${l.label}» تنتج كسراً بالوحدة الأساس.`);
    }
    create.mutate({
      supplierId: Number(supplierId),
      branchId: Number(effectiveBranch),
      taxRatePercent: taxRate.trim() || "0",
      status: "CONFIRMED",
      notes: notes.trim() || undefined,
      items: lines.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: D(l.quantity).toString(),
        unitPrice: D(l.unitPrice).toFixed(2),
      })),
    });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">أمر شراء جديد</h1>
        <Link href="/purchases" className="text-sm text-muted-foreground">← رجوع للمشتريات</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">المورد والفرع</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label>المورد *</Label>
            <select className={selectCls} value={supplierId} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— اختر مورداً —</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowNewSupplier((v) => !v)}>
              {showNewSupplier ? "إلغاء" : "+ مورد جديد"}
            </button>
          </div>
          <div className="space-y-1">
            <Label>الفرع *</Label>
            <select className={selectCls} value={effectiveBranch} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>نسبة الضريبة %</Label>
            <Input dir="ltr" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0" />
          </div>
        </CardContent>
        {showNewSupplier && (
          <CardContent className="border-t pt-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="space-y-1">
              <Label className="text-xs">اسم المورد</Label>
              <Input value={newSupName} onChange={(e) => setNewSupName(e.target.value)} placeholder="مثال: مكتبة الجملة" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">الهاتف</Label>
              <Input dir="ltr" value={newSupPhone} onChange={(e) => setNewSupPhone(e.target.value)} />
            </div>
            <Button
              variant="outline"
              disabled={!newSupName.trim() || createSupplier.isPending}
              onClick={() => createSupplier.mutate({ name: newSupName.trim(), phone: newSupPhone.trim() || undefined })}
            >
              {createSupplier.isPending ? "جارٍ…" : "حفظ المورد"}
            </Button>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">إضافة أصناف</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث عن منتج بالاسم أو SKU أو الباركود…" />
          {query.trim() && (
            <div className="border rounded-md divide-y max-h-60 overflow-auto">
              {(catalog.data ?? []).map((row) => (
                <button
                  key={row.productUnitId}
                  type="button"
                  className="w-full text-right p-2 text-sm hover:bg-accent flex items-center justify-between gap-2"
                  onClick={() => addLine(row)}
                >
                  <span>{row.productName}{row.variantName ? ` — ${row.variantName}` : row.color ? ` — ${row.color}` : ""} · {row.unitName}</span>
                  <span className="text-xs text-muted-foreground font-mono" dir="ltr">{row.sku} · كلفة {row.costPriceBase}</span>
                </button>
              ))}
              {catalog.data && catalog.data.length === 0 && (
                <div className="p-3 text-center text-xs text-muted-foreground">لا نتائج.</div>
              )}
            </div>
          )}

          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الصنف</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2 w-24">الكمية</th>
                <th className="p-2 w-32">سعر الشراء</th>
                <th className="p-2 text-left w-28">الإجمالي</th>
                <th className="p-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="border-t">
                  <td className="p-2">{l.label}</td>
                  <td className="p-2 text-muted-foreground">{l.unitName}</td>
                  <td className="p-2">
                    <Input dir="ltr" className="h-8" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} />
                  </td>
                  <td className="p-2">
                    <Input dir="ltr" className="h-8" value={l.unitPrice} onChange={(e) => patchLine(l.key, { unitPrice: e.target.value })} />
                  </td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{lineTotal(l.unitPrice, l.quantity)}</td>
                  <td className="p-2">
                    <Button variant="ghost" size="sm" onClick={() => removeLine(l.key)}>✕</Button>
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">ابحث أعلاه لإضافة أصناف.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="space-y-1">
            <Label htmlFor="notes">ملاحظات</Label>
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <div className="w-64 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">المجموع</span><span dir="ltr">{fmt(totals.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">الضريبة</span><span dir="ltr">{fmt(totals.tax)}</span></div>
              <div className="flex justify-between font-semibold border-t pt-1"><span>الإجمالي</span><span dir="ltr">{fmt(totals.total)} د.ع</span></div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الإنشاء…" : "إنشاء وأمر بالاستلام"}</Button>
        <Link href="/purchases"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
