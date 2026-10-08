import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Copy,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { D, formatIqd, moneyInput, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { requiredBatchMultiple } from "@shared/batchDivisibility";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";

/**
 * تسوية المدخلات العشرية: دعم الأرقام العربية المشرقية والفاصلة العربية العشرية.
 */
export function normalizeDecimalInput(str: string): string {
  const sanitized = str
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[،٫]/g, ".")
    .replace(/[^0-9.]/g, "");

  const firstDotIndex = sanitized.indexOf(".");
  if (firstDotIndex === -1) return sanitized;

  const intPart = sanitized.slice(0, firstDotIndex);
  const decPart = sanitized.slice(firstDotIndex + 1).replace(/\./g, "");
  return `${intPart}.${decPart}`;
}

export interface EditableRecipeLine {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  unitName?: string;
  notes?: string | null;
}

interface QuickRecipeCopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetComponent: ComponentRequirementDto | null;
  otherBundleComponents?: ComponentRequirementDto[];
  onRecipeCreated: (recipeId: number, variantId: number) => void | Promise<void>;
}

export function QuickRecipeCopyDialog({
  open,
  onOpenChange,
  targetComponent,
  otherBundleComponents = [],
  onRecipeCreated,
}: QuickRecipeCopyDialogProps) {
  const utils = trpc.useUtils();

  // نموذج الوصفة
  const [recipeName, setRecipeName] = useState("");
  const [laborPerOutputBase, setLaborPerOutputBase] = useState("0");
  const [wasteStdPct, setWasteStdPct] = useState("0");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditableRecipeLine[]>([]);
  const [copiedSourceName, setCopiedSourceName] = useState<string | null>(null);

  // بحث إضافة مادة خام
  const [searchMaterial, setSearchMaterial] = useState("");
  const debouncedSearchMaterial = useDebouncedValue(searchMaterial, 200);
  const trimmedSearchMaterial = debouncedSearchMaterial.trim();
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [selectedCatalogRecipeId, setSelectedCatalogRecipeId] = useState<string>("");
  const [isLoadingRecipe, setIsLoadingRecipe] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<{
    recipeId: number;
    sourceName: string;
  } | null>(null);
  const searchContainerRef = React.useRef<HTMLDivElement>(null);
  const activeTemplateRequestIdRef = React.useRef<number>(0);

  const isDebouncing = searchMaterial.trim() !== trimmedSearchMaterial;

  useEffect(() => {
    function handlePointerDownOutside(e: MouseEvent) {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target as Node)
      ) {
        setShowSearchDropdown(false);
      }
    }
    if (showSearchDropdown) {
      document.addEventListener("mousedown", handlePointerDownOutside);
      return () => {
        document.removeEventListener("mousedown", handlePointerDownOutside);
      };
    }
  }, [showSearchDropdown]);

  // استعلام fallback للوحدة الأساسية إن لم تكن متوفرة في DTO
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

  // قائمة الوصفات النشطة في النظام للاختيار كقالب عام
  const allRecipesQ = trpc.production.recipes.list.useQuery(
    { activeOnly: true },
    { enabled: open, staleTime: 30_000 },
  );

  // استعلام المواد الخام للإضافة الحية مع تأجيل ذكي 200ms
  const materialsQ = trpc.production.recipes.materials.useQuery(
    { query: trimmedSearchMaterial, limit: 12 },
    { enabled: open && trimmedSearchMaterial.length >= 1, staleTime: 20_000 },
  );

  const isSearching = isDebouncing || materialsQ.isLoading || materialsQ.isFetching;

  const effectiveBaseUnitId =
    targetComponent?.baseUnitId ??
    fallbackProductQ.data?.primaryProductUnitId ??
    null;

  const effectiveBaseUnitName =
    targetComponent?.baseUnitName ??
    fallbackProductQ.data?.baseUnitName ??
    "وحدة أساسية";

  // تهيئة الحالة عند فتح النافذة أو تغيير الصنف الهدف
  useEffect(() => {
    activeTemplateRequestIdRef.current++;
    if (open && targetComponent) {
      setRecipeName(`وصفة ${targetComponent.productName}`);
      setLaborPerOutputBase("0");
      setWasteStdPct("0");
      setNotes("");
      setLines([]);
      setCopiedSourceName(null);
      setSearchMaterial("");
      setShowSearchDropdown(false);
      setSelectedCatalogRecipeId("");
    }
  }, [open, targetComponent]);

  // مكوّنات البكج الحالية التي تمتلك وصفة جاهزة (اقتراحات الأولوية الذكية)
  const bundleManufacturedSuggestions = useMemo(() => {
    return otherBundleComponents.filter(
      (c) =>
        c.isManufactured &&
        c.recipeId != null &&
        c.variantId !== targetComponent?.variantId,
    );
  }, [otherBundleComponents, targetComponent?.variantId]);


  // جلب وتطبيق محتويات وصفة المصدر
  async function applySourceRecipe(recipeId: number, sourceLabel?: string) {
    const currentRequestId = ++activeTemplateRequestIdRef.current;
    const currentTargetVariantId = targetComponent?.variantId;
    try {
      setIsLoadingRecipe(true);
      const recipeData: any = await utils.production.recipes.get.fetch({
        id: recipeId,
      });

      // التحقق الصارم من أن هذا الطلب هو الأحدث ولم يتم تجاوزه بطلب آخر أو إغلاق النافذة أو تبديل الصنف
      if (
        !open ||
        activeTemplateRequestIdRef.current !== currentRequestId ||
        targetComponent?.variantId !== currentTargetVariantId
      ) {
        return;
      }

      if (!recipeData) {
        notify.err("تعذّر جلب تفاصيل الوصفة المختارة");
        return;
      }

      const sourceName =
        sourceLabel || recipeData.name || `وصفة #${recipeId}`;
      setCopiedSourceName(sourceName);
      setLaborPerOutputBase(String(recipeData.laborPerOutputBase ?? "0"));
      const rawWaste = Number(recipeData.wasteStdPct ?? 0);
      const sourceNotes = (recipeData.notes || "").trim();
      const provenanceNote = `منسوخة من: ${sourceName}`;
      const combinedNotes = sourceNotes
        ? `${sourceNotes}\n(${provenanceNote})`
        : provenanceNote;
      setNotes(combinedNotes);

      const rawLines = recipeData.lines ?? [];
      const nonSelfLines = rawLines.filter(
        (l: any) => Number(l.inputVariantId) !== targetComponent?.variantId,
      );
      if (nonSelfLines.length < rawLines.length) {
        notify.warn(
          "تم استبعاد الصنف الهدف تلقائياً من المواد الأولية لتجنب استهلاك الصنف من نفسه",
        );
      }

      const importedLines: EditableRecipeLine[] = nonSelfLines.map(
        (l: any) => {
          const chosenUnit =
            l.units?.find((u: any) => u.productUnitId === l.inputProductUnitId) ??
            l.units?.find((u: any) => u.isBaseUnit) ??
            null;

          return {
            inputVariantId: Number(l.inputVariantId),
            inputProductUnitId: l.inputProductUnitId
              ? Number(l.inputProductUnitId)
              : null,
            inputProductName: l.inputProductName || `#${l.inputVariantId}`,
            inputSku: l.inputSku || "",
            inputCostPrice: String(l.inputCostPrice || "0"),
            qtyPerOutputBase: String(l.qtyPerOutputBase || "1"),
            unitName: chosenUnit?.unitName || "وحدة",
            notes: l.notes || null,
          };
        },
      );

      setLines(importedLines);
      if (importedLines.length === 0 && rawLines.length > 0) {
        notify.warn(
          "تم استبعاد كافة بنود الوصفة المختارة لأنها تطابق الصنف الهدف لتجنب التكرار الذاتي",
        );
      } else {
        notify.ok(
          `تم نسخ ${importedLines.length} مواد من «${sourceName}» بنجاح`,
        );
      }
    } catch (err: any) {
      notify.err(err.message || "فشل نسخ الوصفة");
    } finally {
      setIsLoadingRecipe(false);
    }
  }

  // التحقق والتأكيد قبل استبدال مسودة وصفة تحتوي على مواد ببيانات قالب آخر
  function handleSelectTemplate(recipeId: number, sourceName: string) {
    if (lines.length > 0) {
      setPendingTemplate({ recipeId, sourceName });
    } else {
      applySourceRecipe(recipeId, sourceName);
    }
  }

  function handleConfirmReplaceTemplate() {
    if (pendingTemplate) {
      applySourceRecipe(pendingTemplate.recipeId, pendingTemplate.sourceName);
      setPendingTemplate(null);
    }
  }

  function handleCancelReplaceTemplate() {
    setPendingTemplate(null);
    setSelectedCatalogRecipeId("");
  }

  // إعادة التعيين لوصفة فارغة
  function handleResetToEmpty() {
    setLines([]);
    setLaborPerOutputBase("0");
    setWasteStdPct("0");
    setNotes("");
    setCopiedSourceName(null);
    setSelectedCatalogRecipeId("");
    if (targetComponent) {
      setRecipeName(`وصفة ${targetComponent.productName}`);
    }
  }

  // إضافة مادة خام من البحث
  function handleAddMaterial(mat: {
    variantId: number;
    productName: string;
    variantName: string | null;
    sku: string;
    unitName: string;
    costPrice: string;
  }) {
    if (targetComponent && mat.variantId === targetComponent.variantId) {
      notify.warn("لا يمكن إضافة الصنف الناتج كمادة خام لنفسه");
      return;
    }

    if (lines.some((l) => l.inputVariantId === mat.variantId)) {
      notify.warn("هذه المادة مضافة بالفعل في الوصفة");
      return;
    }

    const displayName = mat.variantName
      ? `${mat.productName} (${mat.variantName})`
      : mat.productName;

    setLines((prev) => [
      ...prev,
      {
        inputVariantId: mat.variantId,
        inputProductName: displayName,
        inputSku: mat.sku,
        inputCostPrice: mat.costPrice || "0",
        qtyPerOutputBase: "1",
        unitName: mat.unitName,
        notes: null,
      },
    ]);

    setSearchMaterial("");
    setShowSearchDropdown(false);
  }

  function handleRemoveLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function handleLineQtyChange(index: number, val: string) {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, qtyPerOutputBase: val } : l)),
    );
  }

  // احتساب التكاليف الحية ومضاعف الدفعة
  const costs = useMemo(() => {
    let materialsTotal = D(0);
    for (const l of lines) {
      const q = moneyInput(l.qtyPerOutputBase);
      const unitCost = moneyInput(l.inputCostPrice);
      if (q.gt(0)) {
        materialsTotal = materialsTotal.plus(q.mul(unitCost));
      }
    }
    materialsTotal = round2(materialsTotal);

    const labor = round2(moneyInput(laborPerOutputBase));
    const wastePercent = moneyInput(wasteStdPct);
    const directTotal = materialsTotal.plus(labor);

    const wasteFraction = wastePercent.div(100);
    const wasteFactor =
      wasteFraction.gt(0) && wasteFraction.lt(1)
        ? D(1).minus(wasteFraction)
        : D(1);

    const unitCostWithWaste = wasteFactor.gt(0)
      ? round2(directTotal.div(wasteFactor))
      : directTotal;

    const coefficients = lines.map((l) => l.qtyPerOutputBase || "1");
    const batchMultiple = requiredBatchMultiple(coefficients);

    return {
      materialsTotal,
      labor,
      unitCostWithWaste,
      batchMultiple,
    };
  }, [lines, laborPerOutputBase, wasteStdPct]);

  // طفرة إنشاء الوصفة
  const createRecipeMut = trpc.production.recipes.create.useMutation({
    onSuccess: async (res) => {
      notify.ok(
        `تم حفظ الوصفة بنجاح وتحويل «${targetComponent?.productName}» إلى صنف مصنّع`,
      );
      if (targetComponent) {
        try {
          await onRecipeCreated(res.recipeId, targetComponent.variantId);
        } catch (err) {
          console.error("Failed to refresh bundle after recipe creation:", err);
        }
      }
      onOpenChange(false);
    },
    onError: (err) => {
      notify.err(err.message || "تعذّر حفظ الوصفة");
    },
  });

  async function handleSave() {
    if (!targetComponent) return;

    const trimmedName = recipeName.trim();
    if (!trimmedName) {
      notify.warn("اسم الوصفة مطلوب");
      return;
    }

    if (!effectiveBaseUnitId) {
      notify.err(
        "تعذّر تحديد الوحدة الأساسية لهذا الصنف، يرجى مراجعة بطاقة المنتج",
      );
      return;
    }

    if (lines.length === 0) {
      notify.warn("يجب إضافة مادة خام واحدة على الأقل في الوصفة");
      return;
    }

    for (const l of lines) {
      const q = moneyInput(l.qtyPerOutputBase);
      if (q.lte(0)) {
        notify.warn(
          `كمية المادة «${l.inputProductName}» يجب أن تكون رقماً موجباً أكبر من صفر`,
        );
        return;
      }

      if (q.decimalPlaces() > 4) {
        notify.warn(
          `كمية المادة «${l.inputProductName}» لا يمكن أن تتجاوز 4 مراتب عشرية`,
        );
        return;
      }
    }

    const cleanWaste = wasteStdPct.trim();
    if (cleanWaste && (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleanWaste) || cleanWaste.split(".").length > 2)) {
      notify.warn("نسبة الهدر غير صالحة، يرجى إدخال رقم عشري صحيح");
      return;
    }

    const cleanLabor = laborPerOutputBase.trim();
    if (cleanLabor && (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleanLabor) || cleanLabor.split(".").length > 2)) {
      notify.warn("تكلفة العمالة غير صالحة، يرجى إدخال رقم عشري صحيح");
      return;
    }

    const wasteDec = moneyInput(wasteStdPct).div(100);
    if (wasteDec.lt(0) || wasteDec.gte(1)) {
      notify.warn("نسبة الهدر يجب أن تكون بين 0% وأقل من 100%");
      return;
    }

    try {
      await createRecipeMut.mutateAsync({
        name: trimmedName,
        outputVariantId: targetComponent.variantId,
        outputProductUnitId: effectiveBaseUnitId,
        laborPerOutputBase: laborPerOutputBase.trim() || "0",
        wasteStdPct: wasteDec.toString(),
        notes: notes.trim() || null,
        isActive: true,
        lines: lines.map((l) => ({
          inputVariantId: l.inputVariantId,
          inputProductUnitId: l.inputProductUnitId ?? null,
          qtyPerOutputBase: moneyInput(l.qtyPerOutputBase).toString(),
          notes: l.notes ?? null,
        })),
      });
    } catch {
      // Rejection is already surfaced to user via createRecipeMut.onError
    }
  }

  if (!targetComponent) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl max-w-full max-h-[92vh] flex flex-col p-0 overflow-hidden"
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
                  تحديد تركيبة المواد الأولية لتمكين تصنيع «{targetComponent.productName}» محلياً ضمن هذا البكج
                </DialogDescription>
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline" className="text-[11px] font-mono" dir="ltr">
                {targetComponent.sku}
              </Badge>
              <Badge variant="secondary" className="text-[11px]">
                الوحدة: {effectiveBaseUnitName}
              </Badge>
              {targetComponent.shortageQty > 0 && (
                <Badge variant="outline" className="border-[var(--sem-neg)] text-[var(--sem-neg)] text-[11px]">
                  عجز: {targetComponent.shortageQty}
                </Badge>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* محتوى النموذج القابل للتمرير */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
                <p className="font-bold">تنبيه: لا توجد وحدة أساسية نشطة مسجلة لهذا الصنف</p>
                <p className="text-muted-foreground leading-relaxed text-[11px]">
                  تشترط وصفات الإنتاج أن تكون وحدة الناتج مطابقة للوحدة الأساسية النشطة للمنتج في الكتالوج. يرجى مراجعة وتعيين الوحدة الأساسية في بطاقة المنتج أولاً لتمكين حفظ الوصفة.
                </p>
              </div>
            </div>
          )}

          {/* قسم القوالب الذكية والنسخ */}
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
                <CheckCircle2 aria-hidden="true" className="size-4 text-[var(--sem-pos)] shrink-0" />
                <span>
                  تم نسخ تركيبة المواد من: <strong>{copiedSourceName}</strong> ({lines.length} مواد) — يمكنك تعديل الكميات أدناه.
                </span>
              </div>
            )}
          </div>

          {/* تفاصيل الوصفة الأساسية */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="quick-recipe-name" className="text-xs font-medium text-foreground">
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
              <label htmlFor="quick-recipe-base-unit" className="text-xs font-medium text-foreground">
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

          {/* جدول بنود المواد الخام */}
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
              <table className="w-full text-xs text-start">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-start font-medium">المادة الخام</th>
                    <th className="p-2 text-center font-medium w-28">كلفة الوحدة</th>
                    <th className="p-2 text-center font-medium w-28">الكمية لكل ناتج</th>
                    <th className="p-2 text-center font-medium w-28">إجمالي السطر</th>
                    <th className="p-2 text-center w-10">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lines.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-muted-foreground text-xs">
                        لم يتم إضافة أي مواد خام بعد. اختر قالباً من الأعلى أو ابحث عن مادة لإضافتها.
                      </td>
                    </tr>
                  ) : (
                    lines.map((line, idx) => {
                      const qty = moneyInput(line.qtyPerOutputBase);
                      const unitCost = moneyInput(line.inputCostPrice);
                      const lineTotal = round2(qty.mul(unitCost));

                      return (
                        <tr key={`${line.inputVariantId}-${idx}`} className="hover:bg-muted/20">
                          <td className="p-2">
                            <div className="font-semibold text-foreground">
                              {line.inputProductName}
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                              <span className="font-mono" dir="ltr">{line.inputSku}</span>
                              {line.unitName && <span>({line.unitName})</span>}
                            </div>
                          </td>
                          <td className="p-2 text-center font-mono text-muted-foreground">
                            {formatIqd(line.inputCostPrice)}
                          </td>
                          <td className="p-2 text-center">
                            <Input
                              type="text"
                              inputMode="decimal"
                              aria-label={`كمية ${line.inputProductName} لكل وحدة ناتجة`}
                              value={line.qtyPerOutputBase}
                              onChange={(e) => {
                                const val = normalizeDecimalInput(e.target.value);
                                handleLineQtyChange(idx, val);
                              }}
                              className="h-7 text-center font-mono font-bold text-xs"
                            />
                          </td>
                          <td className="p-2 text-center font-mono font-semibold text-foreground">
                            {formatIqd(lineTotal.toString())}
                          </td>
                          <td className="p-2 text-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`حذف ${line.inputProductName} من الوصفة`}
                              onClick={() => handleRemoveLine(idx)}
                              className="size-7 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
              <div className="relative">
                <Search aria-hidden="true" className="size-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="البحث عن مادة خام لإضافتها"
                  value={searchMaterial}
                  onChange={(e) => {
                    setSearchMaterial(e.target.value);
                    setShowSearchDropdown(true);
                  }}
                  onFocus={() => setShowSearchDropdown(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setShowSearchDropdown(false);
                    }
                  }}
                  placeholder="ابحث عن مادة خام لإضافتها إلى الوصفة (بالاسم أو الباركود)..."
                  className="ps-8 h-8 text-xs"
                />
                {searchMaterial && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="مسح البحث"
                    onClick={() => {
                      setSearchMaterial("");
                      setShowSearchDropdown(false);
                    }}
                    className="absolute end-1 top-1/2 -translate-y-1/2 size-6 p-0"
                  >
                    <X aria-hidden="true" className="size-3" />
                  </Button>
                )}
              </div>

              {/* القائمة المنسدلة للبحث */}
              {showSearchDropdown && searchMaterial.trim().length >= 1 && (
                <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-lg max-h-48 overflow-y-auto">
                  {isSearching ? (
                    <div className="p-3 text-center text-xs text-muted-foreground">
                      <Loader2 aria-hidden="true" className="size-4 animate-spin inline me-1.5" />
                      جارٍ البحث عن المواد الخام...
                    </div>
                  ) : materialsQ.isError ? (
                    <div className="p-3 text-center text-xs text-destructive">
                      {materialsQ.error?.message || "تعذر تحميل المواد الخام، يرجى التحقق من الصلاحيات والمحاولة لاحقاً"}
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
                            <div className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                              {mat.sku} • {mat.unitName}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {formatIqd(mat.costPrice)}
                            </span>
                            <Plus aria-hidden="true" className="size-3.5 text-primary shrink-0" />
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* التكاليف التشغيلية (العمالة والهدر) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div className="space-y-1">
              <label htmlFor="quick-recipe-labor" className="text-xs font-medium text-foreground">
                أجور العمالة لكل 1 {effectiveBaseUnitName} (د.ع)
              </label>
              <Input
                id="quick-recipe-labor"
                type="text"
                inputMode="decimal"
                value={laborPerOutputBase}
                onChange={(e) =>
                  setLaborPerOutputBase(normalizeDecimalInput(e.target.value))
                }
                placeholder="0"
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="quick-recipe-waste" className="text-xs font-medium text-foreground">
                نسبة الهدر المعياري المتوقع (%)
              </label>
              <Input
                id="quick-recipe-waste"
                type="text"
                inputMode="decimal"
                value={wasteStdPct}
                onChange={(e) =>
                  setWasteStdPct(normalizeDecimalInput(e.target.value))
                }
                placeholder="0"
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>

          {/* ملاحظات */}
          <div className="space-y-1">
            <label htmlFor="quick-recipe-notes" className="text-xs font-medium text-foreground">
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
                <span>حساب التكلفة المعيارية الحية لكل 1 {effectiveBaseUnitName}:</span>
              </div>
              {costs.batchMultiple > 1 && (
                <Badge variant="outline" className="border-[var(--sem-warn)] text-[var(--sem-warn)] text-[10px]">
                  مضاعف الدفعة: {costs.batchMultiple} وحدات
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded bg-background p-2 border">
                <div className="text-[10px] text-muted-foreground">كلفة المواد الخام</div>
                <div className="font-mono font-bold text-foreground mt-0.5">
                  {formatIqd(costs.materialsTotal.toString())}
                </div>
              </div>
              <div className="rounded bg-background p-2 border">
                <div className="text-[10px] text-muted-foreground">أجور العمالة</div>
                <div className="font-mono font-bold text-foreground mt-0.5">
                  {formatIqd(costs.labor.toString())}
                </div>
              </div>
              <div className="rounded bg-background p-2 border border-primary/30">
                <div className="text-[10px] text-primary font-medium">التكلفة المعيارية شاملة الهدر</div>
                <div className="font-mono font-bold text-primary mt-0.5">
                  {formatIqd(costs.unitCostWithWaste.toString())}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* أزرار الإجراءات في أسفل النافذة */}
        <DialogFooter className="p-3 border-t bg-muted/20 flex items-center justify-between gap-2 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={createRecipeMut.isPending}
          >
            إلغاء
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={
              createRecipeMut.isPending ||
              lines.length === 0 ||
              !recipeName.trim() ||
              !effectiveBaseUnitId
            }
            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
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

    {/* نافذة تأكيد استبدال المواد بقالب جديد */}
    <Dialog
      open={pendingTemplate != null}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleCancelReplaceTemplate();
      }}
    >
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500 shrink-0" aria-hidden="true" />
            <span>تأكيد استبدال مواد الوصفة</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
            تحتوي مسودة الوصفة الحالية على {lines.length} من المواد المدخلة. سيؤدي تطبيق القالب «{pendingTemplate?.sourceName}» إلى استبدال كافة المواد المدخلة وإعادة ضبط نسب الهدر وأجور العمالة. هل تريد المتابعة؟
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
  </>
  );
}
