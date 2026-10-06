import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InferredBranchField } from "@/components/form/InferredField";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import type {
  AggregatedMultiRecipeMaterialDto,
  ProduceMultiRecipeResult,
} from "@shared/multiRecipeProductionTypes";
import type {
  MaterialSubstitutionItem,
  SubstituteRecipeMaterialResult,
} from "@shared/recipeSubstitutionTypes";
import { AlertCircle, Layers, Loader2, Sparkles } from "lucide-react";
import { MultiRecipeItemsStep, type MultiRecipeBatchDraft } from "./MultiRecipeItemsStep";
import { MultiRecipeMaterialsSummary } from "./MultiRecipeMaterialsSummary";
import { MultiRecipeSuccessStep } from "./MultiRecipeSuccessStep";

interface MultiRecipeProductionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipeIds: number[];
  onRemoveRecipeId?: (recipeId: number) => void;
  onClearSelection?: () => void;
  branchId?: number;
}

export function MultiRecipeProductionDialog({
  open,
  onOpenChange,
  recipeIds,
  onRemoveRecipeId,
  onClearSelection,
  branchId,
}: MultiRecipeProductionDialogProps) {
  const utils = trpc.useUtils();

  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(branchId ?? null);
  const [batches, setBatches] = useState<MultiRecipeBatchDraft[]>([]);
  const [successResult, setSuccessResult] = useState<ProduceMultiRecipeResult | null>(null);
  const [clientRequestId, setClientRequestId] = useState<string>("");
  const [materialSubstitutions, setMaterialSubstitutions] = useState<MaterialSubstitutionItem[]>([]);

  useEffect(() => {
    if (branchId != null) {
      setSelectedBranchId(branchId);
    }
  }, [branchId]);

  // استقرار مفتاح معرّفات الوصفات لتجنب مسح مدخلات المستخدم عند إعادة تصيير الأب
  const recipeIdsKey = useMemo(() => recipeIds.slice().sort((a, b) => a - b).join(","), [recipeIds]);

  useEffect(() => {
    if (!open) {
      setSuccessResult(null);
      setClientRequestId("");
      setMaterialSubstitutions([]);
      return;
    }
    // توليد مفتاح طلب حتمي واحد لكل جلسة حوار وتدويره فقط عند النجاح
    setClientRequestId((prev) => prev || `MULTI-REC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    setBatches((prev) => {
      const prevMap = new Map(prev.map((b) => [b.recipeId, b]));
      return recipeIds.map((id) => prevMap.get(id) ?? {
        recipeId: id,
        batchQty: 1,
        scrapQty: 0,
      });
    });
    setSuccessResult(null);
  }, [open, recipeIdsKey]);

  // إعداد بنود التحليل الصالحة فقط
  const validItems = useMemo(() => {
    return batches
      .filter((b) => b.batchQty > 0 && (b.scrapQty ?? 0) < b.batchQty)
      .map((b) => ({
        recipeId: b.recipeId,
        batchQty: b.batchQty,
        scrapQty: b.scrapQty,
        laborPerUnit: b.laborPerUnit,
      }));
  }, [batches]);

  const canQueryAnalysis = open && validItems.length === batches.length && batches.length > 0 && !successResult && selectedBranchId != null;

  const analysisQ = trpc.production.recipes.analyzeMultiRecipe.useQuery(
    {
      branchId: selectedBranchId ?? undefined,
      items: validItems,
      materialSubstitutions: materialSubstitutions.length > 0 ? materialSubstitutions : undefined,
    },
    {
      enabled: canQueryAnalysis,
      staleTime: 3_000,
    }
  );

  const produceMut = trpc.production.recipes.produceMultiRecipe.useMutation({
    onSuccess: async (res) => {
      setSuccessResult(res);
      notify.ok(`تم إنتاج ${res.orders.length} وصفات بنجاح`);
      await Promise.all([
        utils.production.list.invalidate(),
        utils.production.recipes.list.invalidate(),
        utils.production.recipeCapacity.invalidate(),
      ]);
      onClearSelection?.();
    },
    onError: (err) => {
      notify.err(err);
    },
  });

  const handleUpdateBatch = (
    recipeId: number,
    update: Partial<MultiRecipeBatchDraft>
  ) => {
    setBatches((prev) =>
      prev.map((b) => (b.recipeId === recipeId ? { ...b, ...update } : b))
    );
  };

  const handleRemoveBatch = (recipeId: number) => {
    setBatches((prev) => {
      const next = prev.filter((b) => b.recipeId !== recipeId);
      if (next.length === 0) {
        onOpenChange(false);
      }
      return next;
    });
    onRemoveRecipeId?.(recipeId);
  };

  const handleExecuteProduction = () => {
    if (produceMut.isPending || batches.length === 0 || selectedBranchId == null) return;

    produceMut.mutate({
      branchId: selectedBranchId,
      clientRequestId: clientRequestId || `MULTI-REC-${Date.now().toString(36)}`,
      materialSubstitutions: materialSubstitutions.length > 0 ? materialSubstitutions : undefined,
      batches: batches.map((b) => ({
        recipeId: b.recipeId,
        batchQty: b.batchQty,
        scrapQty: b.scrapQty,
        laborPerUnit: b.laborPerUnit,
      })),
    });
  };

  const handleApplySubstitution = (sub: MaterialSubstitutionItem) => {
    setMaterialSubstitutions((prev) => [
      ...prev.filter(
        (s) =>
          !(
            s.originalVariantId === sub.originalVariantId &&
            ((s.recipeId == null && sub.recipeId == null) || s.recipeId === sub.recipeId)
          )
      ),
      sub,
    ]);
  };

  const handleRemoveSubstitution = (material: AggregatedMultiRecipeMaterialDto) => {
    const oId = material.isSubstituted
      ? (material.originalVariantId ?? material.materialVariantId)
      : material.materialVariantId;
    setMaterialSubstitutions((prev) =>
      prev.filter(
        (s) =>
          s.originalVariantId !== oId &&
          s.substituteVariantId !== material.materialVariantId
      )
    );
  };

  const handlePermanentSuccess = (res: SubstituteRecipeMaterialResult) => {
    setMaterialSubstitutions((prev) =>
      prev.filter((s) => s.originalVariantId !== res.originalVariantId)
    );
    utils.production.recipes.analyzeMultiRecipe.invalidate();
  };

  const hasInvalidQty = batches.some((b) => b.batchQty <= 0 || (b.scrapQty ?? 0) >= b.batchQty);

  const isProduceDisabled =
    produceMut.isPending ||
    batches.length === 0 ||
    selectedBranchId == null ||
    hasInvalidQty ||
    analysisQ.isLoading ||
    analysisQ.isError ||
    !analysisQ.data?.canProduceAll;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full sm:max-w-2xl md:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              <Layers aria-hidden className="size-5 text-primary" />
              إنتاج الوصفات المحددة دفعة واحدة
            </DialogTitle>
            <Badge variant="outline" className="gap-1 text-xs">
              <Sparkles aria-hidden className="size-3 text-primary" />
              {batches.length} وصفات
            </Badge>
          </div>
          <DialogDescription className="text-xs">
            حدد الكميات المطلوبة لكل وصفة وراجع كفاية المواد الخام المشتركة في الفرع ثم نفّذ الإنتاج المباشر.
          </DialogDescription>
        </DialogHeader>

        {successResult ? (
          <MultiRecipeSuccessStep
            result={successResult}
            onClose={() => {
              onOpenChange(false);
              onClearSelection?.();
            }}
          />
        ) : (
          <div className="space-y-4 py-1">
            <div className="max-w-xs">
              <InferredBranchField
                label="فرع الإنتاج"
                value={selectedBranchId}
                onChange={setSelectedBranchId}
                disabled={produceMut.isPending}
              />
            </div>

            <MultiRecipeItemsStep
              batches={batches}
              onUpdateBatch={handleUpdateBatch}
              onRemoveBatch={handleRemoveBatch}
              analysis={analysisQ.data}
            />

            {analysisQ.error && (
              <div className="rounded-lg border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)]/20 p-3 text-xs text-[var(--sem-neg)] flex items-start gap-2">
                <AlertCircle aria-hidden className="size-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{analysisQ.error.message}</span>
              </div>
            )}

            <MultiRecipeMaterialsSummary
              analysis={analysisQ.data}
              isLoading={analysisQ.isLoading}
              branchId={selectedBranchId}
              materialSubstitutions={materialSubstitutions}
              onApplySubstitution={handleApplySubstitution}
              onRemoveSubstitution={handleRemoveSubstitution}
              onPermanentSuccess={handlePermanentSuccess}
            />

            <DialogFooter className="gap-2 sm:justify-start pt-2 border-t">
              <Button
                type="button"
                className="gap-2"
                disabled={isProduceDisabled}
                onClick={handleExecuteProduction}
              >
                {produceMut.isPending ? (
                  <>
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    <span>{ACTION_LABELS.saving}</span>
                  </>
                ) : (
                  <>
                    <Layers aria-hidden className="size-4" />
                    <span>إنتاج فوري ({batches.length} أوامر)</span>
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={produceMut.isPending}
                onClick={() => onOpenChange(false)}
              >
                إلغاء
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
