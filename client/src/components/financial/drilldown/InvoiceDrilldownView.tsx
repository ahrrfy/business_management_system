import { trpc } from "@/lib/trpc";
import { fmt, D, formatQuantity } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { sourceTypeLabel } from "@/lib/labels";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { CheckCircle2, Clock, ExternalLink } from "lucide-react";

export function InvoiceDrilldownView({ invoiceId }: { invoiceId: number }) {
  const q = trpc.sales.get.useQuery({ invoiceId });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={q.error?.message} onRetry={() => void q.refetch()} />;

  const inv = q.data;
  if (!inv) return <p className="text-sm text-muted-foreground text-center py-4">تعذّر العثور على الفاتورة.</p>;

  const remaining = D(inv.total).minus(D(inv.paidAmount)).minus(D(inv.returnedTotal ?? "0"));
  const isPaid = remaining.lte(0);

  return (
    <div className="space-y-4 pt-2 text-sm">
      {/* رأس الفاتورة والمعلومات الأساسية */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg bg-muted/20 p-3 border">
        <div>
          <span className="text-[11px] text-muted-foreground">رقم الفاتورة</span>
          <p className="font-mono font-bold text-base" dir="ltr">{inv.invoiceNumber}</p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">تاريخ الإصدار</span>
          <p className="font-medium">{fmtDate(inv.invoiceDate)}</p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">الحالة</span>
          <div className="mt-0.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                isPaid ? "badge-status-active" : "badge-status-pending"
              }`}
            >
              {isPaid ? <CheckCircle2 className="size-3" /> : <Clock className="size-3" />}
              {invoiceStatusLabel(inv.status)}
            </span>
          </div>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">المصدر</span>
          <p className="font-medium">{sourceTypeLabel(inv.sourceType)}</p>
        </div>
      </div>

      {/* أرقام المبالغ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border bg-card p-3">
        <div className="rounded p-2 bg-muted/10">
          <span className="text-xs text-muted-foreground">المبلغ الإجمالي</span>
          <p className="text-lg font-bold tabular-nums" dir="ltr">{fmt(inv.total)} د.ع</p>
        </div>
        <div className="rounded p-2 bg-money-positive/5 border border-money-positive/20">
          <span className="text-xs text-muted-foreground">المدفوع المسدد</span>
          <p className="text-lg font-bold text-money-positive tabular-nums" dir="ltr">{fmt(inv.paidAmount)} د.ع</p>
        </div>
        <div className="rounded p-2 bg-muted/10">
          <span className="text-xs text-muted-foreground">المسترجع</span>
          <p className="text-lg font-bold tabular-nums" dir="ltr">{fmt(inv.returnedTotal ?? "0")} د.ع</p>
        </div>
        <div
          className={`rounded p-2 border ${
            remaining.gt(0)
              ? "bg-money-negative/5 border-money-negative/30 text-money-negative"
              : "bg-muted/10 text-muted-foreground"
          }`}
        >
          <span className="text-xs">المتبقي المطلوب</span>
          <p className="text-lg font-bold tabular-nums" dir="ltr">
            {remaining.gt(0) ? `${fmt(remaining.toFixed(2))} د.ع` : "0.00 د.ع"}
          </p>
        </div>
      </div>

      {/* بنود الفاتورة إن وجدت */}
      {inv.items && inv.items.length > 0 && (
        <div className="space-y-2 border rounded-lg p-3">
          <span className="font-semibold text-xs text-muted-foreground">بنود الفاتورة ({inv.items.length})</span>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {inv.items.map((it, idx) => (
              <div
                key={it.id ?? idx}
                className="flex items-center justify-between gap-2 p-2 rounded bg-muted/20 text-xs"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{it.productName ?? "بند خدمة / منتج"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    الكمية: <span className="font-mono">{formatQuantity(it.quantity)}</span> ×{" "}
                    <span className="font-mono" dir="ltr">{fmt(it.unitPrice)}</span> د.ع
                  </p>
                </div>
                <div className="text-left font-bold tabular-nums" dir="ltr">
                  {fmt(it.total)} د.ع
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* زر الانتقال لشاشة المبيعات الكاملة */}
      <div className="flex justify-end pt-2 border-t">
        <Link href={`/sales?invoiceId=${inv.id}`}>
          <Button variant="outline" size="sm" className="gap-1.5">
            <ExternalLink className="size-3.5" />
            فتح الفاتورة الكاملة في المبيعات
          </Button>
        </Link>
      </div>
    </div>
  );
}
