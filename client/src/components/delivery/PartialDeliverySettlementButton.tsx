import { lazy, Suspense, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOperationPermission } from "@/hooks/useOperationPermission";

const SettlementDialog = lazy(
  () => import("./PartialDeliverySettlementDialog"),
);

/** Keep the financial workspace out of invoice and public-page startup bundles. */
export function PartialDeliverySettlementButton({
  consignmentId,
  targetShiftId,
  disabled,
  label = "استكمال تسوية تسليم جزئي",
  onOpenChange,
  onCompleted,
}: {
  consignmentId: number;
  targetShiftId?: number;
  disabled?: boolean;
  label?: string;
  onOpenChange?: (open: boolean) => void;
  onCompleted?: () => void;
}) {
  const canProve = useOperationPermission("delivery.manualProof").allowed;
  const canRemit = useOperationPermission("delivery.recordRemittance").allowed;
  const [open, setOpen] = useState(false);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  if (!canProve || !canRemit) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          onOpenChange?.(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <Suspense
          fallback={
            <LoaderCircle
              className="size-4 animate-spin"
              aria-label="التحميل"
            />
          }
        >
          <SettlementDialog
            consignmentId={consignmentId}
            targetShiftId={targetShiftId}
            onCompleted={onCompleted}
            onClose={() => {
              setOpen(false);
              onOpenChange?.(false);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
