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
import { ReturnComposer } from "@/components/returns/ReturnComposer";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { INVOICE_STATUSES, invoiceStatusLabel, type InvoiceStatus } from "@shared/invoiceStatus";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";

/** حالات فلتر الفاتورة — مرآة enum الخادم (`salesListInput.status`) عبر المصدر المشترك.
 *  `SUPERSEDED` كانت مفقودةً من القاموس المحلّي ⇒ يقبلها الخادم ولا سبيل لاختيارها من الشاشة،
 *  والفاتورة المُصحَّحة تُعرَض وتُصدَّر رمزاً إنجليزياً خاماً. */
const isInvoiceStatus = (v: string): v is InvoiceStatus =>
  (INVOICE_STATUSES as readonly string[]).includes(v);

/** حجم صفحة قائمة الفواتير — الترقيم خادميّ (نمط Invoices). */
const PAGE_SIZE = 50;

/** صفُّ قائمة الفواتير — مشتقٌّ من عقد `sales.listPage` فلا ينجرف عن الخادم. */
type InvoicePickRow = RouterOutputs["sales"]["listPage"]["rows"][number];

export default function Returns() {
  const utils = trpc.useUtils();

  const searchStr = useSearch();
  const urlInvoiceId = useMemo(() => {
    const p = new URLSearchParams(searchStr);
    const v = p.get("invoiceId");
    return v ? parseInt(v, 10) : null;
  }, [searchStr]);
  /**
   * ١٩/٨ — اعتمادُ طلبِ إرجاعٍ من موظّف: لوحةُ الطلبات المعلَّقة تُرسل `?requestId=` مع
   * الفاتورة، فيتحوّل المُنشئ من «مرتجعٍ مباشر» إلى «اعتمادِ طلب» — نفس الشاشة ونفس المسار
   * الماليّ، والفارق أنّ الاعتماد يفرض فصل المهام واللقطة التفاؤلية ويختم الطلب.
   */
  const approvingRequestId = useMemo(() => {
    const v = new URLSearchParams(searchStr).get("requestId");
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
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
  // إجمالي المطابق للفلتر (نفس buildSalesListConds خادمياً) — يغذّي شريط الترقيم بعدّاد «من N»
  // كنمط شاشة المبيعات؛ عند تأخّره يعمل الترقيم بوضع hasMore (keyset) بلا انتظار.
  const summaryQ = trpc.sales.listSummary.useQuery({
    q: qDebounced || undefined,
    status: (statusFilter || undefined) as StatusFilter,
  });

  // أعمدة منتقي الفاتورة — تقرأ الفاتورة المحدَّدة، فتُبنى في جسم المكوّن.
  const invoiceColumns: ColumnDef<InvoicePickRow, unknown>[] = [
    {
      id: "invoiceNumber",
      header: "رقم الفاتورة",
      accessorFn: (r) => r.invoiceNumber,
      meta: { kind: "code" },
      cell: ({ row }) => <CopyInline value={row.original.invoiceNumber} />,
    },
    {
      id: "total",
      header: "الإجمالي",
      accessorFn: (r) => fmt(r.total),
      meta: { kind: "money" },
      cell: ({ row }) => fmt(row.original.total),
    },
    {
      id: "status",
      header: "الحالة",
      // التسمية العربية من القاموس الموحّد لا الرمز الخامّ (`@shared/invoiceStatus`).
      accessorFn: (r) => invoiceStatusLabel(r.status),
      meta: { kind: "status" },
      cell: ({ row }) => invoiceStatusLabel(row.original.status),
    },
    {
      id: "actions",
      header: "إجراء",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const id = Number(row.original.id);
        const isPicked = selectedId === id;
        return (
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
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="مرتجعات البيع"
        description="خطوتان: اختر الفاتورة، ثم حدّد ما يرجع — المبلغ وطريقة الردّ والدرج تأتي جاهزةً من الفاتورة نفسها."
        backHref="/invoices"
        backLabel="رجوع للمبيعات"
      />

      <PendingReturnRequests />

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
            {/* البحث والفلتر في ListToolbar أعلاه (يغذّيان الاستعلام الخادميّ) ⇒ `searchable={false}`
                وإلّا ظهر حقلا بحثٍ متجاوران. و`externalFiltersActive` يشمل `page > 0` كي تبقى
                رسالةُ «لا فواتير بعد» محصورةً بالصفحة الأولى بلا فلتر — كما كان الجدول الخامّ.
                والترقيم يُصيّره DataTable عبر serverPagination (لا TablePager منفصل). */}
            <DataTable<InvoicePickRow>
              columns={invoiceColumns}
              data={invoiceRows}
              searchable={false}
              externalFiltersActive={!!qDebounced || !!statusFilter || page > 0}
              loading={invoicesQuery.isLoading}
              errorState={{ isError: invoicesQuery.isError, message: invoicesQuery.error?.message, onRetry: () => void invoicesQuery.refetch() }}
              getRowClassName={(inv) => (selectedId === Number(inv.id) ? "bg-muted/40" : undefined)}
              serverPagination={{
                page,
                onPageChange: setPage,
                pageSize: PAGE_SIZE,
                total: summaryQ.data?.count,
                hasMore: invoicesQuery.data?.hasMore,
                isFetching: invoicesQuery.isFetching,
              }}
              emptyState="لا فواتير بعد."
              emptyFilteredState="لا فواتير مطابقة. غيّر البحث أو الفلتر."
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
              approvingRequestId={approvingRequestId}
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

/**
 * **طلبات الإرجاع المعلَّقة** (١٩/٨) — الطرف الثاني من «طلب موظف + اعتماد مدير».
 *
 * بلا هذه اللوحة يبقى الطلب في القاعدة بلا من يراه: الموظّف أرسل والمدير لا يعلم. تظهر
 * أعلى الشاشة كي تكون أوّل ما يراه المدير حين يفتح المرتجعات — فالطلب المعلَّق **عملٌ
 * متوقّف** وزبونٌ ينتظر، لا صفٌّ في أرشيف.
 */
function PendingReturnRequests() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const requests = trpc.returns.requests.useQuery(
    { status: "PENDING_APPROVAL" },
    { refetchInterval: 30_000, retry: false },
  );
  const reject = trpc.returns.rejectRequest.useMutation({
    onSuccess: () => {
      notify.ok("رُفض الطلب", "يرى الموظّف السبب في شاشته.");
      utils.returns.requests.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  /**
   * ⭐ الطابور المحكوم أيضاً (تدقيق ١/٩/٢٦ — بلاغ «المرتجع وهميّ ولا أثر له»).
   *
   * كانت هذه اللوحة تقرأ **الجدول القديم وحده** (`returnRequests`)، بينما ما تُنشئه هذه
   * الشاشة نفسها عبر `returns.create` يهبط في `salesControlRequests`. فالموظّف يُرسل من هنا
   * ثمّ لا يجد طلبه هنا — وهو بالضبط ما يُقرأ «النظام بلع المرتجع». والتعليق أعلاه كان يصف
   * العطب على الطابور القديم ثمّ وقع نفسُه على الجديد.
   */
  const governed = trpc.salesControl.list.useQuery(
    { status: "PENDING" },
    { refetchInterval: 30_000, retry: false },
  );
  const governedReturns = (governed.data ?? []).filter((r) => r.requestType === "SALES_RETURN");

  const rows = requests.data ?? [];
  // ⛔ لا إخفاء صامت عند فشل الاستعلام: بطاقةٌ تختفي على خطأٍ تُقرأ «لا طلبات» وهي كذبة.
  if (requests.isError && governed.isError) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="flex flex-wrap items-center gap-2 p-3 text-sm text-destructive">
          <AlertTriangle aria-hidden className="size-4" />
          تعذّر تحميل طلبات الإرجاع المعلّقة — قد تكون هناك طلبات لا تراها.
          <Button size="sm" variant="outline" onClick={() => { void requests.refetch(); void governed.refetch(); }}>
            إعادة المحاولة
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (rows.length === 0 && governedReturns.length === 0) return null;

  return (
    <Card className="border-[var(--sem-warn)]/45 bg-[var(--sem-warn-bg)]/30">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 text-sm font-black text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="size-4" />
          طلبات إرجاع معلّقة لم تُنفَّذ بعد ({rows.length + governedReturns.length})
        </div>
        <p className="text-[11px] font-normal text-muted-foreground">
          الطلب المعلّق صفريّ الأثر: لم يتغيّر المخزون ولا المال. يعتمده مراجعٌ مستقلّ (غير الطالب وغير منشئ الفاتورة).
        </p>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {governedReturns.map((r) => (
          <div key={`gov-${r.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-black tabular-nums" dir="ltr">{r.invoiceNumber ?? `#${r.invoiceId}`}</span>
                <span className="text-muted-foreground">طلبه {r.requestedByName ?? `مستخدم ${r.requestedBy}`}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">طلب تحكّم #{r.id}</span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">السبب: {r.reason}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate("/invoices?tab=controls")}>
              افتح شاشة الاعتماد
            </Button>
          </div>
        ))}
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-black tabular-nums" dir="ltr">{r.invoiceNumber ?? `#${r.invoiceId}`}</span>
                <span className="text-muted-foreground">طلبه {r.createdByName ?? `مستخدم ${r.createdBy}`}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                  {((r.linesJson as { baseQuantity: number }[]) ?? []).length} بند
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">السبب: {r.reason}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                onClick={() => navigate(`/returns?invoiceId=${r.invoiceId}&requestId=${r.id}`)}
                title="راجع البنود ثم نفّذ المرتجع بالرافد والدرج الصحيحين"
              >
                مراجعة واعتماد
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={reject.isPending}
                onClick={() => {
                  const reason = window.prompt("سبب رفض الطلب (يراه الموظّف):")?.trim();
                  if (!reason || reason.length < 3) return;
                  reject.mutate({ requestId: Number(r.id), reason });
                }}
              >
                رفض
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
