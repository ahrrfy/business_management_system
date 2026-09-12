import { Link } from "wouter";
import { Check, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc";
import {
  formatDeliveryAge,
  deliveryAgeLevel,
  DELIVERY_AGE_CLS,
} from "@shared/deliveryAging";
import type { ReturnConsignmentTarget } from "./ReturnConsignmentDialog";

type OpenConsignment = RouterOutputs["delivery"]["openConsignments"]["rows"][number];

export function DeliveryConsignmentsTable({
  list,
  rows,
  statementMode,
  canReturn,
  onOutcomeToggle,
  onCollectedChange,
  onReturn,
  onOpenTimeline,
}: {
  list: OpenConsignment[];
  rows: Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }>;
  statementMode: boolean;
  canReturn: boolean;
  onOutcomeToggle: (consignmentId: number, currentOutcome: "COLLECTED" | "NONE", remaining: number) => void;
  onCollectedChange: (consignmentId: number, value: string) => void;
  onReturn: (target: ReturnConsignmentTarget) => void;
  onOpenTimeline: (consignmentId: number) => void;
}) {
  const remainingOf = (c: OpenConsignment) =>
    Math.max(
      0,
      Number(c.codAmount) -
        Number(c.collectedAmount) -
        Number(c.counterSettledAmount ?? "0") -
        Number(c.shortfallAssigned ?? "0"),
    );

  const isRemittable = (c: OpenConsignment) =>
    c.parcelStatus === "DELIVERED" &&
    (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL") &&
    remainingOf(c) > 0;

  const isStatementConfirmable = (c: OpenConsignment) =>
    c.status === "DISPATCHED" &&
    c.parcelStatus !== "CANCELLED" &&
    c.parcelStatus !== "RETURNED" &&
    (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL" || c.moneyStatus === "NOT_APPLICABLE");

  const isSettleable = (c: OpenConsignment) => isRemittable(c) || (statementMode && isStatementConfirmable(c));

  const isReturnable = (c: OpenConsignment) =>
    c.status === "DISPATCHED" &&
    (c.parcelStatus === "ASSIGNED" || c.parcelStatus === "FAILED") &&
    (c.moneyStatus === "NOT_APPLICABLE" || c.moneyStatus === "UNSETTLED") &&
    Number(c.collectedAmount) === 0;

  const get = (c: OpenConsignment) =>
    rows[c.id] ??
    (statementMode
      ? { outcome: "NONE" as const, collected: "0" }
      : isSettleable(c)
        ? { outcome: "COLLECTED" as const, collected: String(remainingOf(c)) }
        : { outcome: "NONE" as const, collected: "0" });

  return (
    <ScrollTableShell className="bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="p-3 text-right">الإرسالية</th>
            <th className="p-3 text-right">الفاتورة</th>
            <th className="p-3 text-right">العميل</th>
            <th className="p-3 text-end">العمر</th>
            <th className="p-3 text-left" title="مبلغُ COD المطلوب تحصيله من الزبون">المطلوب تحصيله</th>
            <th className="p-3 text-center">قرار المندوب</th>
            <th className="p-3 text-left">المبلغ المقبوض</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => {
            const st = get(c);
            const remaining = remainingOf(c);
            const remittable = isSettleable(c);
            const returnable = isReturnable(c);
            const feeDue = Math.max(0, Number(c.feeDue ?? 0));
            const ageHours = c.dispatchedAt ? Math.max(0, Math.floor((Date.now() - new Date(c.dispatchedAt as unknown as string).getTime()) / 3600000)) : 0;
            const ageLevel = deliveryAgeLevel(ageHours);
            return (
              <tr key={c.id} className="border-b last:border-0">
                <td className="p-3 font-medium">
                  <button type="button" onClick={() => onOpenTimeline(c.id)} className="text-primary hover:underline">
                    {c.consignmentNumber}
                  </button>
                </td>
                <td className="p-3">
                  {c.invoiceId ? (
                    <Link className="font-mono text-xs text-primary hover:underline" dir="ltr" href={`/invoices/${c.invoiceId}`}>
                      {c.invoiceNumber ?? `#${c.invoiceId}`}
                    </Link>
                  ) : "—"}
                </td>
                <td className="p-3">{c.customerName ?? c.recipientName ?? "عميل نقدي"}</td>
                <td className="p-3 text-end">
                  <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-black", DELIVERY_AGE_CLS[ageLevel])} dir="ltr">
                    {formatDeliveryAge(ageHours)}
                  </span>
                </td>
                <td className="p-3 text-left tabular-nums" dir="ltr">{fmt(String(remaining))}</td>
                <td className="p-3 text-center">
                  <div className="inline-flex gap-1">
                    {remittable && (
                      <button
                        type="button"
                        className={cn("rounded px-2 py-1 text-xs font-bold", st.outcome === "COLLECTED" ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-muted text-muted-foreground")}
                        onClick={() => onOutcomeToggle(c.id, st.outcome, remaining)}
                        title={st.outcome === "COLLECTED" ? "المندوب حصّل هذا الطرد — انقر لإلغاء" : "انقر لتأكيد أنّ المندوب حصّل هذا الطرد"}
                      >
                        <Check aria-hidden className="inline size-3" /> {st.outcome === "COLLECTED" ? "حصل" : "لم يحصل"}
                      </button>
                    )}
                    {canReturn && returnable && (
                      <button
                        type="button"
                        className="rounded bg-[var(--sem-warn-bg)] px-2 py-1 text-xs font-bold text-[var(--sem-warn)]"
                        onClick={() => onReturn({
                          consignmentId: c.id,
                          label: `الإرسالية ${c.consignmentNumber}`,
                        })}
                      >
                        <RotateCcw aria-hidden className="inline size-3" /> مُرتجَع
                      </button>
                    )}
                    {!remittable && !returnable && feeDue > 0 && <span className="text-xs font-bold text-[var(--sem-warn)]">أجرة مستحقة</span>}
                  </div>
                </td>
                <td className="p-3 text-left">
                  {remittable ? (
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      disabled={st.outcome !== "COLLECTED"}
                      value={st.collected}
                      onChange={(e) => onCollectedChange(c.id, e.target.value)}
                      className="h-8 w-28 text-end tabular-nums"
                    />
                  ) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollTableShell>
  );
}
