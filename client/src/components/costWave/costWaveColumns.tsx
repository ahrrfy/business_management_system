import type { ColumnDef } from "@tanstack/react-table";
import {
  COST_WAVE_EVENT_STAGE_LABELS,
  COST_WAVE_SKIP_LABELS,
  type CostWaveEventStage,
} from "@shared/costWave";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";

type Detail = RouterOutputs["inventory"]["costWave"];
type Item = Detail["items"][number];
type Approval = Detail["approvals"][number];
type Event = Detail["events"][number];
type SkippedItem = Detail["skipped"][number];

export const COST_WAVE_ITEM_COLUMNS: ColumnDef<Item, unknown>[] = [
  {
    accessorKey: "productNameSnapshot",
    header: "المنتج / المتغيّر",
    cell: ({ row }) => (
      <div>
        <div className="font-semibold">{row.original.productNameSnapshot}</div>
        <div className="text-xs text-muted-foreground">
          {row.original.variantLabelSnapshot || "—"} ·{" "}
          {row.original.skuSnapshot || "بلا SKU"}
        </div>
      </div>
    ),
  },
  {
    accessorKey: "categoryNameSnapshot",
    header: "الفئة",
    cell: ({ row }) => row.original.categoryNameSnapshot || "—",
  },
  {
    accessorKey: "oldCost",
    header: "التكلفة السابقة",
    cell: ({ row }) => formatIqd(row.original.oldCost),
    meta: { kind: "money" },
  },
  {
    accessorKey: "newCost",
    header: "التكلفة الجديدة",
    cell: ({ row }) => (
      <span className="font-bold">{formatIqd(row.original.newCost)}</span>
    ),
    meta: { kind: "money" },
  },
  {
    accessorKey: "expectedQuantity",
    header: "الكمية",
    cell: ({ row }) =>
      row.original.expectedQuantity.toLocaleString("ar-IQ-u-nu-latn"),
    meta: { kind: "number" },
  },
  {
    id: "branches",
    header: "لقطة الفروع",
    accessorFn: (row) =>
      row.branchQuantities
        .map(
          (branch) =>
            `${branch.branchName || `#${branch.branchId}`}: ${branch.quantity}`,
        )
        .join(" · "),
    cell: ({ row }) => (
      <div className="max-w-72 text-xs leading-6">
        {row.original.branchQuantities.length
          ? row.original.branchQuantities.map((branch) => (
              <span key={branch.branchId} className="me-2 inline-block">
                {branch.branchName || `فرع #${branch.branchId}`}: {" "}
                <b>{branch.quantity}</b>
              </span>
            ))
          : "لا رصيد حالي"}
      </div>
    ),
  },
  {
    accessorKey: "inventoryValueBefore",
    header: "قيمة المخزون قبل",
    cell: ({ row }) => formatIqd(row.original.inventoryValueBefore),
    meta: { kind: "money" },
  },
  {
    accessorKey: "inventoryValueAfter",
    header: "قيمة المخزون بعد",
    cell: ({ row }) => formatIqd(row.original.inventoryValueAfter),
    meta: { kind: "money" },
  },
  {
    accessorKey: "expectedValueDelta",
    header: "فرق القيمة",
    cell: ({ row }) => (
      <bdi dir="ltr">{formatIqd(row.original.expectedValueDelta)}</bdi>
    ),
    meta: { kind: "money" },
  },
];

export const COST_WAVE_APPROVAL_COLUMNS: ColumnDef<Approval, unknown>[] = [
  {
    accessorKey: "approverName",
    header: "صاحب القرار",
    cell: ({ row }) =>
      row.original.approverName || `مستخدم #${row.original.approverId}`,
  },
  {
    accessorKey: "decision",
    header: "القرار",
    cell: ({ row }) => (
      <Badge variant={row.original.decision === "APPROVED" ? "success" : "danger"}>
        {row.original.decision === "APPROVED" ? "اعتماد" : "رفض"}
      </Badge>
    ),
  },
  {
    accessorKey: "decidedAt",
    header: "التاريخ والوقت",
    cell: ({ row }) => fmtDateTime(row.original.decidedAt),
    meta: { kind: "datetime" },
  },
  {
    accessorKey: "reason",
    header: "الملاحظة / السبب",
    cell: ({ row }) => row.original.reason || "—",
  },
  {
    accessorKey: "snapshotFingerprint",
    header: "بصمة اللقطة",
    cell: ({ row }) => (
      <code dir="ltr" className="text-xs">
        {row.original.snapshotFingerprint.slice(0, 12)}…
      </code>
    ),
  },
];

export const COST_WAVE_EVENT_COLUMNS: ColumnDef<Event, unknown>[] = [
  {
    accessorKey: "stage",
    header: "المرحلة",
    cell: ({ row }) =>
      COST_WAVE_EVENT_STAGE_LABELS[
        row.original.stage as CostWaveEventStage
      ] ?? row.original.stage,
  },
  {
    accessorKey: "actorName",
    header: "نفّذها",
    cell: ({ row }) =>
      row.original.actorName || `مستخدم #${row.original.actorUserId}`,
  },
  {
    accessorKey: "createdAt",
    header: "التاريخ والوقت",
    cell: ({ row }) => fmtDateTime(row.original.createdAt),
    meta: { kind: "datetime" },
  },
  {
    accessorKey: "snapshotFingerprint",
    header: "بصمة اللقطة",
    cell: ({ row }) => (
      <code dir="ltr" className="text-xs">
        {row.original.snapshotFingerprint.slice(0, 16)}…
      </code>
    ),
  },
];

export const COST_WAVE_SKIPPED_COLUMNS: ColumnDef<SkippedItem, unknown>[] = [
  { accessorKey: "productName", header: "المنتج" },
  { accessorKey: "variantLabel", header: "المتغيّر" },
  { accessorKey: "sku", header: "SKU" },
  {
    accessorKey: "oldCost",
    header: "التكلفة الحالية",
    cell: ({ row }) => formatIqd(row.original.oldCost),
    meta: { kind: "money" },
  },
  {
    accessorKey: "reason",
    header: "سبب الاستبعاد",
    cell: ({ row }) => COST_WAVE_SKIP_LABELS[row.original.reason],
  },
];
