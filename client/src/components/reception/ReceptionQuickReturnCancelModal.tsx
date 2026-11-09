import { useMemo, useState } from "react";
import { FileWarning, PackageX, RotateCcw } from "lucide-react";
import { ACTION_LABELS } from "@shared/actionLabels";
import { normalizeKnownSystemBarcode } from "@shared/barcodeScanner";
import { invoiceStatusBadgeVariant, invoiceStatusLabel } from "@shared/invoiceStatus";
import { workOrderStatusBadgeCls, workOrderStatusLabel } from "@shared/workOrderStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { SalesReturnDrawer } from "@/components/invoice/SalesReturnDrawer";
import { QuickCancelInvoiceDialog } from "@/components/invoice/QuickCancelInvoiceDialog";
import ReverseDeliveryRequestDialog from "@/components/workorder/ReverseDeliveryRequestDialog";
import { WorkOrderQuickCancelDialog } from "@/components/workorder/WorkOrderQuickCancelDialog";
import { receptionInvoiceActions, receptionOperationAllowed } from "@/lib/receptionOperationAccess";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export interface ReceptionQuickReturnCancelModalProps {
  branchId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReceptionQuickReturnCancelModal({
  branchId,
  open,
  onOpenChange,
}: ReceptionQuickReturnCancelModalProps) {
  const me = trpc.auth.me.useQuery();
  const actions = receptionInvoiceActions(me.data);
  const canReadQueue = receptionOperationAllowed(me.data, "reception.invoiceQueue");
  const canListOrders = receptionOperationAllowed(me.data, "workOrders.list");

  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"invoices" | "orders">("invoices");
  const [returnInvoiceId, setReturnInvoiceId] = useState<number | null>(null);
  const [cancelInvoiceId, setCancelInvoiceId] = useState<number | null>(null);
  const [cancelWorkOrderId, setCancelWorkOrderId] = useState<number | null>(null);

  const trimmedQ = normalizeKnownSystemBarcode(q).trim();

  const invoicesQ = trpc.reception.invoiceQueue.useQuery(
    {
      branchId,
      sinceDays: trimmedQ ? 90 : 7,
      q: trimmedQ || undefined,
      limit: 20,
    },
    { enabled: open && branchId > 0 && canReadQueue },
  );

  const ordersQ = trpc.workOrders.list.useQuery(
    {
      branchId,
      branchQueue: true,
      statuses: ["RECEIVED", "IN_PROGRESS", "READY"],
      limit: 60,
    },
    { enabled: open && branchId > 0 && canListOrders && actions.canCancelWorkOrder },
  );

  const filteredOrders = useMemo(() => {
    const rows = ordersQ.data ?? [];
    if (!trimmedQ) return rows.slice(0, 15);
    const needle = normalizeKnownSystemBarcode(trimmedQ).trim().toLowerCase();
    return rows
      .filter((r) =>
        [r.orderNumber, r.title, r.customerName, r.customerPhone]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      )
      .slice(0, 15);
  }, [ordersQ.data, trimmedQ]);

  const invoiceRows = useMemo(
    () =>
      (invoicesQ.data?.rows ?? []).filter(
        (r) =>
          r.status !== "CANCELLED" &&
          r.status !== "RETURNED" &&
          r.status !== "SUPERSEDED",
      ),
    [invoicesQ.data?.rows],
  );

  const showMatchingOrdersInline =
    tab === "invoices" &&
    trimmedQ.length > 0 &&
    invoiceRows.length === 0 &&
    filteredOrders.length > 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw aria-hidden className="size-5 text-primary" />
              مرتجع أو إلغاء سريع
            </DialogTitle>
            <DialogDescription>
              امسح الباركود أو ابحث برقم الفاتورة أو الهاتف، ثم اضغط مرتجع أو إلغاء مباشرة دون مغادرة المحطة.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <UnifiedSearchInput
              value={q}
              onChange={setQ}
              placeholder="امسح باركود الفاتورة / الطلب أو اكتب اسم أو هاتف الزبون..."
              autoFocus
            />

            {actions.canCancelWorkOrder && canListOrders ? (
              <div className="flex items-center gap-1.5 border-b pb-2">
                <Button
                  type="button"
                  size="sm"
                  variant={tab === "invoices" ? "default" : "ghost"}
                  className="h-8 text-xs"
                  onClick={() => setTab("invoices")}
                >
                  الفواتير ({invoiceRows.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={tab === "orders" ? "default" : "ghost"}
                  className="h-8 text-xs"
                  onClick={() => setTab("orders")}
                >
                  طلبات قبل التسليم ({filteredOrders.length})
                </Button>
              </div>
            ) : null}

            <div className="max-h-[55vh] overflow-y-auto space-y-2 pe-1">
              {tab === "invoices" && !showMatchingOrdersInline ? (
                invoicesQ.isLoading ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {ACTION_LABELS.loading}
                  </div>
                ) : invoiceRows.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    لا توجد فواتير قابلة للمرتجع أو الإلغاء مطابقة للبحث.
                  </div>
                ) : (
                  invoiceRows.map((r) => {
                    const isWorkOrderInvoice = r.sourceType === "WORKORDER";
                    const linkedWoId =
                      r.workOrderId ??
                      (() => {
                        const m = /^WO-(\d+)(?::R\d+)?$/.exec(String(r.sourceId ?? ""));
                        return m ? Number(m[1]) : null;
                      })();
                    const canCancelRow =
                      !isWorkOrderInvoice &&
                      r.consignmentStatus !== "DELIVERED" &&
                      r.consignmentStatus !== "PARTIAL" &&
                      (actions.canCancelInvoice || actions.canCancelUnpaidCod);

                    return (
                      <div
                        key={r.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-2.5 hover:bg-muted/30"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span dir="ltr" className="font-mono text-sm font-bold">
                              #{r.invoiceNumber}
                            </span>
                            <Badge
                              variant={invoiceStatusBadgeVariant(r.status)}
                              className="text-[11px]"
                            >
                              {invoiceStatusLabel(r.status)}
                            </Badge>
                            {r.workOrderNumber ? (
                              <span dir="ltr" className="text-xs text-muted-foreground font-mono">
                                ({r.workOrderNumber})
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {r.customerName ?? r.contactName ?? "زبون نقدي"}
                            {r.customerPhone || r.contactPhone
                              ? ` · ${r.customerPhone ?? r.contactPhone}`
                              : ""}{" "}
                            · الإجمالي <span className="font-mono font-semibold text-foreground">{fmt(r.total)}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {isWorkOrderInvoice ? (
                            actions.canReverseWorkOrder && linkedWoId ? (
                              <ReverseDeliveryRequestDialog
                                workOrderId={linkedWoId}
                                orderNumber={r.workOrderNumber ?? String(r.sourceId ?? linkedWoId)}
                                title={`فاتورة ${r.invoiceNumber}`}
                                buttonLabel="مرتجع / عكس تسليم"
                                size="sm"
                                onRequested={() => {
                                  void invoicesQ.refetch();
                                }}
                              />
                            ) : null
                          ) : (
                            <>
                              {actions.canCreateReturn ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-8 gap-1 text-xs"
                                  onClick={() => setReturnInvoiceId(r.id)}
                                >
                                  <RotateCcw aria-hidden className="size-3.5" />
                                  مرتجع
                                </Button>
                              ) : null}
                              {canCancelRow ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="destructive"
                                  className="h-8 gap-1 text-xs"
                                  onClick={() => setCancelInvoiceId(r.id)}
                                >
                                  <FileWarning aria-hidden className="size-3.5" />
                                  إلغاء
                                </Button>
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )
              ) : ordersQ.isLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {ACTION_LABELS.loading}
                </div>
              ) : filteredOrders.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  لا توجد طلبات قيد العمل مطابقة للبحث.
                </div>
              ) : (
                filteredOrders.map((wo) => (
                  <div
                    key={wo.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-2.5 hover:bg-muted/30"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span dir="ltr" className="font-mono text-sm font-bold">
                          #{wo.orderNumber}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            workOrderStatusBadgeCls(wo.status),
                          )}
                        >
                          {workOrderStatusLabel(wo.status)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {wo.title} · {wo.customerName ?? "زبون نقدي"} · السعر{" "}
                        <span className="font-mono font-semibold text-foreground">
                          {fmt(wo.salePrice)}
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="h-8 gap-1 text-xs shrink-0"
                      onClick={() => setCancelWorkOrderId(wo.id)}
                    >
                      <PackageX aria-hidden className="size-3.5" />
                      إلغاء الطلب
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SalesReturnDrawer
        invoiceId={returnInvoiceId}
        initialMode="FULL"
        onClose={() => setReturnInvoiceId(null)}
        onSuccess={() => {
          setReturnInvoiceId(null);
          void invoicesQ.refetch();
        }}
      />

      <QuickCancelInvoiceDialog
        invoiceId={cancelInvoiceId}
        open={cancelInvoiceId != null}
        onOpenChange={(v) => {
          if (!v) setCancelInvoiceId(null);
        }}
        onSwitchToReturn={(id) => setReturnInvoiceId(id)}
        onSuccess={() => {
          setCancelInvoiceId(null);
          void invoicesQ.refetch();
        }}
      />

      <WorkOrderQuickCancelDialog
        workOrderId={cancelWorkOrderId}
        onOpenChange={(v) => {
          if (!v) setCancelWorkOrderId(null);
        }}
        onSuccess={() => {
          setCancelWorkOrderId(null);
          void ordersQ.refetch();
        }}
      />
    </>
  );
}
