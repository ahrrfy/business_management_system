/** كشف تشغيلي للمنتجات غير المعدودة — شاشة توجيه العمال والطباعة والتصدير. */
import { useDeferredValue, useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { Download, Printer, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { trpc } from "@/lib/trpc";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { notify } from "@/lib/notify";
import { fmtInt } from "@/lib/money";

const PAGE = 250;

export default function StocktakeRemaining() {
  const params = useParams();
  const sessionId = Number(params.id);
  const enabled = Number.isFinite(sessionId) && sessionId > 0;
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const qDeferred = useDeferredValue(q.trim());
  const [assignmentId, setAssignmentId] = useState("");
  const [page, setPage] = useState(0);

  const monitor = trpc.stocktakes.monitor.useQuery(
    { sessionId },
    { enabled, refetchInterval: 10_000 },
  );
  const remaining = trpc.stocktakes.remaining.useQuery(
    {
      sessionId,
      q: qDeferred || undefined,
      assignmentId: assignmentId ? Number(assignmentId) : undefined,
      limit: PAGE,
      offset: page * PAGE,
    },
    { enabled, refetchInterval: 10_000 },
  );

  useEffect(() => setPage(0), [qDeferred, assignmentId]);
  useEffect(() => {
    const totalRows = remaining.data?.total;
    if (totalRows == null || totalRows === 0) return;
    const lastPage = Math.max(0, Math.ceil(totalRows / PAGE) - 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, remaining.data?.total]);

  if (!enabled) return <ErrorState message="معرّف جلسة الجرد غير صالح." />;
  if ((monitor.isLoading || remaining.isLoading) && !remaining.data) {
    return <LoadingState message="جارٍ إعداد كشف المنتجات المتبقية…" />;
  }
  if (remaining.error) {
    return <ErrorState message={remaining.error.message} onRetry={() => void remaining.refetch()} />;
  }
  if (!remaining.data) return <ErrorState message="تعذّر تحميل كشف المنتجات المتبقية." />;

  const { session, total, items } = remaining.data;
  const assignments = monitor.data?.assignments ?? [];
  const generatedAt = new Date();
  const progress = monitor.data?.progress;

  async function fetchAll() {
    const all: typeof items = [];
    const batchSize = 2_000;
    let offset = 0;
    while (true) {
      const page = await utils.client.stocktakes.remaining.query({
        sessionId,
        q: qDeferred || undefined,
        assignmentId: assignmentId ? Number(assignmentId) : undefined,
        limit: batchSize,
        offset,
      });
      all.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return all;
  }

  function exportRemaining() {
    exportRows(fetchAll, {
      filename: `المنتجات-المتبقية-${session.code}`,
      title: `المنتجات المتبقية — ${session.name}`,
      meta: [
        { label: "الجلسة", value: session.code },
        { label: "الفرع", value: session.branchName },
        { label: "العامل/الفريق", value: assignmentId ? assignments.find((a) => a.id === Number(assignmentId))?.name ?? "—" : "الكل" },
        { label: "إجمالي النطاق", value: String(progress?.total ?? "—") },
        { label: "المعدود", value: String(progress?.counted ?? "—") },
        { label: "عدد المنتجات", value: String(total) },
        { label: "وقت إنشاء الكشف", value: generatedAt.toLocaleString("ar-IQ-u-nu-latn") },
      ],
      columns: [
        { key: "productName", header: "المنتج" },
        { key: "variantName", header: "المتغيّر", map: (r) => r.variantName ?? "" },
        { key: "sku", header: "SKU" },
        { key: "barcode", header: "الباركود", map: (r) => r.barcode ?? "" },
        { key: "baseUnit", header: "الوحدة", map: (r) => r.baseUnit ?? "" },
        { key: "assignmentName", header: "مجموعة التوجيه المقترحة" },
        { key: "zone", header: "المنطقة", map: (r) => r.zone ?? "" },
      ],
    });
  }

  async function printRemaining() {
    const printableItems = await fetchAll();
    const opened = printReportDoc({
      title: "كشف المنتجات المتبقية في الجرد",
      docNum: session.code,
      headerExtra: [
        { label: "الجلسة", value: session.name },
        { label: "الفرع", value: session.branchName },
        { label: "العامل/الفريق", value: assignmentId ? assignments.find((a) => a.id === Number(assignmentId))?.name ?? "—" : "الكل" },
        { label: "إجمالي النطاق", value: progress ? fmtInt(progress.total) : "—" },
        { label: "المعدود", value: progress ? fmtInt(progress.counted) : "—" },
        { label: "العدد المتبقي", value: fmtInt(total) },
        { label: "وقت الإنشاء", value: generatedAt.toLocaleString("ar-IQ-u-nu-latn") },
      ],
      note: "قائمة عمل ميدانية عمياء: لا تتضمن الرصيد الدفتري أو التكلفة. ضع علامة أمام المنتج بعد جرده ثم سجّل العدّ في النظام.",
      columns: [
        { key: "check", label: "تم", align: "center" },
        { key: "product", label: "المنتج" },
        { key: "sku", label: "SKU" },
        { key: "barcode", label: "الباركود" },
        { key: "unit", label: "الوحدة" },
        { key: "worker", label: "العامل/المنطقة" },
      ],
      rows: printableItems.map((r) => ({
        check: "□",
        product: `${r.productName}${r.variantName ? ` — ${r.variantName}` : ""}`,
        sku: r.sku,
        barcode: r.barcode ?? "—",
        unit: r.baseUnit ?? "—",
        worker: `${r.assignmentName}${r.zone ? ` — ${r.zone}` : ""}`,
      })),
      orientation: "landscape",
    });
    if (!opened) notify.err("حجب المتصفح نافذة الطباعة — اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Link href={`/stocktakes/${sessionId}`} className="font-semibold text-primary hover:underline">
          → متابعة الجرد
        </Link>
        <span className="text-border">/</span>
        <span className="text-muted-foreground">المنتجات المتبقية</span>
      </div>

      <PageHeader
        title="المنتجات المتبقية في الجرد"
        description={
          <>
            {session.name} · <span className="font-mono" dir="ltr">{session.code}</span> · {session.branchName}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void Promise.all([remaining.refetch(), monitor.refetch()])}>
              <RefreshCw aria-hidden className={`size-4 ${remaining.isFetching ? "animate-spin" : ""}`} /> تحديث
            </Button>
            <Button variant="outline" size="sm" disabled={total === 0} onClick={() => void printRemaining()}>
              <Printer aria-hidden className="size-4" /> طباعة كشف العمل
            </Button>
            <Button size="sm" disabled={total === 0} onClick={exportRemaining}>
              <Download aria-hidden className="size-4" /> تصدير Excel
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="gap-1 p-4">
          <p className="text-xs font-semibold text-muted-foreground">المتبقي وفق الفلتر</p>
          <p className="text-3xl font-bold text-primary tabular-nums" dir="ltr">{fmtInt(total)}</p>
        </Card>
        <Card className="gap-1 p-4 sm:col-span-2">
          <p className="text-sm font-bold">كشف توجيه جاهز للعمال</p>
          <p className="text-xs text-muted-foreground">
            ابحث بالاسم أو SKU أو الباركود، أو اختر العامل/المنطقة، ثم اطبع الكشف أو صدّره. لا يظهر فيه أي رصيد دفتري.
          </p>
        </Card>
      </div>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-3 border-b p-3">
          <label className="relative min-w-64 flex-1 sm:max-w-md">
            <Search aria-hidden className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="بحث: اسم المنتج / SKU / العامل / المنطقة…"
              className="h-9 w-full rounded-md border bg-card pe-3 ps-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </label>
          <select
            value={assignmentId}
            onChange={(e) => setAssignmentId(e.target.value)}
            className="h-9 min-w-52 rounded-md border bg-card px-3 text-sm"
            aria-label="تصفية حسب العامل أو الفريق"
          >
            <option value="">كل العمال والمناطق</option>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.zone ? ` — ${a.zone}` : ""}</option>
            ))}
          </select>
          <span className="me-auto text-xs text-muted-foreground">
            {remaining.isFetching ? "يُحدَّث…" : `${fmtInt(total)} منتج متبقٍ`}
          </span>
        </div>

        <ScrollTableShell bordered={false}>
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="p-2.5 text-start font-semibold">المنتج</th>
                <th className="p-2.5 text-start font-semibold">SKU / الباركود</th>
                <th className="p-2.5 text-start font-semibold">الوحدة</th>
                <th className="p-2.5 text-start font-semibold">مجموعة التوجيه المقترحة</th>
                <th className="p-2.5 text-start font-semibold">المنطقة</th>
                <th className="p-2.5 text-center font-semibold">علامة ميدانية</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.variantId} className="border-t">
                  <td className="p-2.5">
                    <p className="font-bold">{r.productName}</p>
                    {r.variantName && <p className="text-xs text-muted-foreground">{r.variantName}</p>}
                  </td>
                  <td className="p-2.5 font-mono text-xs" dir="ltr">
                    <p>{r.sku}</p>
                    <p className="text-muted-foreground">{r.barcode ?? "—"}</p>
                  </td>
                  <td className="p-2.5">{r.baseUnit ?? "—"}</td>
                  <td className="p-2.5 font-semibold">{r.assignmentName}</td>
                  <td className="p-2.5">{r.zone ?? "—"}</td>
                  <td className="p-2.5 text-center text-xl text-muted-foreground">□</td>
                </tr>
              ))}
              {items.length === 0 && <TableEmptyRow colSpan={6} message="لا توجد منتجات متبقية ضمن هذا الفلتر." />}
            </tbody>
          </table>
        </ScrollTableShell>
        {total > PAGE && (
          <div className="flex items-center justify-center gap-3 border-t p-3">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              السابق
            </Button>
            <span className="text-xs text-muted-foreground">
              صفحة {fmtInt(page + 1)} من {fmtInt(Math.ceil(total / PAGE))} · المعروض {fmtInt(items.length)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * PAGE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              التالي
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
