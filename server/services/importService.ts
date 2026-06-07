// خدمة الاستيراد بالجملة (بيانات أساسية فقط: عملاء/موردون/منتجات).
// النمط: تحقّق كامل أولاً ⇒ إن وُجد أي فشل لا تُكتب أي بيانات (الكل أو لا شيء) ⇒ وإلا فالكتابة داخل withTx واحد.
// الأموال نصاً عبر toDbMoney (قاعدة §٥). لا استيراد لمستندات مالية (خطِر — انظر CLAUDE.md/الخطة).
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  categories,
  customers,
  importBatches,
  productPrices,
  productUnits,
  productVariants,
  products,
  suppliers,
} from "../../drizzle/schema";
import { logger } from "../logger";
import { toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";

// ───────────────────────── العقد المشترك ─────────────────────────

export type OnExisting = "skip" | "update" | "error";
export type ImportOptions = {
  dryRun?: boolean;
  onExisting?: OnExisting;
  fileName?: string;
};

export type ImportRowResult = {
  rowNumber: number;
  status: "created" | "updated" | "skipped" | "failed";
  message?: string;
};

export type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  committed: boolean;
  rows: ImportRowResult[];
};

type ImportType = "CUSTOMERS" | "SUPPLIERS" | "PRODUCTS";

// ───────────────────────── مخططات الصفوف (zod) ─────────────────────────

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "قيمة مالية غير صالحة");
const phoneStr = z.string().trim().max(20);
const priceTier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const customerType = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);

export const customerImportRow = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  phone: phoneStr.optional(),
  whatsapp: phoneStr.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  district: z.string().trim().max(100).optional(),
  customerType: customerType.optional(),
  defaultPriceTier: priceTier.optional(),
  creditLimit: moneyStr.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CustomerImportRow = z.infer<typeof customerImportRow>;

export const supplierImportRow = z.object({
  rowNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  phone: phoneStr.optional(),
  email: z.string().trim().email("بريد غير صالح").max(320).optional(),
  whatsapp: phoneStr.optional(),
  address: z.string().trim().max(1000).optional(),
  city: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(50).optional(),
  productTypes: z.string().trim().max(1000).optional(),
  paymentTerms: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SupplierImportRow = z.infer<typeof supplierImportRow>;

export const productImportRow = z.object({
  rowNumber: z.number().int().positive(),
  productName: z.string().trim().min(1).max(255),
  categoryName: z.string().trim().max(255).optional(),
  isCustomizable: z.boolean().optional(),
  sku: z.string().trim().min(1).max(60),
  variantName: z.string().trim().max(255).optional(),
  color: z.string().trim().max(60).optional(),
  size: z.string().trim().max(60).optional(),
  costPrice: moneyStr,
  unitName: z.string().trim().min(1).max(40),
  conversionFactor: z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "معامل تحويل غير صالح"),
  isBaseUnit: z.boolean().optional(),
  barcode: z.string().trim().max(64).optional(),
  priceTier: priceTier.optional(),
  price: moneyStr.optional(),
});
export type ProductImportRow = z.infer<typeof productImportRow>;

// ───────────────────────── أدوات مساعدة ─────────────────────────

const norm = (s?: string | null): string | null => {
  const t = s?.trim();
  return t || null;
};
const uniq = <T>(arr: (T | null | undefined)[]): T[] =>
  Array.from(new Set(arr.filter((x): x is T => x != null && x !== "")));
const insertId = (res: unknown): number => Number((res as any)[0]?.insertId ?? (res as any).insertId);

function tally(rows: ImportRowResult[]) {
  return {
    created: rows.filter((r) => r.status === "created").length,
    updated: rows.filter((r) => r.status === "updated").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

/** يبني الملخّص ويسجّل الدفعة في importBatches (best-effort، لا يرمي). */
async function finalize(
  importType: ImportType,
  total: number,
  rows: ImportRowResult[],
  committed: boolean,
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const counts = tally(rows);
  const summary: ImportSummary = {
    total,
    ...counts,
    committed,
    rows: [...rows].sort((a, b) => a.rowNumber - b.rowNumber),
  };

  // تسجيل الدفعة للمساءلة (لا نسجّل المعاينة dry-run؛ لا تغيير حالة).
  if (!options.dryRun) {
    try {
      const db = requireDb();
      await db.insert(importBatches).values({
        batchName: options.fileName?.slice(0, 255) || `استيراد ${importType}`,
        importType,
        fileName: options.fileName?.slice(0, 255) ?? null,
        totalRows: total,
        successfulRows: counts.created + counts.updated,
        failedRows: counts.failed,
        status: committed ? "COMPLETED" : "FAILED",
        errorLog: summary.rows.filter((r) => r.status === "failed" || r.status === "skipped"),
        createdBy: actor.userId,
        completedAt: new Date(),
      });
    } catch (e) {
      logger.warn({ err: e, importType }, "تعذّر تسجيل دفعة الاستيراد");
    }
  }

  return summary;
}

function markWriteError(rows: ImportRowResult[], message: string): ImportRowResult[] {
  return rows.map((r) =>
    r.status === "created" || r.status === "updated" ? { ...r, status: "failed", message } : r,
  );
}

// ───────────────────────── العملاء ─────────────────────────

export async function importCustomers(
  rows: CustomerImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const db = requireDb();
  const results: ImportRowResult[] = [];
  const toCreate: CustomerImportRow[] = [];
  const toUpdate: { row: CustomerImportRow; id: number }[] = [];

  // مفتاح التكرار: الهاتف إن وُجد وإلا الاسم.
  const keyOf = (r: CustomerImportRow) =>
    norm(r.phone) ? `p:${norm(r.phone)}` : `n:${r.name.trim().toLowerCase()}`;
  const firstSeen = new Map<string, number>();
  const dupRows = new Set<number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (firstSeen.has(k)) dupRows.add(r.rowNumber);
    else firstSeen.set(k, r.rowNumber);
  }

  // البحث عن الموجود (دفعة واحدة).
  const phones = uniq(rows.map((r) => norm(r.phone)));
  const namesNoPhone = uniq(rows.filter((r) => !norm(r.phone)).map((r) => r.name.trim()));
  const byPhone = new Map<string, number>();
  const byName = new Map<string, number>();
  if (phones.length) {
    for (const e of await db.select({ id: customers.id, phone: customers.phone }).from(customers).where(inArray(customers.phone, phones)))
      if (e.phone) byPhone.set(e.phone, Number(e.id));
  }
  if (namesNoPhone.length) {
    for (const e of await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.name, namesNoPhone)))
      byName.set(e.name, Number(e.id));
  }

  for (const r of rows) {
    if (dupRows.has(r.rowNumber)) {
      results.push({ rowNumber: r.rowNumber, status: "failed", message: "مكرّر داخل الملف" });
      continue;
    }
    const phone = norm(r.phone);
    const existingId = phone ? byPhone.get(phone) : byName.get(r.name.trim());
    if (existingId) {
      if (onExisting === "skip") results.push({ rowNumber: r.rowNumber, status: "skipped", message: "موجود مسبقاً" });
      else if (onExisting === "error") results.push({ rowNumber: r.rowNumber, status: "failed", message: "موجود مسبقاً" });
      else toUpdate.push({ row: r, id: existingId });
    } else {
      toCreate.push(r);
    }
  }
  for (const r of toCreate) results.push({ rowNumber: r.rowNumber, status: "created" });
  for (const u of toUpdate) results.push({ rowNumber: u.row.rowNumber, status: "updated" });

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || anyFailed || (!toCreate.length && !toUpdate.length)) {
    return finalize("CUSTOMERS", rows.length, results, false, options, actor);
  }

  try {
    await withTx(async (tx) => {
      if (toCreate.length) {
        await tx.insert(customers).values(
          toCreate.map((r) => ({
            name: r.name.trim(),
            phone: norm(r.phone),
            whatsapp: norm(r.whatsapp),
            address: norm(r.address),
            city: norm(r.city),
            district: norm(r.district),
            customerType: r.customerType ?? "فرد",
            defaultPriceTier: r.defaultPriceTier ?? "RETAIL",
            creditLimit: r.creditLimit ? toDbMoney(r.creditLimit) : "0",
            notes: norm(r.notes),
            isActive: true,
          })),
        );
      }
      for (const { row, id } of toUpdate) {
        const patch: Record<string, unknown> = {};
        if (norm(row.phone) != null) patch.phone = norm(row.phone);
        if (norm(row.whatsapp) != null) patch.whatsapp = norm(row.whatsapp);
        if (norm(row.address) != null) patch.address = norm(row.address);
        if (norm(row.city) != null) patch.city = norm(row.city);
        if (norm(row.district) != null) patch.district = norm(row.district);
        if (row.customerType) patch.customerType = row.customerType;
        if (row.defaultPriceTier) patch.defaultPriceTier = row.defaultPriceTier;
        if (row.creditLimit) patch.creditLimit = toDbMoney(row.creditLimit);
        if (norm(row.notes) != null) patch.notes = norm(row.notes);
        if (Object.keys(patch).length) await tx.update(customers).set(patch).where(eq(customers.id, id));
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقّع أثناء الكتابة";
    return finalize("CUSTOMERS", rows.length, markWriteError(results, msg), false, options, actor);
  }
  return finalize("CUSTOMERS", rows.length, results, true, options, actor);
}

// ───────────────────────── الموردون ─────────────────────────

export async function importSuppliers(
  rows: SupplierImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const db = requireDb();
  const results: ImportRowResult[] = [];
  const toCreate: SupplierImportRow[] = [];
  const toUpdate: { row: SupplierImportRow; id: number }[] = [];

  const keyOf = (r: SupplierImportRow) =>
    norm(r.phone) ? `p:${norm(r.phone)}` : `n:${r.name.trim().toLowerCase()}`;
  const firstSeen = new Map<string, number>();
  const dupRows = new Set<number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (firstSeen.has(k)) dupRows.add(r.rowNumber);
    else firstSeen.set(k, r.rowNumber);
  }

  const phones = uniq(rows.map((r) => norm(r.phone)));
  const namesNoPhone = uniq(rows.filter((r) => !norm(r.phone)).map((r) => r.name.trim()));
  const byPhone = new Map<string, number>();
  const byName = new Map<string, number>();
  if (phones.length) {
    for (const e of await db.select({ id: suppliers.id, phone: suppliers.phone }).from(suppliers).where(inArray(suppliers.phone, phones)))
      if (e.phone) byPhone.set(e.phone, Number(e.id));
  }
  if (namesNoPhone.length) {
    for (const e of await db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(inArray(suppliers.name, namesNoPhone)))
      byName.set(e.name, Number(e.id));
  }

  for (const r of rows) {
    if (dupRows.has(r.rowNumber)) {
      results.push({ rowNumber: r.rowNumber, status: "failed", message: "مكرّر داخل الملف" });
      continue;
    }
    const phone = norm(r.phone);
    const existingId = phone ? byPhone.get(phone) : byName.get(r.name.trim());
    if (existingId) {
      if (onExisting === "skip") results.push({ rowNumber: r.rowNumber, status: "skipped", message: "موجود مسبقاً" });
      else if (onExisting === "error") results.push({ rowNumber: r.rowNumber, status: "failed", message: "موجود مسبقاً" });
      else toUpdate.push({ row: r, id: existingId });
    } else {
      toCreate.push(r);
    }
  }
  for (const r of toCreate) results.push({ rowNumber: r.rowNumber, status: "created" });
  for (const u of toUpdate) results.push({ rowNumber: u.row.rowNumber, status: "updated" });

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || anyFailed || (!toCreate.length && !toUpdate.length)) {
    return finalize("SUPPLIERS", rows.length, results, false, options, actor);
  }

  try {
    await withTx(async (tx) => {
      if (toCreate.length) {
        await tx.insert(suppliers).values(
          toCreate.map((r) => ({
            name: r.name.trim(),
            phone: norm(r.phone),
            email: norm(r.email),
            whatsapp: norm(r.whatsapp),
            address: norm(r.address),
            city: norm(r.city),
            taxId: norm(r.taxId),
            productTypes: norm(r.productTypes),
            paymentTerms: norm(r.paymentTerms),
            notes: norm(r.notes),
            isActive: true,
          })),
        );
      }
      for (const { row, id } of toUpdate) {
        const patch: Record<string, unknown> = {};
        if (norm(row.phone) != null) patch.phone = norm(row.phone);
        if (norm(row.email) != null) patch.email = norm(row.email);
        if (norm(row.whatsapp) != null) patch.whatsapp = norm(row.whatsapp);
        if (norm(row.address) != null) patch.address = norm(row.address);
        if (norm(row.city) != null) patch.city = norm(row.city);
        if (norm(row.taxId) != null) patch.taxId = norm(row.taxId);
        if (norm(row.productTypes) != null) patch.productTypes = norm(row.productTypes);
        if (norm(row.paymentTerms) != null) patch.paymentTerms = norm(row.paymentTerms);
        if (norm(row.notes) != null) patch.notes = norm(row.notes);
        if (Object.keys(patch).length) await tx.update(suppliers).set(patch).where(eq(suppliers.id, id));
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقّع أثناء الكتابة";
    return finalize("SUPPLIERS", rows.length, markWriteError(results, msg), false, options, actor);
  }
  return finalize("SUPPLIERS", rows.length, results, true, options, actor);
}

// ───────────────────────── المنتجات (شجرة ٤ جداول) ─────────────────────────
// نموذج مبسّط آمن: كل productName = منتج واحد، متغيّراته بالـ sku، وحداته بالاسم، أسعاره بالفئة.
// الاستيراد يُنشئ منتجات جديدة فقط؛ الـ sku الموجود ⇒ تخطّي/فشل (التحديث عبر شاشة المنتج).

type UnitAgg = {
  unitName: string;
  conversionFactor: string;
  barcode?: string;
  isBaseUnit: boolean;
  prices: Map<string, string>; // tier → price
};
type VariantAgg = {
  sku: string;
  variantName?: string;
  color?: string;
  size?: string;
  costPrice: string;
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

export async function importProducts(
  rows: ProductImportRow[],
  options: ImportOptions,
  actor: Actor,
): Promise<ImportSummary> {
  const onExisting = options.onExisting ?? "skip";
  const db = requireDb();
  const failures = new Map<number, string>(); // rowNumber → سبب الفشل

  // ١) التجميع: productName → variants(sku) → units(name) → prices(tier).
  const groups = new Map<string, ProductAgg>();
  const skuOwner = new Map<string, string>(); // sku → productName (لكشف تضارب الملكية)
  for (const r of rows) {
    const pName = r.productName.trim();
    let p = groups.get(pName);
    if (!p) {
      p = { productName: pName, categoryName: norm(r.categoryName) ?? undefined, isCustomizable: !!r.isCustomizable, rowNumbers: [], variants: new Map() };
      groups.set(pName, p);
    }
    p.rowNumbers.push(r.rowNumber);

    const owner = skuOwner.get(r.sku);
    if (owner && owner !== pName) failures.set(r.rowNumber, `الـ SKU «${r.sku}» مرتبط بمنتج آخر (${owner})`);
    else skuOwner.set(r.sku, pName);

    let v = p.variants.get(r.sku);
    if (!v) {
      v = { sku: r.sku, variantName: norm(r.variantName) ?? undefined, color: norm(r.color) ?? undefined, size: norm(r.size) ?? undefined, costPrice: r.costPrice, rowNumbers: [], units: new Map() };
      p.variants.set(r.sku, v);
    }
    v.rowNumbers.push(r.rowNumber);

    let u = v.units.get(r.unitName);
    if (!u) {
      u = { unitName: r.unitName, conversionFactor: r.conversionFactor, barcode: norm(r.barcode) ?? undefined, isBaseUnit: !!r.isBaseUnit, prices: new Map() };
      v.units.set(r.unitName, u);
    }
    if (r.priceTier) {
      if (!r.price) failures.set(r.rowNumber, "السعر مطلوب مع وجود فئة السعر");
      else u.prices.set(r.priceTier, r.price);
    }
  }

  // ٢) التحقّق على مستوى المتغيّر/الوحدة + تكرار الباركود داخل الملف.
  const batchBarcodes = new Map<string, number>(); // barcode → rowNumber
  for (const p of Array.from(groups.values())) {
    for (const v of Array.from(p.variants.values())) {
      const baseUnits = Array.from(v.units.values()).filter((u) => u.isBaseUnit);
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
          const prev = batchBarcodes.get(u.barcode);
          if (prev != null) for (const rn of v.rowNumbers) failures.set(rn, `الباركود «${u.barcode}» مكرّر داخل الملف`);
          else batchBarcodes.set(u.barcode, v.rowNumbers[0]);
        }
      }
    }
  }

  // ٣) كشف الموجود في القاعدة: SKU (متغيّر) + الباركود (وحدة، فريد عالمياً).
  const allSkus = Array.from(skuOwner.keys());
  const allBarcodes = Array.from(batchBarcodes.keys());
  const existingSkus = new Set<string>();
  const existingBarcodes = new Set<string>();
  if (allSkus.length) {
    for (const e of await db.select({ sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.sku, allSkus)))
      existingSkus.add(e.sku);
  }
  if (allBarcodes.length) {
    for (const e of await db.select({ barcode: productUnits.barcode }).from(productUnits).where(inArray(productUnits.barcode, allBarcodes)))
      if (e.barcode) existingBarcodes.add(e.barcode);
  }

  // ٤) تصنيف كل مجموعة منتج: إنشاء / تخطّي / فشل.
  const results: ImportRowResult[] = [];
  const toCreate: ProductAgg[] = [];
  for (const p of Array.from(groups.values())) {
    const groupFailed = p.rowNumbers.some((rn) => failures.has(rn));
    if (groupFailed) {
      for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: failures.get(rn) ?? "خطأ في صفّ مرتبط بنفس المنتج" });
      continue;
    }
    const skus = Array.from(p.variants.keys());
    const hasExistingSku = skus.some((sku) => existingSkus.has(sku));
    const barcodeClash = Array.from(p.variants.values()).some((v) =>
      Array.from(v.units.values()).some((u) => u.barcode && existingBarcodes.has(u.barcode)),
    );

    if (barcodeClash) {
      for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: "باركود مُستخدَم مسبقاً (يجب أن يكون فريداً)" });
      continue;
    }
    if (hasExistingSku) {
      if (onExisting === "error") for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "failed", message: "الـ SKU موجود مسبقاً" });
      else for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "skipped", message: onExisting === "update" ? "موجود — التحديث عبر شاشة المنتج" : "موجود مسبقاً" });
      continue;
    }
    toCreate.push(p);
    for (const rn of p.rowNumbers) results.push({ rowNumber: rn, status: "created" });
  }

  const anyFailed = results.some((r) => r.status === "failed");
  if (options.dryRun || anyFailed || !toCreate.length) {
    return finalize("PRODUCTS", rows.length, results, false, options, actor);
  }

  // ٥) التنفيذ: إنشاء التصنيفات الناقصة ثم شجرة كل منتج داخل معاملة واحدة.
  try {
    await withTx(async (tx) => {
      const catNames = uniq(toCreate.map((p) => p.categoryName));
      const catMap = new Map<string, number>();
      if (catNames.length) {
        for (const c of await tx.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.name, catNames)))
          catMap.set(c.name, Number(c.id));
        for (const name of catNames) {
          if (!catMap.has(name)) {
            const res = await tx.insert(categories).values({ name });
            catMap.set(name, insertId(res));
          }
        }
      }

      for (const p of toCreate) {
        const pRes = await tx.insert(products).values({
          name: p.productName,
          categoryId: p.categoryName ? catMap.get(p.categoryName) ?? null : null,
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
              isBaseUnit: u.isBaseUnit,
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
        }
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقّع أثناء الكتابة";
    return finalize("PRODUCTS", rows.length, markWriteError(results, msg), false, options, actor);
  }
  return finalize("PRODUCTS", rows.length, results, true, options, actor);
}
