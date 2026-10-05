import { AlertTriangle, CheckCircle2, Factory, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AggregatedMaterialDto } from "@shared/bundleProductionTypes";

interface BundleKitMaterialsStepProps {
  materials: AggregatedMaterialDto[];
  maxBundlesPossible: number;
  limitingFactorName: string | null;
  limitingFactorType: "RAW_MATERIAL" | "COMMERCIAL_COMPONENT" | null;
  requestedBundleQty: number;
}

export function BundleKitMaterialsStep({
  materials,
  maxBundlesPossible,
  limitingFactorName,
  limitingFactorType,
  requestedBundleQty,
}: BundleKitMaterialsStepProps) {
  const isConstrained = maxBundlesPossible < requestedBundleQty;
  const deficitMaterials = materials.filter((m) => !m.isSufficient);

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
            <AlertTriangle className="size-6 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="size-6 shrink-0 mt-0.5" />
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
                className={`text-xs ${
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
          <Gauge className="size-4 shrink-0" />
          <span>
            يوجد نقص في رصيد <strong>{deficitMaterials.length}</strong> مواد خام بالنسبة
            للكمية المخططة. يمكنك مراجعة العجز أدناه لتوريدها.
          </span>
        </div>
      )}

      {/* جدول المواد الخام المجمعة */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span className="font-semibold text-foreground flex items-center gap-1.5">
            <Factory className="size-4" />
            الاحتياج التراكمي للمواد الخام (Consolidated BOM)
          </span>
          <span>{materials.length} مواد خام مستهلكة</span>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs text-start">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                <th className="p-2.5 text-start font-medium">المادة الخام</th>
                <th className="p-2.5 text-start font-medium">SKU</th>
                <th className="p-2.5 text-center font-medium">الوحدة</th>
                <th className="p-2.5 text-center font-medium">الاحتياج الكلي للدفعة</th>
                <th className="p-2.5 text-center font-medium">المتاح بالفرع</th>
                <th className="p-2.5 text-center font-medium">حالة الكفاية</th>
                <th className="p-2.5 text-center font-medium">صافي العجز</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {materials.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-muted-foreground">
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
                    <td className="p-2.5 font-medium text-foreground">{m.materialName}</td>
                    <td className="p-2.5 font-mono text-[11px] text-muted-foreground" dir="ltr">
                      {m.sku}
                    </td>
                    <td className="p-2.5 text-center">{m.unitName}</td>
                    <td className="p-2.5 text-center font-mono font-bold">
                      {m.totalRequiredBase}
                    </td>
                    <td className="p-2.5 text-center font-mono">
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
                    <td className="p-2.5 text-center">
                      {m.isSufficient ? (
                        <Badge
                          variant="secondary"
                          className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-none text-[10px]"
                        >
                          متوفر بكفاية
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-none text-[10px]"
                        >
                          غير كافٍ
                        </Badge>
                      )}
                    </td>
                    <td className="p-2.5 text-center font-mono">
                      {m.isSufficient ? (
                        <span className="text-muted-foreground">0</span>
                      ) : (
                        <span className="text-[var(--sem-neg)] font-bold">
                          {m.deficitBase}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
