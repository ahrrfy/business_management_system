import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { NumberInput } from "@/components/form/NumberInput";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, Handshake, X } from "lucide-react";
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
  syncColorChipsOnRename,
  toArabicDigits,
  variantStockTotal,
  type ClientUnit,
  type ClientVariant,
  type ParsedVariantRow,
} from "@/lib/variants";
import { ColorDot, Field, MarginBadge } from "@/components/product/variantBits";
import { BulkTools, MatrixGenerator } from "@/components/product/VariantMatrix";
import { VariantsTable } from "@/components/product/VariantsTable";
import { NameAssistant } from "@/components/product/NameAssistant";
import { ImportModal, LabelPrintModal } from "@/components/product/variantModals";
import SimpleProductEditForm from "@/components/product/SimpleProductEditForm";
import BundleRecipeCard from "@/components/product/BundleRecipeCard";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";

/**
 * تعديل منتج بنموذج المتغيّرات المستقلة (product-variants).
 *
 * يقرأ المنتج بكامل متغيّراته عبر `catalog.getForVariantEdit`، ويعرضها في نفس محرّر
 * المتغيّرات (قالب وحدات مشترك + جدول متغيّرات بباركود لكل وحدة). يسمح بتحديث الموجود،
 * إضافة جديد، وتعطيل لون (لا حذف — حفظاً للمخزون/الحركات). المخزون **قراءة فقط** هنا
 * (يُدار عبر الجرد/الحركات). الحفظ عبر `catalog.updateProductVariants`.
 *
 * معرّف الصفّ: المتغيّر الموجود = "db:<id>"؛ الجديد = مفتاح عشوائيّ ⇒ التمييز عند الحفظ.
 */

const DB_PREFIX = "db:";

export default function ProductEdit() {
  const params = useParams();
  const productId = Number(params.id);
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const categoriesQ = trpc.catalog.categories.useQuery();
  const product = trpc.catalog.getForVariantEdit.useQuery({ productId }, { enabled: Number.isFinite(productId) });

  const [hydrated, setHydrated] = useState(false);
  const [productType, setProductType] = useState("");
  const [brand, setBrand] = useState("");
  const [modelName, setModelName] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [baseSku, setBaseSku] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [isCustomizable, setIsCustomizable] = useState(false);
  const [isService, setIsService] = useState(false);
  const [isActive, setIsActive] = useState(true);

  const [units, setUnits] = useState<ClientUnit[]>([]);
  const unitSeq = useRef(1);
  const [variants, setVariants] = useState<ClientVariant[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());

  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  // simple-edit-view: المنتج البسيط (متغيّر واحد بلا لون/قياس) يُحرَّر بنموذج نظيف افتراضياً؛
  // «advanced» يفتح محرّر المتغيّرات (لإضافة ألوان/قياسات/صور).
  const [advanced, setAdvanced] = useState(false);

  const branches = useMemo(() => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })), [branchesQ.data]);
  const myBranch = me.data?.branchId ?? 1;
  const branchId = pickedBranch ?? branches[0]?.id ?? myBranch;

  // ── تعبئة من الـAPI مرّة واحدة ──
  useEffect(() => {
    if (!product.data || hydrated) return;
    const d = product.data;
    setProductType(d.productType ?? "");
    setBrand(d.brand ?? "");
    setModelName(d.modelName ?? "");
    setOriginalName(d.name);
    setDescription(d.description ?? "");
    setCategoryId(d.categoryId ?? "");
    setIsCustomizable(d.isCustomizable);
    setIsService(d.isService);
    setIsActive(d.isActive);

    // قالب الوحدات بمعرّفات محلّية.
    const tmpl: ClientUnit[] = d.unitTemplate.map((u, i) => ({
      id: i + 1,
      name: u.unitName,
      factor: u.conversionFactor,
      isBase: u.isBaseUnit,
      retail: u.retail,
      wholesale: u.wholesale,
      government: u.government,
    }));
    unitSeq.current = tmpl.length + 1;
    setUnits(tmpl);

    const sharedCost = d.variants[0]?.costPrice ?? "";
    setCostPrice(sharedCost);
    const tmplBaseRetail = tmpl.find((u) => u.isBase)?.retail ?? "";
    // بادئة SKU مُشتقّة من أوّل متغيّر (إسقاط آخر مقطعين: كود اللون/القياس).
    const firstSku = d.variants[0]?.sku ?? "";
    setBaseSku(firstSku.split("-").slice(0, Math.max(1, firstSku.split("-").length - (d.variants[0]?.size ? 2 : 1))).join("-"));

    const rows: ClientVariant[] = d.variants.map((v) => {
      const unitBarcodes: Record<number, string> = {};
      for (const cu of tmpl) unitBarcodes[cu.id] = v.unitBarcodes[cu.name] ?? "";
      const stockByBranch: Record<number, string> = {};
      for (const [bid, q] of Object.entries(v.stockByBranch)) stockByBranch[Number(bid)] = String(q);
      const override = v.costPrice !== sharedCost || (v.baseRetail !== "" && v.baseRetail !== tmplBaseRetail);
      return {
        id: `${DB_PREFIX}${v.id}`,
        color: v.color ?? "",
        colorHex: v.colorHex ?? null,
        size: v.size ?? "",
        sku: v.sku,
        unitBarcodes,
        stockByBranch,
        minStock: String(v.minStock),
        reorderPoint: String(v.reorderPoint),
        priceOverride: override,
        costPrice: override ? v.costPrice : "",
        retail: override ? v.baseRetail : "",
        isActive: v.isActive,
        image: v.image,
      };
    });
    setVariants(rows);
    setHydrated(true);
  }, [product.data, hydrated]);

  const composedName = useMemo(
    () => [productType, brand, modelName].map((s) => s.trim()).filter(Boolean).join(" "),
    [productType, brand, modelName]
  );
  const baseRetail = units.find((u) => u.isBase)?.retail.trim() ?? "";

  const includedCount = colors.length
    ? sizes.length
      ? colors.flatMap((c) => sizes.map((s) => `${c}|${s}`)).filter((k) => !excluded.has(k)).length
      : colors.length
    : 0;

  // فحص تكرار الباركود ضدّ القاعدة (live).
  const allCodes = useMemo(() => {
    const set = new Set<string>();
    for (const v of variants) for (const u of units) {
      const c = (v.unitBarcodes[u.id] || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set);
  }, [variants, units]);
  const debouncedKey = useDebouncedValue(allCodes.join("\n"), 450);
  const debouncedCodes = useMemo(() => (debouncedKey ? debouncedKey.split("\n") : []), [debouncedKey]);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: debouncedCodes },
    { enabled: debouncedCodes.length > 0, staleTime: 10_000 }
  );
  // الباركودات المملوكة لهذا المنتج نفسه ليست تعارضاً (نستثنيها من الكهرماني) — نفس مجموعة allCodes.
  const ownCodes = useMemo(() => new Set(allCodes), [allCodes]);
  const takenInDb = useMemo(
    () => new Set((checkQ.data ?? []).map((r) => r.code).filter((c) => !ownCodes.has(c))),
    [checkQ.data, ownCodes]
  );

  const update = trpc.catalog.updateProductVariants.useMutation({
    onSuccess: async (res) => {
      setError("");
      const added = (res as { added?: number }).added ?? 0;
      setDone(added ? `تم الحفظ — أُضيف ${toArabicDigits(added)} متغيّر جديد.` : "تم حفظ التعديلات بنجاح.");
      await Promise.all([
        utils.catalog.getForVariantEdit.invalidate({ productId }),
        utils.catalog.posList.invalidate(),
        utils.catalog.adminList.invalidate(),
        utils.catalog.forPurchase.invalidate(),
      ]);
      setHydrated(false); // أعد التحميل ليعكس المعرّفات الجديدة
    },
    onError: (e) => { setError(e.message); setDone(""); },
  });

  /* ── الوحدات ── */
  const addUnit = () => setUnits((u) => [...u, { id: unitSeq.current++, name: "", factor: "", isBase: false, retail: "", wholesale: "" }]);
  const patchUnit = (id: number, patch: Partial<ClientUnit>) => setUnits((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeUnit = (id: number) => setUnits((u) => (u.length <= 1 ? u : u.filter((x) => x.id !== id)));
  const setBaseUnit = (id: number) => setUnits((u) => u.map((x) => ({ ...x, isBase: x.id === id })));

  /* ── المتغيّرات ── */
  const toggleExclude = (key: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  function makeVariant(color: string, size: string): ClientVariant {
    return {
      id: `new|${color}|${size}|${Math.random().toString(36).slice(2, 8)}`,
      color, colorHex: null, size, sku: deriveSku(baseSku, color, size),
      unitBarcodes: {}, stockByBranch: {}, minStock: "0", reorderPoint: "0",
      priceOverride: false, costPrice: "", retail: "", isActive: true, image: null,
    };
  }
  function generate() {
    const combos: Array<[string, string]> = [];
    for (const c of colors) {
      if (sizes.length) { for (const s of sizes) if (!excluded.has(`${c}|${s}`)) combos.push([c, s]); }
      else combos.push([c, ""]);
    }
    setVariants((prev) => {
      const byKey = new Map(prev.map((v) => [`${v.color}|${v.size}`, v]));
      const genKeys = new Set(combos.map(([c, s]) => `${c}|${s}`));
      // دمج غير متلف: المتغيّرات غير المشمولة بالتوليد تبقى كما هي (موجودة أو جديدة)؛
      // والمشمولة تُحدَّث أو تُنشأ. لا حذف لصفّ موجود في التعديل.
      const kept = prev.filter((v) => !genKeys.has(`${v.color}|${v.size}`));
      const generated = combos.map(([c, s]) => {
        const ex = byKey.get(`${c}|${s}`);
        return ex ? { ...ex, sku: ex.sku || deriveSku(baseSku, c, s) } : makeVariant(c, s);
      });
      return [...kept, ...generated];
    });
  }
  const patchVariant = (id: string, patch: Partial<ClientVariant>) => setVariants((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  // إعادة تسمية لون بالصفّ ⇒ مزامنة رقائق المصفوفة (كما في ProductNew، منطقٌ نقيّ مُختبَر).
  const commitColorRename = (oldColor: string, newColor: string) =>
    setColors((cs) => syncColorChipsOnRename(cs, oldColor, newColor, variants.map((v) => v.color)));
  // الموجود (db:) لا يُحذف — يُعطَّل؛ الجديد يُحذف من النموذج.
  const removeVariant = (id: string) =>
    setVariants((vs) =>
      id.startsWith(DB_PREFIX) ? vs.map((v) => (v.id === id ? { ...v, isActive: false } : v)) : vs.filter((v) => v.id !== id)
    );
  const onScan = (vid: string, uid: number) =>
    setVariants((vs) => vs.map((v) => (v.id === vid ? { ...v, unitBarcodes: { ...v.unitBarcodes, [uid]: genEan13("621") } } : v)));

  const bulkMin = (val: string) => setVariants((vs) => vs.map((v) => ({ ...v, minStock: val })));
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
  function applyImport(rows: ParsedVariantRow[]) {
    setVariants((prev) => {
      const out = [...prev];
      const idxByKey = new Map(out.map((v, i) => [`${v.color}|${v.size}`, i]));
      for (const r of rows) {
        const key = `${r.color}|${r.size}`;
        const existingIdx = idxByKey.get(key);
        if (existingIdx != null) {
          const cur = out[existingIdx];
          const unitBarcodes = { ...cur.unitBarcodes };
          r.barcodes.forEach((b, i) => { const u = units[i]; if (u && b) unitBarcodes[u.id] = b; });
          out[existingIdx] = { ...cur, sku: r.sku || cur.sku, unitBarcodes };
        } else {
          const base = makeVariant(r.color, r.size);
          if (r.sku) base.sku = r.sku;
          r.barcodes.forEach((b, i) => { const u = units[i]; if (u && b) base.unitBarcodes[u.id] = b; });
          idxByKey.set(key, out.length);
          out.push(base);
        }
      }
      return out;
    });
  }

  function validateLocal(): string | null {
    if (!composedName && !originalName.trim()) return "اسم المنتج مطلوب (نوع/ماركة/موديل).";
    if (!costPrice.trim()) return "سعر التكلفة المشترك مطلوب.";
    if (units.some((u) => !u.name.trim())) return "كل وحدة في القالب تحتاج اسماً.";
    // اسم الوحدة مفتاح مطابقة في مسار الحفظ (unitBarcodes[u.name.trim()]) ⇒ وحدتان بنفس الاسم تتصادمان
    // فيُطمَس باركود/سعر إحداهما (والخادم assertEditUniqueness يرفض لاحقاً) — نمسكه هنا برسالةٍ أوضح وأبكر
    // (مطابقةً لحارس ProductNew).
    const unitNames = units.map((u) => u.name.trim());
    const dupUnitName = unitNames.find((n, i) => n && unitNames.indexOf(n) !== i);
    if (dupUnitName) return `اسم وحدة مكرّر في القالب: «${dupUnitName}» — لكل وحدة اسمٌ فريد.`;
    if (units.filter((u) => u.isBase).length !== 1) return "حدّد وحدة أساس واحدة فقط في قالب الوحدات.";
    if (!variants.length) return "المنتج يحتاج متغيّراً واحداً على الأقل.";
    if (variants.some((v) => !v.sku.trim())) return "كل متغيّر يحتاج SKU.";
    const skus = variants.map((v) => v.sku.trim());
    const dupSku = skus.find((s, i) => s && skus.indexOf(s) !== i);
    if (dupSku) return `SKU مكرّر بين المتغيّرات: ${dupSku}.`;
    const codes: string[] = [];
    for (const v of variants) for (const u of units) { const c = (v.unitBarcodes[u.id] || "").trim(); if (c) codes.push(c); }
    const dupBc = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dupBc) return `باركود مكرّر داخل النموذج: ${dupBc}.`;
    return null;
  }

  function buildPayload() {
    const unitTemplate = units.map((u) => ({
      unitName: u.name.trim(),
      conversionFactor: u.isBase ? "1" : u.factor.trim() || "1",
      isBaseUnit: u.isBase,
      prices: [
        ...(u.retail.trim() ? [{ priceTier: "RETAIL" as const, price: u.retail.trim() }] : []),
        ...(u.wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: u.wholesale.trim() }] : []),
        // GOVERNMENT يجب إعادة إرساله دائماً: upsert يمسح كل أسعار الوحدة ثم يُدرِج المُرسَل فقط.
        ...((u.government ?? "").trim() ? [{ priceTier: "GOVERNMENT" as const, price: (u.government ?? "").trim() }] : []),
      ],
    }));
    return {
      productId,
      // الاسم الصريح هو المرجع؛ التركيب من الأجزاء مجرّد بديل عند فراغه (يطابق composeName في الخادم).
      name: originalName.trim() || composedName || null,
      productType: productType.trim() || null,
      brand: brand.trim() || null,
      modelName: modelName.trim() || null,
      description: description.trim() || null,
      categoryId: categoryId === "" ? null : Number(categoryId),
      isCustomizable,
      isService,
      isActive,
      unitTemplate,
      variants: variants.map((v) => {
        const unitBarcodes: Record<string, string> = {};
        for (const u of units) {
          const b = (v.unitBarcodes[u.id] || "").trim();
          if (b) unitBarcodes[u.name.trim()] = b;
        }
        return {
          id: v.id.startsWith(DB_PREFIX) ? Number(v.id.slice(DB_PREFIX.length)) : undefined,
          sku: v.sku.trim(),
          color: v.color.trim() || null,
          colorHex: v.colorHex || null, // "" أو null ⇒ null (يتّسق مع ProductNew ويجنّب رفض zod للفراغ)
          size: v.size.trim() || null,
          costPrice: v.priceOverride && v.costPrice.trim() ? v.costPrice.trim() : costPrice.trim(),
          baseRetail: v.priceOverride && v.retail.trim() ? v.retail.trim() : undefined,
          minStock: clampInt(v.minStock),
          reorderPoint: clampInt(v.reorderPoint),
          isActive: v.isActive,
          image: v.image, // string ⇒ تُعيَّن، null ⇒ تُزال (يُعاد التوفيق دائماً)
          unitBarcodes,
        };
      }),
    };
  }

  async function save() {
    setError("");
    setDone("");
    const err = validateLocal();
    if (err) { setError(err); return; }
    const codes = Array.from(new Set(variants.flatMap((v) => units.map((u) => (v.unitBarcodes[u.id] || "").trim())).filter(Boolean)));
    if (codes.length) {
      try {
        const taken = (await utils.catalog.checkBarcodes.fetch({ codes })).filter((t) => !ownCodes.has(t.code));
        if (taken.length) { setError(`الباركود ${taken[0].code} مُستخدَم في «${taken[0].takenBy}». غيّره قبل الحفظ.`); return; }
      } catch { /* القيد UNIQUE هو الحارس الأخير */ }
    }
    update.mutate(buildPayload());
  }

  function exportExcel() {
    exportRows(variants, {
      filename: `منتج-${originalName || composedName || "بمتغيرات"}`,
      sheetName: "المنتجات",
      columns: [
        { key: "name", header: "الاسم الكامل", map: (v) => [originalName || composedName, v.color, v.size].filter(Boolean).join(" ") },
        { key: "color", header: "اللون", map: (v) => v.color },
        { key: "size", header: "القياس", map: (v) => v.size },
        { key: "sku", header: "SKU", map: (v) => v.sku },
        ...units.map((u) => ({ key: `bc_${u.id}`, header: `باركود ${u.name || "وحدة"}`, map: (v: ClientVariant) => v.unitBarcodes[u.id] || "" })),
        { key: "stock", header: "المخزون (كل الفروع)", map: (v) => variantStockTotal(v.stockByBranch) },
        { key: "price", header: "سعر البيع", map: (v) => (v.priceOverride && v.retail.trim() ? v.retail.trim() : baseRetail) },
        { key: "active", header: "الحالة", map: (v) => (v.isActive ? "مفعّل" : "معطّل") },
      ],
    });
  }

  if (product.isLoading) return <LoadingState />;
  if (!product.data) return <div className="p-10 text-center text-muted-foreground">المنتج غير موجود.</div>;

  // simple-edit-view: منتج بسيط = متغيّر واحد بلا لون/قياس وليس خِدمة ⇒ نموذج التحرير المبسّط افتراضياً.
  // (الخدمة تُستثنى: نموذجها المبسّط لا يعرض مفتاح «خِدمة» ويُظهر رصيداً صفريّاً بلا معنى.)
  const isSimple =
    product.data.variants.length === 1 &&
    !product.data.variants[0].color &&
    !product.data.variants[0].size &&
    !product.data.isService;
  if (isSimple && !advanced) {
    // عند فتح المتقدّم نُصفّر hydrated ليُعاد التحميل من أحدث بيانات الخادم (بعد أي حفظ في المبسّط)
    // ⇒ لا يعرض المتقدّم لقطةً قديمة ولا يعكس حفظاً سابقاً بالخطأ.
    return <SimpleProductEditForm productId={productId} onAdvanced={() => { setHydrated(false); setAdvanced(true); }} />;
  }

  const activeCount = variants.filter((v) => v.isActive).length;

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-28">
      <PageHeader
        title="تعديل منتج بمتغيّرات"
        description="المنتجات / تعديل المنتج"
        actions={
          <div className="flex items-center gap-2">
            {isSimple && (
              <Button type="button" variant="outline" size="sm" onClick={() => { if (window.confirm("العودة للتحرير المبسّط تتجاهل أي تعديلات غير محفوظة هنا. متابعة؟")) setAdvanced(false); }} title="العودة للتحرير المبسّط">
                تحرير مبسّط
              </Button>
            )}
            <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground">← رجوع للمنتجات</Link>
          </div>
        }
      />

      {/* بضاعة الأمانة (٢٠/٧): وسم للعرض فقط — يُدار وقت الإنشاء، ولا يُغيَّر في التعديل (نمط قفل §٥-ك). */}
      {product.data?.isConsignment && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <Handshake aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <b>بضاعة أمانة</b> — المودِع: {product.data.consignorName ?? `#${product.data.consignorId}`}.
            خانة «سعر التكلفة» أدناه هي <b>حصة المودِع</b> (المبلغ المستحقّ له عند البيع). لتغيير المودِع أو الوسم: صفِّر الرصيد ثم أعِد الإنشاء.
          </div>
        </div>
      )}

      {/* اسم مركّب + معاينة */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">اسم المنتج وبياناته</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field
              label="اسم المنتج"
              required
              hint="يظهر في البيع والفواتير والتقارير. هذا اسم المنتج الكامل (وهو ما يظهر للمنتجات المستوردة)."
              className="md:col-span-3"
            >
              <div className="flex items-center gap-2">
                <Input value={originalName} onChange={(e) => setOriginalName(e.target.value)} placeholder="اسم المنتج الكامل" dir="auto" />
                {composedName && composedName !== originalName.trim() && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setOriginalName(composedName)}
                    title="تركيب الاسم من النوع/الماركة/الموديل"
                  >
                    ↻ تركيب من الحقول
                  </Button>
                )}
              </div>
              <NameAssistant name={originalName.trim() || composedName} onApply={setOriginalName} excludeProductId={productId} warnColors />
            </Field>
            <Field label="النوع (اختياري)" hint="حقول وصفية للبحث/التصنيف — لا تغيّر الاسم تلقائياً."><Input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="قلم جاف" /></Field>
            <Field label="الماركة (اختياري)"><Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Pilot" dir="auto" /></Field>
            <Field label="الموديل (اختياري)"><Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="G-2" dir="auto" /></Field>
            <Field label="الفئة / التصنيف">
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              >
                <option value="">— بلا فئة —</option>
                {(categoriesQ.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="بادئة SKU (للمتغيّرات الجديدة)" className="md:col-span-2"><Input value={baseSku} onChange={(e) => setBaseSku(e.target.value.toUpperCase())} dir="ltr" placeholder="PG-G2" /></Field>
            <Field label="الوصف" className="md:col-span-3"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="خصائص/ملاحظات…" /></Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">معاينة</CardTitle></CardHeader>
          <CardContent>
            <div className="rounded-lg border bg-muted/30 overflow-hidden">
              <div className="aspect-[4/3] flex items-center justify-center text-muted-foreground" style={{ background: "repeating-linear-gradient(135deg, oklch(0.95 0.005 250), oklch(0.95 0.005 250) 10px, oklch(0.93 0.005 250) 10px, oklch(0.93 0.005 250) 20px)" }}>
                <span className="font-mono text-[11px] bg-card/80 px-2 py-1 rounded">{originalName || composedName || "—"}</span>
              </div>
              <div className="p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">{toArabicDigits(variants.length)} متغيّر ({toArabicDigits(activeCount)} مفعّل):</span>
                  {variants.slice(0, 10).map((v) => <ColorDot key={v.id} name={v.color} hex={v.colorHex} />)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* تسعير مشترك */}
      <Card>
        <CardHeader><CardTitle className="text-base">التسعير · مشترك</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label={product.data?.isConsignment ? "حصة المودِع (د.ع)" : "سعر التكلفة (د.ع)"} required hint={product.data?.isConsignment ? "المبلغ المستحقّ للمودِع عند البيع." : "موحّد لكل الألوان إلا ما له سعر خاص."}><Input value={costPrice} onChange={(e) => setCostPrice(e.target.value)} dir="ltr" placeholder="150" /></Field>
          <Field label="خِدمة (بِلا مَخزون)" hint="لا يَخصُم مَخزوناً ولا يَنزل سالباً."><div className="flex items-center gap-2 h-9"><Switch checked={isService} onCheckedChange={setIsService} /><span className="text-xs text-muted-foreground">{isService ? "خِدمة" : "سِلعة"}</span></div></Field>
          <Field label="قابل للتخصيص"><div className="flex items-center gap-2 h-9"><Switch checked={isCustomizable} onCheckedChange={setIsCustomizable} disabled={isService} /><span className="text-xs text-muted-foreground">{isCustomizable ? "يدخل كمادة" : "جاهز للبيع"}</span></div></Field>
          <Field label="حالة المنتج"><div className="flex items-center gap-2 h-9"><Switch checked={isActive} onCheckedChange={setIsActive} /><span className="text-xs text-muted-foreground">{isActive ? "مفعّل" : "مخفي"}</span></div></Field>
        </CardContent>
      </Card>

      {/* قالب الوحدات */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">قالب الوحدات والأسعار · مشترك</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">يُطبَّق على كل المتغيّرات (مطابقة بالاسم). حذف وحدة من القالب يُعطّلها — لا يمحو تاريخها.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addUnit}>+ وحدة</Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="hidden md:grid grid-cols-12 gap-2 px-1 text-[11px] font-semibold text-muted-foreground">
            <span className="col-span-2">الوحدة</span><span className="col-span-1">معامل</span><span className="col-span-2">سعر المفرد</span><span className="col-span-2">سعر الجملة</span><span className="col-span-2">سعر الحكومي</span><span className="col-span-2">الهامش</span><span className="col-span-1 text-center">أساس</span>
          </div>
          {units.map((u) => {
            const factor = u.isBase ? 1 : parseFloat(u.factor) || 1;
            const unitCost = (parseFloat(costPrice) || 0) * factor;
            return (
              <div key={u.id} className="grid grid-cols-2 md:grid-cols-12 gap-2 items-center border-t pt-2 md:border-0 md:pt-0">
                <Input className="md:col-span-2 h-8 text-sm" value={u.name} onChange={(e) => patchUnit(u.id, { name: e.target.value })} placeholder="قطعة / درزن" />
                <NumberInput className="md:col-span-1 h-8 text-sm" disabled={u.isBase} value={u.isBase ? "1" : u.factor} onChange={(v) => patchUnit(u.id, { factor: v })} placeholder="12" decimals={4} />
                <MoneyInput className="md:col-span-2 h-8 text-sm" value={u.retail} onChange={(v) => patchUnit(u.id, { retail: v })} placeholder="مفرد" />
                <MoneyInput className="md:col-span-2 h-8 text-sm" value={u.wholesale} onChange={(v) => patchUnit(u.id, { wholesale: v })} placeholder="جملة" />
                <MoneyInput className="md:col-span-2 h-8 text-sm" value={u.government ?? ""} onChange={(v) => patchUnit(u.id, { government: v })} placeholder="حكومي" />
                <div className="md:col-span-2"><MarginBadge cost={unitCost} sell={u.retail} /></div>
                <div className="md:col-span-1 flex items-center justify-center gap-2">
                  <input type="radio" name="baseUnitEdit" checked={u.isBase} onChange={() => setBaseUnit(u.id)} title="الوحدة الأساس" aria-label="الوحدة الأساس" />
                  <button type="button" onClick={() => removeUnit(u.id)} disabled={units.length <= 1} className="text-muted-foreground hover:text-destructive disabled:opacity-30 text-xs" aria-label="حذف الوحدة"><X aria-hidden className="size-4" /></button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* المتغيّرات */}
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">المتغيّرات (الألوان والقياسات)<Badge variant="secondary" className="bg-primary/10 text-primary">{toArabicDigits(variants.length)}</Badge></CardTitle>
            <p className="text-xs text-muted-foreground mt-1">عدّل الموجود أو أضِف جديداً. حذف لون موجود <b>يعطّله</b> (حفظاً للمخزون). المخزون قراءة فقط هنا.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">الفرع:
              <select value={branchId} onChange={(e) => setPickedBranch(Number(e.target.value))} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground">
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>استيراد / لصق</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrintOpen(true)} disabled={!variants.length}>طباعة الملصقات</Button>
            <Button type="button" variant="outline" size="sm" onClick={exportExcel} disabled={!variants.length}>تصدير Excel</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <MatrixGenerator colors={colors} setColors={setColors} sizes={sizes} setSizes={setSizes} excluded={excluded} toggleExclude={toggleExclude} onGenerate={generate} includedCount={includedCount} existingCount={variants.length} />
          {variants.length > 0 && (
            <BulkTools
              units={units}
              branchName={branches.find((b) => b.id === branchId)?.name ?? "الفرع"}
              onMinAll={bulkMin}
              onStockAll={() => { /* المخزون يُدار عبر الجرد/الحركات — لا تعديل بالجملة في التعديل */ }}
              onSeq={bulkSeq}
            />
          )}
          <VariantsTable
            variants={variants}
            units={units}
            branches={branches}
            branchId={branchId}
            costPrice={costPrice}
            baseName={originalName || composedName}
            takenInDb={takenInDb}
            patchVariant={patchVariant}
            removeVariant={removeVariant}
            onScan={onScan}
            onColorCommit={commitColorRename}
            stockEditable={false}
            emptyHint="لا متغيّرات — أضِف عبر المولّد أعلاه."
          />
        </CardContent>
      </Card>

      {/* gstack B12 (٧/٧/٢٦): تبويب وصفة البكج — يُعرض فقط لو المنتج بكج. المتغيّر الأول هو الأب حصراً
          (قيد الإنشاء + التعديل). previewImpact + setComponents يستهلكان في المكوّن. */}
      {product.data?.isBundle && (product.data as any)?.variants?.[0]?.id != null && (
        <BundleRecipeCard bundleVariantId={Number((product.data as any).variants[0].id)} />
      )}

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

      <div className="fixed bottom-0 inset-x-0 lg:start-60 border-t bg-card/95 backdrop-blur px-6 py-3 flex items-center justify-between gap-3 z-30">
        <div className="text-xs text-muted-foreground hidden sm:block">
          {toArabicDigits(variants.length)} متغيّر ({toArabicDigits(activeCount)} مفعّل) — التعديل يحدّث الموجود، يضيف الجديد، ويعطّل المحذوف.
        </div>
        <div className="flex gap-2">
          <Link href="/products"><Button type="button" variant="outline" size="sm">إلغاء</Button></Link>
          <Button type="button" size="sm" onClick={save} disabled={update.isPending}>{update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}</Button>
        </div>
      </div>

      <ImportModal open={importOpen} onOpenChange={setImportOpen} units={units} onImport={applyImport} />
      <LabelPrintModal open={printOpen} onOpenChange={setPrintOpen} variants={variants} units={units} baseName={originalName || composedName} baseRetail={baseRetail} />
    </div>
  );
}
