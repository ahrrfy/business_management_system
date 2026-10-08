import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Boxes, Loader2, PackageCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type {
  AggregatedMaterialDto,
  BundleRequirementMode,
  ComponentRequirementDto,
  ProduceBundleComponentsResult,
} from "@shared/bundleProductionTypes";
import type {
  MaterialSubstitutionItem,
  SubstituteRecipeMaterialResult,
} from "@shared/recipeSubstitutionTypes";
import {
  BundleKitComponentsStep,
  type BundleKitComponentBatch,
} from "./BundleKitComponentsStep";
import { BundleKitMaterialsStep } from "./BundleKitMaterialsStep";
import { BundleKitParametersBar } from "./BundleKitParametersBar";
import { BundleKitReviewStep } from "./BundleKitReviewStep";
import { BundleKitSuccessStep } from "./BundleKitSuccessStep";
import { QuickRecipeCopyDialog } from "./QuickRecipeCopyDialog";

const STEP_ITEMS = [
  { id: 1, label: "1. المكونات والعجز" },
  { id: 2, label: "2. المواد وعنق الزجاجة" },
  { id: 3, label: "3. المراجعة والتأكيد" },
] as const;

interface BundleKitProductionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialBundleVariantId?: number;
  branchId?: number | null;
  onSuccess?: (res: ProduceBundleComponentsResult) => void;
}

export function BundleKitProductionDialog({
  open,
  onOpenChange,
  initialBundleVariantId,
  branchId,
  onSuccess,
}: BundleKitProductionDialogProps) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const effectiveBranchId = branchId ?? me.data?.branchId ?? null;

  const [selectedBundleId, setSelectedBundleId] = useState<number | null>(initialBundleVariantId ?? null);
  const [bundleQuantity, setBundleQuantity] = useState<number>(10);
  const [mode, setMode] = useState<BundleRequirementMode>("NET_SHORTAGE");
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [batches, setBatches] = useState<BundleKitComponentBatch[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [linkedWorkOrderId, setLinkedWorkOrderId] = useState<number | null>(null);
  const [successResult, setSuccessResult] = useState<ProduceBundleComponentsResult | null>(null);
  const [clientRequestId, setClientRequestId] = useState<string>("");
  const [materialSubstitutions, setMaterialSubstitutions] = useState<MaterialSubstitutionItem[]>([]);
  const [quickRecipeTarget, setQuickRecipeTarget] = useState<ComponentRequirementDto | null>(null);
  const newlyCreatedRecipeVariantIdRef = useRef<number | null>(null);

  const lastSyncedParamsRef = useRef<{
    bundleVariantId: number | null;
    bundleQuantity: number;
    mode: BundleRequirementMode;
  } | null>(null);

  const isParamsClean =
    lastSyncedParamsRef.current != null &&
    lastSyncedParamsRef.current.bundleVariantId === selectedBundleId &&
    lastSyncedParamsRef.current.bundleQuantity === bundleQuantity &&
    lastSyncedParamsRef.current.mode === mode;

  const customBatchesPayload = useMemo(() => {
    if (!isParamsClean || batches.length === 0) return undefined;
    return batches.map((b) => {
      const trimmedLabor = b.laborPerUnit?.trim();
      const validLabor =
        trimmedLabor && /^\d+(\.\d{1,2})?$/.test(trimmedLabor) ? trimmedLabor : undefined;
      return {
        variantId: b.variantId,
        recipeId: b.recipeId ?? undefined,
        batchQty: b.selected ? b.batchQty : 0,
        scrapQty: b.scrapQty ?? 0,
        laborPerUnit: validLabor,
        selected: b.selected,
      };
    });
  }, [isParamsClean, batches]);

  const debouncedCustomBatches = useDebouncedValue(customBatchesPayload, 200);

  const bundlesListQ = trpc.production.bundles.list.useQuery(undefined, {
    enabled: open && !initialBundleVariantId,
  });

  useEffect(() => {
    if (!open) {
      setStep(1);
      setSuccessResult(null);
      setClientRequestId("");
      setMaterialSubstitutions([]);
      lastSyncedParamsRef.current = null;
      setQuickRecipeTarget(null);
      newlyCreatedRecipeVariantIdRef.current = null;
      return;
    }
    setClientRequestId((prev) => prev || `bnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    if (initialBundleVariantId) {
      setSelectedBundleId(initialBundleVariantId);
    } else if (bundlesListQ.data?.length && !selectedBundleId) {
      setSelectedBundleId(bundlesListQ.data[0].bundleVariantId);
    }
  }, [open, initialBundleVariantId, bundlesListQ.data]);

  const analysisQ = trpc.production.bundles.analyzeRequirements.useQuery(
    {
      bundleVariantId: selectedBundleId ?? 0,
      bundleQuantity,
      branchId: effectiveBranchId ?? undefined,
      mode,
      materialSubstitutions: materialSubstitutions.length > 0 ? materialSubstitutions : undefined,
      batches: debouncedCustomBatches,
    },
    { enabled: open && selectedBundleId != null && bundleQuantity > 0, staleTime: 3_000 }
  );

  useEffect(() => {
    if (!analysisQ.data?.components) return;

    const newlyCreatedId = newlyCreatedRecipeVariantIdRef.current;
    const hasNewlyCreatedMfg =
      newlyCreatedId != null &&
      analysisQ.data.components.some(
        (c) => c.variantId === newlyCreatedId && c.isManufactured,
      );

    const paramsChanged =
      !lastSyncedParamsRef.current ||
      lastSyncedParamsRef.current.bundleVariantId !== selectedBundleId ||
      lastSyncedParamsRef.current.bundleQuantity !== bundleQuantity ||
      lastSyncedParamsRef.current.mode !== mode;

    if (paramsChanged) {
      lastSyncedParamsRef.current = {
        bundleVariantId: selectedBundleId,
        bundleQuantity,
        mode,
      };
      setBatches(
        analysisQ.data.components
          .filter((c) => c.isManufactured)
          .map((c) => ({
            variantId: c.variantId,
            recipeId: c.recipeId,
            batchQty: c.suggestedBatchQty,
            scrapQty: 0,
            laborPerUnit: c.laborPerUnit || "0.00",
            selected: c.suggestedBatchQty > 0,
          }))
      );
    } else {
      setBatches((prev) => {
        const prevMap = new Map(prev.map((b) => [b.variantId, b]));
        const mfgComps = analysisQ.data.components.filter((c) => c.isManufactured);
        if (prev.length === mfgComps.length && !hasNewlyCreatedMfg) {
          const isIdentical = mfgComps.every((c) => {
            const ex = prevMap.get(c.variantId);
            return ex && ex.recipeId === c.recipeId;
          });
          if (isIdentical) return prev;
        }
        return mfgComps.map((c) => {
          const ex = prevMap.get(c.variantId);
          const isNewlyCreated = c.variantId === newlyCreatedId;
          const shouldSelect = c.suggestedBatchQty > 0;
          const defaultBatchQty = c.suggestedBatchQty;

          return ex
            ? {
                ...ex,
                recipeId: c.recipeId,
                batchQty:
                  ex.batchQty > 0
                    ? ex.batchQty
                    : defaultBatchQty,
                selected: isNewlyCreated ? shouldSelect : ex.selected,
              }
            : {
                variantId: c.variantId,
                recipeId: c.recipeId,
                batchQty: defaultBatchQty,
                scrapQty: 0,
                laborPerUnit: c.laborPerUnit || "0.00",
                selected: shouldSelect,
              };
        });
      });
    }

    if (hasNewlyCreatedMfg) {
      newlyCreatedRecipeVariantIdRef.current = null;
    }
  }, [analysisQ.data, selectedBundleId, bundleQuantity, mode]);

  const produceMut = trpc.production.bundles.produceComponents.useMutation({
    onSuccess: async (res) => {
      setSuccessResult(res);
      setStep(4);
      notify.ok(`تم إنتاج مكونات البكج بنجاح (${res.orders.length} أمر إنتاج)`);
      await Promise.all([
        utils.production.list.invalidate(),
        utils.production.bundles.analyzeRequirements.invalidate(),
        utils.catalog.invalidate(),
      ]);
      onSuccess?.(res);
    },
    onError: (err) => notify.err(err.message),
  });

  function handleBatchChange(variantId: number, update: Partial<BundleKitComponentBatch>) {
    setBatches((prev) => prev.map((b) => (b.variantId === variantId ? { ...b, ...update } : b)));
  }

  function handleToggleAll(selected: boolean) {
    setBatches((prev) => {
      const compMap = new Map(analysisQ.data?.components.map((c) => [c.variantId, c]) ?? []);
      return prev.map((b) => {
        const comp = compMap.get(b.variantId);
        const fallback =
          comp?.suggestedBatchQty && comp.suggestedBatchQty > 0
            ? comp.suggestedBatchQty
            : comp?.totalRequiredQty && comp.totalRequiredQty > 0
              ? comp.totalRequiredQty
              : (comp?.requiredBatchMultiple || 1);
        return {
          ...b,
          selected,
          batchQty: selected && b.batchQty <= 0 ? fallback : b.batchQty,
        };
      });
    });
  }

  function handleResetToSuggested() {
    if (!analysisQ.data?.components) return;
    setBatches(
      analysisQ.data.components
        .filter((c) => c.isManufactured)
        .map((c) => ({
          variantId: c.variantId,
          recipeId: c.recipeId,
          batchQty: c.suggestedBatchQty,
          scrapQty: 0,
          laborPerUnit: c.laborPerUnit || "0.00",
          selected: c.suggestedBatchQty > 0,
        }))
    );
  }

  function validateActiveBatches(): boolean {
    if (!analysisQ.data) return false;
    const active = batches.filter((b) => b.selected);
    if (active.length === 0) {
      notify.err("يجب تحديد مكوّن مصنّع واحد على الأقل للمتابعة");
      return false;
    }
    for (const b of active) {
      const comp = analysisQ.data.components.find((c) => c.variantId === b.variantId);
      const name = comp?.productName ?? `#${b.variantId}`;
      if (b.batchQty <= 0) {
        notify.err(`يجب إدخال كمية دفعة موجبة للصنف «${name}»`);
        return false;
      }
      if (comp && comp.requiredBatchMultiple > 1 && b.batchQty % comp.requiredBatchMultiple !== 0) {
        notify.err(`كمية الصنف «${name}» (${b.batchQty}) يجب أن تكون من مضاعفات العدد ${comp.requiredBatchMultiple}`);
        return false;
      }
      if (b.scrapQty >= b.batchQty) {
        notify.err(`كمية التالف للصنف «${name}» يجب أن تكون أقل قطعيّاً من حجم الدفعة`);
        return false;
      }
      if (b.laborPerUnit && b.laborPerUnit.trim() !== "" && !/^\d+(\.\d{1,2})?$/.test(b.laborPerUnit.trim())) {
        notify.err(`أجور العمالة للصنف «${name}» يجب أن تكون رقماً صالحاً بمنزلتين عشريتين كحد أقصى`);
        return false;
      }
    }
    return true;
  }

  function handleGoToStep(targetStep: 1 | 2 | 3) {
    if (targetStep > step && !validateActiveBatches()) return;
    setStep(targetStep);
  }

  function handleConfirmProduce() {
    if (produceMut.isPending || !selectedBundleId || !validateActiveBatches()) return;
    const activeBatches = batches.filter((b) => b.selected && b.batchQty > 0);
    produceMut.mutate({
      bundleVariantId: selectedBundleId,
      bundleQuantity,
      branchId: effectiveBranchId ?? undefined,
      clientRequestId: clientRequestId || `bnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      notes: notes.trim() || null,
      linkedWorkOrderId,
      materialSubstitutions: materialSubstitutions.length > 0 ? materialSubstitutions : undefined,
      batches: activeBatches.map((b) => ({
        recipeId: b.recipeId!,
        variantId: b.variantId,
        batchQty: b.batchQty,
        scrapQty: b.scrapQty,
        laborPerUnit: b.laborPerUnit?.trim() || undefined,
      })),
    });
  }

  function handleReset() {
    setStep(1);
    setSuccessResult(null);
    setNotes("");
    setLinkedWorkOrderId(null);
    setMaterialSubstitutions([]);
    setClientRequestId(`bnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    lastSyncedParamsRef.current = null;
  }

  const handleApplySubstitution = (sub: MaterialSubstitutionItem) => {
    setMaterialSubstitutions((p) => [...p.filter((s) => s.originalVariantId !== sub.originalVariantId), sub]);
  };
  const handleRemoveSubstitution = (mat: AggregatedMaterialDto) => {
    const oId = mat.isSubstituted ? (mat.originalVariantId ?? mat.materialVariantId) : mat.materialVariantId;
    setMaterialSubstitutions((p) => p.filter((s) => s.originalVariantId !== oId && s.substituteVariantId !== mat.materialVariantId));
  };
  const handlePermanentSuccess = (res: SubstituteRecipeMaterialResult) => {
    setMaterialSubstitutions((p) => p.filter((s) => s.originalVariantId !== res.originalVariantId));
    utils.production.bundles.analyzeRequirements.invalidate();
  };

  const analysis = analysisQ.data;
  const isReady = !analysisQ.isLoading && analysis != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-w-full max-h-[90vh] flex flex-col p-0 overflow-hidden" dir="rtl">
        <DialogHeader className="p-4 border-b bg-muted/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Boxes className="size-5 text-primary" aria-hidden="true" />
              <DialogTitle className="text-base font-bold">مولّد إنتاج مكونات البكج</DialogTitle>
            </div>
            {analysis && step < 4 && <Badge variant="outline" className="text-xs">{analysis.bundleName}</Badge>}
          </div>
          <DialogDescription className="text-xs text-muted-foreground mt-1">
            تحليل ذكي لمكونات البكج، فحص أرصدة الفرع، جبر مضاعف القسمة، وتوليد أوامر الإنتاج ذرّياً.
          </DialogDescription>

          {step < 4 && (
            <div className="flex items-center gap-2 pt-2 text-xs">
              {STEP_ITEMS.map((s, idx) => (
                <div key={s.id} className="flex items-center gap-2">
                  {idx > 0 && <ArrowLeft className="size-3 text-muted-foreground" aria-hidden="true" />}
                  <button
                    type="button"
                    onClick={() => handleGoToStep(s.id)}
                    disabled={s.id > 1 && !isReady}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors ${
                      step === s.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {s.label}
                  </button>
                </div>
              ))}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {step < 4 && (
            <BundleKitParametersBar
              bundlesList={bundlesListQ.data ?? []}
              selectedBundleId={selectedBundleId}
              onSelectBundleId={(id) => { setSelectedBundleId(id); setStep(1); }}
              initialBundleVariantId={initialBundleVariantId}
              bundleName={analysis?.bundleName}
              bundleQuantity={bundleQuantity}
              onBundleQuantityChange={setBundleQuantity}
              mode={mode}
              onModeChange={setMode}
            />
          )}

          {analysisQ.isLoading && (
            <div className="flex flex-col items-center justify-center p-12 space-y-2 text-muted-foreground">
              <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
              <p className="text-xs font-medium">جارٍ تحليل تركيبة البكج وأرصدة المواد…</p>
            </div>
          )}

          {isReady && step === 1 && (
            <BundleKitComponentsStep
              components={analysis.components}
              batches={batches}
              onBatchChange={handleBatchChange}
              onToggleAll={handleToggleAll}
              onResetToSuggested={handleResetToSuggested}
              onAddRecipe={(comp) => setQuickRecipeTarget(comp)}
            />
          )}

          {isReady && step === 2 && (
            <BundleKitMaterialsStep
              materials={analysis.aggregatedMaterials}
              maxBundlesPossible={analysis.maxBundlesPossible}
              limitingFactorName={analysis.limitingFactorName}
              limitingFactorType={analysis.limitingFactorType}
              requestedBundleQty={bundleQuantity}
              branchId={effectiveBranchId}
              materialSubstitutions={materialSubstitutions}
              onApplySubstitution={handleApplySubstitution}
              onRemoveSubstitution={handleRemoveSubstitution}
              onPermanentSuccess={handlePermanentSuccess}
            />
          )}

          {isReady && step === 3 && (
            <BundleKitReviewStep
              bundleName={analysis.bundleName}
              bundleSku={analysis.bundleSku}
              requestedBundleQty={bundleQuantity}
              components={analysis.components}
              batches={batches}
              notes={notes}
              onNotesChange={setNotes}
              linkedWorkOrderId={linkedWorkOrderId}
              onLinkedWorkOrderChange={setLinkedWorkOrderId}
              estimatedLaborCost={analysis.estimatedTotalLaborCost}
              estimatedMaterialsCost={analysis.estimatedTotalMaterialsCost}
              estimatedTotalCost={analysis.estimatedTotalCost}
              isSubmitting={produceMut.isPending}
              onSubmit={handleConfirmProduce}
              maxBundlesPossible={analysis.maxBundlesPossible}
              limitingFactorName={analysis.limitingFactorName}
            />
          )}

          {step === 4 && successResult && (
            <BundleKitSuccessStep
              result={successResult}
              onProduceAnother={handleReset}
              onClose={() => onOpenChange(false)}
            />
          )}
        </div>

        {step < 4 && (
          <DialogFooter className="p-3 border-t bg-muted/20 flex items-center justify-between gap-2">
            <div>
              {step > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setStep((s) => (s - 1) as any)}
                >
                  <ArrowRight className="size-4" aria-hidden="true" />
                  السابق
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                إلغاء
              </Button>

              {step < 3 ? (
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={!isReady}
                  onClick={() => handleGoToStep((step + 1) as any)}
                >
                  التالي
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5"
                  disabled={produceMut.isPending || batches.filter((b) => b.selected).length === 0}
                  onClick={handleConfirmProduce}
                >
                  {produceMut.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      جارٍ الترحيل الذري…
                    </>
                  ) : (
                    <>
                      <PackageCheck className="size-4" aria-hidden="true" />
                      تأكيد وإنتاج المكونات
                    </>
                  )}
                </Button>
              )}
            </div>
          </DialogFooter>
        )}
      </DialogContent>

      <QuickRecipeCopyDialog
        open={quickRecipeTarget != null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setQuickRecipeTarget(null);
        }}
        targetComponent={quickRecipeTarget}
        otherBundleComponents={analysis?.components ?? []}
        onRecipeCreated={async (newRecipeId, variantId) => {
          newlyCreatedRecipeVariantIdRef.current = variantId;
          await analysisQ.refetch();
          await Promise.all([
            utils.production.recipes.invalidate(),
            utils.catalog.invalidate(),
          ]);
        }}
      />
    </Dialog>
  );
}
