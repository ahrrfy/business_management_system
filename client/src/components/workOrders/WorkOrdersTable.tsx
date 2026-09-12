import { useMemo } from "react";
import {
  Calendar,
  CheckCircle2,
  ChevronRight,
  Package,
  Pencil,
  Truck,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/DataTable";
import { MobileDataCard } from "@/components/ui/MobileDataCard";
import { RowActions, type RowAction } from "@/components/list";
import { CopyInline } from "@/components/CopyButton";
import { ChannelBadge } from "@/components/ChannelBadge";
import { fmtAr, fmtInt, D, positiveDiff } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import {
  type WorkOrderStatus,
  WO_NEXT_STATUS,
  workOrderStatusHue,
} from "@shared/workOrderStatus";
import {
  type WO,
  type Status,
  type ColKey,
  PRIORITIES,
  ADV_LABEL,
  dueInfo,
  workOrderCardLabel,
  workOrderContactMessage,
  printWoFromCard,
  printWoThermalFromCard,
  printWoShippingLabel,
} from "./workOrderTypes";

export function WorkOrdersTable({
  rows,
  isManager,
  canRequestControl,
  canRequestCancel,
  canDeliver,
  onOpen,
  onEdit,
  onAdvance,
  onCancel,
  operation: customOperation,
}: {
  rows: WO[];
  isManager: boolean;
  canRequestControl: boolean;
  canRequestCancel: boolean;
  canDeliver: boolean;
  onOpen: (id: number) => void;
  onEdit: (id: number) => void;
  onAdvance: (order: WO, to: Status) => void;
  onCancel: (order: Pick<WO, "id" | "title" | "orderNumber">) => void;
  operation?: any;
}) {
  const columns = useMemo<ColumnDef<WO, unknown>[]>(() => [
    {
      accessorKey: "orderNumber",
      header: "رقم الأمر",
      cell: ({ row }) => <CopyInline value={row.original.orderNumber} successMessage="تم نَسخ رَقم الأَمر" />,
    },
    {
      accessorKey: "createdAt",
      header: "التاريخ",
      cell: ({ row }) => fmtDate(row.original.createdAt),
    },
    {
      id: "title",
      header: "العنوان",
      cell: ({ row }) => {
        const o = row.original;
        const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
        return (
          <div className="max-w-56">
            <div className="truncate font-medium">{o.title}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {fmtInt(o.quantity)} ×
              <span className={`wob-pri ${pri.cls}`} style={{ padding: "0 4px" }}><span className="wob-pri-dot" />{pri.label}</span>
            </div>
          </div>
        );
      },
    },
    {
      id: "customer",
      header: "العميل",
      cell: ({ row }) => row.original.customerName ?? "عميل نقدي",
    },
    {
      accessorKey: "status",
      header: "الحالة",
      cell: ({ row }) => {
        const o = row.original;
        const hue = workOrderStatusHue(o.status);
        return (
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{ background: `oklch(0.6 0.17 ${hue} / 0.13)`, color: `oklch(0.45 0.17 ${hue})` }}
          >
            {workOrderCardLabel(o)}
          </span>
        );
      },
    },
    {
      accessorKey: "salePrice",
      header: "الإجمالي",
      cell: ({ row }) => <span dir="ltr" className="tabular-nums">{fmtAr(row.original.salePrice)}</span>,
    },
    {
      accessorKey: "deposit",
      header: "العربون",
      cell: ({ row }) => {
        const dep = D(row.original.deposit ?? 0);
        return dep.gt(0) ? <span dir="ltr" className="tabular-nums">{fmtAr(dep.toFixed(2))}</span> : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "remaining",
      header: "المتبقي",
      cell: ({ row }) => {
        const o = row.original;
        if (o.status === "DELIVERED" || o.status === "CANCELLED") return <span className="text-muted-foreground">—</span>;
        const due = positiveDiff(o.salePrice, o.deposit ?? 0);
        return (
          <span dir="ltr" className={`tabular-nums font-medium ${due.gt(0) ? "text-stock-low" : "text-money-positive"}`}>
            {fmtAr(due.toFixed(2))}
          </span>
        );
      },
    },
    {
      id: "due",
      header: "الاستحقاق",
      cell: ({ row }) => {
        const di = dueInfo(row.original);
        return <span className={`wob-due wob-${di.state} whitespace-nowrap`}>{di.text}</span>;
      },
    },
    {
      id: "channel",
      header: "القناة",
      cell: ({ row }) => {
        return <ChannelBadge channel={row.original.receptionChannel} />;
      },
    },
    {
      id: "assignee",
      header: "فني التنفيذ",
      cell: ({ row }) => row.original.assigneeName ?? <span className="text-muted-foreground">غير مُسنَد</span>,
    },
    {
      id: "delivery",
      header: "التوصيل",
      cell: ({ row }) => {
        const o = row.original;
        if (!o.hasDelivery) return <span className="text-muted-foreground">استلام مباشر</span>;
        if (!o.consignmentId) {
          return <span className={o.status === "READY" ? "font-bold text-stock-low" : "text-muted-foreground"}>
            {o.status === "READY" ? "بانتظار الإسناد" : "لم يُرسل"}
          </span>;
        }
        return (
          <span className="whitespace-nowrap">
            {(o as WO & { courierDeliveredAt?: Date | null }).courierDeliveredAt ? "وصل للعميل" : "مع جهة التوصيل"}
            {o.deliveryPartyName ? ` — ${o.deliveryPartyName}` : ""}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "إجراءات",
      enableSorting: false,
      cell: ({ row }) => {
        const o = row.original;
        const isFinal = o.status === "DELIVERED" || o.status === "CANCELLED";
        const next = WO_NEXT_STATUS[o.status as WorkOrderStatus];
        const actions: RowAction[] = [
          { key: "open", kind: "view", label: "فتح التفاصيل", onSelect: () => onOpen(o.id) },
          { key: "edit", kind: "edit", label: isManager ? "تعديل" : "طلب تعديل", icon: Pencil, hidden: isFinal || !canRequestControl, onSelect: () => onEdit(o.id), gate: { roles: ["cashier", "manager"], module: "workorders", level: "FULL" } },
          { key: "print", kind: "print", label: "طباعة A4", onSelect: () => printWoFromCard(o) },
          { key: "print-thermal", kind: "print", label: "طباعة حرارية (80مم)", onSelect: () => printWoThermalFromCard(o) },
          { key: "print-label", kind: "print", label: "ملصق شحن", onSelect: () => printWoShippingLabel(o) },
        ];
        if (next === ("DELIVERED" as ColKey) && o.hasDelivery && canDeliver) {
          actions.push({ key: "dispatch", kind: "approve", label: "إسناد للتوصيل", icon: Truck, href: "/delivery" });
        } else if (next && (next !== "DELIVERED" || canDeliver)) {
          actions.push({ key: "advance", kind: next === ("DELIVERED" as ColKey) ? "pay" : "approve", label: ADV_LABEL[next], onSelect: () => onAdvance(o, next) });
        }
        if (canRequestCancel && !isFinal) {
          actions.push({ key: "cancel", kind: "cancel", label: isManager ? "إلغاء الأمر" : "طلب إلغاء الأمر", variant: "destructive", onSelect: () => onCancel(o) });
        }
        return (
          <RowActions
            mode="menu"
            label={`إجراءات ${o.orderNumber}`}
            contact={{
              phone: o.customerPhone,
              alternativePhones: [o.deliveryPhone],
              label: `واتساب ${o.customerName ?? "العميل"}`,
              message: workOrderContactMessage(o),
              gate: { module: "workorders", level: "READ" },
            }}
            actions={actions}
          />
        );
      },
    },
  ], [isManager, canRequestControl, canRequestCancel, canDeliver, onOpen, onEdit, onAdvance, onCancel]);

  const defaultOperation = useMemo(() => ({
    getOperation: (order: WO) => ({
      actor: {
        name: order.createdByName,
        source: order.createdByName ? "user" as const : "legacy" as const,
      },
      action: { code: "workOrder.create", label: "إنشاء طلب خدمة" },
      subject: { type: "workOrder", label: "طلب", id: order.orderNumber },
      at: order.createdAt,
    }),
    label: "تتبّع الإنشاء",
  }), []);

  const operation = customOperation ?? defaultOperation;

  return (
    <DataTable
      columns={columns}
      data={rows}
      operation={operation}
      searchable={false}
      emptyText="لا طلبات مطابقة للبحث/الفلاتر الحالية."
      viewKey="work-orders-list"
      getRowId={(r) => String(r.id)}
      pageSize={50}
      mobileCardRenderer={(o) => {
        const pri = PRIORITIES[o.priority ?? "NORMAL"] ?? PRIORITIES.NORMAL;
        const due = positiveDiff(o.salePrice, o.deposit ?? 0);
        const next = WO_NEXT_STATUS[o.status as WorkOrderStatus];
        return (
          <MobileDataCard
            key={o.id}
            title={o.title}
            subtitle={`${o.orderNumber} · ${o.customerName ?? "عميل نقدي"}`}
            badge={{
              label: workOrderCardLabel(o),
              variant: o.status === "DELIVERED" ? "success" : o.status === "READY" ? "default" : o.status === "IN_PROGRESS" ? "warning" : "secondary",
            }}
            amount={{
              value: fmtAr(o.salePrice),
              label: due.gt(0) && o.status !== "DELIVERED" && o.status !== "CANCELLED" ? `المتبقي: ${fmtAr(due.toFixed(2))}` : undefined,
              positive: o.status === "DELIVERED",
            }}
            metadata={[
              { label: "الكمية", value: `${fmtInt(o.quantity)} نسخة` },
              { label: "الأولوية", value: pri.label },
              { label: "الاستحقاق", value: fmtDate(o.dueDate), icon: Calendar },
              { label: "الفني", value: o.assigneeName ?? "غير مُسنَد" },
            ]}
            onClick={() => onOpen(o.id)}
            primaryAction={
              next && (next !== "DELIVERED" || canDeliver)
                ? {
                    label: next === "IN_PROGRESS" ? "بدء التنفيذ" : next === "READY" ? "جاهز" : "تسليم",
                    icon: next === "READY" ? CheckCircle2 : next === ("DELIVERED" as ColKey) ? Package : ChevronRight,
                    onClick: () => onAdvance(o, next),
                  }
                : undefined
            }
          />
        );
      }}
    />
  );
}
