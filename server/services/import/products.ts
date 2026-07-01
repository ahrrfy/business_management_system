// استيراد المنتجات بالجملة (شجرة ٤ جداول): تجميع ← تحقّق ← كشف موجود ← تصنيف ← تنفيذ ذرّي.
// نموذج مبسّط آمن: كل productName = منتج واحد، متغيّراته بالـ sku، وحداته بالاسم، أسعاره بالفئة.
// الاستيراد يُنشئ منتجات جديدة فقط؛ الـ sku الموجود ⇒ تخطّي/فشل (التحديث عبر شاشة المنتج).
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  categories,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { logger } from "../../logger";
import { setStock } from "../inventoryService";
import { money, toDbMoney } from "../money";
import { type Actor, requireDb, withTx } from "../tx";
import { priceTier, type ProductImportRow } from "./schemas";
import type { ImportOptions, ImportRowResult, ImportSummary } from "./types";
import { finalize, insertId, markWriteError, norm, uniq, writeErrorMessage } from "./helpers";

type UnitAgg = {
  unitName: string;
  conversionFactor: string;
  barcode?: string;
  // undefined = لم يُحدَّد في الملف؛ افتراضه المشروط يُحسم بعد التجميع (§٥.١).
  isBaseUnit: boolean | undefined;
  prices: Map<string, string>; // tier → price (مُطبَّع بـ toDbMoney لمقارنة تعارض حتمية)
};
type VariantAgg = {
  sku: string;
  variantName?: string;
  color?: string;
  size?: string;
  costPrice: string;
  openingStock?: number;
  rowNumbers: number[];
  units: Map<string, UnitAgg>;
};
type ProductAgg = {
  productName: string;
  categoryName?: string;
  isCustomizable: boolean;
  rowNumbers: number[];
  variants: Map<string, VariantAgg>;
};

// خرائط الأسعار الصريحة (§٥.٣): retailPrice→RETAIL / wholesalePrice→WHOLESALE / governmentPrice→GOVERNMENT.
const EXPLICIT_PRICE_FIELDS = [
  ["retailPrice", "RETAIL"],
  ["wholesalePrice", "WHOLESALE"],
  ["governmentPrice", "GOVERNMENT"],
] as const;

export async function importProducts(
  rows: ProductImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const skipFailed = options.skipFailed ?? false;
  const db = requireDb();
  const failures = new Map<number, string>(); // rowNumber → سبب الفشل

  // ١) التجميع: productName → variants(sku) → units(name) → prices(tier) — مع كشف تعارض الصفوف المكرّرة.
  const { groups, skuOwner } = aggregateImportRows(rows, failures);

  // ٢) افتراض isBaseUnit المشروط (sku بصفّ واحد بلا تحديد ⇒ وحدته هي الأساس).
  applyBaseUnitDefaults(groups);

  // ٣) التحقّق على مستوى المتغيّر/الوحدة + تكرار الباركود داخل الملف.
  const batchBarcodes = validateProductGroups(groups, failures);

  // ٤) كشف الموجود في القاعدة: SKU (متغيّر) + الباركود مع sku متغيّره المالك.
  const { existingSkus, existingBarcodeOwner } = await detectExistingProducts(db, skuOwner, batchBarcodes);

  // ٥) تصنيف كل مجموعة منتج: إنشاء / تخطّي / فشل.
  const { results, toCreate } = classifyProductGroups(groups, existingSkus, existingBarcodeOwner, failures, onExisting);

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || (anyFailed && !skipFailed) || !toCreate.length) {
    return finalize("PRODUCTS", rows.length, results, false, options, actor);
  }

  // ٦) التنفيذ: إنشاء التصنيفات الناقصة ثم شجرة كل منتج (+ مخزونه الافتتاحي) داخل معاملة واحدة.
  try {
    await withTx((tx) => persistProductsInTx(tx, toCreate, actor));
  } catch (e) {
    // الرسالة الخام تُسجَّل كاملة للتشخيص وتُعرَّب للواجهة (لا نصّ SQL/قيود/بيانات صفوف للمستخدم).
    logger.error({ err: e }, "فشل كتابة دفعة استيراد المنتجات");
    return finalize("PRODUCTS", rows.length, markWriteError(results, writeErrorMessage(e)), false, options, actor);
  }
  return finalize("PRODUCTS", rows.length, results, true, options, actor);
}

type SkuOwner = Map<string, { productName: string; rows: number[] }>;

/** ① التجميع: productName → variants(sku) → units(name) → prices(tier) — مع كشف تعارض الصفوف المكرّرة. */
function aggregateImportRows(
  rows: ProductImportRow[],
  failures: Map<number, string>,
): { groups: Map<string, ProductAgg>; skuOwner: SkuOwner } {
  const groups = new Map<string, ProductAgg>();
  const skuOwner: SkuOwner = new Map(); // sku → المالك الأول + صفوفه
  for (const r of rows) {
    const pName = r.productName.trim();
    let p = groups.get(pName);
    if (!p) {
      p = { productName: pName, categoryName: norm(r.categoryName) ?? undefined, isCustomizable: !!r.isCustomizable, rowNumbers: [], variants: new Map() };
      groups.set(pName, p);
    }
    p.rowNumbers.push(r.rowNumber);

    // sku اختياري في الملف: البديل التلقائي = الباركود (§٥.١)؛ كلاهما غائب ⇒ فشل الصف (ويُفشل المنتج كاملاً).
    const sku = norm(r.sku) ?? norm(r.barcode);
    if (!sku) {
      failures.set(r.rowNumber, "حدّد SKU أو الباركود");
      continue;
    }

    // تضارب ملكية الـ SKU عبر منتجَين ⇒ أفشِل الصفّ الحالي وكل صفوف المالك الأول (لا تتركها «created»).
    const owner = skuOwner.get(sku);
    if (owner && owner.productName !== pName) {
      failures.set(r.rowNumber, `الـ SKU «${sku}» مرتبط بأكثر من منتج`);
      for (const rn of owner.rows) failures.set(rn, `الـ SKU «${sku}» مرتبط بأكثر من منتج`);
    } else if (owner) {
      owner.rows.push(r.rowNumber);
    } else {
      skuOwner.set(sku, { productName: pName, rows: [r.rowNumber] });
    }

    const vName = norm(r.variantName) ?? undefined;
    const vColor = norm(r.color) ?? undefined;
    const vSize = norm(r.size) ?? undefined;
    let v = p.variants.get(sku);
    if (!v) {
      v = { sku, variantName: vName, color: vColor, size: vSize, costPrice: r.costPrice, rowNumbers: [], units: new Map() };
      p.variants.set(sku, v);
    } else if (v.variantName !== vName || v.color !== vColor || v.size !== vSize || v.costPrice !== r.costPrice) {
      // صفّ آخر لنفس الـ SKU بقيم متغيّر متعارضة ⇒ لا تَدمج بصمت (قد يكون خطأ إدخال في التكلفة).
      failures.set(r.rowNumber, `قيم متعارضة لنفس الـ SKU «${sku}» (التكلفة/الاسم/اللون/المقاس)`);
    }
    v.rowNumbers.push(r.rowNumber);

    // المخزون الافتتاحي على مستوى المتغيّر: قيمتان مختلفتان لنفس الـ SKU ⇒ تعارض لا دمج صامت.
    if (r.openingStock !== undefined) {
      if (v.openingStock !== undefined && v.openingStock !== r.openingStock) {
        failures.set(r.rowNumber, `قيم متعارضة للمخزون الافتتاحي لنفس الـ SKU «${sku}»`);
      } else {
        v.openingStock = r.openingStock;
      }
    }

    const uBarcode = norm(r.barcode) ?? undefined;
    let u = v.units.get(r.unitName);
    if (!u) {
      u = { unitName: r.unitName, conversionFactor: r.conversionFactor, barcode: uBarcode, isBaseUnit: r.isBaseUnit, prices: new Map() };
      v.units.set(r.unitName, u);
    } else if (
      u.conversionFactor !== r.conversionFactor ||
      (u.isBaseUnit ?? false) !== (r.isBaseUnit ?? false) ||
      u.barcode !== uBarcode
    ) {
      // وحدة مكرّرة بقيم متعارضة (معامل/أساس/باركود) ⇒ أفشِل بدل الدمج الصامت (المعامل يحكم حساب المخزون).
      failures.set(r.rowNumber, `قيم متعارضة للوحدة «${r.unitName}» داخل الـ SKU «${sku}»`);
    }

    // دمج الأسعار: الحقول الصريحة الثلاثة + (priceTier/price) القديمة للتوافق — سعر 0/فارغ ⇒ تخطَّ الفئة (§٥.٣).
    const setUnitPrice = (tier: string, raw: string, rn: number) => {
      if (money(raw).isZero()) return; // 0 = لا سعر لهذه الفئة في النظام القديم
      const val = toDbMoney(raw); // تطبيع نصّي ⇒ مقارنة تعارض حتمية («2.0» ≡ «2.00»)
      const prev = u.prices.get(tier);
      if (prev != null && prev !== val) failures.set(rn, `سعر متعارض للفئة ${tier} في الوحدة «${u.unitName}»`);
      else u.prices.set(tier, val);
    };
    for (const [field, tier] of EXPLICIT_PRICE_FIELDS) {
      const raw = r[field];
      if (raw !== undefined) setUnitPrice(tier, raw, r.rowNumber);
    }
    if (r.priceTier) {
      if (!r.price) failures.set(r.rowNumber, "السعر مطلوب مع وجود فئة السعر");
      else setUnitPrice(r.priceTier, r.price, r.rowNumber);
    }
  }
  return { groups, skuOwner };
}

/**
 * ② افتراض isBaseUnit المشروط (§٥.١ — بعد التجميع لا في zod، لأن التحقق الصفّي لا يرى سياق المجموعة):
 * sku بصفّ واحد بلا تحديد ⇒ وحدته هي الأساس (ملف الأصناف: الكود فريد ١٠٠٪ ⇒ هذا هو المسار الفعلي).
 * صفّان فأكثر كلاهما بلا تحديد ⇒ يفشلان برسالة «وحدة أساس واحدة بالضبط» — سلوك منصوص لا عرَضي.
 */
function applyBaseUnitDefaults(groups: Map<string, ProductAgg>): void {
  for (const p of Array.from(groups.values())) {
    for (const v of Array.from(p.variants.values())) {
      if (v.rowNumbers.length === 1) {
        const only = Array.from(v.units.values())[0];
        if (only && only.isBaseUnit === undefined) only.isBaseUnit = true;
      }
    }
  }
}

/** ③ التحقّق على مستوى المتغيّر/الوحدة + تكرار الباركود داخل الملف. يُعيد خريطة الباركود → صفوف مالكه. */
function validateProductGroups(
  groups: Map<string, ProductAgg>,
  failures: Map<number, string>,
): Map<string, number[]> {
  const batchBarcodes = new Map<string, number[]>(); // barcode → صفوف المتغيّر المالك
  for (const p of Array.from(groups.values())) {
    for (const v of Array.from(p.variants.values())) {
      const baseUnits = Array.from(v.units.values()).filter((u) => !!u.isBaseUnit);
      if (baseUnits.length !== 1) {
        for (const rn of v.rowNumbers) failures.set(rn, `المتغيّر «${v.sku}» يحتاج وحدة أساس واحدة بالضبط`);
      }
      for (const u of Array.from(v.units.values())) {
        const f = Number(u.conversionFactor);
        if (u.isBaseUnit && f !== 1) {
          for (const rn of v.rowNumbers) failures.set(rn, `وحدة الأساس «${u.unitName}» يجب أن يكون معامل تحويلها ١`);
        }
        if (!u.isBaseUnit && (!Number.isInteger(f) || f < 1)) {
          for (const rn of v.rowNumbers) failures.set(rn, `معامل تحويل «${u.unitName}» يجب أن يكون عدداً صحيحاً ≥ ١`);
        }
        if (u.barcode) {
          const prevRows = batchBarcodes.get(u.barcode);
          if (prevRows) {
            for (const rn of v.rowNumbers) failures.set(rn, `الباركود «${u.barcode}» مكرّر داخل الملف`);
            for (const rn of prevRows) failures.set(rn, `الباركود «${u.barcode}» مكرّر داخل الملف`);
          } else {
            batchBarcodes.set(u.barcode, v.rowNumbers);
          }
        }
      }
    }
  }
  return batchBarcodes;
}

/**
 * ④ كشف الموجود في القاعدة: SKU (متغيّر) + الباركود مع sku متغيّره المالك —
 * الباركود الموجود لمتغيّرٍ من المنتج نفسه ليس «تعارضاً» بل إعادةُ استيراد منتجٍ سبق إنشاؤه:
 * ملف المالك بلا عمود SKU ⇒ sku=الباركود لكل صف، فبدون تمييز المالك كانت إعادة الاستيراد
 * تُصنَّف «فاشل: باركود مُستخدَم» وتُوقف بقية الدفعات (نقيض «إعادة التشغيل آمنة» — §٤.٣.٤-د).
 */
async function detectExistingProducts(
  db: ReturnType<typeof requireDb>,
  skuOwner: SkuOwner,
  batchBarcodes: Map<string, number[]>,
): Promise<{ existingSkus: Set<string>; existingBarcodeOwner: Map<string, string> }> {
  const allSkus = Array.from(skuOwner.keys());
  const allBarcodes = Array.from(batchBarcodes.keys());
  const existingSkus = new Set<string>();
  const existingBarcodeOwner = new Map<string, string>(); // barcode → sku المتغيّر المالك في القاعدة
  if (allSkus.length) {
    for (const e of await db.select({ sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.sku, allSkus)))
      existingSkus.add(e.sku);
  }
  if (allBarcodes.length) {
    for (const e of await db
      .select({ barcode: productUnits.barcode, sku: productVariants.sku })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .where(inArray(productUnits.barcode, allBarcodes)))
      if (e.barcode) existingBarcodeOwner.set(e.barcode, e.sku);
  }
  return { existingSkus, existingBarcodeOwner };
}

/** ⑤ تصنيف كل مجموعة منتج: إنشاء / تخطّي / فشل. يُعيد نتائج كل الصفوف + المجموعات الجاهزة للإنشاء. */
function classifyProductGroups(
  groups: Map<string, ProductAgg>,
  existingSkus: Set<string>,
  existingBarcodeOwner: Map<string, string>,
  failures: Map<number, string>,
  onExisting: string,
): { results: ImportRowResult[]; toCreate: ProductAgg[] } {
  const results: ImportRowResult[] = [];
  const toCreate: ProductAgg[] = [];
  for (const p of Array.from(groups.values())) {
    const groupFailed = p.rowNumbers.some((rn) => failures.has(rn));
    if (groupFailed) {
      for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: failures.get(rn) ?? "خطأ في صفّ مرتبط بنفس المنتج" });
      continue;
    }
    const skus = Array.from(p.variants.keys());
    const skuSet = new Set(skus);
    const hasExistingSku = skus.some((sku) => existingSkus.has(sku));
    // التعارض الحقيقي: باركود موجود في القاعدة لمتغيّرٍ من «خارج هذا المنتج» (sku المالك ليس من
    // skus المنتج) — أمّا المملوك لأحد متغيّراته نفسها (إعادة استيراد) فيُحسم «موجود مسبقاً» أدناه.
    const barcodeClash = Array.from(p.variants.values()).some((v) =>
      Array.from(v.units.values()).some((u) => {
        if (!u.barcode) return false;
        const ownerSku = existingBarcodeOwner.get(u.barcode);
        return ownerSku != null && !skuSet.has(ownerSku);
      }),
    );

    // «موجود مسبقاً» يسبق فحص التعارض (§٤.٣.٤-د): إعادة استيراد منتجٍ سبق إنشاؤه تتخطّاه لا
    // تُفشله — وإلا استحال استئناف ملفٍ توقّف في منتصفه عبر الواجهة (الدفعة ١ كلها «فاشلة»).
    if (hasExistingSku) {
      if (onExisting === "error") for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: "الـ SKU موجود مسبقاً" });
      else for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "skipped", message: onExisting === "update" ? "موجود — التحديث عبر شاشة المنتج" : "موجود مسبقاً" });
      continue;
    }
    if (barcodeClash) {
      for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: "باركود مُستخدَم مسبقاً (يجب أن يكون فريداً)" });
      continue;
    }
    toCreate.push(p);
    for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "created" });
  }
  return { results, toCreate };
}

/** ⑥ التنفيذ: إنشاء التصنيفات الناقصة ثم شجرة كل منتج (+ مخزونه الافتتاحي) داخل معاملة واحدة. */
async function persistProductsInTx(tx: Tx, toCreate: ProductAgg[], actor: Actor): Promise<void> {
  const catNames = uniq(toCreate.map((p) => p.categoryName));
  const catMap = new Map<string, number>(); // المفتاح: الاسم بحالة موحّدة (تفادي تصادم «X»/«x» على القيد الفريد)
  if (catNames.length) {
    for (const c of await tx.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.name, catNames)))
      catMap.set(c.name.trim().toLowerCase(), Number(c.id));
    for (const name of catNames) {
      const key = name.trim().toLowerCase();
      if (!catMap.has(key)) {
        const res = await tx.insert(categories).values({ name });
        catMap.set(key, insertId(res));
      }
    }
  }

  for (const p of toCreate) {
    const pRes = await tx.insert(products).values({
      name: p.productName,
      categoryId: p.categoryName ? catMap.get(p.categoryName.trim().toLowerCase()) ?? null : null,
      isCustomizable: p.isCustomizable,
    });
    const productId = insertId(pRes);

    for (const v of Array.from(p.variants.values())) {
      const vRes = await tx.insert(productVariants).values({
        productId,
        sku: v.sku,
        variantName: v.variantName ?? null,
        color: v.color ?? null,
        size: v.size ?? null,
        costPrice: toDbMoney(v.costPrice),
      });
      const variantId = insertId(vRes);

      for (const u of Array.from(v.units.values())) {
        const uRes = await tx.insert(productUnits).values({
          variantId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode ?? null,
          isBaseUnit: !!u.isBaseUnit,
        });
        const productUnitId = insertId(uRes);
        for (const [tier, price] of Array.from(u.prices)) {
          await tx.insert(productPrices).values({
            productUnitId,
            priceTier: tier as z.infer<typeof priceTier>,
            price: toDbMoney(price),
          });
        }
      }

      // المخزون الافتتاحي (§٥.٣): حركة تسوية بمرجع OPENING داخل نفس المعاملة — ذرّيةُ الشجرة ورصيدها معاً.
      if (v.openingStock !== undefined && v.openingStock > 0) {
        await setStock(tx, {
          variantId,
          branchId: actor.branchId,
          targetQuantity: v.openingStock,
          referenceType: "OPENING",
          notes: "رصيد افتتاحي (استيراد)",
          createdBy: actor.userId,
        });
      }
    }
  }
}
