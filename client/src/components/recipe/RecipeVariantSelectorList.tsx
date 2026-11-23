import { AlertTriangle, Check, Palette } from "lucide-react";
import { formatQuantity } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { RecipeLineSelectionWithMeta } from "@shared/recipeVariantSelection";

export interface CustomizableVariantOption {
  variantId: number;
  label: string;
  color: string | null;
  colorHex: string | null;
  availableBase: number;
}

export interface CustomizableLineOption {
  recipeId: number;
  outputVariantId: number;
  outputProductId: number;
  recipeLineId: number;
  inputProductId: number;
  defaultInputVariantId: number;
  materialName: string;
  qtyPerOutputBase: string;
  options: CustomizableVariantOption[];
}

export function areAllCustomizableLinesSelected(
  lines: readonly CustomizableLineOption[],
  selections: readonly RecipeLineSelectionWithMeta[] | undefined,
): boolean {
  if (lines.length === 0) return true;
  if (!selections?.length) return false;
  return lines.every((line) => {
    const picked = selections.find((s) => Number(s.recipeLineId) === Number(line.recipeLineId));
    if (!picked) return false;
    return line.options.some((opt) => Number(opt.variantId) === Number(picked.variantId));
  });
}

export function upsertRecipeLineSelection(
  current: readonly RecipeLineSelectionWithMeta[] | undefined,
  line: CustomizableLineOption,
  option: CustomizableVariantOption,
): RecipeLineSelectionWithMeta[] {
  const nextEntry: RecipeLineSelectionWithMeta = {
    recipeLineId: Number(line.recipeLineId),
    variantId: Number(option.variantId),
    materialName: line.materialName,
    label: option.label,
    color: option.color,
    colorHex: option.colorHex,
  };
  const base = (current ?? []).filter((s) => Number(s.recipeLineId) !== Number(line.recipeLineId));
  return [...base, nextEntry].sort((a, b) => a.recipeLineId - b.recipeLineId);
}

interface RecipeVariantSelectorListProps {
  lines: readonly CustomizableLineOption[];
  selections: readonly RecipeLineSelectionWithMeta[] | undefined;
  onChange: (next: RecipeLineSelectionWithMeta[]) => void;
  quantity?: number;
  conversionFactor?: number;
  /** في الاستقبال/أمر الشغل نُظهر تحذير النقص دون حجب الإدخال لأن الفحص الصارم عند بدء التنفيذ. */
  allowShortageIntake?: boolean;
}

export function RecipeVariantSelectorList({
  lines,
  selections,
  onChange,
  quantity = 1,
  conversionFactor = 1,
  allowShortageIntake = false,
}: RecipeVariantSelectorListProps) {
  if (lines.length === 0) return null;

  const effQty = Math.max(1, Number(quantity) || 1);
  const effFactor = Math.max(0.0001, Number(conversionFactor) || 1);

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
          <Palette aria-hidden className="size-4 text-violet-600" />
          <span>اختيار ألوان ومتغيرات المواد المطلوبة *</span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          الكمية المطلوبة: {formatQuantity(effQty)}
        </span>
      </div>

      <div className="space-y-3">
        {lines.map((line) => {
          const neededBase = effQty * effFactor * Number(line.qtyPerOutputBase || 0);
          const selected = selections?.find((s) => Number(s.recipeLineId) === Number(line.recipeLineId));
          const selectedOpt = selected
            ? line.options.find((opt) => Number(opt.variantId) === Number(selected.variantId))
            : undefined;
          const hasShortage =
            selectedOpt != null && Number(selectedOpt.availableBase) < neededBase;

          return (
            <div key={line.recipeLineId} className="rounded-md border bg-card p-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-bold text-foreground">{line.materialName}</span>
                <span className="text-[11px] text-muted-foreground" dir="ltr">
                  المطلوب: {formatQuantity(neededBase)}
                </span>
              </div>

              {line.options.length === 0 ? (
                <p className="text-[11px] text-destructive">
                  لا توجد متغيرات فعّالة لهذه المادة — راجع إعدادات الصنف.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {line.options.map((opt) => {
                    const isPicked = selectedOpt?.variantId === opt.variantId;
                    const isShort = Number(opt.availableBase) < neededBase;
                    return (
                      <button
                        key={opt.variantId}
                        type="button"
                        onClick={() => onChange(upsertRecipeLineSelection(selections, line, opt))}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                          isPicked
                            ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                            : "border-border bg-background hover:bg-muted/60 text-foreground",
                        )}
                      >
                        {opt.colorHex ? (
                          <span
                            aria-hidden
                            className="size-3 rounded-full border border-black/20 shrink-0"
                            style={{ backgroundColor: opt.colorHex }}
                          />
                        ) : null}
                        <span>{opt.label}</span>
                        <span
                          className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded tabular-nums",
                            isShort
                              ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                              : "bg-muted text-muted-foreground",
                          )}
                          dir="ltr"
                        >
                          {formatQuantity(opt.availableBase)}
                        </span>
                        {isPicked && <Check aria-hidden className="size-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {hasShortage && (
                <div className="flex items-start gap-1.5 rounded border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-1.5 text-[11px] text-[var(--sem-warn)]">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0 mt-0.5" />
                  <span>
                    {allowShortageIntake
                      ? `المتوفر في الفرع (${formatQuantity(selectedOpt.availableBase)}) أقل من المطلوب (${formatQuantity(neededBase)}) — يُسمح بتسجيل الطلب وسيُفحص المخزون بصرامة عند بدء التنفيذ.`
                      : `المتوفر في الفرع (${formatQuantity(selectedOpt.availableBase)}) أقل من المطلوب (${formatQuantity(neededBase)}).`}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
