// باركودات بديلة (aliases) لوحدة المنتج — نقطة الحقيقة الوحيدة للقراءة/الكتابة/الفحص.
//
// الاختراع الأساسيّ: باركود واحد لا يخصّ سلعتين مختلفتين. هذه الوحدة تُنسّق ذلك بين
// `productUnits.barcode` (الأساسيّ) و `productUnitBarcodes.barcode` (البديل) — فحص التفرّد
// يمرّ على الجدولين معاً قبل أيّ إدراج، والبحث بالباركود يمرّ عليهما معاً كذلك.
//
// (٤/٩) التطبيع: كل باركود يدخل هنا — للحفظ أو للمطابقة — يمرّ بـ`canonicalizeBarcodeInput`
// (تقليم + طيّ أرقام عربية-هندية). وللمطابقة مسارٌ احتياطيّ على العمود المُطبَّع داخل SQL كي يبقى
// الإرثُ الملوَّث (صفوفٌ حُفظت قبل التطبيع بمسافةٍ طرفية) قابلاً للمسح بلا هجرةِ بيانات.
import { TRPCError } from "@trpc/server";
import { asc, eq, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ProductBarcodeMatchKind } from "@shared/productScan";
import { barcodeIdentityCandidates, canonicalizeBarcodeInput } from "@shared/barcodeNormalize";
import { appErrorMessage } from "@shared/errors";
import { getDb, type DB, type Tx } from "../../db";
import { productUnits, productUnitBarcodes, productVariants, products } from "../../../drizzle/schema";
import { foldDigitsSql } from "../../lib/similarMatch";

type DbOrTx = DB | Tx;

export type BarcodeOwner = {
  productUnitId: number;
  productId: number;
  variantId: number;
  productName: string;
  variantName: string | null;
  unitName: string;
  sku: string | null;
  matchKind: ProductBarcodeMatchKind;
  primaryBarcode: string | null;
  factor: number;
  productActive: boolean;
  variantActive: boolean;
  unitActive: boolean;
  isBundle: boolean;
  isService: boolean;
};

export type BarcodeOwnerResolution =
  | { status: "FOUND"; owner: BarcodeOwner }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS" };

export function barcodeAmbiguityMessage(what: string): string {
  return appErrorMessage({
    what,
    why: "الباركود يطابق أكثر من وحدة في الكتالوج، واختيار إحداها آلياً قد ينفّذ العملية على الصنف الخطأ",
    doThis: "افتح المنتجات وصحّح الباركودات المتعارضة، ثم أعد المسح",
  });
}

/**
 * الباركود المخزَّن بعد تطبيعه داخل SQL: تقليم + حالةٌ موحّدة (صغيرة) + طيّ الأرقام العربية-الهندية
 * والفارسية — يُقارَن بمُدخلٍ مُطبَّعٍ **بحروفٍ صغيرة**.
 *
 * تُستعمل أيضاً للتحقق من تعارض الإرث قبل قبول التطابق الحرفي: وجود صف نظيف لا يثبت
 * انفراده بالهوية. لا نخزّن نتيجة هذا الفحص في كاش كي تظهر الكتابات المتزامنة فوراً.
 */
export function normalizedStoredBarcodeSql(column: SQLWrapper): SQL {
  if (column === productUnits.barcode) return sql`${productUnits.barcodeNormalized}`;
  if (column === productUnitBarcodes.barcode) return sql`${productUnitBarcodes.barcodeNormalized}`;
  // يجب أن يُطابق `canonicalizeBarcodeInput` (الذي يقلّم بـJS `String.prototype.trim()`): وهذا يزيل
  // **كلّ** الفراغات الطرفية (space + \t \n \r \f \v + NBSP)، لا مسافة ASCII وحدها كما يفعل MySQL
  // `TRIM()` بلا وسيط. عدمُ التكافؤ كان يُعمي المسارَ الاحتياطيّ وكشفَ الصدام عن إرثٍ ملوَّث بتبويب/سطرٍ
  // جديد (لاحقة Excel/الماسح CR/LF/Tab — وهي المصدر الذي صرّح به هذا الإصلاح). التقليم **طرفيٌّ فقط**
  // (`^…|…$`) حفاظاً على مسافة Code39 الداخليّة المعنويّة التي يُبقيها التطبيعُ نفسه. NBSP (بايتاه C2A0)
  // قد لا يلتقطه `[[:space:]]` في بعض البناءات فنذكره صراحةً عند الحواف فقط. القيم كلّها معاملات ⇒ لا حقن.
  let visible: SQL = sql`${column}`;
  for (const mark of ["\u00ad", "\u061c", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064", "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff"]) {
    visible = sql`replace(${visible}, ${mark}, '')`;
  }
  const edge = "[\\x{0000}-\\x{0020}\\x{007f}-\\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}]";
  const trimmed = sql`regexp_replace(${visible}, ${`^${edge}+|${edge}+$`}, '')`;
  return foldDigitsSql(sql`lower(${trimmed})`);
}

/** شرط «يساوي أيّاً من القيم» على العمود المُطبَّع — لكشف الصدام مع الإرث الملوَّث. مُصدَّرٌ لإعادة
 *  استعماله في كشف مُلّاك الإرث الملوَّث بمسار الاستيراد (import/products). */
export function normalizedMatchAny(column: SQLWrapper, codes: string[]): SQL | undefined {
  const lows = Array.from(
    new Set(codes.flatMap(barcodeIdentityCandidates).map((candidate) => candidate.toLowerCase())),
  );
  if (!lows.length) return undefined;
  return inArray(normalizedStoredBarcodeSql(column), lows);
}

async function findPrimaryOwners(db: DbOrTx, where: SQL): Promise<BarcodeOwner[]> {
  const rows = await db
    .select({
      productUnitId: productUnits.id,
      productId: products.id,
      variantId: productVariants.id,
      productName: products.name,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      sku: productVariants.sku,
      primaryBarcode: productUnits.barcode,
      factor: productUnits.conversionFactor,
      productActive: products.isActive,
      variantActive: productVariants.isActive,
      unitActive: productUnits.isActive,
      isBundle: products.isBundle,
      isService: products.isService,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(where)
    .orderBy(asc(productUnits.id))
    .limit(2);
  return rows.map((r) => ({
    productUnitId: Number(r.productUnitId),
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productName: r.productName,
    variantName: r.variantName,
    unitName: r.unitName,
    sku: r.sku,
    matchKind: "PRIMARY",
    primaryBarcode: r.primaryBarcode,
    factor: Number(r.factor),
    productActive: Boolean(r.productActive),
    variantActive: Boolean(r.variantActive),
    unitActive: Boolean(r.unitActive),
    isBundle: Boolean(r.isBundle),
    isService: Boolean(r.isService),
  }));
}

async function findAliasOwners(db: DbOrTx, where: SQL): Promise<BarcodeOwner[]> {
  const rows = await db
    .select({
      productUnitId: productUnitBarcodes.productUnitId,
      productId: products.id,
      variantId: productVariants.id,
      productName: products.name,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      sku: productVariants.sku,
      primaryBarcode: productUnits.barcode,
      factor: productUnits.conversionFactor,
      productActive: products.isActive,
      variantActive: productVariants.isActive,
      unitActive: productUnits.isActive,
      isBundle: products.isBundle,
      isService: products.isService,
    })
    .from(productUnitBarcodes)
    .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(where)
    .orderBy(asc(productUnitBarcodes.id))
    .limit(2);
  return rows.map((r) => ({
    productUnitId: Number(r.productUnitId),
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productName: r.productName,
    variantName: r.variantName,
    unitName: r.unitName,
    sku: r.sku,
    matchKind: "ALIAS",
    primaryBarcode: r.primaryBarcode,
    factor: Number(r.factor),
    productActive: Boolean(r.productActive),
    variantActive: Boolean(r.variantActive),
    unitActive: Boolean(r.unitActive),
    isBundle: Boolean(r.isBundle),
    isService: Boolean(r.isService),
  }));
}

/**
 * المسار الاحتياطيّ الشافي: يطابق العمود المُطبَّع (لإرثٍ حُفظ قبل تطبيع الكتابة)، لكنّه **يرفض الحسم
 * عند تعدّد المالك**. لو تطبّع صفّان ملوّثان على وحدتين مختلفتين إلى القيمة نفسها («10095 » و«10095\t»)،
 * فإعادةُ أدنى id صامتاً تُسعّر المسحَ وتخصم مخزونَ **غير صاحبه** (نقضُ «لا دينار لغير صاحبه»، §٥). عند
 * الغموض نُرجع null ⇒ رسالةُ «لا يطابق» الصاخبة، فيبحث الكاشير يدوياً بدل تسعيرٍ خاطئ صامت. يجمع المُلّاك
 * المتمايزين (بمعرّف الوحدة) عبر الجدولين؛ واحدٌ ⇒ يُعاد، صفرٌ ⇒ غير موجود، أكثرُ ⇒ غموضٌ ⇒ null.
 */
async function resolveNormalizedOwner(db: DbOrTx, candidates: string[]): Promise<BarcodeOwnerResolution> {
  // نعدّ المُلّاك المتمايزين بـ **معرّف الوحدة** لا بالصفوف: وحدةٌ واحدة قد تملك عدّة بدائلَ ملوّثة
  // تتطبّع كلّها إلى القيمة نفسها، فحدُّ الصفوف (limit 2) قد يُرجع صفَّين لمالكٍ واحد ويُخفي مالكاً
  // ثالثاً مختلفاً ⇒ حسمٌ خاطئ (مراجعة Codex P1). لذا نُجمّع على معرّف الوحدة (`groupBy`) ونحدّ
  // بمالكَين متمايزين — يكفيان للحكم بالغموض. الأساسيّ صفٌّ لكلّ وحدة فتمايزُه مضمونٌ أصلاً.
  const primUnits = await db
    .select({ id: productUnits.id })
    .from(productUnits)
    .where(normalizedMatchAny(productUnits.barcode, candidates))
    .groupBy(productUnits.id)
    .limit(2);
  const ownerIds = new Set<number>(primUnits.map((r) => Number(r.id)));
  if (ownerIds.size < 2) {
    const aliUnits = await db
      .select({ id: productUnitBarcodes.productUnitId })
      .from(productUnitBarcodes)
      .where(normalizedMatchAny(productUnitBarcodes.barcode, candidates))
      .groupBy(productUnitBarcodes.productUnitId)
      .limit(2);
    for (const r of aliUnits) ownerIds.add(Number(r.id));
  }
  if (ownerIds.size === 0) return { status: "NOT_FOUND" };
  if (ownerIds.size > 1) return { status: "AMBIGUOUS" };
  const unitId = ownerIds.values().next().value as number;
  const isPrimary = primUnits.some((r) => Number(r.id) === unitId);
  const [row] = await db
    .select({
      productId: products.id,
      variantId: productVariants.id,
      productName: products.name,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      sku: productVariants.sku,
      primaryBarcode: productUnits.barcode,
      factor: productUnits.conversionFactor,
      productActive: products.isActive,
      variantActive: productVariants.isActive,
      unitActive: productUnits.isActive,
      isBundle: products.isBundle,
      isService: products.isService,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productUnits.id, unitId))
    .limit(1);
  if (!row) return { status: "NOT_FOUND" };
  return { status: "FOUND", owner: {
    productUnitId: unitId,
    productId: Number(row.productId),
    variantId: Number(row.variantId),
    productName: row.productName,
    variantName: row.variantName,
    unitName: row.unitName,
    sku: row.sku,
    matchKind: isPrimary ? "PRIMARY" : "ALIAS",
    primaryBarcode: row.primaryBarcode,
    factor: Number(row.factor),
    productActive: Boolean(row.productActive),
    variantActive: Boolean(row.variantActive),
    unitActive: Boolean(row.unitActive),
    isBundle: Boolean(row.isBundle),
    isService: Boolean(row.isService),
  } };
}

/** يحلّ باركوداً واحداً إلى وحدة المنتج المالكة — أساسيّاً كان أو بديلاً. للاستعمال الداخليّ. */
export async function resolveBarcodeOwnerResult(
  db: DbOrTx,
  code: string,
  options?: { allowNormalizedFallback?: boolean },
): Promise<BarcodeOwnerResolution> {
  const c = canonicalizeBarcodeInput(code);
  if (!c) return { status: "NOT_FOUND" };
  const candidates = barcodeIdentityCandidates(c);
  // المسار السريع مفهرس، لكنه يجمع الشكلين UPC-A/EAN-13 وعبر الجدولين قبل الحسم.
  // إن امتلك الشكلين مالكان مختلفان نفشل بصخب بدلاً من خصم مخزون الصنف الخطأ.
  const primaryMatches = await findPrimaryOwners(db, inArray(productUnits.barcode, candidates));
  const aliasMatches = await findAliasOwners(db, inArray(productUnitBarcodes.barcode, candidates));
  const exactOwners = new Set([...primaryMatches, ...aliasMatches].map((owner) => owner.productUnitId));
  if (exactOwners.size > 1) return { status: "AMBIGUOUS" };
  if (exactOwners.size === 1) {
    // التطابق الحرفي لا يجيز تجاوز تعارض مع صف إرثي على وحدة أخرى.
    return resolveNormalizedOwner(db, candidates);
  }
  if (options?.allowNormalizedFallback === false) return { status: "NOT_FOUND" };
  // المسار الاحتياطيّ (٤/٩): صفٌّ حُفظ قبل تطبيع الحفظ قد يحمل فراغاً طرفياً أو رقماً عربياً-هندياً ⇒
  // المساواة الخامّة تُخطئه رغم أنّ الباركود «هو نفسه» بعين الإنسان والماسح. نُطبّع العمودَ داخل SQL
  // ونقارن بالمُدخل المُطبَّع، **رافضين الحسمَ عند تعدّد المالك** (لئلّا يُسعَّر المسحُ لغير صاحبه).
  // الكلفة مسحٌ بلا فهرس — تُدفَع فقط حين يُخطئ المسار السريع (المسحُ الموجود يعود فوراً)، لا على كلّ مسح.
  return resolveNormalizedOwner(db, candidates);
}

export async function resolveBarcodeOwner(db: DbOrTx, code: string): Promise<BarcodeOwner | null> {
  const result = await resolveBarcodeOwnerResult(db, code);
  return result.status === "FOUND" ? result.owner : null;
}

/** كاشف صدامات الباركود داخل معاملة الكتابة (tx) — نقطة الحقيقة للـwrite paths.
 *  يمرّ على الأساسيّ والبديل معاً، ويسمح بتجاهل وحدات معيّنة (لحالات التحديث الذاتيّ).
 *  رجوعه فارغ ⇒ آمن للإدراج/التحديث. يرى الإرثَ الملوَّث أيضاً: «10095» الجديد يصطدم بـ«10095 »
 *  المخزَّن على سلعةٍ أخرى — وإلّا صار للرمز الواحد مالكان يفصل بينهما مسافةٌ لا يراها أحد. */
export async function findBarcodeClashes(
  tx: DbOrTx,
  codes: string[],
  opts?: { ignorePrimaryUnitIds?: number[]; ignoreAliasIds?: number[]; ignoreProductIds?: number[] },
): Promise<Array<{ code: string; takenBy: string; source: "primary" | "alias" }>> {
  const clean = Array.from(new Set(codes.flatMap(barcodeIdentityCandidates).filter(Boolean)));
  if (!clean.length) return [];
  const ignorePrim = opts?.ignorePrimaryUnitIds ?? [];
  const ignoreAli = opts?.ignoreAliasIds ?? [];
  const ignoreProducts = opts?.ignoreProductIds ?? [];

  const primary = await tx
    .select({ id: productUnits.id, code: productUnits.barcode, productId: products.id, productName: products.name, sku: productVariants.sku })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(or(inArray(productUnits.barcode, clean), normalizedMatchAny(productUnits.barcode, clean)));

  const aliases = await tx
    .select({
      id: productUnitBarcodes.id,
      code: productUnitBarcodes.barcode,
      productId: products.id,
      productName: products.name,
      sku: productVariants.sku,
    })
    .from(productUnitBarcodes)
    .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(or(inArray(productUnitBarcodes.barcode, clean), normalizedMatchAny(productUnitBarcodes.barcode, clean)));

  const out: Array<{ code: string; takenBy: string; source: "primary" | "alias" }> = [];
  for (const r of primary) {
    if (!r.code) continue;
    if (ignorePrim.includes(Number(r.id))) continue;
    if (ignoreProducts.includes(Number(r.productId))) continue;
    out.push({ code: r.code, takenBy: `${r.productName} (${r.sku})`, source: "primary" });
  }
  for (const r of aliases) {
    if (ignoreAli.includes(Number(r.id))) continue;
    if (ignoreProducts.includes(Number(r.productId))) continue;
    out.push({ code: r.code, takenBy: `${r.productName} (${r.sku}) — بديل`, source: "alias" });
  }
  return out;
}

/** يفحص قائمةً من الباركودات ويعيد المُستعمَل منها (بصريّاً أو بديلاً) — للتحقّق اللحظيّ قبل الحفظ. */
export async function checkBarcodesTakenAcrossBoth(codes: string[]): Promise<Array<{ code: string; takenBy: string }>> {
  const db = getDb();
  if (!db) return [];
  const clean = Array.from(new Set(codes.flatMap(barcodeIdentityCandidates).filter(Boolean)));
  if (!clean.length) return [];

  const primary = await db
    .select({ code: productUnits.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(or(inArray(productUnits.barcode, clean), normalizedMatchAny(productUnits.barcode, clean)));

  const aliases = await db
    .select({ code: productUnitBarcodes.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnitBarcodes)
    .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(or(inArray(productUnitBarcodes.barcode, clean), normalizedMatchAny(productUnitBarcodes.barcode, clean)));

  const dedup = new Map<string, string>();
  for (const r of primary) {
    if (r.code) dedup.set(r.code, `${r.productName} (${r.sku})`);
  }
  for (const r of aliases) {
    if (r.code && !dedup.has(r.code)) dedup.set(r.code, `${r.productName} (${r.sku}) — بديل`);
  }
  return Array.from(dedup.entries()).map(([code, takenBy]) => ({ code, takenBy }));
}

/** يمنع إضافة باركود بديل يخصّ الوحدة الحاليّة أو أيّ وحدة أخرى بأيّ شكل. */
export async function assertBarcodeFree(code: string, opts?: { ignoreUnitId?: number }): Promise<void> {
  const clean = canonicalizeBarcodeInput(code);
  if (!clean) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود فارغ." });
  if (clean.length > 64) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود أطول من ٦٤ خانة." });
  const taken = await checkBarcodesTakenAcrossBoth([clean]);
  if (!taken.length) return;
  // ignoreUnitId يُستعمَل حين يكون الباركود بالفعل الأساسيّ لهذه الوحدة (مسموح، لا حاجة لبديل).
  if (opts?.ignoreUnitId) {
    const owner = await resolveBarcodeOwner(getDb()!, clean);
    if (owner && owner.productUnitId === opts.ignoreUnitId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "هذا الباركود هو الأساسيّ لهذه الوحدة نفسها — لا حاجة لإضافته كبديل.",
      });
    }
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: `الباركود ${clean} مُستعمَل في «${taken[0].takenBy}» — غيّره أو احذفه من هناك أوّلاً.`,
  });
}

/** ينقل كل البدائل من وحدة إلى أخرى داخل معاملة — يُستعمَل عند إعادة تسمية الوحدة في
 *  `updateProductWithVariants` (كي لا تبقى البدائل عالقةً على الوحدة المعطَّلة). */
export async function migrateAliases(tx: DbOrTx, fromUnitId: number, toUnitId: number): Promise<number> {
  if (fromUnitId === toUnitId) return 0;
  const existing = await tx
    .select({ id: productUnitBarcodes.id })
    .from(productUnitBarcodes)
    .where(eq(productUnitBarcodes.productUnitId, fromUnitId));
  if (!existing.length) return 0;
  await tx
    .update(productUnitBarcodes)
    .set({ productUnitId: toUnitId })
    .where(eq(productUnitBarcodes.productUnitId, fromUnitId));
  return existing.length;
}

/** يحلّ (variantId + unitName) إلى productUnitId — يُستعمَل من الواجهة حين لا تحمل الـid مباشرةً. */
export async function resolveProductUnitId(variantId: number, unitName: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ id: productUnits.id })
    .from(productUnits)
    .where(eq(productUnits.variantId, variantId))
    .limit(50);
  if (!row) return null;
  // نقرأ كل وحدات المتغيّر ثم نطابق بالاسم (تفادياً لتكرار where على varchar).
  const allUnits = await db
    .select({ id: productUnits.id, unitName: productUnits.unitName })
    .from(productUnits)
    .where(eq(productUnits.variantId, variantId));
  const target = unitName.trim();
  const match = allUnits.find((u) => u.unitName === target);
  return match ? Number(match.id) : null;
}

/** يُعيد كل الباركودات (الأساسيّ + البدائل) لوحدةٍ ما. تُستعمَل في شاشة التعديل. */
export async function listUnitBarcodes(productUnitId: number) {
  const db = getDb();
  if (!db) return { primary: null as string | null, aliases: [] as Array<{ id: number; barcode: string; note: string | null; createdAt: Date }> };
  const [primaryRow] = await db
    .select({ barcode: productUnits.barcode })
    .from(productUnits)
    .where(eq(productUnits.id, productUnitId))
    .limit(1);
  const aliases = await db
    .select({
      id: productUnitBarcodes.id,
      barcode: productUnitBarcodes.barcode,
      note: productUnitBarcodes.note,
      createdAt: productUnitBarcodes.createdAt,
    })
    .from(productUnitBarcodes)
    .where(eq(productUnitBarcodes.productUnitId, productUnitId))
    .orderBy(productUnitBarcodes.createdAt);
  return {
    primary: primaryRow?.barcode ?? null,
    aliases: aliases.map((a) => ({ ...a, id: Number(a.id) })),
  };
}

/**
 * البدائل لعدّة وحداتٍ دفعةً واحدة (استعلامٌ واحد) — تُغذّي منتقي «أيّ باركود يُطبع؟» في شاشة
 * الملصقات. الفتح صفّاً صفّاً عبر `listUnitBarcodes` كان سيصير N+1 على قائمة طباعةٍ طويلة،
 * وإخفاء المنتقي بلا معرفةٍ مسبقة كان سيُخفي البدائل أصلاً. الوحدات بلا بدائل تغيب عن الخريطة
 * ⇒ الواجهة لا تعرض منتقياً حيث لا خيار (لا زرٌّ يقول «لا بدائل» على كلّ صفّ).
 */
export async function listUnitBarcodesMany(
  productUnitIds: number[],
): Promise<Record<number, Array<{ id: number; barcode: string; note: string | null }>>> {
  const db = getDb();
  const ids = Array.from(new Set(productUnitIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (!db || !ids.length) return {};
  const rows = await db
    .select({
      id: productUnitBarcodes.id,
      productUnitId: productUnitBarcodes.productUnitId,
      barcode: productUnitBarcodes.barcode,
      note: productUnitBarcodes.note,
    })
    .from(productUnitBarcodes)
    .where(inArray(productUnitBarcodes.productUnitId, ids))
    .orderBy(productUnitBarcodes.createdAt);
  const out: Record<number, Array<{ id: number; barcode: string; note: string | null }>> = {};
  for (const r of rows) {
    const key = Number(r.productUnitId);
    (out[key] ??= []).push({ id: Number(r.id), barcode: r.barcode, note: r.note });
  }
  return out;
}

/** يضيف باركوداً بديلاً — يفحص التفرّد العالميّ قبل الإدراج. */
export async function addUnitBarcodeAlias(
  productUnitId: number,
  barcode: string,
  note: string | null,
  createdBy: number | null,
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مُهيّأة." });
  const clean = canonicalizeBarcodeInput(barcode);
  await assertBarcodeFree(clean, { ignoreUnitId: productUnitId });
  // تحقّق أنّ الوحدة نفسها موجودة (تجنّب FK error غامضاً للمستخدم).
  const [unit] = await db.select({ id: productUnits.id }).from(productUnits).where(eq(productUnits.id, productUnitId)).limit(1);
  if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "وحدة المنتج غير موجودة." });
  await db.insert(productUnitBarcodes).values({
    productUnitId,
    barcode: clean,
    note: note?.trim() || null,
    createdBy,
  });
  return { ok: true };
}

/** يحذف باركوداً بديلاً بمعرّفه. الأساسيّ لا يُحذَف من هنا (يبقى في `productUnits.barcode`). */
export async function removeUnitBarcodeAlias(id: number) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مُهيّأة." });
  const [row] = await db
    .select({ id: productUnitBarcodes.id })
    .from(productUnitBarcodes)
    .where(eq(productUnitBarcodes.id, id))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الباركود البديل غير موجود." });
  await db.delete(productUnitBarcodes).where(eq(productUnitBarcodes.id, id));
  return { ok: true };
}
