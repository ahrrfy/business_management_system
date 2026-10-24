import React from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ReceptionCollectSection } from "@/components/reception/ReceptionCollectSection";
import { DeliveryPaymentRefunds } from "@/components/delivery/DeliveryFeeRefunds";
import { ChargeExcessRefundWorkspace } from "@/components/fulfillment/ChargeExcessRefundWorkspace";
import { ChargesWorkspace } from "@/components/fulfillment/ChargesWorkspace";

type LegacyProps = React.ComponentProps<typeof ReceptionCollectSection>;
export function WorkflowCollectStation({ action, onAction, chargeId, refundCodes, ...props }: LegacyProps & {
  action: string | null; onAction: (action: string | null, chargeId?: number) => void;
  chargeId?: number; refundCodes?: string[];
}) {
  const busy = useIsMutating() > 0;
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      {action && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onAction(null)}>العودة للتحصيل</Button>}
      {action !== "charges" && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onAction("charges")}>قبض أجر أو سداد مستفيد</Button>}
      {action !== "refunds" && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onAction("refunds")}>استرداد وأمانات زائدة</Button>}
    </div>
    {!action && <ReceptionCollectSection {...props} onOpenCharge={id => onAction("charges", id)} />}
    {action === "charges" && <ChargesWorkspace key={`${props.branchId}:${chargeId ?? "list"}`} embedded branchId={props.branchId} initialChargeId={chargeId} />}
    {action === "refunds" && <div className="space-y-3">{refundCodes?.length ? <p className="break-words text-sm text-muted-foreground">مستندات الإسناد المحفوظة: {refundCodes.join("، ")} — استعمل أصل إيصال الأمانة عند الرد.</p> : null}<DeliveryPaymentRefunds branchId={props.branchId} /><ChargeExcessRefundWorkspace embedded branchId={props.branchId} /></div>}
  </div>;
}
