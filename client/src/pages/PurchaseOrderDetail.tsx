import { PurchasePaymentEvidence, purchasePaymentEvidencePrintMeta } from "@/components/purchases/PurchasePaymentEvidence";
import { useState } from "react";
import { purchaseShippingAdjustmentLabel } from "@/components/purchases/purchaseGovernanceUiPolicy";
import { PurchaseShippingRefund } from "@/components/purchases/PurchaseShippingRefund";
import {
  PurchaseTenderField,
  usePurchaseTenderState,
} from "@/components/purchases/PurchaseTenderField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { EmptyState } from "@/components/EmptyState";
import { fmtDate } from "@/lib/date";
import { D, fmtAr } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import { hasModuleAccess } from "@shared/permissions";
import { getPurchaseSettlement } from "@shared/purchaseSettlement";
import { canLifecycleOperation } from "@/lib/lifecycleOperationAccess";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Clock,
  ExternalLink,
  HandCoins,
  Landmark,
  Pencil,
  Printer,
  Receipt,
  RotateCcw,
  Truck,
} from "lucide-react";
import { Link, useParams } from "wouter";
import { variantDisplayName } from "@shared/variantDisplay";
import { poItemColumns, type PoItemRow } from "@/components/purchases/purchaseDetailColumns";
import { PurchaseOrderGovernance } from "@/components/purchases/PurchaseOrderGovernance";
import {
  PurchaseOrderActionDialogs,
  PurchaseRateAnomalyBanner,
} from "@/components/purchases/PurchaseRateAnomalyBanner";
import { PurchaseQuickApproveDialog } from "@/components/purchases/PurchaseQuickApproveDialog";
import { PaymentMethodChip } from "@/components/common/MovementBadges";
import { getPurchaseSettlementIntentLabel } from "@shared/purchaseSettlement";
import { purchaseTenderLabel } from "@shared/purchaseTender";
import { printPurchaseInvoiceV2 } from "@/lib/printing/printTemplates";
import { splitDocumentNotes } from "@/components/invoice";
import { DataTable } from "@/components/data-table/DataTable";
import { NextActionChip } from "@/components/nextAction/NextActionChip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PO_STATUS: Record<string, string> = { DRAFT: "مسوّدة", SENT: "مُرسَل", CONFIRMED: "مؤكّد", RECEIVED: "مُستلَم", CANCELLED: "ملغى" };

/** نبرة الحالة عبر variants الشارة (توكنز، لا ألوان خام — حارس check:colors). */
function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "RECEIVED") return "default";
  if (status === "CANCELLED") return "destructive";
  if (status === "DRAFT") return "outline";
  return "secondary";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * تفاصيل أمر شراء — **قراءة فقط**.
 *
 * سدّ رابطٍ مكسور: «سجلّ المشتريات» و«دفتر الأستاذ» يربطان رقم الأمر بـ`/purchases/:id`
 * وكان المسار غير معرَّف في App.tsx ⇒ صفحة فارغة عند كل نقرة (تدقيق ١٧/٧، السطر ٣٤١).
 * الاعتماد النهائي هو إجراء الاستلام والترحيل نفسه؛ لا توجد شاشة استلام مستقلة.
 *
 * التكلفة محجوبة خادمياً لغير أدواتها (`purchases.get` يُفرغ الأسعار والإجماليات إلى null)
 * ⇒ الشاشة تعرض «—» بلا منطق حجبٍ عميليّ موازٍ.
 */
export default function PurchaseOrderDetail() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const po = trpc.purchases.get.useQuery(
    { purchaseOrderId },
    { enabled: Number.isFinite(purchaseOrderId) && purchaseOrderId > 0 },
  );
  const me = trpc.auth.me.useQuery();

  const legacyEdit = hasModuleAccess(
    me.data?.role ?? "",
    (
      me.data as
        | {
            permissionsOverride?: Record<
              string,
              "NONE" | "READ" | "FULL"
            > | null;
          }
        | undefined
    )?.permissionsOverride ?? null,
    "purchases",
    "FULL",
  );
  const canEdit = canLifecycleOperation(me.data, "purchases.updateOrder", legacyEdit);
  const canConfirm = canLifecycleOperation(me.data, "purchases.confirmOrder", legacyEdit);
  const canDecide = canLifecycleOperation(me.data, "purchases.decideControl", legacyEdit);
  const canSettleShipping = canLifecycleOperation(me.data, "purchases.settleShippingFromShift", legacyEdit);
  const canRequestPayment = canLifecycleOperation(me.data, "supplierPayments.requestPayment", legacyEdit);
  const canAutoSettle = canLifecycleOperation(me.data, "purchases.reconcileSettlement", legacyEdit);
  const canReverseReceipt = canLifecycleOperation(me.data, "goodsReceiptReversal.requestReversal", legacyEdit);
  const canRevisePaymentSource = canLifecycleOperation(
    me.data,
    "purchases.revisePaymentSource",
    legacyEdit,
  );

  const [isSettleShippingOpen, setIsSettleShippingOpen] = useState(false);
  const [isRevisePaymentOpen, setIsRevisePaymentOpen] = useState(false);
  const [revisePaymentReason, setRevisePaymentReason] = useState("");
  const [reviseRequestId, setReviseRequestId] = useState(() =>
    crypto.randomUUID(),
  );
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [submitReason, setSubmitReason] = useState("إرسال أمر الشراء للاعتماد");
  const [submitInvoiceTotal, setSubmitInvoiceTotal] = useState("");
  const [confirmAnomalousRate, setConfirmAnomalousRate] = useState(false);
  const [rateDeviationReason, setRateDeviationReason] = useState("");
  const [approveTarget, setApproveTarget] = useState<{
    id: number;
    poNumber: string;
    controlRequestId: number;
    creatorId: number | null;
    version: number;
    settlementType: "CASH" | "CREDIT";
    branchId: number;
    agreedCurrency: string | null;
    total: string | null;
  } | null>(null);
  const [isRejectOpen, setIsRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const utils = trpc.useUtils();
  const invalidateDetail = () =>
    Promise.all([
      utils.purchases.get.invalidate({ purchaseOrderId }),
      utils.purchases.list.invalidate(),
      utils.purchases.events.invalidate({ purchaseOrderId }),
      utils.purchases.pendingControls.invalidate(),
    ]);
  const poData = po.data;
  const pendingControls = trpc.purchases.pendingControls.useInfiniteQuery(
    { limit: 200 },
    {
      enabled: canDecide && poData?.status === "SENT",
      getNextPageParam: (page) =>
        page.hasMore ? (page.nextCursor ?? undefined) : undefined,
    },
  );
  const activeControlRequest = (
    pendingControls.data?.pages.flatMap((p) => p.rows) ?? []
  ).find(
    (row): row is Extract<typeof row, { documentType: "PURCHASE_ORDER" }> =>
      row.documentType === "PURCHASE_ORDER" &&
      Number(row.purchaseOrderId) === Number(poData?.id ?? purchaseOrderId) &&
      row.kind === "APPROVE_REVISION",
  );
  const confirmOrderMut = trpc.purchases.confirmOrder.useMutation({
    onSuccess: async (res) => {
      setIsSubmitOpen(false);
      setSubmitInvoiceTotal("");
      setConfirmAnomalousRate(false);
      setRateDeviationReason("");
      notify.ok("تم إرسال أمر الشراء للاعتماد");
      if (res.unitCostWarnings?.length) {
        notify.warn(res.unitCostWarnings.map((w) => w.message).join(" • "));
      }
      await invalidateDetail();
    },
    onError: (err) => notify.err(err),
  });
  const rejectControlMut = trpc.purchases.decideControl.useMutation({
    onSuccess: async () => {
      setIsRejectOpen(false);
      setRejectReason("");
      notify.ok("تم رفض طلب اعتماد أمر الشراء وإعادته مسودة");
      await invalidateDetail();
    },
    onError: (err) => notify.err(err),
  });
  const reviseGoodsTotal =
    poData && poData.subtotal != null
      ? D(poData.subtotal).plus(D(poData.taxAmount ?? 0)).toFixed(2)
      : "0";
  const reviseTenderState = usePurchaseTenderState({
    branchId: poData?.branchId ?? null,
    supplierId: poData?.supplierId ?? null,
    enabled:
      isRevisePaymentOpen &&
      poData != null &&
      poData.settlementType === "CASH" &&
      poData.agreedCurrency !== "USD",
    context: "edit",
    isCreator: poData != null && me.data?.id === poData.createdBy,
    total: reviseGoodsTotal,
  });
  const revisePaymentMut = trpc.purchases.revisePaymentSource.useMutation({
    onSuccess: async (res) => {
      setIsRevisePaymentOpen(false);
      setRevisePaymentReason("");
      setReviseRequestId(crypto.randomUUID());
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
        utils.purchases.revisions.invalidate({ purchaseOrderId }),
        utils.purchases.events.invalidate({ purchaseOrderId }),
        utils.purchases.pendingControls.invalidate(),
      ]);
      if (
        res.shortageWarning?.hasShortage &&
        res.shortageWarning.warningMessage
      ) {
        notify.warn(res.shortageWarning.warningMessage);
      }
      notify.ok(
        `تم إنشاء المراجعة المحكومة #${res.revisionNo ?? res.revisionId} لتصحيح مصدر السداد بعد التحقق من عدم وجود صرف فعلي سابق`,
      );
    },
    onError: (err) => notify.err(err),
  });
  const autoSettleSupplierMut = trpc.purchases.reconcileSettlement.useMutation({
    onSuccess: async (res) => {
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
        utils.purchases.integrityReport.invalidate(),
        utils.suppliers.list.invalidate(),
      ]);
      if (
        res.settledOrdersCount > 0 ||
        res.partiallySettledOrdersCount > 0 ||
        res.nativeAdoptedEpisodesCount > 0
      ) {
        notify.ok(
          `تمت مطابقة سندات الصرف السابقة للمورد (${res.supplierName}) وتسوية ${fmtAr(res.totalSettledAmount)} د.ع دون صرف مكرر`,
        );
      } else if (res.ownerRequiredEpisodesCount > 0) {
        notify.warn(
          "توجد سندات صرف تاريخية مطابقة للفواتير الاصلية لهذا المورد، لكن ربطها التوثيقي يتطلب اعتماد حساب المالك النشط لمنع الصرف المكرر",
        );
      } else if (res.unclaimedDisbursementsCount > 0) {
        notify.warn(
          "يوجد سند صرف سابق غير مخصص لهذا المورد لا يتطابق تلقائيا مع رصيد الفاتورة المفتوحة؛ راجع كشف حساب المورد قبل اصدار اي دفعة جديدة لمنع الصرف المكرر",
        );
      } else {
        notify.info(
          "لا توجد سندات صرف سابقة غير مخصصة لهذا المورد؛ استخدم (سداد الفاتورة النقدية الان) لتوثيق الصرف الفعلي",
        );
      }
    },
    onError: (err) => {
      notify.err(err);
    },
  });
  const settleShippingMut = trpc.purchases.settleShippingFromShift.useMutation({
    onSuccess: async (res) => {
      notify.ok(
        "تم صرف أجور الشحن من درج الوردية بنجاح",
        `تم تسجيل سند الصرف رقم ${res.voucherNumber || `#${res.receiptId}`} بمبلغ ${fmtAr(res.amount)} د.ع وحسمه من رصيد الوردية #${res.shiftId}`,
      );
      setIsSettleShippingOpen(false);
      await Promise.all([
        utils.purchases.get.invalidate({ purchaseOrderId }),
        utils.purchases.list.invalidate(),
      ]);
    },
    onError: (err) => {
      notify.err(err);
    },
  });

  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return <ErrorState message="رقم أمر شراء غير صالح." />;
  }
  if (po.isLoading) return <LoadingState />;
  // دورٌ مُنح «التقارير» صراحةً دون «المشتريات» يعبُر سجلّ المشتريات/الأستاذ (بوّابة reports)
  // ثمّ يصطدم هنا بـFORBIDDEN لأنّ `purchases.get` يلزمه purchases≥READ. لا نُوسّع الإجراء
  // (يسرّب تكلفة الشراء لأدوارٍ لم تُمنَحها) — نشرح السبب بدل خطأٍ خام.
  if (po.error) {
    return po.error.data?.code === "FORBIDDEN" ? (
      <EmptyState
        title="لا تملك صلاحية «المشتريات»"
        description="تفاصيل أمر الشراء تتطلّب صلاحية المشتريات (قراءة) — اطلبها من المدير."
      />
    ) : (
      <ErrorState message={po.error.message} />
    );
  }
  if (!po.data) {
    return (
      <EmptyState
        title="أمر الشراء غير موجود"
        description="قد يكون محذوفاً أو يخصّ فرعاً آخر لا تملك الاطّلاع عليه."
      />
    );
  }

  const d = po.data;
  const costHidden = d.total === null;
  const isUsd = d.agreedCurrency === "USD";
  const currentUserId = me.data?.id;
  const isOwner = me.data?.isOwner === true;
  const isManagerOrOwner =
    isOwner || me.data?.role === "admin" || me.data?.role === "manager";
  const violatesSod =
    !isOwner &&
    (currentUserId == null ||
      (activeControlRequest != null &&
        [
          activeControlRequest.requestedBy,
          activeControlRequest.creatorId,
          activeControlRequest.lastEditedBy,
          d.lastEditedBy,
          d.submittedBy,
        ].some((id) => id != null && Number(id) === Number(currentUserId))));
  // المتبقّي للمورّد بعملة الاتفاق: أمر الدولار تُتابَع ذمّته بـusdTotal−paidUsd−returnedUsd
  // (نفس حساب PurchaseReceive وخدمة التسوية) — عرض متبقّي الدينار وحده يُظهر رقماً مختلفاً مادّياً.
  const settlement = getPurchaseSettlement(d);
  const settlementIqd = getPurchaseSettlement({ ...d, agreedCurrency: "IQD" });
  const remaining = costHidden ? null : D(settlement.remainingAmount);
  // التعديل ممكن ما لم يبدأ الأثر الفعليّ: أمرٌ نهائيّ، أو استُلم منه سطر، أو حمل دفعة.
  // نفس حرّاس `updatePurchaseOrder` — والخادم هو الحكم النهائيّ.
  const openForEditing =
    d.status === "DRAFT" &&
    !d.items.some((it) => (it.receivedBaseQuantity ?? 0) > 0) &&
    !D(d.paidAmount ?? 0).gt(0) &&
    !D(d.paidUsd ?? 0).gt(0);
  const parsedNotes = splitDocumentNotes(d.notes);
  const cashSourceLabel = d.tender
    ? purchaseTenderLabel(d.tender)
    : d.legacyCashSource?.mode === "DRAWER"
      ? `نقد من الوردية${d.legacyCashSource.shiftId ? ` #${d.legacyCashSource.shiftId}` : ""}`
      : d.legacyCashSource?.mode === "TREASURY"
        ? "نقد من خزنة الفرع"
        : null;

  function printOrder() {
    const useUsdLines =
      isUsd &&
      (d.items.length === 0 ||
        d.items.every((it) => it.usdUnitPrice != null && it.usdTotal != null));
    const usdSubtotal = useUsdLines
      ? d.items
          .reduce((acc, it) => acc.plus(D(it.usdTotal ?? 0)), D(0))
          .toDecimalPlaces(2)
      : D(0);
    const usdTax =
      useUsdLines && d.usdTotal != null
        ? D(d.usdTotal).minus(usdSubtotal).toDecimalPlaces(2)
        : D(0);
    printPurchaseInvoiceV2({
      invoiceNumber: d.poNumber ?? `#${d.id}`,
      invoiceDate: d.orderDate,
      statusLabel: PO_STATUS[d.status] ?? d.status,
      supplierName: d.supplierName ?? "—",
      paymentMethod: getPurchaseSettlementIntentLabel(d.settlementType),
      cashSourceLabel: costHidden ? null : cashSourceLabel,
      createdByName:
        d.createdByName ?? (d.createdBy ? `مستخدم #${d.createdBy}` : null),
      approvedByName: d.approvedByName ?? null,
      agreedCurrency: d.agreedCurrency ?? "IQD",
      agreedRate: costHidden ? null : (d.agreedRate ?? null),
      usdTotal: costHidden ? null : (d.usdTotal ?? null),
      items: d.items.map((it) => ({
        productName: variantDisplayName({
          productName: it.productName ?? "",
          variantName: it.variantName,
          color: it.color,
          size: it.size,
          variantKind: it.variantKind,
          sku: it.sku,
        }),
        unitName: it.unitName ?? "قطعة",
        quantity: it.quantity,
        unitPrice: costHidden
          ? "—"
          : useUsdLines
            ? (it.usdUnitPrice ?? "0")
            : (it.unitPrice ?? "0"),
        total: costHidden
          ? "—"
          : ((useUsdLines ? it.usdTotal : it.total) ?? "0"),
        barcode: it.barcode ?? null,
      })),
      subtotal: costHidden
        ? "—"
        : useUsdLines
          ? usdSubtotal.toFixed(2)
          : (d.subtotal ?? "0"),
      discountAmount: costHidden
        ? null
        : useUsdLines
          ? (d.usdInvoiceDiscount ?? "0")
          : (d.invoiceDiscount ?? "0"),
      taxAmount: costHidden
        ? null
        : useUsdLines
          ? usdTax.toFixed(2)
          : (d.taxAmount ?? "0"),
      taxRate: d.taxRatePercent != null ? Number(d.taxRatePercent) : null,
      total: costHidden
        ? "—"
        : useUsdLines
          ? (d.usdTotal ?? d.total ?? "0")
          : (d.total ?? "0"),
      paidAmount: costHidden
        ? null
        : useUsdLines
          ? settlement.paidAmount
          : d.settlementType === "CASH"
            ? d.linkedCashPaidAmount
            : d.paidAmount,
      remainingAmount: remaining ? remaining.toFixed(2) : null,
    });
  }

  return (
    <div className="space-y-2.5">
      <PageHeader
        title={`أمر شراء ${d.poNumber ?? `#${d.id}`}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {d.status === "DRAFT" && canConfirm ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setSubmitInvoiceTotal("");
                  setSubmitReason("إرسال أمر الشراء للاعتماد");
                  setConfirmAnomalousRate(false);
                  setRateDeviationReason("");
                  setIsSubmitOpen(true);
                }}
              >
                <CheckCircle2 aria-hidden className="size-4" />
                إرسال للاعتماد
              </Button>
            ) : null}
            {d.status === "SENT" && canDecide && activeControlRequest ? (
              violatesSod ? (
                <Badge variant="outline" className="text-xs">
                  بانتظار مراجع مستقل (فصل المهام)
                </Badge>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      setApproveTarget({
                        id: Number(d.id),
                        poNumber: d.poNumber ?? `#${d.id}`,
                        controlRequestId: Number(activeControlRequest.id),
                        creatorId: d.createdBy != null ? Number(d.createdBy) : null,
                        version: Number(d.version),
                        settlementType: d.settlementType === "CASH" ? "CASH" : "CREDIT",
                        branchId: Number(d.branchId),
                        agreedCurrency: d.agreedCurrency ?? "IQD",
                        total: d.total != null ? String(d.total) : null,
                      })
                    }
                  >
                    <CheckCircle2 aria-hidden className="size-4" />
                    {d.settlementType === "CASH" && !isUsd
                      ? "اعتماد واستلام وسداد نقدي"
                      : "اعتماد واستلام"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setRejectReason("");
                      setIsRejectOpen(true);
                    }}
                  >
                    رفض
                  </Button>
                </>
              )
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={printOrder}>
              <Printer aria-hidden className="size-4" />
              طباعة
            </Button>
            {canEdit && openForEditing ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/purchases/${d.id}/edit`}>
                  <Pencil aria-hidden className="size-4" />
                  تعديل
                </Link>
              </Button>
            ) : null}
            {canReverseReceipt && d.status === "RECEIVED" ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/purchases/goods-receipt-reversals">
                  <RotateCcw aria-hidden className="size-4" />
                  عكس استلام / تصحيح الخطأ
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {/* م٢ ق١١ — «الخطوة التالية» لأمر الشراء. اختياريّ العقد فيسقط إلى null بأمان. */}
      <NextActionChip
        nextAction={d.nextAction ?? null}
        terminalReason={d.nextActionReason ?? null}
      />

      {!costHidden ? (
        <PurchaseRateAnomalyBanner
          purchaseOrderId={d.id}
          status={d.status}
          agreedCurrency={d.agreedCurrency}
          agreedRate={d.agreedRate}
          rateSanity={d.rateSanity}
          unitCostWarnings={d.unitCostWarnings}
          canEdit={canEdit && openForEditing}
        />
      ) : null}

      {d.status === "RECEIVED" && canReverseReceipt && (
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <CheckCircle2 aria-hidden className="size-4 text-[var(--sem-pos)]" />
            <span>
              أمر الشراء مستلم ومرحّل مخزنياً ومحاسبياً. لتصحيح أي خطأ إدخال أو سهو، استخدم مسار عكس الاستلام الذري لضمان سلامة الدفاتر والمخزون.
            </span>
          </div>
          <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
            <Link href="/purchases/goods-receipt-reversals">فتح مسار عكس الاستلام</Link>
          </Button>
        </div>
      )}

      <Card>
        <CardHeader className="py-2.5 px-4">
          <CardTitle className="text-sm font-bold">بيانات الأمر</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2.5 px-4 pb-3.5 pt-0 md:grid-cols-4">
          <Field label="المورّد">
            {d.supplierId ? (
              <Link
                href={`/suppliers/${d.supplierId}/edit`}
                className="text-primary underline-offset-2 hover:underline"
              >
                {d.supplierName ?? `#${d.supplierId}`}
              </Link>
            ) : (
              (d.supplierName ?? "—")
            )}
          </Field>
          <Field label="التاريخ">{fmtDate(d.orderDate)}</Field>
          <Field label="الحالة">
            <Badge variant={statusVariant(d.status)}>
              {PO_STATUS[d.status] ?? d.status}
            </Badge>
          </Field>
          <Field label="العملة المتّفقة">
            {isUsd ? "دولار أمريكي ($)" : "دينار عراقي (د.ع)"}
          </Field>
          <Field label="آلية التسوية">
            <div className="flex flex-wrap items-center gap-1.5">
              <span>{getPurchaseSettlementIntentLabel(d.settlementType)}</span>
              {d.settlementType === "CASH" && !costHidden && (d.tender || d.legacyCashSource) ? (
                <PaymentMethodChip
                  method={
                    d.tender?.mode === "CARD"
                      ? "CARD"
                      : d.tender?.mode === "TREASURY" ||
                          d.legacyCashSource?.mode === "TREASURY"
                        ? "TREASURY"
                        : "CASH"
                  }
                />
              ) : null}
            </div>
          </Field>
          {isUsd && !costHidden && d.agreedRate != null ? (
            <Field label="سعر الصرف المثبت">{fmtAr(d.agreedRate)} د.ع/$</Field>
          ) : null}
          <Field label="أنشأه">
            {d.createdByName ?? (d.createdBy ? `مستخدم #${d.createdBy}` : "—")}
          </Field>
          <Field label="اعتمده">
            {d.approvedByName ?? "لم يُعتمد بعد"}
          </Field>
          {parsedNotes.poReference ? (
            <Field label="مرجع أمر الشراء">{parsedNotes.poReference}</Field>
          ) : null}
          {parsedNotes.notes ? (
            <div className="col-span-2 md:col-span-4">
              <Field label="ملاحظات">{parsedNotes.notes}</Field>
            </div>
          ) : null}
          {parsedNotes.terms ? (
            <div className="col-span-2 md:col-span-4">
              <Field label="الشروط والأحكام">{parsedNotes.terms}</Field>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {!costHidden ? <PurchasePaymentEvidence tender={d.tender} paymentReceipts={d.paymentReceipts ?? []} /> : null}

      {!costHidden && d.goodsPaymentSummary ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 py-2.5 px-4">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Banknote aria-hidden className="size-4 text-primary" />
              سداد البضاعة ومصدر الدفع (منفصل عن الشحن)
            </CardTitle>
            {canRevisePaymentSource &&
            (d.status === "DRAFT" || d.status === "SENT") &&
            (d.paymentReceipts ?? []).length === 0 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  reviseTenderState.reset(
                    d.tender ?? null,
                    `${d.branchId ?? ""}:${d.supplierId ?? ""}`,
                    d.legacyCashSource ?? null,
                    false,
                  );
                  setRevisePaymentReason("");
                  setReviseRequestId(crypto.randomUUID());
                  setIsRevisePaymentOpen(true);
                }}
              >
                <Pencil aria-hidden className="size-3.5" />
                تصحيح مصدر السداد
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2.5 px-4 pb-3.5 pt-0 text-xs">
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <Field label="إجمالي البضاعة">
                <span className="font-semibold">{fmtAr(d.goodsPaymentSummary.goodsTotal)} د.ع</span>
              </Field>
              <Field label="مصدر سداد البضاعة">
                {d.goodsPaymentSummary.sourceMode === "DRAWER"
                  ? `درج وردية المنشئ${d.goodsPaymentSummary.shiftId ? ` #${d.goodsPaymentSummary.shiftId}` : ""}`
                  : d.goodsPaymentSummary.sourceMode === "TREASURY"
                    ? "خزينة الفرع الرئيسية"
                    : d.goodsPaymentSummary.sourceMode === "CARD"
                      ? `بطاقة الشركة${d.goodsPaymentSummary.cardLastFour ? ` (${d.goodsPaymentSummary.cardLastFour})` : ""}`
                      : "غير محدّد"}
              </Field>
              <Field label="دفعة المورد السابقة المحتسبة">
                {fmtAr(d.goodsPaymentSummary.priorAppliedAmount)} د.ع
                {d.goodsPaymentSummary.priorVoucherNumber
                  ? ` (${d.goodsPaymentSummary.priorVoucherNumber})`
                  : ""}
              </Field>
              <Field label="المتبقي للصرف على البضاعة">
                <span className="font-semibold">{fmtAr(d.goodsPaymentSummary.remainingPayable)} د.ع</span>
              </Field>
              <Field label="الرصيد المتاح في المصدر">
                {d.goodsPaymentSummary.availableCash != null
                  ? `${fmtAr(d.goodsPaymentSummary.availableCash)} د.ع`
                  : "—"}
              </Field>
              <Field label="العجز النقدي للبضاعة">
                {d.goodsPaymentSummary.hasShortage ? (
                  <Badge variant="destructive">
                    {fmtAr(d.goodsPaymentSummary.shortageAmount)} د.ع
                  </Badge>
                ) : (
                  <span className="text-[var(--sem-pos)]">0.00 د.ع (مغطّى)</span>
                )}
              </Field>
              <Field label="مصدر الشحن والكمرك (مستقل)">
                {D(d.goodsPaymentSummary.shipping.shippingTotal).gt(0)
                  ? `${fmtAr(d.goodsPaymentSummary.shipping.shippingTotal)} د.ع — ${
                      d.goodsPaymentSummary.shipping.fundingSource === "DRAWER"
                        ? "درج الوردية"
                        : d.goodsPaymentSummary.shipping.fundingSource === "TREASURY"
                          ? "الخزينة"
                          : "استحقاق شحن"
                    }`
                  : "لا يوجد شحن"}
              </Field>
              <Field label="حالة سند الشحن">
                {d.goodsPaymentSummary.shipping.voucherStatus === "RECORDED"
                  ? `مثبّت بسند #${d.goodsPaymentSummary.shipping.recordedReceiptId ?? "—"}`
                  : d.goodsPaymentSummary.shipping.voucherStatus === "PENDING_DISBURSEMENT"
                    ? "بانتظار الصرف الفعلي"
                    : d.goodsPaymentSummary.shipping.voucherStatus === "CONFLICT"
                      ? "تعارض مستندات شحن"
                      : "لا سند شحن"}
              </Field>
            </div>
            {d.goodsPaymentSummary.hasShortage && d.goodsPaymentSummary.warningMessage ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)]"
              >
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{d.goodsPaymentSummary.warningMessage}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* بعد cutover، الدفع يُخصَّص إلى فاتورة مورد مرحّلة لا إلى أمر الشراء مباشرةً. */}
      {settlement.requiresReview ? (
        <p role="alert" className="border border-money-negative p-2.5 text-xs text-money-negative">
          دليل السداد يحتاج مراجعة. طلب السداد متوقف حتى مطابقة المستندات.
        </p>
      ) : null}
      {d.status !== "RECEIVED" && d.status !== "CANCELLED" ? (
        <Card>
          <CardContent className="p-3 text-xs leading-relaxed text-muted-foreground">
            {d.settlementType === "CASH"
              ? "هذه فاتورة شراء نقدية: عند اعتمادها واستلام البضاعة، سيصرف النظام قيمتها نقدا في نفس العملية وتصبح الذمة المتبقية 0.00 تلقائيا."
              : "هذه فاتورة شراء بالاجل: لا يطلب سدادها قبل الاستلام؛ عند اعتمادها واستلام البضاعة تسجل ذمة اجلة على المورد وتتاح للتسديد."}
          </CardContent>
        </Card>
      ) : null}
      {d.status === "RECEIVED" &&
      !settlement.requiresReview &&
      remaining != null &&
      remaining.gt(0) ? (
        <Card
          className={
            d.settlementType === "CASH"
              ? "border-destructive/50 bg-destructive/5"
              : undefined
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              {d.settlementType === "CASH" ? (
                <>
                  <AlertTriangle aria-hidden className="size-4 text-destructive" />
                  <span className="text-destructive">
                    تنبيه: فاتورة شراء نقدية مستلمة لم يوثق سدادها ({fmtAr(remaining.toFixed(2))} {isUsd ? "$" : "د.ع"})
                  </span>
                </>
              ) : (
                <span>تسديد ذمة المورد</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {d.settlementType === "CASH"
                ? "هذه الفاتورة مسجلة نقدية لكن رصيدها ما زال مفتوحا (فاتورة تاريخية قبل الترحيل الذري). ان كان قد صدر لها سند صرف عام سابقا فطابق سندات المورد هنا دون صرف مكرر، وان لم يصرف النقد بعد فسددها الان."
                : `الرصيد المفتوح على هذه الفاتورة قدره ${fmtAr(remaining.toFixed(2))} ${isUsd ? "$" : "د.ع"}. اعتماد سند صرف للمورد او دفعة مورد يخفض ذمة المورد ويسوي الفاتورة المفتوحة تلقائيا.`}
            </p>
            {(canRequestPayment || canAutoSettle) && d.supplierId != null ? (
              <div className="flex flex-wrap gap-2">
                {canRequestPayment ? (
                  <>
                    <Button asChild size="sm">
                      <Link href={`/purchases/supplier-payments?supplierId=${d.supplierId}`}>
                        <Banknote aria-hidden className="size-4" />
                        {d.settlementType === "CASH"
                          ? "سداد الفاتورة النقدية الان"
                          : "فتح تسديدات فواتير المورد"}
                      </Link>
                    </Button>
                    {!isUsd ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/vouchers/payment/new?partyType=SUPPLIER&partyId=${d.supplierId}`}>
                          <Receipt aria-hidden className="size-4" />
                          اصدار سند صرف للمورد
                        </Link>
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {canAutoSettle && d.settlementType === "CASH" && !isUsd ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={autoSettleSupplierMut.isPending}
                    onClick={() =>
                      autoSettleSupplierMut.mutate({
                        supplierId: Number(d.supplierId),
                      })
                    }
                  >
                    <HandCoins aria-hidden className="size-4" />
                    مطابقة سند صرف سابق دون صرف مكرر
                  </Button>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">البنود</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* مُضمَّن: البطاقة تحمل عنوان «البنود»، والإجماليات في بطاقةٍ مستقلّة أدناه. */}
          <DataTable<PoItemRow>
            embedded
            searchable={false}
            bounded={false}
            pageSize={Infinity}
            data={d.items}
            columns={poItemColumns(isUsd)}
            emptyText="لا بنود في هذا الأمر."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">الإجماليات</CardTitle>
        </CardHeader>
        <CardContent>
          {costHidden ? (
            <p className="text-sm text-muted-foreground">
              قيم التكلفة محجوبة عن صلاحيّتك.
            </p>
          ) : (
            <div className="space-y-3">
              {/* ما يُحسَب فعلاً ضمن «الإجمالي» وذمّة المورّد — بضاعةٌ فقط، بلا شحن ولا كمرك
                  (قرار المالك ٥/٨/٢٦: order.ts `total = subtotal + tax`). كانا سابقاً يُعرَضان
                  كسطرَين مجاورَين لهذه المجموعة فيبدوان مطروحَين منها رغم أنهما لم يدخلاها قطّ —
                  فُصلا بصرياً أدناه ليزول هذا الالتباس. */}
              {isUsd && d.usdTotal != null && d.agreedRate != null ? (
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  فاتورة المورد (<bdi dir="ltr" className="font-semibold text-foreground">{fmtAr(d.usdTotal)} $</bdi>) × سعر الصرف المثبت (<bdi dir="ltr" className="font-semibold text-foreground">{fmtAr(d.agreedRate)} د.ع/$</bdi>) = الإجمالي المعادل (<bdi dir="ltr" className="font-semibold text-foreground">{fmtAr(d.total)} د.ع</bdi>)
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="المجموع قبل الضريبة (د.ع)">{fmtAr(d.subtotal)} د.ع</Field>
                {/* خصم فاتورة المورّد (0204): **مطبَّقٌ في الأعمدة أعلاه** — المجموع صافٍ بعده،
                    والذمّة وتكلفة المخزون كذلك. يُعرَض إفصاحاً لا بنداً يُطرَح مرّةً أخرى. */}
                {D(d.invoiceDiscount ?? 0).gt(0) && (
                  <Field label="خصم فاتورة المورّد (مطبَّق)">
                    −{fmtAr(d.invoiceDiscount)} د.ع
                    {isUsd && D(d.usdInvoiceDiscount ?? 0).gt(0)
                      ? ` (${fmtAr(d.usdInvoiceDiscount)} $)`
                      : ""}
                  </Field>
                )}
                <Field label="الضريبة (د.ع)">{fmtAr(d.taxAmount)} د.ع</Field>
                <Field label={isUsd ? "المعادل المحاسبي (د.ع)" : "إجمالي أمر الشراء (د.ع)"}>
                  <span className="font-bold">{fmtAr(d.total)} د.ع</span>
                </Field>
                {!D(settlementIqd.invoiceTotalAmount).eq(D(d.total ?? 0)) ? (
                  <Field label="المفوتر بذمة المورد (د.ع)">{fmtAr(settlementIqd.invoiceTotalAmount)} د.ع</Field>
                ) : null}
                <Field label="آلية التسوية">{getPurchaseSettlementIntentLabel(d.settlementType)}</Field>
                <Field label="حالة السداد">{settlement.statusLabel}</Field>
                {isUsd ? (
                  <>
                    <Field label="فاتورة المورد ($)">{fmtAr(d.usdTotal)} $</Field>
                    <Field label="المدفوع للمورد ($)">{fmtAr(settlement.paidAmount)} $</Field>
                    {D(settlement.returnedAmount).gt(0) ? (
                      <Field label="تخفيض الذمة ($)">{fmtAr(settlement.returnedAmount)} $</Field>
                    ) : null}
                    <Field label="المتبقّي للمورّد ($)">
                      <span
                        className={`font-semibold ${remaining && remaining.lte(0) ? "text-money-positive" : ""}`}
                      >
                        {fmtAr(remaining?.toString())} $
                        {remaining && remaining.lte(0) ? ` (${settlement.statusLabel})` : ""}
                      </span>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="المدفوع (د.ع)">{fmtAr(settlementIqd.paidAmount)} د.ع</Field>
                    {D(settlementIqd.returnedAmount).gt(0) ? (
                      <Field label="تخفيض الذمة (د.ع)">{fmtAr(settlementIqd.returnedAmount)} د.ع</Field>
                    ) : null}
                    <Field label="المتبقّي (د.ع)">
                      <span
                        className={`font-semibold ${remaining && remaining.lte(0) ? "text-money-positive" : ""}`}
                      >
                        {fmtAr(remaining?.toString())} د.ع
                        {remaining && remaining.lte(0) ? ` (${settlement.statusLabel})` : ""}
                      </span>
                    </Field>
                  </>
                )}
              </div>

              {(D(d.shippingCost ?? 0).gt(0) || D(d.customsCost ?? 0).gt(0)) && (
                <Card>
                  <CardContent className="p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                      <div className="flex items-center gap-2">
                        <Truck className="size-4 text-primary" aria-hidden />
                        <span className="font-semibold text-sm">أجور الشحن والكمرك والتفريغ</span>
                      </div>
                      <div>
                        {d.shippingPayment?.obligationStatus === "PAID" ? (
                          d.shippingPayment.cashBucket === "DRAWER" ? (
                            <Badge variant="outline" className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] gap-1.5 py-0.5">
                              <CheckCircle2 className="size-3.5" aria-hidden />
                              مدفوع نقداً من درج الوردية #{d.shippingPayment.shiftId}
                            </Badge>
                          ) : d.shippingPayment.cashBucket === "TREASURY" ? (
                            <Badge variant="outline" className="border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] text-[var(--sem-info)] gap-1.5 py-0.5">
                              <Landmark className="size-3.5" aria-hidden />
                              مدفوع من الخزينة الإدارية
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] gap-1.5 py-0.5">
                              <CheckCircle2 className="size-3.5" aria-hidden />
                              تم السداد بالكامل
                            </Badge>
                          )
                        ) : d.shippingPayment?.obligationStatus === "PAYMENT_PENDING" ? (
                          <Badge variant="outline" className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] gap-1.5 py-0.5">
                            <Clock className="size-3.5" aria-hidden />
                            طلب صرف بانتظار اعتماد المالك
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-[var(--sem-danger)]/40 bg-[var(--sem-danger-bg)] text-[var(--sem-danger)] gap-1.5 py-0.5">
                            <AlertTriangle className="size-3.5" aria-hidden />
                            {purchaseShippingAdjustmentLabel(d.shippingPayment?.obligationStatus) ?? "مستحق غير مسدد"}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <Field label="أجور الشحن">{fmtAr(d.shippingCost)} د.ع</Field>
                      <Field label="الرسوم الجمركية">{fmtAr(d.customsCost)} د.ع</Field>
                      <Field label="إجمالي المصروف الإضافي">
                        <span className="font-bold text-foreground">
                          {fmtAr(d.shippingPayment?.totalLanded ?? D(d.shippingCost ?? 0).plus(D(d.customsCost ?? 0)).toString())} د.ع
                        </span>
                      </Field>
                      {d.shippingPayment?.voucherNumber ? (
                        <Field label="سند الصرف المالي">
                          <Link
                            href={`/vouchers?search=${encodeURIComponent(d.shippingPayment.voucherNumber)}`}
                            className="text-primary hover:underline inline-flex items-center gap-1 font-mono text-xs font-semibold"
                          >
                            <Receipt className="size-3.5" aria-hidden />
                            {d.shippingPayment.voucherNumber}
                            <ExternalLink className="size-3" aria-hidden />
                          </Link>
                        </Field>
                      ) : (
                        <Field label="سند الصرف المالي">
                          <span className="text-muted-foreground text-xs">لم يُنشأ سند بعد</span>
                        </Field>
                      )}
                    </div>

                    <PurchaseShippingRefund refund={d.shippingPayment?.refund} />
                    {d.shippingPayment?.payee ? (
                      <div className="text-xs text-muted-foreground flex items-center gap-1 pt-1">
                        <span>الجهة المستفيدة / الناقل:</span>
                        <span className="font-medium text-foreground">{d.shippingPayment.payee}</span>
                      </div>
                    ) : null}

                    {d.shippingFundingSource === "DRAWER" && d.shippingPayment?.obligationStatus === "PAYMENT_PENDING" ? (
                      <p className="text-xs text-muted-foreground border-t pt-2">
                        تصريح الدفع من درج المنشئ ينتظر اعتماد سند الشحن المرتبط أعلاه، مستقلاً عن اعتماد الفاتورة. لا تغلق الوردية قبل توثيقه.
                      </p>
                    ) : null}
                    {canSettleShipping && d.shippingFundingSource !== "DRAWER" && !d.shippingPayment?.hasRecordedPayment && d.shippingPayment?.obligationStatus !== "PAID" && d.status === "RECEIVED" ? (
                      <div className="pt-2 flex items-center justify-between border-t gap-2 flex-wrap">
                        <p className="text-xs text-muted-foreground">
                          يمكن صرف أجور الشحن مباشرةً من درج الوردية النقدية النشطة لتُسجل كنفقات وردية وتُخصم من رصيد الكاشير.
                        </p>
                        <Button
                          size="sm"
                          onClick={() => setIsSettleShippingOpen(true)}
                          disabled={settleShippingMut.isPending}
                          className="gap-1.5 font-medium"
                        >
                          <HandCoins className="size-4" aria-hidden />
                          صرف الشحن من درج الوردية
                        </Button>
                      </div>
                    ) : null}

                    <p className="text-[11px] leading-relaxed text-muted-foreground border-t pt-2">
                      يسجل هذا المبلغ مصروف نقل على الشركة عند الاستلام، ولا يضاف إلى تكلفة المخزون أو ذمة المورد.
                      مصدر النقد هو درج منفذ الدفع الموثق، وليس وردية المعتمد أو المدقق.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {!costHidden ? <PurchaseOrderGovernance purchaseOrderId={purchaseOrderId} /> : null}

      <Dialog open={isRevisePaymentOpen} onOpenChange={setIsRevisePaymentOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>تصحيح مصدر سداد البضاعة بمراجعة محكومة</DialogTitle>
            <DialogDescription className="text-right text-xs leading-relaxed">
              يتحقق الخادم ذرياً من عدم وجود سند دفع فعلي مسجّل على الأمر {d.poNumber} قبل إنشاء مراجعة جديدة لمصدر السداد.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <PurchaseTenderField
              idPrefix="po-revise-payment"
              state={reviseTenderState}
              paymentTerms="CASH"
              currency={d.agreedCurrency ?? "IQD"}
            />
            <div className="space-y-1">
              <Label htmlFor="po-revise-reason" className="text-xs">
                سبب تصحيح مصدر السداد *
              </Label>
              <Textarea
                id="po-revise-reason"
                rows={2}
                value={revisePaymentReason}
                onChange={(e) => setRevisePaymentReason(e.target.value)}
                placeholder="اشرح سبب تغيير مصدر السداد (3 أحرف على الأقل)…"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRevisePaymentOpen(false)}
              disabled={revisePaymentMut.isPending}
            >
              إلغاء
            </Button>
            <Button
              type="button"
              disabled={
                revisePaymentMut.isPending ||
                reviseTenderState.isActionBlocked ||
                revisePaymentReason.trim().length < 3
              }
              onClick={() => {
                if (!reviseTenderState.payload) return;
                revisePaymentMut.mutate({
                  purchaseOrderId: d.id,
                  expectedVersion: d.version,
                  reason: revisePaymentReason.trim(),
                  tender: reviseTenderState.payload,
                  cashSource: undefined,
                  clientRequestId: reviseRequestId,
                });
              }}
            >
              {revisePaymentMut.isPending ? ACTION_LABELS.saving : "حفظ المراجعة الجديدة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isSettleShippingOpen} onOpenChange={setIsSettleShippingOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="size-5 text-primary" aria-hidden />
              تأكيد صرف أجور الشحن من درج الوردية
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-right">
              <div>
                أمر الشراء: <span className="font-semibold text-foreground">{d.poNumber}</span>
              </div>
              <div>
                مبلغ الشحن والكمرك المستحق:{" "}
                <span className="font-bold text-foreground">
                  {fmtAr(
                    d.shippingPayment?.totalLanded ??
                      D(d.shippingCost ?? 0).plus(D(d.customsCost ?? 0)).toString(),
                  )}{" "}
                  د.ع
                </span>
              </div>
              <div className="rounded-md border bg-muted/50 p-2.5 text-xs text-muted-foreground leading-relaxed mt-2">
                يوثق هذا الإجراء دفعاً نقدياً فعلياً من درج منشئ الفاتورة في فرعها، لا درج المعتمد. ينقص النقد المتوقع بمقدار الشحن؛ لا تؤكد الصرف إلا إذا كان هذا مصدر الدفع الحقيقي.
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setIsSettleShippingOpen(false)}
              disabled={settleShippingMut.isPending}
            >
              إلغاء
            </Button>
            <Button
              onClick={() => {
                settleShippingMut.mutate({ purchaseOrderId: d.id });
              }}
              disabled={settleShippingMut.isPending}
            >
              {settleShippingMut.isPending ? "جارٍ الصرف…" : "تأكيد الصرف والخصم من الوردية"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PurchaseQuickApproveDialog
        target={approveTarget}
        currentUserId={me.data?.id}
        onClose={() => setApproveTarget(null)}
        onApproved={async () => {
          setApproveTarget(null);
          await invalidateDetail();
        }}
      />
      <PurchaseOrderActionDialogs
        poNumber={d.poNumber ?? `#${d.id}`}
        isUsd={isUsd}
        costHidden={costHidden}
        isManagerOrOwner={isManagerOrOwner}
        rateSanity={d.rateSanity}
        submitOpen={isSubmitOpen}
        onSubmitOpenChange={setIsSubmitOpen}
        submitPending={confirmOrderMut.isPending}
        submitInvoiceTotal={submitInvoiceTotal}
        submitInvoicePlaceholder={!costHidden ? String(isUsd ? (d.usdTotal ?? "") : (d.total ?? "")) : undefined}
        onSubmitInvoiceTotalChange={setSubmitInvoiceTotal}
        submitReason={submitReason}
        onSubmitReasonChange={setSubmitReason}
        confirmAnomalousRate={confirmAnomalousRate}
        onConfirmAnomalousChange={setConfirmAnomalousRate}
        rateDeviationReason={rateDeviationReason}
        onRateDeviationReasonChange={setRateDeviationReason}
        onConfirmSubmit={() =>
          confirmOrderMut.mutate({
            purchaseOrderId: d.id,
            expectedVersion: Number(d.version),
            reason: submitReason.trim(),
            clientRequestId: `po-submit-${d.id}-${crypto.randomUUID()}`,
            ...(!costHidden ? { supplierInvoiceTotal: submitInvoiceTotal.trim(), requireInvoiceMatch: true } : {}),
            ...(confirmAnomalousRate ? { confirmAnomalousRate: true, rateDeviationReason: rateDeviationReason.trim() } : {}),
          })
        }
        rejectOpen={isRejectOpen}
        onRejectOpenChange={setIsRejectOpen}
        rejectPending={rejectControlMut.isPending}
        rejectReason={rejectReason}
        onRejectReasonChange={setRejectReason}
        onConfirmReject={() => {
          if (!activeControlRequest) return;
          rejectControlMut.mutate({
            requestId: Number(activeControlRequest.id),
            decisionKey: `po-reject-${activeControlRequest.id}-${crypto.randomUUID()}`,
            approve: false,
            reason: rejectReason.trim(),
          });
        }}
      />
    </div>
  );
}
