import { z } from "zod";

export const bundleRequirementModeSchema = z.enum(["NET_SHORTAGE", "FULL_QUANTITY"]);
export type BundleRequirementMode = z.infer<typeof bundleRequirementModeSchema>;

export const analyzeBundleRequirementsInputSchema = z.object({
  bundleVariantId: z.number().int().positive(),
  bundleQuantity: z.number().int().positive(),
  branchId: z.number().int().positive().optional(),
  mode: bundleRequirementModeSchema.default("NET_SHORTAGE"),
});
export type AnalyzeBundleRequirementsInput = z.infer<typeof analyzeBundleRequirementsInputSchema>;

export interface ComponentRequirementDto {
  variantId: number;
  productName: string;
  sku: string;
  componentBaseQuantity: number;
  totalRequiredQty: number;
  onHandStock: number;
  shortageQty: number;
  suggestedBatchQty: number;
  isManufactured: boolean;
  recipeId: number | null;
  recipeName: string | null;
  requiredBatchMultiple: number;
  surplusBufferQty: number;
  laborPerUnit: string;
  wasteStdPct: string;
}

export interface AggregatedMaterialDto {
  materialVariantId: number;
  materialName: string;
  sku: string;
  unitName: string;
  totalRequiredBase: string;
  availableInBranch: number;
  isSufficient: boolean;
  deficitBase: string;
}

export interface BundleRequirementsAnalysisResult {
  bundleVariantId: number;
  bundleName: string;
  bundleSku: string;
  requestedBundleQty: number;
  mode: BundleRequirementMode;
  components: ComponentRequirementDto[];
  aggregatedMaterials: AggregatedMaterialDto[];
  maxBundlesPossible: number;
  limitingFactorName: string | null;
  limitingFactorType: "RAW_MATERIAL" | "COMMERCIAL_COMPONENT" | null;
  estimatedTotalLaborCost: string;
  estimatedTotalMaterialsCost: string;
  estimatedTotalCost: string;
}

export const produceBundleComponentsInputSchema = z.object({
  bundleVariantId: z.number().int().positive(),
  bundleQuantity: z.number().int().positive(),
  branchId: z.number().int().positive().optional(),
  linkedWorkOrderId: z.number().int().positive().nullish(),
  clientRequestId: z.string().min(1).max(80),
  notes: z.string().max(500).nullish(),
  batches: z.array(
    z.object({
      recipeId: z.number().int().positive(),
      variantId: z.number().int().positive(),
      batchQty: z.number().int().positive(),
      scrapQty: z.number().int().min(0).default(0),
      laborPerUnit: z.string().regex(/^\d+(\.\d{1,2})?$/).nullish(),
    })
  ).min(1),
});
export type ProduceBundleComponentsInput = z.infer<typeof produceBundleComponentsInputSchema>;

export interface ProduceBundleComponentsResult {
  bundleVariantId: number;
  bundleDocGroupRef: string;
  orders: Array<{
    productionOrderId: number;
    docNumber: string;
    variantId: number;
    productName: string;
    goodQty: number;
    totalCost: string;
  }>;
  totalCostAllOrders: string;
  updatedBundleUnitCost: string;
}

export * from "./multiRecipeProductionTypes";
