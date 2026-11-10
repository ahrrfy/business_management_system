import Decimal from "decimal.js";
import { lifecycleActionAllowed } from "@/lib/lifecycleActionPermission";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { Truck, Wallet } from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { ReturnConsignmentDialog, type ReturnConsignmentTarget } from "@/components/delivery/ReturnConsignmentDialog";
import { ConsignmentTimelineDrawer } from "@/components/delivery/ConsignmentTimelineDrawer";
import { CompanyStatementBox } from "@/components/delivery/CompanyStatementBox";
import { DeliveryManifestButton } from "@/components/delivery/DeliveryManifestButton";
import { DeliveryObligationsCard } from "@/components/delivery/DeliveryObligationsCard";
import { formatPartyObligationOptionLabel } from "@/components/delivery/DeliveryPartyExposureBadge";
import { DeliveryRemittanceHistoryCard } from "@/components/delivery/DeliveryRemittanceHistoryCard";
import { DeliverySettleSummaryCard } from "@/components/delivery/DeliverySettleSummaryCard";
import { DeliveryConsignmentsTable } from "@/components/delivery/DeliveryConsignmentsTable";
import { CompanyStatementScanQueue } from "@/components/delivery/CompanyStatementScanQueue";
import { shipmentStatementCandidates, statementClaimSnapshot, statementDraftLines, statementLineSummary, statementShipmentFees, parseStatementAmount, type StatementDecision, type CompanyStatementQueueCandidate } from "@/components/delivery/companyStatementQueue";
import { companyStatementPartyTransition } from "@/components/delivery/statementDraft";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
import { printCompanyStatementReceipt } from "@/lib/printing/printCompanyStatementReceipt";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { printAssignmentCancelReceipt, printDeliveryFeePaymentReceipt } from "@/lib/printing/cashierLifecycleReceipts";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { D, fmt , moneyInput } from "@/lib/money";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import {
  filterOperationalRows,
  mergeDisplayedSelection,
} from "@/lib/deliveryOperations";
import { statementQueueRemaining } from "@/components/delivery/companyStatementQueue";
import { CompanyStatementImport } from "@/components/delivery/CompanyStatementImport";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ACTION_LABELS } from "@shared/actionLabels";
import { useRealtimeEvent } from "@/lib/realtime";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";

type OpenConsignment = RouterOutputs["delivery"]["openConsignments"]["rows"][number];

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────

export function DeliverySettleTab() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const settleSearch = useSearch();
  const rawUrlBranch = Number(new URLSearchParams(settleSearch).get("branchId"));
  const branchId = me.data?.branchId ? Number(me.data.branchId) : rawUrlBranch > 0 ? rawUrlBranch : 0;
  const currentShift = trpc.shifts.current.useQuery(
    { branchId, shiftType: "RECEPTION" },
    { enabled: branchId > 0 },
  );
  const fallbackShift = trpc.shifts.current.useQuery(
    { branchId },
    { enabled: branchId > 0 && currentShift.isSuccess && !currentShift.data },
  );
  const activeShift = currentShift.data ?? fallbackShift.data ?? null;
  const canRemit = lifecycleActionAllowed(me.data, "delivery.recordRemittance", !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["cashier", "manager"],
    ));
  const canReturn = lifecycleActionAllowed(me.data, "delivery.returnConsignment", !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    ));

  const canRecordStatement = lifecycleActionAllowed(me.data, "delivery.recordCompanyStatement", canRemit);
  const canPayPartyFees = lifecycleActionAllowed(me.data, "delivery.payPartyFees", !!me.data);
  const [partyId, setPartyId] = useState<string>(() => new URLSearchParams(settleSearch).get("party") ?? "");
  const [returnTarget, setReturnTarget] = useState<ReturnConsignmentTarget | null>(null);
  const obligations = trpc.delivery.obligations.useQuery(branchId > 0 ? { branchId } : undefined);
  const staleParties = trpc.delivery.staleParties.useQuery(undefined);

  useRealtimeEvent(
    [
      REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
      REALTIME_EVENT_TYPES.DELIVERY_COMPLETED,
      REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED,
    ],
    () => {
      void utils.delivery.obligations.invalidate();
      void utils.delivery.staleParties.invalidate();
      if (partyId) {
        void utils.delivery.openConsignments.invalidate();
        void utils.delivery.remittances.invalidate();
      }
    },
  );

  const cons = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: Number(partyId), ...(branchId > 0 ? { branchId } : {}), limit: 500 },
    {
      enabled: !!partyId,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  useEffect(() => {
    if (cons.hasNextPage && !cons.isFetchingNextPage&& !cons.isError) void cons.fetchNextPage();
  }, [cons.hasNextPage, cons.isFetchingNextPage, cons.isError,
    cons.fetchNextPage,
  ]);

  const remittances = trpc.delivery.remittances.useQuery({ partyId: Number(partyId), limit: 20 }, { enabled: !!partyId });
  const [rows, setRows] = useState<Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }>>({});
  const [claimSnapshots, setClaimSnapshots] = useState<Record<number, string>>({});
  const [statementDecisions, setStatementDecisions] = useState<Record<number, StatementDecision>>({});
  const [statementQueueIds, setStatementQueueIds] = useState<number[]>([]);
  const [pendingStatement, setPendingStatement] = useState<RouterInputs["delivery"]["recordCompanyStatement"] | null>(null);
  const [pendingRemittance, setPendingRemittance] = useState<RouterInputs["delivery"]["recordRemittance"] | null>(null);
  const [countedBreakdown, setCountedBreakdown] = useState<Record<number, number>>({});
  const [countedCash, setCountedCash] = useState(0);
  const [remitReqId, setRemitReqId] = useState(() => crypto.randomUUID());
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [statementNumber, setStatementNumber] = useState("");
  const [appendToStatement, setAppendToStatement] = useState(false);
  const [parcelFilter, setParcelFilter] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [statementDeductions, setStatementDeductions] = useState(0);
  const [statementNotes, setStatementNotes] = useState("");

  const draftBusyRef = useRef(false);
  const switchParty = (nextPartyId: string) => {
    if (draftBusyRef.current) return;
    const reset = companyStatementPartyTransition(partyId, nextPartyId, 0);
    if (!reset) return;

    setPartyId(reset.partyId);
    setParcelFilter("");
    setRows(reset.selections);
    setClaimSnapshots({});
    setStatementDecisions({});
    setStatementQueueIds(reset.queueIds);
    setCountedBreakdown(reset.countedBreakdown);
    setCountedCash(reset.countedCash);
    setStatementNumber(reset.statementNumber);
    setAppendToStatement(false);
    setStatementDate(reset.statementDate);
    setStatementDeductions(reset.statementDeductions);
    setStatementNotes(reset.statementNotes);
    setRemitReqId(crypto.randomUUID());
  };

  useEffect(() => {
    const p = new URLSearchParams(settleSearch).get("party");
    if (p) switchParty(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleSearch]);

  const resetAfterSettle = () => {
    setPendingStatement(null);
    setPendingRemittance(null);
    setRows({});
    setClaimSnapshots({});
    setStatementDecisions({});
    setStatementQueueIds([]);
    setCountedBreakdown({});
    setCountedCash(0);
    setStatementNumber("");
    setAppendToStatement(false);
    setStatementDate("");
    setStatementDeductions(0);
    setStatementNotes("");
    setRemitReqId(crypto.randomUUID());
    utils.delivery.openConsignments.invalidate();
    utils.delivery.inTransit.invalidate();
    utils.delivery.listParties.invalidate();
    utils.delivery.obligations.invalidate();
    utils.delivery.remittances.invalidate();
  };

  const stmtWinRef = useRef<{ win: Window | null; count: number } | null>(null);
  const remitWinRef = useRef<Window | null>(null);
  const feeWinRef = useRef<Window | null>(null);
  const retWinRef = useRef<{ win: Window | null; row: OpenConsignment | undefined; consignmentId: number } | null>(null);

  const companyStatement = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      const snap = stmtWinRef.current;
      stmtWinRef.current = null;
      const proofNote = r.remittanceNumber ? `سند التوريد ${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع` : "كشف إثبات محض — لا سند توريد";
      notify.ok(`سُجِّل كشف الشركة ${r.statementNumber}`, `${proofNote}${r.deliveriesConfirmed > 0 ? ` · أثبت تسليم ${r.deliveriesConfirmed} طرداً` : ""}`);
      const pName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "شركة التوصيل";
      void printCompanyStatementReceipt(
        {
          companyName: pName,
          statementNumber: r.statementNumber,
          remittanceNumber: r.remittanceNumber,
          deliveriesConfirmed: r.deliveriesConfirmed,
          statementConsignmentCount: snap?.count,
          collectedTotal: r.collectedTotal,
          deductionsTotal: statementDeductions ? String(statementDeductions) : "0.00",
          netRemitted: r.netRemitted,
          notes: statementNotes.trim() || null,
        },
        snap?.win ? { into: snap.win } : undefined,
      );
      resetAfterSettle();
    },
    onError: (e) => {
      try { stmtWinRef.current?.win?.close(); } catch { /* noop */ }
      stmtWinRef.current = null;
      const status = e.data?.httpStatus;
      if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 499) setPendingStatement(null);
      notify.err(e, "إذا انقطع الاتصال فاستخدم استعادة نتيجة الكشف بالطلب المحفوظ");
    },
  });

  const remit = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      const win = remitWinRef.current;
      remitWinRef.current = null;
      const commissionNote = r.courierCommissionAmount != null
        ? ` · عمولة القاعدة ${fmt(r.courierCommissionAmount)} (فرقٌ ${fmt(D(r.feesTotal).minus(D(r.courierCommissionAmount)).toFixed(2))})`
          : "";
      notify.ok(
        "سُجِّل التوريد",
        `${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع${D(r.shortfallTotal).gt(0) ? ` (عجز ${fmt(r.shortfallTotal)})` : ""}${commissionNote}`,
      );
      const pName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "";
      printRemittanceReceipt(pName, r, win ? { into: win } : undefined);
      resetAfterSettle();
    },
    onError: (e) => {
      try { remitWinRef.current?.close(); } catch { /* noop */ }
      remitWinRef.current = null;
      const status = e.data?.httpStatus;
      if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 499) setPendingRemittance(null);
      notify.err(e, "إذا انقطع الاتصال فاستخدم استعادة نتيجة التوريد بالطلب المحفوظ");
    },
  });

  const payPartyFees = trpc.delivery.payPartyFees.useMutation({
    onSuccess: (r) => {
      const win = feeWinRef.current;
      feeWinRef.current = null;
      notify.ok(`صُرفت ${r.count} أجرة`, `المجموع ${fmt(r.paidTotal)} د.ع — بسند واحد`);
      const pName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "جهة التوصيل";
      void printDeliveryFeePaymentReceipt(
        {
          voucherNumber: `PF-${partyId}-${Date.now()}`,
          partyName: pName,
          amount: r.paidTotal,
          paymentMethod: "CASH",
          cashierName: me.data?.name ?? null,
          shiftId: activeShift?.id ?? null,
          notes: `صرف أجور ${r.count} إرسالية`,
        },
        win ? { into: win } : undefined,
      );
      void utils.delivery.invalidate();
    },
    onError: (e) => {
      try { feeWinRef.current?.close(); } catch { /* noop */ }
      feeWinRef.current = null;
      notify.err(e);
    },
  });

  const ret = trpc.delivery.returnConsignment.useMutation({
    onSuccess: (_, variables) => {
      const snap = retWinRef.current;
      retWinRef.current = null;
      notify.ok("أُرجعت الإرسالية");
      if (snap) {
        void printAssignmentCancelReceipt(
          {
            action: "cancelAssignment",
            consignmentNumber: snap.row?.consignmentNumber ?? String(snap.consignmentId),
            sourceRef: snap.row?.orderNumber ?? snap.row?.invoiceNumber ?? null,
            partyName: obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? null,
            recipientName: snap.row?.recipientName ?? snap.row?.customerName ?? null,
            codAmount: snap.row?.codAmount ?? "0",
            reason: "استلام مرتجع إرسالية من شاشة التسوية",
            cashierName: me.data?.name ?? null,
          },
          snap.win ? { into: snap.win } : undefined,
        );
      }
      setReturnTarget(null);
      setRows((current) => {
        const next = { ...current };
        delete next[variables.consignmentId];
        return next;
      });
      setStatementQueueIds((current) =>
        current.filter((id) => id !== variables.consignmentId),
      );
      void utils.delivery.invalidate();
    },
    onError: (e) => {
      try { retWinRef.current?.win?.close(); } catch { /* noop */ }
      retWinRef.current = null;
      notify.err(e);
    },
  });

  draftBusyRef.current =
    companyStatement.isPending ||
    remit.isPending ||
    pendingStatement != null ||
    pendingRemittance != null ||
    ret.isPending ||
    payPartyFees.isPending;

  const list = useMemo(
    () => (cons.data?.pages ?? []).flatMap((p) => p.rows),
    [cons.data],
  );
  const listStillLoading = cons.isLoading ||
    cons.hasNextPage || cons.isFetchingNextPage||
    cons.isError;
  const displayedStatementRows = filterOperationalRows(list, parcelFilter);
  const partyName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "";
  const partyRow = obligations.data?.find((p) => String(p.partyId) === partyId);

  const remainingOf = (c: OpenConsignment) => statementQueueRemaining(c);
  const remittableOf = (c: OpenConsignment) =>
    Boolean(c.physicalReturnReceived) && c.parcelStatus !== "DELIVERED"
      ? D(c.cashInCourierCustody ?? 0)
      : remainingOf(c);
  const isRemittable = (c: OpenConsignment) =>
    (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL") &&
    ((c.parcelStatus === "DELIVERED" &&
      (c.cashInCourierCustody == null || D(c.cashInCourierCustody).gt(0)) &&
      remainingOf(c).gt(0)) ||
      (Boolean(c.physicalReturnReceived) && D(c.cashInCourierCustody ?? 0).gt(0)));

  const statementMode = partyRow?.partyType === "COMPANY" || statementNumber.trim().length > 0;
  const isStatementConfirmable = (c: OpenConsignment) => c.status === "DISPATCHED"
    && c.parcelStatus !== "CANCELLED" && c.parcelStatus !== "RETURNED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL" || c.moneyStatus === "NOT_APPLICABLE");
  const isSettleable = (c: OpenConsignment) => isRemittable(c) || (statementMode && isStatementConfirmable(c));

  const get = (c: OpenConsignment) => rows[c.id] ?? { outcome: "NONE" as const, collected: "0" };
  const feePreview = statementShipmentFees(list.filter((c) => isSettleable(c) && get(c).outcome === "COLLECTED"),
    Object.fromEntries(Object.entries(rows).map(([id, row]) => [Number(id), row.collected])));
  const statementDeduction = moneyInput(statementDeductions);
  const feeNeedsExplicit = statementMode && feePreview.needsExplicit && statementDeduction.isZero();
  const feeMismatch = statementMode && !feePreview.needsExplicit && statementDeduction.gt(0) && !statementDeduction.eq(feePreview.total);

  const totals = useMemo(() => {
    let fees = D(0);
    let collected = D(0), expected = D(0), leftInTransit = 0, selectedCount = 0;
    for (const c of list) {
      if (!isSettleable(c)) {
        if (remainingOf(c).gt(0)) leftInTransit += 1;
        continue;
      }
      const remaining = statementMode ? remainingOf(c) : remittableOf(c);
      const st = get(c);
      if (st.outcome === "COLLECTED" ) {
        selectedCount += 1;
        expected = expected.plus(remaining);
        const amount = statementMode ? (parseStatementAmount(st.collected) ?? D(0)) : remaining;
        collected = collected.plus(amount);
        if (!statementMode) fees = fees.plus(Decimal.min(amount, D(c.feeWithholdingCash ?? "0")));
      } else if (remaining .gt(0) ) leftInTransit += 1;
      }
    const declaredDeduction = statementMode ? moneyInput(statementDeductions) : D(0);
    if (statementMode) fees = declaredDeduction.gt(0) ? declaredDeduction : feePreview.total;
    const deductions = D(0);
    const rawNet = collected.minus(fees).minus(deductions);
    const net = rawNet.isNegative() ? D(0): rawNet;
    // Existing summary/cash-counter presentation contract is numeric; calculations stay Decimal.
    return { collected: collected.toNumber(), fees: fees.toNumber(), net: net.toNumber(), deductions: deductions.toNumber(), shortfall: expected .minus(collected).toNumber(), expected: expected.toNumber(), leftInTransit, selectedCount };
  }, [list, rows, statementMode, statementDeductions]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (pendingStatement && !companyStatement.isPending) { companyStatement.mutate(pendingStatement); return; }
    if (pendingRemittance && !remit.isPending) { remit.mutate(pendingRemittance); return; }
    if (!(statementMode ? canRecordStatement : canRemit)) { notify.err("صلاحية تسجيل الكشف أو التوريد غير ممنوحة لحسابك"); return; }
    if (listStillLoading) {
      notify.err("لا يمكن التسوية قبل اكتمال تحميل قائمة الإرساليات");
      return;
    }
    if (partyRow?.partyType === "COMPANY" && statementNumber.trim().length < 2) {
      notify.err("رقم كشف شركة التوصيل مطلوب", "أدخل رقم الكشف ثم امسح باركود كل بوليصة وردت فيه.");
      return;
    }
    const selected = list
      .filter((c) => isSettleable(c) && get(c).outcome === "COLLECTED",
    )
      ;
    if (Object.values(rows).filter((row) => row.outcome === "COLLECTED").length !== selected.length) {
      notify.err("تغيرت قائمة الفواتير المحددة؛ حدّث البيانات وأعد اختيار الشحنة قبل الحفظ");
      return;
    }
    if (selected.some((row) => row.feeWithholdingBlocked)) {
      notify.err("راجع قيود أجرة الشحنة وجهتها وفرعها وقاعدة العمولة قبل التوريد");
      return;
    }
    if (statementMode && (feePreview.insufficient || feeNeedsExplicit || feeMismatch || statementDeduction.gt(D(totals.collected)))) {
      notify.err(feePreview.insufficient ? "نقد إحدى الشحنات لا يكفي لأجرتها؛ راجع الشحنة أو سوّ الأجرة مستقلاً" :
        feeNeedsExplicit ? "أدخل استقطاع الأجرة المثبت في كشف الشركة قبل حساب الصافي" : "الاستقطاع لا يطابق أجور الشحنات المحددة؛ راجع الكشف");
      return;
    }
    const amounts = Object.fromEntries(Object.entries(rows).map(([id, row]) => [Number(id), row.collected]));
    const statementLines = statementMode ? statementDraftLines(selected, amounts, claimSnapshots, statementDecisions) : null;
    if (statementMode && !statementLines) {
      notify.err("راجع مبالغ الكشف ومسؤولية الفروق أو بيانات الفاتورة المتغيرة قبل الحفظ");
      return;
    }
    const lines = selected.map((c) => ({ consignmentId: c.id, collectedAmount: remittableOf(c).toFixed(2) }));
    const validLines = statementMode ? statementLines! : lines.filter((line) => D(line.collectedAmount) .gt(0));
    if (validLines.length === 0) {
      notify.err("لا أسطر للتسوية — حدّد ما حُصِّل فعلاً");
      return;
    }
    if (!D(countedCash).eq(D(totals.net))) {
      notify.err(`النقد المعدود لا يطابق الصافي المتوقع. المعدود ${fmt(String(countedCash))} والمتوقع ${fmt(String(totals.net))} د.ع`);
      return;
    }
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد تسوية تحصيلات المندوب",
      description: [statementMode ? (appendToStatement ? `إكمال الكشف ${statementNumber} بدفعة جديدة` : `تسجيل أول دفعة للكشف ${statementNumber}`) : "توريد الشحنات المحددة",
        `عدد الفواتير المحددة: ${validLines.length}. النقد المورّد ${fmt(String(totals.net))} د.ع.`,
        ...validLines.map((line) => statementLineSummary(selected.find((c) => c.id === line.consignmentId)!, line.collectedAmount, statementDecisions[line.consignmentId])),
        "تبقى الشحنات غير المحددة خارج هذا التوريد."].join("\n"),
      confirmText: "تأكيد التسوية",
    });
    if (!ok) return;
    if (statementMode) {
      stmtWinRef.current = { win: preopenDocumentWindow(), count: validLines.length };
      const submitted = {
        partyId: Number(partyId),
        ...(activeShift?.id ? { targetShiftId: activeShift.id } : {}),
        statementNumber: statementNumber.trim(),
        appendToStatement,
        statementDate: appendToStatement ? null : statementDate || null,
        deductionsTotal: statementDeductions ? String(statementDeductions) : null,
        notes: statementNotes.trim() || null,
        lines: validLines,
        countedCash: countedCash.toFixed(2),
        clientRequestId: remitReqId,
      };
      setPendingStatement(submitted);
      companyStatement.mutate(submitted);
      return;
    }
    remitWinRef.current = preopenDocumentWindow();
    const submitted = {
      partyId: Number(partyId),
      ...(activeShift?.id ? { targetShiftId: activeShift.id } : {}),
      lines: validLines,
      countedCash: countedCash.toFixed(2),
      clientRequestId: remitReqId,
    };
    setPendingRemittance(submitted);
    remit.mutate(submitted);
  };

  const displayedEligible = Array.from(new Map(displayedStatementRows.filter(isSettleable)
    .flatMap((row) => shipmentStatementCandidates(list.filter(isSettleable), row.id))
    .map((row) => [row.id, row])).values());
  const selectAll = () => {
    setClaimSnapshots((current) => ({ ...current, ...Object.fromEntries(displayedEligible
      .filter((c) => rows[c.id]?.outcome !== "COLLECTED")
      .map((c) => [c.id, statementClaimSnapshot(c)])) }));
    setRows((current) =>
      mergeDisplayedSelection(current, displayedEligible, (id) =>
        current[id]?.outcome === "COLLECTED"
          ? current[id]
          : { outcome: "COLLECTED" as const,
              collected: (statementMode ? remainingOf(list.find((c)=> c.id=== id)!) : remittableOf(list.find((c)=> c.id=== id)!)).toFixed(2),
            },
      ),
    );
    setStatementQueueIds((current) => Array.from(new Set([...current, ...displayedEligible.map((c) => c.id)])));

  };
  const clearDisplayed = () => {
    const visible = new Set(displayedEligible.map((c) => c.id));
    setRows((current) =>
      mergeDisplayedSelection(current, displayedEligible, () => ({ outcome: "NONE" as const, collected: "0",
      })) );
    setStatementQueueIds((current) => current.filter((id) => !visible.has(id)));
    setStatementDecisions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !visible.has(Number(id)))));
  };

  return (
    <div className="space-y-4">
      {/* ─── بطاقة التزامات الجهات والجهات المتأخرة ─── */}
      <DeliveryObligationsCard
        obligations={obligations}
        staleParties={staleParties}
        partyId={partyId}
        onSelectParty={switchParty}
      />

      {/* ─── تسوية الجهة المختارة ─── */}
      {(pendingStatement || pendingRemittance) && <div role="alert" className="rounded border p-3 text-sm space-y-2">
        <p>نتيجة العملية غير مؤكدة. استعدها بإعادة إرسال الطلب الأصلي نفسه قبل إجراء تسوية أخرى.</p>
        <Button type="button" disabled={companyStatement.isPending || remit.isPending} onClick={() => void submit()}>استعادة نتيجة التوريد</Button>
      </div>}
      <div className="rounded-xl border bg-card p-4">
        <label htmlFor="delivery-settle-party" className="mb-1.5 block text-sm font-bold">اختر جهة التوصيل</label>
        <div className="flex flex-wrap items-center gap-2">
          <AppSelect
            disabled={
              companyStatement.isPending ||
              remit.isPending ||
              ret.isPending ||
              payPartyFees.isPending
            }
            id="delivery-settle-party"
            className="w-auto min-w-64 max-w-md"
            value={partyId}
            onValueChange={switchParty}
          >
            <option value="">— اختر —</option>
            {(obligations.data ?? []).map((p) => (
              <option key={p.partyId} value={p.partyId}>{formatPartyObligationOptionLabel(p.name, p.partyType === "COMPANY" ? "شركة" : "مندوب", p)}</option>
            ))}
          </AppSelect>
          {partyId && partyName && (
            <>
              <DeliveryManifestButton partyId={Number(partyId)} partyName={partyName} />
              {partyRow && D(partyRow.feeDueTotal) .gt(0 ) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canPayPartyFees || payPartyFees.isPending || !activeShift?.id}
                  title={!activeShift?.id ? "افتح وردية لصرف الأجور من درج موثَّق" : `صرف ${fmt(partyRow.feeDueTotal)} د.ع مستحقة`}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "صرف كل الأجور المستحقة",
                      description: `صرف ${fmt(partyRow.feeDueTotal)} د.ع عن ${partyName} بسندٍ واحد من الوردية #${activeShift?.id}.`,
                      confirmText: "صرف",
                    });
                    if (!ok || !activeShift?.id) return;
                    feeWinRef.current = preopenDocumentWindow();
                    payPartyFees.mutate({ partyId: Number(partyId), shiftId: activeShift.id, clientRequestId: crypto.randomUUID() });
                  }}
                >
                  <Wallet aria-hidden className="size-3.5" />
                  صرف كل الأجور ({fmt(partyRow.feeDueTotal)} د.ع)
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {!partyId ? null : cons.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>
      ) : cons.isError && list.length === 0 ? (
        <div role="alert" className="rounded border p-4 text-sm">
          تعذر تحميل الإرساليات.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void cons.refetch()}
          >
            إعادة المحاولة
          </Button>
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={Truck} title="لا التزامات مفتوحة" description="لا توجد مبالغ للتوريد أو أجور للدفع أو إرساليات قابلة للإرجاع لهذه الجهة." />
      ) : (
        <>
          <UnifiedSearchInput
            value={parcelFilter}
            onChange={setParcelFilter}
            placeholder="بحث بالاسم والهاتف والفاتورة والبوليصة…"
            aria-label="تصفية إرساليات التسوية"
          />
          <p className="text-xs text-muted-foreground">
            المعروض: {displayedStatementRows.length} من {list.length} · التحديد
            المحفوظ يشمل النتائج المخفية؛ راجعه قبل التأكيد.
          </p>
          {cons.isError && (
            <p role="alert" className="text-sm text-destructive">
              تعذر تحميل قائمة الإرساليات كاملة. التحديد محفوظ؛ أعد المحاولة قبل
              التسوية.{" "}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void cons.refetch()}
              >
                إعادة المحاولة
              </Button>
            </p>
          )}
          <DeliveryConsignmentsTable
            list={displayedStatementRows}
            rows={rows}
            statementMode={statementMode}
            canReturn={canReturn}
            onOutcomeToggle={(id, current) => {
              if (draftBusyRef.current) return;
              const members = shipmentStatementCandidates(list.filter(isSettleable), id);
              const memberIds = members.map((row) => row.id);
              if (current !== "COLLECTED") setClaimSnapshots((snapshots) => ({ ...snapshots, ...Object.fromEntries(members.filter((member) => rows[member.id]?.outcome !== "COLLECTED").map((member) => [member.id, statementClaimSnapshot(member)])) }));
              else setStatementDecisions((decisions) => Object.fromEntries(Object.entries(decisions).filter(([key]) => !memberIds.includes(Number(key)))));
              if (statementMode) {
                setStatementQueueIds((ids) => current === "COLLECTED"
                  ? ids.filter((queuedId) => !memberIds.includes(queuedId))
                  : Array.from(new Set([...ids, ...memberIds])));
              }
              setRows((r) => ({
                ...r,
                ...Object.fromEntries(members.filter((member) => current === "COLLECTED" || r[member.id]?.outcome !== "COLLECTED").map((member) => [member.id, {
                  outcome: current === "COLLECTED" ? "NONE" : "COLLECTED",
                  collected: current === "COLLECTED" ? "0" : (statementMode ? remainingOf(member) : remittableOf(member)).toFixed(2),
                }] as const)),
              }));
            }}
            onCollectedChange={(id, value) => {
              if (draftBusyRef.current) return;
              setRows((r) => ({ ...r, [id]: { outcome: "COLLECTED", collected: value } }));
            }}
            onReturn={setReturnTarget}
            onOpenTimeline={setDrawerId}
          />

          <CompanyStatementBox
            required={partyRow?.partyType === "COMPANY"}
            disabled={companyStatement.isPending || remit.isPending || pendingStatement != null || pendingRemittance != null}
            statementNumber={statementNumber} onStatementNumberChange={(v) => { setStatementNumber(v); setRows({}); setClaimSnapshots({}); setStatementDecisions({}); setStatementQueueIds([]); }}
            statementDate={statementDate} onStatementDateChange={setStatementDate}
            deductions={statementDeductions} onDeductionsChange={setStatementDeductions}
            notes={statementNotes} onNotesChange={setStatementNotes}
            onSelectAll={selectAll}
            onClearSelection={clearDisplayed}
            displayedCount={ displayedEligible.length}
            selectionDisabled={listStillLoading || companyStatement.isPending || remit.isPending || pendingStatement != null || pendingRemittance != null
            }
            lines={list.filter((c) => isSettleable(c)).map((c) => ({ consignmentId: c.id, consignmentNumber: c.consignmentNumber, remaining: (statementMode ? remainingOf(c) : remittableOf(c)).toFixed(2), selected: get(c).outcome === "COLLECTED", collected: get(c).outcome === "COLLECTED" ? (parseStatementAmount(get(c).collected)?.toFixed(2) ?? "0") : "0" }))}
          />

          {partyRow?.partyType === "COMPANY" && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={appendToStatement} disabled={companyStatement.isPending || remit.isPending || pendingStatement != null || pendingRemittance != null}
                onChange={(event) => setAppendToStatement(event.target.checked)} />
              <span>إكمال كشف مسجّل سابقاً: أضف الشحنات المحددة إلى الكشف الأصلي كدفعة مستقلة.</span>
            </label>
          )}

          {partyRow?.partyType === "COMPANY" && (
            <CompanyStatementScanQueue
              candidates={list.filter((candidate) => isSettleable(candidate)) as CompanyStatementQueueCandidate[]}
              queuedIds={statementQueueIds}
              collectedById={Object.fromEntries(Object.entries(rows).map(([id, row]) => [Number(id), row.collected]))}
              claimSnapshots={claimSnapshots}
              decisionsById={statementDecisions}
              disabled={statementNumber.trim().length < 2 || listStillLoading||
                companyStatement.isPending || pendingStatement != null || pendingRemittance != null
              }
              onQueue={(candidate, collected) => {
                setClaimSnapshots((current) => ({ ...current, [candidate.id]: statementClaimSnapshot(candidate) }));
                setStatementQueueIds((ids) => ids.includes(candidate.id) ? ids : [...ids, candidate.id]);
                setRows((current) => ({ ...current, [candidate.id]: { outcome: "COLLECTED", collected } }));
              }}
              onRemove={(consignmentId) => {
                const memberIds = shipmentStatementCandidates(list, consignmentId).map((row) => row.id);
                setStatementQueueIds((ids) => ids.filter((id) => !memberIds.includes(id)));
                setRows((current) => ({ ...current, ...Object.fromEntries(memberIds.map((id) => [id, { outcome: "NONE" as const, collected: "0" }])) }));
                setStatementDecisions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !memberIds.includes(Number(key)))));
              }}
              onCollectedChange={(consignmentId, collected) => {
                setRows((current) => ({ ...current, [consignmentId]: { outcome: "COLLECTED", collected } }));
                setStatementDecisions((current) => ({ ...current, [consignmentId]: {} }));
              }}
              onDecisionChange={(consignmentId, decision) => setStatementDecisions((current) => ({ ...current, [consignmentId]: decision }))}
            />
          )}

          {partyRow?.partyType === "COMPANY" && (
            <CompanyStatementImport
              key={partyId}
              partyId={Number(partyId)}
              candidates={list.filter(isSettleable)}
              selectedIds={list
                .filter((candidate) => get(candidate).outcome === "COLLECTED")
                .map((candidate) => candidate.id)}
              disabled={
                statementNumber.trim().length < 2 ||
                listStillLoading ||
                companyStatement.isPending || pendingStatement != null || pendingRemittance != null
              }
              onApply={(lines) => {
                const expanded = lines;
                setClaimSnapshots((current) => ({ ...current, ...Object.fromEntries(lines.flatMap((line) => {
                  const candidate = list.find((row) => row.id === line.consignmentId);
                  return candidate ? [[candidate.id, statementClaimSnapshot(candidate)]] : [];
                })) }));
                setRows((current) => ({
                  ...current,
                  ...Object.fromEntries(
                    expanded.map((line) => [
                      line.consignmentId,
                      {
                        outcome: "COLLECTED" as const,
                        collected: line.collectedAmount,
                      },
                    ]),
                  ),
                }));
                setStatementQueueIds((current) => Array.from(new Set([...current, ...expanded.map((line) => line.consignmentId)])));

              }}
            />
          )}

          {(feeNeedsExplicit && !pendingStatement) ? <p role="alert" className="text-sm font-bold text-destructive">تعذرت مطابقة مصدر أجرة الشحنة تلقائياً؛ أدخل استقطاع الأجرة المثبت في كشف الشركة قبل حساب الصافي.</p> : <DeliverySettleSummaryCard
            totals={totals}
            countedCash={countedCash}
            countedBreakdown={countedBreakdown}
            onCountedChange={(c, total) => { if (draftBusyRef.current) return; setCountedBreakdown(c); setCountedCash(Number(total)); }}
            canRemit={statementMode ? canRecordStatement && !feePreview.insufficient && !feeMismatch && !statementDeduction.gt(D(totals.collected)) : canRemit}
            isPending={remit.isPending || companyStatement.isPending || pendingStatement != null || pendingRemittance != null}
            listStillLoading={listStillLoading}
            statementMode={statementMode}
            statementNumber={statementNumber}
            onSubmit={submit}
          />}
          {statementMode && feePreview.insufficient && <p role="alert" className="text-sm font-bold text-destructive">نقد إحدى الشحنات لا يكفي لأجرتها؛ لا تُحسم من شحنة أخرى.</p>}
          {feeMismatch && <p role="alert" className="text-sm font-bold text-destructive">الاستقطاع لا يطابق أجور الشحنات المحددة؛ راجع الكشف.</p>}
          {statementMode && statementDeduction.gt(D(totals.collected)) && <p role="alert" className="text-sm font-bold text-destructive">الاستقطاع يتجاوز نقد الكشف المحدد.</p>}

          <DeliveryRemittanceHistoryCard
            partyName={partyName}
            remittances={remittances}
          />
        </>
      )}

      <ReturnConsignmentDialog
        target={returnTarget}
        pending={ret.isPending}
        onClose={() => setReturnTarget(null)}
        onConfirm={({ consignmentId, refundShiftId }) => {
          const row = list.find((c) => Number(c.id) === Number(consignmentId));
          retWinRef.current = { win: preopenDocumentWindow(), row, consignmentId };
          ret.mutate({ consignmentId, clientRequestId: crypto.randomUUID(), refundShiftId });
        }}
      />

      <ConsignmentTimelineDrawer consignmentId={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}
