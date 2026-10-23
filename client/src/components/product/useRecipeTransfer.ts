import { confirm } from "@/lib/confirm";
import { moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import type { ImportedRecipeData } from "./RecipeImportDialog";
import {
  getStoredRecipeClipboard,
  setStoredRecipeClipboard,
  type CopiedRecipePayload,
  type EditableLine,
} from "./recipeClipboard";
import type { RecipeController } from "./useProductRecipe";
type TransferProps = Pick<
  RecipeController,
  | "can"
  | "createMut"
  | "updateMut"
  | "data"
  | "currentRecipe"
  | "currentCompanyId"
  | "isEditing"
  | "setIsEditing"
  | "clipboardData"
  | "setClipboardData"
  | "formName"
  | "setFormName"
  | "formLabor"
  | "setFormLabor"
  | "formWaste"
  | "setFormWaste"
  | "formNotes"
  | "setFormNotes"
  | "formLines"
  | "setFormLines"
>;
export function useRecipeTransfer({
  can,
  createMut,
  updateMut,
  data,
  currentRecipe,
  currentCompanyId,
  isEditing,
  setIsEditing,
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
}: TransferProps) {
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
      companyId: currentCompanyId,
      recipeName: isEditing ? formName : currentRecipe?.name || "وصفة منتج",
      productName: data?.product.name || "المنتج",
      laborPerOutputBase: isEditing
        ? formLabor
        : currentRecipe?.laborPerOutputBase || "0",
      wasteStdPct: isEditing ? formWaste : currentRecipe?.wasteStdPct || "0",
      notes: isEditing ? formNotes : currentRecipe?.notes || null,
      lines: linesToCopy,
      copiedAt: new Date().toISOString(),
    };

    const res = setStoredRecipeClipboard(payload, currentCompanyId);
    if (!res.success || !res.sanitized) {
      notify.warn("تعذّر تجهيز بنود الوصفة للنسخ");
      return;
    }

    setClipboardData(res.sanitized);
    if (res.persistedLocally) {
      notify.ok(
        `تم نسخ بنود الوصفة (${res.sanitized.lines.length} مواد) إلى الحافظة بنجاح`,
      );
    } else {
      notify.ok(
        `تم نسخ بنود الوصفة (${res.sanitized.lines.length} مواد) في ذاكرة الجلسة الحالية`,
      );
    }
  }

  // ميزة لصق الوصفة
  async function handlePasteRecipe() {
    if (
      createMut.isPending ||
      updateMut.isPending ||
      !can(
        currentRecipe
          ? "production.recipes.update"
          : "production.recipes.create",
      )
    )
      return;
    const clip = getStoredRecipeClipboard(currentCompanyId) ?? clipboardData;
    if (!clip || clip.lines.length === 0) {
      notify.warn("الحافظة فارغة حالياً، انسخ وصفة من أي منتج أولاً");
      return;
    }

    if ((isEditing && formLines.length > 0) || (!isEditing && currentRecipe)) {
      const currentCount = isEditing
        ? formLines.length
        : (currentRecipe?.lines.length ?? 0);
      const currentLabel = isEditing
        ? "نموذج الوصفة الحالي"
        : `وصفة «${currentRecipe?.name}»`;
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
    const targetOutputVariantId =
      currentRecipe?.outputVariantId ?? data?.primaryVariantId;
    for (const l of clip.lines) {
      const vid = Number(l.inputVariantId);
      if (!Number.isFinite(vid) || vid <= 0) continue;
      if (targetOutputVariantId && vid === targetOutputVariantId) continue;

      const existing = consolidatedMap.get(vid);
      if (existing) {
        const sumQty = moneyInput(existing.qtyPerOutputBase).plus(
          moneyInput(l.qtyPerOutputBase),
        );
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
      notify.warn(
        "لم يتم العثور على مواد صالحة للصق (تم استبعاد المنتج الحالي لتفادي التبعية الدائرية)",
      );
      return;
    }

    if (safeLines.length < clip.lines.length) {
      notify.warn(
        "تم استبعاد الصنف الحالي أو دمج المواد المكررة لتفادي التبعية الدائرية والتكرار",
      );
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
      setFormName(
        currentRecipe?.name || `وصفة ${data?.product.name || "المنتج"}`,
      );
      setIsEditing(true);
    }

    notify.ok(
      `تم لصق ${safeLines.length} مواد من الحافظة بنجاح، يمكنك تعديلها وحفظ الوصفة`,
    );
  }

  // تطبيق قالب مستورد أو مقترح
  async function handleApplyTemplate(
    template: ImportedRecipeData,
  ): Promise<boolean> {
    if (
      createMut.isPending ||
      updateMut.isPending ||
      !can(
        currentRecipe
          ? "production.recipes.update"
          : "production.recipes.create",
      )
    )
      return false;
    if ((isEditing && formLines.length > 0) || (!isEditing && currentRecipe)) {
      const currentCount = isEditing
        ? formLines.length
        : (currentRecipe?.lines.length ?? 0);
      const currentLabel = isEditing
        ? "النموذج الحالي"
        : `الوصفة الحالية «${currentRecipe?.name}»`;
      const ok = await confirm({
        title: "تأكيد تطبيق القالب",
        description: `يحتوي ${currentLabel} على ${currentCount} مواد. هل ترغب باستبدالها بمواد القالب «${template.recipeName}»؟`,
        confirmText: "نعم، طبق القالب",
        variant: "warning",
      });
      if (!ok) return false;
    }

    // استبعاد المادة إذا كانت تمثل نفس المنتج الحالي ودمج المواد المكررة
    const consolidatedMap = new Map<number, EditableLine>();
    const targetOutputVariantId =
      currentRecipe?.outputVariantId ?? data?.primaryVariantId;
    for (const l of template.lines) {
      const vid = Number(l.inputVariantId);
      if (!Number.isFinite(vid) || vid <= 0) continue;
      if (targetOutputVariantId && vid === targetOutputVariantId) continue;

      const existing = consolidatedMap.get(vid);
      if (existing) {
        const sumQty = moneyInput(existing.qtyPerOutputBase).plus(
          moneyInput(l.qtyPerOutputBase),
        );
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
      return false;
    }

    if (safeLines.length < template.lines.length) {
      notify.warn(
        "تم استبعاد الصنف الحالي أو دمج المواد المكررة لتفادي التبعية الدائرية والتكرار",
      );
    }

    setFormLines(safeLines);

    setFormLabor(template.laborPerOutputBase || "0");
    setFormWaste(template.wasteStdPct || "0");
    if (template.notes) setFormNotes(template.notes);
    if (!formName || formName === `وصفة ${data?.product.name || "المنتج"}`) {
      setFormName(
        currentRecipe?.name || `وصفة ${data?.product.name || "المنتج"}`,
      );
    }

    setIsEditing(true);
    notify.ok(
      `تم تطبيق قالب «${template.recipeName}» بنجاح، يمكنك تعديل الكميات وحفظ الوصفة`,
    );
    return true;
  }

  return { handleCopyRecipe, handlePasteRecipe, handleApplyTemplate };
}
export type RecipeTransfer = ReturnType<typeof useRecipeTransfer>;
