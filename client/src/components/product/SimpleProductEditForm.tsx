import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertCircle, CheckCircle2, Layers, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import { MoneyCoach } from "@/components/form/MoneyCoach";
import { NumberInput } from "@/components/form/NumberInput";
import { type ImageItem } from "@/components/form/ImageUploader";
import { ProductMediaContentSection } from "@/components/product/ProductMediaContentSection";
import { buildProductImagesPayload, hydrateProductImages } from "@/lib/productImages";
import { PageHeader } from "@/components/PageHeader";
import { Field, MarginBadge, ScanButton } from "@/components/product/variantBits";
import { UnitBarcodeAliases } from "@/components/product/UnitBarcodeAliases";
import { UnitPriceHistory } from "@/components/product/UnitPriceHistory";
import { trpc } from "@/lib/trpc";
import { ConsignmentField, type ConsignmentValue } from "@/components/product/ConsignmentField";
import { NameAssistant } from "@/components/product/NameAssistant";
import { Badge } from "@/components/ui/badge";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { barcodeInfo, clampInt, genEan13, onlyDigits, toArabicDigits } from "@/lib/variants";
import { cn } from "@/lib/utils";
import { CategoryOptionList } from "@/lib/categoryTree";
import { checkVariantSanity } from "@shared/priceSanity";

/**
 * SimpleProductEditForm — تحرير «سلعة بسيطة» (متغيّر واحد بلا لون/قياس) بنفس نظافة شاشة الإضافة.
 *
 * شريحة simple-edit-view: المنتج البسيط (كتاب/ملزمة/دفتر مفرد) كان يُحرَّر عبر جدول المتغيّرات
 * العريض (أعمدة لون/قياس بـ«—») — الباركود موجودٌ وقابلٌ للتعديل هناك لكنّ التجربة ثقيلة. هذا
 * النموذج يعرض حقولاً مباشرة: الاسم + وحدات بباركود لكلٍّ + التكلفة/الأسعار + الحدود + الحالة،
 * ويحفظ عبر `catalog.updateProductVariants` (متغيّر واحد بلا لون/قياس). المخزون قراءة فقط
 * (يُدار عبر الجرد/الحركات). زرّ «التحرير المتقدّم» يفتح محرّر المتغيّرات لإضافة ألوان.
 *
 * صور المنتج العامّة (المشتركة) تُحرَّر هنا مباشرةً (رافع صور — نفس شاشة الإضافة) وتُوفَّق بمطابقة
 * المعرّف عبر `lib/productImages`. صورة اللون المستقلّة (variant.image) تبقى دون مساس (تُدار في المتقدّم).
 */

type EditUnit = { id: number; name: string; factor: string; isBase: boolean; sellInStore: boolean; barcode: string; retail: string; wholesale: string; government: string };

/**
 * **priceSanity L1.5+L1.6 (٣٠/٧):** مرافقٌ حيّ + زرّ «آخر شراء» أسفل حقل التكلفة في «السلعة البسيطة».
 * السلعة البسيطة لها متغيّرٌ واحد ⇒ زرّ آخر شراء ذو معنى مباشر (يملأ الحقل بنقرة).
 */
function SimpleEditCostCoach({
  costPrice, baseRetail, categoryId, brand, productType, productId, variantId, onUseLastPurchase,
}: {
  costPrice: string;
  baseRetail: string;
  categoryId: number | null;
  brand: string;
  productType: string;
  productId: number;
  variantId: number | null;
  onUseLastPurchase: (cost: string) => void;
}) {
  const statsQ = trpc.catalog.categoryStats.useQuery(
    { categoryId, brand: brand.trim() || null, productType: productType.trim() || null, excludeProductId: productId },
    { enabled: categoryId != null || !!brand.trim() || !!productType.trim(), staleTime: 5 * 60 * 1000 }
  );
  const lastPurchaseQ = trpc.catalog.lastPurchaseCost.useQuery(
    { variantId: variantId ?? 0 },
    { enabled: variantId != null && variantId > 0, staleTime: 60 * 1000 }
  );
  const daysAgo = lastPurchaseQ.data?.receivedAt
    ? Math.floor((Date.now() - new Date(lastPurchaseQ.data.receivedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return (
    <div className="mt-1 space-y-1">
      <MoneyCoach
        cost={costPrice.trim()}
        retail={baseRetail.trim()}
        categoryStats={statsQ.data ? {
          minCost: statsQ.data.minCost ?? undefined,
          maxCost: statsQ.data.maxCost ?? undefined,
          medianCost: statsQ.data.medianCost ?? undefined,
          n: statsQ.data.n ?? 0,
        } : undefined}
      />
      {lastPurchaseQ.data && (
        <button
          type="button"
          onClick={() => onUseLastPurchase(lastPurchaseQ.data!.unitCost)}
          className="text-[11px] text-primary hover:underline"
          title={`من فاتورة الشراء #${lastPurchaseQ.data.purchaseOrderId}`}
        >
          استعمل آخر شراء: {Number(lastPurchaseQ.data.unitCost).toLocaleString("en-US")} د.ع
          {daysAgo != null && daysAgo >= 0 && ` — منذ ${daysAgo} يوماً`}
        </button>
      )}
    </div>
  );
}

export default function SimpleProductEditForm({
  productId,
  onAdvanced,
}: {
  productId: number;
  onAdvanced: () => void;
}) {
  const utils = trpc.useUtils();
  const branchesQ = trpc.branches.list.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();
  const product = trpc.catalog.getForVariantEdit.useQuery({ productId }, { enabled: Number.isFinite(productId) });

  const [hydrated, setHydrated] = useState(false);
  const [name, setName] = useState("");
  const [productType, setProductType] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [sku, setSku] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [minStock, setMinStock] = useState("0");
  const [reorderPoint, setReorderPoint] = useState("0");
  const [isCustomizable, setIsCustomizable] = useState(false);
  const [isActive, setIsActive] = useState(true);
  // صور المنتج العامّة (مشتركة) — تُحمَّل من الخادم وتُحفَظ بمطابقة المعرّف (lib/productImages).
  const [images, setImages] = useState<ImageItem[]>([]);
  const [consignment, setConsignment] = useState<ConsignmentValue>({ isConsignment: false, consignorId: null });

  const unitSeq = useRef(1);
  const [units, setUnits] = useState<EditUnit[]>([]);
  // معرّف المتغيّر الوحيد + رصيده الحالي (قراءة فقط). صورة اللون (variant.image) تُترَك دون مساس؛
  // صور المنتج العامّة تُحرَّر عبر حالة `images` أعلاه.
  const variantId = useRef<number | null>(null);
  const baseline = useRef<string | null>(null); // لقطة توقيع النموذج بعد التعبئة (لكشف التعديلات غير المحفوظة)
  const [currentStock, setCurrentStock] = useState<Record<number, number>>({});

  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const branches = useMemo(() => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })), [branchesQ.data]);

  // ── تعبئة من الـAPI مرّة واحدة ──
  useEffect(() => {
    if (!product.data || hydrated) return;
    const d = product.data;
    const v = d.variants[0];
    setName(d.name);
    setProductType(d.productType ?? "");
    setBrand(d.brand ?? "");
    setModelName(d.modelName ?? "");
    setDescription(d.description ?? "");
    setCategoryId(d.categoryId ?? "");
    setIsCustomizable(d.isCustomizable);
    setIsActive(d.isActive);
    if (v) {
      variantId.current = v.id;
      setSku(v.sku);
      setCostPrice(v.costPrice);
      setMinStock(String(v.minStock ?? 0));
      setReorderPoint(String(v.reorderPoint ?? 0));
      setCurrentStock(v.stockByBranch ?? {});
    }
    const tmpl: EditUnit[] = d.unitTemplate.map((u, i) => ({
      id: i + 1,
      name: u.unitName,
      factor: u.conversionFactor,
      isBase: u.isBaseUnit,
      sellInStore: u.isStoreSaleUnit,
      barcode: v?.unitBarcodes[u.unitName] ?? "",
      retail: u.retail,
      wholesale: u.wholesale,
      government: u.government,
    }));
    unitSeq.current = tmpl.length + 1;
    setUnits(tmpl.length ? tmpl : [{ id: 1, name: "قطعة", factor: "1", isBase: true, sellInStore: true, barcode: "", retail: "", wholesale: "", government: "" }]);
    setImages(hydrateProductImages(d.images));
    setConsignment({ isConsignment: !!d.isConsignment, consignorId: d.consignorId ? Number(d.consignorId) : null, consignorName: d.consignorName });
    setHydrated(true);
  }, [product.data, hydrated]);

  const composedName = useMemo(
    () => [productType, brand, modelName].map((s) => s.trim()).filter(Boolean).join(" "),
    [productType, brand, modelName]
  );
  const finalName = name.trim() || composedName;

  // توقيع خفيف للصور (لا نُدرِج data URLs الضخمة): المعرّف + الرئيسية + طول البايتات (يكشف الاستبدال).
  const imagesSig = useMemo(
    () => images.map((i) => `${i.id}:${i.isPrimary ? 1 : 0}:${i.dataUrl.length}`).join("|"),
    [images]
  );
  // ── كشف «تعديلات غير محفوظة»: نقارن توقيع النموذج بلقطة الأساس المُلتقَطة بعد التعبئة ──
  const formSig = useMemo(
    () => JSON.stringify({ name, productType, brand, modelName, description, categoryId, sku, costPrice, minStock, reorderPoint, isCustomizable, isActive, units, imagesSig }),
    [name, productType, brand, modelName, description, categoryId, sku, costPrice, minStock, reorderPoint, isCustomizable, isActive, units, imagesSig]
  );
  useEffect(() => {
    if (hydrated && baseline.current === null) baseline.current = formSig;
  }, [hydrated, formSig]);
  const dirty = hydrated && baseline.current !== null && formSig !== baseline.current;
  // الانتقال للتحرير المتقدّم يعيد التحميل من الخادم ⇒ نؤكّد قبل تجاهل تعديلات غير محفوظة.
  const goAdvanced = () => {
    if (dirty && !window.confirm("لديك تعديلات غير محفوظة ستُتجاهَل عند الانتقال للتحرير المتقدّم. هل تريد المتابعة؟")) return;
    onAdvanced();
  };

  // ── فحص تكرار الباركود ضدّ القاعدة (live) — نستثني باركودات هذا المنتج نفسه ──
  const allCodes = useMemo(() => {
    const set = new Set<string>();
    for (const u of units) { const c = u.barcode.trim(); if (c) set.add(c); }
    return Array.from(set);
  }, [units]);
  const debouncedKey = useDebouncedValue(allCodes.join("\n"), 450);
  const debouncedCodes = useMemo(() => (debouncedKey ? debouncedKey.split("\n") : []), [debouncedKey]);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: debouncedCodes },
    { enabled: debouncedCodes.length > 0, staleTime: 10_000 }
  );
  const ownCodes = useMemo(() => new Set(allCodes), [allCodes]);
  const takenInDb = useMemo(
    () => new Set((checkQ.data ?? []).map((r) => r.code).filter((c) => !ownCodes.has(c))),
    [checkQ.data, ownCodes]
  );

  const update = trpc.catalog.updateProductVariants.useMutation({
    onSuccess: async () => {
      setError("");
      setDone("تم حفظ التعديلات بنجاح.");
      await Promise.all([
        utils.catalog.getForVariantEdit.invalidate({ productId }),
        utils.catalog.posList.invalidate(),
        utils.catalog.adminList.invalidate(),
        utils.catalog.forPurchase.invalidate(),
      ]);
      baseline.current = null; // أعِد التقاط لقطة الأساس بعد إعادة التعبئة (نظافة كشف التعديلات)
      setHydrated(false); // أعد التحميل ليعكس الحالة المحفوظة
    },
    onError: (e) => {
      setDone("");
      setError(e.message);
      if (/SKU|الرمز/.test(e.message)) document.getElementById("simpleedit-sku")?.focus();
    },
  });

  /* ── الوحدات ── */
  const addUnit = () =>
    setUnits((u) => [...u, { id: unitSeq.current++, name: "", factor: "", isBase: false, sellInStore: false, barcode: "", retail: "", wholesale: "", government: "" }]);
  const patchUnit = (id: number, patch: Partial<EditUnit>) =>
    setUnits((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeUnit = (id: number) => setUnits((u) => (u.length <= 1 ? u : u.filter((x) => x.id !== id)));
  const setBaseUnit = (id: number) => setUnits((u) => u.map((x) => ({ ...x, isBase: x.id === id })));

  function validate(): string | null {
    if (!finalName) return "اسم المنتج مطلوب.";
    if (!sku.trim()) return "رمز المنتج (SKU) مطلوب.";
    if (!costPrice.trim()) return "سعر التكلفة مطلوب.";
    if (units.some((u) => !u.name.trim())) return "كل وحدة تحتاج اسماً.";
    if (units.filter((u) => u.isBase).length !== 1) return "حدّد وحدة أساس واحدة فقط.";
    if (units.some((u) => !u.isBase && !(Number(u.factor.trim()) > 1)))
      return "معامل التحويل يجب أن يكون أكبر من ١ للوحدة غير الأساس.";
    const unitNames = units.map((u) => u.name.trim().toLowerCase());
    if (new Set(unitNames).size !== unitNames.length) return "اسم وحدة مكرّر — لكل وحدة اسم فريد.";
    const codes = units.map((u) => u.barcode.trim()).filter(Boolean);
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) return `باركود مكرّر داخل النموذج: ${dup} — لكل وحدة باركود فريد.`;
    if (consignment.isConsignment && !consignment.consignorId) return "صنف الأمانة يلزمه مودِع — اختر المودِع.";
    // حرّاس عقلانية الأسعار — يمنع «حادثة SINARLINE ٣٠/٧». المصدر: shared/priceSanity.ts.
    const unitPricings = units.map((u) => ({
      unitName: u.name.trim() || (u.isBase ? "الأساس" : "وحدة"),
      conversionFactor: u.isBase ? 1 : Number((u.factor ?? "").trim()) || 1,
      retail: u.retail || null,
      wholesale: u.wholesale || null,
      government: u.government || null,
    }));
    const issues = checkVariantSanity(costPrice, unitPricings);
    const blocker = issues.find((i) => i.level === "blocker");
    if (blocker) return blocker.message;
    return null;
  }

  async function save() {
    setError("");
    setDone("");
    const err = validate();
    if (err) {
      setError(err);
      if (!finalName) document.getElementById("simpleedit-name")?.focus();
      else if (!costPrice.trim()) document.getElementById("simpleedit-cost")?.focus();
      return;
    }
    // فحص أخير حاسم للباركود ضدّ القاعدة (نستثني ما يخصّ هذا المنتج).
    const codes = Array.from(new Set(units.map((u) => u.barcode.trim()).filter(Boolean)));
    if (codes.length) {
      try {
        const taken = (await utils.catalog.checkBarcodes.fetch({ codes })).filter((t) => !ownCodes.has(t.code));
        if (taken.length) {
          setError(`الباركود ${taken[0].code} مُستخدَم في «${taken[0].takenBy}». غيّره قبل الحفظ.`);
          return;
        }
      } catch {
        // القيد UNIQUE في القاعدة هو الحارس الأخير.
      }
    }
    const unitTemplate = units.map((u) => ({
      unitName: u.name.trim(),
      conversionFactor: u.isBase ? "1" : u.factor.trim() || "1",
      isBaseUnit: u.isBase,
      isStoreSaleUnit: u.sellInStore,
      prices: [
        ...(u.retail.trim() ? [{ priceTier: "RETAIL" as const, price: u.retail.trim() }] : []),
        ...(u.wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: u.wholesale.trim() }] : []),
        // GOVERNMENT يجب إعادة إرساله دائماً: upsert يمسح كل أسعار الوحدة ثم يُدرِج المُرسَل فقط،
        // فإغفاله يمحو سعر الحكومي الموجود (تصحيح مراجعة عدائية — فقد بيانات صامت).
        ...(u.government.trim() ? [{ priceTier: "GOVERNMENT" as const, price: u.government.trim() }] : []),
      ],
    }));
    const unitBarcodes: Record<string, string> = {};
    for (const u of units) { const b = u.barcode.trim(); if (b) unitBarcodes[u.name.trim()] = b; }
    update.mutate({
      productId,
      name: finalName || null,
      productType: productType.trim() || null,
      brand: brand.trim() || null,
      modelName: modelName.trim() || null,
      description: description.trim() || null,
      categoryId: categoryId === "" ? null : Number(categoryId),
      isConsignment: consignment.isConsignment,
      consignorId: consignment.consignorId,
      isCustomizable,
      isActive,
      unitTemplate,
      variants: [
        {
          id: variantId.current ?? undefined,
          sku: sku.trim(),
          color: null,
          size: null,
          costPrice: costPrice.trim(),
          minStock: clampInt(minStock),
          reorderPoint: clampInt(reorderPoint),
          isActive,
          // صورة اللون (variant.image) لا تُحرَّر هنا: نتركها دون مساس (image=undefined ⇒ الخادم لا يمسّها).
          unitBarcodes,
        },
      ],
      // صور المنتج العامّة: تُرسَل دائماً (ولو فارغة) ⇒ الحذف يُوفَّق؛ غير المتغيّرة بمعرّفها بلا بايتات.
      images: buildProductImagesPayload(images),
    });
  }

  if (product.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!product.data) return <div className="p-10 text-center text-muted-foreground">المنتج غير موجود.</div>;

  const totalStock = Object.values(currentStock).reduce((s, q) => s + (q || 0), 0);
  const unitCost = parseFloat(costPrice) || 0;
  const baseUnitName = units.find((u) => u.isBase)?.name.trim() || "قطعة";

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-28">
      <PageHeader
        title="تعديل سلعة بسيطة"
        description="المنتجات / تعديل المنتج"
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={goAdvanced} title="فتح محرّر المتغيّرات لإضافة ألوان/قياسات/صور">
              <Layers aria-hidden className="size-4 me-1" /> التحرير المتقدّم (متغيّرات)
            </Button>
            <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground">← رجوع للمنتجات</Link>
          </div>
        }
      />

      {!product.data?.isService && !product.data?.isBundle && (
        <ConsignmentField
          value={consignment}
          onChange={setConsignment}
          disabled={totalStock !== 0}
          disabledHint="لا يمكن تغيير وسم الأمانة والرصيد غير صفري — صفِّر المخزون أولاً."
        />
      )}

      {/* ── بيانات المنتج ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">بيانات المنتج</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="اسم المنتج" required hint="يظهر في البيع والفواتير والتقارير." className="md:col-span-3">
            <div className="flex items-center gap-2">
              <Input id="simpleedit-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم المنتج الكامل" dir="auto" />
              {composedName && composedName !== name.trim() && (
                <Button type="button" variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => setName(composedName)} title="تركيب الاسم من النوع/الماركة/الموديل">
                  ↻ تركيب من الحقول
                </Button>
              )}
            </div>
            {/* السلعة البسيطة بلا متغيّرات ⇒ اللون في الاسم مشروع — لا warnColors هنا. */}
            <NameAssistant name={finalName} onApply={setName} excludeProductId={productId} />
          </Field>
          <Field label="النوع (اختياري)"><Input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="كتاب مدرسي" dir="auto" /></Field>
          <Field label="الماركة/الناشر (اختياري)"><Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="دار المعارف" dir="auto" /></Field>
          <Field label="الموديل/الطبعة (اختياري)"><Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="ط. ٢٠٢٦" dir="auto" /></Field>
          <Field label="الفئة / التصنيف">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            >
              <option value="">— بلا فئة —</option>
              <CategoryOptionList categories={categoriesQ.data ?? []} />
            </select>
          </Field>
          <Field label="رمز المنتج (SKU)" required className="md:col-span-2">
            <Input id="simpleedit-sku" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} dir="ltr" placeholder="PR-BOOK-ARB" />
          </Field>
        </CardContent>
      </Card>

      {/* ── الوحدات والباركود ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">الوحدات والباركود والأسعار</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">لكل وحدة باركودها المستقل وسعرها. المنتج البسيط عادةً بوحدة واحدة (قطعة).</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addUnit}>+ وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {units.map((u) => {
            const factor = u.isBase ? 1 : parseFloat(u.factor) || 1;
            const uCost = unitCost * factor;
            const code = u.barcode.trim();
            const info = barcodeInfo(code, {
              countInForm: units.filter((x) => x.barcode.trim() === code).length,
              takenInDb: takenInDb.has(code),
            });
            const bcCls =
              info.severity === "blocker" ? "border-amber-500 ring-1 ring-amber-500"
              : info.severity === "warn"    ? "border-amber-500"
              : info.severity === "ok"      ? "border-emerald-500/60"
              : info.severity === "info"    ? "border-blue-500/40"
              : "";
            const bcTitle = info.message;
            const bcHelpColor =
              info.severity === "blocker" ? "text-red-600 dark:text-red-400"
              : info.severity === "warn"    ? "text-amber-600 dark:text-amber-400"
              : info.severity === "ok"      ? "text-emerald-600 dark:text-emerald-400"
              : "text-blue-600 dark:text-blue-400";
            const symBadgeVariant =
              info.severity === "blocker" ? "destructive"
              : info.severity === "warn"    ? "outline"
              : info.severity === "ok"      ? "default"
              : "secondary";
            return (
              <div key={u.id} className="rounded-lg border bg-muted/20 p-3 space-y-2">
                {/* هوية الوحدة: الاسم + المعامل + وحدة الأساس + الحذف — شبكة محاذاة واحدة */}
                <div className="grid grid-cols-12 gap-2 items-center">
                  <Input
                    className="col-span-12 sm:col-span-4 h-8 text-sm"
                    value={u.name}
                    onChange={(e) => patchUnit(u.id, { name: e.target.value })}
                    placeholder="اسم الوحدة (قطعة / درزن / كرتون)"
                    dir="auto"
                    aria-label="اسم الوحدة"
                  />
                  <div className="col-span-5 sm:col-span-3 flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">معامل ×</span>
                    <NumberInput
                      className="h-8 text-sm text-center"
                      disabled={u.isBase}
                      value={u.isBase ? "1" : u.factor}
                      onChange={(val) => patchUnit(u.id, { factor: val })}
                      placeholder="12"
                      decimals={4}
                      ariaLabel="معامل التحويل"
                    />
                  </div>
                  <label className="col-span-3 sm:col-span-2 flex items-center gap-1.5 text-xs cursor-pointer whitespace-nowrap">
                    <input type="radio" name="simpleEditBaseUnit" checked={u.isBase} onChange={() => setBaseUnit(u.id)} aria-label="الوحدة الأساس" />
                    وحدة أساس
                  </label>
                  <label className="col-span-4 sm:col-span-2 flex items-center gap-1.5 text-xs cursor-pointer whitespace-nowrap">
                    <input type="checkbox" checked={u.sellInStore} onChange={(e) => patchUnit(u.id, { sellInStore: e.target.checked })} aria-label="بيع في المتجر" />
                    بيع بالمتجر
                  </label>
                  <div className="col-span-2 sm:col-span-1 flex justify-end">
                    <button
                      type="button"
                      onClick={() => removeUnit(u.id)}
                      disabled={units.length <= 1}
                      className="inline-flex h-8 items-center text-muted-foreground hover:text-destructive disabled:opacity-30"
                      aria-label="حذف الوحدة"
                      title="حذف الوحدة"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </div>
                </div>

                {/* الباركود (بعرض معقول) + مسح + بدائل، والأسعار — في شبكة واحدة محاذاة */}
                <div className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-12 sm:col-span-6 flex items-center gap-1.5">
                    <Input
                      className={cn("h-8 font-mono text-xs flex-1 min-w-0", bcCls)}
                      dir="ltr"
                      inputMode="numeric"
                      value={u.barcode}
                      onChange={(e) => patchUnit(u.id, { barcode: e.target.value })}
                      placeholder="باركود الوحدة (اختياري)…"
                      title={bcTitle}
                      aria-label="باركود الوحدة"
                      aria-invalid={info.severity === "blocker"}
                      aria-describedby={bcTitle ? `simpleedit-bc-help-${u.id}` : undefined}
                    />
                    <ScanButton onClick={() => patchUnit(u.id, { barcode: genEan13("200") })} title="توليد باركود EAN-13 داخليّ (نطاق GS1 المخصَّص للاستخدام الداخلي)" />
                    {info.symbology.label && (
                      <Badge variant={symBadgeVariant} className="text-[10px] whitespace-nowrap px-1.5 py-0" title={`نوع الترميز: ${info.symbology.label}`}>
                        {info.symbology.label}
                      </Badge>
                    )}
                    <UnitBarcodeAliases variantId={variantId.current} unitName={u.name} />
                    <UnitPriceHistory
                      variantId={variantId.current}
                      unitName={u.name}
                      variantLabel={finalName || sku}
                    />
                  </div>
                  <MoneyInput ariaLabel="سعر المفرد" className="col-span-4 sm:col-span-2 h-8 text-sm" value={u.retail} onChange={(v) => patchUnit(u.id, { retail: v })} placeholder="مفرد" />
                  <MoneyInput ariaLabel="سعر الجملة" className="col-span-4 sm:col-span-2 h-8 text-sm" value={u.wholesale} onChange={(v) => patchUnit(u.id, { wholesale: v })} placeholder="جملة" />
                  <MoneyInput ariaLabel="سعر الحكومي" className="col-span-4 sm:col-span-2 h-8 text-sm" value={u.government} onChange={(v) => patchUnit(u.id, { government: v })} placeholder="حكومي" />
                </div>

                {/* حالة الباركود مرئيّة + مربوطة بـaria-describedby لقارئ الشاشة */}
                {bcTitle && (
                  <p id={`simpleedit-bc-help-${u.id}`} className={cn("text-[11px] ps-0.5", bcHelpColor)}>
                    {bcTitle}
                  </p>
                )}

                {/* سطر تلميح خفيف: تسمية أعمدة السعر + هامش المفرد */}
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground ps-0.5">
                  <span className="hidden sm:block">الأسعار: مفرد · جملة · حكومي (د.ع)</span>
                  <span className="flex items-center gap-1.5">هامش المفرد: <MarginBadge cost={uCost} sell={u.retail} /></span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── التكلفة والضبط ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">التكلفة والضبط</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field
            label={product.data?.isConsignment ? "حصة المودِع (د.ع)" : "سعر التكلفة (د.ع)"}
            required
            hint={product.data?.isConsignment ? "المبلغ المستحقّ للمودِع عند البيع." : "سعر الشراء الموحّد."}
          >
            <MoneyInput id="simpleedit-cost" value={costPrice} onChange={setCostPrice} placeholder="150" />
            <SimpleEditCostCoach
              costPrice={costPrice}
              baseRetail={units.find((u) => u.isBase)?.retail ?? ""}
              categoryId={categoryId === "" ? null : Number(categoryId)}
              brand={brand}
              productType={productType}
              productId={productId}
              variantId={variantId.current}
              onUseLastPurchase={(cost) => setCostPrice(cost)}
            />
          </Field>
          <Field label="الحد الأدنى" hint="ينبّه عند النزول عنه.">
            <NumberInput value={minStock} onChange={setMinStock} className="text-center" ariaLabel="الحد الأدنى" />
          </Field>
          <Field label="نقطة إعادة الطلب" hint="يقترح الشراء عند بلوغها.">
            <NumberInput value={reorderPoint} onChange={setReorderPoint} className="text-center" ariaLabel="نقطة إعادة الطلب" />
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
          <Field label="الرصيد الحالي (قراءة فقط)" hint="يُدار عبر الجرد/الحركات.">
            <div className="h-9 flex items-center text-sm tabular-nums">
              <b dir="ltr">{toArabicDigits(totalStock)}</b>
              <span className="text-muted-foreground ms-1">{baseUnitName} (كل الفروع)</span>
            </div>
          </Field>
          {branches.length > 1 && (
            <div className="col-span-2 md:col-span-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground border-t pt-3">
              {branches.map((b) => (
                <span key={b.id}>{b.name}: <b className="text-foreground" dir="ltr">{toArabicDigits(currentStock[b.id] || 0)}</b></span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ProductMediaContentSection
        description={description}
        onDescriptionChange={setDescription}
        images={images}
        onImagesChange={setImages}
      />

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
      {done && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm badge-status-active">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          <span>{done}</span>
        </div>
      )}

      {/* ── شريط الحفظ الثابت ── */}
      <div className="fixed bottom-0 inset-x-0 lg:start-60 border-t bg-card/95 backdrop-blur px-6 py-3 flex items-center justify-between gap-3 z-30">
        <div className="text-xs text-muted-foreground hidden sm:block">تعديل سلعة بسيطة — المخزون يُدار عبر الجرد/الحركات.</div>
        <div className="flex gap-2">
          <Link href="/products"><Button type="button" variant="outline" size="sm">إلغاء</Button></Link>
          <Button type="button" size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}
          </Button>
        </div>
      </div>
    </div>
  );
}
