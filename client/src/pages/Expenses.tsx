import { printExpenseRows } from "@/lib/expenseListPrint";
import { ExpenseDesktopTable } from "@/components/expenses/ExpenseDesktopTable";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";
import { ErrorState, LoadingState } from "@/components/PageState";
import { useFocusHighlight } from "@/components/search/useFocusHighlight";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TablePager } from "@/components/table/TablePager";
import { PageHeader } from "@/components/PageHeader";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows, type ExportColumn } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { notify } from "@/lib/notify";
import { fmt } from "@/lib/money";
import { trpc, type RouterInputs } from "@/lib/trpc";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { expenseOperationAccess } from "@/lib/expenseOperationAccess";
import type { RoleKey } from "@shared/permissions";
import { AlertTriangle, Ban, CircleCheck, CircleDollarSign, Landmark, Layers3, Loader2, Printer, ShieldAlert, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { expenseStatusFromSearch, isExpenseFinanciallyPrintable } from "@/lib/expenseUiPolicy";
import { ExpenseMobileCard } from "@/components/expenses/ExpenseMobileCard";
import { printExpenseReceipt } from "@/components/expenses/printExpenseReceipt";
import { APPROVAL_LABEL, CATEGORY_LABEL, expenseCategoryText, fundingDetail, fundingKindOf, FUNDING_META, FUNDING_ORDER, isApprovedAwaitingExecution, METHOD_LABEL, metric, PAGE_SIZE, SHIFT_STATUS_LABEL, SHIFT_TYPE_LABEL, STATUS_LABEL, warningsOf, type AuditFocus, type ExpenseRow, type ExpenseTotals } from "@/components/expenses/expenseView";
import { ExpenseRejectDialog } from "@/components/expenses/ExpenseRejectDialog";
import { ExpenseCorrectionDialog } from "@/components/expenses/ExpenseCorrectionDialog";

export default function Expenses() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | "">("");
  const [category, setCategory] = useState<string>("");
  // الفئة التفصيلية المُدارة (0203) — فلترٌ أدقّ من الدلو («وقود» وحده لا كل «مواصلات/شحن»).
  const [expenseCategoryId, setExpenseCategoryId] = useState<string>("");
  const expenseCategoryOptions = trpc.expenses.categories.list.useQuery({
    includeInactive: true,
  }, { enabled: treasuryOperationAllowed(me.data, "expenses.categories.list", true) });
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  type ExpenseListInput = Extract<RouterInputs["expenses"]["list"], object>;
  const listInput: ExpenseListInput = {
    branchId: branchId ? Number(branchId) : undefined,
    category: (category || undefined) as ExpenseListInput["category"],
    expenseCategoryId: expenseCategoryId ? Number(expenseCategoryId) : undefined,
    status: (status || undefined) as ExpenseListInput["status"],
    from: from || undefined,
    to: to || undefined,
    paymentMethod: (paymentMethod || undefined) as ExpenseListInput["paymentMethod"],
    source: (source || undefined) as ExpenseListInput["source"],
    q: dq.trim() || undefined,
    auditFocus: auditFocus ?? undefined,
    auditOnly: auditOnly || undefined,
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
  }, { enabled: treasuryOperationAllowed(me.data, "expenses.list", true) });
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
      PAYEE: rowsWithWarnings.filter(({ row }) => row.integrityWarnings?.includes("PAYEE_MISSING")).length,
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
  // The server applies audit predicates before pagination, shared by export and print.
  const visibleEntries = rowsWithWarnings;
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
          label: "يحتاج تدقيقاً",
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
      map: (r) => r.costCenter?.trim() || "",
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
        auditFocus ? `استثناء: ${auditFocus === "DESCRIPTION" ? "بلا شرح" : auditFocus === "PAYEE" ? "بلا مستفيد" : auditFocus === "SOURCE" ? "مصدر أو إيصال غير متطابق" : "درج أو وردية ناقصة"}` : auditOnly ? "يحتاج تدقيقاً" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const opened = printExpenseRows(printable, filterLabels, { auditFocus, auditOnly });
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

  const { canCancel, canExecuteManaged, canCorrect } = expenseOperationAccess(me.data);
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
      notify.ok("تم اعتماد المصروف رقابياً؛ لا أثر مالي حتى ينفذه صاحب الدرج أو أمين الخزينة");
    },
    onError: (error) => notify.err(error),
  });
  const executeFromOwnDrawer =
    trpc.expenses.executeFromOwnDrawer.useMutation({
      onSuccess: async (_result, variables) => {
        await Promise.all([
          utils.expenses.list.invalidate(),
          utils.expenses.trace.invalidate({ expenseId: variables.expenseId }),
        ]);
        notify.ok("تم صرف المصروف من درج وردية المنشئ وتسجيل المنفذ الفعلي");
      },
      onError: (error) => {
        const detail = /رصيد|سيولة|غير كاف/.test(error.message)
          ? `${error.message} موّل الوردية من تبويب الورديات أو نفّذ الدفع مباشرة من الخزينة.`
          : error.message;
        notify.err(detail);
      },
    });
  const executeManaged = trpc.expenses.executeManaged.useMutation({
    onSuccess: async (_result, variables) => {
      await Promise.all([
        utils.expenses.list.invalidate(),
        utils.expenses.trace.invalidate({ expenseId: variables.expenseId }),
      ]);
      notify.ok(
        variables.source === "TREASURY"
          ? "تم الدفع من الخزينة باسم منفذ التسليم الفعلي"
          : "تم تنفيذ طريقة الدفع وتسجيل المنفذ الفعلي",
      );
    },
    onError: (error) => notify.err(error),
  });
  function actionsFor(r: ExpenseRow) {
    const approvedAwaitingExecution = isApprovedAwaitingExecution(r);
    const isRequester = Number(r.createdBy ?? 0) === Number(me.data?.id ?? 0);
    return [
      {
        key: "print",
        kind: "print" as const,
        label: "طباعة إيصال صرف",
        onSelect: () => void printExpenseReceipt(r),
        hidden:
          !isExpenseFinanciallyPrintable(r.status) || r.source === "ACCRUAL",
        gate: { operations: ["expenses.list"], module: "expenses" as const, level: "READ" as const },
      },
      {
        key: "approve",
        kind: "approve" as const,
        icon: CircleCheck,
        label: "اعتماد الطلب",
        // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — canApprove أصلاً يشترط
        // isOwner، فاستثناءُ صانع الطلب هنا كان يحجب الاعتماد الذاتي المسموح به خادمياً.
        hidden: r.status !== "PENDING_APPROVAL" || r.approvalStatus === "APPROVED" || !canApprove,
        disabled: approve.isPending,
        disabledReason: "توجد عملية اعتماد قيد التنفيذ",
        onSelect: () =>
          void (async () => {
            if (
              !(await confirm({
                variant: "warning",
                title: "اعتماد طلب المصروف",
                description: `سيُعتمد طلب ${fmt(r.amount)} د.ع رقابياً فقط، بلا خصم ولا قيد مالي. التنفيذ خطوة مستقلة باسم من دفع فعلياً. هل تتابع؟`,
                confirmText: "اعتماد فقط",
                cancelText: "تراجع",
              }))
            )
              return;
            approve.mutate({ expenseId: Number(r.id) });
          })(),
      },
      {
        key: "execute-own-drawer",
        kind: "approve" as const,
        icon: WalletCards,
        label: "صرف من ورديتي",
        hidden: !approvedAwaitingExecution || r.paymentMethod !== "CASH" || !isRequester || !treasuryOperationAllowed(me.data, "expenses.executeFromOwnDrawer", true),
        disabled: executeFromOwnDrawer.isPending,
        disabledReason: "توجد عملية تنفيذ قيد المعالجة",
        onSelect: () =>
          void (async () => {
            if (
              !(await confirm({
                variant: "warning",
                title: "تنفيذ المصروف من درج الوردية",
                description: `سيُخصم ${fmt(r.amount)} د.ع من ورديتك أنت، وتُسجل أنت منفذَ التسليم. إذا لم يكفِ الرصيد فموّل الوردية أو اختر الصرف المباشر من الخزينة.`,
                confirmText: "تنفيذ من ورديتي",
                cancelText: "تراجع",
              }))
            )
              return;
            executeFromOwnDrawer.mutate({ expenseId: Number(r.id) });
          })(),
      },
      {
        key: "fund-own-drawer",
        kind: "transfer" as const,
        icon: CircleDollarSign,
        label: "تمويل الوردية",
        hidden: !approvedAwaitingExecution || r.paymentMethod !== "CASH" || !isRequester,
        onSelect: () => {
          window.location.href = "/treasury?tab=shifts";
        },
      },
      {
        key: "execute-managed",
        kind: "approve" as const,
        icon: Landmark,
        label:
          r.paymentMethod === "CASH"
            ? "دفع مباشر من الخزينة"
            : "تنفيذ طريقة الدفع",
        hidden: !approvedAwaitingExecution || !canExecuteManaged,
        disabled: executeManaged.isPending,
        disabledReason: "توجد عملية تنفيذ قيد المعالجة",
        onSelect: () =>
          void (async () => {
            const source = r.paymentMethod === "CASH" ? "TREASURY" : "NON_CASH";
            if (
              !(await confirm({
                variant: "warning",
                title:
                  source === "TREASURY"
                    ? "دفع المصروف من الخزينة"
                    : "تنفيذ طريقة الدفع",
                description:
                  source === "TREASURY"
                    ? `سيُخصم ${fmt(r.amount)} د.ع من الخزينة الإدارية، وستُسجل أنت منفذَ تسليم النقد لا المعتمِد. هل تتابع؟`
                    : `سيُنفذ مبلغ ${fmt(r.amount)} د.ع بطريقة ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}، وستُسجل أنت منفذ العملية. هل تتابع؟`,
                confirmText: "تنفيذ الدفع",
                cancelText: "تراجع",
              }))
            )
              return;
            executeManaged.mutate({ expenseId: Number(r.id), source });
          })(),
      },
      {
        key: "reject",
        kind: "cancel" as const,
        icon: Ban,
        label: "رفض الطلب",
        variant: "destructive" as const,
        hidden: r.status !== "PENDING_APPROVAL" || r.approvalStatus === "APPROVED" || !canApprove,
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
          r.accrualObligationId == null ||
          ![
            "ACCRUED_UNPAID",
            "PAYMENT_PENDING",
            "PAID",
            "CORRECTION_PENDING",
            "REFUND_PENDING",
          ].includes(r.settlementStatus ?? "") ||
          !canCorrect,
        onSelect: () => {
          setCorrectionTarget(r);
        },
        gate: {
          operations: ["expenses.requestAccrualCorrection"],
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
        hidden: r.status !== "ACTIVE" || r.source === "ACCRUAL" || r.accrualObligationId != null || !canCancel,
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
          operations: ["expenses.cancel"],
          roles: ["manager"] as RoleKey[],
          module: "expenses" as const,
          level: "FULL" as const,
        },
      },
    ];
  }


  // أموال العرض عبر fmt من @/lib/money (فواصل آلاف + منزلتان) — بديل الدالة المحلية السابقة.
  return (
    <div className="space-y-2">
      <PageHeader
        title="المصروفات اليومية"
        description="النقدي الصغير الممول يُنفذ من درج المنشئ؛ سائر الطلبات تبقى بلا أثر حتى اعتماد مالك آخر، والنقدي المعتمد وحده يُصرف من الخزينة."
        actions={
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={printing || (list.data?.totals.count ?? 0) === 0}
              onClick={() => void printAll()}
            >
              {printing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Printer className="size-3.5" />
              )}
              {printing ? "جارٍ التحضير…" : "طباعة قائمة"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={exporting || (list.data?.totals.count ?? 0) === 0}
              onClick={() => void exportAll()}
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {exporting ? "جارٍ التحضير…" : "تصدير Excel"}
            </Button>
            <Link href="/expenses/new">
              <Button size="sm" disabled={!treasuryOperationAllowed(me.data, "expenses.create", true)}>+ مصروف جديد</Button>
            </Link>
          </div>
        }
      />

      <section
        aria-label="ملخص المصروفات"
        className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-2 px-3 py-2">
            <div>
              <p className="text-[11px] text-muted-foreground">إجمالي النافذ</p>
              <p className="text-lg font-bold tabular-nums" dir="ltr">
                {metric(totals.active ?? 0)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {Number(totals.count ?? 0).toLocaleString("ar-IQ-u-nu-latn")}{" "}
                عملية ضمن الفلتر
              </p>
            </div>
            <span className="rounded-md bg-primary/10 p-1.5 text-primary">
              <CircleDollarSign aria-hidden className="size-3.5" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-2 px-3 py-2">
            <div>
              <p className="text-[11px] text-muted-foreground">من الأدراج</p>
              <p className="text-lg font-bold tabular-nums" dir="ltr">
                {metric(totals.drawer)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                غير نقدي: <span dir="ltr">{metric(totals.nonCash)}</span> · مستحق غير مدفوع: <span dir="ltr">{metric(totals.accruedUnpaid)}</span>
              </p>
            </div>
            <span className="rounded-md bg-[var(--sem-pos-bg)] p-1.5 text-[var(--sem-pos)]">
              <WalletCards aria-hidden className="size-3.5" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-2 px-3 py-2">
            <div>
              <p className="text-[11px] text-muted-foreground">من الخزينة</p>
              <p className="text-lg font-bold tabular-nums" dir="ltr">
                {metric(totals.treasury)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                من المخزون: <span dir="ltr">{metric(totals.stock)}</span> · استحقاق مسوّى: <span dir="ltr">{metric(totals.accruedPaid)}</span>
              </p>
            </div>
            <span className="rounded-md bg-[var(--sem-info-bg)] p-1.5 text-[var(--sem-info)]">
              <Landmark aria-hidden className="size-3.5" />
            </span>
          </CardContent>
        </Card>
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="flex items-start justify-between gap-2 px-3 py-2">
            <div>
              <p className="text-[11px] text-muted-foreground">يحتاج تدقيقاً</p>
              <p className="text-lg font-bold tabular-nums" dir="ltr">
                {Number(totals.needsAudit ?? pageNeedsAudit).toLocaleString(
                  "ar-IQ-u-nu-latn",
                )}
              </p>
              <p className="text-[11px] text-muted-foreground">
                بانتظار الاعتماد:{" "}
                <span dir="ltr">{metric(totals.pendingApproval)}</span>
                {" · "}مرفوض: <span dir="ltr">{metric(totals.rejected)}</span>
                {" · "}ملغى: <span dir="ltr">{metric(totals.cancelled)}</span>
                {totals.needsAudit == null ? " · المحسوب من الصفحة" : ""}
              </p>
            </div>
            <span className="rounded-md bg-[var(--sem-warn-bg)] p-1.5 text-[var(--sem-warn)]">
              <ShieldAlert aria-hidden className="size-3.5" />
            </span>
          </CardContent>
        </Card>
      </section>

      <ExpenseFilters values={{ branchId, category, expenseCategoryId, status, from, to, paymentMethod, source, query }}
        onChange={(patch) => {
          if (patch.branchId !== undefined) setBranchId(patch.branchId);
          if (patch.category !== undefined) setCategory(patch.category);
          if (patch.expenseCategoryId !== undefined) setExpenseCategoryId(patch.expenseCategoryId);
          if (patch.status !== undefined) setStatus(patch.status);
          if (patch.from !== undefined) setFrom(patch.from);
          if (patch.to !== undefined) setTo(patch.to);
          if (patch.paymentMethod !== undefined) setPaymentMethod(patch.paymentMethod);
          if (patch.source !== undefined) setSource(patch.source);
          if (patch.query !== undefined) setQuery(patch.query);
        }} advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen} activeChips={activeChips}
        resetFilters={resetFilters} branches={branches.data ?? []} categories={expenseCategoryOptions.data ?? []} />

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
            {auditOnly ? "عرض كل النتائج" : "عرض حالات التدقيق"}
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
          {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState message={list.error.message} onRetry={() => void list.refetch()} /> : <>
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
                {group.entries.map(({ row: r, warnings }) => (
                  <ExpenseMobileCard
                    key={Number(r.id)}
                    row={r}
                    warnings={warnings}
                    expanded={expandedDescriptions.has(Number(r.id))}
                    traceExpanded={expandedTraces.has(Number(r.id))}
                    onToggleDescription={toggleDescription}
                    onToggleTrace={toggleTrace}
                    actions={actionsFor(r)}
                  />
                ))}
              </section>
            ))}
            {list.data && visibleEntries.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                لا مصروفات مطابقة.
              </p>
            )}
          </div>

          <ExpenseDesktopTable groupedRows={groupedRows} rowProps={rowProps}
            expandedDescriptions={expandedDescriptions} expandedTraces={expandedTraces}
            toggleDescription={toggleDescription} toggleTrace={toggleTrace} actionsFor={actionsFor}
            canTrace={treasuryOperationAllowed(me.data, "expenses.trace", true)} loaded={!!list.data}
            visibleCount={visibleEntries.length} auditOnly={auditOnly} query={query} />
          </>}
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
