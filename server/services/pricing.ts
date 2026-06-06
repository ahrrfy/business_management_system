import { TRPCError } from "@trpc/server";
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { productPrices } from "../../drizzle/schema";
import type { Tx } from "../db";
import { money } from "./money";

export type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

/** Effective tier: explicit override → customer default → RETAIL. */
export const resolveTier = (o: {
  override?: PriceTier | null;
  customerTier?: PriceTier | null;
}): PriceTier => o.override ?? o.customerTier ?? "RETAIL";

/** Unit price for a (unit × tier). No implicit fallback between tiers. */
export async function getUnitPrice(tx: Tx, productUnitId: number, tier: PriceTier): Promise<Decimal> {
  const rows = await tx
    .select({ price: productPrices.price })
    .from(productPrices)
    .where(and(eq(productPrices.productUnitId, productUnitId), eq(productPrices.priceTier, tier)))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `لا يوجد سعر للوحدة (${productUnitId}) ضمن فئة (${tier}). عرّف السعر أولاً.`,
    });
  }
  return money(rows[0].price);
}
