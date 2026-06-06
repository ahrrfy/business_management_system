import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link, useLocation } from "wouter";

type UnitRow = {
  key: number;
  unitName: string;
  conversionFactor: string;
  barcode: string;
  retail: string;
  wholesale: string;
};

export default function ProductNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [openingStock, setOpeningStock] = useState("0");
  const [units, setUnits] = useState<UnitRow[]>([
    { key: 1, unitName: "قطعة", conversionFactor: "1", barcode: "", retail: "", wholesale: "" },
  ]);
  const [baseKey, setBaseKey] = useState(1);
  const [error, setError] = useState("");

  const create = trpc.catalog.createProduct.useMutation({
    onSuccess: async () => {
      await utils.catalog.posList.invalidate();
      navigate("/products");
    },
    onError: (e) => setError(e.message),
  });

  const addUnit = () => {
    const k = Math.max(...units.map((u) => u.key)) + 1;
    setUnits([...units, { key: k, unitName: "", conversionFactor: "", barcode: "", retail: "", wholesale: "" }]);
  };
  const removeUnit = (k: number) => {
    if (units.length <= 1) return;
    const next = units.filter((u) => u.key !== k);
    setUnits(next);
    if (baseKey === k) setBaseKey(next[0].key);
  };
  const patchUnit = (k: number, patch: Partial<UnitRow>) =>
    setUnits(units.map((u) => (u.key === k ? { ...u, ...patch } : u)));

  function submit() {
    setError("");
    if (!name.trim() || !sku.trim() || !costPrice.trim()) {
      setError("اسم المنتج وSKU والتكلفة حقول مطلوبة.");
      return;
    }
    if (units.some((u) => !u.unitName.trim())) {
      setError("كل وحدة تحتاج اسماً.");
      return;
    }
    create.mutate({
      name: name.trim(),
      variants: [
        {
          sku: sku.trim(),
          color: color.trim() || undefined,
          size: size.trim() || undefined,
          costPrice: costPrice.trim(),
          openingStock: Math.max(0, Math.trunc(Number(openingStock || 0))),
          units: units.map((u) => ({
            unitName: u.unitName.trim(),
            conversionFactor: u.key === baseKey ? "1" : u.conversionFactor.trim() || "1",
            barcode: u.barcode.trim() || undefined,
            isBaseUnit: u.key === baseKey,
            prices: [
              ...(u.retail.trim() ? [{ priceTier: "RETAIL" as const, price: u.retail.trim() }] : []),
              ...(u.wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: u.wholesale.trim() }] : []),
            ],
          })),
        },
      ],
    });
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة منتج</h1>
        <Link href="/products" className="text-sm text-muted-foreground">← رجوع للمنتجات</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات المنتج</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">اسم المنتج *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: قلم جاف أزرق" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sku">SKU *</Label>
            <Input id="sku" dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="PEN-BLUE" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="color">اللون</Label>
            <Input id="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="size">القياس</Label>
            <Input id="size" value={size} onChange={(e) => setSize(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cost">سعر التكلفة (بالوحدة الأساس) *</Label>
            <Input id="cost" dir="ltr" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} placeholder="150" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="stock">المخزون الافتتاحي (بالوحدة الأساس)</Label>
            <Input id="stock" dir="ltr" value={openingStock} onChange={(e) => setOpeningStock(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">الوحدات والأسعار</CardTitle>
          <Button variant="outline" size="sm" onClick={addUnit}>+ إضافة وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">اختر الوحدة الأساس (معاملها = ١). الباركود والأسعار اختيارية لكن يُنصح بها للبيع.</p>
          {units.map((u) => {
            const isBase = u.key === baseKey;
            return (
              <div key={u.key} className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end border-t pt-3">
                <div className="space-y-1">
                  <Label className="text-xs">الوحدة</Label>
                  <Input value={u.unitName} onChange={(e) => patchUnit(u.key, { unitName: e.target.value })} placeholder="قطعة/درزن" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">معامل التحويل</Label>
                  <Input dir="ltr" value={isBase ? "1" : u.conversionFactor} disabled={isBase}
                    onChange={(e) => patchUnit(u.key, { conversionFactor: e.target.value })} placeholder="12" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">الباركود</Label>
                  <Input dir="ltr" value={u.barcode} onChange={(e) => patchUnit(u.key, { barcode: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">سعر مفرد</Label>
                  <Input dir="ltr" value={u.retail} onChange={(e) => patchUnit(u.key, { retail: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">سعر جملة</Label>
                  <Input dir="ltr" value={u.wholesale} onChange={(e) => patchUnit(u.key, { wholesale: e.target.value })} />
                </div>
                <label className="flex items-center gap-1 text-xs">
                  <input type="radio" name="base" checked={isBase} onChange={() => setBaseKey(u.key)} /> أساس
                </label>
                <Button variant="ghost" size="sm" onClick={() => removeUnit(u.key)} disabled={units.length <= 1}>✕</Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ المنتج"}</Button>
        <Link href="/products"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
