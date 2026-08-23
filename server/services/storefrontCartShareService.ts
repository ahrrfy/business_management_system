import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { storefrontCartShares } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontProduct } from "./storefrontService";

const CART_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHARED_CART_LINES = 100;

type StorefrontCartShareLine = {
  productId: number;
  productUnitId: number;
  quantity: number;
};

export function normalizeStorefrontCartShareLines(lines: StorefrontCartShareLine[]): StorefrontCartShareLine[] {
  const byUnit = new Map<number, StorefrontCartShareLine>();
  for (const line of lines) {
    if (!Number.isInteger(line.productId) || line.productId <= 0) continue;
    if (!Number.isInteger(line.productUnitId) || line.productUnitId <= 0) continue;
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) continue;
    const quantity = Math.min(line.quantity, 999);
    const current = byUnit.get(line.productUnitId);
    byUnit.set(line.productUnitId, {
      productId: line.productId,
      productUnitId: line.productUnitId,
      quantity: Math.min((current?.quantity ?? 0) + quantity, 999),
    });
  }
  return Array.from(byUnit.values()).slice(0, MAX_SHARED_CART_LINES);
}

/** يحفظ IDs والكميات فقط؛ لا تُخزَّن أسعار أو أسماء أو بيانات عميل أو تخصيصات. */
export async function createStorefrontCartShare(lines: StorefrontCartShareLine[]) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "خدمة المشاركة غير متاحة حالياً" });
  const normalized = normalizeStorefrontCartShareLines(lines);
  if (!normalized.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أضف منتجاً واحداً على الأقل قبل مشاركة السلة" });
  }

  const expiresAt = new Date(Date.now() + CART_SHARE_TTL_MS);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(18).toString("base64url");
    try {
      await db.insert(storefrontCartShares).values({ token, lines: normalized, expiresAt });
      return { token, expiresAt, lineCount: normalized.length };
    } catch (error) {
      if (attempt === 2 || !String(error).toLowerCase().includes("duplicate")) throw error;
    }
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء رابط السلة، حاول لاحقاً" });
}

/** يعيد السلة من المنتجات الحالية ويستبعد أي وحدة محذوفة أو غير مسعّرة، دون تسريب لقطة السعر القديمة. */
export async function resolveStorefrontCartShare(token: string) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "خدمة المشاركة غير متاحة حالياً" });
  const row = (await db
    .select({ lines: storefrontCartShares.lines, expiresAt: storefrontCartShares.expiresAt })
    .from(storefrontCartShares)
    .where(eq(storefrontCartShares.token, token))
    .limit(1))[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "رابط السلة غير صالح أو انتهت صلاحيته" });
  }

  const requested = Array.isArray(row.lines)
    ? normalizeStorefrontCartShareLines(row.lines.filter((line): line is StorefrontCartShareLine => !!line && typeof line === "object"))
    : [];
  const productIds = Array.from(new Set(requested.map((line) => line.productId)));
  const products = await Promise.all(productIds.map(async (productId) => [productId, await storefrontProduct(productId)] as const));
  const productsById = new Map(products);
  const items: Array<{
    productId: number;
    productUnitId: number;
    quantity: number;
    name: string;
    price: string;
    imageUrl: string | null;
    unitName: string;
    variantLabel?: string;
  }> = [];

  for (const line of requested) {
    const product = productsById.get(line.productId);
    if (!product) continue;
    const unitOptions = [
      ...(product.storeUnits ?? []).map((unit) => ({ unit, variantLabel: undefined as string | undefined })),
      ...(product.variants ?? []).flatMap((variant) => variant.units.map((unit) => ({ unit, variantLabel: variant.label }))),
    ];
    const match = unitOptions.find(({ unit }) => unit.productUnitId === line.productUnitId);
    const price = match?.unit.salePrice ?? match?.unit.price ?? null;
    if (!match || price == null) continue;
    items.push({
      productId: line.productId,
      productUnitId: line.productUnitId,
      quantity: line.quantity,
      name: product.productName,
      price,
      imageUrl: product.imageUrl,
      unitName: match.unit.unitName,
      ...(match.variantLabel ? { variantLabel: match.variantLabel } : {}),
    });
  }

  if (!items.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "لم تعد منتجات هذا الرابط متاحة" });
  }
  return { expiresAt: row.expiresAt, items, skippedCount: requested.length - items.length };
}
