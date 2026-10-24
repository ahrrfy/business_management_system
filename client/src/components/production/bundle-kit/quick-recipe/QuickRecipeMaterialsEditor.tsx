import * as React from "react";
import { Layers, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { formatIqd, moneyInput, round2 } from "@/lib/money";
import { normalizeDecimalInput } from "@shared/numberNormalize";
import type { QuickRecipeDraft } from "./useQuickRecipeDraft";
export function QuickRecipeMaterialsEditor({
  draft,
}: {
  draft: QuickRecipeDraft;
}) {
  const {
    lines,
    effectiveBaseUnitName,
    handleLineQtyChange,
    handleRemoveLine,
    searchContainerRef,
    isSearching,
    trimmedSearchMaterial,
    materialsQ,
    handleAddMaterial,
    searchMaterial,
    setSearchMaterial,
    setShowSearchDropdown,
    showSearchDropdown,
  } = draft;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers aria-hidden="true" className="size-4 text-primary" />
          <span className="text-xs font-bold text-foreground">
            المواد الخام الداخلة في التركيبة ({lines.length})
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          الكميات لكل 1 {effectiveBaseUnitName}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[560px] border-collapse text-xs text-start">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="p-2 text-start font-medium whitespace-nowrap select-none">
                المادة الخام
              </th>
              <th className="p-2 text-center font-medium whitespace-nowrap select-none w-28">
                كلفة الوحدة
              </th>
              <th className="p-2 text-center font-medium whitespace-nowrap select-none w-28">
                الكمية لكل ناتج
              </th>
              <th className="p-2 text-center font-medium whitespace-nowrap select-none w-28">
                إجمالي السطر
              </th>
              <th className="p-2 text-center whitespace-nowrap select-none w-10">
                إجراء
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="py-6 text-center text-muted-foreground text-xs"
                >
                  لم يتم إضافة أي مواد خام بعد. اختر قالباً من الأعلى أو ابحث عن
                  مادة لإضافتها.
                </td>
              </tr>
            ) : (
              lines.map((line, idx) => {
                const qty = moneyInput(line.qtyPerOutputBase);
                const unitCost = moneyInput(line.inputCostPrice);
                const lineTotal = round2(qty.mul(unitCost));

                return (
                  <tr
                    key={`${line.inputVariantId}-${idx}`}
                    className="hover:bg-muted/20"
                  >
                    <td className="p-2">
                      <div className="font-semibold text-foreground">
                        {line.inputProductName}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                        <span className="font-mono tabular-nums" dir="ltr">
                          {line.inputSku}
                        </span>
                        {line.unitName && <span>({line.unitName})</span>}
                      </div>
                    </td>
                    <td
                      className="p-2 text-center font-mono text-muted-foreground tabular-nums whitespace-nowrap"
                      dir="ltr"
                    >
                      {formatIqd(line.inputCostPrice)}
                    </td>
                    <td className="p-2 text-center">
                      <Input
                        type="text"
                        inputMode="decimal"
                        dir="ltr"
                        lang="en-US"
                        aria-label={`كمية ${line.inputProductName} لكل وحدة ناتجة`}
                        value={line.qtyPerOutputBase}
                        onChange={(e) => {
                          const val = normalizeDecimalInput(e.target.value);
                          handleLineQtyChange(idx, val);
                        }}
                        className="h-7 text-center font-mono font-bold text-xs tabular-nums"
                      />
                    </td>
                    <td
                      className="p-2 text-center font-mono font-semibold text-foreground tabular-nums whitespace-nowrap"
                      dir="ltr"
                    >
                      {formatIqd(lineTotal.toString())}
                    </td>
                    <td className="p-2 text-center whitespace-nowrap">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`حذف ${line.inputProductName} من الوصفة`}
                        onClick={() => handleRemoveLine(idx)}
                        className="size-7 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive whitespace-nowrap shrink-0"
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* شريط البحث لإضافة مادة خام إضافية */}
      <div ref={searchContainerRef} className="relative">
        <UnifiedSearchInput
          debounceMs={0}
          aria-label="البحث عن مادة خام لإضافتها"
          onSubmit={(submitted) => {
            if (isSearching || submitted.trim() !== trimmedSearchMaterial)
              return;
            const first = (materialsQ.data ?? [])[0];
            if (first) handleAddMaterial(first);
          }}
          value={searchMaterial}
          onChange={(val) => {
            setSearchMaterial(val);
            setShowSearchDropdown(true);
          }}
          onFocus={() => setShowSearchDropdown(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setShowSearchDropdown(false);
            }
          }}
          placeholder="ابحث عن مادة خام لإضافتها إلى الوصفة (بالاسم أو الباركود)..."
          className="h-8 text-xs"
        />

        {/* القائمة المنسدلة للبحث */}
        {showSearchDropdown && searchMaterial.trim().length >= 1 && (
          <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-lg max-h-48 overflow-y-auto">
            {isSearching ? (
              <div className="p-3 text-center text-xs text-muted-foreground">
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin inline me-1.5"
                />
                جارٍ البحث عن المواد الخام...
              </div>
            ) : materialsQ.isError ? (
              <div className="p-3 text-center text-xs text-destructive">
                {materialsQ.error?.message ||
                  "تعذر تحميل المواد الخام، يرجى التحقق من الصلاحيات والمحاولة لاحقاً"}
              </div>
            ) : (materialsQ.data ?? []).length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">
                لم يتم العثور على مواد خام مطابقة
              </div>
            ) : (
              <div className="p-1 divide-y">
                {(materialsQ.data ?? []).map((mat) => (
                  <button
                    key={mat.variantId}
                    type="button"
                    onClick={() => handleAddMaterial(mat)}
                    className="w-full text-start p-2 hover:bg-accent rounded text-xs flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-medium text-foreground">
                        {mat.productName}
                        {mat.variantName && ` (${mat.variantName})`}
                      </div>
                      <div
                        className="text-[10px] text-muted-foreground font-mono"
                        dir="ltr"
                      >
                        {mat.sku} • {mat.unitName}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatIqd(mat.costPrice)}
                      </span>
                      <Plus
                        aria-hidden="true"
                        className="size-3.5 text-primary shrink-0"
                      />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
