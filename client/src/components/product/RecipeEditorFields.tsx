import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { formatIqd } from "@/lib/money";
import type { RecipeController } from "./useProductRecipe";
type Props = Pick<
  RecipeController,
  | "isEditing"
  | "formName"
  | "setFormName"
  | "formLabor"
  | "setFormLabor"
  | "formWaste"
  | "setFormWaste"
  | "formNotes"
  | "setFormNotes"
  | "searchQuery"
  | "setSearchQuery"
  | "showSearchDropdown"
  | "setShowSearchDropdown"
  | "materialsQ"
  | "handleAddMaterial"
>;
export function RecipeEditorFields({
  isEditing,
  formName,
  setFormName,
  formLabor,
  setFormLabor,
  formWaste,
  setFormWaste,
  formNotes,
  setFormNotes,
  searchQuery,
  setSearchQuery,
  showSearchDropdown,
  setShowSearchDropdown,
  materialsQ,
  handleAddMaterial,
}: Props) {
  return (
    <>
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
                onClear={() => setShowSearchDropdown(false)}
                onSubmit={(submitted) => {
                  const q = submitted.trim();
                  if (!q || q !== searchQuery.trim() || materialsQ.isFetching)
                    return;
                  const first = (materialsQ.data ?? [])[0];
                  if (first) handleAddMaterial(first);
                }}
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
              {materialsQ.isError && (
                <div role="alert" className="p-3 text-xs text-destructive">
                  <p>تعذر البحث: {materialsQ.error.message}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void materialsQ.refetch()}
                  >
                    إعادة المحاولة
                  </Button>
                </div>
              )}
              {!materialsQ.isLoading &&
                !materialsQ.isError &&
                (materialsQ.data?.length ?? 0) === 0 && (
                  <div className="p-3 text-center text-xs text-muted-foreground">
                    لا توجد مواد خام مطابقة للبحث
                  </div>
                )}
              {!materialsQ.isError &&
                materialsQ.data?.map((mat) => (
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
                      <span
                        className="text-[11px] text-muted-foreground block font-mono"
                        dir="ltr"
                      >
                        {mat.sku} · {mat.unitName}
                      </span>
                    </div>
                    <div className="text-end">
                      <span
                        className="font-semibold text-foreground block"
                        dir="ltr"
                      >
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
    </>
  );
}
