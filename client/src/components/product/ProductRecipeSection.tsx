import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Layers,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Save,
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
import { D, formatIqd, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

interface EditableLine {
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

interface ProductRecipeSectionProps {
  productId: number;
  isService?: boolean;
}

export function ProductRecipeSection({
  productId,
  isService = false,
}: ProductRecipeSectionProps) {
  const utils = trpc.useUtils();

  // استعلام قراءة وصفة المنتج
  const recipeQ = trpc.production.recipes.forProduct.useQuery(
    { productId },
    { enabled: Number.isFinite(productId) && productId > 0 },
  );

  const [isEditing, setIsEditing] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null);

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

  // طفرات إدارة الوصفة
  const createMut = trpc.production.recipes.create.useMutation({
    onSuccess: async () => {
      notify.ok("تم إنشاء وصفة المواد بنجاح");
      setIsEditing(false);
      await utils.production.recipes.forProduct.invalidate({ productId });
    },
    onError: (err) => notify.err(err.message || "تعذّر حفظ الوصفة"),
  });

  const updateMut = trpc.production.recipes.update.useMutation({
    onSuccess: async () => {
      notify.ok("تم تحديث وصفة المواد بنجاح");
      setIsEditing(false);
      await utils.production.recipes.forProduct.invalidate({ productId });
    },
    onError: (err) => notify.err(err.message || "تعذّر تحديث الوصفة"),
  });

  const setActiveMut = trpc.production.recipes.setActive.useMutation({
    onSuccess: async () => {
      notify.ok("تم تغيير حالة تفعيل الوصفة");
      await utils.production.recipes.forProduct.invalidate({ productId });
    },
    onError: (err) => notify.err(err.message || "تعذّر تغيير حالة الوصفة"),
  });

  const deleteMut = trpc.production.recipes.remove.useMutation({
    onSuccess: async () => {
      notify.ok("تم حذف الوصفة بنجاح");
      setIsEditing(false);
      await utils.production.recipes.forProduct.invalidate({ productId });
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
  }

  function handleAddMaterial(mat: {
    variantId: number;
    productName: string;
    variantName: string | null;
    sku: string;
    unitName: string;
    costPrice: string;
  }) {
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

  function handleLineNotesChange(index: number, val: string) {
    setFormLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, notes: val || null } : l)),
    );
  }

  // حساب التكاليف الحية
  const calculatedCosts = useMemo(() => {
    const linesToCompute = isEditing
      ? formLines
      : currentRecipe?.lines || [];

    let materialsTotal = D(0);
    for (const l of linesToCompute) {
      const qty = D(l.qtyPerOutputBase || "0");
      const unitCost = D(l.inputCostPrice || "0");
      materialsTotal = materialsTotal.plus(qty.mul(unitCost));
    }
    materialsTotal = round2(materialsTotal);

    const labor = round2(D(isEditing ? formLabor : currentRecipe?.laborPerOutputBase || "0"));
    const wastePct = D(isEditing ? formWaste : currentRecipe?.wasteStdPct || "0");
    const totalBeforeWaste = materialsTotal.plus(labor);
    const wasteFactor = wastePct.gt(0) && wastePct.lt(1)
      ? D(1).minus(wastePct)
      : D(1);
    const totalUnitCost = wasteFactor.gt(0)
      ? round2(totalBeforeWaste.div(wasteFactor))
      : totalBeforeWaste;

    return {
      materialsTotal,
      labor,
      totalUnitCost,
    };
  }, [isEditing, formLines, formLabor, formWaste, currentRecipe]);

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
      const q = D(l.qtyPerOutputBase || "0");
      if (q.lte(0)) {
        notify.warn(`كمية المادة «${l.inputProductName}» يجب أن تكون أكبر من صفر`);
        return;
      }
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
      <Card className="border border-border/70 shadow-sm">
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          جارٍ تحميل وصفة المنتج والمواد...
        </CardContent>
      </Card>
    );
  }

  const effectiveIsService = Boolean(data?.product.isService || isService);

  return (
    <Card className="border border-border/70 shadow-sm overflow-hidden">
      <CardHeader className="bg-muted/30 pb-4 border-b">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Layers className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
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
                        ? "bg-emerald-600 hover:bg-emerald-700"
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
          <div className="flex items-center gap-2 flex-wrap">
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
                  className="h-8 gap-1.5 text-xs"
                >
                  <Power className="size-3.5" />
                  {currentRecipe.isActive ? "تعطيل الوصفة" : "تفعيل الوصفة"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={startEditing}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Pencil className="size-3.5" />
                  تعديل الوصفة
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleteMut.isPending}
                  className="h-8 gap-1.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
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
                className="h-8 gap-1.5 text-xs bg-primary hover:bg-primary/90"
              >
                <Plus className="size-3.5" />
                إنشاء وصفة مواد خام
              </Button>
            )}
            {isEditing && (
              <>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSave}
                  disabled={createMut.isPending || updateMut.isPending}
                  className="h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
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
                  className="h-8 gap-1.5 text-xs"
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
          <div className="py-8 text-center rounded-lg border border-dashed border-border/80 bg-muted/20 space-y-3">
            <div className="size-12 rounded-full bg-muted/60 text-muted-foreground mx-auto flex items-center justify-center">
              <Layers className="size-6 text-muted-foreground/60" />
            </div>
            <div className="space-y-1 max-w-md mx-auto">
              <h4 className="text-sm font-semibold text-foreground">
                لا توجد وصفة مواد خام لهذا الصنف حالياً
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {effectiveIsService
                  ? "إن كانت هذه الخدمة تستهلك مواداً مثل الأوراق، الأحبار، الأقمشة أو الساريات، يمكنك ربطها بوصفة مواد ليتم خصمها وحساب كلفتها تلقائياً."
                  : "تمكنك الوصفة من حساب تكلفة التصنيع واستهلاك المواد الخام بدقة عند تشغيل أوامر الإنتاج."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startEditing}
              className="gap-1.5 text-xs mt-2"
            >
              <Plus className="size-3.5" />
              إنشاء وصفة مواد جديدة الآن
            </Button>
          </div>
        )}

        {/* وضع العرض أو التعديل */}
        {(currentRecipe || isEditing) && (
          <div className="space-y-4">
            {/* بطاقات الإحصاء والتكلفة المحسوبة */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg border bg-card text-card-foreground">
                <span className="text-[11px] text-muted-foreground block font-medium">
                  تكلفة المواد الخام التقديرية
                </span>
                <span className="text-base font-bold text-foreground mt-0.5 block" dir="ltr">
                  {formatIqd(calculatedCosts.materialsTotal.toString())}
                </span>
                <span className="text-[10px] text-muted-foreground">لكل وحدة ناتج أساسية</span>
              </div>

              <div className="p-3 rounded-lg border bg-card text-card-foreground">
                <span className="text-[11px] text-muted-foreground block font-medium">
                  أجور العمالة المباشرة
                </span>
                <span className="text-base font-bold text-foreground mt-0.5 block" dir="ltr">
                  {formatIqd(calculatedCosts.labor.toString())}
                </span>
                <span className="text-[10px] text-muted-foreground">لكل وحدة ناتج</span>
              </div>

              <div className="p-3 rounded-lg border bg-card text-card-foreground">
                <span className="text-[11px] text-muted-foreground block font-medium">
                  نسبة الهدر المعياري
                </span>
                <span className="text-base font-bold text-foreground mt-0.5 block" dir="ltr">
                  {D(isEditing ? formWaste : currentRecipe?.wasteStdPct || "0").mul(100).toFixed(1)}%
                </span>
                <span className="text-[10px] text-muted-foreground">تُمتص في كلفة الوحدة</span>
              </div>

              <div className="p-3 rounded-lg border bg-primary/5 border-primary/20 text-primary">
                <span className="text-[11px] text-primary/80 block font-medium">
                  إجمالي كلفة الوحدة المعيارية
                </span>
                <span className="text-base font-bold text-primary mt-0.5 block" dir="ltr">
                  {formatIqd(calculatedCosts.totalUnitCost.toString())}
                </span>
                <span className="text-[10px] text-primary/70">تشمل المواد + العمالة + الهدر</span>
              </div>
            </div>

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
            <div className="rounded-lg border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-start border-collapse">
                  <thead className="bg-muted/40 text-muted-foreground border-b text-[11px]">
                    <tr>
                      <th className="py-2 px-3 text-start font-medium">#</th>
                      <th className="py-2 px-3 text-start font-medium">المادة الخام / المكوّن</th>
                      <th className="py-2 px-3 text-start font-medium">الرمز (SKU)</th>
                      <th className="py-2 px-3 text-start font-medium">الوحدة</th>
                      <th className="py-2 px-3 text-center font-medium">الكمية المطلوبة</th>
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
                          colSpan={isEditing ? 8 : 7}
                          className="py-6 text-center text-muted-foreground text-xs"
                        >
                          لا توجد مواد مضافة في هذه الوصفة حتى الآن
                        </td>
                      </tr>
                    ) : (
                      (isEditing ? formLines : currentRecipe?.lines || []).map((line, idx) => {
                        const lineQty = D(line.qtyPerOutputBase || "0");
                        const lineCost = round2(lineQty.mul(D(line.inputCostPrice || "0")));

                        return (
                          <tr key={line.inputVariantId} className="hover:bg-muted/20">
                            <td className="py-2.5 px-3 text-muted-foreground text-[11px]">
                              {idx + 1}
                            </td>
                            <td className="py-2.5 px-3 font-medium text-foreground">
                              {line.inputProductName}
                              {line.notes && (
                                <span className="block text-[10px] text-muted-foreground mt-0.5">
                                  {line.notes}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-muted-foreground font-mono" dir="ltr">
                              {line.inputSku}
                            </td>
                            <td className="py-2.5 px-3 text-muted-foreground">
                              {("unitName" in line && line.unitName)
                                ? line.unitName
                                : ((line as any).units?.find((u: any) => u.isBaseUnit)?.unitName || "وحدة")}
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
    </Card>
  );
}
export default ProductRecipeSection;
