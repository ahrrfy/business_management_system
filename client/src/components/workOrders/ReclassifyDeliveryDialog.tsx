/**
 * ReclassifyDeliveryDialog — حوار «تغيير طريقة التسليم» (استلام مباشر ⇄ توصيل).
 *
 * الاستعمال (Slice C، ٢٩/٨/٢٦):
 * - استُخرِج من ReceptionOrderQueue بعد بلاغ المالك: «الاسناد يحتوي على مشكلة فهو يسند الطلب منذ
 *   البداية، ونحن اساساً لا نعلم هل الشركة ام المندوب الذي سوف يكون الموصل الحقيقي للطلب».
 * - يُستعمَل الآن في مكانَين: طابور الاستقبال + شاشة تفاصيل أمر الشغل (WorkOrderDetail) — الأخيرة
 *   كانت بلا زرِّ تحويلٍ إطلاقاً، فمن يفتح الأمر من قائمةٍ عامة لا يستطيع تحويله بلا العودة للطابور.
 *
 * التفويض: يتبع بوّابات `workOrders.setDeliveryMethod` الخادميّة (workordersCashierProcedure).
 * الحارس النقديّ لأمانة الأجرة (COUNTER → استلام مباشر ⇒ ردّ نقديّ) يعمل بنفس منطق ReceptionOrderQueue
 * الأصليّ (deliveryFeeHeld query + confirmFeeRefund + refundShiftId عند تعدّد الأدراج).
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Store, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** الحقول الدنيا اللازمة للحوار — تُغطّي كلَّ ما تُظهره RouterOutputs["workOrders"]["list"][n] و
 *  RouterOutputs["workOrders"]["detail"] بلا تحويل. */
export interface ReclassifyOrder {
  id: number;
  orderNumber: string;
  title: string;
  hasDelivery?: boolean | null;
  deliveryAddress?: string | null;
  deliveryPhone?: string | null;
  deliveryCost?: string | null;
  customerPhone?: string | null;
}

export interface ReclassifyPayload {
  hasDelivery: boolean;
  deliveryAddress?: string | null;
  deliveryPhone?: string | null;
  deliveryCost?: string | null;
  confirmFeeRefund?: boolean;
  refundShiftId?: number | null;
}

export function ReclassifyDeliveryDialog({
  order,
  pending,
  onClose,
  onConfirm,
}: {
  order: ReclassifyOrder | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (payload: ReclassifyPayload) => void;
}) {
  const [hasDelivery, setHasDelivery] = useState(false);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [cost, setCost] = useState("0");
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [refundShiftId, setRefundShiftId] = useState<number | null>(null);

  const feeHeldQ = trpc.workOrders.deliveryFeeHeld.useQuery(
    { workOrderId: order?.id ?? 0 },
    { enabled: !!order, staleTime: 0 },
  );
  const heldNet = Number(feeHeldQ.data?.net ?? "0");
  const branchId = feeHeldQ.data?.branchId ?? null;

  useEffect(() => {
    if (order) {
      setHasDelivery(!!order.hasDelivery);
      setAddress(order.deliveryAddress ?? "");
      setPhone(order.deliveryPhone ?? order.customerPhone ?? "");
      setCost(order.deliveryCost ?? "0");
      setConfirmRefund(false);
      setRefundShiftId(null);
    }
  }, [order?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const mustRefundFee = !hasDelivery && heldNet > 0;
  const openShiftsQ = trpc.treasury.getOpenShifts.useQuery(
    { branchId: branchId ?? 0 },
    { enabled: mustRefundFee && branchId != null },
  );
  const drawerShifts = openShiftsQ.data ?? [];
  const needShiftPick = mustRefundFee && drawerShifts.length > 1;

  if (!order) return null;
  const originalHasDelivery = !!order.hasDelivery;
  const originalCost = order.deliveryCost ?? "0";
  const priceMayHaveChanged =
    hasDelivery !== originalHasDelivery || (hasDelivery && cost !== originalCost);

  const submit = () => {
    if (hasDelivery && !address.trim()) {
      notify.err("عنوان التوصيل مطلوب عند تفعيل التوصيل");
      return;
    }
    if (mustRefundFee && !confirmRefund) {
      notify.err("أكّد تسليم أمانة الأجرة للزبون أولاً");
      return;
    }
    if (needShiftPick && refundShiftId == null) {
      notify.err("اختر درج الردّ النقديّ");
      return;
    }
    onConfirm({
      hasDelivery,
      deliveryAddress: hasDelivery ? address.trim() : null,
      deliveryPhone: phone.trim() || null,
      deliveryCost: hasDelivery ? cost || "0" : "0",
      confirmFeeRefund: mustRefundFee ? true : undefined,
      refundShiftId: mustRefundFee ? refundShiftId ?? undefined : undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-lg font-extrabold">تغيير طريقة التسليم</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          {order.orderNumber} — {order.title}
        </p>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setHasDelivery(false)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors",
              !hasDelivery
                ? "border-primary bg-primary/10 text-primary"
                : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            <Store aria-hidden className="size-4" /> استلام مباشر
          </button>
          <button
            type="button"
            onClick={() => setHasDelivery(true)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors",
              hasDelivery
                ? "border-primary bg-primary/10 text-primary"
                : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            <Truck aria-hidden className="size-4" /> توصيل
          </button>
        </div>

        {hasDelivery && (
          <div className="mb-3 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reclassify-address">عنوان التوصيل</Label>
              <Input
                id="reclassify-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="العنوان التفصيلي"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>هاتف المستلم</Label>
                <IntlPhoneInput value={phone} onChange={setPhone} ariaLabel="هاتف المستلم" />
              </div>
              <div className="space-y-1">
                <Label>أجرة التوصيل التقديرية</Label>
                <MoneyInput value={cost} onChange={setCost} ariaLabel="أجرة التوصيل" />
              </div>
            </div>
          </div>
        )}

        {priceMayHaveChanged && (
          <p className="mb-4 flex items-start gap-1.5 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              هذا التغيير لا يُعدِّل سعر بيع الأمر تلقائياً — راجع السعر مع العميل إن استلزم فرق التوصيل تعديلاً.
            </span>
          </p>
        )}

        {mustRefundFee && (
          <div className="mb-4 space-y-2.5 rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3">
            <p className="flex items-start gap-1.5 text-xs text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                على هذا الطلب أمانة أجرة توصيل{" "}
                <b className="tabular-nums" dir="ltr">
                  {fmt(heldNet)}
                </b>{" "}
                د.ع مقبوضة نقداً — بالحفظ تُردّ نقداً من الدرج. <b>سلّمها للزبون.</b>
              </span>
            </p>
            {needShiftPick && (
              <div className="space-y-1">
                <Label className="text-[11px] text-[var(--sem-warn)]">
                  أكثر من درجٍ مفتوح — من أيّ درجٍ يخرج النقد؟
                </Label>
                <select
                  aria-label="درج ردّ الأمانة النقدي"
                  className="h-9 w-full rounded-md border bg-card px-2 text-xs font-bold"
                  value={refundShiftId != null ? String(refundShiftId) : ""}
                  onChange={(e) => setRefundShiftId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">اختر الدرج…</option>
                  {drawerShifts.map((sh) => (
                    <option key={sh.shiftId} value={String(sh.shiftId)}>
                      {sh.userName} — وردية #{sh.shiftId}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs font-bold text-[var(--sem-warn)]">
              <input
                type="checkbox"
                checked={confirmRefund}
                onChange={(e) => setConfirmRefund(e.target.checked)}
                className="size-4 accent-amber-600"
                aria-label="تأكيد تسليم أمانة الأجرة للزبون"
              />
              سلّمتُ مبلغ الأمانة للزبون نقداً
            </label>
          </div>
        )}

        <div className="flex gap-2.5">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={pending}>
            إلغاء
          </Button>
          <Button
            className="flex-1"
            onClick={submit}
            disabled={pending || (mustRefundFee && !confirmRefund)}
          >
            {pending ? "جارٍ…" : "حفظ"}
          </Button>
        </div>
      </div>
    </div>
  );
}
