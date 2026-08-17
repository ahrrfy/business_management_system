/**
 * Returns — مرتجعات البيع: **اختيار الفاتورة** ثمّ المكوّن المرجعيّ الموحَّد.
 *
 * كل منطق المرتجع (الكميات، الرافدان، السقوف، الدرج، المرجع، التأكيد) يعيش في
 * `@/components/returns/ReturnComposer` — نفسه المستعمَل في `/sales-returns/new`. هذه الصفحة
 * لا تحسب سقفاً ولا تعرض رافداً من عندها: كان ذلك سبب «يملأ الموظف كل شيء ثمّ يُرفض الطلب»
 * (بلاغ المالك ١٧/٨/٢٦). مسؤوليّتها هنا: إيجاد الفاتورة الصحيحة، لا غير.
 */
import { CopyInline } from "@/components/CopyButton";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { INVOICE_STATUSES, invoiceStatusLabel, type InvoiceStatus } from "@shared/invoiceStatus";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";

/** حالات فلتر الفاتورة — مرآة enum الخادم (`salesListInput.status`) عبر المصدر المشترك.
 *  `SUPERSEDED` كانت مفقودةً من القاموس المحلّي ⇒ يقبلها الخادم ولا سبيل لاختيارها من الشاشة،
 *  والفاتورة المُصحَّحة تُعرَض وتُصدَّر رمزاً إنجليزياً خاماً. */
const isInvoiceStatus = (v: string): v is InvoiceStatus =>
  (INVOICE_STATUSES as readonly string[]).includes(v);

/** حجم صفحة قائمة الفواتير — الترقيم خادميّ (نمط Invoices). */
const PAGE_SIZE = 50;

export default function Returns() {
  const utils = trpc.useUtils();

  const searchStr = useSearch();
  const urlInvoiceId = useMemo(() => {
    const p = new URLSearchParams(searchStr);
    const v = p.get("invoiceId");
    return v ? parseInt(v, 10) : null;
  }, [searchStr]);

  const [selectedId, setSelectedId] = useState<number | null>(urlInvoiceId);
  // الـURL مصدر الحقيقة: مزامنة الفاتورة المختارة عند الوصول بـ?invoiceId= (رابط مستقلّ من تفاصيل الفاتورة).
  useEffect(() => {
    if (urlInvoiceId != null && urlInvoiceId !== selectedId) setSelectedId(urlInvoiceId);
  }, [urlInvoiceId]); // eslint-disable-line

  // فلاتر في querystring — تعيش مع فتح تفاصيل الفاتورة والرجوع، ويمكن مشاركتها رابطاً.
  const [filters, setFilters, resetFilters] = useUrlFilters({ q: "", status: "" });
  const q = filters.q;
  // تصحيح قيمة URL (Codex P2): status enum معروف مسبقاً؛ قيمة غريبة (مشاركة/تعديل يدوي) تفشل
  // sales.listPage.useQuery صامتاً بخطأ Zod ⇒ رجوع للافتراضي (كل الحالات) بدل قائمةٍ فارغةٍ مضلِّلة.
  const statusFilter = isInvoiceStatus(filters.status) ? filters.status : "";
  const setQ = (v: string) => setFilters({ q: v });
  const setStatusFilter = (v: string) => setFilters({ status: v });

  // البحث والفلترة خادميان (sales.listPage): كان البحث محلياً في آخر ٥٠ فاتورة فقط ⇒ فاتورة
  // أقدم تُعطي «لا نتائج» وهي موجودة. q يشمل رقم الفاتورة واسم العميل (نفس بحث شاشة المبيعات).
  const [page, setPage] = useState(0);
  const qDebounced = useDebouncedValue(q.trim(), 300);
  // أي تغيير في البحث/الفلتر يعيد للصفحة الأولى (وإلا بقي offset قديماً على مجموعة أصغر).
  useEffect(() => { setPage(0); }, [qDebounced, statusFilter]);

  type StatusFilter = InvoiceStatus | undefined;
  const invoicesQuery = trpc.sales.listPage.useQuery({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    q: qDebounced || undefined,
    status: (statusFilter || undefined) as StatusFilter,
  });
  const invoiceRows = invoicesQuery.data?.rows ?? [];
  // إجمالي المطابق للفلتر (نفس buildSalesListConds خادمياً) — يغذّي TablePager بعدّاد «من N»
  // كنمط شاشة المبيعات؛ عند تأخّره يعمل الترقيم بوضع hasMore (keyset) بلا انتظار.
  const summaryQ = trpc.sales.listSummary.useQuery({
    q: qDebounced || undefined,
    status: (statusFilter || undefined) as StatusFilter,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="مرتجعات البيع"
        description="خطوتان: اختر الفاتورة، ثم حدّد ما يرجع — المبلغ وطريقة الردّ والدرج تأتي جاهزةً من الفاتورة نفسها."
        actions={<Link href="/invoices" className="text-sm text-muted-foreground">← رجوع للمبيعات</Link>}
      />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <ListToolbar
              title="اختيار الفاتورة"
              // العدّاد = إجمالي المطابق خادمياً (لا صفوف الصفحة المعروضة وحدها) متى ما توفّر.
              count={summaryQ.data?.count ?? invoiceRows.length}
              loading={invoicesQuery.isLoading}
              search={{
                value: q,
                onChange: setQ,
                placeholder: "بحث (رقم الفاتورة/اسم العميل)",
                barcode: true,
              }}
              activeFilterCount={statusFilter ? 1 : 0}
              onResetFilters={resetFilters}
              filters={
                // FilterField يُظهر التسمية بصرياً — aria-label وحده لا يُرى (نمط PR #559/#566).
                // قيمة «ALL» الحارسة: Radix يرفض بند القيمة الفارغة فلا يمكن الرجوع لـ«كل الحالات» بدونها.
                <FilterField label="حالة الفاتورة">
                  <AppSelect
                    size="sm"
                    className="w-44"
                    aria-label="فلتر حالة الفاتورة"
                    value={statusFilter || "ALL"}
                    onValueChange={(v) => setStatusFilter(v === "ALL" ? "" : v)}
                  >
                    <option value="ALL">كل الحالات</option>
                    {INVOICE_STATUSES.map((v) => (
                      <option key={v} value={v}>{invoiceStatusLabel(v)}</option>
                    ))}
                  </AppSelect>
                </FilterField>
              }
              exportSpec={{
                filename: "فواتير-للمرتجعات",
                rows: invoiceRows,
                columns: [
                  { key: "invoiceNumber", header: "رقم الفاتورة" },
                  { key: "customerName", header: "العميل", map: (r) => r.customerName ?? "عميل نقدي" },
                  { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                  { key: "status", header: "الحالة", map: (r) => invoiceStatusLabel(r.status) },
                ],
              }}
            />
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">رقم الفاتورة</th>
                    <th className="p-2 text-right">الإجمالي</th>
                    <th className="p-2 text-start">الحالة</th>
                    <th className="p-2 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceRows.map((inv) => {
                    const id = Number(inv.id);
                    const isPicked = selectedId === id;
                    return (
                      <tr key={inv.id} className={`border-t ${isPicked ? "bg-muted/40" : ""}`}>
                        <td className="p-2"><CopyInline value={inv.invoiceNumber} /></td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(inv.total)}</td>
                        <td className="p-2">{invoiceStatusLabel(inv.status)}</td>
                        <td className="p-2 text-center">
                          <RowActions
                            mode="inline"
                            actions={[
                              {
                                key: "pick",
                                kind: "reverse",
                                label: isPicked ? "محدّدة" : "اختيار",
                                disabled: isPicked, // منع مسح الكميات المُدخَلة بنقرة سهو
                                disabledReason: "الفاتورة محددة بالفعل",
                                onSelect: () => setSelectedId(id),
                                gate: { roles: ["manager"], module: "sales", level: "FULL" },
                              },
                              {
                                key: "view",
                                kind: "view",
                                label: "عرض الفاتورة",
                                href: `/invoices/${id}`,
                                gate: { module: "sales", level: "READ" },
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {!invoicesQuery.isLoading && invoiceRows.length === 0 && (
                    <TableEmptyRow
                      colSpan={4}
                      // صفر نتائج بلا أي بحث/فلتر وعلى الصفحة الأولى = لا فواتير في النظام أصلاً؛
                      // غير ذلك فالمجموعة مفلترة خادمياً والرسالة تُوجّه لتغيير الفلتر.
                      message={!qDebounced && !statusFilter && page === 0 ? "لا فواتير بعد." : "لا فواتير مطابقة. غيّر البحث أو الفلتر."}
                    />
                  )}
                  {invoicesQuery.isLoading && (
                    <tr><td colSpan={4} className="p-0"><LoadingState /></td></tr>
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
            <TablePager
              page={page}
              onPageChange={setPage}
              pageSize={PAGE_SIZE}
              rowsOnPage={invoiceRows.length}
              total={summaryQ.data?.count}
              hasMore={invoicesQuery.data?.hasMore}
              isLoading={invoicesQuery.isLoading || invoicesQuery.isFetching}
            />
          </CardContent>
        </Card>

        <div>
          {selectedId == null ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              اختر فاتورة من القائمة لعرض بنودها وتسجيل المرتجع.
            </div>
          ) : (
            <ReturnComposer
              invoiceId={selectedId}
              onDone={() => {
                void utils.sales.listPage.invalidate();
                void utils.sales.listSummary.invalidate();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
