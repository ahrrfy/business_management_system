import { ActorCell } from "@/components/data-table/ActorCell";
import { BalanceSnapshotStrip, MovementTypeBadge, PaymentMethodChip } from "@/components/common/MovementBadges";
import { CopyButton } from "@/components/CopyButton";
import type { ImageItem } from "@/components/form/ImageUploader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DigitalStampOverlay } from "@/components/vouchers/DigitalStampOverlay";
import { ResubmitVoucherDialog } from "@/components/vouchers/ResubmitVoucherDialog";
import { SupplierVoucherSettlementSummary } from "@/components/vouchers/SupplierVoucherSettlementSummary";
import {
  isNonPoVoucherSystemRef,
  isPurchaseSupplierVoucherRef,
  printVoucherWithAudit,
  voucherPartyKindText,
  voucherPartyStatementHref,
  voucherShortHash,
  type VoucherDetailRecord,
} from "@/components/vouchers/voucherExport";
import { VoucherRejectDialog } from "@/components/vouchers/VoucherRejectDialog";
import {
  accrualPaymentAttemptLabel,
  accrualPaymentResubmitPayload,
  canPrintOfficialVoucher,
  canShowAccrualPaymentResubmit,
  canShowVoucherApprovalAction,
  canShowVoucherRejectAction,
  validAccrualReissueReason,
  voucherApprovalLabel,
} from "@/components/vouchers/voucherUiPolicy";
import { usePrintAudit } from "@/hooks/usePrintAudit";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { trpc } from "@/lib/trpc";
import { SUPPLIER_RECEIPT_PURPOSE_LABELS, type SupplierReceiptPurpose } from "@shared/balanceTrail";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { ExternalLink, Paperclip, Printer } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "wouter";

export interface VoucherDetailDrawerProps {
  voucherId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActionSuccess?: () => void;
}

type ExtendedVoucherDetail = VoucherDetailRecord & {
  partyBalanceBefore?: string | null;
  partyBalanceAfter?: string | null;
  supplierReceiptPurpose?: SupplierReceiptPurpose | null;
  resubmitLineageStatus?: "NONE" | "VALID" | "BROKEN" | null;
  resubmitAttempt?: number | null;
  resubmitRootReceiptId?: number | null;
  resubmitPriorReceiptId?: number | null;
};

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function VoucherDetailDrawer({ voucherId, open, onOpenChange, onActionSuccess }: VoucherDetailDrawerProps) {
  const utils = trpc.useUtils();
  const printAudit = usePrintAudit();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const query = trpc.vouchers.get.useQuery({ receiptId: voucherId ?? 0 }, { enabled: open && voucherId != null });

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [reissueReason, setReissueReason] = useState("");
  const [resubmitNote, setResubmitNote] = useState("");
  const [resubmitImages, setResubmitImages] = useState<ImageItem[]>([]);
  const [stampInfo, setStampInfo] = useState<{ isOpen: boolean; voucherNumber?: string; title?: string }>({ isOpen: false });

  const branchMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of branches.data ?? []) m.set(Number(b.id), b.name);
    return m;
  }, [branches.data]);

  const legacyManage =
    !!me.data &&
    moduleAccessAllowed(me.data.role as RoleKey, (me.data.permissionsOverride ?? null) as PermissionMap | null, "treasury", "FULL", [
      "manager",
      "accountant",
    ]);
  const isOwner = me.data?.isOwner === true;
  const canApprove = treasuryOperationAllowed(me.data, "vouchers.approve", legacyManage);
  const canReject = treasuryOperationAllowed(me.data, "vouchers.reject", legacyManage);
  const canCancel = treasuryOperationAllowed(me.data, "vouchers.cancel", legacyManage);
  const canResubmit = treasuryOperationAllowed(me.data, "vouchers.resubmitExpensePayment", legacyManage);

  async function refreshAll() {
    await Promise.all([
      utils.vouchers.get.invalidate(),
      utils.vouchers.list.invalidate(),
      utils.vouchers.aggregate.invalidate(),
      utils.suppliers.invalidate(),
      utils.customers.invalidate(),
    ]);
    onActionSuccess?.();
  }

  const approveMut = trpc.vouchers.approve.useMutation({
    onSuccess: async (res) => {
      await refreshAll();
      notify.ok(`تم اعتماد السند ${res.voucherNumber}`);
      setStampInfo({ isOpen: true, voucherNumber: res.voucherNumber, title: query.data?.direction === "OUT" ? "صرف واعتماد" : "معتمد رسميا" });
    },
    onError: (e) => notify.err(e),
  });
  const rejectMut = trpc.vouchers.reject.useMutation({
    onSuccess: async (res) => { setRejectOpen(false); setRejectReason(""); await refreshAll(); notify.ok(`تم رفض السند ${res.voucherNumber}`); },
    onError: (e) => notify.err(e),
  });
  const cancelMut = trpc.vouchers.cancel.useMutation({
    onSuccess: async (res) => {
      await refreshAll();
      notify.ok(res.status === "PENDING_APPROVAL" ? `أرسل طلب إلغاء السند ${res.voucherNumber} للاعتماد` : `ألغي الطلب غير المادي ${res.voucherNumber}`);
    },
    onError: (e) => notify.err(e),
  });
  const resubmitMut = trpc.vouchers.resubmitExpensePayment.useMutation({
    onSuccess: async (res) => {
      setResubmitOpen(false); setReissueReason(""); setResubmitNote(""); setResubmitImages([]);
      await refreshAll();
      notify.ok(`أعيد تقديم المحاولة A${res.attempt} بالسند ${res.voucherNumber}`);
    },
    onError: (e) => notify.err(e),
  });

  const v = query.data as ExtendedVoucherDetail | null | undefined;
  const partyHref = v ? voucherPartyStatementHref(v.partyType, v.partyId) : null;
  const isPoPay = isPurchaseSupplierVoucherRef(v?.referenceNumber);
  const showResubmit =
    !!v &&
    (canShowAccrualPaymentResubmit({
      referenceNumber: v.referenceNumber,
      approvalStatus: v.approvalStatus,
      resubmitLineageStatus: v.resubmitLineageStatus,
      canManage: canResubmit,
    }) ||
      (canResubmit && v.approvalStatus === "REJECTED" && isPoPay));
  const attemptLabel = v
    ? accrualPaymentAttemptLabel({
        attempt: v.resubmitAttempt,
        rootReceiptId: v.resubmitRootReceiptId,
        priorReceiptId: v.resubmitPriorReceiptId,
      })
    : null;

  async function handleApprove() {
    if (!v) return;
    const ok = await confirm({
      variant: "info",
      title: v.direction === "OUT" ? "اعتماد المالك وصرف السند" : "اعتماد السند",
      description: `سيعتمد السند ${v.voucherNumber ?? ""} بمبلغ ${fmt(v.amount)} د.ع وينفذ أثره المالي فورا.`,
      confirmText: v.direction === "OUT" ? "اعتماد وصرف" : "اعتماد",
      cancelText: "تراجع",
    });
    if (ok) approveMut.mutate({ receiptId: Number(v.id) });
  }

  async function handleCancel() {
    if (!v) return;
    const materialized = v.status === "COMPLETED" && v.approvalStatus === "APPROVED";
    const ok = await confirm({
      variant: "danger",
      title: materialized ? "طلب إلغاء السند" : "إلغاء الطلب غير المادي",
      description: materialized
        ? `سيعلق طلب إلغاء للسند ${v.voucherNumber ?? ""} بمبلغ ${fmt(v.amount)} د.ع حتى اعتماد مالك آخر.`
        : `سيعلم الطلب ${v.voucherNumber ?? ""} ملغى بلا أثر مالي.`,
      confirmText: materialized ? "إرسال طلب الإلغاء" : "إلغاء الطلب",
      cancelText: "تراجع",
    });
    if (ok) cancelMut.mutate({ receiptId: Number(v.id) });
  }

  async function handlePrint(mode: "thermal" | "a4") {
    if (!v) return;
    await printVoucherWithAudit({
      receiptId: Number(v.id),
      mode,
      fetchVoucher: () => Promise.resolve(v),
      branchMap,
      runPrintAudit: (input) => printAudit.run(input),
      onError: (e) => notify.err(e),
    });
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" dir="rtl" className="w-full sm:max-w-2xl overflow-y-auto p-4 sm:p-6">
          <SheetHeader className="text-start border-b pb-3">
            <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
              <span>معاينة السند</span>
              {v?.voucherNumber ? (
                <span className="inline-flex items-center gap-1 font-mono" dir="ltr">
                  {v.voucherNumber}
                  <CopyButton value={v.voucherNumber} title="نسخ رقم السند" />
                </span>
              ) : null}
              {v ? (
                <>
                  <MovementTypeBadge kind={v.direction === "IN" ? "RECEIPT" : "PAYMENT"} />
                  <Badge variant={v.approvalStatus === "PENDING_APPROVAL" ? "warning" : v.approvalStatus === "REJECTED" ? "destructive" : "success"}>
                    {voucherApprovalLabel(v)}
                  </Badge>
                  {v.status === "REVERSED" ? <Badge variant="destructive">ملغى</Badge> : null}
                </>
              ) : null}
            </SheetTitle>
            <SheetDescription>تفاصيل الحركة والاعتماد والربط الدفتري.</SheetDescription>
          </SheetHeader>

          {query.isLoading ? <LoadingState /> : null}
          {query.isError ? <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} /> : null}

          {v ? (
            <div className="space-y-3 py-3 text-sm">
              <Card>
                <CardContent className="p-3.5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground">المبلغ</div>
                    <div className="text-xl font-bold tabular-nums text-primary" dir="ltr"><bdi dir="ltr">{fmt(v.amount)} د.ع</bdi></div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">طريقة الدفع</div>
                    <PaymentMethodChip method={v.paymentMethod} cashBucket={v.cashBucket} cardLastFour={v.cardLastFour} />
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">تاريخ السند</div>
                    <div className="font-medium">{fmtDate(v.voucherDate ?? v.createdAt)}</div>
                    <div className="text-[11px] text-muted-foreground">{fmtDateTime(v.createdAt)}</div>
                  </div>
                </CardContent>
              </Card>

              {(v.partyType === "SUPPLIER" || v.partyType === "CUSTOMER") && v.partyBalanceBefore != null ? (
                <BalanceSnapshotStrip partyType={v.partyType} before={v.partyBalanceBefore} debit={v.direction === "OUT" ? v.amount : "0.00"} credit={v.direction === "IN" ? v.amount : "0.00"} />
              ) : null}

              {v.supplierReceiptPurpose ? (
                <div className="text-xs text-muted-foreground rounded-md border bg-muted/20 px-3 py-2">
                  <span>تصنيف قبض المورد: </span>
                  <span className="font-medium text-foreground">{SUPPLIER_RECEIPT_PURPOSE_LABELS[v.supplierReceiptPurpose] ?? v.supplierReceiptPurpose}</span>
                </div>
              ) : null}

              <Card>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 text-xs">
                  <DetailField label={`الطرف (${voucherPartyKindText(v.partyType)})`}>
                    <div className="font-semibold flex items-center gap-1">
                      <span>{v.partyName ?? v.counterpartyName ?? "—"}</span>
                      {partyHref ? (
                        <Link href={partyHref} className="text-primary hover:underline inline-flex items-center gap-0.5">
                          <span>كشف الحساب</span><ExternalLink aria-hidden className="size-3" />
                        </Link>
                      ) : null}
                    </div>
                  </DetailField>
                  <DetailField label={ATTRIBUTION_LABELS.branch}>
                    <span className="font-medium">{v.branchId != null ? (branchMap.get(Number(v.branchId)) ?? `#${v.branchId}`) : "—"}</span>
                  </DetailField>
                  <DetailField label={ATTRIBUTION_LABELS.performedBy}>
                    <ActorCell actor={{ name: v.createdByName, userId: v.createdBy }} />
                  </DetailField>
                  <DetailField label={ATTRIBUTION_LABELS.approvedBy}>
                    {v.approvedBy != null ? <ActorCell actor={{ name: v.approvedByName, userId: v.approvedBy }} /> : <span>—</span>}
                  </DetailField>
                  {v.categoryName ? <DetailField label="الفئة المحاسبية"><span className="font-medium">{v.categoryName}</span></DetailField> : null}
                  {v.invoiceNumber ? (
                    <DetailField label="الفاتورة المرتبطة"><Link href={`/invoices/${v.invoiceId}`} className="text-primary underline inline-block">{v.invoiceNumber}</Link></DetailField>
                  ) : null}
                  {v.exchangeHouseName ? <DetailField label="مكتب الصيرفة"><span className="font-medium">{v.exchangeHouseName}</span></DetailField> : null}
                  {v.referenceNumber ? <DetailField label="المرجع"><span className="font-mono" dir="ltr">{v.referenceNumber}</span></DetailField> : null}
                </CardContent>
              </Card>

              {v.description || v.internalNote ? (
                <Card><CardContent className="p-3.5 space-y-1.5 text-xs">
                  {v.description ? <div><span className="text-muted-foreground">البيان: </span><span className="font-medium">{v.description}</span></div> : null}
                  {v.internalNote ? <div><span className="text-muted-foreground">ملاحظة داخلية: </span><span>{v.internalNote}</span></div> : null}
                </CardContent></Card>
              ) : null}

              {v.attachmentUrl ? (
                <Card><CardContent className="p-3.5 space-y-2 text-xs">
                  <a href={v.attachmentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline font-medium">
                    <Paperclip aria-hidden className="size-3.5" />فتح المرفق في تبويب مستقل
                  </a>
                  {/^data:image\//.test(v.attachmentUrl) ? <img src={v.attachmentUrl} alt="مرفق السند" className="max-h-48 rounded border object-contain" /> : null}
                </CardContent></Card>
              ) : null}

              <SupplierVoucherSettlementSummary settlement={v.supplierSettlement} bookSettlement={v.bookSettlement} advanceRefund={v.advanceRefund} />

              <details className="rounded-md border bg-muted/20 p-2.5 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium">تفاصيل التدقيق التقنية</summary>
                <div className="mt-1.5 space-y-1">
                  <div>البصمة: <span className="font-mono">{voucherShortHash(v.signatureHash)}</span></div>
                  {attemptLabel ? <div>{attemptLabel}</div> : null}
                </div>
              </details>

              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                {canPrintOfficialVoucher(v) ? (
                  <>
                    <Button type="button" variant="outline" size="sm" onClick={() => void handlePrint("thermal")}><Printer aria-hidden className="size-4 ms-1" />طباعة حرارية</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => void handlePrint("a4")}><Printer aria-hidden className="size-4 ms-1" />طباعة A4</Button>
                  </>
                ) : null}
                {canShowVoucherApprovalAction({ direction: v.direction, approvalStatus: v.approvalStatus, isOwner, canManageLegacyReceipt: canApprove }) ? (
                  <Button type="button" size="sm" disabled={approveMut.isPending} onClick={() => void handleApprove()}>{v.direction === "OUT" ? "اعتماد المالك وصرف" : "اعتماد المالك"}</Button>
                ) : null}
                {canShowVoucherRejectAction({ direction: v.direction, approvalStatus: v.approvalStatus, isOwner, canManageLegacyReceipt: canReject }) ? (
                  <Button type="button" variant="destructive" size="sm" disabled={rejectMut.isPending} onClick={() => { setRejectReason(""); setRejectOpen(true); }}>رفض</Button>
                ) : null}
                {showResubmit ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => { setReissueReason(""); setResubmitNote(""); setResubmitImages([]); setResubmitOpen(true); }}>إعادة تقديم</Button>
                ) : null}
                {canCancel && v.status !== "REVERSED" && v.paymentMethod !== "EXCHANGE" && !isNonPoVoucherSystemRef(v.referenceNumber) ? (
                  <Button type="button" variant="destructive" size="sm" disabled={cancelMut.isPending} onClick={() => void handleCancel()}>
                    {v.status === "COMPLETED" && v.approvalStatus === "APPROVED" ? "طلب إلغاء السند" : "إلغاء الطلب"}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <VoucherRejectDialog
        rejectTarget={rejectOpen && v ? v : null}
        rejectReason={rejectReason}
        setRejectReason={setRejectReason}
        isPending={rejectMut.isPending}
        onClose={() => setRejectOpen(false)}
        onSubmit={() => { const reason = rejectReason.trim(); if (reason && v) rejectMut.mutate({ receiptId: Number(v.id), reason }); }}
      />
      <ResubmitVoucherDialog
        resubmitTarget={resubmitOpen && v ? v : null}
        onClose={() => setResubmitOpen(false)}
        onSubmit={() => {
          if (!v || !validAccrualReissueReason(reissueReason)) return;
          resubmitMut.mutate(accrualPaymentResubmitPayload({ receiptId: Number(v.id), reissueReason, attachmentUrl: resubmitImages[0]?.dataUrl ?? null, note: resubmitNote }));
        }}
        reissueReason={reissueReason}
        setReissueReason={setReissueReason}
        resubmitNote={resubmitNote}
        setResubmitNote={setResubmitNote}
        resubmitAttachmentImages={resubmitImages}
        setResubmitAttachmentImages={setResubmitImages}
        isPending={resubmitMut.isPending}
      />
      <DigitalStampOverlay isOpen={stampInfo.isOpen} onClose={() => setStampInfo({ isOpen: false })} title={stampInfo.title} referenceNumber={stampInfo.voucherNumber} actorName={me.data?.name ?? undefined} />
    </>
  );
}
