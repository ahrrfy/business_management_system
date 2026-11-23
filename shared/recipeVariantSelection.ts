import { z } from "zod";

export const recipeLineSelectionSchema = z.object({
  recipeLineId: z.number().int().positive(),
  variantId: z.number().int().positive(),
});

export type RecipeLineSelection = z.infer<typeof recipeLineSelectionSchema>;

export const recipeSelectionsSchema = z.array(recipeLineSelectionSchema).max(100);

export interface RecipeLineSelectionWithMeta extends RecipeLineSelection {
  materialName?: string;
  label?: string;
  color?: string | null;
  colorHex?: string | null;
}

export function stripRecipeSelectionMeta(
  selections?: readonly RecipeLineSelection[] | null,
): RecipeLineSelection[] | undefined {
  if (!selections || selections.length === 0) return undefined;
  return [...selections]
    .map((s) => ({
      recipeLineId: Number(s.recipeLineId),
      variantId: Number(s.variantId),
    }))
    .sort((a, b) => a.recipeLineId - b.recipeLineId);
}

export function serializeRecipeSelectionsKey(
  selections?: readonly RecipeLineSelection[] | null,
): string {
  const normalized = stripRecipeSelectionMeta(selections);
  if (!normalized?.length) return "";
  return normalized.map((s) => `${s.recipeLineId}:${s.variantId}`).join(",");
}

export function formatRecipeSelectionSummary(
  selections?: readonly RecipeLineSelectionWithMeta[] | null,
): string {
  if (!selections || selections.length === 0) return "";
  return selections
    .map((s) => {
      const value = (s.label || s.color || `#${s.variantId}`).trim();
      return s.materialName ? `${s.materialName}: ${value}` : value;
    })
    .filter(Boolean)
    .join(" · ");
}
