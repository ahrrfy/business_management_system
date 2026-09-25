import { trpc } from "@/lib/trpc";
import { fmt, D, formatQuantity, positiveDiff } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { CheckCircle2, Clock, ExternalLink } from "lucide-react";

export function PurchaseOrderDrilldownView({ poId }: { poId: number }) {
  const q = trpc.purchases.get.useQuery({ purchaseOrderId: poId });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={q.error?.message} onRetry={() => void q.refetch()} />;

  const po = q.data;
  if (!po) return <p className="text-sm text-muted-foreground text-center py-4">تعذّر العثور على أمر الشراء.</p>;

  const remaining = positiveDiff(po.total, po.paidAmount).toFixed(2);
  const isPaid = D(remaining).lte(0);

  return (
    <div className="space-y-4 pt-2 text-sm">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg bg-muted/20 p-3 border">
        <div>
          <span className="text-[11px] text-muted-foreground">رقم أمر الشراء</span>
          <p className="font-mono font-bold text-base" dir="ltr">{po.poNumber ?? `#${po.id}`}</p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">تاريخ الشراء</span>
          <p className="font-medium">{fmtDate(po.orderDate)}</p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">حالة السداد</span>
          <p className="font-semibold flex items-center gap-1">
            {isPaid ? (
              <span className="text-money-positive flex items-center gap-1">
                <CheckCircle2 className="size-3.5" />
                مسدد بالكامل
              </span>
            ) : (
              <span className="text-[var(--sem-warn)] flex items-center gap-1">
                <Clock className="size-3.5" />
                غير مسدد بالكامل
              </span>
            )}
          </p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">المورد</span>
          <p className="font-medium truncate">{po.supplierName ?? "غير محدد"}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs text-muted-foreground">إجمالي الفاتورة</span>
          <p className="text-2xl font-bold tabular-nums" dir="ltr">{fmt(po.total)} د.ع</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">المدفوع</span>
          <p className="text-lg font-bold tabular-nums text-money-positive" dir="ltr">{fmt(po.paidAmount)} د.ع</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">المتبقي</span>
          <p className="text-lg font-bold tabular-nums text-money-negative" dir="ltr">{fmt(remaining)} د.ع</p>
        </div>
      </div>

      {po.items && po.items.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-semibold text-muted-foreground">الأصناف المشتراة:</span>
          <div className="rounded-md border overflow-hidden">
            <div className="bg-muted/40 p-2 text-xs font-semibold grid grid-cols-12 gap-2 border-b">
              <span className="col-span-6">الصنف</span>
              <span className="col-span-2 text-center">الكمية</span>
              <span className="col-span-2 text-end">سعر الوحدة</span>
              <span className="col-span-2 text-end">الإجمالي</span>
            </div>
            <div className="divide-y max-h-48 overflow-y-auto">
              {po.items.map((item: any, idx: number) => (
                <div key={item.id ?? idx} className="p-2 text-xs grid grid-cols-12 gap-2 items-center">
                  <span className="col-span-6 font-medium">{item.productName ?? `صنف #${item.productId}`}</span>
                  <span className="col-span-2 text-center tabular-nums">{formatQuantity(item.quantity)}</span>
                  <span className="col-span-2 text-end tabular-nums" dir="ltr">{fmt(item.unitCost)}</span>
                  <span className="col-span-2 text-end tabular-nums font-semibold" dir="ltr">{fmt(item.subtotal)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-end pt-2 border-t">
        <Link href={`/purchases/${po.id}`}>
          <Button variant="outline" size="sm" className="gap-1.5">
            <ExternalLink className="size-3.5" />
            فتح أمر الشراء الكامل
          </Button>
        </Link>
      </div>
    </div>
  );
}
