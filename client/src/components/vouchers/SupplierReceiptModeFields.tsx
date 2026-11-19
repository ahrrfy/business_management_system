import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import {
  SUPPLIER_RECEIPT_PURPOSE_LABELS,
  type SupplierReceiptPurpose,
} from "@shared/balanceTrail";
import { paymentMethodCompact } from "@shared/terms";
import type { VoucherFormModel } from "./useVoucherForm";

type SupplierReceiptFieldsProps = {
  model: Pick<
    VoucherFormModel,
    | "supplierAdvanceRefundActive"
    | "supplierAdvanceRefundSources"
    | "supplierAdvanceRefundReceiptId"
    | "setSupplierAdvanceRefundReceiptId"
    | "supplierReceiptPurpose"
    | "setSupplierReceiptPurpose"
    | "selectedSupplierAdvanceRefund"
    | "supplierAdvanceRefundValidationError"
    | "supplierAdvanceRefundWarning"
    | "method"
  >;
};

export function SupplierReceiptModeFields({ model }: SupplierReceiptFieldsProps) {
  const sources = model.supplierAdvanceRefundSources.data ?? [];
  if (!model.supplierAdvanceRefundActive) return null;

  const isRefund = model.supplierReceiptPurpose === "ADVANCE_REFUND";
  const selected = model.selectedSupplierAdvanceRefund;
  const noRefundSources =
    !model.supplierAdvanceRefundSources.isLoading &&
    !model.supplierAdvanceRefundSources.isFetching &&
    !model.supplierAdvanceRefundSources.isError &&
    sources.length === 0;

  return (
    <Card className="lg:col-span-2">
      <CardContent className="space-y-3 p-3.5 text-xs">
        <div className="space-y-1.5">
          <Label>تصنيف قبض المورد</Label>
          <div
            role="radiogroup"
            aria-label="تصنيف قبض المورد"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!isRefund}
              onClick={() => model.setSupplierReceiptPurpose("CREDIT_OBLIGATION")}
              className={`rounded-md border p-2.5 text-start transition-colors ${
                !isRefund
                  ? "border-primary bg-primary/10 text-foreground font-semibold"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/40"
              }`}
            >
              <div>{SUPPLIER_RECEIPT_PURPOSE_LABELS.CREDIT_OBLIGATION}</div>
              <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                يزيد مستحق المورد (له علينا) مباشرة دون اشتراط ربط بدفعة سابقة.
              </div>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={isRefund}
              onClick={() => model.setSupplierReceiptPurpose("ADVANCE_REFUND")}
              className={`rounded-md border p-2.5 text-start transition-colors ${
                isRefund
                  ? "border-primary bg-primary/10 text-foreground font-semibold"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/40"
              }`}
            >
              <div>{SUPPLIER_RECEIPT_PURPOSE_LABELS.ADVANCE_REFUND}</div>
              <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                {noRefundSources
                  ? "لا توجد دفعة سابقة مفتوحة للاسترداد حاليا."
                  : `ربط بسند صرف سابق (${sources.length} متاح) مع إعادة فتح التخصيص عند اللزوم.`}
              </div>
            </button>
          </div>
        </div>

        {isRefund && (
          <div className="space-y-2 border-t pt-2.5">
            <Label htmlFor="supplier-advance-refund-source">
              الدفعة السابقة المستردة
            </Label>
            {sources.length > 0 ? (
              <AppSelect
                id="supplier-advance-refund-source"
                aria-label="الدفعة السابقة المستردة"
                value={
                  model.supplierAdvanceRefundReceiptId == null
                    ? ""
                    : String(model.supplierAdvanceRefundReceiptId)
                }
                onValueChange={(value) =>
                  model.setSupplierAdvanceRefundReceiptId(
                    value ? Number(value) : null,
                  )
                }
              >
                <option value="">اختر سند الدفعة السابقة</option>
                {sources.map((source) => (
                  <option key={source.id} value={String(source.id)}>
                    {source.voucherNumber ?? `سند #${source.id}`} —{" "}
                    {paymentMethodCompact(source.paymentMethod)} — المتبقي{" "}
                    {fmtAr(source.remainingAmount)} د.ع
                  </option>
                ))}
              </AppSelect>
            ) : null}

            {selected ? (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">
                <span>
                  السند الأصلي: {selected.voucherNumber ?? `#${selected.id}`}
                </span>
                <span>أصل الدفعة: {fmtAr(selected.amount)} د.ع</span>
                <span>
                  المتبقي القابل للاسترداد: {fmtAr(selected.remainingAmount)} د.ع
                </span>
                <span>
                  الجزء غير المستخدم: {fmtAr(selected.unusedAmount)} د.ع
                </span>
                <span>
                  طريقة الدفعة الأصلية:{" "}
                  {paymentMethodCompact(selected.paymentMethod)}
                </span>
                <span>
                  طريقة الاسترداد الفعلية: {paymentMethodCompact(model.method)}
                </span>
              </div>
            ) : null}

            {model.supplierAdvanceRefundWarning ? (
              <p className="text-[var(--sem-warn)]">
                {model.supplierAdvanceRefundWarning}
              </p>
            ) : null}
            {model.supplierAdvanceRefundValidationError ? (
              <p role="alert" className="text-[var(--sem-warn)]">
                {model.supplierAdvanceRefundValidationError}
              </p>
            ) : null}
            {model.supplierAdvanceRefundSources.isError ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void model.supplierAdvanceRefundSources.refetch()}
              >
                إعادة التحقق من الدفعات السابقة
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** تصدير متوافق لاختبار استرداد دفعة المورد. */
export function SupplierAdvanceRefundFields(props: SupplierReceiptFieldsProps) {
  return <SupplierReceiptModeFields {...props} />;
}
