import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AlertCircle, Package, X } from "lucide-react";
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
import { barcodeState, clampInt, genEan13, onlyDigits, toArabicDigits } from "@/lib/variants";
import { UnitBarcodeAliases, type LocalAlias } from "@/components/product/UnitBarcodeAliases";
import { NameAssistant } from "@/components/product/NameAssistant";
import { cn } from "@/lib/utils";

/**
 * SimpleProductForm — إضافة «سلعة بسيطة» بلا ألوان/قياسات: منتجٌ واحد (متغيّر واحد) بعدّة وحدات.
 *
 * شريحة add-simple-product: كثير من أصناف المكتبة (كتاب، ملزمة، دفتر مفرد) بلا متغيّرات لون/قياس،
 * لكنها قد تُباع بوحدات متعددة (قطعة/درزن/كرتون) لكلٍّ باركودها وسعرها. فشاشة «المتغيّرات» تُثقِلها
 * بأعمدة لون/قياس بلا داعٍ. هذا النموذج يُرسِل إلى `catalog.createProduct` **متغيّراً واحداً** (بلا
 * لون/قياس) بقالب وحدات كامل — وهو ما يدعمه العقد الخادميّ أصلاً (units[] + productUnits.barcode).
 *
 * الوحدات: وحدة أساس واحدة (معامل ١) + وحدات أكبر بمعاملها (درزن ×١٢…). لكل وحدة باركودها المستقل
 * وأسعارها، و«بدائل» (باركودات إضافية لنفس الوحدة) تُجمَع محلّياً وتُدرَج ذرّياً مع المنتج عند الحفظ.
 * المسح: تركيز حقل الباركود يجعل ماسح HID يكتب فيه مباشرةً؛ زرّ «المسح» يولّد EAN-13 صالحاً.
 * فحص تكرار حيّ ضدّ القاعدة عبر `catalog.checkBarcodes` (نفس مسار المتغيّرات) يشمل البدائل.
 */

/** وحدة في قالب السلعة البسيطة — باركود وأسعار وبدائل مستقلّة لكل وحدة (وضع محلّي). */
type SimpleUnit = {
  id: number;
  name: string;
  factor: string;
  isBase: boolean;
  barcode: string;
  retail: string;
  wholesale: string;
  government: string;
  aliases: LocalAlias[];
};

export default function SimpleProductForm() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
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

  // ── قالب الوحدات (باركود + أسعار + بدائل لكلّ) — الافتراضي وحدة أساس واحدة (قطعة) ──
  const unitSeq = useRef(2);
  const [units, setUnits] = useState<SimpleUnit[]>([
    { id: 1, name: "قطعة", factor: "1", isBase: true, barcode: "", retail: "", wholesale: "", government: "", aliases: [] },
  ]);

  // ── التكلفة المشتركة (على مستوى المتغيّر، لا الوحدة) + المخزون الافتتاحي + الضبط ──
  const [costPrice, setCostPrice] = useState("");
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
  const baseUnit = units.find((u) => u.isBase);
  const baseBarcode = baseUnit?.barcode.trim() ?? "";
  const baseUnitName = baseUnit?.name.trim() || "قطعة";

  // ── فحص تكرار الباركود ضدّ القاعدة (live، debounced) — يشمل باركودات الوحدات وبدائلها ──
  const allCodes = useMemo(() => {
    const set = new Set<string>();
    for (const u of units) {
      const c = u.barcode.trim();
      if (c) set.add(c);
      for (const a of u.aliases) {
        const ac = (a.barcode || "").trim();
        if (ac) set.add(ac);
      }
    }
    return Array.from(set);
  }, [units]);
  // عدّاد ظهور باركود في كامل النموذج (باركودات الوحدات + بدائلها) — يطابق فضاء تفرّد الحفظ،
  // فيومض التكرار حيّاً حتى حين يصطدم الأساسيّ ببديلٍ في وحدة أخرى (لا الأساسيّات وحدها).
  const codeCountInForm = (c: string) => {
    if (!c) return 0;
    let n = 0;
    for (const u of units) {
      if (u.barcode.trim() === c) n++;
      for (const a of u.aliases) if ((a.barcode || "").trim() === c) n++;
    }
    return n;
  };
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

  /* ── الوحدات ── */
  const addUnit = () =>
    setUnits((u) => [
      ...u,
      { id: unitSeq.current++, name: "", factor: "", isBase: false, barcode: "", retail: "", wholesale: "", government: "", aliases: [] },
    ]);
  const patchUnit = (id: number, patch: Partial<SimpleUnit>) =>
    setUnits((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeUnit = (id: number) =>
    setUnits((u) => {
      if (u.length <= 1) return u;
      const next = u.filter((x) => x.id !== id);
      // إن حُذفت وحدة الأساس، رقِّ الأولى الباقية أساساً — وإلّا بقي النموذج بلا أساس ويُحجَب الحفظ.
      if (!next.some((x) => x.isBase)) next[0] = { ...next[0], isBase: true };
      return next;
    });
  const setBaseUnit = (id: number) => setUnits((u) => u.map((x) => ({ ...x, isBase: x.id === id })));

  /**
   * SKU صريح إن وُجد، وإلا يُولَّد فريداً. الأسماء العربية الخالصة تُجرَّد إلى فراغ بعد إسقاط
   * غير [A-Z0-9]، فنُلحِق لاحقةً عشوائية قصيرة لضمان التفرّد. باركود وحدة الأساس (فريدٌ أصلاً)
   * بديلٌ صالح حين يغيب مقطع الاسم اللاتيني.
   */
  function autoSku(): string {
    const explicit = sku.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (explicit) return explicit;
    const slug = finalName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    if (slug) return `PR-${slug}-${suffix}`;
    if (baseBarcode) return baseBarcode;
    return `PR-${suffix}`;
  }

  function validate(): string | null {
    if (!finalName) return "اسم المنتج مطلوب (اكتبه مباشرةً أو املأ النوع/الماركة/الموديل).";
    if (units.some((u) => !u.name.trim())) return "كل وحدة تحتاج اسماً (قطعة / درزن / علبة…).";
    // اسم الوحدة مفتاحُ مطابقةٍ في مسار التعديل (getForVariantEdit/upsertVariantUnits يطابقان بالاسم)
    // ⇒ وحدتان بنفس الاسم تتداخلان فيُطمَس باركود/سعر إحداهما عند أوّل تعديل. امنع التكرار عند الإنشاء.
    const unitNames = units.map((u) => u.name.trim());
    const dupUnitName = unitNames.find((n, i) => n && unitNames.indexOf(n) !== i);
    if (dupUnitName) return `اسم وحدة مكرّر: «${dupUnitName}» — لكل وحدة اسمٌ فريد (قطعة/درزن/كرتون).`;
    if (units.filter((u) => u.isBase).length !== 1) return "حدّد وحدة أساس واحدة فقط.";
    // كل وحدة غير أساس أكبر من الأساس ⇒ معامل تحويلها صحيحٌ أكبر من ١ (درزن=١٢). بلا هذا الحارس
    // يُرسَل المعامل الفارغ كـ«١» صامتاً فيُخصَم الدرزن قطعةً واحدةً من المخزون (§٥ baseQuantity).
    if (units.some((u) => !u.isBase && !(Number(u.factor.trim()) > 1)))
      return "الوحدة الأكبر من الأساس (درزن/كرتون) تحتاج معامل تحويل صحيحاً أكبر من ١ (درزن = ١٢).";
    if (!costPrice.trim()) return "سعر التكلفة مطلوب.";
    const anyPrice = units.some((u) => u.retail.trim() || u.wholesale.trim() || u.government.trim());
    if (!anyPrice) return "حدّد سعر بيع واحداً على الأقل (المفرد افتراضاً).";
    // تكرار الباركود داخل النموذج (وحدات + بدائل) ضمن فضاء تفرّد واحد.
    const codes: string[] = [];
    for (const u of units) {
      const c = u.barcode.trim();
      if (c) codes.push(c);
      for (const a of u.aliases) {
        const ac = (a.barcode || "").trim();
        if (ac) codes.push(ac);
      }
    }
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) return `باركود مكرّر داخل النموذج: ${dup} — لكل وحدة/بديل باركود فريد.`;
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
    // فحص أخير حاسم للباركود ضدّ القاعدة (لا نعتمد على توقيت الـdebounce) — يشمل البدائل.
    const codes = Array.from(
      new Set(
        units
          .flatMap((u) => [u.barcode.trim(), ...u.aliases.map((a) => (a.barcode || "").trim())])
          .filter(Boolean)
      )
    );
    if (codes.length) {
      try {
        const hit = await utils.catalog.checkBarcodes.fetch({ codes });
        if (hit.length) {
          setError(`الباركود ${hit[0].code} مُستخدَم في «${hit[0].takenBy}». غيّره قبل الحفظ.`);
          document.getElementById("simple-barcode")?.focus();
          return;
        }
      } catch {
        // فشل الفحص المسبق لا يمنع الحفظ — قيد UNIQUE في القاعدة يبقى الحارس الأخير.
      }
    }
    const unitsPayload = units.map((u) => {
      const aliases = u.aliases
        .map((a) => ({ barcode: (a.barcode || "").trim(), note: a.note ?? null }))
        .filter((a) => a.barcode);
      return {
        unitName: u.name.trim(),
        conversionFactor: u.isBase ? "1" : u.factor.trim() || "1",
        barcode: u.barcode.trim() || undefined,
        isBaseUnit: u.isBase,
        prices: [
          ...(u.retail.trim() ? [{ priceTier: "RETAIL" as const, price: u.retail.trim() }] : []),
          ...(u.wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: u.wholesale.trim() }] : []),
          ...(u.government.trim() ? [{ priceTier: "GOVERNMENT" as const, price: u.government.trim() }] : []),
        ],
        barcodeAliases: aliases.length ? aliases : undefined,
      };
    });
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
          units: unitsPayload,
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
            منتج واحد بلا ألوان/قياسات (كتاب، ملزمة، دفتر مفرد…) — بوحدة أو أكثر (قطعة/درزن/كرتون).
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
            {/* السلعة البسيطة بلا متغيّرات ⇒ اللون في الاسم مشروع — لا warnColors هنا. */}
            <NameAssistant name={finalName} onApply={setName} />
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

      {/* ── الوحدات والباركود والأسعار ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">الوحدات والباركود والأسعار</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              لكل وحدة باركودها المستقل وسعرها. أضِف وحدة أكبر (درزن/كرتون) بمعامل تحويلها.
              «بدائل» = باركودات إضافية لنفس الوحدة (نفس التكلفة/السعر/المخزون).
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addUnit}>+ وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {units.map((u, idx) => {
            const factor = u.isBase ? 1 : parseFloat(u.factor) || 1;
            const uCost = unitCost * factor;
            const code = u.barcode.trim();
            const st = barcodeState(code, {
              countInForm: codeCountInForm(code),
              takenInDb: takenInDb.has(code),
            });
            const bcCls =
              st === "takenInDb" || st === "dupInForm"
                ? "border-amber-500 ring-1 ring-amber-500"
                : st === "invalid"
                  ? "border-amber-500"
                  : st === "valid"
                    ? "border-emerald-500/60"
                    : "";
            const bcTitle =
              st === "takenInDb"
                ? "باركود مُستخدَم في منتج آخر — غيّره قبل الحفظ."
                : st === "dupInForm"
                  ? "باركود مكرّر داخل النموذج."
                  : st === "invalid"
                    ? "خانة تحقّق EAN-13 غير مطابقة — يُقبل مع ذلك (قد يكون كود Code128 داخليّاً)."
                    : st === "valid"
                      ? "باركود EAN-13 صالح."
                      : "";
            // لون نصّ حالة الباركود المرئيّ (a11y — لا نكتفي بلون الحدّ وaria): أحمر للحاصر، كهرماني للتحذير، أخضر للصالح.
            const bcHelpColor =
              st === "takenInDb" || st === "dupInForm"
                ? "text-red-600 dark:text-red-400"
                : st === "invalid"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400";
            return (
              <div key={u.id} className="rounded-lg border bg-muted/20 p-3 space-y-2">
                {/* هوية الوحدة: الاسم + المعامل + وحدة الأساس + الحذف — شبكة محاذاة واحدة */}
                <div className="grid grid-cols-12 gap-2 items-center">
                  <Input
                    className="col-span-12 sm:col-span-5 h-8 text-sm"
                    value={u.name}
                    onChange={(e) => patchUnit(u.id, { name: e.target.value })}
                    placeholder="اسم الوحدة (قطعة / درزن / كرتون)"
                    dir="auto"
                    aria-label="اسم الوحدة"
                  />
                  <div className="col-span-5 sm:col-span-3 flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">معامل ×</span>
                    <Input
                      className="h-8 text-sm text-center"
                      dir="ltr"
                      inputMode="numeric"
                      disabled={u.isBase}
                      value={u.isBase ? "1" : u.factor}
                      onChange={(e) => patchUnit(u.id, { factor: onlyDigits(e.target.value) })}
                      placeholder="12"
                      title="كم وحدة أساس في هذه الوحدة (درزن = ١٢)"
                      aria-label="معامل التحويل"
                    />
                  </div>
                  <label className="col-span-5 sm:col-span-3 flex items-center gap-1.5 text-xs cursor-pointer whitespace-nowrap">
                    <input type="radio" name="simpleBaseUnit" checked={u.isBase} onChange={() => setBaseUnit(u.id)} aria-label="الوحدة الأساس" />
                    وحدة أساس
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
                      id={idx === 0 ? "simple-barcode" : undefined}
                      className={cn("h-8 font-mono text-xs flex-1 min-w-0", bcCls)}
                      dir="ltr"
                      inputMode="numeric"
                      value={u.barcode}
                      onChange={(e) => patchUnit(u.id, { barcode: e.target.value })}
                      placeholder="باركود الوحدة (اختياري)…"
                      title={bcTitle}
                      aria-label="باركود الوحدة"
                      aria-invalid={st === "takenInDb" || st === "dupInForm"}
                      aria-describedby={bcTitle ? `simple-bc-help-${u.id}` : undefined}
                    />
                    <ScanButton onClick={() => patchUnit(u.id, { barcode: genEan13("621") })} title="توليد باركود EAN-13 صالح" />
                    <UnitBarcodeAliases
                      unitName={u.name || "قطعة"}
                      localAliases={u.aliases}
                      onLocalChange={(next) => patchUnit(u.id, { aliases: next })}
                    />
                  </div>
                  <MoneyInput ariaLabel="سعر المفرد" className="col-span-4 sm:col-span-2 h-8 text-sm" value={u.retail} onChange={(v) => patchUnit(u.id, { retail: v })} placeholder="مفرد" />
                  <MoneyInput ariaLabel="سعر الجملة" className="col-span-4 sm:col-span-2 h-8 text-sm" value={u.wholesale} onChange={(v) => patchUnit(u.id, { wholesale: v })} placeholder="جملة" />
                  <MoneyInput ariaLabel="سعر الحكومي" className="col-span-4 sm:col-span-2 h-8 text-sm" value={u.government} onChange={(v) => patchUnit(u.id, { government: v })} placeholder="حكومي" />
                </div>

                {/* حالة الباركود مرئيّة (لا لون الحدّ وحده) + مربوطة بـaria-describedby لقارئ الشاشة */}
                {bcTitle && (
                  <p id={`simple-bc-help-${u.id}`} className={cn("text-[11px] ps-0.5", bcHelpColor)}>
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

      {/* ── التكلفة والمخزون الافتتاحي والضبط ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">التكلفة والمخزون الافتتاحي</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            التكلفة موحّدة للمنتج (بالوحدة الأساس). الرصيد الافتتاحي لكل فرع يُسجَّل حركة OPENING — اتركه صفراً إن لم يتوفّر.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Field label="سعر التكلفة (د.ع)" required hint="سعر شراء الوحدة الأساس.">
              <MoneyInput id="simple-cost" value={costPrice} onChange={setCostPrice} placeholder="150" />
            </Field>
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
          </div>
          <div className="flex flex-wrap gap-3 border-t pt-4">
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
          سيُحفظ منتج بسيط واحد بـ<b className="text-foreground">{toArabicDigits(units.length)}</b> وحدة
          {baseBarcode ? " (بباركود)" : " (بلا باركود)"}
          {totalStock > 0 && <> — رصيد افتتاحيّ <b className="text-foreground">{toArabicDigits(totalStock)}</b> {baseUnitName}</>}.
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
