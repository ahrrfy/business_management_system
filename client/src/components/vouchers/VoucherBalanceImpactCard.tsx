import {
  BalanceSnapshotStrip,
  PaymentMethodChip,
} from "@/components/common/MovementBadges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { D } from "@/lib/money";
import type Decimal from "decimal.js";

function formatUsdAmount(raw: string | null | undefined): string {
  const d = D(raw ?? 0);
  const neg = d.isNegative() ? "-" : "";
  const [intPart, decPart] = d.abs().toFixed(2).split(".");
  return `${neg}${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decPart}`;
}

interface VoucherBalanceImpactCardProps {
  direction: "IN" | "OUT";
  partyType: "CUSTOMER" | "SUPPLIER" | "DELIVERY_PARTY" | "OTHER";
  amountDec: Decimal;
  method: string;
  cardLastFour?: string | null;
  treasuryNotice: boolean;
  awaitsOwnerDisbursement: boolean;
  customerBalance?: string | null;
  supplierBalance?: string | null;
  supplierBalanceUsd?: string | null;
  pendingReserved?: string | null;
}

export function VoucherBalanceImpactCard({
  direction,
  partyType,
  amountDec,
  method,
  cardLastFour,
  treasuryNotice,
  awaitsOwnerDisbursement,
  customerBalance,
  supplierBalance,
  supplierBalanceUsd,
  pendingReserved,
}: VoucherBalanceImpactCardProps) {
  const expectedBucket =
    method === "CASH"
      ? direction === "OUT" || treasuryNotice
        ? "TREASURY"
        : "DRAWER"
      : null;

  const isPartyLedger =
    (partyType === "SUPPLIER" && supplierBalance != null) ||
    (partyType === "CUSTOMER" && customerBalance != null);

  const rawBefore =
    partyType === "SUPPLIER" ? supplierBalance : customerBalance;
  const amountStr = amountDec.gt(0) ? amountDec.toFixed(2) : "0.00";
  const hasUsdRef =
    partyType === "SUPPLIER" &&
    supplierBalanceUsd != null &&
    D(supplierBalanceUsd).abs().gt(0);

  const isPendingDisbursement = direction === "OUT" || awaitsOwnerDisbursement;

  return (
    <Card>
      <CardContent className="space-y-2.5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-foreground">
              أثر السند ومصدر النقد:
            </span>
            <PaymentMethodChip
              method={method}
              cashBucket={expectedBucket}
              cardLastFour={method === "CARD" ? cardLastFour : null}
            />
            <Badge variant={isPendingDisbursement ? "warning" : "success"}>
              {isPendingDisbursement
                ? "طلب صرف — ينتظر اعتماد المالك"
                : "تثبيت فوري عند الحفظ"}
            </Badge>
          </div>
          {hasUsdRef && (
            <Badge variant="outline">
              <span>مرجع الدولار المستقل: </span>
              <bdi dir="ltr" className="tabular-nums ms-1">
                ${formatUsdAmount(supplierBalanceUsd)}
              </bdi>
            </Badge>
          )}
        </div>

        {isPartyLedger && rawBefore != null ? (
          <BalanceSnapshotStrip
            partyType={partyType === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER"}
            before={rawBefore}
            debit={direction === "OUT" ? amountStr : "0.00"}
            credit={direction === "IN" ? amountStr : "0.00"}
            pendingReserved={pendingReserved}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
