import React from "react";
import { Package, AlertTriangle, User, BadgeDollarSign, Truck, FileText, Ban } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { D, fmt, round2 } from "@/lib/money";

export interface ScannedDispatchOrder {
  id: number;
  kind?: "workOrder" | "invoice" | "onlineOrder";
  orderNumber: string;
  title: string | null;
  status?: string | null;
  branchId?: number | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryCost: string | null;
  version?: number;
  invoiceId?: number | null;
  activeConsignment?: {
    id: number;
    consignmentNumber: string;
    partyId: number;
    partyName: string | null;
    partyType: "INDIVIDUAL" | "COMPANY" | null;
    parcelStatus: string;
    moneyStatus: string;
    codAmount: string;
    collectedAmount: string;
  } | null;
}

interface Props {
  order: ScannedDispatchOrder;
  isCompanyParty: boolean;
  recipientPhone: string;
  onRecipientPhoneChange: (v: string) => void;
  recipientName: string;
  onRecipientNameChange: (v: string) => void;
  dispatchFee: string;
  onDispatchFeeChange: (v: string) => void;
  deliveryAddress: string;
  onDeliveryAddressChange: (v: string) => void;
  deliveryNotes: string;
  onDeliveryNotesChange: (v: string) => void;
  externalTrackingRef: string;
  onExternalTrackingRefChange: (v: string) => void;
  onConfirmDispatch: () => void;
  onCancel: () => void;
  onCancelAssignment?: (consignment: { id: number; number: string }) => void;
  isPending: boolean;
}

export function DispatchPreviewCard({
  order,
  isCompanyParty,
  recipientPhone,
  onRecipientPhoneChange,
  recipientName,
  onRecipientNameChange,
  dispatchFee,
  onDispatchFeeChange,
  deliveryAddress,
  onDeliveryAddressChange,
  deliveryNotes,
  onDeliveryNotesChange,
  externalTrackingRef,
  onExternalTrackingRefChange,
  onConfirmDispatch,
  onCancel,
  onCancelAssignment,
  isPending,
}: Props) {
  const docLabel =
    order.kind === "onlineOrder"
      ? "طلب متجر"
      : order.kind === "invoice"
      ? "فاتورة بيع"
      : "أمر شغل";

  const codAmount = round2(
    D(order.salePrice || "0").minus(D(order.deposit || "0")),
  ).toFixed(2);

  return (
    <Card className="overflow-hidden gap-0 py-0 shadow-sm border-primary/30" dir="rtl">
      <div className="flex items-start justify-between border-b bg-muted/40 p-4">
        <div>
          <div className="flex items-center gap-2">
            <Package aria-hidden className="size-5 text-primary" />
            <span className="text-lg font-extrabold font-mono">#{order.orderNumber}</span>
            <Badge variant="outline" className="border-green-500 text-green-600 font-bold">
              {docLabel} — جاهز
            </Badge>
          </div>
          {order.title && <p className="mt-1 text-sm text-muted-foreground">{order.title}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          مسح طلب آخر
        </Button>
      </div>

      <div className="space-y-3.5 p-4">
        {order.activeConsignment && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-destructive font-extrabold text-sm">
              <AlertTriangle className="size-4 shrink-0" />
              <span>الطلب مسند مسبقاً لجهة أخرى ولا يمكن تكرار إسناده!</span>
            </div>
            <p className="text-xs text-muted-foreground">
              جهة التوصيل الحالية:{" "}
              <strong className="text-foreground">{order.activeConsignment.partyName ?? "غير محدد"}</strong> ·
              إرسالية: <strong className="font-mono text-foreground">{order.activeConsignment.consignmentNumber}</strong> ·
              حالة الطرد: <strong className="text-foreground">{order.activeConsignment.parcelStatus}</strong>
            </p>
            <p className="text-xs text-destructive font-bold">
              يجب إلغاء الإرسالية السابقة أو استرجاعها أولاً لعزل الذمم ومنع التداخل المالي.
            </p>
            {(order.activeConsignment.parcelStatus === "ASSIGNED" ||
              order.activeConsignment.parcelStatus === "FAILED") &&
              onCancelAssignment && (
                <div className="pt-1.5 flex justify-end">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-8 gap-1.5 text-xs font-bold shadow-sm"
                    onClick={() => {
                      if (order.activeConsignment) {
                        onCancelAssignment({
                          id: order.activeConsignment.id,
                          number: order.activeConsignment.consignmentNumber,
                        });
                      }
                    }}
                  >
                    <Ban className="size-3.5" />
                    إلغاء إسناد التوصيل السابق
                  </Button>
                </div>
              )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-2 rounded-xl border bg-background p-3">
            <User aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">العميل</p>
              <p className="font-bold">{order.customerName ?? "زبون نقدي"}</p>
              {order.customerPhone && (
                <p className="text-xs text-muted-foreground font-mono" dir="ltr">
                  {order.customerPhone}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-xl border bg-background p-3">
            <BadgeDollarSign aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">القيمة والتحصيل (COD)</p>
              <p className="font-bold font-mono">{fmt(order.salePrice)} د.ع</p>
              {D(order.deposit ?? "0").gt(0) ? (
                <p className="text-xs text-emerald-600 font-bold">
                  عربون {fmt(order.deposit!)} · متبقٍّ {fmt(codAmount)} د.ع على المندوب
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  المطلوب من الزبون عند الاستلام: {fmt(codAmount)} د.ع
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-3">
          <p className="text-xs font-extrabold text-primary flex items-center gap-1.5">
            <Truck className="size-3.5" />
            تثبيت بيانات الإسناد والتوصيل
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-bold">اسم المستلم (إن اختلف عن العميل)</label>
              <Input
                value={recipientName}
                onChange={(e) => onRecipientNameChange(e.target.value)}
                placeholder={order.customerName ?? "اسم المستلم..."}
                className="h-10 bg-background"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold">هاتف المستلم</label>
              <IntlPhoneInput
                value={recipientPhone}
                onChange={onRecipientPhoneChange}
                placeholder="770 123 4567"
                className="h-10"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-bold">
                <Truck aria-hidden className="size-3.5 text-muted-foreground" />
                عنوان التوصيل
              </label>
              <Input
                value={deliveryAddress}
                onChange={(e) => onDeliveryAddressChange(e.target.value)}
                placeholder="المحافظة - المدينة - الحي - أقرب نقطة دالة..."
                className="h-10 bg-background"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold">أجرة التوصيل (د.ع)</label>
              <MoneyInput
                value={dispatchFee}
                onChange={onDispatchFeeChange}
                placeholder="0"
                className="h-10"
                ariaLabel="أجرة التوصيل"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1 text-xs font-bold">
              <FileText aria-hidden className="size-3.5 text-muted-foreground" />
              ملاحظات التوصيل
            </label>
            <Input
              value={deliveryNotes}
              onChange={(e) => onDeliveryNotesChange(e.target.value)}
              placeholder="أي تعليمات للمندوب أو وقت التسليم المفضل..."
              className="h-10 bg-background"
            />
          </div>

          {isCompanyParty && (
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs font-bold">
                <Package aria-hidden className="size-3.5 text-muted-foreground" />
                رقم تتبع / بوليصة الشركة الخارجية (اختياري)
              </label>
              <Input
                value={externalTrackingRef}
                onChange={(e) => onExternalTrackingRefChange(e.target.value)}
                placeholder="رقم البوليصة أو شحنة الشركة..."
                className="h-10 bg-background font-mono text-xs"
                dir="ltr"
              />
            </div>
          )}
        </div>

        <Button
          className="w-full py-6 text-base font-extrabold"
          onClick={onConfirmDispatch}
          disabled={isPending || !!order.activeConsignment}
        >
          {order.activeConsignment
            ? "مسند مسبقاً للإرسالية " + order.activeConsignment.consignmentNumber
            : isPending
            ? "جارٍ الإسناد ذرياً…"
            : D(dispatchFee || "0").gt(0)
            ? `تأكيد الإسناد للمندوب · أجرة ${fmt(dispatchFee)} د.ع`
            : "تأكيد الإسناد للمندوب"}
        </Button>
      </div>
    </Card>
  );
}
