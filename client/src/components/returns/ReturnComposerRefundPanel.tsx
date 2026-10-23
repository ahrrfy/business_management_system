/**
 * ReturnComposer — **المكوّن المرجعيّ الوحيد للمرتجع** (بلاغ المالك ١٧/٨/٢٦).
 *
 * لماذا وُحِّد: كان للمرتجع شاشتان بمنطقين مختلفين (`/returns` نموذجٌ مديريّ،
 * و`/sales-returns/new` محرّرٌ كامل)، وكلتاهما تحسب سقوف الاسترداد **محلياً** بمنطقٍ يخالف
 * الخادم ⇒ يملأ الموظف كل شيء ثمّ يُرفض الطلب برسالة سقفٍ غامضة. والمرتجع عمليةٌ يوميّةٌ
 * متكرّرة (نصّ المالك: «الزبائن مزاجهم متقلّب ويطلبون مرتجع كثيراً») فوجب أن تكون بمألوفيّة
 * شاشة البيع وأن تكون **غير قابلة للخطأ بالبناء**.
 *
 * مبدأ التصميم الحاكم هنا: **لا خيار على الشاشة إلّا وقد أذِن به الخادم**.
 * السقوف تأتي من `returns.getInvoice` (المحسوبة بنفس دالّة `loadRefundCaps` التي ستحكم على
 * الطلب)، **والروافدُ والأدراجُ من المنتقي الموحَّد `<RefundRailPicker>`** (م٢ ق١٠) الذي يستفتي
 * `refundRails.preflight` بالمبلغ المطلوب ⇒ ما تعراه الشاشة = ما يقبله الخادم بالتعريف.
 * لا تُعِد حساب سقفٍ هنا ولا تُضِف رافداً بنصٍّ ثابت — تلك بالضبط العلّة التي أُصلحت.
 *
 * قرارات المالك المُجسَّدة (١٧/٨/٢٦):
 *  · رافدا الردّ **نقدٌ أو بطاقة فقط** مهما كان رافد القبض (بطاقة/نقد/تحويل/رصيد زين).
 *  · النقد يخرج من **وردية المنفّذ المفتوحة** افتراضاً، أو يختار وردية مفتوحة أخرى صراحةً؛
 *    وبلا وردية مفتوحة يخرج من **الخزينة** للإداريّ (استثناءٌ مصنَّف خادمياً — الخادم يعلنه رافداً).
 *  · الردّ بالبطاقة يُنفَّذ على الجهاز ثمّ يُوثَّق بمرجعه (إثباتٌ لا إقفال).
 */
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import { RefundRailPicker } from "@/components/ui/RefundRailPicker";
import { D, fmt, round2 } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { cn } from "@/lib/utils";
import { REFUND_RAIL_LABEL } from "@shared/refundRails";
import type { ReturnComposerModel } from "./useReturnComposer";

type Props = Omit<
  Pick<
    ReturnComposerModel,
    | "refundRailPermission"
    | "manualAmount"
    | "setManualAmount"
    | "setRailState"
    | "clientRequestId"
    | "inv"
    | "isWalkIn"
    | "isDeliveryReversal"
    | "returnValue"
    | "pickedRail"
    | "method"
    | "visibleRefundOptions"
    | "railCap"
    | "customerStillOwes"
    | "suggestedRefund"
    | "refundAmount"
    | "refundD"
    | "hasIncompleteRefund"
    | "overCap"
    | "isLocked"
    | "approve"
    | "create"
    | "noRefundNeeded"
    | "requiresExecutableRail"
  >,
  "inv"
> & { inv: NonNullable<ReturnComposerModel["inv"]> };
export function ReturnComposerRefundPanel({
  refundRailPermission,
  manualAmount,
  setManualAmount,
  setRailState,
  clientRequestId,
  inv,
  isWalkIn,
  isDeliveryReversal,
  returnValue,
  pickedRail,
  method,
  visibleRefundOptions,
  railCap,
  customerStillOwes,
  suggestedRefund,
  refundAmount,
  refundD,
  hasIncompleteRefund,
  overCap,
  isLocked,
  approve,
  create,
  noRefundNeeded,
  requiresExecutableRail,
}: Props) {
  return (
    <div className="lg:col-span-7 space-y-3">
      {noRefundNeeded && !hasIncompleteRefund ? (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm font-bold">
              لا يوجد استرداد مالي
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2.5">
            <div className="flex items-start gap-2 rounded-lg border border-[var(--sem-info)]/45 bg-[var(--sem-info-bg)] p-3 text-xs font-semibold text-[var(--sem-info)]">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              <div>
                <div>
                  {isDeliveryReversal
                    ? "لا يوجد لدى المتجر مبلغ يستوجب الرد — تُعكس عهدة التوصيل آلياً بلا إخراج نقد وبلا وردية صرف."
                    : !isWalkIn &&
                        suggestedRefund.gt(0) &&
                        manualAmount !== null
                      ? "تم اختيار تقييد كامل مبلغ المرتجع في حساب العميل (رصيد دائن / موازنة ذمم) دون صرف نقد من الدرج."
                      : "لم يُقبض من هذه الفاتورة ما يستوجب الرد — يُسجّل المرتجع بلا إخراج نقد وبلا وردية صرف."}
                </div>
                <div className="mt-1 text-[11px] font-normal">
                  المرتجع {fmt(returnValue.toFixed(2))} د.ع · المقبوض القابل
                  للرد{" "}
                  {fmt(
                    D(
                      inv?.refundablePaidAmount ?? inv?.paidAmount ?? "0",
                    ).toFixed(2),
                  )}{" "}
                  د.ع
                  {customerStillOwes.gt(0)
                    ? ` · يبقى على العميل ${fmt(customerStillOwes.toFixed(2))} د.ع`
                    : ""}
                </div>
              </div>
            </div>
            {!isWalkIn && !isDeliveryReversal && suggestedRefund.gt(0) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setManualAmount(null)}
                className="h-8 text-xs font-bold"
              >
                استرداد المبلغ نقداً / بطاقة ({fmt(suggestedRefund.toFixed(2))}{" "}
                د.ع) بدلاً من تقييده بالذمة
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm font-bold">
              الاسترداد المالي والدرج
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-3">
            {/* سقوف الرد */}
            <ul className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
              {visibleRefundOptions.map((o) => (
                <li
                  key={o.method}
                  className="inline-flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 px-2 py-1"
                >
                  {o.method === "CARD" && <CardBrandLogos size="xs" />}
                  <span className="font-bold text-foreground">
                    {paymentMethodLabel(o.method)}
                  </span>
                  {o.blockedReason ? (
                    <span> — {o.blockedReason}</span>
                  ) : (
                    <span dir="ltr" className="ms-1 tabular-nums font-semibold">
                      {" "}
                      حتى {fmt(o.cap)} د.ع
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {!isWalkIn && !isDeliveryReversal && suggestedRefund.gt(0) && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => setManualAmount(null)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer",
                    manualAmount === null
                      ? "border-primary bg-primary/10 text-primary font-bold"
                      : "bg-background hover:bg-muted text-muted-foreground",
                  )}
                >
                  ردّ الصافي للعميل ({fmt(suggestedRefund.toFixed(2))} د.ع)
                </button>
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => setManualAmount("0")}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer",
                    manualAmount === "0"
                      ? "border-primary bg-primary/10 text-primary font-bold"
                      : "bg-background hover:bg-muted text-muted-foreground",
                  )}
                >
                  تقييد كامل المرتجع بحساب العميل / موازنة ذمم (0 د.ع نقد)
                </button>
              </div>
            )}

            <div className="rounded-lg border bg-muted/20 p-2.5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="text-xs sm:text-sm">
                  <span className="font-bold">يُعاد للزبون: </span>
                  <span
                    className="text-base sm:text-lg font-black tabular-nums text-primary"
                    dir="ltr"
                  >
                    {fmt(refundD.toString())}
                  </span>
                  <span className="ms-1 text-xs font-bold">
                    د.ع{pickedRail ? ` — ${REFUND_RAIL_LABEL[pickedRail]}` : ""}
                  </span>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    قيمة المرتجع {fmt(returnValue.toFixed(2))} · المسموح{" "}
                    {fmt(railCap.toFixed(2))}
                  </div>
                  {!isWalkIn && returnValue.gt(refundD) && refundD.gt(0) && (
                    <div className="mt-1 text-[11px] font-semibold text-primary">
                      تسوية مركبة: يُسقط{" "}
                      {fmt(returnValue.minus(refundD).toFixed(2))} د.ع من ذمة
                      العميل + يُردّ {fmt(refundD.toFixed(2))} د.ع
                    </div>
                  )}
                </div>
                {isDeliveryReversal ? (
                  <div className="rounded-md border border-[var(--sem-pos)]/35 bg-[var(--sem-pos-bg)] px-2.5 py-1.5 text-xs font-bold text-[var(--sem-pos)]">
                    {refundD.gt(0)
                      ? "ردّ المقبوض لدى المتجر وعكس عهدة التوصيل عن الباقي"
                      : "عكس عهدة التوصيل آلياً (بلا إخراج نقد من الدرج)"}
                  </div>
                ) : isWalkIn ? (
                  <div className="rounded-md border border-[var(--sem-info)]/35 bg-[var(--sem-info-bg)] px-2.5 py-1.5 text-xs font-bold text-[var(--sem-info)]">
                    مبلغ ثابت بعد التقريب (زبون عابر)
                  </div>
                ) : (
                  <div className="w-36 space-y-1">
                    <Label htmlFor="ret-amount" className="text-[11px]">
                      تعديل المبلغ (اختياري)
                    </Label>
                    <MoneyInput
                      id="ret-amount"
                      value={refundAmount}
                      onChange={setManualAmount}
                      ariaLabel="مبلغ الاسترداد"
                      disabled={isLocked}
                      expectedRange={{ max: Number(railCap.toFixed(2)) }}
                    />
                  </div>
                )}
              </div>
              {overCap && (
                <p className="mt-2 text-xs font-bold text-destructive">
                  المبلغ يتجاوز المسموح — الحدّ {fmt(railCap.toFixed(2))} د.ع.
                </p>
              )}
            </div>

            {refundD.gt(0) && refundRailPermission.allowed ? (
              <RefundRailPicker
                key={clientRequestId}
                context={{
                  sourceDocType: "SALE_RETURN",
                  sourceDocId: inv.id,
                  amount: round2(refundD).toFixed(2),
                }}
                mode="embedded"
                requestOnly={!requiresExecutableRail}
                onStateChange={setRailState}
                drawerLabel="من أيّ درج يخرج النقد؟"
                drawerHint="النقد يخرج من الدرج المختار عند تنفيذ المرتجع، ويظهر في تسويته."
                submitting={create.isPending || approve.isPending}
              />
            ) : refundD.gt(0) ? (
              <div className="rounded-lg border border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)] p-3 text-xs font-semibold text-[var(--sem-warn)]">
                هذا المرتجع يحتاج صرفاً مالياً؛ يلزم تفويض «التحقق من مصدر ردّ
                المبلغ» قبل اعتماده.
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
