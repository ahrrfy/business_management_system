import { balanceOptionText } from "@/components/BalanceBadge";
import { ListToolbar, RowActions } from "@/components/list";
import { ErrorState } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
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
                <select
                  className={selectCls}
                  value={f.supplierId}
                  onChange={(e) => setF({ supplierId: e.target.value })}
                >
                  <option value="">— كل الموردين —</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {balanceOptionText((s as { currentBalance?: string | null }).currentBalance, "supplier")}
                    </option>
                  ))}
                </select>
                <select
                  className={selectCls}
                  value={f.branchId}
                  onChange={(e) => setF({ branchId: e.target.value })}
                >
                  <option value="">— كل الفروع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
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
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">رقم المرتجع</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">المورد</th>
                <th className="p-2">الفرع</th>
                <th className="p-2 text-center">أمر الشراء</th>
                <th className="p-2 text-right">القيمة المرتجعة</th>
                <th className="p-2">المنفّذ</th>
                <th className="p-2">ملاحظات</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 tabular-nums" dir="ltr">
                    {r.purchaseReturnId ? <Link className="font-semibold text-primary hover:underline" href={`/purchase-returns/${r.purchaseReturnId}`}>{r.returnNumber}</Link> : `#${r.id}`}
                  </td>
                  <td className="p-2 text-xs" dir="ltr">
                    {/* entryDate حقل تاريخ بلا وقت ⇒ نعرض التاريخ فقط (لا timeStyle مُختلَق). */}
                    {fmtDate(r.entryDate)}
                  </td>
                  <td className="p-2 font-medium">{supplierName(r.supplierId)}</td>
                  <td className="p-2">{branchName(r.branchId)}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{r.purchaseOrderId ? `#${r.purchaseOrderId}` : "—"}</td>
                  <td className="p-2 text-right font-semibold tabular-nums" dir="ltr">{fmt(returned(r.amount))}</td>
                  <td className="p-2 text-xs">{r.createdByName ?? (r.createdBy ? `مستخدم #${r.createdBy}` : "غير موثق")}</td>
                  <td className="p-2 text-xs text-muted-foreground">{noteText(r.notes)}</td>
                  <td className="p-2 text-center">
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
                          key: "print",
                          kind: "print",
                          label: "طباعة مستند المرتجع",
                          onSelect: () => printReturn(r),
                          gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" },
                        },
                        {
                          key: "po",
                          kind: "view",
                          href: r.purchaseReturnId ? `/purchase-returns/${r.purchaseReturnId}` : `/purchases/${r.purchaseOrderId}/receive`,
                          label: r.purchaseReturnId ? "فتح مستند المرتجع" : "فتح أمر الشراء",
                          hidden: r.purchaseOrderId == null,
                          gate: { module: "purchases", level: "READ" },
                        },
                        {
                          key: "stmt",
                          kind: "view",
                          label: "كشف حساب المورد",
                          href: `/suppliers-statement?id=${r.supplierId}`,
                          hidden: r.supplierId == null,
                          gate: { module: "suppliers", level: "READ" },
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {/* 403/فشل الخادم ⇒ خطأ صريح (نمط Vouchers) لا رسالة «لا مرتجعات» مضلِّلة. */}
              {list.isError && !list.isLoading && (
                <tr>
                  <td colSpan={9}>
                    <ErrorState message={list.error?.message} onRetry={() => void list.refetch()} />
                  </td>
                </tr>
              )}
              {!list.isLoading && !list.isError && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-muted-foreground">
                    {total === 0 && !f.supplierId && !f.branchId && !f.from && !f.to && !dq.trim()
                      ? "لا مرتجعات مشتريات بعد."
                      : "لا مرتجعات مطابقة. غيّر البحث أو الفلتر."}
                  </td>
                </tr>
              )}
              {list.isLoading && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td>
                </tr>
              )}
            </tbody>
          </table>
          </ScrollTableShell>
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
