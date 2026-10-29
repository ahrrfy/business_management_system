/**
 * ReceptionCollectSection - قسم التحصيل والذمم في شاشة الاستقبال
 * تحصيل وذمم المناديب والشركات ومطابقة الكشوفات ومسح باركود الإرسالية
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RouterOutputs } from "@/lib/trpc";
import {
  BarChart3,
  Building2,
  CheckCircle2,
  CheckSquare,
  Clock,
  Loader2,
  MapPin,
  Phone,
  Printer,
  ScanLine,
  Search,
  Square,
  User,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { cn } from "@/lib/utils";
import { D, fmt, moneyInput, round2 } from "@/lib/money";
import { errMsg, notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { confirm } from "@/lib/confirm";
import {
  printRemittanceReceiptAsync,
  type RemittanceReceiptData,
} from "@/components/delivery/printRemittanceReceipt";
import { preopenDocumentWindow } from "@/lib/printing/print";
import { printInvoicePaymentReceipt, type InvoicePaymentReceiptData } from "@/lib/printing/cashierLifecycleReceipts";
import { WorkflowPrintActions } from "@/components/delivery/workflow/WorkflowPrintActions";
import {
  printCompanyStatementReceiptAsync,
  type CompanyStatementReceiptData,
} from "@/lib/printing/printCompanyStatementReceipt";
import { CompanyStatementScanQueue } from "@/components/delivery/CompanyStatementScanQueue";
import {
  statementQueueRemaining,
  type CompanyStatementQueueCandidate,
} from "@/components/delivery/companyStatementQueue";
import { companyStatementPartyTransition } from "@/components/delivery/statementDraft";
import {
  PredictiveConsignmentSearchInput,
  type PredictiveItem,
} from "@/components/delivery/PredictiveConsignmentSearchInput";
import {
  filterOperationalRows,
  mergeDisplayedSelection,
} from "@/lib/deliveryOperations";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { CompanyStatementImport } from "@/components/delivery/CompanyStatementImport";
import { docBarcode } from "@shared/documentNumber";
import type { WorkflowScanPreview } from "@shared/deliveryWorkflow";
import { deliverySourceView } from "@shared/deliverySource";
import {
  SHORTFALL_REASONS,
  SHORTFALL_REASON_LABEL_AR,
  type ShortfallReason,
} from "@shared/shortfallReason";

export type PartyObligation = RouterOutputs["delivery"]["obligations"][number];
type FinancialRetry = { signature: string; key: string };
type SavedRemittancePrint = {
  partyName: string;
  branchId: number;
  receipt: RemittanceReceiptData;
};
type SavedCompanyStatementPrint = {
  branchId: number;
  receipt: CompanyStatementReceiptData;
};
function financialRetryKey(
  ref: { current: FinancialRetry | null },
  payload: unknown,
) {
  const signature = JSON.stringify(payload);
  if (ref.current?.signature !== signature)
    ref.current = { signature, key: crypto.randomUUID() };
  return ref.current!.key;
}

function BarcodeCustomerCollection({
  preview,
  partyName,
  pending,
  onConfirm,
  onCancel,
}: {
  preview: WorkflowScanPreview;
  partyName?: string;
  pending: boolean;
  onConfirm: (input: {
    collectedAmount: string;
    shortfallReason?: ShortfallReason;
  }) => void;
  onCancel: () => void;
}) {
  const due = D(preview.money.codAmount);
  const [mode, setMode] = useState<"full" | "different">("full");
  const [amount, setAmount] = useState(due.toFixed(2));
  const [shortfallReason, setShortfallReason] = useState<ShortfallReason | "">(
    "",
  );
  const amountValid = /^(?:\d+|\d*\.\d{1,2})$/.test(amount.trim());
  const entered = amountValid ? D(amount) : D(0);
  const effective = mode === "full" ? due : entered;
  const shortfall = round2(due.minus(effective));
  const isShort = shortfall.gt(0);
  const isOver = effective.gt(due);
  const canConfirm =
    !pending &&
    (mode === "full" || amountValid) &&
    !isOver &&
    (!isShort || shortfallReason !== "");

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div>
        <p className="text-sm font-bold">تحصيل العميل</p>
        <p className="text-xs leading-5 text-muted-foreground">
          المسح عرّف الشحنة فقط. عند التأكيد ينتقل المقبوض إلى عهدة{" "}
          {partyName ?? "جهة التوصيل"}؛ توريد الجهة للدرج إجراء مستقل لاحقاً.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "full" ? "default" : "outline"}
          disabled={pending}
          onClick={() => {
            setMode("full");
            setAmount(due.toFixed(2));
            setShortfallReason("");
          }}
        >
          تحصيل المطلوب بالكامل
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "different" ? "secondary" : "outline"}
          disabled={pending}
          onClick={() => setMode("different")}
        >
          مبلغ مختلف
        </Button>
      </div>
      {mode === "different" && (
        <div className="space-y-2">
          <Label htmlFor="workflow-customer-collected-amount">
            المقبوض فعلياً من العميل
          </Label>
          <MoneyInput
            id="workflow-customer-collected-amount"
            ariaLabel="المبلغ المقبوض فعلياً من العميل"
            value={amount}
            onChange={setAmount}
          />
          {isOver && (
            <p className="text-xs font-medium text-destructive">
              المبلغ أكبر من المطالبة الحالية؛ سجّل الفائض من مساره المستقل.
            </p>
          )}
          {isShort && (
            <>
              <p className="text-xs font-medium text-[var(--sem-warn)]">
                العجز {fmt(shortfall.toFixed(2))} د.ع سيُقيّد على جهة التوصيل،
                لا على العميل.
              </p>
              <AppSelect
                aria-label="سبب عجز تحصيل العميل"
                value={shortfallReason}
                onValueChange={(value) =>
                  setShortfallReason(value as ShortfallReason | "")
                }
              >
                <option value="">— اختر سبب العجز (إلزامي) —</option>
                {SHORTFALL_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {SHORTFALL_REASON_LABEL_AR[reason]}
                  </option>
                ))}
              </AppSelect>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          تراجع
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canConfirm}
          onClick={() =>
            onConfirm({
              collectedAmount: effective.toFixed(2),
              ...(isShort && shortfallReason ? { shortfallReason } : {}),
            })
          }
        >
          {pending ? "جارٍ الإثبات…" : "إثبات التسليم وتحصيل العميل"}
        </Button>
      </div>
    </div>
  );
}

export interface ReceptionCollectSectionProps {
  branchId: number;
  shift: { id: number } | null;
  scannedBarcode?: string | null;
  onBarcodeConsumed?: () => void;
  onNavigateToDispatchBarcode?: (raw: string) => void;
  onNavigateToAftercare?: (context: {
    caseId?: number;
    executionId?: number;
    raw?: string;
  }) => void;
  onOpenCharge?: (chargeId: number) => void;
}

export function ReceptionCollectSection({
  branchId,
  shift,
  scannedBarcode,
  onBarcodeConsumed,
  onNavigateToDispatchBarcode,
  onNavigateToAftercare,
  onOpenCharge,
}: ReceptionCollectSectionProps) {
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [returnedCustodyOnly, setReturnedCustodyOnly] = useState(false);
  const [settleMode, setSettleMode] = useState<"courier" | "company">(
    "courier",
  );
  const [statementNumber, setStatementNumber] = useState("");
  const [statementDeductions, setStatementDeductions] = useState("");
  const [statementNotes, setStatementNotes] = useState("");
  const [selectedStatementLines, setSelectedStatementLines] = useState<
    Record<number, boolean>
  >({});
  const [statementAmounts, setStatementAmounts] = useState<
    Record<number, string>
  >({});
  const [statementQueueIds, setStatementQueueIds] = useState<number[]>([]);
  const [countedCash, setCountedCash] = useState("");
  const [collectBarcodeInput, setCollectBarcodeInput] = useState("");
  const [parcelFilter, setParcelFilter] = useState("");
  const [isSearchingCollect, setIsSearchingCollect] = useState(false);
  const remittanceRetry = useRef<FinancialRetry | null>(null);
  const statementRetry = useRef<FinancialRetry | null>(null);
  const me = trpc.auth.me.useQuery();
  const staffConfirmPrintContext = useRef<{ data: InvoicePaymentReceiptData; window: Window | null } | null>(null);
  const workflowConfirmPrintContext = useRef<{ data: InvoicePaymentReceiptData; window: Window | null } | null>(null);
  const remittancePrintContext = useRef<{
    partyName: string;
    branchId: number;
    shiftId: number;
    window: Window | null;
  } | null>(null);
  const [lastRemittance, setLastRemittance] =
    useState<SavedRemittancePrint | null>(null);
  const [printingRemittance, setPrintingRemittance] = useState(false);
  const [remittancePrintMessage, setRemittancePrintMessage] = useState("");
  const statementPrintContext = useRef<{
    branchId: number;
    window: Window | null;
    companyName: string;
    deductionsTotal: string;
    notes?: string;
    statementConsignmentCount: number;
  } | null>(null);
  const [lastCompanyStatement, setLastCompanyStatement] =
    useState<SavedCompanyStatementPrint | null>(null);
  const [printingCompanyStatement, setPrintingCompanyStatement] =
    useState(false);
  const [companyPrintMessage, setCompanyPrintMessage] = useState("");

  const [scanContext, setScanContext] = useState<{
    preview: WorkflowScanPreview;
    raw: string;
  } | null>(null);
  const [pendingCustomerCollection, setPendingCustomerCollection] = useState<{
    preview: WorkflowScanPreview;
    groupKey: string;
    partyName?: string;
  } | null>(null);
  const scanSequence = useRef(0);
  const acceptedGroups = useRef(new Set<string>());
  const confirmRetry = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    scanSequence.current++;
    acceptedGroups.current.clear();
    setScanContext(null);
    setPendingCustomerCollection(null);
    setReturnedCustodyOnly(false);
    return () => {
      scanSequence.current++;
    };
  }, [branchId, shift?.id]);
  const draftBusyRef = useRef(false);
  const switchCollectParty = useCallback(
    (
      nextPartyId: number | null,
      nextPartyType: "INDIVIDUAL" | "COMPANY" | null | undefined,
    ) => {
      if (draftBusyRef.current) return;
      const reset = companyStatementPartyTransition(
        selectedPartyId,
        nextPartyId,
        "",
      );
      if (reset) {
        acceptedGroups.current.clear();
        setSelectedPartyId(reset.partyId);
        setStatementNumber(reset.statementNumber);
        setStatementDeductions(reset.statementDeductions);
        setStatementNotes(reset.statementNotes);
        setSelectedStatementLines(reset.selections);
        setStatementAmounts(reset.amounts);
        setStatementQueueIds(reset.queueIds);
        setCountedCash(reset.countedCash);
      }
      setReturnedCustodyOnly(false);
      setSettleMode(nextPartyType === "COMPANY" ? "company" : "courier");
    },
    [selectedPartyId],
  );

  const utils = trpc.useUtils();
  const partiesQ = trpc.delivery.listParties.useQuery(
    { activeOnly: true },
    { staleTime: 60_000 },
  );
  const obligationsQ = trpc.delivery.obligations.useQuery(
    { branchId },
    { staleTime: 10_000, refetchInterval: false },
  );
  const selectedParty = (obligationsQ.data ?? []).find(
    (p: PartyObligation) => p.partyId === selectedPartyId,
  );
  const partyInfo = (partiesQ.data ?? []).find((p) => p.id === selectedPartyId);
  const isCompany = partyInfo?.partyType === "COMPANY";
  const allCollectParties = (partiesQ.data ?? []).filter(
    (party) => party.branchId == null || party.branchId === branchId,
  );
  const collectIndividualCouriers = allCollectParties.filter(
    (p) => p.partyType === "INDIVIDUAL",
  );
  const collectCompanyCouriers = allCollectParties.filter(
    (p) => p.partyType === "COMPANY",
  );
  const totalObligation = selectedParty
    ? Number(selectedParty.codDueTotal ?? 0)
    : 0;
  const inTransitAmount = selectedParty
    ? Number(selectedParty.parcelsInTransitAmount ?? 0)
    : 0;

  // الإرساليات المفتوحة للجهة المختارة — نحتاجها لبناء lines التوريد وتأكيد التسليم
  const openConsQ = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: selectedPartyId ?? 0, branchId, limit: 500 },
    {
      enabled: !!selectedPartyId,
      staleTime: 10_000,
      refetchInterval: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  useEffect(() => {
    if (
      openConsQ.hasNextPage &&
      !openConsQ.isFetchingNextPage &&
      !openConsQ.isError
    )
      void openConsQ.fetchNextPage();
  }, [
    openConsQ.hasNextPage,
    openConsQ.isFetchingNextPage,
    openConsQ.isError,
    openConsQ.fetchNextPage,
  ]);

  const openRows = (openConsQ.data?.pages ?? []).flatMap((page) => page.rows);
  const openConsStillLoading =
    openConsQ.isLoading ||
    openConsQ.hasNextPage ||
    openConsQ.isFetchingNextPage ||
    openConsQ.isError;
  const statementRows = openRows
    .filter((row) => row.sourceType !== "AFTERCARE_EXECUTION")
    .filter(
      (row) =>
        (row.parcelStatus === "DELIVERED" &&
          (row.moneyStatus === "UNSETTLED" || row.moneyStatus === "PARTIAL")) ||
        (row.status === "DISPATCHED" &&
          row.parcelStatus !== "CANCELLED" &&
          row.parcelStatus !== "RETURNED" &&
          (row.moneyStatus === "UNSETTLED" ||
            row.moneyStatus === "PARTIAL" ||
            row.moneyStatus === "NOT_APPLICABLE")),
    );
  const displayedStatementRows = filterOperationalRows(
    statementRows,
    parcelFilter,
  );
  const displayedOpenRows = filterOperationalRows(openRows, parcelFilter);

  const remittableRows = openRows.filter(
    (r) =>
      (r.parcelStatus === "DELIVERED" || r.physicalReturnReceived) &&
      (!returnedCustodyOnly || r.physicalReturnReceived) &&
      r.sourceType !== "AFTERCARE_EXECUTION",
  );
  const remittableTotal = remittableRows.reduce((sum, r) => {
    const due = r.physicalReturnReceived
      ? Number(r.cashInCourierCustody)
      : Math.max(
          0,
          Number(r.codAmount ?? 0) -
            Number(r.collectedAmount ?? 0) -
            Number(
              (r as { counterSettledAmount?: string | number })
                .counterSettledAmount ?? 0,
            ),
        );
    return sum + due;
  }, 0);

  // حسابات وضع كشف الشركة:
  const statementSelectedRows = statementRows.filter(
    (r) => selectedStatementLines[r.id],
  );
  const statementExpectedTotal = statementSelectedRows.reduce(
    (sum, row) =>
      sum.plus(statementQueueRemaining(row as CompanyStatementQueueCandidate)),
    D(0),
  );
  const statementSelectedCodTotal = statementSelectedRows.reduce(
    (sum, row) =>
      sum.plus(
        moneyInput(
          statementAmounts[row.id] ??
            statementQueueRemaining(
              row as CompanyStatementQueueCandidate,
            ).toFixed(2),
        ),
      ),
    D(0),
  );
  const statementDeductionsNum = moneyInput(statementDeductions);
  const statementNetRaw = statementSelectedCodTotal.minus(
    statementDeductionsNum,
  );
  const statementNetExpected = statementNetRaw.isNegative()
    ? D(0)
    : statementNetRaw;

  const staffConfirmMut = trpc.delivery.staffConfirm.useMutation({
    onSuccess: () => {
      const ctx = staffConfirmPrintContext.current;
      staffConfirmPrintContext.current = null;
      notify.ok(
        "تم إثبات تسليم الطرد للزبون",
        "أصبح المبلغ بعهدة المندوب وجاهزاً للتوريد للدرج.",
      );
      if (ctx) {
        void printInvoicePaymentReceipt(ctx.data, { into: ctx.window }).catch(() => {
          try { if (ctx.window && !ctx.window.closed) ctx.window.close(); } catch { /* noop */ }
        });
      }
      void obligationsQ.refetch();
      void openConsQ.refetch();
      void utils.delivery.invalidate();
    },
    onError: (e) => {
      const win = staffConfirmPrintContext.current?.window;
      staffConfirmPrintContext.current = null;
      try { if (win && !win.closed) win.close(); } catch { /* noop */ }
      notify.err(e, "تعذّر تأكيد التسليم");
    },
  });

  const workflowConfirmMut = trpc.delivery.workflow.confirmDelivery.useMutation(
    {
      onSuccess: () => {
        const ctx = workflowConfirmPrintContext.current;
        workflowConfirmPrintContext.current = null;
        notify.ok(
          "ثبت تسليم الشحنة ومطالبتها الحالية؛ توريد النقد إجراء مستقل",
        );
        if (ctx) {
          void printInvoicePaymentReceipt(ctx.data, { into: ctx.window }).catch(() => {
            try { if (ctx.window && !ctx.window.closed) ctx.window.close(); } catch { /* noop */ }
          });
        }
        void obligationsQ.refetch();
        void openConsQ.refetch();
      },
      onError: (error) => {
        const win = workflowConfirmPrintContext.current?.window;
        workflowConfirmPrintContext.current = null;
        try { if (win && !win.closed) win.close(); } catch { /* noop */ }
        acceptedGroups.current.clear();
        notify.err(error, "تعذر إثبات التسليم؛ أعد المحاولة بنفس المسح");
      },
    },
  );

  async function printSavedRemittance(
    saved: SavedRemittancePrint,
    into: Window | null,
    reprint: boolean,
  ) {
    setPrintingRemittance(true);
    setRemittancePrintMessage("");
    try {
      const result = await printRemittanceReceiptAsync(
        saved.partyName,
        {
          ...saved.receipt,
          ...(reprint
            ? {
                copy: {
                  kind: "REPRINT" as const,
                  reason: "إعادة طباعة سند التوريد المحفوظ",
                },
              }
            : {}),
        },
        { into },
      );
      if (!result.ok)
        throw new Error(
          "حُجبت نافذة الطباعة؛ اسمح بها ثم استخدم إعادة طباعة السند المحفوظ",
        );
      setRemittancePrintMessage(
        result.via === "browser"
          ? "فتحت معاينة السند المحفوظ للطباعة"
          : "أرسل السند المحفوظ إلى الطابعة",
      );
    } catch (error) {
      setRemittancePrintMessage(
        `التوريد مثبت؛ تعذرت الطباعة فقط. ${errMsg(error)}`,
      );
      notify.err(
        error,
        "التوريد مثبت؛ لا تعِد تسجيله. أعد طباعة السند المحفوظ",
      );
      try {
        if (into && !into.closed) into.close();
      } catch {
        /* Only the failed print window is released. */
      }
    } finally {
      setPrintingRemittance(false);
    }
  }

  const remitMut = trpc.delivery.recordRemittance.useMutation({
    onSuccess: (r) => {
      const context = remittancePrintContext.current;
      remittancePrintContext.current = null;
      const saved = {
        partyName: context?.partyName ?? selectedParty?.name ?? "جهة التوصيل",
        branchId: context?.branchId ?? branchId,
        receipt: {
          ...r,
          branchId: context?.branchId ?? branchId,
          shiftId: context?.shiftId ?? shift?.id,
        },
      };
      setLastRemittance(saved);
      notify.ok(
        "تم توريد نقد جهة التوصيل إلى الدرج — " + r.remittanceNumber,
        "صاف " + fmt(r.netRemitted) + " د.ع",
      );
      void printSavedRemittance(
        saved,
        context?.window ?? null,
        r.idempotentReplay,
      );
      setCountedCash("");
      remittanceRetry.current = null;
      void obligationsQ.refetch();
      void openConsQ.refetch();
      void utils.delivery.invalidate();
    },
    onError: (e) => {
      const window = remittancePrintContext.current?.window;
      remittancePrintContext.current = null;
      try {
        if (window && !window.closed) window.close();
      } catch {
        /* No print is sent on an unconfirmed transaction. */
      }
      notify.err(e, "تعذّر توريد جهة التوصيل");
    },
  });

  async function printSavedCompanyStatement(
    saved: SavedCompanyStatementPrint,
    into: Window | null,
    reprint: boolean,
  ) {
    setPrintingCompanyStatement(true);
    setCompanyPrintMessage("");
    try {
      const result = await printCompanyStatementReceiptAsync(
        {
          ...saved.receipt,
          ...(reprint
            ? {
                copy: {
                  kind: "REPRINT" as const,
                  reason: "إعادة طباعة كشف الشركة المحفوظ",
                },
              }
            : {}),
        },
        { into },
      );
      if (!result.ok)
        throw new Error(
          "حُجبت نافذة الطباعة؛ اسمح بها ثم أعد طباعة الكشف المحفوظ",
        );
      setCompanyPrintMessage(
        result.via === "browser"
          ? "فتحت معاينة الكشف المحفوظ للطباعة"
          : "أرسل الكشف المحفوظ إلى الطابعة",
      );
    } catch (error) {
      setCompanyPrintMessage(`الكشف مثبت؛ تعذرت الطباعة فقط. ${errMsg(error)}`);
      notify.err(
        error,
        "الكشف مثبت؛ أعد طباعة النسخة المحفوظة ولا تسجل كشفاً جديداً",
      );
      try {
        if (into && !into.closed) into.close();
      } catch {
        /* Release only the failed print preview. */
      }
    } finally {
      setPrintingCompanyStatement(false);
    }
  }

  const companyStatementMut = trpc.delivery.recordCompanyStatement.useMutation({
    onSuccess: (r) => {
      const context = statementPrintContext.current;
      statementPrintContext.current = null;
      const saved: SavedCompanyStatementPrint = {
        branchId: context?.branchId ?? branchId,
        receipt: {
          companyName:
            context?.companyName ??
            partyInfo?.name ??
            selectedParty?.name ??
            "شركة التوصيل",
          statementNumber: r.statementNumber,
          remittanceNumber: r.remittanceNumber,
          deliveriesConfirmed: r.deliveriesConfirmed,
          collectedTotal: r.collectedTotal,
          deductionsTotal: context?.deductionsTotal,
          netRemitted: r.netRemitted,
          statementConsignmentCount: context?.statementConsignmentCount,
          notes: context?.notes,
        },
      };
      setLastCompanyStatement(saved);
      notify.ok(
        `سُجِّل كشف الشركة ${r.statementNumber}`,
        r.remittanceNumber == null
          ? "كشف إثبات دون توريد نقدي"
          : `سند التوريد ${r.remittanceNumber} — صافٍ ${fmt(r.netRemitted)} د.ع`,
      );
      void printSavedCompanyStatement(
        saved,
        context?.window ?? null,
        r.idempotentReplay === true,
      );
      setStatementNumber("");
      setStatementDeductions("");
      setStatementNotes("");
      setCountedCash("");
      setSelectedStatementLines({});
      setStatementAmounts({});
      setStatementQueueIds([]);
      statementRetry.current = null;
      void obligationsQ.refetch();
      void openConsQ.refetch();
      void utils.delivery.invalidate();
    },
    onError: (e) => {
      const window = statementPrintContext.current?.window;
      statementPrintContext.current = null;
      try {
        if (window && !window.closed) window.close();
      } catch {
        /* Never print an unconfirmed statement. */
      }
      notify.err(e, "تعذّر تسجيل كشف شركة التوصيل");
    },
  });

  async function handleConfirmDelivery(row: (typeof openRows)[number]) {
    const generation = scanSequence.current;
    if (row.sourceType === "AFTERCARE_EXECUTION") {
      onNavigateToAftercare?.({
        executionId: row.aftercareExecutionId ?? undefined,
        raw: docBarcode("CN", row.consignmentNumber),
      });
      notify.info(
        "دفعة المعالجة بلا تحصيل من العميل؛ أثبت النتيجة وسوِّ أجرة الناقل من المعالجة",
      );
      return;
    }
    const remaining = Math.max(
      0,
      Number(row.codAmount ?? 0) -
        Number(row.collectedAmount ?? 0) -
        Number(
          (row as { counterSettledAmount?: string | number })
            .counterSettledAmount ?? 0,
        ),
    );
    const ok = await confirm({
      title: "تأكيد تسليم الطرد للزبون",
      description: [
        `الإرسالية: ${row.consignmentNumber}`,
        `المصدر: ${deliverySourceView(row).reference}`,
        row.customerName ? `الزبون: ${row.customerName}` : "",
        `المبلغ المطلوب: ${fmt(String(remaining))} د.ع`,
        "سيُسجَّل أن المندوب سلّم الطلب للزبون وقبض المبلغ.",
      ]
        .filter(Boolean)
        .join("\n"),
      confirmText: "تأكيد التسليم",
    });
    if (!ok || generation !== scanSequence.current) return;

    const rPhone = (row as { customerPhone?: string | null; recipientPhone?: string | null }).customerPhone
      ?? (row as { recipientPhone?: string | null }).recipientPhone ?? null;
    staffConfirmPrintContext.current = {
      data: {
        receiptNumber: row.consignmentNumber,
        invoiceNumber: deliverySourceView(row).reference || row.consignmentNumber,
        customerName: row.customerName ?? null,
        customerPhone: rPhone,
        invoiceTotal: row.codAmount ?? remaining.toFixed(2),
        amountPaid: remaining.toFixed(2),
        remainingAfter: "0.00",
        paymentMethod: "CASH",
        reference: `إثبات تسليم طرد ${row.consignmentNumber}${selectedParty?.name ? ` — ${selectedParty.name}` : ""}`,
        cashierName: me.data?.name ?? null,
      },
      window: preopenDocumentWindow("width=380,height=700"),
    };
    staffConfirmMut.mutate({
      consignmentId: row.id,
      collectedAmount: remaining.toFixed(2),
      evidence: "تأكيد موظف الاستقبال / عودة المندوب",
      clientRequestId: crypto.randomUUID(),
    });
  }

  async function handleCollect() {
    const generation = scanSequence.current;
    if (!selectedPartyId || !countedCash || !shift || remitMut.isPending)
      return;
    const amount = D(countedCash);
    if (amount.lte(0)) {
      notify.err("أدخل مبلغاً صحيحاً");
      return;
    }

    if (remittableRows.length === 0) {
      notify.err(
        "لا توجد طرود مسلّمة جاهزة للتوريد — تأكد من تأكيد تسليم الطرود أولاً",
      );
      return;
    }

    // بناء lines تلقائياً: توزيع المبلغ بالترتيب الزمني على الإرساليات المُسلّمة فقط (DELIVERED)
    let remaining = amount;
    const lines: { consignmentId: number; collectedAmount: string }[] = [];
    for (const row of remittableRows) {
      if (remaining.lte(0)) break;
      const due = D(
        String(
          row.physicalReturnReceived
            ? Number(row.cashInCourierCustody)
            : Math.max(
                0,
                Number(row.codAmount ?? 0) -
                  Number(row.collectedAmount ?? 0) -
                  Number(
                    (row as { counterSettledAmount?: string | number })
                      .counterSettledAmount ?? 0,
                  ),
              ),
        ),
      );
      if (due.lte(0)) continue;
      const take = round2(remaining.gte(due) ? due : remaining);
      lines.push({ consignmentId: row.id, collectedAmount: take.toFixed(2) });
      remaining = round2(remaining.minus(take));
    }

    if (lines.length === 0) {
      notify.err("لا مبالغ مستحقة للتوريد");
      return;
    }

    const ok = await confirm({
      title: "تأكيد توريد جهة التوصيل للدرج",
      description: [
        `الجهة: ${selectedParty?.name ?? ""}`,
        `المبلغ المستلَم: ${fmt(amount.toFixed(2))} د.ع`,
        `الذمة المسلّمة الجاهزة للتوريد: ${fmt(String(remittableTotal))} د.ع`,
        `عدد الإرساليات المُسوَّاة: ${lines.length}`,
        amount.lt(D(String(remittableTotal)))
          ? `تسوية جزئية — يبقى ${fmt(round2(D(String(remittableTotal)).minus(amount)).toFixed(2))} د.ع نقد بعهدة الجهة`
          : "تسوية كاملة للطرود المسلّمة — الأجرة معزولة تلقائياً",
      ].join("\n"),
      confirmText: "تسجيل توريد الجهة",
    });
    if (!ok || generation !== scanSequence.current) return;
    const payload = {
      partyId: selectedPartyId,
      branchId,
      targetShiftId: shift.id,
      lines,
      countedCash: amount.toFixed(2),
    };
    // Reserve after the explicit cash confirmation, before the network mutation.
    // A blocked popup is retained as null; the saved result always has a direct reprint button.
    remittancePrintContext.current = {
      partyName: selectedParty?.name ?? partyInfo?.name ?? "جهة التوصيل",
      branchId,
      shiftId: shift.id,
      window: preopenDocumentWindow("width=380,height=700"),
    };
    remitMut.mutate({
      ...payload,
      clientRequestId: financialRetryKey(remittanceRetry, payload),
    });
  }

  async function handleCompanyStatementCollect() {
    const generation = scanSequence.current;
    if (
      !selectedPartyId ||
      !shift ||
      openConsStillLoading ||
      companyStatementMut.isPending
    )
      return;
    if (!statementNumber.trim()) {
      notify.err("يرجى إدخال رقم كشف الشركة");
      return;
    }
    const lines = statementSelectedRows.map((row) => {
      const entered = round2(
        moneyInput(
          statementAmounts[row.id] ??
            statementQueueRemaining(
              row as CompanyStatementQueueCandidate,
            ).toFixed(2),
        ),
      );
      return {
        consignmentId: row.id,
        collectedAmount: entered.isNegative() ? "0.00" : entered.toFixed(2),
      };
    });
    if (lines.length === 0) {
      notify.err("يرجى تحديد طرد واحد على الأقل تم تسليمه في الكشف");
      return;
    }
    const cash = moneyInput(countedCash || statementNetExpected.toFixed(2));
    if (cash.lte(0) && statementNetExpected.gt(0)) {
      notify.err("أدخل المبلغ الصافي المستلم");
      return;
    }
    const ok = await confirm({
      title: "تأكيد تسوية كشف شركة التوصيل",
      description: [
        `الشركة: ${partyInfo?.name ?? ""}`,
        `رقم الكشف: ${statementNumber}`,
        `عدد الطرود المسلّمة بالكشف: ${lines.length}`,
        `المطلوب حسب النظام: ${fmt(statementExpectedTotal.toFixed(2))} د.ع`,
        `المثبت في كشف الشركة: ${fmt(statementSelectedCodTotal.toFixed(2))} د.ع`,
        statementDeductionsNum.gt(0)
          ? `استقطاعات أجور الشركة: - ${fmt(statementDeductionsNum.toFixed(2))} د.ع`
          : "",
        `صافي النقد المورّد للدرج: ${fmt(cash.toFixed(2))} د.ع`,
        statementRows.length - lines.length > 0
          ? `يبقى معلقاً بذمة الشركة: ${statementRows.length - lines.length} طرود`
          : "تسوية شاملة لكل الطرود",
      ]
        .filter(Boolean)
        .join("\n"),
      confirmText: "تأكيد كشف الجهة وتوريدها",
    });
    if (!ok || generation !== scanSequence.current) return;

    const payload = {
      partyId: selectedPartyId,
      branchId,
      shiftType: "RECEPTION" as const,
      targetShiftId: shift.id,
      statementNumber: statementNumber.trim(),
      statementDate: new Date().toISOString().slice(0, 10),
      deductionsTotal: statementDeductionsNum.gt(0)
        ? statementDeductionsNum.toFixed(2)
        : undefined,
      notes: statementNotes.trim() || undefined,
      lines,
      countedCash: cash.toFixed(2),
    };
    statementPrintContext.current = {
      branchId,
      companyName: partyInfo?.name ?? selectedParty?.name ?? "شركة التوصيل",
      deductionsTotal: payload.deductionsTotal ?? "0.00",
      notes: payload.notes,
      statementConsignmentCount: lines.length,
      window: preopenDocumentWindow("width=380,height=700"),
    };
    companyStatementMut.mutate({
      ...payload,
      clientRequestId: financialRetryKey(statementRetry, payload),
    });
  }

  draftBusyRef.current =
    companyStatementMut.isPending ||
    remitMut.isPending ||
    staffConfirmMut.isPending ||
    workflowConfirmMut.isPending;

  const handleCollectBarcode = useCallback(
    async (raw: string) => {
      if (draftBusyRef.current || !raw.trim()) return;
      const generation = ++scanSequence.current;
      setIsSearchingCollect(true);
      try {
        const preview = await utils.delivery.workflow.preview.fetch({
          raw,
          station: "collect",
          branchId,
        });
        if (generation !== scanSequence.current || draftBusyRef.current) return;
        setScanContext({ preview, raw });
        if (preview.relations.aftercareExecutionId != null) {
          notify.info(
            "دفعة معالجة بلا COD من العميل",
            "افتح المعالجة لإثبات التسليم أو تسوية أجرة الناقل، دون سند قبض عميل.",
          );
          onBarcodeConsumed?.();
          return;
        }
        if (
          preview.relations.chargeId != null &&
          preview.group?.leaderConsignmentId == null
        ) {
          onOpenCharge?.(preview.relations.chargeId);
          onBarcodeConsumed?.();
          return;
        }
        const leaderId =
          preview.group?.leaderConsignmentId ?? preview.relations.consignmentId;
        if (leaderId == null) {
          notify.info(
            "لا توجد إرسالية قائمة لهذا المصدر؛ افتحه في محطة الإرسال أو الأجور",
          );
          onBarcodeConsumed?.();
          return;
        }
        const timeline = await utils.delivery.consignmentTimeline.fetch({
          consignmentId: leaderId,
        });
        if (generation !== scanSequence.current || draftBusyRef.current) return;
        const partyId = timeline.consignment.partyId;
        const pInfo = (partiesQ.data ?? []).find((p) => p.id === partyId);
        const groupKey = preview.group?.key ?? `consignment:${leaderId}`;
        if (acceptedGroups.current.has(groupKey)) {
          notify.info(
            "هذه الشحنة محددة بالفعل؛ مسح أحد أعضائها لا يكرر الاختيار",
          );
          onBarcodeConsumed?.();
          return;
        }
        switchCollectParty(partyId, pInfo?.partyType);
        acceptedGroups.current.add(groupKey);
        const heldIds = new Set(
          preview.returnState?.members
            .filter((row) => row.received)
            .map((row) => row.consignmentId) ?? [],
        );
        const groupMembers = timeline.shipment.members.filter(
          (row) => row.operational || heldIds.has(row.id),
        );
        const returnedAmount = (preview.returnState?.members ?? [])
          .filter((row) => row.received)
          .reduce((sum, row) => sum.plus(row.cashInCourierCustody), D(0));
        const returnedCash = heldIds.size > 0 && returnedAmount.gt(0);
        if (returnedCash) {
          setSettleMode("courier");
          setReturnedCustodyOnly(true);
          setCountedCash(returnedAmount.toFixed(2));
          notify.ok(
            `الطرود مستلمة فعلياً — النقد المثبت بعهدة الناقل ${fmt(returnedAmount.toFixed(2))} د.ع؛ توريده لا يعيد قبض العميل`,
          );
        } else if (heldIds.size > 0) {
          setCountedCash("");
          notify.info(
            "الطرود مستلمة ولا تحمل نقداً مثبتاً بعهدة الناقل؛ راجع الأجرة أو المرتجع التجاري من المصدر دون قبض عميل جديد",
          );
        } else if (pInfo?.partyType === "COMPANY") {
          setSelectedStatementLines((current) => ({
            ...current,
            ...Object.fromEntries(groupMembers.map((row) => [row.id, true])),
          }));
          setStatementAmounts((current) => ({
            ...current,
            ...Object.fromEntries(
              groupMembers.map((row) => [
                row.id,
                statementQueueRemaining(row).toFixed(2),
              ]),
            ),
          }));
          setStatementQueueIds((current) =>
            Array.from(
              new Set([...current, ...groupMembers.map((row) => row.id)]),
            ),
          );
          notify.ok(
            `تم تحديد الشحنة ${timeline.shipment.consignmentNumber} مرة واحدة بكل مصادرها`,
          );
        } else if (
          groupMembers.some((row) => row.parcelStatus !== "DELIVERED")
        ) {
          setPendingCustomerCollection({
            preview,
            groupKey,
            partyName: pInfo?.name,
          });
          notify.info(
            "تمت قراءة الشحنة بلا أثر مالي",
            "راجع تحصيل العميل ثم اضغط التأكيد؛ توريد الجهة يبقى إجراءً مستقلاً.",
          );
        } else {
          setCountedCash(preview.money.cashInCourierCustody);
          notify.ok(
            `الشحنة مسلمة — النقد المثبت بعهدة الناقل ${fmt(preview.money.cashInCourierCustody)} د.ع`,
          );
        }
        setCollectBarcodeInput("");
        onBarcodeConsumed?.();
      } catch (error) {
        if (generation === scanSequence.current)
          notify.err(
            error,
            "تعذر قراءة المطالبة الحالية؛ احتفظ بالمسح وأعد المحاولة",
          );
      } finally {
        if (generation === scanSequence.current) setIsSearchingCollect(false);
      }
    },
    [
      utils,
      branchId,
      partiesQ.data,
      switchCollectParty,
      onOpenCharge,
      onBarcodeConsumed,
    ],
  );

  const handleSelectPredictiveParcel = useCallback(
    (item: PredictiveItem) =>
      handleCollectBarcode(docBarcode("CN", item.consignmentNumber)),
    [handleCollectBarcode],
  );
  const externalScan = useRef<string | null>(null);

  useEffect(() => {
    if (!scannedBarcode) {
      externalScan.current = null;
      return;
    }
    if (externalScan.current === scannedBarcode || draftBusyRef.current) return;
    externalScan.current = scannedBarcode;
    void handleCollectBarcode(scannedBarcode);
  }, [scannedBarcode, handleCollectBarcode]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {lastCompanyStatement?.branchId === branchId && (
        <Card className="p-3 space-y-2" role="status">
          <p className="font-medium">
            كشف مثبت: {lastCompanyStatement.receipt.statementNumber} —{" "}
            {lastCompanyStatement.receipt.companyName}
          </p>
          <p className="text-sm">
            {lastCompanyStatement.receipt.remittanceNumber == null
              ? "كشف إثبات دون توريد نقدي."
              : `صافي التوريد ${fmt(lastCompanyStatement.receipt.netRemitted)} د.ع.`}{" "}
            إعادة الطباعة لا تسجل كشفاً أو توريداً جديداً.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={printingCompanyStatement}
            onClick={() => {
              const into = preopenDocumentWindow("width=380,height=700");
              void printSavedCompanyStatement(lastCompanyStatement, into, true);
            }}
          >
            <Printer className="size-4 me-1" aria-hidden /> إعادة طباعة كشف
            الشركة المثبت
          </Button>
          {companyPrintMessage && (
            <p className="text-sm whitespace-pre-wrap">{companyPrintMessage}</p>
          )}
        </Card>
      )}
      {lastRemittance?.branchId === branchId && (
        <Card className="p-3 space-y-2" role="status">
          <p className="font-medium">
            توريد مثبت: {lastRemittance.receipt.remittanceNumber} —{" "}
            {lastRemittance.partyName}
          </p>
          <p className="text-sm">
            صافي التوريد {fmt(lastRemittance.receipt.netRemitted)} د.ع. إعادة
            الطباعة لا تسجل قبضاً أو توريداً جديداً.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={printingRemittance}
            onClick={() => {
              const into = preopenDocumentWindow("width=380,height=700");
              void printSavedRemittance(lastRemittance, into, true);
            }}
          >
            <Printer className="size-4 me-1" aria-hidden /> إعادة طباعة سند
            التوريد
          </Button>
          {remittancePrintMessage && (
            <p className="text-sm whitespace-pre-wrap">
              {remittancePrintMessage}
            </p>
          )}
        </Card>
      )}
      {/* ─── حقل البحث التنبؤي الذكي ومسح الباركود للتحصيل ─── */}
      <div className="rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ScanLine className="size-5 text-primary shrink-0" />
            <span className="text-sm font-extrabold text-primary">
              البحث ومسح الباركود لتحصيل العميل أو توريد الجهة
            </span>
          </div>
          <span className="text-xs text-muted-foreground font-mono bg-background/80 px-2 py-0.5 rounded border">
            F2 للتركيز
          </span>
        </div>
        <PredictiveConsignmentSearchInput
          disabled={companyStatementMut.isPending || remitMut.isPending}
          onSelect={handleSelectPredictiveParcel}
          onBarcodeEnter={(raw) => void handleCollectBarcode(raw)}
          partyId={selectedPartyId}
          localCandidates={openRows}
          placeholder="بحث برقم الهاتف، اسم الزبون، رقم الفاتورة أو الإرسالية…"
          className="w-full"
          inputClassName="h-11 text-sm bg-background shadow-xs font-bold"
        />
      </div>

      {scanContext && (
        <Card className="p-3 space-y-2">
          <strong dir="ltr">{scanContext.preview.printSource.number}</strong>
          <p className="text-sm">
            مطالبة العميل الحالية {fmt(scanContext.preview.money.codAmount)} د.ع
            · أمانة الأجرة {fmt(scanContext.preview.money.heldDeliveryFee)} د.ع
          </p>
          <WorkflowPrintActions
            branchId={scanContext.preview.source.branchId}
            preview={scanContext.preview}
            mode="collect"
          />
          {pendingCustomerCollection &&
            pendingCustomerCollection.preview.source.kind ===
              scanContext.preview.source.kind &&
            pendingCustomerCollection.preview.source.id ===
              scanContext.preview.source.id && (
              <BarcodeCustomerCollection
                key={`${pendingCustomerCollection.preview.source.kind}:${pendingCustomerCollection.preview.source.id}:${pendingCustomerCollection.preview.source.version}`}
                preview={pendingCustomerCollection.preview}
                partyName={pendingCustomerCollection.partyName}
                pending={workflowConfirmMut.isPending}
                onCancel={() => {
                  acceptedGroups.current.delete(
                    pendingCustomerCollection.groupKey,
                  );
                  setPendingCustomerCollection(null);
                }}
                onConfirm={({ collectedAmount, shortfallReason }) => {
                  const signature = JSON.stringify({
                    source: pendingCustomerCollection.preview.source,
                    collectedAmount,
                    shortfallReason: shortfallReason ?? null,
                  });
                  if (confirmRetry.current?.signature !== signature)
                    confirmRetry.current = {
                      signature,
                      key: crypto.randomUUID(),
                    };
                  const pvw = pendingCustomerCollection.preview;
                  const remAfter = round2(D(pvw.money.codAmount).minus(D(collectedAmount)));
                  workflowConfirmPrintContext.current = {
                    data: {
                      receiptNumber: pvw.summaries.parcel.shipmentNumber ?? pvw.printSource.number,
                      invoiceNumber: pvw.printSource.number,
                      customerName: pvw.recipient.name,
                      customerPhone: pvw.recipient.phone,
                      invoiceTotal: pvw.money.codAmount,
                      amountPaid: collectedAmount,
                      remainingAfter: remAfter.gt(0) ? remAfter.toFixed(2) : "0.00",
                      paymentMethod: "CASH",
                      reference: `إثبات تسليم وتحصيل COD${pendingCustomerCollection.partyName ? ` — ${pendingCustomerCollection.partyName}` : ""}${shortfallReason ? ` (${SHORTFALL_REASON_LABEL_AR[shortfallReason]})` : ""}`,
                      cashierName: me.data?.name ?? null,
                    },
                    window: preopenDocumentWindow("width=380,height=700"),
                  };
                  workflowConfirmMut.mutate(
                    {
                      source: {
                        kind: pendingCustomerCollection.preview.source.kind,
                        id: pendingCustomerCollection.preview.source.id,
                        expectedVersion:
                          pendingCustomerCollection.preview.source.version,
                      },
                      branchId:
                        pendingCustomerCollection.preview.source.branchId,
                      evidence:
                        "إثبات الموظف بعد مسح الشحنة واستلام إفادة التسليم الفعلي",
                      collectedAmount,
                      ...(shortfallReason ? { shortfallReason } : {}),
                      clientRequestId: confirmRetry.current.key,
                    },
                    {
                      onSuccess: () => {
                        setCountedCash(collectedAmount);
                        setPendingCustomerCollection(null);
                      },
                    },
                  );
                }}
              />
            )}
          {scanContext.preview.relations.aftercareExecutionId != null && (
            <>
              <p className="text-sm text-muted-foreground">
                هذه دفعة معالجة؛ لا يُنشأ عليها سند قبض عميل. تسليمها وأجرة
                الناقل يتابعان من حالة المعالجة.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  onNavigateToAftercare?.({
                    caseId: scanContext.preview.relations.aftercareCaseId,
                    executionId:
                      scanContext.preview.relations.aftercareExecutionId,
                    raw: scanContext.raw,
                  })
                }
              >
                فتح المعالجة وتسوية أجرة الناقل
              </Button>
            </>
          )}
          {scanContext.preview.relations.chargeId != null && (
            <Button
              variant="outline"
              onClick={() =>
                onOpenCharge?.(scanContext.preview.relations.chargeId!)
              }
            >
              فتح مستند الأجور ومقبوضاته
            </Button>
          )}
          {scanContext.preview.relations.consignmentId == null &&
            onNavigateToDispatchBarcode && (
              <Button
                variant="outline"
                onClick={() => onNavigateToDispatchBarcode(scanContext.raw)}
              >
                فتح الإرسال بنفس المصدر
              </Button>
            )}
        </Card>
      )}
      <Card className="gap-0 p-4">
        <h2 className="mb-3 font-extrabold flex items-center gap-2">
          <BarChart3 aria-hidden className="size-5" /> تحصيل العميل وتوريد جهات
          التوصيل
        </h2>
        <AppSelect
          disabled={companyStatementMut.isPending || remitMut.isPending}
          value={selectedPartyId ? String(selectedPartyId) : ""}
          onValueChange={(v) => {
            const nextId = v ? Number(v) : null;
            const info = (partiesQ.data ?? []).find((p) => p.id === nextId);
            switchCollectParty(nextId, info?.partyType);
          }}
          className="h-12 w-full text-base font-bold"
        >
          <option value="">— اختر المندوب أو شركة التوصيل —</option>
          {collectIndividualCouriers.length > 0 && (
            <optgroup label="── المناديب الداخليين (سائقون بعُهدة نقدية) ──">
              {collectIndividualCouriers.map((p) => {
                const bal = Number(
                  (obligationsQ.data ?? []).find(
                    (o: PartyObligation) => o.partyId === p.id,
                  )?.codDueTotal ?? 0,
                );
                return (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} (مندوب)
                    {bal > 0 ? ` — عهدة: ${fmt(String(bal))} د.ع` : ""}
                  </option>
                );
              })}
            </optgroup>
          )}
          {collectCompanyCouriers.length > 0 && (
            <optgroup label="── شركات ومكاتب التوصيل (مطابقة كشوفات دورية) ──">
              {collectCompanyCouriers.map((p) => {
                const bal = Number(
                  (obligationsQ.data ?? []).find(
                    (o: PartyObligation) => o.partyId === p.id,
                  )?.codDueTotal ?? 0,
                );
                return (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} (شركة)
                    {bal > 0 ? ` — رصيد معلق: ${fmt(String(bal))} د.ع` : ""}
                  </option>
                );
              })}
            </optgroup>
          )}
        </AppSelect>

        {selectedPartyId && isCompany && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-blue-700">
              <Building2 className="size-4 shrink-0" />
              <span>
                نظام شركة التوصيل: مطابقة كشف الطلبات واستقطاعات الأجور وتوريد
                الصافي
              </span>
            </div>
            <Badge
              variant="outline"
              className="border-blue-500 text-blue-700 font-bold shrink-0"
            >
              كشف شركة
            </Badge>
            {openRows.some(
              (row) =>
                row.physicalReturnReceived &&
                Number(row.cashInCourierCustody) > 0,
            ) && (
              <Button
                size="sm"
                variant="outline"
                disabled={draftBusyRef.current}
                onClick={() => {
                  setReturnedCustodyOnly(!returnedCustodyOnly);
                  setSettleMode(returnedCustodyOnly ? "company" : "courier");
                }}
              >
                {returnedCustodyOnly
                  ? "كشف الشركة"
                  : "توريد نقد الطرود المستلمة"}
              </Button>
            )}
          </div>
        )}
        {selectedPartyId && !isCompany && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--sem-pos)]">
              <User className="size-4 shrink-0" />
              <span>
                نظام المندوب الفردي: عهدة نقدية ميدانية وتوريد مباشر للدرج
                (الأجرة معزولة)
              </span>
            </div>
            <Badge
              variant="outline"
              className="border-[var(--sem-pos)] text-[var(--sem-pos)] font-bold shrink-0"
            >
              عهدة نقدية
            </Badge>
          </div>
        )}
      </Card>

      {selectedPartyId && (
        <Card className="gap-0 p-4 space-y-4">
          {openConsQ.isError && (
            <p role="alert" className="text-xs text-destructive">
              تعذر تحميل إرساليات الجهة كاملة. التحديد محفوظ والتسوية محجوبة.{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openConsQ.refetch()}
              >
                إعادة المحاولة
              </Button>
            </p>
          )}
          {obligationsQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">
              جارٍ تحميل الذمة…
            </div>
          ) : (
            <>
              {/* ملخص الذمة */}
              <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-bold">
                      إجمالي الذمة المسندة (COD)
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      مجموع قيمة الإرساليات غير المُسدَّدة — الأجرة معزولة
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-xl font-extrabold tabular-nums",
                      totalObligation > 0
                        ? "text-destructive"
                        : "text-[var(--sem-pos)]",
                    )}
                  >
                    {fmt(String(totalObligation))} د.ع
                  </span>
                </div>

                {totalObligation > 0 && (
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
                    <div className="rounded-lg border bg-background/60 p-2.5">
                      <div className="text-muted-foreground">
                        طرود في الطريق
                      </div>
                      <div className="text-base font-extrabold tabular-nums text-foreground mt-0.5">
                        {fmt(String(inTransitAmount))} د.ع
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        بعهدة الجهة للتسليم
                      </div>
                    </div>
                    <div className="rounded-lg border bg-background/60 p-2.5">
                      <div className="text-muted-foreground">
                        نقد جاهز للتوريد
                      </div>
                      <div className="text-base font-extrabold tabular-nums text-[var(--sem-pos)] mt-0.5">
                        {fmt(String(remittableTotal))} د.ع
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        سُلِّم للزبون بانتظار التوريد
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* ─── وضع كشف شركة التوصيل ─── */}
              {settleMode === "company" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4 text-primary" />
                      <span className="text-sm font-extrabold text-primary">
                        بيانات كشف شركة التوصيل
                      </span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-bold">
                          رقم الكشف المسلَّم من الشركة{" "}
                          <span className="text-destructive">*</span>
                        </label>
                        <Input
                          value={statementNumber}
                          disabled={companyStatementMut.isPending}
                          onChange={(e) => {
                            setStatementNumber(e.target.value);
                          }}
                          placeholder="مثال: STMT-2026-09"
                          className="h-10 bg-background font-mono font-bold"
                          dir="ltr"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-bold">
                          استقطاعات أجور الشركة (د.ع)
                        </label>
                        <MoneyInput
                          value={statementDeductions}
                          disabled={companyStatementMut.isPending}
                          onChange={setStatementDeductions}
                          placeholder="0"
                          className="h-10 bg-background"
                          ariaLabel="استقطاعات أجور الشركة"
                        />
                      </div>
                    </div>
                  </div>

                  <CompanyStatementScanQueue
                    candidates={
                      statementRows as CompanyStatementQueueCandidate[]
                    }
                    queuedIds={statementQueueIds}
                    collectedById={statementAmounts}
                    disabled={
                      statementNumber.trim().length < 2 ||
                      openConsStillLoading ||
                      companyStatementMut.isPending
                    }
                    onQueue={(candidate, collected) => {
                      setStatementQueueIds((ids) =>
                        ids.includes(candidate.id)
                          ? ids
                          : [...ids, candidate.id],
                      );
                      setSelectedStatementLines((current) => ({
                        ...current,
                        [candidate.id]: true,
                      }));
                      setStatementAmounts((current) => ({
                        ...current,
                        [candidate.id]: collected,
                      }));
                    }}
                    onRemove={(consignmentId) => {
                      setStatementQueueIds((ids) =>
                        ids.filter((id) => id !== consignmentId),
                      );
                      setSelectedStatementLines((current) => ({
                        ...current,
                        [consignmentId]: false,
                      }));
                      setStatementAmounts((current) => {
                        const next = { ...current };
                        delete next[consignmentId];
                        return next;
                      });
                    }}
                    onCollectedChange={(consignmentId, collected) => {
                      setStatementAmounts((current) => ({
                        ...current,
                        [consignmentId]: collected,
                      }));
                    }}
                  />

                  <CompanyStatementImport
                    key={selectedPartyId}
                    partyId={selectedPartyId}
                    candidates={
                      statementRows as CompanyStatementQueueCandidate[]
                    }
                    selectedIds={statementSelectedRows.map((row) => row.id)}
                    disabled={
                      statementNumber.trim().length < 2 ||
                      openConsStillLoading ||
                      companyStatementMut.isPending
                    }
                    onApply={(lines) => {
                      setSelectedStatementLines((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          lines.map((line) => [line.consignmentId, true]),
                        ),
                      }));
                      setStatementAmounts((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          lines.map((line) => [
                            line.consignmentId,
                            line.collectedAmount,
                          ]),
                        ),
                      }));
                      setStatementQueueIds((current) =>
                        Array.from(
                          new Set([
                            ...current,
                            ...lines.map((line) => line.consignmentId),
                          ]),
                        ),
                      );
                    }}
                  />

                  {/* قائمة الطرود مع إمكانية التحديد بالمطابقة */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-muted-foreground">
                        الطرود المفتوحة للشركة ({statementRows.length})
                      </h3>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 font-bold"
                          disabled={
                            openConsStillLoading ||
                            companyStatementMut.isPending ||
                            displayedStatementRows.length === 0
                          }
                          onClick={() => {
                            setSelectedStatementLines((current) =>
                              mergeDisplayedSelection(
                                current,
                                displayedStatementRows,
                                () => true,
                              ),
                            );
                            setStatementAmounts((current) =>
                              mergeDisplayedSelection(
                                current,
                                displayedStatementRows,
                                (id) =>
                                  current[id] ??
                                  statementQueueRemaining(
                                    statementRows.find(
                                      (row) => row.id === id,
                                    ) as CompanyStatementQueueCandidate,
                                  ).toFixed(2),
                              ),
                            );
                            setStatementQueueIds((current) =>
                              Array.from(
                                new Set([
                                  ...current,
                                  ...displayedStatementRows.map(
                                    (row) => row.id,
                                  ),
                                ]),
                              ),
                            );
                          }}
                        >
                          تحديد النتائج المعروضة (
                          {displayedStatementRows.length})
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 font-bold text-muted-foreground"
                          disabled={companyStatementMut.isPending}
                          onClick={() => {
                            const visible = new Set(
                              displayedStatementRows.map((row) => row.id),
                            );
                            setSelectedStatementLines((current) =>
                              mergeDisplayedSelection(
                                current,
                                displayedStatementRows,
                                () => false,
                              ),
                            );
                            setStatementQueueIds((current) =>
                              current.filter((id) => !visible.has(id)),
                            );
                          }}
                        >
                          إلغاء تحديد المعروض
                        </Button>
                      </div>
                    </div>

                    {statementRows.length > 0 && (
                      <div className="relative">
                        <UnifiedSearchInput
                          value={parcelFilter}
                          onChange={setParcelFilter}
                          placeholder="بحث برقم الهاتف، اسم الزبون، رقم الفاتورة أو الإرسالية…"
                          aria-label="تصفية طرود كشف الشركة"
                          className="ps-9 h-9 text-xs"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          المعروض: {displayedStatementRows.length} من{" "}
                          {statementRows.length} · التحديد خارج نتائج البحث
                          محفوظ ويشمله تأكيد الكشف.
                        </p>
                      </div>
                    )}

                    {statementRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد طرود مفتوحة لهذه الشركة
                      </div>
                    ) : displayedStatementRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد نتائج مطابقة للبحث &ldquo;{parcelFilter}&rdquo;
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {displayedStatementRows.map((row) => {
                          const cod = statementQueueRemaining(
                            row as CompanyStatementQueueCandidate,
                          );
                          const isSelected = !!selectedStatementLines[row.id];
                          const r = row as {
                            customerPhone?: string | null;
                            recipientPhone?: string | null;
                            address?: string | null;
                            deliveryAddress?: string | null;
                          };
                          const phone = r.customerPhone ?? r.recipientPhone;
                          const address = r.address ?? r.deliveryAddress;
                          return (
                            <div
                              key={row.id}
                              onClick={() => {
                                if (companyStatementMut.isPending) return;
                                if (isSelected) {
                                  setSelectedStatementLines((current) => ({
                                    ...current,
                                    [row.id]: false,
                                  }));
                                  setStatementQueueIds((ids) =>
                                    ids.filter((id) => id !== row.id),
                                  );
                                  return;
                                }
                                setSelectedStatementLines((current) => ({
                                  ...current,
                                  [row.id]: true,
                                }));
                                setStatementAmounts((current) => ({
                                  ...current,
                                  [row.id]: cod.toFixed(2),
                                }));
                                setStatementQueueIds((ids) =>
                                  ids.includes(row.id) ? ids : [...ids, row.id],
                                );
                              }}
                              className={cn(
                                "flex items-center justify-between gap-3 rounded-xl border p-3 cursor-pointer transition-colors shadow-xs",
                                isSelected
                                  ? "border-primary bg-primary/5"
                                  : "bg-background hover:bg-muted/20",
                              )}
                            >
                              <div className="flex items-center gap-3">
                                <div className="shrink-0 text-primary">
                                  {isSelected ? (
                                    <CheckSquare className="size-5" />
                                  ) : (
                                    <Square className="size-5 text-muted-foreground" />
                                  )}
                                </div>
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-extrabold text-sm">
                                      {deliverySourceView(row).reference}
                                    </span>
                                    <span className="text-xs text-muted-foreground font-mono">
                                      {row.consignmentNumber}
                                    </span>
                                    {row.externalTrackingRef && (
                                      <span
                                        className="text-xs font-bold text-primary font-mono"
                                        dir="ltr"
                                      >
                                        {row.externalTrackingRef}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                                    {row.customerName && (
                                      <span>
                                        الزبون:{" "}
                                        <strong className="text-foreground">
                                          {row.customerName}
                                        </strong>
                                      </span>
                                    )}
                                    {phone && (
                                      <span
                                        className="inline-flex items-center gap-1 font-mono"
                                        dir="ltr"
                                      >
                                        <Phone className="size-3 text-muted-foreground" />
                                        <span className="text-foreground font-semibold">
                                          {phone}
                                        </span>
                                      </span>
                                    )}
                                    {address && (
                                      <span className="inline-flex items-center gap-1">
                                        <MapPin className="size-3 text-muted-foreground shrink-0" />
                                        <span
                                          className="text-foreground truncate max-w-[200px]"
                                          title={address}
                                        >
                                          {address}
                                        </span>
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <div className="text-end">
                                <span className="text-xs text-muted-foreground block">
                                  المطلوب (COD)
                                </span>
                                <span className="font-extrabold text-sm tabular-nums text-foreground">
                                  {fmt(cod.toFixed(2))} د.ع
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* حسابات التوريد والتأكيد */}
                  {shift && statementSelectedRows.length > 0 && (
                    <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-4 space-y-3">
                      <p className="text-sm font-extrabold text-[var(--sem-pos)]">
                        مطابقة كشف الجهة وتوريد الصافي للدرج
                      </p>
                      <div className="grid grid-cols-3 gap-2 text-xs border-b border-[var(--sem-pos)]/20 pb-3">
                        <div>
                          <span className="text-muted-foreground block">
                            طرود الكشف المسلّمة
                          </span>
                          <span className="font-extrabold text-sm">
                            {statementSelectedRows.length} طرود
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">
                            مجموع الـ COD
                          </span>
                          <span className="font-extrabold text-sm">
                            {fmt(statementSelectedCodTotal.toFixed(2))} د.ع
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">
                            صافي النقد المتوقع
                          </span>
                          <span className="font-extrabold text-sm text-[var(--sem-pos)]">
                            {fmt(statementNetExpected.toFixed(2))} د.ع
                          </span>
                        </div>
                      </div>

                      {statementRows.length - statementSelectedRows.length >
                        0 && (
                        <p className="text-xs text-[var(--sem-warn)] font-bold">
                          يبقى معلقاً بذمة الشركة:{" "}
                          {statementRows.length - statementSelectedRows.length}{" "}
                          طرود (لم تُذكر بالكشف أو مؤجلة)
                        </p>
                      )}

                      <div className="flex gap-2 pt-1">
                        <MoneyInput
                          value={countedCash}
                          disabled={
                            companyStatementMut.isPending || remitMut.isPending
                          }
                          onChange={setCountedCash}
                          placeholder={
                            "المبلغ الصافي المستلم (المتوقع: " +
                            fmt(statementNetExpected.toFixed(2)) +
                            ")"
                          }
                          className="flex-1 h-11 text-base font-bold bg-background"
                          ariaLabel="المبلغ الصافي المستلم"
                        />
                        <Button
                          className="bg-[var(--sem-pos)] hover:bg-[var(--sem-pos)]/90 text-background px-6 font-bold"
                          disabled={
                            companyStatementMut.isPending ||
                            !statementNumber.trim()
                          }
                          onClick={() => void handleCompanyStatementCollect()}
                        >
                          {companyStatementMut.isPending
                            ? "جارٍ التوريد…"
                            : "تسوية الكشف وتوريد النقد"}
                        </Button>
                      </div>
                      <p className="text-[11px] leading-5 text-muted-foreground">
                        هذا المسار نقدي إلى درج الوردية فقط. إذا كان السداد
                        تحويلاً بنكياً فلا تسجله كنقد؛ أوقف العملية وسلّم مرجع
                        التحويل للمحاسب لإثباته قبل التسوية.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                /* ─── وضع تسوية المندوب الفردي التقليدي ─── */
                <>
                  <div className="space-y-2">
                    <h3 className="text-xs font-bold text-muted-foreground flex items-center justify-between">
                      <span>
                        الطرود والإرساليات المسندة ({openRows.length})
                      </span>
                      {inTransitAmount > 0 && (
                        <span className="font-normal text-[var(--sem-warn)]">
                          {
                            openRows.filter(
                              (r) => r.parcelStatus !== "DELIVERED",
                            ).length
                          }{" "}
                          طرود في الطريق
                        </span>
                      )}
                    </h3>

                    {openRows.length > 0 && (
                      <div className="relative">
                        <UnifiedSearchInput
                          value={parcelFilter}
                          onChange={setParcelFilter}
                          placeholder="بحث برقم الهاتف، اسم الزبون، رقم الفاتورة أو الإرسالية…"
                          aria-label="تصفية الطرود المفتوحة"
                          className="ps-9 h-9 text-xs"
                        />
                      </div>
                    )}

                    {openConsQ.isLoading ? (
                      <div className="py-4 text-center text-xs text-muted-foreground">
                        جارٍ تحميل الطرود…
                      </div>
                    ) : openRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد طرود مفتوحة
                      </div>
                    ) : displayedOpenRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        لا توجد نتائج مطابقة للبحث &ldquo;{parcelFilter}&rdquo;
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {displayedOpenRows.map((row) => {
                          const cod = Number(row.codAmount ?? 0);
                          const isDelivered = row.parcelStatus === "DELIVERED";
                          const isInTransit = !isDelivered;
                          const r = row as {
                            customerPhone?: string | null;
                            recipientPhone?: string | null;
                            address?: string | null;
                            deliveryAddress?: string | null;
                          };
                          const phone = r.customerPhone ?? r.recipientPhone;
                          const address = r.address ?? r.deliveryAddress;
                          return (
                            <div
                              key={row.id}
                              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border bg-background p-3 shadow-xs"
                            >
                              <div className="min-w-0 space-y-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-extrabold text-sm">
                                    {deliverySourceView(row).reference}
                                  </span>
                                  <span className="text-xs text-muted-foreground font-mono">
                                    {row.consignmentNumber}
                                  </span>
                                  {isInTransit && (
                                    <Badge
                                      variant="secondary"
                                      className="text-[11px] font-bold"
                                    >
                                      في الطريق
                                    </Badge>
                                  )}
                                  {isDelivered && (
                                    <Badge className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-transparent text-[11px] font-bold">
                                      سلم — جاهز للتوريد
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                                  {row.customerName && (
                                    <span>
                                      الزبون:{" "}
                                      <strong className="text-foreground">
                                        {row.customerName}
                                      </strong>
                                    </span>
                                  )}
                                  {phone && (
                                    <span
                                      className="inline-flex items-center gap-1 font-mono"
                                      dir="ltr"
                                    >
                                      <Phone className="size-3 text-muted-foreground" />
                                      <span className="text-foreground font-semibold">
                                        {phone}
                                      </span>
                                    </span>
                                  )}
                                  {address && (
                                    <span className="inline-flex items-center gap-1">
                                      <MapPin className="size-3 text-muted-foreground shrink-0" />
                                      <span
                                        className="text-foreground truncate max-w-[220px]"
                                        title={address}
                                      >
                                        {address}
                                      </span>
                                    </span>
                                  )}
                                  <span>
                                    المطلوب (COD):{" "}
                                    <strong className="text-foreground tabular-nums">
                                      {fmt(String(cod))} د.ع
                                    </strong>
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                                {isInTransit && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="font-bold text-xs h-8"
                                    disabled={staffConfirmMut.isPending}
                                    onClick={() =>
                                      void handleConfirmDelivery(row)
                                    }
                                  >
                                    <CheckCircle2
                                      aria-hidden
                                      className="size-3.5 ms-1 text-[var(--sem-pos)]"
                                    />
                                    تأكيد التسليم
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* قسم القبض والتوريد للدرج للمندوب */}
                  {shift && remittableTotal > 0 && (
                    <div className="rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/20 p-4 space-y-3">
                      <p className="text-sm font-extrabold text-[var(--sem-pos)]">
                        توريد جهة التوصيل للدرج
                      </p>
                      <p className="text-xs text-muted-foreground">
                        نقل النقد الذي سبق تحصيله من العملاء من عهدة الجهة إلى
                        الوردية الحالية — الأجرة معزولة
                      </p>
                      <div className="flex gap-2">
                        <MoneyInput
                          value={countedCash}
                          disabled={
                            companyStatementMut.isPending || remitMut.isPending
                          }
                          onChange={setCountedCash}
                          placeholder={
                            "المبلغ المستلَم (الكامل: " +
                            fmt(String(remittableTotal)) +
                            ")"
                          }
                          className="flex-1 h-11 text-base font-bold bg-background"
                          ariaLabel="المبلغ المستلَم"
                        />
                        <Button
                          className="bg-[var(--sem-pos)] hover:bg-[var(--sem-pos)]/90 text-background px-6 font-bold"
                          disabled={!countedCash || remitMut.isPending}
                          onClick={() => void handleCollect()}
                        >
                          {remitMut.isPending ? "…" : "تسجيل التوريد"}
                        </Button>
                      </div>
                      <p className="text-[11px] leading-5 text-muted-foreground">
                        هذا المسار نقدي إلى درج الوردية فقط. إذا كان السداد
                        تحويلاً بنكياً فلا تسجله كنقد؛ أوقف العملية وسلّم مرجع
                        التحويل للمحاسب لإثباته قبل التسوية.
                      </p>
                      {countedCash &&
                        D(String(remittableTotal)).gt(0) &&
                        D(countedCash).lt(D(String(remittableTotal))) && (
                          <p className="text-xs text-[var(--sem-warn)] font-bold">
                            تسوية جزئية — يبقى{" "}
                            {fmt(
                              round2(
                                D(String(remittableTotal)).minus(
                                  D(countedCash),
                                ),
                              ).toFixed(2),
                            )}{" "}
                            د.ع بعهدة الجهة
                          </p>
                        )}
                    </div>
                  )}

                  {shift && remittableTotal === 0 && totalObligation > 0 && (
                    <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
                      <div className="flex items-center gap-2 font-bold text-xs text-foreground">
                        <Clock
                          aria-hidden
                          className="size-4 text-muted-foreground"
                        />
                        <span>الطرود لا تزال في الطريق مع المندوب</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        إجمالي مبالغ الطرود ({fmt(String(totalObligation))} د.ع)
                        لا تزال بعهدة المندوب في الميدان. عند عودة المندوب
                        وتسليم الطلب، اضغط <strong>«تأكيد التسليم»</strong> على
                        الطرد أعلاه، وسيظهر زر القبض والتوريد للدرج فوراً مع
                        طباعة الإيصال.
                      </p>
                    </div>
                  )}
                </>
              )}

              {totalObligation === 0 && (
                <div className="rounded-xl border bg-[var(--sem-pos-bg)]/20 p-4 text-center text-[var(--sem-pos)] font-bold">
                  لا ذمة على هذه الجهة
                </div>
              )}

              {!shift && (
                <p className="text-sm text-destructive text-center">
                  افتح وردية استقبال لتسجيل التحصيل
                </p>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
