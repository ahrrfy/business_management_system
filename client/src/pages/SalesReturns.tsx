import { balanceOptionText } from "@/components/BalanceBadge";
import { ListToolbar, RowActions } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { D, fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

/* ═══════════ سجلّ مرتجعات البيع ═══════════
   يستهلك returns.list (managerProcedure): قيود RETURN ذات فاتورة بلا مورد.
   فلاتر عميل/فرع/فترة + ترقيم خادمي (limit/offset) + تصدير Excel + زر إنشاء.
═══════════════════════════════════════════ */

const PAGE = 50;

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function SalesReturns() {
  const [customerId, setCustomerId] = useState<number | "">("");
  const [branchId, setBranchId] = useState<number | "">("");
  // فلتر الفترة خادمي (entryDate) — أسماء dateFrom/dateTo لتفادي تصادم from/to الترقيم أدناه.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  const customers = trpc.customers.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const list = trpc.returns.list.useQuery({
    customerId: customerId ? Number(customerId) : undefined,
    branchId: branchId ? Number(branchId) : undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
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

  const setFilter = (fn: (v: number | "") => void, v: number | "") => {
    fn(v);
    setPage(0);
  };

  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">سجلّ مرتجعات البيع</h1>
        <Link href="/purchase-returns" className="text-sm text-muted-foreground">مرتجعات الشراء ←</Link>
      </div>
      <p className="text-sm text-muted-foreground">
        البضاعة المُرتجَعة من العملاء (قيود إرجاع مرتبطة بفواتير البيع). لإنشاء مرتجع جديد استعمل زرّ «مرتجع بيع جديد».
      </p>

      <Card>
        <CardHeader>
          <ListToolbar
            title="المرتجعات"
            count={total}
            loading={list.isLoading}
            filters={
              <>
                <select
                  className={selectCls}
                  value={customerId}
                  onChange={(e) => setFilter(setCustomerId, e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">— كل العملاء —</option>
                  {(customers.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {balanceOptionText((c as { currentBalance?: string | null }).currentBalance, "customer")}
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
              filename: "مرتجعات-البيع",
              rows,
              columns: [
                { key: "entryDate", header: "التاريخ" },
                { key: "invoiceNumber", header: "رقم الفاتورة", map: (r) => r.invoiceNumber ?? "" },
                { key: "customer", header: "العميل", map: (r) => r.customerName ?? "—" },
                { key: "branch", header: "الفرع", map: (r) => branchName(r.branchId) },
                { key: "returned", header: "القيمة المرتجعة", map: (r) => Number(returned(r.amount)) },
              ],
            }}
            add={{ href: "/sales-returns/new", label: "مرتجع بيع جديد" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">رقم القيد</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2">رقم الفاتورة</th>
                <th className="p-2">العميل</th>
                <th className="p-2">الفرع</th>
                <th className="p-2 text-right">القيمة المرتجعة</th>
                <th className="p-2">ملاحظات</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 tabular-nums" dir="ltr">{r.id}</td>
                  <td className="p-2 text-xs" dir="ltr">
                    {/* entryDate حقل تاريخ بلا وقت ⇒ نعرض التاريخ فقط (لا timeStyle مُختلَق). */}
                    {r.entryDate ? new Date(r.entryDate).toLocaleDateString("ar-IQ-u-nu-latn") : "—"}
                  </td>
                  <td className="p-2 tabular-nums" dir="ltr">{r.invoiceNumber ?? "—"}</td>
                  {/* customerName فارغ = بيع نقدي بلا عميل مسجَّل. */}
                  <td className="p-2 font-medium">{r.customerName ?? "—"}</td>
                  <td className="p-2">{branchName(r.branchId)}</td>
                  <td className="p-2 text-right font-semibold tabular-nums" dir="ltr">{fmt(returned(r.amount))}</td>
                  <td className="p-2 text-xs text-muted-foreground">{noteText(r.notes)}</td>
                  <td className="p-2 text-center">
                    <RowActions
                      mode="auto"
                      actions={[
                        {
                          key: "invoice",
                          label: "عرض الفاتورة الأصلية",
                          href: `/invoices/${r.invoiceId}`,
                          hidden: !r.invoiceId,
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    {total === 0 && !customerId && !branchId && !dateFrom && !dateTo
                      ? "لا مرتجعات بيع بعد."
                      : "لا مرتجعات مطابقة. غيّر الفلتر."}
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
