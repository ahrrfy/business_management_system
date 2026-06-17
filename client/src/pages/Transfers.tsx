import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Variant = {
  variantId: number;
  productName: string;
  variantName: string | null;
  color: string | null;
  sku: string;
  stockBase: number;
  unitName: string;
};

export default function Transfers() {
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const branches = trpc.branches.list.useQuery();
  const [fromBranchId, setFromBranchId] = useState<number | "">("");
  const [toBranchId, setToBranchId] = useState<number | "">("");
  const [variantId, setVariantId] = useState<number | "">("");
  const [baseQuantity, setBaseQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [query, setQuery] = useState("");

  // Defaults once branches load.
  const effectiveFrom =
    fromBranchId || me.data?.branchId || (branches.data?.[0] ? Number(branches.data[0].id) : 0);
  const effectiveTo =
    toBranchId ||
    (branches.data?.find((b) => Number(b.id) !== Number(effectiveFrom))
      ? Number(branches.data.find((b) => Number(b.id) !== Number(effectiveFrom))!.id)
      : 0);

  const catalog = trpc.catalog.forPurchase.useQuery(
    { branchId: Number(effectiveFrom), query: query.trim() || undefined, limit: 200 },
    { enabled: !!effectiveFrom }
  );

  // Reduce (variant×unit) rows to one row per variant — base unit preferred.
  const variants = useMemo<Variant[]>(() => {
    const byVariant = new Map<number, Variant>();
    for (const r of catalog.data ?? []) {
      const cur = byVariant.get(r.variantId);
      if (!cur || (!cur.unitName && r.isBaseUnit) || (r.isBaseUnit && !cur)) {
        byVariant.set(r.variantId, {
          variantId: r.variantId,
          productName: r.productName,
          variantName: r.variantName,
          color: r.color,
          sku: r.sku,
          stockBase: r.stockBase,
          unitName: r.isBaseUnit ? r.unitName : cur?.unitName ?? r.unitName,
        });
      }
    }
    return Array.from(byVariant.values());
  }, [catalog.data]);

  const selected = variants.find((v) => v.variantId === variantId);

  const transfer = trpc.inventory.transfer.useMutation({
    onSuccess: async () => {
      setDone(`تم تحويل ${baseQuantity} وحدة (أساس) بنجاح.`);
      setError("");
      setBaseQuantity("");
      setNotes("");
      await Promise.all([
        utils.catalog.forPurchase.invalidate(),
        utils.inventory.movements.invalidate(),
      ]);
    },
    onError: (e) => {
      setError(e.message);
      setDone("");
    },
  });

  function submit() {
    setError("");
    setDone("");
    if (!effectiveFrom || !effectiveTo) return setError("اختر فرعَي المصدر والوجهة.");
    if (effectiveFrom === effectiveTo) return setError("لا يمكن التحويل لنفس الفرع.");
    if (!variantId) return setError("اختر منتجاً.");
    const qty = Math.trunc(Number(baseQuantity || "0"));
    if (!Number.isInteger(qty) || qty <= 0) return setError("الكمية يجب أن تكون عدداً صحيحاً موجباً.");
    if (selected && qty > selected.stockBase)
      return setError(`الكمية تتجاوز المخزون المتاح في فرع المصدر (${selected.stockBase}).`);
    transfer.mutate({
      variantId: Number(variantId),
      fromBranchId: Number(effectiveFrom),
      toBranchId: Number(effectiveTo),
      baseQuantity: qty,
      notes: notes.trim() || undefined,
    });
  }

  const fromName = branches.data?.find((b) => Number(b.id) === Number(effectiveFrom))?.name ?? "—";
  const toName = branches.data?.find((b) => Number(b.id) === Number(effectiveTo))?.name ?? "—";

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تحويل بين الفروع</h1>
        <Link href="/inventory" className="text-sm text-muted-foreground">حركات المخزون ←</Link>
      </div>
      <p className="text-sm text-muted-foreground">انقل المخزون بين فرع وآخر بحركتين مرتبطتين (TRANSFER_OUT/IN) دون أي قيد محاسبي.</p>

      <Card>
        <CardHeader><CardTitle className="text-base">الفروع</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>من فرع *</Label>
            <select
              className={selectCls}
              value={effectiveFrom || ""}
              onChange={(e) => {
                setFromBranchId(e.target.value ? Number(e.target.value) : "");
                setVariantId("");
              }}
            >
              <option value="">— اختر —</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>إلى فرع *</Label>
            <select
              className={selectCls}
              value={effectiveTo || ""}
              onChange={(e) => setToBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">— اختر —</option>
              {(branches.data ?? [])
                .filter((b) => Number(b.id) !== Number(effectiveFrom))
                .map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">المنتج والكمية</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>بحث عن منتج (اسم/SKU/باركود)</Label>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="اكتب للبحث…" />
          </div>

          {query.trim() && (
            <div className="border rounded-md max-h-60 overflow-auto divide-y">
              {variants.slice(0, 50).map((v) => (
                <button
                  key={v.variantId}
                  type="button"
                  className={`w-full text-right p-2 text-sm hover:bg-accent flex items-center justify-between gap-2 ${
                    variantId === v.variantId ? "bg-accent" : ""
                  }`}
                  onClick={() => {
                    setVariantId(v.variantId);
                    setQuery("");
                  }}
                >
                  <span>
                    {v.productName}
                    {v.variantName ? ` — ${v.variantName}` : v.color ? ` — ${v.color}` : ""}
                    <span className="text-xs text-muted-foreground"> · {v.unitName}</span>
                  </span>
                  <span className="text-xs text-muted-foreground font-mono" dir="ltr">
                    {v.sku} · متاح {v.stockBase}
                  </span>
                </button>
              ))}
              {variants.length === 0 && (
                <div className="p-3 text-center text-xs text-muted-foreground">لا نتائج.</div>
              )}
            </div>
          )}

          {selected && (
            <div className="rounded-md bg-muted/40 p-3 text-sm flex items-center justify-between">
              <div>
                <div className="font-medium">{selected.productName}{selected.variantName ? ` — ${selected.variantName}` : ""}</div>
                <div className="text-xs text-muted-foreground font-mono" dir="ltr">{selected.sku}</div>
              </div>
              <div className="text-left">
                <div className="text-xs text-muted-foreground">المتاح في {fromName}</div>
                <div className="font-semibold tabular-nums" dir="ltr">{selected.stockBase} {selected.unitName}</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>الكمية بالوحدة الأساس *</Label>
              <Input dir="ltr" value={baseQuantity} onChange={(e) => setBaseQuantity(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1">
              <Label>ملاحظات</Label>
              <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}

      <div className="flex gap-2">
        <Button onClick={submit} disabled={transfer.isPending || !variantId}>
          {transfer.isPending ? "جارٍ التحويل…" : `تحويل من ${fromName} إلى ${toName}`}
        </Button>
        <Link href="/inventory"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
