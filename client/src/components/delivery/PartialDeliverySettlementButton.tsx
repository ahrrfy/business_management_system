import { lazy, Suspense, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOperationPermission } from "@/hooks/useOperationPermission";

const SettlementDialog = lazy(
  () => import("./PartialDeliverySettlementDialog"),
);

/** Keep the financial workspace out of invoice and public-page startup bundles. */
export function PartialDeliverySettlementButton({
  consignmentId,
}: {
  consignmentId: number;
}) {
  const canProve = useOperationPermission("delivery.manualProof").allowed;
  const canRemit = useOperationPermission("delivery.recordRemittance").allowed;
  const [open, setOpen] = useState(false);
  if (!canProve || !canRemit) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        استكمال تسوية تسليم جزئي
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
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
