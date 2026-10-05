import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmt } from "@/lib/money";
import { formatQuantity } from "@shared/quantityFormat";
import type { MultiRecipeRequirementsAnalysisResult } from "@shared/multiRecipeProductionTypes";
import { AlertCircle, Trash2 } from "lucide-react";

export interface MultiRecipeBatchDraft {
  recipeId: number;
  batchQty: number;
  scrapQty: number;
  laborPerUnit?: string;
}

interface MultiRecipeItemsStepProps {
  batches: MultiRecipeBatchDraft[];
  onUpdateBatch: (recipeId: number, update: Partial<MultiRecipeBatchDraft>) => void;
  onRemoveBatch: (recipeId: number) => void;
  analysis?: MultiRecipeRequirementsAnalysisResult;
}

export function MultiRecipeItemsStep({
  batches,
  onUpdateBatch,
  onRemoveBatch,
  analysis,
}: MultiRecipeItemsStepProps) {
  const analysisMap = new Map(analysis?.recipes.map((r) => [r.recipeId, r]) ?? []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>قائمة الوصفات المراد إنتاجها وتحديد كمية كل دفعة:</span>
        <span>{batches.length} وصفة</span>
      </div>

      <div className="space-y-2.5 max-h-[340px] overflow-y-auto pe-1">
        {batches.map((b) => {
          const rDto = analysisMap.get(b.recipeId);
          const hasDivisibilityError = rDto && !rDto.isMultipleValid;

          return (
            <Card
              key={b.recipeId}
              className={`border transition-colors ${
                hasDivisibilityError
                  ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)]/20"
                  : "hover:border-primary/40"
              }`}
            >
              <CardContent className="p-3 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">
                      {rDto?.recipeName ?? `وصفة #${b.recipeId}`}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
                      <span>{rDto?.outputProductName ?? "منتج ناتج"}</span>
                      {rDto?.outputSku && (
                        <span className="font-mono text-[10px]" dir="ltr">
                          ({rDto.outputSku})
                        </span>
                      )}
                      <span className="inline-block rounded px-1.5 py-0.2 bg-muted text-[10px]">
                        وحدة: {rDto?.outputUnitName ?? "أساس"}
                      </span>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => onRemoveBatch(b.recipeId)}
                    title="إزالة هذه الوصفة من دفعة الإنتاج"
                    aria-label={`إزالة وصفة ${rDto?.recipeName ?? b.recipeId}`}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-border/60">
                  <div className="space-y-1">
                    <Label className="text-xs">كمية الدفعة المطلوبة *</Label>
                    <Input
                      dir="ltr"
                      type="number"
                      min={1}
                      className="h-8 text-sm"
                      value={b.batchQty || ""}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        onUpdateBatch(b.recipeId, {
                          batchQty: isNaN(val) ? 0 : Math.max(0, val),
                        });
                      }}
                      placeholder="1"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">تالف متوقع (اختياري)</Label>
                    <Input
                      dir="ltr"
                      type="number"
                      min={0}
                      className="h-8 text-sm"
                      value={b.scrapQty === 0 ? "0" : b.scrapQty || ""}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        onUpdateBatch(b.recipeId, {
                          scrapQty: isNaN(val) ? 0 : Math.max(0, val),
                        });
                      }}
                      placeholder="0"
                    />
                  </div>
                </div>

                {b.scrapQty >= b.batchQty && b.batchQty > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-destructive font-medium bg-destructive/10 p-2 rounded">
                    <AlertCircle aria-hidden className="size-3.5 shrink-0" />
                    <span>كمية التالف لا يمكن أن تساوي أو تتجاوز حجم الدفعة.</span>
                  </div>
                )}

                {hasDivisibilityError && rDto && (
                  <div className="flex items-center justify-between gap-2 text-xs text-[var(--sem-warn)] font-medium bg-[var(--sem-warn-bg)]/30 p-2 rounded">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <AlertCircle aria-hidden className="size-3.5 shrink-0" />
                      <span>
                        تنبيه قابلية القسمة: الوصفة تقبل مضاعفات {rDto.requiredBatchMultiple} فقط.
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 text-[11px] px-2 border-[var(--sem-warn)]/50 hover:bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                      onClick={() => {
                        const target = Math.ceil(b.batchQty / rDto.requiredBatchMultiple) * rDto.requiredBatchMultiple;
                        onUpdateBatch(b.recipeId, {
                          batchQty: Math.max(rDto.requiredBatchMultiple, target),
                        });
                      }}
                    >
                      جبر إلى {Math.max(rDto.requiredBatchMultiple, Math.ceil(b.batchQty / rDto.requiredBatchMultiple) * rDto.requiredBatchMultiple)}
                    </Button>
                  </div>
                )}

                {rDto && (
                  <div className="flex items-center justify-between text-xs pt-1 text-muted-foreground border-t border-dashed">
                    <span>
                      السليم الصافي:{" "}
                      <b className="text-foreground tabular-nums">
                        {formatQuantity(rDto.goodQty.toString())}
                      </b>{" "}
                      {rDto.outputUnitName}
                    </span>
                    <span>
                      الكلفة التقديرية:{" "}
                      <b className="text-foreground tabular-nums" dir="ltr">
                        {fmt(rDto.estimatedTotalCost)}
                      </b>
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
