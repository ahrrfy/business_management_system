import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

/**
 * شجرة الحسابات (P0، الدفتر المزدوج) — عرضٌ للقراءة فقط في هذه المرحلة. الحسابات بياناتٌ مرجعية تُبذَر
 * بالهجرة، وكلٌّ منها مربوطٌ بالمفهوم القائم في النظام عبر «الدور النظاميّ» (systemRole) — أساسُ محرّك
 * القيود لاحقاً. لا كتابة/قيود بعد (الدفتر المزدوج يُبنى مرحلةً مرحلة).
 */
// توكنز دلالية (ثيم-آواره تلقائياً، لا ألوان خام — يمرّ حارس check:colors):
// أصول/إيراد = موجب، مصروف = سالب، التزام = تحذير، حقوق ملكية = معلومة.
const TYPE_TONE: Record<string, string> = {
  ASSET: "text-money-positive",
  LIABILITY: "text-[var(--sem-warn)]",
  EQUITY: "text-[var(--sem-info)]",
  REVENUE: "text-money-positive",
  EXPENSE: "text-money-negative",
};

/** صفُّ الحساب — مشتقٌّ من عقد `accounts.tree` فلا ينجرف عن الخادم. */
type AccountRow = RouterOutputs["accounts"]["tree"][number]["rows"][number];

const accountColumns: ColumnDef<AccountRow, unknown>[] = [
  { id: "code", header: "الرمز", accessorFn: (r) => r.code, meta: { kind: "code", width: "id" }, cell: ({ row }) => row.original.code },
  {
    id: "name",
    header: "اسم الحساب",
    accessorFn: (r) => r.name,
    meta: { width: "wide" },
    // الإزاحة تُبقي التسلسل الهرميّ مقروءاً: الرؤوس الخمسة بلا إزاحة وأبناؤها مُزاحون.
    cell: ({ row }) => <span className={row.original.parentId == null ? "" : "ps-6 inline-block"}>{row.original.name}</span>,
  },
  {
    id: "systemRole",
    header: "الدور النظاميّ (الربط)",
    accessorFn: (r) => r.systemRole ?? "",
    cell: ({ row }) =>
      row.original.systemRole ? (
        <code className="text-xs rounded bg-muted px-1.5 py-0.5" dir="ltr">
          {row.original.systemRole}
        </code>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
];

export default function ChartOfAccounts() {
  const tree = trpc.accounts.tree.useQuery();
  const groups = tree.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="شجرة الحسابات"
        description="أساس الدفتر المزدوج — كل حساب مربوطٌ بالمفهوم القائم في النظام عبر «الدور النظاميّ». عرضٌ للقراءة (المرحلة الأولى)."
      />
      {tree.isLoading && <p className="text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>}
      {!tree.isLoading && groups.length === 0 && (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">لا حسابات بعد.</CardContent></Card>
      )}
      {groups.map((g) => (
        <Card key={g.type}>
          <CardHeader className="py-3">
            <CardTitle className={`text-base ${TYPE_TONE[g.type] ?? ""}`}>{g.label}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* مُضمَّن: البطاقة تحمل عنوان المجموعة، وشريطُ حالةٍ لكل نوعِ حسابٍ ضجيجٌ لا معلومة. */}
            <DataTable<AccountRow>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              data={g.rows}
              columns={accountColumns}
              /* `!bg-…`: تلوينُ `odd:`/`even:` في `DataTable` أعلى تخصّصاً من صنف خلفيةٍ
                 عاديّ ⇒ بلا `!` تفقد الرؤوسُ الخمسةُ تمييزَها البصريّ ولا يبقى إلّا الخطّ العريض. */
              getRowClassName={(a) => (a.parentId == null ? "!bg-muted/30 font-semibold" : undefined)}
              emptyText="لا حسابات."
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
