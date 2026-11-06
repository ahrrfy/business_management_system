import { z } from "zod";
import { nonNegMoneyString } from "./moneySchemas";

export const NO_PRODUCT_RECIPE_FINGERPRINT = "NONE";
export const productRecipeFingerprintSchema = z.string().regex(/^(NONE|[a-f0-9]{64})$/);

/** Same definition for independent recipe saves and the atomic product editor. */
export const productRecipeDefinitionSchema = z.object({
  name: z.string().min(1).max(150),
  outputVariantId: z.number().int().positive(),
  outputProductUnitId: z.number().int().positive(),
  laborPerOutputBase: nonNegMoneyString.nullish(),
  wasteStdPct: z.string().nullish(),
  notes: z.string().nullish(),
  isActive: z.boolean().optional(),
  lines: z.array(z.object({
    inputVariantId: z.number().int().positive(),
    inputProductUnitId: z.number().int().positive().nullish(),
    qtyPerOutputBase: z.string(),
    notes: z.string().nullish(),
  })).min(1),
});

export const productRecipeChangeSchema = productRecipeDefinitionSchema.extend({
  recipeId: z.number().int().positive().nullable(),
  expectedFingerprint: productRecipeFingerprintSchema,
});
export type ProductRecipeChange = z.infer<typeof productRecipeChangeSchema>;
