import { ClipboardPaste, Layers, PackageSearch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PredictiveRecipeSuggestions } from "./PredictiveRecipeSuggestions";
import type { RecipeController } from "./useProductRecipe";
import type { RecipeTransfer } from "./useRecipeTransfer";
type Props = Pick<
  RecipeController,
  "currentRecipe" | "isEditing" | "setIsImportDialogOpen" | "startEditing"
> &
  Pick<RecipeTransfer, "handlePasteRecipe" | "handleApplyTemplate"> & {
    effectiveIsService: boolean;
    clipboardCount: number;
    productId: number;
    writeDisabled: boolean;
  };
export function RecipeEmptyState({
  currentRecipe,
  isEditing,
  setIsImportDialogOpen,
  startEditing,
  handlePasteRecipe,
  handleApplyTemplate,
  effectiveIsService,
  clipboardCount,
  productId,
  writeDisabled,
}: Props) {
  return (
    <>
      {/* حالة عدم وجود وصفة وبلا وضع تعديل */}
      {!currentRecipe && !isEditing && (
        <div className="space-y-4">
          <div className="py-7 text-center rounded-lg border border-dashed border-border/80 bg-muted/20 space-y-3">
            <div className="size-11 rounded-full bg-muted/60 text-muted-foreground mx-auto flex items-center justify-center">
              <Layers className="size-5 text-muted-foreground/60" />
            </div>
            <div className="space-y-1 max-w-md mx-auto">
              <h4 className="text-sm font-semibold text-foreground">
                لا توجد وصفة مواد خام لهذا الصنف حالياً
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {effectiveIsService
                  ? "إن كانت هذه الخدمة تستهلك مواداً مثل الأوراق، الأحبار أو الأقمشة، يمكنك ربطها بوصفة مواد ليتم خصمها وحساب كلفتها تلقائياً."
                  : "تمكنك الوصفة من حساب تكلفة التصنيع واستهلاك المواد الخام بدقة عند تشغيل أوامر الإنتاج."}
              </p>
            </div>

            <div className="flex items-center justify-center gap-2 flex-wrap pt-1">
              <Button
                type="button"
                size="sm"
                onClick={startEditing}
                disabled={writeDisabled}
                className="gap-1.5 text-xs bg-primary hover:bg-primary/90"
              >
                <Plus className="size-3.5" />
                إنشاء وصفة جديدة
              </Button>

              {clipboardCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handlePasteRecipe}
                  disabled={writeDisabled}
                  className="gap-1.5 text-xs border-primary/40 text-primary hover:bg-primary/5"
                >
                  <ClipboardPaste className="size-3.5" />
                  لصق من الحافظة ({clipboardCount} مواد)
                </Button>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsImportDialogOpen(true)}
                disabled={writeDisabled}
                className="gap-1.5 text-xs"
              >
                <PackageSearch className="size-3.5" />
                استيراد وصفة كقالب
              </Button>
            </div>
          </div>

          {/* محرك الاقتراحات التنبؤية للوصفات المشابهة */}
          <PredictiveRecipeSuggestions
            productId={productId}
            onApplySuggestion={handleApplyTemplate}
          />
        </div>
      )}
    </>
  );
}
