import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";

type UnitRow = {
  key: number;
  id?: number; // existing
  unitName: string;
  conversionFactor: string;
  barcode: string;
  retail: string;
  wholesale: string;
  isBase: boolean;
};

export default function ProductEdit() {
  const params = useParams();
  const productId = Number(params.id);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const product = trpc.catalog.getForEdit.useQuery({ productId }, { enabled: Number.isFinite(productId) });

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [variantId, setVariantId] = useState<number | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  // Hydrate form from API once.
  useEffect(() => {
    if (!product.data) return;
    setName(product.data.name);
    const v = product.data.variants[0];
    if (!v) return;
    setVariantId(v.id);
    setSku(v.sku);
    setColor(v.color ?? "");
    setSize(v.size ?? "");
    setCostPrice(v.costPrice);
    const rows: UnitRow[] = v.units.map((u, i) => ({
      key: i + 1,
      id: u.id,
      unitName: u.unitName,
      conversionFactor: u.conversionFactor,
      barcode: u.barcode ?? "",
      retail: u.prices.find((p) => p.priceTier === "RETAIL")?.price ?? "",
      wholesale: u.prices.find((p) => p.priceTier === "WHOLESALE")?.price ?? "",
      isBase: u.isBaseUnit,
    }));
    setUnits(rows);
    setNextKey(rows.length + 1);
  }, [product.data]);

  const update = trpc.catalog.updateProduct.useMutation({
    onSuccess: async () => {
      setDone("تم الحفظ بنجاح.");
      setError("");
      await Promise.all([
        utils.catalog.getForEdit.invalidate({ productId }),
        utils.catalog.posList.invalidate(),
        utils.catalog.forPurchase.invalidate(),
      ]);
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  const addUnit = () => {
    setUnits((p) => [
      ...p,
      { key: nextKey, unitName: "", conversionFactor: "", barcode: "", retail: "", wholesale: "", isBase: false },
    ]);
    setNextKey((k) => k + 1);
  };
  const removeUnit = (k: number) => {
    if (units.length <= 1) return;
    setUnits((prev) => {
      const next = prev.filter((u) => u.key !== k);
      if (!next.some((u) => u.isBase)) next[0].isBase = true;
      return next;
    });
  };
  const setBase = (k: number) =>
    setUnits((prev) => prev.map((u) => ({ ...u, isBase: u.key === k, conversionFactor: u.key === k ? "1" : u.conversionFactor })));
  const patchUnit = (k: number, patch: Partial<UnitRow>) =>
    setUnits((prev) => prev.map((u) => (u.key === k ? { ...u, ...patch } : u)));

  function submit() {
    setError("");
    setDone("");
    if (!variantId) return setError("لم يُحمَّل المتغيّر بعد.");
    if (!name.trim() || !sku.trim() || !costPrice.trim()) return setError("الاسم والSKU والتكلفة مطلوبة.");
    if (!units.some((u) => u.isBase)) return setError("يلزم وحدة أساس واحدة.");
    if (units.some((u) => !u.unitName.trim())) return setError("كل وحدة تحتاج اسماً.");
    update.mutate({
      productId,
      name: name.trim(),
      variants: [
        {
          id: variantId,
          sku: sku.trim(),
          color: color.trim() || undefined,
          size: size.trim() || undefined,
          costPrice: costPrice.trim(),
          units: units.map((u) => ({
            id: u.id,
            unitName: u.unitName.trim(),
            conversionFactor: u.isBase ? "1" : (u.conversionFactor.trim() || "1"),
            barcode: u.barcode.trim() || undefined,
            isBaseUnit: u.isBase,
            prices: [
              ...(u.retail.trim() ? [{ priceTier: "RETAIL" as const, price: u.retail.trim() }] : []),
              ...(u.wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: u.wholesale.trim() }] : []),
            ],
          })),
        },
      ],
    });
  }

  if (product.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!product.data) return <div className="p-10 text-center text-muted-foreground">المنتج غير موجود.</div>;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تعديل المنتج</h1>
        <Link href="/products" className="text-sm text-muted-foreground">← رجوع للمنتجات</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات المنتج</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1"><Label>اسم المنتج *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label>SKU *</Label><Input dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} /></div>
          <div className="space-y-1"><Label>اللون</Label><Input value={color} onChange={(e) => setColor(e.target.value)} /></div>
          <div className="space-y-1"><Label>القياس</Label><Input value={size} onChange={(e) => setSize(e.target.value)} /></div>
          <div className="space-y-1"><Label>سعر التكلفة (بالوحدة الأساس) *</Label><Input dir="ltr" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">الوحدات والأسعار</CardTitle>
          <Button variant="outline" size="sm" onClick={addUnit}>+ إضافة وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">حذف الوحدة يُلغّيها (isActive=false) دون مساس بحركات سابقة.</p>
          {units.map((u) => (
            <div key={u.key} className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end border-t pt-3">
              <div className="space-y-1"><Label className="text-xs">الوحدة</Label><Input value={u.unitName} onChange={(e) => patchUnit(u.key, { unitName: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">معامل</Label><Input dir="ltr" value={u.isBase ? "1" : u.conversionFactor} disabled={u.isBase} onChange={(e) => patchUnit(u.key, { conversionFactor: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">الباركود</Label><Input dir="ltr" value={u.barcode} onChange={(e) => patchUnit(u.key, { barcode: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">مفرد</Label><Input dir="ltr" value={u.retail} onChange={(e) => patchUnit(u.key, { retail: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">جملة</Label><Input dir="ltr" value={u.wholesale} onChange={(e) => patchUnit(u.key, { wholesale: e.target.value })} /></div>
              <label className="flex items-center gap-1 text-xs">
                <input type="radio" name="base-edit" checked={u.isBase} onChange={() => setBase(u.key)} /> أساس
              </label>
              <Button variant="ghost" size="sm" onClick={() => removeUnit(u.key)} disabled={units.length <= 1}>✕</Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={update.isPending}>{update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}</Button>
        <Button variant="outline" onClick={() => navigate("/products")}>إلغاء</Button>
      </div>
    </div>
  );
}
