import * as React from "react";
import { AlertTriangle, Copy, Loader2, Save } from "lucide-react";
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
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import {
  QuickRecipeIdentityFields,
  QuickRecipeCostFields,
} from "./quick-recipe/QuickRecipeDetails";
import { QuickRecipeMaterialsEditor } from "./quick-recipe/QuickRecipeMaterialsEditor";
import {
  QuickRecipeTemplatePanel,
  QuickRecipeReplaceConfirmation,
} from "./quick-recipe/QuickRecipeTemplatePanel";
import { useQuickRecipeDraft } from "./quick-recipe/useQuickRecipeDraft";
import { useQuickRecipeTemplates } from "./quick-recipe/useQuickRecipeTemplates";
import { useQuickRecipeSave } from "./quick-recipe/useQuickRecipeSave";
export { normalizeDecimalInput } from "@shared/numberNormalize";
export type { EditableRecipeLine } from "./quick-recipe/recipeDraftModel";
interface QuickRecipeCopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetComponent: ComponentRequirementDto | null;
  otherBundleComponents?: ComponentRequirementDto[];
  onRecipeCreated: (
    recipeId: number,
    variantId: number,
  ) => void | Promise<void>;
}
export function QuickRecipeCopyDialog({
  open,
  onOpenChange,
  targetComponent,
  otherBundleComponents = [],
  onRecipeCreated,
}: QuickRecipeCopyDialogProps) {
  const draft = useQuickRecipeDraft({ open, targetComponent });
  const templates = useQuickRecipeTemplates({
    open,
    targetComponent,
    otherBundleComponents,
    draft,
  });
  const { createRecipeMut, handleSave } = useQuickRecipeSave({
    open,
    targetComponent,
    onOpenChange,
    onRecipeCreated,
    draft,
  });
  const { effectiveBaseUnitId, effectiveBaseUnitName, recipeName, lines } =
    draft;
  if (!targetComponent) return null;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-4xl max-w-[96vw] max-h-[92vh] flex flex-col p-0 overflow-hidden"
          dir="rtl"
        >
          {/* رأس النافذة */}
          <DialogHeader className="p-4 border-b bg-muted/30 shrink-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Copy aria-hidden="true" className="size-5" />
                </div>
                <div>
                  <DialogTitle className="text-base font-bold flex items-center gap-2">
                    <span>تحويل لمصنّع: إضافة / نسخ وصفة إنتاج</span>
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    تحديد تركيبة المواد الأولية لتمكين تصنيع «
                    {targetComponent.productName}» محلياً ضمن هذا البكج
                  </DialogDescription>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge
                  variant="outline"
                  className="text-[11px] font-mono whitespace-nowrap shrink-0"
                  dir="ltr"
                >
                  {targetComponent.sku}
                </Badge>
                <Badge
                  variant="secondary"
                  className="text-[11px] whitespace-nowrap shrink-0"
                >
                  الوحدة: {effectiveBaseUnitName}
                </Badge>
                {targetComponent.shortageQty > 0 && (
                  <Badge
                    variant="outline"
                    className="border-[var(--sem-neg)] text-[var(--sem-neg)] text-[11px] whitespace-nowrap shrink-0"
                  >
                    عجز: {targetComponent.shortageQty}
                  </Badge>
                )}
              </div>
            </div>
          </DialogHeader>

          {/* محتوى النموذج القابل للتمرير */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            <fieldset
              disabled={createRecipeMut.isPending}
              className="min-w-0 space-y-4 border-0 p-0"
            >
              {/* تنبيه غياب الوحدة الأساسية النشطة */}
              {!effectiveBaseUnitId && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2.5"
                >
                  <AlertTriangle
                    aria-hidden="true"
                    className="size-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400"
                  />
                  <div className="space-y-0.5">
                    <p className="font-bold">
                      تنبيه: لا توجد وحدة أساسية نشطة مسجلة لهذا الصنف
                    </p>
                    <p className="text-muted-foreground leading-relaxed text-[11px]">
                      تشترط وصفات الإنتاج أن تكون وحدة الناتج مطابقة للوحدة
                      الأساسية النشطة للمنتج في الكتالوج. يرجى مراجعة وتعيين
                      الوحدة الأساسية في بطاقة المنتج أولاً لتمكين حفظ الوصفة.
                    </p>
                  </div>
                </div>
              )}

              <QuickRecipeTemplatePanel
                draft={draft}
                templates={templates}
                targetComponent={targetComponent}
              />

              <QuickRecipeIdentityFields draft={draft} />

              <QuickRecipeMaterialsEditor draft={draft} />

              <QuickRecipeCostFields draft={draft} />
            </fieldset>
          </div>

          {/* أزرار الإجراءات في أسفل النافذة */}
          <DialogFooter className="p-3 border-t bg-muted/20 flex items-center justify-between gap-2 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={createRecipeMut.isPending}
              className="whitespace-nowrap shrink-0"
            >
              إلغاء
            </Button>

            <Button
              type="button"
              variant="success"
              size="sm"
              onClick={handleSave}
              disabled={
                createRecipeMut.isPending ||
                lines.length === 0 ||
                !recipeName.trim() ||
                !effectiveBaseUnitId
              }
              className="gap-1.5 font-medium whitespace-nowrap shrink-0"
            >
              {createRecipeMut.isPending ? (
                <>
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  جارٍ حفظ الوصفة...
                </>
              ) : (
                <>
                  <Save aria-hidden="true" className="size-4" />
                  حفظ الوصفة وتحويل الصنف لمصنّع
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <QuickRecipeReplaceConfirmation draft={draft} templates={templates} />
    </>
  );
}
