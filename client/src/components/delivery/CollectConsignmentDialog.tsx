import Decimal from "decimal.js";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Receipt,
  Truck,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc, type RouterInputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmt, round2 } from "@/lib/money";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
import { preopenDocumentWindow } from "@/lib/printing/print";
import {
  SHORTFALL_REASONS,
  SHORTFALL_REASON_LABEL_AR,
  type ShortfallReason,
} from "@shared/shortfallReason";

export interface TargetConsignment {
  id: number;
  consignmentNumber?: string | null;
  partyId: number;
  partyName?: string | null;
  orderNumber?: string | null;
  invoiceNumber?: string | null;
  customerName?: string | null;
  recipientPhone?: string | null;
  codDue?: string | number | null;
  codAmount?: string | number | null;
  collectedAmount?: string | number | null;
  parcelStatus?: string | null;
}

export interface CollectConsignmentDialogProps {
  consignment?: TargetConsignment | null;
  partyId?: number | null;
  partyName?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
}

type SubmittedRemittance = {
  payload: RouterInputs["delivery"]["recordRemittance"];
  partyLabel: string;
};

type ShiftTypeOption = "RECEPTION" | "RETAIL" | "PRINT_SERVICES";

function cleanMoneyStr(value: Decimal | string | number | null | undefined): string {
  const fixed = round2(value instanceof Decimal ? value : D(value)).toFixed(2);
  return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function CollectConsignmentDialog({
  consignment,
  partyId,
  partyName,
  open,
  onOpenChange,
  onCompleted,
}: CollectConsignmentDialogProps) {
  const utils = trpc.useUtils();
  const explicitPartyId =
    consignment?.partyId && consignment.partyId > 0
      ? consignment.partyId
      : partyId && partyId > 0
      ? partyId
      : null;

  // في حال فتح الحوار من مستند لم يمرر partyId صريحاً (مثل مسارات قديمة)، نشتقه من الإرسالية مباشرة
  const timelineFallback = trpc.delivery.consignmentTimeline.useQuery(
    { consignmentId: consignment?.id ?? 0 },
    {
      enabled: open && explicitPartyId == null && Boolean(consignment?.id && consignment.id > 0),
      staleTime: 30_000,
      retry: false,
    },
  );
  const effectivePartyId =
    explicitPartyId ??
    (timelineFallback.data?.consignment?.partyId
      ? Number(timelineFallback.data.consignment.partyId)
      : null);

  // استعلام الطرود المفتوحة للجهة لمعرفة كل ما بذمتها
  const openCn = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: effectivePartyId ?? 0, limit: 500 },
    {
      enabled: open && effectivePartyId != null && effectivePartyId > 0,
      staleTime: 0,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  useEffect(() => {
    if (open && openCn.hasNextPage && !openCn.isFetching && !openCn.isError) void openCn.fetchNextPage();
  }, [open, openCn.hasNextPage, openCn.isFetching, openCn.isError, openCn.fetchNextPage]);
  const obligationsLoading =
    timelineFallback.isFetching ||
    !openCn.data ||
    openCn.isFetching ||
    openCn.hasNextPage ||
    openCn.isError;

  // استعلام بيانات الفاعل
  const me = trpc.auth.me.useQuery(undefined, { enabled: open });
  const canRemit = lifecycleActionAllowed(me.data, "delivery.recordRemittance", true);
  const canConfirmDelivery = lifecycleActionAllowed(me.data, "delivery.staffConfirm", true);
  const isAdmin = me.data?.role === "admin";
  const isManager = me.data?.role === "manager" || isAdmin;

  // وضع التحصيل: تحصيل هذا الطرد/الشحنة فقط أو تحصيل وتصفير كامل رصيد المندوب
  const [settleScope, setSettleScope] = useState<"SINGLE" | "ALL_PARTY">(() =>
    consignment ? "SINGLE" : "ALL_PARTY",
  );

  // هل نؤكد التسليم أولاً إن لم يكن الطرد مختوماً DELIVERED؟
  const [confirmDeliveryFirst, setConfirmDeliveryFirst] = useState(false);

  // النقد المعدود
  const [countedCash, setCountedCash] = useState("0");
  const [shortfallReason, setShortfallReason] = useState<ShortfallReason | "">("");
  const [shortfallNotes, setShortfallNotes] = useState("");
  const [shiftType, setShiftType] = useState<ShiftTypeOption>("RECEPTION");
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [submittedRemittance, setSubmittedRemittance] = useState<SubmittedRemittance | null>(null);
  const [submittingRemittance, setSubmittingRemittance] = useState(false);
  const remittanceInFlight = useRef(false);

  // استعلام بيانات الجهة لمعرفة فرعها ونوعها (مندوب أم شركة)
  const partyQ = trpc.delivery.getParty.useQuery(
    { id: effectivePartyId ?? 0 },
    { enabled: open && effectivePartyId != null && effectivePartyId > 0, staleTime: 60_000 },
  );

  // استعلام الوردية النشطة
  const effectiveBranchId =
    partyQ.data?.branchId != null
      ? Number(partyQ.data.branchId)
      : me.data?.branchId != null
      ? Number(me.data.branchId)
      : undefined;

  const activeShift = trpc.shifts.current.useQuery(
    {
      shiftType,
      branchId: effectiveBranchId,
    },
    {
      enabled: open && effectiveBranchId != null,
      staleTime: 30_000,
      retry: false,
    },
  );

  // الطرود القابلة للتوريد بحساب Decimal الدقيق (مع دعم عهدة المرتجع واستبعاد المسلم الآجل بلا نقد بيد المندوب)
  const remittableRows = useMemo(() => {
    const rows = (openCn.data?.pages ?? []).flatMap((page) => page.rows);
    return rows
      .map((r) => {
        const cod = D(r.codAmount ?? 0);
        const collected = D(r.collectedAmount ?? 0);
        const counter = D(r.counterSettledAmount ?? 0);
        const shortfall = D(r.shortfallAssigned ?? 0);
        const invoiceRemainingDec = Decimal.max(0, round2(cod.minus(collected).minus(counter).minus(shortfall)));
        const isReturnedWithCustody =
          Boolean(r.physicalReturnReceived) &&
          r.parcelStatus !== "DELIVERED" &&
          D(r.cashInCourierCustody ?? 0).gt(0);
        const remainingDec = isReturnedWithCustody ? round2(D(r.cashInCourierCustody ?? 0)) : invoiceRemainingDec;
        const hasProvenCustody =
          isReturnedWithCustody ||
          (r.parcelStatus === "DELIVERED" &&
            !Boolean((r as { returnDeclaredAt?: unknown }).returnDeclaredAt) &&
            (r.cashInCourierCustody == null || D(r.cashInCourierCustody).gt(0)));
        return {
          ...r,
          remainingDec,
          remainingDue: remainingDec.toNumber(),
          isReturnedWithCustody,
          hasProvenCustody,
        };
      })
      .filter((r) => r.remainingDec.gt(0));
  }, [openCn.data]);

  const currentConsignment = consignment ? remittableRows.find((row) => row.id === consignment.id) : null;

  // أعضاء الشحنة الكاملة عند فتح طرد فردي أو شحنة متعددة الفواتير
  const singleTargetRows = useMemo(() => {
    if (!currentConsignment) return [];
    if (currentConsignment.shipmentLeaderConsignmentId != null) {
      return remittableRows.filter(
        (row) => row.shipmentLeaderConsignmentId === currentConsignment.shipmentLeaderConsignmentId,
      );
    }
    return [currentConsignment];
  }, [currentConsignment, remittableRows]);

  const isGroupedShipment = (currentConsignment?.shipmentInvoiceCount ?? 0) > 1;

  // التحقق من جاهزية الشحنة متعددة الفواتير للتوريد الكامل أو التأكيد الجماعي + التوريد
  const singleShipmentBlockReason = useMemo(() => {
    if (!currentConsignment) return null;
    if (singleTargetRows.some((r) => r.feeWithholdingBlocked)) {
      return "توجد قيود على أجرة هذه الشحنة أو قاعدة عمولتها؛ عالجها من شاشة تسوية المناديب.";
    }
    if (singleTargetRows.some((r) => Boolean((r as { returnDeclaredAt?: unknown }).returnDeclaredAt))) {
      return "تم إعلان رجوع على هذه الشحنة؛ عالج المرتجع من شاشة تسوية المناديب.";
    }
    const allReadyWithCustody = singleTargetRows.every((r) => r.hasProvenCustody);
    const allUnconfirmedInTransit = singleTargetRows.every(
      (r) => r.parcelStatus !== "DELIVERED" && !r.isReturnedWithCustody,
    );
    if (!allReadyWithCustody && !allUnconfirmedInTransit) {
      if (
        !isGroupedShipment &&
        currentConsignment.parcelStatus === "DELIVERED" &&
        !currentConsignment.hasProvenCustody
      ) {
        return "هذا الطرد مسلّم بالآجل دون نقد مقبوض بيد المندوب؛ يُحصّل من ذمة العميل لا من توريد المندوب.";
      }
      return "بعض فواتير هذه الشحنة بحالات تسليم مختلفة أو مسلّمة بالآجل؛ استخدم شاشة تسوية المناديب لمعالجتها.";
    }
    return null;
  }, [currentConsignment, isGroupedShipment, singleTargetRows]);

  const singleNeedsConfirmFirst = useMemo(
    () =>
      singleTargetRows.length > 0 &&
      singleShipmentBlockReason == null &&
      singleTargetRows.every((r) => r.parcelStatus !== "DELIVERED" && !r.isReturnedWithCustody),
    [singleTargetRows, singleShipmentBlockReason],
  );

  // الطرود المسلمة الجاهزة للتوريد الشامل (مع استبعاد المسلم الآجل والشحنات المجمعة غير المكتملة)
  const deliveredRows = useMemo(() => {
    const candidates = remittableRows.filter((row) => row.hasProvenCustody && !row.feeWithholdingBlocked);
    const candidateIds = new Set(candidates.map((row) => row.id));
    return candidates.filter((row) => {
      if (row.shipmentLeaderConsignmentId == null) return true;
      const allShipmentOwing = remittableRows.filter(
        (sibling) => sibling.shipmentLeaderConsignmentId === row.shipmentLeaderConsignmentId,
      );
      return allShipmentOwing.every((sibling) => candidateIds.has(sibling.id));
    });
  }, [remittableRows]);

  const rowNetExpectedDec = (row: (typeof remittableRows)[number]) => {
    const fee = Decimal.min(row.remainingDec, Decimal.max(0, D(row.feeWithholdingCash ?? 0)));
    return round2(row.remainingDec.minus(fee));
  };

  // حساب المتبقي وصافي التوريد للطرد/الشحنة المستهدفة
  const singleGrossDueDec = useMemo(
    () => round2(singleTargetRows.reduce((sum, r) => sum.plus(r.remainingDec), D(0))),
    [singleTargetRows],
  );
  const singleNetExpectedDec = useMemo(
    () => round2(singleTargetRows.reduce((sum, r) => sum.plus(rowNetExpectedDec(r)), D(0))),
    [singleTargetRows],
  );

  // صافي التوريد لجميع طرود الجهة الجاهزة
  const allPartyNetExpectedDec = useMemo(
    () => round2(deliveredRows.reduce((sum, r) => sum.plus(rowNetExpectedDec(r)), D(0))),
    [deliveredRows],
  );

  // المبلغ الصافي المتوقع توريده بناءً على النطاق المختار
  const expectedTotalDec = settleScope === "SINGLE" ? singleNetExpectedDec : allPartyNetExpectedDec;
  const expectedTotalStr = cleanMoneyStr(expectedTotalDec);

  // إعادة الضبط عند الفتح
  useEffect(() => {
    if (!open || submittedRemittance) return;
    const initialScope = consignment ? "SINGLE" : "ALL_PARTY";
    setSettleScope(initialScope);
    setConfirmDeliveryFirst(Boolean(consignment && consignment.parcelStatus !== "DELIVERED"));
    setShortfallReason("");
    setShortfallNotes("");
    setClientRequestId(crypto.randomUUID());
  }, [open, consignment?.id, submittedRemittance]);

  // إذا اتضح بعد جلب القائمة أن الشحنة غير مختومة بالتسليم بعد، نفعل خيار التأكيد المسبق تلقائياً
  useEffect(() => {
    if (!open || submittedRemittance) return;
    if (singleNeedsConfirmFirst && canConfirmDelivery) {
      setConfirmDeliveryFirst(true);
    }
  }, [open, singleNeedsConfirmFirst, canConfirmDelivery, submittedRemittance]);

  // تحديث النقد المعدود تلقائياً ليتطابق مع المبلغ المتوقع بدقة Decimal
  useEffect(() => {
    if (!open || submittedRemittance) return;
    setCountedCash(expectedTotalStr);
  }, [open, expectedTotalStr, submittedRemittance]);

  // حساب الفرق والعجز بدقة Decimal
  const countedDec = useMemo(() => {
    try {
      return round2(D(countedCash?.trim() ? countedCash : "0"));
    } catch {
      return D(0);
    }
  }, [countedCash]);
  const shortfallDec = Decimal.max(0, round2(expectedTotalDec.minus(countedDec)));
  const isShortfall = shortfallDec.gt(0);
  const isExcess = countedDec.gt(expectedTotalDec);

  // طفرة تأكيد التسليم اليدوي بيد الموظف
  const staffConfirm = trpc.delivery.staffConfirm.useMutation();

  // طفرة تسجيل التوريد المالي
  const recordRemittance = trpc.delivery.recordRemittance.useMutation();

  const isPending = staffConfirm.isPending || recordRemittance.isPending || submittingRemittance;
  const intentLocked = isPending || submittedRemittance != null;

  // A committed remittance can disappear from the live obligations before its response arrives.
  // Recovery must replay this exact payload/key, without delivery confirmation or fresh amounts.
  const remitWinRef = useRef<Window | null>(null);
  const submitRemittance = async (submitted: SubmittedRemittance) => {
    if (remittanceInFlight.current) return;
    remittanceInFlight.current = true;
    setSubmittingRemittance(true);
    setSubmittedRemittance(submitted);
    if (!remitWinRef.current) remitWinRef.current = preopenDocumentWindow();
    const remitWin = remitWinRef.current;
    remitWinRef.current = null;
    try {
      const res = await recordRemittance.mutateAsync(submitted.payload);
      notify.ok(
        "تم تسجيل التوريد وقبض النقد بنجاح",
        `سند التوريد #${res.remittanceNumber ?? res.remittanceId} — دخل الدرج ${fmt(res.netRemitted)} د.ع${
          D(res.shortfallTotal ?? 0).gt(0) ? ` (عجز: ${fmt(res.shortfallTotal)} د.ع)` : ""
        }`,
      );
      try {
        if (remitWin) printRemittanceReceipt(submitted.partyLabel, res, { into: remitWin });
        else printRemittanceReceipt(submitted.partyLabel, res);
      } catch {
        // Printing does not change the acknowledged financial result.
      }
      setSubmittedRemittance(null);
      setClientRequestId(crypto.randomUUID());
      onOpenChange(false);
      onCompleted?.();
      void Promise.all([
        utils.delivery.invalidate(),
        utils.shifts.invalidate(),
        utils.treasury.invalidate(),
        utils.sales.invalidate(),
        utils.workOrders.invalidate(),
      ]).catch(() => {});
    } catch (err: unknown) {
      try { remitWin?.close(); } catch { /* noop */ }
      const status = (err as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;
      // A definite rejection permits correction; timeouts/transport/5xx keep the original intent.
      if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 499) {
        setSubmittedRemittance(null);
        setClientRequestId(crypto.randomUUID());
      }
      notify.err(err);
    } finally {
      remittanceInFlight.current = false;
      setSubmittingRemittance(false);
    }
  };

  const handleSettle = async () => {
    if (intentLocked) return;
    if (obligationsLoading || expectedTotalDec.lte(0)) {
      notify.err("انتظر تحميل الذمة الحالية قبل تأكيد التوريد");
      return;
    }
    if (
      !canRemit ||
      (settleScope === "SINGLE" && singleNeedsConfirmFirst && (!confirmDeliveryFirst || !canConfirmDelivery))
    ) {
      notify.err("صلاحية تنفيذ التحصيل أو تأكيد التسليم غير ممنوحة لحسابك");
      return;
    }
    if (effectivePartyId == null || effectivePartyId <= 0) {
      notify.err("لم يتم تحديد جهة التوصيل");
      return;
    }
    if (settleScope === "SINGLE" && singleShipmentBlockReason) {
      notify.err(singleShipmentBlockReason);
      return;
    }
    if (isExcess) {
      notify.err("المبلغ المقبوض أكبر من الصافي المتوقع للتوريد");
      return;
    }
    if (isShortfall) {
      notify.err("يجب أن يطابق النقد المستلم صافي التوريد كاملاً");
      return;
    }

    remitWinRef.current = preopenDocumentWindow();
    try {
      // 1. إذا كان الطرد أو الشحنة المجمعة غير مسلّمة وطُلب تأكيد تسليمها أولاً:
      if (settleScope === "SINGLE" && currentConsignment && singleNeedsConfirmFirst && confirmDeliveryFirst) {
        await staffConfirm.mutateAsync({
          ...(isGroupedShipment
            ? {
                wholeShipment: true,
                consignmentId: currentConsignment.shipmentLeaderConsignmentId ?? currentConsignment.id,
              }
            : {
                consignmentId: currentConsignment.id,
              }),
          collectedAmount: cleanMoneyStr(singleGrossDueDec),
          evidence: "تسليم وتحصيل مباشر بالكاونتر",
          clientRequestId: crypto.randomUUID(),
          shortfallReason: isShortfall && shortfallReason ? (shortfallReason as ShortfallReason) : undefined,
        });
      }

      // 2. تجهيز أسطر التوريد
      let lines: Array<{ consignmentId: number; collectedAmount: string }> = [];

      if (settleScope === "SINGLE") {
        if (!consignment || singleTargetRows.length === 0) throw new Error("لم يتم تحديد الإرسالية");
        lines = singleTargetRows.map((r) => ({
          consignmentId: r.id,
          collectedAmount: cleanMoneyStr(r.remainingDec),
        }));
      } else {
        if (deliveredRows.length === 0) {
          try { remitWinRef.current?.close(); } catch { /* noop */ }
          remitWinRef.current = null;
          notify.err("لا توجد طرود مسلّمة بانتظار التوريد لهذه الجهة");
          return;
        }
        lines = deliveredRows.map((r) => ({
          consignmentId: r.id,
          collectedAmount: cleanMoneyStr(r.remainingDec),
        }));
      }

      // استبعاد الأسطر الصفرية
      const activeLines = lines.filter((l) => D(l.collectedAmount).gt(0));
      if (activeLines.length === 0 && countedDec.gt(0)) {
        throw new Error("تعذر توزيع المبلغ المقبوض على الإرساليات");
      }

      // 3. تنفيذ التوريد المالي الذري
      await submitRemittance({
        payload: {
          partyId: effectivePartyId,
          shiftType,
          ...(activeShift.data?.id ? { targetShiftId: activeShift.data.id } : {}),
          lines: activeLines,
          countedCash: cleanMoneyStr(countedDec),
          shortfall: null,
          clientRequestId,
        },
        partyLabel: consignment?.partyName ?? partyName ?? partyQ.data?.name ?? "جهة التوصيل",
      });
    } catch (err: unknown) {
      try { remitWinRef.current?.close(); } catch { /* noop */ }
      remitWinRef.current = null;
      notify.err(err);
    }
  };

  const displayName = consignment?.partyName ?? partyName ?? partyQ.data?.name ?? "المندوب";
  const isCompanyParty = partyQ.data?.partyType === "COMPANY";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && intentLocked) return; onOpenChange(next); }}>
      <DialogContent dir="rtl" className="sm:max-w-xl" showCloseButton={!intentLocked}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-black">
            <Wallet aria-hidden className="size-6 text-emerald-600" />
            قبض النقد وتوريد عهدة المندوب
          </DialogTitle>
          <DialogDescription className="text-start leading-6">
            تسجيل استلام المبالغ المحصلة من المندوب وإدخالها فوراً في درج الوردية وتصفير الذمة المرتبطة بالسند.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {submittedRemittance && (
            <div role="alert" className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/30 p-3 text-sm">
              أُرسل طلب توريد بقيمة {fmt(submittedRemittance.payload.countedCash)} د.ع. استعد نتيجته بنفس الطلب قبل إجراء تحصيل آخر؛ قد تكون الذمة الحالية تغيّرت بعد تسجيله.
            </div>
          )}

          {isCompanyParty && deliveredRows.length === 0 && effectivePartyId != null && (
            <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-xs space-y-2">
              <p className="font-bold text-foreground">
                هذه شركة توصيل خارجية — طرودها المفتوحة ({remittableRows.length}) تُختَم وتُورَّد عبر «كشف شركة التوصيل» برقم الكشف واستقطاعاته.
              </p>
              <Button size="sm" variant="outline" asChild onClick={() => onOpenChange(false)}>
                <Link href={`/delivery?tab=settlement&party=${effectivePartyId}`}>
                  فتح شاشة تسجيل كشف الشركة
                </Link>
              </Button>
            </div>
          )}

          {/* بطاقة معلومات المندوب */}
          <div className="rounded-xl border bg-muted/40 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="size-4 text-primary" />
                <span className="font-extrabold text-base">{displayName}</span>
              </div>
              <Badge variant="outline" className="font-mono text-xs">
                {deliveredRows.length} طرد مسلم بانتظار التوريد
              </Badge>
            </div>

            {consignment && (
              <div className="mt-2 pt-2 border-t text-xs grid grid-cols-1 sm:grid-cols-2 gap-2 text-muted-foreground">
                <div>
                  الإرسالية:{" "}
                  <span className="font-mono font-bold text-foreground">
                    {consignment.consignmentNumber ?? `#${consignment.id}`}
                  </span>
                  {isGroupedShipment && (
                    <span className="ms-1 text-[11px] font-bold text-primary">
                      (شحنة {singleTargetRows.length} فواتير)
                    </span>
                  )}
                </div>
                <div>
                  المستلم: <span className="font-bold text-foreground">{consignment.customerName ?? "عميل نقدي"}</span>
                </div>
                {consignment.orderNumber && (
                  <div>
                    الطلب: <span className="font-mono text-foreground">{consignment.orderNumber}</span>
                  </div>
                )}
                {consignment.recipientPhone && (
                  <div dir="ltr" className="text-start">
                    {consignment.recipientPhone}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* خيار نطاق التوريد إذا فتح من طرد فردي أو شحنة */}
          {consignment && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                disabled={intentLocked}
                className={`flex flex-col items-start p-3 rounded-xl border text-start transition-all ${
                  settleScope === "SINGLE"
                    ? "border-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/20 shadow-sm"
                    : "border-border hover:bg-muted/50"
                }`}
                onClick={() => setSettleScope("SINGLE")}
              >
                <span className="text-xs font-bold text-muted-foreground">
                  {isGroupedShipment ? `تحصيل هذه الشحنة كاملة (${singleTargetRows.length} فواتير)` : "تحصيل هذا الطرد فقط"}
                </span>
                <span className="text-lg font-black text-emerald-600 mt-1 tabular-nums" dir="ltr">
                  {fmt(cleanMoneyStr(singleNetExpectedDec))} د.ع
                </span>
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  {isGroupedShipment
                    ? `إجمالي فواتير الشحنة: ${fmt(cleanMoneyStr(singleGrossDueDec))} د.ع`
                    : `طرد #${consignment.consignmentNumber ?? consignment.id}`}
                </span>
              </button>

              <button
                type="button"
                disabled={intentLocked}
                className={`flex flex-col items-start p-3 rounded-xl border text-start transition-all ${
                  settleScope === "ALL_PARTY"
                    ? "border-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/20 shadow-sm"
                    : "border-border hover:bg-muted/50"
                }`}
                onClick={() => setSettleScope("ALL_PARTY")}
              >
                <span className="text-xs font-bold text-muted-foreground">تصفير كامل ذمة المندوب</span>
                <span className="text-lg font-black text-foreground mt-1 tabular-nums" dir="ltr">
                  {fmt(cleanMoneyStr(allPartyNetExpectedDec))} د.ع
                </span>
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  جميع الطرود المسلمة ({deliveredRows.length} طرد)
                </span>
              </button>
            </div>
          )}

          {/* تأكيد التسليم المسبق إذا لم يكن مسلماً بعد */}
          {settleScope === "SINGLE" && singleNeedsConfirmFirst && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-xs">
              <input
                type="checkbox"
                id="confirm-first-check"
                checked={confirmDeliveryFirst}
                disabled={!canConfirmDelivery || intentLocked}
                onChange={(e) => setConfirmDeliveryFirst(e.target.checked)}
                className="mt-0.5 rounded border-amber-500"
              />
              <label htmlFor="confirm-first-check" className="cursor-pointer font-bold leading-5">
                {isGroupedShipment
                  ? `تأكيد تسليم جميع فواتير الشحنة (${singleTargetRows.length}) للعميل وقبض ثمنها ثم توريدها فوراً`
                  : "تأكيد وصول الطرد للعميل وقبض ثمنه أولاً (تأكيد تسليم + توريد فوري في خطوة واحدة)"}
              </label>
            </div>
          )}

          {settleScope === "SINGLE" && singleShipmentBlockReason && (
            <p role="alert" className="text-sm font-bold text-destructive">
              {singleShipmentBlockReason}
            </p>
          )}

          {/* تحديد الوردية والدرج */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-bold mb-1 block">وردية إيداع النقد</Label>
              <AppSelect
                value={shiftType}
                disabled={intentLocked}
                onValueChange={(val) => setShiftType(val as ShiftTypeOption)}
                className="h-10 text-sm"
              >
                <option value="RECEPTION">وردية الاستقبال (كاونتر المبيعات)</option>
                <option value="RETAIL">وردية التجزئة</option>
                <option value="PRINT_SERVICES">وردية خدمات الطباعة</option>
              </AppSelect>
            </div>

            <div>
              <Label className="text-xs font-bold mb-1 block">حالة الدرج المستلم</Label>
              <div className="h-10 px-3 flex items-center rounded-md border bg-muted/20 text-xs font-medium">
                {activeShift.data ? (
                  <span className="text-emerald-600 flex items-center gap-1 font-bold">
                    <CheckCircle2 className="size-3.5" /> وردية نشطة #{activeShift.data.id} (الدرج مفتوح)
                  </span>
                ) : isManager ? (
                  <span className="text-muted-foreground">الخزينة الإدارية (تلقائي للأدوار الإدارية)</span>
                ) : (
                  <span className="text-destructive font-bold">لا توجد وردية مفتوحة</span>
                )}
              </div>
            </div>
          </div>

          {/* حقل النقد المستلم الفعلي */}
          <div className="rounded-xl border p-3.5 space-y-2 bg-card">
            <div className="flex items-center justify-between">
              <Label htmlFor="counted-cash-input" className="text-sm font-extrabold flex items-center gap-1.5">
                <Banknote className="size-4 text-emerald-600" />
                المبلغ المقبوض وعده الكاشير (د.ع)
              </Label>
              <span className="text-xs text-muted-foreground">
                المتوقع: <b className="text-foreground tabular-nums">{fmt(expectedTotalStr)}</b> د.ع
              </span>
            </div>

            <MoneyInput
              id="counted-cash-input"
              value={countedCash}
              disabled
              onChange={setCountedCash}
              className="h-12 text-lg font-black text-end tabular-nums border-2 border-emerald-600/30 focus-visible:border-emerald-600"
              ariaLabel="المبلغ المقبوض"
            />

            {/* تنبيه العجز */}
            {isShortfall && !submittedRemittance && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 space-y-2 mt-2">
                <div className="flex items-center gap-2 text-xs font-black text-destructive">
                  <AlertTriangle className="size-4 shrink-0" />
                  يوجد عجز نقدي بمقدار {fmt(cleanMoneyStr(shortfallDec))} د.ع سيقيد ذمة فورية على المندوب
                </div>

                <div className="space-y-1.5 pt-1">
                  <Label className="text-xs font-bold text-destructive">سبب العجز المالي *</Label>
                  <AppSelect
                    value={shortfallReason}
                    disabled={intentLocked}
                    onValueChange={(val) => setShortfallReason(val as ShortfallReason)}
                    className="h-9 text-xs border-destructive/40"
                  >
                    <option value="">اختر سبب العجز...</option>
                    {SHORTFALL_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {SHORTFALL_REASON_LABEL_AR[r]}
                      </option>
                    ))}
                  </AppSelect>
                  <Input
                    placeholder="ملاحظات تفصيلية حول سبب العجز (اختياري)..."
                    value={shortfallNotes}
                    disabled={intentLocked}
                    onChange={(e) => setShortfallNotes(e.target.value)}
                    className="h-8 text-xs mt-1"
                    maxLength={500}
                  />
                </div>
              </div>
            )}

            {isExcess && !submittedRemittance && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive font-bold flex items-center gap-1.5">
                <AlertTriangle className="size-4 shrink-0" />
                المبلغ المقبوض أكبر من الصافي المطلوب ({fmt(expectedTotalStr)} د.ع)؛ لا يقبل قبض زيادة عن الذمة.
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-start pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={intentLocked}>
            إلغاء
          </Button>

          <Button
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-black px-6"
            disabled={
              !canRemit ||
              submittedRemittance != null ||
              obligationsLoading ||
              (settleScope === "SINGLE" && singleNeedsConfirmFirst && (!confirmDeliveryFirst || !canConfirmDelivery)) ||
              isPending ||
              countedDec.lte(0) ||
              isExcess ||
              isShortfall ||
              (settleScope === "SINGLE" && singleShipmentBlockReason != null) ||
              (settleScope === "SINGLE" && !consignment)
            }
            onClick={() => void handleSettle()}
          >
            {isPending ? (
              "جارٍ تسجيل التوريد والقبض..."
            ) : (
              <>
                <Receipt className="size-4" />
                تأكيد القبض وإصدار سند التوريد ({fmt(countedCash)} د.ع)
              </>
            )}
          </Button>
          {submittedRemittance && (
            <Button disabled={!canRemit || isPending} onClick={() => void submitRemittance(submittedRemittance)}>
              {isPending ? "جارٍ التحقق من نتيجة التوريد…" : "استعادة نتيجة التوريد"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
