import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

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
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [activeOnly, setActiveOnly] = useState(true);
  const list = trpc.digitalCards.subscriptions.list.useQuery({
    branchId,
    activeOnly,
  });

  const effectiveBranchId = branchId ?? me.data?.branchId ?? undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title="الاشتراكات وتجديداتها"
        description="يُنشأ العقد تلقائياً بعد نجاح البيع فقط. التجديد يبقى عقداً جديداً مرتبطاً بالسابق، فلا تُمس الفاتورة أو تكلفة البيع القديمة."
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="ds-branch">
              الفرع
            </label>
            <select
              id="ds-branch"
              className={selectCls}
              value={effectiveBranchId ?? ""}
              onChange={(e) =>
                setBranchId(e.target.value ? Number(e.target.value) : undefined)
              }
            >
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            الاشتراكات السارية فقط
          </label>
          <button
            type="button"
            className="text-sm text-muted-foreground underline"
            onClick={() => void utils.digitalCards.subscriptions.list.invalidate()}
          >
            تحديث
          </button>
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
