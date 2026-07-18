// price-waves (٧/٧/٢٦): موجات تحديث الأسعار — معاينة قبل الالتزام + تطبيق ذرّي + سجلّ دائم.
//
// النموذج الذهني:
//   * موجة = تعديل جماعيّ لمجموعة productPrices بمعايير (فلاتر) وقاعدة تغيير موحَّدة (نسبة/مبلغ/هامش).
//   * `previewPriceWave` — قراءة فقط، تُرجع الصفوف المتأثّرة (oldPrice, newPrice) لعرضها للمدير.
//   * `applyPriceWave` — كتابة ذرّية: يفتح withTx، يعيد حساب الأسعار من نفس الفلاتر (لا يعتمد على قراءة العميل)،
//     يكتب رأس الموجة + يحدّث productPrices + يُدرج priceChangeLog لكل صفٍّ.
//
// ثوابت الأمان (W1..W5):
//   W1  إعادة الحساب داخل withTx — لا نعتمد على «صفوف العميل من المعاينة» (سباق: مدير آخر يغيّر سعراً بين المعاينة والتطبيق).
//   W2  السعر الجديد > 0 دائماً (يفرضه CHECK). خفض بنسبة كبيرة قد يهبطه لصفر ⇒ نقصره إلى 0.01.
//   W3  السعر الجديد ≥ التكلفة الحيّة (WAVG) — إلّا لو المدير أذّن صراحةً `allowBelowCost=true`.
//   W4  تنفيذ managerProcedure حصراً — كشف/تعديل التكلفة ينكشف من التصفية.
//   W5  استقرار SORT: نطبّق بترتيب productUnitId → priceTier كي تكون النتيجة حتميّة (تكرار المعاينة = التطبيق).
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import {
  priceChangeLog,
  priceUpdateWaves,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money, toDbMoney } from "./money";
import type { PriceTier } from "./pricing";

export type PriceChangeType =
  | "INCREASE_PERCENT"
  | "DECREASE_PERCENT"
  | "INCREASE_AMOUNT"
  | "DECREASE_AMOUNT"
  | "SET_MARGIN";

export interface PriceWaveFilters {
  categoryId?: number | null;
  productSearch?: string | null; // LIKE على products.name أو productVariants.sku
  priceTier?: PriceTier | null; // فارغ = كل الفئات المسعَّرة
}

export interface PreviewPriceWaveInput {
  filters: PriceWaveFilters;
  changeType: PriceChangeType;
  changeValue: string; // نسبة (0<pct≤1000) أو مبلغ ثابت (>0) أو هامش (0<pct≤1000)
}

export interface ApplyPriceWaveInput extends PreviewPriceWaveInput {
  name: string;
  description?: string | null;
  reason?: string | null; // يُنسخ إلى priceChangeLog لكل صفٍّ
  allowBelowCost?: boolean;
}

export interface PriceWaveRow {
  productUnitId: number;
  productName: string;
  sku: string;
  unitName: string;
  priceTier: PriceTier;
  oldPrice: string;
  newPrice: string;
  costPrice: string;
  belowCost: boolean;
}

/** W1: إعادة الحساب المشتركة (كي تعمل نفس المنطق للمعاينة والتطبيق داخل نفس المعاملة). */
async function computeAffectedRows(
  tx: Tx,
  input: PreviewPriceWaveInput,
): Promise<PriceWaveRow[]> {
  const changeVal = money(input.changeValue);
  if (!changeVal.gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة التغيير يجب أن تكون أكبر من صفر" });
  }
  // حدّ أعلى منطقي على النسب — يقصّه CHECK أيضاً.
  if (
    (input.changeType === "INCREASE_PERCENT" ||
      input.changeType === "DECREASE_PERCENT" ||
      input.changeType === "SET_MARGIN") &&
    changeVal.gt(1000)
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "النسبة تتجاوز الحدّ الأقصى المسموح (1000)" });
  }

  const conditions: any[] = [eq(productUnits.isActive, true), eq(productVariants.isActive, true)];
  if (input.filters.categoryId != null && input.filters.categoryId > 0) {
    conditions.push(eq(products.categoryId, input.filters.categoryId));
  }
  if (input.filters.productSearch && input.filters.productSearch.trim().length >= 2) {
    const term = `%${input.filters.productSearch.trim()}%`;
    conditions.push(or(like(products.name, term), like(productVariants.sku, term))!);
  }
  if (input.filters.priceTier) {
    conditions.push(eq(productPrices.priceTier, input.filters.priceTier));
  }

  const rows = await tx
    .select({
      productUnitId: productPrices.productUnitId,
      priceTier: productPrices.priceTier,
      oldPrice: productPrices.price,
      productName: products.name,
      sku: productVariants.sku,
      unitName: productUnits.unitName,
      costPrice: productVariants.costPrice,
    })
    .from(productPrices)
    .innerJoin(productUnits, eq(productPrices.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(...conditions))
    .orderBy(asc(productPrices.productUnitId), asc(productPrices.priceTier));

  const result: PriceWaveRow[] = [];
  for (const r of rows) {
    const oldPrice = money(r.oldPrice);
    const cost = money(r.costPrice);
    let newPrice: Decimal;
    switch (input.changeType) {
      case "INCREASE_PERCENT":
        newPrice = oldPrice.mul(new Decimal(100).plus(changeVal)).dividedBy(100);
        break;
      case "DECREASE_PERCENT":
        newPrice = oldPrice.mul(new Decimal(100).minus(changeVal)).dividedBy(100);
        break;
      case "INCREASE_AMOUNT":
        newPrice = oldPrice.plus(changeVal);
        break;
      case "DECREASE_AMOUNT":
        newPrice = oldPrice.minus(changeVal);
        break;
      case "SET_MARGIN":
        // newPrice = cost × (1 + margin%). إن كانت التكلفة صفراً، نتخطّى الصفّ.
        if (cost.lte(0)) continue;
        newPrice = cost.mul(new Decimal(100).plus(changeVal)).dividedBy(100);
        break;
      default:
        throw new TRPCError({ code: "BAD_REQUEST", message: "نوع تغيير غير معروف" });
    }
    // W2: قصّ إلى 0.01 كحدّ أدنى مطلق (لا سعر صفر أو سالب).
    if (newPrice.lt(0.01)) newPrice = new Decimal(0.01);
    // تجاهل الصفوف التي لا يتغيّر سعرها فعلياً (نسبة/مبلغ = صفر أو رفع 0% إلخ).
    if (newPrice.toDecimalPlaces(2).equals(oldPrice.toDecimalPlaces(2))) continue;

    result.push({
      productUnitId: Number(r.productUnitId),
      productName: r.productName,
      sku: r.sku,
      unitName: r.unitName,
      priceTier: r.priceTier as PriceTier,
      oldPrice: toDbMoney(oldPrice),
      newPrice: toDbMoney(newPrice),
      costPrice: toDbMoney(cost),
      belowCost: newPrice.lt(cost),
    });
  }
  return result;
}

/** معاينة الموجة — قراءة فقط، بدون كتابة. */
export async function previewPriceWave(tx: Tx, input: PreviewPriceWaveInput): Promise<PriceWaveRow[]> {
  return computeAffectedRows(tx, input);
}

/**
 * تطبيق الموجة ذرّياً: يعيد حساب الصفوف داخل نفس المعاملة (W1)، ثم:
 *   - يكتب رأس `priceUpdateWaves` بـtotalRows.
 *   - لكل صف: UPDATE productPrices + INSERT priceChangeLog بـwaveId.
 * إن سقط صفٌّ واحد ⇒ ROLLBACK كامل (withTx). المستدعي يفتح `withTx`.
 */
export async function applyPriceWave(
  tx: Tx,
  input: ApplyPriceWaveInput,
  actorUserId: number,
): Promise<{ waveId: number; totalRows: number }> {
  if (!input.name.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الموجة مطلوب" });
  }
  const rows = await computeAffectedRows(tx, input);
  if (!rows.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا صفوف تُطابق فلاتر الموجة — لا شيء لتحديثه" });
  }
  // W3: لا نسمح ببيعٍ تحت التكلفة إلّا بإذن صريح.
  const belowCostRows = rows.filter((r) => r.belowCost);
  if (belowCostRows.length && !input.allowBelowCost) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${belowCostRows.length} صفّ سعرها الجديد تحت التكلفة — أذّن allowBelowCost أو راجع الفلاتر`,
    });
  }

  const waveRes = await tx.insert(priceUpdateWaves).values({
    name: input.name.trim(),
    description: input.description?.trim() || null,
    changeType: input.changeType,
    changeValue: toDbMoney(input.changeValue),
    filtersJson: JSON.stringify(input.filters),
    totalRows: rows.length,
    appliedBy: actorUserId,
  });
  const waveId = extractInsertId(waveRes);

  // W5: التطبيق بترتيب productUnitId → priceTier (استقرار).
  for (const r of rows) {
    await tx
      .update(productPrices)
      .set({ price: r.newPrice })
      .where(
        and(
          eq(productPrices.productUnitId, r.productUnitId),
          eq(productPrices.priceTier, r.priceTier),
        ),
      );
    await tx.insert(priceChangeLog).values({
      productUnitId: r.productUnitId,
      priceTier: r.priceTier,
      oldPrice: r.oldPrice,
      newPrice: r.newPrice,
      reason: input.reason?.trim() || null,
      waveId,
      actorUserId,
    });
  }
  return { waveId, totalRows: rows.length };
}

/** قائمة الموجات المطبَّقة (للتاريخ في الشاشة). */
export async function listPriceWaves(tx: Tx, limit = 50) {
  // تدقيق ١٧/٧: كان asc + limit + reverse يقتطع **أقدم** ٥٠ موجةً ثم يعكس ترتيب عرضها ⇒ الموجات
  // الجديدة تختفي بعد تجاوز ٥٠. الصحيح: desc + limit ⇒ أحدث ٥٠ موجةً فعلاً. desc(id) يكسر تعادل
  // appliedAt (موجتان في الثانية نفسها) حتمياً ⇒ الأحدث إدراجاً أوّلاً.
  return tx.select().from(priceUpdateWaves).orderBy(desc(priceUpdateWaves.appliedAt), desc(priceUpdateWaves.id)).limit(limit);
}

/** سجلّ تغييرات سعرٍ محدَّد (لعرض «تاريخ السعر» على شاشة تعديل المنتج). */
export async function getPriceUnitHistory(tx: Tx, productUnitId: number, limit = 50) {
  // تدقيق ١٧/٧: كان asc ⇒ أقدم ٥٠ تغييراً؛ الصحيح desc ⇒ أحدث التغييرات أولاً (desc(id) لكسر تعادل الوقت).
  return tx
    .select()
    .from(priceChangeLog)
    .where(eq(priceChangeLog.productUnitId, productUnitId))
    .orderBy(desc(priceChangeLog.createdAt), desc(priceChangeLog.id))
    .limit(limit);
}

/** ملء أسماء الوحدات لصفوف السجلّ (لعرض friendly في التقارير). */
export async function enrichLogRows(tx: Tx, rows: Array<{ productUnitId: number }>) {
  const ids = Array.from(new Set(rows.map((r) => Number(r.productUnitId))));
  if (!ids.length) return new Map<number, { productName: string; unitName: string; sku: string }>();
  const found = await tx
    .select({
      id: productUnits.id,
      unitName: productUnits.unitName,
      productName: products.name,
      sku: productVariants.sku,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.id, ids));
  const map = new Map<number, { productName: string; unitName: string; sku: string }>();
  for (const r of found) map.set(Number(r.id), { productName: r.productName, unitName: r.unitName, sku: r.sku });
  return map;
}
