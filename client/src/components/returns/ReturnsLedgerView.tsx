import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { CopyInline } from "@/components/CopyButton";
import { fmt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import {
  Receipt,
  Printer,
  Search,
  BookOpen,
} from "lucide-react";

type LedgerRow = RouterOutputs["returns"]["list"]["rows"][number];

export function ReturnsLedgerView() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [selectedPerformer, setSelectedPerformer] = useState<string>("");
  const [page, setPage] = useState(0);

  const performersQuery = trpc.returns.performers.useQuery();

  const ledgerQuery = trpc.returns.list.useQuery({
    q: debouncedSearch || undefined,
    createdBy: selectedPerformer ? Number(selectedPerformer) : undefined,
    limit: 30,
    offset: page * 30,
  });

  const columns = useMemo<ColumnDef<LedgerRow, unknown>[]>(
    () => [
      {
        id: "invoiceNumber",
        header: "رقم الفاتورة",
        accessorFn: (r) => r.invoiceNumber ?? "—",
        meta: { kind: "code" },
        cell: ({ row }) =>
          row.original.invoiceNumber ? (
            <CopyInline value={row.original.invoiceNumber} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "customer",
        header: "العميل",
        cell: ({ row }) => (
          <div className="text-xs">
            <div className="font-semibold">{row.original.customerName || "زبون عابر"}</div>
            {row.original.customerPhone && (
              <div className="text-muted-foreground font-mono">{row.original.customerPhone}</div>
            )}
          </div>
        ),
      },
      {
        id: "amount",
        header: "المبلغ المرتجع",
        accessorFn: (r) => fmt(r.amount),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="font-mono font-bold text-money-negative">
            {fmt(row.original.amount)}
          </span>
        ),
      },
      {
        id: "performer",
        header: "الموظف المنفذ",
        accessorFn: (r) => r.performedByName ?? "—",
        cell: ({ row }) => row.original.performedByName || "—",
      },
      {
        id: "date",
        header: "تاريخ القيد",
        cell: ({ row }) => {
          const d = row.original.entryDate ? new Date(row.original.entryDate) : null;
          return d ? d.toLocaleDateString("ar-IQ") : "—";
        },
      },
      {
        id: "notes",
        header: "البيان والملاحظات",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground truncate max-w-xs block">
            {row.original.notes || "مرتجع مبيعات"}
          </span>
        ),
      },
    ],
    []
  );

  const handlePrintLedger = () => {
    const rows = ledgerQuery.data?.rows ?? [];
    if (rows.length === 0) return;

    const totalSum = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);

    printReportDoc({
      title: "سجل قيود المرتجعات المالية والمحاسبية",
      docDate: new Date().toLocaleDateString("ar-IQ"),
      headerExtra: [
        { label: "إجمالي العمليات", value: `${rows.length} عملية` },
        { label: "حالة التقرير", value: "مستخرج من دفتر اليومية" },
      ],
      note: "تقرير محاسبي صادر عن بوابة المرتجعات الإدارية الشاملة - شركة الرؤية العربية",
      columns: [
        { key: "invoice", label: "رقم الفاتورة" },
        { key: "customer", label: "العميل" },
        { key: "performer", label: "المنفذ" },
        { key: "date", label: "التاريخ" },
        { key: "amount", label: "المبلغ المرتجع", align: "left" },
      ],
      rows: rows.map((r) => ({
        invoice: r.invoiceNumber ?? "—",
        customer: r.customerName ?? "زبون عابر",
        performer: r.performedByName ?? "—",
        date: r.entryDate ? new Date(r.entryDate).toLocaleDateString("ar-IQ") : "—",
        amount: fmt(r.amount),
      })),
      summary: [
        {
          label: "مجموع المرتجعات المعروضة",
          value: fmt(totalSum),
          large: true,
          bold: true,
        },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 text-xs space-y-1">
          <div className="font-bold text-sm flex items-center gap-2 text-primary">
            <BookOpen className="size-4" aria-hidden />
            دفتر يومية وسجل قيود المرتجعات المحاسبية
          </div>
          <p className="text-muted-foreground">
            تتبع وتدقيق كافة قيود الإرجاع المنفذة على النظام، والمربوطة بالدفتر المحاسبي العام وحسابات العملاء وأدراج الكاشير.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Receipt className="size-4" aria-hidden />
              سجل العمليات ({ledgerQuery.data?.total ?? 0})
            </CardTitle>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handlePrintLedger}
              disabled={!ledgerQuery.data?.rows.length}
              className="gap-2 self-start sm:self-auto"
            >
              <Printer className="size-4" aria-hidden />
              طباعة تقرير السجل
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          {/* أشرطة التصفية والبحث */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute right-3 top-3 size-4 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="ابحث برقم الفاتورة..."
                className="pr-9"
              />
            </div>

            <div className="w-full sm:w-60">
              <AppSelect
                value={selectedPerformer}
                onValueChange={(val) => {
                  setSelectedPerformer(val);
                  setPage(0);
                }}
              >
                <option value="">كل الموظفين المنفذين</option>
                {(performersQuery.data ?? []).map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </AppSelect>
            </div>
          </div>

          {/* جدول البيانات */}
          <DataTable
            columns={columns}
            data={ledgerQuery.data?.rows ?? []}
            loading={ledgerQuery.isLoading}
          />

          {/* ترقيم الصفحات البسيط */}
          {(ledgerQuery.data?.total ?? 0) > 30 && (
            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground border-t">
              <span>
                عرض {page * 30 + 1} - {Math.min((page + 1) * 30, ledgerQuery.data?.total ?? 0)} من أصل {ledgerQuery.data?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  السابق
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(page + 1) * 30 >= (ledgerQuery.data?.total ?? 0)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  التالي
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
