import * as React from "react";
import { AlertTriangle, Coins, Layers, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { formatIqd } from "@/lib/money";
import { digitsArabicToLatin } from "@shared/numberNormalize";
import { normalizeSearchText } from "@shared/searchNormalize";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { BundleKitComponentBatch } from "./BundleKitComponentsStep";

export interface OpenWorkOrderOption {
  id: number;
  orderNumber: string;
  title: string;
  customerName?: string | null;
}

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
  openWorkOrders?: OpenWorkOrderOption[];
  onWorkOrderSearchChange?: (query: string) => void;
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
  openWorkOrders = [],
  onWorkOrderSearchChange,
  estimatedLaborCost,
  estimatedMaterialsCost,
  estimatedTotalCost,
  maxBundlesPossible,
  limitingFactorName,
}: BundleKitReviewStepProps) {
  const compMap = new Map<number, ComponentRequirementDto>(
    components.map((c) => [c.variantId, c]),
  );
  const selectedBatches = batches.filter((b) => b.selected && b.batchQty > 0);
  const isConstrained = maxBundlesPossible != null && maxBundlesPossible < requestedBundleQty;

  const isPickerMode = openWorkOrders.length > 0 || Boolean(onWorkOrderSearchChange);
  const [woQuery, setWoQuery] = React.useState(() =>
    linkedWorkOrderId != null ? String(linkedWorkOrderId) : "",
  );
  const [committedWO, setCommittedWO] = React.useState<OpenWorkOrderOption | null>(() =>
    linkedWorkOrderId != null
      ? (openWorkOrders.find((o) => Number(o.id) === linkedWorkOrderId) ?? null)
      : null,
  );
  const selectedWO =
    committedWO && Number(committedWO.id) === linkedWorkOrderId ? committedWO : null;

  const woMatches = React.useMemo(() => {
    const nq = normalizeSearchText(woQuery.trim());
    if (!nq || openWorkOrders.length === 0) return [];
    return openWorkOrders
      .filter((o) =>
        normalizeSearchText(`${o.id} ${o.orderNumber} ${o.title} ${o.customerName ?? ""}`).includes(nq),
      )
      .slice(0, 30);
  }, [openWorkOrders, woQuery]);

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
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 whitespace-nowrap shrink-0">
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
            ربط بطلب شغل مفتوح (اختياري)
          </Label>
          {selectedWO ? (
            <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 text-xs">
              <span className="truncate" dir="ltr">
                {selectedWO.orderNumber}{" "}
                <span className="text-muted-foreground">— {selectedWO.title}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setCommittedWO(null);
                  onLinkedWorkOrderChange(null);
                  setWoQuery("");
                  onWorkOrderSearchChange?.("");
                }}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label="إلغاء الربط"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <UnifiedSearchInput
                id="linked-wo"
                barcode={false}
                debounceMs={0}
                size="compact"
                dir="auto"
                value={woQuery}
                onChange={(val) => {
                  setWoQuery(val);
                  setCommittedWO(null);
                  const latin = digitsArabicToLatin(val).trim();
                  onWorkOrderSearchChange?.(latin);
                  if (isPickerMode) {
                    if (linkedWorkOrderId != null) {
                      onLinkedWorkOrderChange(null);
                    }
                    return;
                  }
                  if (/^\d+$/.test(latin)) {
                    const num = parseInt(latin, 10);
                    onLinkedWorkOrderChange(Number.isFinite(num) && num > 0 ? num : null);
                  } else {
                    onLinkedWorkOrderChange(null);
                  }
                }}
                onSubmit={(submitted) => {
                  const latin = digitsArabicToLatin(submitted).trim();
                  if (/^\d+$/.test(latin)) {
                    const num = parseInt(latin, 10);
                    if (Number.isFinite(num) && num > 0) {
                      const matched = openWorkOrders.find((o) => Number(o.id) === num) ?? null;
                      setCommittedWO(matched);
                      onLinkedWorkOrderChange(num);
                      setWoQuery(String(num));
                      return;
                    }
                  }
                  if (woMatches.length > 0) {
                    const chosen = woMatches[0];
                    setCommittedWO(chosen);
                    onLinkedWorkOrderChange(Number(chosen.id));
                    setWoQuery(String(chosen.id));
                  }
                }}
                placeholder="ابحث برقم الأمر/العنوان/العميل أو أدخل الرقم…"
              />
              {woQuery.trim() && openWorkOrders.length > 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md max-h-48 overflow-auto">
                  {woMatches.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">لا نتائج مطابقة.</div>
                  ) : (
                    woMatches.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => {
                          setCommittedWO(o);
                          onLinkedWorkOrderChange(Number(o.id));
                          setWoQuery(String(o.id));
                        }}
                        className="w-full text-right px-3 py-1.5 hover:bg-accent text-xs border-b last:border-b-0"
                      >
                        <span className="font-mono text-xs" dir="ltr">
                          {o.orderNumber}
                        </span>{" "}
                        — {o.title}
                        <span className="block text-[11px] text-muted-foreground">
                          {o.customerName ?? "عميل نقدي"}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
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
