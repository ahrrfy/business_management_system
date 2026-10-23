import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SalesReturnPortalModel } from "./useSalesReturnPortal";
import { SalesReturnInspectionHeader } from "./SalesReturnInspectionHeader";
import { SalesReturnInspectionBody } from "./SalesReturnInspectionBody";
type Props = Omit<
  Pick<
    SalesReturnPortalModel,
    | "setSalesInvoiceNo"
    | "salesCart"
    | "setSalesCart"
    | "salesRefundMethod"
    | "setSalesReason"
    | "setInspectedInvoice"
    | "inspectedInvoice"
    | "settlementMethod"
    | "noCashNoAccount"
    | "isInvoiceFullyReturned"
    | "handleAddInspectedItemToCart"
    | "handleAddAllRemainingItems"
  >,
  "inspectedInvoice"
> & {
  inspectedInvoice: NonNullable<SalesReturnPortalModel["inspectedInvoice"]>;
};
export function SalesReturnInspectedInvoice({
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
}: Props) {
  return (
    <Card
      className={cn(
        "shadow-xs border-2 transition-all",
        inspectedInvoice.isOtherBranch
          ? "border-amber-500/60 bg-amber-50/20 dark:bg-amber-950/10"
          : isInvoiceFullyReturned
            ? "border-destructive/60 bg-destructive/5"
            : inspectedInvoice.isDead
              ? "border-destructive/40 bg-destructive/5"
              : "border-emerald-500/40 bg-emerald-50/20 dark:bg-emerald-950/10",
      )}
    >
      <SalesReturnInspectionHeader
        {...{
          setSalesInvoiceNo,
          salesCart,
          setSalesCart,
          setSalesReason,
          setInspectedInvoice,
          inspectedInvoice,
          isInvoiceFullyReturned,
          handleAddAllRemainingItems,
        }}
      />
      <SalesReturnInspectionBody
        {...{
          salesCart,
          salesRefundMethod,
          inspectedInvoice,
          settlementMethod,
          noCashNoAccount,
          isInvoiceFullyReturned,
          handleAddInspectedItemToCart,
        }}
      />
    </Card>
  );
}
