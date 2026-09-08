import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { D, fmt, fmtAr, positiveDiff } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ExternalLink, Package, Pencil, Printer, User } from "lucide-react";
import { Link } from "wouter";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { NextActionChip } from "@/components/nextAction/NextActionChip";
import { hasModuleAccess } from "@shared/permissions";

type PoItemRow = NonNullable<RouterOutputs["purchases"]["get"]>["items"][number];

function poItemColumns(isUsd: boolean): ColumnDef<PoItemRow, unknown>[] {
  return [
    {
      id: "product",
      header: "الصنف",
      accessorFn: (it) => (it.productName ?? "—") + (it.variantName ? " — " + it.variantName : ""),
      meta: { width: "wide" },
      cell: ({ row }) => (
        <div>
          <span className="font-medium text-foreground">{row.original.productName ?? "—"}</span>
          {row.original.variantName ? (
            <span className="text-xs text-muted-foreground block">{row.original.variantName}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: "unit",
      header: "الوحدة",
      accessorFn: (it) => it.unitName ?? "—",
      cell: ({ row }) => row.original.unitName ?? "—",
    },
    {
      id: "quantity",
      header: "الكمية",
      accessorFn: (it) => fmtAr(it.quantity),
      meta: { kind: "number" },
      cell: ({ row }) => fmtAr(row.original.quantity),
    },
    {
      id: "received",
      header: "المستلَم / المطلوب",
      accessorFn: (it) => fmtAr(it.receivedBaseQuantity) + " / " + fmtAr(it.baseQuantity),
      meta: { kind: "number" },
      cell: ({ row }) => (
        <span className="tabular-nums font-mono text-xs">
          {fmtAr(row.original.receivedBaseQuantity)} / {fmtAr(row.original.baseQuantity)}
        </span>
      ),
    },
    {
      id: "unitPrice",
      header: isUsd ? "السعر ($)" : "السعر",
      accessorFn: (it) => fmtAr(isUsd ? it.usdUnitPrice : it.unitPrice),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(isUsd ? row.original.usdUnitPrice : row.original.unitPrice),
    },
    {
      id: "total",
      header: isUsd ? "الإجمالي ($)" : "الإجمالي",
      accessorFn: (it) => fmtAr(isUsd ? it.usdTotal : it.total),
      meta: { kind: "money" },
      cell: ({ row }) => fmtAr(isUsd ? row.original.usdTotal : row.original.total),
    },
  ];
}

const PO_STATUS: Record<string, string> = {
  DRAFT: "مسوّدة",
  SENT: "مُرسَل",
  CONFIRMED: "مؤكّد",
  RECEIVED: "مُستلَم",
  CANCELLED: "ملغى",
};

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "RECEIVED") return "default";
  if (status === "CANCELLED") return "destructive";
  if (status === "DRAFT") return "outline";
  return "secondary";
}

export interface PurchaseDetailDrawerProps {
  purchaseOrderId: number | null;
  onClose: () => void;
  onPrint?: (id: number) => void;
}

export function PurchaseDetailDrawer({
  purchaseOrderId,
  onClose,
  onPrint,
}: PurchaseDetailDrawerProps) {
  const isOpen = purchaseOrderId != null && purchaseOrderId > 0;
  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId: purchaseOrderId ?? 0 },
    { enabled: isOpen },
  );
  const me = trpc.auth.me.useQuery();

  const canEdit = hasModuleAccess(
    me.data?.role ?? "",
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)?.permissionsOverride ?? null,
    "purchases",
    "FULL",
  );

  const d = po.data;
  const isUsd = d?.agreedCurrency === "USD";
  const costHidden = d?.total === null;
  const remaining = costHidden || !d
    ? null
    : isUsd
      ? positiveDiff(d.usdTotal, D(d.paidUsd ?? 0).plus(D(d.returnedUsd ?? 0)).toString())
      : positiveDiff(d.total, d.paidAmount);

  const openForEditing =
    d?.status === "DRAFT" &&
    !d.items.some((it) => (it.receivedBaseQuantity ?? 0) > 0) &&
    !D(d.paidAmount ?? 0).gt(0) &&
    !D(d.paidUsd ?? 0).gt(0);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto space-y-4" dir="rtl">
        <SheetHeader className="border-b pb-3">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Package aria-hidden className="size-5 text-primary" />
              <span>أمر شراء</span>
              <span dir="ltr" className="tabular-nums font-bold">
                {d?.poNumber ?? `#${purchaseOrderId ?? ""}`}
              </span>
            </SheetTitle>
            {d?.status ? (
              <Badge variant={statusVariant(d.status)}>
                {PO_STATUS[d.status] ?? d.status}
              </Badge>
            ) : null}
          </div>
        </SheetHeader>

        {po.isLoading ? <LoadingState message="جارٍ تحميل تفاصيل أمر الشراء…" /> : null}
        {po.error ? <ErrorState message={po.error.message} /> : null}
        {!po.isLoading && !po.error && !d ? (
          <EmptyState title="أمر الشراء غير موجود" description="قد يكون محذوفاً أو غير متاح لفرعك." />
        ) : null}

        {d ? (
          <div className="space-y-4">
            <NextActionChip nextAction={d.nextAction ?? null} terminalReason={d.nextActionReason ?? null} />

            {/* بطاقة الرأس والملخص */}
            <Card>
              <CardContent className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">المورّد</div>
                  <div className="font-semibold truncate">
                    {d.supplierId ? (
                      <Link
                        href={`/suppliers-statement?id=${d.supplierId}`}
                        className="text-primary hover:underline"
                        title="كشف الحساب"
                      >
                        {d.supplierName ?? `#${d.supplierId}`}
                      </Link>
                    ) : (
                      d.supplierName ?? "—"
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">التاريخ</div>
                  <div className="tabular-nums">{fmtDate(d.orderDate)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">العملة</div>
                  <div>{d.agreedCurrency ?? "IQD"} {isUsd && d.agreedRate ? `(${fmt(d.agreedRate)})` : ""}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">التسوية</div>
                  <div>{d.settlementType === "CASH" ? "نقدي" : "آجل"}</div>
                </div>
              </CardContent>
            </Card>

            {/* الأرقام المالية السريعة */}
            {!costHidden ? (
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border bg-card p-2 text-center">
                  <div className="text-xs text-muted-foreground">الإجمالي</div>
                  <div className="font-bold text-sm tabular-nums">
                    {isUsd ? `${fmt(d.usdTotal)} $` : `${fmt(d.total)} د.ع`}
                  </div>
                </div>
                <div className="rounded-lg border bg-card p-2 text-center">
                  <div className="text-xs text-muted-foreground">المدفوع</div>
                  <div className="font-bold text-sm text-money-positive tabular-nums">
                    {isUsd ? `${fmt(d.paidUsd ?? "0")} $` : `${fmt(d.paidAmount ?? "0")} د.ع`}
                  </div>
                </div>
                <div className="rounded-lg border bg-card p-2 text-center">
                  <div className="text-xs text-muted-foreground">المتبقي</div>
                  <div className="font-bold text-sm text-money-negative tabular-nums">
                    {remaining != null
                      ? isUsd
                        ? `${fmt(remaining.toFixed(2))} $`
                        : `${fmt(remaining.toFixed(2))} د.ع`
                      : "—"}
                  </div>
                </div>
              </div>
            ) : null}

            {/* جدول البنود */}
            <div>
              <div className="text-xs font-semibold mb-1.5 flex items-center justify-between">
                <span>بنود الأمر ({d.items.length})</span>
                {d.notes ? <span className="text-muted-foreground font-normal">ملاحظات: {d.notes}</span> : null}
              </div>
              <div className="rounded-md border overflow-hidden">
                <DataTable<PoItemRow>
                  embedded
                  searchable={false}
                  bounded={false}
                  pageSize={Infinity}
                  data={d.items}
                  columns={poItemColumns(isUsd)}
                  emptyText="لا بنود مسجلة."
                />
              </div>
            </div>

            {/* الإجراءات الموضعية المباشرة */}
            <div className="pt-2 border-t flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {onPrint ? (
                  <Button size="sm" variant="outline" onClick={() => onPrint(d.id)}>
                    <Printer aria-hidden className="size-4" />
                    طباعة
                  </Button>
                ) : null}
                {canEdit && openForEditing ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/purchases/${d.id}/edit`}>
                      <Pencil aria-hidden className="size-4" />
                      تعديل
                    </Link>
                  </Button>
                ) : null}
                {d.supplierId ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/suppliers-statement?id=${d.supplierId}`}>
                      <User aria-hidden className="size-4" />
                      كشف المورد
                    </Link>
                  </Button>
                ) : null}
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href={`/purchases/${d.id}`}>
                  <ExternalLink aria-hidden className="size-4" />
                  الصفحة المستقلة
                </Link>
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
