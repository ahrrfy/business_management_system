// شاشة «الأهداف الشهرية» — تبويب في hub الموارد البشرية (وحدة الأهداف والعمولات، S2).
//
// شبكة قابلة للتحرير: هدف صافي مبيعات لكل موظف مؤهَّل (مرتبط بحساب، غير منتهي الخدمة) لشهر
// مُنتقى، مع «فعليّ الشهر السابق» مرجعاً. الحفظ دفعة واحدة (upsert)، وتفريغ الحقل يحذف الهدف.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MoneyInput } from "@/components/form/MoneyInput";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { iqd } from "@/lib/hr/ui";
import { trpc } from "@/lib/trpc";
import { CopyPlus, Save } from "lucide-react";
import { useMemo, useState } from "react";

export default function CommissionTargets() {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<string>(thisMonth());
  const grid = trpc.commissions.targets.grid.useQuery({ period });
  const rows = grid.data ?? [];

  /** المسودّة المحلية: القيم المعدَّلة فقط (مفتاحها employeeId). */
  const [draft, setDraft] = useState<Record<number, string>>({});

  // تغيير الشهر يمسح المسودّة (قيم شهر آخر لا تنتقل).
  function changePeriod(p: string) {
    setPeriod(p);
    setDraft({});
  }

  const dirtyRows = useMemo(() => {
    const out: { employeeId: number; target: string | null }[] = [];
    for (const r of rows) {
      const d = draft[r.employeeId];
      if (d === undefined) continue;
      const server = r.target != null ? String(Number(r.target)) : "";
      if (d.trim() === server.trim()) continue;
      out.push({ employeeId: r.employeeId, target: d.trim() === "" ? null : d.trim() });
    }
    return out;
  }, [rows, draft]);

  const save = trpc.commissions.targets.saveAll.useMutation({
    onSuccess: (res) => {
      notify.ok(`حُفظت الأهداف (${res.saved} حفظاً${res.removed ? `، ${res.removed} حذفاً` : ""})`);
      setDraft({});
      void utils.commissions.targets.grid.invalidate({ period });
    },
    onError: (e) => notify.err(e),
  });

  const copyPrev = trpc.commissions.targets.copyFromPrevious.useMutation({
    onSuccess: (res) => {
      notify.ok(`نُسخ ${res.copied} هدفاً من الشهر السابق`);
      setDraft({});
      void utils.commissions.targets.grid.invalidate({ period });
    },
    onError: async (e) => {
      if (e.data?.code === "CONFLICT") {
        const ok = await confirm({
          variant: "warning",
          title: "كتابة فوق أهداف قائمة",
          description: `${e.message} سيستبدل النسخُ أهدافَ الموظفين المشتركين بين الشهرين.`,
          confirmText: "اكتب فوقها",
        });
        if (ok) copyPrev.mutate({ period, overwrite: true });
        return;
      }
      notify.err(e);
    },
  });

  const totalTargets = useMemo(() => {
    let count = 0;
    for (const r of rows) {
      const d = draft[r.employeeId];
      const effective = d !== undefined ? d.trim() : r.target != null ? String(r.target) : "";
      if (effective !== "" && Number(effective) > 0) count++;
    }
    return count;
  }, [rows, draft]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الأهداف الشهرية"
        description="هدف صافي مبيعات شهري لكل موظف — تُقاس عليه شرائح خطط العمولات (نمط نسبة التحقيق). تفريغ الحقل يحذف الهدف."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <MonthPicker value={period} onChange={changePeriod} ariaLabel="شهر الأهداف" />
            <Button
              size="sm"
              variant="outline"
              disabled={copyPrev.isPending}
              onClick={() => copyPrev.mutate({ period, overwrite: false })}
            >
              <CopyPlus className="size-4" aria-hidden /> نسخ من الشهر السابق
            </Button>
            <Button size="sm" disabled={dirtyRows.length === 0 || save.isPending} onClick={() => save.mutate({ period, rows: dirtyRows })}>
              <Save className="size-4" aria-hidden />
              {save.isPending ? "جارٍ الحفظ…" : `حفظ الكل${dirtyRows.length ? ` (${dirtyRows.length})` : ""}`}
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {grid.isLoading ? "" : `${rows.length} موظفاً مؤهَّلاً — ${totalTargets} منهم له هدف لشهر ${period}`}
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الموظف</th>
                  <th className="p-2">الفرع</th>
                  <th className="p-2 text-start">فعليّ الشهر السابق</th>
                  <th className="p-2 text-start">هدف {period}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = draft[r.employeeId];
                  const value = d !== undefined ? d : r.target != null ? String(Number(r.target)) : "";
                  const server = r.target != null ? String(Number(r.target)) : "";
                  const isDirty = d !== undefined && d.trim() !== server.trim();
                  return (
                    <tr key={r.employeeId} className={`border-t ${isDirty ? "bg-accent/40" : ""}`}>
                      <td className="p-2">
                        <div className="font-medium">{r.employeeName}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.position || "—"}
                          {r.employmentStatus === "leave" ? " · في إجازة" : ""}
                        </div>
                      </td>
                      <td className="p-2 text-muted-foreground">{r.branchName || "—"}</td>
                      <td className="p-2 tabular-nums text-muted-foreground" dir="ltr">
                        {iqd(r.lastMonthActual)}
                      </td>
                      <td className="p-2">
                        <MoneyInput
                          value={value}
                          onChange={(raw) => setDraft((prev) => ({ ...prev, [r.employeeId]: raw }))}
                          decimals={0}
                          placeholder="بلا هدف"
                          className="h-8 w-40"
                          ariaLabel={`هدف ${r.employeeName}`}
                        />
                      </td>
                    </tr>
                  );
                })}
                {grid.isLoading && (
                  <tr><td colSpan={4}><LoadingState /></td></tr>
                )}
                {!grid.isLoading && rows.length === 0 && (
                  <TableEmptyRow colSpan={4} message="لا موظفين مرتبطين بحسابات مستخدمين — اربط الموظف بحسابه من شاشة الموظف أولاً." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
