import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { D, fmt, fmtAr, positiveDiff } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  CheckCircle2,
  ExternalLink,
  HandCoins,
  Package,
  Pencil,
  Printer,
  ShieldCheck,
  Undo2,
  User,
} from "lucide-react";
import { Link } from "wouter";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { NextActionChip } from "@/components/nextAction/NextActionChip";
import { hasModuleAccess } from "@shared/permissions";
import { PurchaseOrderGovernance } from "./PurchaseOrderGovernance";
import { QuickSupplierPaymentDialog } from "./QuickSupplierPaymentDialog";

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
  const utils = trpc.useUtils();
  const isOpen = purchaseOrderId != null && purchaseOrderId > 0;
  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId: purchaseOrderId ?? 0 },
    { enabled: isOpen },
  );
  const me = trpc.auth.me.useQuery();

  const [activeTab, setActiveTab] = useState<"details" | "governance">("details");
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [approvalReason, setApprovalReason] = useState("اعتماد واستلام البضاعة كاملة");

  const canEdit = hasModuleAccess(
    me.data?.role ?? "",
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)?.permissionsOverride ?? null,
    "purchases",
    "FULL",
  );

  const pendingControls = trpc.purchases.pendingControls.useQuery(
    { limit: 200 },
    { enabled: isOpen && canEdit },
  );

  const activeControlRequest = useMemo(() => {
    return (pendingControls.data?.rows ?? []).find(
      (row) =>
        row.documentType === "PURCHASE_ORDER" &&
        Number(row.purchaseOrderId) === purchaseOrderId &&
        row.kind === "APPROVE_REVISION",
    );
  }, [pendingControls.data?.rows, purchaseOrderId]);

  const orderDecisionMut = trpc.purchases.decideControl.useMutation({
    onSuccess: async (res) => {
      notify.ok(
        res.status === "APPROVED"
          ? "تم اعتماد أمر الشراء واستلام البضاعة بالكامل وترحيل الفاتورة بنجاح"
          : "تم تحديث حالة طلب الاعتماد",
      );
      setIsApprovalOpen(false);
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId: purchaseOrderId ?? 0 }),
        utils.purchases.list.invalidate(),
        utils.purchases.pendingControls.invalidate(),
      ]);
    },
    onError: (err) => notify.err(err),
  });

  const confirmMut = trpc.purchases.confirmOrder.useMutation({
    onSuccess: async () => {
      notify.ok("تم إرسال أمر الشراء للاعتماد");
      setIsApprovalOpen(false);
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId: purchaseOrderId ?? 0 }),
        utils.purchases.list.invalidate(),
        utils.purchases.pendingControls.invalidate(),
      ]);
    },
    onError: (err) => notify.err(err),
  });

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

  const canApproveDirectly =
    canEdit &&
    d &&
    ((d.status === "SENT" && activeControlRequest != null) || d.status === "DRAFT");

  function handleApproveAndReceive() {
    if (!d) return;
    if (d.status === "SENT" && activeControlRequest) {
      orderDecisionMut.mutate({
        requestId: Number(activeControlRequest.id),
        decisionKey: `decide-drawer-${activeControlRequest.id}-${crypto.randomUUID()}`,
        approve: true,
        reason: approvalReason.trim() || "اعتماد واستلام البضاعة كاملة",
        confirmedFullReceipt: true,
      });
    } else if (d.status === "DRAFT") {
      confirmMut.mutate({
        purchaseOrderId: d.id,
        expectedVersion: d.version,
        reason: approvalReason.trim() || "إرسال أمر الشراء للاعتماد والاستلام",
        clientRequestId: `confirm-drawer-${d.id}-${crypto.randomUUID()}`,
      });
    }
  }

  const isApproving = orderDecisionMut.isPending || confirmMut.isPending;

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

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "details" | "governance")} className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="details">تفاصيل الأمر والبنود</TabsTrigger>
                <TabsTrigger value="governance" className="flex items-center gap-1.5">
                  <ShieldCheck aria-hidden className="size-4" />
                  <span>سجل الحوكمة والمراجعات</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="space-y-4 pt-2">
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

                {/* أشرطة الإجراءات المباشرة (استلام / سداد / مرتجع) */}
                <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border bg-muted/30">
                  {canApproveDirectly ? (
                    <Button
                      size="sm"
                      onClick={() => setIsApprovalOpen(true)}
                      className="bg-primary text-primary-foreground font-semibold"
                    >
                      <CheckCircle2 aria-hidden className="size-4" />
                      {d.status === "SENT" ? "اعتماد واستلام فوري" : "إرسال للاعتماد"}
                    </Button>
                  ) : null}

                  {d.status === "RECEIVED" && remaining != null && remaining.gt(0) && !costHidden ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsPaymentOpen(true)}
                      className="font-semibold text-primary border-primary/40 hover:bg-primary/5"
                    >
                      <HandCoins aria-hidden className="size-4" />
                      سداد فوري للمورد
                    </Button>
                  ) : null}

                  {d.status === "RECEIVED" ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/purchase-returns/new?po=${encodeURIComponent(d.poNumber)}`}>
                        <Undo2 aria-hidden className="size-4" />
                        مرتجع شراء
                      </Link>
                    </Button>
                  ) : null}
                </div>

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

                {/* مصاريف الشحن والكمرك إن وُجدت */}
                {(D(d.shippingCost ?? 0).gt(0) || D(d.customsCost ?? 0).gt(0)) && !costHidden ? (
                  <div className="rounded-md border bg-[var(--sem-warn-bg)]/60 p-3 text-xs">
                    <div className="font-semibold text-[var(--sem-warn)] mb-1">
                      مصاريف الشحن والكمرك المُرسمَلة على المخزون
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>الشحن: {fmtAr(d.shippingCost)} د.ع</div>
                      <div>الكمرك: {fmtAr(d.customsCost)} د.ع</div>
                    </div>
                  </div>
                ) : null}

                {/* الإجراءات الموضعية المباشرة في التذييل */}
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
              </TabsContent>

              <TabsContent value="governance" className="space-y-4 pt-2">
                <PurchaseOrderGovernance purchaseOrderId={d.id} />
              </TabsContent>
            </Tabs>

            {/* نافذة تأكيد الاعتماد والاستلام الفوري */}
            <Dialog open={isApprovalOpen} onOpenChange={setIsApprovalOpen}>
              <DialogContent className="sm:max-w-md" dir="rtl">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-base">
                    <CheckCircle2 aria-hidden className="size-5 text-primary" />
                    <span>اعتماد واستلام أمر الشراء {d.poNumber}</span>
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground">
                    اعتماد هذا الأمر يعني تأكيد استلام البضاعة كاملة في المستودع وترحيل فاتورة المورد في قيد متوازن وإتاحتها للبيع فوراً.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div className="space-y-1">
                    <Label htmlFor="approve-reason" className="text-xs">
                      بيان الاعتماد / السبب
                    </Label>
                    <Input
                      id="approve-reason"
                      value={approvalReason}
                      onChange={(e) => setApprovalReason(e.target.value)}
                      className="text-xs"
                      placeholder="اعتماد واستلام البضاعة كاملة"
                    />
                  </div>
                </div>
                <DialogFooter className="gap-2 sm:gap-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsApprovalOpen(false)}
                    disabled={isApproving}
                  >
                    إلغاء
                  </Button>
                  <SubmitButton
                    size="sm"
                    pending={isApproving}
                    onClick={handleApproveAndReceive}
                    disabled={approvalReason.trim().length < 3}
                  >
                    تأكيد الاعتماد والاستلام
                  </SubmitButton>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* نافذة السداد السريع للمورد */}
            {isPaymentOpen && d.supplierId ? (
              <QuickSupplierPaymentDialog
                open={isPaymentOpen}
                onClose={() => setIsPaymentOpen(false)}
                purchaseOrderId={d.id}
                poNumber={d.poNumber}
                supplierId={d.supplierId}
                supplierName={d.supplierName ?? ""}
                branchId={Number(d.branchId)}
                currency={isUsd ? "USD" : "IQD"}
                exchangeRate={d.agreedRate}
                remainingAmount={remaining ? remaining.toFixed(2) : "0"}
                onSuccess={() => void utils.purchases.get.invalidate({ purchaseOrderId: d.id })}
              />
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
