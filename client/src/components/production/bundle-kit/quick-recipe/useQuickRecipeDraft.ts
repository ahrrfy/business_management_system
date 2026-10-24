import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import {
  calculateRecipeDraftCosts,
  type EditableRecipeLine,
} from "./recipeDraftModel";

export function useQuickRecipeDraft({
  open,
  targetComponent,
}: {
  open: boolean;
  targetComponent: ComponentRequirementDto | null;
}) {
  const [recipeName, setRecipeName] = useState("");
  const [laborPerOutputBase, setLaborPerOutputBase] = useState("0");
  const [wasteStdPct, setWasteStdPct] = useState("0");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditableRecipeLine[]>([]);
  const [copiedSourceName, setCopiedSourceName] = useState<string | null>(null);
  const [searchMaterial, setSearchMaterial] = useState("");
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [selectedCatalogRecipeId, setSelectedCatalogRecipeId] = useState("");
  const [scopeVersion, setScopeVersion] = useState(0);
  const sessionRef = useRef(0);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const debouncedSearchMaterial = useDebouncedValue(searchMaterial, 200);
  const trimmedSearchMaterial = debouncedSearchMaterial.trim();
  const isDebouncing = searchMaterial.trim() !== trimmedSearchMaterial;

  const fallbackProductQ = trpc.production.recipes.forProduct.useQuery(
    { productId: targetComponent?.productId ?? 0 },
    {
      enabled:
        open &&
        Boolean(targetComponent?.productId) &&
        !targetComponent?.baseUnitId,
      staleTime: 60_000,
    },
  );
  const materialsQ = trpc.production.recipes.materials.useQuery(
    { query: trimmedSearchMaterial, limit: 12 },
    { enabled: open && trimmedSearchMaterial.length >= 1, staleTime: 20_000 },
  );
  const isSearching =
    isDebouncing || materialsQ.isLoading || materialsQ.isFetching;
  const effectiveBaseUnitId =
    targetComponent?.baseUnitId ??
    fallbackProductQ.data?.primaryProductUnitId ??
    null;
  const effectiveBaseUnitName =
    targetComponent?.baseUnitName ??
    fallbackProductQ.data?.baseUnitName ??
    "وحدة أساسية";

  function clearRecipe() {
    setRecipeName(targetComponent ? `وصفة ${targetComponent.productName}` : "");
    setLaborPerOutputBase("0");
    setWasteStdPct("0");
    setNotes("");
    setLines([]);
    setCopiedSourceName(null);
    setSelectedCatalogRecipeId("");
  }

  function handleResetToEmpty() {
    // A reset starts a new draft even when the output variant stays the same.
    sessionRef.current++;
    setScopeVersion((version) => version + 1);
    clearRecipe();
  }

  const targetVariantId = targetComponent?.variantId;
  useLayoutEffect(() => {
    sessionRef.current++;
    setScopeVersion((version) => version + 1);
    if (open && targetComponent) {
      clearRecipe();
      setSearchMaterial("");
      setShowSearchDropdown(false);
    }
    return () => {
      sessionRef.current++;
    };
    // Target identity, rather than DTO object identity, defines the draft session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetVariantId]);

  useEffect(() => {
    if (!showSearchDropdown) return;
    function handlePointerDownOutside(event: MouseEvent) {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target as Node)
      ) {
        setShowSearchDropdown(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDownOutside);
    return () =>
      document.removeEventListener("mousedown", handlePointerDownOutside);
  }, [showSearchDropdown]);

  function handleAddMaterial(material: {
    variantId: number;
    productName: string;
    variantName: string | null;
    sku: string;
    unitName: string;
    costPrice: string;
  }) {
    if (targetComponent && material.variantId === targetComponent.variantId) {
      notify.warn("لا يمكن إضافة الصنف الناتج كمادة خام لنفسه");
      return;
    }
    if (lines.some((line) => line.inputVariantId === material.variantId)) {
      notify.warn("هذه المادة مضافة بالفعل في الوصفة");
      return;
    }
    const displayName = material.variantName
      ? `${material.productName} (${material.variantName})`
      : material.productName;
    setLines((previous) => [
      ...previous,
      {
        inputVariantId: material.variantId,
        inputProductName: displayName,
        inputSku: material.sku,
        inputCostPrice: material.costPrice || "0",
        qtyPerOutputBase: "1",
        unitName: material.unitName,
        notes: null,
      },
    ]);
    setSearchMaterial("");
    setShowSearchDropdown(false);
  }
  function handleRemoveLine(index: number) {
    setLines((previous) => previous.filter((_, i) => i !== index));
  }
  function handleLineQtyChange(index: number, value: string) {
    setLines((previous) =>
      previous.map((line, i) =>
        i === index ? { ...line, qtyPerOutputBase: value } : line,
      ),
    );
  }
  const costs = useMemo(
    () => calculateRecipeDraftCosts(lines, laborPerOutputBase, wasteStdPct),
    [lines, laborPerOutputBase, wasteStdPct],
  );
  return {
    recipeName,
    setRecipeName,
    laborPerOutputBase,
    setLaborPerOutputBase,
    wasteStdPct,
    setWasteStdPct,
    notes,
    setNotes,
    lines,
    setLines,
    copiedSourceName,
    setCopiedSourceName,
    searchMaterial,
    setSearchMaterial,
    showSearchDropdown,
    setShowSearchDropdown,
    selectedCatalogRecipeId,
    setSelectedCatalogRecipeId,
    sessionRef,
    scopeVersion,
    searchContainerRef,
    trimmedSearchMaterial,
    isSearching,
    materialsQ,
    effectiveBaseUnitId,
    effectiveBaseUnitName,
    handleResetToEmpty,
    handleAddMaterial,
    handleRemoveLine,
    handleLineQtyChange,
    costs,
  };
}

export type QuickRecipeDraft = ReturnType<typeof useQuickRecipeDraft>;
