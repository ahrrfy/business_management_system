import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { Label } from "@/components/ui/label";
import { printARAging } from "@/lib/printing/printTemplates";
import { D, fmt as fmtMoney } from "@/lib/money";
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

const fmt = (s: string | number) => fmtMoney(s);

export default function ARAging() {
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const aging = trpc.reports.arAging.useQuery({ branchId: branchId ? Number(branchId) : undefined });

  // §٥: نجمع بدقّة Decimal (لا Number()) ⇒ لا انجراف float عبر مئات الصفوف.
  const totals = useMemo(() => {
    const rows = aging.data ?? [];
    const acc = rows.reduce(
      (a, r) => ({
        d0_30: a.d0_30.plus(D(r.d0_30 || 0)),
        d31_60: a.d31_60.plus(D(r.d31_60 || 0)),
        d61_90: a.d61_90.plus(D(r.d61_90 || 0)),
        d91p: a.d91p.plus(D(r.d91p || 0)),
        unpaidTotal: a.unpaidTotal.plus(D(r.unpaidTotal || 0)),
        currentBalance: a.currentBalance.plus(D(r.currentBalance || 0)),
      }),
      { d0_30: D(0), d31_60: D(0), d61_90: D(0), d91p: D(0), unpaidTotal: D(0), currentBalance: D(0) }
    );
    return {
      d0_30: acc.d0_30.toFixed(2),
      d31_60: acc.d31_60.toFixed(2),
      d61_90: acc.d61_90.toFixed(2),
      d91p: acc.d91p.toFixed(2),
      unpaidTotal: acc.unpaidTotal.toFixed(2),
      currentBalance: acc.currentBalance.toFixed(2),
    };
  }, [aging.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">أعمار الذمم المدينة — لنا على العملاء</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!aging.data?.length}
            onClick={() =>
              exportRows(aging.data ?? [], {
                filename: "ذمم-مدينة",
                columns: [
                  { key: "customerName", header: "العميل" },
                  { key: "customerType", header: "الفئة" },
                  { key: "phone", header: "الهاتف" },
                  { key: "d0_30", header: "0–30", map: (r) => Number(r.d0_30) },
                  { key: "d31_60", header: "31–60", map: (r) => Number(r.d31_60) },
                  { key: "d61_90", header: "61–90", map: (r) => Number(r.d61_90) },
                  { key: "d91p", header: "+90", map: (r) => Number(r.d91p) },
                  { key: "unpaidTotal", header: "إجمالي غير المدفوع", map: (r) => Number(r.unpaidTotal) },
                  { key: "currentBalance", header: "رصيد جارٍ", map: (r) => Number(r.currentBalance) },
                  { key: "oldestInvoiceDate", header: "أقدم فاتورة" },
                ],
              })
            }
          >
            تصدير Excel
          </Button>
          <Button variant="outline" size="sm" disabled={!aging.data?.length} onClick={() => printARAging({
            date: new Date().toLocaleDateString('en-GB'),
            rows: (aging.data ?? []).map(r => ({
              name: r.customerName,
              d0_30: D(r.d0_30||0).toNumber(), d31_60: D(r.d31_60||0).toNumber(),
              d61_90: D(r.d61_90||0).toNumber(), d91p: D(r.d91p||0).toNumber(),
              unpaidTotal: D(r.unpaidTotal||0).toNumber(), currentBalance: D(r.currentBalance||0).toNumber(),
            })),
            totals: {
              d0_30: D(totals.d0_30).toNumber(), d31_60: D(totals.d31_60).toNumber(),
              d61_90: D(totals.d61_90).toNumber(), d91p: D(totals.d91p).toNumber(),
              unpaidTotal: D(totals.unpaidTotal).toNumber(), currentBalance: D(totals.currentBalance).toNumber(),
            },
          })}>طباعة PDF</Button>
          <Link href="/customers-statement"><Button variant="outline">كشف حساب عميل</Button></Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        المبالغ المستحقّة <strong>لنا</strong> على العملاء، مُجمَّعة في أربع شرائح عمرية.
        الأخضر = حديث، الأحمر = متأخّر. المُسدَّد كلياً مستثنى.
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
          <Bucket label="إجمالي غير المدفوع" value={totals.unpaidTotal} color="bg-muted" emphasis />
          <Bucket label="إجمالي ما لنا عليهم" value={totals.currentBalance} color="bg-emerald-50 text-emerald-800" emphasis />
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
                <th className="p-2 text-left">إجمالي غير المدفوع</th>
                <th className="p-2 text-left">الرصيد (لنا عليه)</th>
                <th className="p-2">أقدم فاتورة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(aging.data ?? []).map((r) => (
                <tr key={r.customerId} className="border-t">
                  <td className="p-2 font-medium">{r.customerName}</td>
                  <td className="p-2 text-xs">{CUST_TYPE_LABEL[r.customerType ?? ""] ?? r.customerType ?? "—"}</td>
                  <td className="p-2"><CopyInline value={r.phone} /></td>
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

function Bucket({ label, value, color, emphasis }: { label: string; value: string; color: string; emphasis?: boolean }) {
  return (
    <div className={`rounded-md p-3 ${color}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className={`tabular-nums ${emphasis ? "text-xl font-bold" : "text-lg font-semibold"}`} dir="ltr">{fmt(value)}</div>
    </div>
  );
}
