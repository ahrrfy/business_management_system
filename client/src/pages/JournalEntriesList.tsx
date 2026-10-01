/**
 * JournalEntriesList — سجل القيود اليومية اليدوية والتسويات المحاسبية.
 *
 * يوفر استعراضاً وتدقيقاً رقابياً لكافة القيود المحاسبية اليدوية مع تفاصيل أسطرها،
 * أطرافها المحاسبية، ومبالغ التوازن المالي.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  BookOpen,
  Calendar,
  Building2,
  Eye,
  Plus,
  Scale,
  User,
  ArrowRight,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { DataTable } from "@/components/data-table/DataTable";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { fmtAr } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type JournalRow = RouterOutputs["accounts"]["listManualJournals"]["rows"][number];

export default function JournalEntriesList() {
  const [branchId, setBranchId] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [selectedJournal, setSelectedJournal] = useState<JournalRow | null>(null);

  const branchesQ = trpc.branches.list.useQuery();
  const branches = branchesQ.data ?? [];

  const journalsQ = trpc.accounts.listManualJournals.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    from: fromDate || undefined,
    to: toDate || undefined,
  });

  const rows = journalsQ.data?.rows ?? [];

  const columns = useMemo<ColumnDef<JournalRow, unknown>[]>(
    () => [
      {
        id: "id",
        header: "رقم القيد",
        accessorFn: (r) => r.id,
        cell: ({ row }) => (
          <div className="font-mono font-bold text-primary">
            #{row.original.id}
          </div>
        ),
      },
      {
        id: "entryDate",
        header: "تاريخ القيد",
        accessorFn: (r) => r.entryDate,
        cell: ({ row }) => (
          <div className="font-mono text-sm">
            {row.original.entryDate}
          </div>
        ),
      },
      {
        id: "branchName",
        header: "الفرع",
        accessorFn: (r) => r.branchName ?? "المركز العام",
        cell: ({ row }) => (
          <div className="text-sm font-medium">
            {row.original.branchName ?? "المركز العام"}
          </div>
        ),
      },
      {
        id: "notes",
        header: "البيان المحاسبي (سبب التسوية)",
        accessorFn: (r) => r.notes ?? "",
        cell: ({ row }) => (
          <div className="text-sm max-w-md truncate" title={row.original.notes ?? ""}>
            {row.original.notes || "—"}
          </div>
        ),
      },
      {
        id: "amount",
        header: "المبلغ المتوازن",
        accessorFn: (r) => r.amount,
        cell: ({ row }) => (
          <div className="font-mono font-bold text-money-positive">
            {fmtAr(row.original.amount)} د.ع
          </div>
        ),
      },
      {
        id: "createdByName",
        header: "المسجل",
        accessorFn: (r) => r.createdByName ?? "",
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <User className="size-3" />
            {row.original.createdByName ?? "—"}
          </div>
        ),
      },
      {
        id: "actions",
        header: "التفاصيل",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedJournal(row.original)}
            className="flex items-center gap-1 text-primary hover:text-primary/80"
          >
            <Eye className="size-3.5" />
            عرض السطور
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-4 md:p-6" dir="rtl">
      <PageHeader
        title="سجل القيود اليومية اليدوية"
        description="استعراض وتدقيق قيود اليومية اليدوية والتسويات المحاسبية المعتمدة ومطابقتها"
        actions={
          <Link href="/journal/new">
            <Button size="sm" className="flex items-center gap-1.5">
              <Plus className="size-4" />
              قيد يدوي جديد
            </Button>
          </Link>
        }
      />

      {/* فلاتر البحث والفرز */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <Building2 className="size-3.5" />
                تصفية حسب الفرع
              </label>
              <AppSelect
                value={branchId}
                onValueChange={setBranchId}
                className="w-full text-right"
              >
                <option value="">جميع الفروع</option>
                {branches.map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <Calendar className="size-3.5" />
                من تاريخ
              </label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full text-right"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                <Calendar className="size-3.5" />
                إلى تاريخ
              </label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full text-right"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* جدول القيود */}
      <DataTable
        columns={columns}
        data={rows}
        searchable
        searchPlaceholder="البحث في بيان القيد أو الرقم أو الفرع..."
        emptyText="لا توجد قيود يومية مسجلة بهذه المعايير."
      />

      {/* نافذة معاينة سطور القيد */}
      {selectedJournal && (
        <Dialog open onOpenChange={(open) => !open && setSelectedJournal(null)}>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <BookOpen className="size-5 text-primary" />
                تفاصيل قيد اليومية #{selectedJournal.id}
              </DialogTitle>
              <DialogDescription>
                تاريخ: {selectedJournal.entryDate} | الفرع: {selectedJournal.branchName ?? "المركز العام"} | بواسطة: {selectedJournal.createdByName ?? "—"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 pt-2">
              <div className="p-3 bg-muted/40 rounded-lg text-sm">
                <span className="font-semibold">البيان العام: </span>
                {selectedJournal.notes || "لا يوجد بيان"}
              </div>

              {/* أسطر القيد */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-muted-foreground">
                  <Scale className="size-4" />
                  أسطر القيد المتوازن
                </h4>
                <div className="border rounded-lg divide-y bg-background">
                  {selectedJournal.lines.map((line, idx) => (
                    <div
                      key={line.id ?? idx}
                      className="p-3 grid grid-cols-1 sm:grid-cols-12 gap-2 text-sm items-center"
                    >
                      <div className="sm:col-span-5">
                        <div className="font-medium text-foreground">
                          {line.accountCode} - {line.accountName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          نوع الحساب: {line.accountType} {line.role ? `(${line.role})` : ""}
                          {line.customerName && ` | العميل: ${line.customerName}`}
                          {line.supplierName && ` | المورد: ${line.supplierName}`}
                        </div>
                      </div>

                      <div className="sm:col-span-3 text-start font-mono">
                        {line.debit && Number(line.debit) > 0 ? (
                          <span className="text-money-positive font-bold">
                            مدين: {fmtAr(line.debit)} د.ع
                          </span>
                        ) : null}
                      </div>

                      <div className="sm:col-span-3 text-start font-mono">
                        {line.credit && Number(line.credit) > 0 ? (
                          <span className="text-blue-600 dark:text-blue-400 font-bold">
                            دائن: {fmtAr(line.credit)} د.ع
                          </span>
                        ) : null}
                      </div>

                      <div className="sm:col-span-1 text-center text-xs text-muted-foreground">
                        {idx + 1}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-3 bg-primary/10 border border-primary/20 rounded-lg flex items-center justify-between font-mono font-bold text-sm">
                <span>إجمالي القيد المتوازن:</span>
                <span className="text-primary">{fmtAr(selectedJournal.amount)} د.ع</span>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
