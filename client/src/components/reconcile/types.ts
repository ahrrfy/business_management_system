import type { RouterInputs, RouterOutputs } from "@/lib/trpc";
import type { OpeningAllocationRole } from "@/lib/doubleEntryRoleLabels";

export type Row = {
  entity: string;
  id: number;
  expected: string;
  actual: string;
  drift: string;
  note?: string;
};

export type ReconcileData = RouterOutputs["reports"]["reconcile"];
export type DoubleEntryData = ReconcileData["doubleEntry"];
export type ActivationData = ReconcileData["activation"];
export type OpeningPreparation = RouterOutputs["reports"]["prepareDoubleEntryShadow"];
export type OpeningAllocation = NonNullable<
  RouterInputs["reports"]["prepareDoubleEntryShadow"]["allocations"]
>[number];

/** صفوفٌ مشتقّة من عقد الخادم فلا تنجرف عنه. */
export type OperationalMismatchRow = NonNullable<
  ActivationData["operationalReconciliation"]
>["mismatches"][number];
export type OpeningRoleTotalRow = OpeningPreparation["preview"]["roleTotals"][number];
export type DoubleEntryRoleRow = DoubleEntryData["roles"][number];

/** جداول هذه الشاشة كلّها مُضمَّنة في بطاقاتٍ/أقسامٍ تحمل عناوينها وعدَّها ⇒ بلا شريط حالة. */
export const PANEL_TABLE = {
  embedded: true,
  searchable: false,
  bounded: false,
  pageSize: Infinity,
} as const;
