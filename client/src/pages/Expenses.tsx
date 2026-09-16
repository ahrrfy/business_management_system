import { RowActions } from "@/components/list";
import { useFocusHighlight } from "@/components/search/useFocusHighlight";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows, type ExportColumn } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc } from "@/lib/trpc";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import {
  AlertTriangle,
  Ban,
  Building2,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDollarSign,
  Landmark,
  Layers3,
  Loader2,
  Printer,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  expenseStatusFromSearch,
  isExpenseFinanciallyPrintable,
} from "@/lib/expenseUiPolicy";
import { selectClsFull } from "@/lib/ui/formStyles";


// المساعدات والأنواع والمكوّنات مستخرَجة إلى components/expenses/ (ترشيق الصفحة).
import { ExpenseTracePanel } from "@/components/expenses/ExpenseTracePanel";
import { printExpenseReceipt } from "@/components/expenses/printExpenseReceipt";
import {
  APPROVAL_LABEL,
  CATEGORY_LABEL,
  expenseCategoryText,
  fundingDetail,
  fundingKindOf,
  FUNDING_META,
  FUNDING_ORDER,
  METHOD_LABEL,
  metric,
  PAGE_SIZE,
  SHIFT_STATUS_LABEL,
  SHIFT_TYPE_LABEL,
  sourceLabel,
  STATUS_CLS,
  STATUS_LABEL,
  warningsOf,
  type AuditFocus,
  type ExpenseRow,
  type ExpenseTotals,
} from "@/components/expenses/expenseView";
import { ExpenseRejectDialog } from "@/components/expenses/ExpenseRejectDialog";
import { ExpenseCorrectionDialog } from "@/components/expenses/ExpenseCorrectionDialog";

export default function Expenses() {
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const [category, setCategory] = useState<string>("");
  // الفئة التفصيلية المُدارة (0203) — فلترٌ أدقّ من الدلو («وقود» وحده لا كل «مواصلات/شحن»).
  const [expenseCategoryId, setExpenseCategoryId] = useState<string>("");
  const expenseCategoryOptions = trpc.expenses.categories.list.useQuery({
    includeInactive: true,
  });
  const [status, setStatus] = useState<string>(() =>
    typeof window === "undefined"
      ? ""
      : expenseStatusFromSearch(window.location.search),
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<ExpenseRow | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<ExpenseRow | null>(
    null,
  );
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [auditOnly, setAuditOnly] = useState(false);
  const [auditFocus, setAuditFocus] = useState<AuditFocus | null>(null);
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedTraces, setExpandedTraces] = useState<Set<number>>(
    () => new Set(),
  );
  // الترقيم خادميّ: كانت تُحمَّل أحدث ٣٠٠ دفعةً والباقي غير قابل للوصول (بينما التصدير يرى الكل
  // ⇒ تناقض صامت بين ملف Excel والشاشة). الآن صفحة صفحة، والتصدير يبقى شاملاً صراحةً.
  const [page, setPage] = useState(0);
  // إبراز المصروف القادم من البحث الشامل (?focus=) — القائمة تُحمَّل أحدث ٣٠٠، فالأقرب زمنياً يُبرَز.
  const { rowProps } = useFocusHighlight();

  // البحث خادمي الآن (q ممهَّل): البيان/المرجع/المستفيد عبر كل النتائج لا المُحمَّل فقط.
  const dq = useDebouncedValue(query, 250);
  const listInput = {
    branchId: branchId ? Number(branchId) : undefined,
    category: (category || undefined) as any,
    expenseCategoryId: expenseCategoryId ? Number(expenseCategoryId) : undefined,
    status: (status || undefined) as any,
    from: from || undefined,
    to: to || undefined,
    paymentMethod: (paymentMethod || undefined) as any,
    source: (source || undefined) as any,
    q: dq.trim() || undefined,
  };
  function resetFilters() {
    setBranchId("");
    setCategory("");
    setExpenseCategoryId("");
    setStatus("");
    setFrom("");
    setTo("");
    setPaymentMethod("");
    setSource("");
    setQuery("");
    setAuditOnly(false);
    setAuditFocus(null);
  }
  const list = trpc.expenses.list.useQuery({
    ...listInput,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const rows = (list.data?.rows ?? []) as ExpenseRow[];
  const totals = (list.data?.totals ?? {}) as ExpenseTotals;
  const total = Number(totals.count ?? 0);

  const rowsWithWarnings = useMemo(
    () =>
      rows.map((row) => ({
        row,
        warnings: warningsOf(row),
        funding: fundingKindOf(row),
      })),
    [rows],
  );
  const pageNeedsAudit = rowsWithWarnings.filter(
    (entry) => entry.warnings.length > 0,
  ).length;
  const auditBreakdown = useMemo(
    () => ({
      DESCRIPTION: rowsWithWarnings.filter(
        ({ row }) => !row.description?.trim(),
      ).length,
      PAYEE: rowsWithWarnings.filter(({ row }) => !row.payee?.trim()).length,
      SOURCE: rowsWithWarnings.filter(({ row }) =>
        (row.integrityWarnings ?? []).some(
          (warning) =>
            warning !== "DESCRIPTION_MISSING" && warning !== "PAYEE_MISSING",
        ),
      ).length,
      DRAWER: rowsWithWarnings.filter(
        ({ row, funding }) =>
          funding === "DRAWER" &&
          (row.shiftId == null || row.receiptId == null),
      ).length,
    }),
    [rowsWithWarnings],
  );
  const visibleEntries = auditFocus
    ? rowsWithWarnings.filter(({ row, funding }) => {
        if (auditFocus === "DESCRIPTION") return !row.description?.trim();
        if (auditFocus === "PAYEE") return !row.payee?.trim();
        if (auditFocus === "DRAWER")
          return (
            funding === "DRAWER" &&
            (row.shiftId == null || row.receiptId == null)
          );
        return (row.integrityWarnings ?? []).some(
          (warning) =>
            warning !== "DESCRIPTION_MISSING" && warning !== "PAYEE_MISSING",
        );
      })
    : auditOnly
      ? rowsWithWarnings.filter((entry) => entry.warnings.length > 0)
      : rowsWithWarnings;
  const groupedRows = useMemo(
    () =>
      FUNDING_ORDER.map((kind) => ({
        kind,
        entries: visibleEntries.filter((entry) => entry.funding === kind),
      })).filter((group) => group.entries.length > 0),
    [visibleEntries],
  );

  function toggleDescription(id: number) {
    setExpandedDescriptions((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTrace(id: number) {
    setExpandedTraces((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeChips = [
    query.trim()
      ? { key: "q", label: `بحث: ${query.trim()}`, clear: () => setQuery("") }
      : null,
    branchId
      ? {
          key: "branch",
          label: `الفرع: ${branches.data?.find((branch) => Number(branch.id) === Number(branchId))?.name ?? branchId}`,
          clear: () => setBranchId(""),
        }
      : null,
    category
      ? {
          key: "category",
          label: `الدلو: ${CATEGORY_LABEL[category] ?? category}`,
          clear: () => setCategory(""),
        }
      : null,
    expenseCategoryId
      ? {
          key: "expenseCategoryId",
          label: `الفئة: ${
            (expenseCategoryOptions.data ?? []).find(
              (c) => String(c.id) === expenseCategoryId,
            )?.name ?? expenseCategoryId
          }`,
          clear: () => setExpenseCategoryId(""),
        }
      : null,
    status
      ? {
          key: "status",
          label: `الحالة: ${STATUS_LABEL[status] ?? status}`,
          clear: () => setStatus(""),
        }
      : null,
    from
      ? { key: "from", label: `من: ${fmtDate(from)}`, clear: () => setFrom("") }
      : null,
    to
      ? { key: "to", label: `إلى: ${fmtDate(to)}`, clear: () => setTo("") }
      : null,
    paymentMethod
      ? {
          key: "method",
          label: `الدفع: ${METHOD_LABEL[paymentMethod] ?? paymentMethod}`,
          clear: () => setPaymentMethod(""),
        }
      : null,
    source
      ? {
          key: "source",
          label: `المصدر: ${source === "STOCK" ? "مخزون" : "مالي"}`,
          clear: () => setSource(""),
        }
      : null,
    auditOnly
      ? {
          key: "audit",
          label: "يحتاج تدقيقاً — الصفحة الحالية",
          clear: () => setAuditOnly(false),
        }
      : null,
    auditFocus
      ? {
          key: "audit-focus",
          label: `استثناء: ${
            auditFocus === "DESCRIPTION"
              ? "بلا شرح"
              : auditFocus === "PAYEE"
                ? "بلا مستفيد"
                : auditFocus === "SOURCE"
                  ? "مصدر أو إيصال غير متطابق"
                  : "درج أو وردية ناقصة"
          }`,
          clear: () => setAuditFocus(null),
        }
      : null,
  ].filter(
    (chip): chip is { key: string; label: string; clear: () => void } =>
      chip != null,
  );

  // أي تغيير في الفلاتر/البحث يعيدنا للصفحة الأولى (وإلا offset قديم على مجموعة أصغر = صفحة فارغة).
  const filterKey = JSON.stringify(listInput);
  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  // أعمدة التصدير (مشتركة بين زرّ التصدير وجلب-الكل).
  const exportColumns: ExportColumn<ExpenseRow>[] = [
    { key: "id", header: "رقم المصروف", map: (r) => Number(r.id) },
    {
      key: "receiptVoucherNumber",
      header: "رقم السند",
      map: (r) => r.receiptVoucherNumber ?? "",
    },
    { key: "receiptId", header: "رقم الإيصال", map: (r) => r.receiptId ?? "" },
    {
      key: "expenseDate",
      header: "التاريخ",
      map: (r) => fmtDate(r.expenseDate as unknown as string),
    },
    {
      key: "createdAt",
      header: "وقت التسجيل",
      map: (r) => fmtDateTime(r.createdAt as unknown as string),
    },
    {
      key: "updatedAt",
      header: "آخر تحديث",
      map: (r) => fmtDateTime(r.updatedAt as unknown as string),
    },
    { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
    {
      key: "category",
      header: "الفئة",
      map: (r) => expenseCategoryText(r),
    },
    {
      key: "costCenter",
      header: "مركز التكلفة",
      map: (r) => r.costCenter ?? "",
    },
    { key: "description", header: "الوصف", map: (r) => r.description ?? "" },
    { key: "payee", header: "المستفيد", map: (r) => r.payee ?? "" },
    {
      key: "referenceNumber",
      header: "المرجع",
      map: (r) => r.referenceNumber ?? "",
    },
    {
      key: "paymentMethod",
      header: "طريقة الدفع",
      map: (r) => METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod,
    },
    {
      key: "fundingKind",
      header: "مصدر التمويل",
      map: (r) => FUNDING_META[fundingKindOf(r)].short,
    },
    {
      key: "source",
      header: "نوع المصدر الخام",
      map: (r) => r.source ?? "",
    },
    {
      key: "cashBucket",
      header: "وعاء النقد الخام",
      map: (r) => r.cashBucket ?? "",
    },
    { key: "fundingDetail", header: "تفصيل مصدر التمويل", map: fundingDetail },
    {
      key: "settlementStatus",
      header: "حالة تسوية الاستحقاق",
      map: (r) => r.settlementStatus ?? "",
    },
    {
      key: "accrualObligationId",
      header: "رقم التزام الاستحقاق",
      map: (r) => r.accrualObligationId ?? "",
    },
    {
      key: "accrualEvidenceReference",
      header: "مرجع دليل الاعتراف",
      map: (r) => r.accrualEvidenceReference ?? "",
    },
    {
      key: "recognitionAccountingEntryId",
      header: "قيد الاعتراف",
      map: (r) => r.recognitionAccountingEntryId ?? "",
    },
    {
      key: "settlementReceiptId",
      header: "سند التسوية",
      map: (r) => r.settlementReceiptId ?? "",
    },
    {
      key: "settlementAccountingEntryId",
      header: "قيد التسوية",
      map: (r) => r.settlementAccountingEntryId ?? "",
    },
    { key: "shiftId", header: "رقم الوردية", map: (r) => r.shiftId ?? "" },
    {
      key: "shiftOwnerName",
      header: "صاحب الدرج",
      map: (r) => r.shiftOwnerName ?? "",
    },
    {
      key: "shiftType",
      header: "نوع الوردية",
      map: (r) =>
        r.shiftType ? (SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType) : "",
    },
    {
      key: "shiftStatus",
      header: "حالة الوردية",
      map: (r) =>
        r.shiftStatus
          ? (SHIFT_STATUS_LABEL[r.shiftStatus] ?? r.shiftStatus)
          : "",
    },
    {
      key: "createdByName",
      header: "أنشأ العملية",
      map: (r) =>
        r.createdByName ?? (r.createdBy != null ? `#${r.createdBy}` : ""),
    },
    {
      key: "approvedByName",
      header: "اعتمد العملية",
      map: (r) => r.approvedByName ?? "",
    },
    {
      key: "approvalStatus",
      header: "حالة الاعتماد",
      map: (r) =>
        r.approvalStatus
          ? (APPROVAL_LABEL[r.approvalStatus] ?? r.approvalStatus)
          : "",
    },
    {
      key: "receiptStatus",
      header: "حالة الإيصال",
      map: (r) => r.receiptStatus ?? "",
    },
    {
      key: "integrityWarnings",
      header: "ملاحظات التدقيق",
      map: (r) => warningsOf(r).join("؛ "),
    },
    { key: "amount", header: "المبلغ", map: (r) => Number(r.amount) },
    {
      key: "status",
      header: "الحالة",
      map: (r) => STATUS_LABEL[r.status] ?? r.status,
    },
  ];

  // تصدير كل النتائج المطابقة (لا الصفحة المحمَّلة): يكرّر عبر offset حتى تنضب (بلا اقتطاع).
  async function exportAll() {
    setExporting(true);
    try {
      const all = await fetchAllPaged<ExpenseRow>(
        (offset, limit) =>
          utils.expenses.list
            .fetch({ ...listInput, limit, offset })
            .then((res) => ({ rows: res.rows ?? [], total: res.totals.count })),
        { pageSize: 1000 },
      );
      if (!all.length) {
        notify.err("لا بيانات للتصدير");
        return;
      }
      exportRows(all, { filename: "المصروفات", columns: exportColumns });
    } catch (e) {
      notify.err(e);
    } finally {
      setExporting(false);
    }
  }

  // طباعة قائمة المصروفات — كل النتائج المطابقة للفلتر (fetchAllPaged) لا الصفحة المعروضة فقط.
  async function printAll() {
    setPrinting(true);
    try {
      const all = await fetchAllPaged<ExpenseRow>(
        (offset, limit) =>
          utils.expenses.list
            .fetch({ ...listInput, limit, offset })
            .then((res) => ({ rows: res.rows ?? [], total: res.totals.count })),
        { pageSize: 1000 },
      );
      const printable = all.filter((row) =>
        isExpenseFinanciallyPrintable(row.status),
      );
      if (!printable.length) {
        notify.err(
          "لا توجد مصروفات نافذة للطباعة؛ الطلبات المعلّقة والمرفوضة لا تُطبع كسند صرف",
        );
        return;
      }
      const filterLabels = [
        branchId
          ? `الفرع: ${branches.data?.find((b) => b.id === branchId)?.name ?? branchId}`
          : null,
        category ? `الدلو: ${CATEGORY_LABEL[category] ?? category}` : null,
        expenseCategoryId
          ? `الفئة: ${
              (expenseCategoryOptions.data ?? []).find(
                (c) => String(c.id) === expenseCategoryId,
              )?.name ?? expenseCategoryId
            }`
          : null,
        status ? `الحالة: ${STATUS_LABEL[status] ?? status}` : null,
        paymentMethod
          ? `طريقة الدفع: ${METHOD_LABEL[paymentMethod] ?? paymentMethod}`
          : null,
        source ? `المصدر: ${source === "STOCK" ? "مخزون" : "نقدي"}` : null,
        from || to ? `الفترة: ${from || "البداية"} — ${to || "اليوم"}` : null,
        query.trim() ? `بحث: ${query.trim()}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const printTotal = printable.reduce(
        (sum, row) => sum.plus(D(row.amount)),
        D(0),
      );
      const opened = printReportDoc({
        title: "المصروفات اليومية",
        headerExtra: filterLabels
          ? [{ label: "الفلاتر", value: filterLabels }]
          : [],
        columns: [
          { key: "identity", label: "المصروف / السند" },
          { key: "date", label: "التاريخ / التسجيل" },
          { key: "branch", label: "الفرع" },
          { key: "category", label: "الفئة / المركز" },
          { key: "description", label: "البيان / المستفيد" },
          { key: "funding", label: "التمويل / الدفع" },
          { key: "shift", label: "الدرج / الوردية" },
          { key: "actors", label: "المنشئ / المعتمد" },
          { key: "amount", label: "المبلغ", align: "left" },
          { key: "status", label: "الحالة" },
          { key: "audit", label: "ملاحظات التدقيق" },
        ],
        rows: printable.map((r) => ({
          identity: `#${Number(r.id)}${r.receiptVoucherNumber ? ` / ${r.receiptVoucherNumber}` : r.receiptId ? ` / R#${r.receiptId}` : ""}`,
          date: `${fmtDate(r.expenseDate as unknown as string)} / ${fmtDateTime(r.createdAt as unknown as string)}`,
          branch: r.branchName ?? "—",
          category: `${expenseCategoryText(r)}${r.costCenter ? ` / ${r.costCenter}` : ""}`,
          description: `${r.description ?? "لا يوجد شرح"}${r.payee ? ` / المستفيد: ${r.payee}` : ""}${r.referenceNumber ? ` / مرجع: ${r.referenceNumber}` : ""}`,
          funding: `${FUNDING_META[fundingKindOf(r)].short} / ${sourceLabel(r)}`,
          shift: fundingDetail(r),
          actors: `${r.createdByName ?? (r.createdBy != null ? `#${r.createdBy}` : "—")}${r.approvedByName ? ` / اعتماد: ${r.approvedByName}` : ""}`,
          amount: fmt(r.amount),
          status: STATUS_LABEL[r.status] ?? r.status,
          audit: warningsOf(r).join("؛ ") || "سليم",
        })),
        summary: [
          {
            label: "إجمالي المصروفات النافذة فقط",
            value: `${fmt(printTotal.toString())} د.ع`,
            large: true,
            bold: true,
          },
        ],
      });
      if (!opened)
        notify.err(
          "حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.",
        );
    } catch (e) {
      notify.err(e);
    } finally {
      setPrinting(false);
    }
  }

  // الإلغاء = expensesManagerProcedure(["manager"], "expenses", "FULL") — نُخفي الزرّ عمّن يرفضه
  // الخادم (كاشير/محاسب: إدخالٌ بلا إلغاء) بنفس دالة الخادم moduleAccessAllowed ⇒ لا تباعُد.
  const me = trpc.auth.me.useQuery();
  const canCancel =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "expenses",
      "FULL",
      ["manager"],
    );
  const canApprove = me.data?.isOwner === true;

  const cancel = trpc.expenses.cancel.useMutation({
    onSuccess: async () => {
      await utils.expenses.list.invalidate();
    },
  });
  const approve = trpc.expenses.approve.useMutation({
    onSuccess: async (_result, variables) => {
      await Promise.all([
        utils.expenses.list.invalidate(),
        utils.expenses.trace.invalidate({ expenseId: variables.expenseId }),
      ]);
      notify.ok("تم اعتماد المصروف وتنفيذه ذرياً");
    },
    onError: (error) => notify.err(error),
  });
  function actionsFor(r: ExpenseRow) {
    return [
      {
        key: "print",
        kind: "print" as const,
        label: "طباعة إيصال صرف",
        onSelect: () => void printExpenseReceipt(r),
        hidden:
          !isExpenseFinanciallyPrintable(r.status) || r.source === "ACCRUAL",
        gate: { module: "expenses" as const, level: "READ" as const },
      },
      {
        key: "approve",
        kind: "approve" as const,
        icon: CircleCheck,
        label: "اعتماد وصرف",
        // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — canApprove أصلاً يشترط
        // isOwner، فاستثناءُ صانع الطلب هنا كان يحجب الاعتماد الذاتي المسموح به خادمياً.
        hidden: r.status !== "PENDING_APPROVAL" || !canApprove,
        disabled: approve.isPending,
        disabledReason: "توجد عملية اعتماد قيد التنفيذ",
        onSelect: () =>
          void (async () => {
            if (
              !(await confirm({
                variant: "warning",
                title: "اعتماد وصرف المصروف",
                description:
                  r.paymentMethod === "CASH"
                    ? `سيُسحب ${fmt(r.amount)} د.ع من خزينة الفرع ويُنشأ القيد والإيصال كعملية ذرية واحدة. هل تتابع؟`
                    : `سيُنفذ المصروف غير النقدي ${fmt(r.amount)} د.ع ويُنشأ القيد والإيصال كعملية ذرية واحدة. هل تتابع؟`,
                confirmText: "اعتماد وصرف",
                cancelText: "تراجع",
              }))
            )
              return;
            approve.mutate({ expenseId: Number(r.id) });
          })(),
      },
      {
        key: "reject",
        kind: "cancel" as const,
        icon: Ban,
        label: "رفض الطلب",
        variant: "destructive" as const,
        hidden: r.status !== "PENDING_APPROVAL" || !canApprove,
        disabled: approve.isPending,
        disabledReason: "توجد عملية اعتماد قيد التنفيذ",
        onSelect: () => {
          setRejectTarget(r);
        },
      },
      {
        key: "correct-source",
        kind: "reverse" as const,
        label: "تصحيح المصدر",
        variant: "destructive" as const,
        hidden:
          r.status !== "ACTIVE" ||
          r.source !== "ACCRUAL" ||
          r.accrualObligationId == null ||
          ![
            "ACCRUED_UNPAID",
            "PAYMENT_PENDING",
            "PAID",
            "CORRECTION_PENDING",
            "REFUND_PENDING",
          ].includes(r.settlementStatus ?? "") ||
          !canCancel,
        onSelect: () => {
          setCorrectionTarget(r);
        },
        gate: {
          roles: ["manager"] as RoleKey[],
          module: "expenses" as const,
          level: "FULL" as const,
        },
      },
      {
        key: "cancel",
        kind: "reverse" as const,
        label: "إلغاء",
        variant: "destructive" as const,
        hidden: r.status !== "ACTIVE" || r.source === "ACCRUAL" || !canCancel,
        disabled: cancel.isPending,
        disabledReason: "توجد عملية إلغاء قيد التنفيذ",
        onSelect: () =>
          void (async () => {
            if (
              !(await confirm({
                variant: "warning",
                title: "إلغاء المصروف",
                description:
                  r.source === "STOCK"
                    ? `ستُعاد المنتجات (${fmt(r.amount)} د.ع كلفةً) إلى المخزون ويُعكس القيد. هل تتابع؟`
                    : r.paymentMethod === "CASH"
                      ? `سيُعاد مبلغ ${fmt(r.amount)} د.ع إلى ${r.cashBucket === "DRAWER" ? "درج الوردية" : "خزينة الفرع"} ويُسجَّل قيد محاسبي عكسي. هل تتابع؟`
                      : `سيُعكس مبلغ ${fmt(r.amount)} د.ع محاسبياً بطريقة الدفع المسجّلة من دون مسّ الدرج أو الخزينة النقدية. هل تتابع؟`,
                confirmText: "إلغاء المصروف",
                cancelText: "تراجع",
              }))
            )
              return;
            cancel.mutate({ expenseId: Number(r.id) });
          })(),
        gate: {
          roles: ["manager"] as RoleKey[],
          module: "expenses" as const,
          level: "FULL" as const,
        },
      },
    ];
  }


  // أموال العرض عبر fmt من @/lib/money (فواصل آلاف + منزلتان) — بديل الدالة المحلية السابقة.
  return (
    <div className="space-y-3">
      <PageHeader
        title="المصروفات اليومية"
        description="النقدي الصغير الممول يُنفذ من درج المنشئ؛ سائر الطلبات تبقى بلا أثر حتى اعتماد مالك آخر، والنقدي المعتمد وحده يُصرف من الخزينة."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={printing || (list.data?.totals.count ?? 0) === 0}
              onClick={() => void printAll()}
            >
              {printing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Printer className="size-4" />
              )}
              {printing ? "جارٍ التحضير…" : "طباعة قائمة"}
            </Button>
            <Button
              variant="outline"
              disabled={exporting || (list.data?.totals.count ?? 0) === 0}
              onClick={() => void exportAll()}
            >
              {exporting ? <Loader2 className="size-4 animate-spin" /> : null}
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
            <Link href="/expenses/new">
              <Button>+ مصروف جديد</Button>
            </Link>
          </div>
        }
      />

      <section
        aria-label="ملخص المصروفات"
        className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">إجمالي النافذ</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {metric(totals.active ?? 0)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {Number(totals.count ?? 0).toLocaleString("ar-IQ-u-nu-latn")}{" "}
                عملية ضمن الفلتر
              </p>
            </div>
            <span className="rounded-lg bg-primary/10 p-1.5 text-primary">
              <CircleDollarSign aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">من الأدراج</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {metric(totals.drawer)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                غير نقدي: <span dir="ltr">{metric(totals.nonCash)}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                مستحق غير مدفوع:{" "}
                <span dir="ltr">{metric(totals.accruedUnpaid)}</span>
              </p>
            </div>
            <span className="rounded-lg bg-[var(--sem-pos-bg)] p-1.5 text-[var(--sem-pos)]">
              <WalletCards aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">من الخزينة</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {metric(totals.treasury)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                من المخزون: <span dir="ltr">{metric(totals.stock)}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                استحقاق مسوّى:{" "}
                <span dir="ltr">{metric(totals.accruedPaid)}</span>
              </p>
            </div>
            <span className="rounded-lg bg-[var(--sem-info-bg)] p-1.5 text-[var(--sem-info)]">
              <Landmark aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-3 p-3">
            <div>
              <p className="text-xs text-muted-foreground">يحتاج تدقيقاً</p>
              <p className="mt-0.5 text-xl font-bold tabular-nums" dir="ltr">
                {Number(totals.needsAudit ?? pageNeedsAudit).toLocaleString(
                  "ar-IQ-u-nu-latn",
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                بانتظار الاعتماد:{" "}
                <span dir="ltr">{metric(totals.pendingApproval)}</span>
                {" · "}مرفوض: <span dir="ltr">{metric(totals.rejected)}</span>
                {" · "}ملغى: <span dir="ltr">{metric(totals.cancelled)}</span>
                {totals.needsAudit == null ? " · المحسوب من الصفحة" : ""}
              </p>
            </div>
            <span className="rounded-lg bg-[var(--sem-warn-bg)] p-1.5 text-[var(--sem-warn)]">
              <ShieldAlert aria-hidden className="size-4" />
            </span>
          </CardContent>
        </Card>
      </section>

      <Card className="gap-0 py-0">
        <CardContent className="space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal
                aria-hidden
                className="size-4 text-muted-foreground"
              />
              <h2 className="text-sm font-semibold">بحث وفلاتر المصروفات</h2>
              {activeChips.length > 0 && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {activeChips.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                فلاتر متقدمة
                {advancedOpen ? (
                  <ChevronUp aria-hidden className="size-4" />
                ) : (
                  <ChevronDown aria-hidden className="size-4" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={activeChips.length === 0}
                onClick={resetFilters}
              >
                <X aria-hidden className="size-3.5" /> إعادة ضبط
              </Button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
            <div className="space-y-1 md:col-span-2 xl:col-span-3">
              <Label htmlFor="expense-search" className="text-xs">
                بحث شامل
              </Label>
              <div className="relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="expense-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="البيان، المستفيد، المرجع، رقم المصروف أو السند…"
                  className="pr-8"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-branch" className="text-xs">
                الفرع
              </Label>
              <AppSelect
                id="expense-branch"
                className="h-9"
                value={String(branchId)}
                onValueChange={(value) =>
                  setBranchId(
                    value ? Number(value) : "",
                  )
                }
              >
                <option value="">كل الفروع</option>
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-status" className="text-xs">
                الحالة
              </Label>
              <AppSelect
                id="expense-status"
                className="h-9"
                value={status}
                onValueChange={(value) => setStatus(value)}
              >
                <option value="">كل الحالات</option>
                <option value="PENDING_APPROVAL">بانتظار اعتماد المالك</option>
                <option value="ACTIVE">نافذ</option>
                <option value="REJECTED">مرفوض بلا صرف</option>
                <option value="CANCELLED">ملغى</option>
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-from" className="text-xs">
                من تاريخ
              </Label>
              <Input
                id="expense-from"
                type="date"
                dir="ltr"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="expense-to" className="text-xs">
                إلى تاريخ
              </Label>
              <Input
                id="expense-to"
                type="date"
                dir="ltr"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
          </div>

          {advancedOpen && (
            <div className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="expense-category" className="text-xs">
                  الدلو المحاسبي
                </Label>
                <AppSelect
                  id="expense-category"
                  className="h-9"
                  value={category}
                  onValueChange={(value) => {
                    setCategory(value);
                    // الفلتران متداخلان: تغيير الدلو يُبطل فئةً دقيقةً قد لا تنتمي إليه،
                    // وإلّا خرجت النتيجة فارغةً بلا سببٍ ظاهر للمستخدم.
                    setExpenseCategoryId("");
                  }}
                >
                  <option value="">كل الدلاء</option>
                  {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="expense-managed-category" className="text-xs">
                  الفئة التفصيلية
                </Label>
                <AppSelect
                  id="expense-managed-category"
                  className="h-9"
                  value={expenseCategoryId}
                  onValueChange={(value) => setExpenseCategoryId(value)}
                >
                  <option value="">كل الفئات</option>
                  {(expenseCategoryOptions.data ?? [])
                    .filter((c) => !category || c.bucket === category)
                    .map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-f-method" className="text-xs">
                  طريقة الدفع
                </Label>
                <AppSelect
                  id="exp-f-method"
                  value={paymentMethod}
                  onValueChange={setPaymentMethod}
                  placeholder="كل طرق الدفع"
                >
                  <option value="">كل طرق الدفع</option>
                  {Object.entries(METHOD_LABEL).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-f-source" className="text-xs">
                  نوع المصروف
                </Label>
                <AppSelect
                  id="exp-f-source"
                  value={source}
                  onValueChange={setSource}
                  placeholder="كل الأنواع"
                >
                  <option value="">كل الأنواع</option>
                  <option value="CASH">مالي</option>
                  <option value="STOCK">مخزون (نثرية/تلف)</option>
                </AppSelect>
              </div>
            </div>
          )}

          {activeChips.length > 0 && (
            <div
              className="flex flex-wrap gap-1.5 border-t pt-2"
              aria-label="الفلاتر الفعالة"
            >
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.clear}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full border bg-muted/40 px-3 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {chip.label}
                  <X aria-hidden className="size-3" />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {(Number(totals.needsAudit ?? pageNeedsAudit) > 0 || auditOnly) && (
        <div
          className="flex flex-col gap-3 rounded-lg border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] px-4 py-3 text-[var(--sem-warn)] sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-sm font-semibold">
                توجد عمليات تحتاج مراجعة بيانات المصدر أو الشرح
              </p>
              <p className="text-xs opacity-90">
                {pageNeedsAudit} في الصفحة الحالية؛ يشمل غياب الشرح أو المستفيد
                أو ربط الدرج والوردية.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAuditFocus(null);
              setAuditOnly((value) => !value);
            }}
          >
            {auditOnly ? "عرض كل الصفحة" : "عرض حالات الصفحة فقط"}
          </Button>
        </div>
      )}

      {Number(totals.needsAudit ?? pageNeedsAudit) > 0 && (
        <section
          aria-label="تفصيل استثناءات تدقيق المصروفات"
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
        >
          {(
            [
              {
                key: "DESCRIPTION",
                label: "مصروفات بلا شرح",
                count: Number(
                  totals.missingDescription ?? auditBreakdown.DESCRIPTION,
                ),
              },
              {
                key: "PAYEE",
                label: "مصروفات بلا مستفيد",
                count: Number(totals.missingPayee ?? auditBreakdown.PAYEE),
              },
              {
                key: "SOURCE",
                label: "اختلاف المصدر أو الإيصال",
                count: Number(totals.sourceMismatch ?? auditBreakdown.SOURCE),
              },
              {
                key: "DRAWER",
                label: "درج أو وردية غير مكتملة",
                count: Number(totals.drawerMismatch ?? auditBreakdown.DRAWER),
              },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={auditFocus === item.key}
              onClick={() => {
                setAuditOnly(false);
                setAuditFocus((current) =>
                  current === item.key ? null : item.key,
                );
              }}
              className={`flex min-h-14 items-center justify-between rounded-lg border px-3 py-2 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                auditFocus === item.key
                  ? "border-primary bg-primary/5"
                  : "bg-card"
              }`}
            >
              <span>
                <span className="block text-xs font-semibold">
                  {item.label}
                </span>
                <span className="text-[11px] text-primary">عرض السجلات</span>
              </span>
              <span className="text-xl font-bold tabular-nums" dir="ltr">
                {item.count.toLocaleString("ar-IQ-u-nu-latn")}
              </span>
            </button>
          ))}
        </section>
      )}

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold">السجل المحاسبي التفصيلي</h2>
            <p className="text-xs text-muted-foreground">
              مجمّع حسب مصدر التمويل ·{" "}
              {visibleEntries.length.toLocaleString("ar-IQ-u-nu-latn")} من{" "}
              {rows.length.toLocaleString("ar-IQ-u-nu-latn")} في الصفحة
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Layers3 aria-hidden className="size-4" />
            افتح «مسار التتبّع» لأي صف لعرض المستند والإيصال والقيد والتدقيق
          </div>
        </div>
        <CardContent className="p-0">
          <div className="space-y-3 p-3 md:hidden">
            {groupedRows.map((group) => (
              <section
                key={group.kind}
                aria-label={FUNDING_META[group.kind].label}
                className="space-y-2"
              >
                <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2 text-xs font-semibold">
                  <span>{FUNDING_META[group.kind].label}</span>
                  <span>
                    {group.entries.length} ·{" "}
                    <span dir="ltr">
                      {fmt(
                        group.entries.reduce(
                          (sum, entry) => sum + Number(entry.row.amount),
                          0,
                        ),
                      )}
                    </span>
                  </span>
                </div>
                {group.entries.map(({ row: r, warnings }) => {
                  const expanded = expandedDescriptions.has(Number(r.id));
                  const traceExpanded = expandedTraces.has(Number(r.id));
                  return (
                    <article
                      key={Number(r.id)}
                      className="space-y-3 rounded-lg border p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs" dir="ltr">
                              EXP#{Number(r.id)}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
                            >
                              {STATUS_LABEL[r.status] ?? r.status}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {fmtDate(r.expenseDate as unknown as string)} ·{" "}
                            {r.branchName ?? "—"}
                          </p>
                        </div>
                        <p className="text-lg font-bold tabular-nums" dir="ltr">
                          {fmt(r.amount)}
                        </p>
                      </div>
                      <div>
                        <p
                          className={`text-sm leading-6 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
                        >
                          {r.description?.trim() || "لا يوجد شرح للعملية"}
                        </p>
                        {(r.description?.length ?? 0) > 80 && (
                          <button
                            type="button"
                            className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
                            onClick={() => toggleDescription(Number(r.id))}
                          >
                            {expanded ? "طي الشرح" : "عرض الشرح كاملاً"}
                          </button>
                        )}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        <div>
                          <dt className="text-muted-foreground">المستفيد</dt>
                          <dd className="font-medium">{r.payee ?? "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            الفئة / المركز
                          </dt>
                          <dd>
                            {expenseCategoryText(r)}
                            {r.costCenter ? ` · ${r.costCenter}` : ""}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            مصدر التمويل
                          </dt>
                          <dd>{fundingDetail(r)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            أنشأ العملية
                          </dt>
                          <dd>
                            {r.createdByName ??
                              (r.createdBy != null ? `#${r.createdBy}` : "—")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">السند</dt>
                          <dd dir="ltr">
                            {r.receiptVoucherNumber ??
                              (r.receiptId ? `R#${r.receiptId}` : "—")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">وقت التسجيل</dt>
                          <dd dir="ltr">
                            {fmtDateTime(r.createdAt as unknown as string)}
                          </dd>
                        </div>
                      </dl>
                      {warnings.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {warnings.map((warning) => (
                            <span
                              key={warning}
                              className="rounded-full badge-status-cancelled px-2 py-0.5 text-[11px]"
                            >
                              {warning}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-expanded={traceExpanded}
                          onClick={() => toggleTrace(Number(r.id))}
                        >
                          {traceExpanded ? (
                            <ChevronUp aria-hidden className="size-4" />
                          ) : (
                            <ChevronDown aria-hidden className="size-4" />
                          )}
                          مسار التتبّع
                        </Button>
                        <RowActions actions={actionsFor(r)} />
                      </div>
                      {traceExpanded && (
                        <ExpenseTracePanel expenseId={Number(r.id)} />
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
            {list.data && visibleEntries.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                لا مصروفات مطابقة.
              </p>
            )}
          </div>

          <div className="hidden md:block">
            <ScrollTableShell
              bordered={false}
              maxHeightClass="max-h-[calc(100dvh-13rem)]"
            >
              <table className="w-full min-w-[1500px] text-sm">
                <caption className="sr-only">
                  سجل المصروفات التفصيلي مجمّع حسب مصدر التمويل
                </caption>
                <thead className="bg-muted/50">
                  <tr>
                    <th scope="col" className="p-2 text-start">
                      المصروف / السند
                    </th>
                    <th scope="col" className="p-2 text-start">
                      التاريخ والتوقيت
                    </th>
                    <th scope="col" className="p-2 text-start">
                      البيان / المستفيد
                    </th>
                    <th scope="col" className="p-2 text-start">
                      الفرع / التصنيف
                    </th>
                    <th scope="col" className="p-2 text-start">
                      مصدر التمويل
                    </th>
                    <th scope="col" className="p-2 text-start">
                      الدرج / الوردية
                    </th>
                    <th scope="col" className="p-2 text-start">
                      المسؤولية والاعتماد
                    </th>
                    <th scope="col" className="p-2 text-start">
                      المبلغ
                    </th>
                    <th scope="col" className="p-2 text-start">
                      الحالة
                    </th>
                    <th scope="col" className="p-2 text-start">
                      التدقيق
                    </th>
                    <th scope="col" className="p-2 text-center">
                      إجراء
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groupedRows.map((group) => (
                    <Fragment key={group.kind}>
                      <tr className="border-y bg-muted/70">
                        <td colSpan={11} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-semibold">
                              {FUNDING_META[group.kind].label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {group.entries.length} عملية · إجمالي الصفحة{" "}
                              <span
                                className="font-semibold text-foreground tabular-nums"
                                dir="ltr"
                              >
                                {fmt(
                                  group.entries.reduce(
                                    (sum, entry) =>
                                      sum + Number(entry.row.amount),
                                    0,
                                  ),
                                )}
                              </span>
                            </span>
                          </div>
                        </td>
                      </tr>
                      {group.entries.map(({ row: r, warnings, funding }) => {
                        const fr = rowProps(r.id);
                        const expanded = expandedDescriptions.has(Number(r.id));
                        const traceExpanded = expandedTraces.has(Number(r.id));
                        return (
                          <Fragment key={Number(r.id)}>
                            <tr
                              ref={fr.ref}
                              className={`border-t align-top ${fr.className} ${r.status === "CANCELLED" ? "opacity-70" : ""}`}
                            >
                              <td className="p-2">
                                <div className="font-mono text-xs" dir="ltr">
                                  EXP#{Number(r.id)}
                                </div>
                                <div
                                  className="mt-1 font-mono text-[11px] text-muted-foreground"
                                  dir="ltr"
                                >
                                  {r.receiptVoucherNumber ??
                                    (r.receiptId
                                      ? `R#${r.receiptId}`
                                      : "بلا سند")}
                                </div>
                                {r.referenceNumber && (
                                  <div
                                    className="mt-1 max-w-36 truncate text-[11px] text-muted-foreground"
                                    title={r.referenceNumber}
                                  >
                                    مرجع: {r.referenceNumber}
                                  </div>
                                )}
                              </td>
                              <td className="p-2 text-xs">
                                <div dir="ltr">
                                  {fmtDate(r.expenseDate as unknown as string)}
                                </div>
                                <div
                                  className="mt-1 text-[11px] text-muted-foreground"
                                  dir="ltr"
                                >
                                  أُدخل:{" "}
                                  {fmtDateTime(
                                    r.createdAt as unknown as string,
                                  )}
                                </div>
                                {r.updatedAt && (
                                  <div
                                    className="text-[11px] text-muted-foreground"
                                    dir="ltr"
                                  >
                                    حُدّث: {fmtDateTime(r.updatedAt)}
                                  </div>
                                )}
                              </td>
                              <td className="max-w-[25rem] p-2">
                                <p
                                  className={`leading-6 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
                                >
                                  {r.description?.trim() || (
                                    <span className="font-medium text-destructive">
                                      لا يوجد شرح للعملية
                                    </span>
                                  )}
                                </p>
                                {(r.description?.length ?? 0) > 80 && (
                                  <button
                                    type="button"
                                    className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
                                    onClick={() =>
                                      toggleDescription(Number(r.id))
                                    }
                                  >
                                    {expanded ? "طي" : "عرض كامل"}
                                  </button>
                                )}
                                <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                  <UserRound aria-hidden className="size-3.5" />{" "}
                                  المستفيد:{" "}
                                  <span className="text-foreground">
                                    {r.payee ?? "—"}
                                  </span>
                                </div>
                              </td>
                              <td className="p-2 text-xs">
                                <div>{r.branchName ?? "—"}</div>
                                <div className="mt-1 text-muted-foreground">
                                  {expenseCategoryText(r)}
                                </div>
                                {r.costCenter && (
                                  <div className="text-[11px] text-muted-foreground">
                                    مركز: {r.costCenter}
                                  </div>
                                )}
                              </td>
                              <td className="p-2 text-xs">
                                <span
                                  className={`inline-flex rounded-full px-2 py-0.5 text-xs ${FUNDING_META[funding].badge}`}
                                >
                                  {FUNDING_META[funding].short}
                                </span>
                                <div className="mt-1 text-muted-foreground">
                                  {sourceLabel(r)}
                                </div>
                              </td>
                              <td className="p-2 text-xs">
                                {funding === "DRAWER" ? (
                                  <>
                                    <div className="font-medium">
                                      {r.shiftOwnerName ??
                                        "صاحب الدرج غير ظاهر"}
                                    </div>
                                    <div
                                      className="mt-1 text-muted-foreground"
                                      dir="ltr"
                                    >
                                      وردية #{r.shiftId ?? "—"}
                                    </div>
                                    <div className="text-[11px] text-muted-foreground">
                                      {r.shiftType
                                        ? (SHIFT_TYPE_LABEL[r.shiftType] ??
                                          r.shiftType)
                                        : "—"}{" "}
                                      ·{" "}
                                      {r.shiftStatus
                                        ? (SHIFT_STATUS_LABEL[r.shiftStatus] ??
                                          r.shiftStatus)
                                        : "—"}
                                    </div>
                                  </>
                                ) : funding === "TREASURY" ? (
                                  <div className="inline-flex items-center gap-1">
                                    <Building2 aria-hidden className="size-4" />{" "}
                                    الخزينة الإدارية
                                  </div>
                                ) : (
                                  <div>{fundingDetail(r)}</div>
                                )}
                              </td>
                              <td className="p-2 text-xs">
                                <div>
                                  أنشأ:{" "}
                                  <span className="font-medium">
                                    {r.createdByName ??
                                      (r.createdBy != null
                                        ? `#${r.createdBy}`
                                        : "—")}
                                  </span>
                                </div>
                                <div className="mt-1 text-muted-foreground">
                                  اعتمد: {r.approvedByName ?? "—"}
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  {r.approvalStatus
                                    ? (APPROVAL_LABEL[r.approvalStatus] ??
                                      r.approvalStatus)
                                    : "—"}
                                  {r.receiptStatus
                                    ? ` · إيصال ${r.receiptStatus}`
                                    : ""}
                                </div>
                              </td>
                              <td
                                className="p-2 text-start text-base font-bold tabular-nums"
                                dir="ltr"
                              >
                                {fmt(r.amount)}
                              </td>
                              <td className="p-2">
                                <span
                                  className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
                                >
                                  {STATUS_LABEL[r.status] ?? r.status}
                                </span>
                              </td>
                              <td className="max-w-52 p-2">
                                {warnings.length ? (
                                  <div className="flex flex-wrap gap-1">
                                    {warnings.map((warning) => (
                                      <span
                                        key={warning}
                                        className="rounded-full badge-status-cancelled px-2 py-0.5 text-[11px]"
                                      >
                                        {warning}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    لا ملاحظات
                                  </span>
                                )}
                              </td>
                              <td className="p-2 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    aria-label={`مسار تتبع المصروف ${Number(r.id)}`}
                                    aria-expanded={traceExpanded}
                                    onClick={() => toggleTrace(Number(r.id))}
                                  >
                                    {traceExpanded ? (
                                      <ChevronUp
                                        aria-hidden
                                        className="size-4"
                                      />
                                    ) : (
                                      <ChevronDown
                                        aria-hidden
                                        className="size-4"
                                      />
                                    )}
                                    تفاصيل
                                  </Button>
                                  <RowActions actions={actionsFor(r)} />
                                </div>
                              </td>
                            </tr>
                            {traceExpanded && (
                              <tr className="border-t bg-muted/20">
                                <td colSpan={11} className="p-3">
                                  <ExpenseTracePanel expenseId={Number(r.id)} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                  {list.data && visibleEntries.length === 0 && (
                    <TableEmptyRow
                      colSpan={11}
                      message={
                        auditOnly
                          ? "لا توجد حالات تدقيق في هذه الصفحة."
                          : query
                            ? "لا مصروفات مطابقة للبحث."
                            : "لا مصروفات لهذا الفلتر."
                      }
                    />
                  )}
                </tbody>
              </table>
            </ScrollTableShell>
          </div>
        </CardContent>
        <TablePager
          page={page}
          onPageChange={setPage}
          pageSize={PAGE_SIZE}
          rowsOnPage={rows.length}
          total={total}
          isLoading={list.isFetching}
        />
      </Card>
      {cancel.error && (
        <p className="text-sm text-destructive">{cancel.error.message}</p>
      )}
      <ExpenseRejectDialog
        target={rejectTarget}
        onClose={() => setRejectTarget(null)}
      />
      <ExpenseCorrectionDialog
        target={correctionTarget}
        onClose={() => setCorrectionTarget(null)}
      />
    </div>
  );
}
