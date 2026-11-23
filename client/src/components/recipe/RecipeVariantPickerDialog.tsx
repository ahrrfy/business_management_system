import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { RecipeLineSelectionWithMeta } from "@shared/recipeVariantSelection";
import {
  areAllCustomizableLinesSelected,
  pruneRecipeSelections,
  RecipeVariantSelectorList,
  type CustomizableLineOption,
} from "./RecipeVariantSelectorList";

interface RecipeVariantPickerDialogProps {
  open: boolean;
  title: string;
  lines: readonly CustomizableLineOption[];
  initialSelections?: readonly RecipeLineSelectionWithMeta[];
  quantity?: number;
  conversionFactor?: number;
  allowShortageIntake?: boolean;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (selections: RecipeLineSelectionWithMeta[]) => void;
}

export function RecipeVariantPickerDialog({
  open,
  title,
  lines,
  initialSelections,
  quantity = 1,
  conversionFactor = 1,
  allowShortageIntake = false,
  confirmLabel = "تأكيد الاختيار",
  onCancel,
  onConfirm,
}: RecipeVariantPickerDialogProps) {
  const [selections, setSelections] = useState<RecipeLineSelectionWithMeta[]>(() =>
    pruneRecipeSelections(initialSelections, lines),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelections(pruneRecipeSelections(initialSelections, lines));
      setError(null);
    }
  }, [open, initialSelections, lines]);

  const validSelections = pruneRecipeSelections(selections, lines);
  const complete = areAllCustomizableLinesSelected(lines, validSelections);

  function handleConfirm() {
    if (!complete) {
      setError("اختر اللون/المتغير المطلوب لكل مادة قبل المتابعة");
      return;
    }
    setError(null);
    onConfirm(validSelections);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent dir="rtl" className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Palette aria-hidden className="size-5 text-violet-600" />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="py-1 space-y-3">
          <RecipeVariantSelectorList
            lines={lines}
            selections={selections}
            onChange={(next) => {
              setSelections(next);
              if (error) setError(null);
            }}
            quantity={quantity}
            conversionFactor={conversionFactor}
            allowShortageIntake={allowShortageIntake}
          />
          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs font-bold text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            إلغاء
          </Button>
          <Button type="button" size="sm" onClick={handleConfirm} disabled={!complete} className="inline-flex items-center gap-1">
            <Check aria-hidden className="size-4" />
            <span>{confirmLabel}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
