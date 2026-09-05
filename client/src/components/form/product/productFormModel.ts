/**
 * ═══ نموذجُ شاشة المنتج (بمتغيّرات) — الحالةُ والتحقّقُ والحمولةُ في مكانٍ واحد (م٦ ق٤) ═══
 *
 * **العلّة المقيسة (D5 في مقياس الاحتكاك):** `ProductNew.tsx` و`ProductEdit.tsx` كانتا تحملان
 * ~٢٥ `useState` لكلٍّ، ومُتحقِّقاً محلّياً لكلٍّ، وبانيَ حمولةٍ لكلٍّ — بأسماءٍ مختلفة للحقل نفسه
 * (`productName`/`originalName`) وبحقولٍ في إحداهما دون الأخرى (٨ انحرافات في خطّ أساس
 * `check:form-parity`). فالإصلاحُ في شاشةٍ لا يصل إلى أختها.
 *
 * **الحلّ:** نموذجٌ واحد (`ProductFormModel`) تحمله الشاشتان، ودوالُّ نقيّة بلا React:
 *   • `emptyProductFormModel` / `productFormModelFromDocument` — التهيئة (إنشاء/تعديل).
 *   • `validateProductForm` — **كلُّ** الأسباب التي تمنع الحفظ (لا أوّلُها) ⇒ تُعرض في `SaveBar`.
 *   • `buildCreateProductPayload` / `buildUpdateProductPayload` — الحمولةُ بنوع عقد الراوتر نفسه
 *     (`RouterInputs`) كي يمسك TypeScript أيَّ حقلٍ تعرضه الشاشة ولا يقبله الخادم («الشاشة تكذب»).
 *   • `productFormSignature` — لقطةٌ مرجعية لكشف «تعديلٌ غير محفوظ» بلا علَمٍ يدويّ.
 *
 * ⛔ الملفّ نقيّ (لا React ولا شبكة) — يُختبر في `test:unit`.
 * ⚠️ الأرقامُ لا تُوطَّن هنا؛ العرضُ شأنُ المكوّنات.
 */
import type { ImageItem } from "@/components/form/ImageUploader";
import type { ConsignmentValue } from "@/components/product/ConsignmentField";
import { buildProductImagesPayload, hydrateProductImages } from "@/lib/productImages";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";
import {
  clampInt,
  deriveSku,
  type ClientUnit,
  type ClientVariant,
  type ParsedVariantRow,
} from "@/lib/variants";
import { checkVariantSanity } from "@shared/priceSanity";

export type ProductFormMode = "create" | "edit";

/** مستندُ التعديل كما يُعيده الخادم (`catalog.getForVariantEdit`). */
export type ProductEditDocument = NonNullable<RouterOutputs["catalog"]["getForVariantEdit"]>;

/** معرّفُ صفّ متغيّرٍ محفوظ في القاعدة داخل النموذج: `db:<id>`؛ الجديد مفتاحٌ عشوائيّ. */
export const DB_VARIANT_PREFIX = "db:";
export const isDbVariant = (id: string) => id.startsWith(DB_VARIANT_PREFIX);
export const dbVariantId = (id: string): number | undefined =>
  isDbVariant(id) ? Number(id.slice(DB_VARIANT_PREFIX.length)) : undefined;

export type ProductFormModel = {
  /** اسمُ المنتج الصريح (المرجع)؛ فراغُه ⇒ يُركَّب من النوع/الماركة/الموديل. */
  productName: string;
  productType: string;
  brand: string;
  modelName: string;
  description: string;
  categoryId: number | "";
  /** بادئةُ SKU للمتغيّرات الجديدة. */
  baseSku: string;
  /** سعرُ التكلفة المشترك (بالوحدة الأساس). */
  costPrice: string;
  /** الحدُّ الأدنى الافتراضيّ للمتغيّرات الجديدة. */
  defaultMin: string;
  isCustomizable: boolean;
  allowAutoCartRecommendations: boolean;
  isService: boolean;
  allowBackorder: boolean;
  isActive: boolean;
  showInReception: boolean;
  showInPrintPos: boolean;
  consignment: ConsignmentValue;
  units: ClientUnit[];
  /** التسلسلُ التالي لمعرّف وحدةٍ محلّية. */
  nextUnitId: number;
  variants: ClientVariant[];
  colors: string[];
  sizes: string[];
  /** مفاتيحُ `لون|قياس` المستبعَدة من المولّد. */
  excluded: string[];
  images: ImageItem[];
};

export function emptyProductFormModel(): ProductFormModel {
  return {
    productName: "",
    productType: "",
    brand: "",
    modelName: "",
    description: "",
    categoryId: "",
    baseSku: "",
    costPrice: "",
    defaultMin: "0",
    isCustomizable: false,
    allowAutoCartRecommendations: true,
    isService: false,
    allowBackorder: false,
    isActive: true,
    showInReception: false,
    showInPrintPos: false,
    consignment: { isConsignment: false, consignorId: null },
    units: [{ id: 1, name: "قطعة", factor: "1", isBase: true, sellInStore: true, retail: "", wholesale: "", government: "" }],
    nextUnitId: 2,
    variants: [],
    colors: [],
    sizes: [],
    excluded: [],
    images: [],
  };
}

/** تعبئةٌ من مستند الخادم — نفسُ منطق `ProductEdit` السابق حرفياً (بادئة SKU، السعر الخاصّ، الصور). */
export function productFormModelFromDocument(d: ProductEditDocument): ProductFormModel {
  const units: ClientUnit[] = d.unitTemplate.map((u, i) => ({
    id: i + 1,
    name: u.unitName,
    factor: u.conversionFactor,
    isBase: u.isBaseUnit,
    sellInStore: u.isStoreSaleUnit,
    retail: u.retail,
    wholesale: u.wholesale,
    government: u.government,
  }));
  const sharedCost = d.variants[0]?.costPrice ?? "";
  const tmplBaseRetail = units.find((u) => u.isBase)?.retail ?? "";
  // بادئة SKU مُشتقّة من أوّل متغيّر (إسقاط آخر مقطعين: كود اللون/القياس).
  const firstSku = d.variants[0]?.sku ?? "";
  const skuParts = firstSku.split("-");
  const baseSku = skuParts.slice(0, Math.max(1, skuParts.length - (d.variants[0]?.size ? 2 : 1))).join("-");
  const variants: ClientVariant[] = d.variants.map((v) => {
    const unitBarcodes: Record<number, string> = {};
    for (const cu of units) unitBarcodes[cu.id] = v.unitBarcodes[cu.name] ?? "";
    const stockByBranch: Record<number, string> = {};
    for (const [bid, q] of Object.entries(v.stockByBranch)) stockByBranch[Number(bid)] = String(q);
    const override = v.costPrice !== sharedCost || (v.baseRetail !== "" && v.baseRetail !== tmplBaseRetail);
    return {
      id: `${DB_VARIANT_PREFIX}${v.id}`,
      variantKind: v.variantKind ?? "VARIANT",
      variantName: v.variantName ?? null,
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
  return {
    productName: d.name,
    productType: d.productType ?? "",
    brand: d.brand ?? "",
    modelName: d.modelName ?? "",
    description: d.description ?? "",
    categoryId: d.categoryId ?? "",
    baseSku,
    costPrice: sharedCost,
    defaultMin: "0",
    isCustomizable: d.isCustomizable,
    allowAutoCartRecommendations: d.allowAutoCartRecommendations,
    isService: d.isService,
    allowBackorder: d.allowBackorder,
    isActive: d.isActive,
    showInReception: d.showInReception,
    showInPrintPos: d.showInPrintPos,
    consignment: { isConsignment: d.isConsignment, consignorId: d.consignorId, consignorName: d.consignorName },
    units,
    nextUnitId: units.length + 1,
    variants,
    colors: [],
    sizes: [],
    excluded: [],
    images: hydrateProductImages(d.images),
  };
}

/* ─────────────── مشتقّات ─────────────── */

export const composedName = (m: Pick<ProductFormModel, "productType" | "brand" | "modelName">) =>
  [m.productType, m.brand, m.modelName].map((s) => s.trim()).filter(Boolean).join(" ");

/** الاسمُ الصريح هو المرجع؛ التركيبُ بديلٌ عند فراغه (يطابق `composeName` في الخادم). */
export const finalName = (m: ProductFormModel) => m.productName.trim() || composedName(m);

export const baseRetailOf = (m: ProductFormModel) => m.units.find((u) => u.isBase)?.retail.trim() ?? "";

/** كلُّ باركودات النموذج (الأساسيّة + البدائل المحلّية) — فضاءُ التفرّد الواحد. */
export function allBarcodes(m: ProductFormModel): string[] {
  const set = new Set<string>();
  for (const v of m.variants)
    for (const u of m.units) {
      const c = (v.unitBarcodes[u.id] || "").trim();
      if (c) set.add(c);
      for (const a of v.unitBarcodeAliases?.[u.id] ?? []) {
        const ac = (a.barcode || "").trim();
        if (ac) set.add(ac);
      }
    }
  return Array.from(set);
}

/**
 * لقطةٌ مرجعية لكشف التعديل غير المحفوظ. الصورُ بتوقيعٍ خفيف (المعرّف + الرئيسية + طولُ البايتات)
 * لا بمحتواها — data URL بمئات الكيلوبايتات لا يُقارَن نصّاً كلَّ تصيير.
 */
export function productFormSignature(m: ProductFormModel): string {
  const { images, ...rest } = m;
  return JSON.stringify({
    ...rest,
    images: images.map((i) => `${i.id}:${i.isPrimary ? 1 : 0}:${i.dataUrl.length}`),
  });
}

/* ─────────────── التحقّق — كلُّ الأسباب لا أوّلُها ─────────────── */

/** يُرجع **كلَّ** ما يمنع الحفظ (لعرضه في `SaveBar`)؛ مصفوفة فارغة = صالح. */
export function validateProductForm(m: ProductFormModel): string[] {
  const reasons: string[] = [];
  if (!finalName(m)) reasons.push("اسم المنتج مطلوب (اكتبه مباشرةً أو املأ النوع/الماركة/الموديل).");
  if (!m.costPrice.trim()) reasons.push("سعر التكلفة المشترك مطلوب.");
  if (m.units.some((u) => !u.name.trim())) reasons.push("كل وحدة في القالب تحتاج اسماً.");
  // اسمُ الوحدة مفتاحُ مطابقةٍ في مسار الحفظ ⇒ وحدتان بنفس الاسم تتصادمان فيُطمَس باركود/سعر إحداهما.
  const unitNames = m.units.map((u) => u.name.trim());
  const dupUnitName = unitNames.find((n, i) => n && unitNames.indexOf(n) !== i);
  if (dupUnitName) reasons.push(`اسم وحدة مكرّر في القالب: «${dupUnitName}» — لكل وحدة اسمٌ فريد.`);
  if (m.units.filter((u) => u.isBase).length !== 1) reasons.push("حدّد وحدة أساس واحدة فقط في قالب الوحدات.");
  // الوحدة غير الأساس معاملها أكبر من ١ (درزن=١٢) — بلا ذلك يُخصَم الدرزن قطعةً واحدةً (§٥).
  if (m.units.some((u) => !u.isBase && !(Number((u.factor ?? "").trim()) > 1)))
    reasons.push("الوحدة الأكبر من الأساس (درزن/كرتون) تحتاج معامل تحويل أكبر من ١ في قالب الوحدات.");
  if (!m.variants.length) reasons.push("أضف متغيّراً واحداً على الأقل (اكتب لوناً ثم «ولّد المتغيّرات»).");
  if (m.variants.some((v) => !v.sku.trim())) reasons.push("كل متغيّر يحتاج SKU.");
  const skus = m.variants.map((v) => v.sku.trim());
  const dupSku = skus.find((s, i) => s && skus.indexOf(s) !== i);
  if (dupSku) reasons.push(`SKU مكرّر بين المتغيّرات: ${dupSku} — لكل متغيّر رمز فريد.`);
  const codes: string[] = [];
  for (const v of m.variants)
    for (const u of m.units) {
      const c = (v.unitBarcodes[u.id] || "").trim();
      if (c) codes.push(c);
      for (const a of v.unitBarcodeAliases?.[u.id] ?? []) {
        const ac = (a.barcode || "").trim();
        if (ac) codes.push(ac);
      }
    }
  const dupBc = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dupBc) reasons.push(`باركود مكرّر داخل النموذج: ${dupBc} — لكل وحدة/لون/بديل باركود فريد.`);
  if (m.consignment.isConsignment && !m.consignment.consignorId)
    reasons.push("منتج الأمانة يلزمه مودِع — اختر المودِع أو أطفئ «بضاعة أمانة».");
  // حرّاس عقلانية الأسعار — يمنع «حادثة SINARLINE ٣٠/٧». المصدر: shared/priceSanity.ts (يُشارَك خادمياً).
  for (const v of m.variants) {
    const overrideCost = v.priceOverride && v.costPrice.trim() ? v.costPrice.trim() : m.costPrice.trim();
    const unitPricings = m.units.map((u) => ({
      unitName: u.name.trim() || (u.isBase ? "الأساس" : "وحدة"),
      conversionFactor: u.isBase ? 1 : Number((u.factor ?? "").trim()) || 1,
      retail: u.isBase && v.priceOverride && v.retail.trim() ? v.retail.trim() : u.retail || null,
      wholesale: u.wholesale || null,
      government: u.government || null,
    }));
    const blocker = checkVariantSanity(overrideCost, unitPricings).find((i) => i.level === "blocker");
    if (blocker) reasons.push(`[${v.color || v.sku || "متغيّر"}] ${blocker.message}`);
  }
  return Array.from(new Set(reasons));
}

/* ─────────────── الحمولات — بنوع عقد الراوتر ─────────────── */

type CreatePayload = RouterInputs["catalog"]["createProduct"];
type UpdatePayload = RouterInputs["catalog"]["updateProductVariants"];
type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

function unitPrices(retail: string, wholesale: string, government: string): Array<{ priceTier: PriceTier; price: string }> {
  return [
    ...(retail.trim() ? [{ priceTier: "RETAIL" as const, price: retail.trim() }] : []),
    ...(wholesale.trim() ? [{ priceTier: "WHOLESALE" as const, price: wholesale.trim() }] : []),
    // GOVERNMENT يجب إعادة إرساله دائماً: upsert يمسح كل أسعار الوحدة ثم يُدرِج المُرسَل فقط.
    ...(government.trim() ? [{ priceTier: "GOVERNMENT" as const, price: government.trim() }] : []),
  ];
}

export function buildCreateProductPayload(m: ProductFormModel, branches: ReadonlyArray<{ id: number }>): CreatePayload {
  return {
    name: finalName(m) || undefined,
    productType: m.productType.trim() || null,
    brand: m.brand.trim() || null,
    modelName: m.modelName.trim() || null,
    description: m.description.trim() || null,
    categoryId: m.categoryId === "" ? undefined : Number(m.categoryId),
    isCustomizable: m.isCustomizable,
    isService: m.isService,
    allowBackorder: m.isService ? false : m.allowBackorder,
    showInReception: m.showInReception,
    showInPrintPos: m.showInPrintPos,
    allowAutoCartRecommendations: m.allowAutoCartRecommendations,
    isActive: m.isActive,
    isConsignment: m.consignment.isConsignment,
    consignorId: m.consignment.isConsignment ? m.consignment.consignorId : null,
    variants: m.variants.map((v) => {
      const overrideCost = v.priceOverride && v.costPrice.trim() ? v.costPrice.trim() : m.costPrice.trim();
      return {
        sku: v.sku.trim(),
        color: v.color.trim() || undefined,
        colorHex: v.colorHex || undefined,
        size: v.size.trim() || undefined,
        costPrice: overrideCost,
        minStock: clampInt(v.minStock),
        reorderPoint: clampInt(v.reorderPoint),
        isActive: v.isActive,
        openingStockByBranch: branches
          .map((b) => ({ branchId: b.id, qty: clampInt(v.stockByBranch[b.id] || "0") }))
          .filter((x) => x.qty > 0),
        units: m.units.map((u) => {
          const retail = u.isBase && v.priceOverride && v.retail.trim() ? v.retail.trim() : u.retail.trim();
          const aliases = (v.unitBarcodeAliases?.[u.id] ?? [])
            .map((a) => ({ barcode: (a.barcode || "").trim(), note: a.note ?? null }))
            .filter((a) => a.barcode);
          return {
            unitName: u.name.trim(),
            conversionFactor: u.isBase ? "1" : u.factor.trim() || "1",
            barcode: (v.unitBarcodes[u.id] || "").trim() || undefined,
            isBaseUnit: u.isBase,
            isStoreSaleUnit: u.sellInStore,
            prices: unitPrices(retail, u.wholesale, u.government ?? ""),
            barcodeAliases: aliases.length ? aliases : undefined,
          };
        }),
      };
    }),
  };
}

export function buildUpdateProductPayload(m: ProductFormModel, productId: number, updateReason?: string | null): UpdatePayload {
  return {
    productId,
    updateReason: updateReason ?? undefined,
    name: finalName(m) || null,
    productType: m.productType.trim() || null,
    brand: m.brand.trim() || null,
    modelName: m.modelName.trim() || null,
    description: m.description.trim() || null,
    categoryId: m.categoryId === "" ? null : Number(m.categoryId),
    isCustomizable: m.isCustomizable,
    allowAutoCartRecommendations: m.allowAutoCartRecommendations,
    isService: m.isService,
    // التبديل معطَّلٌ بصرياً على الخدمة، لكن قيمةً قديمة قد تبقى في الحالة ⇒ نُصفّرها فلا تصل تركيبةٌ يرفضها CHECK.
    allowBackorder: m.isService ? false : m.allowBackorder,
    isActive: m.isActive,
    showInReception: m.showInReception,
    showInPrintPos: m.showInPrintPos,
    isConsignment: m.consignment.isConsignment,
    consignorId: m.consignment.consignorId,
    unitTemplate: m.units.map((u) => ({
      unitName: u.name.trim(),
      conversionFactor: u.isBase ? "1" : u.factor.trim() || "1",
      isBaseUnit: u.isBase,
      isStoreSaleUnit: u.sellInStore,
      prices: unitPrices(u.retail, u.wholesale, u.government ?? ""),
    })),
    variants: m.variants.map((v) => {
      const unitBarcodes: Record<string, string> = {};
      for (const u of m.units) {
        const b = (v.unitBarcodes[u.id] || "").trim();
        if (b) unitBarcodes[u.name.trim()] = b;
      }
      return {
        id: dbVariantId(v.id),
        sku: v.sku.trim(),
        variantKind: v.variantKind ?? "VARIANT",
        variantName: v.variantName?.trim() || null,
        color: v.color.trim() || null,
        colorHex: v.colorHex || null,
        size: v.size.trim() || null,
        costPrice: v.priceOverride && v.costPrice.trim() ? v.costPrice.trim() : m.costPrice.trim(),
        baseRetail: v.priceOverride && v.retail.trim() ? v.retail.trim() : undefined,
        minStock: clampInt(v.minStock),
        reorderPoint: clampInt(v.reorderPoint),
        isActive: v.isActive,
        // لا نعيد إرسال URL/data URL الإرثي في كل حفظ؛ null فقط إشارة إزالة صريحة.
        image: v.image === null ? null : undefined,
        unitBarcodes,
      };
    }),
    // صور المنتج العامّة: معرّفات وmetadata فقط؛ الفارغة توفّق الحذف ولا تمرّر بايتات.
    images: buildProductImagesPayload(m.images),
  };
}

/* ─────────────── المتغيّرات: توليدٌ واستيراد (نقيّ) ─────────────── */

export function makeVariant(m: ProductFormModel, color: string, size: string): ClientVariant {
  return {
    id: `new|${color}|${size}|${Math.random().toString(36).slice(2, 8)}`,
    color,
    colorHex: null,
    size,
    sku: deriveSku(m.baseSku, color, size),
    unitBarcodes: {},
    stockByBranch: {},
    minStock: m.defaultMin || "0",
    reorderPoint: "0",
    priceOverride: false,
    costPrice: "",
    retail: "",
    isActive: true,
    image: null,
    unitBarcodeAliases: {},
  };
}

/**
 * توليدُ المتغيّرات من المصفوفة — **دمجٌ غير متلف** في الوضعين: الصفوف خارج المصفوفة تبقى كما هي
 * (كانت شاشة الإنشاء تُسقطها — سلوكٌ مختلفٌ عن التعديل لشيءٍ واحد)، والمشمولةُ تُحدَّث أو تُنشأ.
 */
export function generateVariants(m: ProductFormModel): ClientVariant[] {
  const excluded = new Set(m.excluded);
  const combos: Array<[string, string]> = [];
  for (const c of m.colors) {
    if (m.sizes.length) {
      for (const s of m.sizes) if (!excluded.has(`${c}|${s}`)) combos.push([c, s]);
    } else combos.push([c, ""]);
  }
  const byKey = new Map(m.variants.map((v) => [`${v.color}|${v.size}`, v]));
  const genKeys = new Set(combos.map(([c, s]) => `${c}|${s}`));
  const kept = m.variants.filter((v) => !genKeys.has(`${v.color}|${v.size}`));
  const generated = combos.map(([c, s]) => {
    const ex = byKey.get(`${c}|${s}`);
    return ex ? { ...ex, sku: ex.sku || deriveSku(m.baseSku, c, s) } : makeVariant(m, c, s);
  });
  return [...kept, ...generated];
}

/** استيراد/لصق صفوف — دمجٌ غير متلف؛ المخزونُ يُطبَّق حين يكون قابلاً للتحرير (الإنشاء) فقط. */
export function applyImportRows(
  m: ProductFormModel,
  rows: ParsedVariantRow[],
  branchId: number,
  stockEditable: boolean,
): ClientVariant[] {
  const out = [...m.variants];
  const idxByKey = new Map(out.map((v, i) => [`${v.color}|${v.size}`, i]));
  for (const r of rows) {
    const key = `${r.color}|${r.size}`;
    const existingIdx = idxByKey.get(key);
    if (existingIdx != null) {
      const cur = out[existingIdx];
      const unitBarcodes = { ...cur.unitBarcodes };
      r.barcodes.forEach((b, i) => {
        const u = m.units[i];
        if (u && b) unitBarcodes[u.id] = b;
      });
      out[existingIdx] = {
        ...cur,
        sku: r.sku || cur.sku,
        unitBarcodes,
        ...(stockEditable
          ? { stockByBranch: { ...cur.stockByBranch, [branchId]: r.stock || cur.stockByBranch[branchId] || "0" } }
          : {}),
      };
    } else {
      const base = makeVariant(m, r.color, r.size);
      if (r.sku) base.sku = r.sku;
      r.barcodes.forEach((b, i) => {
        const u = m.units[i];
        if (u && b) base.unitBarcodes[u.id] = b;
      });
      if (stockEditable) base.stockByBranch = { [branchId]: r.stock || "0" };
      idxByKey.set(key, out.length);
      out.push(base);
    }
  }
  return out;
}
