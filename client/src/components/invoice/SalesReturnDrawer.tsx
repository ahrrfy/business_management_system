import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import { RotateCcw } from "lucide-react";

export interface SalesReturnDrawerProps {
  invoiceId: number | null;
  onClose: () => void;
  onSuccess?: () => void;
}

export function SalesReturnDrawer({
  invoiceId,
  onClose,
  onSuccess,
}: SalesReturnDrawerProps) {
  const isOpen = invoiceId != null && invoiceId > 0;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl overflow-y-auto space-y-4"
        dir="rtl"
      >
        <SheetHeader className="border-b pb-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <RotateCcw aria-hidden className="size-5 text-primary" />
            <span>إرجاع مبيعات — الفاتورة #{invoiceId ?? ""}</span>
          </SheetTitle>
        </SheetHeader>

        {invoiceId ? (
          <ReturnComposer
            invoiceId={invoiceId}
            onDone={() => {
              onSuccess?.();
              onClose();
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
