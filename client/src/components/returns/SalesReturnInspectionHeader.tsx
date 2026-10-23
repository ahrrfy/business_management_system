import { FileCheck, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";

type Props = Omit<
  Pick<
    SalesReturnPortalModel,
    | "setSalesInvoiceNo"
    | "salesCart"
    | "setSalesCart"
    | "setSalesReason"
    | "setInspectedInvoice"
    | "inspectedInvoice"
    | "isInvoiceFullyReturned"
    | "handleAddAllRemainingItems"
  >,
  "inspectedInvoice"
> & {
  inspectedInvoice: NonNullable<SalesReturnPortalModel["inspectedInvoice"]>;
};
export function SalesReturnInspectionHeader({
  setSalesInvoiceNo,
  salesCart,
  setSalesCart,
  setSalesReason,
  setInspectedInvoice,
  inspectedInvoice,
  isInvoiceFullyReturned,
  handleAddAllRemainingItems,
}: Props) {
  return (
    <CardHeader className="p-3 pb-2 flex flex-row items-center justify-between gap-2 border-b">
      <div className="flex items-center gap-2 flex-wrap">
        <FileCheck
          className={cn(
            "size-4",
            inspectedInvoice.isOtherBranch
              ? "text-amber-600"
              : isInvoiceFullyReturned
                ? "text-destructive"
                : "text-emerald-600",
          )}
        />
        <span className="font-bold text-sm">
          فاتورة المبيعات #{inspectedInvoice.invoiceNumber}
        </span>
        <Badge
          variant={
            isInvoiceFullyReturned || inspectedInvoice.isDead
              ? "destructive"
              : "outline"
          }
          className="text-[10px] font-normal"
        >
          {inspectedInvoice.status}
        </Badge>
        {inspectedInvoice.isOtherBranch && (
          <Badge
            variant="destructive"
            className="text-[11px] font-bold bg-amber-600 text-white"
          >
            فرع آخر #{inspectedInvoice.originBranchId}
          </Badge>
        )}
        {isInvoiceFullyReturned && (
          <Badge
            variant="destructive"
            className="text-[11px] font-bold bg-destructive text-destructive-foreground animate-pulse"
          >
            تم إرجاع هذه الفاتورة
          </Badge>
        )}
        {inspectedInvoice.customerName && (
          <span className="text-xs text-muted-foreground font-medium">
            العميل: {inspectedInvoice.customerName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {!isInvoiceFullyReturned &&
          !inspectedInvoice.isOtherBranch &&
          inspectedInvoice.items.some((i) => i.remainingQuantity > 0) && (
            <>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => {
                  handleAddAllRemainingItems();
                  setSalesReason(
                    (prev) => prev.trim() || "إرجاع كامل الفاتورة",
                  );
                }}
                className="h-7 text-xs px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs"
              >
                <RotateCcw className="size-3 ml-1" />
                مرتجع كامل للفاتورة (إرجاع كافة البنود المتبقية)
              </Button>
              {salesCart.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSalesCart([])}
                  className="h-7 text-xs px-2 bg-background border-border"
                >
                  تصفير لتحديد مرتجع جزئي
                </Button>
              )}
            </>
          )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setInspectedInvoice(null);
            setSalesInvoiceNo("");
          }}
          className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
        >
          إلغاء الفحص
        </Button>
      </div>
    </CardHeader>
  );
}
