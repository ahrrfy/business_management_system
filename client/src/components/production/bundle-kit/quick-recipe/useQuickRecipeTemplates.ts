import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { moneyInput, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { EditableRecipeLine } from "./recipeDraftModel";
import type { QuickRecipeDraft } from "./useQuickRecipeDraft";

interface TemplateRecipeLine {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName?: string | null;
  inputSku?: string | null;
  inputCostPrice?: string | null;
  qtyPerOutputBase?: string | null;
  notes?: string | null;
  units?: { productUnitId: number; unitName: string; isBaseUnit: boolean }[];
}

export function useQuickRecipeTemplates({
  open,
  targetComponent,
  otherBundleComponents,
  draft,
}: {
  open: boolean;
  targetComponent: ComponentRequirementDto | null;
  otherBundleComponents: ComponentRequirementDto[];
  draft: QuickRecipeDraft;
}) {
  const utils = trpc.useUtils();
  const [isLoadingRecipe, setIsLoadingRecipe] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<{
    recipeId: number;
    sourceName: string;
  } | null>(null);
  const activeRequestIdRef = useRef(0);
  const allRecipesQ = trpc.production.recipes.list.useQuery(
    { activeOnly: true },
    { enabled: open, staleTime: 30_000 },
  );
  const bundleManufacturedSuggestions = useMemo(
    () =>
      otherBundleComponents.filter(
        (component) =>
          component.isManufactured &&
          component.recipeId != null &&
          component.variantId !== targetComponent?.variantId,
      ),
    [otherBundleComponents, targetComponent?.variantId],
  );

  useLayoutEffect(() => {
    activeRequestIdRef.current++;
    setPendingTemplate(null);
    setIsLoadingRecipe(false);
  }, [draft.scopeVersion]);

  async function applySourceRecipe(recipeId: number, sourceLabel?: string) {
    const requestId = ++activeRequestIdRef.current;
    const session = draft.sessionRef.current;
    const isCurrent = () =>
      activeRequestIdRef.current === requestId &&
      draft.sessionRef.current === session;
    setIsLoadingRecipe(true);
    try {
      const recipeData = await utils.production.recipes.get.fetch({
        id: recipeId,
      });
      if (!isCurrent()) return;
      if (!recipeData) {
        notify.err("تعذّر جلب تفاصيل الوصفة المختارة");
        return;
      }
      const sourceName = sourceLabel || recipeData.name || `وصفة #${recipeId}`;
      draft.setCopiedSourceName(sourceName);
      draft.setLaborPerOutputBase(String(recipeData.laborPerOutputBase ?? "0"));
      const rawWaste = moneyInput(recipeData.wasteStdPct ?? "0");
      const wastePercent =
        rawWaste.gt(0) && rawWaste.lt(1)
          ? round2(rawWaste.mul(100)).toString()
          : rawWaste.gte(1)
            ? round2(rawWaste).toString()
            : "0";
      draft.setWasteStdPct(wastePercent);
      const sourceNotes = (recipeData.notes || "").trim();
      const provenance = `منسوخة من: ${sourceName}`;
      draft.setNotes(
        sourceNotes ? `${sourceNotes}\n(${provenance})` : provenance,
      );
      const rawLines: TemplateRecipeLine[] = recipeData.lines ?? [];
      const nonSelfLines = rawLines.filter(
        (line) => Number(line.inputVariantId) !== targetComponent?.variantId,
      );
      if (nonSelfLines.length < rawLines.length) {
        notify.warn(
          "تم استبعاد الصنف الهدف تلقائياً من المواد الأولية لتجنب استهلاك الصنف من نفسه",
        );
      }
      const importedLines: EditableRecipeLine[] = nonSelfLines.map((line) => {
        // Quantities and cost are expressed in base units; retain the saved unit ID.
        const baseUnit = line.units?.find((unit) => unit.isBaseUnit);
        return {
          inputVariantId: Number(line.inputVariantId),
          inputProductUnitId: line.inputProductUnitId
            ? Number(line.inputProductUnitId)
            : null,
          inputProductName: line.inputProductName || `#${line.inputVariantId}`,
          inputSku: line.inputSku || "",
          inputCostPrice: String(line.inputCostPrice || "0"),
          qtyPerOutputBase: String(line.qtyPerOutputBase || "1"),
          unitName: baseUnit?.unitName || "وحدة أساسية",
          notes: line.notes || null,
        };
      });
      draft.setLines(importedLines);
      if (importedLines.length === 0 && rawLines.length > 0) {
        notify.warn(
          "تم استبعاد كافة بنود الوصفة المختارة لأنها تطابق الصنف الهدف لتجنب التكرار الذاتي",
        );
      } else {
        notify.ok(
          `تم نسخ ${importedLines.length} مواد من «${sourceName}» بنجاح`,
        );
      }
    } catch (error) {
      if (isCurrent())
        notify.err(error instanceof Error ? error.message : "فشل نسخ الوصفة");
    } finally {
      if (isCurrent()) setIsLoadingRecipe(false);
    }
  }
  function handleSelectTemplate(recipeId: number, sourceName: string) {
    if (draft.lines.length > 0) setPendingTemplate({ recipeId, sourceName });
    else void applySourceRecipe(recipeId, sourceName);
  }
  function handleConfirmReplaceTemplate() {
    if (!pendingTemplate) return;
    void applySourceRecipe(
      pendingTemplate.recipeId,
      pendingTemplate.sourceName,
    );
    setPendingTemplate(null);
  }
  function handleCancelReplaceTemplate() {
    setPendingTemplate(null);
    draft.setSelectedCatalogRecipeId("");
  }
  return {
    allRecipesQ,
    bundleManufacturedSuggestions,
    isLoadingRecipe,
    pendingTemplate,
    handleSelectTemplate,
    handleConfirmReplaceTemplate,
    handleCancelReplaceTemplate,
    selectedCatalogRecipeId: draft.selectedCatalogRecipeId,
    setSelectedCatalogRecipeId: draft.setSelectedCatalogRecipeId,
    copiedSourceName: draft.copiedSourceName,
  };
}
export type QuickRecipeTemplates = ReturnType<typeof useQuickRecipeTemplates>;
