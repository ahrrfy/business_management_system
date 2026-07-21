/**
 * productEditService.ts — تعديل منتج بنموذج المتغيّرات المستقلة (product-variants).
 *
 * شقيق `catalogService.createProduct` لكن للتعديل: يقرأ المنتج بكامل متغيّراته/وحداته/
 * أسعاره (مع reorderPoint/isActive)، ويحدّثه ضمن معاملة ذرّية واحدة — يحدّث المتغيّرات
 * الموجودة، يضيف الجديدة، ويعطّل (لا يحذف) ما يُلغى حفظاً للمخزون والحركات والتاريخ.
 *
 * الوحدات قالبٌ مشترك (اسم/معامل/سعر) تُطابَق بالاسم لكل متغيّر، **والباركود مستقل لكل
 * (متغيّر×وحدة)**. لا يلمس المخزون — أرصدة الفروع تُدار عبر شاشات الجرد/الحركات.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { branchStock, productImages, productPrices, productUnits, productVariants, products, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import type { Tx } from "../db";
import { findBarcodeClashes, migrateAliases } from "./catalog/barcodeAliases";
import { assertValidUnitFactors } from "./catalog/unitFactors";
import { toDbMoney } from "./money";
import type { PriceTier } from "./pricing";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

/* ============================ القراءة (للتعديل) ============================ */

export interface VariantEditUnit {
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  retail: string; // سعر المفرد (RETAIL) — فارغ إن لم يُعرَّف
  wholesale: string; // سعر الجملة (WHOLESALE)
  government: string; // سعر الحكومي (GOVERNMENT) — يجب أن يُعاد إرساله عند الحفظ وإلّا حُذف (upsert يمسح ثم يُدرِج)
}

export interface VariantEditRow {
  id: number;
  sku: string;
  color: string | null;
  /** لون العرض الحقيقي «#RRGGBB» (اختيار صريح) أو null ⇒ يُستنتَج من الاسم. */
  colorHex: string | null;
  size: string | null;
  costPrice: string;
  /** سعر مفرد وحدة الأساس لهذا المتغيّر — لكشف «السعر الخاص» عند التحميل (يمنع طمسه عند الحفظ). */
  baseRetail: string;
  reorderPoint: number;
  minStock: number;
  isActive: boolean;
  /** باركود مستقل لكل وحدة, مفتاحه اسم الوحدة. */
  unitBarcodes: Record<string, string>;
  /** رصيد الفرع الحالي لكل فرع (قراءة فقط في التعديل). */
  stockByBranch: Record<number, number>;
  /** صورة هذا اللون (data URL) أو null. */
  image: string | null;
}

export interface ProductForVariantEdit {
  id: number;
  name: string;
  productType: string | null;
  brand: string | null;
  modelName: string | null;
  description: string | null;
  categoryId: number | null;
  isCustomizable: boolean;
  isService: boolean;
  /** gstack B12 (٧/٧/٢٦): علم البكج — يُشغّل تبويب وصفة المكوّنات في ProductEdit. */
  isBundle: boolean;
  isActive: boolean;
  // بضاعة الأمانة (٢٠/٧): الوسم + المودِع (اسمه للعرض) — للبانر العلوي وإعادة تسمية «التكلفة»→«حصة المودِع».
  isConsignment: boolean;
  consignorId: number | null;
  consignorName: string | null;
  /** قالب الوحدات المشترك — مُشتقّ من وحدات أوّل متغيّر فعّال (النموذج يصنعها موحّدة). */
  unitTemplate: VariantEditUnit[];
  variants: VariantEditRow[];
}

/** يقرأ منتجاً بكامل متغيّراته/وحداته/أسعاره/أرصدته لتعبئة شاشة التعديل. */
export async function getProductForVariantEdit(productId: number): Promise<ProductForVariantEdit | null> {
  const db = getDb();
  if (!db) return null;
  const p = (await db.select().from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!p) return null;

  // بضاعة الأمانة: اسم المودِع للعرض (قراءة واحدة عند وجود ربط فقط).
  let consignorName: string | null = null;
  if (p.consignorId != null) {
    const [c] = await db.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, Number(p.consignorId))).limit(1);
    consignorName = c?.name ?? null;
  }
  const consignFields = {
    isConsignment: !!p.isConsignment,
    consignorId: p.consignorId != null ? Number(p.consignorId) : null,
    consignorName,
  };

  const variants = await db.select().from(productVariants).where(eq(productVariants.productId, productId));
  if (!variants.length) {
    return {
      id: Number(p.id),
      name: p.name,
      productType: p.productType,
      brand: p.brand,
      modelName: p.modelName,
      description: p.description,
      categoryId: p.categoryId != null ? Number(p.categoryId) : null,
      isCustomizable: !!p.isCustomizable,
      isService: !!p.isService,
      isBundle: !!p.isBundle,
      isActive: !!p.isActive,
      ...consignFields,
      unitTemplate: [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, retail: "", wholesale: "", government: "" }],
      variants: [],
    };
  }
  const variantIds = variants.map((v) => Number(v.id));
  const units = (await db.select().from(productUnits).where(inArray(productUnits.variantId, variantIds))).filter(
    (u) => u.isActive
  );
  const unitIds = units.map((u) => Number(u.id));
  const prices = unitIds.length ? await db.select().from(productPrices).where(inArray(productPrices.productUnitId, unitIds)) : [];
  const stocks = await db.select().from(branchStock).where(inArray(branchStock.variantId, variantIds));
  // product-variants: صور المتغيّرات (variantId مضبوط) — صور المنتج العامّة (variantId=NULL) تُستثنى.
  const vImages = await db.select().from(productImages).where(inArray(productImages.variantId, variantIds));

  const priceOf = (unitId: number, tier: PriceTier) =>
    prices.find((pr) => Number(pr.productUnitId) === unitId && pr.priceTier === tier)?.price ?? "";

  const variantRows: VariantEditRow[] = variants.map((v) => {
    const myUnits = units.filter((u) => Number(u.variantId) === Number(v.id));
    const unitBarcodes: Record<string, string> = {};
    for (const u of myUnits) if (u.barcode) unitBarcodes[u.unitName] = u.barcode;
    const baseUnit = myUnits.find((u) => u.isBaseUnit);
    const baseRetail = baseUnit ? priceOf(Number(baseUnit.id), "RETAIL") : "";
    const stockByBranch: Record<number, number> = {};
    for (const s of stocks.filter((s) => Number(s.variantId) === Number(v.id))) stockByBranch[Number(s.branchId)] = s.quantity;
    const image = vImages.find((im) => Number(im.variantId) === Number(v.id))?.url ?? null;
    return {
      id: Number(v.id),
      sku: v.sku,
      color: v.color,
      colorHex: v.colorHex ?? null,
      size: v.size,
      costPrice: v.costPrice,
      baseRetail,
      reorderPoint: v.reorderPoint ?? 0,
      minStock: v.minStock ?? 0,
      isActive: !!v.isActive,
      unitBarcodes,
      stockByBranch,
      image,
    };
  });

  // القالب المشترك = وحدات أوّل متغيّر (مرتّبة: الأساس أولاً) — النموذج يصنع وحدات موحّدة عبر المتغيّرات.
  const firstUnits = units
    .filter((u) => Number(u.variantId) === variantIds[0])
    .sort((a, b) => Number(b.isBaseUnit) - Number(a.isBaseUnit));
  const unitTemplate: VariantEditUnit[] = (firstUnits.length ? firstUnits : []).map((u) => ({
    unitName: u.unitName,
    conversionFactor: u.conversionFactor,
    isBaseUnit: !!u.isBaseUnit,
    retail: priceOf(Number(u.id), "RETAIL"),
    wholesale: priceOf(Number(u.id), "WHOLESALE"),
    government: priceOf(Number(u.id), "GOVERNMENT"),
  }));

  return {
    id: Number(p.id),
    name: p.name,
    productType: p.productType,
    brand: p.brand,
    modelName: p.modelName,
    description: p.description,
    categoryId: p.categoryId != null ? Number(p.categoryId) : null,
    isCustomizable: !!p.isCustomizable,
    isService: !!p.isService,
    isBundle: !!p.isBundle,
    isActive: !!p.isActive,
    ...consignFields,
    unitTemplate: unitTemplate.length ? unitTemplate : [{ unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, retail: "", wholesale: "", government: "" }],
    variants: variantRows,
  };
}

/* ============================ الكتابة (التعديل) ============================ */

export interface UpdateUnitTemplate {
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  prices: Array<{ priceTier: PriceTier; price: string }>;
}

export interface UpdateVariantRow {
  id?: number; // موجود ⇒ تحديث؛ غائب ⇒ إضافة
  sku: string;
  color?: string | null;
  colorHex?: string | null;
  size?: string | null;
  costPrice: string;
  /** سعر خاص لمفرد وحدة الأساس لهذا المتغيّر — فارغ ⇒ يتبع سعر القالب المشترك. */
  baseRetail?: string;
  minStock?: number;
  reorderPoint?: number;
  isActive?: boolean;
  /** صورة هذا اللون — string ⇒ تُعيَّن، null/"" ⇒ تُزال (يُعاد التوفيق في كل حفظ). */
  image?: string | null;
  /** باركود لكل وحدة بمفتاح اسم الوحدة. */
  unitBarcodes: Record<string, string>;
}

export interface UpdateProductVariantsInput {
  productId: number;
  name?: string | null;
  productType?: string | null;
  brand?: string | null;
  modelName?: string | null;
  description?: string | null;
  categoryId?: number | null;
  isCustomizable?: boolean;
  isService?: boolean;
  isActive?: boolean;
  unitTemplate: UpdateUnitTemplate[];
  variants: UpdateVariantRow[];
}

// الاسم الصريح (input.name) هو المرجع الأول: المنتجات المستوردة تحمل اسماً كاملاً في `name`
// بلا أجزاء (نوع/ماركة/موديل)، وحقل «اسم المنتج» في شاشة التعديل يحرّره مباشرةً. الأجزاء الثلاثة
// تبقى وصفاً اختيارياً (تصنيف/بحث) ولا تَجُبّ الاسم الصريح. عند غياب الاسم الصريح نركّب من الأجزاء.
function composeName(input: UpdateProductVariantsInput, fallback: string): string {
  const explicit = (input.name ?? "").trim();
  const composed = [input.productType, input.brand, input.modelName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return explicit || composed || fallback;
}

/** يرفض الباركود المكرّر ضدّ منتجات أخرى، ويرفض SKU المكرّر داخل نفس المنتج فقط. */
async function assertEditUniqueness(tx: Tx, input: UpdateProductVariantsInput) {
  const unitNames = input.unitTemplate.map((u) => u.unitName.trim());
  const codes: string[] = [];
  for (const v of input.variants) for (const n of unitNames) {
    const b = (v.unitBarcodes[n] ?? "").trim();
    if (b) codes.push(b);
  }
  const seen = new Set<string>();
  for (const c of codes) {
    if (seen.has(c)) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${c} مكرّر داخل المنتج — لكل وحدة/لون باركود فريد.` });
    seen.add(c);
  }
  if (seen.size) {
    const taken = await tx
      .select({ code: productUnits.barcode, name: products.name })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(inArray(productUnits.barcode, Array.from(seen)), ne(productVariants.productId, input.productId)))
      .limit(1);
    if (taken[0]) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${taken[0].code} مُستخدَم في «${taken[0].name}».` });
  }

  const skus = input.variants.map((v) => v.sku.trim()).filter(Boolean);
  const seenSku = new Set<string>();
  for (const s of skus) {
    if (seenSku.has(s)) throw new TRPCError({ code: "CONFLICT", message: `الرمز ${s} (SKU) مكرّر بين المتغيّرات.` });
    seenSku.add(s);
  }
}

/** يُكتب وحدات متغيّر وأسعاره من القالب المشترك + باركوده الخاص (تحديث بالاسم أو إدراج).
 *  `baseRetailOverride` (إن وُجد) يحلّ محلّ سعر مفرد وحدة الأساس لهذا المتغيّر فقط. */
async function upsertVariantUnits(
  tx: Tx,
  variantId: number,
  template: UpdateUnitTemplate[],
  unitBarcodes: Record<string, string>,
  baseRetailOverride?: string
) {
  const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, variantId));
  const keep = new Set<number>();
  // فحص التفرّد للباركودات الأساسيّة على مستوى (الأساسيّ + البديل) قبل أيّ كتابة — نمنع
  // كتابة باركود أساسيّ يطابق بديلاً لسلعة أخرى (Codex P1). نتجاهل وحدات المتغيّر الحاليّة
  // (تحديث ذاتيّ مقبول).
  const codesToWrite = template
    .map((t) => (unitBarcodes[t.unitName.trim()] ?? "").trim())
    .filter(Boolean);
  if (codesToWrite.length) {
    const clashes = await findBarcodeClashes(tx, codesToWrite, {
      ignorePrimaryUnitIds: existing.map((u) => Number(u.id)),
    });
    if (clashes[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${clashes[0].code} مُستخدَم في «${clashes[0].takenBy}».`,
      });
    }
  }
  const override = (baseRetailOverride ?? "").trim();
  // نَجمع كل صفوف الأسعار ثم نُدرجها دفعةً واحدة (بدل INSERT لكل سعر) — أقلّ ذهاباً للقاعدة.
  const priceRows: { productUnitId: number; priceTier: PriceTier; price: string }[] = [];
  // نتتبّع الوحدات المُنشأة حديثاً (لنَنقل بدائل الوحدات المُعطَّلة إليها لدى إعادة التسمية).
  const inserted: Array<{ unitId: number; barcode: string | null }> = [];
  for (const t of template) {
    const name = t.unitName.trim();
    const barcode = (unitBarcodes[name] ?? "").trim() || null;
    const match = existing.find((u) => u.unitName === name);
    let unitId: number;
    if (match) {
      unitId = Number(match.id);
      await tx
        .update(productUnits)
        .set({ unitName: name, conversionFactor: t.isBaseUnit ? "1" : t.conversionFactor, barcode, isBaseUnit: t.isBaseUnit, isActive: true })
        .where(eq(productUnits.id, unitId));
      await tx.delete(productPrices).where(eq(productPrices.productUnitId, unitId));
    } else {
      const res = await tx.insert(productUnits).values({
        variantId,
        unitName: name,
        conversionFactor: t.isBaseUnit ? "1" : t.conversionFactor,
        barcode,
        isBaseUnit: t.isBaseUnit,
      });
      unitId = extractInsertId(res);
      inserted.push({ unitId, barcode });
    }
    keep.add(unitId);
    for (const pr of t.prices) {
      // سعر خاص لمفرد وحدة الأساس يَجُبّ سعر القالب لهذا المتغيّر.
      const price = t.isBaseUnit && pr.priceTier === "RETAIL" && override ? override : pr.price;
      if (price.trim()) priceRows.push({ productUnitId: unitId, priceTier: pr.priceTier, price: toDbMoney(price) });
    }
  }
  if (priceRows.length) await tx.insert(productPrices).values(priceRows);
  // وحدات لم تعد في القالب ⇒ تعطيل (حفظ التاريخ، لا حذف).
  // **قبل التعطيل**: إن كانت الوحدة القديمة تحمل باركوداً يطابق أحد الوحدات المُنشأة حديثاً
  // (سيناريو إعادة تسمية: "قطعة"→"حبة" بنفس الباركود)، ننقل بدائلها إلى الوحدة الجديدة كي
  // لا تعلق البدائل على وحدة معطَّلة (Codex P2-3).
  const drop = existing.filter((u) => !keep.has(Number(u.id)));
  for (const oldUnit of drop) {
    if (!oldUnit.barcode) continue;
    const successor = inserted.find((i) => i.barcode === oldUnit.barcode);
    if (successor) await migrateAliases(tx, Number(oldUnit.id), successor.unitId);
  }
  if (drop.length) await tx.update(productUnits).set({ isActive: false }).where(inArray(productUnits.id, drop.map((u) => Number(u.id))));
}

/** تعديل منتج بنموذج المتغيّرات ضمن معاملة ذرّية. لا يحذف متغيّراً (تعطيل فقط) حفظاً للمخزون. */
export async function updateProductWithVariants(input: UpdateProductVariantsInput, _actor: Actor) {
  return withTx(async (tx) => {
    const p = (await tx.select().from(products).where(eq(products.id, input.productId)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
    if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
    const baseUnits = input.unitTemplate.filter((u) => u.isBaseUnit).length;
    if (baseUnits !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد وحدة أساس واحدة فقط في قالب الوحدات" });
    if (input.unitTemplate.some((u) => !u.unitName.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "كل وحدة في القالب تحتاج اسماً" });
    // تحقّق معامل التحويل خادمياً (تدقيق ١٧/٧): الأساس ١، غير الأساس عدد صحيح > ١ (كان الحارس واجهياً فقط).
    assertValidUnitFactors(input.unitTemplate);
    if (input.variants.some((v) => !v.sku.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "كل متغيّر يحتاج SKU" });

    await assertEditUniqueness(tx, input);

    const name = composeName(input, p.name);
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });

    await tx
      .update(products)
      .set({
        name,
        productType: input.productType?.trim() || null,
        brand: input.brand?.trim() || null,
        modelName: input.modelName?.trim() || null,
        description: input.description?.trim() || null,
        categoryId: input.categoryId ?? null,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        isService: input.isService ?? !!p.isService,
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
      })
      .where(eq(products.id, input.productId));

    let added = 0;
    for (const v of input.variants) {
      const vals = {
        sku: v.sku.trim(),
        color: v.color?.trim() || null,
        size: v.size?.trim() || null,
        costPrice: toDbMoney(v.costPrice),
        minStock: v.minStock != null ? Math.max(0, Math.trunc(v.minStock)) : 0,
        reorderPoint: v.reorderPoint != null ? Math.max(0, Math.trunc(v.reorderPoint)) : 0,
        isActive: v.isActive ?? true,
      };
      // colorHex بدلالة الصورة (أدناه): undefined ⇒ **لا نلمسها** فيُصان اللون الصريح المخزَّن — تعديلٌ لا
      // يرسل colorHex (كشاشة «السلعة البسيطة» SimpleProductEditForm) كان يمسحه إلى null صامتاً؛ null/"" ⇒
      // تُزال (المستخدم أعادها للتلقائي)؛ hex ⇒ تُعيَّن. عند الإدراج نُثبّتها (لا قيمة محفوظة لنصونها).
      const colorHexPatch = v.colorHex !== undefined ? { colorHex: v.colorHex?.trim() || null } : {};
      let variantId: number;
      if (v.id) {
        const owned = (await tx.select({ id: productVariants.id }).from(productVariants).where(and(eq(productVariants.id, v.id), eq(productVariants.productId, input.productId))).limit(1))[0];
        if (!owned) throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} لا يخصّ هذا المنتج` });
        variantId = v.id;
        await tx.update(productVariants).set({ ...vals, ...colorHexPatch }).where(eq(productVariants.id, variantId));
      } else {
        const res = await tx.insert(productVariants).values({ productId: input.productId, ...vals, colorHex: v.colorHex?.trim() || null });
        variantId = extractInsertId(res);
        added++;
      }
      await upsertVariantUnits(tx, variantId, input.unitTemplate, v.unitBarcodes, v.baseRetail);

      // product-variants: توفيق صورة اللون. image=undefined ⇒ لا نلمسها؛ string ⇒ تُعيَّن؛ null/"" ⇒ تُزال.
      if (v.image !== undefined) {
        const img = (v.image ?? "").trim();
        const existing = await tx
          .select({ id: productImages.id })
          .from(productImages)
          .where(eq(productImages.variantId, variantId))
          .orderBy(productImages.id);
        if (img) {
          if (existing.length > 0) {
            // تحديث في المكان (يصون productImages.id فلا تتدلّى روابط /api/img المُفتَّحة بالـid:
            // كاش SW سنة/حافة CF/صفوف الأوفلاين)؛ ?v= يتغيّر فقط عند تغيّر المحتوى ⇒ إبطال صحيح.
            // راجع docs/product-image-studio-design-2026-07-21.md §٢.ب.
            await tx.update(productImages).set({ url: img }).where(eq(productImages.id, existing[0].id));
            if (existing.length > 1)
              await tx.delete(productImages).where(inArray(productImages.id, existing.slice(1).map((r) => r.id)));
          } else {
            await tx.insert(productImages).values({ productId: input.productId, variantId, url: img, isPrimary: false, sortOrder: 0 });
          }
        } else if (existing.length > 0) {
          await tx.delete(productImages).where(eq(productImages.variantId, variantId));
        }
      }
    }

    return { productId: input.productId, added };
  });
}
