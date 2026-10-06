import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import { formatQuantity } from "@shared/quantityFormat";
import type {
  AggregatedMultiRecipeMaterialDto,
  MultiRecipeRequirementsAnalysisResult,
} from "@shared/multiRecipeProductionTypes";
import type {
  MaterialSubstitutionItem,
  SubstituteRecipeMaterialResult,
} from "@shared/recipeSubstitutionTypes";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Layers, Trash2 } from "lucide-react";
import { MaterialSubstitutionDialog } from "../MaterialSubstitutionDialog";

interface MultiRecipeMaterialsSummaryProps {
  analysis?: MultiRecipeRequirementsAnalysisResult;
  isLoading: boolean;
  branchId?: number | null;
  materialSubstitutions?: MaterialSubstitutionItem[];
  onApplySubstitution?: (substitution: MaterialSubstitutionItem) => void;
  onRemoveSubstitution?: (material: AggregatedMultiRecipeMaterialDto) => void;
  onPermanentSuccess?: (result: SubstituteRecipeMaterialResult) => void;
}

export function MultiRecipeMaterialsSummary({
  analysis,
  isLoading,
  branchId,
  materialSubstitutions = [],
  onApplySubstitution,
  onRemoveSubstitution,
  onPermanentSuccess,
}: MultiRecipeMaterialsSummaryProps) {
  const [selectedMaterialForSub, setSelectedMaterialForSub] =
    useState<AggregatedMultiRecipeMaterialDto | null>(null);
  const [isSubDialogOpen, setIsSubDialogOpen] = useState<boolean>(false);

  const currentSub = useMemo(() => {
    if (!selectedMaterialForSub) return null;
    const origId = selectedMaterialForSub.isSubstituted
      ? (selectedMaterialForSub.originalVariantId ?? selectedMaterialForSub.materialVariantId)
      : selectedMaterialForSub.materialVariantId;
    return materialSubstitutions.find((s) => s.originalVariantId === origId) ?? null;
  }, [selectedMaterialForSub, materialSubstitutions]);

  if (isLoading) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-center text-xs text-muted-foreground">
          جارٍ تحليل الاحتياجات ومطابقة أرصدة المخزون...
        </CardContent>
      </Card>
    );
  }

  if (!analysis) return null;

  const hasDeficit = !analysis.canProduceAll;

  return (
    <div className="space-y-3" dir="rtl">
      {/* بطاقة التكاليف الإجمالية */}
      <Card className="border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)]/10">
        <CardContent className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">كلفة المواد الخام:</span>
              <div className="font-semibold text-sm tabular-nums" dir="ltr">
                {fmt(analysis.totalMaterialsCost)}
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">إجمالي أجور العمالة:</span>
              <div className="font-semibold text-sm tabular-nums" dir="ltr">
                {fmt(analysis.totalLaborCost)}
              </div>
            </div>
            <div>
              <span className="font-medium text-primary">الكلفة التقديرية الإجمالية:</span>
              <div className="font-bold text-base text-primary tabular-nums" dir="ltr">
                {fmt(analysis.totalEstimatedCost)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* تنبيه النواقص أو التأكيد */}
      {hasDeficit ? (
        <div className="rounded-lg border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)]/20 p-2.5 flex items-start gap-2 text-xs text-[var(--sem-neg)]">
          <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <div className="font-semibold">تنبيه: الأرصدة المتوفرة لا تكفي لإتمام كامل الكميات</div>
            <div className="text-[11px] text-muted-foreground">
              يوجد عجز في {analysis.limitingFactors.length} مادة خام. يمكنك استبدال المواد النافذة ببدائل متوفرة أدناه.
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-2.5 flex items-center gap-2 text-xs text-[var(--sem-pos)]">
          <CheckCircle2 aria-hidden className="size-4 shrink-0" />
          <span className="font-medium">
            كافة المواد الخام المطلوبة متوفرة بالكامل في رصيد الفرع وجاهزة للإنتاج.
          </span>
        </div>
      )}

      {/* جدول/قائمة المواد المجمعة */}
      <Card>
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground">
            <Layers aria-hidden className="size-3.5 text-primary" />
            المواد الخام المستهلكة المجمعة لجميع الوصفات ({analysis.aggregatedMaterials.length} مادة):
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-1.5 max-h-[220px] overflow-y-auto">
          {analysis.aggregatedMaterials.map((m) => (
            <div
              key={m.materialVariantId}
              className={`flex items-center justify-between gap-2 text-xs p-2 rounded border transition-colors ${
                !m.isSufficient ? "border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)]/20" : "border-border/50 bg-background/50"
              }`}
            >
              <div className="min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium truncate">{m.materialName}</span>
                  {m.sku && (
                    <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                      ({m.sku})
                    </span>
                  )}
                </div>
                {m.isSubstituted && m.originalMaterialName && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <ArrowLeftRight aria-hidden className="size-2.5 text-primary" />
                    بديل عن «{m.originalMaterialName}»
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-muted-foreground text-[11px]">
                  مطلوب: <b className="text-foreground">{formatQuantity(m.totalRequiredBase)}</b> /
                  متوفر:{" "}
                  <b
                    className={
                      m.isSufficient ? "text-[var(--sem-pos)]" : "text-[var(--sem-neg)]"
                    }
                  >
                    {formatQuantity(m.availableInBranch.toString())}
                  </b>{" "}
                  {m.unitName}
                </span>

                <span
                  className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    m.isSufficient
                      ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                      : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
                  }`}
                >
                  {m.isSufficient ? "متوفر" : `نقص ${formatQuantity(m.deficitBase)}`}
                </span>

                {m.isSubstituted ? (
                  <div className="flex items-center gap-1">
                    <Badge
                      variant="secondary"
                      className="bg-primary/10 text-primary border-primary/20 text-[10px] gap-1 py-0.5"
                    >
                      <ArrowLeftRight aria-hidden className="size-2.5" />
                      مادة بديلة
                    </Badge>
                    {onRemoveSubstitution && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[11px] text-destructive hover:bg-destructive/10 px-1.5"
                        onClick={() => onRemoveSubstitution(m)}
                        title="إلغاء البديل"
                      >
                        <Trash2 aria-hidden className="size-3" />
                        إلغاء
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px] text-muted-foreground hover:bg-muted px-1.5"
                      onClick={() => {
                        setSelectedMaterialForSub(m);
                        setIsSubDialogOpen(true);
                      }}
                      title="تغيير المادة البديلة"
                    >
                      تغيير
                    </Button>
                  </div>
                ) : !m.isSufficient ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-6 text-[11px] border border-[var(--sem-neg)]/50 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] hover:bg-[var(--sem-neg)]/20 font-bold gap-1 px-2 shadow-xs transition-colors"
                    onClick={() => {
                      setSelectedMaterialForSub(m);
                      setIsSubDialogOpen(true);
                    }}
                  >
                    <ArrowLeftRight aria-hidden className="size-3" />
                    استبدال ببديل
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px] text-muted-foreground hover:text-foreground gap-1 px-1.5"
                    onClick={() => {
                      setSelectedMaterialForSub(m);
                      setIsSubDialogOpen(true);
                    }}
                    title="استبدال المادة بخام آخر"
                  >
                    <ArrowLeftRight aria-hidden className="size-2.5" />
                    استبدال
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {selectedMaterialForSub && (
        <MaterialSubstitutionDialog
          open={isSubDialogOpen}
          onOpenChange={(next) => {
            setIsSubDialogOpen(next);
            if (!next) setSelectedMaterialForSub(null);
          }}
          recipeId={selectedMaterialForSub.recipeId ?? null}
          recipeName={selectedMaterialForSub.recipeName ?? null}
          originalVariantId={
            selectedMaterialForSub.isSubstituted
              ? (selectedMaterialForSub.originalVariantId ?? selectedMaterialForSub.materialVariantId)
              : selectedMaterialForSub.materialVariantId
          }
          originalProductName={
            selectedMaterialForSub.isSubstituted
              ? (selectedMaterialForSub.originalMaterialName ?? selectedMaterialForSub.materialName)
              : selectedMaterialForSub.materialName
          }
          originalSku={
            selectedMaterialForSub.isSubstituted
              ? (selectedMaterialForSub.originalSku ?? selectedMaterialForSub.sku)
              : selectedMaterialForSub.sku
          }
          originalQtyPerOutputBase={selectedMaterialForSub.qtyPerOutputBase ?? "1"}
          originalUnitName={selectedMaterialForSub.unitName}
          originalCostPrice={selectedMaterialForSub.costPrice ?? null}
          availableStock={selectedMaterialForSub.isSubstituted ? null : selectedMaterialForSub.availableInBranch}
          consumedQty={Number(selectedMaterialForSub.totalRequiredBase)}
          branchId={branchId ?? null}
          defaultScope="adhoc"
          currentSubstitution={currentSub}
          onApplyAdHoc={(sub) => {
            onApplySubstitution?.({ ...sub, recipeId: undefined });
            setIsSubDialogOpen(false);
            setSelectedMaterialForSub(null);
          }}
          onPermanentSuccess={(res) => {
            onPermanentSuccess?.(res);
            setIsSubDialogOpen(false);
            setSelectedMaterialForSub(null);
          }}
          onRemoveSubstitution={() => {
            if (selectedMaterialForSub) {
              onRemoveSubstitution?.(selectedMaterialForSub);
              setIsSubDialogOpen(false);
              setSelectedMaterialForSub(null);
            }
          }}
        />
      )}
    </div>
  );
}
