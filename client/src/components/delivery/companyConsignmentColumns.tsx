import { Ban, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtDate } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { type RouterOutputs, type RouterInputs } from "@/lib/trpc";
type ConsignmentRow = RouterOutputs["delivery"]["consignments"]["rows"][number];
export function moneyCol<T>(
  id: string,
  header: string,
  get: (r: T) => string | number | null | undefined,
  display?: (r: T) => string,
  cls?: (r: T) => string | undefined,
): ColumnDef<T, unknown> {
  return {
    id,
    header,
    accessorFn: (r) => (display ? display(r) : fmt(get(r))),
    meta: { kind: "money" },
    sortDescFirst: true,
    sortingFn: (a, b) => D(get(a.original) ?? 0).cmp(D(get(b.original) ?? 0)),
    cell: ({ row }) => (
      <span className={cls?.(row.original)}>
        {display ? display(row.original) : fmt(get(row.original))}
      </span>
    ),
  };
}

export const CN_STATUS: Record<string, { label: string; cls: string }> = {
  NOT_APPLICABLE: { label: "لا تحصيل", cls: "bg-muted text-muted-foreground" },
  UNSETTLED: { label: "غير مورّد", cls: "badge-stock-low" },
  DISPATCHED: { label: "غير مسوّاة", cls: "badge-stock-low" },
  PARTIAL: { label: "سُوّيت جزئياً", cls: "badge-stock-low" },
  SETTLED: { label: "مسوّاة", cls: "badge-status-active" },
  CANCELLED: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
  DELIVERED: { label: "مسوّاة", cls: "badge-status-active" },
  RETURNED: { label: "أُرجعت", cls: "bg-muted text-muted-foreground" },
  WRITTEN_OFF: { label: "شُطبت", cls: "badge-stock-out" },
};

export const PARCEL_STATUS: Record<string, string> = {
  ASSIGNED: "مسند",
  ACCEPTED: "مقبول",
  PICKED_UP: "استلمه السائق",
  OUT_FOR_DELIVERY: "خرج للتوصيل",
  DELIVERED: "وصل العميل",
  FAILED: "تعذر التوصيل",
  RETURNED: "مرتجع",
};

type CompanyConsignmentOptions = {
  canEdit: boolean;
  canSettle: boolean;
  partyId: number;
  drivers: RouterOutputs["delivery"]["partyMembers"];
  reassignM: {
    isPending: boolean;
    mutate: (input: RouterInputs["delivery"]["reassignConsignment"]) => void;
  };
  setCollectConsignmentTarget: (row: ConsignmentRow) => void;
  setCancelConsignmentTarget: (row: { id: number; number: string }) => void;
  setTimelineId: (id: number) => void;
  setReturnTarget: (row: { consignmentId: number; label: string }) => void;
};

export function CompanyConsignmentActions({
  c,
  canEdit,
  canSettle,
  setCollectConsignmentTarget,
  setCancelConsignmentTarget,
  setTimelineId,
  setReturnTarget,
}: CompanyConsignmentOptions & { c: ConsignmentRow }) {
  const remaining = D(c.remainingDue);
  const canRemit =
    c.parcelStatus === "DELIVERED" &&
    c.moneyStatus !== "SETTLED" &&
    remaining.gt(0);
  const canCancel =
    (c.parcelStatus === "ASSIGNED" ||
      c.parcelStatus === "OUT_FOR_DELIVERY" ||
      c.parcelStatus === "FAILED") &&
    D(c.collectedAmount).isZero() &&
    D(c.counterSettledAmount).isZero() &&
    D(c.shortfallAssigned).isZero();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => setTimelineId(c.id)}
      >
        التفاصيل
      </Button>
      {canEdit &&
        ["DISPATCHED", "PARTIAL"].includes(c.status) &&
        (c.parcelStatus === "FAILED" || c.returnDeclaredAt != null) && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() =>
              setReturnTarget({
                consignmentId: c.id,
                label: c.consignmentNumber,
              })
            }
          >
            استلام المرتجع
          </Button>
        )}
      {canSettle && canRemit && (
        <Button
          size="sm"
          variant="default"
          className="h-7 px-2 text-xs font-bold gap-1"
          onClick={() => setCollectConsignmentTarget(c)}
          title="قبض وتحصيل هذا الطرد فوراً"
        >
          <Wallet aria-hidden className="size-3" /> سجّل التحصيل
        </Button>
      )}
      {canEdit && canCancel && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() =>
            setCancelConsignmentTarget({
              id: Number(c.id),
              number: c.consignmentNumber,
            })
          }
          title="إلغاء إسناد الطرد للمندوب وتحرير العهدة"
        >
          <Ban aria-hidden className="size-3" /> إلغاء الإسناد
        </Button>
      )}
    </div>
  );
}

export function CompanyConsignmentDriver({
  c,
  canEdit,
  partyId,
  drivers,
  reassignM,
}: CompanyConsignmentOptions & { c: ConsignmentRow }) {
  return (
    <div className="text-xs">
      <div className="mb-1">{c.assignedUserName ?? "طابور الشركة المشترك"}</div>
      {c.failureReason && (
        <div className="mb-1 text-destructive">{c.failureReason}</div>
      )}
      {canEdit &&
        (c.parcelStatus === "ASSIGNED" ||
          c.parcelStatus === "OUT_FOR_DELIVERY" ||
          c.parcelStatus === "FAILED") && (
          <AppSelect
            value={String(c.assignedUserId ?? "")}
            disabled={reassignM.isPending}
            onValueChange={(next) =>
              reassignM.mutate({
                partyId,
                consignmentId: Number(c.id),
                assignedUserId: next ? Number(next) : null,
                clientRequestId: crypto.randomUUID(),
              })
            }
            className="px-2 py-1"
          >
            <option value="">مشترك لكل السائقين</option>
            {drivers.map((d) => (
              <option key={d.userId} value={d.userId}>
                {d.name ?? d.username ?? "#" + d.userId}
              </option>
            ))}
          </AppSelect>
        )}
    </div>
  );
}

export function companyConsignmentColumns(
  options: CompanyConsignmentOptions,
): ColumnDef<ConsignmentRow, unknown>[] {
  const {
    canEdit,
    canSettle,
    partyId,
    drivers,
    reassignM,
    setCollectConsignmentTarget,
    setCancelConsignmentTarget,
    setTimelineId,
    setReturnTarget,
  } = options;
  return [
    {
      id: "actions",
      header: "الإجراءات",
      enableSorting: false,
      meta: { kind: "actions", align: "start" },
      cell: ({ row }) => (
        <CompanyConsignmentActions {...options} c={row.original} />
      ),
    },
    {
      id: "consignmentNumber",
      header: "الإرسالية",
      accessorFn: (c) => c.consignmentNumber,
      meta: { kind: "code" },
      cell: ({ row }) => (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setTimelineId(row.original.id)}
        >
          {row.original.consignmentNumber}
        </Button>
      ),
    },
    {
      id: "invoice",
      header: "الفاتورة",
      accessorFn: (c) =>
        c.invoiceId ? (c.invoiceNumber ?? "#" + c.invoiceId) : "—",
      meta: { kind: "code" },
      cell: ({ row }) =>
        row.original.invoiceId ? (
          <a
            className="text-xs text-primary hover:underline"
            dir="ltr"
            href={"/invoices/" + row.original.invoiceId}
          >
            {row.original.invoiceNumber ?? "#" + row.original.invoiceId}
          </a>
        ) : (
          "—"
        ),
    },
    {
      id: "customer",
      header: "العميل/المستلم",
      accessorFn: (c) => c.customerName ?? c.recipientName ?? "عميل نقدي",
      meta: { width: "wide" },
      cell: ({ row }) =>
        row.original.customerName ?? row.original.recipientName ?? "عميل نقدي",
    },
    moneyCol<ConsignmentRow>("cod", "COD", (c) => c.codAmount),
    moneyCol<ConsignmentRow>(
      "collected",
      "سوي بالتوريد",
      (c) => c.collectedAmount,
    ),
    moneyCol<ConsignmentRow>(
      "counter",
      "سوي في المكتبة",
      (c) => c.counterSettledAmount,
    ),
    moneyCol<ConsignmentRow>(
      "shortfall",
      "عجز محمل",
      (c) => c.shortfallAssigned,
    ),
    {
      id: "tracking",
      header: "التتبع",
      accessorFn: (c) => c.externalTrackingRef ?? "—",
      meta: { kind: "code" },
    },
    {
      id: "phone",
      header: "الهاتف",
      accessorFn: (c) => c.customerPhone ?? "—",
      meta: { kind: "code" },
    },
    moneyCol<ConsignmentRow>(
      "remaining",
      "المتبقي",
      (c) => c.remainingDue,
      undefined,
      (c) =>
        D(c.remainingDue).gt(0) ? "font-bold text-destructive" : "font-bold",
    ),
    {
      id: "moneyStatus",
      header: "حالة التسوية",
      accessorFn: (c) => CN_STATUS[c.moneyStatus]?.label ?? c.moneyStatus,
      meta: { kind: "status" },
      cell: ({ row }) => {
        const st = CN_STATUS[row.original.moneyStatus] ?? {
          label: row.original.moneyStatus,
          cls: "bg-muted",
        };
        return (
          <span className={cn("rounded px-2 py-0.5 text-xs font-bold", st.cls)}>
            {st.label}
          </span>
        );
      },
    },
    {
      id: "parcelStatus",
      header: "التسليم للعميل",
      accessorFn: (c) => PARCEL_STATUS[c.parcelStatus] ?? c.parcelStatus,
      meta: { kind: "status" },
      cell: ({ row }) => (
        <div className="text-xs">
          <Badge
            variant={
              row.original.parcelStatus === "DELIVERED"
                ? "success"
                : row.original.parcelStatus === "FAILED"
                  ? "danger"
                  : "info"
            }
          >
            {PARCEL_STATUS[row.original.parcelStatus] ??
              row.original.parcelStatus}
          </Badge>
          {row.original.courierDeliveredAt && (
            <div className="mt-1 text-money-positive">
              {fmtDate(row.original.courierDeliveredAt)}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "driver",
      header: "السائق والحركة",
      accessorFn: (c) => c.assignedUserName ?? "طابور الشركة المشترك",
      meta: { width: "wide", wrap: true },
      enableSorting: false,
      cell: ({ row }) => (
        <CompanyConsignmentDriver {...options} c={row.original} />
      ),
    },
    {
      id: "dispatchedAt",
      header: "ارسلت",
      accessorFn: (c) => (c.dispatchedAt ? fmtDate(c.dispatchedAt) : "—"),
      meta: { kind: "date" },
      cell: ({ row }) =>
        row.original.dispatchedAt ? fmtDate(row.original.dispatchedAt) : "—",
    },
    {
      id: "remittanceNumber",
      header: "التوريد",
      accessorFn: (c) => c.remittanceNumber ?? "—",
      meta: { kind: "code" },
      cell: ({ row }) =>
        row.original.remittanceNumber ? (
          <span className="text-xs">{row.original.remittanceNumber}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];
}
