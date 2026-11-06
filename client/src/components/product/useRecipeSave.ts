import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import type { RecipeController } from "./useProductRecipe";
type SaveProps = Pick<
  RecipeController,
  | "currentRecipe"
  | "createMut"
  | "updateMut"
  | "deleteMut"
  | "can"
  | "prepareRecipeChange"
  | "acceptRecipeSave"
  | "isWritePending"
>;
export function useRecipeSave({
  can,
  currentRecipe,
  createMut,
  updateMut,
  deleteMut,
  prepareRecipeChange,
  acceptRecipeSave,
  isWritePending,
}: SaveProps) {
  async function handleSave() {
    if (isWritePending) return;
    let change;
    try {
      change = prepareRecipeChange(true);
    } catch (error) {
      notify.warn(
        error instanceof Error ? error.message : "تعذّر تجهيز الوصفة",
      );
      return;
    }
    if (!change) return;
    const { recipeId, ...definition } = change;
    let result;
    try {
      result =
        recipeId != null
          ? await updateMut.mutateAsync({ ...definition, id: recipeId })
          : await createMut.mutateAsync(definition);
    } catch {
      return;
    } // mutation onError reports failure; keep the draft intact.
    try {
      await acceptRecipeSave(change, result);
    } catch (error) {
      notify.err(
        error instanceof Error ? error.message : "تعذّر تحديث الوصفة المحفوظة",
      );
    }
  }

  async function handleDelete() {
    if (!currentRecipe || isWritePending || !can("production.recipes.remove"))
      return;
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
