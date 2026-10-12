import { useState } from "react";
import {
  Check,
  ChevronLeft,
  FileSpreadsheet,
  Layers,
  PackageSearch,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { formatIqd, moneyInput } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export interface ImportedRecipeLine {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  unitName?: string;
  notes?: string | null;
}

export interface ImportedRecipeData {
  recipeId: number;
  recipeName: string;
  productId: number;
  productName: string;
  laborPerOutputBase: string;
  wasteStdPct: string;
  notes: string | null;
  lines: ImportedRecipeLine[];
}

interface RecipeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentProductId: number;
  onApplyRecipe: (data: ImportedRecipeData) => Promise<boolean | void> | boolean | void;
}

export function RecipeImportDialog({
  open,
  onOpenChange,
  currentProductId,
  onApplyRecipe,
}: RecipeImportDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const importListQ = trpc.production.recipes.listForImport.useQuery(
    {
      query: searchQuery.trim() || undefined,
      excludeProductId: currentProductId,
      limit: 20,
    },
    { enabled: open, staleTime: 30_000 },
  );

  const recipes = importListQ.data ?? [];
  const selectedRecipe = recipes.find((r) => r.recipeId === selectedRecipeId) ?? recipes[0] ?? null;

  async function handleConfirmApply() {
    if (!selectedRecipe || isApplying) return;
    try {
      setIsApplying(true);
      const res = await onApplyRecipe({
        recipeId: selectedRecipe.recipeId,
        recipeName: selectedRecipe.recipeName,
        productId: selectedRecipe.productId,
        productName: selectedRecipe.productName,
        laborPerOutputBase: selectedRecipe.laborPerOutputBase,
        wasteStdPct: selectedRecipe.wasteStdPct,
        notes: selectedRecipe.notes,
        lines: selectedRecipe.lines.map((l) => ({
          inputVariantId: l.inputVariantId,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          unitName: l.unitName,
          notes: l.notes,
        })),
      });
      if (res !== false) {
        onOpenChange(false);
      }
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 sm:p-5 border-b bg-muted/20">
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <PackageSearch className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">
                استيراد وصفة تصنيع من منتج آخر كقالب
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                اختر أي منتج يملك وصفة معتمدة لاستيراد بنودها وموادها الخام والتعديل الفوري عليها
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* حقل البحث */}
        <div className="p-4 border-b bg-background">
          <UnifiedSearchInput
            value={searchQuery}
            onChange={(val) => {
              setSearchQuery(val);
              setSelectedRecipeId(null);
            }}
            placeholder="ابحث باسم المنتج، أو اسم الوصفة، أو رمز SKU..."
            className="h-9 text-xs"
          />
        </div>

        {/* المحتوى الرئيسي: عمودان (قائمة المنتجات + معاينة الوصفة) */}
        <div className="grid grid-cols-1 md:grid-cols-12 flex-1 overflow-hidden min-h-[360px] max-h-[500px]">
          {/* قائمة الوصفات */}
          <div className="md:col-span-5 border-e overflow-y-auto p-2 space-y-1.5 divide-y divide-border/40">
            {importListQ.isLoading && (
              <div className="py-12 text-center text-xs text-muted-foreground">
                جارٍ تحميل الوصفات المتاحة...
              </div>
            )}

            {!importListQ.isLoading && importListQ.isError && (
              <div className="py-12 text-center text-xs text-muted-foreground space-y-2.5 px-4">
                <p className="text-destructive font-medium">فشل جلب قائمة الوصفات من الخادم</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void importListQ.refetch()}
                  className="h-7 text-xs"
                >
                  إعادة المحاولة
                </Button>
              </div>
            )}

            {!importListQ.isLoading && !importListQ.isError && recipes.length === 0 && (
              <div className="py-12 text-center text-xs text-muted-foreground space-y-2">
                <FileSpreadsheet className="size-8 mx-auto text-muted-foreground/40" />
                <p>لم يتم العثور على وصفات مطابقة للبحث</p>
              </div>
            )}

            {recipes.map((rec) => {
              const isSelected = selectedRecipe?.recipeId === rec.recipeId;
              return (
                <button
                  key={rec.recipeId}
                  type="button"
                  onClick={() => setSelectedRecipeId(rec.recipeId)}
                  className={cn(
                    "w-full text-start p-2.5 rounded-lg transition-colors border block pt-2",
                    isSelected
                      ? "bg-primary/10 border-primary/40 text-foreground"
                      : "bg-card border-border/50 hover:bg-muted/50 text-card-foreground",
                  )}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <span className="font-semibold text-xs leading-tight block">
                      {rec.productName}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0 font-normal">
                      {rec.lineCount} مواد
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
                    <span className="truncate max-w-[140px]">{rec.recipeName}</span>
                    <span className="font-mono font-medium text-foreground" dir="ltr">
                      {formatIqd(rec.estimatedUnitCost)}
                    </span>
                  </div>
                  {rec.categoryName && (
                    <span className="text-[10px] text-muted-foreground/80 block mt-0.5">
                      القسم: {rec.categoryName}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* معاينة تفاصيل الوصفة المحددة */}
          <div className="md:col-span-7 overflow-y-auto p-4 flex flex-col justify-between bg-muted/10 space-y-3">
            {selectedRecipe ? (
              <div className="space-y-3">
                <div className="p-3 rounded-lg border bg-background space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-bold text-sm text-foreground">
                      {selectedRecipe.productName}
                    </h4>
                    <span className="text-xs font-semibold text-primary font-mono" dir="ltr">
                      كلفة تقديرية: {formatIqd(selectedRecipe.estimatedUnitCost)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    اسم الوصفة: {selectedRecipe.recipeName}
                  </p>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1 border-t mt-1.5">
                    <span>أجور عمالة: {formatIqd(selectedRecipe.laborPerOutputBase)}</span>
                    <span>
                      هدر معياري: {(() => {
                        const raw = moneyInput(selectedRecipe.wasteStdPct);
                        const safe = raw.gt(0) && raw.lt(1) ? raw : moneyInput("0");
                        return safe.mul(100).toFixed(1);
                      })()}%
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Layers className="size-3.5 text-primary" />
                    المواد والمكونات ({selectedRecipe.lines.length}):
                  </span>
                  <div className="rounded-md border bg-background overflow-hidden max-h-56 overflow-y-auto">
                    <table className="w-full text-[11px] border-collapse">
                      <thead className="bg-muted/40 text-muted-foreground border-b">
                        <tr>
                          <th className="py-1.5 px-2.5 text-start font-medium">المادة الخام</th>
                          <th className="py-1.5 px-2 text-start font-medium">SKU</th>
                          <th className="py-1.5 px-2 text-center font-medium">الكمية</th>
                          <th className="py-1.5 px-2 text-end font-medium">التكلفة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {selectedRecipe.lines.map((l, idx) => (
                          <tr key={`${l.inputVariantId}-${idx}`}>
                            <td className="py-1.5 px-2.5 font-medium">{l.inputProductName}</td>
                            <td className="py-1.5 px-2 font-mono text-muted-foreground" dir="ltr">
                              {l.inputSku}
                            </td>
                            <td className="py-1.5 px-2 text-center font-mono" dir="ltr">
                              {l.qtyPerOutputBase} {l.unitName}
                            </td>
                            <td className="py-1.5 px-2 text-end font-mono" dir="ltr">
                              {formatIqd(l.inputCostPrice)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {selectedRecipe.notes && (
                  <div className="p-2.5 rounded bg-muted/40 border text-xs text-muted-foreground">
                    <span className="font-semibold block mb-0.5">ملاحظات الوصفة:</span>
                    {selectedRecipe.notes}
                  </div>
                )}
              </div>
            ) : (
              <div className="py-16 text-center text-xs text-muted-foreground">
                اختر وصفة من القائمة لمعاينتها
              </div>
            )}
          </div>
        </div>

        {/* شريط الإجراءات السفلي */}
        <div className="p-3 sm:p-4 border-t bg-muted/20 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-8 text-xs"
          >
            إلغاء
          </Button>

          <Button
            type="button"
            size="sm"
            disabled={!selectedRecipe || isApplying}
            onClick={handleConfirmApply}
            className="h-8 text-xs gap-1.5 bg-primary hover:bg-primary/90"
          >
            <Check className="size-3.5" />
            {isApplying ? "جارٍ التطبيق..." : "تطبيق هذه الوصفة كقالب"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default RecipeImportDialog;
