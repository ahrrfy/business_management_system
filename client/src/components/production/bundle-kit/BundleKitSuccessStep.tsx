import { CheckCircle2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatIqd } from "@/lib/money";
import type { ProduceBundleComponentsResult } from "@shared/bundleProductionTypes";

interface BundleKitSuccessStepProps {
  result: ProduceBundleComponentsResult;
  onProduceAnother: () => void;
  onClose: () => void;
}

export function BundleKitSuccessStep({
  result,
  onProduceAnother,
  onClose,
}: BundleKitSuccessStepProps) {
  return (
    <div className="space-y-4 p-4 text-center" dir="rtl">
      <div className="flex justify-center">
        <div className="rounded-full bg-[var(--sem-pos-bg)] p-3 text-[var(--sem-pos)]">
          <CheckCircle2 className="size-12" />
        </div>
      </div>

      <div className="space-y-1">
        <h3 className="font-bold text-lg text-foreground">
          تم توليد وترحيل أوامر إنتاج البكج بنجاح!
        </h3>
        <p className="text-xs text-muted-foreground font-mono tabular-nums" dir="ltr">
          {result.bundleDocGroupRef}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg mx-auto text-start">
        <div className="rounded-lg border bg-card p-3">
          <span className="text-[11px] text-muted-foreground block">
            إجمالي تكلفة كافة أوامر الإنتاج
          </span>
          <span className="font-bold text-base text-[var(--sem-pos)] font-mono tabular-nums" dir="ltr">
            {formatIqd(result.totalCostAllOrders)}
          </span>
        </div>

        <div className="rounded-lg border bg-card p-3">
          <span className="text-[11px] text-muted-foreground block">
            تكلفة وحدة البكج المحدثة (WAVG)
          </span>
          <span className="font-bold text-base text-foreground font-mono tabular-nums" dir="ltr">
            {formatIqd(result.updatedBundleUnitCost)}
          </span>
        </div>
      </div>

      <div className="max-w-xl mx-auto rounded-lg border text-start overflow-hidden">
        <div className="bg-muted/60 p-2 text-xs font-semibold">
          المستندات الصادرة ({result.orders.length} أمر إنتاج):
        </div>
        <div className="divide-y max-h-48 overflow-y-auto">
          {result.orders.map((o) => (
            <div
              key={o.productionOrderId}
              className="p-2.5 flex items-center justify-between text-xs hover:bg-muted/20"
            >
              <div>
                <span className="font-bold">{o.productName}</span>
                <span className="text-muted-foreground ms-2 whitespace-nowrap">
                  (سليم: <span className="font-mono tabular-nums" dir="ltr">{o.goodQty}</span>)
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-muted-foreground tabular-nums" dir="ltr">
                  {o.docNumber}
                </span>
                <span className="font-bold text-[var(--sem-pos)] font-mono tabular-nums" dir="ltr">
                  {formatIqd(o.totalCost)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between max-w-xl mx-auto pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 whitespace-nowrap shrink-0"
          onClick={onProduceAnother}
        >
          <RotateCcw className="size-4" />
          إنتاج دفعة أخرى
        </Button>
        <Button type="button" size="sm" className="whitespace-nowrap shrink-0" onClick={onClose}>
          إغلاق النافذة
        </Button>
      </div>
    </div>
  );
}
