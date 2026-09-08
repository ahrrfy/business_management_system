import { useState } from "react";
import { Link } from "wouter";
import { Ban, Truck, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CollectConsignmentDialog } from "@/components/delivery/CollectConsignmentDialog";
import { CancelDeliveryAssignmentDialog } from "@/components/delivery/CancelDeliveryAssignmentDialog";

export interface WorkOrderDeliveryData {
  id: number | string;
  orderNumber: string;
  hasDelivery?: boolean | null;
  consignmentId?: number | null;
  consignmentNumber?: string | null;
  deliveryPartyName?: string | null;
  parcelStatus?: string | null;
  deliveryAddress?: string | null;
  customerPhone?: string | null;
  customerName?: string | null;
  deliveryCost?: string | number | null;
  salePrice?: string | number | null;
  deposit?: string | number | null;
}

export interface WorkOrderDeliverySectionProps {
  data: WorkOrderDeliveryData;
  role?: string;
  onInvalidate: () => void;
}

export function WorkOrderDeliverySection({
  data,
  role,
  onInvalidate,
}: WorkOrderDeliverySectionProps) {
  const [showCollectDelivery, setShowCollectDelivery] = useState(false);
  const [showCancelDelivery, setShowCancelDelivery] = useState(false);

  if (!data.hasDelivery && data.consignmentId == null) {
    return null;
  }

  const remainingDue = Math.max(0, Number(data.salePrice ?? 0) - Number(data.deposit ?? 0));

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="size-5 text-primary" />
            حالة التوصيل وإسناد المندوب
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {data.consignmentNumber ? (
              <span className="font-mono text-xs rounded border px-2 py-0.5 bg-background font-bold">
                إرسالية {data.consignmentNumber}
              </span>
            ) : (
              <span className="text-xs rounded border px-2 py-0.5 bg-muted text-muted-foreground">
                بانتظار الإسناد
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 text-sm">
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">جهة التوصيل المسندة</div>
              <div className="font-extrabold text-foreground mt-1">
                {data.deliveryPartyName ?? "لم تُعيَّن جهة بعد"}
              </div>
            </div>

            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">حالة مسار الطرد</div>
              <div className="font-extrabold text-foreground mt-1">
                {data.parcelStatus ? (
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                      data.parcelStatus === "DELIVERED"
                        ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                        : data.parcelStatus === "FAILED"
                        ? "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
                        : "bg-[var(--sem-info-bg)] text-[var(--sem-info)]"
                    }`}
                  >
                    {data.parcelStatus === "ASSIGNED"
                      ? "مسند للمندوب"
                      : data.parcelStatus === "ACCEPTED"
                      ? "مقبول من السائق"
                      : data.parcelStatus === "PICKED_UP"
                      ? "استلمه السائق"
                      : data.parcelStatus === "OUT_FOR_DELIVERY"
                      ? "خرج للتوصيل"
                      : data.parcelStatus === "DELIVERED"
                      ? "تم التسليم للزبون"
                      : data.parcelStatus === "FAILED"
                      ? "تعذر التسليم"
                      : data.parcelStatus}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
            </div>

            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">عنوان التوصيل</div>
              <div className="font-medium text-foreground mt-1 truncate" title={data.deliveryAddress ?? "—"}>
                {data.deliveryAddress ?? "—"}
              </div>
            </div>

            <div className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">هاتف المستلم</div>
              <div className="font-mono text-foreground mt-1" dir="ltr">
                {data.customerPhone ?? "—"}
              </div>
            </div>
          </div>

          {/* أزرار الإجراءات الخاصة بالتوصيل */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
            {/* إلغاء الإسناد إذا أُسند بالخطأ ولم يُحصّل */}
            {data.consignmentId != null &&
              (data.parcelStatus === "ASSIGNED" || data.parcelStatus === "FAILED") &&
              (role === "admin" || role === "manager") && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-1.5"
                  onClick={() => setShowCancelDelivery(true)}
                  title="إلغاء إسناد هذا الطرد للمندوب وإعادته للفرز"
                >
                  <Ban className="size-4" /> إلغاء إسناد المندوب
                </Button>
              )}

            {/* تسجيل التحصيل إذا سُلّم أو لضبط التحصيل */}
            {data.consignmentId != null && (
              <Button
                size="sm"
                variant="default"
                className="gap-1.5 font-bold"
                onClick={() => setShowCollectDelivery(true)}
                title="قبض النقد من المندوب وإصدار سند التوريد"
              >
                <Wallet className="size-4" /> قبض وتحصيل التوصيل
              </Button>
            )}

            {/* رابط سريع لطاولة التوصيل */}
            <Button size="sm" variant="outline" asChild className="gap-1">
              <Link href="/delivery?tab=transit">
                <Truck className="size-4" /> طاولة التوصيل الكاملة
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* حوار التحصيل والتوريد لأمر الشغل */}
      {showCollectDelivery && data.consignmentId != null && (
        <CollectConsignmentDialog
          consignment={{
            id: Number(data.consignmentId),
            consignmentNumber: data.consignmentNumber,
            partyId: 0,
            partyName: data.deliveryPartyName,
            orderNumber: data.orderNumber,
            customerName: data.customerName,
            recipientPhone: data.customerPhone,
            codDue: remainingDue,
            codAmount: remainingDue,
            parcelStatus: data.parcelStatus,
          }}
          open={showCollectDelivery}
          onOpenChange={setShowCollectDelivery}
          onCompleted={() => {
            setShowCollectDelivery(false);
            onInvalidate();
          }}
        />
      )}

      {/* حوار إلغاء إسناد التوصيل لأمر الشغل */}
      {showCancelDelivery && data.consignmentId != null && (
        <CancelDeliveryAssignmentDialog
          consignment={{
            id: Number(data.consignmentId),
            number: data.consignmentNumber ?? String(data.consignmentId),
          }}
          open={showCancelDelivery}
          onOpenChange={setShowCancelDelivery}
          onCompleted={() => {
            setShowCancelDelivery(false);
            onInvalidate();
          }}
        />
      )}
    </>
  );
}
