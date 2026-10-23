import { ReturnComposerStatusBanners } from "./ReturnComposerStatusBanners";
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
import { AlertTriangle, CheckCircle2, RotateCcw, Zap } from "lucide-react";

import { LoadingState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { useReturnComposer } from "./useReturnComposer";
import type { ReturnComposerProps } from "./returnComposerTypes";

import { ReturnComposerItemsTable } from "./ReturnComposerItemsTable";
import { ReturnComposerDocumentation } from "./ReturnComposerDocumentation";
import { ReturnComposerRefundPanel } from "./ReturnComposerRefundPanel";
export { returnQuantityLabel } from "./returnComposerTypes";
export type { ReturnComposerProps } from "./returnComposerTypes";
export function ReturnComposer(props: ReturnComposerProps) {
  const model = useReturnComposer(props);
  const {
    approvingRequestId,
    footer,
    detail,
    operationPermission,
    refundRailPermission,
    executesImmediately,
    requestDetail,
    qty,
    setQty,
    fastBarcode,
    setFastBarcode,
    restock,
    setRestock,
    manualAmount,
    setManualAmount,
    setRailState,
    reason,
    setReason,
    error,
    setError,
    done,
    setDone,
    clientRequestId,
    inv,
    isWalkIn,
    isDeliveryReversal,
    items,
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
    selectedLines,
    qtyLocked,
    isLocked,
    pending,
    canWithdrawPending,
    approve,
    create,
    withdrawPending,
    withdrawing,
    setQtyClamped,
    fillAll,
    handleFastItemScan,
    noRefundNeeded,
    requiresExecutableRail,
    blockReason,
    submit,
    triggerExpressReturn,
  } = model;
  if (detail.isLoading)
    return <LoadingState message="جارٍ تحميل بنود الفاتورة…" />;
  if (detail.isError) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-destructive space-y-1">
        <div className="flex items-center gap-2 font-bold text-sm">
          <AlertTriangle
            aria-hidden
            className="size-4 shrink-0 text-destructive"
          />
          <span>تعذّر تحميل تفاصيل الفاتورة للمرتجع</span>
        </div>
        <p className="text-xs text-muted-foreground">{detail.error.message}</p>
      </div>
    );
  }
  if (!inv) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        الفاتورة غير موجودة أو لا تخصّ فرعك.
      </div>
    );
  }

  return (
    <fieldset
      disabled={create.isPending || approve.isPending}
      className="min-w-0 space-y-2.5"
    >
      <ReturnComposerStatusBanners
        {...{
          approvingRequestId,
          requestDetail,
          pending,
          canWithdrawPending,
          withdrawPending,
          withdrawing,
          create,
          approve,
          detail,
          isLocked,
          inv,
        }}
      />
      {/* ① ملخص الفاتورة والمبالغ — شريط مكثف ومباشر */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-2.5 p-2.5 text-xs md:grid-cols-3 xl:grid-cols-6">
          <div>
            <div className="text-[11px] text-muted-foreground">
              رقم الفاتورة
            </div>
            <div className="font-mono font-bold" dir="ltr">
              {inv.invoiceNumber}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">العميل</div>
            <div className="font-semibold">
              {inv.customerName ?? "عميل نقدي"}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">الإجمالي</div>
            <div className="tabular-nums font-bold" dir="ltr">
              {fmt(inv.total)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">المقبوض</div>
            <div className="tabular-nums" dir="ltr">
              {fmt(inv.paidAmount)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">
              المتاح للاسترداد
            </div>
            <div
              className="font-bold tabular-nums text-money-positive"
              dir="ltr"
            >
              {fmt(inv.refundPool)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">
              المتبقّي على العميل بعد المرتجع
            </div>
            <div
              className={`font-bold tabular-nums ${customerStillOwes.gt(0) ? "text-money-negative" : "text-muted-foreground"}`}
              dir="ltr"
            >
              {fmt(customerStillOwes.toFixed(2))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* شريط وضع المرتجع: كامل مقابل جزئي */}
      {!approvingRequestId && !isLocked && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 rounded-lg border bg-muted/30 p-1">
          <button
            type="button"
            disabled={qtyLocked || items.every((it) => it.remaining <= 0)}
            onClick={() => {
              fillAll();
              setReason((prev) => prev.trim() || "إرجاع كامل الفاتورة");
            }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold transition-all cursor-pointer",
              items.some((it) => it.remaining > 0) &&
                items
                  .filter((it) => it.remaining > 0)
                  .every((it) => qty[it.invoiceItemId] === it.remaining)
                ? "bg-primary text-primary-foreground shadow-xs"
                : "bg-background hover:bg-muted text-foreground border",
            )}
          >
            <Zap className="size-3.5" aria-hidden />
            <span>مرتجع كامل للفاتورة (تحديد كافة البنود)</span>
          </button>
          <button
            type="button"
            disabled={qtyLocked}
            onClick={() => {
              const allSelected =
                items.some((it) => it.remaining > 0) &&
                items
                  .filter((it) => it.remaining > 0)
                  .every((it) => qty[it.invoiceItemId] === it.remaining);
              if (allSelected) {
                setQty({});
              }
            }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold transition-all cursor-pointer",
              !(
                items.some((it) => it.remaining > 0) &&
                items
                  .filter((it) => it.remaining > 0)
                  .every((it) => qty[it.invoiceItemId] === it.remaining)
              )
                ? "bg-primary text-primary-foreground shadow-xs"
                : "bg-background hover:bg-muted text-foreground border",
            )}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            <span>مرتجع جزئي (تحديد الأصناف والكميات)</span>
          </button>
        </div>
      )}

      {/* ② بنود الفاتورة مع مسح الباركود السريع وأزرار الإرجاع الذكي */}
      <ReturnComposerItemsTable
        {...{
          qty,
          fastBarcode,
          setFastBarcode,
          items,
          selectedLines,
          qtyLocked,
          isLocked,
          approve,
          create,
          setQtyClamped,
          fillAll,
          handleFastItemScan,
          triggerExpressReturn,
        }}
      />

      {/* ③ خيارات التسوية والاسترداد الرشيقة في لوحة مدمجة */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* العمود الأيمن: التوثيق السريع وحالة البضاعة */}
        <ReturnComposerDocumentation
          {...{
            restock,
            setRestock,
            reason,
            setReason,
            setError,
            qtyLocked,
            isLocked,
          }}
        />

        {/* العمود الأيسر: طريقة الاسترداد ومنتقي الرافد والدرج */}
        <ReturnComposerRefundPanel
          {...{
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
          }}
        />
      </div>

      {blockReason && !error && (
        <p className="text-sm font-semibold text-muted-foreground">
          {blockReason}
        </p>
      )}
      {error && (
        <p className="text-sm font-semibold text-destructive">{error}</p>
      )}
      {done && <p className="text-sm font-bold text-money-positive">{done}</p>}

      {/* شريط الأوامر والتنفيذ */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
        <Button
          onClick={submit}
          disabled={
            !operationPermission.allowed ||
            !!blockReason ||
            withdrawing ||
            create.isPending ||
            approve.isPending
          }
          className="font-bold text-xs sm:text-sm gap-1.5"
        >
          <CheckCircle2 className="size-4" aria-hidden />
          <span>
            {create.isPending
              ? ACTION_LABELS.sending
              : approvingRequestId
                ? "اعتماد وتنفيذ المرتجع"
                : executesImmediately
                  ? "تنفيذ المرتجع الآن"
                  : "إرسال طلب المرتجع"}
          </span>
        </Button>

        <Button
          variant="secondary"
          onClick={triggerExpressReturn}
          disabled={
            !operationPermission.allowed ||
            !!pending ||
            withdrawing ||
            qtyLocked ||
            isLocked ||
            items.every((it) => it.remaining <= 0) ||
            create.isPending ||
            approve.isPending
          }
          className="font-bold text-xs sm:text-sm gap-1.5"
        >
          <Zap className="size-4" aria-hidden />
          <span>إرجاع سريع لكامل الفاتورة</span>
        </Button>

        <Button
          variant="outline"
          disabled={qtyLocked}
          onClick={() => {
            setQty({});
            setManualAmount(null);
            setReason("");
            setError("");
            setDone("");
            setFastBarcode("");
          }}
          className="text-xs sm:text-sm gap-1 text-muted-foreground"
        >
          <RotateCcw className="size-3.5" aria-hidden />
          <span>إعادة ضبط</span>
        </Button>

        {footer}
      </div>
    </fieldset>
  );
}
export default ReturnComposer;
