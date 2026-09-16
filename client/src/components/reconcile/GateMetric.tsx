import { Check, AlertTriangle } from "lucide-react";

export function GateMetric({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2 font-semibold tabular-nums">
        {ok ? (
          <Check aria-hidden className="size-4" />
        ) : (
          <AlertTriangle aria-hidden className="size-4 text-destructive" />
        )}
        <span dir="ltr">{value}</span>
      </div>
    </div>
  );
}
