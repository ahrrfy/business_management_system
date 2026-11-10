import React, { useEffect, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { ReceptionCollectSection } from "@/components/reception/ReceptionCollectSection";

const DeliveryPaymentRefunds = lazyWithRetry(() =>
  import("@/components/delivery/DeliveryFeeRefunds").then((m) => ({
    default: m.DeliveryPaymentRefunds,
  })),
);
const ChargeExcessRefundWorkspace = lazyWithRetry(() =>
  import("@/components/fulfillment/ChargeExcessRefundWorkspace").then((m) => ({
    default: m.ChargeExcessRefundWorkspace,
  })),
);
const ChargesWorkspace = lazyWithRetry(() =>
  import("@/components/fulfillment/ChargesWorkspace").then((m) => ({
    default: m.ChargesWorkspace,
  })),
);

type LegacyProps = React.ComponentProps<typeof ReceptionCollectSection>;
export function WorkflowCollectStation({
  action,
  onAction,
  chargeId,
  refundCodes,
  hideActionSwitch = false,
  ...props
}: LegacyProps & {
  action: string | null;
  onAction: (action: string | null, chargeId?: number) => void;
  chargeId?: number;
  refundCodes?: string[];
  hideActionSwitch?: boolean;
}) {
  const busy = useIsMutating() > 0;
  const [selectedRefundCode, setSelectedRefundCode] = useState<string | null>(
    () => refundCodes?.[0] ?? null,
  );
  useEffect(() => {
    if (refundCodes?.length) {
      setSelectedRefundCode((prev) =>
        prev && refundCodes.includes(prev) ? prev : refundCodes[0],
      );
    } else {
      setSelectedRefundCode(null);
    }
  }, [refundCodes]);

  return (
    <div className="space-y-3">
      {!hideActionSwitch && (
        <div className="flex flex-wrap gap-2">
          {action && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAction(null)}
            >
              العودة للتحصيل
            </Button>
          )}
          {action !== "charges" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAction("charges")}
            >
              قبض أجر أو سداد مستفيد
            </Button>
          )}
          {action !== "refunds" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAction("refunds")}
            >
              استرداد وأمانات زائدة
            </Button>
          )}
        </div>
      )}
      {!action && (
        <ReceptionCollectSection
          {...props}
          onOpenCharge={(id) => onAction("charges", id)}
        />
      )}
      {action === "charges" && (
        <React.Suspense fallback={<Skeleton className="h-28 w-full" />}>
          <ChargesWorkspace
            key={`${props.branchId}:${chargeId ?? "list"}`}
            embedded
            branchId={props.branchId}
            initialChargeId={chargeId}
          />
        </React.Suspense>
      )}
      {action === "refunds" && (
        <React.Suspense fallback={<Skeleton className="h-28 w-full" />}>
          <div className="space-y-3">
            {refundCodes?.length ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2.5 text-sm">
                <span className="font-semibold text-muted-foreground">
                  مستندات الإسناد المحفوظة للرد (اضغط للمعاينة الفورية):
                </span>
                {refundCodes.map((code) => (
                  <Button
                    key={code}
                    type="button"
                    size="sm"
                    variant={selectedRefundCode === code ? "default" : "outline"}
                    className="h-7 px-2 font-mono text-xs"
                    dir="ltr"
                    onClick={() => setSelectedRefundCode(code)}
                  >
                    {code}
                  </Button>
                ))}
              </div>
            ) : null}
            <DeliveryPaymentRefunds
              branchId={props.branchId}
              initialDocumentNumber={selectedRefundCode}
              defaultShiftId={props.shift?.id ?? null}
            />
            <ChargeExcessRefundWorkspace embedded branchId={props.branchId} />
          </div>
        </React.Suspense>
      )}
    </div>
  );
}
