// تقرير «الاعتماد الذاتي» — الضابطُ التعويضيّ لقرار المالك (٣/٩/٢٦، PR #962):
// «لا اعتماد ثانٍ بعد المالك». راجع shared/approvalPolicy.ts:
//   «والتقريرُ يحلّ محلّ الفصل، فهو جزءٌ من السياسة لا زينةٌ بعدها: كلُّ ما اعتمده المالك
//    على نفسه يجب أن يظهر في شاشةٍ واحدة مرتّبةٍ بالمبلغ.»
// مرئيٌّ للمُلّاك فقط (RequireOwner في App.tsx + ownerProcedure خادمياً) — الملّاك يعتمدون
// على بعضهم بعضاً هنا، لا مديرٌ ولا محاسب.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtAr, formatIqd, sum } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { SELF_APPROVAL_KIND_LABEL_AR, type SelfApprovalKind } from "@shared/selfApprovalKinds";

type Row = RouterOutputs["selfApprovalAudit"]["list"][number];

const NOTE =
  "معيارُ الظهور هنا تساوٍ حرفيّ بين مَن أنشأ المستند ومَن قرّره — لا يعتمد على صفة isOwner الحالية، " +
  "فقد تتغيّر لاحقاً بينما يبقى القرار التاريخيّ ذاتياً. كل صفٍّ هنا اعتمده فاعلٌ نفسه، وكان ذلك ممكناً " +
  "قانونياً فقط لأنّه مالكٌ نشطٌ وقت القرار. إيصالات التنفيذ الآلية (كسداد مورّدٍ اعتمده مالكٌ لطلب " +
  "موظّفٍ آخر) مُستبعَدة — العدّ يقتصر على القرار الأصليّ نفسه فلا يتكرّر.";

export default function SelfApprovalAudit() {
  const [kind, setKind] = useState<SelfApprovalKind | "">("");
  const [branchId, setBranchId] = useState<number | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.selfApprovalAudit.list.useQuery({
    from: from || undefined,
    to: to || undefined,
  });
  const allRows: Row[] = q.data ?? [];
  const hasFilters = kind !== "" || branchId !== "";

  const rows = useMemo(
    () =>
      allRows.filter(
        (r) =>
          (kind === "" || r.kind === kind) &&
          (branchId === "" || r.branchId === branchId),
      ),
    [allRows, kind, branchId],
  );

  const totalAmount = useMemo(() => sum(rows.map((r) => r.amount ?? "0")), [rows]);
  const distinctActors = useMemo(() => new Set(rows.map((r) => r.actorUserId)).size, [rows]);

  const kpis: KpiItem[] = [
    { label: "عدد السجلّات", value: String(rows.length), tone: rows.length > 0 ? "warning" : "info" },
    { label: "إجمالي المبالغ", value: fmtAr(totalAmount), tone: rows.length > 0 ? "warning" : "info" },
    { label: "عدد الملّاك الفاعلين", value: String(distinctActors), tone: "info" },
  ];

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "decidedAt",
        header: "تاريخ القرار",
        accessorFn: (r) => fmtDate(r.decidedAt),
        meta: { kind: "date" },
        cell: ({ row }) => fmtDate(row.original.decidedAt),
        footer: () => <span className="font-bold">الإجمالي ({rows.length})</span>,
      },
      {
        id: "kind",
        header: "النوع",
        accessorFn: (r) => r.kindLabel,
        meta: { kind: "status" },
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
              row.original.direction === "IN" ? "badge-status-active" : "badge-stock-out"
            }`}
          >
            {row.original.kindLabel}
          </span>
        ),
      },
      {
        id: "subject",
        header: "المرجع",
        accessorFn: (r) => r.subject,
        meta: { kind: "code" },
        cell: ({ row }) => (
          <Link href={row.original.href} className="text-primary underline-offset-2 hover:underline">
            {row.original.subject}
          </Link>
        ),
      },
      {
        id: "detail",
        header: "التفاصيل",
        accessorFn: (r) => r.detail ?? "—",
        meta: { width: "wide" },
        cell: ({ row }) => (
          <span className="block max-w-xs truncate text-xs" title={row.original.detail ?? ""}>
            {row.original.detail ?? "—"}
          </span>
        ),
      },
      {
        id: "amount",
        header: "المبلغ",
        accessorFn: (r) => fmtAr(r.amount ?? 0),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className={row.original.direction === "IN" ? "text-money-positive" : "text-money-negative"}>
            {fmtAr(row.original.amount ?? 0)}
          </span>
        ),
        footer: () => <span className="font-bold">{fmtAr(totalAmount)}</span>,
      },
      {
        id: "actor",
        header: "المالك",
        accessorFn: (r) => r.actorName,
        meta: { width: "actor" },
        cell: ({ row }) => <span className="text-xs">{row.original.actorName}</span>,
      },
      {
        id: "branch",
        header: "الفرع",
        accessorFn: (r) => r.branchName ?? "—",
        cell: ({ row }) => row.original.branchName ?? "—",
      },
    ],
    [rows.length, totalAmount],
  );

  const globalEmptyMessage = (
    <span className="text-money-positive">لا سجلّات اعتمادٍ ذاتيّ — كل قرارٍ اعتمده مالكٌ غير مَن أنشأه.</span>
  );
  const filteredEmptyMessage = <span>لا سجلّات مطابقة للفلاتر الحالية — جرّب توسيع النوع أو الفرع أو الفترة.</span>;

  function onExport() {
    exportRows(rows, {
      filename: `الاعتماد-الذاتي-${new Date().toISOString().slice(0, 10)}`,
      columns: [
        { key: "decidedAt", header: "التاريخ", map: (r) => fmtDate(r.decidedAt) },
        { key: "kindLabel", header: "النوع", map: (r) => r.kindLabel },
        { key: "subject", header: "المرجع", map: (r) => r.subject },
        { key: "detail", header: "التفاصيل", map: (r) => r.detail ?? "" },
        { key: "amount", header: "المبلغ", map: (r) => Number(r.amount ?? 0) },
        { key: "actorName", header: "المالك", map: (r) => r.actorName },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "تقرير الاعتماد الذاتي",
      headerExtra: [
        { label: "العدد", value: String(rows.length) },
        { label: "الإجمالي", value: formatIqd(totalAmount) },
      ],
      note: NOTE,
      columns: [
        { key: "decidedAt", label: "التاريخ" },
        { key: "kind", label: "النوع" },
        { key: "subject", label: "المرجع" },
        { key: "amount", label: "المبلغ", align: "left" },
        { key: "actor", label: "المالك" },
      ],
      rows: rows.map((r) => ({
        decidedAt: fmtDate(r.decidedAt),
        kind: r.kindLabel,
        subject: r.subject,
        amount: fmtAr(r.amount ?? 0),
        actor: r.actorName,
      })),
      showIndex: true,
      summary: [{ label: "الإجمالي", value: formatIqd(totalAmount), large: true, bold: true }],
    });
  }

  return (
    <ReportShell
      title="الاعتماد الذاتي"
      description="كل فعلٍ ماليّ اعتمده مالكٌ على نفسه — سجلّ رقابةٍ لا اعتمادٌ ثانٍ يُشترط."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={rows.length === 0}
      printDisabled={rows.length === 0}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">النوع</label>
            <AppSelect
              className="h-9"
              value={kind}
              onValueChange={(value) => setKind((value as SelfApprovalKind) || "")}
            >
              <option value="">الكل</option>
              {Object.entries(SELF_APPROVAL_KIND_LABEL_AR).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect
              className="h-9"
              value={String(branchId)}
              onValueChange={(value) => setBranchId(value ? Number(value) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">من تاريخ</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36 text-xs" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">إلى تاريخ</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36 text-xs" />
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable<Row>
            columns={columns}
            data={rows}
            loading={q.isLoading}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            searchPlaceholder="بحث بالمرجع أو التفاصيل أو اسم المالك..."
            externalFiltersActive={hasFilters}
            emptyState={globalEmptyMessage}
            emptyFilteredState={filteredEmptyMessage}
          />
        </CardContent>
      </Card>
    </ReportShell>
  );
}
