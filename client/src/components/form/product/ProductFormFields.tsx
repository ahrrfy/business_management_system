/**
 * ProductFormFields — حقولُ منتجٍ بمتغيّرات، **مكوّنٌ واحد للإنشاء والتعديل** (م٦ ق٤ / D5).
 *
 * قرار المالك: «شاشةُ التعديل تُظهر شاشة الإنشاء مطابقة». كانت `ProductNew`/`ProductEdit` تكتبان
 * البطاقات نفسها بيدين، فانجرفتا (٨ حقولٍ في إحداهما دون الأخرى — خطّ أساس `check:form-parity`).
 * الآن الشاشتان تُصيّران هذا المكوّن نفسَه بـ`mode` مختلف؛ والفرقُ الوحيد بين الوضعين هو ما
 * **يستحيل** في الإنشاء بحكم الطبيعة (مساعداتٌ تحتاج سجلاً محفوظاً: قالب التخصيص، المنتجات
 * المرتبطة، وصفة البكج، صورُ الاستوديو) — وتُعرض حين يُمرَّر `productId` لا حسب الوضع.
 *
 * موقعُه `components/form/` كي **يتبعه** حارس التناظر (يقيس حقول المكوّن المشترك في الشاشتين).
 * الحالةُ يملكها النموذج (`ProductFormModel`) عبر `onChange(patch)` — لا `useState` للحقول هنا.
 * الأرقامُ لاتينية (لا تحويلَ إلى الهندية) — قرار المالك.
 */
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MoneyCoach } from "@/components/form/MoneyCoach";
import { MoneyInput } from "@/components/form/MoneyInput";
import { NumberInput } from "@/components/form/NumberInput";
import { AiProductContentAssistant } from "@/components/product/AiProductContentAssistant";
import BundleRecipeCard from "@/components/product/BundleRecipeCard";
import { ConsignmentField } from "@/components/product/ConsignmentField";
import { NameAssistant } from "@/components/product/NameAssistant";
import { ProductCustomizationTemplateEditor } from "@/components/product/ProductCustomizationTemplateEditor";
import { ProductMediaContentSection } from "@/components/product/ProductMediaContentSection";
import { ProductRelatedProductsEditor } from "@/components/product/ProductRelatedProductsEditor";
import { ColorDot, Field } from "@/components/product/variantBits";
import { categoryOptionElements, type CategoryLite } from "@/lib/categoryTree";
import { trpc } from "@/lib/trpc";
import { RefreshCw } from "lucide-react";
import { ProductVariantsFields } from "@/components/form/product/ProductVariantsFields";
import {
  composedName,
  finalName,
  type ProductFormMode,
  type ProductFormModel,
} from "./productFormModel";

export type ProductModelPatch =
  | Partial<ProductFormModel>
  | ((m: ProductFormModel) => Partial<ProductFormModel>);

/** حقائقُ الخادم التي لا يملكها النموذج (تعطيلٌ وتسميات) — فارغةٌ في الإنشاء. */
export type ProductFormFacts = {
  isBundle?: boolean;
  /** وسمُ الأمانة المحفوظ (يُعيد تسمية «التكلفة» إلى «حصة المودِع»). */
  isConsignment?: boolean;
  bundleVariantId?: number | null;
  /** مجموعُ الرصيد عبر الفروع — يقفل وسم الأمانة حين لا يكون صفراً. */
  totalStock?: number;
};

export type ProductFormFieldsProps = {
  mode: ProductFormMode;
  model: ProductFormModel;
  onChange: (patch: ProductModelPatch) => void;
  /** في التعديل: معرّف المنتج — المساعداتُ التي تحتاج سجلاً محفوظاً تُعرض بوجوده لا بالوضع. */
  productId?: number;
  facts?: ProductFormFacts;
  branches: Array<{ id: number; name: string }>;
  branchId: number;
  onBranchChange: (id: number) => void;
  categories: CategoryLite[];
  /** باركوداتٌ محجوزة في القاعدة لمنتجٍ آخر (فحصٌ حيّ) — لتلوين الخلايا. */
  takenInDb: Set<string>;
  /** في التعديل: فتحُ حوار بدائل الباركود لوحدةٍ محفوظة. */
  onOpenAliasDialog?: (target: { variantId: number; unitName: string; label: string }) => void;
};

/**
 * **priceSanity L1.5 (٣٠/٧):** مرافقٌ حيّ أسفل حقل التكلفة — الهامش والنسبة ومعيار الفئة. في التعديل
 * يستثني المنتج نفسه من الإحصاء (`excludeProductId`).
 */
function ProductCostCoach({
  costPrice, baseRetail, categoryId, brand, productType, productId,
}: {
  costPrice: string;
  baseRetail: string;
  categoryId: number | null;
  brand: string;
  productType: string;
  productId?: number;
}) {
  const statsQ = trpc.catalog.categoryStats.useQuery(
    { categoryId, brand: brand.trim() || null, productType: productType.trim() || null, excludeProductId: productId },
    { enabled: categoryId != null || !!brand.trim() || !!productType.trim(), staleTime: 5 * 60 * 1000 },
  );
  return (
    <MoneyCoach
      className="mt-1"
      cost={costPrice.trim()}
      retail={baseRetail.trim()}
      categoryStats={statsQ.data ? {
        minCost: statsQ.data.minCost ?? undefined,
        maxCost: statsQ.data.maxCost ?? undefined,
        medianCost: statsQ.data.medianCost ?? undefined,
        n: statsQ.data.n ?? 0,
      } : undefined}
    />
  );
}

export function ProductFormFields({
  mode,
  model,
  onChange,
  productId,
  facts,
  branches,
  branchId,
  onBranchChange,
  categories,
  takenInDb,
  onOpenAliasDialog,
}: ProductFormFieldsProps) {
  const set = (patch: Partial<ProductFormModel>) => onChange(patch);
  const composed = composedName(model);
  const name = finalName(model);
  const isEdit = mode === "edit";
  const primaryImage = model.images.find((i) => i.isPrimary) ?? model.images[0];
  const activeCount = model.variants.filter((v) => v.isActive).length;
  const consignmentLocked = (facts?.totalStock ?? 0) > 0;
  const costLabel = model.consignment.isConsignment || facts?.isConsignment ? "حصة المودِع (د.ع)" : "سعر التكلفة (د.ع)";
  const backorderBlocked = model.isService || !!facts?.isBundle || model.consignment.isConsignment;

  const aiProductFacts = {
    finalProductName: name || null,
    inputDescription: model.description.trim() || null,
    category: model.categoryId === "" ? null : categories.find((c) => Number(c.id) === Number(model.categoryId))?.name ?? null,
    productType: model.productType.trim() || null,
    brand: model.brand.trim() || null,
    modelName: model.modelName.trim() || null,
    attributes: {},
    variants: model.variants.map((v) => ({ color: v.color.trim() || null, size: v.size.trim() || null })),
    saleUnits: model.units.filter((u) => u.name.trim()).map((u) => ({ name: u.name.trim(), conversionFactor: u.isBase ? "1" : u.factor.trim() || "1" })),
    verifiedClaims: [],
    audience: null,
  };

  return (
    <div className="space-y-4" data-slot="product-form-fields" data-mode={mode}>
      <AiProductContentAssistant
        productId={productId}
        facts={aiProductFacts}
        onApply={(draft) =>
          // «الفارغ فقط» للاسم — لا يُطمَس اسمٌ كتبه الموظّف؛ الوصفُ يُستبدل (هو ما طُلب توليده).
          set({ description: draft.description, ...(model.productName.trim() ? {} : { productName: draft.seoTitle || draft.shortTitle }) })
        }
      />

      {/* بضاعة الأمانة: يُقفل حين يكون للمنتج رصيد؛ ولا معنى له لخدمةٍ أو بكج. */}
      {!facts?.isBundle && !model.isService && (
        <ConsignmentField
          value={model.consignment}
          onChange={(consignment) => set({ consignment })}
          disabled={consignmentLocked}
          disabledHint="لا يمكن تغيير وسم الأمانة والرصيد غير صفري — صفِّر المخزون أولاً."
        />
      )}

      {/* اسم مركّب + معاينة */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">اسم المنتج وبياناته</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field
              label="اسم المنتج"
              required
              hint="يظهر في البيع والفواتير والتقارير. اكتبه مباشرةً أو ركّبه من النوع/الماركة/الموديل."
              className="md:col-span-3"
            >
              <div className="flex items-center gap-2">
                <Input id="product-name" value={model.productName} onChange={(e) => set({ productName: e.target.value })} placeholder="اسم المنتج الكامل" dir="auto" />
                {composed && composed !== model.productName.trim() && (
                  <Button type="button" variant="outline" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => set({ productName: composed })} title="تركيب الاسم من النوع/الماركة/الموديل">
                    <RefreshCw aria-hidden className="size-3.5" />
                    تركيب من الحقول
                  </Button>
                )}
              </div>
              <NameAssistant name={name} onApply={(productName) => set({ productName })} excludeProductId={productId} warnColors />
            </Field>
            <Field label="النوع (اختياري)" hint="حقول وصفية للبحث/التصنيف — لا تغيّر الاسم تلقائياً.">
              <Input value={model.productType} onChange={(e) => set({ productType: e.target.value })} placeholder="قلم جاف" />
            </Field>
            <Field label="الماركة (اختياري)">
              <Input value={model.brand} onChange={(e) => set({ brand: e.target.value })} placeholder="Pilot" dir="auto" />
            </Field>
            <Field label="الموديل (اختياري)">
              <Input value={model.modelName} onChange={(e) => set({ modelName: e.target.value })} placeholder="G-2" dir="auto" />
            </Field>
            <Field label="الفئة / التصنيف">
              <AppSelect
                value={String(model.categoryId)}
                onValueChange={(next) => set({ categoryId: next === "" ? "" : Number(next) })}
                className="h-9 border-input px-3 text-sm"
              >
                <option value="">— بلا فئة —</option>
                {categoryOptionElements(categories)}
              </AppSelect>
            </Field>
            <Field label="رمز المنتج (SKU الأساس)" hint="تُشتقّ منه أكواد المتغيّرات الجديدة تلقائياً." className="md:col-span-2">
              <Input value={model.baseSku} onChange={(e) => set({ baseSku: e.target.value.toUpperCase() })} dir="ltr" placeholder="PG-G2" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">معاينة الكاتالوج</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border bg-muted/30">
              {primaryImage ? (
                <div className="aspect-[4/3] bg-card">
                  <img src={primaryImage.dataUrl || primaryImage.url} alt={name || "صورة المنتج"} className="h-full w-full object-cover" />
                </div>
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-card px-3 text-center font-mono text-[11px] text-muted-foreground">
                  {isEdit ? (name || "—") : "— تُضاف الصورة بعد الحفظ عبر الاستوديو —"}
                </div>
              )}
              <div className="space-y-2 p-3">
                <div className="text-sm font-semibold">{name || <span className="text-muted-foreground">— اسم المنتج —</span>}</div>
                <div className="flex flex-wrap gap-1">{model.baseSku && <Badge variant="outline" dir="ltr">{model.baseSku}</Badge>}</div>
                {model.variants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t pt-1">
                    <span className="text-[11px] text-muted-foreground" dir="ltr">{model.variants.length} متغيّر ({activeCount} مفعّل):</span>
                    {model.variants.slice(0, 10).map((v) => <ColorDot key={v.id} name={v.color} hex={v.colorHex} />)}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* التسعير والتصنيف · مشترك */}
      <Card>
        <CardHeader><CardTitle className="text-base">التسعير والتصنيف · مشترك</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label={costLabel} required hint={model.consignment.isConsignment ? "المبلغ المستحقّ للمودِع عند البيع." : "موحّد لكل الألوان إلا ما له سعر خاص."}>
            <MoneyInput id="product-cost" value={model.costPrice} onChange={(costPrice) => set({ costPrice })} placeholder="150" />
            <ProductCostCoach
              costPrice={model.costPrice}
              baseRetail={model.units.find((u) => u.isBase)?.retail ?? ""}
              categoryId={model.categoryId === "" ? null : Number(model.categoryId)}
              brand={model.brand}
              productType={model.productType}
              productId={productId}
            />
          </Field>
          <Field label="الحد الأدنى الافتراضي" hint="يُطبَّق على المتغيّرات الجديدة.">
            <NumberInput value={model.defaultMin} onChange={(defaultMin) => set({ defaultMin })} className="text-center" ariaLabel="الحد الأدنى الافتراضي" />
          </Field>
          <Field label="خِدمة (بِلا مَخزون)" hint={isEdit ? "لا يَخصُم مَخزوناً ولا يَنزل سالباً. تحويلُ سلعةٍ برصيد إلى خدمة يُرفَض." : "لخدمةٍ بوصفةٍ وموادّ استعمل تبويب «خِدمة»؛ هنا التبديل للتصنيف فقط."}>
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.isService} onCheckedChange={(isService) => set({ isService, ...(isService ? { allowBackorder: false } : {}) })} />
              <span className="text-xs text-muted-foreground">{model.isService ? "خِدمة" : "سِلعة"}</span>
            </div>
          </Field>
          <Field
            label="يُباع بالطلب (قبل التوريد)"
            hint={
              backorderBlocked
                ? "غير متاح: يخصّ السلع المخزنية وحدها (لا خدمة ولا بكج ولا أمانة)."
                : model.allowBackorder
                  ? "يُباع ولو كان الرصيد صفراً أو سالباً؛ السالب = عدد الأعمال المُباعة ولم تُورَّد، ويعود صفراً بفاتورة شراء من مورّد أو بإنتاجٍ داخليّ."
                  : "البيع يتوقّف عند نفاد الرصيد (السلوك المعتاد)."
            }
          >
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.allowBackorder} onCheckedChange={(allowBackorder) => set({ allowBackorder })} disabled={backorderBlocked} />
              <span className="text-xs text-muted-foreground">{model.allowBackorder ? "مسموح" : "متوقف"}</span>
            </div>
          </Field>
          <Field label="قابل للتخصيص">
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.isCustomizable} onCheckedChange={(isCustomizable) => set({ isCustomizable })} disabled={model.isService} />
              <span className="text-xs text-muted-foreground">{model.isCustomizable ? "يدخل كمادة" : "جاهز للبيع"}</span>
            </div>
          </Field>
          <Field label="التوصيات الآلية" hint="يكمل العلاقات اليدوية بمنتجات متاحة من نفس التصنيف.">
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.allowAutoCartRecommendations} onCheckedChange={(allowAutoCartRecommendations) => set({ allowAutoCartRecommendations })} />
              <span className="text-xs text-muted-foreground">{model.allowAutoCartRecommendations ? "مسموح" : "متوقف"}</span>
            </div>
          </Field>
          <Field label="حالة المنتج">
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.isActive} onCheckedChange={(isActive) => set({ isActive })} />
              <span className="text-xs text-muted-foreground">{model.isActive ? "مفعّل" : "معطّل"}</span>
            </div>
          </Field>
          <Field label="نقطة الطباعة والاستنساخ" hint={model.showInPrintPos ? "يَظهر في شبكة «خدمات طباعة» ويُباع عبر كاشير الطباعة." : "لن يَظهر في شبكة خدمات الطباعة."}>
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.showInPrintPos} onCheckedChange={(showInPrintPos) => set({ showInPrintPos })} />
              <span className="text-xs text-muted-foreground">{model.showInPrintPos ? "يظهر" : "مخفيّ"}</span>
            </div>
          </Field>
          <Field label="نقطة خدمة العملاء (الاستقبال)" hint={model.showInReception ? "يَظهر في بحث كاشير الاستقبال ويُباع عبر مسار الاستقبال." : "لن يَظهر في كاشير الاستقبال."}>
            <div className="flex h-9 items-center gap-2">
              <Switch checked={model.showInReception} onCheckedChange={(showInReception) => set({ showInReception })} />
              <span className="text-xs text-muted-foreground">{model.showInReception ? "يظهر" : "مخفيّ"}</span>
            </div>
          </Field>
        </CardContent>
      </Card>

      {/* مساعداتٌ تحتاج سجلاً محفوظاً — تُعرض بوجود المعرّف لا بالوضع (هذا هو الفرق الوحيد المشروع). */}
      {productId != null && (
        <>
          <ProductCustomizationTemplateEditor productId={productId} enabled={model.isCustomizable} />
          <ProductRelatedProductsEditor productId={productId} />
        </>
      )}

      <ProductVariantsFields
        mode={mode}
        model={model}
        onChange={onChange}
        branches={branches}
        branchId={branchId}
        onBranchChange={onBranchChange}
        takenInDb={takenInDb}
        onOpenAliasDialog={onOpenAliasDialog}
      />

      {/* الصور تُنشر بعد الحفظ عبر الاستوديو (الخادم يرفض بايتاتٍ عند الإنشاء — fail-closed). */}
      <ProductMediaContentSection
        description={model.description}
        onDescriptionChange={(description) => set({ description })}
        images={isEdit ? model.images : undefined}
        onImagesChange={isEdit ? (images) => set({ images }) : undefined}
        productExists={isEdit}
      />

      {facts?.isBundle && facts.bundleVariantId != null && (
        <BundleRecipeCard bundleVariantId={Number(facts.bundleVariantId)} />
      )}
    </div>
  );
}
