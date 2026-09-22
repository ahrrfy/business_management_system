import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileText, Receipt, ArrowDownLeft, ArrowUpRight, ShoppingCart } from "lucide-react";
import type { DrilldownTarget } from "./drilldown/types";
import { InvoiceDrilldownView } from "./drilldown/InvoiceDrilldownView";
import { PurchaseOrderDrilldownView } from "./drilldown/PurchaseOrderDrilldownView";
import { VoucherDrilldownView } from "./drilldown/VoucherDrilldownView";
import { GenericDrilldownView } from "./drilldown/GenericDrilldownView";

export type { DrilldownTarget };

interface AccountLedgerDrilldownDialogProps {
  target: DrilldownTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccountLedgerDrilldownDialog({
  target,
  open,
  onOpenChange,
}: AccountLedgerDrilldownDialogProps) {
  if (!target) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            {target.type === "INVOICE" ? (
              <>
                <FileText className="size-5 text-primary" />
                تفاصيل الفاتورة المستندية (حركة مدين)
              </>
            ) : target.type === "PURCHASE_ORDER" ? (
              <>
                <ShoppingCart className="size-5 text-primary" />
                تفاصيل فاتورة الشراء المستندية (حركة دائن)
              </>
            ) : target.type === "VOUCHER" ? (
              <>
                <Receipt className="size-5 text-money-positive" />
                تفاصيل السند المالي (حركة دائن / تسوية)
              </>
            ) : (
              <>
                {target.direction === "DEBIT" ? (
                  <ArrowUpRight className="size-5 text-[var(--sem-info)]" />
                ) : (
                  <ArrowDownLeft className="size-5 text-money-positive" />
                )}
                تفاصيل الحركة المالية
              </>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            عرض المستند الأصلي المصدر للحركة للتحقق والمطابقة المحاسبية.
          </DialogDescription>
        </DialogHeader>

        {target.type === "INVOICE" && <InvoiceDrilldownView invoiceId={target.invoiceId} />}
        {target.type === "PURCHASE_ORDER" && <PurchaseOrderDrilldownView poId={target.poId} />}
        {target.type === "VOUCHER" && <VoucherDrilldownView receiptId={target.receiptId} />}
        {target.type === "GENERIC" && <GenericDrilldownView target={target} />}
      </DialogContent>
    </Dialog>
  );
}
