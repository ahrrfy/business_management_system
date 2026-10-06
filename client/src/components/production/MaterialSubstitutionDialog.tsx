import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { ProductSearchPicker, type PurchaseRow } from "@/components/production/ProductSearchPicker";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt, formatQuantity } from "@/lib/money";
import { ArrowLeftRight, AlertTriangle, Check, Lock, Info, Trash2 } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import type { MaterialSubstitutionItem, SubstituteRecipeMaterialResult } from "@shared/recipeSubstitutionTypes";

export interface MaterialSubstitutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipeId?: number | null;
  recipeName?: string | null;
  originalVariantId: number;
  originalProductName: string;
  originalSku?: string | null;
  originalQtyPerOutputBase: string;
  originalUnitName?: string | null;
  originalCostPrice?: string | null;
  availableStock?: number | null;
  consumedQty?: number | null;
  branchId: number | null;
  defaultScope?: "adhoc" | "permanent";
  onApplyAdHoc?: (substitution: MaterialSubstitutionItem) => void;
  onPermanentSuccess?: (result: SubstituteRecipeMaterialResult) => void;
  currentSubstitution?: MaterialSubstitutionItem | null;
  onRemoveSubstitution?: () => void;
}

export function MaterialSubstitutionDialog({
  open,
  onOpenChange,
  recipeId,
  recipeName,
  originalVariantId,
  originalProductName,
  originalSku,
  originalQtyPerOutputBase,
  originalUnitName,
  originalCostPrice,
  availableStock,
  consumedQty,
  branchId,
  defaultScope,
  onApplyAdHoc,
  onPermanentSuccess,
  currentSubstitution,
  onRemoveSubstitution,
}: MaterialSubstitutionDialogProps) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const userRole = String(me.data?.role ?? "").toUpperCase();
  const canUpdatePermanently = ["ADMIN", "MANAGER"].includes(userRole) && Boolean(recipeId);
  const activeBranchId = branchId != null ? branchId : (me.data?.branchId ?? null);
  const canAdHoc = Boolean(onApplyAdHoc);

  const [scope, setScope] = useState<"adhoc" | "permanent">("adhoc");
  const [substituteVariant, setSubstituteVariant] = useState<PurchaseRow | null>(null);
  const [substituteUnits, setSubstituteUnits] = useState<PurchaseRow[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState<string>("");
  const [qty, setQty] = useState<string>(originalQtyPerOutputBase || "1");
  const [reason, setReason] = useState<string>("نفاد المادة الأصلية من المخزون");
  const [notes, setNotes] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!open) {
      setError("");
      return;
    }
    const initialScope = defaultScope ?? (!canAdHoc && recipeId ? "permanent" : "adhoc");
    setScope(initialScope);
    setQty(currentSubstitution?.qtyPerOutputBase ?? originalQtyPerOutputBase ?? "1");
    setReason("نفاد المادة الأصلية من المخزون");
    setNotes("");
    setError("");
  }, [open, currentSubstitution, originalQtyPerOutputBase, defaultScope, canAdHoc, recipeId]);

  const selectedUnit = useMemo(
    () => substituteUnits.find((u) => String(u.productUnitId) === selectedUnitId) ?? null,
    [substituteUnits, selectedUnitId],
  );

  const substituteMutation = trpc.production.recipes.substituteMaterial.useMutation({
    onSuccess: (res) => {
      notify.ok("تم استبدال المادة واعتماد الوصفة بشكل دائم", `تم تحديث بطاقة الوصفة «${res.recipeName}».`);
      utils.production.recipes.list.invalidate();
      utils.production.recipes.listRunnable.invalidate();
      utils.production.recipes.forProduct.invalidate();
      utils.production.recipes.get.invalidate();
      utils.production.runPreview.invalidate();
      utils.production.recipeCapacity.invalidate();
      onPermanentSuccess?.(res);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err.message);
      notify.err(err);
    },
  });

  const handlePickSubstitute = (v: PurchaseRow, units: PurchaseRow[]) => {
    if (v.variantId === originalVariantId) {
      setError("لا يمكن اختيار نفس المادة كبديل لنفسها");
      return;
    }
    setError("");
    setSubstituteVariant(v);
    setSubstituteUnits(units);
    const base = units.find((u) => u.isBaseUnit) ?? units[0] ?? v;
    setSelectedUnitId(String(base.productUnitId));
  };

  const handleApply = () => {
    const activeSubVariantId = substituteVariant?.variantId ?? currentSubstitution?.substituteVariantId;
    if (!activeSubVariantId) {
      setError("يرجى اختيار المادة البديلة أولاً.");
      return;
    }
    if (activeSubVariantId === originalVariantId) {
      setError("المادة البديلة لا يمكن أن تكون نفس المادة الأصلية.");
      return;
    }
    const cleanQty = qty.trim();
    if (!cleanQty || !/^\d+(\.\d{1,4})?$/.test(cleanQty) || Number(cleanQty) <= 0) {
      setError("الكمية يجب أن تكون رقماً موجباً بأربع منازل عشرية كحد أقصى.");
      return;
    }
    const factor = selectedUnit && Number(selectedUnit.conversionFactor) > 0 ? Number(selectedUnit.conversionFactor) : 1;
    const baseQty = new Decimal(cleanQty).times(factor).toDecimalPlaces(4).toFixed(4);
    if (new Decimal(baseQty).lte(0)) {
      setError("الكمية الناتجة بعد التحويل بالوحدة الأساس يجب أن تكون أكبر من صفر.");
      return;
    }

    if (scope === "permanent") {
      if (!recipeId) return setError("لا يمكن التعديل الدائم لعدم تحديد معرف الوصفة.");
      if (!canUpdatePermanently) return setError("غير مصرح: تحديث الوصفة الدائم مقصور على دور مدير فأعلى.");
      substituteMutation.mutate({
        recipeId,
        originalVariantId,
        substituteVariantId: activeSubVariantId,
        substituteProductUnitId: selectedUnitId ? Number(selectedUnitId) : null,
        qtyPerOutputBase: baseQty,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
        branchId: activeBranchId ?? undefined,
      });
      return;
    }
    onApplyAdHoc?.({
      recipeId: recipeId ?? undefined,
      originalVariantId,
      substituteVariantId: activeSubVariantId,
      substituteProductUnitId: selectedUnitId ? Number(selectedUnitId) : null,
      qtyPerOutputBase: baseQty,
    });
    notify.ok("تم تطبيق الاستبدال المؤقت", "تم إدراج المادة البديلة على أمر التشغيل الحالي فقط.");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (substituteMutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl text-start" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-primary/10 text-primary">
              <ArrowLeftRight aria-hidden className="size-5" />
            </span>
            <div>
              <DialogTitle className="text-base font-bold">استبدال مادة خام ببديل</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                {recipeName ? `الوصفة: ${recipeName}` : "تعديل المكون النافذ أو العاجز مخزنياً"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3.5 text-sm">
          {/* بطاقة المادة الأصلية */}
          <div className="rounded-lg border border-border/80 bg-muted/30 p-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-muted-foreground">المادة الأصلية الحالية</span>
              {availableStock != null && (
                <span className={`px-2 py-0.5 rounded-full font-bold ${availableStock <= 0 ? "bg-destructive/10 text-destructive" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"}`}>
                  المتاح: {formatQuantity(availableStock)} {originalUnitName ?? ""}
                </span>
              )}
            </div>
            <div className="font-medium text-foreground">{originalProductName}</div>
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              {originalSku && <span dir="ltr">SKU: {originalSku}</span>}
              <span>المعيار: {formatQuantity(originalQtyPerOutputBase)} / ناتج</span>
              {consumedQty != null && <span>المطلوب للدفعة: {formatQuantity(consumedQty)}</span>}
              {originalCostPrice && <span>التكلفة: {fmt(originalCostPrice)} د.ع</span>}
            </div>
          </div>

          {/* نطاق الاستبدال */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">نطاق تطبيق الاستبدال</Label>
            {canAdHoc ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer text-xs ${scope === "adhoc" ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:bg-accent/40"}`}>
                  <input type="radio" name="substitutionScope" value="adhoc" checked={scope === "adhoc"} onChange={() => setScope("adhoc")} className="mt-0.5" />
                  <div>
                    <div className="font-semibold text-foreground">تطبيق على أمر التشغيل الحالي فقط</div>
                    <div className="text-[11px] text-muted-foreground">دفعة إسعافية مؤقتة دون تغيير بطاقة الوصفة</div>
                  </div>
                </label>

                <label className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs ${!canUpdatePermanently ? "opacity-50 cursor-not-allowed bg-muted/20" : scope === "permanent" ? "border-primary bg-primary/5 ring-1 ring-primary/30 cursor-pointer" : "border-border hover:bg-accent/40 cursor-pointer"}`}>
                  <input type="radio" name="substitutionScope" value="permanent" disabled={!canUpdatePermanently} checked={scope === "permanent"} onChange={() => setScope("permanent")} className="mt-0.5" />
                  <div>
                    <div className="font-semibold flex items-center gap-1 text-foreground">
                      <span>اعتماد دائم وتحديث الوصفة</span>
                      {!canUpdatePermanently && <Lock aria-hidden className="size-3 text-muted-foreground" />}
                    </div>
                    <div className="text-[11px] text-muted-foreground">حفظ ذري وتحديث شجرة المواد ومزامنة البكجات</div>
                  </div>
                </label>
              </div>
            ) : (
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs space-y-0.5">
                <div className="font-semibold text-foreground flex items-center gap-1">
                  <Check aria-hidden className="size-3.5 text-primary" />
                  <span>اعتماد دائم وتحديث بطاقة الوصفة الرسمية</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  سيتم استبدال المادة بشكل دائم في بنية الوصفة مع أقفال 2PL ومزامنة تكاليف البكجات.
                </p>
              </div>
            )}
            {canAdHoc && !canUpdatePermanently && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Info aria-hidden className="size-3 text-muted-foreground shrink-0" />
                <span>التحديث الدائم للوصفة مقصور على دور مدير فأعلى لحماية التكاليف والتسعير.</span>
              </p>
            )}
          </div>

          {/* اختيار المادة البديلة */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">اختيار المادة البديلة</Label>
            {activeBranchId != null ? (
              <ProductSearchPicker
                branchId={activeBranchId}
                placeholder="ابحث عن المادة البديلة بالاسم أو SKU أو الباركود…"
                onPick={handlePickSubstitute}
              />
            ) : (
              <div className="rounded-md border p-2 text-xs text-muted-foreground">
                يرجى تحديد الفرع أولاً للبحث في المواد والمخزون.
              </div>
            )}

            {substituteVariant ? (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-primary flex items-center gap-1">
                    <Check aria-hidden className="size-3.5" />
                    المادة البديلة المختارة
                  </span>
                  <span className="text-muted-foreground">المتاح: {formatQuantity(substituteVariant.stockBase)} {substituteVariant.unitName}</span>
                </div>
                <div className="font-medium text-xs">{substituteVariant.productName}</div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span dir="ltr">SKU: {substituteVariant.sku}</span>
                  <span>كلفة الأساس: {fmt(substituteVariant.costPriceBase)} د.ع</span>
                </div>
              </div>
            ) : currentSubstitution ? (
              <div className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-xs">
                مطبّق حالياً بديل بالمعرّف #{currentSubstitution.substituteVariantId} بكمية {currentSubstitution.qtyPerOutputBase}. اختر بديلاً جديداً لتغييره.
              </div>
            ) : null}
          </div>

          {/* الكمية والوحدة */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-end">
            <div className="space-y-1">
              <Label className="text-xs font-semibold">كمية البديل لكل وحدة ناتج</Label>
              <Input dir="ltr" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="الكمية المعيارية" />
              <p className="text-[10px] text-muted-foreground">تم ملء كمية المادة السابقة تلقائياً مع إمكانية التعديل.</p>
            </div>

            {substituteUnits.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs font-semibold">وحدة القياس للبديل</Label>
                <AppSelect className="h-9" value={selectedUnitId} onValueChange={setSelectedUnitId}>
                  {substituteUnits.map((u) => (
                    <option key={u.productUnitId} value={String(u.productUnitId)}>
                      {u.unitName}{u.isBaseUnit ? " (أساس)" : ` × ${u.conversionFactor}`}
                    </option>
                  ))}
                </AppSelect>
                {selectedUnit && (
                  <p className="text-[10px] text-muted-foreground">
                    معامل التحويل: {selectedUnit.conversionFactor}
                    {Number(selectedUnit.conversionFactor) > 1 && (
                      <span className="text-primary font-semibold ms-1">
                        (المعادل بالأساس: {formatQuantity(new Decimal(Number(qty) || 0).times(selectedUnit.conversionFactor).toDecimalPlaces(4).toFixed(4))})
                      </span>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* التدقيق والسبب عند التحديث الدائم */}
          {scope === "permanent" && (
            <div className="space-y-2 border-t pt-2.5">
              <div className="space-y-1">
                <Label className="text-xs font-semibold">سبب الاستبدال (للتوثيق والتدقيق)</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: انقطاع المادة من المورّد" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold">ملاحظة إضافية (اختياري)</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="أي تفاصيل فنية عن البديل" />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive flex items-start gap-1.5">
              <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-row gap-2 mt-2">
          {currentSubstitution && onRemoveSubstitution && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={substituteMutation.isPending}
              className="text-destructive hover:bg-destructive/10 gap-1.5"
              onClick={() => {
                onRemoveSubstitution();
                onOpenChange(false);
              }}
            >
              <Trash2 aria-hidden className="size-3.5" />
              إلغاء البديل والرجوع للأصل
            </Button>
          )}

          <div className="flex items-center gap-2 ms-auto">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={substituteMutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              إلغاء
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={substituteMutation.isPending || (!substituteVariant && !currentSubstitution)}
              onClick={handleApply}
              className="gap-1.5"
            >
              <ArrowLeftRight aria-hidden className="size-3.5" />
              {substituteMutation.isPending ? ACTION_LABELS.saving : scope === "permanent" ? "حفظ واعتماد دائم للوصفة" : "تطبيق الاستبدال للدفعة"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
