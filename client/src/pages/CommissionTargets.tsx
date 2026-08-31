// شاشة «الأهداف الشهرية» — تبويب في hub الموارد البشرية (وحدة الأهداف والعمولات، S2).
//
// شبكة قابلة للتحرير: هدف صافي مبيعات لكل موظف مؤهَّل (مرتبط بحساب، غير منتهي الخدمة) لشهر
// مُنتقى، مع «فعليّ الشهر السابق» مرجعاً. الحفظ دفعة واحدة (upsert)، وتفريغ الحقل يحذف الهدف.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppSelect } from "@/components/ui/AppSelect";
import { MoneyInput } from "@/components/form/MoneyInput";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { CommissionGuide } from "@/components/commissions/CommissionGuide";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { iqd } from "@/lib/hr/ui";
import { employmentStatusLabel } from "@shared/hr";
import { trpc } from "@/lib/trpc";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { CopyPlus, Save, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

export default function CommissionTargets() {
  const utils = trpc.useUtils();
  // بوّابة عرض مطابقة للخادم: الكتابة commissionsManagerProcedure(["manager"],"commissions","FULL")
  // — نفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية) ⇒ لا تباعُد. القراءة (accountant/auditor) شبكة للعرض فقط.
  const me = trpc.auth.me.useQuery();
  const canWrite = !!me.data?.role &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "commissions", "FULL", ["manager"]);
  const [period, setPeriod] = useState<string>(thisMonth());
  const grid = trpc.commissions.targets.grid.useQuery({ period });
  const rows = grid.data ?? [];

  /** المسوّدة المحلية: القيم المعدَّلة فقط (مفتاحها employeeId). */
  const [draft, setDraft] = useState<Record<number, string>>({});

  // تغيير الشهر يمسح المسوّدة (قيم شهر آخر لا تنتقل).
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

  // حارس فقد بيانات: مسوّدة غير محفوظة (تعديل هدف واحد أو أكثر) يستحقّ تحذيراً قبل مغادرة الصفحة.
  useUnsavedGuard(dirtyRows.length > 0);

  // فلتر فرع + بحث موظف — عميليان بحتان فوق الشبكة المحمَّلة كاملةً؛ لا يمسّان draft (التعديلات
  // المخفيّة خلف الفلتر تبقى محفوظة في المسوّدة وتُرسَل مع «حفظ الكل»).
  const [f, setF] = useUrlFilters({ q: "", branch: "" });
  const filteredRows = useMemo(() => {
    const needle = f.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (f.branch && r.branchName !== f.branch) return false;
      if (needle && !r.employeeName.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, f.q, f.branch]);
  const branchOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) if (r.branchName) names.add(r.branchName);
    return Array.from(names).sort((a, b) => a.localeCompare(b, "ar"));
  }, [rows]);

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
        description="حدّد لكل موظف مبلغ المبيعات المطلوب منه هذا الشهر. تُقاس عليه مستويات الخطط التي تحتسب «حسب نسبة تحقيق الهدف» — أمّا خطط «مبلغ المبيعات» فلا تحتاج هدفاً. اترك الحقل فارغاً لإلغاء هدف الموظف."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <MonthPicker value={period} onChange={changePeriod} ariaLabel="شهر الأهداف" />
            {canWrite && (
              <>
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
              </>
            )}
          </div>
        }
      />

      <CommissionGuide />

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {grid.isLoading ? "" : `${filteredRows.length} موظفاً — ${totalTargets} منهم له هدف محدَّد لشهر ${period}`}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={f.q} onChange={(e) => setF({ q: e.target.value })} placeholder="بحث بالموظف…" aria-label="بحث بالموظف" className="h-8 w-full pr-8 sm:w-44" />
            </div>
            <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })} className="h-8 w-36" size="sm" placeholder="كل الفروع">
              <option value="">كل الفروع</option>
              {branchOptions.map((name) => <option key={name} value={name}>{name}</option>)}
            </AppSelect>
            {(f.q.trim() !== "" || f.branch !== "") && (
              <Button variant="ghost" size="sm" onClick={() => setF({ q: "", branch: "" })} className="text-muted-foreground">
                <X aria-hidden className="size-4" /> مسح
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">الموظف</th>
                  <th className="p-2 text-start">الفرع</th>
                  <th className="p-2 text-start whitespace-nowrap">ما باعه فعلاً الشهر الماضي</th>
                  <th className="p-2 text-start whitespace-nowrap">هدفه لشهر {period} (د.ع)</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const d = draft[r.employeeId];
                  const value = d !== undefined ? d : r.target != null ? String(Number(r.target)) : "";
                  const server = r.target != null ? String(Number(r.target)) : "";
                  const isDirty = d !== undefined && d.trim() !== server.trim();
                  return (
                    <tr key={r.employeeId} className={`border-t ${isDirty ? "bg-accent/40" : ""}`}>
                      <td className="p-2">
                        <div className="font-medium whitespace-nowrap">{r.employeeName}</div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap">
                          {r.position || "—"}
                          {r.employmentStatus === "leave" ? ` · ${employmentStatusLabel("leave")}` : ""}
                        </div>
                      </td>
                      <td className="p-2 text-muted-foreground">{r.branchName || "—"}</td>
                      <td className="p-2 tabular-nums text-muted-foreground" dir="ltr">
                        {iqd(r.lastMonthActual)}
                      </td>
                      <td className="p-2">
                        {canWrite ? (
                          <MoneyInput
                            value={value}
                            onChange={(raw) => setDraft((prev) => ({ ...prev, [r.employeeId]: raw }))}
                            decimals={0}
                            placeholder="بلا هدف"
                            className="h-8 w-40"
                            ariaLabel={`هدف ${r.employeeName}`}
                          />
                        ) : (
                          <span className="tabular-nums" dir="ltr">{r.target != null ? iqd(r.target) : "—"}</span>
                        )}
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
                {!grid.isLoading && rows.length > 0 && filteredRows.length === 0 && (
                  <TableEmptyRow colSpan={4} message="لا موظفين مطابقين للفلاتر." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
