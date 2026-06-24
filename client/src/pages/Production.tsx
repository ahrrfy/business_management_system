import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { fmt, fmtInt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Row = RouterOutputs["production"]["list"][number];

export default function Production() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin" || role === "manager";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });

  const [status, setStatus] = useState<"" | "CONFIRMED" | "CANCELLED">("");
  const [branchId, setBranchId] = useState<number | "">("");
  const [q, setQ] = useState("");

  const list = trpc.production.list.useQuery({
    status: status || undefined,
    branchId: branchId ? Number(branchId) : undefined,
    limit: 300,
  }, { enabled: me.data != null });

  const rows: Row[] = list.data ?? [];
  const filtered = useMemo(() => {
    const term = q.trim();
    if (!term) return rows;
    return rows.filter((r) => String(r.docNumber).includes(term) || String(r.branchName ?? "").includes(term));
  }, [rows, q]);

  function exportAll() {
    if (filtered.length === 0) return;
    exportRows(filtered, {
      filename: "مستندات-الإنتاج",
      columns: [
        { key: "docNumber", header: "رقم المستند" },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "outputQty", header: "كمية المخرجات", map: (r) => r.outputQty },
        { key: "materialsCost", header: "كلفة المواد", map: (r) => r.materialsCost },
        { key: "laborCost", header: "العمالة", map: (r) => r.laborCost },
        { key: "totalCost", header: "الكلفة الكلية", map: (r) => r.totalCost },
        { key: "status", header: "الحالة", map: (r) => (r.status === "CANCELLED" ? "ملغى" : "مُرحَّل") },
        { key: "createdAt", header: "التاريخ", map: (r) => fmtDateTime(r.createdAt) },
      ],
    });
  }

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="الإنتاج والتحويل"
        description="تحويل المخزون إلى منتجات (ملازم/كتب/أكياس). يُخصم المدخل ويُنتَج المخرَج بكلفته الحقيقية."
        actions={<Link href="/production/new"><Button>＋ مستند إنتاج جديد</Button></Link>}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="space-y-1">
            <Label>الحالة</Label>
            <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as any)}>
              <option value="">— الكل —</option>
              <option value="CONFIRMED">مُرحَّل</option>
              <option value="CANCELLED">ملغى</option>
            </select>
          </div>
          {canPickBranch && (
            <div className="space-y-1">
              <Label>الفرع</Label>
              <select className={selectCls} value={branchId === "" ? "" : String(branchId)} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label>بحث (رقم/فرع)</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="PRD-…" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">المستندات <span className="text-xs text-muted-foreground font-normal">({filtered.length})</span></CardTitle>
          <Button variant="outline" size="sm" disabled={filtered.length === 0} onClick={exportAll}>تصدير Excel</Button>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2">رقم المستند</th>
                <th className="p-2">الفرع</th>
                <th className="p-2 text-center">كمية المخرجات</th>
                <th className="p-2 text-left">الكلفة الكلية</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2">التاريخ</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={Number(r.id)} className="border-t">
                  <td className="p-2 font-mono" dir="ltr">{r.docNumber}</td>
                  <td className="p-2 text-xs">{r.branchName}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{fmtInt(r.outputQty)}</td>
                  <td className="p-2 text-left tabular-nums" dir="ltr">{fmt(r.totalCost)}</td>
                  <td className="p-2 text-center">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.status === "CANCELLED" ? "badge-status-cancelled" : "badge-status-active"}`}>
                      {r.status === "CANCELLED" ? "ملغى" : "مُرحَّل"}
                    </span>
                  </td>
                  <td className="p-2 text-xs whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                  <td className="p-2 text-center"><Link href={`/production/${Number(r.id)}`} className="text-sky-700 text-sm">فتح</Link></td>
                </tr>
              ))}
              {!list.isLoading && filtered.length === 0 && (
                <TableEmptyRow colSpan={7} message="لا مستندات إنتاج بعد." />
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
