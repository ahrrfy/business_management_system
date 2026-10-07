import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Gauge,
  Layers,
  PackageSearch,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Save,
  Sparkles,
  TrendingUp,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { confirm } from "@/lib/confirm";
import { D, formatIqd, moneyInput, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useSessionContext } from "@/hooks/useSessionContext";
import { RecipeImportDialog, type ImportedRecipeData } from "./RecipeImportDialog";
import { PredictiveRecipeSuggestions } from "./PredictiveRecipeSuggestions";

export const RECIPE_CLIPBOARD_KEY = "alroya_recipe_clipboard_v1";
export const RECIPE_CLIPBOARD_LEGACY_KEY = "alroya_recipe_clipboard";
export const RECIPE_CLIPBOARD_EVENT = "alroya_recipe_clipboard_updated";

export interface EditableLine {
  id?: number;
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  notes?: string | null;
  unitName?: string;
}

export interface CopiedRecipeLine {
  inputVariantId: number;
  inputProductUnitId?: number | null;
  inputProductName: string;
  inputSku: string;
  inputCostPrice: string;
  qtyPerOutputBase: string;
  notes?: string | null;
  unitName?: string;
}

export interface CopiedRecipePayload {
  version?: number;
  recipeName: string;
  productName: string;
  laborPerOutputBase: string;
  wasteStdPct: string;
  notes?: string | null;
  lines: CopiedRecipeLine[];
  copiedAt: string;
}

export function sanitizeRecipeClipboard(raw: unknown): CopiedRecipePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const rawLines = Array.isArray(obj.lines)
    ? obj.lines
    : Array.isArray(obj.items)
      ? obj.items
      : null;
  if (!rawLines || rawLines.length === 0) return null;

  const validLines: CopiedRecipeLine[] = [];
  const seenVariants = new Set<number>();

  for (const item of rawLines) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const variantId = Number(it.inputVariantId ?? it.variantId);
    if (!Number.isFinite(variantId) || variantId <= 0) continue;
    if (seenVariants.has(variantId)) continue;
    seenVariants.add(variantId);

    const unitId = it.inputProductUnitId != null ? Number(it.inputProductUnitId) : null;
    const qty =
      it.qtyPerOutputBase != null
        ? String(it.qtyPerOutputBase)
        : it.quantity != null
          ? String(it.quantity)
          : "1";
    const cost =
      it.inputCostPrice != null
        ? String(it.inputCostPrice)
        : it.costPrice != null
          ? String(it.costPrice)
          : "0";
    const pName =
      typeof it.inputProductName === "string" && it.inputProductName.trim()
        ? it.inputProductName.trim()
        : typeof it.productName === "string" && it.productName.trim()
          ? it.productName.trim()
          : `مادة خام (#${variantId})`;
    const sku =
      typeof it.inputSku === "string"
        ? it.inputSku
        : typeof it.sku === "string"
          ? it.sku
          : "";
    const uName = typeof it.unitName === "string" ? it.unitName : "وحدة";
    const notes = typeof it.notes === "string" ? it.notes : null;

    validLines.push({
      inputVariantId: variantId,
      inputProductUnitId: unitId && Number.isFinite(unitId) && unitId > 0 ? unitId : null,
      inputProductName: pName,
      inputSku: sku,
      inputCostPrice: cost,
      qtyPerOutputBase: qty,
      notes,
      unitName: uName,
    });
  }

  if (validLines.length === 0) return null;

  return {
    version: 1,
    recipeName:
      typeof obj.recipeName === "string" && obj.recipeName.trim()
        ? obj.recipeName.trim()
        : "وصفة منتج",
    productName:
      typeof obj.productName === "string" && obj.productName.trim()
        ? obj.productName.trim()
        : "المنتج",
    laborPerOutputBase: typeof obj.laborPerOutputBase === "string" ? obj.laborPerOutputBase : "0",
    wasteStdPct: typeof obj.wasteStdPct === "string" ? obj.wasteStdPct : "0",
    notes: typeof obj.notes === "string" ? obj.notes : null,
    lines: validLines,
    copiedAt: typeof obj.copiedAt === "string" ? obj.copiedAt : new Date().toISOString(),
  };
}

export function getStoredRecipeClipboard(): CopiedRecipePayload | null {
  try {
    if (typeof localStorage === "undefined") return null;
    let raw = localStorage.getItem(RECIPE_CLIPBOARD_KEY);
    if (!raw) {
      raw = localStorage.getItem(RECIPE_CLIPBOARD_LEGACY_KEY);
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeRecipeClipboard(parsed);
    if (sanitized && !localStorage.getItem(RECIPE_CLIPBOARD_KEY)) {
      try {
        localStorage.setItem(RECIPE_CLIPBOARD_KEY, JSON.stringify(sanitized));
      } catch {}
    }
    return sanitized;
  } catch {
    return null;
  }
}

export function setStoredRecipeClipboard(payload: CopiedRecipePayload) {
  try {
    const sanitized = sanitizeRecipeClipboard(payload);
    if (!sanitized) return;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(RECIPE_CLIPBOARD_KEY, JSON.stringify(sanitized));
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(RECIPE_CLIPBOARD_EVENT, { detail: sanitized }));
    }
  } catch {
    // ignore localStorage quota errors
  }
}

interface ProductRecipeSectionProps {
  productId: number;
  isService?: boolean;
}

export function ProductRecipeSection({
  productId,
  isService = false,
}: ProductRecipeSectionProps) {
  const utils = trpc.useUtils();
  const { context } = useSessionContext();
  const currentBranchId = context?.branch?.id ? Number(context.branch.id) : undefined;

  // استعلام قراءة وصفة المنتج مع تفاصيل الصنف وأسعار البيع
  const recipeQ = trpc.production.recipes.forProduct.useQuery(
    { productId },
    { enabled: Number.isFinite(productId) && productId > 0 },
  );

  const [isEditing, setIsEditing] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [priceTierMode, setPriceTierMode] = useState<"RETAIL" | "WHOLESALE">("RETAIL");

  // حالة الحافظة المشتركة عبر التخزين المحلي
  const [clipboardData, setClipboardData] = useState<CopiedRecipePayload | null>(() =>
    getStoredRecipeClipboard(),
  );

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (
        e.key === RECIPE_CLIPBOARD_KEY ||
        e.key === RECIPE_CLIPBOARD_LEGACY_KEY ||
        e.key === null
      ) {
        setClipboardData(getStoredRecipeClipboard());
      }
    };
    const handleCustom = () => {
      setClipboardData(getStoredRecipeClipboard());
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECIPE_CLIPBOARD_EVENT, handleCustom);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECIPE_CLIPBOARD_EVENT, handleCustom);
    };
  }, []);

  // إعادة ضبط حالة التحرير ونموذج الإدخال عند التبديل لمنتج آخر
  useEffect(() => {
    setIsEditing(false);
    setSelectedRecipeId(null);
    setSearchQuery("");
    setShowSearchDropdown(false);
    setFormLines([]);
    setClipboardData(getStoredRecipeClipboard());
  }, [productId]);

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
    { enabled: isEditing && searchQuery.trim().length >= 1, staleTime: 30_000 },
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
      enabled: Boolean(currentBranchId && activeLinesForCheck.length > 0),
      staleTime: 15_000,
    },
  );

  const stockData = stockCheckQ.data;

  // تهيئة نموذج التعديل من الوصفة الحالية
  function startEditing() {
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
    if (data?.primaryVariantId && mat.variantId === data.primaryVariantId) {
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

  // ميزة نسخ الوصفة
  function handleCopyRecipe() {
    const linesToCopy = isEditing
      ? formLines.map((l) => ({
          inputVariantId: l.inputVariantId,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          notes: l.notes,
          unitName: l.unitName,
        }))
      : (currentRecipe?.lines || []).map((l) => ({
          inputVariantId: l.inputVariantId,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          notes: l.notes,
          unitName: l.units?.find((u) => u.isBaseUnit)?.unitName || "وحدة",
        }));

    if (linesToCopy.length === 0) {
      notify.warn("لا توجد بنود مواد لنسخها في هذه الوصفة");
      return;
    }

    const payload: CopiedRecipePayload = {
      recipeName: isEditing ? formName : currentRecipe?.name || "وصفة منتج",
      productName: data?.product.name || "المنتج",
      laborPerOutputBase: isEditing ? formLabor : currentRecipe?.laborPerOutputBase || "0",
      wasteStdPct: isEditing ? formWaste : currentRecipe?.wasteStdPct || "0",
      notes: isEditing ? formNotes : currentRecipe?.notes || null,
      lines: linesToCopy,
      copiedAt: new Date().toISOString(),
    };

    const sanitized = sanitizeRecipeClipboard(payload);
    if (!sanitized) {
      notify.warn("تعذّر تجهيز بنود الوصفة للنسخ");
      return;
    }

    setStoredRecipeClipboard(sanitized);
    setClipboardData(sanitized);
    notify.ok(`تم نسخ بنود الوصفة (${sanitized.lines.length} مواد) إلى الحافظة بنجاح`);
  }

  // ميزة لصق الوصفة
  async function handlePasteRecipe() {
    const clip = getStoredRecipeClipboard();
    if (!clip || clip.lines.length === 0) {
      notify.warn("الحافظة فارغة حالياً، انسخ وصفة من أي منتج أولاً");
      return;
    }

    if ((isEditing && formLines.length > 0) || (!isEditing && currentRecipe)) {
      const currentCount = isEditing ? formLines.length : (currentRecipe?.lines.length ?? 0);
      const currentLabel = isEditing ? "نموذج الوصفة الحالي" : `وصفة «${currentRecipe?.name}»`;
      const ok = await confirm({
        title: "تأكيد استبدال مواد الوصفة",
        description: `يحتوي ${currentLabel} على ${currentCount} مواد. هل ترغب باستبدالها بـ ${clip.lines.length} مواد من الحافظة (من «${clip.recipeName}»)؟`,
        confirmText: "نعم، استبدل المواد",
        variant: "warning",
      });
      if (!ok) return;
    }

    // استبعاد المادة إذا كانت تمثل نفس المنتج الحالي ودمج المواد المكررة
    const consolidatedMap = new Map<number, EditableLine>();
    for (const l of clip.lines) {
      const vid = Number(l.inputVariantId);
      if (!Number.isFinite(vid) || vid <= 0) continue;
      if (data?.primaryVariantId && vid === data.primaryVariantId) continue;

      const existing = consolidatedMap.get(vid);
      if (existing) {
        const sumQty = moneyInput(existing.qtyPerOutputBase).plus(moneyInput(l.qtyPerOutputBase));
        existing.qtyPerOutputBase = sumQty.toString();
      } else {
        consolidatedMap.set(vid, {
          inputVariantId: vid,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          notes: l.notes,
          unitName: l.unitName || "وحدة",
        });
      }
    }

    const safeLines = Array.from(consolidatedMap.values());
    if (safeLines.length === 0) {
      notify.warn("لم يتم العثور على مواد صالحة للصق (تم استبعاد المنتج الحالي لتفادي التبعية الدائرية)");
      return;
    }

    if (safeLines.length < clip.lines.length) {
      notify.warn("تم استبعاد الصنف الحالي أو دمج المواد المكررة لتفادي التبعية الدائرية والتكرار");
    }

    setFormLines(safeLines);

    if (clip.laborPerOutputBase && (formLabor === "0" || !formLabor)) {
      setFormLabor(clip.laborPerOutputBase);
    }
    if (clip.wasteStdPct && (formWaste === "0" || !formWaste)) {
      setFormWaste(clip.wasteStdPct);
    }
    if (clip.notes && !formNotes) {
      setFormNotes(clip.notes);
    }

    if (!isEditing) {
      setFormName(currentRecipe?.name || `وصفة ${data?.product.name || "المنتج"}`);
      setIsEditing(true);
    }

    notify.ok(`تم لصق ${safeLines.length} مواد من الحافظة بنجاح، يمكنك تعديلها وحفظ الوصفة`);
  }

  // تطبيق قالب مستورد أو مقترح
  async function handleApplyTemplate(template: ImportedRecipeData) {
    if ((isEditing && formLines.length > 0) || (!isEditing && currentRecipe)) {
      const currentCount = isEditing ? formLines.length : (currentRecipe?.lines.length ?? 0);
      const currentLabel = isEditing ? "النموذج الحالي" : `الوصفة الحالية «${currentRecipe?.name}»`;
      const ok = await confirm({
        title: "تأكيد تطبيق القالب",
        description: `يحتوي ${currentLabel} على ${currentCount} مواد. هل ترغب باستبدالها بمواد القالب «${template.recipeName}»؟`,
        confirmText: "نعم، طبق القالب",
        variant: "warning",
      });
      if (!ok) return;
    }

    // استبعاد المادة إذا كانت تمثل نفس المنتج الحالي ودمج المواد المكررة
    const consolidatedMap = new Map<number, EditableLine>();
    for (const l of template.lines) {
      const vid = Number(l.inputVariantId);
      if (!Number.isFinite(vid) || vid <= 0) continue;
      if (data?.primaryVariantId && vid === data.primaryVariantId) continue;

      const existing = consolidatedMap.get(vid);
      if (existing) {
        const sumQty = moneyInput(existing.qtyPerOutputBase).plus(moneyInput(l.qtyPerOutputBase));
        existing.qtyPerOutputBase = sumQty.toString();
      } else {
        consolidatedMap.set(vid, {
          inputVariantId: vid,
          inputProductUnitId: l.inputProductUnitId,
          inputProductName: l.inputProductName,
          inputSku: l.inputSku,
          inputCostPrice: l.inputCostPrice,
          qtyPerOutputBase: l.qtyPerOutputBase,
          notes: l.notes,
          unitName: l.unitName || "وحدة",
        });
      }
    }

    const safeLines = Array.from(consolidatedMap.values());
    if (safeLines.length === 0) {
      notify.warn("لم يتم العثور على مواد صالحة في القالب لتطبيقها");
      return;
    }

    if (safeLines.length < template.lines.length) {
      notify.warn("تم استبعاد الصنف الحالي أو دمج المواد المكررة لتفادي التبعية الدائرية والتكرار");
    }

    setFormLines(safeLines);

    setFormLabor(template.laborPerOutputBase || "0");
    setFormWaste(template.wasteStdPct || "0");
    if (template.notes) setFormNotes(template.notes);
    if (!formName || formName === `وصفة ${data?.product.name || "المنتج"}`) {
      setFormName(currentRecipe?.name || `وصفة ${data?.product.name || "المنتج"}`);
    }

    setIsEditing(true);
    notify.ok(`تم تطبيق قالب «${template.recipeName}» بنجاح، يمكنك تعديل الكميات وحفظ الوصفة`);
  }

  // حساب التكاليف الحية بأمان ضد المُدخلات الجزئية
  const calculatedCosts = useMemo(() => {
    const linesToCompute = isEditing ? formLines : currentRecipe?.lines || [];

    let materialsTotal = D(0);
    for (const l of linesToCompute) {
      const qty = moneyInput(l.qtyPerOutputBase);
      const unitCost = moneyInput(l.inputCostPrice);
      materialsTotal = materialsTotal.plus(qty.mul(unitCost));
    }
    materialsTotal = round2(materialsTotal);

    const rawLabor = moneyInput(isEditing ? formLabor : currentRecipe?.laborPerOutputBase);
    const labor = round2(rawLabor.isNegative() ? D(0) : rawLabor);
    const rawWaste = moneyInput(isEditing ? formWaste : currentRecipe?.wasteStdPct);
    const wastePct = rawWaste.gt(0) && rawWaste.lt(1) ? rawWaste : D(0);
    const totalBeforeWaste = materialsTotal.plus(labor);
    const wasteFactor =
      wastePct.gt(0) && wastePct.lt(1) ? D(1).minus(wastePct) : D(1);
    const totalUnitCost = wasteFactor.gt(0)
      ? round2(totalBeforeWaste.div(wasteFactor))
      : totalBeforeWaste;

    return {
      materialsTotal,
      labor,
      wastePct,
      totalUnitCost,
    };
  }, [isEditing, formLines, formLabor, formWaste, currentRecipe]);

  // حساب مؤشرات الربحية وهامش الربح مع دعم فئات الأسعار (مفرق / جملة)
  const profitability = useMemo(() => {
    const hasRetail = Boolean(data?.sellingPrice && moneyInput(data.sellingPrice).gt(0));
    const hasWholesale = Boolean(data?.wholesalePrice && moneyInput(data.wholesalePrice).gt(0));

    const effectiveTier =
      (priceTierMode === "WHOLESALE" && hasWholesale) || !hasRetail
        ? "WHOLESALE"
        : "RETAIL";

    const rawPrice = effectiveTier === "WHOLESALE" ? data?.wholesalePrice : data?.sellingPrice;
    if (!rawPrice) return null;
    const sellP = moneyInput(rawPrice);
    if (sellP.lte(0)) return null;

    const unitCost = calculatedCosts.totalUnitCost;
    const grossProfit = round2(sellP.minus(unitCost));
    const grossMarginPct = round2(grossProfit.div(sellP).mul(100));
    const isLoss = grossProfit.lt(0);
    const isLowMargin = !isLoss && grossMarginPct.lt(15);

    return {
      priceTier: effectiveTier,
      hasBothTiers: Boolean(hasRetail && hasWholesale),
      sellingPrice: sellP,
      grossProfit,
      grossMarginPct,
      isLoss,
      isLowMargin,
    };
  }, [data?.sellingPrice, data?.wholesalePrice, priceTierMode, calculatedCosts.totalUnitCost]);

  async function handleSave() {
    if (!formName.trim()) {
      notify.warn("اسم الوصفة مطلوب");
      return;
    }
    if (!data?.primaryVariantId || !data?.primaryProductUnitId) {
      notify.err("لا يمكن حفظ الوصفة لعدم وجود متغير أساسي أو وحدة أساسية للمنتج");
      return;
    }
    if (formLines.length === 0) {
      notify.warn("يجب إضافة مادة خام واحدة على الأقل في الوصفة");
      return;
    }

    for (const l of formLines) {
      const q = moneyInput(l.qtyPerOutputBase);
      if (q.lte(0)) {
        notify.warn(`كمية المادة «${l.inputProductName}» يجب أن تكون أكبر من صفر`);
        return;
      }
    }

    const laborVal = moneyInput(formLabor);
    if (laborVal.isNegative()) {
      notify.warn("كلفة العمالة لا يمكن أن تكون سالبة");
      return;
    }
    const wasteVal = moneyInput(formWaste);
    if (wasteVal.isNegative() || wasteVal.gte(1)) {
      notify.warn("نسبة الهدر المعياري يجب أن تكون بين 0 وأقل من 1 (مثلاً 0.05 لـ 5%)");
      return;
    }

    const payloadLines = formLines.map((l) => ({
      inputVariantId: l.inputVariantId,
      inputProductUnitId: l.inputProductUnitId ?? null,
      qtyPerOutputBase: l.qtyPerOutputBase,
      notes: l.notes ?? null,
    }));

    if (currentRecipe) {
      await updateMut.mutateAsync({
        id: currentRecipe.id,
        name: formName.trim(),
        outputVariantId: currentRecipe.outputVariantId,
        outputProductUnitId: currentRecipe.outputProductUnitId,
        laborPerOutputBase: formLabor.trim() || "0",
        wasteStdPct: formWaste.trim() || "0",
        notes: formNotes.trim() || null,
        lines: payloadLines,
      });
    } else {
      await createMut.mutateAsync({
        name: formName.trim(),
        outputVariantId: data.primaryVariantId,
        outputProductUnitId: data.primaryProductUnitId,
        laborPerOutputBase: formLabor.trim() || "0",
        wasteStdPct: formWaste.trim() || "0",
        notes: formNotes.trim() || null,
        isActive: true,
        lines: payloadLines,
      });
    }
  }

  async function handleDelete() {
    if (!currentRecipe) return;
    const ok = await confirm({
      title: "تأكيد حذف الوصفة",
      description: `هل أنت متأكد من حذف وصفة «${currentRecipe.name}»؟ لا يمكن التراجع عن هذا الإجراء.`,
      confirmText: "نعم، احذف الوصفة",
      variant: "danger",
    });
    if (!ok) return;
    await deleteMut.mutateAsync({ id: currentRecipe.id });
  }

  if (recipeQ.isLoading) {
    return (
      <Card className="border border-border/70 shadow-xs">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          جارٍ تحميل وصفة المنتج والمواد...
        </CardContent>
      </Card>
    );
  }

  const effectiveIsService = Boolean(data?.product.isService || isService);
  const clipboardCount = clipboardData?.lines.length ?? 0;

  return (
    <Card className="border border-border/70 shadow-xs overflow-hidden">
      <CardHeader className="bg-muted/30 pb-4 border-b">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Layers className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-base font-bold">
                  {effectiveIsService
                    ? "وصفة مواد استهلاك الخدمة (BOM)"
                    : "وصفة المواد والتصنيع (BOM)"}
                </CardTitle>
                {effectiveIsService ? (
                  <Badge variant="outline" className="border-sky-500/40 text-sky-700 bg-sky-50/70 text-[11px]">
                    استهلاك خدمة
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-700 bg-amber-50/70 text-[11px]">
                    إنتاج مخزني
                  </Badge>
                )}
                {currentRecipe && (
                  <Badge
                    variant={currentRecipe.isActive ? "default" : "secondary"}
                    className={cn(
                      "text-[11px]",
                      currentRecipe.isActive
                        ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                        : "bg-muted-foreground/30 text-muted-foreground",
                    )}
                  >
                    {currentRecipe.isActive ? "مفعّلة" : "معطّلة"}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {effectiveIsService
                  ? "تحديد المواد الخام التي يخصمها النظام من المخزون تلقائياً عند تنفيذ أمر شغل هذه الخدمة"
                  : "تعريف المعايير الثابتة لتحويل المواد الأولية إلى هذا المنتج عبر دورة الإنتاج"}
              </p>
            </div>
          </div>

          {/* أزرار الإجراءات في الرأس */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* زر نسخ الوصفة */}
            {(currentRecipe || (isEditing && formLines.length > 0)) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopyRecipe}
                title="نسخ بنود الوصفة بالكامل إلى الحافظة لنقلها لمنتج آخر"
                className="h-8 gap-1 text-xs"
              >
                <Copy className="size-3.5" />
                نسخ الوصفة
              </Button>
            )}

            {/* زر لصق الوصفة */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePasteRecipe}
              disabled={clipboardCount === 0}
              title={
                clipboardCount > 0
                  ? `لصق ${clipboardCount} مواد من الحافظة (من «${clipboardData?.productName}»)`
                  : "الحافظة فارغة حالياً"
              }
              className="h-8 gap-1.5 text-xs"
            >
              <ClipboardPaste className="size-3.5" />
              <span>لصق الوصفة</span>
              {clipboardCount > 0 && (
                <Badge
                  variant="secondary"
                  className="size-5 p-0 flex items-center justify-center text-[10px] font-mono bg-primary/10 text-primary"
                >
                  {clipboardCount}
                </Badge>
              )}
            </Button>

            {/* زر استيراد وصفة من منتج آخر */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsImportDialogOpen(true)}
              title="البحث في وصفات المنتجات الأخرى واستيراد أي منها كقالب"
              className="h-8 gap-1 text-xs"
            >
              <PackageSearch className="size-3.5" />
              استيراد وصفة
            </Button>

            {currentRecipe && !isEditing && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setActiveMut.mutate({
                      id: currentRecipe.id,
                      active: !currentRecipe.isActive,
                    })
                  }
                  disabled={setActiveMut.isPending}
                  className="h-8 gap-1 text-xs"
                >
                  <Power className="size-3.5" />
                  {currentRecipe.isActive ? "تعطيل" : "تفعيل"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={startEditing}
                  className="h-8 gap-1 text-xs"
                >
                  <Pencil className="size-3.5" />
                  تعديل
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleteMut.isPending}
                  className="h-8 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  حذف
                </Button>
              </>
            )}

            {!currentRecipe && !isEditing && (
              <Button
                type="button"
                size="sm"
                onClick={startEditing}
                className="h-8 gap-1 text-xs bg-primary hover:bg-primary/90"
              >
                <Plus className="size-3.5" />
                إنشاء وصفة
              </Button>
            )}

            {isEditing && (
              <>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSave}
                  disabled={createMut.isPending || updateMut.isPending}
                  className="h-8 gap-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Save className="size-3.5" />
                  حفظ الوصفة
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={cancelEditing}
                  disabled={createMut.isPending || updateMut.isPending}
                  className="h-8 gap-1 text-xs"
                >
                  <X className="size-3.5" />
                  إلغاء
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 sm:p-5 space-y-4">
        {/* حالة عدم وجود وصفة وبلا وضع تعديل */}
        {!currentRecipe && !isEditing && (
          <div className="space-y-4">
            <div className="py-7 text-center rounded-lg border border-dashed border-border/80 bg-muted/20 space-y-3">
              <div className="size-11 rounded-full bg-muted/60 text-muted-foreground mx-auto flex items-center justify-center">
                <Layers className="size-5 text-muted-foreground/60" />
              </div>
              <div className="space-y-1 max-w-md mx-auto">
                <h4 className="text-sm font-semibold text-foreground">
                  لا توجد وصفة مواد خام لهذا الصنف حالياً
                </h4>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {effectiveIsService
                    ? "إن كانت هذه الخدمة تستهلك مواداً مثل الأوراق، الأحبار أو الأقمشة، يمكنك ربطها بوصفة مواد ليتم خصمها وحساب كلفتها تلقائياً."
                    : "تمكنك الوصفة من حساب تكلفة التصنيع واستهلاك المواد الخام بدقة عند تشغيل أوامر الإنتاج."}
                </p>
              </div>

              <div className="flex items-center justify-center gap-2 flex-wrap pt-1">
                <Button
                  type="button"
                  size="sm"
                  onClick={startEditing}
                  className="gap-1.5 text-xs bg-primary hover:bg-primary/90"
                >
                  <Plus className="size-3.5" />
                  إنشاء وصفة جديدة
                </Button>

                {clipboardCount > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePasteRecipe}
                    className="gap-1.5 text-xs border-primary/40 text-primary hover:bg-primary/5"
                  >
                    <ClipboardPaste className="size-3.5" />
                    لصق من الحافظة ({clipboardCount} مواد)
                  </Button>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsImportDialogOpen(true)}
                  className="gap-1.5 text-xs"
                >
                  <PackageSearch className="size-3.5" />
                  استيراد وصفة كقالب
                </Button>
              </div>
            </div>

            {/* محرك الاقتراحات التنبؤية للوصفات المشابهة */}
            <PredictiveRecipeSuggestions
              productId={productId}
              onApplySuggestion={handleApplyTemplate}
            />
          </div>
        )}

        {/* وضع العرض أو التعديل */}
        {(currentRecipe || isEditing) && (
          <div className="space-y-4">
            {/* بطاقات الإحصاء والتكلفة المحسوبة وهامش الربحية والطاقة الإنتاجية */}
            <div className="grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-2.5">
              <div className="p-3 rounded-lg border bg-card text-card-foreground">
                <span className="text-[11px] text-muted-foreground block font-medium">
                  تكلفة المواد الخام
                </span>
                <span className="text-sm sm:text-base font-bold text-foreground mt-0.5 block" dir="ltr">
                  {formatIqd(calculatedCosts.materialsTotal.toString())}
                </span>
                <span className="text-[10px] text-muted-foreground">لكل وحدة ناتج أساسية</span>
              </div>

              <div className="p-3 rounded-lg border bg-card text-card-foreground">
                <span className="text-[11px] text-muted-foreground block font-medium">
                  أجور العمالة المباشرة
                </span>
                <span className="text-sm sm:text-base font-bold text-foreground mt-0.5 block" dir="ltr">
                  {formatIqd(calculatedCosts.labor.toString())}
                </span>
                <span className="text-[10px] text-muted-foreground">لكل وحدة ناتج</span>
              </div>

              <div className="p-3 rounded-lg border bg-card text-card-foreground">
                <span className="text-[11px] text-muted-foreground block font-medium">
                  نسبة الهدر المعياري
                </span>
                <span className="text-sm sm:text-base font-bold text-foreground mt-0.5 block" dir="ltr">
                  {calculatedCosts.wastePct.mul(100).toFixed(1)}%
                </span>
                <span className="text-[10px] text-muted-foreground">تُمتص في كلفة الوحدة</span>
              </div>

              <div className="p-3 rounded-lg border bg-primary/5 border-primary/20 text-primary">
                <span className="text-[11px] text-primary/80 block font-medium">
                  كلفة الوحدة المعيارية
                </span>
                <span className="text-sm sm:text-base font-bold text-primary mt-0.5 block" dir="ltr">
                  {formatIqd(calculatedCosts.totalUnitCost.toString())}
                </span>
                <span className="text-[10px] text-primary/70">المواد + العمالة + الهدر</span>
              </div>

              {/* بطاقة الطاقة الإنتاجية الفورية */}
              <div
                className={cn(
                  "p-3 rounded-lg border",
                  stockData && stockData.maxCapacity > 0
                    ? "bg-emerald-50/60 border-emerald-500/30 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-300"
                    : "bg-muted/30 border-border text-foreground",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground block font-medium">
                    الطاقة الإنتاجية الفورية
                  </span>
                  <Gauge className="size-3.5 text-muted-foreground" />
                </div>
                <span className="text-sm sm:text-base font-bold mt-0.5 block" dir="ltr">
                  {activeLinesForCheck.length === 0
                    ? "لا توجد مواد"
                    : stockData
                      ? `${stockData.maxCapacity} وحدة`
                      : currentBranchId
                        ? "جارٍ الفحص..."
                        : "حدد الفرع"}
                </span>
                <span className="text-[10px] text-muted-foreground block truncate">
                  {activeLinesForCheck.length === 0
                    ? "أضف مواداً أولية للوصفة"
                    : !stockData
                      ? currentBranchId
                        ? "فحص أرصدة المستودع..."
                        : "اختر فرعاً لمعاينة الرصيد"
                      : stockData.limitingComponent
                        ? `العائق: ${stockData.limitingComponent}`
                        : stockData.maxCapacity > 0
                          ? "المواد متوفرة بالكامل"
                          : "لا يوجد رصيد كافٍ"}
                </span>
              </div>

              {/* بطاقة هامش الربحية المتوقع */}
              <div
                className={cn(
                  "p-3 rounded-lg border",
                  profitability
                    ? profitability.isLoss
                      ? "bg-destructive/10 border-destructive/30 text-destructive"
                      : profitability.isLowMargin
                        ? "bg-amber-50/60 border-amber-500/30 text-amber-900 dark:bg-amber-950/20 dark:text-amber-300"
                        : "bg-emerald-50/60 border-emerald-500/30 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-300"
                    : "bg-muted/30 border-border text-foreground",
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <span className="text-[11px] text-muted-foreground block font-medium truncate">
                      هامش الربح {profitability?.priceTier === "WHOLESALE" ? "(جملة)" : "(مفرق)"}
                    </span>
                    {profitability?.hasBothTiers && (
                      <button
                        type="button"
                        onClick={() =>
                          setPriceTierMode((prev) => (prev === "RETAIL" ? "WHOLESALE" : "RETAIL"))
                        }
                        className="text-[9px] px-1 py-0.5 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
                        title="التبديل بين سعر المفرق وسعر الجملة"
                      >
                        {profitability.priceTier === "RETAIL" ? "جملة" : "مفرق"}
                      </button>
                    )}
                  </div>
                  <TrendingUp className="size-3.5 text-muted-foreground shrink-0" />
                </div>
                <span className="text-sm sm:text-base font-bold mt-0.5 block" dir="ltr">
                  {profitability
                    ? `${profitability.grossMarginPct.toFixed(1)}%`
                    : "غير محدد"}
                </span>
                <span className="text-[10px] text-muted-foreground block truncate" dir="ltr">
                  {profitability
                    ? `الربح: ${formatIqd(profitability.grossProfit.toString())}`
                    : "لم يُسجل سعر بيع"}
                </span>
              </div>
            </div>

            {/* تنبيهات الذكاء التشغيلي والربحية */}
            {profitability?.isLoss && (
              <div className="p-3 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2.5 text-xs">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="font-bold block">
                    تحذير تشغيلي: التكلفة المعيارية أعلى من سعر البيع!
                  </span>
                  <p className="leading-relaxed">
                    تكلفة إنتاج الوحدة ({formatIqd(calculatedCosts.totalUnitCost.toString())}) تتجاوز
                    سعر البيع المعياري ({formatIqd(profitability.sellingPrice.toString())}) بعجز قدره{" "}
                    {formatIqd(profitability.grossProfit.abs().toString())} للوحدة (
                    {profitability.grossMarginPct.toFixed(1)}%). يُرجى مراجعة نسب الهدر وكميات المواد
                    أو تعديل سعر البيع لتفادي الخسائر التشغيلية.
                  </p>
                </div>
              </div>
            )}

            {profitability?.isLowMargin && !profitability?.isLoss && (
              <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-50/70 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 flex items-start gap-2.5 text-xs">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="font-bold block">تنبيه: هامش ربح منخفض</span>
                  <p className="leading-relaxed">
                    هامش الربح الإجمالي المتوقع ({profitability.grossMarginPct.toFixed(1)}%) أقل من
                    الحد الموصى به (15%). يُنصح بفحص أسعار شراء المواد الخام وأجور العمالة لتحسين الربحية.
                  </p>
                </div>
              </div>
            )}

            {stockData && stockData.maxCapacity === 0 && activeLinesForCheck.length > 0 && (
              <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-50/50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-300 flex items-start gap-2.5 text-xs">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="font-bold block">
                    تنبيه مخزني: نقص في المواد الأولية في الفرع الحالي
                  </span>
                  <p className="leading-relaxed">
                    رصيد بعض المواد الخام صفر في مخزون الفرع الحالي
                    {stockData.limitingComponent ? ` (${stockData.limitingComponent})` : ""}، ولن يكون
                    بالإمكان بدء أوامر الإنتاج الفوري حتى تأمين النواقص.
                  </p>
                </div>
              </div>
            )}

            {/* اقتراحات تنبؤية ذكية داخل وضع التعديل عند خلو المواد */}
            {isEditing && formLines.length === 0 && (
              <PredictiveRecipeSuggestions
                productId={productId}
                onApplySuggestion={handleApplyTemplate}
              />
            )}

            {/* حقول الوصفة في وضع التحرير */}
            {isEditing && (
              <div className="p-4 rounded-lg border bg-muted/10 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-foreground">
                      اسم الوصفة <span className="text-destructive">*</span>
                    </label>
                    <Input
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="مثال: وصفة طباعة علم قياس 140x90"
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-foreground">
                      كلفة العمالة لكل وحدة (د.ع)
                    </label>
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={formLabor}
                      onChange={(e) => setFormLabor(e.target.value)}
                      placeholder="0"
                      className="h-8 text-xs"
                      dir="ltr"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-foreground">
                      نسبة الهدر المتوقعة (0 إلى 0.99)
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="0.99"
                      value={formWaste}
                      onChange={(e) => setFormWaste(e.target.value)}
                      placeholder="مثلاً 0.05 لـ 5%"
                      className="h-8 text-xs"
                      dir="ltr"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">
                    ملاحظات وتعليمات الإنتاج / الاستهلاك
                  </label>
                  <Textarea
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    placeholder="ملاحظات توجيهية للفنيين وأوامر الشغل..."
                    rows={2}
                    className="text-xs"
                  />
                </div>
              </div>
            )}

            {/* شريط إضافة مادة خام أثناء التعديل */}
            {isEditing && (
              <div className="space-y-2 relative">
                <div className="flex items-center gap-2">
                  <div className="flex-1 relative">
                    <UnifiedSearchInput
                      value={searchQuery}
                      onChange={(val) => {
                        setSearchQuery(val);
                        setShowSearchDropdown(true);
                      }}
                      onFocus={() => setShowSearchDropdown(true)}
                      placeholder="ابحث عن مادة خام لإضافتها للوصفة (اسم الصنف أو SKU)..."
                      className="h-9 text-xs"
                    />
                  </div>
                  {searchQuery && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSearchQuery("");
                        setShowSearchDropdown(false);
                      }}
                      className="h-9 text-xs"
                    >
                      مسح
                    </Button>
                  )}
                </div>

                {/* قائمة نتائج البحث */}
                {showSearchDropdown && searchQuery.trim().length >= 1 && (
                  <div className="absolute z-50 start-0 end-0 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-lg p-1 space-y-1">
                    {materialsQ.isLoading && (
                      <div className="p-3 text-center text-xs text-muted-foreground">
                        جارٍ البحث في الأصناف المخزنية...
                      </div>
                    )}
                    {!materialsQ.isLoading && (materialsQ.data?.length ?? 0) === 0 && (
                      <div className="p-3 text-center text-xs text-muted-foreground">
                        لا توجد مواد خام مطابقة للبحث
                      </div>
                    )}
                    {materialsQ.data?.map((mat) => (
                      <button
                        key={mat.variantId}
                        type="button"
                        onClick={() => handleAddMaterial(mat)}
                        className="w-full flex items-center justify-between p-2 rounded text-start text-xs hover:bg-muted transition-colors"
                      >
                        <div className="space-y-0.5">
                          <span className="font-medium text-foreground block">
                            {mat.productName}
                            {mat.variantName ? ` (${mat.variantName})` : ""}
                          </span>
                          <span className="text-[11px] text-muted-foreground block font-mono" dir="ltr">
                            {mat.sku} · {mat.unitName}
                          </span>
                        </div>
                        <div className="text-end">
                          <span className="font-semibold text-foreground block" dir="ltr">
                            {formatIqd(mat.costPrice)}
                          </span>
                          <span className="text-[10px] text-emerald-600 block font-medium">
                            + إضافة للوصفة
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* جدول مكونات الوصفة */}
            <div className="rounded-lg border overflow-hidden max-h-[520px] overflow-y-auto">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-start border-collapse">
                  <thead className="bg-muted/40 text-muted-foreground border-b text-[11px]">
                    <tr>
                      <th className="py-2 px-3 text-start font-medium">#</th>
                      <th className="py-2 px-3 text-start font-medium">المادة الخام / المكوّن</th>
                      <th className="py-2 px-3 text-start font-medium">الرمز (SKU)</th>
                      <th className="py-2 px-3 text-start font-medium">الوحدة</th>
                      <th className="py-2 px-3 text-center font-medium">الكمية المطلوبة</th>
                      <th className="py-2 px-3 text-center font-medium">المتوفر في الفرع</th>
                      <th className="py-2 px-3 text-end font-medium">تكلفة الوحدة (د.ع)</th>
                      <th className="py-2 px-3 text-end font-medium">إجمالي البند (د.ع)</th>
                      {isEditing && (
                        <th className="py-2 px-3 text-center font-medium w-16">إجراء</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {(isEditing ? formLines : currentRecipe?.lines || []).length === 0 ? (
                      <tr>
                        <td
                          colSpan={isEditing ? 9 : 8}
                          className="py-6 text-center text-muted-foreground text-xs"
                        >
                          لا توجد مواد مضافة في هذه الوصفة حتى الآن
                        </td>
                      </tr>
                    ) : (
                      (isEditing ? formLines : currentRecipe?.lines || []).map((line, idx) => {
                        const lineQty = moneyInput(line.qtyPerOutputBase);
                        const lineCost = round2(lineQty.mul(moneyInput(line.inputCostPrice)));
                        const compStock = stockData?.components.find(
                          (c) => c.variantId === line.inputVariantId,
                        );

                        return (
                          <tr key={`${line.inputVariantId}-${idx}`} className="hover:bg-muted/20">
                            <td className="py-2.5 px-3 text-muted-foreground text-[11px]">
                              {idx + 1}
                            </td>
                            <td className="py-2.5 px-3 font-medium text-foreground">
                              {line.inputProductName || `مادة خام (#${line.inputVariantId})`}
                              {line.notes && (
                                <span className="block text-[10px] text-muted-foreground mt-0.5">
                                  {line.notes}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-muted-foreground font-mono" dir="ltr">
                              {line.inputSku || "-"}
                            </td>
                            <td className="py-2.5 px-3 text-muted-foreground">
                              {"unitName" in line && line.unitName
                                ? line.unitName
                                : (line as any).units?.find((u: any) => u.isBaseUnit)?.unitName || "وحدة"}
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              {isEditing ? (
                                <Input
                                  type="number"
                                  step="0.0001"
                                  min="0.0001"
                                  value={line.qtyPerOutputBase}
                                  onChange={(e) => handleLineQtyChange(idx, e.target.value)}
                                  className="h-7 w-24 mx-auto text-center text-xs font-mono"
                                  dir="ltr"
                                />
                              ) : (
                                <span className="font-bold font-mono" dir="ltr">
                                  {line.qtyPerOutputBase}
                                </span>
                              )}
                            </td>
                            {/* عمود المتوفر في الفرع */}
                            <td className="py-2.5 px-3 text-center">
                              {compStock ? (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-[10px] font-mono",
                                    compStock.available > 0
                                      ? compStock.isLimiting
                                        ? "border-amber-500/40 text-amber-700 bg-amber-50/80"
                                        : "border-emerald-500/40 text-emerald-700 bg-emerald-50/80"
                                      : "border-destructive/40 text-destructive bg-destructive/10",
                                  )}
                                >
                                  {compStock.available > 0
                                    ? `متوفر: ${compStock.available}`
                                    : "غير متوفر"}
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] font-mono text-muted-foreground border-border bg-muted/40"
                                >
                                  غير مسجل
                                </Badge>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-end font-mono text-muted-foreground" dir="ltr">
                              {formatIqd(line.inputCostPrice)}
                            </td>
                            <td className="py-2.5 px-3 text-end font-bold font-mono text-foreground" dir="ltr">
                              {formatIqd(lineCost.toString())}
                            </td>
                            {isEditing && (
                              <td className="py-2.5 px-3 text-center">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemoveLine(idx)}
                                  className="size-7 p-0 text-destructive hover:bg-destructive/10"
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ملاحظات الوصفة إن وجدت في وضع العرض */}
            {!isEditing && currentRecipe?.notes && (
              <div className="p-3 rounded-lg border bg-muted/20 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground block mb-0.5">ملاحظات الوصفة:</span>
                {currentRecipe.notes}
              </div>
            )}
          </div>
        )}
      </CardContent>

      {/* نافذة استيراد وصفة من منتج آخر */}
      <RecipeImportDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        currentProductId={productId}
        onApplyRecipe={handleApplyTemplate}
      />
    </Card>
  );
}

export default ProductRecipeSection;
