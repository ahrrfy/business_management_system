import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { trpc } from "@/lib/trpc";
import { D, fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { ExternalLink, FileText, HandCoins, Printer, RotateCcw, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import { Link } from "wouter";
import { invoiceItemColumns, type InvoiceItemRow } from "./InvoiceDetailComponents";
import { invoiceStatusBadgeVariant, invoiceStatusLabel } from "@shared/invoiceStatus";
import { sourceTypeLabel } from "@/lib/labels";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { QuickSalesPaymentDialog } from "./QuickSalesPaymentDialog";
import { hasModuleAccess } from "@shared/permissions";

export interface InvoiceDetailDrawerProps {
  invoiceId: number | null;
  onClose: () => void;
  onOpenReturn?: (id: number) => void;
  onPrintThermal?: (id: number) => void;
  onPrintA4?: (id: number) => void;
}

export function InvoiceDetailDrawer({
  invoiceId,
  onClose,
  onOpenReturn,
  onPrintThermal,
  onPrintA4,
}: InvoiceDetailDrawerProps) {
  const isOpen = invoiceId != null && invoiceId > 0;
  const q = trpc.sales.get.useQuery(
    { invoiceId: invoiceId ?? 0 },
    { enabled: isOpen },
  );

  const inv = q.data;
  const total = inv ? D(inv.total) : D(0);
  const paid = inv ? D(inv.paidAmount) : D(0);
  const returned = inv ? D(inv.returnedTotal ?? "0") : D(0);
  const remaining = total.minus(paid).minus(returned);

  const me = trpc.auth.me.useQuery();
  const canWriteSales = hasModuleAccess(
    me.data?.role ?? "",
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)?.permissionsOverride ?? null,
    "sales",
    "FULL",
  );

  const canReturn =
    canWriteSales &&
    inv &&
    inv.status !== "CANCELLED" &&
    inv.status !== "RETURNED" &&
    inv.status !== "SUPERSEDED";

  const canPay =
    canWriteSales &&
    inv &&
    inv.status !== "CANCELLED" &&
    inv.status !== "RETURNED" &&
    inv.status !== "SUPERSEDED" &&
    remaining.gt(0);

  const [payOpen, setPayOpen] = useState(false);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto space-y-4"
        dir="rtl"
      >
        <SheetHeader className="border-b pb-3">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="flex items-center gap-2 text-base">
              <FileText aria-hidden className="size-5 text-primary" />
              <span>فاتورة مبيعات</span>
              <span dir="ltr" className="tabular-nums font-bold">
                {inv?.invoiceNumber ?? `#${invoiceId ?? ""}`}
              </span>
            </SheetTitle>
            {inv?.status ? (
              <Badge variant={invoiceStatusBadgeVariant(inv.status)}>
                {invoiceStatusLabel(inv.status)}
              </Badge>
            ) : null}
          </div>
        </SheetHeader>

        {q.isLoading ? <LoadingState message="جارٍ تحميل الفاتورة…" /> : null}
        {q.error ? <ErrorState message={q.error.message} /> : null}
        {!q.isLoading && !q.error && !inv ? (
          <EmptyState title="الفاتورة غير موجودة" description="قد تكون محذوفة أو غير متاحة لفرعك." />
        ) : null}

        {inv ? (
          <div className="space-y-4">
            {/* بطاقة العميل والمصدر */}
            <Card>
              <CardContent className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">العميل</div>
                  <div className="font-semibold truncate">
                    {inv.customerId ? (
                      <Link
                        href={`/customers-statement?id=${inv.customerId}`}
                        className="text-primary hover:underline"
                        title="كشف الحساب"
                      >
                        {inv.customerName ?? `#${inv.customerId}`}
                      </Link>
                    ) : (
                      inv.customerName ?? "عميل نقدي"
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">التاريخ</div>
                  <div className="tabular-nums">{fmtDate(inv.invoiceDate)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">المصدر / القناة</div>
                  <div>{sourceTypeLabel(inv.sourceType)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">طريقة الدفع</div>
                  <div>{inv.paymentMethod ? paymentMethodLabel(inv.paymentMethod) : "—"}</div>
                </div>
              </CardContent>
            </Card>

            {/* الأرقام المالية السريعة */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg border bg-card p-2 text-center">
                <div className="text-xs text-muted-foreground">الإجمالي</div>
                <div className="font-bold text-sm tabular-nums">{fmt(inv.total)} د.ع</div>
              </div>
              <div className="rounded-lg border bg-card p-2 text-center">
                <div className="text-xs text-muted-foreground">المدفوع</div>
                <div className="font-bold text-sm text-money-positive tabular-nums">
                  {fmt(inv.paidAmount)} د.ع
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2 text-center">
                <div className="text-xs text-muted-foreground">المرتجع</div>
                <div className="font-bold text-sm text-muted-foreground tabular-nums">
                  {fmt(inv.returnedTotal ?? "0")} د.ع
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2 text-center">
                <div className="text-xs text-muted-foreground">المتبقي</div>
                <div
                  className={`font-bold text-sm tabular-nums ${
                    remaining.gt(0) ? "text-money-negative" : "text-money-positive"
                  }`}
                >
                  {fmt(remaining.toFixed(2))} د.ع
                </div>
              </div>
            </div>

            {/* جدول بنود الفاتورة */}
            <div>
              <div className="text-xs font-semibold mb-1.5 flex items-center justify-between">
                <span>البنود ({inv.items.length})</span>
                {inv.notes ? (
                  <span className="text-muted-foreground font-normal">ملاحظات: {inv.notes}</span>
                ) : null}
              </div>
              <div className="rounded-md border overflow-hidden">
                <DataTable<InvoiceItemRow>
                  embedded
                  searchable={false}
                  bounded={false}
                  pageSize={Infinity}
                  data={inv.items}
                  columns={invoiceItemColumns(inv.subtotal)}
                  emptyText="لا بنود مسجلة."
                />
              </div>
            </div>

            {/* الإجراءات الموضعية المباشرة */}
            <div className="pt-2 border-t flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {canPay ? (
                  <Button size="sm" variant="outline" onClick={() => setPayOpen(true)}>
                    <HandCoins aria-hidden className="size-4 text-primary" />
                    تسديد دفعة
                  </Button>
                ) : null}
                {canReturn && onOpenReturn ? (
                  <Button size="sm" variant="outline" onClick={() => onOpenReturn(inv.id)}>
                    <RotateCcw aria-hidden className="size-4 text-warning" />
                    إرجاع أصناف
                  </Button>
                ) : null}
                {onPrintThermal ? (
                  <Button size="sm" variant="outline" onClick={() => onPrintThermal(inv.id)}>
                    <Printer aria-hidden className="size-4" />
                    طباعة حرارية
                  </Button>
                ) : null}
                {onPrintA4 ? (
                  <Button size="sm" variant="outline" onClick={() => onPrintA4(inv.id)}>
                    <Printer aria-hidden className="size-4" />
                    طباعة A4
                  </Button>
                ) : null}
                {inv.customerId ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/customers-statement?id=${inv.customerId}`}>
                      <User aria-hidden className="size-4" />
                      كشف الحساب
                    </Link>
                  </Button>
                ) : null}
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href={`/invoices/${inv.id}`}>
                  <ExternalLink aria-hidden className="size-4" />
                  الصفحة المستقلة
                </Link>
              </Button>
            </div>

            {canPay ? (
              <QuickSalesPaymentDialog
                open={payOpen}
                onClose={() => setPayOpen(false)}
                invoiceId={inv.id}
                invoiceNumber={inv.invoiceNumber}
                customerName={inv.customerName}
                remainingAmount={remaining.toFixed(2)}
                totalAmount={inv.total}
                paidAmount={inv.paidAmount}
                branchId={Number(inv.branchId)}
                onSuccess={() => {
                  void q.refetch();
                }}
              />
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
