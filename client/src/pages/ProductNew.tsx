import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { Boxes, FlaskConical, Layers, Package, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";

import { PageHeader } from "@/components/PageHeader";
import { RecordForm } from "@/components/form/RecordForm";
import { ProductFormFields, type ProductModelPatch } from "@/components/form/product/ProductFormFields";
import {
  allBarcodes,
  buildCreateProductPayload,
  emptyProductFormModel,
  finalName,
  productFormSignature,
  validateProductForm,
  type ProductFormModel,
} from "@/components/form/product/productFormModel";
import {
  PostSaveProductBanner,
  type PostSaveProductSummary,
} from "@/components/product/PostSaveProductBanner";
import BundleForm from "@/components/product/BundleForm";
import ServiceForm from "@/components/product/ServiceForm";
import SimpleProductForm from "@/components/product/SimpleProductForm";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { trpc } from "@/lib/trpc";

/**
 * إضافة منتج — تبويب البند (بسيطة/بمتغيّرات/خدمة/بكج)، ووضعُ «بمتغيّرات» على النموذج الواحد (م٦ ق٤):
 * `RecordForm` (Ctrl+S · حارس المغادرة · نتيجة مُهيكَلة) + `ProductFormFields` **نفسُه** الذي تُصيّره
 * شاشة التعديل — فالإنشاء ⇒ التعديل شاشةٌ واحدة حرفياً، والحالةُ في `ProductFormModel` النقيّ.
 *
 * كانت هذه الصفحة تحمل ~٢٥ `useState` ومتحقِّقاً وبانيَ حمولةٍ خاصَّين بها ينجرفان عن التعديل.
 */
type ItemMode = "simple" | "raw_material" | "variants" | "service" | "bundle";

const MODES: Array<{ v: ItemMode; label: string; Icon: typeof Package; hint: string }> = [
  { v: "simple", label: "سلعة بسيطة", Icon: Package, hint: "منتج واحد بباركود واحد — كتاب/ملزمة/دفتر مفرد" },
  { v: "raw_material", label: "مادة خام", Icon: FlaskConical, hint: "ورق/حبر/مادة تشغيل تُستهلك في الوصفات وأوامر العمل ولا تظهر في البيع" },
  { v: "variants", label: "سلعة بمتغيّرات", Icon: Layers, hint: "ألوان/قياسات — كل تركيبة منتج مستقل بباركوده" },
  { v: "service", label: "خِدمة", Icon: Wrench, hint: "بلا مخزون — تصوير/تجليد/تصميم" },
  { v: "bundle", label: "بكج (باندل)", Icon: Boxes, hint: "منتج مركّب من عدّة منتجات يُباع كوحدة — طقم مدرسي/هدية" },
];

const TITLE: Record<ItemMode, string> = {
  simple: "إضافة سلعة بسيطة",
  raw_material: "إضافة مادة خام",
  variants: "إضافة منتج بمتغيّرات",
  service: "إضافة خِدمة",
  bundle: "إضافة بكج (باندل)",
};

export default function ProductNew() {
  const { can } = useCatalogPeopleOperationAccess();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: can("branches.list") });
  const categoriesQ = trpc.catalog.categories.useQuery(undefined, { enabled: can("catalog.categories") });
  // الافتراضي «بسيطة» لأنها الحالة الأشيَع في المكتبة (كتاب/ملزمة/دفتر مفرد).
  const [mode, setMode] = useState<ItemMode>("simple");
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [lastSaved, setLastSaved] = useState<PostSaveProductSummary | null>(null);

  // ── النموذج الواحد (وضع المتغيّرات) ──
  const [model, setModel] = useState<ProductFormModel>(() => emptyProductFormModel());
  const patch = (p: ProductModelPatch) => setModel((m) => ({ ...m, ...(typeof p === "function" ? p(m) : p) }));
  // مرجعٌ للنموذج الحيّ — يُقرأ بعد انتظار الحفظ لكشف تعديلٍ وقع أثناء الانتظار (Codex #1010 P1، بلا لقطةٍ بائتة).
  const modelRef = useRef(model);
  modelRef.current = model;
  /*
   * لقطةُ الاتّساخ المرجعية: النموذج الفارغ، ثمّ **ما أُرسل فعلاً** بعد حفظٍ ناجح (لا الحالة وقت وصول
   * الاستجابة — سباق Codex #978: تعديلٌ أثناء انتظار الحفظ كان يُبتلَع فيُغادَر بلا سؤال).
   */
  const [savedSignature, setSavedSignature] = useState<string>(() => productFormSignature(emptyProductFormModel()));
  const isDirty = productFormSignature(model) !== savedSignature;

  const branches = useMemo(() => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })), [branchesQ.data]);
  const myBranch = me.data?.branchId ?? 1;
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const branchId = pickedBranch ?? branches[0]?.id ?? myBranch;

  // ── فحص تكرار الباركود ضدّ القاعدة (live، debounced) — يشمل الوحدات وبدائلها ──
  const codes = useMemo(() => allBarcodes(model), [model]);
  const debouncedKey = useDebouncedValue(codes.join("\n"), 450);
  const debouncedCodes = useMemo(() => (debouncedKey ? debouncedKey.split("\n") : []), [debouncedKey]);
  const checkQ = trpc.catalog.checkBarcodes.useQuery(
    { codes: debouncedCodes },
    { enabled: can("catalog.checkBarcodes") && (debouncedCodes.length > 0), staleTime: 10_000 },
  );
  const takenInDb = useMemo(() => new Set((checkQ.data ?? []).map((r) => r.code)), [checkQ.data]);

  const create = trpc.catalog.createProduct.useMutation();
  const blockedBy = useMemo(() => validateProductForm(model), [model]);

  // بعد حفظٍ ناجح نغادر إلى القائمة — بعد أن يرى الحارس أنّ النموذج لم يعد متّسخاً (وإلّا سأل).
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (leaveTo && !isDirty) navigate(leaveTo);
  }, [leaveTo, isDirty, navigate]);

  async function save(): Promise<unknown> {
    if (!can("catalog.createProduct")) throw new Error("العملية غير مفوضة لحسابك");
    // فحص أخير حاسم للباركود ضدّ القاعدة (لا نعتمد على توقيت الـdebounce) — يشمل البدائل.
    if (codes.length) {
      let taken: Array<{ code: string; takenBy: string }> = [];
      try {
        taken = await utils.catalog.checkBarcodes.fetch({ codes });
      } catch {
        // فشل الفحص المسبق لا يمنع الحفظ — قيد UNIQUE في القاعدة يبقى الحارس الأخير.
      }
      if (taken.length) throw new Error(`الباركود ${taken[0].code} مُستخدَم في «${taken[0].takenBy}». غيّره قبل الحفظ.`);
    }
    const submitted = productFormSignature(model);
    const res = await create.mutateAsync(buildCreateProductPayload(model, branches, clientRequestId));
    setClientRequestId(crypto.randomUUID());
    setSavedSignature(submitted);
    await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.adminList.invalidate()]);
    return res;
  }

  async function saveAndClose() {
    const res = await save();
    setLeaveTo("/products");
    return res;
  }

  async function saveAndNew() {
    // بصمةُ ما نبدأ به قبل الحفظ. إن عدّل المستخدم النموذج **أثناء انتظار** الطفرة فلا نطمس تعديله
    // بنموذجٍ فارغ (Codex #1010 P1، نمط CP-U02) — نبدأ فارغاً فقط إن بقي النموذج كما أُرسِل.
    const submitted = productFormSignature(model);
    const savedName = finalName(model);
    const savedSku = model.baseSku || model.variants[0]?.sku || null;
    const savedUsage = model.stockUsage;
    const res = await save();
    const createdId = Number(
      (res as { productId?: number; id?: number })?.productId ??
        (res as { id?: number })?.id ??
        0,
    );
    if (createdId > 0) {
      setLastSaved({
        productId: createdId,
        name: savedName,
        sku: savedSku,
        stockUsage: savedUsage,
      });
    }
    if (productFormSignature(modelRef.current) === submitted) {
      const fresh = emptyProductFormModel();
      setModel(fresh);
      setSavedSignature(productFormSignature(fresh));
    }
    // إن عُدّل أثناء الانتظار: `save()` ثبّت savedSignature على ما أُرسل، فيبقى تعديلُ المستخدم متّسخاً وظاهراً.
    return res;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-28">
      <PageHeader
        title={TITLE[mode]}
        breadcrumbs={[{ label: "المنتجات", href: "/products" }, { label: "إضافة منتج" }]}
        backHref="/products"
        backLabel="رجوع للمنتجات"
      />

      {/* ── نوع البَند ── */}
      <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
        {MODES.map((t) => (
          <button
            key={t.v}
            type="button"
            onClick={() => setMode(t.v)}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              mode === t.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
            title={t.hint}
            aria-pressed={mode === t.v}
          >
            <t.Icon aria-hidden className="size-4" />
            {t.label}
          </button>
        ))}
      </div>

      {mode === "service" ? (
        <ServiceForm />
      ) : mode === "simple" || mode === "raw_material" ? (
        <SimpleProductForm key={mode} rawMaterialPreset={mode === "raw_material"} />
      ) : mode === "bundle" ? (
        <BundleForm />
      ) : (
        <>
        <PostSaveProductBanner saved={lastSaved} onDismiss={() => setLastSaved(null)} />
        <RecordForm
          mode="create"
          isDirty={isDirty}
          blockedBy={can("catalog.createProduct") ? blockedBy : [...blockedBy, "العملية غير مفوضة لحسابك"]}
          isPending={create.isPending}
          onSave={saveAndClose}
          onSaveAndNew={saveAndNew}
          saveLabel="حفظ المنتج والمتغيّرات"
          savedMessage="تم حفظ المنتج ومتغيّراته"
          barHint={
            <>
              سيُحفظ <b className="text-foreground" dir="ltr">{model.variants.length}</b> منتج مخزنيّ مستقل تحت منتج واحد — كلٌّ بباركوداته ورصيده لكل فرع.
            </>
          }
        >
          <ProductFormFields
            mode="create"
            model={model}
            onChange={patch}
            branches={branches}
            branchId={branchId}
            onBranchChange={setPickedBranch}
            categories={categoriesQ.data ?? []}
            takenInDb={takenInDb}
          />
        </RecordForm>
        </>
      )}
    </div>
  );
}
