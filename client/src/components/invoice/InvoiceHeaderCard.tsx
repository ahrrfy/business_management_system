import { Link } from "wouter";
import { Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CopyInline } from "@/components/CopyButton";
import InvoiceChannelBadge from "@/components/InvoiceChannelBadge";
import { Field, SummaryRow, type InvoiceDetailData } from "@/components/invoice/InvoiceDetailComponents";
import { invoiceStatusLabel, invoiceStatusBadgeVariant } from "@shared/invoiceStatus";
import { paymentMethodClass, paymentMethodLabel } from "@/lib/paymentMethod";
import { shiftTypeLabel, sourceTypeLabel } from "@/lib/labels";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { D, fmt, round2 } from "@/lib/money";

interface InvoiceHeaderCardProps {
  data: InvoiceDetailData;
  remaining: ReturnType<typeof round2>;
  canOpenStatement: boolean;
}

export function InvoiceHeaderCard({
  data,
  remaining,
  canOpenStatement,
}: InvoiceHeaderCardProps) {
  const hasDiscount = D(data.discountAmount ?? "0").gt(0);
  const hasTax = D(data.taxAmount ?? "0").gt(0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <CopyInline value={data.invoiceNumber} />
          <div className="flex items-center gap-2">
            {/* بالطريق مع المندوب ⇒ الحقيقة «عند الاستلام» لا طريقة السلة المخزَّنة */}
            {data.consignmentStatus === "DISPATCHED" || data.consignmentStatus === "PARTIAL" ? (
              <span
                className="text-xs rounded-full px-2.5 py-0.5 font-semibold badge-stock-low"
                title={
                  D(data.paidAmount).gt(0) && data.paymentMethod
                    ? `المتبقّي يُحصَّل عند الاستلام — المقبوض سلفاً بطريقة: ${paymentMethodLabel(data.paymentMethod)}`
                    : "تُحصَّل عند الاستلام عبر المندوب ثم تُورَّد"
                }
              >
                عند الاستلام (COD)
              </span>
            ) : (
              data.paymentMethod && (
                <span
                  className={`text-xs rounded-full px-2.5 py-0.5 font-semibold ${paymentMethodClass(data.paymentMethod)}`}
                  title="طريقة الدفع المسجّلة على هذه الفاتورة"
                >
                  {paymentMethodLabel(data.paymentMethod)}
                </span>
              )
            )}
            {/* التمييز البصريّ «مُعدَّلة» */}
            {data.correctionOfInvoiceId != null && (
              <Link
                href={`/invoices/${data.correctionOfInvoiceId}`}
                className="rounded-full bg-[var(--sem-warn-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--sem-warn)]"
                title="فاتورةٌ مُعدَّلة — اضغط لعرض الأصل المُستبدَل"
              >
                مُعدَّلة
              </Link>
            )}
            <Badge variant={invoiceStatusBadgeVariant(data.status)} className="text-xs">
              {invoiceStatusLabel(data.status)}
            </Badge>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-5 md:grid-cols-3">
          {/* البيانات الوصفية */}
          <div className="md:col-span-2 grid grid-cols-2 gap-x-6 gap-y-4 text-sm content-start">
            <Field label="القناة">
              <span className="inline-flex items-center gap-1.5">
                <InvoiceChannelBadge row={data} />
                <span className="text-xs text-muted-foreground">{sourceTypeLabel(data.sourceType)}</span>
              </span>
            </Field>
            <Field label="العميل">
              {data.customerId && canOpenStatement ? (
                <Link
                  href={`/customers-statement?id=${data.customerId}`}
                  className="text-primary hover:underline"
                  title="فتح كشف حساب العميل"
                >
                  {data.customerName ?? `#${data.customerId}`}
                </Link>
              ) : (
                data.customerName ?? "عميل نقدي"
              )}
            </Field>
            <Field label="موظف المبيعات">{data.salespersonName ?? "—"}</Field>
            <Field label="الوردية">
              {data.shiftId
                ? `#${data.shiftId} — ${shiftTypeLabel(data.shiftType)}`
                : "—"}
            </Field>
            <Field label="محطة البيع">
              <span dir="ltr" className="font-mono text-xs">
                {data.deviceId ?? "—"}
              </span>
            </Field>
            <Field label="التاريخ">{fmtDate(data.invoiceDate)}</Field>
            <Field label="الاستحقاق">
              {data.dueDate ? String(data.dueDate).slice(0, 10) : "—"}
            </Field>
            {data.customerId && (
              <div className="col-span-2 space-y-0.5">
                <div className="text-xs text-muted-foreground">
                  ذمة العميل الحالية
                </div>
                <div className="font-medium tabular-nums" dir="ltr">
                  <CopyInline
                    value={data.customerBalance ?? "0"}
                    display={fmt(data.customerBalance ?? "0")}
                    mono={false}
                  />
                </div>
              </div>
            )}
          </div>

          {/* لوحة الملخّص المالي */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5 text-sm self-start">
            <SummaryRow label="قبل الضريبة" value={data.subtotal} />
            {hasDiscount && (
              <SummaryRow label="الخصم" value={data.discountAmount} />
            )}
            {hasTax && (
              <SummaryRow
                label={`الضريبة (${data.taxRatePercent ?? "0"}٪)`}
                value={data.taxAmount}
              />
            )}
            {Number(data.deliveryFee ?? 0) > 0 ? (
              <SummaryRow label="أجرة التوصيل" value={data.deliveryFee} />
            ) : data.deliveryFree ? (
              <div className="flex items-center justify-between py-1 text-sm">
                <span className="text-muted-foreground">التوصيل</span>
                <span className="badge-status-active rounded-md px-1.5 py-0.5 text-xs font-extrabold">
                  {Number(data.deliveryWaivedAmount ?? 0) > 0
                    ? `مجاناً — قيمته ${fmt(data.deliveryWaivedAmount)} د.ع`
                    : "مجاناً"}
                </span>
              </div>
            ) : null}
            <div className="border-t pt-2.5">
              <SummaryRow label="الإجمالي" value={data.total} strong />
            </div>
            {data.courierName && Number(data.courierFee ?? 0) > 0 && (
              <div className="mt-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 font-bold text-[var(--sem-warn)]">
                    <Truck aria-hidden className="size-3.5" /> أجرة التوصيل ({data.courierFeeCollection === "COUNTER" ? "مقبوضة في الاستقبال" : data.courierFeeCollection === "SHOP" ? "على المكتبة" : `يقبضها ${data.courierName}`})
                  </span>
                  <span className="font-black tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(data.courierFee)}</span>
                </div>
                {data.courierFeeCollection !== "SHOP" && (
                  <div className="mt-1.5 flex items-center justify-between border-t border-[var(--sem-warn)]/30 pt-1.5 font-black text-[var(--sem-warn)]">
                    <span>المجموع النهائي (يدفعه الزبون شاملاً التوصيل)</span>
                    <span className="tabular-nums" dir="ltr">
                      {fmt(
                        round2(
                          D(data.total).plus(D(data.courierFee ?? 0)),
                        ).toFixed(2),
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}
            {data.consignmentNumber && (
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 rounded-md border px-2.5 py-2 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <Truck aria-hidden className="size-3.5 text-muted-foreground" />
                  إرسالية{" "}
                  <span className="font-mono font-bold" dir="ltr">{data.consignmentNumber}</span>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                      data.consignmentStatus === "DELIVERED"
                        ? "badge-status-active"
                        : data.consignmentStatus === "RETURNED" ||
                            data.consignmentStatus === "WRITTEN_OFF"
                          ? "badge-stock-out"
                          : "badge-stock-low"
                    }`}>
                    {data.consignmentStatus === "DISPATCHED" ? "بالطريق"
                      : data.consignmentStatus === "PARTIAL" ? "حُصِّل جزئياً"
                      : data.consignmentStatus === "DELIVERED" ? "سُلِّمت"
                      : data.consignmentStatus === "RETURNED" ? "أُرجعت"
                      : data.consignmentStatus === "WRITTEN_OFF" ? "شُطبت" : data.consignmentStatus}
                  </span>
                </span>
                <a className="text-xs font-bold text-primary hover:underline" href={`/delivery?tab=parties&detail=${data.deliveryPartyId ?? ""}`}>
                  {data.courierName ?? "جهة التوصيل"} — كشف الجهة
                </a>
              </div>
            )}
            <SummaryRow label="المدفوع" value={data.paidAmount} />
            <SummaryRow
              label="المتبقّي"
              value={remaining.toFixed(2)}
              tone={remaining.gt(0) ? "amber" : "emerald"}
            />
          </div>
        </div>

        {data.notes && (
          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <div className="text-xs text-muted-foreground mb-1">ملاحظات</div>
            <div className="whitespace-pre-wrap">{data.notes}</div>
          </div>
        )}
        {data.status === "CANCELLED" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            ألغيت بواسطة:{" "}
            <strong>{data.cancelledByName ?? "غير موثّق"}</strong>
            {data.cancelledAt ? ` — ${fmtDateTime(data.cancelledAt)}` : ""}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
