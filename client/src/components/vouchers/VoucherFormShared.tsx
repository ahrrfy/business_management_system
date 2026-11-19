import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImageUploader } from "@/components/form/ImageUploader";
import { DataTable } from "@/components/data-table/DataTable";
import { AlertTriangle, Printer } from "lucide-react";
import { Link } from "wouter";
import { voucherCreateActionLabel } from "@/components/vouchers/voucherUiPolicy";
import { VoucherCategoryQuickCreate } from "@/components/vouchers/VoucherCategoryQuickCreate";
import { useVoucherForm } from "./useVoucherForm";
import type { VoucherFormProps } from "./voucherFormTypes";
import { ledgerPreviewColumns, type LedgerPreviewRow } from "./voucherFormTypes";
import { VoucherPaymentFields } from "./VoucherPaymentFields";
import { VoucherPartyAllocationFields } from "./VoucherPartyAllocationFields";
import {
  SupplierAdvanceRefundFields,
  SupplierReceiptModeFields,
} from "./SupplierReceiptModeFields";
import { VoucherBalanceImpactCard } from "./VoucherBalanceImpactCard";
import { VoucherErrorRecoveryBanner } from "./VoucherErrorRecoveryBanner";

export type { VoucherFormProps } from "./voucherFormTypes";
export { SupplierAdvanceRefundFields };

export default function VoucherFormShared(props: VoucherFormProps) {
  const model = useVoucherForm(props);
  const {
    embedded,
    initialCurrentBalance,
    initialPendingReserved,
    isReceipt,
    direction,
    canCreate,
    branchId,
    setBranchId,
    businessDay,
    amount,
    setAmount,
    amountDec,
    method,
    setMethod,
    partyType,
    setPartyType,
    customerId,
    setCustomerId,
    supplierId,
    setSupplierId,
    supplierReceiptPurpose,
    setSupplierReceiptPurpose,
    allowSupplierOverpay,
    setAllowSupplierOverpay,
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
    setErr,
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

  const currentCustomerBalance =
    customerData.data?.currentBalance ??
    (partyType === "CUSTOMER" ? initialCurrentBalance : undefined);
  const currentSupplierBalance =
    supplierData.data?.currentBalance ??
    (partyType === "SUPPLIER" ? initialCurrentBalance : undefined);
  const currentSupplierBalanceUsd = supplierData.data?.currentBalanceUsd;

  return (
    <div className="space-y-2.5">
      {!embedded && (
        <PageHeader
          title={isReceipt ? "سند قبض جديد" : "سند صرف جديد"}
          description={
            isReceipt
              ? "تحصيلات العملاء أو قبض الموردين والإيرادات المتنوعة."
              : "طلب صرف مستقل يعتمد ويصرف من الخزينة أو الحساب البنكي."
          }
          backHref="/vouchers"
          backLabel="السندات"
        />
      )}

      <div className="grid gap-3 lg:grid-cols-2 items-start">
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
            treasuryNotice,
            awaitsOwnerDisbursement,
            create,
          }}
        />

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
            supplierReceiptPurpose,
            allowSupplierOverpay,
            setAllowSupplierOverpay,
            deliveryPartyId,
            setDeliveryPartyId,
            counterpartyName,
            setCounterpartyName,
            invoiceId,
            setInvoiceId,
            customerData,
            supplierData,
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

        <SupplierReceiptModeFields model={model} />

        <Card className="lg:col-span-2">
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3.5">
            <div className="space-y-1">
              <Label>وصف السند *</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  isReceipt
                    ? "مثال: تحصيل مبلغ أو إشعار قبض"
                    : "مثال: سداد مستحق أو مصروف تشغيلي"
                }
                rows={2}
              />
              <Label className="pt-1 block text-xs">
                ملاحظة داخلية (لا تطبع)
              </Label>
              <Input
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                placeholder="مثال: رقم المستند الورقي أو الإيصال"
              />
            </div>
            <div className="space-y-1">
              <Label>مرفق السند (اختياري)</Label>
              <ImageUploader
                value={attachmentImages}
                onChange={setAttachmentImages}
                maxItems={1}
                maxSizeMB={2}
                singlePrimary={false}
                hint="صورة الإيصال الأصلي / كشف البنك."
              />
            </div>
            {ledgerPreview && (
              <div className="space-y-1 md:col-span-2">
                <Label>معاينة قيد الدفتر</Label>
                <div className="rounded-md border bg-muted/20 text-xs">
                  <DataTable<LedgerPreviewRow>
                    embedded
                    searchable={false}
                    bounded={false}
                    pageSize={Infinity}
                    columns={ledgerPreviewColumns}
                    data={ledgerPreview}
                    emptyText="لا قيد للمعاينة."
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <VoucherErrorRecoveryBanner
        err={err}
        direction={direction}
        partyType={partyType}
        customerId={customerId}
        supplierId={supplierId}
        invoiceId={invoiceId}
        method={method}
        amountDec={amountDec}
        supplierBalance={currentSupplierBalance}
        supplierReceiptPurpose={supplierReceiptPurpose}
        allowSupplierOverpay={allowSupplierOverpay}
        onEnableSupplierOverpay={() => {
          setAllowSupplierOverpay(true);
          setErr("");
        }}
        onApplySuggestedAmount={(suggested) => {
          setAmount(suggested);
          setErr("");
        }}
        onClearInvoice={() => {
          setInvoiceId(null);
          setSelectedInvoiceLabel("");
          setErr("");
        }}
        onSwitchMethod={(next) => {
          setMethod(next);
          setErr("");
        }}
        onSwitchSupplierCreditMode={() => {
          setSupplierReceiptPurpose("CREDIT_OBLIGATION");
          setErr("");
        }}
      />

      {hardBlock && (
        <div className="rounded-md border badge-stock-low text-sm p-3 flex items-start gap-2">
          <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            لا توجد وردية مفتوحة في هذا الفرع للسند النقدي —{" "}
            <Link href="/shifts" className="underline font-medium">
              افتح وردية
            </Link>{" "}
            أو اختر طريقة غير نقدية.
          </span>
        </div>
      )}

      <VoucherBalanceImpactCard
        direction={direction}
        partyType={partyType}
        amountDec={amountDec}
        method={method}
        cardLastFour={cardLastFour}
        treasuryNotice={treasuryNotice}
        awaitsOwnerDisbursement={awaitsOwnerDisbursement}
        customerBalance={currentCustomerBalance}
        supplierBalance={currentSupplierBalance}
        supplierBalanceUsd={currentSupplierBalanceUsd}
        pendingReserved={initialPendingReserved}
      />

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
              disabled={
                !canCreate ||
                create.isPending ||
                hardBlock ||
                supplierAdvanceRefundBlocked
              }
              title="Ctrl+Enter"
            >
              <Printer aria-hidden className="size-4 ms-1" />
              حفظ + طباعة حرارية
            </Button>
            <Button
              variant="outline"
              onClick={() => submit("a4")}
              disabled={
                !canCreate ||
                create.isPending ||
                hardBlock ||
                supplierAdvanceRefundBlocked
              }
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
      </div>

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
