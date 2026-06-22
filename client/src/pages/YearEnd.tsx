/**
 * إقفال سنوي + رولوفر Retained Earnings — adminProcedure.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useState } from "react";

export default function YearEndPage() {
  const utils = trpc.useUtils();
  const list = trpc.yearEnd.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);
  const [branchId, setBranchId] = useState<number | null>(null);

  const closeMut = trpc.yearEnd.close.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُقفلت السنة ${r.year} — صافي الربح ${r.netProfit}`);
      utils.yearEnd.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <h1 className="text-2xl font-bold">الإقفال السنوي</h1>
      <p className="text-sm text-muted-foreground">
        يحسب revenue/cogs/expenses من دفتر الأستاذ، يقفل الفترة حتى Dec 31، وينشر قيد ADJUST بقيمة net profit على Jan 1 من السنة التالية.
      </p>

      <Card>
        <CardHeader className="font-semibold">إقفال سنة جديدة</CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <label className="text-sm font-medium">السنة</label>
              <input
                type="number"
                value={year}
                min={2020}
                max={2100}
                onChange={(e) => setYear(Number(e.target.value) || currentYear - 1)}
                className="h-9 px-3 rounded-md border bg-transparent text-sm"
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium">نطاق الإقفال</label>
              <select
                value={branchId ?? ""}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
                className="h-9 px-3 rounded-md border bg-transparent text-sm"
              >
                <option value="">الشركة كلّها</option>
                {branches.data?.map((b: any) => (
                  <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                ))}
              </select>
            </div>
          </div>

          <Button
            onClick={async () => {
              const scope = branchId ? `فرع #${branchId}` : "الشركة كلّها";
              if (await confirm({ title: `إقفال سنة ${year}`, description: `سيُغلق الكتابة على هذه الفترة (${scope}) ⇒ أي قيد بتاريخ السنة ${year} سيُرفَض. لفتح الإقفال يحتاج تدخّل المسؤول.`, variant: "danger" })) {
                closeMut.mutate({ year, branchId: branchId ?? undefined });
              }
            }}
            disabled={closeMut.isPending}
            variant="destructive"
          >
            تطبيق الإقفال
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-semibold">الإقفالات السابقة</CardHeader>
        <CardContent>
          {list.isLoading ? (
            <p className="text-muted-foreground">جاري التحميل…</p>
          ) : (list.data?.rows.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-sm">لا إقفالات سابقة</p>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-right p-2 border">السنة</th>
                    <th className="text-right p-2 border">الفرع</th>
                    <th className="text-right p-2 border">الإيراد</th>
                    <th className="text-right p-2 border">التكلفة</th>
                    <th className="text-right p-2 border">المصاريف</th>
                    <th className="text-right p-2 border">صافي الربح</th>
                    <th className="text-right p-2 border">تاريخ الإقفال</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data!.rows.map((s: any) => {
                    const net = Number(s.netProfit);
                    const isProfit = net >= 0;
                    return (
                      <tr key={s.id} className="hover:bg-accent/40">
                        <td className="p-2 border font-medium">{s.year}</td>
                        <td className="p-2 border">{s.branchId ?? "كل الفروع"}</td>
                        <td className="p-2 border">{formatIqd(s.totalRevenue)}</td>
                        <td className="p-2 border">{formatIqd(s.totalCogs)}</td>
                        <td className="p-2 border">{formatIqd(s.totalExpenses)}</td>
                        <td className={`p-2 border font-semibold ${isProfit ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>
                          <span className="inline-flex items-center gap-1.5" aria-label={isProfit ? "ربح" : "خسارة"}>
                            {isProfit
                              ? <TrendingUp className="size-4" aria-hidden="true" />
                              : <TrendingDown className="size-4" aria-hidden="true" />}
                            {isProfit ? formatIqd(net) : `(${formatIqd(Math.abs(net))})`}
                          </span>
                        </td>
                        <td className="p-2 border text-muted-foreground">{fmtDate(s.closedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
