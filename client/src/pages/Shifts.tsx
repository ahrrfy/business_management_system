import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ShiftCloseDialog } from "@/components/shifts/ShiftCloseDialog";
import { ShiftFundingDialog } from "@/components/shifts/ShiftFundingDialog";
import { ShiftFundingDecisionDialogs } from "@/components/shifts/ShiftFundingDecisionDialogs";
import { ShiftInvoicesDialog } from "@/components/shifts/ShiftInvoicesDialog";
import {
  adaptShiftCashReconciliation,
} from "@/components/financial";
import { useClipboard } from "@/hooks/useClipboard";
import { formatZReportAsText } from "@/lib/copy/formatters";
import { fmtDateTime } from "@/lib/date";
import { D, fmt, formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printShiftClose } from "@/lib/printing/print";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import {
  Check,
  CircleDollarSign,
  Copy,
  Lock,
  Printer,
  Receipt,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ACTION_LABELS } from "@shared/actionLabels";

/* ═══════════ سجلّ الورديات + إعادة طباعة Z-report ═══════════
   يستهلك shifts.list (branch-scoped): ورديات الكاشير مع فُتحت/أُغلقت/المتوقع/المعدود/الفرق.
   فلاتر فرع/حالة + ترقيم خادمي + تصدير Excel + زر إعادة طباعة تقرير الوردية (Z) عبر printShiftClose.
═══════════════════════════════════════════════════════════ */

const PAGE = 50;
const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "مفتوحة",
  CLOSED: "مغلقة",
};
const STATUS_CLS: Record<string, string> = {
  OPEN: "badge-status-pending",
  CLOSED: "badge-status-active",
};
const SHIFT_TYPE_LABEL: Record<string, string> = {
  RETAIL: "تجزئة",
  RECEPTION: "خدمة العملاء",
  PRINT_SERVICES: "خدمات طباعة",
};

const fmtDT = (d: string | number | Date | null | undefined) => fmtDateTime(d);

// نوع الصفّ صريحاً (الإجراء يُعيد {rows,total}) — حسمٌ يُجنّب فشل استدلال T في fetchAllPaged.
type Row = RouterOutputs["shifts"]["list"]["rows"][number];
/** صفُّ فواتير الوردية — مشتقٌّ من عقد `sales.list` فلا ينجرف عن الخادم. */
type ShiftInvoiceRow = RouterOutputs["sales"]["list"][number];

export default function Shifts() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const [branchId, setBranchId] = useState<number | "">("");
  const [status, setStatus] = useState<"" | "OPEN" | "CLOSED">("");
  const [shiftType, setShiftType] = useState<
    "" | "RETAIL" | "RECEPTION" | "PRINT_SERVICES"
  >("");
  const [varianceState, setVarianceState] = useState<
    "" | "WITH_VARIANCE" | "MATCHED" | "UNRECONCILED"
  >("");
  // فلتر الفترة خادمي (openedAt) — أسماء dateFrom/dateTo لتفادي تصادم from/to الترقيم أدناه.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);
  const [printing, setPrinting] = useState<number | null>(null);
  const [copying, setCopying] = useState<number | null>(null);
  const [closingShiftId, setClosingShiftId] = useState<number | null>(null);
  const [closeCounted, setCloseCounted] = useState("");
  const [legacyEvidenceNote, setLegacyEvidenceNote] = useState("");
  const [legacySourceReceiptId, setLegacySourceReceiptId] = useState("");
  const [legacyConfirmedZero, setLegacyConfirmedZero] = useState(false);
  const [legacyClientRequestId, setLegacyClientRequestId] = useState("");
  const [fundingShiftId, setFundingShiftId] = useState<number | null>(null);
  const [fundingAmount, setFundingAmount] = useState("");
  const [fundingNote, setFundingNote] = useState("");
  const [fundingSourceReceiptId, setFundingSourceReceiptId] = useState("");
  const [fundingClientRequestId, setFundingClientRequestId] = useState("");
  const [fundingSourceCursor, setFundingSourceCursor] = useState<number | null>(null);
  const [fundingSourceCursorHistory, setFundingSourceCursorHistory] = useState<Array<number | null>>([]);
  const [rejectFundingId, setRejectFundingId] = useState<number | null>(null);
  const [fundingRejectionReason, setFundingRejectionReason] = useState("");
  const [cancelFundingId, setCancelFundingId] = useState<number | null>(null);
  const [fundingCancellationReason, setFundingCancellationReason] = useState("");
  // فواتير الوردية — لتحقيق فروقات النقد (فتح قائمة مضمَّنة بدل الانتقال لشاشة مبيعات منفصلة).
  const [invoicesShiftId, setInvoicesShiftId] = useState<number | null>(null);
  const { copy } = useClipboard({ successMessage: "نُسِخ تقرير Z" });

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  // إدارة أي وردية مفتوحة عن بُعد (كاشير نسي إغلاقها) — بنفس صلاحيات closeShift الخادمية
  // (admin أي فرع، manager فرعه فقط)؛ الكاشير لا يرى الزرّ أصلاً (والخادم يرفضه لو حاول).
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  const branches = trpc.branches.list.useQuery();
  const list = trpc.shifts.list.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    status: status || undefined,
    shiftType: shiftType || undefined,
    varianceState: varianceState || undefined,
    q: debouncedQuery || undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    limit: PAGE,
    offset: page * PAGE,
  });
  const fundingRequestsQ = trpc.shifts.fundingRequests.useQuery();

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  const branchName = useMemo(() => {
    const m = new Map((branches.data ?? []).map((b) => [Number(b.id), b.name]));
    return (id: number | null | undefined) =>
      id != null ? (m.get(Number(id)) ?? `#${id}`) : "—";
  }, [branches.data]);

  const setFilter = <T,>(fn: (v: T) => void, v: T) => {
    fn(v);
    setPage(0);
  };

  // الفرق: موجب = فائض (أخضر)، سالب = عجز (أحمر)، صفر/غير محسوب = محايد.
  const varianceCls = (v: string | null) => {
    if (v == null) return "text-muted-foreground";
    const d = D(v);
    if (d.gt(0)) return "text-money-positive";
    if (d.lt(0)) return "text-money-negative";
    return "text-foreground";
  };

  // فواتير الوردية — قائمة مضمَّنة (بدل التنقّل لشاشة المبيعات) لتحقيق فروقات النقد سطراً بسطر.
  const invoicesShiftQ = trpc.sales.list.useQuery(
    { shiftId: invoicesShiftId ?? 0, limit: 200 },
    { enabled: invoicesShiftId != null },
  );
  const invoicesShiftRow = rows.find((r) => r.id === invoicesShiftId) ?? null;

  // إغلاق وردية عن بُعد (نسيها كاشيرها مفتوحة) — نفس منطق نوافذ POS/الاستقبال/الطباعة:
  // المتوقع = الافتتاحي + نقد وارد − نقد صادر، ولا يُقبل إغلاقٌ بفرق (نفس حوكمة closeShift الخادمية).
  const closingRow = rows.find((r) => r.id === closingShiftId) ?? null;
  const closeReportQ = trpc.shifts.report.useQuery(
    { shiftId: closingShiftId ?? 0 },
    { enabled: closingShiftId != null },
  );
  const closeExpected = closeReportQ.data
    ? D(closeReportQ.data.expectedCash)
    : null;
  const closeDiff =
    closeExpected != null && closeCounted
      ? D(closeCounted).minus(closeExpected)
      : null;
  const closeHasVariance = closeDiff != null && closeDiff.abs().gt("0.005");
  const isLegacyNegative = closeExpected?.lt(0) ?? false;
  const isOwner = me.data?.isOwner === true;
  const fundingSourcesQ = trpc.shifts.fundingSources.useQuery(
    {
      targetShiftId: fundingShiftId ?? 0,
      cursorReceiptId: fundingSourceCursor,
    },
    { enabled: isOwner && fundingShiftId != null },
  );
  const fundingOutgoingQ = trpc.shifts.fundingOutgoing.useQuery(undefined, {
    enabled: isOwner,
  });
  const closeReconciliation = adaptShiftCashReconciliation(closeReportQ.data, {
    countedCash: closeCounted || null,
    variance: closeDiff?.toFixed(2) ?? null,
    isMatched: closeDiff == null ? null : !closeHasVariance,
  });

  const closeShiftM = trpc.shifts.close.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        "legacyNegativeRemediation" in result
          ? "مُوّلت الوردية من الخزنة بالقيمة الدقيقة، وصُفّرت وأُغلقت"
          : result.treasuryReturn
            ? `أُغلقت الوردية ورُحّل ${formatIqd(result.countedCash)} إلى الخزينة تلقائياً`
            : "أُغلقت الوردية",
        result.treasuryReturn ? `سند الترحيل ${result.treasuryReturn.handoverNumber}` : undefined,
      );
      setClosingShiftId(null);
      setCloseCounted("");
      setLegacyEvidenceNote("");
      setLegacySourceReceiptId("");
      setLegacyConfirmedZero(false);
      setLegacyClientRequestId("");
      await utils.shifts.list.invalidate();
    },
    onError: (e) => notify.errBig(e),
  });

  const fundingRow = rows.find((r) => r.id === fundingShiftId) ?? null;
  const fundingSources = fundingSourcesQ.data?.items ?? [];
  const fundingReportQ = trpc.shifts.report.useQuery(
    { shiftId: fundingShiftId ?? 0 },
    { enabled: fundingShiftId != null },
  );
  const fundingExpected = fundingReportQ.data
    ? D(fundingReportQ.data.expectedCash)
    : null;
  const requestFundingM = trpc.shifts.requestFunding.useMutation({
    onSuccess: async () => {
      notify.ok("أُنشئ طلب العهدة؛ لن تتحرك الخزنة حتى يؤكد صاحب الوردية الاستلام");
      setFundingShiftId(null);
      setFundingAmount("");
      setFundingNote("");
      setFundingSourceReceiptId("");
      setFundingClientRequestId("");
      setFundingSourceCursor(null);
      setFundingSourceCursorHistory([]);
      await Promise.all([
        fundingRequestsQ.refetch(),
        utils.shifts.fundingSources.invalidate(),
        fundingOutgoingQ.refetch(),
      ]);
    },
    onError: (error) => notify.errBig(error),
  });
  const respondFundingM = trpc.shifts.respondFunding.useMutation({
    onSuccess: async (result) => {
      notify.ok(
        result.status === "COMPLETED"
          ? `ثُبّت استلام ${fmt(result.amount)} د.ع في الوردية #${result.shiftId}`
          : "رُفض طلب العهدة بلا أي أثر نقدي",
      );
      setRejectFundingId(null);
      setFundingRejectionReason("");
      await Promise.all([
        fundingRequestsQ.refetch(),
        utils.shifts.list.invalidate(),
      ]);
    },
    onError: (error) => notify.errBig(error),
  });
  const cancelFundingM = trpc.shifts.cancelFunding.useMutation({
    onSuccess: async () => {
      notify.ok("أُلغي طلب العهدة بلا أثر نقدي وأصبح سحب المصدر متاحاً من جديد");
      setCancelFundingId(null);
      setFundingCancellationReason("");
      await Promise.all([
        fundingOutgoingQ.refetch(),
        utils.shifts.fundingSources.invalidate(),
        fundingRequestsQ.refetch(),
      ]);
    },
    onError: (error) => notify.errBig(error),
  });

  function openFundingDialog(shiftId: number) {
    setFundingAmount("");
    setFundingNote("");
    setFundingSourceReceiptId("");
    setFundingSourceCursor(null);
    setFundingSourceCursorHistory([]);
    setFundingClientRequestId(
      globalThis.crypto?.randomUUID?.() ??
        `shift-funding-${shiftId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    setFundingShiftId(shiftId);
  }

  function openCloseDialog(shiftId: number) {
    setCloseCounted("");
    setLegacyEvidenceNote("");
    setLegacySourceReceiptId("");
    setLegacyConfirmedZero(false);
    setLegacyClientRequestId(
      globalThis.crypto?.randomUUID?.() ??
        `legacy-${shiftId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    setClosingShiftId(shiftId);
  }

  async function reprintZ(shiftId: number) {
    setPrinting(shiftId);
    try {
      const rep = await utils.shifts.report.fetch({ shiftId });
      if (!rep) {
        notify.err("تعذّر جلب تقرير الوردية");
        return;
      }
      const sh = rep.shift as {
        openingBalance: string;
        expectedCash: string | null;
        countedCash: string | null;
        variance: string | null;
        status: string;
        openedAt: string | Date;
        closedAt: string | Date | null;
      };
      const open = sh.status === "OPEN";
      // اسم الكاشير واسم الفرع من صف الوردية المعروض
      const row = rows.find((r) => r.id === shiftId);
      const cashierName = row?.userName ?? `#${shiftId}`;
      const bName = branchName(row?.branchId);

      const payments = (rep.payments ?? []).map((p) => ({
        method: p.method,
        direction: p.direction as "IN" | "OUT",
        count: Number(p.count),
        total: p.total,
      }));

      if (open) {
        // وردية مفتوحة: تقرير مبدئي بالتصميم الجديد (النقد المتوقع = الرصيد الافتتاحي مبدئياً)
        await printShiftClose({
          shiftId,
          openedAt: sh.openedAt,
          closedAt: new Date(),
          cashierName,
          branchName: bName,
          openingBalance: sh.openingBalance,
          invoiceCount: rep.invoiceCount,
          salesTotal: rep.salesTotal,
          payments,
          expectedCash: sh.expectedCash ?? sh.openingBalance,
          countedCash: sh.countedCash ?? "0",
          variance: sh.variance ?? "0",
        });
      } else {
        // وردية مغلقة: Z-Report نهائي
        await printShiftClose({
          shiftId,
          openedAt: sh.openedAt,
          closedAt: sh.closedAt ? new Date(sh.closedAt) : new Date(),
          cashierName,
          branchName: bName,
          openingBalance: sh.openingBalance,
          invoiceCount: rep.invoiceCount,
          salesTotal: rep.salesTotal,
          payments,
          expectedCash: sh.expectedCash ?? "0",
          countedCash: sh.countedCash ?? "0",
          variance: sh.variance ?? "0",
        });
      }
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(null);
    }
  }

  // نَسخ مُلَخَّص Z نَصّياً (للَصق في واتساب/مُلاحَظة الإدارة) — يَجلب نَفس تَقرير الطباعة ويُمَرِّرُه إلى formatZReportAsText.
  async function copyZ(shiftId: number) {
    setCopying(shiftId);
    try {
      const rep = await utils.shifts.report.fetch({ shiftId });
      if (!rep) {
        notify.err("تعذّر جلب تقرير الوردية");
        return;
      }
      const sh = rep.shift as {
        openingBalance: string;
        expectedCash: string | null;
        countedCash: string | null;
        variance: string | null;
        openedAt: string | Date;
        closedAt: string | Date | null;
      };
      // النَقد الداخل/الخارج = مَجموع الحَركات النَقدِية (CASH) حَسَب الاتجاه.
      let cashIn = D(0);
      let cashOut = D(0);
      for (const p of rep.payments ?? []) {
        if (p.method !== "CASH") continue;
        if (p.direction === "IN") cashIn = cashIn.plus(D(p.total));
        else if (p.direction === "OUT") cashOut = cashOut.plus(D(p.total));
      }
      const text = formatZReportAsText({
        shiftId,
        opened: sh.openedAt,
        closed: sh.closedAt ?? undefined,
        openingFloat: sh.openingBalance,
        cashIn: cashIn.toFixed(2),
        cashOut: cashOut.toFixed(2),
        expectedCash: sh.expectedCash ?? sh.openingBalance,
        countedCash: sh.countedCash,
        variance: sh.variance,
      });
      await copy(text);
    } catch (e) {
      notify.err(e);
    } finally {
      setCopying(null);
    }
  }

  const activeFilterCount = [
    branchId,
    status,
    shiftType,
    varianceState,
    dateFrom,
    dateTo,
  ].filter((value) => value !== "").length;
  const anyFilter = query.trim() !== "" || activeFilterCount > 0;

  function resetFilters() {
    setQuery("");
    setBranchId("");
    setStatus("");
    setShiftType("");
    setVarianceState("");
    setDateFrom("");
    setDateTo("");
    setPage(0);
  }

  function printVisibleShifts() {
    const filterLabels = [
      query.trim() ? `بحث: ${query.trim()}` : null,
      status ? `الحالة: ${STATUS_LABEL[status]}` : null,
      shiftType ? `النوع: ${SHIFT_TYPE_LABEL[shiftType]}` : null,
      varianceState === "WITH_VARIANCE"
        ? "المطابقة: بفرق نقدي"
        : varianceState === "MATCHED"
          ? "المطابقة: مطابقة"
          : varianceState === "UNRECONCILED"
            ? "المطابقة: غير محسوبة"
            : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const opened = printReportDoc({
      title: "سجلّ الورديات",
      headerExtra: [
        {
          label: "الفرع",
          value: branchId ? branchName(Number(branchId)) : "كل الفروع",
        },
        {
          label: "الفترة",
          value:
            dateFrom || dateTo
              ? `${dateFrom || "البداية"} — ${dateTo || "اليوم"}`
              : "كل الفترات",
        },
        {
          label: "نطاق الطباعة",
          value: total === 0 ? "لا نتائج" : `${from}–${to} من ${total}`,
        },
        ...(filterLabels ? [{ label: "الفلاتر", value: filterLabels }] : []),
      ],
      note: "تطبع هذه النسخة الصفحة المعروضة المطابقة للفلاتر. استخدم تصدير Excel للحصول على جميع الصفوف المطابقة.",
      columns: [
        { key: "id", label: "#" },
        { key: "employee", label: "الموظف" },
        { key: "type", label: "النوع" },
        { key: "branch", label: "الفرع" },
        { key: "opened", label: "فُتحت" },
        { key: "closed", label: "أُغلقت" },
        { key: "expected", label: "المتوقع", align: "left" },
        { key: "variance", label: "الفرق", align: "left" },
        { key: "status", label: "الحالة" },
      ],
      rows: rows.map((row) => ({
        id: String(row.id),
        employee: row.userName ?? `#${row.userId}`,
        type: SHIFT_TYPE_LABEL[row.shiftType] ?? row.shiftType,
        branch: branchName(row.branchId),
        opened: fmtDT(row.openedAt),
        closed: fmtDT(row.closedAt),
        expected: row.expectedCash != null ? fmt(row.expectedCash) : "—",
        variance: row.variance != null ? fmt(row.variance) : "—",
        status: STATUS_LABEL[row.status] ?? row.status,
      })),
    });
    if (!opened)
      notify.err(
        "حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.",
      );
  }
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min((page + 1) * PAGE, total);

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجلّ الورديات"
        description="ورديات الكاشير (فتح/إغلاق الصندوق) مع النقد المتوقّع والمعدود والفرق. أعد طباعة تقرير نهاية الوردية (Z) لأي وردية مغلقة."
      />

      {(fundingRequestsQ.data?.length ?? 0) > 0 && (
        <Card className="border-warning/50">
          <CardHeader className="pb-2">
            <div className="font-bold">عهد نقدية إضافية بانتظار استلامك</div>
            <p className="text-xs text-muted-foreground">
              لا تُضف العهدة إلى رصيد درجك إلا بعد أن تستلم النقد فعلياً وتضغط «استلمت».
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {(fundingRequestsQ.data ?? []).map((request) => (
              <div
                key={request.requestReceiptId}
                className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-sm">
                  <div className="font-bold">
                    وردية #{request.shiftId} · {fmt(request.amount)} د.ع
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    سلّمها: {request.requestedByName ?? `#${request.requestedBy}`} · {request.evidenceNote}
                  </div>
                  {request.sourceReferenceNumber && (
                    <div className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      {request.sourceReferenceNumber} · receipt #{request.sourceTreasuryReceiptId}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    disabled={respondFundingM.isPending}
                    onClick={() =>
                      respondFundingM.mutate({
                        requestReceiptId: request.requestReceiptId,
                        decision: "ACCEPT",
                      })
                    }
                  >
                    <Check aria-hidden className="size-4" />
                    استلمت النقد
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={respondFundingM.isPending}
                    onClick={() => {
                      setFundingRejectionReason("");
                      setRejectFundingId(request.requestReceiptId);
                    }}
                  >
                    <X aria-hidden className="size-4" />
                    رفض
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {isOwner && (fundingOutgoingQ.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="font-bold">طلبات عهدة أرسلت ولم تُستلم بعد</div>
            <p className="text-xs text-muted-foreground">
              ما تزال صفريّة الأثر. يمكنك إلغاء الطلب لتحرير سحب المصدر إذا تعذّر التسليم.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {(fundingOutgoingQ.data ?? []).map((request) => (
              <div
                key={request.requestReceiptId}
                className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-sm">
                  <div className="font-bold">
                    وردية #{request.shiftId} — {request.targetUserName ?? `#${request.targetUserId}`} · {fmt(request.amount)} د.ع
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {request.sourceReferenceNumber} · من وردية #{request.sourceShiftId} · {request.evidenceNote}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cancelFundingM.isPending}
                  onClick={() => {
                    setFundingCancellationReason("");
                    setCancelFundingId(request.requestReceiptId);
                  }}
                >
                  <X aria-hidden className="size-4" />
                  إلغاء الطلب
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="الورديات"
            count={total}
            loading={list.isLoading}
            search={{
              value: query,
              onChange: (value) => setFilter(setQuery, value),
              placeholder: "اسم الموظف أو رقم الوردية…",
              ariaLabel: "البحث في الورديات باسم الموظف أو رقم الوردية",
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetFilters}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={printVisibleShifts}
            printLabel="طباعة القائمة"
            printDisabled={rows.length === 0}
            filters={
              <>
                <FilterField label="الحالة">
                  <AppSelect
                    className="h-9"
                    value={status}
                    onValueChange={(value) =>
                      setFilter(
                        setStatus,
                        value as "" | "OPEN" | "CLOSED",
                      )
                    }
                  >
                    <option value="">الكل</option>
                    <option value="OPEN">مفتوحة</option>
                    <option value="CLOSED">مغلقة</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="نوع الوردية">
                  <AppSelect
                    className="h-9"
                    value={shiftType}
                    onValueChange={(value) =>
                      setFilter(
                        setShiftType,
                        value as
                          | ""
                          | "RETAIL"
                          | "RECEPTION"
                          | "PRINT_SERVICES",
                      )
                    }
                  >
                    <option value="">الكل</option>
                    <option value="RETAIL">تجزئة</option>
                    <option value="RECEPTION">خدمة العملاء</option>
                    <option value="PRINT_SERVICES">خدمات طباعة</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="المطابقة النقدية">
                  <AppSelect
                    className="h-9"
                    value={varianceState}
                    onValueChange={(value) =>
                      setFilter(
                        setVarianceState,
                        value as
                          | ""
                          | "WITH_VARIANCE"
                          | "MATCHED"
                          | "UNRECONCILED",
                      )
                    }
                  >
                    <option value="">الكل</option>
                    <option value="WITH_VARIANCE">بفرق نقدي</option>
                    <option value="MATCHED">مطابقة</option>
                    <option value="UNRECONCILED">غير محسوبة</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="الفرع">
                  <AppSelect
                    className="h-9"
                    value={String(branchId)}
                    onValueChange={(value) =>
                      setFilter(
                        setBranchId,
                        value ? Number(value) : "",
                      )
                    }
                  >
                    <option value="">كل الفروع</option>
                    {(branches.data ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="من تاريخ">
                  <Input
                    type="date"
                    dir="ltr"
                    className="h-8 w-36"
                    value={dateFrom}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFilter(setDateFrom, value);
                      if (value && dateTo && value > dateTo) setDateTo(value);
                    }}
                  />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input
                    type="date"
                    dir="ltr"
                    className="h-8 w-36"
                    value={dateTo}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFilter(setDateTo, value);
                      if (value && dateFrom && value < dateFrom)
                        setDateFrom(value);
                    }}
                  />
                </FilterField>
              </>
            }
            exportSpec={{
              filename: "سجلّ-الورديات",
              rows,
              // تصدير كل النتائج المطابقة للفلاتر الحالية (لا الصفحة المعروضة فقط) — pageSize=200 (سقف الخادم).
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, limit) =>
                    utils.shifts.list
                      .fetch({
                        branchId: branchId ? Number(branchId) : undefined,
                        status: status || undefined,
                        shiftType: shiftType || undefined,
                        varianceState: varianceState || undefined,
                        q: debouncedQuery || undefined,
                        from: dateFrom || undefined,
                        to: dateTo || undefined,
                        limit,
                        offset,
                      })
                      .then((r) => ({
                        rows: (r.rows ?? []) as Row[],
                        total: r.total,
                      })),
                  { pageSize: 200 },
                ),
              columns: [
                { key: "id", header: "رقم الوردية" },
                {
                  key: "userName",
                  header: "الموظف",
                  map: (r) => r.userName ?? `#${r.userId}`,
                },
                {
                  key: "branch",
                  header: "الفرع",
                  map: (r) => branchName(r.branchId),
                },
                {
                  key: "shiftType",
                  header: "نوع الوردية",
                  map: (r) => SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType,
                },
                {
                  key: "openedAt",
                  header: "فُتحت",
                  map: (r) => fmtDT(r.openedAt),
                },
                {
                  key: "closedAt",
                  header: "أُغلقت",
                  map: (r) => fmtDT(r.closedAt),
                },
                {
                  key: "openingBalance",
                  header: "الافتتاحي",
                  map: (r) => Number(r.openingBalance ?? 0),
                },
                {
                  key: "expectedCash",
                  header: "المتوقع",
                  map: (r) =>
                    r.expectedCash != null ? Number(r.expectedCash) : "",
                },
                {
                  key: "countedCash",
                  header: "المعدود",
                  map: (r) =>
                    r.countedCash != null ? Number(r.countedCash) : "",
                },
                {
                  key: "variance",
                  header: "الفرق",
                  map: (r) => (r.variance != null ? Number(r.variance) : ""),
                },
                {
                  key: "status",
                  header: "الحالة",
                  map: (r) => STATUS_LABEL[r.status] ?? r.status,
                },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<Row>
            data={rows}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
            /* البحث والفلاتر في ListToolbar أعلاه (تغذّي الاستعلام) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={anyFilter}
            /* الترقيم خادميّ (limit/offset + total) ⇒ شريطٌ واحد داخل الجدول بدل شريطٍ يدويّ تحته. */
            serverPagination={{ page, onPageChange: setPage, pageSize: PAGE, total, isFetching: list.isFetching }}
            emptyState="لا ورديات بعد. تُفتح الورديات من نقطة البيع."
            emptyFilteredState="لا ورديات مطابقة. غيّر الفلتر."
            columns={[
              {
                id: "id",
                header: "#",
                accessorFn: (r) => r.id,
                meta: { kind: "number", width: "id" },
                cell: ({ row }) => row.original.id,
              },
              {
                id: "user",
                header: "الموظف",
                accessorFn: (r) => r.userName ?? `#${r.userId}`,
                meta: { width: "actor" },
                cell: ({ row }) => <span className="font-medium">{row.original.userName ?? `#${row.original.userId}`}</span>,
              },
              {
                id: "branch",
                header: "الفرع",
                accessorFn: (r) => branchName(r.branchId),
                cell: ({ row }) => branchName(row.original.branchId),
              },
              {
                id: "shiftType",
                header: "النوع",
                // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
                accessorFn: (r) => SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType,
                cell: ({ row }) => (
                  <span className="text-xs">{SHIFT_TYPE_LABEL[row.original.shiftType] ?? row.original.shiftType}</span>
                ),
              },
              {
                id: "openedAt",
                header: "فُتحت",
                accessorFn: (r) => fmtDT(r.openedAt),
                meta: { kind: "datetime" },
                cell: ({ row }) => <span className="text-xs">{fmtDT(row.original.openedAt)}</span>,
              },
              {
                id: "closedAt",
                header: "أُغلقت",
                accessorFn: (r) => fmtDT(r.closedAt),
                meta: { kind: "datetime" },
                cell: ({ row }) => <span className="text-xs">{fmtDT(row.original.closedAt)}</span>,
              },
              {
                id: "openingBalance",
                header: "الافتتاحي",
                accessorFn: (r) => fmt(r.openingBalance),
                meta: { kind: "money" },
                cell: ({ row }) => fmt(row.original.openingBalance),
              },
              {
                id: "expectedCash",
                header: "المتوقع",
                accessorFn: (r) => (r.expectedCash != null ? fmt(r.expectedCash) : "—"),
                meta: { kind: "money" },
                cell: ({ row }) => (row.original.expectedCash != null ? fmt(row.original.expectedCash) : "—"),
              },
              {
                id: "countedCash",
                header: "المعدود",
                accessorFn: (r) => (r.countedCash != null ? fmt(r.countedCash) : "—"),
                meta: { kind: "money" },
                cell: ({ row }) => (row.original.countedCash != null ? fmt(row.original.countedCash) : "—"),
              },
              {
                id: "variance",
                header: "الفرق",
                accessorFn: (r) => (r.variance != null ? fmt(r.variance) : "—"),
                meta: { kind: "money" },
                cell: ({ row }) => (
                  <span className={`font-semibold ${varianceCls(row.original.variance)}`}>
                    {row.original.variance != null ? fmt(row.original.variance) : "—"}
                  </span>
                ),
              },
              {
                id: "status",
                header: "الحالة",
                accessorFn: (r) => STATUS_LABEL[r.status] ?? r.status,
                meta: { kind: "status" },
                cell: ({ row }) => (
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[row.original.status] ?? "bg-muted"}`}>
                    {STATUS_LABEL[row.original.status] ?? row.original.status}
                  </span>
                ),
              },
              {
                id: "actions",
                header: "إجراء",
                enableSorting: false,
                meta: { kind: "actions" },
                cell: ({ row }) => {
                  const r = row.original;
                  return (
                    /* زر Z-report + نَسخ مُلَخَّص نَصّي (RowActions inline). */
                    <RowActions
                      mode="inline"
                      actions={[
                        {
                          key: "invoices",
                          kind: "view",
                          label: "الفواتير",
                          icon: Receipt,
                          onSelect: () => setInvoicesShiftId(r.id),
                          gate: { module: "sales", level: "READ" },
                        },
                        {
                          key: "zreport",
                          kind: "print",
                          label: printing === r.id ? "جارٍ…" : "Z-report",
                          icon: Printer,
                          disabled: printing === r.id,
                          disabledReason: "التقرير قيد التحضير",
                          onSelect: () => void reprintZ(r.id),
                          gate: { module: "treasury", level: "READ" },
                        },
                        {
                          key: "copy",
                          kind: "export",
                          label: copying === r.id ? "جارٍ…" : "نسخ",
                          icon: Copy,
                          disabled: copying === r.id,
                          disabledReason: "الملخص قيد التحضير",
                          onSelect: () => void copyZ(r.id),
                          gate: { module: "treasury", level: "READ" },
                        },
                        {
                          key: "funding",
                          kind: "transfer",
                          label: "تمويل إضافي",
                          icon: CircleDollarSign,
                          hidden: r.status !== "OPEN" || !isOwner || Number(r.userId) === Number(me.data?.id),
                          onSelect: () => openFundingDialog(r.id),
                          gate: { module: "treasury", level: "FULL" },
                        },
                        {
                          key: "close",
                          kind: "reverse",
                          label: "إغلاق",
                          icon: Lock,
                          hidden: r.status !== "OPEN" || !isElevated,
                          onSelect: () => openCloseDialog(r.id),
                          gate: {
                            roles: ["cashier", "manager"],
                            module: "treasury",
                            level: "READ",
                          },
                        },
                      ]}
                    />
                  );
                },
              },
            ]}
          />
        </CardContent>
      </Card>

      <ShiftFundingDialog
        fundingShiftId={fundingShiftId}
        fundingRowUserName={fundingRow?.userName}
        fundingReportLoading={fundingReportQ.isLoading}
        fundingExpected={fundingExpected}
        fundingSources={fundingSources}
        fundingSourcesLoading={fundingSourcesQ.isLoading}
        fundingSourcesNextCursor={fundingSourcesQ.data?.nextCursor}
        fundingSourceReceiptId={fundingSourceReceiptId}
        setFundingSourceReceiptId={(val) => {
          setFundingSourceReceiptId(val);
          const selected = fundingSources.find(
            (source) => Number(source.receiptId) === Number(val),
          );
          setFundingAmount(selected?.amount ?? "");
        }}
        fundingAmount={fundingAmount}
        setFundingAmount={setFundingAmount}
        fundingNote={fundingNote}
        setFundingNote={setFundingNote}
        fundingSourceCursor={fundingSourceCursor}
        setFundingSourceCursor={setFundingSourceCursor}
        fundingSourceCursorHistory={fundingSourceCursorHistory}
        setFundingSourceCursorHistory={setFundingSourceCursorHistory}
        fundingClientRequestId={fundingClientRequestId}
        isPending={requestFundingM.isPending}
        onClose={() => {
          setFundingShiftId(null);
          setFundingAmount("");
          setFundingNote("");
          setFundingSourceReceiptId("");
          setFundingClientRequestId("");
          setFundingSourceCursor(null);
          setFundingSourceCursorHistory([]);
        }}
        onSubmit={() => {
          if (fundingShiftId == null) return;
          requestFundingM.mutate({
            shiftId: fundingShiftId,
            amount: D(fundingAmount).toFixed(2),
            evidenceNote: fundingNote.trim(),
            sourceTreasuryReceiptId: Number(fundingSourceReceiptId),
            clientRequestId: fundingClientRequestId,
          });
        }}
      />

      <ShiftFundingDecisionDialogs
        rejectFundingId={rejectFundingId}
        fundingRejectionReason={fundingRejectionReason}
        setFundingRejectionReason={setFundingRejectionReason}
        onCloseReject={() => {
          setRejectFundingId(null);
          setFundingRejectionReason("");
        }}
        onConfirmReject={() => {
          if (rejectFundingId == null) return;
          respondFundingM.mutate({
            requestReceiptId: rejectFundingId,
            decision: "REJECT",
            rejectionReason: fundingRejectionReason.trim(),
          });
        }}
        isRejectPending={respondFundingM.isPending}
        cancelFundingId={cancelFundingId}
        fundingCancellationReason={fundingCancellationReason}
        setFundingCancellationReason={setFundingCancellationReason}
        onCloseCancel={() => {
          setCancelFundingId(null);
          setFundingCancellationReason("");
        }}
        onConfirmCancel={() => {
          if (cancelFundingId == null) return;
          cancelFundingM.mutate({
            requestReceiptId: cancelFundingId,
            cancellationReason: fundingCancellationReason.trim(),
          });
        }}
        isCancelPending={cancelFundingM.isPending}
      />

      <ShiftCloseDialog
        closingShiftId={closingShiftId}
        closingRowUserName={closingRow?.userName}
        isLoading={closeReportQ.isLoading}
        closeReportData={closeReportQ.data}
        closeReconciliation={closeReconciliation}
        isLegacyNegative={isLegacyNegative}
        isOwner={isOwner}
        closeExpected={closeExpected}
        closeCounted={closeCounted}
        setCloseCounted={setCloseCounted}
        closeDiff={closeDiff}
        closeHasVariance={closeHasVariance}
        varianceCls={varianceCls}
        legacySourceReceiptId={legacySourceReceiptId}
        setLegacySourceReceiptId={setLegacySourceReceiptId}
        legacyEvidenceNote={legacyEvidenceNote}
        setLegacyEvidenceNote={setLegacyEvidenceNote}
        legacyConfirmedZero={legacyConfirmedZero}
        setLegacyConfirmedZero={setLegacyConfirmedZero}
        legacyClientRequestId={legacyClientRequestId}
        isPending={closeShiftM.isPending}
        onClose={() => {
          setClosingShiftId(null);
          setCloseCounted("");
          setLegacyEvidenceNote("");
          setLegacySourceReceiptId("");
          setLegacyConfirmedZero(false);
          setLegacyClientRequestId("");
        }}
        onSubmit={({
          isLegacyNegative: isNeg,
          closingShiftId: sId,
          closeExpected,
          legacySourceReceiptId: srcId,
          legacyEvidenceNote: note,
          legacyClientRequestId: reqId,
          closeCounted: counted,
        }) => {
          if (isNeg) {
            closeShiftM.mutate({
              shiftId: sId,
              countedCash: "0",
              legacyNegativeRemediation: {
                expectedCash: closeExpected.toFixed(2),
                sourceTreasuryReceiptId: srcId ? Number(srcId) : undefined,
                evidenceNote: note.trim(),
                confirmDrawerCountedZero: true,
                clientRequestId: reqId,
              },
            });
            return;
          }
          closeShiftM.mutate({
            shiftId: sId,
            countedCash: counted,
          });
        }}
      />

      <ShiftInvoicesDialog
        invoicesShiftId={invoicesShiftId}
        invoicesShiftRowUserName={invoicesShiftRow?.userName}
        isLoading={invoicesShiftQ.isLoading}
        isError={invoicesShiftQ.isError}
        errorMessage={invoicesShiftQ.error?.message}
        invoices={invoicesShiftQ.data ?? []}
        onRetry={() => void invoicesShiftQ.refetch()}
        onClose={() => setInvoicesShiftId(null)}
      />
    </div>
  );
}
