import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { printCustomerStmt } from "@/lib/printing/printTemplates";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "غير مسدّدة",
  PARTIALLY_PAID: "مسدّدة جزئياً",
  PAID: "مسدّدة",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
  CONFIRMED: "مؤكّدة",
};
const STATUS_CLS: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-700",
  PARTIALLY_PAID: "bg-blue-100 text-blue-700",
  PAID: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-rose-100 text-rose-700",
  RETURNED: "bg-rose-100 text-rose-700",
  CONFIRMED: "bg-slate-100 text-slate-700",
};
const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "شيك", TRANSFER: "تحويل", WALLET: "محفظة",
};

const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

export default function CustomerStatement() {
  // wouter's useLocation() strips the query string, so read it from window.location directly.
  const initial = useMemo(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    return id ? Number(id) : 0;
  }, []);

  const [customerId, setCustomerId] = useState<number>(initial);
  useEffect(() => { if (initial && initial !== customerId) setCustomerId(initial); }, [initial]); // eslint-disable-line

  const index = trpc.reports.customersIndex.useQuery();
  const stmt = trpc.reports.customerStatement.useQuery(
    { customerId: customerId || 0 },
    { enabled: !!customerId }
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">كشف حساب عميل</h1>
        <div className="flex gap-2">
          {stmt.data && (
            <Button variant="outline" size="sm" onClick={() => {
              const d = stmt.data!;
              const invTxs = d.invoices.map(i => ({
                date: new Date(i.invoiceDate).toLocaleDateString('en-GB'),
                ref: i.invoiceNumber, description: 'فاتورة مبيعات',
                debit: Number(i.total), credit: null, balance: 0,
              }));
              const payTxs = d.payments.map(p => ({
                date: new Date(p.createdAt).toLocaleDateString('en-GB'),
                ref: `دفعة`, description: p.direction === 'IN' ? 'دفعة وارد' : 'استرداد',
                debit: null,
                credit: Number(p.amount), balance: 0,
              }));
              const merged = [...invTxs, ...payTxs].sort((a, b) => a.date.localeCompare(b.date));
              let bal = 0;
              const txs = merged.map(t => {
                bal += (t.debit ?? 0) - (t.credit ?? 0);
                return { ...t, balance: bal };
              });
              printCustomerStmt({
                customerName: d.customer.name, customerPhone: d.customer.phone ?? undefined,
                toDate: new Date().toLocaleDateString('en-GB'), transactions: txs,
                totalDebit: d.summary.totalSales, totalCredit: d.summary.totalPaid,
                closingBalance: d.summary.currentBalance,
              });
            }}>طباعة الكشف</Button>
          )}
          <Link href="/ar-aging"><Button variant="outline">أعمار الذمم</Button></Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">كل الفواتير والدفعات لعميل واحد، مع ملخّص الرصيد الجارٍ.</p>

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">العميل</Label>
            <select className={selectCls} value={customerId} onChange={(e) => setCustomerId(Number(e.target.value))}>
              <option value={0}>— اختر عميلاً —</option>
              {(index.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.phone ? `· ${c.phone}` : ""} {Number(c.currentBalance) > 0 ? `· يدين بـ ${fmt(c.currentBalance)}` : ""}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {!customerId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر عميلاً لعرض كشف الحساب.</p>
      )}

      {customerId > 0 && stmt.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}

      {stmt.data && (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.customer.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.customer.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.customer.customerType} · فئة سعرية {stmt.data.customer.defaultPriceTier}
                    {stmt.data.customer.creditLimit && Number(stmt.data.customer.creditLimit) > 0
                      ? ` · سقف ائتمان ${fmt(stmt.data.customer.creditLimit)}`
                      : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <Stat label="إجمالي المبيعات" value={stmt.data.summary.totalSales} />
                  <Stat label="إجمالي المدفوع" value={stmt.data.summary.totalPaid} />
                  <Stat label="غير مسدّد" value={stmt.data.summary.unpaid} emphasis />
                  <Stat label="رصيد جارٍ" value={stmt.data.summary.currentBalance} emphasis />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الفواتير</div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-right">
                    <th className="p-2">الفاتورة</th>
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">الاستحقاق</th>
                    <th className="p-2">المصدر</th>
                    <th className="p-2 text-left">الإجمالي</th>
                    <th className="p-2 text-left">المدفوع</th>
                    <th className="p-2 text-left">المتبقّي</th>
                    <th className="p-2">الحالة</th>
                    <th className="p-2 text-center">فتح</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.data.invoices.map((i) => {
                    const remaining = Math.max(Number(i.total) - Number(i.paidAmount), 0);
                    return (
                      <tr key={i.id} className="border-t">
                        <td className="p-2"><CopyInline value={i.invoiceNumber} /></td>
                        <td className="p-2 text-xs" dir="ltr">{new Date(i.invoiceDate).toLocaleDateString("ar-IQ")}</td>
                        <td className="p-2 text-xs" dir="ltr">{i.dueDate ? String(i.dueDate).slice(0, 10) : "—"}</td>
                        <td className="p-2 text-xs">{i.sourceType}</td>
                        <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(i.total)}</td>
                        <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(i.paidAmount)}</td>
                        <td className="p-2 text-left tabular-nums font-semibold" dir="ltr">{fmt(remaining.toFixed(2))}</td>
                        <td className="p-2">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[i.status] ?? "bg-muted"}`}>
                            {STATUS_LABEL[i.status] ?? i.status}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <Link href={`/invoices/${i.id}`}>
                            <Button variant="outline" size="sm">فتح</Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {stmt.data.invoices.length === 0 && (
                    <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">لا فواتير لهذا العميل.</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الدفعات والاستردادات</div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-right">
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">الفاتورة</th>
                    <th className="p-2">الاتجاه</th>
                    <th className="p-2">طريقة الدفع</th>
                    <th className="p-2 text-left">المبلغ</th>
                    <th className="p-2">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.data.payments.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 text-xs" dir="ltr">{new Date(p.createdAt).toLocaleString("ar-IQ")}</td>
                      <td className="p-2"><CopyInline value={p.invoiceId} /></td>
                      <td className="p-2">
                        <span className={`inline-block rounded px-2 py-0.5 text-xs ${p.direction === "IN" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                          {p.direction === "IN" ? "وارد" : "صادر/استرداد"}
                        </span>
                      </td>
                      <td className="p-2 text-xs">{METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}</td>
                      <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.amount)}</td>
                      <td className="p-2 text-xs">{p.status}</td>
                    </tr>
                  ))}
                  {stmt.data.payments.length === 0 && (
                    <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">لا دفعات.</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: string | number; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-2 ${emphasis ? "bg-primary/5" : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-base font-semibold"}`} dir="ltr">{fmt(value)}</div>
    </div>
  );
}
