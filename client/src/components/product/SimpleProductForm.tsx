import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { Field, MarginBadge, MiniBarcode, ScanButton } from "@/components/product/variantBits";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { barcodeState, clampInt, genEan13, onlyDigits, toArabicDigits } from "@/lib/variants";
import { UnitBarcodeAliases, type LocalAlias } from "@/components/product/UnitBarcodeAliases";
import { cn } from "@/lib/utils";

/**
 * SimpleProductForm — إضافة «سلعة بسيطة» بلا ألوان/قياسات: منتجٌ واحد بباركود واحد.
 *
 * شريحة add-simple-product: كثير من أصناف المكتبة (كتاب، ملزمة، دفتر مفرد) بلا متغيّرات
 * ولا باركودات متعددة — فشاشة «المتغيّرات» تُثقِلها بلا داعٍ وتُلزِم إدخال «لون» وهميّ.
 * هذا النموذج يُرسِل إلى `catalog.createProduct` **متغيّراً واحداً** (بلا لون/قياس) بوحدة أساس
 * واحدة تحمل الباركود مباشرةً — وهو ما يدعمه العقد الخادميّ أصلاً (productUnits.barcode).
 *
 * المسح: تركيز حقل الباركود يجعل ماسح HID يكتب فيه مباشرةً؛ زرّ «المسح» يولّد EAN-13 صالحاً
 * لمن يطبع باركوده ذاتياً. فحص تكرار حيّ ضدّ القاعدة عبر `catalog.checkBarcodes` (نفس مسار المتغيّرات).
 */
export default function SimpleProductForm() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();

  // ── بيانات المنتج ──
  const [name, setName] = useState("");
  const [productType, setProductType] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [sku, setSku] = useState("");

  // ── الباركود + الوحدة + التسعير ──
  const [barcode, setBarcode] = useState("");
  const [unitName, setUnitName] = useState("قطعة");
  // باركودات بديلة تُجمَع محلّياً وتُدرَج ذرّياً مع المنتج عند الحفظ.
  const [aliases, setAliases] = useState<LocalAlias[]>([]);
  const [costPrice, setCostPrice] = useState("");
  const [retail, setRetail] = useState("");
  const [wholesale, setWholesale] = useState("");
  const [government, setGovernment] = useState("");

  // ── المخزون الافتتاحي + الضبط ──
  const [stockByBranch, setStockByBranch] = useState<Record<number, string>>({});
  const [minStock, setMinStock] = useState("0");
  const [reorderPoint, setReorderPoint] = useState("0");
  const [isCustomizable, setIsCustomizable] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [images, setImages] = useState<ImageItem[]>([]);

  const [error, setError] = useState("");

  const branches = useMemo(
    () => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })),
    [branchesQ.data]
  );

  const composedName = useMemo(
    () => [productType, brand, modelName].map((s) => s.trim()).filter(Boolean).join(" "),
    [productType, brand, modelName]
  );
  const finalName = name.trim() || composedName;

  // ── فحص تكرار الباركود ضدّ القاعدة (live، debounced) — نفس نمط شاشة المتغيّرات ──
  const code = barcode.trim();
  const debouncedCode = useDebouncedValue(code, 450);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: [debouncedCode] },
    { enabled: debouncedCode.length > 0, staleTime: 10_000 }
  );
  const taken = useMemo(() => (checkQ.data ?? []).find((r) => r.code === code), [checkQ.data, code]);
  const bcState = barcodeState(code, { countInForm: 1, takenInDb: !!taken });
  const bcHint: Record<typeof bcState, string> = {
    empty: "",
    valid: "باركود EAN-13 صالح.",
    invalid: "خانة تحقّق EAN-13 غير مطابقة — يُقبل مع ذلك (قد يكون كود Code128 داخليّاً).",
    dupInForm: "",
    takenInDb: taken ? `مُستخدَم في «${taken.takenBy}» — غيّره قبل الحفظ.` : "باركود مُستخدَم مسبقاً.",
  };
  const bcCls =
    bcState === "takenInDb"
      ? "border-amber-500 ring-1 ring-amber-500"
      : bcState === "invalid"
        ? "border-amber-500"
        : bcState === "valid"
          ? "border-emerald-500/60"
          : "";

  const create = trpc.catalog.createProduct.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.adminList.invalidate()]);
      navigate("/products");
    },
    onError: (e) => {
      setError(e.message);
      // انقل التركيز للحقل المخالف ليكون الخطأ قابلاً للتصحيح (لا رسالةً غامضة عن رمز لم يُدخِله).
      if (/SKU|الرمز/.test(e.message)) document.getElementById("simple-sku")?.focus();
      else if (/باركود/.test(e.message)) document.getElementById("simple-barcode")?.focus();
    },
  });

  const totalStock = useMemo(
    () => Object.values(stockByBranch).reduce((s, q) => s + (parseInt(q, 10) || 0), 0),
    [stockByBranch]
  );

  /**
   * SKU صريح إن وُجد، وإلا يُولَّد فريداً. الأسماء العربية الخالصة تُجرَّد إلى فراغ بعد إسقاط
   * غير [A-Z0-9]، فنُلحِق لاحقةً عشوائية قصيرة لضمان التفرّد (وإلّا لَتصادم كلُّ اسمٍ عربيٍّ بلا
   * باركود على «PR» نفسه). الباركود (فريدٌ أصلاً) بديلٌ صالح حين يغيب مقطع الاسم اللاتيني.
   */
  function autoSku(): string {
    const explicit = sku.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (explicit) return explicit;
    const slug = finalName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    if (slug) return `PR-${slug}-${suffix}`;
    if (code) return code;
    return `PR-${suffix}`;
  }

  function validate(): string | null {
    if (!finalName) return "اسم المنتج مطلوب (اكتبه مباشرةً أو املأ النوع/الماركة/الموديل).";
    if (!unitName.trim()) return "وحدة القياس مطلوبة (قطعة / نسخة / علبة…).";
    if (!costPrice.trim()) return "سعر التكلفة مطلوب.";
    if (!retail.trim() && !wholesale.trim() && !government.trim()) return "حدّد سعر بيع واحداً على الأقل (المفرد افتراضاً).";
    return null;
  }

  async function save() {
    setError("");
    const err = validate();
    if (err) {
      setError(err);
      if (!finalName) document.getElementById("simple-name")?.focus();
      else if (!costPrice.trim()) document.getElementById("simple-cost")?.focus();
      return;
    }
    // فحص أخير حاسم للباركود ضدّ القاعدة (لا نعتمد على توقيت الـdebounce).
    if (code) {
      try {
        const hit = await utils.catalog.checkBarcodes.fetch({ codes: [code] });
        if (hit.length) {
          setError(`الباركود ${hit[0].code} مُستخدَم في «${hit[0].takenBy}». غيّره قبل الحفظ.`);
          document.getElementById("simple-barcode")?.focus();
          return;
        }
      } catch {
        // فشل الفحص المسبق لا يمنع الحفظ — قيد UNIQUE في القاعدة يبقى الحارس الأخير.
      }
    }
    const prices = [
      ...(retail.trim() ? [{ priceTier: "RETAIL" as const, price: retail.trim() }] : []),
      ...(wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: wholesale.trim() }] : []),
      ...(government.trim() ? [{ priceTier: "GOVERNMENT" as const, price: government.trim() }] : []),
    ];
    create.mutate({
      name: finalName,
      productType: productType.trim() || null,
      brand: brand.trim() || null,
      modelName: modelName.trim() || null,
      description: description.trim() || null,
      categoryId: categoryId === "" ? undefined : Number(categoryId),
      isCustomizable,
      isService: false,
      variants: [
        {
          sku: autoSku(),
          costPrice: costPrice.trim(),
          minStock: clampInt(minStock),
          reorderPoint: clampInt(reorderPoint),
          isActive,
          openingStockByBranch: branches
            .map((b) => ({ branchId: b.id, qty: clampInt(stockByBranch[b.id] || "0") }))
            .filter((x) => x.qty > 0),
          units: [
            {
              unitName: unitName.trim(),
              conversionFactor: "1",
              barcode: code || undefined,
              isBaseUnit: true,
              prices,
              barcodeAliases: aliases.length
                ? aliases.map((a) => ({ barcode: a.barcode, note: a.note ?? null }))
                : undefined,
            },
          ],
        },
      ],
      images: images.length
        ? images.map((i, idx) => ({ url: i.dataUrl, isPrimary: !!i.isPrimary, sortOrder: idx }))
        : undefined,
    });
  }

  const unitCost = parseFloat(costPrice) || 0;

  return (
    <div className="space-y-4">
      {/* ── بيانات المنتج ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package aria-hidden className="size-4" /> بيانات المنتج
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            منتج واحد بباركود واحد — للأصناف بلا ألوان/قياسات (كتاب، ملزمة، دفتر مفرد…).
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field
            label="اسم المنتج"
            required
            hint="يظهر في البيع والفواتير والتقارير. اكتبه مباشرةً أو ركّبه من النوع/الماركة/الموديل."
            className="md:col-span-3"
          >
            <div className="flex items-center gap-2">
              <Input id="simple-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم المنتج الكامل" dir="auto" />
              {composedName && composedName !== name.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => setName(composedName)}
                  title="تركيب الاسم من النوع/الماركة/الموديل"
                >
                  ↻ تركيب من الحقول
                </Button>
              )}
            </div>
          </Field>
          <Field label="النوع (اختياري)" hint="حقول وصفية للبحث/التصنيف — لا تغيّر الاسم تلقائياً.">
            <Input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="كتاب مدرسي" dir="auto" />
          </Field>
          <Field label="الماركة/الناشر (اختياري)">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="دار المعارف" dir="auto" />
          </Field>
          <Field label="الموديل/الطبعة (اختياري)">
            <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="ط. ٢٠٢٦" dir="auto" />
          </Field>
          <Field label="الفئة / التصنيف">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            >
              <option value="">— بلا فئة —</option>
              {(categoriesQ.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="رمز المنتج (SKU)" hint="يُولَّد تلقائياً وفريداً إن تُرك فارغاً." className="md:col-span-2">
            <Input id="simple-sku" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} dir="ltr" placeholder="PR-BOOK-ARB" />
          </Field>
          <Field label="الوصف" className="md:col-span-3">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="خصائص/ملاحظات…" />
          </Field>
        </CardContent>
      </Card>

      {/* ── الباركود والتسعير ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">الباركود والتسعير</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            امسح الباركود أو اكتبه (أو ولّده بالزر). يُفحَص فوراً ضدّ باقي المنتجات لمنع التكرار.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="الباركود" hint={bcHint[bcState] || "اختياري — يمكن إضافته لاحقاً."} className="md:col-span-2">
              <div className="flex items-center gap-2">
                <Input
                  id="simple-barcode"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  dir="ltr"
                  inputMode="numeric"
                  placeholder="امسح أو اكتب الباركود…"
                  title={bcHint[bcState]}
                  className={cn("font-mono", bcCls)}
                />
                <ScanButton onClick={() => setBarcode(genEan13("621"))} title="توليد باركود EAN-13 صالح" />
                <UnitBarcodeAliases
                  unitName={unitName || "قطعة"}
                  localAliases={aliases}
                  onLocalChange={setAliases}
                />
              </div>
            </Field>
            <Field label="وحدة القياس" required hint="قطعة / نسخة / علبة…">
              <Input value={unitName} onChange={(e) => setUnitName(e.target.value)} placeholder="قطعة" dir="auto" />
            </Field>
          </div>

          {code && (
            <div className="rounded-lg border bg-muted/20 p-3 inline-flex items-center gap-3">
              <div className="bg-white rounded p-2 flex justify-center min-h-[52px] items-center min-w-[180px]">
                <MiniBarcode value={code} />
              </div>
              <span className="text-[11px] text-muted-foreground">معاينة الباركود</span>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-t pt-4">
            <Field label="سعر التكلفة (د.ع)" required hint="سعر الشراء.">
              <MoneyInput id="simple-cost" value={costPrice} onChange={setCostPrice} placeholder="150" />
            </Field>
            <Field label="سعر المفرد (د.ع)" hint="السعر الافتراضي للبيع.">
              <MoneyInput value={retail} onChange={setRetail} placeholder="250" />
            </Field>
            <Field label="سعر الجملة (اختياري)">
              <MoneyInput value={wholesale} onChange={setWholesale} placeholder="—" />
            </Field>
            <Field label="سعر الحكومي (اختياري)">
              <MoneyInput value={government} onChange={setGovernment} placeholder="—" />
            </Field>
            <div className="col-span-2 md:col-span-4 flex items-center gap-2 text-xs text-muted-foreground">
              الهامش على المفرد: <MarginBadge cost={unitCost} sell={retail} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── المخزون الافتتاحي والضبط ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">المخزون الافتتاحي والضبط</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">الرصيد الافتتاحي لكل فرع (يُسجَّل حركة OPENING). اتركه صفراً إن لم يتوفّر بعد.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {branchesQ.isLoading ? (
              <p className="text-xs text-muted-foreground py-2">جارٍ تحميل الفروع…</p>
            ) : branches.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">لا توجد فروع مُعرَّفة — أضِف فرعاً أولاً.</p>
            ) : (
              branches.map((b) => (
                <Field key={b.id} label={`مخزون · ${b.name}`}>
                  <Input
                    value={stockByBranch[b.id] || ""}
                    onChange={(e) => setStockByBranch((s) => ({ ...s, [b.id]: onlyDigits(e.target.value) }))}
                    dir="ltr"
                    inputMode="numeric"
                    className="w-28 text-center"
                    placeholder="0"
                  />
                </Field>
              ))
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-t pt-4">
            <Field label="الحد الأدنى" hint="ينبّه عند النزول عنه.">
              <Input value={minStock} onChange={(e) => setMinStock(onlyDigits(e.target.value))} dir="ltr" inputMode="numeric" className="text-center" />
            </Field>
            <Field label="نقطة إعادة الطلب" hint="يقترح الشراء عند بلوغها.">
              <Input value={reorderPoint} onChange={(e) => setReorderPoint(onlyDigits(e.target.value))} dir="ltr" inputMode="numeric" className="text-center" />
            </Field>
            <Field label="قابل للتخصيص">
              <div className="flex items-center gap-2 h-9">
                <Switch checked={isCustomizable} onCheckedChange={setIsCustomizable} />
                <span className="text-xs text-muted-foreground">{isCustomizable ? "يدخل كمادة" : "جاهز للبيع"}</span>
              </div>
            </Field>
            <Field label="الحالة">
              <div className="flex items-center gap-2 h-9">
                <Switch checked={isActive} onCheckedChange={setIsActive} />
                <span className="text-xs text-muted-foreground">{isActive ? "مفعّل" : "مخفي"}</span>
              </div>
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* ── صور المنتج ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">صور المنتج (اختياري)</CardTitle></CardHeader>
        <CardContent>
          <ImageUploader
            value={images}
            onChange={setImages}
            maxItems={10}
            hint="حتى 10 صور للمنتج (تُضغط تلقائياً قبل الحفظ) — الأولى رئيسيّة افتراضياً."
          />
        </CardContent>
      </Card>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}

      {/* ── شريط الحفظ الثابت ── */}
      <div className="fixed bottom-0 inset-x-0 lg:start-60 border-t bg-card/95 backdrop-blur px-6 py-3 flex items-center justify-between gap-3 z-30">
        <div className="text-xs text-muted-foreground hidden sm:block">
          سيُحفظ منتج بسيط واحد
          {code ? " بباركوده" : " (بلا باركود)"}
          {totalStock > 0 && <> — رصيد افتتاحيّ <b className="text-foreground">{toArabicDigits(totalStock)}</b> {unitName.trim() || "قطعة"}</>}.
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => navigate("/products")}>إلغاء</Button>
          <Button type="button" size="sm" onClick={save} disabled={create.isPending}>
            {create.isPending ? "جارٍ الحفظ…" : "حفظ المنتج"}
          </Button>
        </div>
      </div>
    </div>
  );
}
