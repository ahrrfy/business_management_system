import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSalesReturnPortal } from "./useSalesReturnPortal";
import type { SalesReturnPortalProps } from "./salesReturnPortalTypes";

import { SalesReturnSourceFields } from "./SalesReturnSourceFields";
import { SalesReturnInspectedInvoice } from "./SalesReturnInspectedInvoice";
import { SalesReturnCart } from "./SalesReturnCart";
import { SalesReturnSettlementPanel } from "./SalesReturnSettlementPanel";
export type { SalesCartItem } from "./salesReturnPortalTypes";
export function SalesReturnPortal(props: SalesReturnPortalProps) {
  const model = useSalesReturnPortal(props);
  const {
    operationPermission,
    activeBranchId,
    salesInvoiceNo,
    setSalesInvoiceNo,
    salesCustomerName,
    setSalesCustomerName,
    setSalesCustomerPhone,
    salesCustomerId,
    setSalesCustomerId,
    lastAddedId,
    salesCustomerSearch,
    setSalesCustomerSearch,
    debouncedCustomerSearch,
    customersQuery,
    salesDisposition,
    setSalesDisposition,
    salesCart,
    setSalesCart,
    salesRefundMethod,
    setSalesRefundMethod,
    salesCardRef,
    setSalesCardRef,
    salesReason,
    setSalesReason,
    openDrawersQ,
    openDrawers,
    selectedShiftId,
    setSelectedShiftId,
    setInspectedInvoice,
    inspectedInvoice,
    invoiceState,
    pending,
    withdrawing,
    canWithdraw,
    invoiceStateBlockReason,
    withdrawPending,
    salesTotal,
    hasIncompletePrice,
    salesTotalPieces,
    autoDebtOffsetPortion,
    effectiveCashOrCardRefund,
    noCashRequired,
    settlementMethod,
    creditOffsetCap,
    noCashNoAccount,
    isOverInvoiceLimit,
    isInvoiceFullyReturned,
    invoiceLookupLoading,
    handleLookupInvoice,
    handleAddProductFromSearch,
    handleAddInspectedItemToCart,
    handleAddAllRemainingItems,
    salesReturnMutation,
    pendingReturn,
    handleExecuteSalesReturn,
  } = model;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
      {pendingReturn && (
        <Card className="lg:col-span-12">
          <CardContent className="space-y-2 p-3 text-sm">
            <p>
              تعذرت معرفة نتيجة المرتجع السابق. استعد نتيجته بنفس الطلب قبل
              إنشاء مرتجع آخر.
            </p>
            <Button
              type="button"
              onClick={() => void handleExecuteSalesReturn()}
              disabled={
                !operationPermission.allowed || salesReturnMutation.isPending
              }
            >
              استعادة نتيجة المرتجع السابق
            </Button>
          </CardContent>
        </Card>
      )}
      {invoiceStateBlockReason && (
        <Card className="lg:col-span-12">
          <CardContent className="space-y-2 p-3 text-sm">
            <p>{invoiceStateBlockReason}</p>
            {pending && (
              <p className="text-xs text-muted-foreground">
                السبب: {pending.reason} · الطلب لم يُنفّذ، ولا يتغيّر المال أو
                المخزون بسحبه.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {canWithdraw && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void withdrawPending()}
                  disabled={withdrawing}
                >
                  سحب طلبي وإعادة إعداد المرتجع
                </Button>
              )}
              {pending?.canReviewIt && (
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={
                      pending.source === "CONTROL"
                        ? "/invoices?tab=controls"
                        : `/returns?requestId=${pending.id}`
                    }
                  >
                    مراجعة الطلب
                  </Link>
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void invoiceState.refetch();
                  void handleLookupInvoice(
                    invoiceState.data?.invoiceNumber ?? salesInvoiceNo,
                  );
                }}
                disabled={invoiceLookupLoading}
              >
                تحديث الفاتورة
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {/* العمود الرئيسي: السلة وبيانات العميل */}
      <div className="lg:col-span-8 space-y-3.5">
        {/* بطاقة بيانات الفاتورة والعميل والتصنيف المخزني — تصميم رشيق ومضغوط للأعلى */}
        <SalesReturnSourceFields
          {...{
            salesInvoiceNo,
            setSalesInvoiceNo,
            salesCustomerName,
            setSalesCustomerName,
            setSalesCustomerPhone,
            salesCustomerId,
            setSalesCustomerId,
            salesCustomerSearch,
            setSalesCustomerSearch,
            debouncedCustomerSearch,
            customersQuery,
            salesDisposition,
            setSalesDisposition,
            salesReason,
            setSalesReason,
            setInspectedInvoice,
            invoiceLookupLoading,
            handleLookupInvoice,
          }}
        />

        {/* كارت تفاصيل الفاتورة المفحوصة وسقف الاسترداد وبنودها الأصلية */}
        {inspectedInvoice && (
          <SalesReturnInspectedInvoice
            {...{
              setSalesInvoiceNo,
              salesCart,
              setSalesCart,
              salesRefundMethod,
              setSalesReason,
              setInspectedInvoice,
              inspectedInvoice,
              settlementMethod,
              noCashNoAccount,
              isInvoiceFullyReturned,
              handleAddInspectedItemToCart,
              handleAddAllRemainingItems,
            }}
          />
        )}

        {/* بطاقة مسح الباركود والبحث الموحد وسلة الأصناف */}
        <SalesReturnCart
          {...{
            activeBranchId,
            lastAddedId,
            salesCart,
            setSalesCart,
            salesTotal,
            salesTotalPieces,
            handleAddProductFromSearch,
          }}
        />
      </div>

      {/* العمود الجانبي: التسوية المالية والتأكيد الذري */}
      <div className="lg:col-span-4 space-y-3">
        <SalesReturnSettlementPanel
          {...{
            operationPermission,
            salesCart,
            salesRefundMethod,
            setSalesRefundMethod,
            salesCardRef,
            setSalesCardRef,
            openDrawersQ,
            openDrawers,
            selectedShiftId,
            setSelectedShiftId,
            inspectedInvoice,
            withdrawing,
            invoiceStateBlockReason,
            salesTotal,
            hasIncompletePrice,
            salesTotalPieces,
            autoDebtOffsetPortion,
            effectiveCashOrCardRefund,
            noCashRequired,
            settlementMethod,
            creditOffsetCap,
            noCashNoAccount,
            isOverInvoiceLimit,
            isInvoiceFullyReturned,
            salesReturnMutation,
            pendingReturn,
            handleExecuteSalesReturn,
          }}
        />
      </div>
    </div>
  );
}
