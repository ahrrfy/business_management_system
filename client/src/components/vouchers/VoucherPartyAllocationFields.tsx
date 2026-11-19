import CustomerPicker from "@/components/CustomerPicker";
import SupplierPicker from "@/components/voucher/SupplierPicker";
import DeliveryPartyPicker from "@/components/voucher/DeliveryPartyPicker";
import { PaymentMethodChip } from "@/components/common/MovementBadges";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VoucherDetailDrawer } from "@/components/vouchers/VoucherDetailDrawer";
import { voucherApprovalLabel } from "@/components/vouchers/voucherUiPolicy";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { AlertTriangle, Eye, Info } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { VoucherFormModel } from "./useVoucherForm";

type Props = Pick<
  VoucherFormModel,
  | "isReceipt"
  | "direction"
  | "branchId"
  | "amount"
  | "partyType"
  | "setPartyType"
  | "customerId"
  | "setCustomerId"
  | "supplierId"
  | "setSupplierId"
  | "supplierReceiptPurpose"
  | "allowSupplierOverpay"
  | "setAllowSupplierOverpay"
  | "deliveryPartyId"
  | "setDeliveryPartyId"
  | "counterpartyName"
  | "setCounterpartyName"
  | "invoiceId"
  | "setInvoiceId"
  | "customerData"
  | "supplierData"
  | "invoiceQ"
  | "setInvoiceQ"
  | "outstandingInvoiceOptions"
  | "selectedInvoiceLabel"
  | "setSelectedInvoiceLabel"
  | "selectedInList"
  | "invoiceRemaining"
  | "recent"
  | "balanceWarn"
>;
export function VoucherPartyAllocationFields({
  isReceipt,
  branchId,
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
}: Props) {
  const [previewVoucherId, setPreviewVoucherId] = useState<number | null>(null);
  return (
    <Card>
      <CardHeader className="py-2.5 px-3.5">
        <CardTitle className="text-sm">الطرف المقابل</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2.5 px-3.5 pb-3.5 pt-0">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label>نوع الطرف *</Label>
            <span className="text-[11px] text-muted-foreground">
              {partyType === "OTHER" && "تأثير على الصندوق/الدفتر فقط"}
              {partyType === "CUSTOMER" &&
                (isReceipt ? "تخفيض ذمة العميل" : "استرداد للعميل")}
              {partyType === "SUPPLIER" &&
                (isReceipt
                  ? supplierReceiptPurpose === "ADVANCE_REFUND"
                    ? "استرداد دفعة سابقة"
                    : "يرفع مستحق المورد (له علينا)"
                  : "سداد من حساب الشركة للمورد")}
              {partyType === "DELIVERY_PARTY" &&
                (isReceipt ? "تحصيل عهدة التوصيل" : "صرف مستحقات التوصيل")}
            </span>
          </div>
          <AppSelect
            className="h-9"
            value={partyType}
            onValueChange={(value) => {
              const v = value as typeof partyType;
              setPartyType(v);
              setCustomerId(null);
              setSupplierId(null);
              setDeliveryPartyId(null);
              setInvoiceId(null);
            }}
          >
            <option value="OTHER">أخرى (راتب/إيجار/إيرادات متفرّقة…)</option>
            <option value="CUSTOMER">عميل</option>
            <option value="SUPPLIER">مورّد</option>
            <option value="DELIVERY_PARTY">جهة توصيل (COD / مستحقات)</option>
          </AppSelect>
        </div>

        {partyType === "CUSTOMER" && (
          <>
            <CustomerPicker
              customerId={customerId}
              onCustomerChange={(id) => {
                setCustomerId(id);
                setInvoiceId(null);
                setInvoiceQ("");
                setSelectedInvoiceLabel("");
              }}
              balance={customerData.data?.currentBalance}
            />
            {customerId != null && (
              <div className="space-y-1">
                <Label
                  className="flex items-center gap-1"
                  title={
                    !isReceipt
                      ? "هذا سند رد مبلغ للعميل: يسجل صرفاً فعلياً ويحدّث رصيده عند التنفيذ. اختيار فاتورة يخصم المبلغ من مدفوعها، وترك الاختيار فارغاً يرد المبلغ على حساب العميل."
                      : "اترك الاختيار فارغاً ليوزع النظام القبض تلقائياً من أقدم فواتير العميل المؤهلة في هذا الفرع. اختيار فاتورة يخصص القبض لها وحدها."
                  }
                >
                  {isReceipt
                    ? "تخصيص فاتورة محددة (اختياري)"
                    : "ربط الرد بفاتورة (اختياري)"}
                  <Info aria-hidden className="size-3 text-muted-foreground" />
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <UnifiedSearchInput
                    value={invoiceQ}
                    onChange={setInvoiceQ}
                    placeholder="ابحث برقم الفاتورة… (F2)"
                    barcode={true}
                    debounceMs={200}
                    size="default"
                  />
                  <AppSelect
                    value={invoiceId != null ? String(invoiceId) : "0"}
                    onValueChange={(v) => {
                      const id = v === "0" ? null : Number(v);
                      setInvoiceId(id);
                      if (id != null) {
                        const inv = outstandingInvoiceOptions.find(
                          (o) => Number(o.id) === id,
                        );
                        if (inv) {
                          setSelectedInvoiceLabel(
                            `فاتورة #${inv.invoiceNumber} — ${isReceipt ? "متبقٍّ" : "مدفوع"} ${fmt(isReceipt ? invoiceRemaining(inv) : inv.paidAmount)} د.ع`,
                          );
                        }
                      } else {
                        setSelectedInvoiceLabel("");
                      }
                    }}
                    aria-label="ربط السند بفاتورة"
                  >
                    <option value="0">— بلا ربط (توزيع تلقائي) —</option>
                    {invoiceId != null && !selectedInList && (
                      <option value={String(invoiceId)}>
                        {selectedInvoiceLabel || `فاتورة مُختارة #${invoiceId}`}
                      </option>
                    )}
                    {outstandingInvoiceOptions.map((inv) => (
                      <option key={Number(inv.id)} value={String(inv.id)}>
                        فاتورة #{inv.invoiceNumber} —{" "}
                        {isReceipt ? "متبقٍّ" : "مدفوع"}{" "}
                        {fmt(
                          isReceipt ? invoiceRemaining(inv) : inv.paidAmount,
                        )}{" "}
                        د.ع
                      </option>
                    ))}
                  </AppSelect>
                </div>
              </div>
            )}
          </>
        )}
        {partyType === "SUPPLIER" && (
          <>
            <SupplierPicker
              supplierId={supplierId}
              onSupplierChange={setSupplierId}
            />
            {!isReceipt && supplierId != null ? (
              <div className="text-xs text-muted-foreground">
                للدفع من محفظة الصيرفة، استخدم{" "}
                <Link href={`/exchange?tab=settle&supplierId=${supplierId}`} className="underline font-medium text-primary">
                  تسديد مورد عبر الصيرفة
                </Link>
                .
              </div>
            ) : null}
          </>
        )}
        {partyType === "DELIVERY_PARTY" && (
          <DeliveryPartyPicker
            partyId={deliveryPartyId}
            onPartyChange={setDeliveryPartyId}
            branchId={branchId}
          />
        )}
        {partyType === "OTHER" && (
          <div className="space-y-1">
            <Label title="موصى به — يمكن تقرير «كل ما دفع/قبض من فلان» (مفيد للرواتب والإيجارات المتكررة).">
              اسم المستفيد / الدافع
            </Label>
            <Input
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder={
                isReceipt
                  ? "مثلا: المستثمر / شركة الإعلان — تحصيل"
                  : "مثلا: المستثمر (مثل: سلمى أحمد) / الموظف أحمد محمد"
              }
            />
          </div>
        )}

        {balanceWarn && (
          <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-xs p-2 space-y-1.5">
            <div className="flex items-start gap-2">
              <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
              <span>{balanceWarn}</span>
            </div>
            {!isReceipt &&
              partyType === "SUPPLIER" &&
              supplierData.data?.supplierKind !== "CONSIGNOR" && (
                <label className="flex items-center gap-2 cursor-pointer text-foreground pt-1 border-t border-[var(--sem-warn)]/25">
                  <input
                    type="checkbox"
                    checked={allowSupplierOverpay}
                    onChange={(e) => setAllowSupplierOverpay(e.target.checked)}
                    className="rounded border-input"
                  />
                  <span>اعتماد الفرق الزائد كسلفة على الحساب (لنا عليه)</span>
                </label>
              )}
          </div>
        )}

        {(recent.data ?? []).length > 0 && (
          <div className="rounded-md border bg-muted/30 p-2.5 text-xs space-y-1.5">
            <div className="font-bold text-foreground flex items-center gap-1">
              <Info aria-hidden className="size-3.5" />
              <span>آخر سندات لنفس الطرف (7 أيام):</span>
            </div>
            {(recent.data ?? []).map((r) => (
              <div
                key={Number(r.id)}
                className="flex flex-wrap items-center justify-between gap-2 rounded bg-background/70 px-2 py-1 border"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="font-mono font-medium" dir="ltr">{r.voucherNumber}</span>
                  <Badge variant={r.approvalStatus === "PENDING_APPROVAL" ? "warning" : r.approvalStatus === "REJECTED" ? "destructive" : "success"}>
                    {voucherApprovalLabel(r)}
                  </Badge>
                  <PaymentMethodChip method={r.paymentMethod} />
                  <span className="text-[11px] text-muted-foreground">{fmtDate(r.voucherDate ?? r.createdAt)}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <bdi dir="ltr" className="tabular-nums font-semibold">{fmt(r.amount)} د.ع</bdi>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    title="معاينة السند"
                    onClick={() => setPreviewVoucherId(Number(r.id))}
                  >
                    <Eye aria-hidden className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <VoucherDetailDrawer
        voucherId={previewVoucherId}
        open={previewVoucherId != null}
        onOpenChange={(open) => {
          if (!open) setPreviewVoucherId(null);
        }}
      />
    </Card>
  );
}
