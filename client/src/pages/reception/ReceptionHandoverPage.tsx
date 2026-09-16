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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { parseScan } from "@/lib/scanRouter";
import { PaymentReferenceField } from "@/components/pos/PaymentReferenceField";
import { getDeviceCode } from "@/lib/offline/outbox";
import { isPosPaymentMethodEnabled, posPaymentRejectionMessage } from "@shared/posPaymentPolicy";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { cn } from "@/lib/utils";

const PAYMENT_METHODS = [
  { v: "CASH", label: "نقدي", icon: Banknote },
  { v: "CARD", label: "بطاقة", icon: CreditCard },
  { v: "TRANSFER", label: "تحويل", icon: ArrowLeftRight },
  { v: "WALLET", label: "محفظة", icon: Wallet },
] as const;
type ReceptionHandoverMethod = (typeof PAYMENT_METHODS)[number]["v"];

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

export default function ReceptionHandoverPage() {
  const [scanned, setScanned] = useState<ScannedOrder | null>(null);
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
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId: branchId!, shiftType: "RECEPTION" },
    { enabled: !!branchId },
  );
  const shift = shiftQ.data ?? null;

  const initiateExternal = trpc.sales.initiateExternalPayment.useMutation();
  const confirmExternal = trpc.sales.confirmExternalPayment.useMutation();

  // ─── مسح الباركود ────────────────────────────────────────────────────────

  const lookupOrder = useCallback(
    async (raw: string) => {
      const r = parseScan(raw);
      const orderNumber = r.type === "workOrder" || r.type === "invoice" ? r.number : raw.trim();
      if (!orderNumber) return;
      try {
        const wo = await utils.workOrders.getByNumber.fetch({ orderNumber });
        if (!wo) { notify.err("طلب أو فاتورة غير موجودة: " + orderNumber); return; }
        if (wo.kind === "workOrder") {
          if (wo.status === "DELIVERED") { notify.info("الطلب " + wo.orderNumber + " مُسلَّم مسبقاً"); return; }
          if (wo.status !== "READY") {
            notify.warn("الطلب غير جاهز للتسليم — حالته: " + wo.status);
            return;
          }
        } else if (wo.kind === "invoice") {
          if (wo.status === "CANCELLED") {
            notify.err("هذه الفاتورة ملغاة ولا يمكن تسليمها");
            return;
          }
          if (wo.status === "RETURNED") {
            notify.err("هذه الفاتورة مرتجعة بالكامل ولا يمكن تسليمها");
            return;
          }
          if (wo.status === "PAID") {
            const rem = round2(D(wo.salePrice).minus(D(wo.deposit ?? "0")));
            if (rem.lte(0)) {
              notify.info("الفاتورة " + wo.orderNumber + " مسددة بالكامل مسبقاً ومسلّمة");
              return;
            }
          }
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
        setMethod("CASH");
        setReference("");
        setExternalAttempt(null);
      } catch (e) {
        notify.err(e, "تعذّر جلب الطلب");
      }
    },
    [utils],
  );

  useBarcodeScanner(
    useCallback(
      async (raw: string) => { if (!scanned) await lookupOrder(raw); },
      [scanned, lookupOrder],
    ),
    { enabled: !scanned },
  );
  const barcodeInput = useBarcodeInput((code) => void lookupOrder(code));

  // ─── تسليم ────────────────────────────────────────────────────────────────

  const deliverMut = trpc.workOrders.deliver.useMutation({
    onSuccess: () => {
      notify.ok("تمّ تسليم طلب #" + (scanned?.orderNumber ?? ""));
      setScanned(null);
      setMethod("CASH");
      setReference("");
      setExternalAttempt(null);
      void utils.workOrders.invalidate();
      void shiftQ.refetch();
      inputRef.current?.focus();
    },
    onError: (e) => notify.err(e, "تعذّر التسليم"),
  });

  const collectInvoiceMut = trpc.reception.collectOnInvoice.useMutation({
    onSuccess: () => {
      notify.ok("تمّ تحصيل الفاتورة #" + (scanned?.orderNumber ?? "") + " وتسليمها بنجاح");
      setScanned(null);
      setMethod("CASH");
      setReference("");
      setExternalAttempt(null);
      void utils.workOrders.invalidate();
      void shiftQ.refetch();
      inputRef.current?.focus();
    },
    onError: (e) => notify.err(e, "تعذّر تحصيل الفاتورة"),
  });

  const remaining = scanned
    ? round2(D(scanned.salePrice).minus(D(scanned.deposit ?? "0")))
    : null;
  const remainingDue = remaining && remaining.gt(0) ? remaining : null;
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
    if (!scanned || !shift) return;
    const remainingVal = round2(D(scanned.salePrice).minus(D(scanned.deposit ?? "0")));
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
        notify.ok("الفاتورة مدفوعة مسبقاً — تم التسليم بنجاح");
        setScanned(null);
        setMethod("CASH");
        setReference("");
        setExternalAttempt(null);
        void utils.workOrders.invalidate();
        void shiftQ.refetch();
        inputRef.current?.focus();
      }
    } else {
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
                وجّه الماسح نحو تذكرة الطلب أو أدخل الرقم يدوياً
              </p>
              <div className="mt-6 flex gap-2">
                <Input
                  ref={inputRef}
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => {
                    barcodeInput.handleKeyDown(e, setManualInput);
                    if (!e.defaultPrevented && e.key === "Enter" && manualInput.trim()) {
                      void lookupOrder(manualInput.trim());
                    }
                  }}
                  placeholder="رقم الطلب (Enter للبحث)"
                  className="flex-1 h-12 text-center text-base font-bold"
                  dir="ltr"
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
              <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-center">
                <p className="text-sm font-bold text-destructive">
                  لا وردية استقبال مفتوحة — افتح وردية أولاً
                </p>
              </div>
            )}
          </div>
        )}

        {/* بطاقة الطلب الممسوح */}
        {scanned && (
          <div className="w-full max-w-lg">
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
                  onClick={() => {
                    setScanned(null);
                    setManualInput("");
                    setMethod("CASH");
                    setReference("");
                    setExternalAttempt(null);
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
                {remaining && remaining.gt(0) && (
                  <div className="space-y-3 rounded-xl border bg-background p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-muted-foreground">
                        طريقة تحصيل المتبقي:
                      </span>
                      <span className="text-xs font-extrabold text-foreground">
                        {paymentMethodLabel(method)}
                      </span>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
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
                            <Icon aria-hidden className="size-5" />
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
                          <CreditCard aria-hidden className="me-1 inline size-3.5" />
                          يُسجَّل على <span className="font-bold">وردية #{shift?.id}</span> للمحاسبة والمطابقة — لا يدخل درج النقد.
                        </>
                      )}
                    </p>
                  </div>
                )}

                {/* مؤشر المبلغ المتبقي */}
                <div
                  className={
                    remaining && remaining.gt(0)
                      ? "rounded-xl border-2 border-amber-300 bg-amber-50 p-4"
                      : "rounded-xl border-2 border-green-300 bg-green-50 p-4"
                  }
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">
                      {remaining && remaining.gt(0)
                        ? `يُحصَّل الآن (${paymentMethodLabel(method)}):`
                        : "مدفوع بالكامل مسبقاً"}
                    </span>
                    {remaining && remaining.gt(0) && (
                      <span className="text-2xl font-extrabold tabular-nums text-amber-700">
                        {fmt(remaining.toFixed(2))} د.ع
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
                    !shift ||
                    Boolean(remaining?.gt(0) && method !== "CASH" && scanned.kind === "invoice" && !externalConfirmed) ||
                    Boolean(remaining?.gt(0) && method !== "CASH" && !reference.trim())
                  }
                >
                  {deliverMut.isPending || collectInvoiceMut.isPending
                    ? "جارٍ التسليم والتحصيل…"
                    : !shift
                    ? "افتح وردية استقبال أولاً"
                    : remaining && remaining.gt(0)
                    ? `سلّم وحصّل ${fmt(remaining.toFixed(2))} د.ع (${paymentMethodLabel(method)})`
                    : "تسليم (مدفوع كاملاً)"}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
