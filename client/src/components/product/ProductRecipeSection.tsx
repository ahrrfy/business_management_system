import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RecipeImportDialog } from "./RecipeImportDialog";
import { PredictiveRecipeSuggestions } from "./PredictiveRecipeSuggestions";
import {
  useProductRecipe,
  type ProductRecipeSectionProps,
} from "./useProductRecipe";
import { useRecipeTransfer } from "./useRecipeTransfer";
import { useRecipeCosts } from "./useRecipeCosts";
import { useRecipeSave } from "./useRecipeSave";
import { RecipeHeader } from "./RecipeHeader";
import { RecipeEmptyState } from "./RecipeEmptyState";
import { RecipeSummary } from "./RecipeSummary";
import { RecipeEditorFields } from "./RecipeEditorFields";
import { RecipeMaterialsTable } from "./RecipeMaterialsTable";

export * from "./recipeClipboard";
export function ProductRecipeSection(props: ProductRecipeSectionProps) {
  const { productId, isService = false } = props;
  const controller = useProductRecipe(props);
  const transfer = useRecipeTransfer(controller);
  const costs = useRecipeCosts(controller, props);
  const save = useRecipeSave(controller);
  const {
    can,
    recipeQ,
    data,
    currentRecipe,
    currentBranchId,
    isEditing,
    isImportDialogOpen,
    setIsImportDialogOpen,
    setPriceTierMode,
    clipboardData,
    formName,
    setFormName,
    formLabor,
    setFormLabor,
    formWaste,
    setFormWaste,
    formNotes,
    setFormNotes,
    formLines,
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
  } = controller;
  const { handleCopyRecipe, handlePasteRecipe, handleApplyTemplate } = transfer;
  const { calculatedCosts, profitability } = costs;
  const { handleSave, handleDelete } = save;
  if (!can("production.recipes.forProduct"))
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          غير مفوض لعرض وصفة المنتج
        </CardContent>
      </Card>
    );
  if (recipeQ.isLoading)
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          جارٍ تحميل وصفة المنتج والمواد...
        </CardContent>
      </Card>
    );
  if (recipeQ.isError)
    return (
      <Card>
        <CardContent className="space-y-2 py-6 text-sm" role="alert">
          <p>تعذر تحميل وصفة المنتج: {recipeQ.error.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void recipeQ.refetch()}
          >
            إعادة المحاولة
          </Button>
        </CardContent>
      </Card>
    );
  const effectiveIsService = Boolean(data?.product.isService || isService);
  const clipboardCount = clipboardData?.lines.length ?? 0;
  return (
    <Card className="border border-border/70 shadow-xs">
      <RecipeHeader
        can={can}
        currentRecipe={currentRecipe}
        isEditing={isEditing}
        setIsImportDialogOpen={setIsImportDialogOpen}
        clipboardData={clipboardData}
        formLines={formLines}
        createMut={createMut}
        updateMut={updateMut}
        setActiveMut={setActiveMut}
        deleteMut={deleteMut}
        startEditing={startEditing}
        cancelEditing={cancelEditing}
        handleCopyRecipe={handleCopyRecipe}
        handlePasteRecipe={handlePasteRecipe}
        handleSave={handleSave}
        handleDelete={handleDelete}
        effectiveIsService={effectiveIsService}
        clipboardCount={clipboardCount}
      />

      <CardContent className="p-4 sm:p-5 space-y-4">
        <fieldset
          className="contents"
          disabled={createMut.isPending || updateMut.isPending}
        >
          <RecipeEmptyState
            currentRecipe={currentRecipe}
            isEditing={isEditing}
            setIsImportDialogOpen={setIsImportDialogOpen}
            startEditing={startEditing}
            handlePasteRecipe={handlePasteRecipe}
            handleApplyTemplate={handleApplyTemplate}
            effectiveIsService={effectiveIsService}
            clipboardCount={clipboardCount}
            productId={productId}
            writeDisabled={
              !can("production.recipes.create") ||
              createMut.isPending ||
              updateMut.isPending
            }
          />
          {/* وضع العرض أو التعديل */}
          {(currentRecipe || isEditing) && (
            <div className="space-y-4">
              <RecipeSummary
                can={can}
                currentBranchId={currentBranchId}
                setPriceTierMode={setPriceTierMode}
                activeLinesForCheck={activeLinesForCheck}
                stockCheckQ={stockCheckQ}
                stockData={stockData}
                calculatedCosts={calculatedCosts}
                profitability={profitability}
              />
              {/* اقتراحات تنبؤية ذكية داخل وضع التعديل عند خلو المواد */}
              {isEditing && formLines.length === 0 && (
                <PredictiveRecipeSuggestions
                  productId={productId}
                  onApplySuggestion={handleApplyTemplate}
                />
              )}
              <RecipeEditorFields
                isEditing={isEditing}
                formName={formName}
                setFormName={setFormName}
                formLabor={formLabor}
                setFormLabor={setFormLabor}
                formWaste={formWaste}
                setFormWaste={setFormWaste}
                formNotes={formNotes}
                setFormNotes={setFormNotes}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                showSearchDropdown={showSearchDropdown}
                setShowSearchDropdown={setShowSearchDropdown}
                materialsQ={materialsQ}
                handleAddMaterial={handleAddMaterial}
              />
              <RecipeMaterialsTable
                can={can}
                currentRecipe={currentRecipe}
                isEditing={isEditing}
                formLines={formLines}
                stockData={stockCheckQ.isError ? undefined : stockData}
                stockCheckQ={stockCheckQ}
                handleRemoveLine={handleRemoveLine}
                handleLineQtyChange={handleLineQtyChange}
              />
              {/* ملاحظات الوصفة إن وجدت في وضع العرض */}
              {!isEditing && currentRecipe?.notes && (
                <div className="p-3 rounded-lg border bg-muted/20 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground block mb-0.5">
                    ملاحظات الوصفة:
                  </span>
                  {currentRecipe.notes}
                </div>
              )}
            </div>
          )}
        </fieldset>
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
