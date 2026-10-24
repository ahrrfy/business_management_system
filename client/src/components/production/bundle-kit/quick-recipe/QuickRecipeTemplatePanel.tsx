import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { QuickRecipeDraft } from "./useQuickRecipeDraft";
import type { QuickRecipeTemplates } from "./useQuickRecipeTemplates";
interface Props {
  draft: QuickRecipeDraft;
  templates: QuickRecipeTemplates;
  targetComponent: ComponentRequirementDto;
}
export function QuickRecipeTemplatePanel({
  draft,
  templates,
  targetComponent,
}: Props) {
  const { lines, handleResetToEmpty } = draft;
  const {
    bundleManufacturedSuggestions,
    isLoadingRecipe,
    selectedCatalogRecipeId,
    setSelectedCatalogRecipeId,
    allRecipesQ,
    handleSelectTemplate,
    copiedSourceName,
  } = templates;
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold text-primary">
          <Sparkles aria-hidden="true" className="size-4" />
          <span>النسخ الذكي من وصفة سابقة (قالب)</span>
        </div>
        {lines.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleResetToEmpty}
            className="h-7 text-[11px] text-muted-foreground hover:text-foreground gap-1"
          >
            <RotateCcw aria-hidden="true" className="size-3" />
            بدء بوصفة فارغة
          </Button>
        )}
      </div>

      {/* الأولوية 1: مكوّنات نفس البكج المصنعة */}
      {bundleManufacturedSuggestions.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-muted-foreground font-medium">
            وصفات مكوّنات البكج الحالية (مقترحة للتطابق السريع):
          </div>
          <div className="flex flex-wrap gap-2">
            {bundleManufacturedSuggestions.map((comp) => (
              <Button
                key={comp.variantId}
                type="button"
                variant="outline"
                size="sm"
                disabled={isLoadingRecipe}
                onClick={() =>
                  handleSelectTemplate(
                    comp.recipeId!,
                    `${comp.productName} (${comp.recipeName || "وصفة"})`,
                  )
                }
                className="h-7 text-xs gap-1.5 border-primary/40 hover:bg-primary/10 hover:border-primary"
              >
                <Copy aria-hidden="true" className="size-3 text-primary" />
                <span>{comp.productName}</span>
                {comp.recipeName && (
                  <span className="text-[10px] text-muted-foreground">
                    [{comp.recipeName}]
                  </span>
                )}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* الأولوية 2: البحث في كتالوج الوصفات العام */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
        <AppSelect
          aria-label="اختر وصفة من الكتالوج العام للنسخ منها"
          searchable
          searchPlaceholder="ابحث عن وصفة بالاسم أو المنتج..."
          value={selectedCatalogRecipeId}
          disabled={isLoadingRecipe}
          onValueChange={(val: string) => {
            setSelectedCatalogRecipeId(val);
            if (val) {
              const found = (allRecipesQ.data ?? []).find(
                (r) => String(r.id) === val,
              );
              handleSelectTemplate(Number(val), found?.name || `وصفة #${val}`);
            }
          }}
          className="h-8 text-xs"
        >
          <option value="">اختر وصفة من الكتالوج العام للنسخ منها...</option>
          {(allRecipesQ.data ?? [])
            .filter((r) => r.outputVariantId !== targetComponent?.variantId)
            .map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.name} ({r.outputProductName ?? `#${r.outputVariantId}`})
              </option>
            ))}
        </AppSelect>
      </div>

      {/* شريط تأكيد النسخ */}
      {copiedSourceName && (
        <div className="flex items-center gap-2 rounded bg-background/80 p-2 text-xs border border-primary/20 text-foreground">
          <CheckCircle2
            aria-hidden="true"
            className="size-4 text-[var(--sem-pos)] shrink-0"
          />
          <span>
            تم نسخ تركيبة المواد من: <strong>{copiedSourceName}</strong> (
            {lines.length} مواد) — يمكنك تعديل الكميات أدناه.
          </span>
        </div>
      )}
    </div>
  );
}
export function QuickRecipeReplaceConfirmation({
  draft,
  templates,
}: Omit<Props, "targetComponent">) {
  const { lines } = draft;
  const {
    pendingTemplate,
    handleCancelReplaceTemplate,
    handleConfirmReplaceTemplate,
  } = templates;
  return (
    <Dialog
      open={pendingTemplate != null}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleCancelReplaceTemplate();
      }}
    >
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <AlertTriangle
              className="size-5 text-amber-500 shrink-0"
              aria-hidden="true"
            />
            <span>تأكيد استبدال مواد الوصفة</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
            تحتوي مسودة الوصفة الحالية على {lines.length} من المواد المدخلة.
            سيؤدي تطبيق القالب «{pendingTemplate?.sourceName}» إلى استبدال كافة
            المواد المدخلة وإعادة ضبط نسب الهدر وأجور العمالة. هل تريد المتابعة؟
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0 mt-3 flex-col-reverse sm:flex-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancelReplaceTemplate}
          >
            إلغاء والاحتفاظ بالمواد الحالية
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleConfirmReplaceTemplate}
            className="gap-1.5"
          >
            استبدال وتطبيق القالب
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
