import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmt } from "@/lib/money";
import { formatQuantity } from "@shared/quantityFormat";
import type { MultiRecipeRequirementsAnalysisResult } from "@shared/multiRecipeProductionTypes";
import { AlertTriangle, CheckCircle2, Layers } from "lucide-react";

interface MultiRecipeMaterialsSummaryProps {
  analysis?: MultiRecipeRequirementsAnalysisResult;
  isLoading: boolean;
}

export function MultiRecipeMaterialsSummary({
  analysis,
  isLoading,
}: MultiRecipeMaterialsSummaryProps) {
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
    <div className="space-y-3">
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
              يوجد عجز في {analysis.limitingFactors.length} مادة خام. يجب خفض الكميات أو توريد المواد
              قبل الترحيل.
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
        <CardContent className="p-3 pt-0 space-y-1.5 max-h-[180px] overflow-y-auto">
          {analysis.aggregatedMaterials.map((m) => (
            <div
              key={m.materialVariantId}
              className="flex items-center justify-between gap-2 text-xs p-1.5 rounded border border-border/50 bg-background/50"
            >
              <div className="min-w-0 flex items-center gap-1.5">
                <span className="font-medium truncate">{m.materialName}</span>
                {m.sku && (
                  <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                    ({m.sku})
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0 text-start">
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
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
