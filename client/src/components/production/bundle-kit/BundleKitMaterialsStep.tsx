import * as React from "react";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Factory,
  Gauge,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AggregatedMaterialDto } from "@shared/bundleProductionTypes";
import type {
  MaterialSubstitutionItem,
  SubstituteRecipeMaterialResult,
} from "@shared/recipeSubstitutionTypes";
import { MaterialSubstitutionDialog } from "../MaterialSubstitutionDialog";

interface BundleKitMaterialsStepProps {
  materials: AggregatedMaterialDto[];
  maxBundlesPossible: number;
  limitingFactorName: string | null;
  limitingFactorType: "RAW_MATERIAL" | "COMMERCIAL_COMPONENT" | null;
  requestedBundleQty: number;
  branchId: number | null;
  materialSubstitutions: MaterialSubstitutionItem[];
  onApplySubstitution: (substitution: MaterialSubstitutionItem) => void;
  onRemoveSubstitution: (material: AggregatedMaterialDto) => void;
  onPermanentSuccess?: (result: SubstituteRecipeMaterialResult) => void;
}

export function BundleKitMaterialsStep({
  materials,
  maxBundlesPossible,
  limitingFactorName,
  limitingFactorType,
  requestedBundleQty,
  branchId,
  materialSubstitutions,
  onApplySubstitution,
  onRemoveSubstitution,
  onPermanentSuccess,
}: BundleKitMaterialsStepProps) {
  const isConstrained = maxBundlesPossible < requestedBundleQty;
  const deficitMaterials = materials.filter((m) => !m.isSufficient);

  const [selectedMaterialForSub, setSelectedMaterialForSub] = useState<AggregatedMaterialDto | null>(null);
  const [isSubDialogOpen, setIsSubDialogOpen] = useState<boolean>(false);

  const currentSub = useMemo(() => {
    if (!selectedMaterialForSub) return null;
    const origId = selectedMaterialForSub.isSubstituted
      ? (selectedMaterialForSub.originalVariantId ?? selectedMaterialForSub.materialVariantId)
      : selectedMaterialForSub.materialVariantId;
    return materialSubstitutions.find((s) => s.originalVariantId === origId) ?? null;
  }, [selectedMaterialForSub, materialSubstitutions]);

  return (
    <div className="space-y-4" dir="rtl">
      {/* بطاقة عنق الزجاجة والسقف الحاكم */}
      <div
        className={`rounded-lg border p-4 text-sm transition-colors ${
          isConstrained
            ? "border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
            : "border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
        }`}
      >
        <div className="flex items-start gap-3">
          {isConstrained ? (
            <AlertTriangle aria-hidden className="size-6 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 aria-hidden className="size-6 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="font-bold text-base">
                {isConstrained
                  ? "عنق الزجاجة الحاكم يحد طاقة التجهيز"
                  : "المواد الخام متوفرة بالكامل"}
              </h4>
              <Badge
                variant="secondary"
                className={`text-xs whitespace-nowrap shrink-0 ${
                  isConstrained
                    ? "bg-[var(--sem-neg)] text-background"
                    : "bg-[var(--sem-pos)] text-background"
                }`}
              >
                السقف الممكن: {maxBundlesPossible} طقم
              </Badge>
            </div>

            <p className="text-xs text-foreground/80 leading-relaxed">
              {isConstrained ? (
                <>
                  بسبب شح مخزون{" "}
                  <strong className="text-foreground">
                    «{limitingFactorName ?? "مادة مقيدة"}»
                  </strong>{" "}
                  ({limitingFactorType === "RAW_MATERIAL" ? "مادة خام" : "سلعة تجارية"})،
                  فإن أقصى عدد أطقم يمكن تجهيزها بالكامل حالياً هو{" "}
                  <span className="font-bold text-[var(--sem-neg)]">
                    {maxBundlesPossible} طقم
                  </span>{" "}
                  من أصل {requestedBundleQty} مطلوب.
                </>
              ) : (
                <>
                  أرصدة المواد الخام والسلع في هذا الفرع كافية لإنتاج وتشغيل كامل الدفعة المطلوبة (
                  {requestedBundleQty} طقم) دون تعطل.
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* تنبيه سريع إن وُجد عجز في المواد */}
      {deficitMaterials.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]">
          <Gauge aria-hidden className="size-4 shrink-0" />
          <span>
            يوجد نقص في رصيد <strong>{deficitMaterials.length}</strong> مواد خام بالنسبة
            للكمية المخططة. يمكنك استبدال المادة النافذة ببديل متوفر عبر زر «استبدال ببديل» أدناه.
          </span>
        </div>
      )}

      {/* جدول المواد الخام المجمعة */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span className="font-semibold text-foreground flex items-center gap-1.5">
            <Factory aria-hidden className="size-4" />
            الاحتياج التراكمي للمواد الخام (Consolidated BOM)
          </span>
          <span>{materials.length} مواد خام مستهلكة</span>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[780px] border-collapse text-xs text-start">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                <th className="p-2.5 text-start font-medium whitespace-nowrap select-none min-w-[180px]">المادة الخام</th>
                <th className="p-2.5 text-start font-medium whitespace-nowrap select-none min-w-[100px]">SKU</th>
                <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[70px]">الوحدة</th>
                <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[120px]">الاحتياج الكلي للدفعة</th>
                <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[100px]">المتاح بالفرع</th>
                <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[90px]">حالة الكفاية</th>
                <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[90px]">صافي العجز</th>
                <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[120px]">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {materials.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-muted-foreground">
                    لا توجد مواد خام مطلوبة للتشغيل (ربما كافة المكونات متوفرة سلفاً بالفرع).
                  </td>
                </tr>
              ) : (
                materials.map((m) => (
                  <tr
                    key={m.materialVariantId}
                    className={`transition-colors ${
                      !m.isSufficient ? "bg-[var(--sem-neg-bg)]/30" : "hover:bg-muted/20"
                    }`}
                  >
                    <td className="p-2.5 font-medium text-foreground">
                      <div className="flex flex-col gap-0.5">
                        <span>{m.materialName}</span>
                        {m.isSubstituted && m.originalMaterialName && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-1 whitespace-nowrap">
                            <ArrowLeftRight aria-hidden className="size-2.5 text-primary" />
                            بديل عن «{m.originalMaterialName}»
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-2.5 font-mono text-[11px] text-muted-foreground tabular-nums" dir="ltr">
                      {m.sku}
                    </td>
                    <td className="p-2.5 text-center whitespace-nowrap">{m.unitName}</td>
                    <td className="p-2.5 text-center font-mono font-bold tabular-nums" dir="ltr">
                      {m.totalRequiredBase}
                    </td>
                    <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">
                      <span
                        className={
                          m.isSufficient
                            ? "text-[var(--sem-pos)] font-semibold"
                            : "text-[var(--sem-neg)] font-bold"
                        }
                      >
                        {m.availableInBranch}
                      </span>
                    </td>
                    <td className="p-2.5 text-center whitespace-nowrap">
                      {m.isSufficient ? (
                        <Badge
                          variant="secondary"
                          className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-none text-[10px] whitespace-nowrap shrink-0"
                        >
                          متوفر بكفاية
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-none text-[10px] whitespace-nowrap shrink-0"
                        >
                          غير كافٍ
                        </Badge>
                      )}
                    </td>
                    <td className="p-2.5 text-center font-mono tabular-nums" dir="ltr">
                      {m.isSufficient ? (
                        <span className="text-muted-foreground">0</span>
                      ) : (
                        <span className="text-[var(--sem-neg)] font-bold">
                          {m.deficitBase}
                        </span>
                      )}
                    </td>
                    <td className="p-2.5 text-center whitespace-nowrap">
                      {m.isSubstituted ? (
                        <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                          <Badge
                            variant="secondary"
                            className="bg-primary/10 text-primary border-primary/20 text-[10px] gap-1 py-0.5 whitespace-nowrap shrink-0"
                          >
                            <ArrowLeftRight aria-hidden className="size-3" />
                            مادة بديلة
                          </Badge>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-destructive hover:bg-destructive/10 px-2 gap-1 whitespace-nowrap shrink-0"
                            onClick={() => onRemoveSubstitution(m)}
                            title="إلغاء البديل والرجوع للأصل"
                          >
                            <Trash2 aria-hidden className="size-3.5" />
                            إلغاء
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground hover:bg-muted px-2 whitespace-nowrap shrink-0"
                            onClick={() => {
                              setSelectedMaterialForSub(m);
                              setIsSubDialogOpen(true);
                            }}
                            title="تغيير المادة البديلة"
                          >
                            تغيير
                          </Button>
                        </div>
                      ) : !m.isSufficient ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-7 text-xs border border-[var(--sem-neg)]/50 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] hover:bg-[var(--sem-neg)]/20 font-bold gap-1 px-2.5 shadow-xs transition-colors whitespace-nowrap shrink-0"
                          onClick={() => {
                            setSelectedMaterialForSub(m);
                            setIsSubDialogOpen(true);
                          }}
                        >
                          <ArrowLeftRight aria-hidden className="size-3.5" />
                          استبدال ببديل
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1 px-2 whitespace-nowrap shrink-0"
                          onClick={() => {
                            setSelectedMaterialForSub(m);
                            setIsSubDialogOpen(true);
                          }}
                          title="استبدال المادة بخام آخر"
                        >
                          <ArrowLeftRight aria-hidden className="size-3" />
                          استبدال
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedMaterialForSub && (
        <MaterialSubstitutionDialog
          open={isSubDialogOpen}
          onOpenChange={(next) => {
            setIsSubDialogOpen(next);
            if (!next) setSelectedMaterialForSub(null);
          }}
          recipeId={selectedMaterialForSub.recipeId ?? null}
          recipeName={selectedMaterialForSub.recipeName ?? null}
          originalVariantId={
            selectedMaterialForSub.isSubstituted
              ? (selectedMaterialForSub.originalVariantId ?? selectedMaterialForSub.materialVariantId)
              : selectedMaterialForSub.materialVariantId
          }
          originalProductName={
            selectedMaterialForSub.isSubstituted
              ? (selectedMaterialForSub.originalMaterialName ?? selectedMaterialForSub.materialName)
              : selectedMaterialForSub.materialName
          }
          originalSku={
            selectedMaterialForSub.isSubstituted
              ? (selectedMaterialForSub.originalSku ?? selectedMaterialForSub.sku)
              : selectedMaterialForSub.sku
          }
          originalQtyPerOutputBase={selectedMaterialForSub.qtyPerOutputBase ?? "1"}
          originalUnitName={selectedMaterialForSub.unitName}
          originalCostPrice={selectedMaterialForSub.costPrice ?? null}
          availableStock={selectedMaterialForSub.isSubstituted ? null : selectedMaterialForSub.availableInBranch}
          consumedQty={Number(selectedMaterialForSub.totalRequiredBase)}
          branchId={branchId}
          defaultScope="adhoc"
          currentSubstitution={currentSub}
          onApplyAdHoc={(sub) => {
            onApplySubstitution({ ...sub, recipeId: undefined });
            setIsSubDialogOpen(false);
            setSelectedMaterialForSub(null);
          }}
          onPermanentSuccess={(res) => {
            onPermanentSuccess?.(res);
            setIsSubDialogOpen(false);
            setSelectedMaterialForSub(null);
          }}
          onRemoveSubstitution={() => {
            if (selectedMaterialForSub) {
              onRemoveSubstitution(selectedMaterialForSub);
              setIsSubDialogOpen(false);
              setSelectedMaterialForSub(null);
            }
          }}
        />
      )}
    </div>
  );
}
