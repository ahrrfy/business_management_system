import { useMemo } from "react";
import { CheckCircle2, FileText, Phone, UserCheck } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RowActions } from "@/components/list";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildOperationalContactMessage, toIraqiIntl } from "@/lib/whatsapp";
import { D, fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import {
  type PlanRow,
  PLAN_STATUS_AR,
  StatusBadge,
} from "./installmentTypes";

export interface PlansTableProps {
  rows: PlanRow[];
  hasMore: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  onDetail: (id: number) => void;
  onOpenDossier: (customerId: number) => void;
  offset: number;
  limit: number;
  onPage: (offset: number) => void;
  externalFiltersActive?: boolean;
}

export function PlansTable({
  rows,
  hasMore,
  isLoading,
  isError,
  refetch,
  onDetail,
  onOpenDossier,
  offset,
  limit,
  onPage,
  externalFiltersActive,
}: PlansTableProps) {
  const columns = useMemo<ColumnDef<PlanRow, unknown>[]>(
    () => [
      {
        id: "id",
        header: "#",
        accessorKey: "id",
        cell: ({ row }) => (
          <span className="text-center tabular-nums block font-mono text-xs">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "customer",
        header: "العميل",
        accessorKey: "customerName",
        cell: ({ row }) => {
          const p = row.original;
          const intlPhone = p.customerPhone ? toIraqiIntl(p.customerPhone) || p.customerPhone : null;
          return (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{p.customerName}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenDossier(p.customerId)}
                  className="text-primary hover:bg-primary/10 h-6 w-6 p-0"
                  title={`الملف الشامل 360° — ${p.customerName}`}
                  aria-label={`الملف الشامل 360° — ${p.customerName}`}
                >
                  <UserCheck className="size-3.5" aria-hidden />
                </Button>
                {p.invoiceId != null && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <FileText className="size-3" aria-hidden /> فاتورة #{p.invoiceId}
                  </span>
                )}
              </div>
              {p.customerPhone && (
                <div className="flex items-center gap-2" dir="ltr">
                  <a
                    href={`tel:${intlPhone || p.customerPhone}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    title={`اتصال: ${p.customerPhone}`}
                  >
                    <Phone className="size-3" aria-hidden />
                    <span className="tabular-nums">{p.customerPhone}</span>
                  </a>
                  <WhatsAppShare
                    phone={p.customerPhone}
                    message={buildOperationalContactMessage({
                      entityLabel: "خطة أقساط",
                      reference: String(p.id),
                      partyName: p.customerName,
                      title: `إجمالي الخطة: ${fmt(p.totalAmount)} د.ع`,
                      dueAt: p.nextDueDate,
                      status: PLAN_STATUS_AR[p.status]?.label ?? p.status,
                      nextAction: p.nextDueDate ? "يرجى تأكيد موعد القسط القادم." : undefined,
                    })}
                    size="icon-sm"
                    iconOnly
                    label={`واتساب ${p.customerName}`}
                  />
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "totalAmount",
        header: "الإجمالي",
        accessorKey: "totalAmount",
        meta: { kind: "money" },
        sortDescFirst: true,
        sortingFn: (a, b) => D(a.original.totalAmount).cmp(D(b.original.totalAmount)),
        cell: ({ row }) => (
          <span className="text-left font-bold tabular-nums block" dir="ltr">
            {fmt(row.original.totalAmount)}
          </span>
        ),
      },
      {
        id: "downPayment",
        header: "الدفعة الأولى",
        accessorKey: "downPayment",
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="text-left tabular-nums block" dir="ltr">
            {fmt(row.original.downPayment)}
          </span>
        ),
      },
      {
        id: "progress",
        header: "التقدّم",
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="text-center">
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums">
                <CheckCircle2
                  className={`size-3 ${p.paidLines === p.totalLines && p.totalLines > 0 ? "text-[var(--sem-pos)]" : "text-muted-foreground"}`}
                  aria-hidden
                />
                مدفوع {p.paidLines} من {p.totalLines}
              </span>
              {(
                <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums" dir="ltr">
                  الموثق {fmt(p.paidAmount)} — المتبقي {fmt(p.remainingAmount)}{p.reconciliationRequired ? " — تحتاج مطابقة" : ""}
                  <div dir="rtl">صافي المدفوع بالفاتورة: {p.invoiceNetPaidAmount == null ? "—" : fmt(p.invoiceNetPaidAmount)} — المتبقي بالفاتورة: {p.invoiceRemainingAmount == null ? "—" : fmt(p.invoiceRemainingAmount)}</div>
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "nextDueDate",
        header: "القسط القادم",
        accessorKey: "nextDueDate",
        cell: ({ row }) => (
          <span className="text-center text-xs tabular-nums block" dir="ltr">
            {row.original.nextDueDate ?? "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "الحالة",
        accessorKey: "status",
        cell: ({ row }) => (
          <div className="text-center">
            <StatusBadge map={PLAN_STATUS_AR} value={row.original.status} />
          </div>
        ),
      },
      {
        id: "createdAt",
        header: "أُنشئت",
        accessorKey: "createdAt",
        cell: ({ row }) => (
          <span className="text-center text-xs text-muted-foreground tabular-nums block" dir="ltr">
            {row.original.createdAt ? fmtDateTime(row.original.createdAt as unknown as string) : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "تفاصيل",
        meta: { kind: "actions" },
        enableSorting: false,
        cell: ({ row }) => {
          const p = row.original;
          return (
            <RowActions
              mode="inline"
              actions={[
                {
                  key: "dossier",
                  kind: "view",
                  label: "الملف الشامل 360°",
                  onSelect: () => onOpenDossier(p.customerId),
                  gate: { module: "crm", level: "READ" },
                },
                {
                  key: "detail",
                  kind: "view",
                  label: "عرض",
                  onSelect: () => onDetail(p.id),
                  gate: { module: "treasury", level: "READ" },
                },
              ]}
            />
          );
        },
      },
    ],
    [onDetail, onOpenDossier],
  );

  return (
    <Card>
      <CardContent className="p-0">
        <DataTable<PlanRow, number>
          columns={columns}
          data={rows}
          searchable={false}
          externalFiltersActive={externalFiltersActive}
          loading={isLoading}
          errorState={{ isError, onRetry: refetch }}
          getRowId={(r) => r.id}
          serverPagination={{
            page: Math.floor(offset / limit),
            onPageChange: (nextPage) => onPage(nextPage * limit),
            pageSize: limit,
            hasMore,
            isFetching: isLoading,
          }}
          emptyState="لا توجد خطط أقساط بعد. اضغط «خطة أقساط جديدة» للبدء."
          emptyFilteredState="لا توجد خطط مطابقة للفلاتر."
        />
      </CardContent>
    </Card>
  );
}
