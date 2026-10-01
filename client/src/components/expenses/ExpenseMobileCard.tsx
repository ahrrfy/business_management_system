import React from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { RowActions, type RowAction } from "@/components/list";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { FinancialCellProvenanceHover } from "@/components/financial";
import { ExpenseTracePanel } from "./ExpenseTracePanel";
import {
  expenseCategoryText,
  fundingDetail,
  STATUS_CLS,
  STATUS_LABEL,
  type ExpenseRow,
} from "./expenseView";

export interface ExpenseMobileCardProps {
  row: ExpenseRow;
  warnings: string[];
  expanded: boolean;
  traceExpanded: boolean;
  onToggleDescription: (id: number) => void;
  onToggleTrace: (id: number) => void;
  actions: RowAction[];
}

export function ExpenseMobileCard({
  row: r,
  warnings,
  expanded,
  traceExpanded,
  onToggleDescription,
  onToggleTrace,
  actions,
}: ExpenseMobileCardProps) {
  const expenseId = Number(r.id);
  const prov = (r as { provenance?: any }).provenance;

  return (
    <article
      key={expenseId}
      className="space-y-3 rounded-lg border p-3 bg-card text-card-foreground shadow-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs" dir="ltr">
              EXP#{expenseId}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
            >
              {STATUS_LABEL[r.status] ?? r.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {fmtDate(r.expenseDate as unknown as string)} · {r.branchName ?? "—"}
          </p>
        </div>
        <p className="text-lg font-bold tabular-nums" dir="ltr">
          <FinancialCellProvenanceHover data={prov}>
            <span className="cursor-pointer hover:underline text-end block w-full">
              {fmt(r.amount)}
            </span>
          </FinancialCellProvenanceHover>
        </p>
      </div>

      <div>
        <p
          className={`text-sm leading-6 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
        >
          {r.description?.trim() || "لا يوجد شرح للعملية"}
        </p>
        {(r.description?.length ?? 0) > 80 && (
          <button
            type="button"
            className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
            onClick={() => onToggleDescription(expenseId)}
          >
            {expanded ? "طي الشرح" : "عرض الشرح كاملاً"}
          </button>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">المستفيد</dt>
          <dd className="font-medium">{r.payee ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">الفئة / المركز</dt>
          <dd>
            {expenseCategoryText(r)}
            {r.costCenter ? ` · ${r.costCenter}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">مصدر التمويل</dt>
          <dd>{fundingDetail(r)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">أنشأ العملية</dt>
          <dd>
            {r.createdByName ?? (r.createdBy != null ? `#${r.createdBy}` : "—")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">السند</dt>
          <dd dir="ltr">
            {r.receiptVoucherNumber ?? (r.receiptId ? `R#${r.receiptId}` : "—")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">وقت التسجيل</dt>
          <dd dir="ltr">{fmtDateTime(r.createdAt as unknown as string)}</dd>
        </div>
      </dl>

      {warnings.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {warnings.map((warning) => (
            <span
              key={warning}
              className="rounded-full badge-status-cancelled px-2 py-0.5 text-[11px]"
            >
              {warning}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={traceExpanded}
          onClick={() => onToggleTrace(expenseId)}
        >
          {traceExpanded ? (
            <ChevronUp aria-hidden className="size-4" />
          ) : (
            <ChevronDown aria-hidden className="size-4" />
          )}
          مسار التتبّع
        </Button>
        <RowActions actions={actions} />
      </div>

      {traceExpanded && <ExpenseTracePanel expenseId={expenseId} />}
    </article>
  );
}
