import { Link } from "wouter";
import { TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, ExternalLink, MessageSquarePlus } from "lucide-react";
import { fmtAr as fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { workOrderStatusLabel } from "@shared/workOrderStatus";
import type { RouterOutputs } from "@/lib/trpc";
type Dossier = NonNullable<RouterOutputs["customers"]["dossier360"]>;
export function CustomerDossierTimeline({
  dossier,
  customerId,
  onComplaint,
}: {
  dossier: Pick<Dossier, "recentInvoices" | "recentWorkOrders">;
  customerId: number;
  onComplaint: (id: number, number: string) => void;
}) {
  return (
    <>
      {" "}
      <TabsContent value="timeline" className="space-y-4 pt-3">
        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span>آخر فواتير المبيعات</span>
            <Link
              href={`/invoices?customerId=${customerId}`}
              className="text-primary hover:underline text-[11px] flex items-center gap-1"
            >
              <span>عرض الكل</span>
              <ExternalLink aria-hidden className="size-3" />
            </Link>
          </div>

          {dossier.recentInvoices.length === 0 ? (
            <div className="p-4 rounded-md border border-dashed text-center text-xs text-muted-foreground">
              لا توجد فواتير مبيعات مسجلة لهذا العميل حتى الآن.
            </div>
          ) : (
            <div className="space-y-1.5">
              {dossier.recentInvoices.map((inv) => (
                <div
                  key={inv.id}
                  className="p-2.5 rounded-md border bg-card flex items-center justify-between gap-2 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 font-medium">
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="hover:underline text-primary"
                      >
                        #{inv.invoiceNumber}
                      </Link>
                      <Badge variant="outline" className="text-[10px] py-0">
                        {invoiceStatusLabel(inv.status)}
                      </Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <Calendar aria-hidden className="size-3" />
                      <span>{fmtDate(inv.invoiceDate)}</span>
                    </div>
                  </div>
                  <div className="text-left font-bold tabular-nums">
                    {fmt(inv.total)} د.ع
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2 pt-2">
          <div className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span>آخر أوامر الشغل والإنتاج</span>
            <Link
              href={`/work-orders?customerId=${customerId}`}
              className="text-primary hover:underline text-[11px] flex items-center gap-1"
            >
              <span>عرض الكل</span>
              <ExternalLink aria-hidden className="size-3" />
            </Link>
          </div>

          {dossier.recentWorkOrders.length === 0 ? (
            <div className="p-4 rounded-md border border-dashed text-center text-xs text-muted-foreground">
              لا توجد أوامر شغل مسجلة لهذا العميل حتى الآن.
            </div>
          ) : (
            <div className="space-y-1.5">
              {dossier.recentWorkOrders.map((wo) => (
                <div
                  key={wo.id}
                  className="p-2.5 rounded-md border bg-card flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 font-medium">
                      <Link
                        href={`/work-orders/${wo.id}`}
                        className="hover:underline text-primary"
                      >
                        #{wo.orderNumber}
                      </Link>
                      <span className="text-foreground/80 truncate max-w-[200px]">
                        {wo.title}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <Badge variant="secondary" className="text-[10px] py-0">
                        {workOrderStatusLabel(wo.status)}
                      </Badge>
                      <span>· {fmtDate(wo.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-left font-bold tabular-nums">
                      {fmt(wo.totalAmount)} د.ع
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] gap-1 px-2 text-rose-700 border-rose-300 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
                      onClick={() => {
                        onComplaint(wo.id, wo.orderNumber);
                      }}
                    >
                      <MessageSquarePlus
                        aria-hidden
                        className="size-3 text-rose-600"
                      />
                      <span>تسجيل شكوى/ملاحظة</span>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </TabsContent>
    </>
  );
}
