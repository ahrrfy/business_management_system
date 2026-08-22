// اختبار فصل البدائل المدمجة (وثيقة «الجرد بالباركود» ٢٢/٨، م٤).
import { describe, expect, it, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listSplitCandidates, splitAliasToAlternative } from "../stocktakeService";

const TABLES = [
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.products).values([
    { id: 1, name: "دفتر ٤٠ ورقة" },
    { id: 9, name: "بكج مدرسيّ", isBundle: true },
  ]);
  await d.insert(s.productVariants).values([
    // (1) متغيّر مدمج بباركود أساسيّ + بديلَين ⇒ مرشّح فصل.
    { id: 1, productId: 1, sku: "NB40", costPrice: "1000", variantKind: "VARIANT" },
    // (2) بديلٌ أصليّ (ALTERNATIVE) ⇒ لا يُعاد فصله حتى لو حمل بديلاً.
    { id: 2, productId: 1, sku: "NB40-X", costPrice: "1200", variantKind: "ALTERNATIVE", variantName: "ماركة قديمة" },
    // (9) متغيّر بكج ⇒ يُستبعد من الفصل (بلا وصفةٍ تُنسخ).
    { id: 9, productId: 9, sku: "BNDL", costPrice: "0", variantKind: "VARIANT" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 11, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-MAIN" },
    // وحدةٌ معطَّلة بباركود بديل ⇒ لا تُدرَج مرشّحةً.
    { id: 12, variantId: 1, unitName: "علبة", conversionFactor: "10", isBaseUnit: false, barcode: "BC-BOX", isActive: false },
    // وحدةٌ نشطة غير أساس بباركود بديل ⇒ تُستبعد (الفصل مقصورٌ على وحدة الأساس).
    { id: 13, variantId: 1, unitName: "كرتون", conversionFactor: "12", isBaseUnit: false, barcode: "BC-CTN" },
    { id: 21, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-ALT-BASE" },
    { id: 91, variantId: 9, unitName: "طقم", conversionFactor: "1", isBaseUnit: true, barcode: "BC-BNDL" },
  ]);
  await d.insert(s.productUnitBarcodes).values([
    { id: 101, productUnitId: 11, barcode: "ALIAS-A", note: "ماركة النسر" },
    { id: 102, productUnitId: 11, barcode: "ALIAS-B", note: null },
    { id: 103, productUnitId: 12, barcode: "ALIAS-BOX", note: null }, // وحدة معطَّلة
    { id: 104, productUnitId: 21, barcode: "ALIAS-ALT", note: null }, // على بديلٍ أصليّ
    { id: 105, productUnitId: 13, barcode: "ALIAS-CTN", note: null }, // وحدة نشطة غير أساس
    { id: 106, productUnitId: 91, barcode: "ALIAS-BNDL", note: null }, // بكج
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 11, priceTier: "RETAIL", price: "1500" },
    { productUnitId: 11, priceTier: "WHOLESALE", price: "1300" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("listSplitCandidates (م٤)", () => {
  it("يُدرج الوحدات النشطة (VARIANT) ذات باركودٍ بديل، ويستبعد المعطَّلة والبدائل الأصلية", async () => {
    const rows = await listSplitCandidates();
    expect(rows).toHaveLength(1);
    const c = rows[0];
    expect(c.productUnitId).toBe(11);
    expect(c.variantId).toBe(1);
    expect(c.sku).toBe("NB40");
    expect(c.aliases.map((a) => a.barcode).sort()).toEqual(["ALIAS-A", "ALIAS-B"]);
    // الملاحظة تُنقل كما هي.
    expect(c.aliases.find((a) => a.barcode === "ALIAS-A")?.note).toBe("ماركة النسر");
  });
});

describe("splitAliasToAlternative (م٤)", () => {
  it("يُنشئ متغيّراً مستقلاً (ALTERNATIVE) بوحدة أساسٍ تحمل الباركود المنقول وينسخ الأسعار", async () => {
    const res = await splitAliasToAlternative({
      productUnitId: 11,
      aliasBarcode: "ALIAS-A",
      name: "ماركة النسر",
    });
    expect(res.sourceVariantId).toBe(1);
    // sku مشتقّ: المصدر + ALT + ترتيب (بديلٌ أصليّ واحد قائم ⇒ الترتيب 2).
    expect(res.sku).toBe("NB40-ALT2");

    const d = db();
    const nv = (await d.select().from(s.productVariants).where(eq(s.productVariants.id, res.newVariantId)))[0];
    expect(nv.variantKind).toBe("ALTERNATIVE");
    expect(nv.variantName).toBe("ماركة النسر");
    // التكلفة الافتراضية = تكلفة المصدر (لم تُمرَّر).
    expect(Number(nv.costPrice)).toBe(1000);

    const nu = (await d.select().from(s.productUnits).where(eq(s.productUnits.id, res.newUnitId)))[0];
    expect(nu.barcode).toBe("ALIAS-A");
    expect(nu.isBaseUnit).toBe(true);
    expect(Number(nu.conversionFactor)).toBe(1);

    // الباركود حُذف من البدائل (صار أساسياً للبديل الجديد).
    const alias = await d
      .select()
      .from(s.productUnitBarcodes)
      .where(eq(s.productUnitBarcodes.barcode, "ALIAS-A"));
    expect(alias).toHaveLength(0);

    // الأسعار نُسخت لكل الفئات.
    const prices = await d
      .select()
      .from(s.productPrices)
      .where(eq(s.productPrices.productUnitId, res.newUnitId));
    expect(prices.map((p) => p.priceTier).sort()).toEqual(["RETAIL", "WHOLESALE"]);
  });

  it("يحترم التكلفة المُمرَّرة (آخر شراء معروف)", async () => {
    const res = await splitAliasToAlternative({
      productUnitId: 11,
      aliasBarcode: "ALIAS-B",
      name: "ماركة الغزال",
      cost: "1750",
    });
    const d = db();
    const nv = (await d.select().from(s.productVariants).where(eq(s.productVariants.id, res.newVariantId)))[0];
    expect(Number(nv.costPrice)).toBe(1750);
  });

  it("يرفض اسم بديلٍ مكرّراً ضمن المنتج", async () => {
    await expect(
      splitAliasToAlternative({ productUnitId: 11, aliasBarcode: "ALIAS-A", name: "ماركة قديمة" }),
    ).rejects.toThrow(/بديلٌ بالاسم/);
  });

  it("يرفض باركوداً ليس بديلاً لهذه الوحدة", async () => {
    await expect(
      splitAliasToAlternative({ productUnitId: 11, aliasBarcode: "NOT-AN-ALIAS", name: "س" }),
    ).rejects.toThrow(/ليس بديلاً/);
  });

  it("يرفض الاسم الفارغ", async () => {
    await expect(
      splitAliasToAlternative({ productUnitId: 11, aliasBarcode: "ALIAS-A", name: "  " }),
    ).rejects.toThrow(/اسم البديل مطلوب/);
  });

  it("يرفض فصل وحدةٍ غير أساس (يفسد التقييم/COGS)", async () => {
    await expect(
      splitAliasToAlternative({ productUnitId: 13, aliasBarcode: "ALIAS-CTN", name: "ماركة الكرتون" }),
    ).rejects.toThrow(/وحدة الأساس/);
  });

  it("يرفض الفصل من متغيّرٍ بديلٍ أصليّ (لا بديلَ فوق بديل)", async () => {
    await expect(
      splitAliasToAlternative({ productUnitId: 21, aliasBarcode: "ALIAS-ALT", name: "س" }),
    ).rejects.toThrow(/بديلٌ أصليّ/);
  });

  it("يرفض الفصل من بكج (بلا وصفةٍ تُنسخ)", async () => {
    await expect(
      splitAliasToAlternative({ productUnitId: 91, aliasBarcode: "ALIAS-BNDL", name: "س" }),
    ).rejects.toThrow(/البكج والخدمة/);
  });

  it("SKU طويلٌ قربَ حدّ العمود لا يتجاوز ٦٠ محرفاً بعد اللاحقة", async () => {
    const longSku = "X".repeat(58); // 58 + "-ALT2" = 63 > 60 ⇒ يجب أن يُقتطع
    await db().update(s.productVariants).set({ sku: longSku }).where(eq(s.productVariants.id, 1));
    const res = await splitAliasToAlternative({
      productUnitId: 11,
      aliasBarcode: "ALIAS-A",
      name: "ماركة السقف",
    });
    expect(res.sku.length).toBeLessThanOrEqual(60);
    expect(res.sku.endsWith("-ALT2")).toBe(true);
  });

  it("بعد الفصل: الوحدة المصدر لم يبقَ لها ذلك البديل ⇒ يختفي من المرشّحات إن نفدت بدائلها", async () => {
    await splitAliasToAlternative({ productUnitId: 11, aliasBarcode: "ALIAS-A", name: "ماركة النسر" });
    await splitAliasToAlternative({ productUnitId: 11, aliasBarcode: "ALIAS-B", name: "ماركة الغزال" });
    const rows = await listSplitCandidates();
    // الوحدة 11 لم يبقَ لها بديل، والوحدتان الجديدتان بديلان أصليّان (مستبعدتان) ⇒ لا مرشّح.
    expect(rows).toHaveLength(0);
    // تحقّق أنّ البديلين الجديدين موجودان فعلاً.
    const d = db();
    const alts = await d
      .select()
      .from(s.productVariants)
      .where(and(eq(s.productVariants.productId, 1), eq(s.productVariants.variantKind, "ALTERNATIVE")));
    expect(alts).toHaveLength(3); // القديم + جديدان
  });
});
