import { CopyInline } from "@/components/CopyButton";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListToolbar, RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
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
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { useMemo } from "react";

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
                <Input type="date" dir="ltr" className="h-8 w-36" value={f.from} onChange={(e) => setF({ from: e.target.value })} title="من تاريخ" />
                <Input type="date" dir="ltr" className="h-8 w-36" value={f.to} onChange={(e) => setF({ to: e.target.value })} title="إلى تاريخ" />
                <AppSelect size="sm" className="h-8 w-40" value={f.status || "ALL"} onValueChange={(v) => setF({ status: v === "ALL" ? "" : v })}>
                  <option value="ALL">— كل الحالات —</option>
                  {Object.entries(STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </AppSelect>
                {isElevated && (
                  <AppSelect size="sm" className="h-8 w-40" value={f.branchId || "ALL"} onValueChange={(v) => setF({ branchId: v === "ALL" ? "" : v })}>
                    <option value="ALL">— كل الفروع —</option>
                    {(branches.data ?? []).map((b) => (
                      <option key={b.id} value={String(b.id)}>{b.name}</option>
                    ))}
                  </AppSelect>
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
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">رقم العرض</th>
                <th className="p-2">العميل</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">الصلاحية</th>
                <th className="p-2 text-right">الإجمالي</th>
                <th className="p-2">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {items.map((qr) => (
                <tr key={qr.id} className="border-t">
                  <td className="p-2"><CopyInline value={qr.quoteNumber} /></td>
                  <td className="p-2">{qr.customerName ?? "—"}</td>
                  <td className="p-2 whitespace-nowrap tabular-nums" dir="ltr">{fmtDate(qr.quoteDate)}</td>
                  <td className="p-2 text-xs">{qr.validUntil ? String(qr.validUntil).slice(0, 10) : "—"}</td>
                  <td className="p-2 text-right tabular-nums" dir="ltr">{fmt(qr.total)}</td>
                  <td className="p-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[qr.status] ?? "bg-muted"}`}>
                      {STATUS[qr.status] ?? qr.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="auto"
                      actions={[
                        {
                          key: "open",
                          kind: "view",
                          label: "فتح",
                          href: `/quotations/${qr.id}`,
                          gate: { module: "sales", level: "READ" },
                        },
                        {
                          key: "edit",
                          kind: "edit",
                          label: "تعديل",
                          href: `/quotations/${qr.id}/edit`,
                          hidden: qr.status !== "DRAFT" || !canManage,
                          gate: { roles: ["manager"], module: "sales", level: "FULL" },
                        },
                        {
                          key: "print",
                          kind: "print",
                          label: "طباعة",
                          onSelect: () => void printQuote(qr.id),
                          gate: { module: "sales", level: "READ" },
                        },
                        {
                          key: "send",
                          kind: "approve",
                          label: "وضع مُرسَل",
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
                  </td>
                </tr>
              ))}
              {!rows.isLoading && items.length === 0 && (
                <TableEmptyRow colSpan={7} message="لا عروض أسعار مطابقة." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
          {rows.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
                {rows.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
