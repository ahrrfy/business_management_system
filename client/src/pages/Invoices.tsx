import { CopyInline } from "@/components/CopyButton";
import { DataTable } from "@/components/data-table/DataTable";
import { RowActions, SelectionBar, useRowSelection } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { CopyAsMenu } from "@/lib/copy/CopyAsMenu";
import { formatTableAsTSV } from "@/lib/copy/formatters";
import { exportRows } from "@/lib/export";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printInvoiceA4 } from "@/lib/printing/printTemplates";
import { allocateLineTax } from "@/components/invoice";
import { round2 } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fetchAllPaged } from "@/lib/fetchAllRows";

type Row = RouterOutputs["sales"]["list"][number];

/** حجم صفحة القائمة — الخادم يُرقّم، والمعروض هو المُحمَّل. */
const PAGE_SIZE = 50;

const STATUS: Record<string, string> = {
  PENDING: "معلّقة", PARTIALLY_PAID: "مدفوعة جزئياً", PAID: "مدفوعة",
  CONFIRMED: "مؤكّدة", CANCELLED: "ملغاة", RETURNED: "مرتجعة",
};
const STATUS_CLS: Record<string, string> = {
  PAID: "badge-status-active", PARTIALLY_PAID: "badge-stock-low",
  PENDING: "badge-status-cancelled", RETURNED: "badge-stock-out", CANCELLED: "badge-stock-out",
};
const SOURCE: Record<string, string> = { POS: "نقطة بيع", ONLINE: "أونلاين", ORDER: "طلب", WORKORDER: "طلب خدمة" };

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Invoices() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  // فلاتر خادمية (لا فلترة محلية تُخفي صفحات الخادم): فترة invoiceDate + الحالة + بحث نصّي.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  // البحث خادميّ (رقم الفاتورة/اسم العميل): كان محلّياً على الصفحة المُحمَّلة وحدها ⇒ يقول
  // «لا نتائج» عن فاتورة موجودة خارج السقف. debounce ليكتب المستخدم بلا طلب لكل حرف.
  const [q, setQ] = useState("");
  const qDebounced = useDebouncedValue(q.trim(), 300);

  // الترقيم خادميّ: الصفحة المعروضة فقط تُحمَّل (كان يُحمَّل ٢٠٠ صفّاً دفعةً بلا وصول لما بعدها).
  const [page, setPage] = useState(0);

  // تَحديد مُتَعَدِّد لِلصُفوف (نَسخ/تَصدير المُحَدَّد فَقَط).
  const sel = useRowSelection<number>();

  // حالة تحضير تصدير «الكل» (جلب كامل النتائج المطابقة للفلتر، لا الصفحة المعروضة).
  const [exporting, setExporting] = useState(false);

  // الرقم الضريبي للشركة (إعدادات النظام) — يُطبع على A4 بجانب رقم العميل الضريبي إن وُجد.
  const taxSettings = trpc.system.getTaxSettings.useQuery();

  // مدخلات الفلترة المشتركة (بلا limit/offset) — للقائمة وللمجاميع وللتصدير الشامل ⇒ الثلاثة
  // ترى نفس المجموعة حتماً (لا تصدير يخالف ما على الشاشة).
  const filterInput = useMemo(
    () => ({
      from: from || undefined,
      to: to || undefined,
      status: (status || undefined) as Row["status"] | undefined,
      q: qDebounced || undefined,
    }),
    [from, to, status, qDebounced],
  );

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى (وإلا بقي offset قديماً على مجموعة أصغر
  // فظهرت صفحة فارغة).
  useEffect(() => { setPage(0); }, [filterInput]);

  const rows = trpc.sales.list.useQuery({ ...filterInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const data = rows.data ?? [];

  // مجاميع كل النتائج المطابقة للفلتر (خادمياً، لا الصفحة المعروضة فقط) — نفس قيم فلتر list حتماً.
  // count منها = إجمالي الترقيم (نفس buildSalesListConds ⇒ مطابقة مضمونة بالبناء).
  const summary = trpc.sales.listSummary.useQuery(filterInput);
  const total = summary.data?.count;

  // طباعة A4 من القائمة: نجلب التفاصيل (sales.get) ثم نطبع بنفس قالب شاشة الفاتورة.
  async function printA4(invoiceId: number) {
    try {
      const d = await utils.sales.get.fetch({ invoiceId });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      // توزيع ضريبة الفاتورة تناسبياً على السطور لعمود «الضريبة» في A4 (نفس خوارزمية محرّر
      // الفاتورة والـInvoiceDetail: آخر سطر يمتصّ التقريب ⇒ Σ الحصص = d.taxAmount بلا انجراف).
      const afterDisc = round2(D(d.subtotal).minus(D(d.discountAmount ?? "0"))).toFixed(2);
      const shares = allocateLineTax(
        d.items.map((it) => ({ total: String(it.total) })),
        String(d.taxAmount ?? "0"),
        afterDisc,
      );
      await printInvoiceA4({
        invoiceNumber: d.invoiceNumber,
        invoiceDate: d.invoiceDate,
        customerName: d.customerName,
        companyTaxId: taxSettings.data?.taxRegistrationNumber ?? null,
        subtotal: d.subtotal,
        discountAmount: d.discountAmount,
        taxAmount: d.taxAmount,
        total: d.total,
        paidAmount: d.paidAmount,
        items: d.items.map((it, i) => ({
          productName: it.productName ?? "",
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.total,
          taxAmount: shares[i] ?? "0",
        })),
      });
    } catch (e) {
      notify.err(e);
    }
  }

  // نسخ لفاتورة جديدة: نجلب التفاصيل ونزرعها في sessionStorage (تُقرأ مرة واحدة في /sales/new).
  // ننسخ الكمية الأصلية كاملة (الفاتورة الجديدة تعيد بيع السلّة — المرتجعات لا تنقصها)،
  // وشكل كل سطر يطابق InvoiceLine في محرّر الفواتير حرفياً.
  async function duplicateInvoice(invoiceId: number) {
    try {
      const d = await utils.sales.get.fetch({ invoiceId });
      if (!d) { notify.err("تعذّر جلب الفاتورة"); return; }
      sessionStorage.setItem(
        "invoice-seed",
        JSON.stringify({
          customerId: d.customerId,
          tier: d.priceTier,
          items: d.items.map((it) => ({
            productId: it.productId ?? 0,
            variantId: it.variantId,
            productUnitId: it.productUnitId,
            name: it.productName ?? "",
            sku: it.sku ?? "",
            barcode: null,
            unit: it.unitName ?? "",
            // qty رقم في InvoiceLine (كمية لا مال) — التحويل عبر Decimal ثم toNumber.
            qty: D(it.quantity).toNumber(),
            // استرجاع معامل التحويل من baseQuantity ÷ quantity (مخزون النظام بالوحدة الأساس).
            conversionFactor: D(it.quantity).gt(0) ? D(it.baseQuantity).div(D(it.quantity)).toString() : "1",
            stockBase: 0,
            price: it.unitPrice,
            costBase: "0",
            // خصم السطر المحفوظ مبلغٌ مطلق ⇒ يُنسخ كنوع "amount".
            discount: D(it.discountAmount ?? 0).gt(0) ? String(it.discountAmount) : "0",
            discountType: "amount",
            note: "",
          })),
        })
      );
      navigate("/sales/new");
    } catch (e) {
      notify.err(e);
    }
  }

  // تصدير «الكل»: sales.list سقفٌ صلب بلا offset حقيقي للتصدير ⇒ جلبٌ واحد كبير
  // بنفس فلاتر القائمة (بدون limit/offset الصفحة) ثم exportRows. لا يمسّ تصدير المُحَدَّد.
  async function exportAll() {
    setExporting(true);
    try {
      // كل الصفحات المطابقة للفلتر **والبحث** (لا الصفحة المعروضة ولا استعلام عملاق واحد):
      // نفس filterInput ⇒ المُصدَّر = ما تراه على الشاشة موسَّعاً، لا مجموعة أخرى.
      const allRows = await fetchAllPaged<Row>(
        (offset, limit) =>
          utils.sales.list.fetch({ ...filterInput, limit, offset }).then((r) => ({ rows: (r ?? []) as Row[] })),
        { pageSize: 500 },
      );
      exportRows(allRows, {
        filename: "المبيعات",
        columns: [
          { key: "invoiceNumber", header: "رقم الفاتورة" },
          { key: "invoiceDate", header: "التاريخ", map: (r) => new Date(r.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn") },
          { key: "customerName", header: "العميل" },
          { key: "sourceType", header: "المصدر" },
          { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
          { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
          { key: "status", header: "الحالة" },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { accessorKey: "invoiceNumber", header: "رقم الفاتورة", cell: (c) => <CopyInline value={c.getValue() as string} /> },
    { accessorKey: "invoiceDate", header: "التاريخ", cell: (c) => new Date(c.getValue() as string).toLocaleString("ar-IQ-u-nu-latn") },
    { accessorKey: "customerName", header: "العميل", cell: (c) => (c.getValue() as string) ?? "—" },
    { accessorKey: "sourceType", header: "المصدر", cell: (c) => SOURCE[c.getValue() as string] ?? (c.getValue() as string) },
    { accessorKey: "total", header: "الإجمالي", cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span> },
    { accessorKey: "paidAmount", header: "المدفوع", cell: (c) => <span className="tabular-nums" dir="ltr">{fmt(c.getValue() as string)}</span> },
    {
      accessorKey: "status", header: "الحالة",
      cell: (c) => {
        const s = c.getValue() as string;
        return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[s] ?? "bg-muted"}`}>{STATUS[s] ?? s}</span>;
      },
    },
    {
      id: "action", header: "إجراء", enableSorting: false,
      cell: (c) => {
        const r = c.row.original;
        // مسوّاة = لا دفعات بعدها؛ غير قابلة للإرجاع = ملغاة/مرتجعة بالكامل.
        const settled = r.status === "PAID" || r.status === "CANCELLED" || r.status === "RETURNED";
        const returnable = r.status !== "CANCELLED" && r.status !== "RETURNED";
        return (
          <RowActions
            mode="auto"
            actions={[
              { key: "view", label: "عرض", href: `/invoices/${r.id}` },
              { key: "print", label: "طباعة A4", onSelect: () => void printA4(r.id) },
              { key: "duplicate", label: "نسخ لفاتورة جديدة", onSelect: () => void duplicateInvoice(r.id) },
              { key: "pay", label: "تسديد دفعة", href: `/invoices/${r.id}`, hidden: settled },
              { key: "return", label: "إرجاع", href: `/returns?invoiceId=${r.id}`, hidden: !returnable },
            ]}
          />
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  // الصُفوف المُحَدَّدة + تَجهيز نَصّ TSV ومُلَخَّص واتساب لِزِرّ «نَسخ المُحَدَّد كَـ».
  // الفِكرة: TSV لِلَّصق في Excel، ومُلَخَّص نَصّي مُكَثَّف لِواتساب الإدارة.
  const TSV_HEADERS = useMemo(
    () => ["رقم الفاتورة", "التاريخ", "العميل", "المصدر", "الإجمالي", "المدفوع", "الحالة"],
    [],
  );
  const selectedRows = useMemo(() => data.filter((r) => sel.isSelected(r.id)), [data, sel]);
  const selectedTsv = useMemo(() => {
    if (!selectedRows.length) return "";
    const rows = selectedRows.map((r) => ({
      "رقم الفاتورة": r.invoiceNumber,
      "التاريخ": new Date(r.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn"),
      "العميل": r.customerName ?? "",
      "المصدر": SOURCE[r.sourceType] ?? r.sourceType,
      "الإجمالي": Number(r.total),
      "المدفوع": Number(r.paidAmount),
      "الحالة": STATUS[r.status] ?? r.status,
    }));
    return formatTableAsTSV(TSV_HEADERS, rows);
  }, [selectedRows, TSV_HEADERS]);
  const selectedWhatsApp = useMemo(() => {
    if (!selectedRows.length) return "";
    const lines: string[] = [];
    lines.push(`ملخّص الفواتير (${selectedRows.length.toLocaleString("ar-IQ-u-nu-latn")})`);
    let sumTotal = D(0);
    let sumPaid = D(0);
    for (const r of selectedRows) {
      const t = D(r.total);
      const p = D(r.paidAmount);
      sumTotal = sumTotal.plus(t);
      sumPaid = sumPaid.plus(p);
      const customer = r.customerName ?? "—";
      const st = STATUS[r.status] ?? r.status;
      lines.push(`• ${r.invoiceNumber} — ${customer} — ${fmt(r.total)} (${st})`);
    }
    lines.push("");
    lines.push(`الإجمالي: ${fmt(sumTotal.toString())}`);
    lines.push(`المسدَّد: ${fmt(sumPaid.toString())}`);
    lines.push(`المتبقي: ${fmt(sumTotal.minus(sumPaid).toString())}`);
    return lines.join("\n");
  }, [selectedRows]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="المبيعات"
        description="قائمة الفواتير — فرز بنقرة، بحث فوري، وتصدير. اضغط «عرض» لمتابعة فاتورة أو تسديد دفعة."
      />

      <Card>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-6">
          <div className="space-y-1">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">الحالة</Label>
            <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">— كل الحالات —</option>
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={columns}
        data={data}
        searchPlaceholder="بحث برقم الفاتورة أو اسم العميل…"
        loading={rows.isLoading}
        emptyText="لا فواتير مطابقة."
        selection={sel}
        getRowId={(r) => r.id}
        serverSearch={{ value: q, onChange: setQ }}
        serverPagination={{ page, onPageChange: setPage, pageSize: PAGE_SIZE, total }}
        toolbar={
          <Button variant="outline" size="sm" disabled={!total || exporting}
            onClick={() => void exportAll()}>
            {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
          </Button>
        }
      />

      {/* شَريط التَحديد المُتَعَدِّد — يَظهَر عِند تَحديد صَفّ واحِد فَأَكثَر. */}
      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={() => {
          if (!selectedRows.length) return;
          exportRows(selectedRows, {
            filename: "المبيعات-المُحَدَّدة",
            columns: [
              { key: "invoiceNumber", header: "رقم الفاتورة" },
              { key: "invoiceDate", header: "التاريخ", map: (r) => new Date(r.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn") },
              { key: "customerName", header: "العميل" },
              { key: "sourceType", header: "المصدر", map: (r) => SOURCE[r.sourceType] ?? r.sourceType },
              { key: "total", header: "الإجمالي", map: (r) => Number(r.total) },
              { key: "paidAmount", header: "المدفوع", map: (r) => Number(r.paidAmount) },
              { key: "status", header: "الحالة", map: (r) => STATUS[r.status] ?? r.status },
            ],
          });
        }}
      />
      {/* زِرّ «نَسخ المُحَدَّد كَـ» — يَظهَر بِجانب شَريط التَحديد بِنَفس الشَرط. */}
      {sel.count > 0 && (
        <div className="sticky bottom-16 z-20 mx-auto flex w-fit items-center justify-center">
          <CopyAsMenu
            label="نسخ المُحَدَّد"
            tsv={selectedTsv}
            whatsapp={selectedWhatsApp}
          />
        </div>
      )}

      {/* شريط المجاميع — لكل النتائج المطابقة للفلتر خادمياً (لا الصفحة المعروضة فقط). */}
      {summary.data && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6 text-sm">
            <span>
              عدد الفواتير:{" "}
              <b className="tabular-nums" dir="ltr">{summary.data.count.toLocaleString("ar-IQ-u-nu-latn")}</b>
            </span>
            <span>
              الإجمالي:{" "}
              <b className="tabular-nums" dir="ltr">{fmt(summary.data.totalAmount)}</b>
            </span>
            <span>
              المسدَّد:{" "}
              <b className="tabular-nums text-money-positive" dir="ltr">{fmt(summary.data.paidAmount)}</b>
            </span>
            <span>
              المتبقي:{" "}
              <b className="tabular-nums text-[var(--stock-low)]" dir="ltr">{fmt(summary.data.dueAmount)}</b>
            </span>
            <span className="text-xs text-muted-foreground">المجاميع لكل النتائج المطابقة للفلتر</span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
