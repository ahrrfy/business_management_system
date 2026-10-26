import React from "react";
import { useLocation, useSearch } from "wouter";
import { AccountLedgerDrilldownDialog } from "@/components/financial/AccountLedgerDrilldownDialog";

/** Opens linked receipts without losing the treasury tab or list filters. */
export function VoucherDeepLinkDialog() {
  const search = useSearch();
  const [pathname, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get("voucherId") ?? "";
  const receiptId = /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return null;
  return (
    <AccountLedgerDrilldownDialog
      target={{ type: "VOUCHER", receiptId }}
      open
      onOpenChange={(open) => {
        if (open) return;
        params.delete("voucherId");
        const query = params.toString();
        navigate(`${pathname}${query ? `?${query}` : ""}`, { replace: true });
      }}
    />
  );
}
