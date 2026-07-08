import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, Package, Plus, ScanLine, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { Field, MarginBadge, ScanButton } from "@/components/product/variantBits";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { barcodeState, genEan13, onlyDigits } from "@/lib/variants";
import { cn } from "@/lib/utils";

/**
 * BundleForm — إنشاء «بكج (باندل)»: منتج مركّب من عدّة منتجات بسيطة يُباع كوحدة بباركود وسعر مستقل.
 *
 * القواعد الاحترازية (يفرضها الخادم أيضاً — bundleService + createProduct):
 *  1. متغيّر واحد + وحدة أساس واحدة (البكج بلا ألوان/قياسات ولا وحدات مركّبة كالكرتون).
 *  2. المكوّنات منتجات بسيطة (لا بكج داخل بكج، ولا خدمة كمكوّن).
 *  3. الكميّة صحيحة موجبة (>0) بالوحدة الأساس.
 *  4. البكج بلا مخزون افتتاحي/رصيد ذاتي — مخزونه = مخزون مكوّناته الحيّ.
 *
 * التكلفة تُحسب لحظياً في الواجهة (معاينة) وفي الخادم لحظة البيع من WAVG المكوّنات.
 * السعر يضعه المدير بيده — يُنصَح ≤ Σ(أسعار المكوّنات المفردة) لتحفيز الشراء الجماعي.
 */
type ComponentPick = {
  componentVariantId: number;
  componentBaseQuantity: number;
  // للعرض فقط — لا يُرسَل للخادم
  productName: string;
  sku: string;
  unitCost: string;
};

export default function BundleForm() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();

  // ── بيانات المنتج ──
  const [name, setName] = useState("");
  const [productType, setProductType] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");

  // ── الباركود + السعر ──
  const [barcode, setBarcode] = useState("");
  const [unitName, setUnitName] = useState("قطعة");
  const [retail, setRetail] = useState("");
  const [wholesale, setWholesale] = useState("");
  const [government, setGovernment] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [images, setImages] = useState<ImageItem[]>([]);

  // ── مكوّنات البكج ──
  const [components, setComponents] = useState<ComponentPick[]>([]);
  const [picker, setPicker] = useState("");
  const [pickerCategoryId, setPickerCategoryId] = useState<number | "">("");
  const [scanCode, setScanCode] = useState("");
  const [scanFlash, setScanFlash] = useState<"" | "ok" | "err">("");
  const scanInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  const branchId = me.data?.branchId ?? 1;

  // ── تركيب الاسم ──
  const composedName = useMemo(
    () => [productType, brand, modelName].map((s) => s.trim()).filter(Boolean).join(" "),
    [productType, brand, modelName]
  );
  const finalName = name.trim() || composedName;

  // ── فحص الباركود ──
  const code = barcode.trim();
  const debouncedCode = useDebouncedValue(code, 450);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: [debouncedCode] },
    { enabled: debouncedCode.length > 0, staleTime: 10_000 }
  );
  const taken = useMemo(() => (checkQ.data ?? []).find((r) => r.code === code), [checkQ.data, code]);
  const bcState = barcodeState(code, { countInForm: 1, takenInDb: !!taken });

  // ── بحث المكوّنات المؤهّلة (يفلتر البكجات/الخدمات خادمياً) ──
  //     ينشط بأحد شرطين: نصّ بحث ≥ حرفَين، أو اختيار فئة (تصفّح الفئة كاملة).
  const pickerDeb = useDebouncedValue(picker, 300);
  const hasQuery = pickerDeb.trim().length >= 2;
  const hasCategory = pickerCategoryId !== "";
  const searchQ = trpc.bundles.searchComponents.useQuery(
    {
      q: hasQuery ? pickerDeb : undefined,
      categoryId: hasCategory ? Number(pickerCategoryId) : undefined,
      limit: 30,
    },
    { enabled: hasQuery || hasCategory, staleTime: 5_000 }
  );

  // ── بحث بالباركود (query يُستدعى بشكلٍ حَتميّ عبر fetch عند مسح/إدخال) ──
  const [scanBusy, setScanBusy] = useState(false);
  async function submitScan() {
    const code = scanCode.trim();
    if (!code || scanBusy) return;
    setScanBusy(true);
    setError("");
    try {
      const res = await utils.bundles.lookupComponentByBarcode.fetch({ barcode: code });
      if (!res.item) {
        setError("لا يوجد منتج مؤهّل بهذا الباركود (قد يكون بكجاً/خدمة/غير نشط).");
        setScanFlash("err");
        setTimeout(() => setScanFlash(""), 900);
        return;
      }
      addComponent(res.item.variantId, res.item.productName, res.item.sku ?? "", res.item.costPrice);
      setScanCode("");
      setScanFlash("ok");
      setTimeout(() => setScanFlash(""), 700);
      scanInputRef.current?.focus();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "تعذّر البحث عن الباركود.";
      setError(msg);
      setScanFlash("err");
      setTimeout(() => setScanFlash(""), 900);
    } finally {
      setScanBusy(false);
    }
  }

  // ── حساب التكلفة اللحظية (Σ تكاليف مكوّنات × كمياتها) ──
  const computedCost = useMemo(() => {
    let total = 0;
    for (const c of components) {
      total += (parseFloat(c.unitCost) || 0) * c.componentBaseQuantity;
    }
    return total;
  }, [components]);

  // ── مجموع أسعار المكوّنات مفردةً (للمقارنة مع سعر البكج) ──
  const searchRows = useMemo(() => searchQ.data?.items ?? [], [searchQ.data]);
  const _branchIdUnused = branchId; // reserved for future branch-scoped previews

  function addComponent(variantId: number, productName: string, sku: string, cost: string) {
    if (components.some((c) => c.componentVariantId === variantId)) {
      setError(`المكوّن «${productName}» مضاف مسبقاً — زد كميّته بدل تكرار السطر.`);
      return;
    }
    setComponents((prev) => [
      ...prev,
      { componentVariantId: variantId, componentBaseQuantity: 1, productName, sku, unitCost: cost },
    ]);
    setPicker("");
    setError("");
  }

  function updateQty(variantId: number, qty: number) {
    setComponents((prev) =>
      prev.map((c) =>
        c.componentVariantId === variantId ? { ...c, componentBaseQuantity: Math.max(1, Math.trunc(qty)) } : c
      )
    );
  }

  function removeComponent(variantId: number) {
    setComponents((prev) => prev.filter((c) => c.componentVariantId !== variantId));
  }

  const create = trpc.catalog.createProduct.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.adminList.invalidate()]);
      navigate("/products");
    },
    onError: (e) => setError(e.message),
  });

  function validate(): string | null {
    if (!finalName) return "اسم البكج مطلوب.";
    if (!unitName.trim()) return "اسم الوحدة مطلوب (عادةً «قطعة»).";
    if (!retail.trim() && !wholesale.trim() && !government.trim()) return "حدّد سعر بيع واحداً على الأقل.";
    if (!components.length) return "أضف مكوّناً واحداً على الأقل للبكج.";
    if (components.some((c) => c.componentBaseQuantity <= 0)) return "كل كميّة يجب أن تكون صحيحة موجبة.";
    return null;
  }

  async function save() {
    setError("");
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    if (code) {
      try {
        const hit = await utils.catalog.checkBarcodes.fetch({ codes: [code] });
        if (hit.length) {
          setError(`الباركود ${hit[0].code} مُستخدَم في «${hit[0].takenBy}». غيّره قبل الحفظ.`);
          return;
        }
      } catch {
        // لا نمنع الحفظ — قيد UNIQUE في DB الحارس الأخير.
      }
    }
    const prices = [
      ...(retail.trim() ? [{ priceTier: "RETAIL" as const, price: retail.trim() }] : []),
      ...(wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: wholesale.trim() }] : []),
      ...(government.trim() ? [{ priceTier: "GOVERNMENT" as const, price: government.trim() }] : []),
    ];
    // SKU مولَّد تلقائياً — البكج نادراً ما يحتاج SKU يدوي.
    const slug = finalName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const sku = slug ? `BDL-${slug}-${suffix}` : `BDL-${suffix}`;

    create.mutate({
      name: finalName,
      productType: productType.trim() || null,
      brand: brand.trim() || null,
      modelName: modelName.trim() || null,
      description: description.trim() || null,
      categoryId: categoryId === "" ? undefined : Number(categoryId),
      isBundle: true,
      // costPrice على متغيّر البكج غير مستعمَل عملياً (تُحسب لحظياً من المكوّنات) — نضع "0".
      variants: [
        {
          sku,
          costPrice: "0",
          isActive,
          units: [
            {
              unitName: unitName.trim(),
              conversionFactor: "1",
              barcode: code || undefined,
              isBaseUnit: true,
              prices,
            },
          ],
        },
      ],
      bundleComponents: components.map((c, idx) => ({
        componentVariantId: c.componentVariantId,
        componentBaseQuantity: c.componentBaseQuantity,
        sortOrder: idx,
      })),
      images: images.length
        ? images.map((i, idx) => ({ url: i.dataUrl, isPrimary: !!i.isPrimary, sortOrder: idx }))
        : undefined,
    });
  }

  return (
    <div className="space-y-4">
      {/* ── بيانات البكج ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package aria-hidden className="size-4" /> بيانات البكج
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            بكجٌ (باندل): منتج مركّب من عدّة منتجات يُباع كوحدة بباركود وسعر مستقلّ. تُحسب تكلفته لحظة البيع من مكوّناته.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field
            label="اسم البكج"
            required
            hint="مثال: «طقم مدرسي أساسي» أو «هدية تخرّج فاخرة»."
            className="md:col-span-3"
          >
            <div className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم البكج الكامل" dir="auto" />
              {composedName && composedName !== name.trim() && (
                <Button type="button" variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => setName(composedName)}>
                  ↻ تركيب من الحقول
                </Button>
              )}
            </div>
          </Field>
          <Field label="النوع (اختياري)" hint="حقل وصفي.">
            <Input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="طقم مدرسي" />
          </Field>
          <Field label="الماركة (اختياري)">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="…" />
          </Field>
          <Field label="الموديل (اختياري)">
            <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="…" />
          </Field>
          <Field label="الفئة" className="md:col-span-2">
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">— بلا فئة —</option>
              {(categoriesQ.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="التفعيل">
            <div className="flex items-center gap-2 h-9">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <span className="text-xs text-muted-foreground">{isActive ? "نشط" : "معطّل"}</span>
            </div>
          </Field>
          <Field label="الوصف (اختياري)" className="md:col-span-3">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>
        </CardContent>
      </Card>

      {/* ── مكوّنات البكج ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">مكوّنات البكج</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            أضف المكوّنات بأيّ طريقة تناسبك: <strong>امسح باركود المنتج</strong>، أو <strong>اختر فئة لتصفّح منتجاتها</strong>، أو <strong>اكتب اسماً/SKU</strong>. الخدمات والبكجات الأخرى مستبعَدة تلقائياً.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* — طريقة ١: مسح الباركود — */}
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-xs font-medium mb-1.5 flex items-center gap-1.5">
              <ScanLine aria-hidden className="size-3.5" /> مسح بالباركود
              <span className="text-muted-foreground font-normal">— وجّه القارئ إلى المنتج، أو اكتب الباركود واضغط Enter</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                ref={scanInputRef}
                value={scanCode}
                onChange={(e) => setScanCode(onlyDigits(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitScan();
                  }
                }}
                placeholder="باركود المنتج…"
                dir="ltr"
                inputMode="numeric"
                className={cn(
                  "font-mono",
                  scanFlash === "ok" && "border-emerald-500 ring-1 ring-emerald-500",
                  scanFlash === "err" && "border-red-500 ring-1 ring-red-500",
                )}
                aria-label="مسح الباركود"
              />
              <Button type="button" variant="secondary" onClick={submitScan} disabled={scanBusy || !scanCode.trim()}>
                <Plus aria-hidden className="size-4 me-1" /> إضافة
              </Button>
            </div>
          </div>

          {/* — طريقة ٢ + ٣: تصفّح بالفئة + بحث نصّي — */}
          <div className="rounded-md border bg-muted/20 p-3 space-y-2">
            <div className="text-xs font-medium flex items-center gap-1.5">
              <Search aria-hidden className="size-3.5" /> تصفّح أو ابحث في المنتجات
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_240px] gap-2">
              <Input
                value={picker}
                onChange={(e) => setPicker(e.target.value)}
                placeholder="اكتب ≥ حرفَين (اسم أو SKU)…"
                dir="auto"
                aria-label="بحث نصّي على المكوّنات"
              />
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={pickerCategoryId}
                onChange={(e) => setPickerCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
                aria-label="فلترة بالفئة"
              >
                <option value="">— كل الفئات —</option>
                {(categoriesQ.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            {(hasQuery || hasCategory) ? (
              <div className="max-h-64 overflow-auto rounded-md border bg-popover">
                {searchQ.isFetching ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">جارٍ البحث…</div>
                ) : searchRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    لا نتائج — جرّب فئة أخرى أو نصّاً مختلفاً.
                  </div>
                ) : (
                  <ul>
                    {searchRows.map((r) => {
                      const already = components.some((c) => c.componentVariantId === r.variantId);
                      return (
                        <li key={r.variantId}>
                          <button
                            type="button"
                            disabled={already}
                            onClick={() => addComponent(r.variantId, r.productName, r.sku ?? "", r.costPrice)}
                            className={cn(
                              "w-full text-right px-3 py-2 text-sm flex items-center justify-between gap-2 border-b last:border-b-0",
                              already ? "opacity-50 cursor-not-allowed" : "hover:bg-accent focus:bg-accent",
                            )}
                          >
                            <span className="flex items-center gap-2 truncate">
                              {!already && <Plus aria-hidden className="size-3.5 shrink-0" />}
                              <span className="truncate">{r.productName}</span>
                              {already && <span className="text-xs text-emerald-600 shrink-0">مُضاف</span>}
                            </span>
                            <span className="text-xs text-muted-foreground shrink-0 font-mono">{r.sku}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground text-center py-2">
                اختر فئة أو ابدأ الكتابة لعرض المنتجات.
              </div>
            )}
          </div>

          {components.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-8 border rounded-md">
              لا مكوّنات بعد — استعمل الباركود، الفئة، أو البحث النصّي أعلاه.
            </div>
          )}

          {components.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">المكوّن</th>
                    <th className="px-3 py-2 text-right font-medium">SKU</th>
                    <th className="px-3 py-2 text-right font-medium">التكلفة (لكل قطعة)</th>
                    <th className="px-3 py-2 text-right font-medium">الكميّة</th>
                    <th className="px-3 py-2 text-right font-medium">المجموع</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {components.map((c) => {
                    const lineTotal = (parseFloat(c.unitCost) || 0) * c.componentBaseQuantity;
                    return (
                      <tr key={c.componentVariantId} className="border-t">
                        <td className="px-3 py-2">{c.productName}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.sku}</td>
                        <td className="px-3 py-2">{Number(c.unitCost).toLocaleString("en-US")}</td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            value={c.componentBaseQuantity}
                            onChange={(e) => updateQty(c.componentVariantId, parseInt(e.target.value || "1", 10))}
                            className="w-20"
                          />
                        </td>
                        <td className="px-3 py-2 font-medium">{lineTotal.toLocaleString("en-US")}</td>
                        <td className="px-3 py-2 text-left">
                          <Button variant="ghost" size="icon" onClick={() => removeComponent(c.componentVariantId)} aria-label="حذف">
                            <X className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t bg-muted/30 font-medium">
                    <td colSpan={4} className="px-3 py-2">التكلفة المحسوبة للبكج</td>
                    <td className="px-3 py-2">{computedCost.toLocaleString("en-US")}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── الباركود والتسعير ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">الباركود والتسعير</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Field label="الوحدة">
            <Input value={unitName} onChange={(e) => setUnitName(e.target.value)} placeholder="قطعة" />
          </Field>
          <Field label="الباركود" hint="امسحه بالقارئ أو اكتبه، أو ولّد EAN-13.">
            <div className="flex items-center gap-2">
              <Input
                value={barcode}
                onChange={(e) => setBarcode(onlyDigits(e.target.value))}
                placeholder="EAN-13 أو Code128"
                className={cn(
                  bcState === "takenInDb"
                    ? "border-amber-500 ring-1 ring-amber-500"
                    : bcState === "invalid"
                      ? "border-amber-500"
                      : bcState === "valid"
                        ? "border-emerald-500/60"
                        : ""
                )}
              />
              <ScanButton onClick={() => setBarcode(genEan13())} />
            </div>
            {taken && (
              <div className="mt-1 text-xs text-amber-600">مُستخدَم في «{taken.takenBy}» — غيّره.</div>
            )}
          </Field>
          <Field label="سعر المفرد" required hint="سعر البيع الرئيسي للبكج.">
            <MoneyInput value={retail} onChange={setRetail} placeholder="0" />
          </Field>
          <Field label="سعر الجملة">
            <MoneyInput value={wholesale} onChange={setWholesale} placeholder="0" />
          </Field>
          <Field label="سعر الحكومي">
            <MoneyInput value={government} onChange={setGovernment} placeholder="0" />
          </Field>
          <Field label="هامش الربح (على المفرد)" className="md:col-span-3">
            <div className="flex items-center gap-2 h-9">
              <MarginBadge cost={computedCost} sell={parseFloat(retail) || 0} />
              <span className="text-xs text-muted-foreground">
                التكلفة تحدَّث تلقائياً من مكوّنات البكج ({computedCost.toLocaleString("en-US")} د.ع).
              </span>
            </div>
          </Field>
        </CardContent>
      </Card>

      {/* ── الصور ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">صور البكج (اختياري)</CardTitle>
        </CardHeader>
        <CardContent>
          <ImageUploader value={images} onChange={setImages} />
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-50 dark:bg-red-950/40 p-3 text-sm flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 shrink-0 text-red-600" />
          <div>{error}</div>
        </div>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => navigate("/products")}>إلغاء</Button>
        <Button onClick={save} disabled={create.isPending || components.length === 0}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ البكج"}
        </Button>
      </div>
    </div>
  );
}
