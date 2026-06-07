import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const CUST_TYPE_LABEL: Record<string, string> = {
  "فرد": "فرد",
  "تاجر": "تاجر",
  "مؤسسة": "مؤسسة",
  "شركة": "شركة",
  "حكومي": "حكومي",
};

const fmt = (s: string | number) => Number(s).toLocaleString("ar-IQ", { maximumFractionDigits: 2 });

export default function ARAging() {
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const aging = trpc.reports.arAging.useQuery({ branchId: branchId ? Number(branchId) : undefined });

  const totals = useMemo(() => {
    const rows = aging.data ?? [];
    return rows.reduce(
      (a, r) => ({
        d0_30: a.d0_30 + Number(r.d0_30 || 0),
        d31_60: a.d31_60 + Number(r.d31_60 || 0),
        d61_90: a.d61_90 + Number(r.d61_90 || 0),
        d91p: a.d91p + Number(r.d91p || 0),
        unpaidTotal: a.unpaidTotal + Number(r.unpaidTotal || 0),
        currentBalance: a.currentBalance + Number(r.currentBalance || 0),
      }),
      { d0_30: 0, d31_60: 0, d61_90: 0, d91p: 0, unpaidTotal: 0, currentBalance: 0 }
    );
  }, [aging.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">أعمار الذمم (AR Aging)</h1>
        <Link href="/customers-statement"><Button variant="outline">كشف حساب عميل</Button></Link>
      </div>
      <p className="text-sm text-muted-foreground">
        المتأخّر من العملاء مُجمَّعاً في أربع شرائح عمرية حسب تاريخ الفاتورة.
        المُسدَّد كلياً مستثنى؛ يظهر العميل عند وجود مديونيّة أو رصيد قائم.
      </p>

      <Card>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-6">
          <div className="space-y-1">
            <Label className="text-xs">الفرع</Label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— كل الفروع —</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <Bucket label="0–30 يوم" value={totals.d0_30} color="bg-emerald-50 text-emerald-700" />
          <Bucket label="31–60 يوم" value={totals.d31_60} color="bg-amber-50 text-amber-700" />
          <Bucket label="61–90 يوم" value={totals.d61_90} color="bg-orange-50 text-orange-700" />
          <Bucket label="أكثر من 90" value={totals.d91p} color="bg-rose-50 text-rose-700" />
          <Bucket label="إجمالي غير المسدّد" value={totals.unpaidTotal} color="bg-muted" emphasis />
          <Bucket label="مجموع الذمم الجارية" value={totals.currentBalance} color="bg-muted" emphasis />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">العميل</th>
                <th className="p-2">الفئة</th>
                <th className="p-2">الهاتف</th>
                <th className="p-2 text-left">0–30</th>
                <th className="p-2 text-left">31–60</th>
                <th className="p-2 text-left">61–90</th>
                <th className="p-2 text-left">+90</th>
                <th className="p-2 text-left">إجمالي غير المسدّد</th>
                <th className="p-2 text-left">رصيد جارٍ</th>
                <th className="p-2">أقدم فاتورة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(aging.data ?? []).map((r) => (
                <tr key={r.customerId} className="border-t">
                  <td className="p-2 font-medium">{r.customerName}</td>
                  <td className="p-2 text-xs">{CUST_TYPE_LABEL[r.customerType ?? ""] ?? r.customerType ?? "—"}</td>
                  <td className="p-2 text-xs font-mono" dir="ltr">{r.phone ?? "—"}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.d0_30)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.d31_60)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.d61_90)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.d91p)}</td>
                  <td className="p-2 text-left tabular-nums font-semibold" dir="ltr">{fmt(r.unpaidTotal)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.currentBalance)}</td>
                  <td className="p-2 text-xs" dir="ltr">{r.oldestInvoiceDate ?? "—"}</td>
                  <td className="p-2 text-center">
                    <Link href={`/customers-statement?id=${r.customerId}`}>
                      <Button variant="outline" size="sm">كشف الحساب</Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {aging.data && aging.data.length === 0 && (
                <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">لا ذمم مستحقّة. ممتاز.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Bucket({ label, value, color, emphasis }: { label: string; value: number; color: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-3 ${color}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-lg font-semibold"}`} dir="ltr">{fmt(value.toFixed(2))}</div>
    </div>
  );
}
