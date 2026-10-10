import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  MapPin,
  Package,
  Phone,
  Printer,
  ReceiptText,
  Truck,
  User,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { orderStatusLabel, orderStatusChipClass, type OnlineOrderStatus } from "@shared/onlineOrderStatus";

interface OrderQuickViewDrawerProps {
  orderId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrintLabel?: (id: number) => void;
  onPrintThermal?: (id: number) => void;
  onPrintPreparationA4?: (id: number) => void;
  onDispatch?: (order: {
    id: number;
    orderNumber: string;
    total: string;
    customerName: string | null;
    deliveryFree?: boolean;
    deliveryWaivedAmount?: string;
  }) => void;
  canDispatch?: boolean;
}

function money(v: string | number | null | undefined): string {
  return v == null || v === "" ? "0" : fmtInt(v);
}

export function OrderQuickViewDrawer({
  orderId,
  open,
  onOpenChange,
  onPrintLabel,
  onPrintThermal,
  onPrintPreparationA4,
  onDispatch,
  canDispatch,
}: OrderQuickViewDrawerProps) {
  const detailQ = trpc.storeAdmin.orders.detail.useQuery(
    { id: orderId ?? 0 },
    { enabled: !!orderId && open }
  );

  const order = detailQ.data;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full sm:max-w-xl overflow-y-auto p-0 flex flex-col">
        {/* رأس المعاينة */}
        <SheetHeader className="p-4 border-b bg-muted/40 sticky top-0 z-10">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Package className="size-5 text-primary" aria-hidden />
              <SheetTitle className="text-base font-bold font-mono">
                {order ? order.orderNumber : "تفاصيل الطلب"}
              </SheetTitle>
            </div>
            {order && (
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${orderStatusChipClass(
                  order.status as OnlineOrderStatus
                )}`}
              >
                {orderStatusLabel(order.status as OnlineOrderStatus)}
              </span>
            )}
          </div>
        </SheetHeader>

        {/* محتوى التفاصيل */}
        <div className="flex-1 p-4 space-y-4">
          {detailQ.isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
              <span className="text-xs">جارٍ تحميل بنود وبيانات الطلب…</span>
            </div>
          ) : detailQ.isError ? (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] p-3 text-xs text-[var(--sem-neg)]">
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              <span>تعذّر جلب تفاصيل الطلب: {detailQ.error.message}</span>
            </div>
          ) : order ? (
            <>
              {/* بطاقة معلومات العميل والتوصيل */}
              <div className="rounded-lg border bg-card p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground flex items-center gap-1.5">
                    <User className="size-3.5 text-muted-foreground" aria-hidden />
                    {order.customerName ?? "عميل غير مسجل"}
                  </span>
                  {order.customerPhone && (
                    <a
                      href={`tel:${order.customerPhone}`}
                      className="font-mono text-primary flex items-center gap-1 hover:underline"
                      dir="ltr"
                    >
                      <Phone className="size-3" aria-hidden />
                      {order.customerPhone}
                    </a>
                  )}
                </div>

                <div className="flex items-start gap-1.5 text-muted-foreground">
                  <MapPin className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="flex flex-col gap-0.5">
                    <span>
                      {order.governorate ?? "المحافظة غير محددة"}
                      {order.addressText ? ` — ${order.addressText}` : ""}
                    </span>
                    {order.latitude && order.longitude && (
                      <a
                        href={`https://maps.google.com/?q=${encodeURIComponent(`${order.latitude},${order.longitude}`)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline mt-0.5"
                      >
                        <ExternalLink className="size-3" aria-hidden />
                        موقع التوصيل على خرائط Google
                      </a>
                    )}
                  </div>
                </div>

                {/* الموظف المسؤول والمجهز */}
                <div className="pt-2 border-t flex flex-wrap gap-2 text-[11px]">
                  {order.claimedByName ? (
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-muted-foreground font-medium">
                      المستلم للتجهيز: <strong className="text-foreground">{order.claimedByName}</strong>
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">لم يستلم التجهيز أي موظف بعد</span>
                  )}

                  {order.preparedByName && (
                    <span className="inline-flex items-center gap-1 rounded border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] px-2 py-0.5 text-[var(--sem-pos)] font-bold">
                      <CheckCircle2 className="size-3" aria-hidden />
                      المجهّز: {order.preparedByName}
                      {order.fulfillmentDurationMinutes ? ` (${order.fulfillmentDurationMinutes} د)` : ""}
                    </span>
                  )}
                </div>
              </div>

              {/* قائمة بنود ومنتجات الطلب */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-xs text-foreground flex items-center gap-1.5">
                    <Package className="size-3.5 text-primary" aria-hidden />
                    الأصناف والمنتجات ({order.items.length})
                  </h4>
                </div>

                <div className="divide-y rounded-lg border bg-card overflow-hidden">
                  {order.items.map((it, idx) => (
                    <div key={it.id ?? idx} className="p-3 flex items-start gap-3">
                      {/* صورة المنتج المصغرة */}
                      <div className="size-12 rounded border bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                        {it.imageUrl ? (
                          <img
                            src={it.imageUrl}
                            alt={it.productName}
                            className="size-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <Package className="size-5 text-muted-foreground/50" aria-hidden />
                        )}
                      </div>

                      {/* تفاصيل الصنف */}
                      <div className="flex-1 min-w-0 space-y-1 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-bold text-foreground leading-snug">
                            {it.productName}
                          </span>
                          <span className="font-bold font-mono text-foreground shrink-0">
                            {money(it.total)} د.ع
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-[11px]">
                          {it.variantLabel && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                              {it.variantLabel}
                            </span>
                          )}
                          <span>الوحدة: {it.unitName || "قطعة"}</span>
                          <span>
                            الكمية: <strong className="text-foreground">{it.quantity}</strong> × {money(it.unitPrice)} د.ع
                          </span>
                        </div>

                        {/* التخصيص والملاحظات إن وجدت */}
                        {it.hasCustomization && it.customizationSummary && (
                          <div className="mt-1 rounded bg-[var(--sem-info-bg)] border border-[var(--sem-info)]/30 px-2 py-1 text-[11px] text-[var(--sem-info)] font-medium">
                            {it.customizationSummary}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* الملخص المالي */}
              <div className="rounded-lg border bg-card p-3 space-y-1.5 text-xs font-medium">
                <div className="flex justify-between text-muted-foreground">
                  <span>المجموع الفرعي:</span>
                  <span>{money(order.subtotal)} د.ع</span>
                </div>

                <div className="flex justify-between items-center text-muted-foreground">
                  <span>أجرة التوصيل ({order.governorate ?? "—"}):</span>
                  {order.deliveryFree ? (
                    <span className="text-[var(--sem-pos)] font-bold">
                      مجاني (تحمل المتجر {money(order.deliveryWaivedAmount)} د.ع)
                    </span>
                  ) : (
                    <span>{money(order.deliveryFee)} د.ع</span>
                  )}
                </div>

                {order.couponCode && (
                  <div className="flex justify-between text-[var(--sem-pos)]">
                    <span>خصم القسيمة ({order.couponCode}):</span>
                    <span>-{money(order.couponDiscount)} د.ع</span>
                  </div>
                )}

                <div className="pt-2 border-t flex justify-between items-center text-sm font-bold text-foreground">
                  <span>الإجمالي عند الاستلام (COD):</span>
                  <span className="text-primary font-mono text-base">{money(order.total)} د.ع</span>
                </div>
              </div>

              {/* أزرار الإجراءات والطباعة المباشرة */}
              <div className="pt-2 space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1 text-xs"
                    onClick={() => onPrintLabel?.(order.id)}
                  >
                    <Printer className="size-3.5" aria-hidden />
                    <span>ملصق الشحن</span>
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1 text-xs"
                    onClick={() => onPrintThermal?.(order.id)}
                  >
                    <ReceiptText className="size-3.5" aria-hidden />
                    <span>فاتورة حرارية</span>
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1 text-xs"
                    onClick={() => onPrintPreparationA4?.(order.id)}
                  >
                    <FileText className="size-3.5" aria-hidden />
                    <span>ورقة تجهيز A4</span>
                  </Button>
                </div>

                {canDispatch && (order.status === "CONFIRMED" || order.status === "PROCESSING") && onDispatch && (
                  <Button
                    type="button"
                    className="w-full gap-2 font-bold bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={() =>
                      onDispatch({
                        id: order.id,
                        orderNumber: order.orderNumber,
                        total: order.total,
                        customerName: order.customerName,
                        deliveryFree: order.deliveryFree,
                        deliveryWaivedAmount: order.deliveryWaivedAmount,
                      })
                    }
                  >
                    <Truck className="size-4" aria-hidden />
                    <span>إسناد الطلب لشركة/مندوب التوصيل</span>
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
