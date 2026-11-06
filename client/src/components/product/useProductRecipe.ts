import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { operationDecision } from "@shared/operationPermissions";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { useSessionContext } from "@/hooks/useSessionContext";
import {
  buildRecipeChange, recipeDraftBlockers, recipeDraftSignature,
  useProductRecipeDraftRegistration, type ProductRecipeChange, type RecipeDraftFields,
  type RecipeDraftIdentity,
} from "./productRecipeDraft";
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

  const data = recipeQ.data;
  const [isEditing, setEditing] = useState(false);
  const editSource = useRef<{
    data: NonNullable<typeof data>; identity: RecipeDraftIdentity; baseline: string;
  } | null>(null);
  function setIsEditing(next: boolean) {
    if (next && !isEditing && data && !recipeQ.isError) {
      const recipe = data.recipe;
      editSource.current = {
        data,
        identity: {
          recipeId: recipe?.id ?? null,
          outputVariantId: recipe?.outputVariantId ?? data.primaryVariantId ?? 0,
          outputProductUnitId: recipe?.outputProductUnitId ?? data.primaryProductUnitId ?? 0,
          expectedFingerprint: (data as typeof data & { recipeFingerprint?: string }).recipeFingerprint ?? "",
        },
        baseline: recipeDraftSignature({
          formName: recipe?.name ?? `وصفة ${data.product.name || "المنتج"}`,
          formLabor: recipe?.laborPerOutputBase ?? "0", formWaste: recipe?.wasteStdPct ?? "0",
          formNotes: recipe?.notes ?? "", formLines: recipe?.lines ?? [],
        }),
      };
    }
    setEditing(next);
  }
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
    setEditing(false);
    editSource.current = null;
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
    onSuccess: () => {
      notify.ok("تم إنشاء وصفة المواد بنجاح");
    },
    onError: (err) => notify.err(err.message || "تعذّر حفظ الوصفة"),
  });

  const updateMut = trpc.production.recipes.update.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث وصفة المواد بنجاح");
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

  const currentRecipe = useMemo(() => {
    const source = isEditing ? editSource.current?.data : data;
    if (!source) return null;
    if (selectedRecipeId != null) {
      if (source.recipe && source.recipe.id === selectedRecipeId) {
        return source.recipe;
      }
    }
    return source.recipe;
  }, [data, selectedRecipeId, isEditing]);

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
      isWritePending
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

  const fields: RecipeDraftFields = { formName, formLabor, formWaste, formNotes, formLines };
  const latestFields = useRef(fields);
  latestFields.current = fields;
  const recipeIsDirty = isEditing && editSource.current != null
    && recipeDraftSignature(fields) !== editSource.current.baseline;
  const recipeBlockedBy = isEditing ? recipeDraftBlockers(fields, editSource.current?.identity ?? null,
    can(editSource.current?.identity.recipeId != null ? "production.recipes.update" : "production.recipes.create")) : [];
  function prepareRecipeChange(force = false): ProductRecipeChange | undefined {
    if (!isEditing || (!force && !recipeIsDirty)) return undefined;
    if (recipeBlockedBy.length) throw new Error(recipeBlockedBy[0]);
    return buildRecipeChange(fields, editSource.current!.identity);
  }
  async function acceptRecipeSave(change: ProductRecipeChange, result: unknown) {
    const saved = result as { recipeId?: number; recipeFingerprint?: string } | null;
    if (!saved?.recipeId || !saved.recipeFingerprint)
      throw new Error("تعذّر تأكيد حفظ الوصفة؛ حدّث الصفحة وراجع الوصفة المحفوظة");
    if (editSource.current) {
      editSource.current.identity = { ...editSource.current.identity,
        recipeId: saved.recipeId, expectedFingerprint: saved.recipeFingerprint };
      const submittedFields: RecipeDraftFields = {
        formName: change.name, formLabor: change.laborPerOutputBase ?? "0",
        formWaste: change.wasteStdPct ?? "0", formNotes: change.notes ?? "",
        formLines: change.lines.map((line) => ({ ...line, inputProductName: "", inputSku: "", inputCostPrice: "0" })),
      };
      editSource.current.baseline = recipeDraftSignature(submittedFields);
      if (recipeDraftSignature(latestFields.current) === editSource.current.baseline) setEditing(false);
    }
    await invalidateRecipeCaches();
  }
  const localPending = createMut.isPending || updateMut.isPending || setActiveMut.isPending || deleteMut.isPending;
  const parentPending = useProductRecipeDraftRegistration({
    isDirty: recipeIsDirty, isPending: localPending, blockedBy: recipeIsDirty ? recipeBlockedBy : [],
    prepare: () => {
      if (localPending) throw new Error("انتظر اكتمال العملية الحالية على الوصفة");
      const change = prepareRecipeChange();
      return change ? { change, complete: (result) => acceptRecipeSave(change, result) } : undefined;
    },
  }, productId);
  const isWritePending = parentPending || localPending;

  return {
    can,
    recipeIsDirty,
    recipeBlockedBy,
    prepareRecipeChange,
    acceptRecipeSave,
    isWritePending,
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
