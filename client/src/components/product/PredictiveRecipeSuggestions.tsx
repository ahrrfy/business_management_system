import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Layers,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatIqd } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import type { ImportedRecipeData } from "./RecipeImportDialog";

interface PredictiveRecipeSuggestionsProps {
  productId: number;
  onApplySuggestion: (data: ImportedRecipeData) => void;
}

export function PredictiveRecipeSuggestions({
  productId,
  onApplySuggestion,
}: PredictiveRecipeSuggestionsProps) {
  const [expandedRecipeId, setExpandedRecipeId] = useState<number | null>(null);

  const suggestionsQ = trpc.production.recipes.suggestSimilar.useQuery(
    { productId, limit: 4 },
    { enabled: Number.isFinite(productId) && productId > 0, staleTime: 60_000 },
  );

  const suggestions = suggestionsQ.data ?? [];

  if (suggestionsQ.isLoading) {
    return (
      <div className="p-3.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="size-4 text-primary animate-pulse" />
        <span>جارٍ تحليل الصنف والاسم لاقتراح الوصفات الأكثر تطابقاً...</span>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-gradient-to-b from-primary/5 via-primary/5 to-transparent p-3.5 sm:p-4 space-y-3 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-md bg-primary/20 text-primary flex items-center justify-center shrink-0">
            <Sparkles className="size-4" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-foreground flex items-center gap-2">
              وصفات مقترحة لمنتجات مشابهة (ذكاء تنبؤي)
              <Badge variant="secondary" className="text-[10px] font-normal py-0 px-1.5">
                {suggestions.length} اقتراحات
              </Badge>
            </h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              حلّل النظام صنف هذا المنتج واسمه واقترح هذه الوصفات لتطبيقها كقالب جاهز للبدء بنقرة واحدة
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {suggestions.map((sug) => {
          const isExpanded = expandedRecipeId === sug.recipeId;
          return (
            <Card
              key={sug.recipeId}
              className="border border-border/80 bg-card hover:border-primary/40 transition-colors shadow-xs overflow-hidden"
            >
              <CardContent className="p-3 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <span className="font-bold text-xs text-foreground block truncate">
                      {sug.productName}
                    </span>
                    <span className="text-[11px] text-muted-foreground block truncate">
                      {sug.recipeName}
                    </span>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-primary/30 text-primary bg-primary/5 text-[10px] shrink-0"
                  >
                    {sug.matchReason}
                  </Badge>
                </div>

                <div className="flex items-center justify-between text-[11px] border-t border-border/50 pt-2 text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1">
                      <Layers className="size-3 text-muted-foreground/70" />
                      {sug.lineCount} مواد خام
                    </span>
                    <span>·</span>
                    <span className="font-mono font-semibold text-foreground" dir="ltr">
                      {formatIqd(sug.estimatedUnitCost)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedRecipeId(isExpanded ? null : sug.recipeId)}
                      className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                    >
                      {isExpanded ? (
                        <>
                          إخفاء
                          <ChevronUp className="size-3" />
                        </>
                      ) : (
                        <>
                          معاينة
                          <ChevronDown className="size-3" />
                        </>
                      )}
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        onApplySuggestion({
                          recipeId: sug.recipeId,
                          recipeName: sug.recipeName,
                          productId: sug.productId,
                          productName: sug.productName,
                          laborPerOutputBase: sug.laborPerOutputBase,
                          wasteStdPct: sug.wasteStdPct,
                          notes: sug.notes,
                          lines: sug.lines,
                        })
                      }
                      className="h-7 px-2.5 text-[11px] gap-1 bg-primary hover:bg-primary/90"
                    >
                      <Check className="size-3" />
                      تطبيق كقالب
                    </Button>
                  </div>
                </div>

                {/* التفاصيل الموسعة لمعاينة المواد */}
                {isExpanded && (
                  <div className="pt-2 border-t border-border/60 space-y-1.5 animate-in fade-in-50 duration-150">
                    <span className="text-[10px] font-semibold text-muted-foreground block">
                      مواد الوصفة المقترحة:
                    </span>
                    <div className="rounded border bg-muted/20 overflow-hidden">
                      <table className="w-full text-[10px] border-collapse">
                        <thead className="bg-muted/40 text-muted-foreground border-b">
                          <tr>
                            <th className="py-1 px-2 text-start font-medium">المادة الخام</th>
                            <th className="py-1 px-1.5 text-center font-medium">الكمية</th>
                            <th className="py-1 px-2 text-end font-medium">الكلفة</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                          {sug.lines.map((line, idx) => (
                            <tr key={`${line.inputVariantId}-${idx}`}>
                              <td className="py-1 px-2 font-medium truncate max-w-[120px]">
                                {line.inputProductName}
                              </td>
                              <td className="py-1 px-1.5 text-center font-mono" dir="ltr">
                                {line.qtyPerOutputBase} {line.unitName}
                              </td>
                              <td className="py-1 px-2 text-end font-mono" dir="ltr">
                                {formatIqd(line.inputCostPrice)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
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

export default PredictiveRecipeSuggestions;
