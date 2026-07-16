// باركودات بديلة (aliases) لوحدة المنتج — نقطة الحقيقة الوحيدة للقراءة/الكتابة/الفحص.
//
// الاختراع الأساسيّ: باركود واحد لا يخصّ سلعتين مختلفتين. هذه الوحدة تُنسّق ذلك بين
// `productUnits.barcode` (الأساسيّ) و `productUnitBarcodes.barcode` (البديل) — فحص التفرّد
// يمرّ على الجدولين معاً قبل أيّ إدراج، والبحث بالباركود يمرّ عليهما معاً كذلك.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { getDb, type DB, type Tx } from "../../db";
import { productUnits, productUnitBarcodes, productVariants, products } from "../../../drizzle/schema";

type DbOrTx = DB | Tx;

export type BarcodeOwner = { productUnitId: number; productName: string; unitName: string; sku: string | null };

/** يحلّ باركوداً واحداً إلى وحدة المنتج المالكة — أساسيّاً كان أو بديلاً. للاستعمال الداخليّ. */
export async function resolveBarcodeOwner(db: DbOrTx, code: string): Promise<BarcodeOwner | null> {
  const c = code.trim();
  if (!c) return null;
  // الأساسيّ أوّلاً — أسرع (مؤشّر مباشر على productUnits.barcode).
  const primary = await db
    .select({
      productUnitId: productUnits.id,
      productName: products.name,
      unitName: productUnits.unitName,
      sku: productVariants.sku,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productUnits.barcode, c))
    .limit(1);
  if (primary[0]) {
    return {
      productUnitId: Number(primary[0].productUnitId),
      productName: primary[0].productName,
      unitName: primary[0].unitName,
      sku: primary[0].sku,
    };
  }
  // البديل ثانياً.
  const alias = await db
    .select({
      productUnitId: productUnitBarcodes.productUnitId,
      productName: products.name,
      unitName: productUnits.unitName,
      sku: productVariants.sku,
    })
    .from(productUnitBarcodes)
    .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productUnitBarcodes.barcode, c))
    .limit(1);
  if (!alias[0]) return null;
  return {
    productUnitId: Number(alias[0].productUnitId),
    productName: alias[0].productName,
    unitName: alias[0].unitName,
    sku: alias[0].sku,
  };
}

/** كاشف صدامات الباركود داخل معاملة الكتابة (tx) — نقطة الحقيقة للـwrite paths.
 *  يمرّ على الأساسيّ والبديل معاً، ويسمح بتجاهل وحدات معيّنة (لحالات التحديث الذاتيّ).
 *  رجوعه فارغ ⇒ آمن للإدراج/التحديث. */
export async function findBarcodeClashes(
  tx: DbOrTx,
  codes: string[],
  opts?: { ignorePrimaryUnitIds?: number[]; ignoreAliasIds?: number[] },
): Promise<Array<{ code: string; takenBy: string; source: "primary" | "alias" }>> {
  const clean = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean)));
  if (!clean.length) return [];
  const ignorePrim = opts?.ignorePrimaryUnitIds ?? [];
  const ignoreAli = opts?.ignoreAliasIds ?? [];

  const primary = await tx
    .select({ id: productUnits.id, code: productUnits.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.barcode, clean));

  const aliases = await tx
    .select({
      id: productUnitBarcodes.id,
      code: productUnitBarcodes.barcode,
      productName: products.name,
      sku: productVariants.sku,
    })
    .from(productUnitBarcodes)
    .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnitBarcodes.barcode, clean));

  const out: Array<{ code: string; takenBy: string; source: "primary" | "alias" }> = [];
  for (const r of primary) {
    if (!r.code) continue;
    if (ignorePrim.includes(Number(r.id))) continue;
    out.push({ code: r.code, takenBy: `${r.productName} (${r.sku})`, source: "primary" });
  }
  for (const r of aliases) {
    if (ignoreAli.includes(Number(r.id))) continue;
    out.push({ code: r.code, takenBy: `${r.productName} (${r.sku}) — بديل`, source: "alias" });
  }
  return out;
}

/** يفحص قائمةً من الباركودات ويعيد المُستعمَل منها (بصريّاً أو بديلاً) — للتحقّق اللحظيّ قبل الحفظ. */
export async function checkBarcodesTakenAcrossBoth(codes: string[]): Promise<Array<{ code: string; takenBy: string }>> {
  const db = getDb();
  if (!db) return [];
  const clean = Array.from(new Set(codes.map((c) => c.trim()).filter(Boolean)));
  if (!clean.length) return [];

  const primary = await db
    .select({ code: productUnits.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.barcode, clean));

  const aliases = await db
    .select({ code: productUnitBarcodes.barcode, productName: products.name, sku: productVariants.sku })
    .from(productUnitBarcodes)
    .innerJoin(productUnits, eq(productUnitBarcodes.productUnitId, productUnits.id))
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnitBarcodes.barcode, clean));

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
  const clean = code.trim();
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
  const clean = barcode.trim();
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

