import { useRef } from "react";
import { moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { QuickRecipeDraft } from "./useQuickRecipeDraft";

export function useQuickRecipeSave({
  open,
  targetComponent,
  onOpenChange,
  onRecipeCreated,
  draft,
}: {
  open: boolean;
  targetComponent: ComponentRequirementDto | null;
  onOpenChange: (open: boolean) => void;
  onRecipeCreated: (
    recipeId: number,
    variantId: number,
  ) => void | Promise<void>;
  draft: QuickRecipeDraft;
}) {
  const submittedDraftRef = useRef<{
    session: number;
    productName: string;
  } | null>(null);
  const createRecipeMut = trpc.production.recipes.create.useMutation({
    onSuccess: async (result, variables) => {
      const submitted = submittedDraftRef.current;
      notify.ok(
        `تم حفظ الوصفة بنجاح وتحويل «${submitted?.productName ?? `#${variables.outputVariantId}`}» إلى صنف مصنّع`,
      );
      // Refresh the saved variant even after its dialog has been dismissed.
      try {
        await onRecipeCreated(result.recipeId, variables.outputVariantId);
      } catch (error) {
        console.error("Failed to refresh bundle after recipe creation:", error);
      }
      // The caller can await a refresh while another draft is opened or reset.
      if (open && submitted?.session === draft.sessionRef.current)
        onOpenChange(false);
    },
    onError: (error) => notify.err(error.message || "تعذّر حفظ الوصفة"),
  });

  async function handleSave() {
    if (!targetComponent || submittedDraftRef.current) return;
    const trimmedName = draft.recipeName.trim();
    if (!trimmedName) {
      notify.warn("اسم الوصفة مطلوب");
      return;
    }
    if (!draft.effectiveBaseUnitId) {
      notify.err(
        "تعذّر تحديد الوحدة الأساسية لهذا الصنف، يرجى مراجعة بطاقة المنتج",
      );
      return;
    }
    if (draft.lines.length === 0) {
      notify.warn("يجب إضافة مادة خام واحدة على الأقل في الوصفة");
      return;
    }
    for (const line of draft.lines) {
      const quantity = moneyInput(line.qtyPerOutputBase);
      if (quantity.lte(0)) {
        notify.warn(
          `كمية المادة «${line.inputProductName}» يجب أن تكون رقماً موجباً أكبر من صفر`,
        );
        return;
      }
      if (quantity.decimalPlaces() > 4) {
        notify.warn(
          `كمية المادة «${line.inputProductName}» لا يمكن أن تتجاوز 4 مراتب عشرية`,
        );
        return;
      }
    }
    const cleanWaste = draft.wasteStdPct.trim();
    if (
      cleanWaste &&
      (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleanWaste) ||
        cleanWaste.split(".").length > 2)
    ) {
      notify.warn("نسبة الهدر غير صالحة، يرجى إدخال رقم عشري صحيح");
      return;
    }
    const cleanLabor = draft.laborPerOutputBase.trim();
    if (
      cleanLabor &&
      (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleanLabor) ||
        cleanLabor.split(".").length > 2)
    ) {
      notify.warn("تكلفة العمالة غير صالحة، يرجى إدخال رقم عشري صحيح");
      return;
    }
    const waste = moneyInput(draft.wasteStdPct).div(100);
    if (waste.lt(0) || waste.gte(1)) {
      notify.warn("نسبة الهدر يجب أن تكون بين 0% وأقل من 100%");
      return;
    }
    submittedDraftRef.current = {
      session: draft.sessionRef.current,
      productName: targetComponent.productName,
    };
    try {
      await createRecipeMut.mutateAsync({
        name: trimmedName,
        outputVariantId: targetComponent.variantId,
        outputProductUnitId: draft.effectiveBaseUnitId,
        laborPerOutputBase: draft.laborPerOutputBase.trim() || "0",
        wasteStdPct: waste.toString(),
        notes: draft.notes.trim() || null,
        isActive: true,
        lines: draft.lines.map((line) => ({
          inputVariantId: line.inputVariantId,
          inputProductUnitId: line.inputProductUnitId ?? null,
          qtyPerOutputBase: moneyInput(line.qtyPerOutputBase).toString(),
          notes: line.notes ?? null,
        })),
      });
    } catch {
      // The mutation's onError displays the rejection once.
    } finally {
      submittedDraftRef.current = null;
    }
  }
  return { createRecipeMut, handleSave };
}
