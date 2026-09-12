import { useEffect, useMemo, useState } from "react";
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
import { DeliveryRemittanceHistoryCard } from "@/components/delivery/DeliveryRemittanceHistoryCard";
import { DeliverySettleSummaryCard } from "@/components/delivery/DeliverySettleSummaryCard";
import { DeliveryConsignmentsTable } from "@/components/delivery/DeliveryConsignmentsTable";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ACTION_LABELS } from "@shared/actionLabels";

type OpenConsignment = RouterOutputs["delivery"]["openConsignments"]["rows"][number];

// ───────────────────────── تبويب: تسوية المناديب ─────────────────────────

export function DeliverySettleTab() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ? Number(me.data.branchId) : 0;
  const currentShift = trpc.shifts.current.useQuery(
    { branchId, shiftType: "RECEPTION" },
    { enabled: branchId > 0 },
  );
  const canRemit = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["cashier", "manager"],
    );
  const canReturn = !!me.data
    && moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "store",
      "FULL",
      ["manager", "cashier", "sales_rep"],
    );

  const settleSearch = useSearch();
  const [partyId, setPartyId] = useState<string>(() => new URLSearchParams(settleSearch).get("party") ?? "");
  const [returnTarget, setReturnTarget] = useState<ReturnConsignmentTarget | null>(null);
  const obligations = trpc.delivery.obligations.useQuery(undefined, { refetchInterval: 30_000 });
  const staleParties = trpc.delivery.staleParties.useQuery(undefined, { refetchInterval: 60_000 });

  const cons = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: Number(partyId), limit: 500 },
    {
      enabled: !!partyId,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  useEffect(() => {
    if (cons.hasNextPage && !cons.isFetchingNextPage) void cons.fetchNextPage();
  }, [cons.hasNextPage, cons.isFetchingNextPage, cons.fetchNextPage]);

  const remittances = trpc.delivery.remittances.useQuery({ partyId: Number(partyId), limit: 20 }, { enabled: !!partyId });
  const [rows, setRows] = useState<Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }>>({});
  const [countedBreakdown, setCountedBreakdown] = useState<Record<number, number>>({});
  const [countedCash, setCountedCash] = useState(0);
  const [remitReqId, setRemitReqId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const p = new URLSearchParams(settleSearch).get("party");
    if (p && p !== partyId) {
      setPartyId(p);
      setRows({});
      setRemitReqId(crypto.randomUUID());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleSearch]);

  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [statementNumber, setStatementNumber] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [statementDeductions, setStatementDeductions] = useState(0);
  const [statementNotes, setStatementNotes] = useState("");

  const resetAfterSettle = () => {
    setRows({});
    setCountedBreakdown({});
    setCountedCash(0);
    setStatementNumber("");
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

  const companyStatement = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      const proofNote = r.remittanceNumber ? `سند التوريد ${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع` : "كشف إثبات محض — لا سند توريد";
      notify.ok(`سُجِّل كشف الشركة ${r.statementNumber}`, `${proofNote}${r.deliveriesConfirmed > 0 ? ` · أثبت تسليم ${r.deliveriesConfirmed} طرداً` : ""}`);
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

  const remit = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      const commissionNote = r.courierCommissionAmount != null
        ? ` · عمولة القاعدة ${fmt(r.courierCommissionAmount)} (فرقٌ ${fmt(String(Number(r.feesTotal) - Number(r.courierCommissionAmount)))})`
        : "";
      notify.ok(
        "سُجِّل التوريد",
        `${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع${Number(r.shortfallTotal) > 0 ? ` (عجز ${fmt(r.shortfallTotal)})` : ""}${commissionNote}`,
      );
      const pName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "";
      printRemittanceReceipt(pName, r);
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

  const payPartyFees = trpc.delivery.payPartyFees.useMutation({
    onSuccess: (r) => {
      notify.ok(`صُرفت ${r.count} أجرة`, `المجموع ${fmt(r.paidTotal)} د.ع — بسند واحد`);
      resetAfterSettle();
    },
    onError: (e) => notify.err(e),
  });

  const ret = trpc.delivery.returnConsignment.useMutation({
    onSuccess: () => { notify.ok("أُرجعت الإرسالية"); resetAfterSettle(); },
    onError: (e) => notify.err(e),
  });

  const list = useMemo(
    () => (cons.data?.pages ?? []).flatMap((p) => p.rows),
    [cons.data],
  );
  const listStillLoading = cons.hasNextPage || cons.isFetchingNextPage;
  const partyName = obligations.data?.find((p) => String(p.partyId) === partyId)?.name ?? "";
  const partyRow = obligations.data?.find((p) => String(p.partyId) === partyId);

  const remainingOf = (c: OpenConsignment) => Math.max(0, Number(c.codAmount) - Number(c.collectedAmount) - Number(c.counterSettledAmount ?? "0") - Number(c.shortfallAssigned ?? "0"));
  const isRemittable = (c: OpenConsignment) => c.parcelStatus === "DELIVERED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL")
    && remainingOf(c) > 0;

  const statementMode = statementNumber.trim().length > 0;
  const isStatementConfirmable = (c: OpenConsignment) => c.status === "DISPATCHED"
    && c.parcelStatus !== "CANCELLED" && c.parcelStatus !== "RETURNED"
    && (c.moneyStatus === "UNSETTLED" || c.moneyStatus === "PARTIAL" || c.moneyStatus === "NOT_APPLICABLE");
  const isSettleable = (c: OpenConsignment) => isRemittable(c) || (statementMode && isStatementConfirmable(c));

  const get = (c: OpenConsignment) => rows[c.id] ?? (statementMode
    ? { outcome: "NONE" as const, collected: "0" }
    : (isSettleable(c) ? { outcome: "COLLECTED" as const, collected: String(remainingOf(c)) } : { outcome: "NONE" as const, collected: "0" }));

  const totals = useMemo(() => {
    let collected = 0, expected = 0, leftInTransit = 0, selectedCount = 0;
    for (const c of list) {
      if (!isSettleable(c)) continue;
      const remaining = remainingOf(c);
      const st = get(c);
      const col = st.outcome === "COLLECTED" ? Math.min(remaining, Math.max(0, Number(st.collected) || 0)) : 0;
      if (col > 0) {
        expected += remaining;
        collected += col;
        selectedCount += 1;
      } else if (remaining > 0) {
        leftInTransit += 1;
      }
    }
    const deductions = statementMode ? Math.max(0, statementDeductions || 0) : 0;
    const net = Math.max(0, collected - deductions);
    return { collected, fees: 0, net, deductions, shortfall: expected - collected, expected, leftInTransit, selectedCount };
  }, [list, rows, statementMode, statementDeductions]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const lines = list
      .filter((c) => isSettleable(c) && get(c).outcome === "COLLECTED")
      .map((c) => ({ consignmentId: c.id, collectedAmount: String(Math.max(0, Number(get(c).collected) || 0)) }))
      .filter((l) => Number(l.collectedAmount) >= 0);
    const validLines = statementMode ? lines : lines.filter((l) => Number(l.collectedAmount) > 0);
    if (validLines.length === 0) {
      notify.err("لا أسطر للتسوية — حدّد ما حُصِّل فعلاً");
      return;
    }
    if (Math.abs(countedCash - totals.net) > 0.01) {
      notify.err(`النقد المعدود لا يطابق الصافي المتوقع. المعدود ${fmt(String(countedCash))} والمتوقع ${fmt(String(totals.net))} د.ع`);
      return;
    }
    const ok = await confirm({
      variant: "danger",
      title: "تأكيد تسوية تحصيلات المندوب",
      description: `المُحصَّل والمورّد للمكتبة ${fmt(String(totals.net))} د.ع.${statementMode && validLines.filter((l) => Number(l.collectedAmount) === 0).length > 0 ? ` سيُثبَت تسليم ${validLines.filter((l) => Number(l.collectedAmount) === 0).length} طرداً بلا نقد.` : ""}${totals.leftInTransit > 0 ? ` (${totals.leftInTransit} إرسالية تبقى بالطريق خارج هذا التوريد.)` : ""}`,
      confirmText: "تأكيد التسوية",
    });
    if (!ok) return;
    if (statementMode) {
      companyStatement.mutate({
        partyId: Number(partyId),
        statementNumber: statementNumber.trim(),
        statementDate: statementDate || null,
        deductionsTotal: statementDeductions ? String(statementDeductions) : null,
        notes: statementNotes.trim() || null,
        lines: validLines,
        countedCash: countedCash.toFixed(2),
        clientRequestId: remitReqId,
      });
      return;
    }
    remit.mutate({
      partyId: Number(partyId),
      lines: validLines,
      countedCash: countedCash.toFixed(2),
      clientRequestId: remitReqId,
    });
  };

  const selectAll = () => {
    const next: Record<number, { outcome: "COLLECTED" | "NONE"; collected: string }> = {};
    for (const c of list) {
      if (isSettleable(c)) next[c.id] = { outcome: "COLLECTED", collected: String(remainingOf(c)) };
    }
    setRows(next);
  };

  return (
    <div className="space-y-4">
      {/* ─── بطاقة التزامات الجهات والجهات المتأخرة ─── */}
      <DeliveryObligationsCard
        obligations={obligations}
        staleParties={staleParties}
        partyId={partyId}
        onSelectParty={(p) => { setPartyId(p); setRows({}); setRemitReqId(crypto.randomUUID()); }}
      />

      {/* ─── تسوية الجهة المختارة ─── */}
      <div className="rounded-xl border bg-card p-4">
        <label htmlFor="delivery-settle-party" className="mb-1.5 block text-sm font-bold">اختر جهة التوصيل</label>
        <div className="flex flex-wrap items-center gap-2">
          <AppSelect
            id="delivery-settle-party"
            className="w-auto min-w-64 max-w-md"
            value={partyId}
            onValueChange={(value) => { setPartyId(value); setRows({}); setRemitReqId(crypto.randomUUID()); }}
          >
            <option value="">— اختر —</option>
            {(obligations.data ?? []).map((p) => (
              <option key={p.partyId} value={p.partyId}>{p.name} — نقد بيده {fmt(p.currentBalance)} د.ع</option>
            ))}
          </AppSelect>
          {partyId && partyName && (
            <>
              <DeliveryManifestButton partyId={Number(partyId)} partyName={partyName} />
              {partyRow && Number(partyRow.feeDueTotal) > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={payPartyFees.isPending || !currentShift.data?.id}
                  title={!currentShift.data?.id ? "افتح وردية استقبال لصرف الأجور من درج موثَّق" : `صرف ${fmt(partyRow.feeDueTotal)} د.ع مستحقة`}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "صرف كل الأجور المستحقة",
                      description: `صرف ${fmt(partyRow.feeDueTotal)} د.ع عن ${partyName} بسندٍ واحد من وردية الاستقبال #${currentShift.data?.id}.`,
                      confirmText: "صرف",
                    });
                    if (!ok || !currentShift.data?.id) return;
                    payPartyFees.mutate({ partyId: Number(partyId), shiftId: currentShift.data.id, clientRequestId: crypto.randomUUID() });
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
      ) : list.length === 0 ? (
        <EmptyState icon={Truck} title="لا التزامات مفتوحة" description="لا توجد مبالغ للتوريد أو أجور للدفع أو إرساليات قابلة للإرجاع لهذه الجهة." />
      ) : (
        <>
          <DeliveryConsignmentsTable
            list={list}
            rows={rows}
            statementMode={statementMode}
            canReturn={canReturn}
            onOutcomeToggle={(id, current, remaining) => {
              setRows((r) => ({
                ...r,
                [id]: {
                  outcome: current === "COLLECTED" ? "NONE" : "COLLECTED",
                  collected: current === "COLLECTED" ? "0" : String(remaining),
                },
              }));
            }}
            onCollectedChange={(id, value) => {
              setRows((r) => ({ ...r, [id]: { outcome: "COLLECTED", collected: value } }));
            }}
            onReturn={setReturnTarget}
            onOpenTimeline={setDrawerId}
          />

          <CompanyStatementBox
            statementNumber={statementNumber} onStatementNumberChange={(v) => { setStatementNumber(v); setRows({}); }}
            statementDate={statementDate} onStatementDateChange={setStatementDate}
            deductions={statementDeductions} onDeductionsChange={setStatementDeductions}
            notes={statementNotes} onNotesChange={setStatementNotes}
            onSelectAll={selectAll} onClearSelection={() => setRows({})}
            lines={list.filter((c) => isSettleable(c)).map((c) => ({ consignmentId: c.id, consignmentNumber: c.consignmentNumber, remaining: String(remainingOf(c)), selected: get(c).outcome === "COLLECTED", collected: get(c).collected }))}
          />

          <DeliverySettleSummaryCard
            totals={totals}
            countedCash={countedCash}
            countedBreakdown={countedBreakdown}
            onCountedChange={(c, total) => { setCountedBreakdown(c); setCountedCash(Number(total)); }}
            canRemit={canRemit}
            isPending={remit.isPending || companyStatement.isPending}
            listStillLoading={listStillLoading}
            statementMode={statementMode}
            statementNumber={statementNumber}
            onSubmit={submit}
          />

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
          ret.mutate({ consignmentId, clientRequestId: crypto.randomUUID(), refundShiftId });
          setReturnTarget(null);
        }}
      />

      <ConsignmentTimelineDrawer consignmentId={drawerId} onClose={() => setDrawerId(null)} />
    </div>
  );
}
