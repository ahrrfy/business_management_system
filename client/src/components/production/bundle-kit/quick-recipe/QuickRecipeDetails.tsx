import * as React from "react";
import { Calculator } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatIqd } from "@/lib/money";
import { normalizeDecimalInput } from "@shared/numberNormalize";
import type { QuickRecipeDraft } from "./useQuickRecipeDraft";
export function QuickRecipeIdentityFields({
  draft,
}: {
  draft: QuickRecipeDraft;
}) {
  const { recipeName, setRecipeName, effectiveBaseUnitName } = draft;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="space-y-1">
        <label
          htmlFor="quick-recipe-name"
          className="text-xs font-medium text-foreground"
        >
          اسم الوصفة <span className="text-destructive">*</span>
        </label>
        <Input
          id="quick-recipe-name"
          value={recipeName}
          onChange={(e) => setRecipeName(e.target.value)}
          placeholder="أدخل اسم الوصفة..."
          className="h-8 text-xs"
        />
      </div>
      <div className="space-y-1">
        <label
          htmlFor="quick-recipe-base-unit"
          className="text-xs font-medium text-foreground"
        >
          الوحدة الأساسية للناتج
        </label>
        <Input
          id="quick-recipe-base-unit"
          value={effectiveBaseUnitName}
          disabled
          className="h-8 text-xs bg-muted/50 cursor-not-allowed"
        />
      </div>
    </div>
  );
}
export function QuickRecipeCostFields({ draft }: { draft: QuickRecipeDraft }) {
  const {
    effectiveBaseUnitName,
    laborPerOutputBase,
    setLaborPerOutputBase,
    wasteStdPct,
    setWasteStdPct,
    notes,
    setNotes,
    costs,
  } = draft;
  return (
    <>
      {" "}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <div className="space-y-1">
          <label
            htmlFor="quick-recipe-labor"
            className="text-xs font-medium text-foreground"
          >
            أجور العمالة لكل 1 {effectiveBaseUnitName} (د.ع)
          </label>
          <Input
            id="quick-recipe-labor"
            type="text"
            inputMode="decimal"
            dir="ltr"
            lang="en-US"
            value={laborPerOutputBase}
            onChange={(e) =>
              setLaborPerOutputBase(normalizeDecimalInput(e.target.value))
            }
            placeholder="0"
            className="h-8 text-xs font-mono tabular-nums"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="quick-recipe-waste"
            className="text-xs font-medium text-foreground"
          >
            نسبة الهدر المعياري المتوقع (%)
          </label>
          <Input
            id="quick-recipe-waste"
            type="text"
            inputMode="decimal"
            dir="ltr"
            lang="en-US"
            value={wasteStdPct}
            onChange={(e) =>
              setWasteStdPct(normalizeDecimalInput(e.target.value))
            }
            placeholder="0"
            className="h-8 text-xs font-mono tabular-nums"
          />
        </div>
      </div>
      {/* ملاحظات */}
      <div className="space-y-1">
        <label
          htmlFor="quick-recipe-notes"
          className="text-xs font-medium text-foreground"
        >
          ملاحظات الوصفة (اختياري)
        </label>
        <Textarea
          id="quick-recipe-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="أي ملاحظات حول التحضير أو المعايير..."
          className="text-xs min-h-[50px] resize-none"
        />
      </div>
      {/* شريط ملخص التكلفة المعيارية الحية */}
      <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 font-bold text-foreground">
            <Calculator aria-hidden="true" className="size-4 text-primary" />
            <span>
              حساب التكلفة المعيارية الحية لكل 1 {effectiveBaseUnitName}:
            </span>
          </div>
          {costs.batchMultiple > 1 && (
            <Badge
              variant="outline"
              className="border-[var(--sem-warn)] text-[var(--sem-warn)] text-[10px] whitespace-nowrap shrink-0"
            >
              مضاعف الدفعة: {costs.batchMultiple} وحدات
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded bg-background p-2 border">
            <div className="text-[10px] text-muted-foreground">
              كلفة المواد الخام
            </div>
            <div className="font-mono font-bold text-foreground mt-0.5">
              {formatIqd(costs.materialsTotal.toString())}
            </div>
          </div>
          <div className="rounded bg-background p-2 border">
            <div className="text-[10px] text-muted-foreground">
              أجور العمالة
            </div>
            <div className="font-mono font-bold text-foreground mt-0.5">
              {formatIqd(costs.labor.toString())}
            </div>
          </div>
          <div className="rounded bg-background p-2 border border-primary/30">
            <div className="text-[10px] text-primary font-medium">
              التكلفة المعيارية شاملة الهدر
            </div>
            <div className="font-mono font-bold text-primary mt-0.5">
              {formatIqd(costs.unitCostWithWaste.toString())}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
