import { z } from "zod";

export const multiRecipeBatchItemInputSchema = z.object({
  recipeId: z.number().int().positive(),
  batchQty: z.number().int().positive(),
  scrapQty: z.number().int().min(0).default(0),
  laborPerUnit: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .nullish(),
});
export type MultiRecipeBatchItemInput = z.infer<typeof multiRecipeBatchItemInputSchema>;

export const analyzeMultiRecipeRequirementsInputSchema = z.object({
  branchId: z.number().int().positive().optional(),
  items: z.array(multiRecipeBatchItemInputSchema).min(1),
});
export type AnalyzeMultiRecipeRequirementsInput = z.infer<
  typeof analyzeMultiRecipeRequirementsInputSchema
>;

export interface RecipeRequirementMaterialLineDto {
  variantId: number;
  productName: string;
  sku: string;
  unitName: string;
  qtyPerOutputBase: string;
  totalRequiredBase: string;
  availableInBranch: number;
  isSufficient: boolean;
}

export interface RecipeRequirementItemDto {
  recipeId: number;
  recipeName: string;
  outputVariantId: number;
  outputProductName: string;
  outputSku: string;
  outputUnitName: string;
  batchQty: number;
  scrapQty: number;
  goodQty: number;
  requiredBatchMultiple: number;
  isMultipleValid: boolean;
  laborPerUnit: string;
  wasteStdPct: string;
  estimatedLaborCost: string;
  estimatedMaterialsCost: string;
  estimatedTotalCost: string;
  materials: RecipeRequirementMaterialLineDto[];
}

export interface AggregatedMultiRecipeMaterialDto {
  materialVariantId: number;
  materialName: string;
  sku: string;
  unitName: string;
  totalRequiredBase: string;
  availableInBranch: number;
  isSufficient: boolean;
  deficitBase: string;
}

export interface MultiRecipeRequirementsAnalysisResult {
  recipes: RecipeRequirementItemDto[];
  aggregatedMaterials: AggregatedMultiRecipeMaterialDto[];
  totalLaborCost: string;
  totalMaterialsCost: string;
  totalEstimatedCost: string;
  canProduceAll: boolean;
  limitingFactors: Array<{
    materialVariantId: number;
    materialName: string;
    totalRequiredBase: string;
    availableInBranch: number;
    deficitBase: string;
  }>;
}

export const produceMultiRecipeInputSchema = z.object({
  branchId: z.number().int().positive().optional(),
  clientRequestId: z.string().min(1).max(80),
  linkedWorkOrderId: z.number().int().positive().nullish(),
  notes: z.string().max(500).nullish(),
  batches: z.array(multiRecipeBatchItemInputSchema).min(1),
});
export type ProduceMultiRecipeInput = z.infer<typeof produceMultiRecipeInputSchema>;

export interface ProduceMultiRecipeOrderResult {
  productionOrderId: number;
  docNumber: string;
  recipeId: number;
  recipeName: string;
  outputVariantId: number;
  outputProductName: string;
  batchQty: number;
  goodQty: number;
  scrapQty: number;
  totalCost: string;
}

export interface ProduceMultiRecipeResult {
  multiRecipeDocGroupRef: string;
  orders: ProduceMultiRecipeOrderResult[];
  totalCostAllOrders: string;
  orderCount: number;
}
