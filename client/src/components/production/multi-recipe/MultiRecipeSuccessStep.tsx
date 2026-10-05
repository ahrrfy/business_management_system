import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmt } from "@/lib/money";
import { formatQuantity } from "@shared/quantityFormat";
import type { ProduceMultiRecipeResult } from "@shared/multiRecipeProductionTypes";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { useLocation } from "wouter";

interface MultiRecipeSuccessStepProps {
  result: ProduceMultiRecipeResult;
  onClose: () => void;
}

export function MultiRecipeSuccessStep({ result, onClose }: MultiRecipeSuccessStepProps) {
  const [, setLocation] = useLocation();
  return (
    <div className="space-y-4 py-2">
      <div className="text-center space-y-1.5">
        <div className="inline-flex items-center justify-center size-12 rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] mb-1">
          <CheckCircle2 aria-hidden className="size-6" />
        </div>
        <h3 className="text-base font-bold">تم إنتاج الوصفات بنجاح!</h3>
        <p className="text-xs text-muted-foreground">
          تم إنشاء {result.orders.length} أوامر إنتاج مخزنية وتحديث أرصدة وتكاليف المنتجات ذرّياً.
        </p>
        <div className="inline-block rounded-md bg-muted px-2.5 py-1 text-xs font-mono text-muted-foreground" dir="ltr">
          {result.multiRecipeDocGroupRef}
        </div>
      </div>

      <div className="space-y-2 max-h-[260px] overflow-y-auto pe-1">
        {result.orders.map((o) => (
          <Card key={o.productionOrderId} className="border border-border/70">
            <CardContent className="p-3 flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="font-semibold text-foreground truncate">{o.outputProductName}</div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <span className="font-mono text-primary" dir="ltr">
                    {o.docNumber}
                  </span>
                  <span>·</span>
                  <span>سليم: <b className="text-foreground">{formatQuantity(o.goodQty.toString())}</b></span>
                  {o.scrapQty > 0 && (
                    <span className="text-[var(--sem-warn)]">
                      (تالف: {formatQuantity(o.scrapQty.toString())})
                    </span>
                  )}
                </div>
              </div>

              <div className="text-start shrink-0">
                <div className="text-[10px] text-muted-foreground">التكلفة الإجمالية</div>
                <div className="font-bold text-xs tabular-nums text-foreground" dir="ltr">
                  {fmt(o.totalCost)}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between pt-2 border-t text-xs">
        <span className="text-muted-foreground">إجمالي تكلفة كافة الأوامر:</span>
        <span className="font-bold text-sm tabular-nums text-primary" dir="ltr">
          {fmt(result.totalCostAllOrders)}
        </span>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            onClose();
            setLocation("/production");
          }}
        >
          <ExternalLink aria-hidden className="size-3.5" />
          سجل أوامر الإنتاج
        </Button>
        <Button type="button" size="sm" onClick={onClose}>
          إغلاق
        </Button>
      </div>
    </div>
  );
}
