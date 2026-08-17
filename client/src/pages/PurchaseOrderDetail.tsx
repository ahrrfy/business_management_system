import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { D, fmtAr, positiveDiff } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { hasModuleAccess } from "@shared/permissions";
import { Banknote, PackageCheck, Pencil } from "lucide-react";
import { Link, useParams } from "wouter";
import { useState } from "react";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { round2 } from "@/lib/money";

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
  const utils = trpc.useUtils();
  const [payAmount, setPayAmount] = useState("");
  const [payRequestId, setPayRequestId] = useState(() => crypto.randomUUID());
  const pay = trpc.purchases.pay.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        "أُنشئ طلب التسديد",
        `المبلغ محجوزٌ بانتظار اعتماد مالكٍ ثانٍ — لا يُصرَف ولا يُنقص المتبقّي (${r.remainingBefore}) قبله.`,
      );
      setPayAmount("");
      setPayRequestId(crypto.randomUUID());
      await utils.purchases.get.invalidate({ purchaseOrderId });
      await utils.purchases.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

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
      ? positiveDiff(d.usdTotal, D(d.paidUsd ?? 0).plus(D(d.returnedUsd ?? 0)).toString())
      : positiveDiff(d.total, d.paidAmount);
  // الاستلام مقصورٌ على CONFIRMED: `receivePurchase` يرفض كل ما عداها (purchase/receive.ts:180)
  // ⇒ إظهار الزرّ لمسوّدةٍ أو أمرٍ مُرسَل يقود المستخدم إلى رفضٍ حتميّ بعد ملء النموذج.
  const openForReceiving = d.status === "CONFIRMED";
  // التعديل ممكن ما لم يبدأ الأثر الفعليّ: أمرٌ نهائيّ، أو استُلم منه سطر، أو حمل دفعة.
  // نفس حرّاس `updatePurchaseOrder` — والخادم هو الحكم النهائيّ.
  const openForEditing =
    d.status !== "RECEIVED" &&
    d.status !== "CANCELLED" &&
    !d.items.some((it) => (it.receivedBaseQuantity ?? 0) > 0) &&
    !D(d.paidAmount ?? 0).gt(0) &&
    !D(d.paidUsd ?? 0).gt(0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`أمر شراء ${d.poNumber ?? `#${d.id}`}`}
        actions={
          canReceive && (openForEditing || openForReceiving) ? (
            <div className="flex items-center gap-2">
              {openForEditing ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/purchases/${d.id}/edit`}>
                    <Pencil aria-hidden className="size-4" />
                    تعديل
                  </Link>
                </Button>
              ) : null}
              {openForReceiving ? (
                <Button asChild size="sm">
                  <Link href={`/purchases/${d.id}/receive`}>
                    <PackageCheck aria-hidden className="size-4" />
                    استلام
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
              <Link href={`/suppliers/${d.supplierId}/edit`} className="text-primary underline-offset-2 hover:underline">
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

      {/* تسديد أمر الشراء — الفجوة التي كانت تُبقي الشراء الآجل بلا مسار إقفال: بطاقة الدفع
          تختفي فور الاستلام ولا «تسديد» في الإجراءات، فيخرج كل سدادٍ لاحق إلى سند صرفٍ عامّ
          لا يمسّ `paidAmount` ⇒ «المتبقّي» يطالب بمبلغٍ مسدَّد وخطرُ دفعٍ مكرَّر للمورّد. */}
      {canReceive && !isUsd && d.status !== "CANCELLED" && remaining != null && remaining.gt(0) ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">تسديد للمورّد</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              المتبقّي {fmtAr(remaining.toFixed(2))} د.ع. التسديد نقديّ، ويُنشأ **طلباً معلّقاً** يعتمده مالكٌ
              ثانٍ — لا يخرج المال ولا يُنقص المتبقّي قبل الاعتماد.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-40 space-y-1">
                <Label htmlFor="po-pay-amount">المبلغ</Label>
                <MoneyInput value={payAmount} onChange={setPayAmount} placeholder={remaining.toFixed(2)} />
              </div>
              <Button
                size="sm"
                disabled={pay.isPending || !D(payAmount || "0").gt(0)}
                onClick={() => {
                  const amount = round2(D(payAmount || "0"));
                  if (!amount.gt(0)) return notify.err("أدخل مبلغاً موجباً");
                  if (amount.gt(remaining)) return notify.err(`المبلغ يتجاوز المتبقّي (${fmtAr(remaining.toFixed(2))})`);
                  pay.mutate({
                    purchaseOrderId,
                    amount: amount.toFixed(2),
                    method: "CASH",
                    clientRequestId: payRequestId,
                  });
                }}
              >
                <Banknote aria-hidden className="size-4" />
                طلب تسديد
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
                  <th className="p-2.5 text-end font-medium">الكمية</th>
                  <th className="p-2.5 text-end font-medium">المستلَم / المطلوب (أساس)</th>
                  <th className="p-2.5 text-end font-medium">سعر الوحدة{isUsd ? " ($)" : ""}</th>
                  <th className="p-2.5 text-end font-medium">الإجمالي{isUsd ? " ($)" : ""}</th>
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
                    {/* الطرفان بوحدة الأساس: `quantity` بوحدة الشراء و`receivedBaseQuantity` بالأساس،
                        فمقارنتهما مباشرةً تُظهر «٢ مطلوب / ٢٤ مستلَم» لكرتونٍ من ١٢. */}
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">
                      {fmtAr(it.receivedBaseQuantity)} / {fmtAr(it.baseQuantity)}
                    </td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">
                      {fmtAr(isUsd ? it.usdUnitPrice : it.unitPrice)}
                    </td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">
                      {fmtAr(isUsd ? it.usdTotal : it.total)}
                    </td>
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
              {isUsd ? (
                <>
                  <Field label="فاتورة المورّد ($)">{fmtAr(d.usdTotal)}</Field>
                  <Field label="المدفوع ($)">{fmtAr(d.paidUsd)}</Field>
                  <Field label="المُرتجَع ($)">{fmtAr(d.returnedUsd)}</Field>
                  <Field label="المتبقّي للمورّد ($)">{fmtAr(remaining?.toString())}</Field>
                </>
              ) : (
                <Field label="المتبقّي">{fmtAr(remaining?.toString())}</Field>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
