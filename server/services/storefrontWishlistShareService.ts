import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { storefrontWishlistShares } from "../../drizzle/schema";
import { getDb } from "../db";
import { storefrontProduct, type StorefrontProduct } from "./storefrontService";

const WISHLIST_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHARED_PRODUCTS = 60;

function normalizeProductIds(productIds: number[]) {
  return Array.from(new Set(productIds)).slice(0, MAX_SHARED_PRODUCTS);
}

/**
 * يمر الرابط العام عبر العقد نفسه الذي يغذي بطاقة التطبيق وتفاصيله.
 * لا يكفي فحص جدول products الخام، لأن المنتج قد يكون خارج سياق فرع المتجر
 * أو غير منشور رغم وجود صفه الإداري؛ هذا كان يولّد 404 متناقضاً مع الكتالوج.
 */
async function publishedShareableProductIds(productIds: number[]) {
  const accepted: number[] = [];
  const BATCH_SIZE = 6;
  for (let offset = 0; offset < productIds.length; offset += BATCH_SIZE) {
    const batch = productIds.slice(offset, offset + BATCH_SIZE);
    const resolved = await Promise.all(batch.map(async (productId) => ({
      productId,
      product: await storefrontProduct(productId),
    })));
    accepted.push(...resolved.filter((entry) => entry.product != null).map((entry) => entry.productId));
  }
  return accepted;
}

/** يحفظ معرّفات منتجات عامة فقط؛ لا يُخزن عميل أو هاتف أو أسعار قابلة للتقادم. */
export async function createStorefrontWishlistShare(productIds: number[]) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "خدمة المشاركة غير متاحة حالياً" });

  const requestedIds = normalizeProductIds(productIds);
  if (!requestedIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر منتجاً واحداً على الأقل للمشاركة" });
  }

  const sharedProductIds = await publishedShareableProductIds(requestedIds);
  if (!sharedProductIds.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "المنتجات المحددة لم تعد متاحة للمشاركة" });
  }

  const expiresAt = new Date(Date.now() + WISHLIST_SHARE_TTL_MS);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(18).toString("base64url");
    try {
      await db.insert(storefrontWishlistShares).values({ token, productIds: sharedProductIds, expiresAt });
      return { token, expiresAt, productCount: sharedProductIds.length };
    } catch (error) {
      if (attempt === 2 || !String(error).toLowerCase().includes("duplicate")) throw error;
    }
  }

  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر إنشاء رابط المشاركة، حاول لاحقاً" });
}

/** لا يعيد إلا معرّفات المنتجات الحية ووقت الانتهاء؛ الرابط المنتهي يعامل كأنه غير موجود. */
export async function getStorefrontWishlistShare(token: string) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "خدمة المشاركة غير متاحة حالياً" });

  const row = (await db
    .select({ productIds: storefrontWishlistShares.productIds, expiresAt: storefrontWishlistShares.expiresAt })
    .from(storefrontWishlistShares)
    .where(eq(storefrontWishlistShares.token, token))
    .limit(1))[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "رابط قائمة الرغبات غير صالح أو انتهت صلاحيته" });
  }

  const productIds = Array.isArray(row.productIds)
    ? normalizeProductIds(row.productIds.filter((item): item is number => Number.isInteger(item) && item > 0))
    : [];
  if (!productIds.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "لا تحتوي القائمة المشتركة على منتجات متاحة" });
  }
  return { productIds, expiresAt: row.expiresAt };
}

/** يعيد بطاقات الكتالوج الحية فقط؛ لا نعرض أبداً لقطة قديمة من وقت إنشاء الرابط. */
export async function resolveStorefrontWishlistShare(token: string): Promise<{ expiresAt: Date; items: StorefrontProduct[] }> {
  const share = await getStorefrontWishlistShare(token);
  const items: StorefrontProduct[] = [];
  for (let offset = 0; offset < share.productIds.length; offset += 4) {
    const batch = await Promise.all(share.productIds.slice(offset, offset + 4).map((productId) => storefrontProduct(productId)));
    items.push(...batch.filter((item): item is StorefrontProduct => item != null));
  }
  return { expiresAt: share.expiresAt, items };
}
