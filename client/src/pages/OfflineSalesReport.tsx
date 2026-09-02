// تقرير «المبيعات الأوفلاين» — الشريحة ٥ من خطة الأوفلاين.
// عين الإدارة على التجربة المُقاسة: كل فاتورة التُقطت دون اتصال بربط رقمها المؤقّت بالرسمي،
// وزمن ترحيلها، ووسم «مُزامنة لاحقاً» — مع مؤشرات إجمالية تطابق معايير نجاح التجربة.
// خادمياً: offline.salesReport يدعم branchId اختيارياً أصلاً — لا تغيير هنا سوى كشفه بالواجهة.

import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { FilterField } from "@/components/list";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtDateTime as formatDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, CloudUpload } from "lucide-react";
import { useMemo, useState } from "react";

type Row = RouterOutputs["offline"]["salesReport"]["rows"][number];

function fmtIQD(v: string | number): string {
  return Number(v).toLocaleString("en");
}

function fmtDateTime(iso: string | null): string {
  return formatDateTime(iso);
}

export default function OfflineSalesReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const report = trpc.offline.salesReport.useQuery({
    from: from || undefined,
    to: to || undefined,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const rows = report.data?.rows ?? [];
  const totals = report.data?.totals;

  // و-٤ (ورقة الإصلاحات ١٦/٨): مبيعاتٌ نقدية قُبض ثمنها وخرجت بضاعتها، رفضها الخادم لأنّ
  // ورديتها أُغلقت ⇒ خارج الدفتر تماماً. هذا الطابور هو مسار إعادتها إليه.
  const utils = trpc.useUtils();
  const recovery = trpc.offline.recoveryQueue.useQuery(undefined, { refetchInterval: 60_000 });
  const openShifts = trpc.treasury.getOpenShifts.useQuery(undefined, { refetchInterval: 60_000 });
  // الإهمال مسارٌ نادرٌ وخطِر (إسقاط بيعٍ مدفوع) ⇒ لا زرَّ فوريّاً: يُفتح حقلُ سببٍ إلزاميّ أولاً.
  const [discardFor, setDiscardFor] = useState<number | null>(null);
  const [discardReason, setDiscardReason] = useState("");
  const discardRecovery = trpc.offline.discardRecoveryItem.useMutation({
    onSuccess: () => {
      notify.ok("أُهمل العنصر", "سُجِّل السبب في سجلّ التدقيق");
      setDiscardFor(null);
      setDiscardReason("");
      void utils.offline.recoveryQueue.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const postRecovery = trpc.offline.postRecoveryItem.useMutation({
    onSuccess: (r) => {
      notify.ok("رُحِّل البيع المحتجَز", `فاتورة #${r.invoiceId} — ${r.offlineReceiptNumber}`);
      void utils.offline.recoveryQueue.invalidate();
      void utils.offline.salesReport.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  const branchName = (id: number) =>
    branches.data?.find((b) => Number(b.id) === id)?.name ?? `فرع #${id}`;
  const branchLabel = branchId ? branchName(Number(branchId)) : "الكل";
  const periodLabel = from || to ? `${from || "—"} — ${to || "—"}` : "كل الفترة";

  /* الأعمدة تُبنى داخل المكوّن لأنّ عمود الفرع يترجم المعرّف باسمه من استعلام الفروع. */
  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "invoiceNumber",
        header: "الفاتورة الرسمية",
        accessorFn: (r) => r.invoiceNumber,
        meta: { kind: "code" },
        cell: ({ row }) => row.original.invoiceNumber,
      },
      {
        id: "offlineReceiptNumber",
        header: "الإيصال المؤقّت",
        accessorFn: (r) => r.offlineReceiptNumber ?? "—",
        meta: { kind: "code" },
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.offlineReceiptNumber ?? "—"}</span>,
      },
      {
        id: "branch",
        header: "الفرع",
        accessorFn: (r) => branchName(r.branchId),
        cell: ({ row }) => branchName(row.original.branchId),
      },
      {
        id: "capturedAt",
        header: "الالتقاط",
        accessorFn: (r) => fmtDateTime(r.capturedAt),
        meta: { kind: "datetime" },
        cell: ({ row }) => <span className="text-xs">{fmtDateTime(row.original.capturedAt)}</span>,
      },
      {
        id: "syncedAt",
        header: "الترحيل",
        accessorFn: (r) => fmtDateTime(r.syncedAt),
        meta: { kind: "datetime" },
        cell: ({ row }) => <span className="text-xs">{fmtDateTime(row.original.syncedAt)}</span>,
      },
      {
        id: "lag",
        header: "التأخّر",
        accessorFn: (r) => (r.replayLagMinutes != null ? `${r.replayLagMinutes} د` : "—"),
        meta: { kind: "number" },
        cell: ({ row }) => (row.original.replayLagMinutes != null ? `${row.original.replayLagMinutes} د` : "—"),
      },
      {
        id: "total",
        header: "الإجمالي",
        accessorFn: (r) => `${fmtIQD(r.total)} د.ع`,
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-semibold">{fmtIQD(row.original.total)} د.ع</span>,
      },
      {
        id: "notes",
        header: "ملاحظات",
        accessorFn: (r) => (r.lateSynced ? "مُزامنة بعد الإغلاق" : ""),
        meta: { kind: "status" },
        cell: ({ row }) =>
          row.original.lateSynced ? (
            <span className="rounded-full bg-[var(--sem-warn-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-warn)]">
              <AlertTriangle aria-hidden className="ms-1 inline size-3" />
              مُزامنة بعد الإغلاق
            </span>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branches.data],
  );

  const kpis: KpiItem[] = totals
    ? [
        { label: "فواتير أوفلاينية", value: totals.count },
        { label: "إجمالي القيمة", value: `${fmtIQD(totals.total)} د.ع`, tone: "info" },
        {
          label: "زمن الترحيل (متوسط / أقصى)",
          value: totals.avgLagMinutes != null ? `${totals.avgLagMinutes} / ${totals.maxLagMinutes} د` : "—",
        },
        { label: "مُزامنة بعد إغلاق الوردية", value: totals.lateSyncedCount, tone: totals.lateSyncedCount ? "warning" : "default" },
      ]
    : [];

  function onExport() {
    exportRows(rows, {
      filename: "المبيعات-الأوفلاين",
      title: "المبيعات الأوفلاين",
      meta: [{ label: "الفرع", value: branchLabel }, { label: "الفترة", value: periodLabel }],
      columns: [
        { key: "invoiceNumber", header: "الفاتورة الرسمية" },
        { key: "offlineReceiptNumber", header: "الإيصال المؤقّت", map: (r) => r.offlineReceiptNumber ?? "—" },
        { key: "branchId", header: "الفرع", map: (r) => branchName(r.branchId) },
        { key: "capturedAt", header: "الالتقاط", map: (r) => fmtDateTime(r.capturedAt) },
        { key: "syncedAt", header: "الترحيل", map: (r) => fmtDateTime(r.syncedAt) },
        { key: "replayLagMinutes", header: "التأخّر (د)", map: (r) => r.replayLagMinutes ?? "" },
        { key: "total", header: "الإجمالي", money: true, map: (r) => Number(r.total) },
        { key: "lateSynced", header: "ملاحظات", map: (r) => (r.lateSynced ? "مُزامنة بعد الإغلاق" : "") },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "المبيعات الأوفلاين",
      headerExtra: [
        { label: "الفرع", value: branchLabel },
        { label: "الفترة", value: periodLabel },
      ],
      columns: [
        { key: "invoiceNumber", label: "الفاتورة الرسمية" },
        { key: "offlineReceiptNumber", label: "الإيصال المؤقّت" },
        { key: "branchName", label: "الفرع" },
        { key: "capturedAt", label: "الالتقاط" },
        { key: "syncedAt", label: "الترحيل" },
        { key: "replayLagMinutes", label: "التأخّر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
        { key: "notes", label: "ملاحظات" },
      ],
      rows: rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        offlineReceiptNumber: r.offlineReceiptNumber ?? "—",
        branchName: branchName(r.branchId),
        capturedAt: fmtDateTime(r.capturedAt),
        syncedAt: fmtDateTime(r.syncedAt),
        replayLagMinutes: r.replayLagMinutes != null ? `${r.replayLagMinutes} د` : "—",
        total: `${fmtIQD(r.total)} د.ع`,
        notes: r.lateSynced ? "مُزامنة بعد الإغلاق" : "",
      })),
      summary: totals
        ? [
            { label: "فواتير أوفلاينية", value: String(totals.count) },
            { label: "مُزامنة بعد الإغلاق", value: String(totals.lateSyncedCount) },
            { label: "إجمالي القيمة", value: `${fmtIQD(totals.total)} د.ع`, large: true, bold: true },
          ]
        : undefined,
    });
  }

  const recoveryPanel = (recovery.data?.length ?? 0) > 0 && (
    <section className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
        <div>
          <h2 className="text-sm font-bold">مبيعات محتجَزة خارج الدفتر — تحتاج ترحيلاً</h2>
          <p className="text-xs text-muted-foreground">
            زبائن دفعوا نقداً وخرجت بضاعتهم، ورفض الخادم ترحيل البيع لأنّ ورديته أُغلقت.
            رحّلها إلى وردية مفتوحة لتدخل الدفتر — الرقم المطبوع للزبون يبقى مربوطاً بالفاتورة.
          </p>
        </div>
      </div>
      <div className="grid gap-2">
        {recovery.data?.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums" dir="ltr">{item.offlineReceiptNumber}</span>
                {item.ageDays >= 1 && (
                  <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
                    محتجَز منذ {item.ageDays} يوماً
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {item.lineCount} صنفاً · {branchName(item.branchId)}
                {item.deviceId ? <> · جهاز {item.deviceId}</> : null} · {item.rejectReason ?? item.rejectCode}
              </div>
            </div>
            <div className="text-base font-bold tabular-nums" dir="ltr">{fmtIQD(item.amount)} د.ع</div>
            <AppSelect
              value=""
              onValueChange={(v: string) => {
                if (v) postRecovery.mutate({ id: item.id, targetShiftId: Number(v) });
              }}
              disabled={postRecovery.isPending}
              placeholder="رحّل إلى وردية…"
              className="w-52"
              aria-label={`ترحيل ${item.offlineReceiptNumber}`}
            >
              {(openShifts.data ?? [])
                // وردية التجزئة وحدها: ترحيل بيعٍ إلى درج استقبال/طباعة يُفسد نقده المتوقَّع
                // وZ-report الخاصّ بنوعه (والحدّ يرفضه أيضاً).
                .filter((sh) => Number(sh.branchId) === item.branchId && sh.shiftType === "RETAIL")
                .map((sh) => (
                  <option key={sh.shiftId} value={String(sh.shiftId)}>
                    وردية #{sh.shiftId} — {sh.userName ?? ""}
                  </option>
                ))}
            </AppSelect>
            {discardFor === item.id ? (
              <div className="flex w-full items-center gap-2">
                <input
                  className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
                  placeholder="سبب الإهمال (إلزاميّ) — يُسجَّل في التدقيق"
                  value={discardReason}
                  onChange={(e) => setDiscardReason(e.target.value)}
                  aria-label="سبب الإهمال"
                />
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={discardReason.trim().length < 5 || discardRecovery.isPending}
                  onClick={() => discardRecovery.mutate({ id: item.id, reason: discardReason })}
                >
                  تأكيد الإهمال
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDiscardReason("");
                    setDiscardFor(null);
                  }}
                >
                  إلغاء
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  // تصفير السبب عند تبديل الصفّ: نصٌّ كُتب لعنصرٍ آخر كان يبقى ظاهراً وزرّ
                  // التأكيد مُفعَّلاً ⇒ إهمال بيعٍ مدفوع بسببٍ لا يخصّه.
                  setDiscardReason("");
                  setDiscardFor(item.id);
                }}
              >
                إهمال
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <>
    {recoveryPanel}
    <ReportShell
      title="المبيعات الأوفلاين"
      description="الفواتير الملتقطة دون اتصال وترحيلها — عين الإدارة على تجربة العمل ثنائي الاتجاه"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="من تاريخ">
            <input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm" />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm" />
          </FilterField>
          <FilterField label="الفرع" className="w-40">
            <AppSelect value={branchId ? String(branchId) : ""} onValueChange={(v) => setBranchId(v ? Number(v) : "")}>
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </AppSelect>
          </FilterField>
        </div>
      }
    >
      <DataTable<Row>
        columns={columns}
        data={rows}
        loading={report.isLoading}
        errorState={{ isError: report.isError, message: report.error?.message, onRetry: () => void report.refetch() }}
        /*
         * ⛔ لا بحثَ محلّيّ: `offline.salesReport` يقتطع الصفوف عند LIMIT 500 بينما
         * `totals.count` عدٌّ كامل غير مقتطَع — فبحثٌ فوق الخمسمئة المحمَّلة يقول «لا نتائج»
         * عن فاتورةٍ موجودة، وهو أكذبُ من الاقتطاع نفسه. الفلترة خادمية (الفترة · الفرع).
         */
        searchable={false}
        /* فلاتر التاريخ والفرع خارج الجدول (تغذّي الاستعلام) — بلا هذا تُعلَن «لا صفوف بعد» زوراً. */
        externalFiltersActive={!!from || !!to || branchId !== ""}
        /* صدقُ الاقتطاع: العدّاد الكامل أعلى الشاشة قد يتجاوز المعروض ⇒ نُعلنه بدل إخفائه. */
        statusSummary={
          totals && totals.count > rows.length
            ? `معروضٌ ${fmtIQD(rows.length)} من ${fmtIQD(totals.count)} — ضيّق الفترة أو الفرع لرؤية الباقي`
            : undefined
        }
        emptyState={
          <span className="inline-flex flex-col items-center gap-1">
            <CloudUpload aria-hidden className="size-6" />
            لا مبيعات أوفلاينية في النطاق المحدد
          </span>
        }
        emptyFilteredState={
          <span className="inline-flex flex-col items-center gap-1">
            <CloudUpload aria-hidden className="size-6" />
            لا مبيعات أوفلاينية في النطاق المحدد
          </span>
        }
      />
    </ReportShell>
  </>
  );
}
