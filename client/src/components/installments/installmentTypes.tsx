import type { RouterOutputs } from "@/lib/trpc";
export {
  PLAN_STATUS_MAP as PLAN_STATUS_AR,
  LINE_STATUS_MAP as LINE_STATUS_AR,
} from "@shared/installmentStatus";

export type PlanRow = RouterOutputs["installments"]["list"]["rows"][number];
export type PlanDetail = RouterOutputs["installments"]["get"];
export type PlanLine = PlanDetail["lines"][number];
export type DueRow = RouterOutputs["installments"]["dueSoon"][number];
export type PendingExternalPayment =
  RouterOutputs["installments"]["pendingExternalPayments"][number];

export function StatusBadge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const m = map[value] ?? { label: value, cls: "bg-muted text-muted-foreground" };
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${m.cls}`}>{m.label}</span>;
}
