import { BalanceBadge } from "@/components/BalanceBadge";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/form/FormError";
import { ImageUploader } from "@/components/form/ImageUploader";
import { DataTable } from "@/components/data-table/DataTable";
import { AlertTriangle, Building2, Printer, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { voucherCreateActionLabel } from "@/components/vouchers/voucherUiPolicy";
import { VoucherCategoryQuickCreate } from "@/components/vouchers/VoucherCategoryQuickCreate";
import React from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmtAr } from "@/lib/money";
import { paymentMethodCompact } from "@shared/terms";
import { useVoucherForm, type VoucherFormModel } from "./useVoucherForm";
import type { VoucherFormProps } from "./voucherFormTypes";
export type { VoucherFormProps } from "./voucherFormTypes";
import { LedgerPreviewRow } from "./voucherFormTypes";
import { ledgerPreviewColumns } from "./voucherFormTypes";
import { VoucherPaymentFields } from "./VoucherPaymentFields";
import { VoucherPartyAllocationFields } from "./VoucherPartyAllocationFields";

export function SupplierAdvanceRefundFields({ model }: { model: Pick<VoucherFormModel,
  "supplierAdvanceRefundActive" | "supplierAdvanceRefundSources" | "supplierAdvanceRefundReceiptId" |
  "setSupplierAdvanceRefundReceiptId" | "selectedSupplierAdvanceRefund" | "supplierAdvanceRefundValidationError" |
  "supplierAdvanceRefundWarning" | "method"
> }) {
  const sources = model.supplierAdvanceRefundSources.data ?? [];
  if (!model.supplierAdvanceRefundActive || (!sources.length && !model.supplierAdvanceRefundValidationError && model.supplierAdvanceRefundReceiptId == null)) return null;
  const selected = model.selectedSupplierAdvanceRefund;
  return <Card className="lg:col-span-2"><CardContent className="space-y-2 p-3.5 text-xs">
    <Label htmlFor="supplier-advance-refund-source">الدفعة السابقة المستردة</Label>
    {sources.length > 0 ? <AppSelect id="supplier-advance-refund-source" aria-label="الدفعة السابقة المستردة" value={model.supplierAdvanceRefundReceiptId == null ? "" : String(model.supplierAdvanceRefundReceiptId)} onValueChange={(value) => model.setSupplierAdvanceRefundReceiptId(value ? Number(value) : null)}>
      <option value="">اختر سند الدفعة السابقة</option>
      {sources.map((source) => <option key={source.id} value={String(source.id)}>{source.voucherNumber ?? `سند #${source.id}`} — {paymentMethodCompact(source.paymentMethod)} — المتبقي {fmtAr(source.remainingAmount)} د.ع</option>)}
    </AppSelect> : null}
    {selected ? <div className="flex flex-wrap gap-x-5 gap-y-1">
      <span>السند الأصلي: {selected.voucherNumber ?? `#${selected.id}`}</span>
      <span>أصل الدفعة: {fmtAr(selected.amount)} د.ع</span>
      <span>المتبقي القابل للاسترداد: {fmtAr(selected.remainingAmount)} د.ع</span>
      <span>الجزء غير المستخدم: {fmtAr(selected.unusedAmount)} د.ع</span>
      <span>طريقة الدفعة الأصلية: {paymentMethodCompact(selected.paymentMethod)}</span>
      <span>طريقة الاسترداد الفعلية: {paymentMethodCompact(model.method)}</span>
    </div> : null}
    {model.supplierAdvanceRefundWarning ? <p className="text-[var(--sem-warn)]">{model.supplierAdvanceRefundWarning}</p> : null}
    {model.supplierAdvanceRefundValidationError ? <p role="alert" className="text-[var(--sem-warn)]">{model.supplierAdvanceRefundValidationError}</p> : null}
    {model.supplierAdvanceRefundSources.isError ? <Button type="button" variant="outline" size="sm" onClick={() => void model.supplierAdvanceRefundSources.refetch()}>إعادة التحقق من الدفعات السابقة</Button> : null}
  </CardContent></Card>;
}

export default function VoucherFormShared(props: VoucherFormProps) {
  const model = useVoucherForm(props);
  const {
    isReceipt,
    direction,
    canCreate,
    branchId,
    setBranchId,
    businessDay,
    amount,
    setAmount,
    method,
    setMethod,
    partyType,
    setPartyType,
    customerId,
    setCustomerId,
    supplierId,
    setSupplierId,
    deliveryPartyId,
    setDeliveryPartyId,
    description,
    setDescription,
    referenceNumber,
    setReferenceNumber,
    cardLastFour,
    setCardLastFour,
    voucherCategoryId,
    setVoucherCategoryId,
    counterpartyName,
    setCounterpartyName,
    voucherDate,
    setVoucherDate,
    setVoucherDateTouched,
    attachmentImages,
    setAttachmentImages,
    internalNote,
    setInternalNote,
    invoiceId,
    setInvoiceId,
    err,
    categories,
    categoryOptions,
    selectedCategory,
    selectedCategoryReady,
    readyCategoryCount,
    canManageCategories,
    canRestoreCategories,
    showCategoryDialog,
    setShowCategoryDialog,
    restoreDefaults,
    customerData,
    supplierData,
    invoiceQ,
    setInvoiceQ,
    outstandingInvoiceOptions,
    selectedInvoiceLabel,
    setSelectedInvoiceLabel,
    selectedInList,
    invoiceRemaining,
    hardBlock,
    supplierAdvanceRefundBlocked,
    treasuryNotice,
    awaitsOwnerDisbursement,
    recent,
    balanceWarn,
    create,
    submitColor,
    submit,
    requestCancel,
    ledgerPreview,
  } = model;
  return (
    <div className="space-y-2.5">
      <PageHeader
        title={isReceipt ? "سند قبض جديد" : "سند صرف جديد"}
        description={
          isReceipt
            ? "تحصيلات العملاء تسدد فواتيرهم تلقائياً من الأقدم، أو إيرادات متفرقة واسترداد من مورد."
            : "طلب صرف مستقلّ بلا أثر مالي عند الإرسال؛ ينفّذه مالك آخر لاحقاً عبر «اعتماد وصرف» بعد التحقق من الرصيد."
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void requestCancel()}
          >
            → القائمة
          </Button>
        }
      />

      <div className="grid gap-3 lg:grid-cols-2 items-start">
        {/* البَيانات الرئيسية */}
        <VoucherPaymentFields
          {...{
            isReceipt,
            direction,
            branchId,
            setBranchId,
            businessDay,
            amount,
            setAmount,
            method,
            setMethod,
            partyType,
            description,
            referenceNumber,
            setReferenceNumber,
            cardLastFour,
            setCardLastFour,
            voucherCategoryId,
            setVoucherCategoryId,
            voucherDate,
            setVoucherDate,
            setVoucherDateTouched,
            categories,
            categoryOptions,
            selectedCategory,
            selectedCategoryReady,
            readyCategoryCount,
            canManageCategories,
            canRestoreCategories,
            setShowCategoryDialog,
            restoreDefaults,
            awaitsOwnerDisbursement,
            create,
          }}
        />

        {/* الطرف المُقابل */}
        <VoucherPartyAllocationFields
          {...{
            isReceipt,
            direction,
            branchId,
            amount,
            partyType,
            setPartyType,
            customerId,
            setCustomerId,
            supplierId,
            setSupplierId,
            deliveryPartyId,
            setDeliveryPartyId,
            counterpartyName,
            setCounterpartyName,
            invoiceId,
            setInvoiceId,
            customerData,
            invoiceQ,
            setInvoiceQ,
            outstandingInvoiceOptions,
            selectedInvoiceLabel,
            setSelectedInvoiceLabel,
            selectedInList,
            invoiceRemaining,
            recent,
            balanceWarn,
          }}
        />

        <SupplierAdvanceRefundFields model={model} />

        {/* الوَصف + مَعاينة القَيد + المرفقات في بطاقة مدمجة واحدة */}
        <Card className="lg:col-span-2">
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3.5">
            <div className="space-y-1">
              <Label>وَصف السند *</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  isReceipt
                    ? "مثال: تحصيل مبلغ من تاجر بدون فاتورة محدّدة"
                    : "مثال: راتب الموظف أحمد لشهر يونيو"
                }
                rows={2}
              />
              <Label className="pt-1 block text-xs">
                مُلاحظة داخلية (لا تُطبع)
              </Label>
              <Input
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                placeholder="مَثلاً: الإيصال الأصلي بحوزة المُحاسب"
              />
            </div>
            <div className="space-y-1">
              <Label>مُرفَق السند (اختياري)</Label>
              <ImageUploader
                value={attachmentImages}
                onChange={setAttachmentImages}
                maxItems={1}
                maxSizeMB={2}
                singlePrimary={false}
                hint="صورة الإيصال الأصلي / كَشف البنك."
              />
            </div>
            {ledgerPreview && (
              <div className="space-y-1">
                <Label>مَعاينة قَيد الدفتر</Label>
                <div className="rounded-md border bg-muted/20 overflow-hidden text-xs">
                  <DataTable<LedgerPreviewRow>
                    embedded
                    searchable={false}
                    bounded={false}
                    pageSize={Infinity}
                    columns={ledgerPreviewColumns}
                    data={ledgerPreview}
                    emptyText="لا قَيد للمعاينة."
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* تَنبيهات النَظام */}
      <FormError message={err} />
      {hardBlock && (
        <div className="rounded-md border badge-stock-low text-sm p-3 flex items-start gap-2">
          <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            لا توجد وردية مفتوحة في هذا الفرع. السندات النقدية للكاشير تَمسّ
            صندوق الوردية —{" "}
            <Link href="/shifts" className="underline">
              افتح وردية
            </Link>{" "}
            أوّلاً، أو غيِّر طريقة الدفع لغير نقدية.
          </span>
        </div>
      )}
      {treasuryNotice && (
        <div className="rounded-md border badge-status-pending text-sm p-3 flex items-start gap-2">
          <Building2 aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            {isReceipt ? (
              <>
                يُسجَّل في <strong>الخزينة الإدارية</strong> (بلا وردية كاشير) —
                يَظهر في تقرير «النقد خارج الوردية» مفصولاً عن تَسوية درج
                الكاشير.
              </>
            ) : (
              <>
                المصدر المتوقع للطلب هو <strong>الخزينة الإدارية</strong>. لن
                يتغير رصيدها عند الإرسال؛ يتحقق الخادم منه عند «اعتماد وصرف».
              </>
            )}
          </span>
        </div>
      )}
      {awaitsOwnerDisbursement && (
        <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-sm p-3 flex items-start gap-2">
          <ShieldCheck aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            سيُرسل <strong>طلب صرف</strong> بحالة «بانتظار الاعتماد والصرف» بلا
            إيصال أو قيد أو تغيير ذمة. ينفّذه حساب مالك نشط غير مُنشئ الطلب،
            ويعيد الخادم التحقق من الرصيد والصلاحية عند التنفيذ.
          </span>
        </div>
      )}

      {/* الأزرار */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => submit(null)}
          disabled={!canCreate || create.isPending || hardBlock || supplierAdvanceRefundBlocked}
          className={submitColor}
          title={hardBlock ? "افتح وردية قبل سند نقدي للكاشير" : "Ctrl+S"}
        >
          {voucherCreateActionLabel(direction, create.isPending)}
        </Button>
        {isReceipt && (
          <>
            <Button
              variant="outline"
              onClick={() => submit("thermal")}
              disabled={!canCreate || create.isPending || hardBlock || supplierAdvanceRefundBlocked}
              title="Ctrl+Enter"
            >
              <Printer aria-hidden className="size-4 ms-1" />
              حفظ + طباعة حرارية
            </Button>
            <Button
              variant="outline"
              onClick={() => submit("a4")}
              disabled={!canCreate || create.isPending || hardBlock || supplierAdvanceRefundBlocked}
            >
              <Printer aria-hidden className="size-4 ms-1" />
              حفظ + طباعة A4
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={create.isPending}
          onClick={() => void requestCancel()}
        >
          إلغاء (Esc)
        </Button>
        {customerData.data && partyType === "CUSTOMER" && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            رصيد العميل قبل السند:
            <BalanceBadge
              amount={customerData.data.currentBalance}
              entityType="customer"
              showZero
            />
          </span>
        )}
        {supplierData.data && partyType === "SUPPLIER" && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            رصيد المورّد قبل السند:
            <BalanceBadge
              amount={supplierData.data.currentBalance}
              entityType="supplier"
              showZero
            />
          </span>
        )}
      </div>

      {/* إنشاء الفئة الإلزامية دون مغادرة السند نصف المُدخَل — تُنتقى فور حفظها. */}
      {canManageCategories && (
        <VoucherCategoryQuickCreate
          direction={direction}
          open={showCategoryDialog}
          onOpenChange={setShowCategoryDialog}
          onCreated={(category) => setVoucherCategoryId(category.id)}
        />
      )}
    </div>
  );
}
