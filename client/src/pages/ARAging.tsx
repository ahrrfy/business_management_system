import { CopyButton, CopyInline } from "@/components/CopyButton";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { exportRows } from "@/lib/export";
import { printARAging } from "@/lib/printing/printTemplates";
import { D, fmt as fmtMoney, fmtAr } from "@/lib/money";
import { sanitizeForWhatsApp } from "@/lib/whatsapp";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { Info, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMemo } from "react";
import { Link } from "wouter";
import { useRowSelection, SelectionBar } from "@/components/list/SelectionBar";
import { RowActions } from "@/components/list";

type Row = RouterOutputs["reports"]["arAging"][number];

/** الشرائح العمرية كما يعيدها الخادم — مفاتيح الفلترة والفرز معاً. */
const BUCKETS = [
  { key: "d0_30", label: "0–30 يوم" },
  { key: "d31_60", label: "31–60 يوم" },
  { key: "d61_90", label: "61–90 يوم" },
  { key: "d91p", label: "أكثر من 90" },
] as const;
type MoneyKey = (typeof BUCKETS)[number]["key"] | "unpaidTotal" | "currentBalance";

const fmt = (s: string | number) => fmtMoney(s);

/**
 * عمود مبلغ في تقرير الأعمار. `accessorFn` يُرجع **النصّ المعروض** (كي ينسخه المستعمِل كما
 * يقرأه)، و`sortingFn` صريحٌ بـDecimal لأنّ الفرز الافتراضيّ على نصٍّ فيه فواصل آلاف
 * («1,234» قبل «999») يقلب ترتيب الذمم — والفرز هنا هو أداة التحصيل نفسها.
 * `sortDescFirst` يحفظ سلوك الشاشة القائم: أوّل نقرةٍ تُظهر الأكبر ديناً.
 */
function moneyCol(id: string, header: string, get: (r: Row) => string | null, cls?: string): ColumnDef<Row, unknown> {
  return {
    id,
    header,
    accessorFn: (r) => fmt(get(r) ?? 0),
    meta: { kind: "money" },
    sortDescFirst: true,
    sortingFn: (a, b) => D(get(a.original) || 0).cmp(D(get(b.original) || 0)),
    cell: ({ row }) => (cls ? <span className={cls}>{fmt(get(row.original) ?? 0)}</span> : fmt(get(row.original) ?? 0)),
  };
}

export default function ARAging() {
  const me = trpc.auth.me.useQuery();
  const canCrossBranches = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canCrossBranches });
  // القائمة كاملة محمَّلة من الخادم ⇒ كل الفلاتر أدناه عميلية (بحث/شريحة/فئة/فرز/ترقيم).
  const [f, setF, resetF] = useUrlFilters({ branch: "", q: "", bucket: "", ctype: "" });
  const aging = trpc.reports.arAging.useQuery({
    branchId: canCrossBranches && f.branch ? Number(f.branch) : undefined,
  });
  const sel = useRowSelection<number>();
  // الفرز والترقيم صارا داخل `DataTable` (نقرُ الترويسة + شريط الحالة) — بلا حالةٍ محلّية.

  // عقد import-integration §٦: «رصيد غير مفوتر/افتتاحي» = الرصيد الجاري − غير المدفوع،
  // يُحسب في العميل بـDecimal (لا parseFloat) — يفسّر فجوة المستورَد برصيد افتتاحي بلا فواتير.
  const unbilledOf = (r: { currentBalance: string | null; unpaidTotal: string | null }) =>
    D(r.currentBalance || 0).minus(D(r.unpaidTotal || 0));

  // §٥: نجمع بدقّة Decimal (لا Number()) ⇒ لا انجراف float عبر مئات الصفوف.
  // المجاميع على **كامل** البيانات (صورة الذمم الكلية) لا على نتيجة الفلاتر العميلية.
  const totals = useMemo(() => {
    const rows = aging.data ?? [];
    const acc = rows.reduce(
      (a, r) => ({
        d0_30: a.d0_30.plus(D(r.d0_30 || 0)),
        d31_60: a.d31_60.plus(D(r.d31_60 || 0)),
        d61_90: a.d61_90.plus(D(r.d61_90 || 0)),
        d91p: a.d91p.plus(D(r.d91p || 0)),
        unpaidTotal: a.unpaidTotal.plus(D(r.unpaidTotal || 0)),
        currentBalance: a.currentBalance.plus(D(r.currentBalance || 0)),
      }),
      { d0_30: D(0), d31_60: D(0), d61_90: D(0), d91p: D(0), unpaidTotal: D(0), currentBalance: D(0) }
    );
    return {
      d0_30: acc.d0_30.toFixed(2),
      d31_60: acc.d31_60.toFixed(2),
      d61_90: acc.d61_90.toFixed(2),
      d91p: acc.d91p.toFixed(2),
      unpaidTotal: acc.unpaidTotal.toFixed(2),
      currentBalance: acc.currentBalance.toFixed(2),
      unbilled: acc.currentBalance.minus(acc.unpaidTotal).toFixed(2),
    };
  }, [aging.data]);

  // فئات العملاء الموجودة فعلاً في البيانات (قيم enum عربية أصلاً — فرد/تاجر/مؤسسة/شركة/حكومي).
  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of aging.data ?? []) if (r.customerType) s.add(r.customerType);
    return Array.from(s);
  }, [aging.data]);

  // الفلاتر العميلية: بحث بالاسم/الهاتف + شريحة عمرية بها مبلغ + فئة العميل، ثم الفرز.
  const filtered = useMemo(() => {
    const q = f.q.trim();
    const out = (aging.data ?? []).filter((r) => {
      if (q && !(r.customerName.includes(q) || (r.phone ?? "").includes(q))) return false;
      if (f.bucket && !D((r as Record<MoneyKey, string | null>)[f.bucket as MoneyKey] || 0).gt(0)) return false;
      if (f.ctype && (r.customerType ?? "") !== f.ctype) return false;
      return true;
    });
    return out;
  }, [aging.data, f.q, f.bucket, f.ctype]);

  const activeCount = [f.q.trim(), f.bucket, f.ctype].filter(Boolean).length;

  // الصفوف المحدَّدة فقط — للتصدير الجزئي ولنسخ ملخّص واتساب (التحديد يعبر الصفحات).
  const selectedRows = useMemo(
    () => (aging.data ?? []).filter((r) => sel.isSelected(r.customerId)),
    [aging.data, sel],
  );

  // ملخّص واتساب للذمم المحدَّدة (مبلغ غير المدفوع + أقدم فاتورة + الهاتف).
  // يُبنى عبر sanitizeForWhatsApp ⇒ بلا إيموجي.
  const whatsappSummary = useMemo(() => {
    if (selectedRows.length === 0) return "";
    const L: string[] = [];
    L.push("*ذمم مستحقّة — لنا عليكم*");
    L.push(`التاريخ: ${fmtDate(new Date())}`);
    L.push("المكتبة العربية للطباعة والقرطاسية");
    L.push("————————————————");
    let grand = D(0);
    for (const r of selectedRows) {
      const unpaid = D(r.unpaidTotal || 0);
      grand = grand.plus(unpaid);
      const phone = r.phone ? ` — ${r.phone}` : "";
      const oldest = r.oldestInvoiceDate ? ` — أقدم فاتورة ${r.oldestInvoiceDate}` : "";
      L.push(`- ${r.customerName}${phone}: ${fmtAr(unpaid.toFixed(2))} د.ع${oldest}`);
    }
    L.push("————————————————");
    L.push(`*الإجمالي المستحقّ: ${fmtAr(grand.toFixed(2))} د.ع*`);
    L.push("");
    L.push("نرجو التكرّم بالسداد أو التواصل لترتيب التسوية.");
    return sanitizeForWhatsApp(L.join("\n"));
  }, [selectedRows]);

  // الأعمدة داخل المكوّن: عمود «غير مفوتر/افتتاحي» مشتقٌّ بـ`unbilledOf` المعرَّفة أعلاه.
  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      {
        id: "customerName",
        header: "العميل",
        accessorFn: (r) => r.customerName,
        meta: { width: "wide" },
        cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span>,
      },
      {
        id: "customerType",
        header: "الفئة",
        accessorFn: (r) => r.customerType ?? "—",
        cell: ({ row }) => <span className="text-xs">{row.original.customerType ?? "—"}</span>,
      },
      {
        id: "phone",
        header: "الهاتف",
        accessorFn: (r) => r.phone ?? "",
        meta: { kind: "phone" },
        cell: ({ row }) => <CopyInline value={row.original.phone} />,
      },
      moneyCol("d0_30", "0–30", (r) => r.d0_30),
      moneyCol("d31_60", "31–60", (r) => r.d31_60),
      moneyCol("d61_90", "61–90", (r) => r.d61_90),
      moneyCol("d91p", "+90", (r) => r.d91p),
      moneyCol("unpaidTotal", "إجمالي غير المدفوع", (r) => r.unpaidTotal, "font-semibold"),
      {
        /* المُعرِّف عربيٌّ عمداً: `DataTable` يشتقّ اسمَ العمود في منتقي الأعمدة وفي «نسخ
           العمود كـTSV» من الترويسة **حين تكون نصّاً**، وإلّا رجع إلى `id`. وهذه ترويسةٌ
           مركَّبة (فيها Popover) ⇒ لولا التعريب لقرأ الموظّف «unbilled» وسط أعمدةٍ عربية. */
        id: "غير مفوتر/افتتاحي",
        header: () => (
          <span className="inline-flex items-center gap-1">
            غير مفوتر/افتتاحي
            {/* Popover بدل title (نمط ٢٤/٨، Codex #764): متاحٌ باللمس والتركيز.
                الشرحُ محاسبيّ مهمّ — يُميّز رصيداً افتتاحياً مستورداً من فاتورةٍ غير مسجَّلة. */}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="شرح: غير مفوتر/افتتاحي"
                  // Codex P2 (٢٤/٨ على PR #770): هدف اللمس ≥ ٢٤×٢٤px (تُلبّي WCAG 2.5.8
                  // للحاجة الحدّ الأدنى للأهداف؛ توسيعُ padding يعوّض عن حجم الأيقونة الصغير).
                  className="inline-flex h-6 w-6 items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-ring text-muted-foreground hover:text-foreground hover:bg-accent"
                  /* ترويسة `DataTable` نفسها زرُّ فرز: بلا كبح التصعيد يفتح النقرُ الشرحَ
                     **ويقلب الفرز** معاً (وكذلك Enter/مسافة). الشرحُ قراءةٌ لا فرز. */
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Info aria-hidden className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" className="max-w-xs text-xs">
                الرصيد الحالي ناقص غير المدفوع — يشمل الرصيد الافتتاحي المستورد من النظام القديم أو الحركات غير المُوثَّقة بفاتورة.
              </PopoverContent>
            </Popover>
          </span>
        ),
        accessorFn: (r) => fmt(unbilledOf(r).toFixed(2)),
        meta: { kind: "money" },
        sortDescFirst: true,
        sortingFn: (a, b) => unbilledOf(a.original).cmp(unbilledOf(b.original)),
        cell: ({ row }) => <span className="text-[var(--sem-info)]">{fmt(unbilledOf(row.original).toFixed(2))}</span>,
      },
      moneyCol("currentBalance", "الرصيد (لنا عليه)", (r) => r.currentBalance),
      {
        id: "oldestInvoiceDate",
        header: "أقدم فاتورة",
        accessorFn: (r) => r.oldestInvoiceDate ?? "—",
        meta: { kind: "date" },
        cell: ({ row }) => row.original.oldestInvoiceDate ?? "—",
      },
      {
        id: "actions",
        header: "إجراء",
        meta: { kind: "actions" },
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            mode="inline"
            actions={[{
              key: "statement",
              kind: "view",
              label: "كشف الحساب",
              href: "/customers-statement?id=" + row.original.customerId,
              gate: { module: "crm", level: "READ" },
            }]}
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onExportSelected = () => {
    if (selectedRows.length === 0) return;
    exportRows(selectedRows, {
      filename: "ذمم-مدينة-محددة",
      columns: [
        { key: "customerName", header: "العميل" },
        { key: "customerType", header: "الفئة" },
        { key: "phone", header: "الهاتف" },
        { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
        { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
        { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
        { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
        { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
        { key: "unbilled", header: "غير مفوتر/افتتاحي", map: (r) => unbilledOf(r).toNumber() },
        { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance) },
        { key: "oldestInvoiceDate", header: "أقدم فاتورة" },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أعمار الذمم المدينة — لنا على العملاء"
        description={
          <>
            المبالغ المستحقّة <strong>لنا</strong> على العملاء، مُجمَّعة في أربع شرائح عمرية.
            الأخضر = حديث، الأحمر = متأخّر. المُسدَّد كلياً مستثنى.
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!aging.data?.length}
              onClick={() =>
                exportRows(aging.data ?? [], {
                  filename: "ذمم-مدينة",
                  columns: [
                    { key: "customerName", header: "العميل" },
                    { key: "customerType", header: "الفئة" },
                    { key: "phone", header: "الهاتف" },
                    { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
                    { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
                    { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
                    { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
                    { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
                    { key: "unbilled", header: "غير مفوتر/افتتاحي", map: (r) => unbilledOf(r).toNumber() },
                    { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance) },
                    { key: "oldestInvoiceDate", header: "أقدم فاتورة" },
                  ],
                })
              }
            >
              تصدير Excel
            </Button>
            <Button variant="outline" size="sm" disabled={!aging.data?.length} onClick={() => printARAging({
              date: fmtDate(new Date()),
              rows: (aging.data ?? []).map(r => ({
                name: r.customerName,
                d0_30: D(r.d0_30||0).toNumber(), d31_60: D(r.d31_60||0).toNumber(),
                d61_90: D(r.d61_90||0).toNumber(), d91p: D(r.d91p||0).toNumber(),
                unpaidTotal: D(r.unpaidTotal||0).toNumber(), currentBalance: D(r.currentBalance||0).toNumber(),
              })),
              totals: {
                d0_30: D(totals.d0_30).toNumber(), d31_60: D(totals.d31_60).toNumber(),
                d61_90: D(totals.d61_90).toNumber(), d91p: D(totals.d91p).toNumber(),
                unpaidTotal: D(totals.unpaidTotal).toNumber(), currentBalance: D(totals.currentBalance).toNumber(),
              },
            })}>طباعة PDF</Button>
            <Link href="/customers-statement"><Button variant="outline">كشف حساب عميل</Button></Link>
          </>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          {canCrossBranches && (
            <FilterField label="الفرع" className="w-44">
              <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })}>
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </AppSelect>
            </FilterField>
          )}
          <FilterField label="بحث (العميل / الهاتف)" className="w-56">
            <Input
              type="search"
              value={f.q}
              onChange={(e) => setF({ q: e.target.value })}
              placeholder="اسم العميل أو رقم الهاتف…"
            />
          </FilterField>
          <FilterField label="الشريحة العمرية" className="w-40">
            <AppSelect value={f.bucket} onValueChange={(v) => setF({ bucket: v })}>
              <option value="">الكل</option>
              {BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            </AppSelect>
          </FilterField>
          <FilterField label="فئة العميل" className="w-36">
            <AppSelect value={f.ctype} onValueChange={(v) => setF({ ctype: v })}>
              <option value="">الكل</option>
              {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </AppSelect>
          </FilterField>
          {activeCount > 0 && (
            <Button variant="ghost" size="sm" onClick={resetF} className="text-muted-foreground">
              <X aria-hidden className="size-4" />
              {FILTER_LABELS.reset}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <Bucket label="0–30 يوم" value={totals.d0_30} color="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" />
          <Bucket label="31–60 يوم" value={totals.d31_60} color="bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" />
          <Bucket label="61–90 يوم" value={totals.d61_90} color="bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" />
          <Bucket label="أكثر من 90" value={totals.d91p} color="bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]" />
          <Bucket label="إجمالي غير المدفوع" value={totals.unpaidTotal} color="bg-muted" emphasis />
          <Bucket label="غير مفوتر/افتتاحي" value={totals.unbilled} color="bg-[var(--sem-info-bg)] text-[var(--sem-info)]" />
          <Bucket label="إجمالي ما لنا عليهم" value={totals.currentBalance} color="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" emphasis />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable<Row, number>
            columns={columns}
            data={filtered}
            /* البحث في بطاقة الفلاتر أعلاه (يغذّي filtered) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={activeCount > 0}
            loading={aging.isLoading}
            errorState={{ isError: aging.isError, message: aging.error?.message, onRetry: () => void aging.refetch() }}
            selection={sel}
            getRowId={(r) => r.customerId}
            getRowSelectionLabel={(r) => `تحديد ${r.customerName}`}
            emptyState="لا ذمم مستحقّة. ممتاز."
            emptyFilteredState="لا نتائج مطابقة للفلاتر."
          />
        </CardContent>
      </Card>

      {sel.count > 0 && (
        <div className="sticky bottom-3 z-20 mx-auto flex w-fit items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur">
          <CopyButton
            value={whatsappSummary}
            title="نسخ المحدَّد كملخّص واتساب"
            size="sm"
            variant="outline"
            successMessage="تم نسخ الملخّص"
            className="gap-1"
          />
          <span className="text-xs text-muted-foreground">ملخّص واتساب</span>
        </div>
      )}

      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={onExportSelected}
        exportLabel="تصدير المحدَّد Excel"
      />
    </div>
  );
}

function Bucket({ label, value, color, emphasis }: { label: string; value: string; color: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-3 ${color}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-lg font-semibold"}`} dir="ltr">{fmt(value)}</div>
    </div>
  );
}
