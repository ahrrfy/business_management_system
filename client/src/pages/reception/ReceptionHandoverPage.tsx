/**
 * ReceptionHandoverPage - شاشة التسليم المباشر للزبون
 * المسار: /reception/handover
 * تُفتح من رأس شاشة الاستقبال — مسح باركود → تفاصيل → تحصيل نقدي ذري
 */
import { useCallback, useRef, useState } from "react";

import {
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  CheckCircle2,
  CreditCard,
  Package,
  ScanLine,
  User,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { D, fmt, fmtInt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { resolveOrderLookupBarcode } from "@/lib/scanRouter";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { getDeviceCode } from "@/lib/offline/outbox";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { cn } from "@/lib/utils";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import { CardBrandLogos } from "@/components/ui/CardBrandLogos";
import { useInvoiceReceiptPrinter } from "@/hooks/useInvoiceReceiptPrinter";
import { useInvoiceActionPermissions } from "@/hooks/useInvoiceActionPermissions";
import { preopenDocumentWindow, printReceipt } from "@/lib/printing/print";
import { invoiceToReceipt } from "@/lib/printing/invoiceReceipt";
import { printInvoicePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";

const PAYMENT_METHODS = [
  { v: "CASH", label: "نقدي", icon: Banknote },
  { v: "CARD", label: "بطاقة", icon: CreditCard },
  { v: "TRANSFER", label: "تحويل", icon: ArrowLeftRight },
  { v: "WALLET", label: "محفظة", icon: Wallet },
] as const;
type ReceptionHandoverMethod = (typeof PAYMENT_METHODS)[number]["v"];

interface SiblingWorkOrder {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  salePrice: string;
  deposit: string | null;
  hasDelivery: boolean;
  customerName: string | null;
  customerPhone: string | null;
}

interface ScannedOrder {
  id: number;
  kind?: "workOrder" | "invoice" | "onlineOrder";
  orderNumber: string;
  title: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salePrice: string;
  deposit: string | null;
}

function siblingToScanned(item: SiblingWorkOrder, fallbackCustomer?: { name?: string | null; phone?: string | null }): ScannedOrder {
  return {
    id: item.id,
    kind: "workOrder",
    orderNumber: item.orderNumber,
    title: item.title,
    customerName: item.customerName ?? fallbackCustomer?.name ?? null,
    customerPhone: item.customerPhone ?? fallbackCustomer?.phone ?? null,
    salePrice: item.salePrice,
    deposit: item.deposit,
  };
}

export default function ReceptionHandoverPage() {
  const [scanned, setScanned] = useState<ScannedOrder | null>(null);
  const [siblingOrders, setSiblingOrders] = useState<SiblingWorkOrder[]>([]);
  const [manualInput, setManualInput] = useState("");
  const [method, setMethod] = useState<ReceptionHandoverMethod>("CASH");
  const [reference, setReference] = useState("");
  const [externalAttempt, setExternalAttempt] = useState<{
    attemptId: number | null;
    requestId: string;
    deviceId: string;
    fingerprint: string;
    confirmed: boolean;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showDebtApproval, setShowDebtApproval] = useState(false);
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId;
  const { printAuthorizedDocument } = useInvoiceReceiptPrinter(me.data, me.data?.id);
  const printHandoverInvoice = useCallback(async (invoiceId: number, reprint: boolean, win: Window | null) => {
    try {
      const inv = await utils.sales.get.fetch({ invoiceId });
      if (!inv) { try { win?.close(); } catch { /* noop */ } return; }
      await printAuthorizedDocument(invoiceId, "THERMAL", reprint, () => printReceipt(invoiceToReceipt(inv), { into: win }));
    } catch { try { win?.close(); } catch { /* noop */ } }
  }, [utils.sales.get, printAuthorizedDocument]);
  const { canReprint } = useInvoiceActionPermissions(me.data);
  const deliverPrintRef = useRef<{
    win: Window | null;
    order: ScannedOrder;
    amountPaid: string;
    method: string;
    reference: string | null;
  } | null>(null);
  const collectPrintRef = useRef<{
    win: Window | null;
    order: ScannedOrder;
    amountPaid: string;
    method: string;
    reference: string | null;
  } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId: branchId!, shiftType: "RECEPTION" },
    { enabled: !!branchId },
  );
  const shift = shiftQ.data ?? null;

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  const resetPaymentFields = useCallback(() => {
    setMethod("CASH");
    setReference("");
    setExternalAttempt(null);
  }, []);

  // ─── مسح الباركود ────────────────────────────────────────────────────────

  const lookupOrder = useCallback(
    async (raw: string) => {
      const orderNumber = resolveOrderLookupBarcode(raw);
      if (!orderNumber) return;
      try {
        const fetched = await utils.workOrders.getByNumber.fetch({ orderNumber });
        if (!fetched) { notify.err("طلب أو فاتورة غير موجودة: " + orderNumber); return; }
        const wo = fetched as typeof fetched & { siblingWorkOrders?: SiblingWorkOrder[] };
        const readyPickupSiblings = (wo.siblingWorkOrders ?? []).filter((s) => s.status === "READY" && !s.hasDelivery);

        if (wo.kind === "workOrder") {
          if (wo.status === "DELIVERED") {
            if (wo.linkedInvoice?.isUnsettled) {
              notify.info(`الطلب #${wo.orderNumber} مسلّم مسبقاً وله متبقٍ غير مستحصل (${fmt(wo.linkedInvoice.remaining)} د.ع) على فاتورة #${wo.linkedInvoice.invoiceNumber}. تم تحويل الشاشة لتحصيله الآن.`);
              setSiblingOrders(readyPickupSiblings);
              setScanned({
                id: wo.linkedInvoice.id,
                kind: "invoice",
                orderNumber: wo.linkedInvoice.invoiceNumber,
                title: `تحصيل متبقي طلب ${wo.orderNumber} (فاتورة #${wo.linkedInvoice.invoiceNumber})`,
                customerName: wo.customerName,
                customerPhone: wo.customerPhone,
                salePrice: wo.linkedInvoice.total,
                deposit: wo.linkedInvoice.paidAmount,
              });
              setManualInput("");
              resetPaymentFields();
              return;
            }
            if (readyPickupSiblings.length > 0) {
              const firstReady = readyPickupSiblings[0]!;
              setSiblingOrders(readyPickupSiblings);
              setScanned(siblingToScanned(firstReady, { name: wo.customerName, phone: wo.customerPhone }));
              setManualInput("");
              resetPaymentFields();
              return;
            }
            notify.info("الطلب " + wo.orderNumber + " مُسلَّم مسبقاً ومسدد بالكامل");
            return;
          }
          if (wo.status !== "READY") {
            if (readyPickupSiblings.length > 0) {
              const firstReady = readyPickupSiblings[0]!;
              notify.info(`البند #${wo.orderNumber} حالته ${wo.status} — فُتح البند الجاهز #${firstReady.orderNumber} ضمن نفس الوصل.`);
              setSiblingOrders(readyPickupSiblings);
              setScanned(siblingToScanned(firstReady, { name: wo.customerName, phone: wo.customerPhone }));
              setManualInput("");
              resetPaymentFields();
              return;
            }
            notify.warn("الطلب غير جاهز للتسليم — حالته: " + wo.status);
            return;
          }

          const effectiveWoSalePrice = wo.linkedInvoice
            ? wo.linkedInvoice.total
            : wo.salePrice;
          const effectiveWoDeposit = wo.linkedInvoice
            ? wo.linkedInvoice.paidAmount
            : wo.deposit;
          const selfAsSibling: SiblingWorkOrder = {
            id: wo.id,
            orderNumber: wo.orderNumber,
            title: wo.title,
            status: wo.status,
            salePrice: effectiveWoSalePrice,
            deposit: effectiveWoDeposit,
            hasDelivery: Boolean((wo as { hasDelivery?: boolean }).hasDelivery),
            customerName: wo.customerName,
            customerPhone: wo.customerPhone,
          };
          const mergedSiblings = !selfAsSibling.hasDelivery
            ? [
                selfAsSibling,
                ...readyPickupSiblings.filter((s) => s.id !== selfAsSibling.id),
              ]
            : readyPickupSiblings;
          setSiblingOrders(mergedSiblings);
          setScanned({
            id: wo.id,
            kind: "workOrder",
            orderNumber: wo.orderNumber,
            title: wo.title,
            customerName: wo.customerName,
            customerPhone: wo.customerPhone,
            salePrice: effectiveWoSalePrice,
            deposit: effectiveWoDeposit,
          });
          setManualInput("");
          resetPaymentFields();
          return;
        } else if (wo.kind === "invoice") {
          if (wo.status === "CANCELLED") {
            notify.err("هذه الفاتورة ملغاة ولا يمكن تسليمها");
            return;
          }
          if (wo.status === "RETURNED") {
            notify.err("هذه الفاتورة مرتجعة بالكامل ولا يمكن تسليمها");
            return;
          }
          const rem = round2(D(wo.salePrice).minus(D(wo.deposit ?? "0")));
          if (rem.lte(0)) {
            if (readyPickupSiblings.length > 0) {
              const firstReady = readyPickupSiblings[0]!;
              setSiblingOrders(readyPickupSiblings);
              setScanned(siblingToScanned(firstReady, { name: wo.customerName, phone: wo.customerPhone }));
              setManualInput("");
              resetPaymentFields();
              return;
            }
            if (wo.status === "PAID") {
              notify.info("الفاتورة " + wo.orderNumber + " مسددة بالكامل مسبقاً ومسلّمة");
              return;
            }
          }
          setSiblingOrders(readyPickupSiblings);
        } else {
          setSiblingOrders([]);
        }

        setScanned({
          id: wo.id,
          kind: wo.kind ?? "workOrder",
          orderNumber: wo.orderNumber,
          title: wo.title,
          customerName: wo.customerName,
          customerPhone: wo.customerPhone,
          salePrice: wo.salePrice,
          deposit: wo.deposit,
        });
        setManualInput("");
        resetPaymentFields();
      } catch (e) {
        notify.err(e, "تعذّر جلب الطلب");
      }
    },
    [utils, resetPaymentFields],
  );

  useBarcodeScanner(
    useCallback(
      async (raw: string) => { if (!scanned) await lookupOrder(raw); },
      [scanned, lookupOrder],
    ),
    { enabled: !scanned },
  );

  // ─── تسليم ────────────────────────────────────────────────────────────────

  const advanceOrClearAfterHandover = useCallback(
    (deliveredWorkOrderId: number | null, successTitle: string) => {
      const nextSiblings =
        deliveredWorkOrderId != null
          ? siblingOrders.filter((s) => s.id !== deliveredWorkOrderId)
          : siblingOrders;
      setSiblingOrders(nextSiblings);
      resetPaymentFields();
      void utils.workOrders.invalidate();
      void shiftQ.refetch();

      const switchedToOtherReadySibling =
        deliveredWorkOrderId != null &&
        scanned?.kind === "workOrder" &&
        scanned.id !== deliveredWorkOrderId &&
        nextSiblings.some((s) => s.id === scanned.id);

      if (switchedToOtherReadySibling) {
        notify.ok(successTitle);
      } else if (nextSiblings.length > 0) {
        const nextItem = nextSiblings[0]!;
        notify.ok(
          successTitle,
          `انتقل تلقائياً إلى البند الجاهز التالي #${nextItem.orderNumber}`,
        );
        setScanned(siblingToScanned(nextItem));
      } else {
        notify.ok(successTitle);
        setScanned(null);
        inputRef.current?.focus();
      }
    },
    [siblingOrders, scanned, resetPaymentFields, utils.workOrders, shiftQ],
  );

  const deliverMut = trpc.workOrders.deliver.useMutation({
    onSuccess: (res, vars) => {
      const snap = deliverPrintRef.current;
      deliverPrintRef.current = null;
      if (snap) {
        const invId = Number((res as { invoiceId?: number } | null)?.invoiceId ?? 0);
        if (invId > 0) {
          void printHandoverInvoice(invId, false, snap.win);
        } else {
          const remAfter = round2(D(snap.order.salePrice).minus(D(snap.order.deposit ?? "0")).minus(D(snap.amountPaid)));
          void printInvoicePaymentReceipt(
            {
              invoiceNumber: (res as { invoiceNumber?: string } | null)?.invoiceNumber ?? snap.order.orderNumber,
              customerName: snap.order.customerName,
              customerPhone: snap.order.customerPhone,
              invoiceTotal: snap.order.salePrice,
              paidBefore: snap.order.deposit ?? "0",
              amountPaid: snap.amountPaid,
              remainingAfter: (remAfter.gt(0) ? remAfter : D(0)).toFixed(2),
              paymentMethod: snap.method,
              reference: snap.reference,
              cashierName: me.data?.name ?? null,
            },
            snap.win ? { into: snap.win } : undefined,
          );
        }
      }
      const deliveredId = vars.workOrderId;
      const deliveredOrderNumber =
        snap?.order.orderNumber ??
        siblingOrders.find((s) => s.id === vars.workOrderId)?.orderNumber ??
        (scanned?.kind === "workOrder" && scanned.id === vars.workOrderId
          ? scanned.orderNumber
          : String(vars.workOrderId));
      advanceOrClearAfterHandover(
        deliveredId,
        "تمّ تسليم طلب #" + deliveredOrderNumber,
      );
    },
    onError: (e) => {
      try { deliverPrintRef.current?.win?.close(); } catch { /* noop */ }
      deliverPrintRef.current = null;
      notify.err(e, "تعذّر التسليم");
    },
  });

  const collectInvoiceMut = trpc.reception.collectOnInvoice.useMutation({
    onSuccess: () => {
      const snap = collectPrintRef.current;
      collectPrintRef.current = null;
      if (snap) {
        void printInvoicePaymentReceipt(
          {
            invoiceNumber: snap.order.orderNumber,
            customerName: snap.order.customerName,
            customerPhone: snap.order.customerPhone,
            invoiceTotal: snap.order.salePrice,
            paidBefore: snap.order.deposit ?? "0",
            amountPaid: snap.amountPaid,
            remainingAfter: "0.00",
            paymentMethod: snap.method,
            reference: snap.reference,
            cashierName: me.data?.name ?? null,
          },
          snap.win ? { into: snap.win } : undefined,
        );
      }
      advanceOrClearAfterHandover(
        null,
        "تمّ تحصيل الفاتورة #" + (snap?.order.orderNumber ?? scanned?.orderNumber ?? "") + " وتسليمها بنجاح",
      );
    },
    onError: (e) => {
      try { collectPrintRef.current?.win?.close(); } catch { /* noop */ }
      collectPrintRef.current = null;
      notify.err(e, "تعذّر تحصيل الفاتورة");
    },
  });

  const remaining = scanned
    ? round2(D(scanned.salePrice).minus(D(scanned.deposit ?? "0")))
    : null;
  const remainingDue = remaining && remaining.gt(0) ? remaining : null;
  const needsShift = remainingDue !== null;
  const needRef = method !== "CASH";
  const normalizedAmount = remainingDue ? remainingDue.toFixed(2) : "0.00";
  const effectiveBranchId = shift?.branchId ?? branchId ?? null;
  const externalFingerprint = effectiveBranchId
    ? `SALES_COLLECTION|${effectiveBranchId}|${method}|${normalizedAmount}|${reference.trim()}`
    : "";
  const externalConfirmed =
    method === "CASH" ||
    (externalAttempt?.confirmed === true &&
      Boolean(externalFingerprint) &&
      externalAttempt.fingerprint === externalFingerprint);

  async function confirmReceptionExternalPayment() {
    const normalizedRef = reference.trim();
    if (!normalizedRef || !remainingDue || method === "CASH" || !effectiveBranchId) return;
    try {
      const prior =
        externalAttempt?.fingerprint === externalFingerprint
          ? externalAttempt
          : null;
      const deviceId = prior?.deviceId ?? (await getDeviceCode());
      const requestId = prior?.requestId ?? crypto.randomUUID();
      let attemptId = prior?.attemptId ?? null;
      if (attemptId == null) {
        const initiated = await initiateExternal.mutateAsync({
          branchId: effectiveBranchId,
          channel: "SALES_COLLECTION",
          method,
          amount: normalizedAmount,
          reference: normalizedRef,
          requestId,
          deviceId,
        });
        attemptId = initiated.attemptId;
        setExternalAttempt({
          attemptId,
          requestId,
          deviceId,
          fingerprint: externalFingerprint,
          confirmed: false,
        });
      }
      await confirmExternal.mutateAsync({
        branchId: effectiveBranchId,
        channel: "SALES_COLLECTION",
        attemptId,
        deviceId,
      });
      setExternalAttempt({
        attemptId,
        requestId,
        deviceId,
        fingerprint: externalFingerprint,
        confirmed: true,
      });
      notify.ok(
        "تأكّد الدفع الخارجي",
        `ثُبّت المرجع ${normalizedRef} وأصبح جاهزاً للاستهلاك.`,
      );
    } catch (error) {
      notify.err(error, "تعذّر تأكيد الدفع الخارجي");
    }
  }

  async function handleHandover() {
    if (!scanned) return;
    const remainingVal = round2(D(scanned.salePrice).minus(D(scanned.deposit ?? "0")));
    if (remainingVal.gt(0) && !shift) {
      notify.err("لا توجد وردية استقبال مفتوحة لتحصيل المبلغ المتبقي");
      return;
    }
    const docLabel = scanned.kind === "invoice" ? "الفاتورة" : "الطلب";
    const payLabel = method === "CASH" ? "نقداً" : `بـ${paymentMethodLabel(method)}`;

    if (remainingVal.gt(0) && method !== "CASH") {
      if (!reference.trim()) {
        notify.err("مرجع العملية مطلوب لدفعة غير نقدية");
        return;
      }
      if (scanned.kind === "invoice" && !externalConfirmed) {
        notify.err("يجب تأكيد الدفع الخارجي أولاً قبل التسليم");
        return;
      }
    }

    const ok = await confirm({
      title: "تأكيد التسليم المباشر",
      description: [
        `${docLabel}: #${scanned.orderNumber}`,
        "العميل: " + (scanned.customerName ?? scanned.customerPhone ?? "غير محدد"),
        remainingVal.gt(0)
          ? `يُحصَّل الآن: ${fmt(remainingVal.toFixed(2))} د.ع ${payLabel}`
          : "مدفوع بالكامل مسبقاً",
        method !== "CASH" && reference.trim() ? `المرجع: ${reference.trim()}` : "",
      ].filter(Boolean).join("\n"),
      confirmText: remainingVal.gt(0)
        ? `سلّم وحصّل ${fmt(remainingVal.toFixed(2))} د.ع`
        : "تسليم",
    });
    if (!ok) return;

    if (scanned.kind === "invoice") {
      if (remainingVal.gt(0)) {
        collectPrintRef.current = {
          win: preopenDocumentWindow(),
          order: scanned,
          amountPaid: remainingVal.toFixed(2),
          method,
          reference: method !== "CASH" ? reference.trim() : null,
        };
        collectInvoiceMut.mutate({
          invoiceId: scanned.id,
          amount: remainingVal.toFixed(2),
          method,
          reference: method !== "CASH" ? reference.trim() : undefined,
          ...(method === "CASH"
            ? {}
            : {
                externalPaymentAttemptId: externalAttempt?.attemptId ?? undefined,
                externalPaymentDeviceId: externalAttempt?.deviceId ?? undefined,
              }),
          clientRequestId: crypto.randomUUID(),
        });
      } else {
        const win = preopenDocumentWindow();
        void printHandoverInvoice(scanned.id, canReprint, win);
        advanceOrClearAfterHandover(null, "الفاتورة مدفوعة مسبقاً — تم التسليم بنجاح");
      }
    } else {
      deliverPrintRef.current = {
        win: preopenDocumentWindow(),
        order: scanned,
        amountPaid: remainingVal.gt(0) ? remainingVal.toFixed(2) : "0.00",
        method,
        reference: method !== "CASH" ? reference.trim() : null,
      };
      deliverMut.mutate({
        workOrderId: scanned.id,
        payment: remainingVal.gt(0)
          ? {
              amount: remainingVal.toFixed(2),
              method,
              reference: method !== "CASH" ? reference.trim() : undefined,
            }
          : undefined,
        clientRequestId: crypto.randomUUID(),
      });
    }
  }

  // ─── JSX ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" dir="rtl">

      {/* رأس الصفحة */}
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <PageHeader
          title="التسليم المباشر للزبون"
          icon={<CheckCircle2 aria-hidden className="size-5 text-green-600" />}
          backHref="/pos?mode=RECEPTION"
          backLabel="الاستقبال"
          actions={
            shift ? (
              <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
                وردية #{shift.id}
              </span>
            ) : (
              <span className="rounded-full bg-destructive/10 px-3 py-1 text-xs font-bold text-destructive">
                لا وردية
              </span>
            )
          }
        />
      </div>

      {/* المحتوى */}
      <div className="flex flex-1 flex-col items-center gap-6 overflow-auto p-6">

        {/* منطقة المسح — تظهر إذا لم يكن هناك طلب ممسوح */}
        {!scanned && (
          <div className="w-full max-w-lg">
            <div className="rounded-2xl border-2 border-dashed border-green-400 bg-green-50 p-8 text-center">
              <ScanLine aria-hidden className="mx-auto size-14 text-green-500" />
              <p className="mt-4 text-xl font-extrabold text-green-800">
                امسح باركود الطلب الجاهز
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                وجّه الماسح نحو تذكرة الطلب أو الوصل الموحّد أو أدخل الرقم يدوياً
              </p>
              <div className="mt-6 flex gap-2">
                <UnifiedSearchInput
                  ref={inputRef}
                  value={manualInput}
                  onChange={setManualInput}
                  onScan={(code: string) => void lookupOrder(code)}
                  onSubmit={(val: string) => {
                    if (val.trim()) void lookupOrder(val.trim());
                  }}
                  placeholder="رقم الطلب أو الوصل (Enter للبحث)"
                  className="flex-1 h-12 text-center text-base font-bold"
                  dir="ltr"
                  barcode={true}
                  size="lg"
                  autoFocus
                />
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => void lookupOrder(manualInput.trim())}
                  disabled={!manualInput.trim()}
                >
                  بحث
                </Button>
              </div>
            </div>

            {!shift && (
              <div className="mt-4 rounded-xl border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-4 text-center">
                <p className="text-sm font-bold text-[var(--sem-warn)]">
                  لا وردية استقبال مفتوحة — يمكنك تسليم الطلبات المدفوعة مسبقاً، أما تحصيل المتبقي فيتطلب فتح وردية أولاً
                </p>
              </div>
            )}
          </div>
        )}

        {/* بطاقة الطلب الممسوح */}
        {scanned && (
          <div className="w-full max-w-lg space-y-3">
            {siblingOrders.length > 1 && (
              <Card className="gap-2 p-3 py-3 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-foreground">
                    بنود جاهزة ضمن نفس الوصل:
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {fmtInt(siblingOrders.length)} بنود
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {siblingOrders.map((item) => {
                    const active = scanned.kind === "workOrder" && scanned.id === item.id;
                    return (
                      <Button
                        key={item.id}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        className="h-8 gap-1.5 text-xs font-bold"
                        disabled={deliverMut.isPending || collectInvoiceMut.isPending}
                        onClick={() => {
                          setScanned(siblingToScanned(item));
                          resetPaymentFields();
                        }}
                      >
                        <span dir="ltr">#{item.orderNumber}</span>
                        {item.title && (
                          <span className="max-w-36 truncate font-normal opacity-90">
                            — {item.title}
                          </span>
                        )}
                      </Button>
                    );
                  })}
                </div>
              </Card>
            )}

            <Card className="overflow-hidden gap-0 py-0 shadow-md">

              {/* رأس البطاقة */}
              <div className="border-b bg-green-50 p-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Package aria-hidden className="size-6 text-green-600" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xl font-extrabold">#{scanned.orderNumber}</span>
                      <Badge
                        variant="outline"
                        className="border-green-500 bg-green-50 text-green-700"
                      >
                        {scanned.kind === "invoice" ? "فاتورة جاهزة للتسليم" : "جاهز للتسليم"}
                      </Badge>
                    </div>
                    {scanned.title && (
                      <p className="text-sm text-muted-foreground">{scanned.title}</p>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deliverMut.isPending || collectInvoiceMut.isPending}
                  onClick={() => {
                    setScanned(null);
                    setSiblingOrders([]);
                    setManualInput("");
                    resetPaymentFields();
                  }}
                >
                  مسح آخر
                </Button>
              </div>

              {/* تفاصيل */}
              <div className="space-y-3 p-5">

                {/* العميل */}
                <div className="flex items-center gap-3 rounded-xl border bg-background p-4">
                  <User aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">العميل</p>
                    <p className="text-base font-bold">{scanned.customerName ?? "—"}</p>
                    {scanned.customerPhone && (
                      <p className="text-sm text-muted-foreground" dir="ltr">
                        {scanned.customerPhone}
                      </p>
                    )}
                  </div>
                </div>

                {/* المالي */}
                <div className="flex items-center gap-3 rounded-xl border bg-background p-4">
                  <BadgeDollarSign aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">المالي</p>
                    <div className="flex items-center justify-between">
                      <p className="text-base font-bold">{fmt(scanned.salePrice)} د.ع إجمالاً</p>
                      {D(scanned.deposit ?? "0").gt(0) && (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-bold text-green-600">
                          عربون {fmt(scanned.deposit ?? "0")} د.ع
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* اختيار طريقة الدفع عند وجود مبلغ متبقٍ */}
                {remainingDue && (
                  <div className="space-y-3 rounded-xl border bg-background p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-muted-foreground">
                        طريقة تحصيل المتبقي:
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-foreground">
                        {method === "CARD" && <CardBrandLogos size="xs" />}
                        <span>{paymentMethodLabel(method)}</span>
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {PAYMENT_METHODS.map((p) => {
                        const enabled = isPosPaymentMethodEnabled(p.v);
                        const isSelected = method === p.v;
                        const Icon = p.icon;
                        return (
                          <button
                            key={p.v}
                            type="button"
                            disabled={!enabled}
                            onClick={() => {
                              if (!enabled) return;
                              setMethod(p.v);
                              setReference("");
                              setExternalAttempt(null);
                            }}
                            title={enabled ? p.label : posPaymentRejectionMessage(p.v)}
                            className={cn(
                              "flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 py-3 px-2 text-xs font-extrabold transition-all",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground shadow-sm"
                                : enabled
                                  ? "border-border bg-card hover:bg-muted text-foreground"
                                  : "cursor-not-allowed bg-muted/40 text-muted-foreground/45",
                            )}
                          >
                            {p.v === "CARD" ? (
                              <CardBrandLogos size="sm" />
                            ) : (
                              <Icon aria-hidden className="size-5" />
                            )}
                            <span>{p.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {needRef && (
                      <div className="border-t pt-3">
                        <PaymentReferenceField
                          value={reference}
                          onChange={(v) => {
                            setReference(v);
                            setExternalAttempt(null);
                          }}
                          method={method}
                          confirmed={externalConfirmed}
                          confirming={initiateExternal.isPending || confirmExternal.isPending}
                          onConfirm={() => void confirmReceptionExternalPayment()}
                          inputId="reception-handover-reference"
                          colors={{
                            border: "var(--border)",
                            muted: "var(--muted)",
                            mutedFg: "var(--muted-foreground)",
                            fg: "var(--foreground)",
                            amber: "var(--sem-warn)",
                            success: "var(--sem-pos)",
                          }}
                        />
                      </div>
                    )}

                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {method === "CASH" ? (
                        <>
                          <Banknote aria-hidden className="me-1 inline size-3.5" />
                          يدخل المبلغ <span className="font-bold underline">درجك في الوردية #{shift?.id}</span> نقداً.
                        </>
                      ) : (
                        <>
                          {method === "CARD" ? (
                            <CardBrandLogos size="xs" className="me-1 align-middle" />
                          ) : (
                            <ArrowLeftRight aria-hidden className="me-1 inline size-3.5" />
                          )}
                          يُسجَّل على <span className="font-bold">وردية #{shift?.id}</span> للمحاسبة والمطابقة — لا يدخل درج النقد.
                        </>
                      )}
                    </p>
                  </div>
                )}

                {/* مؤشر المبلغ المتبقي */}
                <div
                  className={
                    remainingDue
                      ? "rounded-xl border-2 border-amber-300 bg-amber-50 p-4"
                      : "rounded-xl border-2 border-green-300 bg-green-50 p-4"
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">
                      {remainingDue
                        ? `يُحصَّل الآن (${paymentMethodLabel(method)}):`
                        : "مدفوع بالكامل مسبقاً"}
                    </span>
                    {remainingDue && (
                      <span className="text-2xl font-extrabold tabular-nums text-amber-700">
                        {fmt(remainingDue.toFixed(2))} د.ع
                      </span>
                    )}
                  </div>
                </div>

                {/* زر التسليم */}
                <Button
                  className="w-full py-7 text-lg font-extrabold bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => void handleHandover()}
                  disabled={
                    deliverMut.isPending ||
                    collectInvoiceMut.isPending ||
                    (needsShift && !shift) ||
                    Boolean(remainingDue && method !== "CASH" && scanned.kind === "invoice" && !externalConfirmed) ||
                    Boolean(remainingDue && method !== "CASH" && !reference.trim())
                  }
                >
                  {deliverMut.isPending || collectInvoiceMut.isPending
                    ? "جارٍ التسليم والتحصيل…"
                    : needsShift && !shift
                    ? "افتح وردية استقبال أولاً"
                    : remainingDue
                    ? `سلّم وحصّل ${fmt(remainingDue.toFixed(2))} د.ع (${paymentMethodLabel(method)})`
                    : "تسليم (مدفوع كاملاً)"}
                </Button>

                {remainingDue && scanned.kind === "workOrder" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full text-xs font-bold border-[var(--sem-warn)] text-[var(--sem-warn)] hover:bg-[var(--sem-warn-bg)]"
                    onClick={() => setShowDebtApproval(true)}
                    disabled={deliverMut.isPending || !shift}
                  >
                    إضافة المتبقي ({fmt(remainingDue.toFixed(2))} د.ع) لذمة العميل (اعتماد مسؤول)
                  </Button>
                )}
              </div>
            </Card>

            {showDebtApproval && remainingDue && (
              <ManagerApprovalDialog
                zIndexClass="z-[110]"
                title="اعتماد مدير — إضافة متبقي طلب لذمة العميل"
                description={`تسليم الطلب #${scanned.orderNumber} مع بقاء ${fmt(remainingDue.toFixed(2))} د.ع غير مستحصلة يتطلب موافقة المدير لتحويلها إلى ذمة العميل.`}
                onCancel={() => setShowDebtApproval(false)}
                onApprove={(approval) => {
                  setShowDebtApproval(false);
                  deliverPrintRef.current = {
                    win: preopenDocumentWindow(),
                    order: scanned,
                    amountPaid: "0.00",
                    method: "CASH",
                    reference: null,
                  };
                  deliverMut.mutate({
                    workOrderId: scanned.id,
                    addToCustomerDebt: true,
                    managerApproval: approval,
                    clientRequestId: crypto.randomUUID(),
                  });
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
