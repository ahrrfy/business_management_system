/**
 * catalogAnomalies/detectors.ts — نواة الكشف الرجعيّ عن شذوذ تكلفة/سعر/معامل الكتالوج.
 *
 * **الغاية:** مصدر حقيقةٍ **واحدٌ** لست عدسات كشف (L1-L6) يستخدمه:
 *   - راوتر `catalogAnomalies` (live table لواجهة `/reports/catalog-anomalies`).
 *   - كرون ليليّ (`server/jobs/catalogAnomaliesNightly.ts`) للإشعارات على الجديد.
 *   - كاشف `D8` في `anomalyWatch` (توسعة الكواشف D1-D7).
 *
 * كل عدسةٍ تُعيد صفوفاً بشكلٍ موحَّد `{variantId, code, severity, evidence}` — لا تنسيقاً معنياً
 * بالعرض. طبقة العرض (الراوتر) تُنسّق للعميل.
 *
 * **مبدأ الاستبعاد:** المتغيّرات المعطَّلة، منتجات الأمانة، البكجات، والخِدمات تُستثنى دائماً (لها
 * دلالات مختلفة للتكلفة). المرتفعة الاختيارية عبر جدول `catalogAnomalyOverrides` تُطبَّق بعد.
 */
import { sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { COST_ABOVE_RETAIL_HARD_RATIO, ABS_MAX_CONVERSION_FACTOR } from "../../../shared/priceSanity";

/** رمز العدسة — ثابتٌ يُستعمَل في `catalogAnomalyOverrides.code` وفي عرض العميل. */
export type LensCode = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";

/** حدّة النتيجة — تتّبع تدرّج priceSanity (بلا catastrophic هنا: الكشف الرجعيّ يحسب على قيمة موجودة). */
export type LensSeverity = "blocker" | "warning" | "info";

/** صفٌّ نتيجةٌ من عدسةٍ ما — منسَّقٌ لأداءِ الفرز/العرض في لوحة التدقيق. */
export interface AnomalyFinding {
  variantId: number;
  productId: number;
  sku: string;
  productName: string;
  code: LensCode;
  severity: LensSeverity;
  /** حقولٌ عدديّةٌ لعرضٍ مباشرٍ في الجدول (تكلفة/تجزئة/نسبة…). */
  metrics: Record<string, number | string | null>;
  /** ملحوظةٌ نصّيّة قابلة للعرض مباشرة. */
  note: string;
}

type Db = MySql2Database<Record<string, unknown>>;

// ══════════════════════════════════════════════════════════════════════════════
// الاستعلامات (ست عدسات — كلٌّ يعيد قائمة `AnomalyFinding`).
// ══════════════════════════════════════════════════════════════════════════════

/** L1 — التكلفة ≥ ٥× سعر البيع الأساس (blocker: SINARLINE-class). */
export async function detectL1(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           v.costPrice AS cost,
           (SELECT MIN(pp.price) FROM productPrices pp
            JOIN productUnits pu ON pu.id = pp.productUnitId
            WHERE pu.variantId = v.id AND pu.isBaseUnit = 1) AS baseRetail
    FROM productVariants v
    JOIN products p ON p.id = v.productId
    WHERE v.costPrice > 0
      AND COALESCE(p.isConsignment, 0) = 0
      AND COALESCE(p.isBundle, 0) = 0
      AND COALESCE(p.isService, 0) = 0
      AND COALESCE(v.isActive, 1) = 1
      AND (SELECT MIN(pp.price) FROM productPrices pp
           JOIN productUnits pu ON pu.id = pp.productUnitId
           WHERE pu.variantId = v.id AND pu.isBaseUnit = 1) > 0
      AND v.costPrice >= ${COST_ABOVE_RETAIL_HARD_RATIO} * (
        SELECT MIN(pp.price) FROM productPrices pp
        JOIN productUnits pu ON pu.id = pp.productUnitId
        WHERE pu.variantId = v.id AND pu.isBaseUnit = 1
      )
    ORDER BY v.costPrice / NULLIF((
      SELECT MIN(pp.price) FROM productPrices pp
      JOIN productUnits pu ON pu.id = pp.productUnitId
      WHERE pu.variantId = v.id AND pu.isBaseUnit = 1
    ), 0) DESC
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; cost: string; baseRetail: string | null }>, unknown])[0];
  return list.map((r) => {
    const cost = Number(r.cost);
    const retail = Number(r.baseRetail ?? 0);
    const ratio = retail > 0 ? cost / retail : 0;
    return {
      variantId: r.vid,
      productId: r.pid,
      sku: r.sku,
      productName: r.name,
      code: "L1" as const,
      severity: "blocker" as const,
      metrics: { cost, retail, ratio: Math.round(ratio * 100) / 100 },
      note: `التكلفة (${cost.toLocaleString("en-US")}) ≥ ${COST_ABOVE_RETAIL_HARD_RATIO}× سعر البيع (${retail.toLocaleString("en-US")}) بنسبة ${ratio.toFixed(2)}× — خطأ إدخال محتمل.`,
    };
  });
}

/** L2 — التكلفة > سعر البيع الأساس بأقلّ من ٥× (warning: بيعٌ بخسارة، قد يكون تصفيةً مقصودة). */
export async function detectL2(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           v.costPrice AS cost,
           (SELECT MIN(pp.price) FROM productPrices pp
            JOIN productUnits pu ON pu.id = pp.productUnitId
            WHERE pu.variantId = v.id AND pu.isBaseUnit = 1) AS baseRetail
    FROM productVariants v
    JOIN products p ON p.id = v.productId
    WHERE v.costPrice > 0
      AND COALESCE(p.isConsignment, 0) = 0
      AND COALESCE(p.isBundle, 0) = 0
      AND COALESCE(p.isService, 0) = 0
      AND COALESCE(v.isActive, 1) = 1
      AND (SELECT MIN(pp.price) FROM productPrices pp
           JOIN productUnits pu ON pu.id = pp.productUnitId
           WHERE pu.variantId = v.id AND pu.isBaseUnit = 1) > 0
      AND v.costPrice > (
        SELECT MIN(pp.price) FROM productPrices pp
        JOIN productUnits pu ON pu.id = pp.productUnitId
        WHERE pu.variantId = v.id AND pu.isBaseUnit = 1
      )
      AND v.costPrice < ${COST_ABOVE_RETAIL_HARD_RATIO} * (
        SELECT MIN(pp.price) FROM productPrices pp
        JOIN productUnits pu ON pu.id = pp.productUnitId
        WHERE pu.variantId = v.id AND pu.isBaseUnit = 1
      )
    ORDER BY v.costPrice / (
      SELECT MIN(pp.price) FROM productPrices pp
      JOIN productUnits pu ON pu.id = pp.productUnitId
      WHERE pu.variantId = v.id AND pu.isBaseUnit = 1
    ) DESC
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; cost: string; baseRetail: string | null }>, unknown])[0];
  return list.map((r) => {
    const cost = Number(r.cost);
    const retail = Number(r.baseRetail ?? 0);
    const ratio = retail > 0 ? cost / retail : 0;
    return {
      variantId: r.vid,
      productId: r.pid,
      sku: r.sku,
      productName: r.name,
      code: "L2" as const,
      severity: "warning" as const,
      metrics: { cost, retail, ratio: Math.round(ratio * 100) / 100 },
      note: `بيعٌ بخسارة — التكلفة (${cost.toLocaleString("en-US")}) > سعر البيع (${retail.toLocaleString("en-US")}) بنسبة ${ratio.toFixed(2)}×.`,
    };
  });
}

/** L3 — التكلفة تساوي سعر البيع الأساس (info: هامش صفر، قد يكون تصفيةً أو نسخاً خاطئاً). */
export async function detectL3(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           v.costPrice AS cost,
           (SELECT MIN(pp.price) FROM productPrices pp
            JOIN productUnits pu ON pu.id = pp.productUnitId
            WHERE pu.variantId = v.id AND pu.isBaseUnit = 1) AS baseRetail
    FROM productVariants v
    JOIN products p ON p.id = v.productId
    WHERE v.costPrice > 0
      AND COALESCE(p.isConsignment, 0) = 0
      AND COALESCE(p.isBundle, 0) = 0
      AND COALESCE(p.isService, 0) = 0
      AND COALESCE(v.isActive, 1) = 1
      AND (SELECT MIN(pp.price) FROM productPrices pp
           JOIN productUnits pu ON pu.id = pp.productUnitId
           WHERE pu.variantId = v.id AND pu.isBaseUnit = 1) = v.costPrice
    ORDER BY p.id
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; cost: string; baseRetail: string | null }>, unknown])[0];
  return list.map((r) => ({
    variantId: r.vid,
    productId: r.pid,
    sku: r.sku,
    productName: r.name,
    code: "L3" as const,
    severity: "info" as const,
    metrics: { cost: Number(r.cost), retail: Number(r.baseRetail ?? 0), ratio: 1 },
    note: `التكلفة = سعر البيع (${r.cost}). قد تكون تصفيةً مقصودة أو نسخاً خاطئاً وقت الإدخال.`,
  }));
}

/** L4 — تكلفة صفر مع نشاط (مخزون أو بيع مسجَّل). warning: COGS مُضخَّم، ربحٌ وهميّ. */
export async function detectL4(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           v.costPrice AS cost,
           (SELECT COUNT(*) FROM invoiceItems ii WHERE ii.variantId = v.id) AS salesCount,
           (SELECT COALESCE(SUM(bs.quantity), 0) FROM branchStock bs WHERE bs.variantId = v.id) AS totalStock
    FROM productVariants v
    JOIN products p ON p.id = v.productId
    WHERE (v.costPrice IS NULL OR v.costPrice = 0)
      AND COALESCE(p.isConsignment, 0) = 0
      AND COALESCE(p.isBundle, 0) = 0
      AND COALESCE(p.isService, 0) = 0
      AND COALESCE(v.isActive, 1) = 1
      AND (
        (SELECT COUNT(*) FROM invoiceItems ii WHERE ii.variantId = v.id) > 0
        OR (SELECT COALESCE(SUM(bs.quantity), 0) FROM branchStock bs WHERE bs.variantId = v.id) > 0
      )
    ORDER BY (SELECT COUNT(*) FROM invoiceItems ii WHERE ii.variantId = v.id) DESC
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; cost: string | null; salesCount: number; totalStock: number }>, unknown])[0];
  return list.map((r) => ({
    variantId: r.vid,
    productId: r.pid,
    sku: r.sku,
    productName: r.name,
    code: "L4" as const,
    severity: "warning" as const,
    metrics: { cost: 0, salesCount: Number(r.salesCount), totalStock: Number(r.totalStock) },
    note: `تكلفة صفر مع نشاط: ${r.salesCount} بيعة، ${r.totalStock} مخزون. COGS مضخَّم — كل بيعة ربحٌ وهميّ ١٠٠٪.`,
  }));
}

/** L5 — معامل تحويل شاذّ (≤ ١ لغير الأساس، > ١٠٠٠٠). blocker إن ≤ ١، warning إن > 10k. */
export async function detectL5(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           u.id AS uid, u.unitName, u.conversionFactor AS factor
    FROM productUnits u
    JOIN productVariants v ON v.id = u.variantId
    JOIN products p ON p.id = v.productId
    WHERE COALESCE(u.isBaseUnit, 0) = 0
      AND COALESCE(u.isActive, 1) = 1
      AND COALESCE(v.isActive, 1) = 1
      AND (u.conversionFactor <= 1 OR u.conversionFactor > ${ABS_MAX_CONVERSION_FACTOR})
    ORDER BY u.conversionFactor DESC
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; uid: number; unitName: string; factor: string }>, unknown])[0];
  return list.map((r) => {
    const factor = Number(r.factor);
    const isBroken = factor <= 1;
    return {
      variantId: r.vid,
      productId: r.pid,
      sku: r.sku,
      productName: r.name,
      code: "L5" as const,
      severity: (isBroken ? "blocker" : "warning") as LensSeverity,
      metrics: { factor, unitId: r.uid, unitName: r.unitName },
      note: isBroken
        ? `الوحدة «${r.unitName}» غير أساس بمعامل ${factor} — تكرارٌ للأساس، يخدع حسابات المخزون.`
        : `الوحدة «${r.unitName}» بمعامل ${factor.toLocaleString("en-US")} — قيمة غير معتادة، راجعها.`,
    };
  });
}

/** L6 — تكلفة الوحدة (baseCost × factor) > سعر الوحدة (يمسك أخطاء تسعير الكارتون/العبوة). */
export async function detectL6(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           u.id AS uid, u.unitName, u.conversionFactor AS factor,
           v.costPrice AS baseCost, pp.price AS unitRetail
    FROM productUnits u
    JOIN productVariants v ON v.id = u.variantId
    JOIN products p ON p.id = v.productId
    JOIN productPrices pp ON pp.productUnitId = u.id AND pp.priceTier = 'RETAIL'
    WHERE COALESCE(u.isBaseUnit, 0) = 0
      AND COALESCE(u.isActive, 1) = 1
      AND COALESCE(v.isActive, 1) = 1
      AND COALESCE(p.isConsignment, 0) = 0
      AND COALESCE(p.isBundle, 0) = 0
      AND COALESCE(p.isService, 0) = 0
      AND v.costPrice > 0
      AND pp.price > 0
      AND v.costPrice * u.conversionFactor > pp.price
    ORDER BY (v.costPrice * u.conversionFactor) / pp.price DESC
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; uid: number; unitName: string; factor: string; baseCost: string; unitRetail: string }>, unknown])[0];
  return list.map((r) => {
    const factor = Number(r.factor);
    const baseCost = Number(r.baseCost);
    const unitRetail = Number(r.unitRetail);
    const unitCost = baseCost * factor;
    const ratio = unitRetail > 0 ? unitCost / unitRetail : 0;
    const severity: LensSeverity = ratio >= 2 ? "blocker" : "warning";
    return {
      variantId: r.vid,
      productId: r.pid,
      sku: r.sku,
      productName: r.name,
      code: "L6" as const,
      severity,
      metrics: { baseCost, factor, unitCost, unitRetail, ratio: Math.round(ratio * 100) / 100, unitId: r.uid, unitName: r.unitName },
      note: `تكلفة «${r.unitName}» = ${baseCost}×${factor.toLocaleString("en-US")} = ${unitCost.toLocaleString("en-US")} > سعرها ${unitRetail.toLocaleString("en-US")} بنسبة ${ratio.toFixed(2)}×.`,
    };
  });
}


/**
 * L7 — **صنفٌ نشطٌ بلا سعر قائمةٍ موجب لوحدته الأساس** (blocker). H7، قرار المالك ١٨/٨/٢٦.
 *
 * هذه العدسةُ **شرطُ تشغيل** حارسِ البيع لا زينةٌ بجانبه: الحارس يرفض بيع بندٍ بلا مرجعٍ موجب،
 * فلو فُعِّل على مخزونٍ فيه أصنافٌ ناقصة السعر لَتوقّف الكاشير أمام الزبون بلا أن يعرف أحدٌ
 * كم صنفاً في هذه الحال. العدسةُ تُظهر القائمة **قبل** أن تُظهرها الطوابير — وهي نفسُ الدرس
 * الذي كلّفنا #596 (إقفالٌ شاملٌ نُشر قبل التحقّق أنّ المسار يقبل حمولته).
 *
 * «بلا سعر» يشمل **الصفّ الغائب والصفّ الصفريّ معاً**: أمام القسمة في بوّابة الانحراف لا فرق
 * بينهما — كلاهما مقامٌ صفر ⇒ لا حارس. تُستثنى البطاقات الرقمية (سعرُها في جداول تسعيرها،
 * وصفُّها النائب بصفرٍ مقصود) والبكجات والخِدمات المركّبة تتبع نفس استثناءات بقيّة العدسات.
 */
export async function detectL7(db: Db, limit = 200): Promise<AnomalyFinding[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS pid, v.id AS vid, v.sku, p.name,
           pu.id AS uid, pu.unitName,
           (SELECT COALESCE(MAX(pp.price), 0) FROM productPrices pp
            WHERE pp.productUnitId = pu.id AND pp.priceTier = 'RETAIL') AS retail,
           (SELECT COUNT(*) FROM invoiceItems ii WHERE ii.variantId = v.id) AS salesCount
    FROM productVariants v
    JOIN products p ON p.id = v.productId
    JOIN productUnits pu ON pu.variantId = v.id AND pu.isBaseUnit = 1
    WHERE COALESCE(v.isActive, 1) = 1
      AND COALESCE(p.isActive, 1) = 1
      AND COALESCE(pu.isActive, 1) = 1
      AND COALESCE(p.productType, '') <> 'DIGITAL_CARD'
      AND COALESCE(p.isConsignment, 0) = 0
      AND (SELECT COALESCE(MAX(pp.price), 0) FROM productPrices pp
           WHERE pp.productUnitId = pu.id AND pp.priceTier = 'RETAIL') <= 0
    ORDER BY (SELECT COUNT(*) FROM invoiceItems ii WHERE ii.variantId = v.id) DESC, v.id ASC
    LIMIT ${limit}
  `);
  const list = (rows as unknown as [Array<{ pid: number; vid: number; sku: string; name: string; uid: number; unitName: string; retail: string | null; salesCount: number }>, unknown])[0];
  return list.map((r) => ({
    variantId: r.vid,
    productId: r.pid,
    sku: r.sku,
    productName: r.name,
    code: "L7" as const,
    severity: "blocker" as const,
    metrics: { retail: Number(r.retail ?? 0), salesCount: Number(r.salesCount), unitId: r.uid, unitName: r.unitName },
    note:
      `بلا سعر مفرد للوحدة الأساس «${r.unitName}» — لا يُباع (سياسة إلزام سعر القائمة)، ` +
      `و${Number(r.salesCount) > 0 ? `له ${r.salesCount} بيعة سابقة مرّت بلا مرجعٍ يُقاس عليه أيّ خصم` : "لم يُبع بعد"}.`,
  }));
}

/** يشغّل كل العدسات ويعيد صفوفاً مدمجة (مُدَدَّة إن أخطأ متغيّرٌ من ٢ عدسة). */
export async function detectAll(db: Db, limitPerLens = 200): Promise<AnomalyFinding[]> {
  const results = await Promise.all([
    detectL1(db, limitPerLens),
    detectL2(db, limitPerLens),
    detectL3(db, limitPerLens),
    detectL4(db, limitPerLens),
    detectL5(db, limitPerLens),
    detectL6(db, limitPerLens),
    detectL7(db, limitPerLens),
  ]);
  return results.flat();
}
