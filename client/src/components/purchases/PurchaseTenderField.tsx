import React from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { shiftTypeLabel } from "@/lib/labels";
import { PURCHASE_TENDER_REFERENCE_MAX_LENGTH } from "@shared/purchaseTender";
import {
  usePurchaseTenderState,
  type TenderMode,
} from "./usePurchaseTenderState";
export {
  usePurchaseTenderState,
  purchaseTenderDraft,
  buildPurchaseTenderPayload,
  purchaseTenderAmounts,
} from "./usePurchaseTenderState";
export type {
  PurchaseTenderDraft,
  PurchaseLegacyCashSource,
} from "./usePurchaseTenderState";

export function PurchaseTenderField({
  idPrefix,
  state,
  paymentTerms,
  currency,
}: {
  idPrefix: string;
  state: ReturnType<typeof usePurchaseTenderState>;
  paymentTerms: string;
  currency: string;
}) {
  if (paymentTerms !== "CASH")
    return (
      <p className="text-xs text-muted-foreground">
        آجلة: تثبت ذمة المورد عند الترحيل، ويُسجل السداد الفعلي بسند صرف معتمد.
      </p>
    );
  if (currency !== "IQD")
    return (
      <p className="text-xs text-[var(--sem-warn)]">
        الفاتورة الدولارية تسدد من مسار الصيرفة؛ اختر آجلة ثم سجل التسديد الفعلي
        بعد الاستلام.
      </p>
    );
  const { draft, change, amounts } = state;
  return (
    <section
      className="space-y-2 rounded-md border bg-card px-3 py-2"
      aria-label="سداد فاتورة المورد"
    >
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-tender-mode`} className="text-xs">
            مصدر السداد
          </Label>
          <AppSelect
            id={`${idPrefix}-tender-mode`}
            value={state.preservingLegacy ? "KEEP" : draft.mode}
            onValueChange={(value) =>
              value === "KEEP"
                ? state.preserveLegacy()
                : change("mode", value as TenderMode)
            }
            aria-label="مصدر السداد"
          >
            {state.canPreserveLegacy ? (
              <option value="KEEP">
                الاحتفاظ بالمصدر المحفوظ ({state.legacySourceLabel})
              </option>
            ) : null}
            <option value="DRAWER">نقد من الوردية</option>
            <option value="TREASURY">نقد من الخزنة</option>
            <option value="CARD">بطاقة الشركة</option>
          </AppSelect>
        </div>
        {state.preservingLegacy ? (
          <p className="text-xs text-muted-foreground">
            يبقى مصدر السداد المحفوظ دون تغيير؛ صلاحية الصرف تُفحص عند الاعتماد.
          </p>
        ) : null}
        {!state.preservingLegacy && draft.mode === "DRAWER" ? (
          <div className="space-y-1 text-xs">
            {state.canChooseDrawer &&
            (state.drawers.length > 1 ||
              (state.drawers.length === 1 &&
                draft.shiftId !== String(state.drawers[0]!.id))) ? (
              <>
                <Label htmlFor={`${idPrefix}-tender-shift`}>وردية الدافع</Label>
                <AppSelect
                  id={`${idPrefix}-tender-shift`}
                  value={draft.shiftId}
                  onValueChange={(value) => change("shiftId", value)}
                  aria-label="وردية الدافع"
                >
                  <option value="">اختر الوردية</option>
                  {state.drawers.map((row) => (
                    <option key={row.id} value={String(row.id)}>
                      {shiftTypeLabel(row.shiftType)} — درج #{row.id}
                    </option>
                  ))}
                </AppSelect>
              </>
            ) : (
              <p>
                {draft.shiftId
                  ? `وردية الدافع المحفوظة / الحالية #${draft.shiftId}`
                  : "لا توجد وردية محددة للدافع"}
              </p>
            )}
          </div>
        ) : null}
        {!state.preservingLegacy && draft.mode === "CARD" ? (
          <>
            <div className="space-y-1">
              <Label className="text-xs">حساب بطاقة الشركة</Label>
              <p className="text-xs">
                {state.cardAccount
                  ? `${state.cardAccount.code} — ${state.cardAccount.name}`
                  : "حساب بطاقة الشركة غير متاح"}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-card-last-four`} className="text-xs">
                آخر أربعة أرقام
              </Label>
              <Input
                id={`${idPrefix}-card-last-four`}
                aria-label="آخر أربعة أرقام"
                dir="ltr"
                inputMode="numeric"
                maxLength={4}
                value={draft.cardLastFour}
                onChange={(event) =>
                  change(
                    "cardLastFour",
                    event.target.value.replace(/\D/g, "").slice(0, 4),
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-card-reference`} className="text-xs">
                مرجع عملية البطاقة
              </Label>
              <Input
                id={`${idPrefix}-card-reference`}
                aria-label="مرجع عملية البطاقة"
                maxLength={PURCHASE_TENDER_REFERENCE_MAX_LENGTH}
                value={draft.referenceNumber}
                onChange={(event) =>
                  change("referenceNumber", event.target.value)
                }
              />
              <p className="text-[10px] text-muted-foreground">
                مرجع توثيقي للعملية؛ لا يمثل تحققاً مصرفياً آلياً.
              </p>
            </div>
          </>
        ) : null}
        {!state.preservingLegacy ? (
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-prior-payment`} className="text-xs">
              دفعة سابقة معتمدة (اختياري)
            </Label>
            <AppSelect
              id={`${idPrefix}-prior-payment`}
              aria-label="دفعة سابقة معتمدة"
              value={draft.previousReceiptId}
              onValueChange={(value) => change("previousReceiptId", value)}
            >
              <option value="">بدون ربط دفعة سابقة</option>
              {state.previousPayments.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {row.voucherNumber ?? `سند #${row.id}`} — المتاح{" "}
                  {fmtAr(row.availableAmount)} د.ع
                </option>
              ))}
            </AppSelect>
          </div>
        ) : null}
      </div>
      <div
        className="flex flex-wrap gap-x-5 gap-y-1 border-t pt-2 text-xs"
        aria-label="معاينة السداد"
      >
        <span>قيمة الفاتورة: {fmtAr(amounts.amount.toFixed(2))} د.ع</span>
        <span>من الدفعة السابقة: {fmtAr(amounts.applied.toFixed(2))} د.ع</span>
        <span>
          {amounts.remainder.gt(0)
            ? `الصرف الجديد (${state.sourceSummaryLabel}): ${fmtAr(amounts.remainder.toFixed(2))} د.ع`
            : "لا يوجد صرف جديد"}
        </span>
        {amounts.unused.gt(0) ? (
          <span>
            المتبقي غير المستخدم من الدفعة: {fmtAr(amounts.unused.toFixed(2))}{" "}
            د.ع
          </span>
        ) : null}
        <span>المتبقي على الفاتورة بعد الاعتماد والسداد: 0.00 د.ع</span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        هذه نية سداد تحفظ مع المراجعة؛ لا تتحرك الأموال قبل الاعتماد. دفعات
        المورد الأخرى مستقلة ولا تُستنتج من رصيده.
      </p>
      {state.validationError ? (
        <div
          className="flex items-center gap-2 text-xs text-[var(--sem-warn)]"
          role="alert"
        >
          <p>{state.validationError}</p>
          {state.showRetry ? (
            <button type="button" className="underline" onClick={state.retry}>
              إعادة التحقق
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
