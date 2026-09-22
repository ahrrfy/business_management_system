import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { productPrices } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money } from "./money";

export type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export type AutomaticPriceSource = "TIER" | "CONTRACT";

/**
 * مرجع السعر الآلي الواحد لكل مسارات البيع: عقد العميل النشط أولاً، ثم صف الفئة
 * المطلوب حرفياً. لا يوجد سقوط ضمني إلى RETAIL؛ غياب الاثنين يعني أن التسعير غير مكتمل.
 */
export function resolveEffectivePriceReference(input: {
  catalogUnitPrice: Decimal | string | null | undefined;
  contractUnitPrice?: Decimal | string | null;
}): { unitPrice: Decimal | null; priceSource: AutomaticPriceSource | null } {
  if (input.contractUnitPrice != null) {
    return { unitPrice: money(input.contractUnitPrice), priceSource: "CONTRACT" };
  }
  if (input.catalogUnitPrice != null) {
    return { unitPrice: money(input.catalogUnitPrice), priceSource: "TIER" };
  }
  return { unitPrice: null, priceSource: null };
}

/** Effective tier: explicit override → customer default → RETAIL. */
export const resolveTier = (o: {
  override?: PriceTier | null;
  customerTier?: PriceTier | null;
}): PriceTier => o.override ?? o.customerTier ?? "RETAIL";

/** Unit price for a (unit × tier). No implicit fallback between tiers. */
export async function getUnitPrice(tx: Tx, productUnitId: number, tier: PriceTier): Promise<Decimal> {
  const p = await tryGetUnitPrice(tx, productUnitId, tier);
  if (p == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يوجد سعر للوحدة (${productUnitId}) ضمن فئة (${tier}). عرّف السعر أولاً.`,
    });
  }
  return p;
}

/** كـgetUnitPrice لكن يُعيد null بدل الرمي عند غياب السعر — للقياس المرجعيّ (H6) دون إجبار وجود سعرٍ مُعرَّف. */
export async function tryGetUnitPrice(tx: Tx, productUnitId: number, tier: PriceTier): Promise<Decimal | null> {
  const rows = await tx
    .select({ price: productPrices.price })
    .from(productPrices)
    .where(and(eq(productPrices.productUnitId, productUnitId), eq(productPrices.priceTier, tier)))
    .limit(1);
  return rows[0] ? money(rows[0].price) : null;
}
