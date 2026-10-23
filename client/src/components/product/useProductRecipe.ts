import { useCallback, useEffect, useMemo, useState } from "react";
import { operationDecision } from "@shared/operationPermissions";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { useSessionContext } from "@/hooks/useSessionContext";
import {
  getStoredRecipeClipboard,
  getRecipeClipboardKey,
  RECIPE_CLIPBOARD_BASE_KEY,
  RECIPE_CLIPBOARD_LEGACY_KEY,
  RECIPE_CLIPBOARD_EVENT,
  type CopiedRecipePayload,
  type EditableLine,
} from "./recipeClipboard";
export interface ProductRecipeSectionProps {
  productId: number;
  isService?: boolean;
  branchId?: number | null;
  sellingPrice?: string | null;
  wholesalePrice?: string | null;
}

export function useProductRecipe({
  productId,
  branchId: propBranchId,
}: ProductRecipeSectionProps) {
  const utils = trpc.useUtils();
  const { context } = useSessionContext();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  const can = useCallback(
    (path: string) =>
      me.data ? operationDecision(me.data, path).allowed : false,
    [me.data],
  );
  const currentCompanyId =
    me.data?.companyId != null &&
    Number.isFinite(me.data.companyId) &&
    me.data.companyId > 0
      ? me.data.companyId
      : null;

  const currentBranchId =
    propBranchId !== undefined
      ? propBranchId != null
        ? Number(propBranchId)
        : undefined
      : context?.branch?.id
        ? Number(context.branch.id)
        : undefined;

  // استعلام قراءة وصفة المنتج مع تفاصيل الصنف وأسعار البيع
  const recipeQ = trpc.production.recipes.forProduct.useQuery(
    { productId },
    {
      enabled:
        can("production.recipes.forProduct") &&
        Number.isFinite(productId) &&
        productId > 0,
    },
  );

  const [isEditing, setIsEditing] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [priceTierMode, setPriceTierMode] = useState<"RETAIL" | "WHOLESALE">(
    "RETAIL",
  );

  // حالة الحافظة المشتركة عبر التخزين المحلي والذاكرة
  const [clipboardData, setClipboardData] =
    useState<CopiedRecipePayload | null>(() =>
      getStoredRecipeClipboard(currentCompanyId),
    );

  useEffect(() => {
    setClipboardData(getStoredRecipeClipboard(currentCompanyId));
  }, [currentCompanyId]);

  useEffect(() => {
    const scopedKey = getRecipeClipboardKey(currentCompanyId);
    const handleStorage = (e: StorageEvent) => {
      if (
        e.key === scopedKey ||
        e.key === RECIPE_CLIPBOARD_BASE_KEY ||
        e.key === RECIPE_CLIPBOARD_LEGACY_KEY ||
        e.key === null
      ) {
        setClipboardData(getStoredRecipeClipboard(currentCompanyId));
      }
    };
    const handleCustom = (e: Event) => {
      const detail = (e as CustomEvent<CopiedRecipePayload>).detail;
      if (detail && detail.companyId !== currentCompanyId) {
        setClipboardData(null);
      } else {
        setClipboardData(getStoredRecipeClipboard(currentCompanyId));
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECIPE_CLIPBOARD_EVENT, handleCustom);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECIPE_CLIPBOARD_EVENT, handleCustom);
    };
  }, [currentCompanyId]);

  // إعادة ضبط حالة التحرير ونموذج الإدخال عند التبديل لمنتج آخر
  useEffect(() => {
    setIsEditing(false);
    setSelectedRecipeId(null);
    setSearchQuery("");
    setShowSearchDropdown(false);
    setFormLines([]);
    setFormName("");
    setFormLabor("0");
    setFormWaste("0");
    setFormNotes("");
    setClipboardData(getStoredRecipeClipboard(currentCompanyId));
  }, [productId, currentCompanyId]);

  // حقول نموذج التعديل/الإنشاء
  const [formName, setFormName] = useState("");
  const [formLabor, setFormLabor] = useState("0");
  const [formWaste, setFormWaste] = useState("0");
  const [formNotes, setFormNotes] = useState("");
  const [formLines, setFormLines] = useState<EditableLine[]>([]);

  // بحث إضافة مادة خام
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);

  const materialsQ = trpc.catalog.materialsForRecipe.useQuery(
    { query: searchQuery.trim(), limit: 15 },
    {
      enabled:
        can("catalog.materialsForRecipe") &&
        isEditing &&
        searchQuery.trim().length >= 1,
      staleTime: 30_000,
    },
  );

  // دالة موحدة لإبطال كاش الوصفات والمقترحات عبر التبويبات
  const invalidateRecipeCaches = async () => {
    await Promise.all([
      utils.production.recipes.forProduct.invalidate({ productId }),
      utils.production.recipes.suggestSimilar.invalidate(),
      utils.production.recipes.listForImport.invalidate(),
    ]);
  };

  // طفرات إدارة الوصفة
  const createMut = trpc.production.recipes.create.useMutation({
    onSuccess: async () => {
      notify.ok("تم إنشاء وصفة المواد بنجاح");
      setIsEditing(false);
      await invalidateRecipeCaches();
    },
    onError: (err) => notify.err(err.message || "تعذّر حفظ الوصفة"),
  });

  const updateMut = trpc.production.recipes.update.useMutation({
    onSuccess: async () => {
      notify.ok("تم تحديث وصفة المواد بنجاح");
      setIsEditing(false);
      await invalidateRecipeCaches();
    },
    onError: (err) => notify.err(err.message || "تعذّر تحديث الوصفة"),
  });

  const setActiveMut = trpc.production.recipes.setActive.useMutation({
    onSuccess: async () => {
      notify.ok("تم تغيير حالة تفعيل الوصفة");
      await invalidateRecipeCaches();
    },
    onError: (err) => notify.err(err.message || "تعذّر تغيير حالة الوصفة"),
  });

  const deleteMut = trpc.production.recipes.remove.useMutation({
    onSuccess: async () => {
      notify.ok("تم حذف الوصفة بنجاح");
      setIsEditing(false);
      await invalidateRecipeCaches();
    },
    onError: (err) => notify.err(err.message || "تعذّر حذف الوصفة"),
  });

  const data = recipeQ.data;
  const currentRecipe = useMemo(() => {
    if (!data) return null;
    if (selectedRecipeId != null) {
      if (data.recipe && data.recipe.id === selectedRecipeId) {
        return data.recipe;
      }
    }
    return data.recipe;
  }, [data, selectedRecipeId]);

  // بنود الوصفة النشطة لفحص المخزون الفوري
  const activeLinesForCheck = useMemo(() => {
    const lines = isEditing ? formLines : currentRecipe?.lines || [];
    return lines.map((l) => ({
      inputVariantId: l.inputVariantId,
      qtyPerOutputBase: l.qtyPerOutputBase || "0",
    }));
  }, [isEditing, formLines, currentRecipe]);

  // فحص توفر المواد والطاقة الإنتاجية الفورية
  const stockCheckQ = trpc.production.recipes.checkStockAvailability.useQuery(
    {
      branchId: currentBranchId ?? undefined,
      lines: activeLinesForCheck,
    },
    {
      enabled:
        can("production.recipes.checkStockAvailability") &&
        Boolean(
          currentBranchId &&
          Number.isFinite(currentBranchId) &&
          currentBranchId > 0,
        ) &&
        Boolean(activeLinesForCheck.length > 0),
      staleTime: 15_000,
    },
  );

  const stockData = can("production.recipes.checkStockAvailability")
    ? stockCheckQ.data
    : undefined;

  // تهيئة نموذج التعديل من الوصفة الحالية
  function startEditing() {
    if (
      !can(
        currentRecipe
          ? "production.recipes.update"
          : "production.recipes.create",
      ) ||
      createMut.isPending ||
      updateMut.isPending
    )
      return;
    if (currentRecipe) {
      setFormName(currentRecipe.name);
      setFormLabor(currentRecipe.laborPerOutputBase || "0");
      setFormWaste(currentRecipe.wasteStdPct || "0");
      setFormNotes(currentRecipe.notes || "");
      setFormLines(
        currentRecipe.lines.map((l) => ({
          id: l.id,
          inputVariantId: l.inputVariantId,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          notes: l.notes,
          unitName: l.units?.find((u) => u.isBaseUnit)?.unitName || "وحدة",
        })),
      );
    } else {
      const defaultName = `وصفة ${data?.product.name || "المنتج"}`;
      setFormName(defaultName);
      setFormLabor("0");
      setFormWaste("0");
      setFormNotes("");
      setFormLines([]);
    }
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setSearchQuery("");
    setShowSearchDropdown(false);
    if (currentRecipe) {
      setFormName(currentRecipe.name);
      setFormLabor(currentRecipe.laborPerOutputBase || "0");
      setFormWaste(currentRecipe.wasteStdPct || "0");
      setFormNotes(currentRecipe.notes || "");
      setFormLines(
        currentRecipe.lines.map((l) => ({
          id: l.id,
          inputVariantId: l.inputVariantId,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          notes: l.notes,
          unitName: l.units?.find((u) => u.isBaseUnit)?.unitName || "وحدة",
        })),
      );
    } else {
      setFormName("");
      setFormLabor("0");
      setFormWaste("0");
      setFormNotes("");
      setFormLines([]);
    }
  }

  function handleAddMaterial(mat: {
    variantId: number;
    productName: string;
    variantName: string | null;
    sku: string;
    unitName: string;
    costPrice: string;
  }) {
    const targetOutputVariantId =
      currentRecipe?.outputVariantId ?? data?.primaryVariantId;
    if (targetOutputVariantId && mat.variantId === targetOutputVariantId) {
      notify.warn("لا يمكن إضافة المنتج الحالي كمادة خام لنفسه");
      return;
    }
    if (formLines.some((l) => l.inputVariantId === mat.variantId)) {
      notify.warn("هذه المادة مضافة بالفعل في الوصفة");
      return;
    }
    const displayName = mat.variantName
      ? `${mat.productName} (${mat.variantName})`
      : mat.productName;
    setFormLines((prev) => [
      ...prev,
      {
        inputVariantId: mat.variantId,
        inputProductName: displayName,
        inputSku: mat.sku,
        inputCostPrice: mat.costPrice,
        qtyPerOutputBase: "1",
        unitName: mat.unitName,
        notes: null,
      },
    ]);
    setSearchQuery("");
    setShowSearchDropdown(false);
  }

  function handleRemoveLine(index: number) {
    setFormLines((prev) => prev.filter((_, i) => i !== index));
  }

  function handleLineQtyChange(index: number, val: string) {
    setFormLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, qtyPerOutputBase: val } : l)),
    );
  }

  return {
    can,
    recipeQ,
    data,
    currentRecipe,
    currentCompanyId,
    currentBranchId,
    isEditing,
    setIsEditing,
    isImportDialogOpen,
    setIsImportDialogOpen,
    priceTierMode,
    setPriceTierMode,
    clipboardData,
    setClipboardData,
    formName,
    setFormName,
    formLabor,
    setFormLabor,
    formWaste,
    setFormWaste,
    formNotes,
    setFormNotes,
    formLines,
    setFormLines,
    searchQuery,
    setSearchQuery,
    showSearchDropdown,
    setShowSearchDropdown,
    materialsQ,
    createMut,
    updateMut,
    setActiveMut,
    deleteMut,
    activeLinesForCheck,
    stockCheckQ,
    stockData,
    startEditing,
    cancelEditing,
    handleAddMaterial,
    handleRemoveLine,
    handleLineQtyChange,
  };
}
export type RecipeController = ReturnType<typeof useProductRecipe>;
