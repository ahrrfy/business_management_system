import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { D, fmtAr, positiveDiff } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { hasModuleAccess } from "@shared/permissions";
import { Banknote, Pencil } from "lucide-react";
import { Link, useParams } from "wouter";
import { PurchaseOrderGovernance } from "@/components/purchases/PurchaseOrderGovernance";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";

/** بندُ أمر الشراء — مشتقٌّ من عقد `purchases.get` فلا ينجرف عن الخادم. */
type PoItemRow = NonNullable<RouterOutputs["purchases"]["get"]>["items"][number];

/**
 * أعمدة البنود. تُبنى بدالّة لأنّ رؤوسها وقيمها تتبع عملة الأمر: أمرُ الدولار
 * يعرض `usdUnitPrice`/`usdTotal` ورأسَه بعلامة `($)`.
 */
function poItemColumns(isUsd: boolean): ColumnDef<PoItemRow, unknown>[] {
  return [
    {
      id: "product",
      header: "الصنف",
      accessorFn: (it) => (it.productName ?? "—") + (it.variantName ? " — " + it.variantName : ""),
      meta: { width: "wide" },
      cell: ({ row }) => (
        <>
          {row.original.productName ?? "—"}
          {row.original.variantName ? <span className="text-muted-foreground"> — {row.original.variantName}</span> : null}
        </>
      ),
    },
    { id: "unit", header: "الوحدة", accessorFn: (it) => it.unitName ?? "—", cell: ({ row }) => row.original.unitName ?? "—" },
    { id: "quantity", header: "الكمية", accessorFn: (it) => fmtAr(it.quantity), meta: { kind: "number" }, cell: ({ row }) => fmtAr(row.original.quantity) },
    {
      // الطرفان بوحدة الأساس: `quantity` بوحدة الشراء و`receivedBaseQuantity` بالأساس،
      // فمقارنتهما مباشرةً تُظهر «٢ مطلوب / ٢٤ مستلَم» لكرتونٍ من ١٢.
      id: "received",
      header: "المستلَم / المطلوب (أساس)",
      accessorFn: (it) => fmtAr(it.receivedBaseQuantity) + " / " + fmtAr(it.baseQuantity),
      meta: { kind: "number" },
      cell: ({ row }) => fmtAr(row.original.receivedBaseQuantity) + " / " + fmtAr(row.original.baseQuantity),
    },
    {
      id: "unitPrice",
      header: isUsd ? "سعر الوحدة ($)" : "سعر الوحدة",
      accessorFn: (it) => fmtAr(isUsd ? it.usdUnitPrice : it.unitPrice),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(isUsd ? row.original.usdUnitPrice : row.original.unitPrice),
    },
    {
      id: "total",
      header: isUsd ? "الإجمالي ($)" : "الإجمالي",
      accessorFn: (it) => fmtAr(isUsd ? it.usdTotal : it.total),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(isUsd ? row.original.usdTotal : row.original.total),
    },
  ];
}

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

/** نبرة الحالة عبر variants الشارة (توكنز، لا ألوان خام — حارس check:colors). */
function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "RECEIVED") return "default";
  if (status === "CANCELLED") return "destructive";
  if (status === "DRAFT") return "outline";
  return "secondary";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
 * الاعتماد النهائي هو إجراء الاستلام والترحيل نفسه؛ لا توجد شاشة استلام مستقلة.
 *
 * التكلفة محجوبة خادمياً لغير أدواتها (`purchases.get` يُفرغ الأسعار والإجماليات إلى null)
 * ⇒ الشاشة تعرض «—» بلا منطق حجبٍ عميليّ موازٍ.
 */
export default function PurchaseOrderDetail() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId },
    { enabled: Number.isFinite(purchaseOrderId) && purchaseOrderId > 0 },
  );
  const me = trpc.auth.me.useQuery();

  const canEdit = hasModuleAccess(
    me.data?.role ?? "",
    (
      me.data as
        | {
            permissionsOverride?: Record<
              string,
              "NONE" | "READ" | "FULL"
            > | null;
          }
        | undefined
    )?.permissionsOverride ?? null,
    "purchases",
    "FULL",
  );

  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return <ErrorState message="رقم أمر شراء غير صالح." />;
  }
  if (po.isLoading) return <LoadingState />;
  // دورٌ مُنح «التقارير» صراحةً دون «المشتريات» يعبُر سجلّ المشتريات/الأستاذ (بوّابة reports)
  // ثمّ يصطدم هنا بـFORBIDDEN لأنّ `purchases.get` يلزمه purchases≥READ. لا نُوسّع الإجراء
  // (يسرّب تكلفة الشراء لأدوارٍ لم تُمنَحها) — نشرح السبب بدل خطأٍ خام.
  if (po.error) {
    return po.error.data?.code === "FORBIDDEN" ? (
      <EmptyState
        title="لا تملك صلاحية «المشتريات»"
        description="تفاصيل أمر الشراء تتطلّب صلاحية المشتريات (قراءة) — اطلبها من المدير."
      />
    ) : (
      <ErrorState message={po.error.message} />
    );
  }
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
  const isUsd = d.agreedCurrency === "USD";
  // المتبقّي للمورّد بعملة الاتفاق: أمر الدولار تُتابَع ذمّته بـusdTotal−paidUsd−returnedUsd
  // (نفس حساب PurchaseReceive وخدمة التسوية) — عرض متبقّي الدينار وحده يُظهر رقماً مختلفاً مادّياً.
  const remaining = costHidden
    ? null
    : isUsd
      ? positiveDiff(
          d.usdTotal,
          D(d.paidUsd ?? 0)
            .plus(D(d.returnedUsd ?? 0))
            .toString(),
        )
      : positiveDiff(d.total, d.paidAmount);
  // التعديل ممكن ما لم يبدأ الأثر الفعليّ: أمرٌ نهائيّ، أو استُلم منه سطر، أو حمل دفعة.
  // نفس حرّاس `updatePurchaseOrder` — والخادم هو الحكم النهائيّ.
  const openForEditing =
    d.status === "DRAFT" &&
    !d.items.some((it) => (it.receivedBaseQuantity ?? 0) > 0) &&
    !D(d.paidAmount ?? 0).gt(0) &&
    !D(d.paidUsd ?? 0).gt(0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`أمر شراء ${d.poNumber ?? `#${d.id}`}`}
        actions={
          canEdit && openForEditing ? (
            <div className="flex items-center gap-2">
              {openForEditing ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/purchases/${d.id}/edit`}>
                    <Pencil aria-hidden className="size-4" />
                    تعديل
                  </Link>
                </Button>
              ) : null}
            </div>
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
              <Link
                href={`/suppliers/${d.supplierId}/edit`}
                className="text-primary underline-offset-2 hover:underline"
              >
                {d.supplierName ?? `#${d.supplierId}`}
              </Link>
            ) : (
              (d.supplierName ?? "—")
            )}
          </Field>
          <Field label="التاريخ">{fmtDate(d.orderDate)}</Field>
          <Field label="الحالة">
            <Badge variant={statusVariant(d.status)}>
              {PO_STATUS[d.status] ?? d.status}
            </Badge>
          </Field>
          <Field label="العملة المتّفقة">{d.agreedCurrency ?? "IQD"}</Field>
          {d.notes ? (
            <div className="col-span-2 md:col-span-4">
              <Field label="ملاحظات">{d.notes}</Field>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* بعد cutover، الدفع يُخصَّص إلى فاتورة مورد مرحّلة لا إلى أمر الشراء مباشرةً. */}
      {canEdit &&
      d.status !== "CANCELLED" &&
      remaining != null &&
      remaining.gt(0) ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">تسديد للمورّد</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              يظهر في الأمر رصيد مرجعي قدره {fmtAr(remaining.toFixed(2))}{" "}
              {isUsd ? "$" : "د.ع"}. السداد الجديد يبدأ من فاتورة المورد
              المرحلة ويُخصَّص إليها، ولا يكتب أثراً مباشراً على الأمر.
            </p>
            <Button asChild size="sm">
              <Link href={`/purchases/supplier-payments?supplierId=${d.supplierId}`}>
                <Banknote aria-hidden className="size-4" />
                فتح تسديدات فواتير المورد
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">البنود</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* مُضمَّن: البطاقة تحمل عنوان «البنود»، والإجماليات في بطاقةٍ مستقلّة أدناه. */}
          <DataTable<PoItemRow>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            data={d.items}
            columns={poItemColumns(isUsd)}
            emptyText="لا بنود في هذا الأمر."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">الإجماليات</CardTitle>
        </CardHeader>
        <CardContent>
          {costHidden ? (
            <p className="text-sm text-muted-foreground">
              قيم التكلفة محجوبة عن صلاحيّتك.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Field label="المجموع قبل الضريبة">{fmtAr(d.subtotal)}</Field>
              {/* خصم فاتورة المورّد (0204): **مطبَّقٌ في الأعمدة أعلاه** — المجموع صافٍ بعده،
                  والذمّة وتكلفة المخزون كذلك. يُعرَض إفصاحاً لا بنداً يُطرَح مرّةً أخرى. */}
              {D(d.invoiceDiscount ?? 0).gt(0) && (
                <Field label="خصم فاتورة المورّد (مطبَّق)">
                  −{fmtAr(d.invoiceDiscount)}
                  {isUsd && D(d.usdInvoiceDiscount ?? 0).gt(0)
                    ? ` (${fmtAr(d.usdInvoiceDiscount)} $)`
                    : ""}
                </Field>
              )}
              <Field label="الضريبة">{fmtAr(d.taxAmount)}</Field>
              <Field label="الشحن">{fmtAr(d.shippingCost)}</Field>
              <Field label="الكمرك">{fmtAr(d.customsCost)}</Field>
              <Field label="الإجمالي">{fmtAr(d.total)}</Field>
              <Field label="المدفوع">{fmtAr(d.paidAmount)}</Field>
              {isUsd ? (
                <>
                  {/* مطابَقةٌ لا اشتقاق: منذ ضابط `supplierInvoiceTotal` يُرفض حفظ أمرٍ يخالف
                      قيمة فاتورة المورّد، فهذا الرقم هو رقم الورقة نفسه. */}
                  <Field label="فاتورة المورّد ($)">{fmtAr(d.usdTotal)}</Field>
                  <Field label="المدفوع ($)">{fmtAr(d.paidUsd)}</Field>
                  <Field label="المُرتجَع ($)">{fmtAr(d.returnedUsd)}</Field>
                  <Field label="المتبقّي للمورّد ($)">
                    {fmtAr(remaining?.toString())}
                  </Field>
                </>
              ) : (
                <Field label="المتبقّي">{fmtAr(remaining?.toString())}</Field>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {!costHidden ? <PurchaseOrderGovernance purchaseOrderId={purchaseOrderId} /> : null}
    </div>
  );
}
