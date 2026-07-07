import { balanceOptionText } from "@/components/BalanceBadge";
import { ListToolbar, RowActions } from "@/components/list";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D, fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
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
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [branchId, setBranchId] = useState<number | "">("");
  // فلتر الفترة خادمي (entryDate) — أسماء dateFrom/dateTo لتفادي تصادم from/to الترقيم أدناه.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");

  // البحث خادمي الآن (q ممهَّل): مورد/ملاحظة/رقم قيد/أمر شراء عبر كل النتائج لا الصفحة فقط.
  const dq = useDebouncedValue(query, 250);
  const listInput = {
    supplierId: supplierId ? Number(supplierId) : undefined,
    branchId: branchId ? Number(branchId) : undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    q: dq.trim() || undefined,
  };

  const suppliers = trpc.suppliers.list.useQuery();
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
  const returned = (amount: string) => D(amount).neg().toFixed(2);
  // notes قد يكون مفتاح idempotency تقنيّاً (purchaseReturn:...) لا ملاحظة مستخدم ⇒ يُخفى.
  const noteText = (n: string | null | undefined) =>
    n && !n.startsWith("purchaseReturn:") ? n : "—";

  // البحث خادمي ⇒ الصفوف المعروضة هي نتائج الخادم مباشرةً (لا تصفية محلّية تُخفي صفحات أخرى).
  const visibleRows = rows;

  const setFilter = (fn: (v: number | "") => void, v: number | "") => {
    fn(v);
    setPage(0);
  };

  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">سجلّ مرتجعات المشتريات</h1>
        <Link href="/returns" className="text-sm text-muted-foreground">مرتجعات البيع ←</Link>
      </div>
      <p className="text-sm text-muted-foreground">
        البضاعة المُرتجَعة للموردين (قيود إرجاع ذات مورد). لإنشاء مرتجع جديد استعمل زرّ «مرتجع شراء جديد».
      </p>

      <Card>
        <CardHeader>
          <ListToolbar
            title="المرتجعات"
            count={total}
            loading={list.isLoading}
            search={{ value: query, onChange: (v) => { setQuery(v); setPage(0); }, placeholder: "بحث (مورد/رقم قيد/أمر شراء/ملاحظة)…" }}
            filters={
              <>
                <select
                  className={selectCls}
                  value={supplierId}
                  onChange={(e) => setFilter(setSupplierId, e.target.value ? Number(e.target.value) : "")}
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
                  value={branchId}
                  onChange={(e) => setFilter(setBranchId, e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">— كل الفروع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <Input type="date" dir="ltr" className="h-8 w-36" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} title="من تاريخ" />
                <Input type="date" dir="ltr" className="h-8 w-36" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} title="إلى تاريخ" />
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
                { key: "entryDate", header: "التاريخ" },
                { key: "supplier", header: "المورد", map: (r) => supplierName(r.supplierId) },
                { key: "branch", header: "الفرع", map: (r) => branchName(r.branchId) },
                { key: "purchaseOrderId", header: "أمر الشراء", map: (r) => r.purchaseOrderId ?? "" },
                { key: "returned", header: "القيمة المرتجعة", map: (r) => Number(returned(r.amount)) },
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
                <th className="p-2">رقم القيد</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">المورد</th>
                <th className="p-2">الفرع</th>
                <th className="p-2 text-center">أمر الشراء</th>
                <th className="p-2 text-right">القيمة المرتجعة</th>
                <th className="p-2">ملاحظات</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 tabular-nums" dir="ltr">{r.id}</td>
                  <td className="p-2 text-xs" dir="ltr">
                    {/* entryDate حقل تاريخ بلا وقت ⇒ نعرض التاريخ فقط (لا timeStyle مُختلَق). */}
                    {r.entryDate ? new Date(r.entryDate).toLocaleDateString("ar-IQ-u-nu-latn") : "—"}
                  </td>
                  <td className="p-2 font-medium">{supplierName(r.supplierId)}</td>
                  <td className="p-2">{branchName(r.branchId)}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{r.purchaseOrderId ? `#${r.purchaseOrderId}` : "—"}</td>
                  <td className="p-2 text-right font-semibold tabular-nums" dir="ltr">{fmt(returned(r.amount))}</td>
                  <td className="p-2 text-xs text-muted-foreground">{noteText(r.notes)}</td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="auto"
                      actions={[
                        {
                          key: "po",
                          label: "فتح أمر الشراء",
                          href: `/purchases/${r.purchaseOrderId}/receive`,
                          hidden: r.purchaseOrderId == null,
                        },
                        {
                          key: "stmt",
                          label: "كشف حساب المورد",
                          href: `/suppliers-statement?id=${r.supplierId}`,
                          hidden: r.supplierId == null,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {/* 403/فشل الخادم ⇒ خطأ صريح (نمط Vouchers) لا رسالة «لا مرتجعات» مضلِّلة. */}
              {list.isError && !list.isLoading && (
                <tr>
                  <td colSpan={8}>
                    <ErrorState message={list.error?.message} onRetry={() => void list.refetch()} />
                  </td>
                </tr>
              )}
              {!list.isLoading && !list.isError && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    {total === 0 && !supplierId && !branchId && !dateFrom && !dateTo && !dq.trim()
                      ? "لا مرتجعات مشتريات بعد."
                      : "لا مرتجعات مطابقة. غيّر البحث أو الفلتر."}
                  </td>
                </tr>
              )}
              {list.isLoading && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td>
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
