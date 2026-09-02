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
import { printAPAging } from "@/lib/printing/printTemplates";
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

type Row = RouterOutputs["reports"]["apAging"][number];

/** الشرائح العمرية كما يعيدها الخادم — مفاتيح الفلترة والفرز معاً. */
const BUCKETS = [
  { key: "d0_30", label: "0–30 يوم" },
  { key: "d31_60", label: "31–60 يوم" },
  { key: "d61_90", label: "61–90 يوم" },
  { key: "d91p", label: "أكثر من 90" },
] as const;
type MoneyKey = (typeof BUCKETS)[number]["key"] | "unpaidTotal" | "currentBalance";

const PAGE = 50;

const fmt = (s: string | number) => fmtMoney(s);

/**
 * عمودُ مبلغٍ قابل للفرز. الفرز بـ**Decimal** لا بالنصّ المعروض: `accessorFn` تُرجع النصّ
 * المُنسَّق (كي ينسخه المستعمِل كما يقرأه)، والمقارنةُ النصّية عليه تُرتّب «1,234» قبل «999».
 * و`sortDescFirst` يحفظ سلوك الجدول الخامّ: أوّل نقرةٍ تنازليّة (الأكبر ديناً أوّلاً).
 */
function agingMoneyColumn(id: MoneyKey, header: string, className?: string): ColumnDef<Row, unknown> {
  const read = (r: Row) => D((r as Record<MoneyKey, string | null>)[id] || 0);
  return {
    id,
    header,
    accessorFn: (r) => fmt(read(r).toFixed(2)),
    meta: { kind: "money" },
    sortDescFirst: true,
    sortingFn: (a, b) => read(a.original).cmp(read(b.original)),
    cell: ({ row }) => <span className={className}>{fmt(read(row.original).toFixed(2))}</span>,
  };
}

export default function APAging() {
  const branches = trpc.branches.list.useQuery();
  // القائمة كاملة محمَّلة من الخادم ⇒ كل الفلاتر أدناه عميلية (بحث/شريحة/فرز/ترقيم).
  const [f, setF, resetF] = useUrlFilters({ branch: "", q: "", bucket: "" });
  const aging = trpc.reports.apAging.useQuery({ branchId: f.branch ? Number(f.branch) : undefined });
  const sel = useRowSelection<number>();

  // الفرز صار داخل DataTable (تنازلي أولاً على أعمدة المال عبر `sortDescFirst`)،
  // والترقيم العميليّ صار داخله أيضاً بحجم صفحة PAGE — فزال شريط «السابق/التالي» اليدويّ.

  // عقد import-integration §٦: «رصيد غير مفوتر/افتتاحي» = الرصيد الجاري − غير المدفوع،
  // يُحسب في العميل بـDecimal (لا parseFloat) — يفسّر فجوة المستورَد برصيد افتتاحي بلا أوامر شراء.
  const unbilledOf = (r: { currentBalance: string | null; unpaidTotal: string | null }) =>
    D(r.currentBalance || 0).minus(D(r.unpaidTotal || 0));

  // §٥: نجمع بدقّة Decimal، لا Number() (يتراكم انجراف على كثرة الصفوف). نُخرج نصوصاً 2dp.
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

  // الفلاتر العميلية: بحث بالاسم/الهاتف + شريحة عمرية بها مبلغ. (الفرز يتولّاه DataTable.)
  const filtered = useMemo(() => {
    const q = f.q.trim();
    return (aging.data ?? []).filter((r) => {
      if (q && !(r.supplierName.includes(q) || (r.phone ?? "").includes(q))) return false;
      if (f.bucket && !D((r as Record<MoneyKey, string | null>)[f.bucket as MoneyKey] || 0).gt(0)) return false;
      return true;
    });
  }, [aging.data, f.q, f.bucket]);

  const activeCount = [f.q.trim(), f.bucket].filter(Boolean).length;

  // الصفوف المحدَّدة فقط — للتصدير الجزئي ولنسخ ملخّص واتساب (التحديد يعبر الصفحات).
  const selectedRows = useMemo(
    () => (aging.data ?? []).filter((r) => sel.isSelected(r.supplierId)),
    [aging.data, sel],
  );

  // ملخّص واتساب للذمم المحدَّدة (مبلغ غير المدفوع + أقدم أمر شراء + الهاتف).
  // يُبنى عبر sanitizeForWhatsApp ⇒ بلا إيموجي.
  const whatsappSummary = useMemo(() => {
    if (selectedRows.length === 0) return "";
    const L: string[] = [];
    L.push("*ذمم مستحقّة — لكم علينا*");
    L.push(`التاريخ: ${fmtDate(new Date())}`);
    L.push("المكتبة العربية للطباعة والقرطاسية");
    L.push("————————————————");
    let grand = D(0);
    for (const r of selectedRows) {
      const unpaid = D(r.unpaidTotal || 0);
      grand = grand.plus(unpaid);
      const phone = r.phone ? ` — ${r.phone}` : "";
      const oldest = r.oldestPoDate ? ` — أقدم أمر ${r.oldestPoDate}` : "";
      L.push(`- ${r.supplierName}${phone}: ${fmtAr(unpaid.toFixed(2))} د.ع${oldest}`);
    }
    L.push("————————————————");
    L.push(`*الإجمالي المستحقّ: ${fmtAr(grand.toFixed(2))} د.ع*`);
    L.push("");
    L.push("سنحاول ترتيب السداد في أقرب وقت — لأي استفسار تواصلوا معنا.");
    return sanitizeForWhatsApp(L.join("\n"));
  }, [selectedRows]);

  const columns: ColumnDef<Row, unknown>[] = [
    {
      id: "supplierName",
      header: "المورد",
      accessorFn: (r) => r.supplierName,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => <span className="font-medium">{row.original.supplierName}</span>,
    },
    {
      id: "phone",
      header: "الهاتف",
      accessorFn: (r) => r.phone ?? "",
      meta: { kind: "phone" },
      cell: ({ row }) => <CopyInline value={row.original.phone} />,
    },
    agingMoneyColumn("d0_30", "0–30"),
    agingMoneyColumn("d31_60", "31–60"),
    agingMoneyColumn("d61_90", "61–90"),
    agingMoneyColumn("d91p", "+90"),
    agingMoneyColumn("unpaidTotal", "إجمالي غير المدفوع", "font-semibold"),
    {
      /* عمودٌ مشتقّ (الرصيد − غير المدفوع) لا حقل خادميّ — ولم يكن قابلاً للفرز في الجدول الخامّ.
         والمُعرِّف عربيٌّ عمداً (نفس نظيره في `ARAging`): `DataTable` يشتقّ اسم العمود في منتقي
         الأعمدة وفي «نسخ العمود كـTSV» من الترويسة **حين تكون نصّاً**، وإلّا رجع إلى `id` —
         وهذه ترويسةٌ مركَّبة (فيها Popover) ⇒ لولا التعريب لقرأ الموظّف «unbilled» وسط أعمدةٍ عربية. */
      id: "غير مفوتر/افتتاحي",
      header: () => (
        <span className="inline-flex items-center gap-1">
          غير مفوتر/افتتاحي
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="شرح: غير مفوتر/افتتاحي"
                // Codex P2 (٢٤/٨ على PR #770): هدف لمس ٢٤×٢٤ (WCAG 2.5.8).
                className="inline-flex h-6 w-6 items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-ring text-muted-foreground hover:text-foreground hover:bg-accent"
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
      enableSorting: false,
      cell: ({ row }) => <span className="text-[var(--sem-info)]">{fmt(unbilledOf(row.original).toFixed(2))}</span>,
    },
    agingMoneyColumn("currentBalance", "الرصيد (له علينا)"),
    {
      id: "oldestPoDate",
      header: "أقدم أمر شراء",
      accessorFn: (r) => r.oldestPoDate ?? "—",
      meta: { kind: "date" },
      cell: ({ row }) => <span className="text-xs">{row.original.oldestPoDate ?? "—"}</span>,
    },
    {
      id: "actions",
      header: "إجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => (
        <RowActions
          mode="inline"
          actions={[{
            key: "statement",
            kind: "view",
            label: "كشف الحساب",
            href: `/suppliers-statement?id=${row.original.supplierId}`,
            gate: { module: "suppliers", level: "READ" },
          }]}
        />
      ),
    },
  ];

  const onExportSelected = () => {
    if (selectedRows.length === 0) return;
    exportRows(selectedRows, {
      filename: "ذمم-دائنة-محددة",
      columns: [
        { key: "supplierName", header: "المورد" },
        { key: "phone", header: "الهاتف" },
        { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
        { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
        { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
        { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
        { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
        { key: "unbilled", header: "غير مفوتر/افتتاحي", map: (r) => unbilledOf(r).toNumber() },
        { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance) },
        { key: "oldestPoDate", header: "أقدم أمر شراء" },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أعمار الذمم الدائنة — لهم علينا"
        description="المبالغ المستحقّة لهم علينا (للموردين)، مُجمَّعة في أربع شرائح عمرية. كلما طال العمر كلما استوجب الأولويّة. المسوّدات والملغاة مستثناة."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!aging.data?.length}
              onClick={() =>
                exportRows(aging.data ?? [], {
                  filename: "ذمم-دائنة",
                  columns: [
                    { key: "supplierName", header: "المورد" },
                    { key: "phone", header: "الهاتف" },
                    { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
                    { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
                    { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
                    { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
                    { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
                    { key: "unbilled", header: "غير مفوتر/افتتاحي", map: (r) => unbilledOf(r).toNumber() },
                    { key: "currentBalance", header: "الرصيد الحالي", map: (r) => Number(r.currentBalance) },
                    { key: "oldestPoDate", header: "أقدم أمر شراء" },
                  ],
                })
              }
            >
              تصدير Excel
            </Button>
            <Button variant="outline" size="sm" disabled={!aging.data?.length} onClick={() => printAPAging({
              date: fmtDate(new Date()),
              rows: (aging.data ?? []).map(r => ({
                name: r.supplierName,
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
            <Link href="/suppliers-statement"><Button variant="outline">كشف حساب مورد</Button></Link>
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <FilterField label="الفرع" className="w-44">
            <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })}>
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
            </AppSelect>
          </FilterField>
          <FilterField label="بحث (المورد / الهاتف)" className="w-56">
            <Input
              type="search"
              value={f.q}
              onChange={(e) => setF({ q: e.target.value })}
              placeholder="اسم المورد أو رقم الهاتف…"
            />
          </FilterField>
          <FilterField label="الشريحة العمرية" className="w-40">
            <AppSelect value={f.bucket} onValueChange={(v) => setF({ bucket: v })}>
              <option value="">الكل</option>
              {BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
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
          <Bucket label="إجمالي ما لهم علينا" value={totals.currentBalance} color="bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]" emphasis />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {/* الفلاتر (البحث/الشريحة) في بطاقة الفلاتر أعلاه وتغذّي `filtered` ⇒ `searchable={false}`
              وإلّا ظهر حقلا بحثٍ متجاوران. و`externalFiltersActive` = «للقائمة الأصل صفوفٌ لكن
              المعروض فارغ» ⇒ نفس تمييز الرسالتين في الجدول الخامّ.
              الترقيم العميليّ صار داخل الجدول بحجم صفحة PAGE (شريطٌ واحد لا اثنان)،
              والتحديد المتعدّد يُصيّره DataTable نفسه (عمود اختيار + «تحديد كل المرئي»). */}
          <DataTable<Row, number>
            columns={columns}
            data={filtered}
            searchable={false}
            externalFiltersActive={(aging.data?.length ?? 0) > 0}
            pageSize={PAGE}
            selection={sel}
            getRowId={(r) => r.supplierId}
            loading={aging.isLoading}
            errorState={{ isError: aging.isError, message: aging.error?.message, onRetry: () => void aging.refetch() }}
            emptyState="لا ذمم دائنة مستحقّة."
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
