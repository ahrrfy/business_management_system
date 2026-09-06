import { CopyInline } from "@/components/CopyButton";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { confirm } from "@/lib/confirm";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { fmtDate } from "@/lib/date";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printQuotation } from "@/lib/printing/printTemplates";
import { allocateLineTax } from "@/components/invoice";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Download } from "lucide-react";
import { downloadOfficialPdf } from "@/lib/exportPdf";
import { useMemo } from "react";
import { buildQuotationMessage } from "@/lib/whatsapp";

const STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  ACCEPTED: "مقبول",
  REJECTED: "مرفوض",
  CONVERTED: "محوّل لفاتورة",
  EXPIRED: "منتهٍ",
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SENT: "badge-status-pending",
  ACCEPTED: "badge-status-done",
  REJECTED: "badge-stock-out",
  CONVERTED: "badge-status-active",
  EXPIRED: "badge-stock-low",
};

type Row = RouterOutputs["quotations"]["list"]["rows"][number];

export default function Quotations() {
  const utils = trpc.useUtils();
  // بوّابة عرض مطابقة للخادم: الكتابة (create/setStatus) salesManagerProcedure(["manager"],"sales","FULL")
  // — نفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد.
  const me = trpc.auth.me.useQuery();
  const canManage = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "sales", "FULL", ["manager"]);
  // فلتر الفرع للمرتفعين فقط — غير المرتفع محصور بفرعه خادمياً (scopedBranchId) بصرف النظر عمّا يُختار هنا.
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isElevated });

  // فلاتر خادمية محفوظة في querystring (تعيش مع فتح التفاصيل والرجوع) — لا فلترة محلية تُخفي صفحات الخادم.
  const [f, setF, resetF] = useUrlFilters({ from: "", to: "", status: "", branchId: "", q: "" });

  // البحث خادمي (q ممهَّل): رقم العرض/اسم العميل/الملاحظات عبر كل النتائج لا المُحمَّل فقط.
  const dq = useDebouncedValue(f.q, 250);
  const listInput = useMemo(
    () => ({
      from: f.from || undefined,
      to: f.to || undefined,
      status: (f.status || undefined) as "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED" | undefined,
      branchId: f.branchId ? Number(f.branchId) : undefined,
      q: dq.trim() || undefined,
    }),
    [f.from, f.to, f.status, f.branchId, dq],
  );
  const activeFilterCount = [f.from || f.to, f.status, isElevated ? f.branchId : ""].filter(Boolean).length;

  // ٣/٨: cursor/hasMore بدل الاقتطاع الصامت عند ٢٠٠ (كان limit ثابتاً بلا زرّ استكمال) — «تحميل
  // المزيد» يجلب الصفحة التالية عبر nextCursor (نمط TransfersLog.tsx).
  const rows = trpc.quotations.list.useInfiniteQuery(
    { ...listInput, limit: 100 },
    { getNextPageParam: (last) => last.nextCursor },
  );
  const items = useMemo(() => (rows.data?.pages ?? []).flatMap((p) => p.rows), [rows.data]);

  // «وضع مُرسَل» من القائمة مباشرة (DRAFT → SENT فقط؛ بقية الانتقالات من شاشة العرض).
  const setStatusMut = trpc.quotations.setStatus.useMutation({
    onSuccess: async () => {
      notify.ok("عُلِّم العرض «مُرسَلاً».");
      await utils.quotations.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  // طباعة العرض من القائمة: نجلب التفاصيل (quotations.get) ثم نطبع بنفس قالب شاشة العرض.
  async function printQuote(quotationId: number) {
    try {
      const d = await utils.quotations.get.fetch({ quotationId });
      if (!d) { notify.err("تعذّر جلب عرض السعر"); return; }
      const taxableBase = round2(D(d.subtotal).minus(D(d.discountAmount ?? "0"))).toFixed(2);
      const taxShares = allocateLineTax(
        d.items.map((it) => ({ total: String(it.total) })),
        String(d.taxAmount ?? "0"),
        taxableBase,
      );
      printQuotation({
        quoteNumber: d.quoteNumber,
        quoteDate: d.quoteDate ? String(d.quoteDate).slice(0, 10) : undefined,
        validUntil: d.validUntil ? String(d.validUntil).slice(0, 10) : undefined,
        customerName: d.customerName,
        notes: d.notes,
        items: d.items.map((it, index) => ({
          productName: it.productName ?? "",
          variantName: it.variantName,
          unitName: it.unitName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          taxAmount: taxShares[index] ?? "0",
          total: it.total,
        })),
        subtotal: d.subtotal,
        discountAmount: d.discountAmount,
        taxAmount: d.taxAmount,
        taxRate: Number(d.taxRatePercent ?? 0),
        total: d.total,
      });
    } catch (e) {
      notify.err(e);
    }
  }
  /**
   * أعمدة عروض الأسعار — نُقلت حرفياً من صفوف JSX السابقة: نفس التنسيق ونفس بوّابات
   * الصلاحيات في RowActions. الفائدة من DataTable هنا: حالات التحميل/الخطأ/الفراغ
   * (تمييز «لا سجلات بعد» عن «لا مطابق للفلتر») وبطاقات الجوّال — وكلّها كانت غائبة.
   */
  /*
   * ⛔ كل عمود بـ`enableSorting: false` عمداً: القائمة تُحمَّل تدريجياً (infinite) فما بين يدي
   * DataTable هو الصفحات المُحمَّلة لا كامل البيانات — فرزُ الرؤوس كان سيرتّب المُحمَّل وحده
   * ويبدو فرزاً شاملاً (نظير ما أمسكته مراجعة Codex على القوائم المُرقَّمة خادمياً).
   * ولا يصحّ `serverPagination` هنا: لا مفهومَ «صفحة» في التحميل التراكميّ.
   */
  const quotationColumns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      id: "quoteNumber",
      enableSorting: false,
      header: "رقم العرض",
      accessorFn: (r) => r.quoteNumber,
      cell: ({ row }) => <CopyInline value={row.original.quoteNumber} />,
      meta: { kind: "code" },
    },
    {
      id: "customerName",
      enableSorting: false,
      header: "العميل",
      accessorFn: (r) => r.customerName ?? "—",
      meta: { kind: "text", wrap: true },
    },
    {
      id: "quoteDate",
      enableSorting: false,
      header: "التاريخ",
      accessorFn: (r) => (r.quoteDate ? String(r.quoteDate) : ""),
      cell: ({ row }) => fmtDate(row.original.quoteDate),
      meta: { kind: "date" },
    },
    {
      id: "validUntil",
      enableSorting: false,
      header: "الصلاحية",
      accessorFn: (r) => (r.validUntil ? String(r.validUntil).slice(0, 10) : ""),
      cell: ({ row }) => row.original.validUntil ? String(row.original.validUntil).slice(0, 10) : "—",
      meta: { kind: "date" },
    },
    {
      id: "total",
      enableSorting: false,
      header: "الإجمالي",
      accessorFn: (r) => Number(r.total ?? 0),
      cell: ({ row }) => fmt(row.original.total),
      meta: { kind: "money" },
    },
    {
      id: "status",
      enableSorting: false,
      header: "الحالة",
      accessorFn: (r) => STATUS[r.status] ?? r.status,
      cell: ({ row }) => (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.status] ?? "bg-muted"}`}>
          {STATUS[row.original.status] ?? row.original.status}
        </span>
      ),
      meta: { kind: "status" },
    },
    {
      id: "actions",
      enableSorting: false,
      header: "إجراء",
      cell: ({ row }) => {
        const qr = row.original;
        return (
          <RowActions
            mode="auto"
            contact={{
              phone: qr.customerPhone,
              label: `واتساب ${qr.customerName ?? "العميل"}`,
              message: buildQuotationMessage({
                quoteNumber: qr.quoteNumber,
                quoteDate: qr.quoteDate ? String(qr.quoteDate) : null,
                validUntil: qr.validUntil ? String(qr.validUntil) : null,
                customerName: qr.customerName,
                total: qr.total,
              }),
              disabledReason: "لا يوجد رقم واتساب مرتبط بعرض السعر",
              gate: { module: "sales", level: "READ" },
            }}
            actions={[
              { key: "open", kind: "view", label: "فتح", href: `/quotations/${qr.id}`, gate: { module: "sales", level: "READ" } },
              {
                key: "edit", kind: "edit", label: "تعديل", href: `/quotations/${qr.id}/edit`,
                hidden: qr.status !== "DRAFT" || !canManage,
                gate: { roles: ["manager"], module: "sales", level: "FULL" },
              },
              { key: "print", kind: "print", label: "طباعة", onSelect: () => void printQuote(qr.id), gate: { module: "sales", level: "READ" } },
              {
                key: "download-pdf",
                kind: "export",
                icon: Download,
                label: "تنزيل PDF",
                onSelect: () =>
                  downloadOfficialPdf({
                    kind: "QUOTATION",
                    documentId: qr.id,
                    documentNumber: qr.quoteNumber,
                    fetcher: (params) => utils.client.documentDelivery.downloadPdf.mutate(params),
                  }),
                gate: { module: "sales", level: "READ" },
              },
              {
                key: "send", kind: "approve", label: "وضع مُرسَل",
                onSelect: async () => {
                  if (!(await confirm({
                    variant: "warning",
                    title: "وضع العرض مُرسَلاً",
                    description: `وضع العرض «${qr.quoteNumber}» مُرسَلاً لا يُعكَس من القائمة. متابعة؟`,
                    confirmText: "وضع مُرسَل",
                  }))) return;
                  setStatusMut.mutate({ quotationId: qr.id, status: "SENT" });
                },
                hidden: qr.status !== "DRAFT" || !canManage,
                disabled: setStatusMut.isPending,
                disabledReason: "توجد عملية تحديث قيد التنفيذ",
                gate: { roles: ["manager"], module: "sales", level: "FULL" },
              },
            ]}
          />
        );
      },
      meta: { kind: "actions" },
    },
  ], [canManage, setStatusMut.isPending]);

  return (
    <div className="space-y-4">
      <PageHeader title="عروض الأسعار" description="عروض الأسعار مستندات تفاوضية بلا أثر على المخزون حتى تُحوَّل إلى فاتورة." />
      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={items.length}
            loading={rows.isLoading}
            search={{
              value: f.q,
              onChange: (v) => setF({ q: v }),
              placeholder: "بحث (رقم العرض/العميل/ملاحظات)",
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            filters={
              <>
                {/* FilterField يُظهر التسمية دائماً — title كخاصية HTML أصيلة يظهر hover فقط
                    ولا يخبر الموظّف بمعنى الحقل عند الاختيار (نمط PR #559). */}
                <FilterField label="من تاريخ">
                  <Input type="date" dir="ltr" className="h-8 w-36" value={f.from} onChange={(e) => setF({ from: e.target.value })} />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input type="date" dir="ltr" className="h-8 w-36" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
                </FilterField>
                <FilterField label="الحالة">
                  <AppSelect size="sm" className="h-8 w-40" value={f.status || "ALL"} onValueChange={(v) => setF({ status: v === "ALL" ? "" : v })}>
                    <option value="ALL">— كل الحالات —</option>
                    {Object.entries(STATUS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                {isElevated && (
                  <FilterField label="الفرع">
                    <AppSelect size="sm" className="h-8 w-40" value={f.branchId || "ALL"} onValueChange={(v) => setF({ branchId: v === "ALL" ? "" : v })}>
                      <option value="ALL">— كل الفروع —</option>
                      {(branches.data ?? []).map((b) => (
                        <option key={b.id} value={String(b.id)}>{b.name}</option>
                      ))}
                    </AppSelect>
                  </FilterField>
                )}
              </>
            }
            exportSpec={{
              filename: "عروض الأسعار",
              rows: items,
              // كل الصفحات المطابقة للفلتر (لا المُحمَّل على الشاشة فقط) — offset يعمل حين لا cursor
              // يُمرَّر (توافق عَكسي في paginateKeyset)، فتُغطّى كل الصفوف مهما كثرت.
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, limit) =>
                    utils.quotations.list
                      .fetch({ ...listInput, limit, offset })
                      .then((r) => ({ rows: (r.rows ?? []) as Row[] })),
                  { pageSize: 200 },
                ),
              columns: [
                { key: "quoteNumber", header: "رقم العرض" },
                { key: "customerName", header: "العميل" },
                { key: "quoteDate", header: "التاريخ", map: (r) => fmtDate(r.quoteDate) },
                { key: "validUntil", header: "الصلاحية", map: (r) => (r.validUntil ? String(r.validUntil).slice(0, 10) : "") },
                { key: "total", header: "الإجمالي", map: (r) => Number(r.total ?? 0) },
                { key: "status", header: "الحالة", map: (r) => STATUS[r.status] ?? r.status },
              ],
            }}
            add={canManage ? { href: "/quotations/new", label: "عرض سعر جديد" } : undefined}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={quotationColumns}
            data={items}
            loading={rows.isLoading}
            searchable={false}
            resourceKey="quotations"
            errorState={{ isError: rows.isError, message: rows.error?.message, onRetry: () => void rows.refetch() }}
            emptyText="لا عروض أسعار مطابقة."
          />
          {rows.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
                {rows.isFetchingNextPage ? ACTION_LABELS.loading : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
