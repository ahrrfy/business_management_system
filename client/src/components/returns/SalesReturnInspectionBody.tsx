import { AlertCircle, Plus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmt, formatQuantity } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { returnMethodLabel } from "@/lib/returnMethodLabel";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";

type Props = Omit<
  Pick<
    SalesReturnPortalModel,
    | "salesCart"
    | "salesRefundMethod"
    | "inspectedInvoice"
    | "settlementMethod"
    | "noCashNoAccount"
    | "isInvoiceFullyReturned"
    | "handleAddInspectedItemToCart"
  >,
  "inspectedInvoice"
> & {
  inspectedInvoice: NonNullable<SalesReturnPortalModel["inspectedInvoice"]>;
};
export function SalesReturnInspectionBody({
  salesCart,
  salesRefundMethod,
  inspectedInvoice,
  settlementMethod,
  noCashNoAccount,
  isInvoiceFullyReturned,
  handleAddInspectedItemToCart,
}: Props) {
  return (
    <CardContent className="p-3 space-y-3">
      {inspectedInvoice.isOtherBranch && (
        <div className="p-3 rounded-lg border-2 border-amber-600 bg-amber-500/10 text-amber-800 dark:text-amber-200 flex items-center gap-2.5">
          <AlertCircle className="size-5 shrink-0 text-amber-600" />
          <div className="text-xs">
            <span className="font-bold">
              تنبيه حوكمة: الفاتورة صادرة من فرع آخر (#
              {inspectedInvoice.originBranchId})!
            </span>
            <span className="block text-[11px] text-muted-foreground mt-0.5">
              يُحظر إرجاع فواتير الفروع الأخرى على مستوى الكاشير منعاً لاختلال
              الصناديق وتكرار الصرف. يرجى توجيه العميل للفرع المصدِر أو مراجعة
              المدير العام.
            </span>
          </div>
        </div>
      )}
      {isInvoiceFullyReturned && (
        <div className="p-3 rounded-lg border-2 border-destructive bg-destructive/10 text-destructive flex items-center gap-2.5">
          <AlertCircle className="size-5 shrink-0" />
          <div className="text-xs">
            <span className="font-bold">
              تنبيه: تم إرجاع هذه الفاتورة بالكامل مسبقاً!
            </span>
            <span className="block text-[11px] text-muted-foreground mt-0.5">
              لا يمكن إضافة بنود أو تنفيذ أي عمليات استرداد إضافية على هذه
              الفاتورة (إجمالي المرتجع: {fmt(inspectedInvoice.returnedTotal)}{" "}
              د.ع).
            </span>
          </div>
        </div>
      )}

      {/* المؤشرات المالية للفاتورة */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
        <div className="p-2 rounded-lg bg-background border shadow-2xs">
          <div className="text-[10px] text-muted-foreground">
            إجمالي الفاتورة
          </div>
          <div className="font-bold font-mono text-foreground mt-0.5">
            {fmt(inspectedInvoice.total)} د.ع
          </div>
        </div>
        <div className="p-2 rounded-lg bg-background border shadow-2xs">
          <div className="text-[10px] text-muted-foreground">
            المدفوع نقداً/بطاقة
          </div>
          <div className="font-bold font-mono text-emerald-700 dark:text-emerald-400 mt-0.5">
            {fmt(inspectedInvoice.paidAmount)} د.ع
          </div>
        </div>
        <div className="p-2 rounded-lg bg-background border shadow-2xs">
          <div className="text-[10px] text-muted-foreground">
            المرتجع سابقاً
          </div>
          <div className="font-bold font-mono text-muted-foreground mt-0.5">
            {fmt(inspectedInvoice.returnedTotal)} د.ع
          </div>
        </div>
        <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 shadow-2xs">
          <div className="text-[10px] text-emerald-800 dark:text-emerald-300 font-bold">
            {settlementMethod === "CREDIT_OFFSET"
              ? noCashNoAccount
                ? "سقف تخفيض المتبقي على الفاتورة"
                : "سقف معادلة الذمم"
              : salesRefundMethod === "STORE_CREDIT"
                ? "سقف رصيد المتجر (المتبقي)"
                : "سقف الاسترداد المتاح"}
          </div>
          <div className="font-black font-mono text-emerald-700 dark:text-emerald-400 mt-0.5">
            {fmt(
              settlementMethod === "CREDIT_OFFSET" ||
                salesRefundMethod === "STORE_CREDIT"
                ? inspectedInvoice.remainingInvoiceTotal
                : inspectedInvoice.maxRefundable,
            )}{" "}
            د.ع
          </div>
        </div>
      </div>

      {/* جدول بنود الفاتورة الأصلية ومتاح الإرجاع */}
      {inspectedInvoice.items.length > 0 && (
        <div className="border rounded-lg overflow-hidden shadow-2xs bg-background">
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-xs text-right">
              <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10 text-muted-foreground font-semibold border-b">
                <tr>
                  <th className="p-2">الصنف</th>
                  <th className="p-2 text-center">الكمية المباعة</th>
                  <th className="p-2 text-center">المسترجع</th>
                  <th className="p-2 text-center">المتبقي</th>
                  <th className="p-2">سعر الوحدة</th>
                  <th className="p-2 text-center w-28">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inspectedInvoice.items.map((it) => {
                  const cartItem = salesCart.find(
                    (c) =>
                      c.invoiceItemId === it.invoiceItemId ||
                      (!c.invoiceItemId && c.variantId === it.variantId),
                  );
                  const inCartQty = cartItem?.quantity || 0;
                  return (
                    <tr key={it.invoiceItemId} className="hover:bg-muted/30">
                      <td className="p-2 font-medium">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{it.productName}</span>
                          {it.isBundle && (
                            <Badge
                              variant="secondary"
                              className="text-[9px] px-1 py-0 bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300 border-blue-300"
                            >
                              بكج مركب
                            </Badge>
                          )}
                          {it.isService && (
                            <Badge
                              variant="secondary"
                              className="text-[9px] px-1 py-0 bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border-purple-300"
                            >
                              خدمة
                            </Badge>
                          )}
                        </div>
                        {it.barcode && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {it.barcode}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-center font-mono">
                        {formatQuantity(it.baseQuantity)}
                      </td>
                      <td className="p-2 text-center font-mono text-muted-foreground">
                        {formatQuantity(it.returnedBaseQuantity)}
                      </td>
                      <td className="p-2 text-center font-mono font-bold text-foreground">
                        {formatQuantity(it.remainingQuantity)}
                      </td>
                      <td className="p-2 font-mono">{fmt(it.unitPrice)} د.ع</td>
                      <td className="p-2 text-center">
                        {inspectedInvoice.isOtherBranch ? (
                          <span className="text-[10px] text-amber-600 font-semibold">
                            محظور (فرع آخر)
                          </span>
                        ) : isInvoiceFullyReturned ||
                          it.remainingQuantity <= 0 ? (
                          <span className="text-[10px] text-muted-foreground">
                            مرتجع بالكامل
                          </span>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleAddInspectedItemToCart(it)}
                            className="h-6 text-[11px] px-2 gap-1 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 hover:bg-emerald-50"
                          >
                            <Plus className="size-2.5" />
                            <span>
                              {inCartQty > 0
                                ? `في السلة (${formatQuantity(inCartQty)})`
                                : "إضافة"}
                            </span>
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* سجل المرتجعات السابقة للفاتورة إن وجدت */}
      {inspectedInvoice.previousReturns &&
        inspectedInvoice.previousReturns.length > 0 && (
          <div className="space-y-2 pt-2 border-t">
            <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
              <History className="size-3.5 text-muted-foreground" />
              <span>
                سجل حركات المرتجعات السابقة على الفاتورة (
                {inspectedInvoice.previousReturns.length})
              </span>
            </div>
            <div className="border rounded-lg overflow-x-auto bg-background">
              <table className="w-full text-xs text-right">
                <thead className="bg-muted/70 text-muted-foreground font-semibold border-b">
                  <tr>
                    <th className="p-2">رقم المرتجع</th>
                    <th className="p-2">التاريخ والوقت</th>
                    <th className="p-2">الكاشير</th>
                    <th className="p-2">طريقة الرد</th>
                    <th className="p-2 text-left">قيمة المرتجع</th>
                    <th className="p-2 text-left">المصروف للزبون</th>
                    <th className="p-2">الأصناف المسترجعة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {inspectedInvoice.previousReturns.map((ret) => (
                    <tr key={ret.id} className="hover:bg-muted/20">
                      <td className="p-2 font-mono font-bold text-destructive">
                        {ret.returnNumber}
                      </td>
                      <td className="p-2 font-mono text-[11px] text-muted-foreground">
                        {fmtDateTime(ret.createdAt)}
                      </td>
                      <td className="p-2">{ret.performedByName}</td>
                      <td className="p-2">
                        <Badge variant="outline" className="text-[10px]">
                          {returnMethodLabel(ret.method)}
                        </Badge>
                      </td>
                      <td className="p-2 text-left font-mono font-bold">
                        {ret.amountSource === "LEDGER_ONLY" ? "قيمة القيد: " : ""}{fmt(ret.amount)} د.ع
                      </td>
                      <td className="p-2 text-left font-mono">
                        {ret.payoutAmount == null ? "—" : `${fmt(ret.payoutAmount)} د.ع`}
                      </td>
                      <td className="p-2">
                        {ret.items && ret.items.length > 0 ? (
                          <div className="space-y-0.5">
                            {ret.items.map((item, idx) => (
                              <div
                                key={idx}
                                className="text-[11px] text-muted-foreground"
                              >
                                • {item.name}{" "}
                                <span className="font-mono text-foreground font-semibold">
                                  ({formatQuantity(item.quantity)})
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </CardContent>
  );
}
