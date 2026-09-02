// تقارير المخزون التشغيلية — قرارات لا كميات.
// عروض: إعادة الطلب · راكد عالي القيمة · خطر النفاد · فروقات الجرد. + رابط الكاردكس (بطاقة المنتج).
// يُركّب endpoints (stockStatus/deadStockValue/reorderRisk/stocktakeVariance). عرض + Excel + طباعة A4.
import { useEffect, useMemo, useState } from "react";
import { FilterField, FilterShell, SearchField } from "@/components/list";
import { Link } from "wouter";
import { FolderOpen } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Input } from "@/components/ui/input";
import { LoadingState, ErrorState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { exportRows, type ExportColumn } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtInt, fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type View = "reorder" | "dead" | "risk" | "variance" | "negatives";

/** صفُّ عرضٍ عامّ — العروض الخمسة تختلف حقولاً، والأعمدة تقرأ ما يخصّ عرضها وحده. */
type OpsRow = Record<string, any>;

const VIEW_LABEL: Record<View, string> = {
  reorder: "إعادة الطلب",
  dead: "راكد عالي القيمة",
  risk: "خطر النفاد",
  variance: "فروقات الجرد",
  negatives: "السوالب (وضع الافتتاح)",
};
const VIEW_DESC: Record<View, string> = {
  reorder: "منتجات نفدت أو تحت حدّ إعادة الطلب — اطلبها الآن.",
  dead: "رصيد بلا بيع منذ مدّة — رأس مال مجمّد يجب تحريره.",
  risk: "مبيعات عالية ومخزون منخفض — اطلب عاجلاً قبل النفاد.",
  variance: "فروقات الجرد المعتمدة حسب الفرع والتاريخ.",
  negatives: "أرصدة تحت الصفر — بوصلة أولوية الجرد الافتتاحي: اجرد الأعلى انكشافاً أولاً.",
};
const STATUS_LABEL: Record<string, string> = { out: "نفد", low: "منخفض", ok: "طبيعي" };
const STATUS_CLS: Record<string, string> = { out: "badge-stock-out", low: "badge-stock-low", ok: "bg-muted text-muted-foreground" };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function InventoryOpsReport() {
  const [view, setView] = useState<View>("reorder");
  const [branchId, setBranchId] = useState<number | "">("");
  const [deadDays, setDeadDays] = useState(90);
  const [riskDays, setRiskDays] = useState(30);
  const today = ymd(new Date());
  const monthAgo = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 90); return ymd(d); }, []);
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const branchArg = branchId ? Number(branchId) : undefined;

  // فلترا بحث/فئة محلّيان — يعملان فوق الصفوف المحمَّلة من الخادم بالفعل (لا استعلاماً جديداً).
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");

  const branches = trpc.branches.list.useQuery();
  const reorder = trpc.reports.stockStatus.useQuery({ branchId: branchArg, onlyAlerts: true }, { enabled: view === "reorder", staleTime: 60_000 });
  const dead = trpc.reports.deadStockValue.useQuery({ branchId: branchArg, sinceDays: deadDays }, { enabled: view === "dead", staleTime: 60_000 });
  const risk = trpc.reports.reorderRisk.useQuery({ branchId: branchArg, sinceDays: riskDays }, { enabled: view === "risk", staleTime: 60_000 });
  const variance = trpc.reports.stocktakeVariance.useQuery({ branchId: branchArg, from, to }, { enabled: view === "variance", staleTime: 60_000 });
  const negatives = trpc.reports.negativeStock.useQuery({ branchId: branchArg }, { enabled: view === "negatives", staleTime: 60_000 });

  type AnyRowLocal = Record<string, unknown>;
  /** بحث بالمنتج/المتغيّر + فئة — الفئة تُطبَّق فقط للعروض التي تحمل categoryName. */
  function applyFilters(rows: AnyRowLocal[]): AnyRowLocal[] {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (s) {
        const name = String(r.productName ?? "").toLowerCase();
        const variant = String(r.variantLabel ?? "").toLowerCase();
        if (!name.includes(s) && !variant.includes(s)) return false;
      }
      if (category && String(r.categoryName ?? "") !== category) return false;
      return true;
    });
  }

  // فئات العرض الحاليّ (مصدرها الصفوف الخام بلا فلترة الفئة نفسها) — فارغة لعروضٍ بلا categoryName
  // (إعادة الطلب/فروقات الجرد) فيُخفى الفلتر عندها بدل عرض قائمة فارغة بلا أثر.
  const categories = useMemo(() => {
    const src: AnyRowLocal[] =
      view === "dead" ? ((dead.data?.rows ?? []) as unknown as AnyRowLocal[])
      : view === "risk" ? ((risk.data?.rows ?? []) as unknown as AnyRowLocal[])
      : view === "negatives" ? ((negatives.data?.rows ?? []) as unknown as AnyRowLocal[])
      : [];
    const set = new Set<string>();
    for (const r of src) if (r.categoryName) set.add(String(r.categoryName));
    return Array.from(set).sort();
  }, [view, dead.data, risk.data, negatives.data]);

  // تبديل العرض يُصفّر فلتر الفئة (قائمة فئات مختلفة لكل عرض) — البحث النصّي يبقى (منطقيّ عبر العروض).
  useEffect(() => { setCategory(""); }, [view]);

  const loading =
    (view === "reorder" && reorder.isLoading) ||
    (view === "dead" && dead.isLoading) ||
    (view === "risk" && risk.isLoading) ||
    (view === "variance" && variance.isLoading) ||
    (view === "negatives" && negatives.isLoading);

  const error =
    (view === "reorder" && reorder.isError) ||
    (view === "dead" && dead.isError) ||
    (view === "risk" && risk.isError) ||
    (view === "variance" && variance.isError) ||
    (view === "negatives" && negatives.isError);

  function refetchActive() {
    if (view === "reorder") return reorder.refetch();
    if (view === "dead") return dead.refetch();
    if (view === "risk") return risk.refetch();
    if (view === "variance") return variance.refetch();
    return negatives.refetch();
  }

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  const kpis: KpiItem[] = useMemo(() => {
    if (view === "reorder" && reorder.data) {
      return [
        { label: "نفد", value: fmtInt(reorder.data.totals.outCount), tone: "negative" },
        { label: "منخفض", value: fmtInt(reorder.data.totals.lowCount), tone: "warning" },
        { label: "السطور", value: fmtInt(reorder.data.rows.length), tone: "info" },
      ];
    }
    if (view === "dead" && dead.data) {
      return [
        { label: "منتجات راكدة", value: fmtInt(dead.data.summary.count), tone: "warning" },
        { label: "رأس المال المجمّد", value: formatIqd(dead.data.summary.totalValue), tone: "negative" },
      ];
    }
    if (view === "risk" && risk.data) {
      return [{ label: "منتجات بخطر نفاد", value: fmtInt(risk.data.summary.count), tone: "warning" }];
    }
    if (view === "variance" && variance.data) {
      return [
        { label: "فروقات", value: fmtInt(variance.data.summary.count), tone: "info" },
        { label: "صافي القيمة", value: formatIqd(variance.data.summary.netValue), tone: Number(variance.data.summary.netValue) < 0 ? "negative" : "positive" },
        { label: "إجمالي مطلق", value: formatIqd(variance.data.summary.absValue), tone: "warning" },
      ];
    }
    if (view === "negatives" && negatives.data) {
      return [
        { label: "منتجات سالبة", value: fmtInt(negatives.data.summary.count), tone: "negative" },
        { label: "قيمة الانكشاف", value: formatIqd(negatives.data.summary.totalNegValue), tone: "negative" },
        { label: "بانتظار الجرد الافتتاحي", value: fmtInt(negatives.data.summary.unopenedCount), tone: "warning" },
        { label: "بلا تكلفة", value: fmtInt(negatives.data.summary.missingCostCount), tone: "warning" },
      ];
    }
    return [];
  }, [view, reorder.data, dead.data, risk.data, variance.data, negatives.data]);

  // ── التصدير + الطباعة لكل عرض ── الصفوف تمرّ عبر applyFilters كي يطابق المُصدَّر/المطبوع ما يُعرض.
  type AnyRow = AnyRowLocal;
  function exportConfig(): { rows: AnyRow[]; columns: ExportColumn<AnyRow>[]; printCols: { key: string; label: string; align?: "left" }[] } {
    if (view === "reorder") {
      const rows = applyFilters((reorder.data?.rows ?? []) as unknown as AnyRow[]);
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "branchName", header: "الفرع", map: (r) => (r.branchName as string) ?? "" },
          { key: "quantity", header: "الكمية", map: (r) => Number(r.quantity) },
          { key: "minStock", header: "حدّ الطلب", map: (r) => Number(r.minStock) },
          { key: "status", header: "الحالة", map: (r) => STATUS_LABEL[r.status as string] ?? (r.status as string) },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "branchName", label: "الفرع" }, { key: "quantity", label: "الكمية", align: "left" },
          { key: "minStock", label: "حدّ الطلب", align: "left" }, { key: "status", label: "الحالة" },
        ],
      };
    }
    if (view === "dead") {
      const rows = (dead.data?.rows ?? []) as unknown as AnyRow[];
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "categoryName", header: "الفئة", map: (r) => (r.categoryName as string) ?? "—" },
          { key: "qtyInStock", header: "الرصيد", map: (r) => Number(r.qtyInStock) },
          { key: "costPrice", header: "تكلفة الوحدة", money: true, map: (r) => Number(r.costPrice) },
          { key: "stockValue", header: "قيمة المخزون", money: true, map: (r) => Number(r.stockValue) },
          { key: "daysSinceLastSale", header: "أيام بلا بيع", map: (r) => (r.daysSinceLastSale == null ? "لا بيع" : Number(r.daysSinceLastSale)) },
          { key: "lastSaleDate", header: "آخر بيع", map: (r) => (r.lastSaleDate as string) ?? "—" },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "categoryName", label: "الفئة" }, { key: "qtyInStock", label: "الرصيد", align: "left" }, { key: "costPrice", label: "تكلفة الوحدة", align: "left" }, { key: "stockValue", label: "قيمة المخزون", align: "left" },
          { key: "days", label: "أيام بلا بيع", align: "left" }, { key: "lastSaleDate", label: "آخر بيع" },
        ],
      };
    }
    if (view === "risk") {
      const rows = applyFilters((risk.data?.rows ?? []) as unknown as AnyRow[]);
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "categoryName", header: "الفئة", map: (r) => (r.categoryName as string) ?? "—" },
          { key: "qtyInStock", header: "الرصيد", map: (r) => Number(r.qtyInStock) },
          { key: "threshold", header: "حدّ الطلب", map: (r) => Number(r.threshold) },
          { key: "qtySoldRecent", header: `مبيع ${riskDays}ي`, map: (r) => Number(r.qtySoldRecent) },
          { key: "coverDays", header: "أيام تغطية", map: (r) => (r.coverDays == null ? "" : Number(r.coverDays)) },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "categoryName", label: "الفئة" }, { key: "qtyInStock", label: "الرصيد", align: "left" }, { key: "threshold", label: "حدّ الطلب", align: "left" },
          { key: "qtySoldRecent", label: "المبيع", align: "left" }, { key: "coverDays", label: "أيام تغطية", align: "left" },
        ],
      };
    }
    if (view === "negatives") {
      const rows = applyFilters((negatives.data?.rows ?? []) as unknown as AnyRow[]);
      return {
        rows,
        columns: [
          { key: "productName", header: "المنتج" },
          { key: "variantLabel", header: "المتغيّر" },
          { key: "categoryName", header: "الفئة", map: (r) => (r.categoryName as string) ?? "—" },
          { key: "branchName", header: "الفرع", map: (r) => (r.branchName as string) ?? "" },
          { key: "quantity", header: "الرصيد", map: (r) => Number(r.quantity) },
          { key: "costPrice", header: "تكلفة الوحدة", money: true, map: (r) => Number(r.costPrice) },
          { key: "negValue", header: "قيمة الانكشاف", money: true, map: (r) => Number(r.negValue) },
          { key: "opened", header: "الحالة", map: (r) => (r.opened ? "مُفتتَح (عجز بعد الافتتاح)" : "بانتظار الجرد الافتتاحي") },
          { key: "costMissing", header: "التكلفة", map: (r) => (r.costMissing ? "غير مُدخلة" : "مُدخلة") },
          { key: "lastSaleDate", header: "آخر بيع", map: (r) => (r.lastSaleDate as string) ?? "—" },
          { key: "lastPurchaseDate", header: "آخر شراء", map: (r) => (r.lastPurchaseDate as string) ?? "—" },
        ],
        printCols: [
          { key: "productName", label: "المنتج" }, { key: "variantLabel", label: "المتغيّر" },
          { key: "categoryName", label: "الفئة" }, { key: "branchName", label: "الفرع" }, { key: "quantity", label: "الرصيد", align: "left" }, { key: "costPrice", label: "تكلفة الوحدة", align: "left" },
          { key: "negValue", label: "قيمة الانكشاف", align: "left" }, { key: "openedLabel", label: "الحالة" },
          { key: "lastSaleDate", label: "آخر بيع" },
        ],
      };
    }
    const rows = applyFilters((variance.data?.rows ?? []) as unknown as AnyRow[]);
    return {
      rows,
      columns: [
        { key: "approvedDate", header: "التاريخ", map: (r) => (r.approvedDate as string) ?? "" },
        { key: "branchName", header: "الفرع", map: (r) => (r.branchName as string) ?? "" },
        { key: "approvedByName", header: "المعتمِد", map: (r) => (r.approvedByName as string) ?? "" },
        { key: "sessionCode", header: "جلسة الجرد", map: (r) => (r.sessionCode as string) ?? "" },
        { key: "productName", header: "المنتج" },
        { key: "variantLabel", header: "المتغيّر" },
        { key: "diffQty", header: "الفرق", map: (r) => Number(r.diffQty) },
        { key: "value", header: "القيمة", money: true, map: (r) => Number(r.value) },
        { key: "reason", header: "السبب" },
      ],
      printCols: [
        { key: "approvedDate", label: "التاريخ" }, { key: "branchName", label: "الفرع" }, { key: "sessionCode", label: "جلسة الجرد" },
        { key: "productName", label: "المنتج" }, { key: "diffQty", label: "الفرق", align: "left" },
        { key: "value", label: "القيمة", align: "left" }, { key: "reason", label: "السبب" },
      ],
    };
  }

  function onExport() {
    const cfg = exportConfig();
    exportRows(cfg.rows, {
      filename: `مخزون-${VIEW_LABEL[view]}`,
      title: `المخزون التشغيلي — ${VIEW_LABEL[view]}`,
      meta: [{ label: "الفرع", value: branchLabel }, { label: "تاريخ الإصدار", value: fmtDate(new Date()) }],
      columns: cfg.columns,
    });
  }

  function onPrint() {
    const cfg = exportConfig();
    printReportDoc({
      title: `المخزون التشغيلي — ${VIEW_LABEL[view]}`,
      note: VIEW_DESC[view],
      headerExtra: [
        { label: "الفرع", value: branchLabel },
        ...(view === "variance" ? [{ label: "الفترة", value: `${from} — ${to}` }] : []),
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: cfg.printCols,
      rows: cfg.rows.map((r) => {
        const o: Record<string, string> = {};
        for (const pc of cfg.printCols) {
          const raw = pc.key === "days" ? (r.daysSinceLastSale == null ? "لا بيع" : fmtAr(Number(r.daysSinceLastSale)))
            : pc.key === "status" ? (STATUS_LABEL[r.status as string] ?? String(r.status ?? ""))
            : pc.key === "openedLabel" ? (r.opened ? "مُفتتَح" : "بانتظار الافتتاح")
            : (r as Record<string, unknown>)[pc.key];
          const v = raw == null ? "" : typeof raw === "number" ? fmtAr(raw) : String(raw);
          o[pc.key] = ["quantity", "minStock", "qtyInStock", "threshold", "qtySoldRecent", "coverDays", "costPrice", "stockValue", "value", "diffQty", "negValue"].includes(pc.key)
            ? fmtAr(Number((r as Record<string, unknown>)[pc.key] ?? 0))
            : v;
        }
        return o;
      }),
    });
  }

  const rowCount = exportConfig().rows.length;

  return (
    <ReportShell
      title="تقارير المخزون التشغيلية"
      description="قرارات تقلّل النفاد وتجميد رأس المال."
      note={VIEW_DESC[view]}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rowCount}
      printDisabled={!rowCount}
      actions={
        <Link href="/reports/item-ledger" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          <FolderOpen className="size-4" aria-hidden /> كاردكس المنتج
        </Link>
      }
      filters={
        <FilterShell bare columns={4}>
          <FilterField label="العرض">
            <AppSelect value={view} onValueChange={(v) => setView(v as View)}>
              {(Object.keys(VIEW_LABEL) as View[]).map((v) => (<option key={v} value={v}>{VIEW_LABEL[v]}</option>))}
            </AppSelect>
          </FilterField>
          <FilterField label="الفرع">
            <AppSelect value={branchId === "" ? "" : String(branchId)} onValueChange={(v) => setBranchId(v ? Number(v) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </FilterField>
          {view === "dead" && (
            <FilterField label="راكد منذ">
              <AppSelect value={String(deadDays)} onValueChange={(v) => setDeadDays(Number(v))}>
                <option value={90}>90 يوماً</option>
                <option value={180}>180 يوماً</option>
                <option value={365}>365 يوماً</option>
              </AppSelect>
            </FilterField>
          )}
          {view === "risk" && (
            <FilterField label="مبيعات آخر">
              <AppSelect value={String(riskDays)} onValueChange={(v) => setRiskDays(Number(v))}>
                <option value={30}>30 يوماً</option>
                <option value={60}>60 يوماً</option>
                <option value={90}>90 يوماً</option>
              </AppSelect>
            </FilterField>
          )}
          {view === "variance" && (
            <>
              <FilterField label="من">
                <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
              </FilterField>
              <FilterField label="إلى">
                <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
              </FilterField>
            </>
          )}
          <FilterField label="بحث">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="اسم المنتج/المتغيّر…"
            />
          </FilterField>
          {categories.length > 0 && (
            <FilterField label="الفئة">
              <AppSelect value={category} onValueChange={setCategory}>
                <option value="">كل الفئات</option>
                {categories.map((c) => (<option key={c} value={c}>{c}</option>))}
              </AppSelect>
            </FilterField>
          )}
        </FilterShell>
      }
    >
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void refetchActive()} />
          ) : (
            <ViewTable
              view={view}
              reorder={reorder.data ? { ...reorder.data, rows: applyFilters((reorder.data.rows ?? []) as unknown as AnyRow[]) } : reorder.data}
              dead={dead.data ? { ...dead.data, rows: applyFilters((dead.data.rows ?? []) as unknown as AnyRow[]) } : dead.data}
              risk={risk.data ? { ...risk.data, rows: applyFilters((risk.data.rows ?? []) as unknown as AnyRow[]) } : risk.data}
              variance={variance.data ? { ...variance.data, rows: applyFilters((variance.data.rows ?? []) as unknown as AnyRow[]) } : variance.data}
              negatives={negatives.data ? { ...negatives.data, rows: applyFilters((negatives.data.rows ?? []) as unknown as AnyRow[]) } : negatives.data}
              riskDays={riskDays}
              /* بحث/فئة الشاشة يُصفّيان الصفوف قبل الجدول — بلا هذا يُعلَن «لا صفوف بعد» زوراً. */
              filtersActive={search.trim() !== "" || category !== ""}
            />
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}

/** جدول العرض الحالي — DataTable موحّد داخل بطاقة التقرير (بحث الشاشة في شريط الفلاتر). */
function ViewDataTable({
  view,
  columns,
  rows,
  emptyMsg,
  filtersActive,
}: {
  /** العرض الحالي — يفصل حالةَ الجدول (إخفاء الأعمدة/الكثافة/الفرز) بين العروض الخمسة. */
  view: View;
  columns: ColumnDef<OpsRow, unknown>[];
  rows: OpsRow[];
  emptyMsg: string;
  filtersActive: boolean;
}) {
  return (
    /*
     * `key` و`viewKey` معاً: العروض الخمسة تُصيَّر في **نفس موضع الشجرة**، فبلا `key` يُعيد
     * React استعمال نفس نسخة `DataTable` عبر تبديل العرض — فإخفاءُ عمودٍ في «الراكد» يُخفي
     * العمودَ ذا المعرّف نفسه في «خطر النفاد» ويكتبه في تفضيلاته المحفوظة. و`viewKey` يمنح
     * كل عرضٍ مفتاحَ تخزينٍ ثابتاً بدل مفتاحٍ مشتقٍّ من المسار (واحدٌ للعروض كلّها).
     */
    <DataTable<OpsRow>
      key={view}
      viewKey={`inventory-ops:${view}`}
      columns={columns}
      data={rows}
      /* البحث والفئة في شريط فلاتر التقرير (يغذّيان rows) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
      searchable={false}
      externalFiltersActive={filtersActive}
      emptyText={emptyMsg}
      emptyFilteredState="لا صفوف مطابقة للبحث أو الفئة المختارة."
    />
  );
}

/** عمود نصّي مكتوم (متغيّر/فرع/فئة/سبب). */
function mutedCol(id: string, header: string, get: (r: OpsRow) => string): ColumnDef<OpsRow, unknown> {
  return { id, header, accessorFn: get, cell: ({ row }) => <span className="text-muted-foreground">{get(row.original)}</span> };
}

/** عمود رقميّ — kind: "number" يتكفّل بالمحاذاة وعزل الاتّجاه وtabular-nums. */
function numCol(id: string, header: string, get: (r: OpsRow) => string, cls?: (r: OpsRow) => string | undefined): ColumnDef<OpsRow, unknown> {
  return {
    id,
    header,
    accessorFn: get,
    meta: { kind: "number" },
    cell: ({ row }) => <span className={cls?.(row.original)}>{get(row.original)}</span>,
  };
}

/** عمود مبلغ. */
function moneyCol(id: string, header: string, get: (r: OpsRow) => string, cls?: (r: OpsRow) => string | undefined): ColumnDef<OpsRow, unknown> {
  return {
    id,
    header,
    accessorFn: get,
    meta: { kind: "money" },
    cell: ({ row }) => <span className={cls?.(row.original)}>{get(row.original)}</span>,
  };
}

function ViewTable({
  view, reorder, dead, risk, variance, negatives, riskDays, filtersActive,
}: {
  view: View;
  reorder: any; dead: any; risk: any; variance: any; negatives: any; riskDays: number;
  filtersActive: boolean;
}) {
  if (view === "negatives") {
    const rows: OpsRow[] = negatives?.rows ?? [];
    return (
      <ViewDataTable
        view={view}
        rows={rows}
        filtersActive={filtersActive}
        emptyMsg="لا أرصدة سالبة في هذا النطاق — كل المبيع مغطّى بالمخزون."
        columns={[
          {
            id: "product",
            header: "المنتج",
            accessorFn: (r) => String(r.productName ?? ""),
            meta: { width: "wide" },
            cell: ({ row }) => (
              <span className="font-medium">
                {row.original.productName}
                {row.original.costMissing && (
                  <span className="mr-2 inline-block rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-neg)]">
                    بلا تكلفة
                  </span>
                )}
              </span>
            ),
          },
          mutedCol("variant", "المتغيّر", (r) => String(r.variantLabel ?? "")),
          mutedCol("category", "الفئة", (r) => String(r.categoryName ?? "—")),
          mutedCol("branch", "الفرع", (r) => String(r.branchName ?? "")),
          numCol("quantity", "الرصيد", (r) => fmtAr(r.quantity), () => "text-money-negative font-bold"),
          moneyCol(
            "costPrice",
            "تكلفة الوحدة",
            (r) => (r.costMissing ? "غير مُدخلة" : fmtAr(r.costPrice)),
            (r) => (r.costMissing ? "text-money-negative" : "text-muted-foreground"),
          ),
          moneyCol("negValue", "قيمة الانكشاف", (r) => fmtAr(r.negValue), () => "text-money-negative"),
          {
            id: "openedStatus",
            header: "الحالة",
            // التسمية المعروضة لا العلم الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
            accessorFn: (r) => (r.opened ? "مُفتتَح — عجز بعد الافتتاح" : "بانتظار الجرد الافتتاحي"),
            meta: { align: "center" },
            cell: ({ row }) => (
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                  row.original.opened ? "bg-muted text-muted-foreground" : "border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                }`}
              >
                {row.original.opened ? "مُفتتَح — عجز بعد الافتتاح" : "بانتظار الجرد الافتتاحي"}
              </span>
            ),
          },
          {
            id: "lastSaleDate",
            header: "آخر بيع",
            accessorFn: (r) => String(r.lastSaleDate ?? "—"),
            meta: { kind: "date" },
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.lastSaleDate ?? "—"}</span>,
          },
          {
            id: "lastPurchaseDate",
            header: "آخر شراء",
            accessorFn: (r) => String(r.lastPurchaseDate ?? "—"),
            meta: { kind: "date" },
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.lastPurchaseDate ?? "—"}</span>,
          },
        ]}
      />
    );
  }
  if (view === "reorder") {
    const rows: OpsRow[] = reorder?.rows ?? [];
    return (
      <ViewDataTable
        view={view}
        rows={rows}
        filtersActive={filtersActive}
        emptyMsg="لا تنبيهات مخزون في هذا النطاق."
        columns={[
          { id: "product", header: "المنتج", accessorFn: (r) => String(r.productName ?? ""), meta: { width: "wide" }, cell: ({ row }) => row.original.productName },
          mutedCol("variant", "المتغيّر", (r) => String(r.variantLabel ?? "")),
          mutedCol("branch", "الفرع", (r) => String(r.branchName ?? "—")),
          numCol("quantity", "الكمية", (r) => fmtInt(r.quantity)),
          numCol("minStock", "حدّ الطلب", (r) => fmtInt(r.minStock), () => "text-muted-foreground"),
          {
            id: "status",
            header: "الحالة",
            accessorFn: (r) => STATUS_LABEL[String(r.status)] ?? String(r.status),
            meta: { kind: "status" },
            cell: ({ row }) => (
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[String(row.original.status)] ?? "bg-muted"}`}>
                {STATUS_LABEL[String(row.original.status)] ?? row.original.status}
              </span>
            ),
          },
        ]}
      />
    );
  }
  if (view === "dead") {
    const rows: OpsRow[] = dead?.rows ?? [];
    return (
      <ViewDataTable
        view={view}
        rows={rows}
        filtersActive={filtersActive}
        emptyMsg="لا مخزون راكد في هذا النطاق."
        columns={[
          {
            id: "product",
            header: "المنتج",
            accessorFn: (r) => String(r.productName ?? ""),
            meta: { width: "wide" },
            cell: ({ row }) => <span className="font-medium">{row.original.productName}</span>,
          },
          mutedCol("variant", "المتغيّر", (r) => String(r.variantLabel ?? "")),
          mutedCol("category", "الفئة", (r) => String(r.categoryName ?? "—")),
          numCol("qtyInStock", "الرصيد", (r) => fmtInt(r.qtyInStock)),
          moneyCol("costPrice", "تكلفة الوحدة", (r) => fmtAr(r.costPrice), () => "text-muted-foreground"),
          moneyCol("stockValue", "قيمة المخزون", (r) => fmtAr(r.stockValue), () => "text-money-negative"),
          numCol("daysSinceLastSale", "أيام بلا بيع", (r) => (r.daysSinceLastSale == null ? "لا بيع" : fmtAr(r.daysSinceLastSale)), () => "text-stock-low"),
          {
            id: "lastSaleDate",
            header: "آخر بيع",
            accessorFn: (r) => String(r.lastSaleDate ?? "—"),
            meta: { kind: "date" },
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.lastSaleDate ?? "—"}</span>,
          },
        ]}
      />
    );
  }
  if (view === "risk") {
    const rows: OpsRow[] = risk?.rows ?? [];
    return (
      <ViewDataTable
        view={view}
        rows={rows}
        filtersActive={filtersActive}
        emptyMsg="لا منتجات بخطر نفاد في هذا النطاق."
        columns={[
          {
            id: "product",
            header: "المنتج",
            accessorFn: (r) => String(r.productName ?? ""),
            meta: { width: "wide" },
            cell: ({ row }) => <span className="font-medium">{row.original.productName}</span>,
          },
          mutedCol("variant", "المتغيّر", (r) => String(r.variantLabel ?? "")),
          mutedCol("category", "الفئة", (r) => String(r.categoryName ?? "—")),
          numCol("qtyInStock", "الرصيد", (r) => fmtInt(r.qtyInStock), () => "text-stock-low"),
          numCol("threshold", "حدّ الطلب", (r) => fmtInt(r.threshold), () => "text-muted-foreground"),
          numCol("qtySoldRecent", `مبيع ${riskDays}ي`, (r) => fmtInt(r.qtySoldRecent), () => "text-money-positive"),
          numCol("coverDays", "أيام تغطية", (r) => (r.coverDays == null ? "—" : fmtAr(r.coverDays))),
        ]}
      />
    );
  }
  const rows: OpsRow[] = variance?.rows ?? [];
  return (
    <ViewDataTable
      view={view}
      rows={rows}
      filtersActive={filtersActive}
      emptyMsg="لا فروقات جرد معتمدة في هذا النطاق."
      columns={[
        {
          id: "approvedDate",
          header: "التاريخ",
          accessorFn: (r) => String(r.approvedDate ?? "—"),
          meta: { kind: "date" },
          cell: ({ row }) => <span className="text-muted-foreground">{row.original.approvedDate ?? "—"}</span>,
        },
        mutedCol("branch", "الفرع", (r) => String(r.branchName ?? "—")),
        {
          id: "sessionCode",
          header: "جلسة الجرد",
          accessorFn: (r) => String(r.sessionCode || "—"),
          meta: { kind: "code" },
          cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.sessionCode || "—"}</span>,
        },
        {
          id: "approvedBy",
          header: "المعتمِد",
          accessorFn: (r) => String(r.approvedByName ?? "—"),
          meta: { width: "actor" },
          cell: ({ row }) => <span className="text-muted-foreground">{row.original.approvedByName ?? "—"}</span>,
        },
        {
          id: "product",
          header: "المنتج",
          accessorFn: (r) => `${r.productName ?? ""} · ${r.variantLabel ?? ""}`,
          meta: { width: "wide" },
          cell: ({ row }) => (
            <>
              {row.original.productName}
              <span className="text-xs text-muted-foreground"> · {row.original.variantLabel}</span>
            </>
          ),
        },
        numCol("diffQty", "الفرق", (r) => fmtAr(r.diffQty), (r) => (r.diffQty < 0 ? "text-money-negative" : "text-money-positive")),
        moneyCol("value", "القيمة", (r) => fmtAr(r.value), (r) => (Number(r.value) < 0 ? "text-money-negative" : "text-money-positive")),
        mutedCol("reason", "السبب", (r) => String(r.reason ?? "")),
      ]}
    />
  );
}
