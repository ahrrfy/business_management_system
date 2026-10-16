import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  PackageCheck,
  Printer,
  Receipt,
  RotateCcw,
  Truck,
  User,
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
import { D, fmt } from "@/lib/money";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
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

export function CollectConsignmentDialog({
  consignment,
  partyId,
  partyName,
  open,
  onOpenChange,
  onCompleted,
}: CollectConsignmentDialogProps) {
  const utils = trpc.useUtils();
  const effectivePartyId = consignment?.partyId ?? partyId ?? null;

  // استعلام الطرود المفتوحة للجهة لمعرفة كل ما بذمتها
  const openCn = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: effectivePartyId ?? 0, limit: 500 },
    { enabled: open && effectivePartyId != null && effectivePartyId > 0, staleTime: 0,
      getNextPageParam: last => last.nextCursor ?? undefined },
  );
  useEffect(() => {
    if (open && openCn.hasNextPage && !openCn.isFetching && !openCn.isError) void openCn.fetchNextPage();
  }, [open, openCn.hasNextPage, openCn.isFetching, openCn.isError, openCn.fetchNextPage]);
  const obligationsLoading = !openCn.data || openCn.isFetching || openCn.hasNextPage || openCn.isError;

  // استعلام بيانات الفاعل
  const me = trpc.auth.me.useQuery(undefined, { enabled: open });
  const canRemit = lifecycleActionAllowed(me.data, "delivery.recordRemittance", true);
  const canConfirmDelivery = lifecycleActionAllowed(me.data, "delivery.staffConfirm", true);
  const isAdmin = me.data?.role === "admin";
  const isManager = me.data?.role === "manager" || isAdmin;

  // وضع التحصيل: تحصيل هذا الطرد فقط أو تحصيل وتصفير كامل رصيد المندوب
  const [settleScope, setSettleScope] = useState<"SINGLE" | "ALL_PARTY">(() =>
    consignment ? "SINGLE" : "ALL_PARTY",
  );

  // هل نؤكد التسليم أولاً إن لم يكن الطرد مختوماً DELIVERED؟
  const [confirmDeliveryFirst, setConfirmDeliveryFirst] = useState(false);

  // النقد المعدود
  const [countedCash, setCountedCash] = useState("0");
  const [shortfallReason, setShortfallReason] = useState<ShortfallReason | "">("");
  const [shortfallNotes, setShortfallNotes] = useState("");
  const [shiftType, setShiftType] = useState<"RECEPTION" | "RETAIL">("RECEPTION");
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const [submittedRemittance, setSubmittedRemittance] = useState<SubmittedRemittance | null>(null);
  const [submittingRemittance, setSubmittingRemittance] = useState(false);
  const remittanceInFlight = useRef(false);

  // استعلام بيانات الجهة لمعرفة فرعها
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

  // الطرود القابلة للتوريد: المسلَّمة والتي لم تُورَّد بالكامل بعد
  const remittableRows = useMemo(() => {
    const rows = (openCn.data?.pages ?? []).flatMap(page => page.rows);
    return rows
      .map((r) => {
        const cod = Number(r.codAmount || 0);
        const collected = Number(r.collectedAmount || 0);
        const counter = Number(r.counterSettledAmount || 0);
        const shortfall = Number(r.shortfallAssigned || 0);
        const remaining = Math.max(0, cod - collected - counter - shortfall);
        return {
          ...r,
          remainingDue: remaining,
        };
      })
      .filter((r) => r.remainingDue > 0);
  }, [openCn.data]);
  const currentConsignment = consignment ? remittableRows.find(row => row.id === consignment.id) : null;

  // حساب المتبقي للطرد الفردي المستهدف
  const singleRemainingDue = useMemo(() => {
    return currentConsignment?.remainingDue ?? 0;
  }, [currentConsignment]);

  // إجمالي المتبقي على جميع طرود الجهة
  const allPartyRemainingDue = useMemo(() => {
    return remittableRows.reduce((sum, r) => sum + r.remainingDue, 0);
  }, [remittableRows]);

  // المبلغ المتوقع توريده بناءً على النطاق المختار
  const expectedTotal = useMemo(() => {
    if (settleScope === "SINGLE") {
      return singleRemainingDue;
    }
    return allPartyRemainingDue;
  }, [settleScope, singleRemainingDue, allPartyRemainingDue]);

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

  // تحديث النقد المعدود تلقائياً ليتطابق مع المبلغ المتوقع
  useEffect(() => {
    if (!open || submittedRemittance) return;
    setCountedCash(String(expectedTotal));
  }, [open, expectedTotal, submittedRemittance]);

  // حساب الفرق والعجز
  const countedNum = Number(countedCash || "0");
  const shortfallAmount = Math.max(0, expectedTotal - countedNum);
  const isShortfall = shortfallAmount > 0;
  const isExcess = countedNum > expectedTotal;

  // طفرة تأكيد التسليم اليدوي بيد الموظف
  const staffConfirm = trpc.delivery.staffConfirm.useMutation();

  // طفرة تسجيل التوريد المالي
  const recordRemittance = trpc.delivery.recordRemittance.useMutation();

  const isPending = staffConfirm.isPending || recordRemittance.isPending || submittingRemittance;
  const intentLocked = isPending || submittedRemittance != null;

  // A committed remittance can disappear from the live obligations before its response arrives.
  // Recovery must replay this exact payload/key, without delivery confirmation or fresh amounts.
  const submitRemittance = async (submitted: SubmittedRemittance) => {
    if (remittanceInFlight.current) return;
    remittanceInFlight.current = true;
    setSubmittingRemittance(true);
    setSubmittedRemittance(submitted);
    try {
      const res = await recordRemittance.mutateAsync(submitted.payload);
      notify.ok(
        "تم تسجيل التوريد وقبض النقد بنجاح",
        `سند التوريد #${res.remittanceNumber ?? res.remittanceId} — دخل الدرج ${fmt(res.netRemitted)} د.ع${
          Number(res.shortfallTotal) > 0 ? ` (عجز: ${fmt(res.shortfallTotal)} د.ع)` : ""
        }`,
      );
      try {
        printRemittanceReceipt(submitted.partyLabel, res);
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
    if (obligationsLoading || expectedTotal <= 0) { notify.err("انتظر تحميل الذمة الحالية قبل تأكيد التوريد"); return; }
    if (!canRemit || (settleScope === "SINGLE" && confirmDeliveryFirst && currentConsignment?.parcelStatus !== "DELIVERED" && !canConfirmDelivery)) { notify.err("صلاحية تنفيذ التحصيل أو تأكيد التسليم غير ممنوحة لحسابك"); return; }
    if (effectivePartyId == null) {
      notify.err("لم يتم تحديد جهة التوصيل");
      return;
    }

    if (isExcess) {
      notify.err("المبلغ المقبوض أكبر من الصافي المتوقع للتوريد");
      return;
    }

    if (isShortfall && !shortfallReason) {
      notify.err("يلزم تحديد سبب العجز المالي لتسجيله ذمة على المندوب");
      return;
    }

    try {
      // 1. إذا كان الطرد الفردي غير مسلّم وطُلب تأكيد تسليمه أولاً:
      if (settleScope === "SINGLE" && currentConsignment && confirmDeliveryFirst && currentConsignment.parcelStatus !== "DELIVERED") {
        await staffConfirm.mutateAsync({
          consignmentId: currentConsignment.id,
          collectedAmount: String(countedNum),
          evidence: "تسليم وتحصيل مباشر بالكاونتر",
          clientRequestId: crypto.randomUUID(),
          shortfallReason: isShortfall && shortfallReason ? (shortfallReason as ShortfallReason) : undefined,
        });
      }

      // 2. تجهيز أسطر التوريد
      let lines: Array<{ consignmentId: number; collectedAmount: string }> = [];

      if (settleScope === "SINGLE") {
        if (!consignment) throw new Error("لم يتم تحديد الإرسالية");
        // في حالة الطرد الفردي، المبلغ المقبوض هو النقد المعدود
        lines = [
          {
            consignmentId: consignment.id,
            collectedAmount: String(countedNum),
          },
        ];
      } else {
        // في حالة التصفية الشاملة لكافة طرود الجهة
        if (remittableRows.length === 0) {
          notify.err("لا توجد طرود مسلّمة بانتظار التوريد لهذه الجهة");
          return;
        }

        if (countedNum === expectedTotal) {
          // تطابق تام: كل طرد يُسدد كامل متبقيه
          lines = remittableRows.map((r) => ({
            consignmentId: r.id,
            collectedAmount: String(r.remainingDue),
          }));
        } else {
          // توزيع تناسبي أكبر البواقي
          let remainingBudget = countedNum;
          lines = remittableRows.map((r, idx) => {
            if (idx === remittableRows.length - 1) {
              return {
                consignmentId: r.id,
                collectedAmount: String(Math.max(0, remainingBudget)),
              };
            }
            const share = Math.min(r.remainingDue, remainingBudget);
            remainingBudget -= share;
            return {
              consignmentId: r.id,
              collectedAmount: String(share),
            };
          });
        }
      }

      // استبعاد الأسطر الصفرية
      const activeLines = lines.filter((l) => Number(l.collectedAmount) > 0);
      if (activeLines.length === 0 && countedNum > 0) {
        throw new Error("تعذر توزيع المبلغ المقبوض على الإرساليات");
      }

      // 3. تنفيذ التوريد المالي الذري
      await submitRemittance({ payload: {
        partyId: effectivePartyId,
        shiftType,
        lines: activeLines,
        countedCash: String(countedNum),
        shortfall: isShortfall
          ? {
              reason: shortfallReason as ShortfallReason,
              notes: shortfallNotes.trim() || null,
            }
          : null,
        clientRequestId,
      }, partyLabel: consignment?.partyName ?? partyName ?? "جهة التوصيل" });
    } catch (err: unknown) {
      notify.err(err);
    }
  };

  const displayName = consignment?.partyName ?? partyName ?? "المندوب";

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && intentLocked) return; onOpenChange(next); }}>
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
          {submittedRemittance && <div role="alert" className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/30 p-3 text-sm">
            أُرسل طلب توريد بقيمة {fmt(submittedRemittance.payload.countedCash)} د.ع. استعد نتيجته بنفس الطلب قبل إجراء تحصيل آخر؛ قد تكون الذمة الحالية تغيّرت بعد تسجيله.
          </div>}
          {/* بطاقة معلومات المندوب */}
          <div className="rounded-xl border bg-muted/40 p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="size-4 text-primary" />
                <span className="font-extrabold text-base">{displayName}</span>
              </div>
              <Badge variant="outline" className="font-mono text-xs">
                {remittableRows.length} طرد مسلم بانتظار التوريد
              </Badge>
            </div>

            {consignment && (
              <div className="mt-2 pt-2 border-t text-xs grid grid-cols-2 gap-2 text-muted-foreground">
                <div>
                  الإرسالية: <span className="font-mono font-bold text-foreground">{consignment.consignmentNumber ?? `#${consignment.id}`}</span>
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

          {/* خيار نطاق التوريد إذا فتح من طرد فردي */}
          {consignment && (
            <div className="grid grid-cols-2 gap-2">
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
                <span className="text-xs font-bold text-muted-foreground">تحصيل هذا الطرد فقط</span>
                <span className="text-lg font-black text-emerald-600 mt-1 tabular-nums" dir="ltr">
                  {fmt(singleRemainingDue)} د.ع
                </span>
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  طرد #{consignment.consignmentNumber ?? consignment.id}
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
                  {fmt(allPartyRemainingDue)} د.ع
                </span>
                <span className="text-[10px] text-muted-foreground mt-0.5">
                  جميع الطرود المسلمة ({remittableRows.length} طرد)
                </span>
              </button>
            </div>
          )}

          {/* تأكيد التسليم المسبق إذا لم يكن مسلماً بعد */}
          {currentConsignment && currentConsignment.parcelStatus !== "DELIVERED" && (
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
                تأكيد وصول الطرد للعميل وقبض ثمنه أولاً (تأكيد تسليم + توريد فوري في خطوة واحدة)
              </label>
            </div>
          )}

          {/* تحديد الوردية والدرج */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-bold mb-1 block">وردية إيداع النقد</Label>
              <AppSelect
                value={shiftType}
                disabled={intentLocked}
                onValueChange={(val) => setShiftType(val as "RECEPTION" | "RETAIL")}
                className="h-10 text-sm"
              >
                <option value="RECEPTION">وردية الاستقبال (كاونتر المبيعات)</option>
                <option value="RETAIL">وردية التجزئة</option>
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
                المتوقع: <b className="text-foreground tabular-nums">{fmt(expectedTotal)}</b> د.ع
              </span>
            </div>

            <MoneyInput
              id="counted-cash-input"
              value={countedCash}
              disabled={intentLocked}
              onChange={setCountedCash}
              className="h-12 text-lg font-black text-end tabular-nums border-2 border-emerald-600/30 focus-visible:border-emerald-600"
              ariaLabel="المبلغ المقبوض"
            />

            {/* تنبيه العجز */}
            {isShortfall && !submittedRemittance && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 space-y-2 mt-2">
                <div className="flex items-center gap-2 text-xs font-black text-destructive">
                  <AlertTriangle className="size-4 shrink-0" />
                  يوجد عجز نقدي بمقدار {fmt(shortfallAmount)} د.ع سيقيد ذمة فورية على المندوب
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
                المبلغ المقبوض أكبر من الصافي المطلوب ({fmt(expectedTotal)} د.ع)؛ لا يقبل قبض زيادة عن الذمة.
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
              (settleScope === "SINGLE" && confirmDeliveryFirst && currentConsignment?.parcelStatus !== "DELIVERED" && !canConfirmDelivery) ||
              isPending ||
              countedNum <= 0 ||
              isExcess ||
              (isShortfall && !shortfallReason) ||
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
          {submittedRemittance && <Button disabled={!canRemit || isPending} onClick={() => void submitRemittance(submittedRemittance)}>
            {isPending ? "جارٍ التحقق من نتيجة التوريد…" : "استعادة نتيجة التوريد"}
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
