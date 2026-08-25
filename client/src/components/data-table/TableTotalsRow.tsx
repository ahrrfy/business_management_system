import * as React from "react";
import { cn } from "@/lib/utils";
import { TABLE_TFOOT_CLS } from "./tableStyles";

/**
 * صف إجماليات موحّد لِـ`<tfoot>` — يستبدل النمط اليدوي المتكرّر:
 *   `<tfoot><tr className="bg-muted/40 font-bold border-t-2 border-border">…</tr></tfoot>`
 *
 * كان المكرّر في StocktakeReport و CashOrphanReport و DayCloseReport و InvoiceDetail
 * بأنماط متفاوتة قليلاً (`bg-slate-100` مقابل `bg-muted/40` مقابل `bg-muted/50`). المكوّن
 * هنا يفرض نمطاً واحداً + يُبقي المستدعي حرّاً في تعريف الخلايا.
 *
 * ⚠️ لا يُصدر `<tfoot>` نفسه — الجدول قد يحوي `<tfoot>` واحداً بعدة صفوف. يُستعمل هكذا:
 *   ```tsx
 *   <tfoot>
 *     <TableTotalsRow>
 *       <td>الإجمالي</td>
 *       <td className="text-end tabular-nums">{fmt(total)}</td>
 *     </TableTotalsRow>
 *   </tfoot>
 *   ```
 */
export function TableTotalsRow({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn(TABLE_TFOOT_CLS, className)} {...rest}>
      {children}
    </tr>
  );
}
