import { AlarmClock, CircleDollarSign, Landmark } from "lucide-react";
import { fmt } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import type { DueRow } from "./installmentTypes";

interface DueSoonSectionProps {
  rows: DueRow[];
  isLoading: boolean;
  /** نافذة «المستحقّ قريباً» بالأيام — الخادم يقبل حتى ٩٠ (installments.dueSoon). */
  days: number;
  onDaysChange: (days: number) => void;
  onPay: (r: DueRow) => void;
}

export function DueSoonSection({
  rows,
  isLoading,
  days,
  onDaysChange,
  onPay,
}: DueSoonSectionProps) {
  if (isLoading) return null;
  const overdue = rows.filter((r) => r.daysOverdue > 0).length;
  return (
    <Card className="border-[var(--sem-warn)]/40">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlarmClock className="size-4 text-[var(--sem-warn)]" aria-hidden />
            المستحقّ قريباً ({rows.length} قسطاً{overdue > 0 ? ` — منها ${overdue} متأخّر` : ""})
          </CardTitle>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            خلال
            <AppSelect
              value={String(days)}
              onValueChange={(v) => onDaysChange(Number(v))}
              className="h-7 w-24 text-xs"
              size="sm"
              aria-label="نافذة المستحقّ قريباً بالأيام"
            >
              <option value="3">٣ أيام</option>
              <option value="7">٧ أيام</option>
              <option value="14">١٤ يوماً</option>
              <option value="30">٣٠ يوماً</option>
              <option value="60">٦٠ يوماً</option>
              <option value="90">٩٠ يوماً</option>
            </AppSelect>
          </label>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground text-center">لا أقساط مستحقّة خلال {days} يوماً.</p>
        ) : (
          <ScrollTableShell bordered={false} maxHeightClass="max-h-64">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">العميل</TableHead>
                  <TableHead className="text-center">القسط</TableHead>
                  <TableHead className="text-center">الاستحقاق</TableHead>
                  <TableHead className="text-center">التأخّر</TableHead>
                  <TableHead className="text-left">المبلغ</TableHead>
                  <TableHead className="text-center">النوع</TableHead>
                  <TableHead className="text-center">إجراء</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.lineId} className={r.daysOverdue > 0 ? "bg-destructive/5" : ""}>
                    <TableCell className="font-medium">
                      {r.customerName}
                      {r.customerPhone && <span className="ms-2 text-xs text-muted-foreground" dir="ltr">{r.customerPhone}</span>}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{r.seq} — خطة #{r.planId}</TableCell>
                    <TableCell className="text-center text-xs tabular-nums" dir="ltr">{r.dueDate}</TableCell>
                    <TableCell className="text-center">
                      {r.daysOverdue > 0 ? (
                        <span className="inline-flex items-center rounded-md bg-destructive/15 px-2 py-0.5 text-xs font-bold text-destructive tabular-nums">
                          {r.daysOverdue} يوماً
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">في الموعد</span>
                      )}
                    </TableCell>
                    <TableCell className="text-left font-bold tabular-nums" dir="ltr">{fmt(r.amount)}</TableCell>
                    <TableCell className="text-center text-xs">
                      {r.kind === "CHECK" ? (
                        <span className="inline-flex items-center gap-1">
                          <Landmark className="size-3 text-muted-foreground" aria-hidden />
                          صك {r.checkNumber ?? ""}{r.bankName ? ` — ${r.bankName}` : ""}
                        </span>
                      ) : (
                        "نقدي"
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <RowActions
                        mode="inline"
                        contact={{
                          phone: r.customerPhone,
                          label: `واتساب ${r.customerName}`,
                          message: buildOperationalContactMessage({
                            entityLabel: "قسط",
                            reference: `${r.planId}-${r.seq}`,
                            partyName: r.customerName,
                            title: `القسط المستحق: ${fmt(r.amount)} د.ع`,
                            dueAt: r.dueDate,
                            status: r.daysOverdue > 0 ? `متأخر ${r.daysOverdue} يوماً` : "قريب الاستحقاق",
                            nextAction: "يرجى تأكيد موعد السداد.",
                          }),
                          gate: { module: "treasury", level: "READ" },
                        }}
                        actions={[{
                          key: "pay",
                          kind: "pay",
                          label: "سداد",
                          icon: CircleDollarSign,
                          onSelect: () => onPay(r),
                          gate: { roles: ["manager", "accountant"], module: "treasury", level: "FULL" },
                        }]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}
