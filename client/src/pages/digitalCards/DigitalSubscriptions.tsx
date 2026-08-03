import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField, ListToolbar } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { trpc } from "@/lib/trpc";

const STATUS: Record<string, string> = {
  ACTIVE: "ساري",
  EXPIRED: "منتهٍ",
  CANCELLED: "ملغى",
};

function localDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("ar-IQ");
}

export default function DigitalSubscriptions() {
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const me = trpc.auth.me.useQuery();
  const canPickBranch = me.data?.role === "admin" || me.data?.role === "manager";

  // فرع صريح: المرتفعون يختارون فرعاً بعينه أو «كل الفروع»؛ غيرهم مقصور على فرعه خادمياً بصرف
  // النظر عمّا يُرسَل (لا منتقي لهم — عرضٌ للمرتفع فقط، نمط AbcAnalysis/InventoryOpsReport).
  const [f, setF, resetF] = useUrlFilters({ branch: "", q: "", expiring: "", status: "" });

  const list = trpc.digitalCards.subscriptions.list.useQuery({
    branchId: f.branch ? Number(f.branch) : undefined,
    q: f.q.trim() || undefined,
    expiring: f.expiring ? true : undefined,
    status: (f.status as "ACTIVE" | "EXPIRED" | "CANCELLED" | "") || undefined,
  });

  const activeFilterCount = [f.branch, f.expiring, f.status].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="الاشتراكات وتجديداتها"
        description="يُنشأ العقد تلقائياً بعد نجاح البيع فقط. التجديد يبقى عقداً جديداً مرتبطاً بالسابق، فلا تُمس الفاتورة أو تكلفة البيع القديمة."
      />

      <Card>
        <CardContent className="p-4">
          <ListToolbar
            title="الاشتراكات"
            count={list.data?.length}
            loading={list.isLoading}
            search={{
              value: f.q,
              onChange: (v) => setF({ q: v }),
              placeholder: "بحث باسم الطالب…",
              ariaLabel: "بحث باسم الطالب",
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            onRefresh={() => void utils.digitalCards.subscriptions.list.invalidate()}
            refreshing={list.isFetching}
            filters={
              <>
                {canPickBranch && (
                  <FilterField label="الفرع" className="w-40">
                    <AppSelect
                      size="sm"
                      value={f.branch}
                      onValueChange={(v) => setF({ branch: v })}
                    >
                      <option value="">— كل الفروع —</option>
                      {(branches.data ?? []).map((branch) => (
                        <option key={branch.id} value={String(branch.id)}>
                          {branch.name}
                        </option>
                      ))}
                    </AppSelect>
                  </FilterField>
                )}
                <FilterField label="الحالة" className="w-32">
                  <AppSelect size="sm" value={f.status} onValueChange={(v) => setF({ status: v })}>
                    <option value="">الكل</option>
                    <option value="ACTIVE">ساري</option>
                    <option value="EXPIRED">منتهٍ</option>
                    <option value="CANCELLED">ملغى</option>
                  </AppSelect>
                </FilterField>
                <label className="flex h-8 items-center gap-2 self-end pb-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={f.expiring === "1"}
                    onChange={(e) => setF({ expiring: e.target.checked ? "1" : "" })}
                  />
                  تنتهي خلال أسبوع
                </label>
              </>
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">الطالب</th>
                  <th className="p-2 text-start">الاشتراك</th>
                  <th className="p-2 text-start">يبدأ</th>
                  <th className="p-2 text-start">ينتهي</th>
                  <th className="p-2 text-start">المدة</th>
                  <th className="p-2 text-start">التجديد</th>
                  <th className="p-2 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((subscription) => (
                  <tr key={subscription.id} className="border-t">
                    <td className="p-2 font-medium">{subscription.studentName}</td>
                    <td className="p-2">{subscription.offeringName}</td>
                    <td className="p-2 tabular-nums">{localDate(subscription.startsAt)}</td>
                    <td className="p-2 tabular-nums">{localDate(subscription.expiresAt)}</td>
                    <td className="p-2 tabular-nums">{subscription.durationDays} يوم</td>
                    <td className="p-2 text-muted-foreground">
                      {subscription.previousContractId ? `تجديد عقد #${subscription.previousContractId}` : "أول اشتراك"}
                    </td>
                    <td className="p-2 text-center">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                          subscription.status === "ACTIVE"
                            ? "badge-status-active"
                            : subscription.status === "EXPIRED"
                              ? "badge-stock-out"
                              : "badge-status-neutral"
                        }`}
                      >
                        {STATUS[subscription.status] ?? subscription.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr>
                    <td colSpan={7}>
                      <LoadingState />
                    </td>
                  </tr>
                )}
                {!list.isLoading && (list.data?.length ?? 0) === 0 && (
                  <TableEmptyRow
                    colSpan={7}
                    message="لا اشتراكات مطابقة. عند بيع اشتراك تعليمي ناجح يظهر عقده هنا تلقائياً."
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
