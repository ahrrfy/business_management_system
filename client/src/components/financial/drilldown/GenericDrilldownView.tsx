import { fmt } from "@/lib/money";
import type { DrilldownTarget } from "./types";

export function GenericDrilldownView({
  target,
}: {
  target: Extract<DrilldownTarget, { type: "GENERIC" }>;
}) {
  return (
    <div className="space-y-4 pt-2 text-sm">
      <div className="rounded-lg border bg-card p-4 flex items-center justify-between gap-3">
        <div>
          <span className="text-xs text-muted-foreground">{target.title}</span>
          {target.subtitle && <p className="text-xs text-muted-foreground mt-0.5">{target.subtitle}</p>}
        </div>
        <div className="text-left">
          <span className="text-xs text-muted-foreground">
            {target.direction === "DEBIT" ? "مدين" : "دائن"}
          </span>
          <p
            className={`text-xl font-bold tabular-nums ${
              target.direction === "DEBIT" ? "text-[var(--sem-info)]" : "text-money-positive"
            }`}
            dir="ltr"
          >
            {fmt(target.amount)} د.ع
          </p>
        </div>
      </div>

      {target.details && Object.keys(target.details).length > 0 && (
        <div className="rounded-lg border bg-muted/10 p-3 space-y-2">
          <span className="text-xs font-semibold text-muted-foreground">تفاصيل الحركة:</span>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {Object.entries(target.details).map(([key, value]) => (
              <div key={key} className="p-2 rounded bg-background border">
                <span className="text-muted-foreground">{key}: </span>
                <span className="font-semibold">{String(value ?? "—")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
