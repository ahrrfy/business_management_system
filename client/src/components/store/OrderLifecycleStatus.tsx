import {
  onlineOrderLifecycleChipClass,
  type OnlineOrderLifecycle,
} from "@shared/onlineOrderLifecycle";
import {
  orderStatusChipClass,
  orderStatusLabel,
} from "@shared/onlineOrderStatus";
import { fmtDateTime } from "@/lib/date";

interface OrderLifecycleStatusProps {
  status: string;
  lifecycle?: OnlineOrderLifecycle | null;
  showLatestMovement?: boolean;
}

/** The server projects operational facts; this component only formats their labels. */
export function OrderLifecycleStatus({
  status,
  lifecycle,
  showLatestMovement = false,
}: OrderLifecycleStatusProps) {
  const latest = showLatestMovement ? lifecycle?.latestEvent : null;
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span
        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${onlineOrderLifecycleChipClass(lifecycle?.tone) ?? orderStatusChipClass(status)}`}
      >
        {lifecycle?.label ?? orderStatusLabel(status)}
      </span>
      {(lifecycle?.collectionLabel || lifecycle?.remittanceLabel) && (
        <div className="flex flex-wrap justify-center gap-1 text-[11px] text-muted-foreground">
          {lifecycle.collectionLabel && (
            <span>{lifecycle.collectionLabel}</span>
          )}
          {lifecycle.collectionLabel && lifecycle.remittanceLabel && (
            <span aria-hidden>·</span>
          )}
          {lifecycle.remittanceLabel && (
            <span>{lifecycle.remittanceLabel}</span>
          )}
        </div>
      )}
      {latest && (
        <div className="max-w-56 text-[11px] text-muted-foreground">
          <div>آخر حركة: {latest.label}</div>
          <div>
            <span dir="ltr">{fmtDateTime(latest.occurredAt)}</span>
            {latest.actorName ? ` · ${latest.actorName}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
