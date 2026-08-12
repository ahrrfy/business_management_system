import { CopyButton, CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { exportRows } from "@/lib/export";
import { printARAging } from "@/lib/printing/printTemplates";
import { D, fmt as fmtMoney, fmtAr } from "@/lib/money";
import { sanitizeForWhatsApp } from "@/lib/whatsapp";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { ArrowDown, ArrowUp, ArrowUpDown, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

const PAGE = 50;

const fmt = (s: string | number) => fmtMoney(s);

/** رأس عمود قابل للفرز (تنازلي أولاً ثم تصاعدي) مع aria-sort. */
function SortTh({
  label,
  k,
  sort,
  onSort,
}: {
  label: string;
  k: MoneyKey;
  sort: { key: MoneyKey | ""; dir: "asc" | "desc" };
  onSort: (k: MoneyKey) => void;
}) {
  const active = sort.key === k;
  return (
    <th
      className="p-2 text-right"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 hover:underline"
      >
        {label}
        {active ? (
          sort.dir === "asc" ? <ArrowUp aria-hidden className="size-3" /> : <ArrowDown aria-hidden className="size-3" />
        ) : (
          <ArrowUpDown aria-hidden className="size-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

export default function ARAging() {
  const branches = trpc.branches.list.useQuery();
  // القائمة كاملة محمَّلة من الخادم ⇒ كل الفلاتر أدناه عميلية (بحث/شريحة/فئة/فرز/ترقيم).
  const [f, setF, resetF] = useUrlFilters({ branch: "", q: "", bucket: "", ctype: "" });
  const aging = trpc.reports.arAging.useQuery({ branchId: f.branch ? Number(f.branch) : undefined });
  const sel = useRowSelection<number>();

  // الفرز العميلي: تنازلي أولاً (الأهم = الأكبر ديناً) ثم تصاعدي عند النقر مجدداً.
  const [sort, setSort] = useState<{ key: MoneyKey | ""; dir: "asc" | "desc" }>({ key: "", dir: "desc" });
  const onSort = (k: MoneyKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "desc" ? "asc" : "desc" } : { key: k, dir: "desc" }));

  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [f.q, f.bucket, f.ctype, f.branch]);

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
    let out = (aging.data ?? []).filter((r) => {
      if (q && !(r.customerName.includes(q) || (r.phone ?? "").includes(q))) return false;
      if (f.bucket && !D((r as Record<MoneyKey, string | null>)[f.bucket as MoneyKey] || 0).gt(0)) return false;
      if (f.ctype && (r.customerType ?? "") !== f.ctype) return false;
      return true;
    });
    if (sort.key) {
      const k = sort.key;
      out = [...out].sort((a, b) => {
        const cmp = D((a as Record<MoneyKey, string | null>)[k] || 0).cmp(
          D((b as Record<MoneyKey, string | null>)[k] || 0),
        );
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [aging.data, f.q, f.bucket, f.ctype, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);
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
          <FilterField label="الفرع" className="w-44">
            <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })}>
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
            </AppSelect>
          </FilterField>
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
              مسح الفلاتر
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
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 w-8 text-center">
                  <input
                    type="checkbox"
                    aria-label="تحديد كل الذمم المعروضة"
                    checked={pageRows.length > 0 && pageRows.every((r) => sel.isSelected(r.customerId))}
                    onChange={(e) => sel.setMany(pageRows.map((r) => r.customerId), e.target.checked)}
                  />
                </th>
                <th className="p-2">العميل</th>
                <th className="p-2">الفئة</th>
                <th className="p-2">الهاتف</th>
                <SortTh label="0–30" k="d0_30" sort={sort} onSort={onSort} />
                <SortTh label="31–60" k="d31_60" sort={sort} onSort={onSort} />
                <SortTh label="61–90" k="d61_90" sort={sort} onSort={onSort} />
                <SortTh label="+90" k="d91p" sort={sort} onSort={onSort} />
                <SortTh label="إجمالي غير المدفوع" k="unpaidTotal" sort={sort} onSort={onSort} />
                <th className="p-2 text-right" title="الرصيد الحالي ناقص غير المدفوع — يشمل الرصيد الافتتاحي المستورد من النظام القديم">غير مفوتر/افتتاحي</th>
                <SortTh label="الرصيد (لنا عليه)" k="currentBalance" sort={sort} onSort={onSort} />
                <th className="p-2">أقدم فاتورة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r: Row) => (
                <tr key={r.customerId} className="border-t">
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      aria-label={`تحديد ${r.customerName}`}
                      checked={sel.isSelected(r.customerId)}
                      onChange={() => sel.toggle(r.customerId)}
                    />
                  </td>
                  <td className="p-2 font-medium">{r.customerName}</td>
                  <td className="p-2 text-xs">{r.customerType ?? "—"}</td>
                  <td className="p-2"><CopyInline value={r.phone} /></td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d0_30)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d31_60)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d61_90)}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.d91p)}</td>
                  <td className="p-2 text-right tabular-nums font-semibold" dir="ltr">{fmt(r.unpaidTotal)}</td>
                  <td className="p-2 text-right tabular-nums text-[var(--sem-info)]" dir="ltr">{fmt(unbilledOf(r).toFixed(2))}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(r.currentBalance)}</td>
                  <td className="p-2 text-xs" dir="ltr">{r.oldestInvoiceDate ?? "—"}</td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="inline"
                      actions={[{
                        key: "statement",
                        kind: "view",
                        label: "كشف الحساب",
                        href: `/customers-statement?id=${r.customerId}`,
                        gate: { module: "crm", level: "READ" },
                      }]}
                    />
                  </td>
                </tr>
              ))}
              {aging.data && filtered.length === 0 && (
                <TableEmptyRow
                  colSpan={13}
                  message={aging.data.length === 0 ? "لا ذمم مستحقّة. ممتاز." : "لا نتائج مطابقة للفلاتر."}
                />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* ترقيم عميلي بسيط — القائمة كلها محمَّلة، التقطيع للعرض فقط. */}
      {filtered.length > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {filtered.length.toLocaleString("ar-IQ-u-nu-latn")} صفّ — صفحة {(page + 1).toLocaleString("ar-IQ-u-nu-latn")} من {pages.toLocaleString("ar-IQ-u-nu-latn")}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>السابق</Button>
            <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>التالي</Button>
          </div>
        </div>
      )}

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
