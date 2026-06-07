import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, ne, or, type SQL } from "drizzle-orm";
import { branchStock, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { toDbMoney } from "./money";
import type { PriceTier } from "./pricing";
import { setStock } from "./inventoryService";
import { withTx, type Actor } from "./tx";

/** One sellable line for the POS: a (variant × unit) with its tier price and branch stock. */
export interface PosRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  barcode: string | null;
  isBaseUnit: boolean;
  price: string | null; // null = no price defined for this unit×tier
  stockBase: number; // variant stock in base units at the branch
}

function baseSelect(db: NonNullable<ReturnType<typeof getDb>>, branchId: number, tier: PriceTier) {
  return db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      price: productPrices.price,
      stockBase: branchStock.quantity,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productPrices,
      and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, tier))
    )
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId))
    );
}

function normalize(rows: any[]): PosRow[] {
  return rows.map((r) => ({
    ...r,
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
  }));
}

const activeOnly = and(
  eq(products.isActive, true),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true)
);

/** Resolve a scanned barcode to a single POS row. */
export async function lookupByBarcode(barcode: string, branchId: number, tier: PriceTier): Promise<PosRow | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await baseSelect(db, branchId, tier)
    .where(and(activeOnly, eq(productUnits.barcode, barcode)))
    .limit(1);
  return normalize(rows)[0] ?? null;
}

/** List sellable rows for the POS, optionally filtered by a text query. */
export async function listForPos(branchId: number, tier: PriceTier, query?: string, limit = 200): Promise<PosRow[]> {
  const db = getDb();
  if (!db) return [];
  let where: SQL | undefined = activeOnly;
  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    where = and(
      activeOnly,
      or(like(products.name, q), like(productVariants.sku, q), like(productVariants.variantName, q), like(productUnits.barcode, q))
    );
  }
  const rows = await baseSelect(db, branchId, tier).where(where).orderBy(desc(products.id)).limit(limit);
  return normalize(rows);
}

/** One purchasable line: a (variant × unit) with the variant's last cost (per base) and branch stock.
 *  Distinct from {@link PosRow}: it carries COST, never a sell price, so it must never feed the cashier UI. */
export interface PurchaseRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  costPriceBase: string; // variant cost per base unit
  stockBase: number;
}

/** List purchasable (variant × unit) rows for the purchase-order screen, optionally filtered. */
export async function listForPurchase(branchId: number, query?: string, limit = 50): Promise<PurchaseRow[]> {
  const db = getDb();
  if (!db) return [];
  let where: SQL | undefined = activeOnly;
  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    where = and(
      activeOnly,
      or(like(products.name, q), like(productVariants.sku, q), like(productVariants.variantName, q), like(productUnits.barcode, q))
    );
  }
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      isBaseUnit: productUnits.isBaseUnit,
      costPriceBase: productVariants.costPrice,
      stockBase: branchStock.quantity,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)))
    .where(where)
    .orderBy(desc(products.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
  }));
}

/* ============================ Product setup (catalog write) ============================ */

export interface CreateProductInput {
  name: string;
  categoryId?: number | null;
  isCustomizable?: boolean;
  variants: Array<{
    sku: string;
    variantName?: string | null;
    color?: string | null;
    size?: string | null;
    costPrice: string;
    openingStock?: number;
    units: Array<{
      unitName: string;
      conversionFactor: string;
      barcode?: string | null;
      isBaseUnit?: boolean;
      prices?: Array<{ priceTier: PriceTier; price: string }>;
    }>;
  }>;
}

/* ============================ Product read (for edit) ============================ */

export interface ProductForEdit {
  id: number;
  name: string;
  categoryId: number | null;
  isCustomizable: boolean;
  isActive: boolean;
  variants: Array<{
    id: number;
    sku: string;
    variantName: string | null;
    color: string | null;
    size: string | null;
    costPrice: string;
    units: Array<{
      id: number;
      unitName: string;
      conversionFactor: string;
      barcode: string | null;
      isBaseUnit: boolean;
      isActive: boolean;
      prices: Array<{ priceTier: PriceTier; price: string }>;
    }>;
  }>;
}

export async function getProductForEdit(productId: number): Promise<ProductForEdit | null> {
  const db = getDb();
  if (!db) return null;
  const p = (await db.select().from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!p) return null;
  const variants = await db.select().from(productVariants).where(eq(productVariants.productId, productId));
  const variantIds = variants.map((v) => Number(v.id));
  const units = variantIds.length
    ? await db.select().from(productUnits).where(and(eq(productUnits.isActive, true)))
    : [];
  const myUnits = units.filter((u) => variantIds.includes(Number(u.variantId)));
  const unitIds = myUnits.map((u) => Number(u.id));
  const prices = unitIds.length
    ? await db.select().from(productPrices)
    : [];
  const myPrices = prices.filter((p) => unitIds.includes(Number(p.productUnitId)));

  return {
    id: Number(p.id),
    name: p.name,
    categoryId: p.categoryId != null ? Number(p.categoryId) : null,
    isCustomizable: !!p.isCustomizable,
    isActive: !!p.isActive,
    variants: variants.map((v) => ({
      id: Number(v.id),
      sku: v.sku,
      variantName: v.variantName,
      color: v.color,
      size: v.size,
      costPrice: v.costPrice,
      units: myUnits
        .filter((u) => Number(u.variantId) === Number(v.id))
        .map((u) => ({
          id: Number(u.id),
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode,
          isBaseUnit: !!u.isBaseUnit,
          isActive: !!u.isActive,
          prices: myPrices
            .filter((pp) => Number(pp.productUnitId) === Number(u.id))
            .map((pp) => ({ priceTier: pp.priceTier as PriceTier, price: pp.price })),
        })),
    })),
  };
}

/* ============================ Product update ============================ */

export interface UpdateProductUnitInput {
  id?: number; // existing unit id (omit for new)
  unitName: string;
  conversionFactor: string;
  barcode?: string | null;
  isBaseUnit?: boolean;
  prices?: Array<{ priceTier: PriceTier; price: string }>;
}

export interface UpdateProductVariantInput {
  id: number; // variants are not added/removed via edit for now
  sku: string;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
  costPrice: string;
  units: UpdateProductUnitInput[];
}

export interface UpdateProductInput {
  productId: number;
  name: string;
  categoryId?: number | null;
  isCustomizable?: boolean;
  isActive?: boolean;
  variants: UpdateProductVariantInput[];
}

/** Update a product header + its variant(s) + units + prices in one transaction.
 *  - Existing units (by id) are UPDATEd and their prices replaced.
 *  - New units (no id) are INSERTed with their prices.
 *  - Units present in DB but absent from input are soft-deactivated (isActive=false). */
export async function updateProduct(input: UpdateProductInput, _actor: Actor) {
  return withTx(async (tx) => {
    if (!input.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المنتج مطلوب" });
    if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });

    const p = (await tx.select().from(products).where(eq(products.id, input.productId)).limit(1))[0];
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });

    await tx
      .update(products)
      .set({
        name: input.name.trim(),
        categoryId: input.categoryId ?? null,
        isCustomizable: input.isCustomizable ?? !!p.isCustomizable,
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
      })
      .where(eq(products.id, input.productId));

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit))
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة` });
      if (v.units.filter((u) => u.isBaseUnit).length > 1)
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة فقط` });

      // Variant header.
      await tx
        .update(productVariants)
        .set({
          sku: v.sku,
          variantName: v.variantName ?? null,
          color: v.color ?? null,
          size: v.size ?? null,
          costPrice: toDbMoney(v.costPrice),
        })
        .where(eq(productVariants.id, v.id));

      // Existing units for this variant.
      const existing = await tx.select().from(productUnits).where(eq(productUnits.variantId, v.id));
      const keepIds = new Set<number>();

      for (const u of v.units) {
        let productUnitId: number;
        if (u.id) {
          productUnitId = u.id;
          await tx
            .update(productUnits)
            .set({
              unitName: u.unitName,
              conversionFactor: u.conversionFactor,
              barcode: u.barcode ?? null,
              isBaseUnit: !!u.isBaseUnit,
              isActive: true,
            })
            .where(eq(productUnits.id, u.id));
          // Replace prices for this unit.
          await tx.delete(productPrices).where(eq(productPrices.productUnitId, u.id));
        } else {
          const uRes = await tx.insert(productUnits).values({
            variantId: v.id,
            unitName: u.unitName,
            conversionFactor: u.conversionFactor,
            barcode: u.barcode ?? null,
            isBaseUnit: !!u.isBaseUnit,
          });
          productUnitId = Number((uRes as any)[0]?.insertId ?? (uRes as any).insertId);
        }
        keepIds.add(productUnitId);
        for (const pr of u.prices ?? []) {
          await tx
            .insert(productPrices)
            .values({ productUnitId, priceTier: pr.priceTier, price: toDbMoney(pr.price) });
        }
      }

      // Soft-deactivate units that are no longer present (preserve history).
      for (const existing0 of existing) {
        if (!keepIds.has(Number(existing0.id))) {
          await tx.update(productUnits).set({ isActive: false }).where(eq(productUnits.id, Number(existing0.id)));
        }
      }
    }

    return { productId: input.productId };
  });
}

/** Create a product with its variants, units and prices in one transaction. */
export async function createProduct(input: CreateProductInput, actor: Actor) {
  if (!input.variants.length) throw new TRPCError({ code: "BAD_REQUEST", message: "المنتج يحتاج متغيّراً واحداً على الأقل" });
  return withTx(async (tx) => {
    const pRes = await tx.insert(products).values({
      name: input.name,
      categoryId: input.categoryId ?? null,
      isCustomizable: input.isCustomizable ?? false,
    });
    const productId = Number((pRes as any)[0]?.insertId ?? (pRes as any).insertId);

    for (const v of input.variants) {
      if (!v.units.some((u) => u.isBaseUnit)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${v.sku} يحتاج وحدة أساس واحدة (isBaseUnit)` });
      }
      const vRes = await tx.insert(productVariants).values({
        productId,
        sku: v.sku,
        variantName: v.variantName ?? null,
        color: v.color ?? null,
        size: v.size ?? null,
        costPrice: toDbMoney(v.costPrice),
      });
      const variantId = Number((vRes as any)[0]?.insertId ?? (vRes as any).insertId);

      for (const u of v.units) {
        const uRes = await tx.insert(productUnits).values({
          variantId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          barcode: u.barcode ?? null,
          isBaseUnit: u.isBaseUnit ?? false,
        });
        const productUnitId = Number((uRes as any)[0]?.insertId ?? (uRes as any).insertId);
        for (const p of u.prices ?? []) {
          await tx.insert(productPrices).values({ productUnitId, priceTier: p.priceTier, price: toDbMoney(p.price) });
        }
      }

      // المخزون الافتتاحي (في فرع الموظف) كحركة ADJUST مُسجَّلة.
      if (v.openingStock && v.openingStock > 0) {
        await setStock(tx, {
          variantId,
          branchId: actor.branchId,
          targetQuantity: v.openingStock,
          referenceType: "OPENING",
          notes: "رصيد افتتاحي",
          createdBy: actor.userId,
        });
      }
    }
    return { productId };
  });
}

/* ============================ Barcode assignment ============================ */

/** يسند باركوداً لوحدة بلا باركود (أو يحدّثه)، مع ضمان التفرّد عبر كل الوحدات. */
export async function assignBarcode(productUnitId: number, barcode: string) {
  return withTx(async (tx) => {
    const code = barcode.trim();
    if (!code) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود فارغ" });
    const unit = (await tx.select().from(productUnits).where(eq(productUnits.id, productUnitId)).limit(1))[0];
    if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "الوحدة غير موجودة" });
    // تفرّد الباركود.
    const clash = (
      await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(and(eq(productUnits.barcode, code), ne(productUnits.id, productUnitId)))
        .limit(1)
    )[0];
    if (clash) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${code} مُستخدَم لوحدة أخرى` });
    await tx.update(productUnits).set({ barcode: code }).where(eq(productUnits.id, productUnitId));
    return { productUnitId, barcode: code };
  });
}
