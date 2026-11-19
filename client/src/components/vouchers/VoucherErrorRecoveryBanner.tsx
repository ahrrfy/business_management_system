import { FormError } from "@/components/form/FormError";
import { Button } from "@/components/ui/button";
import { D, fmt } from "@/lib/money";
import type Decimal from "decimal.js";
import { ArrowLeftRight, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import type { SupplierReceiptPurpose } from "@shared/balanceTrail";
import type { MethodValue } from "./voucherFormTypes";

interface VoucherErrorRecoveryBannerProps {
  err: string;
  direction: "IN" | "OUT";
  partyType: "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER";
  customerId: number | null;
  supplierId: number | null;
  invoiceId: number | null;
  method: MethodValue;
  amountDec: Decimal;
  supplierBalance?: string | null;
  supplierReceiptPurpose: SupplierReceiptPurpose;
  allowSupplierOverpay?: boolean;
  onEnableSupplierOverpay?: () => void;
  onApplySuggestedAmount: (amount: string) => void;
  onClearInvoice: () => void;
  onSwitchMethod: (method: MethodValue) => void;
  onSwitchSupplierCreditMode: () => void;
}

export function VoucherErrorRecoveryBanner({
  err,
  direction,
  partyType,
  customerId,
  supplierId,
  invoiceId,
  method,
  amountDec,
  supplierBalance,
  supplierReceiptPurpose,
  allowSupplierOverpay = false,
  onEnableSupplierOverpay,
  onApplySuggestedAmount,
  onClearInvoice,
  onSwitchMethod,
  onSwitchSupplierCreditMode,
}: VoucherErrorRecoveryBannerProps) {
  if (!err) return null;

  const supplierBalDec = D(supplierBalance ?? 0);
  const showCapToBalance =
    partyType === "SUPPLIER" &&
    direction === "OUT" &&
    supplierBalDec.gt(0) &&
    amountDec.gt(supplierBalDec);
  const showAllowOverpay =
    partyType === "SUPPLIER" &&
    direction === "OUT" &&
    !allowSupplierOverpay &&
    onEnableSupplierOverpay != null &&
    (err.includes("أقل") || err.includes("تتجاوز") || err.includes("المستحق"));
  const showUnlinkInvoice =
    partyType === "CUSTOMER" &&
    invoiceId != null &&
    (err.includes("فاتورة") || err.includes("متبق") || err.includes("مخصص"));
  const showShiftRecovery =
    method === "CASH" && (err.includes("وردية") || err.includes("درج"));
  const showReceiptModeSwitch =
    partyType === "SUPPLIER" &&
    direction === "IN" &&
    supplierReceiptPurpose === "ADVANCE_REFUND";
  const showCategoriesLink =
    partyType === "OTHER" && err.includes("فئة");

  return (
    <div className="space-y-2">
      <FormError message={err} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {partyType === "SUPPLIER" && supplierId != null && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/suppliers-statement?id=${supplierId}`}>
              <ExternalLink aria-hidden className="size-3.5 ms-1" />
              كشف حساب المورد
            </Link>
          </Button>
        )}
        {partyType === "CUSTOMER" && customerId != null && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/customers-statement?id=${customerId}`}>
              <ExternalLink aria-hidden className="size-3.5 ms-1" />
              كشف حساب العميل
            </Link>
          </Button>
        )}
        {showAllowOverpay && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onEnableSupplierOverpay}
          >
            تفعيل السماح بالسلفة على الحساب (لنا عليه)
          </Button>
        )}
        {showCapToBalance && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onApplySuggestedAmount(supplierBalDec.toFixed(2))}
          >
            <RefreshCw aria-hidden className="size-3.5 ms-1" />
            تحديد المبلغ بحد المستحق ({fmt(supplierBalDec.toFixed(2))} د.ع)
          </Button>
        )}
        {showReceiptModeSwitch && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSwitchSupplierCreditMode}
          >
            <ArrowLeftRight aria-hidden className="size-3.5 ms-1" />
            التبديل إلى قبض يرفع حساب المورد
          </Button>
        )}
        {showUnlinkInvoice && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClearInvoice}
          >
            فك ربط الفاتورة للتوزيع التلقائي على الحساب
          </Button>
        )}
        {showShiftRecovery && (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/shifts">فتح وردية</Link>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onSwitchMethod("TRANSFER")}
            >
              تغيير الطريقة إلى تحويل
            </Button>
          </>
        )}
        {showCategoriesLink && (
          <Button asChild variant="outline" size="sm">
            <Link href="/voucher-categories">إدارة فئات السندات</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
