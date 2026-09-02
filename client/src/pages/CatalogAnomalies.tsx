/**
 * CatalogAnomalies.tsx — لوحة تدقيق شذوذ الكتالوج (L2.3).
 *
 * **الغاية:** تعرض ست عدسات كشفٍ (L1-L6) على `productVariants` لأخطاء تكلفة/سعر/معامل
 * (حادثة SINARLINE-class). لكل صفٍّ: عرض المُقاييس، deep-link للإصلاح، أو تسجيل «قصديّ»
 * (تصفية/بضاعة قديمة) أو «تجاهل نهائيّاً» (whitelist).
 *
 * **الصلاحيات:** خلف `catalogAnomalies` — admin/manager (FULL) + accountant/auditor (READ فقط،
 * أفعال markIntentional/markIgnored محجوبة).
 */
import { useMemo, useState } from "react";
import { FilterField, FilterShell, SearchField } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { ACTION_LABELS } from "@shared/actionLabels";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ExternalLink, XCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import { TablePager } from "@/components/table/TablePager";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { exportRows } from "@/lib/export";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

type Severity = "blocker" | "warning" | "info";
type LensCode = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
type Finding = RouterOutputs["catalogAnomalies"]["list"]["findings"][number];

const LENS_LABELS: Record<LensCode, string> = {
  L1: "L1 · تكلفة ≥ ٥× بيع",
  L2: "L2 · تكلفة > بيع (خسارة)",
  L3: "L3 · هامش صفر",
  L4: "L4 · تكلفة صفر مع نشاط",
  L5: "L5 · معامل شاذّ",
  L6: "L6 · تكلفة وحدة > سعرها",
};

// توكنز دلالية (tokens.css) بدل الألوان الخام — يتوافق مع حارس check-no-raw-status-colors:
//   blocker → sem-neg (أحمر)  ·  warning → sem-warn (كهرمانيّ)  ·  info → sem-info (أزرق)
const SEVERITY_BADGE: Record<Severity, { className: string; label: string; icon: React.ReactNode }> = {
  blocker: { className: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30", label: "حاجز", icon: <XCircle className="size-3" aria-hidden /> },
  warning: { className: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/30", label: "تحذير", icon: <AlertTriangle className="size-3" aria-hidden /> },
  info: { className: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30", label: "إخبار", icon: <CheckCircle2 className="size-3" aria-hidden /> },
};

const PAGE_SIZE = 200;

/** تسمية حالة الاستثناء كما تُقرأ — مصدرٌ واحد للعرض ولـ«نسخ القيمة». */
function overrideStatusLabel(f: Finding): string {
  if (!f.override) return "نشط";
  const base = f.override.kind === "INTENTIONAL" ? "قصديّ" : "متجاهَل";
  return f.override.excludeUntil ? `${base} حتى ${String(f.override.excludeUntil).slice(0, 10)}` : base;
}

/** صفُّ سجلّ تغيّرات التكلفة — مشتقٌّ من عقد `catalogAnomalies.changeLog`. */
type CostLogRow = RouterOutputs["catalogAnomalies"]["changeLog"][number];

/** نصّ «قبل → بعد (نسبة)» — نفسه في الخليّة وفي «نسخ القيمة». */
function costChangeText(r: CostLogRow): string {
  const oldV = Number(r.oldValue);
  const newV = Number(r.newValue);
  const ratio = oldV > 0 ? newV / oldV : 0;
  return `${oldV.toLocaleString("en-US")} → ${newV.toLocaleString("en-US")} (${ratio.toFixed(2)}×)`;
}

/** تسمية حالة الاستعادة كما تُقرأ — تُطابق ما يعرضه العمود مهما كان شكلُه (شارة/زرّ/رابط). */
function revertStateLabel(r: CostLogRow, canWrite: boolean): string {
  if (r.reverted) return "مستعادٌ سابقاً";
  if (canWrite && Number(r.directRevertAllowed) === 1) return "استعادة";
  if (canWrite && r.revertBlockReason === "STOCK_ON_HAND") return "طلب إعادة تقييم";
  if (canWrite && r.revertBlockReason === "EXPIRED") return "انتهت المهلة";
  if (canWrite && r.revertBlockReason === "NON_COST") return "غير مدعوم";
  return "نشط";
}

export default function CatalogAnomalies() {
  const [includeOverridden, setIncludeOverridden] = useState(false);
  const [codeFilter, setCodeFilter] = useState<LensCode | "">("");
  const [sevFilter, setSevFilter] = useState<Severity | "">("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [markDialog, setMarkDialog] = useState<{
    variantId: number; code: LensCode; kind: "INTENTIONAL" | "IGNORED"; productLabel: string;
  } | null>(null);
  const [exporting, setExporting] = useState(false);

  const utils = trpc.useUtils();
  const meQ = trpc.auth.me.useQuery();
  const canWrite = !!meQ.data?.role && moduleAccessAllowed(
    meQ.data.role as RoleKey,
    (meQ.data.permissionsOverride ?? null) as PermissionMap | null,
    "catalogAnomalies",
    "FULL",
    ["manager"],
  );
  const filterInput = {
    includeOverridden,
    codes: codeFilter ? [codeFilter] : undefined,
    severities: sevFilter ? [sevFilter] : undefined,
    limitPerLens: 200,
  };
  const listQ = trpc.catalogAnomalies.list.useQuery({
    ...filterInput,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }, { staleTime: 60 * 1000 });
  const total = listQ.data?.total ?? 0;

  /** تصدير كامل — كل صفحات النتائج المطابقة للفلاتر الحاليّة (لا الصفحة المعروضة فقط). */
  async function exportAll() {
    if (total === 0 || exporting) return;
    setExporting(true);
    try {
      const rows: Finding[] = [];
      let offset = 0;
      for (;;) {
        const res = await utils.catalogAnomalies.list.fetch({ ...filterInput, limit: 500, offset });
        rows.push(...res.findings);
        offset += res.findings.length;
        if (res.findings.length === 0 || offset >= res.total) break;
      }
      exportRows(rows, {
        filename: "تدقيق-شذوذ-الكتالوج",
        columns: [
          { key: "code", header: "العدسة", map: (f) => LENS_LABELS[f.code as LensCode] ?? f.code },
          { key: "severity", header: "الحدّة", map: (f) => SEVERITY_BADGE[f.severity as Severity]?.label ?? f.severity },
          { key: "productName", header: "المنتج" },
          { key: "sku", header: "SKU" },
          { key: "note", header: "تفاصيل" },
          { key: "status", header: "الحالة", map: (f) => (f.override ? (f.override.kind === "INTENTIONAL" ? "قصديّ" : "متجاهَل") : "نشط") },
        ],
      });
    } finally {
      setExporting(false);
    }
  }

  const markIntentional = trpc.catalogAnomalies.markIntentional.useMutation({
    onSuccess: () => { utils.catalogAnomalies.list.invalidate(); setMarkDialog(null); },
  });
  const markIgnored = trpc.catalogAnomalies.markIgnored.useMutation({
    onSuccess: () => { utils.catalogAnomalies.list.invalidate(); setMarkDialog(null); },
  });
  const clearOverride = trpc.catalogAnomalies.clearOverride.useMutation({
    onSuccess: () => utils.catalogAnomalies.list.invalidate(),
  });

  const filtered = (listQ.data?.findings ?? []).filter((f) => {
    if (!search.trim()) return true;
    const s = search.trim().toLowerCase();
    return (
      f.sku.toLowerCase().includes(s) ||
      f.productName.toLowerCase().includes(s) ||
      String(f.variantId).includes(s)
    );
  });

  /*
   * أعمدة النتائج — داخل المكوّن لأنّها تقرأ الصلاحية وتفتح حوار الاستثناء.
   * `accessorFn` بالتسمية المعروضة لا الرمز الخامّ، وعمودُ الأفعال معفى (لا قيمة له).
   */
  const findingColumns = useMemo<ColumnDef<Finding, unknown>[]>(
    () => [
      {
        id: "severity",
        header: "الحدّة",
        accessorFn: (f) => SEVERITY_BADGE[f.severity as Severity]?.label ?? f.severity,
        meta: { kind: "status" },
        cell: ({ row }) => {
          const sev = SEVERITY_BADGE[row.original.severity as Severity];
          return (
            <Badge variant="outline" className={sev.className}>
              {sev.icon} {sev.label}
            </Badge>
          );
        },
      },
      {
        id: "code",
        header: "العدسة",
        accessorFn: (f) => LENS_LABELS[f.code as LensCode] ?? f.code,
        cell: ({ row }) => <span className="text-xs">{LENS_LABELS[row.original.code as LensCode]}</span>,
      },
      {
        id: "productName",
        header: "المنتج",
        accessorFn: (f) => f.productName,
        meta: { width: "wide" },
        cell: ({ row }) => (
          // القصّ مع title كما كان — اسم المنتج قد يطول فيمدّد الجدول.
          <span className="block max-w-xs truncate" title={row.original.productName}>
            {row.original.productName}
          </span>
        ),
      },
      { id: "sku", header: "SKU", accessorFn: (f) => f.sku, meta: { kind: "code" }, cell: ({ row }) => row.original.sku },
      {
        id: "note",
        header: "تفاصيل",
        accessorFn: (f) => f.note,
        meta: { width: "wide", wrap: true },
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.note}</span>,
      },
      {
        id: "status",
        header: "الحالة",
        accessorFn: (f) => overrideStatusLabel(f),
        meta: { kind: "status" },
        cell: ({ row }) =>
          row.original.override ? (
            <Badge variant="secondary" className="text-[10px]">
              {overrideStatusLabel(row.original)}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">نشط</span>
          ),
      },
      {
        id: "actions",
        header: "أفعال",
        meta: { kind: "actions", width: "wide" },
        cell: ({ row }) => {
          const f = row.original;
          return (
            <div className="flex items-center gap-1">
              <Link href={`/products/${f.productId}/edit`}>
                <Button size="sm" variant="outline" className="h-7 text-xs" title="فتح المنتج للتعديل">
                  <ExternalLink className="size-3 me-1" aria-hidden />
                  إصلاح
                </Button>
              </Link>
              {canWrite && !f.override && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setMarkDialog({ variantId: f.variantId, code: f.code as LensCode, kind: "INTENTIONAL", productLabel: f.productName })}
                  >
                    قصديّ
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setMarkDialog({ variantId: f.variantId, code: f.code as LensCode, kind: "IGNORED", productLabel: f.productName })}
                  >
                    تجاهل
                  </Button>
                </>
              )}
              {canWrite && f.override && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => clearOverride.mutate({ variantId: f.variantId, code: f.code as LensCode })}
                >
                  <RotateCcw className="size-3 me-1" aria-hidden />
                  إلغاء الاستثناء
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, clearOverride],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق شذوذ الكتالوج"
        description="كشف رجعيّ لأخطاء التكلفة/السعر/المعامل بست عدسات (L1-L6). الأفعال: إصلاح (deep-link)، قصديّ (تصفية/بضاعة قديمة)، تجاهل نهائيّاً."
      />

      {/* بطاقات الملخّص */}
      {listQ.data && (
        <div className="grid grid-cols-4 gap-3">
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">حاجز</div><div className="text-2xl font-bold text-[var(--sem-neg)] tabular-nums">{listQ.data.counts.blocker}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">تحذير</div><div className="text-2xl font-bold text-[var(--sem-warn)] tabular-nums">{listQ.data.counts.warning}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">إخبار</div><div className="text-2xl font-bold text-[var(--sem-info)] tabular-nums">{listQ.data.counts.info}</div></CardContent></Card>
          <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">مستثنى</div><div className="text-2xl font-bold text-muted-foreground tabular-nums">{listQ.data.overriddenCount}</div></CardContent></Card>
        </div>
      )}

      <FilterShell
        columns={3}
        activeCount={(search ? 1 : 0) + (codeFilter ? 1 : 0) + (sevFilter ? 1 : 0) + (includeOverridden ? 1 : 0)}
        onReset={() => { setSearch(""); setCodeFilter(""); setSevFilter(""); setIncludeOverridden(false); setPage(0); }}
        headerActions={
          <Button variant="outline" size="sm" disabled={total === 0 || exporting} onClick={() => void exportAll()}>
            {/* المخرَج ملفّ Excel لا طباعة ⇒ مفتاح التصدير لا مفتاح الطباعة. */}
            {exporting ? ACTION_LABELS.exporting : "تصدير Excel (الكل)"}
          </Button>
        }
        toggles={
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input type="checkbox" className="size-4" checked={includeOverridden} onChange={(e) => { setIncludeOverridden(e.target.checked); setPage(0); }} />
            تضمين المستثنى
          </label>
        }
      >
        <FilterField label="بحث (منتج / SKU / رقم متغيّر)" hint="ضمن الصفحة المعروضة" wide>
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="اسم المنتج أو SKU…"
          />
        </FilterField>
        <FilterField label="العدسة">
          <AppSelect value={codeFilter} onValueChange={(v) => { setCodeFilter(v as LensCode | ""); setPage(0); }}>
            <option value="">كل العدسات</option>
            {(Object.keys(LENS_LABELS) as LensCode[]).map((k) => (
              <option key={k} value={k}>{LENS_LABELS[k]}</option>
            ))}
          </AppSelect>
        </FilterField>
        <FilterField label="الحدّة">
          <AppSelect value={sevFilter} onValueChange={(v) => { setSevFilter(v as Severity | ""); setPage(0); }}>
            <option value="">كل الحدّات</option>
            <option value="blocker">حاجز</option>
            <option value="warning">تحذير</option>
            <option value="info">إخبار</option>
          </AppSelect>
        </FilterField>
      </FilterShell>

      {/* لافتة اقتطاع: عدسة بلغ عدد نتائجها الخام سقف limitPerLens ⇒ قد توجد نتائج أخرى لم تُكتشف من المصدر. */}
      {(listQ.data?.truncatedLenses?.length ?? 0) > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-xs text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
          <span>
            العدسات {listQ.data!.truncatedLenses.map((c) => LENS_LABELS[c as LensCode] ?? c).join("، ")} بلغت سقف الكشف
            (200) — قد توجد نتائج إضافية غير ظاهرة. ضيّق الفلتر بعدسة واحدة لرؤية الكل.
          </span>
        </div>
      )}

      {/* الجدول */}
      <Card>
        {/* شريطُ الترقيم اليدويّ حُذف من هنا: الترقيم صار خادمياً داخل الجدول، وشريطان
            يقفزان بمقدارَين مختلفَين يُتخطّى معهما صفوفٌ بصمت. */}
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">النتائج ({filtered.length} من {total})</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable<Finding>
            embedded
            columns={findingColumns}
            data={filtered}
            /* البحث والفلاتر في FilterShell أعلاه (تُغذّي `filtered`) — بلا هذا يظهر حقلا
               بحثٍ متجاوران، وتُعلن الشاشةُ «لا صفوف بعد» بينما الفلترُ وحده هو الحاجب. */
            searchable={false}
            pageSize={Infinity}
            externalFiltersActive={search.trim() !== "" || codeFilter !== "" || sevFilter !== "" || includeOverridden}
            loading={listQ.isLoading}
            errorState={{ isError: listQ.isError, message: listQ.error?.message, onRetry: () => void listQ.refetch() }}
            emptyState={
              <div className="text-sm text-muted-foreground">
                <CheckCircle2 className="size-8 mx-auto mb-2 text-[var(--sem-pos)]" aria-hidden />
                لا شذوذ — جميع المتغيّرات ضمن الحدود المعقولة أو مستثناة.
              </div>
            }
            emptyFilteredState={
              <div className="text-sm text-muted-foreground">
                <CheckCircle2 className="size-8 mx-auto mb-2 text-[var(--sem-pos)]" aria-hidden />
                لا شذوذ مطابق للفلاتر الحالية.
              </div>
            }
          />
          {/*
           * الترقيم يُقاس بـ**صفوف صفحة الخادم** لا بـ`filtered`: بحثُ الشاشة محلّيّ ويصفّي
           * الصفحة المعروضة وحدها (كما يقول تلميحُ حقله). لو مُرِّر `filtered` إلى
           * `serverPagination` لقرأ الشريطُ «عرض 1–3 من 250»، والأسوأ: بحثٌ بلا مطابقٍ في
           * الصفحة الأولى يجعل `rowsOnPage = 0` فيُخفي `TablePager` زرَّي السابق/التالي
           * ⇒ بابٌ مسدود: النتيجةُ في صفحةٍ أخرى ولا سبيل للوصول إليها إلّا بمسح البحث.
           */}
          <TablePager
            page={page}
            onPageChange={setPage}
            pageSize={PAGE_SIZE}
            rowsOnPage={listQ.data?.findings.length ?? 0}
            total={total}
            isLoading={listQ.isLoading || listQ.isFetching}
            status={
              search.trim() && filtered.length !== (listQ.data?.findings.length ?? 0)
                ? `مطابق للبحث في هذه الصفحة: ${filtered.length}`
                : undefined
            }
          />
        </CardContent>
      </Card>

      {/* حوار «قصديّ / تجاهل» */}
      {markDialog && (
        <MarkOverrideDialog
          info={markDialog}
          onClose={() => setMarkDialog(null)}
          onConfirm={(payload) => {
            if (markDialog.kind === "INTENTIONAL") {
              markIntentional.mutate(payload);
            } else {
              markIgnored.mutate({ variantId: markDialog.variantId, code: markDialog.code, justification: payload.justification });
            }
          }}
          isPending={markIntentional.isPending || markIgnored.isPending}
        />
      )}

      {/* L3: سجلّ تغيّرات التكلفة الأخيرة + استعادة */}
      <CostChangeLogSection canWrite={canWrite} />
    </div>
  );
}

/**
 * **L3.4/L3.5:** سجلّ تغيّرات التكلفة الأخيرة — يستهلك `changeLog` و`revertChange` من الراوتر.
 * كل صفٍّ يعرض قبل/بعد + نسبة + الفاعل + الوقت؛ الاستعادة المباشرة تظهر فقط حين يسمح
 * الحارس، وذو المخزون يُوجَّه إلى طلب إعادة التقييم المحاسبيّ.
 */
function CostChangeLogSection({ canWrite }: { canWrite: boolean }) {
  const [minSeverity, setMinSeverity] = useState<"info" | "warning" | "blocker" | "catastrophic">("warning");
  const [days, setDays] = useState(30);
  const utils = trpc.useUtils();
  const logQ = trpc.catalogAnomalies.changeLog.useQuery({ minSeverity, days, limit: 50 }, { staleTime: 60 * 1000 });
  const revert = trpc.catalogAnomalies.revertChange.useMutation({
    onSuccess: () => {
      utils.catalogAnomalies.changeLog.invalidate();
      utils.catalogAnomalies.list.invalidate();
      notify.ok("استُعيدت التكلفة السابقة");
    },
    onError: (e) => notify.err(e),
  });

  /*
   * أعمدة سجلّ التغيّرات — داخل المكوّن لأنّها تقرأ الصلاحية وتستدعي الاستعادة.
   * عمود «الحالة» يُمرَّر بتسميته المقروءة في `accessorFn` وإن كان محتواه زرّاً أو رابطاً.
   */
  const logColumns = useMemo<ColumnDef<CostLogRow, unknown>[]>(
    () => [
      {
        id: "createdAt",
        header: "الوقت",
        accessorFn: (r) => new Date(r.createdAt).toLocaleString("ar-IQ-u-nu-latn"),
        meta: { kind: "datetime", align: "start" },
        cell: ({ row }) => <span className="text-xs">{new Date(row.original.createdAt).toLocaleString("ar-IQ-u-nu-latn")}</span>,
      },
      {
        id: "product",
        header: "المنتج",
        accessorFn: (r) => r.productName ?? `رقم المتغيّر ${r.variantId}`,
        meta: { width: "wide" },
        cell: ({ row }) => (
          <span className="block max-w-xs truncate" title={row.original.productName ?? ""}>
            {row.original.productName ?? `رقم المتغيّر ${row.original.variantId}`}{" "}
            <span className="text-[10px] text-muted-foreground">{row.original.sku ?? ""}</span>
          </span>
        ),
      },
      {
        id: "change",
        header: "قبل → بعد",
        accessorFn: (r) => costChangeText(r),
        // kind: "number" يعزل اتّجاه الأرقام؛ align: "start" يحفظ محاذاة العمود كما كانت.
        meta: { kind: "number", align: "start", width: "wide" },
        cell: ({ row }) => {
          const oldV = Number(row.original.oldValue);
          const newV = Number(row.original.newValue);
          const ratio = oldV > 0 ? newV / oldV : 0;
          return (
            <span className="text-xs">
              {oldV.toLocaleString("en-US")} → {newV.toLocaleString("en-US")}{" "}
              <span className="text-muted-foreground">({ratio.toFixed(2)}×)</span>
            </span>
          );
        },
      },
      {
        id: "severity",
        header: "الحدّة",
        accessorFn: (r) => SEVERITY_BADGE[r.severity as Severity]?.label ?? r.severity,
        cell: ({ row }) => (
          <span className="text-xs">{SEVERITY_BADGE[row.original.severity as Severity]?.label ?? row.original.severity}</span>
        ),
      },
      {
        id: "actor",
        header: "الفاعل",
        accessorFn: (r) => r.actorName ?? "—",
        meta: { kind: "actor" },
        cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.actorName ?? "—"}</span>,
      },
      {
        id: "revertState",
        header: "الحالة",
        accessorFn: (r) => revertStateLabel(r, canWrite),
        cell: ({ row }) => {
          const r = row.original;
          const oldV = Number(r.oldValue);
          return (
            <span className="text-xs">
              {r.reverted ? (
                <Badge variant="secondary" className="text-[10px]">مستعادٌ سابقاً</Badge>
              ) : canWrite && Number(r.directRevertAllowed) === 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={async () => {
                    const ok = await confirm({
                      variant: "warning",
                      title: "استعادة تكلفة سابقة",
                      description: `استعادة التكلفة إلى ${oldV.toLocaleString("en-US")} د.ع؟`,
                      confirmText: "استعادة",
                    });
                    if (ok) revert.mutate({ logId: r.id });
                  }}
                >
                  <RotateCcw className="size-3 me-1" aria-hidden /> استعادة
                </Button>
              ) : canWrite && r.revertBlockReason === "STOCK_ON_HAND" ? (
                <Link href="/inventory" className="text-xs text-primary underline-offset-4 hover:underline">
                  طلب إعادة تقييم
                </Link>
              ) : canWrite && r.revertBlockReason === "EXPIRED" ? (
                <span className="text-muted-foreground">انتهت المهلة</span>
              ) : canWrite && r.revertBlockReason === "NON_COST" ? (
                <span className="text-muted-foreground">غير مدعوم</span>
              ) : (
                <span className="text-muted-foreground">نشط</span>
              )}
            </span>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, revert],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">سجلّ تغيّرات التكلفة (Trigger BEFORE UPDATE)</CardTitle>
        <div className="flex items-center gap-2">
          <AppSelect value={minSeverity} onValueChange={(v) => setMinSeverity(v as typeof minSeverity)} className="h-8 w-36 text-xs">
            <option value="info">إخبار فأعلى</option>
            <option value="warning">تحذير فأعلى</option>
            <option value="blocker">حاجز فأعلى</option>
            <option value="catastrophic">كارثيّ فقط</option>
          </AppSelect>
          <AppSelect value={String(days)} onValueChange={(v) => setDays(Number(v))} className="h-8 w-28 text-xs">
            <option value={7}>7 أيام</option>
            <option value={30}>30 يوماً</option>
            <option value={90}>90 يوماً</option>
          </AppSelect>
        </div>
      </CardHeader>
      <CardContent>
        {/* مُضمَّن: العنوان والفلاتر في ترويسة البطاقة أعلاه. */}
        <DataTable<CostLogRow>
          embedded
          searchable={false}
          bounded={false}
          pageSize={Infinity}
          columns={logColumns}
          data={logQ.data ?? []}
          loading={logQ.isLoading}
          errorState={{ isError: logQ.isError, message: logQ.error?.message, onRetry: () => void logQ.refetch() }}
          emptyText="لا تغيّرات مسجّلة في هذه النافذة."
        />
      </CardContent>
    </Card>
  );
}

function MarkOverrideDialog({
  info, onClose, onConfirm, isPending,
}: {
  info: { variantId: number; code: LensCode; kind: "INTENTIONAL" | "IGNORED"; productLabel: string };
  onClose: () => void;
  onConfirm: (payload: { variantId: number; code: LensCode; justification: string; excludeUntil: string | null }) => void;
  isPending: boolean;
}) {
  const [justification, setJustification] = useState("");
  const [excludeUntil, setExcludeUntil] = useState("");
  const disabled = justification.trim().length < 10 || isPending;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {info.kind === "INTENTIONAL" ? "تعليم «قصديّ»" : "تجاهل نهائيّ"}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {info.productLabel} — {LENS_LABELS[info.code]}
          </p>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium">التبرير <span className="text-[var(--sem-neg)]">*</span> (≥ 10 محارف)</label>
            <Textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder={info.kind === "INTENTIONAL" ? "مثال: تصفية مذكرات ٢٠٢٧ — قرار المالك ١/٩" : "مثال: هامش تاريخيّ متعمّد لمنتج ولاء"}
              rows={3}
            />
          </div>
          {info.kind === "INTENTIONAL" && (
            <div>
              <label className="text-xs font-medium">مدّة الاستثناء (اختياري — يعود للطابور بعدها)</label>
              <Input
                type="date"
                value={excludeUntil}
                onChange={(e) => setExcludeUntil(e.target.value)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={disabled}
            onClick={() => onConfirm({ variantId: info.variantId, code: info.code, justification: justification.trim(), excludeUntil: excludeUntil || null })}
          >
            {isPending ? ACTION_LABELS.saving : "تأكيد"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
