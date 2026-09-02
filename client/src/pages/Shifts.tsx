import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import {
  ShiftCashReconciliation,
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
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">#</th>
                  <th className="p-2">الموظف</th>
                  <th className="p-2">الفرع</th>
                  <th className="p-2">النوع</th>
                  <th className="p-2">فُتحت</th>
                  <th className="p-2">أُغلقت</th>
                  <th className="p-2 text-right">الافتتاحي</th>
                  <th className="p-2 text-right">المتوقع</th>
                  <th className="p-2 text-right">المعدود</th>
                  <th className="p-2 text-right">الفرق</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 tabular-nums" dir="ltr">
                      {r.id}
                    </td>
                    <td className="p-2 font-medium">
                      {r.userName ?? `#${r.userId}`}
                    </td>
                    <td className="p-2">{branchName(r.branchId)}</td>
                    <td className="p-2 whitespace-nowrap text-xs">
                      {SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType}
                    </td>
                    <td
                      className="p-2 text-xs whitespace-nowrap tabular-nums"
                      dir="ltr"
                    >
                      {fmtDT(r.openedAt)}
                    </td>
                    <td
                      className="p-2 text-xs whitespace-nowrap tabular-nums"
                      dir="ltr"
                    >
                      {fmtDT(r.closedAt)}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {fmt(r.openingBalance)}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {r.expectedCash != null ? fmt(r.expectedCash) : "—"}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {r.countedCash != null ? fmt(r.countedCash) : "—"}
                    </td>
                    <td
                      className={`p-2 text-right font-semibold tabular-nums ${varianceCls(r.variance)}`}
                      dir="ltr"
                    >
                      {r.variance != null ? fmt(r.variance) : "—"}
                    </td>
                    <td className="p-2 text-center">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
                      >
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* زر Z-report + نَسخ مُلَخَّص نَصّي (RowActions inline). */}
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
                            hidden:
                              r.status !== "OPEN" ||
                              !isOwner ||
                              Number(r.userId) === Number(me.data?.id),
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
                    </td>
                  </tr>
                ))}
                {!list.isLoading && rows.length === 0 && (
                  <TableEmptyRow
                    colSpan={12}
                    message={
                      total === 0 && !anyFilter
                        ? "لا ورديات بعد. تُفتح الورديات من نقطة البيع."
                        : "لا ورديات مطابقة. غيّر الفلتر."
                    }
                  />
                )}
                {list.isLoading && (
                  <tr>
                    <td colSpan={12}>
                      <LoadingState />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground" dir="ltr">
          {total === 0
            ? "لا صفوف"
            : `${from}–${to} / ${total.toLocaleString("ar-IQ-u-nu-latn")}`}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            السابق
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            التالي
          </Button>
        </div>
      </div>

      <Dialog
        open={fundingShiftId != null}
        onOpenChange={(open) => {
          if (!open) {
            setFundingShiftId(null);
            setFundingAmount("");
            setFundingNote("");
            setFundingSourceReceiptId("");
            setFundingClientRequestId("");
            setFundingSourceCursor(null);
            setFundingSourceCursorHistory([]);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              تمويل إضافي للوردية #{fundingShiftId} — {fundingRow?.userName ?? ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              هذا طلب تسليم فقط: لا تُخصم الخزنة ولا يزيد الدرج حتى يستلم صاحب الوردية النقد فعلياً
              ويؤكد الاستلام. الرصيد المتوقع الحي: {fundingReportQ.isLoading ? "جارٍ الحساب…" : fundingExpected == null ? "—" : `${fmt(fundingExpected.toString())} د.ع`}.
            </div>
            {fundingExpected?.lt(0) && (
              <div className="rounded-lg border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                هذه الوردية سالبة؛ لا يجوز إخفاء العجز بتمويل إضافي. عالج المستند المسبب أو استخدم مسار التصحيح التاريخي.
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor="shift-funding-source" className="text-sm font-bold">
                سحب الوردية المصدر
              </label>
              <AppSelect
                id="shift-funding-source"
                className={`${selectCls} h-10 w-full`}
                value={fundingSourceReceiptId}
                disabled={fundingSourcesQ.isLoading}
                onValueChange={(value) => {
                  const nextId = value;
                  setFundingSourceReceiptId(nextId);
                  const selected = fundingSources.find(
                    (source) => Number(source.receiptId) === Number(nextId),
                  );
                  setFundingAmount(selected?.amount ?? "");
                }}
              >
                <option value="">اختر سحباً نقدياً مقبولاً وغير مستخدم</option>
                {fundingSources.map((source) => (
                  <option key={source.receiptId} value={source.receiptId}>
                    {source.referenceNumber} — وردية #{source.sourceShiftId} {source.sourceUserName ?? ""} — {fmt(source.amount)} د.ع
                  </option>
                ))}
              </AppSelect>
              <p className="text-xs text-muted-foreground">
                إلزامي: يجب أن يكون سحباً مقبولاً من وردية أخرى وبنفس المبلغ، ولا يمكن استعماله مرتين. من دون سحبٍ فعلي أغلق الوردية وافتح وردية جديدة بعهدة من الخزينة.
              </p>
              {!fundingSourcesQ.isLoading && fundingSources.length === 0 && (
                <p className="text-xs font-bold text-warning">
                  {fundingSourcesQ.data?.nextCursor != null
                    ? "لا يوجد مصدر صالح في هذه الصفحة؛ اعرض المصادر الأقدم."
                    : "لا يوجد سحب وردية مقبول متاح لهذا الفرع. نفّذ السحب واستلمه في الخزينة أولاً."}
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fundingSourcesQ.isLoading || fundingSourceCursorHistory.length === 0}
                  onClick={() => {
                    setFundingSourceReceiptId("");
                    setFundingAmount("");
                    setFundingSourceCursorHistory((history) => {
                      const previous = history[history.length - 1] ?? null;
                      setFundingSourceCursor(previous);
                      return history.slice(0, -1);
                    });
                  }}
                >
                  الأحدث
                </Button>
                <span className="text-xs text-muted-foreground">50 مصدراً في الصفحة كحد أقصى</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fundingSourcesQ.isLoading || fundingSourcesQ.data?.nextCursor == null}
                  onClick={() => {
                    const nextCursor = fundingSourcesQ.data?.nextCursor;
                    if (nextCursor == null) return;
                    setFundingSourceReceiptId("");
                    setFundingAmount("");
                    setFundingSourceCursorHistory((history) => [...history, fundingSourceCursor]);
                    setFundingSourceCursor(nextCursor);
                  }}
                >
                  الأقدم
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="shift-funding-amount" className="text-sm font-bold">
                المبلغ المطابق للسحب
              </label>
              <MoneyInput
                id="shift-funding-amount"
                value={fundingAmount}
                onChange={setFundingAmount}
                placeholder="0"
                ariaLabel="مبلغ التمويل الإضافي للوردية"
                disabled
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="shift-funding-note" className="text-sm font-bold">
                سبب الحاجة للنقد
              </label>
              <Textarea
                id="shift-funding-note"
                rows={3}
                maxLength={500}
                value={fundingNote}
                onChange={(event) => setFundingNote(event.target.value)}
                placeholder="مثال: عهدة لتسديد مصروفات تشغيلية متوقعة خلال الوردية"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFundingShiftId(null)}>
              إلغاء
            </Button>
            <Button
              disabled={
                requestFundingM.isPending ||
                fundingReportQ.isLoading ||
                fundingExpected == null ||
                fundingExpected.lt(0) ||
                !fundingAmount ||
                !fundingSourceReceiptId ||
                D(fundingAmount || 0).lte(0) ||
                fundingNote.trim().length < 10 ||
                !fundingClientRequestId
              }
              onClick={() => {
                if (fundingShiftId == null) return;
                requestFundingM.mutate({
                  shiftId: fundingShiftId,
                  amount: D(fundingAmount).toFixed(2),
                  evidenceNote: fundingNote.trim(),
                  sourceTreasuryReceiptId: Number(fundingSourceReceiptId),
                  clientRequestId: fundingClientRequestId,
                });
              }}
            >
              {requestFundingM.isPending ? "جارٍ إنشاء العهدة…" : "إنشاء طلب التسليم"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rejectFundingId != null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectFundingId(null);
            setFundingRejectionReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>رفض استلام العهدة النقدية</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="shift-funding-rejection" className="text-sm font-bold">
              سبب عدم الاستلام
            </label>
            <Textarea
              id="shift-funding-rejection"
              rows={3}
              maxLength={500}
              value={fundingRejectionReason}
              onChange={(event) => setFundingRejectionReason(event.target.value)}
              placeholder="لم أستلم النقد فعلياً أو المبلغ لا يطابق الطلب"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectFundingId(null)}>
              رجوع
            </Button>
            <Button
              variant="destructive"
              disabled={
                respondFundingM.isPending ||
                fundingRejectionReason.trim().length < 5
              }
              onClick={() => {
                if (rejectFundingId == null) return;
                respondFundingM.mutate({
                  requestReceiptId: rejectFundingId,
                  decision: "REJECT",
                  rejectionReason: fundingRejectionReason.trim(),
                });
              }}
            >
              {respondFundingM.isPending ? "جارٍ الرفض…" : "تأكيد الرفض بلا أثر نقدي"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelFundingId != null}
        onOpenChange={(open) => {
          if (!open) {
            setCancelFundingId(null);
            setFundingCancellationReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إلغاء طلب تسليم العهدة</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              الإلغاء لا يغيّر الخزينة أو الدرج، ويعيد إتاحة سحب المصدر لطلب صحيح لاحقاً.
            </p>
            <label htmlFor="shift-funding-cancellation" className="text-sm font-bold">
              سبب الإلغاء
            </label>
            <Textarea
              id="shift-funding-cancellation"
              rows={3}
              maxLength={500}
              value={fundingCancellationReason}
              onChange={(event) => setFundingCancellationReason(event.target.value)}
              placeholder="تعذّر التسليم الفعلي أو لم تعد الوردية تحتاج المبلغ"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelFundingId(null)}>
              رجوع
            </Button>
            <Button
              variant="destructive"
              disabled={cancelFundingM.isPending || fundingCancellationReason.trim().length < 5}
              onClick={() => {
                if (cancelFundingId == null) return;
                cancelFundingM.mutate({
                  requestReceiptId: cancelFundingId,
                  cancellationReason: fundingCancellationReason.trim(),
                });
              }}
            >
              {cancelFundingM.isPending ? "جارٍ الإلغاء…" : "إلغاء الطلب بلا أثر نقدي"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* إغلاق وردية عن بُعد (admin/manager) — لموظّف نسي إغلاق ورديته. نفس حوكمة نوافذ POS/
          الاستقبال/الطباعة تماماً: لا إغلاق بفرق (closeShift الخادمية ترفضه دون استثناء). */}
      <Dialog
        open={closingShiftId != null}
        onOpenChange={(open) => {
          if (!open) {
            setClosingShiftId(null);
            setCloseCounted("");
            setLegacyEvidenceNote("");
            setLegacySourceReceiptId("");
            setLegacyConfirmedZero(false);
            setLegacyClientRequestId("");
          }
        }}
      >
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>
              إغلاق وردية #{closingShiftId} — {closingRow?.userName ?? ""}
            </DialogTitle>
          </DialogHeader>
          {closeReportQ.isLoading ? (
            <LoadingState />
          ) : (
            <>
              <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    ملخص الفواتير (للمعلومة فقط)
                  </span>
                  <span className="tabular-nums" dir="ltr">
                    {closeReportQ.data?.invoiceCount ?? 0} فاتورة ·{" "}
                    {fmt(Number(closeReportQ.data?.salesTotal ?? 0))} د.ع
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  هذا الإجمالي لا يدخل معادلة الإغلاق؛ التسوية أدناه مبنية على
                  إيصالات النقد الفعلية لهذه الوردية.
                </p>
              </div>
              <ShiftCashReconciliation
                data={closeReconciliation}
                defaultExpandedKeys={[
                  "cashSales",
                  "cashReturns",
                  "cashExpenses",
                  "cashDrops",
                ]}
                formatMoney={(value) =>
                  value == null || value === "" ? "—" : fmt(String(value))
                }
                formatDateTime={(value) => fmtDT(value)}
              />
              {isLegacyNegative && isOwner ? (
                <div className="space-y-4 rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
                  <div>
                    <p className="font-bold">معالجة رصيد سالب موروث — للمالك فقط</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      سيُسحب من الخزنة مبلغ {fmt(closeExpected?.abs().toNumber() ?? 0)} د.ع
                      ويُضاف إلى هذه الوردية بسندَي تصحيح مترابطين، ثم يُثبت الرصيد والمعدود
                      والفرق صفراً وتُغلق الوردية. لن يتغير أي سند تاريخي.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="legacy-source-receipt" className="font-bold">
                      رقم إيصال السحب الموجود في الخزنة (إن وُجد)
                    </label>
                    <Input
                      id="legacy-source-receipt"
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={legacySourceReceiptId}
                      onChange={(event) => setLegacySourceReceiptId(event.target.value)}
                      placeholder="مثال: 2996"
                    />
                    <p className="text-xs text-muted-foreground">
                      يُستعمل لإثبات سلسلة الحيازة فقط؛ المتبقي منه يبقى في الخزنة.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="legacy-evidence-note" className="font-bold">
                      دليل وسبب المعالجة
                    </label>
                    <Textarea
                      id="legacy-evidence-note"
                      rows={3}
                      maxLength={1000}
                      value={legacyEvidenceNote}
                      onChange={(event) => setLegacyEvidenceNote(event.target.value)}
                      placeholder="اذكر نتيجة المراجعة، مصدر المبلغ، وتوجيه المالك…"
                    />
                  </div>
                  <label className="flex items-start gap-2 rounded-md border bg-background p-3 font-bold">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={legacyConfirmedZero}
                      onChange={(event) => setLegacyConfirmedZero(event.target.checked)}
                    />
                    <span>أؤكد أن النقد الموجود فعلياً في درج هذه الوردية معدود ويساوي صفراً.</span>
                  </label>
                </div>
              ) : isLegacyNegative ? (
                <div className="rounded-xl border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                  هذه وردية سالبة موروثة. لا يملك حق تمويلها وتصفيرها وإغلاقها إلا حساب المالك.
                </div>
              ) : (
              <div className="space-y-1.5 rounded-xl border p-4">
                <label
                  htmlFor="close-counted-cash"
                  className="block text-sm font-bold"
                >
                  النقد المعدود (د.ع)
                </label>
                <MoneyInput
                  id="close-counted-cash"
                  value={closeCounted}
                  onChange={setCloseCounted}
                  placeholder="0"
                  ariaLabel="النقد المعدود عند إغلاق الوردية"
                  className="h-11 text-center text-lg font-extrabold"
                />
                {closeDiff != null && (
                  <div
                    className={`flex items-center gap-1 text-sm font-bold ${varianceCls(closeDiff.toFixed(2))}`}
                  >
                    <span>
                      الفرق: {closeDiff.gte(0) ? "+" : ""}
                      {fmt(closeDiff.toNumber())} د.ع
                    </span>
                    {closeDiff.isZero() && (
                      <Check aria-hidden className="size-3.5" />
                    )}
                  </div>
                )}
              </div>
              )}
              {!isLegacyNegative && closeHasVariance && (
                <div className="rounded-xl border border-destructive/60 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                  لا يمكن إغلاق الوردية: النقد المعدود لا يساوي الافتتاحي مضافاً
                  إليه صافي المبيعات النقدية المسجّلة. راجع الفواتير والمرتجعات
                  لهذه الوردية أولاً.
                </div>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingShiftId(null)}>
              إلغاء
            </Button>
            <Button
              disabled={
                closeShiftM.isPending ||
                closeExpected == null ||
                (isLegacyNegative
                  ? !isOwner ||
                    legacyEvidenceNote.trim().length < 20 ||
                    !legacyConfirmedZero ||
                    !legacyClientRequestId
                  : !closeCounted || closeHasVariance)
              }
              onClick={() => {
                if (closingShiftId == null || closeExpected == null) return;
                if (isLegacyNegative) {
                  closeShiftM.mutate({
                    shiftId: closingShiftId,
                    countedCash: "0",
                    legacyNegativeRemediation: {
                      expectedCash: closeExpected.toFixed(2),
                      sourceTreasuryReceiptId: legacySourceReceiptId
                        ? Number(legacySourceReceiptId)
                        : undefined,
                      evidenceNote: legacyEvidenceNote.trim(),
                      confirmDrawerCountedZero: true,
                      clientRequestId: legacyClientRequestId,
                    },
                  });
                  return;
                }
                closeShiftM.mutate({
                  shiftId: closingShiftId,
                  countedCash: closeCounted,
                });
              }}
            >
              {closeShiftM.isPending
                ? "جارٍ التنفيذ…"
                : isLegacyNegative
                  ? "تمويل من الخزنة وتصفير وإغلاق"
                  : "إغلاق"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* فواتير الوردية — قائمة مضمَّنة لتحقيق الفروقات النقدية بلا مغادرة الشاشة (سطراً بسطر). */}
      <Dialog
        open={invoicesShiftId != null}
        onOpenChange={(open) => {
          if (!open) setInvoicesShiftId(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              فواتير وردية #{invoicesShiftId} —{" "}
              {invoicesShiftRow?.userName ?? ""}
            </DialogTitle>
          </DialogHeader>
          {invoicesShiftQ.isLoading ? (
            <LoadingState />
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                {invoicesShiftQ.data?.length ?? 0} فاتورة — الإجمالي{" "}
                <b className="tabular-nums" dir="ltr">
                  {fmt(
                    (invoicesShiftQ.data ?? [])
                      .reduce((s, r) => s.plus(D(r.total)), D(0))
                      .toString(),
                  )}
                </b>{" "}
                د.ع
              </div>
              <ScrollTableShell bordered maxHeightClass="max-h-[60vh]">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2">رقم الفاتورة</th>
                      <th className="p-2">الوقت</th>
                      <th className="p-2">طريقة الدفع</th>
                      <th className="p-2 text-right">الإجمالي</th>
                      <th className="p-2 text-right">المدفوع</th>
                      <th className="p-2 text-center">الحالة</th>
                      <th className="p-2 text-center">فتح</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(invoicesShiftQ.data ?? []).map((inv) => (
                      <tr key={inv.id} className="border-t">
                        <td className="p-2 font-medium tabular-nums" dir="ltr">
                          {inv.invoiceNumber}
                        </td>
                        <td
                          className="p-2 text-xs whitespace-nowrap tabular-nums"
                          dir="ltr"
                        >
                          {fmtDT(inv.invoiceDate)}
                        </td>
                        <td className="p-2 text-xs">
                          {inv.paymentMethod
                            ? paymentMethodLabel(inv.paymentMethod)
                            : "—"}
                        </td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">
                          {fmt(inv.total)}
                        </td>
                        <td className="p-2 text-right tabular-nums" dir="ltr">
                          {fmt(inv.paidAmount)}
                        </td>
                        <td className="p-2 text-center text-xs">
                          {invoiceStatusLabel(inv.status)}
                        </td>
                        <td className="p-2 text-center">
                          <Link
                            href={`/invoices/${inv.id}`}
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            فتح
                          </Link>
                        </td>
                      </tr>
                    ))}
                    {(invoicesShiftQ.data ?? []).length === 0 && (
                      <TableEmptyRow
                        colSpan={7}
                        message="لا فواتير على هذه الوردية."
                      />
                    )}
                  </tbody>
                </table>
              </ScrollTableShell>
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoicesShiftId(null)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
