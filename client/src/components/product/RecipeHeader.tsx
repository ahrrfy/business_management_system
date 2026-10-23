import {
  ClipboardPaste,
  Copy,
  Layers,
  PackageSearch,
  Pencil,
  Plus,
  Power,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { RecipeController } from "./useProductRecipe";
import type { RecipeTransfer } from "./useRecipeTransfer";
import type { RecipeSave } from "./useRecipeSave";
type Props = Pick<
  RecipeController,
  | "can"
  | "currentRecipe"
  | "isEditing"
  | "setIsImportDialogOpen"
  | "clipboardData"
  | "formLines"
  | "createMut"
  | "updateMut"
  | "setActiveMut"
  | "deleteMut"
  | "startEditing"
  | "cancelEditing"
> &
  Pick<RecipeTransfer, "handleCopyRecipe" | "handlePasteRecipe"> &
  Pick<RecipeSave, "handleSave" | "handleDelete"> & {
    effectiveIsService: boolean;
    clipboardCount: number;
  };
export function RecipeHeader({
  can,
  currentRecipe,
  isEditing,
  setIsImportDialogOpen,
  clipboardData,
  formLines,
  createMut,
  updateMut,
  setActiveMut,
  deleteMut,
  startEditing,
  cancelEditing,
  handleCopyRecipe,
  handlePasteRecipe,
  handleSave,
  handleDelete,
  effectiveIsService,
  clipboardCount,
}: Props) {
  const writeDisabled =
    !can(
      currentRecipe ? "production.recipes.update" : "production.recipes.create",
    ) ||
    createMut.isPending ||
    updateMut.isPending;
  return (
    <>
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
                  <Badge
                    variant="outline"
                    className="border-sky-500/40 text-sky-700 bg-sky-50/70 text-[11px]"
                  >
                    استهلاك خدمة
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 text-amber-700 bg-amber-50/70 text-[11px]"
                  >
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
              disabled={clipboardCount === 0 || writeDisabled}
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
              disabled={writeDisabled}
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
                  disabled={
                    !can("production.recipes.setActive") ||
                    setActiveMut.isPending
                  }
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
                  disabled={writeDisabled}
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
                  disabled={
                    !can("production.recipes.remove") || deleteMut.isPending
                  }
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
                disabled={writeDisabled}
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
                  disabled={writeDisabled}
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
    </>
  );
}
