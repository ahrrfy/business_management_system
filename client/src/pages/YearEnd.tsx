/**
 * إقفال سنوي + رولوفر Retained Earnings — adminProcedure.
 */
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useState } from "react";

// قيمة القائمة المنسدلة عندما يريد المستخدم "الشركة كلّها" حصراً (branchId=null خادمياً)
// — مُميَّزة عن "" (بلا فلتر نطاق إطلاقاً)، وAppSelect يتعامل بالنصوص فقط.
const COMPANY_WIDE = "COMPANY";

export default function YearEndPage() {
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);
  const [branchId, setBranchId] = useState<number | null>(null);

  // فلترا سجل «الإقفالات السابقة» — مستقلّان عن نموذج «إقفال سنة جديدة» أعلاه.
  const [histYear, setHistYear] = useState("");
  const [histBranch, setHistBranch] = useState("");
  const histFilters = {
    year: histYear.trim() ? Number(histYear) : undefined,
    branchId: histBranch === "" ? undefined : histBranch === COMPANY_WIDE ? null : Number(histBranch),
  };
  const histFiltered = histYear.trim() !== "" || histBranch !== "";
  const list = trpc.yearEnd.list.useQuery(histFilters);

  const closeMut = trpc.yearEnd.close.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُقفلت السنة ${r.year} — صافي الربح ${r.netProfit}`);
      utils.yearEnd.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <PageHeader
        title="الإقفال السنوي"
        description="يحسب الإيراد وتكلفة المبيعات والمصروفات من دفتر الأستاذ، يقفل الفترة حتى ٣١ كانون الأول، وينشر قيد تسوية بصافي الربح على ١ كانون الثاني من السنة التالية."
      />

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
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <span className="font-semibold">الإقفالات السابقة</span>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">السنة</Label>
              <Input
                type="number"
                value={histYear}
                onChange={(e) => setHistYear(e.target.value)}
                placeholder="كل السنوات"
                className="h-9 w-32"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">النطاق</Label>
              <AppSelect value={histBranch} onValueChange={setHistBranch} placeholder="كل النطاقات" className="w-44">
                <option value="">كل النطاقات</option>
                <option value={COMPANY_WIDE}>الشركة كلّها فقط</option>
                {branches.data?.map((b: any) => (
                  <option key={b.id} value={String(b.id)}>{b.name} ({b.code})</option>
                ))}
              </AppSelect>
            </div>
            {histFiltered && (
              <Button variant="ghost" size="sm" onClick={() => { setHistYear(""); setHistBranch(""); }}>
                إعادة ضبط
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <LoadingState />
          ) : (
            <ScrollTableShell bordered={false}>
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
                  {(list.data?.rows.length ?? 0) === 0 ? (
                    <TableEmptyRow colSpan={7} message={histFiltered ? "لا إقفالات مطابقة للفلاتر" : "لا إقفالات سابقة"} />
                  ) : (
                    list.data!.rows.map((s: any) => {
                      const net = Number(s.netProfit);
                      const isProfit = net >= 0;
                      const branchName = s.branchId == null ? "كل الفروع" : (branches.data?.find((b: any) => b.id === s.branchId)?.name ?? `فرع #${s.branchId}`);
                      return (
                        <tr key={s.id} className="hover:bg-accent/40">
                          <td className="p-2 border font-medium">{s.year}</td>
                          <td className="p-2 border">{branchName}</td>
                          <td className="p-2 border">{formatIqd(s.totalRevenue)}</td>
                          <td className="p-2 border">{formatIqd(s.totalCogs)}</td>
                          <td className="p-2 border">{formatIqd(s.totalExpenses)}</td>
                          <td className={`p-2 border font-semibold ${isProfit ? "text-money-positive" : "text-money-negative"}`}>
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
                    })
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
