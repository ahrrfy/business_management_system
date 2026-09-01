import { EntityPicker } from "@/components/invoice/EntityPicker";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { DataTable } from "@/components/data-table/DataTable";
import { ActorCell } from "@/components/data-table/ActorCell";
import type { ColumnDef } from "@tanstack/react-table";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDate } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { useMemo } from "react";
import { Link } from "wouter";

// حسم النوع صراحةً: returns.list يُعيد {rows,total} ⇒ صفّ الجدول/التصدير = عنصر rows.
type Row = RouterOutputs["returns"]["list"]["rows"][number];

/* ═══════════ سجلّ مرتجعات البيع ═══════════
   يستهلك returns.list (managerProcedure): قيود RETURN ذات فاتورة بلا مورد.
   فلاتر عميل/فرع/فترة + ترقيم خادمي (limit/offset) + تصدير Excel + زر إنشاء.
═══════════════════════════════════════════ */

const PAGE = 50;

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesReturns() {
  // فلاتر في querystring — تعيش مع فتح تفاصيل الفاتورة والرجوع، ويمكن مشاركتها رابطاً.
  // كل القيم نصوص؛ ""=افتراضي يُحذف من الـURL. Numeric filters تُحوَّل عند الاستخدام.
  const [filters, setFilters, resetFilters] = useUrlFilters({
    customerId: "", branchId: "", createdBy: "", dateFrom: "", dateTo: "", q: "", page: "0",
  });
  // تصحيح قيم URL (Codex P2): querystring يمكن أن يحمل قيماً باطلة (مشاركة/تعديل يدوي) ⇒
  // returns.list.useQuery يفشل بـZod (positive int expected) على قيمة غير رقمية.
  // fall-back للـ"" (كل العملاء/الفروع) بدل قيمة تُفشِل الاستعلام كاملاً.
  const toPosInt = (s: string): number | "" => {
    if (s === "") return "";
    const n = Number(s);
    return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : "";
  };
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const toYmd = (s: string) => (YMD.test(s) ? s : "");
  const customerId = toPosInt(filters.customerId);
  const branchId = toPosInt(filters.branchId);
  const createdBy = toPosInt(filters.createdBy);
  const dateFrom = toYmd(filters.dateFrom);
  const dateTo = toYmd(filters.dateTo);
  const q = filters.q;
  // بحث خادمي برقم الفاتورة (ممهَّل — لا طلب لكل حرف).
  const dq = useDebouncedValue(q, 250);
  const pageNum = Number(filters.page);
  const page = Number.isFinite(pageNum) && pageNum >= 0 ? Math.floor(pageNum) : 0;
  const setCustomerId = (v: number | "") => setFilters({ customerId: v === "" ? "" : String(v), page: "0" });
  const setBranchId = (v: number | "") => setFilters({ branchId: v === "" ? "" : String(v), page: "0" });
  const setCreatedBy = (v: number | "") => setFilters({ createdBy: v === "" ? "" : String(v), page: "0" });
  const setDateFrom = (v: string) => setFilters({ dateFrom: v, page: "0" });
  const setDateTo = (v: string) => setFilters({ dateTo: v, page: "0" });
  const setQ = (v: string) => setFilters({ q: v, page: "0" });
  const setPage = (updater: number | ((p: number) => number)) =>
    setFilters({ page: String(typeof updater === "function" ? updater(page) : updater) });

  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  // منفّذو المرتجعات ضمن الفرع المُختار حالياً — يغذّي فلتر «منفّذ المرتجع» (لا دليل مستخدمين كامل).
  const performers = trpc.returns.performers.useQuery({ branchId: branchId ? Number(branchId) : undefined });
  // مدخلات الفلترة بلا limit/offset — مشتركة بين الاستعلام الصفحي وتصدير الكل.
  const filterInput = {
    customerId: customerId ? Number(customerId) : undefined,
    branchId: branchId ? Number(branchId) : undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    q: dq.trim() || undefined,
    createdBy: createdBy ? Number(createdBy) : undefined,
  };
  const list = trpc.returns.list.useQuery({
    ...filterInput,
    limit: PAGE,
    offset: page * PAGE,
  });

  const branchName = useMemo(() => {
    const m = new Map((branches.data ?? []).map((b) => [Number(b.id), b.name]));
    return (id: number | null | undefined) => (id != null ? m.get(Number(id)) ?? `#${id}` : "—");
  }, [branches.data]);

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  // amount مخزَّن سالباً (اتفاقية RETURN) ⇒ القيمة المُرتجَعة = القيمة المطلقة، عبر decimal.js (لا parseFloat).
  const returned = (amount: string) => D(amount).neg().toFixed(2);
  // notes قد يكون مفتاح idempotency تقنيّاً (saleReturn:... / sale.return:...) لا ملاحظة مستخدم ⇒ يُخفى.
  const noteText = (n: string | null | undefined) =>
    n && !n.startsWith("saleReturn:") && !n.startsWith("sale.return:") ? n : "—";

  // اتساق مع بقية ListToolbar: عدّ الفلاتر النشطة (باستثناء q — يظهر في مربع البحث).
  // resetFilters و setPage=0 يتكفّل بهما useUrlFilters + setters الجديدة أعلاه.
  const activeFilterCount = [filters.customerId, filters.branchId, filters.createdBy, filters.dateFrom, filters.dateTo].filter(Boolean).length;

  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);
  /**
   * أعمدة مرتجعات البيع — منقولة حرفياً من صفوف JSX. «منفّذ المرتجع» صار يقرأ تسميته
   * من عقد الإسناد ({ATTRIBUTION_LABELS.performedBy}) فلا تنفرد الشاشة بصياغتها.
   */
  const returnColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    { id: "id", header: "رقم القيد", accessorFn: (r) => r.id, meta: { kind: "number", width: "id" } },
    {
      id: "entryDate", header: "التاريخ",
      // entryDate حقل تاريخ بلا وقت ⇒ نعرض التاريخ فقط (لا timeStyle مُختلَق).
      accessorFn: (r) => (r.entryDate ? String(r.entryDate) : ""),
      cell: ({ row }) => fmtDate(row.original.entryDate),
      meta: { kind: "date" },
    },
    { id: "invoiceNumber", header: "رقم الفاتورة", accessorFn: (r) => r.invoiceNumber ?? "—", meta: { kind: "code" } },
    // customerName فارغ = بيع نقدي بلا عميل مسجَّل.
    { id: "customerName", header: "العميل", accessorFn: (r) => r.customerName ?? "—", meta: { kind: "text", wrap: true } },
    { id: "branch", header: "الفرع", accessorFn: (r) => branchName(r.branchId), meta: { kind: "text" } },
    {
      id: "performedBy", header: ATTRIBUTION_LABELS.performedBy,
      accessorFn: (r) => r.performedByName ?? "غير موثّق",
      cell: ({ row }) => <ActorCell actor={{ name: row.original.performedByName }} />,
      meta: { kind: "actor" },
    },
    {
      id: "amount", header: "القيمة المرتجعة",
      accessorFn: (r) => Number(returned(r.amount)),
      cell: ({ row }) => fmt(returned(row.original.amount)),
      meta: { kind: "money" },
    },
    {
      id: "notes", header: "ملاحظات",
      accessorFn: (r) => noteText(r.notes),
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{noteText(row.original.notes)}</span>,
      meta: { kind: "text", wrap: true },
    },
    {
      id: "actions", header: "إجراء",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <RowActions
            mode="auto"
            contact={r.customerName ? {
              phone: r.customerPhone,
              label: `واتساب ${r.customerName}`,
              message: buildOperationalContactMessage({
                entityLabel: "مرتجع بيع",
                reference: String(r.id),
                partyName: r.customerName,
                title: `قيمة المرتجع: ${fmt(returned(r.amount))} د.ع`,
                dueAt: r.entryDate,
                nextAction: "نؤكد لكم تسجيل المرتجع وتسوية الفاتورة المرتبطة.",
              }),
              gate: { module: "sales", level: "READ" },
            } : undefined}
            actions={[
              {
                key: "invoice", kind: "view", label: "عرض الفاتورة الأصلية",
                href: `/invoices/${r.invoiceId}`, hidden: !r.invoiceId,
                gate: { module: "sales", level: "READ" },
              },
            ]}
          />
        );
      },
      meta: { kind: "actions" },
    },
  ], [branchName]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ مرتجعات البيع"
        description="البضاعة المُرتجَعة من العملاء (قيود إرجاع مرتبطة بفواتير البيع). لإنشاء مرتجع جديد استعمل زرّ «مرتجع بيع جديد»."
        actions={
          <Link href="/purchase-returns">
            <Button variant="outline" size="sm">مرتجعات الشراء ←</Button>
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="المرتجعات"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث برقم الفاتورة",
              barcode: true,
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetFilters}
            filters={
              <>
                {/* FilterField يُظهر التسمية دائماً — placeholder/title وحدهما يختفيان عند الاختيار
                    فيضيع معنى الحقل (نمط PR #559). */}
                <FilterField label="العميل" className="min-w-[200px]">
                  {/* بحث خادميّ بدل قائمة مقصوصة عند ٥٠٠ (العميل ٥٠١ كان غير قابل للاختيار). */}
                  <EntityPicker
                    type="SALE_RETURN"
                    selectedId={customerId === "" ? null : Number(customerId)}
                    onSelect={(id) => setCustomerId(id ?? "")}
                    placeholder="— كل العملاء —"
                    clearLabel="عرض كل العملاء"
                  />
                </FilterField>
                <FilterField label="الفرع">
                  <AppSelect
                    className="h-9"
                    value={String(branchId)}
                    onValueChange={(value) => setBranchId(value ? Number(value) : "")}
                  >
                    <option value="">— كل الفروع —</option>
                    {(branches.data ?? []).map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="منفّذ المرتجع">
                  <AppSelect
                    size="sm"
                    className="h-8 w-44"
                    value={createdBy === "" ? "ALL" : String(createdBy)}
                    onValueChange={(v) => setCreatedBy(v === "ALL" ? "" : Number(v))}
                  >
                    <option value="ALL">— كل المنفّذين —</option>
                    {(performers.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="من تاريخ">
                  <Input type="date" dir="ltr" className="h-8 w-36" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input type="date" dir="ltr" className="h-8 w-36" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                </FilterField>
              </>
            }
            exportSpec={{
              filename: "مرتجعات-البيع",
              rows,
              // تصدير كل النتائج المطابقة للفلاتر الحالية (لا الصفحة وحدها) — ترقيم خادمي offset حتى تنضب.
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, limit) =>
                    utils.returns.list
                      .fetch({ ...filterInput, limit, offset })
                      .then((r) => ({ rows: (r.rows ?? []) as Row[], total: r.total })),
                  { pageSize: 200 }
                ),
              columns: [
                { key: "entryDate", header: "التاريخ" },
                { key: "invoiceNumber", header: "رقم الفاتورة", map: (r) => r.invoiceNumber ?? "" },
                { key: "customer", header: "العميل", map: (r) => r.customerName ?? "—" },
                { key: "branch", header: "الفرع", map: (r) => branchName(r.branchId) },
                { key: "performedByName", header: "منفّذ المرتجع", map: (r) => r.performedByName ?? "غير موثّق" },
                { key: "returned", header: "القيمة المرتجعة", map: (r) => Number(returned(r.amount)) },
              ],
            }}
            add={{ href: "/sales-returns/new", label: "مرتجع بيع جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={returnColumns}
            data={rows}
            loading={list.isLoading}
            searchable={false}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            emptyText={total === 0 && !customerId && !branchId && !createdBy && !dateFrom && !dateTo && !q.trim()
              ? "لا مرتجعات بيع بعد."
              : "لا مرتجعات مطابقة. غيّر الفلتر."}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground" dir="ltr">
          {total === 0 ? "لا صفوف" : `${from}–${to} / ${total.toLocaleString("ar-IQ-u-nu-latn")}`}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            السابق
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            التالي
          </Button>
        </div>
      </div>
    </div>
  );
}
