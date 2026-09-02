import { balanceOptionText } from "@/components/BalanceBadge";
import { DataTable } from "@/components/data-table/DataTable";
import { ActorCell } from "@/components/data-table/ActorCell";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDate } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc } from "@/lib/trpc";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

/* ═══════════ سجلّ مرتجعات المشتريات ═══════════
   يستهلك purchaseReturns.list (managerProcedure): قيود RETURN ذات مورد.
   فلاتر مورد/فرع + ترقيم خادمي (limit/offset) + تصدير Excel + زر إنشاء.
═══════════════════════════════════════════════ */

const PAGE = 50;

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function PurchaseReturns() {
  const utils = trpc.useUtils();
  // فلاتر خادمية محفوظة في querystring (نمط Invoices.tsx/Purchases.tsx) — تعيش مع فتح
  // التفاصيل والرجوع، وتُشارَك رابطاً. أسماء from/to لفترة entryDate.
  const [f, setF, resetF] = useUrlFilters({ supplierId: "", branchId: "", from: "", to: "", q: "" });
  const [page, setPage] = useState(0);

  // البحث خادمي الآن (q ممهَّل): مورد/ملاحظة/رقم قيد/أمر شراء عبر كل النتائج لا الصفحة فقط.
  const dq = useDebouncedValue(f.q, 250);
  const listInput = useMemo(
    () => ({
      supplierId: f.supplierId ? Number(f.supplierId) : undefined,
      branchId: f.branchId ? Number(f.branchId) : undefined,
      from: f.from || undefined,
      to: f.to || undefined,
      q: dq.trim() || undefined,
    }),
    [f.supplierId, f.branchId, f.from, f.to, dq],
  );
  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [f.supplierId, f.branchId, f.from || f.to].filter(Boolean).length;

  const suppliers = trpc.suppliers.list.useQuery();
  const supplierContacts = useMemo(
    () => new Map((suppliers.data ?? []).map((s) => [Number(s.id), s])),
    [suppliers.data],
  );
  const branches = trpc.branches.list.useQuery();
  const list = trpc.purchaseReturns.list.useQuery({ ...listInput, limit: PAGE, offset: page * PAGE });

  const supplierName = useMemo(() => {
    const m = new Map((suppliers.data ?? []).map((s) => [Number(s.id), s.name]));
    return (id: number | null | undefined) => (id != null ? m.get(Number(id)) ?? `#${id}` : "—");
  }, [suppliers.data]);
  const branchName = useMemo(() => {
    const m = new Map((branches.data ?? []).map((b) => [Number(b.id), b.name]));
    return (id: number | null | undefined) => (id != null ? m.get(Number(id)) ?? `#${id}` : "—");
  }, [branches.data]);

  const rows = list.data?.rows ?? [];
  type Row = (typeof rows)[number];
  const total = list.data?.total ?? 0;

  // amount مخزَّن سالباً (اتفاقية RETURN) ⇒ القيمة المُرتجَعة = القيمة المطلقة، عبر decimal.js (لا parseFloat).
  const returned = (amount: string) => D(amount).abs().toFixed(2);
  // notes قد يكون مفتاح idempotency تقنيّاً (purchaseReturn:...) لا ملاحظة مستخدم ⇒ يُخفى.
  const noteText = (n: string | null | undefined) =>
    n && !n.startsWith("purchaseReturn:") ? n : "—";

  // البحث خادمي ⇒ الصفوف المعروضة هي نتائج الخادم مباشرةً (لا تصفية محلّية تُخفي صفحات أخرى).
  const visibleRows = rows;

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى (وإلا بقي offset قديماً على مجموعة أصغر).
  useEffect(() => { setPage(0); }, [listInput]);

  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  // طباعة مستند المرتجع مباشرة من السجل: لا جدول بنود مخزّن لكل مرتجع (المرتجع يُسجَّل قيداً
  // إجمالياً واحداً في الدفتر — لا جدول تفصيلي لكل سطر)؛ نطبع مستنداً موجزاً موثِّقاً بالمبلغ
  // الكلّي والمرجعية عبر قالب التقارير العام (نمط سند — لا فاتورة بنود مفصّلة).
  function printReturn(r: (typeof visibleRows)[number]) {
    const ok = printReportDoc({
      title: "مستند مرتجع شراء",
      docNum: r.returnNumber ?? `#${r.id}`,
      docDate: fmtDate(r.entryDate),
      headerExtra: [
        { label: "المورد", value: supplierName(r.supplierId) },
        { label: "الفرع", value: branchName(r.branchId) },
      ],
      meta: [
        {
          title: "تفاصيل المرتجع",
          fields: [
            { label: "أمر الشراء المرجعي", value: r.purchaseOrderId ? `#${r.purchaseOrderId}` : "بلا مرجع" },
            { label: "المنفّذ", value: r.createdByName ?? (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق") },
            { label: "الملاحظات", value: noteText(r.notes) },
          ],
        },
      ],
      columns: [
        { key: "desc", label: "البيان" },
        { key: "amount", label: "القيمة (د.ع)", align: "left" },
      ],
      rows: [{ desc: "قيمة البضاعة المُرتجَعة للمورد", amount: `${fmt(returned(r.amount))} د.ع` }],
      summary: [{ label: "إجمالي المرتجع", value: `${fmt(returned(r.amount))} د.ع`, large: true, bold: true }],
      showIndex: false,
    });
    if (!ok) notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
  }
  /** أعمدة مرتجعات الشراء — منقولة حرفياً؛ «المنفّذ» يقرأ تسميته من عقد الإسناد. */
  const returnColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      id: "returnNumber", header: "رقم المرتجع",
      accessorFn: (r) => r.returnNumber ?? `#${r.id}`,
      cell: ({ row }) => row.original.purchaseReturnId
        ? <Link className="font-semibold text-primary hover:underline" href={`/purchase-returns/${row.original.purchaseReturnId}`}>{row.original.returnNumber}</Link>
        : `#${row.original.id}`,
      meta: { kind: "code" },
    },
    {
      id: "entryDate", header: "التاريخ",
      // entryDate حقل تاريخ بلا وقت ⇒ نعرض التاريخ فقط (لا timeStyle مُختلَق).
      accessorFn: (r) => (r.entryDate ? String(r.entryDate) : ""),
      cell: ({ row }) => fmtDate(row.original.entryDate),
      meta: { kind: "date" },
    },
    { id: "supplier", header: "المورد", accessorFn: (r) => supplierName(r.supplierId), meta: { kind: "text", wrap: true } },
    { id: "branch", header: "الفرع", accessorFn: (r) => branchName(r.branchId), meta: { kind: "text" } },
    {
      id: "po", header: "أمر الشراء",
      accessorFn: (r) => (r.purchaseOrderId ? `#${r.purchaseOrderId}` : "—"),
      meta: { kind: "code", align: "center" },
    },
    {
      id: "amount", header: "القيمة المرتجعة",
      accessorFn: (r) => Number(returned(r.amount)),
      cell: ({ row }) => fmt(returned(row.original.amount)),
      meta: { kind: "money" },
    },
    {
      id: "performedBy", header: ATTRIBUTION_LABELS.performedBy,
      accessorFn: (r) => r.createdByName ?? (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق"),
      cell: ({ row }) => <ActorCell actor={{ name: row.original.createdByName, userId: row.original.createdBy }} />,
      meta: { kind: "actor" },
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
            contact={{
              whatsapp: supplierContacts.get(Number(r.supplierId))?.whatsapp,
              phone: supplierContacts.get(Number(r.supplierId))?.phone,
              label: `واتساب ${supplierName(r.supplierId)}`,
              message: buildOperationalContactMessage({
                entityLabel: "مرتجع شراء",
                reference: String(r.id),
                partyName: supplierName(r.supplierId),
                title: `قيمة المرتجع: ${fmt(returned(r.amount))} د.ع`,
                dueAt: r.entryDate,
                nextAction: "يرجى تأكيد استلام المرتجع وتسوية الحساب.",
              }),
              gate: { module: "purchases", level: "READ" },
            }}
            actions={[
              {
                key: "print", kind: "print", label: "طباعة مستند المرتجع",
                onSelect: () => printReturn(r),
                gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" },
              },
              {
                key: "po", kind: "view",
                href: r.purchaseReturnId ? `/purchase-returns/${r.purchaseReturnId}` : `/purchases/${r.purchaseOrderId}`,
                label: r.purchaseReturnId ? "فتح مستند المرتجع" : "فتح أمر الشراء",
                hidden: r.purchaseOrderId == null,
                gate: { module: "purchases", level: "READ" },
              },
              {
                key: "stmt", kind: "view", label: "كشف حساب المورد",
                href: `/suppliers-statement?id=${r.supplierId}`,
                hidden: r.supplierId == null,
                gate: { module: "suppliers", level: "READ" },
              },
            ]}
          />
        );
      },
      meta: { kind: "actions" },
    },
  ], [supplierName, branchName, supplierContacts]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ مرتجعات المشتريات"
        description="البضاعة المُرتجَعة للموردين (قيود إرجاع ذات مورد). لإنشاء مرتجع جديد استعمل زرّ «مرتجع شراء جديد»."
        actions={
          <Link href="/returns">
            <Button variant="outline" size="sm">مرتجعات البيع ←</Button>
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <ListToolbar
            title="المرتجعات"
            count={total}
            loading={list.isLoading}
            search={{ value: f.q, onChange: (v) => setF({ q: v }), placeholder: "بحث (مورد/رقم قيد/أمر شراء/ملاحظة)…" }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            filters={
              <>
                <AppSelect
                  className="h-9"
                  value={f.supplierId}
                  onValueChange={(value) => setF({ supplierId: value })}
                >
                  <option value="">— كل الموردين —</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {balanceOptionText((s as { currentBalance?: string | null }).currentBalance, "supplier")}
                    </option>
                  ))}
                </AppSelect>
                <AppSelect
                  className="h-9"
                  value={f.branchId}
                  onValueChange={(value) => setF({ branchId: value })}
                >
                  <option value="">— كل الفروع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </AppSelect>
                <Input type="date" dir="ltr" className="h-8 w-36" value={f.from} onChange={(e) => setF({ from: e.target.value })} title="من تاريخ" />
                <Input type="date" dir="ltr" className="h-8 w-36" value={f.to} onChange={(e) => setF({ to: e.target.value })} title="إلى تاريخ" />
              </>
            }
            exportSpec={{
              filename: "مرتجعات-المشتريات",
              rows: visibleRows,
              fetchAll: () =>
                fetchAllPaged(
                  (offset, limit) =>
                    utils.purchaseReturns.list.fetch({ ...listInput, limit, offset }).then((r) => ({ rows: r.rows, total: r.total })),
                  { pageSize: 200 },
                ),
              columns: [
                { key: "id", header: "رقم القيد" },
                { key: "returnNumber", header: "رقم المرتجع", map: (r) => r.returnNumber ?? `#${r.id}` },
                { key: "entryDate", header: "التاريخ" },
                { key: "supplier", header: "المورد", map: (r) => supplierName(r.supplierId) },
                { key: "branch", header: "الفرع", map: (r) => branchName(r.branchId) },
                { key: "purchaseOrderId", header: "أمر الشراء", map: (r) => r.purchaseOrderId ?? "" },
                { key: "returned", header: "القيمة المرتجعة", map: (r) => Number(returned(r.amount)) },
                { key: "createdByName", header: "المنفذ", map: (r) => r.createdByName ?? (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق") },
                { key: "notes", header: "ملاحظات", map: (r) => noteText(r.notes) },
              ],
            }}
            add={{ href: "/purchase-returns/new", label: "مرتجع شراء جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={returnColumns}
            data={visibleRows}
            loading={list.isLoading}
            searchable={false}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            emptyText={total === 0 && !f.supplierId && !f.branchId && !f.from && !f.to && !dq.trim()
              ? "لا مرتجعات مشتريات بعد."
              : "لا مرتجعات مطابقة. غيّر البحث أو الفلتر."}
            /*
             * ترقيمٌ خادميّ (limit/offset) ⇒ يُعلَن لـDataTable.
             * بدونه يظنّ الصفحةَ الحاضرة كاملَ البيانات فيُفعّل فرزاً يرتّب صفحةً واحدة
             * فقط، فتُنتج الصفحةُ التالية شريحةً مفروزةً مستقلّة (مراجعة Codex، P2).
             */
            serverPagination={{
              page,
              onPageChange: setPage,
              pageSize: PAGE,
              total,
            }}
          />
        </CardContent>
      </Card>

      {/* الترقيم يُصيّره DataTable عبر serverPagination — شريطٌ واحد لا اثنان. */}
    </div>
  );
}
