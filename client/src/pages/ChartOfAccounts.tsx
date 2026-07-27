import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TableEmptyRow } from "@/components/PageState";
import { trpc } from "@/lib/trpc";

/**
 * شجرة الحسابات (P0، الدفتر المزدوج) — عرضٌ للقراءة فقط في هذه المرحلة. الحسابات بياناتٌ مرجعية تُبذَر
 * بالهجرة، وكلٌّ منها مربوطٌ بالمفهوم القائم في النظام عبر «الدور النظاميّ» (systemRole) — أساسُ محرّك
 * القيود لاحقاً. لا كتابة/قيود بعد (الدفتر المزدوج يُبنى مرحلةً مرحلة).
 */
const TYPE_TONE: Record<string, string> = {
  ASSET: "text-emerald-600 dark:text-emerald-400",
  LIABILITY: "text-amber-600 dark:text-amber-400",
  EQUITY: "text-sky-600 dark:text-sky-400",
  REVENUE: "text-emerald-600 dark:text-emerald-400",
  EXPENSE: "text-rose-600 dark:text-rose-400",
};

export default function ChartOfAccounts() {
  const tree = trpc.accounts.tree.useQuery();
  const groups = tree.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="شجرة الحسابات"
        description="أساس الدفتر المزدوج — كل حساب مربوطٌ بالمفهوم القائم في النظام عبر «الدور النظاميّ». عرضٌ للقراءة (المرحلة الأولى)."
      />
      {tree.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
      {!tree.isLoading && groups.length === 0 && (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">لا حسابات بعد.</CardContent></Card>
      )}
      {groups.map((g) => (
        <Card key={g.type}>
          <CardHeader className="py-3">
            <CardTitle className={`text-base ${TYPE_TONE[g.type] ?? ""}`}>{g.label}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 w-24">الرمز</th>
                    <th className="p-2">اسم الحساب</th>
                    <th className="p-2">الدور النظاميّ (الربط)</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((a) => {
                    const isHeader = a.parentId == null; // الرؤوس الخمسة
                    return (
                      <tr key={a.id} className={`border-t ${isHeader ? "bg-muted/30 font-semibold" : ""}`}>
                        <td className="p-2 tabular-nums" dir="ltr">{a.code}</td>
                        <td className={`p-2 ${isHeader ? "" : "ps-6"}`}>{a.name}</td>
                        <td className="p-2">
                          {a.systemRole
                            ? <code className="text-xs rounded bg-muted px-1.5 py-0.5" dir="ltr">{a.systemRole}</code>
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {g.rows.length === 0 && <TableEmptyRow colSpan={3} message="لا حسابات." />}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
