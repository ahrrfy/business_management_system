import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { AlertCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * إضافة منتج — v3 add-screens (شاشة واحدة كاملة، بلا wizard).
 *
 * تصميم:
 *  - **اسم مركّب**: النوع · الماركة · الموديل ⇒ معاينة مباشرة لبطاقة الكاتالوج.
 *  - وصف، حد أدنى للتنبيه، خاضع للتخصيص (toggle)، حالة المنتج (toggle).
 *  - **رفع صور** (حتى ١٠) مع تحديد الرئيسية وسحب/إفلات.
 *  - **اقتراح SKU** تلقائي من بادئة الماركة + الموديل + رقم تسلسلي.
 *  - جدول وحدات وأسعار ديناميكي (الوحدة الأساس + إضافات).
 *
 * العقد: ينادي `catalog.createProduct` بالحقول الجديدة (productType/brand/modelName/images)
 * والمتغيّر الواحد المستخرَج من النموذج.
 */

type UnitRow = {
  key: number;
  unitName: string;
  conversionFactor: string;
  barcode: string;
  retail: string;
  wholesale: string;
};

function suggestSku(brand: string, model: string): string {
  const b = brand.trim().slice(0, 2).toUpperCase().replace(/[^A-Z0-9]/g, "X") || "PR";
  const m = model.trim().slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, "") || Math.floor(100 + Math.random() * 900).toString();
  const tail = Math.floor(100 + Math.random() * 900);
  return `${b}-${m}-${tail}`;
}

export default function ProductNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  // الاسم المركّب: نوع · ماركة · موديل
  const [productType, setProductType] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");

  // باقي بيانات المنتج
  const [description, setDescription] = useState("");
  const [sku, setSku] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [openingStock, setOpeningStock] = useState("0");
  const [minStock, setMinStock] = useState("0");
  const [isActive, setIsActive] = useState(true);
  const [isCustomizable, setIsCustomizable] = useState(false);

  // الوحدات والأسعار
  const [units, setUnits] = useState<UnitRow[]>([
    { key: 1, unitName: "قطعة", conversionFactor: "1", barcode: "", retail: "", wholesale: "" },
  ]);
  const [baseKey, setBaseKey] = useState(1);

  // الصور
  const [images, setImages] = useState<ImageItem[]>([]);

  const [error, setError] = useState("");

  const composedName = useMemo(
    () => [productType, brand, modelName].map((s) => s.trim()).filter(Boolean).join(" "),
    [productType, brand, modelName]
  );

  const primary = images.find((i) => i.isPrimary) ?? images[0];

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

  function fillSuggestedSku() {
    setSku(suggestSku(brand, modelName));
  }

  function submit() {
    setError("");
    if (!composedName) { setError("أدخل النوع/الماركة/الموديل لتركيب اسم المنتج."); return; }
    if (!sku.trim()) { setError("SKU مطلوب — استخدم زرّ الاقتراح أو اكتبه يدوياً."); return; }
    if (!costPrice.trim()) { setError("سعر التكلفة مطلوب."); return; }
    if (units.some((u) => !u.unitName.trim())) { setError("كل وحدة تحتاج اسماً."); return; }

    create.mutate({
      productType: productType.trim() || null,
      brand: brand.trim() || null,
      modelName: modelName.trim() || null,
      description: description.trim() || null,
      isCustomizable,
      variants: [
        {
          sku: sku.trim(),
          color: color.trim() || undefined,
          size: size.trim() || undefined,
          costPrice: costPrice.trim(),
          minStock: Math.max(0, Math.trunc(Number(minStock || 0))),
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
      images: images.length
        ? images.map((i, idx) => ({ url: i.dataUrl, isPrimary: !!i.isPrimary, sortOrder: idx }))
        : undefined,
    });
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة منتج</h1>
        <Link href="/products" className="text-sm text-muted-foreground">← رجوع للمنتجات</Link>
      </div>

      {/* ── المعاينة المباشرة + اسم مركّب ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">اسم المنتج المركّب</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label htmlFor="ptype">النوع *</Label>
              <Input id="ptype" value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="قلم جاف" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pbrand">الماركة *</Label>
              <Input id="pbrand" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Pilot" dir="auto" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pmodel">الموديل *</Label>
              <Input id="pmodel" value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="G-2" dir="auto" />
            </div>
            <div className="md:col-span-3 space-y-1">
              <Label htmlFor="pdesc">الوصف</Label>
              <Textarea id="pdesc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ملاحظات/خصائص…" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">معاينة الكاتالوج</CardTitle></CardHeader>
          <CardContent>
            <div className="rounded-lg border bg-muted/30 overflow-hidden">
              <div className="aspect-square bg-card flex items-center justify-center text-muted-foreground text-xs">
                {primary ? (
                  <img src={primary.dataUrl || primary.url} alt={composedName} className="w-full h-full object-cover" />
                ) : (
                  <span>— لا توجد صورة —</span>
                )}
              </div>
              <div className="p-3 space-y-1.5">
                <div className="text-sm font-semibold">
                  {composedName || <span className="text-muted-foreground">— اسم المنتج —</span>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {sku && <Badge variant="outline" className="text-[10px]" dir="ltr">{sku}</Badge>}
                  {color && <Badge variant="secondary" className="text-[10px]">{color}</Badge>}
                  {size && <Badge variant="secondary" className="text-[10px]" dir="ltr">{size}</Badge>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── الصور ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">صور المنتج</CardTitle></CardHeader>
        <CardContent>
          {/* بلا maxSizeMB صريح — افتراض المكوّن ٨ ميغا قبل الضغط التلقائي (علاج «قيمة أطول من المسموح»). */}
          <ImageUploader
            value={images}
            onChange={setImages}
            maxItems={10}
            hint="حتى 10 صور (تُضغط تلقائياً قبل الحفظ) — الأولى تكون رئيسيّة افتراضياً، ويمكن تغييرها بالنقر على «اجعلها رئيسية» عند التمرير فوق الصورة."
          />
        </CardContent>
      </Card>

      {/* ── التسعير والمخزون ───────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">التسعير والمخزون</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <Label htmlFor="sku">SKU *</Label>
            <div className="flex gap-1.5">
              <Input id="sku" dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="PG-549" />
              <Button type="button" variant="outline" size="sm" onClick={fillSuggestedSku} className="shrink-0 text-xs">
                اقتراح
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cost">سعر التكلفة (د.ع) *</Label>
            <Input id="cost" dir="ltr" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} placeholder="150" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="stock">المخزون الافتتاحي (وحدة أساس)</Label>
            <Input id="stock" dir="ltr" value={openingStock} onChange={(e) => setOpeningStock(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="color">اللون</Label>
            <Input id="color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="أزرق" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="size">القياس</Label>
            <Input id="size" value={size} onChange={(e) => setSize(e.target.value)} placeholder="0.7mm" dir="ltr" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="minS">الحد الأدنى للتنبيه</Label>
            <Input id="minS" dir="ltr" inputMode="numeric" value={minStock} onChange={(e) => setMinStock(e.target.value.replace(/\D/g, ""))} placeholder="10" />
          </div>
          <div className="space-y-1">
            <Label>قابل للتخصيص</Label>
            <div className="flex items-center gap-3 h-9">
              <Switch checked={isCustomizable} onCheckedChange={setIsCustomizable} />
              <span className="text-sm text-muted-foreground">{isCustomizable ? "نعم — يدخل في أوامر الشغل كمواد" : "لا — منتج جاهز للبيع"}</span>
            </div>
          </div>
          <div className="space-y-1">
            <Label>الحالة</Label>
            <div className="flex items-center gap-3 h-9">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <span className="text-sm text-muted-foreground">{isActive ? "مفعّل — يظهر في نقطة البيع" : "معطّل — مخفي"}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── الوحدات والأسعار ───────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">الوحدات والأسعار</CardTitle>
          <Button variant="outline" size="sm" onClick={addUnit}>+ إضافة وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            اختر الوحدة الأساس (معاملها = 1). الباركود والأسعار اختياريّة لكن يُنصح بها للبيع.
          </p>
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
                <label className="flex items-center gap-1 text-xs h-9">
                  <input type="radio" name="base" checked={isBase} onChange={() => setBaseKey(u.key)} /> أساس
                </label>
                <Button variant="ghost" size="sm" onClick={() => removeUnit(u.key)} disabled={units.length <= 1}>✕</Button>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* راية isActive لا تذهب للخادم حالياً — `catalog.createProduct` يَفتح المنتج مفعَّلاً
         وأيّ تعطيل يلي عبر شاشة التعديل (يحترم منطق RBAC). */}
      <span className="hidden">{String(isActive)}</span>

      {/* خطأ الخادم يُعرض كاملاً قرب زر الحفظ (رسائل errorMap العربية تذكر اسم الحقل —
          مثلاً «قيمة أطول من المسموح في الحقل «الصورة»» — فلا تُقصّ ولا تُبتلع). */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>{create.isPending ? "جارٍ الحفظ…" : "حفظ المنتج"}</Button>
        <Link href="/products"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
