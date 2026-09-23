import { trpc } from "@/lib/trpc";
import { fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { paymentMethodCompact, isUnifiedPaymentMethod } from "@shared/terms";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ExternalLink } from "lucide-react";

export function VoucherDrilldownView({ receiptId }: { receiptId: number }) {
  const q = trpc.vouchers.get.useQuery({ receiptId });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState message={q.error?.message} onRetry={() => void q.refetch()} />;

  const vch = q.data;
  if (!vch) return <p className="text-sm text-muted-foreground text-center py-4">تعذّر العثور على السند.</p>;

  const isReceipt = vch.direction === "IN";

  return (
    <div className="space-y-4 pt-2 text-sm">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg bg-muted/20 p-3 border">
        <div>
          <span className="text-[11px] text-muted-foreground">رقم السند</span>
          <p className="font-mono font-bold text-base" dir="ltr">{vch.voucherNumber ?? `#${vch.id}`}</p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">نوع السند</span>
          <p className="font-bold text-primary">
            {isReceipt ? "سند قبض (مقبوضات)" : "سند صرف (مدفوعات)"}
          </p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">التاريخ</span>
          <p className="font-medium">{fmtDate(vch.voucherDate ? new Date(vch.voucherDate) : vch.createdAt)}</p>
        </div>
        <div>
          <span className="text-[11px] text-muted-foreground">حالة الاعتماد</span>
          <p className="font-medium">
            {vch.approvalStatus === "APPROVED" ? (
              <span className="text-money-positive font-bold">معتمد ومرحّل</span>
            ) : vch.approvalStatus === "PENDING_APPROVAL" ? (
              <span className="text-stock-low font-bold">بانتظار الاعتماد</span>
            ) : (
              <span className="text-money-negative font-bold">مرفوض</span>
            )}
          </p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs text-muted-foreground">المبلغ المقيد</span>
          <p className="text-2xl font-bold tabular-nums text-money-positive" dir="ltr">
            {fmt(vch.amount)} د.ع
          </p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">طريقة الدفع</span>
          <p className="font-semibold">
            {isUnifiedPaymentMethod(vch.paymentMethod)
              ? paymentMethodCompact(vch.paymentMethod)
              : vch.paymentMethod ?? "نقداً"}
          </p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">الطرف</span>
          <p className="font-semibold">{vch.counterpartyName ?? vch.partyName ?? "حساب العميل"}</p>
        </div>
      </div>

      {vch.description && (
        <div className="rounded-lg border bg-muted/10 p-3 space-y-1">
          <span className="text-xs font-semibold text-muted-foreground">البيان والملاحظات:</span>
          <p className="text-xs leading-relaxed">{vch.description}</p>
        </div>
      )}

      {vch.internalNote && (
        <div className="rounded-lg border bg-muted/10 p-3 space-y-1">
          <span className="text-xs font-semibold text-muted-foreground">ملاحظة داخلية:</span>
          <p className="text-xs text-muted-foreground">{vch.internalNote}</p>
        </div>
      )}

      <div className="flex justify-end pt-2 border-t">
        <Link href={`/treasury?tab=vouchers&voucherId=${vch.id}`}>
          <Button variant="outline" size="sm" className="gap-1.5">
            <ExternalLink className="size-3.5" />
            فتح السند في وحدة الخزينة
          </Button>
        </Link>
      </div>
    </div>
  );
}
