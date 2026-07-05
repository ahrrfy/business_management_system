import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { AlertCircle, Package, Wrench, X } from "lucide-react";
import ServiceForm from "@/components/product/ServiceForm";
import { trpc } from "@/lib/trpc";
import { exportRows } from "@/lib/export";
import {
  clampInt,
  deriveSku,
  genEan13,
  incEan13,
  isValidEan13,
  marginPercent,
  onlyDigits,
  toArabicDigits,
  variantStockTotal,
  type ClientUnit,
  type ClientVariant,
  type ParsedVariantRow,
} from "@/lib/variants";
import { ColorDot, Field, MarginBadge } from "@/components/product/variantBits";
import { BulkTools, MatrixGenerator } from "@/components/product/VariantMatrix";
import { VariantsTable } from "@/components/product/VariantsTable";
import { ImportModal, LabelPrintModal } from "@/components/product/variantModals";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

/**
 * إضافة منتج بمتغيّرات — كل لون/قياس منتجٌ مخزنيّ مستقل (product-variants).
 *
 * النموذج: منتج أب (اسم مركّب + تكلفة + قالب وحدات مشترك) → متغيّرات (لون/قياس) كلٌّ
 * بـSKU وباركود مستقل لكل وحدة ورصيد افتتاحي لكل فرع وظهور مستقل في البيع.
 * يستدعي `catalog.createProduct` (يقبل `variants[]` أصلاً) مع الحقول الموسَّعة
 * (reorderPoint/isActive/openingStockByBranch) ويتحقّق من الباركود عبر `catalog.checkBarcodes`.
 *
 * المسح: تركيز خلية باركود يجعل ماسح HID يكتب فيها مباشرةً (لا حاجة لربط خاص)؛
 * زر «المسح» بجانب كل خلية يولّد EAN-13 صالحاً لمن يطبع باركوده ذاتياً.
 */

export default function ProductNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();

  // ── الاسم المركّب + الرأس المشترك ──
  const [productName, setProductName] = useState("");
  const [productType, setProductType] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [baseSku, setBaseSku] = useState("");

  // ── التسعير والمخزون المشترك ──
  const [costPrice, setCostPrice] = useState("");
  const [defaultMin, setDefaultMin] = useState("0");
  const [isCustomizable, setIsCustomizable] = useState(false);
  const [isService, setIsService] = useState(false);
  const [isActive, setIsActive] = useState(true);

  // ── قالب الوحدات المشترك ──
  const unitSeq = useRef(2);
  const [units, setUnits] = useState<ClientUnit[]>([
    { id: 1, name: "قطعة", factor: "1", isBase: true, retail: "", wholesale: "" },
  ]);

  // ── المصفوفة + المتغيّرات ──
  const [colors, setColors] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [variants, setVariants] = useState<ClientVariant[]>([]);

  // ── الصور المشتركة على مستوى المنتج ──
  const [images, setImages] = useState<ImageItem[]>([]);

  // ── الفرع المختار (لعمود المخزون) ──
  const branches = useMemo(
    () => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })),
    [branchesQ.data]
  );
  const myBranch = me.data?.branchId ?? 1;
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = pickedBranch ?? branches[0]?.id ?? myBranch;

  const [error, setError] = useState("");

  // نوافذ الاستيراد/الطباعة.
  const [importOpen, setImportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);

  const composedName = useMemo(
    () => [productType, brand, modelName].map((s) => s.trim()).filter(Boolean).join(" "),
    [productType, brand, modelName]
  );
  const baseRetail = units.find((u) => u.isBase)?.retail.trim() ?? "";
  const primaryImage = images.find((i) => i.isPrimary) ?? images[0];

  const includedCount = colors.length
    ? sizes.length
      ? colors.flatMap((c) => sizes.map((s) => `${c}|${s}`)).filter((k) => !excluded.has(k)).length
      : colors.length
    : 0;

  // ── فحص تكرار الباركود ضدّ القاعدة (live، debounced) ──
  const allCodes = useMemo(() => {
    const set = new Set<string>();
    for (const v of variants) for (const u of units) {
      const c = (v.unitBarcodes[u.id] || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set);
  }, [variants, units]);
  // مفتاح نصّيّ مستقرّ: لا يتغيّر إلا بتغيّر الباركودات نفسها (لا عند تعديل المخزون/الحدّ)،
  // ويستفيد من مسار «الفارغ فوراً» في useDebouncedValue (مسح كل الباركودات يُلغي الفحص حالاً).
  const debouncedKey = useDebouncedValue(allCodes.join("\n"), 450);
  const debouncedCodes = useMemo(() => (debouncedKey ? debouncedKey.split("\n") : []), [debouncedKey]);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: debouncedCodes },
    { enabled: debouncedCodes.length > 0, staleTime: 10_000 }
  );
  const takenInDb = useMemo(() => new Set((checkQ.data ?? []).map((r) => r.code)), [checkQ.data]);

  const create = trpc.catalog.createProduct.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.adminList.invalidate()]);
      navigate("/products");
    },
    onError: (e) => setError(e.message),
  });

  /* ── الوحدات ── */
  const addUnit = () =>
    setUnits((u) => [...u, { id: unitSeq.current++, name: "", factor: "", isBase: false, retail: "", wholesale: "" }]);
  const patchUnit = (id: number, patch: Partial<ClientUnit>) =>
    setUnits((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeUnit = (id: number) => setUnits((u) => (u.length <= 1 ? u : u.filter((x) => x.id !== id)));
  const setBaseUnit = (id: number) => setUnits((u) => u.map((x) => ({ ...x, isBase: x.id === id })));

  /* ── المصفوفة + المتغيّرات ── */
  const toggleExclude = (key: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  function makeVariant(color: string, size: string): ClientVariant {
    return {
      id: `${color}|${size}|${Math.random().toString(36).slice(2, 8)}`,
      color,
      size,
      sku: deriveSku(baseSku, color, size),
      unitBarcodes: {},
      stockByBranch: {},
      minStock: defaultMin || "0",
      reorderPoint: "0",
      priceOverride: false,
      costPrice: "",
      retail: "",
      isActive: true,
      image: null,
    };
  }

  function generate() {
    const combos: Array<[string, string]> = [];
    for (const c of colors) {
      if (sizes.length) {
        for (const s of sizes) if (!excluded.has(`${c}|${s}`)) combos.push([c, s]);
      } else combos.push([c, ""]);
    }
    setVariants((prev) => {
      const byKey = new Map(prev.map((v) => [`${v.color}|${v.size}`, v]));
      // دمج غير متلف: نحفظ تعديلات الصفوف الموجودة عبر مفتاح color|size.
      return combos.map(([c, s]) => {
        const ex = byKey.get(`${c}|${s}`);
        return ex ? { ...ex, sku: ex.sku || deriveSku(baseSku, c, s) } : makeVariant(c, s);
      });
    });
  }

  function applyImport(rows: ParsedVariantRow[]) {
    setVariants((prev) => {
      const out = [...prev];
      const idxByKey = new Map(out.map((v, i) => [`${v.color}|${v.size}`, i]));
      for (const r of rows) {
        const key = `${r.color}|${r.size}`;
        const base = makeVariant(r.color, r.size);
        if (r.sku) base.sku = r.sku;
        r.barcodes.forEach((b, i) => {
          const u = units[i];
          if (u && b) base.unitBarcodes[u.id] = b;
        });
        base.stockByBranch = { [branchId]: r.stock || "0" };
        const existingIdx = idxByKey.get(key);
        if (existingIdx != null) {
          // دمج غير متلف: نحفظ معرّف الصفّ الموجود ونحدّث قيمه.
          out[existingIdx] = { ...out[existingIdx], ...base, id: out[existingIdx].id };
        } else {
          idxByKey.set(key, out.length);
          out.push(base);
        }
      }
      return out;
    });
  }

  const patchVariant = (id: string, patch: Partial<ClientVariant>) =>
    setVariants((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const removeVariant = (id: string) => setVariants((vs) => vs.filter((v) => v.id !== id));
  const onScan = (vid: string, uid: number) =>
    setVariants((vs) => vs.map((v) => (v.id === vid ? { ...v, unitBarcodes: { ...v.unitBarcodes, [uid]: genEan13("621") } } : v)));

  /* ── أدوات الجملة ── */
  const bulkMin = (val: string) => setVariants((vs) => vs.map((v) => ({ ...v, minStock: val })));
  const bulkStock = (val: string) =>
    setVariants((vs) => vs.map((v) => ({ ...v, stockByBranch: { ...v.stockByBranch, [branchId]: val } })));
  const bulkSeq = (uid: number, start: string) => {
    let code = isValidEan13(start) ? start : genEan13("621");
    setVariants((vs) =>
      vs.map((v) => {
        if (v.unitBarcodes[uid]) return v;
        const next = { ...v, unitBarcodes: { ...v.unitBarcodes, [uid]: code } };
        code = incEan13(code);
        return next;
      })
    );
  };

  /* ── التحقّق المحليّ قبل الحفظ ── */
  function validateLocal(): string | null {
    if (!productName.trim() && !composedName) return "اسم المنتج مطلوب (اكتبه مباشرةً أو املأ النوع/الماركة/الموديل).";
    if (!costPrice.trim()) return "سعر التكلفة المشترك مطلوب.";
    if (units.some((u) => !u.name.trim())) return "كل وحدة في القالب تحتاج اسماً.";
    if (units.filter((u) => u.isBase).length !== 1) return "حدّد وحدة أساس واحدة فقط في قالب الوحدات.";
    if (!variants.length) return "أضف متغيّراً واحداً على الأقل (اكتب لوناً ثم «ولّد المتغيّرات»).";
    if (variants.some((v) => !v.sku.trim())) return "كل متغيّر يحتاج SKU.";
    const skus = variants.map((v) => v.sku.trim());
    const dupSku = skus.find((s, i) => s && skus.indexOf(s) !== i);
    if (dupSku) return `SKU مكرّر بين المتغيّرات: ${dupSku} — لكل متغيّر رمز فريد.`;
    const codes: string[] = [];
    for (const v of variants) for (const u of units) {
      const c = (v.unitBarcodes[u.id] || "").trim();
      if (c) codes.push(c);
    }
    const dupBc = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dupBc) return `باركود مكرّر داخل النموذج: ${dupBc} — لكل وحدة/لون باركود فريد.`;
    return null;
  }

  function buildPayload() {
    return {
      // الاسم الصريح هو المرجع؛ التركيب من الأجزاء بديل عند فراغه (يطابق composeProductName في الخادم).
      name: productName.trim() || composedName || undefined,
      productType: productType.trim() || null,
      brand: brand.trim() || null,
      modelName: modelName.trim() || null,
      description: description.trim() || null,
      categoryId: categoryId === "" ? undefined : Number(categoryId),
      isCustomizable,
      isService,
      variants: variants.map((v) => {
        const overrideCost = v.priceOverride && v.costPrice.trim() ? v.costPrice.trim() : costPrice.trim();
        return {
          sku: v.sku.trim(),
          color: v.color.trim() || undefined,
          size: v.size.trim() || undefined,
          costPrice: overrideCost,
          minStock: clampInt(v.minStock),
          reorderPoint: clampInt(v.reorderPoint),
          isActive: v.isActive,
          image: v.image || undefined,
          openingStockByBranch: branches
            .map((b) => ({ branchId: b.id, qty: clampInt(v.stockByBranch[b.id] || "0") }))
            .filter((x) => x.qty > 0),
          units: units.map((u) => {
            const retail = u.isBase && v.priceOverride && v.retail.trim() ? v.retail.trim() : u.retail.trim();
            const wholesale = u.wholesale.trim();
            return {
              unitName: u.name.trim(),
              conversionFactor: u.isBase ? "1" : u.factor.trim() || "1",
              barcode: (v.unitBarcodes[u.id] || "").trim() || undefined,
              isBaseUnit: u.isBase,
              prices: [
                ...(retail ? [{ priceTier: "RETAIL" as const, price: retail }] : []),
                ...(wholesale ? [{ priceTier: "WHOLESALE" as const, price: wholesale }] : []),
              ],
            };
          }),
        };
      }),
      images: images.length
        ? images.map((i, idx) => ({ url: i.dataUrl, isPrimary: !!i.isPrimary, sortOrder: idx }))
        : undefined,
    };
  }

  async function save() {
    setError("");
    const err = validateLocal();
    if (err) {
      setError(err);
      // انقل التركيز لأوّل حقل خاطئ شائع (اسم/تكلفة) — WCAG focus-management.
      if (!productName.trim() && !composedName) document.getElementById("product-name")?.focus();
      else if (!costPrice.trim()) document.getElementById("product-cost")?.focus();
      return;
    }
    // فحص أخير حاسم للباركود ضدّ القاعدة (لا نعتمد على توقيت الـdebounce).
    const codes = Array.from(
      new Set(variants.flatMap((v) => units.map((u) => (v.unitBarcodes[u.id] || "").trim())).filter(Boolean))
    );
    if (codes.length) {
      try {
        const taken = await utils.catalog.checkBarcodes.fetch({ codes });
        if (taken.length) {
          setError(`الباركود ${taken[0].code} مُستخدَم في «${taken[0].takenBy}». غيّره قبل الحفظ.`);
          return;
        }
      } catch {
        // فشل الفحص المسبق لا يمنع الحفظ — قيد UNIQUE في القاعدة يبقى الحارس الأخير.
      }
    }
    create.mutate(buildPayload());
  }

  /* ── تصدير Excel: صف لكل متغيّر، عمود باركود لكل وحدة (كل لون كأنه منتج مستقل) ── */
  function exportExcel() {
    exportRows(variants, {
      filename: `منتج-${productName.trim() || composedName || "بمتغيرات"}`,
      sheetName: "المنتجات",
      columns: [
        { key: "name", header: "الاسم الكامل", map: (v) => [productName.trim() || composedName, v.color, v.size].filter(Boolean).join(" ") },
        { key: "color", header: "اللون", map: (v) => v.color },
        { key: "size", header: "القياس", map: (v) => v.size },
        { key: "sku", header: "SKU", map: (v) => v.sku },
        ...units.map((u) => ({
          key: `bc_${u.id}`,
          header: `باركود ${u.name || "وحدة"}`,
          map: (v: ClientVariant) => v.unitBarcodes[u.id] || "",
        })),
        { key: "stock", header: "المخزون (كل الفروع)", map: (v) => variantStockTotal(v.stockByBranch) },
        { key: "price", header: "سعر البيع", map: (v) => (v.priceOverride && v.retail.trim() ? v.retail.trim() : baseRetail) },
        { key: "active", header: "الحالة", map: (v) => (v.isActive ? "مفعّل" : "معطّل") },
      ],
    });
  }

  const activeCount = variants.filter((v) => v.isActive).length;
  const totalStock = variants.reduce((s, v) => s + variantStockTotal(v.stockByBranch), 0);

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-28">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            المنتجات / <span className="text-foreground">إضافة منتج</span>
          </div>
          <h1 className="text-2xl font-bold leading-tight">إضافة منتج بمتغيّرات</h1>
        </div>
        <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground">← رجوع للمنتجات</Link>
      </div>

      {/* ── نوع البَند: سلعة مخزنية أو خِدمة (print-catalog) ── */}
      <div className="inline-flex rounded-lg border bg-muted/40 p-1 gap-1">
        {[
          { v: false, label: "سلعة مخزنية", Icon: Package, hint: "بضاعة لها مخزون وباركود" },
          { v: true, label: "خِدمة", Icon: Wrench, hint: "بلا مخزون — تصوير/تجليد/تصميم" },
        ].map((t) => (
          <button
            key={String(t.v)}
            type="button"
            onClick={() => setIsService(t.v)}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              isService === t.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            title={t.hint}
            aria-pressed={isService === t.v}
          >
            <t.Icon aria-hidden className="size-4" />
            {t.label}
          </button>
        ))}
      </div>

      {isService ? (
        <ServiceForm />
      ) : (
      <>
      {/* ── اسم مركّب + معاينة الكاتالوج ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">اسم المنتج وبياناته</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field
              label="اسم المنتج"
              required
              hint="يظهر في البيع والفواتير والتقارير. اكتبه مباشرةً أو ركّبه من النوع/الماركة/الموديل."
              className="md:col-span-3"
            >
              <div className="flex items-center gap-2">
                <Input id="product-name" value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="اسم المنتج الكامل" dir="auto" />
                {composedName && composedName !== productName.trim() && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setProductName(composedName)}
                    title="تركيب الاسم من النوع/الماركة/الموديل"
                  >
                    ↻ تركيب من الحقول
                  </Button>
                )}
              </div>
            </Field>
            <Field label="النوع (اختياري)" hint="حقول وصفية للبحث/التصنيف — لا تغيّر الاسم تلقائياً.">
              <Input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="قلم جاف" />
            </Field>
            <Field label="الماركة (اختياري)">
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Pilot" dir="auto" />
            </Field>
            <Field label="الموديل (اختياري)">
              <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="G-2" dir="auto" />
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
            <Field label="رمز المنتج (SKU الأساس)" hint="تُشتقّ منه أكواد المتغيّرات تلقائياً." className="md:col-span-2">
              <Input value={baseSku} onChange={(e) => setBaseSku(e.target.value.toUpperCase())} dir="ltr" placeholder="PG-G2" />
            </Field>
            <Field label="الوصف" className="md:col-span-3">
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="خصائص/ملاحظات…" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">معاينة الكاتالوج</CardTitle></CardHeader>
          <CardContent>
            <div className="rounded-lg border bg-muted/30 overflow-hidden">
              <div className="aspect-[4/3] bg-card flex items-center justify-center text-muted-foreground text-xs">
                {primaryImage ? (
                  <img src={primaryImage.dataUrl || primaryImage.url} alt={productName.trim() || composedName} className="w-full h-full object-cover" />
                ) : (
                  <span className="font-mono text-[11px]">— لا صورة —</span>
                )}
              </div>
              <div className="p-3 space-y-2">
                <div className="text-sm font-semibold">
                  {productName.trim() || composedName || <span className="text-muted-foreground">— اسم المنتج —</span>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {baseSku && <Badge variant="outline" dir="ltr">{baseSku}</Badge>}
                </div>
                {variants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t">
                    <span className="text-[11px] text-muted-foreground">{toArabicDigits(variants.length)} متغيّر:</span>
                    {variants.slice(0, 10).map((v) => <ColorDot key={v.id} name={v.color} />)}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── التسعير والمخزون المشترك ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">التسعير والمخزون · مشترك</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="سعر التكلفة (د.ع)" required hint="سعر شراء موحّد لكل الألوان.">
            <MoneyInput id="product-cost" value={costPrice} onChange={setCostPrice} placeholder="150" />
          </Field>
          <Field label="الحد الأدنى الافتراضي" hint="يُطبَّق على المتغيّرات الجديدة.">
            <Input value={defaultMin} onChange={(e) => setDefaultMin(onlyDigits(e.target.value))} dir="ltr" inputMode="numeric" />
          </Field>
          <Field label="قابل للتخصيص">
            <div className="flex items-center gap-2 h-9">
              <Switch checked={isCustomizable} onCheckedChange={setIsCustomizable} />
              <span className="text-xs text-muted-foreground">{isCustomizable ? "يدخل كمادة" : "جاهز للبيع"}</span>
            </div>
          </Field>
          <Field label="الحالة (المنتج كاملاً)">
            <div className="flex items-center gap-2 h-9">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <span className="text-xs text-muted-foreground">{isActive ? "مفعّل" : "مخفي"}</span>
            </div>
          </Field>
        </CardContent>
      </Card>

      {/* ── قالب الوحدات والأسعار المشترك ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">قالب الوحدات والأسعار · مشترك</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              يُطبَّق على كل المتغيّرات. ولكل وحدة من كل لون <b>باركودها المستقل</b> (يُدخَل في جدول المتغيّرات).
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addUnit}>+ وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="hidden md:grid grid-cols-12 gap-2 px-1 text-[11px] font-semibold text-muted-foreground">
            <span className="col-span-3">الوحدة</span>
            <span className="col-span-2">معامل التحويل</span>
            <span className="col-span-2">سعر المفرد</span>
            <span className="col-span-2">سعر الجملة</span>
            <span className="col-span-2">الهامش</span>
            <span className="col-span-1 text-center">أساس</span>
          </div>
          {units.map((u) => {
            const factor = u.isBase ? 1 : parseFloat(u.factor) || 1;
            const unitCost = (parseFloat(costPrice) || 0) * factor;
            return (
              <div key={u.id} className="grid grid-cols-2 md:grid-cols-12 gap-2 items-center border-t pt-2 md:border-0 md:pt-0">
                <Input className="md:col-span-3 h-8 text-sm" value={u.name} onChange={(e) => patchUnit(u.id, { name: e.target.value })} placeholder="قطعة / درزن / كرتون" />
                <Input className="md:col-span-2 h-8 text-sm" dir="ltr" disabled={u.isBase} value={u.isBase ? "1" : u.factor} onChange={(e) => patchUnit(u.id, { factor: e.target.value })} placeholder="12" />
                <MoneyInput className="md:col-span-2 h-8 text-sm" value={u.retail} onChange={(v) => patchUnit(u.id, { retail: v })} placeholder="مفرد" />
                <MoneyInput className="md:col-span-2 h-8 text-sm" value={u.wholesale} onChange={(v) => patchUnit(u.id, { wholesale: v })} placeholder="جملة" />
                <div className="md:col-span-2"><MarginBadge cost={unitCost} sell={u.retail} /></div>
                <div className="md:col-span-1 flex items-center justify-center gap-2">
                  <input type="radio" name="baseUnit" checked={u.isBase} onChange={() => setBaseUnit(u.id)} title="الوحدة الأساس" aria-label="الوحدة الأساس" />
                  <button type="button" onClick={() => removeUnit(u.id)} disabled={units.length <= 1} className="text-muted-foreground hover:text-destructive disabled:opacity-30" aria-label="حذف الوحدة"><X aria-hidden className="size-4" /></button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── المتغيّرات ── */}
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              المتغيّرات (الألوان والقياسات)
              <Badge variant="secondary" className="bg-primary/10 text-primary">{toArabicDigits(variants.length)}</Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              كل صفّ منتج مخزنيّ مستقل: SKU ورصيد لكل فرع وظهور منفصل في البيع — <b>وباركود مستقل لكل وحدة</b>.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              الفرع:
              <select
                value={branchId}
                onChange={(e) => setPickedBranch(Number(e.target.value))}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>استيراد / لصق</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrintOpen(true)} disabled={!variants.length}>طباعة الملصقات</Button>
            <Button type="button" variant="outline" size="sm" onClick={exportExcel} disabled={!variants.length}>تصدير Excel</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <MatrixGenerator
            colors={colors}
            setColors={setColors}
            sizes={sizes}
            setSizes={setSizes}
            excluded={excluded}
            toggleExclude={toggleExclude}
            onGenerate={generate}
            includedCount={includedCount}
            existingCount={variants.length}
          />
          {variants.length > 0 && (
            <BulkTools
              units={units}
              branchName={branches.find((b) => b.id === branchId)?.name ?? "الفرع"}
              onMinAll={bulkMin}
              onStockAll={bulkStock}
              onSeq={bulkSeq}
            />
          )}
          <VariantsTable
            variants={variants}
            units={units}
            branches={branches}
            branchId={branchId}
            costPrice={costPrice}
            baseName={composedName}
            takenInDb={takenInDb}
            patchVariant={patchVariant}
            removeVariant={removeVariant}
            onScan={onScan}
          />
          {variants.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground px-1">
              <span>الإجمالي: <b className="text-foreground">{toArabicDigits(variants.length)}</b> منتج ({toArabicDigits(activeCount)} مفعّل)</span>
              <span>مخزون كلّي (كل الفروع): <b className="text-foreground">{toArabicDigits(totalStock)}</b> قطعة</span>
              <span>سعر البيع الأساس: <b className="text-foreground" dir="ltr">{baseRetail || "—"}</b> د.ع</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── الصور المشتركة على مستوى المنتج ── */}
      <Card>
        <CardHeader><CardTitle className="text-base">صور المنتج (مشتركة)</CardTitle></CardHeader>
        <CardContent>
          <ImageUploader
            value={images}
            onChange={setImages}
            maxItems={10}
            hint="حتى 10 صور للمنتج عامّةً (تُضغط تلقائياً قبل الحفظ) — الأولى رئيسيّة افتراضياً. ولكل لون صورته المستقلّة في صفّ المتغيّر بالأسفل."
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
          سيُحفظ <b className="text-foreground">{toArabicDigits(variants.length)}</b> منتج مخزنيّ مستقل تحت منتج واحد — كلٌّ بباركوداته ورصيده لكل فرع.
        </div>
        <div className="flex gap-2">
          <Link href="/products"><Button type="button" variant="outline" size="sm">إلغاء</Button></Link>
          <Button type="button" size="sm" onClick={save} disabled={create.isPending}>
            {create.isPending ? "جارٍ الحفظ…" : "حفظ المنتج والمتغيّرات"}
          </Button>
        </div>
      </div>

      <ImportModal open={importOpen} onOpenChange={setImportOpen} units={units} onImport={applyImport} />
      <LabelPrintModal
        open={printOpen}
        onOpenChange={setPrintOpen}
        variants={variants}
        units={units}
        baseName={composedName}
        baseRetail={baseRetail}
      />
      </>
      )}
    </div>
  );
}
