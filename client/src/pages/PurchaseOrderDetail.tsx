import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { fmtAr, positiveDiff } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { hasModuleAccess } from "@shared/permissions";
import { PackageCheck } from "lucide-react";
import { Link, useParams } from "wouter";

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

/** نبرة الحالة عبر variants الشارة (توكنز، لا ألوان خام — حارس check:colors). */
function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "RECEIVED") return "default";
  if (status === "CANCELLED") return "destructive";
  if (status === "DRAFT") return "outline";
  return "secondary";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * تفاصيل أمر شراء — **قراءة فقط**.
 *
 * سدّ رابطٍ مكسور: «سجلّ المشتريات» و«دفتر الأستاذ» يربطان رقم الأمر بـ`/purchases/:id`
 * وكان المسار غير معرَّف في App.tsx ⇒ صفحة فارغة عند كل نقرة (تدقيق ١٧/٧، السطر ٣٤١).
 * لم يُوجَّه الرابط إلى `/purchases/:id/receive` لأنّ تلك شاشة **إجراء** لأمين المخزن،
 * بينما قارئ الأستاذ محاسبٌ/مدقّق — التوجيه إليها يخلط الأدوار ويصدّ من لا يملك الاستلام.
 *
 * التكلفة محجوبة خادمياً لغير أدواتها (`purchases.get` يُفرغ الأسعار والإجماليات إلى null)
 * ⇒ الشاشة تعرض «—» بلا منطق حجبٍ عميليّ موازٍ.
 */
export default function PurchaseOrderDetail() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId },
    { enabled: Number.isFinite(purchaseOrderId) && purchaseOrderId > 0 }
  );
  const me = trpc.auth.me.useQuery();

  const canReceive = hasModuleAccess(
    me.data?.role ?? "",
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
      ?.permissionsOverride ?? null,
    "purchases",
    "FULL"
  );

  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return <ErrorState message="رقم أمر شراء غير صالح." />;
  }
  if (po.isLoading) return <LoadingState />;
  if (po.error) return <ErrorState message={po.error.message} />;
  if (!po.data) {
    return (
      <EmptyState
        title="أمر الشراء غير موجود"
        description="قد يكون محذوفاً أو يخصّ فرعاً آخر لا تملك الاطّلاع عليه."
      />
    );
  }

  const d = po.data;
  const costHidden = d.total === null;
  const remaining = costHidden ? null : positiveDiff(d.total, d.paidAmount);
  const openForReceiving = d.status !== "RECEIVED" && d.status !== "CANCELLED";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`أمر شراء ${d.poNumber ?? `#${d.id}`}`}
        actions={
          canReceive && openForReceiving ? (
            <Button asChild size="sm">
              <Link href={`/purchases/${d.id}/receive`}>
                <PackageCheck aria-hidden className="size-4" />
                استلام
              </Link>
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">بيانات الأمر</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Field label="المورّد">
            {d.supplierId ? (
              <Link href={`/suppliers/${d.supplierId}`} className="text-primary underline-offset-2 hover:underline">
                {d.supplierName ?? `#${d.supplierId}`}
              </Link>
            ) : (
              (d.supplierName ?? "—")
            )}
          </Field>
          <Field label="التاريخ">{fmtDate(d.orderDate)}</Field>
          <Field label="الحالة">
            <Badge variant={statusVariant(d.status)}>{PO_STATUS[d.status] ?? d.status}</Badge>
          </Field>
          <Field label="العملة المتّفقة">{d.agreedCurrency ?? "IQD"}</Field>
          {d.notes ? (
            <div className="col-span-2 md:col-span-4">
              <Field label="ملاحظات">{d.notes}</Field>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">البنود</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="p-2.5 text-end font-medium">الصنف</th>
                  <th className="p-2.5 text-end font-medium">الوحدة</th>
                  <th className="p-2.5 text-end font-medium">المطلوب</th>
                  <th className="p-2.5 text-end font-medium">المستلَم</th>
                  <th className="p-2.5 text-end font-medium">سعر الوحدة</th>
                  <th className="p-2.5 text-end font-medium">الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((it) => (
                  <tr key={it.id} className="border-b last:border-0">
                    <td className="p-2.5 text-end">
                      {it.productName ?? "—"}
                      {it.variantName ? <span className="text-muted-foreground"> — {it.variantName}</span> : null}
                    </td>
                    <td className="p-2.5 text-end">{it.unitName ?? "—"}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(it.quantity)}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(it.receivedBaseQuantity)}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(it.unitPrice)}</td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(it.total)}</td>
                  </tr>
                ))}
                {d.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-muted-foreground">
                      لا بنود في هذا الأمر.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">الإجماليات</CardTitle>
        </CardHeader>
        <CardContent>
          {costHidden ? (
            <p className="text-sm text-muted-foreground">قيم التكلفة محجوبة عن صلاحيّتك.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="المجموع قبل الضريبة">{fmtAr(d.subtotal)}</Field>
              <Field label="الضريبة">{fmtAr(d.taxAmount)}</Field>
              <Field label="الشحن">{fmtAr(d.shippingCost)}</Field>
              <Field label="الكمرك">{fmtAr(d.customsCost)}</Field>
              <Field label="الإجمالي">{fmtAr(d.total)}</Field>
              <Field label="المدفوع">{fmtAr(d.paidAmount)}</Field>
              <Field label="المتبقّي">{fmtAr(remaining?.toString())}</Field>
              {d.agreedCurrency === "USD" ? <Field label="الإجمالي بالدولار">{fmtAr(d.usdTotal)}</Field> : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
