import { confirm } from "@/lib/confirm";
import { moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import type { RecipeController } from "./useProductRecipe";
type SaveProps = Pick<
  RecipeController,
  | "data"
  | "currentRecipe"
  | "formName"
  | "formLabor"
  | "formWaste"
  | "formNotes"
  | "formLines"
  | "createMut"
  | "updateMut"
  | "deleteMut"
  | "can"
>;
export function useRecipeSave({
  can,
  data,
  currentRecipe,
  formName,
  formLabor,
  formWaste,
  formNotes,
  formLines,
  createMut,
  updateMut,
  deleteMut,
}: SaveProps) {
  async function handleSave() {
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
    if (!formName.trim()) {
      notify.warn("اسم الوصفة مطلوب");
      return;
    }
    if (!data?.primaryVariantId || !data?.primaryProductUnitId) {
      notify.err(
        "لا يمكن حفظ الوصفة لعدم وجود متغير أساسي أو وحدة أساسية للمنتج",
      );
      return;
    }
    if (formLines.length === 0) {
      notify.warn("يجب إضافة مادة خام واحدة على الأقل في الوصفة");
      return;
    }

    for (const l of formLines) {
      const q = moneyInput(l.qtyPerOutputBase);
      if (q.lte(0)) {
        notify.warn(
          `كمية المادة «${l.inputProductName}» يجب أن تكون أكبر من صفر`,
        );
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
      notify.warn(
        "نسبة الهدر المعياري يجب أن تكون بين 0 وأقل من 1 (مثلاً 0.05 لـ 5%)",
      );
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

  return { handleSave, handleDelete };
}
export type RecipeSave = ReturnType<typeof useRecipeSave>;
