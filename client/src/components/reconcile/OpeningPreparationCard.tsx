import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { Clock3, ShieldCheck } from "lucide-react";
import {
  ROLE_LABELS,
  OPENING_ALLOCATION_ROLES,
  allocationKey,
} from "@/lib/doubleEntryRoleLabels";
import { GateMetric } from "./GateMetric";
import { PANEL_TABLE, type OpeningPreparation, type OpeningRoleTotalRow } from "./types";

export function OpeningPreparationCard({
  openingPreparation,
  openingPreparationError,
  preparingOpening,
  openingAllocationAmounts,
  onOpeningAllocationAmountChange,
  busy,
  onPrepareShadow,
  onPrepareAllocatedShadow,
  onStartShadow,
}: {
  openingPreparation: OpeningPreparation | null;
  openingPreparationError: string | null;
  preparingOpening: boolean;
  openingAllocationAmounts: Record<string, string>;
  onOpeningAllocationAmountChange: (key: string, value: string) => void;
  busy: boolean;
  onPrepareShadow: () => void;
  onPrepareAllocatedShadow: () => void;
  onStartShadow: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">معاينة لقطة القطع الافتتاحية</div>
          <p className="max-w-3xl text-xs text-muted-foreground">
            اللقطة الآلية تنقل أرصدة الميزانية الفعلية عند تاريخ القطع إلى
            الدورة الجديدة. لا تعيد بناء قائمة الأرباح والخسائر التاريخية،
            ولا يجوز عرض أرقام ما قبل القطع على أنها YTD من الدفتر المزدوج.
            أول إقفال سنوي رسمي يتطلب أن تغطي الدورة السنة كاملة من 1 كانون
            الثاني.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onPrepareShadow}
        >
          <Clock3 aria-hidden className="size-4" />
          {preparingOpening ? "جارٍ إعداد المعاينة…" : "إعداد معاينة"}
        </Button>
      </div>

      {openingPreparationError && (
        <div className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          تعذّر إعداد المعاينة: {openingPreparationError}
        </div>
      )}

      {openingPreparation && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <GateMetric
              label="تاريخ القطع"
              value={openingPreparation.preview.asOf}
              ok={openingPreparation.preview.canApprove}
            />
            <GateMetric
              label="إجمالي المدين"
              value={fmt(openingPreparation.preview.totals.debit)}
              ok={openingPreparation.preview.totals.isBalanced}
            />
            <GateMetric
              label="إجمالي الدائن"
              value={fmt(openingPreparation.preview.totals.credit)}
              ok={openingPreparation.preview.totals.isBalanced}
            />
            <GateMetric
              label="مجموعات/أسطر الافتتاح"
              value={`${openingPreparation.preview.journalGroups.length}/${openingPreparation.preview.lines.length}`}
              ok={
                openingPreparation.preview.canApprove &&
                openingPreparation.preview.lines.length > 0
              }
            />
          </div>

          <DataTable<OpeningRoleTotalRow>
            {...PANEL_TABLE}
            data={openingPreparation.preview.roleTotals}
            emptyText="لا مجاميع أدوار في المعاينة."
            columns={[
              {
                id: "role",
                header: "الدور المحاسبي",
                accessorFn: (row) => ROLE_LABELS[row.role] ?? row.role,
                cell: ({ row }) => <span className="font-medium">{ROLE_LABELS[row.original.role] ?? row.original.role}</span>,
              },
              // kind: "money" يتكفّل بالمحاذاة وtabular-nums وعزل الاتّجاه ⇒ لا dir="ltr" يدويّ.
              { id: "debit", header: "مدين", accessorFn: (row) => fmt(row.debit), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.debit) },
              { id: "credit", header: "دائن", accessorFn: (row) => fmt(row.credit), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.credit) },
            ]}
          />

          {openingPreparation.preview.unallocatedOpeningBalance.scopes.length > 0 && (
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <div className="font-semibold">
                  تخصيص الرصيد الافتتاحي غير المنسوب
                </div>
                <p className="text-xs text-muted-foreground">
                  هذا ليس موازنة آلية. يوزع المحاسب الطرف المقابل لكل
                  نطاق على حسابات حقوق الملكية أو القرض الصحيحة، ويُعاد
                  بناء البصمة بعد اكتمال المبلغ بالفلس.
                </p>
              </div>
              {openingPreparation.preview.unallocatedOpeningBalance.scopes.map(
                (scope) => (
                  <div
                    key={scope.branchId ?? "GLOBAL"}
                    className="space-y-2 border-t pt-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-medium">
                        {scope.branchId == null
                          ? "نطاق الشركة العام"
                          : `الفرع رقم ${scope.branchId}`}
                      </span>
                      <span>
                        المطلوب {scope.debit !== "0.00" ? "مدين" : "دائن"}:{" "}
                        <span className="font-semibold tabular-nums" dir="ltr">
                          {fmt(
                            scope.debit !== "0.00"
                              ? scope.debit
                              : scope.credit,
                          )}
                        </span>
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {OPENING_ALLOCATION_ROLES.map((role) => {
                        const key = allocationKey(scope.branchId, role);
                        return (
                          <label key={role} className="space-y-1 text-xs font-medium">
                            {ROLE_LABELS[role] ?? role}
                            <Input
                              value={openingAllocationAmounts[key] ?? ""}
                              inputMode="decimal"
                              dir="ltr"
                              placeholder="0.00"
                              disabled={busy}
                              onChange={(event) =>
                                onOpeningAllocationAmountChange(
                                  key,
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ),
              )}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onPrepareAllocatedShadow}
              >
                إعادة المعاينة بالتخصيص
              </Button>
            </div>
          )}

          {openingPreparation.preview.blockers.length > 0 && (
            <div className="space-y-1 rounded-md border border-destructive/40 p-2">
              {openingPreparation.preview.blockers.map((item) => (
                <div key={`${item.code}-${item.source}`} className="text-sm">
                  <span className="font-medium">{item.source}:</span>{" "}
                  {item.message}
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md bg-muted/40 p-2 text-xs">
            <span className="font-medium">بصمة اللقطة:</span>{" "}
            <span className="break-all font-mono" dir="ltr">
              {openingPreparation.preview.openingHash}
            </span>
            <div className="mt-1 text-muted-foreground">
              تنتهي صلاحية التأكيد في {fmtDateTime(openingPreparation.expiresAt)}؛
              وأي تغير في الأرصدة يفرض معاينة جديدة.
            </div>
          </div>

          <Button
            type="button"
            disabled={busy || !openingPreparation.preview.canApprove}
            onClick={onStartShadow}
          >
            <ShieldCheck aria-hidden className="size-4" />
            تأكيد اللقطة وبدء وضع الظل
          </Button>
        </div>
      )}
    </div>
  );
}
