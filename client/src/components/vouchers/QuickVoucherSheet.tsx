import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import VoucherFormShared from "@/components/vouchers/VoucherFormShared";

export interface QuickVoucherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType: "PAYMENT" | "RECEIPT";
  defaultPartyType: "SUPPLIER" | "CUSTOMER";
  defaultPartyId?: number;
  defaultPartyName?: string;
  defaultAmount?: string;
  currentBalance?: string;
  pendingReserved?: string;
  onSuccess?: () => void;
}

export function QuickVoucherSheet({
  open,
  onOpenChange,
  defaultType,
  defaultPartyType,
  defaultPartyId,
  defaultPartyName,
  defaultAmount,
  currentBalance,
  pendingReserved,
  onSuccess,
}: QuickVoucherSheetProps) {
  const title =
    defaultType === "PAYMENT" ? "سند صرف سريع" : "سند قبض سريع";
  const partyLabel = defaultPartyType === "SUPPLIER" ? "مورد" : "عميل";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        dir="rtl"
        className="w-full sm:max-w-3xl overflow-y-auto p-4 sm:p-6"
      >
        <SheetHeader className="text-start border-b pb-3">
          <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
            <span>{title}</span>
            {defaultPartyName ? (
              <Badge variant="outline">
                {partyLabel}: {defaultPartyName}
              </Badge>
            ) : null}
          </SheetTitle>
          <SheetDescription>
            تسجيل السند وتحديث الرصيد مباشرة دون مغادرة الشاشة الحالية.
          </SheetDescription>
        </SheetHeader>
        <div className="pt-3">
          <VoucherFormShared
            key={`${defaultType}:${defaultPartyType}:${defaultPartyId ?? ""}:${defaultAmount ?? ""}:${open}`}
            voucherType={defaultType}
            embedded
            initialPartyType={defaultPartyType}
            initialPartyId={defaultPartyId ?? null}
            initialAmount={defaultAmount ?? ""}
            initialCurrentBalance={currentBalance}
            initialPendingReserved={pendingReserved}
            onSubmitted={() => {
              onOpenChange(false);
              onSuccess?.();
            }}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
