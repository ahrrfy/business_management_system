/**
 * فرقُ لقطتَي منتج — اختبارٌ نقيّ بلا قاعدة (م٦ ق٨).
 * يثبت: (١) لقطتان متطابقتان ⇒ صفر صفوف؛ (٢) تغيّرُ الاسم وسعر وحدةٍ يظهر بتسمية الشاشة؛
 * (٣) الوحدةُ/المتغيّرُ المضاف والمحذوف يُعلَنان؛ (٤) الصورُ تُقارَن بمرجعها لا ببايتاتها؛
 * (٥) `changedFieldLabels` بلا تكرار وبترتيب الظهور.
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCT_SNAPSHOT_KIND,
  isProductSnapshotDocument,
  type ProductSnapshotDocument,
} from "./productSnapshot";
import { changedFieldLabels, diffProductSnapshots, displayChangeValue } from "./productVersionDiff";

function doc(overrides: Partial<ProductSnapshotDocument> = {}): ProductSnapshotDocument {
  return {
    kind: PRODUCT_SNAPSHOT_KIND,
    id: 7,
    name: "دفتر 100 ورقة",
    productType: "قرطاسية",
    brand: null,
    modelName: null,
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
    allowBackorder: false,
    isBundle: false,
    isActive: true,
    showInReception: false,
    showInPrintPos: false,
    isConsignment: false,
    consignorId: null,
    consignorName: null,
    unitTemplate: [
      { unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, retail: "1000.00", wholesale: "900.00", government: "" },
      { unitName: "درزن", conversionFactor: "12", isBaseUnit: false, isStoreSaleUnit: false, retail: "11000.00", wholesale: "", government: "" },
    ],
    variants: [
      {
        id: 1, sku: "NB-100", variantKind: "VARIANT", variantName: null, color: "أزرق", colorHex: null, size: null,
        costPrice: "500.00", baseRetail: "1000.00", reorderPoint: 0, minStock: 0, isActive: true,
        unitBarcodes: { قطعة: "BC-PIECE-1", درزن: "BC-DOZEN-1" }, imageRef: null,
      },
    ],
    images: [{ id: 40, isPrimary: true, sortOrder: 0, ref: "data-url:abcdef0123456789:4096" }],
    ...overrides,
  };
}

describe("diffProductSnapshots — «ما الذي تغيّر»", () => {
  it("لقطتان متطابقتان ⇒ لا صفوف", () => {
    expect(diffProductSnapshots(doc(), doc())).toEqual([]);
  });

  it("تغيّرُ الاسم وسعر وحدة يظهر بتسمية الشاشة وقيمتَيه قبل/بعد — مرّةً واحدة لا لكلّ متغيّر", () => {
    // سعرُ القالب يتغيّر ⇒ `baseRetail` كلّ متغيّرٍ يتبعه على الخادم؛ صفٌّ واحد للوحدة لا N+1.
    const after = doc({
      name: "دفتر 100 ورقة — طبعة 2026",
      unitTemplate: doc().unitTemplate.map((u) => (u.unitName === "قطعة" ? { ...u, retail: "1250.00" } : u)),
      variants: doc().variants.map((v) => ({ ...v, baseRetail: "1250.00" })),
    });
    const rows = diffProductSnapshots(doc(), after);
    expect(rows).toEqual([
      { path: "name", label: "اسم المنتج", before: "دفتر 100 ورقة", after: "دفتر 100 ورقة — طبعة 2026" },
      { path: "unit:قطعة.retail", label: "الوحدة «قطعة» — سعر المفرد", before: "1000.00", after: "1250.00" },
    ]);
    expect(changedFieldLabels(rows)).toEqual(["اسم المنتج", "الوحدة «قطعة» — سعر المفرد"]);
  });

  it("سعرُ المفرد الخاصّ بالمتغيّر يظهر حين يخالف القالب فقط", () => {
    const special = doc({ variants: doc().variants.map((v) => ({ ...v, baseRetail: "950.00" })) });
    expect(diffProductSnapshots(doc(), special)).toEqual([
      { path: "variant:1.baseRetail", label: "المتغير «أزرق» — سعر المفرد الخاص", before: null, after: "950.00" },
    ]);
  });

  it("القيم المنطقية تُعرض نعم/لا، والفارغُ «—»", () => {
    const rows = diffProductSnapshots(doc(), doc({ allowBackorder: true, brand: "Pilot" }));
    expect(rows).toEqual([
      { path: "brand", label: "الماركة", before: null, after: "Pilot" },
      { path: "allowBackorder", label: "يباع بالطلب", before: "لا", after: "نعم" },
    ]);
    expect(displayChangeValue(null)).toBe("—");
    expect(displayChangeValue("Pilot")).toBe("Pilot");
  });

  it("وحدةٌ محذوفة ومتغيّرٌ مضاف وباركودٌ متغيّر — كلٌّ بصفّه", () => {
    const base = doc();
    const after = doc({
      unitTemplate: [base.unitTemplate[0]],
      variants: [
        { ...base.variants[0], unitBarcodes: { قطعة: "BC-PIECE-NEW" } },
        { ...base.variants[0], id: 2, sku: "NB-100-RED", color: "أحمر" },
      ],
    });
    const rows = diffProductSnapshots(base, after);
    expect(rows.map((r) => r.path)).toEqual([
      "unit:درزن",
      "variant:1.barcode:قطعة",
      "variant:1.barcode:درزن",
      "variant:2",
    ]);
    expect(rows[0]).toMatchObject({ before: "موجودة", after: "محذوفة" });
    expect(rows[3]).toMatchObject({ label: "المتغير «أحمر»", before: null, after: "مضاف" });
  });

  it("الصورُ تُقارَن بمرجع المحتوى (بصمة) لا ببايتات — والاستبدالُ يظهر تغييراً", () => {
    const rows = diffProductSnapshots(
      doc(),
      doc({ images: [{ id: 40, isPrimary: true, sortOrder: 0, ref: "data-url:ffffffffffffffff:8192" }] }),
    );
    expect(rows).toEqual([
      { path: "image:40.ref", label: "الصورة #40 — المحتوى", before: "data-url:abcdef0123456789:4096", after: "data-url:ffffffffffffffff:8192" },
    ]);
  });

  it("المودِع يُعرض باسمه حين يُعرف", () => {
    const rows = diffProductSnapshots(doc(), doc({ isConsignment: true, consignorId: 9, consignorName: "دار المعارف" }));
    expect(rows).toEqual([
      { path: "isConsignment", label: "بضاعة أمانة", before: "لا", after: "نعم" },
      { path: "consignorId", label: "المودع", before: null, after: "دار المعارف" },
    ]);
  });

  it("changedFieldLabels بلا تكرار وبترتيب الظهور", () => {
    const rows = [
      { path: "a", label: "اسم المنتج", before: "1", after: "2" },
      { path: "b", label: "الماركة", before: null, after: "x" },
      { path: "c", label: "اسم المنتج", before: "2", after: "3" },
    ];
    expect(changedFieldLabels(rows)).toEqual(["اسم المنتج", "الماركة"]);
  });
});

describe("isProductSnapshotDocument — حارس الشكل قبل الاستعادة", () => {
  it("يقبل المستند الموسوم ويرفض ما دونه", () => {
    expect(isProductSnapshotDocument(doc())).toBe(true);
    expect(isProductSnapshotDocument({ ...doc(), kind: "customer.row.v1" })).toBe(false);
    expect(isProductSnapshotDocument({ id: 1, name: "x" })).toBe(false);
    expect(isProductSnapshotDocument(null)).toBe(false);
  });
});
