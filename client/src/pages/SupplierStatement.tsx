import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildStatementMessage } from "@/lib/whatsapp";
import { printSupplierStmt } from "@/lib/printing/printTemplates";
import { positiveDiff } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const PO_STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودّة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};
const PO_STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  SENT: "bg-blue-100 text-blue-700",
  CONFIRMED: "bg-amber-100 text-amber-700",
  RECEIVED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-rose-100 text-rose-700",
};

const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

export default function SupplierStatement() {
  // wouter's useLocation() strips the query string, so read it from window.location directly.
  const initial = useMemo(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    return id ? Number(id) : 0;
  }, []);

  const [supplierId, setSupplierId] = useState<number>(initial);
  useEffect(() => { if (initial && initial !== supplierId) setSupplierId(initial); }, [initial]); // eslint-disable-line

  const index = trpc.reports.suppliersIndex.useQuery();
  const stmt = trpc.reports.supplierStatement.useQuery(
    { supplierId: supplierId || 0 },
    { enabled: !!supplierId }
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">كشف حساب مورد</h1>
        <div className="flex gap-2">
          {stmt.data && (
            <Button variant="outline" size="sm" onClick={() => {
              const d = stmt.data!;
              const poTxs = d.purchaseOrders.map(p => ({
                date: new Date(p.orderDate).toLocaleDateString('en-GB'),
                ref: p.poNumber, description: 'أمر شراء',
                debit: null, credit: Number(p.total), balance: 0,
              }));
              const payTxs = d.payments.map(p => ({
                date: new Date(p.entryDate).toLocaleDateString('en-GB'),
                ref: 'دفعة', description: 'دفعة للمورد',
                debit: Number(p.amount), credit: null, balance: 0,
              }));
              const merged = [...poTxs, ...payTxs].sort((a, b) => a.date.localeCompare(b.date));
              let bal = 0;
              const txs = merged.map(t => { bal += (t.credit ?? 0) - (t.debit ?? 0); return { ...t, balance: bal }; });
              printSupplierStmt({
                supplierName: d.supplier.name, supplierPhone: d.supplier.phone ?? undefined,
                toDate: new Date().toLocaleDateString('en-GB'), transactions: txs,
                totalDebit: d.summary.totalPaid, totalCredit: d.summary.totalPurchases,
                closingBalance: d.summary.currentBalance,
              });
            }}>طباعة الكشف</Button>
          )}
          {stmt.data && (
            <WhatsAppShare
              phone={stmt.data.supplier.phone}
              message={buildStatementMessage({
                entityName: stmt.data.supplier.name,
                entityType: "supplier",
                currentBalance: stmt.data.summary.currentBalance,
                totalSales: stmt.data.summary.totalPurchases,
                totalPaid: stmt.data.summary.totalPaid,
                unpaid: stmt.data.summary.unpaid,
              })}
              label="إرسال كشف الحساب"
            />
          )}
          <Link href="/ap-aging"><Button variant="outline">أعمار الذمم الدائنة</Button></Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">كل أوامر الشراء والدفعات لمورد واحد، مع ملخّص الرصيد الجارٍ.</p>

      <Card>
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">المورد</Label>
            <select className={selectCls} value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value))}>
              <option value={0}>— اختر مورداً —</option>
              {(index.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.phone ? `· ${s.phone}` : ""} {Number(s.currentBalance) > 0 ? `· له علينا ${fmt(s.currentBalance)}` : Number(s.currentBalance) < 0 ? `· لنا عليه ${fmt(Math.abs(Number(s.currentBalance)))}` : ""}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {!supplierId && (
        <p className="text-sm text-muted-foreground text-center py-8">اختر مورداً لعرض كشف الحساب.</p>
      )}

      {supplierId > 0 && stmt.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}

      {stmt.data && (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="text-lg font-semibold">{stmt.data.supplier.name}</div>
                  <div className="text-xs"><CopyInline value={stmt.data.supplier.phone} /></div>
                  <div className="text-xs text-muted-foreground">
                    {stmt.data.supplier.city ?? "—"}
                    {stmt.data.supplier.paymentTerms ? ` · شروط الدفع: ${stmt.data.supplier.paymentTerms}` : ""}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <Stat label="إجمالي المشتريات" value={stmt.data.summary.totalPurchases} />
                  <Stat label="إجمالي المدفوع" value={stmt.data.summary.totalPaid} />
                  <Stat label="غير مدفوع" value={stmt.data.summary.unpaid} emphasis />
                  <StatBalance label="الرصيد الجاري" value={stmt.data.summary.currentBalance} entityType="supplier" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">أوامر الشراء</div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-right">
                    <th className="p-2">أمر الشراء</th>
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">الاستحقاق</th>
                    <th className="p-2 text-left">الإجمالي</th>
                    <th className="p-2 text-left">المدفوع</th>
                    <th className="p-2 text-left">المتبقّي</th>
                    <th className="p-2">الحالة</th>
                    <th className="p-2 text-center">فتح</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.data.purchaseOrders.map((p) => {
                    // §٥: نستعمل Decimal للطرح (positiveDiff) لا Number() float.
                    const remaining = positiveDiff(p.total, p.paidAmount).toFixed(2);
                    return (
                      <tr key={p.id} className="border-t">
                        <td className="p-2"><CopyInline value={p.poNumber} /></td>
                        <td className="p-2 text-xs" dir="ltr">{new Date(p.orderDate).toLocaleDateString("ar-IQ")}</td>
                        <td className="p-2 text-xs" dir="ltr">{p.expectedDeliveryDate ? String(p.expectedDeliveryDate).slice(0, 10) : "—"}</td>
                        <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.total)}</td>
                        <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.paidAmount)}</td>
                        <td className="p-2 text-left tabular-nums font-semibold" dir="ltr">{fmt(remaining)}</td>
                        <td className="p-2">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${PO_STATUS_CLS[p.status] ?? "bg-muted"}`}>
                            {PO_STATUS_LABEL[p.status] ?? p.status}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <Link href={`/purchases/${p.id}/receive`}>
                            <Button variant="outline" size="sm">فتح</Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                  {stmt.data.purchaseOrders.length === 0 && (
                    <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">لا أوامر شراء لهذا المورد.</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="p-3 border-b bg-muted/30 text-sm font-medium">الدفعات المسجّلة</div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-right">
                    <th className="p-2">التاريخ</th>
                    <th className="p-2">أمر الشراء</th>
                    <th className="p-2 text-left">المبلغ</th>
                    <th className="p-2">ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.data.payments.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 text-xs" dir="ltr">{new Date(p.entryDate).toLocaleDateString("ar-IQ")}</td>
                      <td className="p-2"><CopyInline value={p.purchaseOrderId} /></td>
                      <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(p.amount)}</td>
                      <td className="p-2 text-xs">{p.notes ?? "—"}</td>
                    </tr>
                  ))}
                  {stmt.data.payments.length === 0 && (
                    <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">لا دفعات مسجّلة لهذا المورد.</td></tr>
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

function StatBalance({ label, value, entityType }: { label: string; value: string | number; entityType: "customer" | "supplier" }) {
  const num = Number(value);
  // للمورد: الموجب = "له علينا" (أحمر)؛ للعميل: الموجب = "لنا عليه" (أخضر)
  const weHaveClaim = entityType === "customer" ? num > 0 : num < 0;
  const hasBalance = num !== 0;
  return (
    <div className={`rounded-md p-2 ${hasBalance ? (weHaveClaim ? "bg-emerald-50" : "bg-rose-50") : "bg-muted/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums text-xl font-bold ${hasBalance ? (weHaveClaim ? "text-emerald-700" : "text-rose-700") : ""}`} dir="ltr">
        {fmt(Math.abs(num))}
      </div>
      <div className={`text-xs font-semibold mt-0.5 ${hasBalance ? (weHaveClaim ? "text-emerald-600" : "text-rose-600") : "text-muted-foreground"}`}>
        {!hasBalance ? "لا ذمم" : weHaveClaim ? "لنا عليه" : "له علينا"}
      </div>
    </div>
  );
}
