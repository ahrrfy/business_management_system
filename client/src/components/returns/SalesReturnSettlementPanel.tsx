import { AlertCircle, FileCheck, Receipt, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";
import { SalesReturnSettlementMethods } from "./SalesReturnSettlementMethods";
type Props = Pick<
  SalesReturnPortalModel,
  | "operationPermission"
  | "salesCart"
  | "salesRefundMethod"
  | "setSalesRefundMethod"
  | "salesCardRef"
  | "setSalesCardRef"
  | "openDrawersQ"
  | "openDrawers"
  | "selectedShiftId"
  | "setSelectedShiftId"
  | "inspectedInvoice"
  | "withdrawing"
  | "invoiceStateBlockReason"
  | "salesTotal"
  | "hasIncompletePrice"
  | "salesTotalPieces"
  | "autoDebtOffsetPortion"
  | "effectiveCashOrCardRefund"
  | "noCashRequired"
  | "settlementMethod"
  | "creditOffsetCap"
  | "noCashNoAccount"
  | "isOverInvoiceLimit"
  | "isInvoiceFullyReturned"
  | "salesReturnMutation"
  | "pendingReturn"
  | "handleExecuteSalesReturn"
>;
export function SalesReturnSettlementPanel({
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
}: Props) {
  return (
    <Card className="shadow-sm border-emerald-500/30">
      <CardHeader className="p-3 pb-2 border-b bg-muted/20">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Wallet className="size-4 text-emerald-600" aria-hidden />
          <span>طريقة الاسترداد المالي والتأكيد</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-2.5">
        {/* كارت المبلغ الإجمالي */}
        <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-center space-y-0.5">
          <span className="text-xs text-muted-foreground font-medium">
            قيمة المرتجع
          </span>
          <div className="text-xl font-black text-emerald-700 dark:text-emerald-400 font-mono">
            {fmt(String(salesTotal))}{" "}
            <span className="text-xs font-bold">د.ع</span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            إجمالي الأصناف: {salesCart.length} ({salesTotalPieces} قطعة)
          </span>
          {(salesRefundMethod === "CASH" || salesRefundMethod === "CARD") &&
            autoDebtOffsetPortion > 0 &&
            effectiveCashOrCardRefund > 0 && (
              <div className="mt-2 pt-2 border-t border-emerald-500/20 text-right space-y-1 text-[11px]">
                <div className="font-bold text-emerald-900 dark:text-emerald-200 flex items-center justify-between">
                  <span>تفصيل التسوية الذرية المركبة:</span>
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 border-emerald-600 text-emerald-700"
                  >
                    تلقائي 100%
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>• إسقاط مديونية آجلة من ذمة العميل:</span>
                  <span className="font-mono font-bold text-amber-700 dark:text-amber-400">
                    {fmt(String(autoDebtOffsetPortion))} د.ع
                  </span>
                </div>
                <div className="flex items-center justify-between text-emerald-800 dark:text-emerald-300 font-bold">
                  <span>
                    • صافي المسترد للعميل (
                    {salesRefundMethod === "CASH"
                      ? "نقداً من الدرج"
                      : "بالبطاقة"}
                    ):
                  </span>
                  <span className="font-mono font-black text-xs">
                    {fmt(String(effectiveCashOrCardRefund))} د.ع
                  </span>
                </div>
              </div>
            )}
        </div>

        {/* اختيار طريقة الاسترداد */}
        {noCashRequired && salesTotal > 0 ? (
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            {noCashNoAccount
              ? "تخفيض المتبقي على الفاتورة — بلا استرداد مالي"
              : "تسوية المتبقي على الفاتورة — بلا صرف نقد أو اختيار درج"}
          </div>
        ) : (
          <SalesReturnSettlementMethods
            {...{
              salesRefundMethod,
              setSalesRefundMethod,
              salesCardRef,
              setSalesCardRef,
              openDrawersQ,
              openDrawers,
              selectedShiftId,
              setSelectedShiftId,
              inspectedInvoice,
              salesTotal,
              effectiveCashOrCardRefund,
            }}
          />
        )}

        {/* سقف الاسترداد المالي للفاتورة إن وجدت */}
        {inspectedInvoice && (
          <div
            className={cn(
              "p-3 rounded-xl border text-xs space-y-1.5",
              isInvoiceFullyReturned ||
                isOverInvoiceLimit ||
                inspectedInvoice.isDead
                ? "bg-destructive/10 border-destructive/40 text-destructive"
                : "bg-emerald-500/10 border-emerald-500/30 text-emerald-950 dark:text-emerald-200",
            )}
          >
            <div className="flex items-center justify-between font-bold">
              <span className="flex items-center gap-1.5">
                <FileCheck className="size-3.5 text-emerald-600" />
                {settlementMethod === "CREDIT_OFFSET"
                  ? `سقف تخفيض المتبقي على الفاتورة #${inspectedInvoice.invoiceNumber}`
                  : salesRefundMethod === "STORE_CREDIT"
                    ? `سقف رصيد المتجر #${inspectedInvoice.invoiceNumber}`
                    : `سقف الاسترداد النقدي #${inspectedInvoice.invoiceNumber}`}
              </span>
              <span className="font-mono font-black text-sm">
                {fmt(
                  settlementMethod === "CREDIT_OFFSET"
                    ? creditOffsetCap
                    : salesRefundMethod === "STORE_CREDIT"
                      ? inspectedInvoice.remainingInvoiceTotal
                      : inspectedInvoice.maxRefundable,
                )}{" "}
                د.ع
              </span>
            </div>
            {isInvoiceFullyReturned ? (
              <div className="text-[11px] font-medium flex items-center gap-1 text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>
                  تم إرجاع هذه الفاتورة بالكامل ({inspectedInvoice.status}) ولا
                  تقبل مرتجعات
                </span>
              </div>
            ) : inspectedInvoice.isDead ? (
              <div className="text-[11px] font-medium flex items-center gap-1 text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>
                  الفاتورة مغلقة أو مسترجعة بالكامل ({inspectedInvoice.status})
                  ولا تقبل مرتجعات
                </span>
              </div>
            ) : isOverInvoiceLimit ? (
              <div className="text-[11px] font-medium flex items-center gap-1 text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>
                  {salesRefundMethod === "CASH" || salesRefundMethod === "CARD"
                    ? Number(inspectedInvoice.paidAmount || 0) <= 0
                      ? "الفاتورة آجلة بالكامل ولم يُدفع منها نقد — يرجى اختيار [معادلة ذمم] لتسوية الحساب دون صرف نقد"
                      : salesTotal > 0 && effectiveCashOrCardRefund <= 0
                        ? "قيمة المرتجع تقع بالكامل ضمن الجزء الآجل — اختر [معادلة ذمم] لإسقاطها من ذمة العميل"
                        : `تجاوز سقف الاسترداد النقدي بمقدار (${fmt(String(effectiveCashOrCardRefund - Number(inspectedInvoice.maxRefundable || 0)))} د.ع)`
                    : salesRefundMethod === "CREDIT_OFFSET"
                      ? `تجاوز الرصيد الآجل القابل للمعادلة بمقدار (${fmt(String(salesTotal - Number(inspectedInvoice.unpaidAmount || 0)))} د.ع) — اختر [صرف نقدي / بطاقة] لتسوية الجزء الآجل وصرف المدفوع معاً`
                      : `تجاوز سقف الفاتورة المتبقي بمقدار (${fmt(String(salesTotal - Number(inspectedInvoice.remainingInvoiceTotal || 0)))} د.ع)`}
                </span>
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground flex items-center justify-between">
                <span>المدفوع: {fmt(inspectedInvoice.paidAmount)} د.ع</span>
                <span>المرتجع: {fmt(inspectedInvoice.returnedTotal)} د.ع</span>
                {Number(inspectedInvoice.unpaidAmount || 0) > 0 && (
                  <span className="text-amber-700 dark:text-amber-400 font-semibold">
                    الآجل: {fmt(inspectedInvoice.unpaidAmount)} د.ع
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* زر التنفيذ النهائي */}
        <Button
          type="button"
          onClick={() => void handleExecuteSalesReturn()}
          disabled={
            !operationPermission.allowed ||
            !!pendingReturn ||
            !!invoiceStateBlockReason ||
            withdrawing ||
            salesReturnMutation.isPending ||
            salesCart.length === 0 ||
            hasIncompletePrice ||
            salesTotal <= 0 ||
            (inspectedInvoice != null &&
              (isInvoiceFullyReturned ||
                inspectedInvoice.isDead ||
                inspectedInvoice.isOtherBranch ||
                isOverInvoiceLimit))
          }
          className="w-full h-12 text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white gap-2 shadow-sm cursor-pointer disabled:opacity-50"
        >
          <Receipt className="size-5" />
          <span>
            {salesReturnMutation.isPending
              ? "جاري تنفيذ المرتجع..."
              : inspectedInvoice?.isOtherBranch
                ? "الفاتورة صادرة من فرع آخر — محظور الإرجاع"
                : isInvoiceFullyReturned
                  ? "الفاتورة مسترجعة بالكامل — لا يمكن الإرجاع"
                  : "تأكيد المرتجع وطباعة الإيصال"}
          </span>
        </Button>
      </CardContent>
    </Card>
  );
}
