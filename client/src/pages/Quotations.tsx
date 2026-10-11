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
import { variantDisplayName } from "@shared/variantDisplay";
import { allocateLineTax } from "@/components/invoice";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Download, FileSpreadsheet, Phone, Printer, User } from "lucide-react";
import { downloadOfficialPdf } from "@/lib/exportPdf";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { buildQuotationMessage } from "@/lib/whatsapp";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { printReportDoc } from "@/lib/printing/reportDoc";

const STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  ACCEPTED: "مقبول",
  REJECTED: "مرفوض",
  CONVERTED: "محوّل لفاتورة",
  EXPIRED: "منتهٍ",
};

const STATUS_SEMANTIC_STYLE: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  DRAFT: {
    bg: "bg-muted/40",
    text: "text-muted-foreground",
    border: "border-border",
  },
  SENT: {
    bg: "bg-[var(--sem-warn-bg)]",
    text: "text-[var(--sem-warn)]",
    border: "border-[var(--sem-warn)]/30",
  },
  ACCEPTED: {
    bg: "bg-[var(--sem-pos-bg)]",
    text: "text-[var(--sem-pos)]",
    border: "border-[var(--sem-pos)]/30",
  },
  REJECTED: {
    bg: "bg-[var(--sem-neg-bg)]",
    text: "text-[var(--sem-neg)]",
    border: "border-[var(--sem-neg)]/30",
  },
  CONVERTED: {
    bg: "bg-[var(--sem-pos-bg)]",
    text: "text-[var(--sem-pos)]",
    border: "border-[var(--sem-pos)]/30",
  },
  EXPIRED: {
    bg: "bg-[var(--sem-neg-bg)]",
    text: "text-[var(--sem-neg)]",
    border: "border-[var(--sem-neg)]/30",
  },
};

type Row = RouterOutputs["quotations"]["list"]["rows"][number];

export default function Quotations() {
  const utils = trpc.useUtils();
  const [selectedDossierCustomerId, setSelectedDossierCustomerId] =
    useState<number | null>(null);
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

  // طباعة العرض الرسمية من القائمة: نجلب التفاصيل ثم نطبع عبر printReportDoc
  async function printOfficialQuoteDoc(quotationId: number) {
    try {
      const d = await utils.quotations.get.fetch({ quotationId });
      if (!d) {
        notify.err("تعذّر جلب تفاصيل عرض السعر");
        return;
      }
      const opened = printReportDoc({
        title: d.status === "ACCEPTED" ? "عرض أسعار رسمي معتمد" : "عرض أسعار رسمي",
        docNum: d.quoteNumber,
        docDate: d.quoteDate ? fmtDate(d.quoteDate) : undefined,
        headerExtra: [
          { label: "حالة العرض", value: STATUS[d.status] ?? d.status },
          { label: "صالح لغاية", value: d.validUntil ? fmtDate(d.validUntil) : "—" },
        ],
        meta: [
          {
            title: "بيانات العميل والمشروع",
            fields: [
              { label: "اسم العميل", value: d.customerName ?? "—" },
              { label: "الهاتف", value: d.customerPhone ?? "—" },
              { label: "ملاحظات", value: d.notes ?? "—" },
            ],
          },
        ],
        columns: [
          { key: "item", label: "المادة والمواصفات", align: "right" },
          { key: "unit", label: "الوحدة", align: "center" },
          { key: "qty", label: "الكمية", align: "center" },
          { key: "price", label: "سعر الوحدة", align: "left" },
          { key: "total", label: "المجموع", align: "left" },
        ],
        rows: d.items.map((it) => ({
          item: variantDisplayName({ ...it, productName: it.productName ?? "" }),
          unit: it.unitName ?? "—",
          qty: String(it.quantity),
          price: `${fmt(it.unitPrice)} د.ع`,
          total: `${fmt(it.total)} د.ع`,
        })),
        summary: [
          { label: "المجموع الفرعي", value: `${fmt(d.subtotal)} د.ع` },
          ...(D(d.discountAmount ?? "0").gt(0)
            ? [{ label: "الخصم", value: `${fmt(d.discountAmount ?? "0")} د.ع` }]
            : []),
          ...(D(d.taxAmount ?? "0").gt(0)
            ? [{ label: "الضريبة", value: `${fmt(d.taxAmount ?? "0")} د.ع` }]
            : []),
          { label: "الإجمالي النهائي", value: `${fmt(d.total)} د.ع`, large: true, bold: true },
        ],
      });
      if (!opened) {
        notify.err("تعذّر فتح نافذة الطباعة الرسمية");
      }
    } catch (e) {
      notify.err(e);
    }
  }

  function printQuotationsSummaryReport() {
    if (items.length === 0) {
      notify.err("لا توجد عروض أسعار لطباعتها");
      return;
    }
    const totalSum = items.reduce((acc, r) => acc.plus(D(r.total ?? 0)), D(0));
    printReportDoc({
      title: "تقرير عروض الأسعار والمقايسات",
      headerExtra: [
        { label: "تاريخ التقرير", value: fmtDate(new Date()) },
        { label: "عدد العروض", value: String(items.length) },
      ],
      columns: [
        { key: "quoteNumber", label: "رقم العرض", align: "right" },
        { key: "customerName", label: "العميل", align: "right" },
        { key: "quoteDate", label: "التاريخ", align: "center" },
        { key: "validUntil", label: "الصلاحية", align: "center" },
        { key: "status", label: "الحالة", align: "center" },
        { key: "total", label: "الإجمالي", align: "left" },
      ],
      rows: items.map((r) => ({
        quoteNumber: r.quoteNumber,
        customerName: r.customerName ?? "—",
        quoteDate: fmtDate(r.quoteDate),
        validUntil: r.validUntil ? String(r.validUntil).slice(0, 10) : "—",
        status: STATUS[r.status] ?? r.status,
        total: `${fmt(r.total)} د.ع`,
      })),
      summary: [
        { label: "إجمالي قيمة العروض المعروضة", value: `${fmt(totalSum.toString())} د.ع`, large: true, bold: true },
      ],
    });
  }

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
      cell: ({ row }) => {
        const qr = row.original;
        const phone = qr.customerPhone;
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-foreground">{qr.customerName ?? "—"}</span>
            {qr.customerId && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6 text-primary hover:bg-primary/10"
                onClick={() => setSelectedDossierCustomerId(qr.customerId)}
                title="الملف الشامل 360°"
                aria-label={`الملف الشامل 360° للعميل ${qr.customerName ?? ""}`}
              >
                <User className="size-3.5" aria-hidden />
              </Button>
            )}
            {phone && (
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                className="size-6 text-[var(--sem-pos)] hover:bg-accent"
                title={`اتصال مباشر: ${phone}`}
                aria-label={`اتصال بالعميل ${qr.customerName ?? ""}`}
              >
                <a href={`tel:${phone}`}>
                  <Phone className="size-3.5" aria-hidden />
                </a>
              </Button>
            )}
            {phone && (
              <WhatsAppShare
                phone={phone}
                message={buildQuotationMessage({
                  quoteNumber: qr.quoteNumber,
                  quoteDate: qr.quoteDate ? String(qr.quoteDate) : null,
                  validUntil: qr.validUntil ? String(qr.validUntil) : null,
                  customerName: qr.customerName,
                  total: qr.total,
                })}
                iconOnly
                size="icon-sm"
                className="size-6"
                label={`واتساب ${qr.customerName ?? "العميل"}`}
              />
            )}
          </div>
        );
      },
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
      cell: ({ row }) => {
        const style = STATUS_SEMANTIC_STYLE[row.original.status] ?? STATUS_SEMANTIC_STYLE.DRAFT;
        return (
          <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text} ${style.border}`}>
            {STATUS[row.original.status] ?? row.original.status}
          </span>
        );
      },
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
              {
                key: "dossier360",
                kind: "view",
                icon: User,
                label: "الملف الشامل 360°",
                hidden: !qr.customerId,
                onSelect: () => setSelectedDossierCustomerId(qr.customerId),
                gate: { module: "crm", level: "READ" },
              },
              { key: "open", kind: "view", label: "فتح", href: `/quotations/${qr.id}`, gate: { module: "sales", level: "READ" } },
              {
                key: "edit", kind: "edit", label: "تعديل", href: `/quotations/${qr.id}/edit`,
                hidden: qr.status !== "DRAFT" || !canManage,
                gate: { roles: ["manager"], module: "sales", level: "FULL" },
              },
              { key: "print", kind: "print", label: "طباعة رسمية (A4)", onSelect: () => void printOfficialQuoteDoc(qr.id), gate: { module: "sales", level: "READ" } },
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
      <PageHeader
        title="عروض الأسعار والمقايسات"
        description="عروض الأسعار مستندات تفاوضية بلا أثر على المخزون حتى تُحوَّل إلى فاتورة."
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={printQuotationsSummaryReport}
              disabled={items.length === 0}
              className="gap-1.5"
            >
              <Printer className="size-4" aria-hidden />
              طباعة تقرير العروض
            </Button>
            {canManage && (
              <Button asChild size="sm">
                <Link href="/quotations/new">عرض سعر جديد</Link>
              </Button>
            )}
          </div>
        }
      />
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
              formats: ["xlsx", "csv"],
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

      <CustomerDossierDrawer
        customerId={selectedDossierCustomerId}
        open={selectedDossierCustomerId != null}
        onClose={() => setSelectedDossierCustomerId(null)}
      />
    </div>
  );
}
