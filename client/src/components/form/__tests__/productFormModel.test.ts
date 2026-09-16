/**
 * نموذجُ شاشة المنتج (م٦ ق٤) — اختبارٌ نقيّ بلا React ولا قاعدة.
 * يثبت: التهيئة من مستند الخادم تعكس منطق التعديل (بادئة SKU، السعر الخاصّ)، والتحقّقُ يُرجع **كلَّ**
 * الأسباب، والحمولتان تحملان الحقول الثمانية التي كانت منحرفة بين الشاشتين، والتوليدُ غير متلف.
 */
import { describe, expect, it } from "vitest";
import {
  buildCreateProductPayload,
  buildUpdateProductPayload,
  emptyProductFormModel,
  generateVariants,
  productFormModelFromDocument,
  productFormSignature,
  validateProductForm,
  type ProductEditDocument,
} from "../product/productFormModel";

function serverDoc(): ProductEditDocument {
  return {
    id: 7,
    name: "قلم جاف",
    productType: "قلم",
    brand: "Pilot",
    modelName: "G-2",
    description: null,
    internalName: null,
    storeTitle: null,
    seoTitle: null,
    shortTitle: null,
    posLabel: null,
    invoiceLabel: null,
    marketingCopy: null,
    categoryId: 3,
    isCustomizable: false,
    allowAutoCartRecommendations: true,
    isService: false,
    allowBackorder: true,
    isBundle: false,
    isActive: true,
    showInReception: true,
    showInPrintPos: false,
    isConsignment: false,
    consignorId: null,
    consignorName: null,
    unitTemplate: [
      { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, retail: "1000.00", wholesale: "900.00", government: "" },
      { unitName: "درزن", conversionFactor: "12", isBaseUnit: false, isStoreSaleUnit: false, retail: "11000.00", wholesale: "", government: "" },
    ],
    variants: [
      { id: 21, sku: "PG-G2-BLK", variantKind: "VARIANT", variantName: null, color: "أسود", colorHex: null, size: null, costPrice: "500.00", baseRetail: "1000.00", reorderPoint: 2, minStock: 1, isActive: true, unitBarcodes: { قطعة: "6210000000017" }, stockByBranch: { 1: 40 }, image: null },
      { id: 22, sku: "PG-G2-RED", variantKind: "VARIANT", variantName: null, color: "أحمر", colorHex: "#ff0000", size: null, costPrice: "500.00", baseRetail: "1250.00", reorderPoint: 0, minStock: 0, isActive: false, unitBarcodes: {}, stockByBranch: {}, image: null },
    ],
    images: [],
  };
}

describe("productFormModelFromDocument — التهيئة من الخادم", () => {
  it("تشتقّ بادئة SKU وتكشف السعر الخاصّ وتحمل الحقول الثمانية", () => {
    const m = productFormModelFromDocument(serverDoc());
    expect(m.productName).toBe("قلم جاف");
    expect(m.baseSku).toBe("PG-G2");
    expect(m.costPrice).toBe("500.00");
    expect(m.allowBackorder).toBe(true);
    expect(m.showInReception).toBe(true);
    expect(m.units.map((u) => u.name)).toEqual(["قطعة", "درزن"]);
    expect(m.nextUnitId).toBe(3);
    expect(m.variants[0]).toMatchObject({ id: "db:21", priceOverride: false, retail: "", unitBarcodes: { 1: "6210000000017", 2: "" } });
    // الأحمر سعرُ مفرده 1250 يخالف القالب 1000 ⇒ سعرٌ خاصّ.
    expect(m.variants[1]).toMatchObject({ id: "db:22", priceOverride: true, retail: "1250.00", isActive: false });
  });
});

describe("validateProductForm — كلُّ الأسباب لا أوّلُها", () => {
  it("النموذجُ الفارغ يعلن الاسم والتكلفة والمتغيّرات معاً", () => {
    const reasons = validateProductForm(emptyProductFormModel());
    expect(reasons).toEqual([
      "اسم المنتج مطلوب (اكتبه مباشرةً أو املأ النوع/الماركة/الموديل).",
      "سعر التكلفة المشترك مطلوب.",
      "أضف متغيّراً واحداً على الأقل (اكتب لوناً ثم «ولّد المتغيّرات»).",
    ]);
  });

  it("المستند الصالح يمرّ، ومعاملُ وحدةٍ أكبر ≤ 1 وباركودٌ مكرّر يُعلَنان", () => {
    const ok = productFormModelFromDocument(serverDoc());
    expect(validateProductForm(ok)).toEqual([]);
    const bad = { ...ok, units: ok.units.map((u) => (u.isBase ? u : { ...u, factor: "1" })) };
    bad.variants = bad.variants.map((v) => ({ ...v, unitBarcodes: { 1: "6210000000017" } }));
    expect(validateProductForm(bad)).toEqual([
      "الوحدة الأكبر من الأساس (درزن/كرتون) تحتاج معامل تحويل أكبر من ١ في قالب الوحدات.",
      "باركود مكرّر داخل النموذج: 6210000000017 — لكل وحدة/لون/بديل باركود فريد.",
    ]);
  });
});

describe("الحمولتان — الحقولُ التي كانت منحرفة بين الشاشتين تُرسَل في الوضعين", () => {
  it("createProduct تحمل showInPrintPos/allowAutoCartRecommendations/isActive/isService/allowBackorder", () => {
    const m = { ...productFormModelFromDocument(serverDoc()), showInPrintPos: true, allowAutoCartRecommendations: false, isActive: false };
    const p = buildCreateProductPayload(m, [{ id: 1 }]);
    expect(p).toMatchObject({ name: "قلم جاف", isService: false, allowBackorder: true, showInReception: true, showInPrintPos: true, allowAutoCartRecommendations: false, isActive: false });
    expect(p.variants[0].units[0]).toMatchObject({ unitName: "قطعة", isBaseUnit: true, barcode: "6210000000017", prices: [{ priceTier: "RETAIL", price: "1000.00" }, { priceTier: "WHOLESALE", price: "900.00" }] });
    // الأحمر بسعرٍ خاصّ ⇒ سعرُ وحدة الأساس من السطر لا القالب.
    expect(p.variants[1].units[0].prices[0]).toEqual({ priceTier: "RETAIL", price: "1250.00" });
  });

  it("updateProductVariants تحمل المعرّفات المحفوظة والسعر الخاصّ وسبب التعديل", () => {
    const m = productFormModelFromDocument(serverDoc());
    const p = buildUpdateProductPayload(m, 7, "تصحيح");
    expect(p).toMatchObject({ productId: 7, updateReason: "تصحيح", name: "قلم جاف", allowBackorder: true, showInReception: true, showInPrintPos: false });
    expect(p.variants.map((v) => v.id)).toEqual([21, 22]);
    expect(p.variants[0].baseRetail).toBeUndefined();
    expect(p.variants[1].baseRetail).toBe("1250.00");
    expect(p.variants[0].unitBarcodes).toEqual({ قطعة: "6210000000017" });
    // الخدمة تُصفّر «يُباع بالطلب» فلا تصل تركيبةٌ يرفضها CHECK.
    expect(buildUpdateProductPayload({ ...m, isService: true }, 7).allowBackorder).toBe(false);
  });

  it("Codex #1010: الخدمةُ لا تُرسل رصيداً افتتاحياً (setStock يبتلعه صامتاً)", () => {
    const m = productFormModelFromDocument(serverDoc()); // المتغيّر ٢١ برصيد فرعٍ 40
    expect(buildCreateProductPayload(m, [{ id: 1 }]).variants[0].openingStockByBranch).toEqual([{ branchId: 1, qty: 40 }]);
    expect(buildCreateProductPayload({ ...m, isService: true }, [{ id: 1 }]).variants[0].openingStockByBranch).toEqual([]);
  });

  it("Codex #1010: الحمولةُ تُصفّر تركيباتِ الأمانة/الخدمة/«يُباع بالطلب» المرفوضة", () => {
    const m = productFormModelFromDocument(serverDoc()); // allowBackorder=true، بلا أمانة
    // أمانة + «يُباع بالطلب» ⇒ يُصفَّر backorder، والأمانةُ تبقى.
    const consign = { ...m, allowBackorder: true, consignment: { isConsignment: true, consignorId: 5 } };
    expect(buildCreateProductPayload(consign, [{ id: 1 }])).toMatchObject({ allowBackorder: false, isConsignment: true, consignorId: 5 });
    // خدمة + أمانة ⇒ الأمانةُ والمودِعُ وbackorder تُصفَّر كلُّها (create + update).
    const svcConsign = { ...m, isService: true, allowBackorder: true, consignment: { isConsignment: true, consignorId: 5 } };
    expect(buildCreateProductPayload(svcConsign, [{ id: 1 }])).toMatchObject({ isService: true, isConsignment: false, consignorId: null, allowBackorder: false });
    expect(buildUpdateProductPayload(svcConsign, 7)).toMatchObject({ isConsignment: false, consignorId: null, allowBackorder: false });
  });
});

describe("generateVariants — دمجٌ غير متلف في الوضعين", () => {
  it("الصفوف خارج المصفوفة تبقى، والمشمولةُ تُحدَّث أو تُنشأ", () => {
    const m = { ...productFormModelFromDocument(serverDoc()), colors: ["أسود", "أزرق"], sizes: [], excluded: [] };
    const out = generateVariants(m);
    expect(out.map((v) => v.color)).toEqual(["أحمر", "أسود", "أزرق"]);
    expect(out.find((v) => v.color === "أسود")?.id).toBe("db:21"); // الموجود بقي بمعرّفه
    expect(out.find((v) => v.color === "أزرق")?.sku).toBe("PG-G2-BLU");
  });

  it("Codex #1010: إعادةُ التوليد تُسقط متغيّراً مُستبعَداً صراحةً وتُبقي غيرَ المتّصل بالمصفوفة", () => {
    // «أسود» موجودٌ (db:21) لكنّه مُستبعَدٌ بنقر الخليّة ⇒ يُسقَط؛ «أحمر» (db:22) خارج المصفوفة ⇒ يبقى.
    const m = { ...productFormModelFromDocument(serverDoc()), colors: ["أسود"], sizes: [], excluded: ["أسود|"] };
    const colors = generateVariants(m).map((v) => v.color);
    expect(colors).not.toContain("أسود");
    expect(colors).toContain("أحمر");
  });

  it("التوقيعُ يتغيّر بتغيّر أيّ حقل ويتجاهل بايتات الصور", () => {
    const a = emptyProductFormModel();
    expect(productFormSignature(a)).toBe(productFormSignature(emptyProductFormModel()));
    expect(productFormSignature({ ...a, productName: "x" })).not.toBe(productFormSignature(a));
    const img = { id: "dbimg:1", dataUrl: "data:image/png;base64,AAAA", url: "data:image/png;base64,AAAA", isPrimary: true };
    expect(productFormSignature({ ...a, images: [img] })).not.toContain("base64");
  });
});
