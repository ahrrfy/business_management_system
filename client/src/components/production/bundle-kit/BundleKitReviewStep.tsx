import { AlertTriangle, Coins, FileText, Layers, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatIqd } from "@/lib/money";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { BundleKitComponentBatch } from "./BundleKitComponentsStep";

interface BundleKitReviewStepProps {
  bundleName: string;
  bundleSku: string;
  requestedBundleQty: number;
  components: ComponentRequirementDto[];
  batches: BundleKitComponentBatch[];
  notes: string;
  onNotesChange: (notes: string) => void;
  linkedWorkOrderId: number | null;
  onLinkedWorkOrderChange: (id: number | null) => void;
  estimatedLaborCost: string;
  estimatedMaterialsCost: string;
  estimatedTotalCost: string;
  isSubmitting: boolean;
  onSubmit: () => void;
  maxBundlesPossible?: number;
  limitingFactorName?: string | null;
}

export function BundleKitReviewStep({
  bundleName,
  bundleSku,
  requestedBundleQty,
  components,
  batches,
  notes,
  onNotesChange,
  linkedWorkOrderId,
  onLinkedWorkOrderChange,
  estimatedLaborCost,
  estimatedMaterialsCost,
  estimatedTotalCost,
  isSubmitting,
  onSubmit,
  maxBundlesPossible,
  limitingFactorName,
}: BundleKitReviewStepProps) {
  const compMap = new Map<number, ComponentRequirementDto>(
    components.map((c) => [c.variantId, c]),
  );
  const selectedBatches = batches.filter((b) => b.selected && b.batchQty > 0);
  const isConstrained = maxBundlesPossible != null && maxBundlesPossible < requestedBundleQty;

  return (
    <div className="space-y-4" dir="rtl">
      {/* تحذير عنق الزجاجة ونقص المواد إن وجد */}
      {isConstrained && (
        <div className="rounded-lg border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-3 text-xs text-[var(--sem-neg)] flex items-start gap-2.5">
          <AlertTriangle aria-hidden className="size-5 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold">تحذير: نقص في رصيد المواد الخام بالفرع</div>
            <p className="text-foreground/80 leading-relaxed">
              السقف الممكن حالياً هو <strong>{maxBundlesPossible} طقم</strong> فقط بسبب نقص «{limitingFactorName ?? "مادة مقيدة"}».
              تأكيد أمر الإنتاج بالكمية الحالية سيؤدي لفشل العملية لعدم كفاية الرصيد.
              يرجى الرجوع للخطوة السابقة واستبدال المادة النافذة ببديل متوفر.
            </p>
          </div>
        </div>
      )}

      {/* ملخص البكج والتكاليف التقديرية */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-3 space-y-1">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Layers className="size-3.5" />
            البكج المستهدف
          </span>
          <div className="font-bold text-sm truncate">{bundleName}</div>
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-muted-foreground" dir="ltr">
              {bundleSku}
            </span>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5">
              {requestedBundleQty} طقم
            </Badge>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-3 space-y-1">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Coins className="size-3.5" />
            أوامر الإنتاج المرتقبة
          </span>
          <div className="font-bold text-sm">
            {selectedBatches.length} أمر إنتاج متزامن
          </div>
          <div className="text-xs text-muted-foreground">
            تُنفذ كمعاملة ذرية شاملة (All-or-Nothing)
          </div>
        </div>

        <div className="rounded-lg border bg-card p-3 space-y-1">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Coins className="size-3.5" />
            التكلفة التقديرية الإجمالية
          </span>
          <div className="font-bold text-sm text-[var(--sem-pos)]">
            {formatIqd(estimatedTotalCost)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            مواد: {formatIqd(estimatedMaterialsCost)} + عمالة: {formatIqd(estimatedLaborCost)}
          </div>
        </div>
      </div>

      {/* قائمة الدفعات المعتمدة للإطلاق */}
      <div className="space-y-1.5">
        <h4 className="text-xs font-semibold text-foreground">
          أوامر الإنتاج التي سيتم توليدها وترحيلها:
        </h4>

        {selectedBatches.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            لم يتم اختيار أي مكونات مصنعة للإنتاج. يرجى العودة للخطوة الأولى وتحديد المكونات المطلوبة.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[650px] border-collapse text-xs text-start">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="p-2.5 text-start font-medium whitespace-nowrap select-none min-w-[180px]">المكون</th>
                  <th className="p-2.5 text-start font-medium whitespace-nowrap select-none min-w-[120px]">الوصفة</th>
                  <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[90px]">كمية الدفعة</th>
                  <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[70px]">التالف</th>
                  <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[90px]">الناتج السليم</th>
                  <th className="p-2.5 text-center font-medium whitespace-nowrap select-none min-w-[110px]">أجور العمالة/وحدة</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {selectedBatches.map((b) => {
                  const comp = compMap.get(b.variantId);
                  const goodQty = b.batchQty - b.scrapQty;

                  return (
                    <tr key={b.variantId} className="hover:bg-muted/20">
                      <td className="p-2.5">
                        <span className="font-semibold text-foreground">
                          {comp?.productName ?? `#${b.variantId}`}
                        </span>
                        <span className="block font-mono text-[10px] text-muted-foreground tabular-nums" dir="ltr">
                          {comp?.sku}
                        </span>
                      </td>
                      <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                        {comp?.recipeName ?? "وصفة أساسية"}
                      </td>
                      <td className="p-2.5 text-center font-mono font-bold tabular-nums" dir="ltr">
                        {b.batchQty}
                      </td>
                      <td className="p-2.5 text-center font-mono tabular-nums text-[var(--sem-neg)]" dir="ltr">
                        {b.scrapQty > 0 ? b.scrapQty : 0}
                      </td>
                      <td className="p-2.5 text-center font-mono tabular-nums text-[var(--sem-pos)] font-bold" dir="ltr">
                        {goodQty}
                      </td>
                      <td className="p-2.5 text-center font-mono tabular-nums whitespace-nowrap" dir="ltr">
                        {formatIqd(b.laborPerUnit || "0")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* حقول الملاحظات والربط بأمر الشغل */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
        <div className="space-y-1">
          <Label htmlFor="kit-notes" className="text-xs">
            ملاحظات التشغيل (اختياري)
          </Label>
          <Input
            id="kit-notes"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="مثال: تشغيل دفعة مستعجلة لحفل تخرج كلية الصيدلة"
            className="text-xs h-9"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="linked-wo" className="text-xs">
            رقم أمر الشغل المرتبط (اختياري)
          </Label>
          <Input
            id="linked-wo"
            type="number"
            dir="ltr"
            lang="en-US"
            value={linkedWorkOrderId ?? ""}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              onLinkedWorkOrderChange(Number.isFinite(val) && val > 0 ? val : null);
            }}
            placeholder="رقم التعريف لأمر الشغل linkedWorkOrderId"
            className="text-xs h-9 font-mono tabular-nums"
          />
        </div>
      </div>

      {/* تنبيه الأمان والضمان الذري */}
      <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-foreground">
        <ShieldCheck className="size-5 shrink-0 text-primary" />
        <span>
          <strong>ضمان المعاملة الذرية:</strong> يتم استهلاك الخامات وإنتاج كافة المكونات المحددة
          وتحديث متوسط تكلفتها المرجح ومزامنة تكلفة البكج ككل في معاملة قاعدة بيانات واحدة لا تتجزأ.
        </span>
      </div>
    </div>
  );
}
