import { useMemo } from "react";
import { composeCustomizationText } from "@/components/CustomizationDialog";
import type { CartLine } from "./cartMath";
import { ReceptionDuplicateAlert } from "./ReceptionDuplicateAlert";
import type { WorkOrderChannel } from "@shared/receptionChannel";
import type { ReceptionDuplicateInput } from "@shared/receptionDuplicateOrders";

/** Remote baskets only: connection state is handled inside the alert so offline stays visible. */
export function ReceptionCartDuplicateAlert({
  branchId,
  phone,
  customerId,
  channel,
  cart,
  total,
  draftId,
  disabled,
  onVerify,
}: {
  branchId: number;
  phone: string;
  customerId?: number | null;
  channel: WorkOrderChannel;
  cart: CartLine[];
  total: string;
  draftId?: number;
  disabled: boolean;
  onVerify: () => void;
}) {
  const input = useMemo<ReceptionDuplicateInput | null>(() => {
    if (disabled || !cart.length || channel === "WALK_IN") return null;
    return {
      branchId,
      phone: phone || undefined,
      customerId: customerId ?? undefined,
      channel,
      excludeDraftId: draftId,
      total,
      lines: cart.map((line) => ({
        lineKind: line.custom
          ? "CUSTOM"
          : line.row.isPrintService
            ? "PRINT"
            : "GOODS",
        variantId: line.manualService ? null : line.row.variantId || null,
        productUnitId: line.manualService
          ? null
          : line.row.productUnitId || null,
        quantity: String(line.qty),
        title: line.custom?.title || line.row.productName,
        customizationText: line.custom
          ? composeCustomizationText(line.custom)
          : null,
        printSpec: line.custom
          ? JSON.stringify({
              ...line.custom,
              designImages: [],
              paymentReceiptImages: [],
            })
          : null,
      })),
    };
  }, [disabled, cart, channel, branchId, phone, customerId, draftId, total]);
  return (
    <ReceptionDuplicateAlert
      input={input}
      enabled={!disabled}
      onVerify={onVerify}
    />
  );
}
