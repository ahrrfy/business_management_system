import { BranchBalanceCard } from "@/components/treasury/BranchBalanceCard";
import { BranchComparisonChart } from "@/components/treasury/BranchComparisonChart";
import { CashFlowChart } from "@/components/treasury/CashFlowChart";
import { OpenShiftsPanel } from "@/components/treasury/OpenShiftsPanel";
import { PaymentMethodDonut } from "@/components/treasury/PaymentMethodDonut";
import { TreasuryKpiCard } from "@/components/treasury/TreasuryKpiCard";
import { FinancialSourceBadge } from "@/components/financial";
import { AppSelect } from "@/components/ui/AppSelect";
import { moduleAccessAllowed } from "@shared/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { CashCounter } from "@/components/CashCounter";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/data-table/DataTable";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmtAr, sum } from "@/lib/money";
import { notify } from "@/lib/notify";
import { newClientRequestId } from "@/lib/countQueue";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { exportRows } from "@/lib/export";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock3,
  Layers,
  Loader2,
  Receipt as ReceiptIcon,
  RefreshCcw,
  Vault,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

type Period = "today" | "yesterday" | "week" | "month";
type PendingHandover = RouterOutputs["treasury"]["pendingHandoverReceipts"][number];

const PERIOD_AR: Record<Period, string> = {
  today: "اليوم",
  yesterday: "أمس",
  week: "آخر ٧ أيام",
  month: "آخر ٣٠ يوماً",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const fmtDT = (d: string | number | Date | null | undefined) => fmtDateTime(d);

const fmtRelativeShort = (iso: string) => {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "للتوّ";
  if (m < 60) return `منذ ${m.toLocaleString("ar-IQ-u-nu-latn")} د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h.toLocaleString("ar-IQ-u-nu-latn")} س`;
  return fmtDT(iso);
};

function CustodyQueryNotice({
  loading,
  error,
  loadingLabel,
  errorLabel,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  loadingLabel: string;
  errorLabel: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
        {loadingLabel}
      </div>
    );
  }
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span className="flex items-center gap-2">
        <AlertTriangle aria-hidden className="size-3.5" />
        {errorLabel}
      </span>
      <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5" onClick={onRetry}>
        <RefreshCcw aria-hidden className="size-3.5" /> إعادة المحاولة
      </Button>
    </div>
  );
}

interface MovementRow {
  id: string;
  rawId: number;
  source: "RECEIPT" | "EXPENSE";
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  branchId: number | null;
  branchName: string | null;
  description: string | null;
  voucherNumber: string | null;
  status: string | null;
  approvalStatus: string | null;
  approvedAt: string | null;
  shiftId: number | null;
  shiftOwnerId: number | null;
  shiftOwnerName: string | null;
  createdBy: number | null;
  createdByName: string | null;
  partyType: string | null;
  partyId: number | null;
  partyName: string | null;
  approvedBy: number | null;
  approvedByName: string | null;
  referenceNumber: string | null;
  invoiceId: number | null;
  workOrderId: number | null;
  reservationId: number | null;
  expenseId: number | null;
  expensePayee: string | null;
  expenseCategory: string | null;
  costCenter: string | null;
  ledgerEntryId: number | null;
  documentDate: string | null;
  integrityWarnings: string[];
  createdAt: string;
}

const MOVEMENT_WARNING_LABEL: Record<string, string> = {
  DESCRIPTION_MISSING: "لا يوجد شرح للعملية",
  ACTOR_MISSING: "منفذ العملية غير موثق",
  CASH_SOURCE_MISSING: "مصدر النقد غير محدد",
  DRAWER_WITHOUT_SHIFT: "حركة درج بلا وردية",
  TREASURY_WITH_SHIFT: "حركة خزينة مرتبطة بورديّة",
  LEDGER_ENTRY_MISSING: "لا يوجد قيد محاسبي مرتبط",
};

const MOV_PAGE = 20;

export default function Treasury() {
  const [branchId, setBranchId] = useState<number | "">("");
  const [period, setPeriod] = useState<Period>("today");
  // فلتر مدى تاريخ + ترقيم لجدول «آخر الحركات النقدية» — كان مثبَّتاً على آخر ٢٠ حركة صامتاً
  // بلا تصفّح لما قبلها ولا حصر بفترة.
  const [movFrom, setMovFrom] = useState("");
  const [movTo, setMovTo] = useState("");
  const [movPage, setMovPage] = useState(0);
  const [movExporting, setMovExporting] = useState(false);
  // العهدة الوسيطة (imprest، ٢٨/٧/٢٦): تمويل الخزينة (رأس مال) — يُموّل عهد الورديات.
  const [fundOpen, setFundOpen] = useState(false);
  const [fundBranch, setFundBranch] = useState<number | "">("");
  const [fundAmount, setFundAmount] = useState("");
  const [fundDesc, setFundDesc] = useState("");
  const [fundNotes, setFundNotes] = useState("");
  const [fundReqId, setFundReqId] = useState("");

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const dashboard = trpc.treasury.getDashboard.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { refetchInterval: 30_000 },
  );
  const trends = trpc.treasury.getKpiTrends.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 60_000 },
  );
  const cashFlow = trpc.treasury.getCashFlowSeries.useQuery(
    { days: 30, branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 5 * 60_000 },
  );
  const breakdown = trpc.treasury.getPaymentMethodBreakdown.useQuery(
    { period, branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 5 * 60_000 },
  );
  const movements = trpc.treasury.getRecentMovements.useQuery(
    {
      limit: MOV_PAGE,
      offset: movPage * MOV_PAGE,
      branchId: branchId ? Number(branchId) : undefined,
      from: movFrom || undefined,
      to: movTo || undefined,
    },
    { refetchInterval: 30_000 },
  );
  // أي تغيير في فلاتر جدول الحركات يعيدنا للصفحة الأولى (وإلا بقي offset قديماً على مجموعة أصغر).
  useEffect(() => {
    setMovPage(0);
  }, [branchId, movFrom, movTo]);
  const openShifts = trpc.treasury.getOpenShifts.useQuery(
    { branchId: branchId ? Number(branchId) : undefined },
    { refetchInterval: 30_000 },
  );
  const pendingHandovers = trpc.treasury.pendingHandoverReceipts.useQuery(
    undefined,
    { refetchInterval: 15_000 },
  );
  const [acceptTarget, setAcceptTarget] = useState<PendingHandover | null>(null);
  const [acceptBreakdown, setAcceptBreakdown] = useState<Record<number, number>>({});
  const [acceptCounted, setAcceptCounted] = useState("0.00");
  const [acceptRequestId, setAcceptRequestId] = useState("");
  const acceptHandover = trpc.treasury.acceptHandoverReceipt.useMutation({
    onSuccess: (result) => {
      if (result.accepted) {
        notify.ok(
          result.idempotent ? "العهدة مقبولة مسبقاً" : "تم قبول عهدة النقد",
          `السند ${result.referenceNumber} — ${fmtAr(result.countedCash)} د.ع`,
        );
        setAcceptTarget(null);
      } else {
        notify.warn(
          `فرق عهدة ${fmtAr(result.variance)} د.ع`,
          "حُفظ العد وبقيت العهدة معلّقة. أعد إسنادها إلى مستلم مستقل لإعادة العد؛ لم يدخل أي مبلغ إلى الخزينة.",
        );
        setAcceptTarget(null);
      }
      void utils.treasury.pendingHandoverReceipts.invalidate();
      void utils.treasury.getDashboard.invalidate();
      void utils.treasury.getKpiTrends.invalidate();
      void utils.treasury.getCashFlowSeries.invalidate();
      void utils.treasury.getPaymentMethodBreakdown.invalidate();
      void utils.treasury.getRecentMovements.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const userRole = me.data?.role ?? "";
  const isAdmin = userRole === "admin";
  const isManager = userRole === "manager";

  // المسار أ (ورقة الإصلاحات ١٦/٨): طابور العهد المعلّقة **كلّها** — لا المسندة للمستخدم وحده.
  // بدونه يبقى نقدُ مستلمٍ غائب خارج رصيد الخزينة بلا أن يراه أحد (٥٠٬٠٠٠ د.ع ظلّت أربعة أيام).
  // بوّابة الشاشة تُطابق بوّابة الخادم (خريطة الصلاحيات: treasury=FULL) لا دوراً خاماً —
  // وإلّا صار المنح الصريح معلَناً في جرد الصلاحيات وغير قابلٍ للاستعمال فعلياً.
  const canGovernHandovers = moduleAccessAllowed(
    userRole,
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
      ?.permissionsOverride ?? null,
    "treasury",
    "FULL",
    ["manager", "accountant"],
  );
  const pendingQueue = trpc.treasury.pendingHandoverQueue.useQuery(undefined, {
    enabled: canGovernHandovers,
    refetchInterval: 30_000,
  });
  const reassignHandover = trpc.treasury.reassignHandoverReceipt.useMutation({
    onSuccess: (result) => {
      notify.ok(
        "أُعيد إسناد العهدة",
        `السند ${result.referenceNumber} أُسند إلى المستلم الجديد دون كشف المبلغ قبل العد.`,
      );
      void utils.treasury.pendingHandoverQueue.invalidate();
      void utils.treasury.pendingHandoverReceipts.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const handoverRecipients = trpc.shifts.handoverRecipients.useQuery(undefined, {
    enabled: canGovernHandovers && (pendingQueue.data?.length ?? 0) > 0,
  });
  const canChooseBranch = isAdmin || isManager;
  const hideTreasury = dashboard.data?.hideTreasury ?? false;

  const refreshAll = () => {
    void utils.treasury.getDashboard.invalidate();
    void utils.treasury.getKpiTrends.invalidate();
    void utils.treasury.getCashFlowSeries.invalidate();
    void utils.treasury.getPaymentMethodBreakdown.invalidate();
    void utils.treasury.getRecentMovements.invalidate();
    void utils.treasury.getOpenShifts.invalidate();
    void utils.treasury.pendingHandoverReceipts.invalidate();
  };

  const fundTreasuryM = trpc.treasury.fundTreasury.useMutation({
    onSuccess: (r) => {
      notify.ok(
        "تم تمويل الخزينة",
        `السند ${r.referenceNumber} — الرصيد بعده ${fmtAr(r.treasuryBalanceAfter)} د.ع`,
      );
      setFundOpen(false);
      setFundAmount("");
      setFundDesc("");
      setFundNotes("");
      refreshAll();
    },
    onError: (e) => notify.err(e),
  });
  const openFund = () => {
    setFundReqId(newClientRequestId());
    setFundBranch(
      branchId !== ""
        ? Number(branchId)
        : isManager && me.data?.branchId != null
          ? Number(me.data.branchId)
          : "",
    );
    setFundAmount("");
    setFundDesc("");
    setFundNotes("");
    setFundOpen(true);
  };
  const fundAmountValid =
    /^\d+(\.\d{1,2})?$/.test(fundAmount) && Number(fundAmount) > 0;

  const movementCols: ColumnDef<MovementRow>[] = useMemo(
    () => [
      {
        header: "المستند والروابط",
        accessorKey: "id",
        cell: ({ row }) => (
          <div className="min-w-32 space-y-0.5 text-[11px]" dir="ltr">
            <div className="font-mono font-semibold">
              {row.original.source === "RECEIPT" ? "R" : "EXP"}#
              {row.original.rawId}
            </div>
            {row.original.voucherNumber && (
              <div className="font-mono">{row.original.voucherNumber}</div>
            )}
            <div className="flex flex-wrap gap-x-2 text-muted-foreground">
              {row.original.expenseId && (
                <span>EXP#{row.original.expenseId}</span>
              )}
              {row.original.invoiceId && (
                <span>INV#{row.original.invoiceId}</span>
              )}
              {row.original.workOrderId && (
                <span>WO#{row.original.workOrderId}</span>
              )}
              {row.original.reservationId && (
                <span>RSV#{row.original.reservationId}</span>
              )}
              {row.original.ledgerEntryId && (
                <span>JE#{row.original.ledgerEntryId}</span>
              )}
            </div>
            {row.original.referenceNumber && (
              <div
                className="max-w-44 truncate text-muted-foreground"
                title={row.original.referenceNumber}
              >
                مرجع: {row.original.referenceNumber}
              </div>
            )}
          </div>
        ),
      },
      {
        header: "الاتجاه والمبلغ",
        accessorKey: "amount",
        cell: ({ row }) => (
          <div className="space-y-1">
            <span
              className={
                row.original.direction === "IN"
                  ? "inline-flex items-center gap-1 text-money-positive"
                  : "inline-flex items-center gap-1 text-money-negative"
              }
            >
              {row.original.direction === "IN" ? (
                <ArrowDownLeft className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpRight className="h-3.5 w-3.5" />
              )}
              {row.original.direction === "IN" ? "وارد" : "صادر"}
            </span>
            <div className="tabular-nums font-bold" dir="ltr">
              {fmtAr(row.original.amount)}
            </div>
          </div>
        ),
      },
      {
        header: "البيان والمستفيد",
        accessorKey: "description",
        cell: ({ row }) => (
          <div className="max-w-64 space-y-1 text-xs">
            <p
              className={
                row.original.description
                  ? "line-clamp-2"
                  : "font-medium text-destructive"
              }
            >
              {row.original.description || "لا يوجد شرح للعملية"}
            </p>
            <p className="text-muted-foreground">
              الطرف: {row.original.partyName || row.original.expensePayee || "—"}
            </p>
            {(row.original.expenseCategory || row.original.costCenter) && (
              <p className="text-[11px] text-muted-foreground">
                {[row.original.expenseCategory, row.original.costCenter]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
        ),
      },
      {
        header: "المصدر / الوردية",
        accessorKey: "cashBucket",
        cell: ({ row }) => (
          <div className="min-w-40 space-y-1.5 text-xs">
            <FinancialSourceBadge
              compact
              source={row.original.cashBucket ?? row.original.paymentMethod}
              paymentMethod={row.original.paymentMethod}
              cashBucket={row.original.cashBucket}
            />
            <div>{row.original.branchName ?? "—"}</div>
            {row.original.cashBucket === "DRAWER" ? (
              <div className="text-[11px] text-muted-foreground">
                وردية #{row.original.shiftId ?? "—"} · صاحب الدرج:{" "}
                {row.original.shiftOwnerName ?? "غير موثق"}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                {row.original.cashBucket === "TREASURY"
                  ? "الخزينة الإدارية"
                  : "لا يوجد موقع نقدي"}
              </div>
            )}
          </div>
        ),
      },
      {
        header: "المسؤولية والاعتماد",
        accessorKey: "createdByName",
        cell: ({ row }) => (
          <div className="min-w-40 space-y-1 text-xs">
            <div>
              نفّذ:{" "}
              <span className="font-medium">
                {row.original.createdByName ?? "غير موثق"}
              </span>
              {row.original.createdBy != null && (
                <span
                  className="font-mono text-[10px] text-muted-foreground"
                  dir="ltr"
                >
                  {" "}
                  #{row.original.createdBy}
                </span>
              )}
            </div>
            <div className="text-muted-foreground">
              اعتمد: {row.original.approvedByName ?? "—"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {row.original.approvalStatus ?? "بلا مسار اعتماد"}
            </div>
          </div>
        ),
      },
      {
        header: "الحالة والتوقيت",
        accessorKey: "createdAt",
        cell: ({ row }) => (
          <div className="min-w-36 space-y-1 text-xs">
            <div className="font-medium">{row.original.status ?? "—"}</div>
            <div dir="ltr">
              {row.original.documentDate
                ? fmtDate(row.original.documentDate)
                : "—"}
            </div>
            <div className="text-[11px] text-muted-foreground" dir="ltr">
              نُفذت: {fmtDT(row.original.createdAt)}
            </div>
            {row.original.approvedAt && (
              <div className="text-[11px] text-muted-foreground" dir="ltr">
                اعتُمدت: {fmtDT(row.original.approvedAt)}
              </div>
            )}
          </div>
        ),
      },
      {
        header: "التدقيق",
        accessorKey: "integrityWarnings",
        cell: ({ row }) => (
          <div className="flex max-w-52 flex-wrap gap-1">
            {row.original.integrityWarnings.length ? (
              row.original.integrityWarnings.map((warning) => (
                <span
                  key={warning}
                  className="rounded-full badge-status-cancelled px-2 py-0.5 text-[10px]"
                >
                  {MOVEMENT_WARNING_LABEL[warning] ?? warning}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">سليم</span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  // تصدير «الكل» لجدول الحركات (لا صفحة العرض الحالية فقط ٢٠ صفّاً) — نفس فلاتر الفرع/المدى الحاليّة.
  async function exportMovements() {
    setMovExporting(true);
    try {
      const allRows = await fetchAllPaged<MovementRow>(
        (offset, limit) =>
          utils.treasury.getRecentMovements
            .fetch({
              limit,
              offset,
              branchId: branchId ? Number(branchId) : undefined,
              from: movFrom || undefined,
              to: movTo || undefined,
            })
            .then((r) => ({ rows: r.rows as MovementRow[] })),
        { pageSize: 100 },
      );
      exportRows(allRows, {
        filename: "حركات-الخزينة",
        columns: [
          {
            key: "source",
            header: "نوع المستند",
            map: (r) => (r.source === "RECEIPT" ? "إيصال" : "مصروف"),
          },
          { key: "rawId", header: "معرّف المستند", map: (r) => r.rawId },
          {
            key: "voucherNumber",
            header: "رقم السند",
            map: (r) => r.voucherNumber ?? "",
          },
          {
            key: "referenceNumber",
            header: "المرجع",
            map: (r) => r.referenceNumber ?? "",
          },
          {
            key: "invoiceId",
            header: "الفاتورة",
            map: (r) => r.invoiceId ?? "",
          },
          {
            key: "workOrderId",
            header: "أمر الشغل",
            map: (r) => r.workOrderId ?? "",
          },
          {
            key: "reservationId",
            header: "الحجز",
            map: (r) => r.reservationId ?? "",
          },
          {
            key: "expenseId",
            header: "المصروف",
            map: (r) => r.expenseId ?? "",
          },
          {
            key: "ledgerEntryId",
            header: "القيد المحاسبي",
            map: (r) => r.ledgerEntryId ?? "",
          },
          {
            key: "documentDate",
            header: "تاريخ المستند",
            map: (r) => (r.documentDate ? fmtDate(r.documentDate) : ""),
          },
          {
            key: "createdAt",
            header: "وقت التنفيذ",
            map: (r) => fmtDT(r.createdAt),
          },
          {
            key: "direction",
            header: "الاتجاه",
            map: (r) => (r.direction === "IN" ? "وارد" : "صادر"),
          },
          { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
          { key: "paymentMethodLabel", header: "الطريقة" },
          {
            key: "cashBucket",
            header: "مكان النقد",
            map: (r) =>
              r.cashBucket === "DRAWER"
                ? "درج"
                : r.cashBucket === "TREASURY"
                  ? "خزينة"
                  : "—",
          },
          {
            key: "branchName",
            header: "الفرع",
            map: (r) => r.branchName ?? "—",
          },
          { key: "shiftId", header: "الوردية", map: (r) => r.shiftId ?? "" },
          {
            key: "shiftOwnerName",
            header: "صاحب الدرج",
            map: (r) => r.shiftOwnerName ?? "",
          },
          {
            key: "description",
            header: "الوصف",
            map: (r) => r.description ?? "",
          },
          {
            key: "expensePayee",
            header: "الطرف / المستفيد",
            map: (r) => r.partyName ?? r.expensePayee ?? "",
          },
          {
            key: "expenseCategory",
            header: "الفئة",
            map: (r) => r.expenseCategory ?? "",
          },
          {
            key: "costCenter",
            header: "مركز التكلفة",
            map: (r) => r.costCenter ?? "",
          },
          {
            key: "createdByName",
            header: "نفّذ العملية",
            map: (r) =>
              r.createdByName ?? (r.createdBy ? `#${r.createdBy}` : ""),
          },
          {
            key: "approvedByName",
            header: "اعتمد العملية",
            map: (r) =>
              r.approvedByName ?? (r.approvedBy ? `#${r.approvedBy}` : ""),
          },
          {
            key: "approvalStatus",
            header: "حالة الاعتماد",
            map: (r) => r.approvalStatus ?? "",
          },
          {
            key: "approvedAt",
            header: "وقت الاعتماد",
            map: (r) => (r.approvedAt ? fmtDT(r.approvedAt) : ""),
          },
          { key: "status", header: "الحالة", map: (r) => r.status ?? "" },
          {
            key: "integrityWarnings",
            header: "ملاحظات التدقيق",
            map: (r) =>
              r.integrityWarnings
                .map((warning) => MOVEMENT_WARNING_LABEL[warning] ?? warning)
                .join("؛ "),
          },
        ],
      });
    } catch (e) {
      notify.err(e);
    } finally {
      setMovExporting(false);
    }
  }

  const totalDrawerAll = useMemo(
    () =>
      dashboard.data?.drawerBalances.reduce(
        (s, r) => s + Number(r.expectedCash),
        0,
      ) ?? 0,
    [dashboard.data],
  );
  const totalTreasuryAll = useMemo(
    () => sum(dashboard.data?.treasuryBalances.map((r) => r.balance) ?? []),
    [dashboard.data],
  );

  const comparisonRows = useMemo(() => {
    if (!dashboard.data) return [];
    const t = new Map<number, number>();
    for (const r of dashboard.data.treasuryBalances)
      t.set(r.branchId, Number(r.balance));
    return dashboard.data.drawerBalances.map((r) => ({
      branchId: r.branchId,
      branchName: r.branchName,
      drawer: Number(r.expectedCash),
      treasury: t.get(r.branchId) ?? 0,
    }));
  }, [dashboard.data]);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4" dir="rtl">
      {/* ═══ Header / Toolbar ═══ */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Vault className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight">لوحة الخزينة</h1>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              {dashboard.data?.generatedAt && (
                <span className="tabular-nums" dir="ltr">
                  آخر تحديث: {fmtRelativeShort(dashboard.data.generatedAt)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mr-auto flex flex-wrap items-center gap-2">
          {canChooseBranch && (branches.data?.length ?? 0) > 1 && (
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) =>
                setBranchId(e.target.value ? Number(e.target.value) : "")
              }
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <select
            className={selectCls}
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            {(["today", "yesterday", "week", "month"] as const).map((p) => (
              <option key={p} value={p}>
                {PERIOD_AR[p]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={refreshAll}
            title="تحديث"
          >
            <RefreshCcw className="h-3.5 w-3.5 me-1" />
            تحديث
          </Button>
        </div>
      </div>

      {/* ═══ شريط أزرار سريعة ═══ */}
      <div className="flex flex-wrap gap-2">
        <Link href="/vouchers/receipt/new">
          <Button size="sm" variant="default" className="gap-1.5">
            <ArrowDownLeft className="h-4 w-4" />
            سند قبض
          </Button>
        </Link>
        <Link href="/vouchers/payment/new">
          <Button size="sm" variant="outline" className="gap-1.5">
            <ArrowUpRight className="h-4 w-4" />
            سند صرف
          </Button>
        </Link>
        <Link href="/expenses/new">
          <Button size="sm" variant="outline" className="gap-1.5">
            <ReceiptIcon className="h-4 w-4" />
            مصروف يومي
          </Button>
        </Link>
        <Link href="/shifts">
          <Button size="sm" variant="ghost" className="gap-1.5">
            <Layers className="h-4 w-4" />
            الورديات
            <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
        {(isAdmin || isManager) && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={openFund}
            title="إيداع رأس مال / رصيد افتتاحيّ في الخزينة"
          >
            <Vault className="h-4 w-4" />
            تمويل الخزينة
          </Button>
        )}
      </div>

      {canGovernHandovers &&
        (pendingQueue.isLoading ||
          pendingQueue.isError ||
          (pendingQueue.data?.length ?? 0) > 0) && (
        <section className="rounded-md border p-4">
          <div className="mb-3 flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-bold">نقدٌ معلَّق لدى مستلمين (رقابة المدير)</h2>
              <p className="text-xs text-muted-foreground">
                عهدٌ خرجت من الأدراج ولم تدخل رصيد الخزينة بعد. إن تعذّر على المستلم قبولها
                (إجازة/تعطيل حساب) فأعِد إسنادها — المبلغ لا يتحرّك، يتغيّر المسؤول عن قبوله فقط.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <CustodyQueryNotice
              loading={pendingQueue.isLoading}
              error={pendingQueue.isError}
              loadingLabel="جارٍ تحميل طابور عهد الاستلام…"
              errorLabel="تعذّر تحميل طابور عهد الاستلام؛ لا يمكن افتراض عدم وجود عهد معلّقة."
              onRetry={() => void pendingQueue.refetch()}
            />
            {!pendingQueue.isLoading && !pendingQueue.isError && (
              <>
                <CustodyQueryNotice
                  loading={handoverRecipients.isLoading}
                  error={handoverRecipients.isError}
                  loadingLabel="جارٍ تحميل المستلمين المؤهلين…"
                  errorLabel="تعذّر تحميل قائمة المستلمين؛ أُوقفت إعادة الإسناد لحين نجاح التحميل."
                  onRetry={() => void handoverRecipients.refetch()}
                />
                <div className="grid gap-2">
                  {pendingQueue.data?.map((row) => (
                    <div
                      key={row.id}
                      className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold tabular-nums" dir="ltr">
                            {row.referenceNumber}
                          </span>
                          {row.ageDays >= 2 && (
                            <span className="rounded bg-[var(--sem-warn)]/15 px-1.5 py-0.5 text-xs text-[var(--sem-warn)]">
                              معلَّقة منذ {row.ageDays} يوماً
                            </span>
                          )}
                          {!row.assignedToActive && (
                            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
                              المستلم معطَّل
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          مُسنَدة إلى:{" "}
                          <span className="font-medium text-foreground">
                            {row.assignedToName ?? `#${row.assignedToId}`}
                          </span>
                          {row.sourceEmployeeName ? <> · من وردية {row.sourceEmployeeName}</> : null}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        المبلغ مخفي لحماية العد المستقل
                      </div>
                      <AppSelect
                        value=""
                        onValueChange={(v) => {
                          if (v) {
                            reassignHandover.mutate({ receiptId: row.id, toUserId: Number(v) });
                          }
                        }}
                        disabled={
                          reassignHandover.isPending ||
                          handoverRecipients.isLoading ||
                          handoverRecipients.isError
                        }
                        placeholder="إعادة إسناد إلى…"
                        className="w-48"
                        aria-label={`إعادة إسناد العهدة ${row.referenceNumber}`}
                      >
                        {(handoverRecipients.data ?? [])
                          // الخادم يحصر القائمة في فرع القارئ، والفلتر يبقيها مطابقةً لفرع العهدة أيضاً.
                          .filter(
                            (u) =>
                              Number(u.id) !== row.assignedToId &&
                              Number(u.branchId) === row.branchId,
                          )
                          .map((u) => (
                            <option key={u.id} value={String(u.id)}>
                              {u.name ?? `#${u.id}`}
                            </option>
                          ))}
                      </AppSelect>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {(pendingHandovers.isLoading ||
        pendingHandovers.isError ||
        (pendingHandovers.data?.length ?? 0) > 0) && (
        <section className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn)]/5 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-[var(--sem-warn)]" />
            <div>
              <h2 className="text-sm font-bold">عهد نقد بانتظار استلامك</h2>
              <p className="text-xs text-muted-foreground">
                لا يدخل المبلغ رصيد الخزينة حتى تؤكد أنك استلمته فعلياً.
              </p>
            </div>
          </div>
          <CustodyQueryNotice
            loading={pendingHandovers.isLoading}
            error={pendingHandovers.isError}
            loadingLabel="جارٍ تحميل عهد النقد المسندة إليك…"
            errorLabel="تعذّر تحميل عهد الاستلام المسندة إليك؛ لا يمكن افتراض عدم وجود عهد."
            onRetry={() => void pendingHandovers.refetch()}
          />
          {!pendingHandovers.isLoading && !pendingHandovers.isError && (
            <div className="grid gap-2">
              {pendingHandovers.data?.map((handover) => {
                const accepting =
                  acceptHandover.isPending &&
                  acceptHandover.variables?.receiptId === handover.id;
                return (
                  <div
                    key={handover.id}
                    className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold tabular-nums" dir="ltr">
                          {handover.referenceNumber}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {handover.source === "CASH_DROP"
                            ? "سحب أثناء الوردية"
                            : "تسليم إغلاق وردية"}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        <div>
                          الموظف الذي سُحب من ورديته:{" "}
                          <span className="font-medium text-foreground">
                            {handover.sourceEmployeeName ?? "غير مسجّل"}
                          </span>
                          {handover.sourceShiftId != null && (
                            <> · وردية #{handover.sourceShiftId}</>
                          )}
                        </div>
                        <div className="mt-0.5 tabular-nums" dir="ltr">
                          وقت السحب: {fmtDT(handover.createdAt)}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      المبلغ المعلن مخفي حتى العد المستقل
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setAcceptTarget(handover);
                        setAcceptBreakdown({});
                        setAcceptCounted("0.00");
                        setAcceptRequestId(newClientRequestId());
                      }}
                      disabled={acceptHandover.isPending}
                      className="gap-1.5"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {accepting ? "جارٍ القبول…" : "عدّ واستلام"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <Dialog open={acceptTarget != null} onOpenChange={(open) => { if (!open && !acceptHandover.isPending) setAcceptTarget(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>عدّ عهدة النقد {acceptTarget?.referenceNumber}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            عدّ الفئات فعلياً قبل المقارنة. إذا اختلف المجموع سيُحفظ الفرق وتبقى العهدة خارج الخزينة.
          </p>
          <CashCounter
            value={acceptBreakdown}
            onChange={(counts, total) => {
              setAcceptBreakdown(counts);
              setAcceptCounted(total);
            }}
            disabled={acceptHandover.isPending}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptTarget(null)} disabled={acceptHandover.isPending}>إلغاء</Button>
            <Button
              disabled={!acceptTarget || !acceptRequestId || acceptHandover.isPending}
              onClick={() => {
                if (!acceptTarget) return;
                acceptHandover.mutate({
                  receiptId: acceptTarget.id,
                  countedCash: acceptCounted,
                  countedBreakdown: Object.fromEntries(Object.entries(acceptBreakdown).map(([key, value]) => [String(key), value])),
                  clientRequestId: acceptRequestId,
                });
              }}
            >
              {acceptHandover.isPending ? "جارٍ حفظ العد…" : "حفظ العد ومحاولة القبول"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ صف ١: KPI cards ═══ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <TreasuryKpiCard
          icon={Wallet}
          label="النقد في الدروج"
          value={String(totalDrawerAll)}
          deltaPct={trends.data?.drawerTotal.deltaPct ?? null}
          deltaLabel="عن أمس"
          accent="green"
          loading={dashboard.isLoading || trends.isLoading}
        />
        {!hideTreasury && (
          <TreasuryKpiCard
            icon={Vault}
            label={
              branchId !== ""
                ? `النقد في خزينة ${branches.data?.find((b) => b.id === Number(branchId))?.name ?? "الفرع المحدد"}`
                : isAdmin
                  ? "النقد في الخزائن — إجمالي الفروع"
                  : "النقد في خزينة فرعك"
            }
            value={totalTreasuryAll}
            deltaPct={trends.data?.treasuryTotal.deltaPct ?? null}
            deltaLabel="مقابل قبل اليوم"
            accent="purple"
            loading={dashboard.isLoading || trends.isLoading}
          />
        )}
        <TreasuryKpiCard
          icon={Layers}
          label="ورديات مفتوحة"
          value={String(dashboard.data?.openShiftsCount ?? 0)}
          rawNumeric
          deltaPct={trends.data?.openShifts.deltaPct ?? null}
          deltaLabel="مقابل أمس"
          accent="blue"
          suffix="وردية"
          loading={dashboard.isLoading || trends.isLoading}
        />
        <TreasuryKpiCard
          icon={ArrowDownLeft}
          label="مقبوضات اليوم"
          value={dashboard.data?.todayReceiptsTotal ?? "0"}
          deltaPct={trends.data?.todayReceipts.deltaPct ?? null}
          deltaLabel="عن أمس"
          accent="green"
          sparkline={trends.data?.todayReceipts.sparkline}
          loading={dashboard.isLoading || trends.isLoading}
        />
        <TreasuryKpiCard
          icon={ArrowUpRight}
          label="مصروفات اليوم"
          value={dashboard.data?.todayExpensesTotal ?? "0"}
          deltaPct={trends.data?.todayExpenses.deltaPct ?? null}
          deltaLabel="عن أمس"
          accent="red"
          sparkline={trends.data?.todayExpenses.sparkline}
          loading={dashboard.isLoading || trends.isLoading}
        />
      </div>

      {/* ═══ صف ٢: المخطّط الزمني + الدونات ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          <CashFlowChart
            data={cashFlow.data ?? []}
            loading={cashFlow.isLoading}
          />
        </div>
        <div>
          <PaymentMethodDonut
            data={breakdown.data ?? []}
            loading={breakdown.isLoading}
            direction="in"
          />
        </div>
      </div>

      {/* ═══ صف ٣: بطاقات الفروع ═══ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {dashboard.isLoading
          ? [1, 2].map((i) => (
              <div key={i} className="rounded-md border p-5 animate-pulse">
                <div className="h-9 w-9 rounded-lg bg-muted mb-3" />
                <div className="h-3 w-32 bg-muted rounded mb-3" />
                <div className="h-16 bg-muted rounded" />
              </div>
            ))
          : (dashboard.data?.drawerBalances ?? []).map((dr) => {
              const tr = dashboard.data?.treasuryBalances.find(
                (t) => t.branchId === dr.branchId,
              );
              const branchType = (branches.data?.find(
                (b) => b.id === dr.branchId,
              )?.type ?? null) as "MAIN" | "SALES" | null;
              const alerts: Array<{
                severity: "warning" | "danger" | "info";
                text: string;
              }> = [];
              if (dr.openShiftsCount === 0) {
                alerts.push({
                  severity: "info",
                  text: "لا ورديات مفتوحة في هذا الفرع الآن",
                });
              }
              if (!hideTreasury && tr && Number(tr.balance) < 0) {
                alerts.push({
                  severity: "danger",
                  text: `رصيد الخزينة سالب (${fmtAr(tr.balance)})`,
                });
              }
              return (
                <BranchBalanceCard
                  key={dr.branchId}
                  branchId={dr.branchId}
                  branchName={dr.branchName}
                  branchTypeBadge={branchType ?? undefined}
                  drawer={{
                    expected: dr.expectedCash,
                    opening: dr.totalOpening,
                    openShifts: dr.openShiftsCount,
                  }}
                  treasury={
                    !hideTreasury && tr ? { balance: tr.balance } : null
                  }
                  alerts={alerts}
                />
              );
            })}
      </div>

      {/* ═══ صف ٤: مقارنة الفروع ═══ */}
      {comparisonRows.length >= 2 && (
        <BranchComparisonChart
          data={comparisonRows}
          showTreasury={!hideTreasury}
          loading={dashboard.isLoading}
        />
      )}

      {/* ═══ صف ٥: جدول الحركات + الورديات ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <div className="rounded-md border bg-card p-4 lg:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-semibold">آخر الحركات النقدية</h3>
            <span className="text-xs text-muted-foreground">
              <Building2 className="inline h-3 w-3" />{" "}
              {branchId
                ? branches.data?.find((b) => b.id === branchId)?.name
                : "كل الفروع المرئيّة"}
            </span>
          </div>
          {/* مدى تاريخ اختياري — بلا فلتر يبقى السلوك القديم (آخر ٢٠ حركة). */}
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">
                من تاريخ
              </label>
              <Input
                type="date"
                dir="ltr"
                className="h-8 w-36"
                value={movFrom}
                onChange={(e) => {
                  const v = e.target.value;
                  setMovFrom(v);
                  if (v && movTo && v > movTo) setMovTo(v);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">
                إلى تاريخ
              </label>
              <Input
                type="date"
                dir="ltr"
                className="h-8 w-36"
                value={movTo}
                onChange={(e) => {
                  const v = e.target.value;
                  setMovTo(v);
                  if (v && movFrom && v < movFrom) setMovFrom(v);
                }}
              />
            </div>
            {(movFrom || movTo) && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1"
                onClick={() => {
                  setMovFrom("");
                  setMovTo("");
                }}
              >
                <X className="h-3 w-3" />
                مسح المدى
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mr-auto"
              disabled={movExporting || !movements.data?.rows.length}
              onClick={() => void exportMovements()}
            >
              {movExporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
          </div>
          <DataTable
            data={movements.data?.rows ?? []}
            columns={movementCols}
            loading={movements.isLoading}
            emptyText="لا حركات بعد."
            searchable={false}
            pageSize={MOV_PAGE}
          />
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span dir="ltr">
              {movPage * MOV_PAGE + 1}–
              {movPage * MOV_PAGE + (movements.data?.rows.length ?? 0)}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={movPage === 0}
                onClick={() => setMovPage((p) => Math.max(0, p - 1))}
              >
                السابق
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!movements.data?.hasMore}
                onClick={() => setMovPage((p) => p + 1)}
              >
                التالي
              </Button>
            </div>
          </div>
        </div>
        <div className="lg:col-span-4">
          <OpenShiftsPanel
            shifts={openShifts.data ?? []}
            loading={openShifts.isLoading}
          />
        </div>
      </div>

      {/* تمويل الخزينة (imprest، ٢٨/٧/٢٦) — إيداع رأس مال / رصيد افتتاحيّ يُموّل عهد الورديات. */}
      {fundOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          dir="rtl"
          onClick={() => setFundOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label="تمويل الخزينة"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2">
              <Vault className="h-5 w-5 text-primary" />
              <h2 className="text-base font-bold">تمويل الخزينة</h2>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              إيداع رأس مال / رصيد افتتاحيّ في خزينة الفرع — يُموّل عهد
              الورديات. يُسجَّل بسند وقيدٍ للتدقيق.
            </p>
            <div className="grid gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  الفرع
                </label>
                {isAdmin ? (
                  <select
                    className={selectCls + " w-full"}
                    value={fundBranch}
                    onChange={(e) =>
                      setFundBranch(
                        e.target.value ? Number(e.target.value) : "",
                      )
                    }
                  >
                    <option value="">— اختر الفرع —</option>
                    {(branches.data ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    {(branches.data ?? []).find(
                      (b) => Number(b.id) === Number(fundBranch),
                    )?.name ?? (fundBranch ? `فرع #${fundBranch}` : "—")}
                  </div>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  المبلغ (د.ع)
                </label>
                <MoneyInput
                  value={fundAmount}
                  onChange={setFundAmount}
                  placeholder="0"
                  className={selectCls + " w-full text-right font-bold"}
                  ariaLabel="مبلغ تمويل الخزينة"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  التبرير / المصدر (إلزامي)
                </label>
                <input
                  value={fundDesc}
                  maxLength={500}
                  placeholder="مثال: إيداع رأس مال أوّليّ من المالك"
                  onChange={(e) => setFundDesc(e.target.value)}
                  className={selectCls + " w-full"}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  ملاحظة (اختياري)
                </label>
                <input
                  value={fundNotes}
                  maxLength={500}
                  onChange={(e) => setFundNotes(e.target.value)}
                  className={selectCls + " w-full"}
                />
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setFundOpen(false)}
              >
                إلغاء
              </Button>
              <Button
                className="flex-1"
                disabled={
                  fundTreasuryM.isPending ||
                  !fundBranch ||
                  !fundAmountValid ||
                  !fundDesc.trim()
                }
                onClick={() =>
                  fundTreasuryM.mutate({
                    branchId: Number(fundBranch),
                    amount: fundAmount,
                    description: fundDesc.trim(),
                    notes: fundNotes.trim() || null,
                    clientRequestId: fundReqId,
                  })
                }
              >
                {fundTreasuryM.isPending ? "جارٍ التمويل…" : "تمويل الخزينة"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
