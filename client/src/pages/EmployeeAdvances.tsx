import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
/* ============================================================================
 * شاشة سلف الموظفين — تبويب في hub الموارد البشرية (بند 12ج).
 *
 * قائمة شهرية موحّدة لطلبات السلف وصرفها وتسويتها. الطلب بلا أثر مالي؛ الصرف فقط
 * يخرج من درج وردية المنفّذ، ثم يُخصم كاملاً من مسيّر الشهر نفسه بلا ترحيل.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { FilterField, ListToolbar } from "@/components/list";
import { confirm } from "@/lib/confirm";
import { currentBaghdadMonth } from "@/lib/businessMonth";
import { fmtDate } from "@/lib/date";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { D, fmtAr, moneyInput } from "@/lib/money";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { HandCoins, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EmployeeAdvanceRepaymentPanel } from "@/components/hr/EmployeeAdvanceRepaymentPanel";
import { toExcelMoney } from "@/lib/payrollAccrual";
import { selectClsSm } from "@/lib/ui/formStyles";

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "نشطة",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  APPROVED: "معتمدة ولم تُصرف",
  REJECTED: "مرفوضة",
  EXPIRED: "منتهية الشهر",
  LEGACY_UNCLASSIFIED: "تاريخية غير مصنفة",
  SETTLED: "مسوّاة",
  CANCELLED: "ملغاة",
};
const STATUS_CLS: Record<string, string> = {
  ACTIVE: "badge-status-pending",
  PENDING_APPROVAL: "badge-stock-low",
  APPROVED: "badge-status-pending",
  REJECTED: "bg-destructive/10 text-destructive",
  EXPIRED: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
  LEGACY_UNCLASSIFIED: "bg-muted text-muted-foreground",
  SETTLED: "badge-status-active",
  CANCELLED: "bg-muted text-muted-foreground",
};
const STATUS_TITLE: Record<string, string> = {
  ACTIVE: "نشطة — تُخصم كاملةً من مسيّر شهرها دون ترحيل",
  PENDING_APPROVAL:
    "طلب مسجَّل بلا أثر مالي حتى الاعتماد والصرف من درج وردية المنفّذ",
  APPROVED: "معتمدة بلا أثر مالي حتى تنفيذ الصرف من درج وردية المنفّذ",
  REJECTED: "مرفوضة بلا أثر نقدي أو محاسبي",
  EXPIRED: "انتهى شهر الطلب دون صرفه؛ يُلغى ويعاد احتساب طلب الشهر الجاري",
  LEGACY_UNCLASSIFIED:
    "سجل تاريخي لا يحمل تصنيف شهر موثوقاً؛ محجوب عن الصرف والراتب حتى المراجعة",
  // Codex P2 (٢٤/٨): مسارُ التسوية ليس واحداً — لوحةُ سدادٍ يدويّ (تحت الجدول) تعتمد ⇒
  // remaining=0 وSETTLED دون أيّ خصمٍ من راتب. لا نُلبس مدقّقاً/HR قصّةً مالية ليست بالضرورة صحيحة.
  SETTLED:
    "مسوّاة — استُوفي المبلغ كاملاً (خصماً من الرواتب أو سداداً مباشراً)",
  CANCELLED: "ملغاة — أُلغيت قبل بدء الخصم (سند الصرف لم يُعكَس آلياً)",
};
/** صفُّ سلفة موظّف — مشتقٌّ من عقد `payroll.advancesList` فلا ينجرف عن الخادم. */
type AdvanceRow = RouterOutputs["payroll"]["advancesList"][number];

function advanceClassificationLabel(row: AdvanceRow): string {
  if (!row.financiallyDisbursed) {
    if (
      row.status === "LEGACY_UNCLASSIFIED" ||
      row.workflowStatus === "LEGACY_UNCLASSIFIED" ||
      !row.payrollPeriod
    ) {
      return "طلب تاريخي غير مصنف — لم يُصرف";
    }
    return `طلب شهر ${row.payrollPeriod} — لم يُصرف`;
  }
  if (row.sourceType === "LEGACY_UNCLASSIFIED") {
    return "ذمة تاريخية غير مصنفة — لا شهر خصم";
  }
  if (row.sourceType === "OTHER_DEDUCTION") {
    return row.monthlyDeduction != null
      ? `ذمة أخرى — الاستقطاع المعتمد ${iqd(row.monthlyDeduction)}`
      : "ذمة أخرى — وفق الاستقطاع المعتمد";
  }
  return row.payrollPeriod
    ? `سلفة راتبية — شهر الخصم ${row.payrollPeriod}`
    : "سلفة راتبية — شهر الخصم غير محدد";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STATUS_CLS[status] ?? "bg-muted text-muted-foreground"}`}
      title={STATUS_TITLE[status] ?? undefined}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function EmployeeAdvances() {
  const { can } = useCatalogPeopleOperationAccess();
  const utils = trpc.useUtils();
  // مرآة الخادم: `payroll.advanceGrant` و`payroll.advanceCancel` = `hrWrite` (hr:FULL) —
  // server/routers/payrollRouter.ts:522/547. إخفاءُ زرّ «منح سلفة» على من لا يستطيع الحفظ (بدل
  // فتحِ حوارٍ يُرفض عند submit).
  const me = trpc.auth.me.useQuery();
  const canGrant = can(
    "payroll.advanceGrant",
    !!me.data?.role &&
      moduleAccessAllowed(
        me.data.role as RoleKey,
        (me.data.permissionsOverride ?? null) as PermissionMap | null,
        "hr",
        "FULL",
        ["manager"],
      ),
  );
  const [status, setStatus] = useState<
    | ""
    | "ACTIVE"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "REJECTED"
    | "EXPIRED"
    | "LEGACY_UNCLASSIFIED"
    | "SETTLED"
    | "CANCELLED"
  >("");
  const [empFilter, setEmpFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [period, setPeriod] = useState(() => currentBaghdadMonth());
  const [q, setQ] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);

  const empOpts = trpc.employees.formOptions.useQuery(undefined, {
    enabled: can("employees.formOptions"),
  });
  const allEmpsQ = trpc.employees.list.useQuery(
    { limit: 500 },
    { enabled: can("employees.list") },
  );
  const allEmployees = useMemo(() => {
    if (allEmpsQ.data?.rows) {
      return allEmpsQ.data.rows.map((e) => ({ id: e.id, name: e.fullName }));
    }
    return empOpts.data?.managers ?? [];
  }, [allEmpsQ.data?.rows, empOpts.data?.managers]);
  const branchesQ = trpc.branches.list.useQuery(undefined, {
    enabled: can("branches.list"),
  });

  const listInput = useMemo(
    () => ({
      status: (status || undefined) as
        | "ACTIVE"
        | "PENDING_APPROVAL"
        | "APPROVED"
        | "REJECTED"
        | "EXPIRED"
        | "LEGACY_UNCLASSIFIED"
        | "SETTLED"
        | "CANCELLED"
        | undefined,
      employeeId: empFilter ? Number(empFilter) : undefined,
      branchId: branchFilter ? Number(branchFilter) : undefined,
      period: period || undefined,
    }),
    [status, empFilter, branchFilter, period],
  );
  const listQ = trpc.payroll.advancesList.useQuery(listInput, {
    enabled: can("payroll.advancesList"),
  });
  const rows = listQ.data ?? [];

  const filtered = useMemo(() => {
    const t = q.trim();
    if (!t) return rows;
    return rows.filter(
      (r) => r.employeeName.includes(t) || (r.voucherNumber ?? "").includes(t),
    );
  }, [rows, q]);

  const totals = useMemo(() => {
    let remaining = D(0);
    let amount = D(0);
    for (const r of filtered) {
      amount = amount.plus(D(r.amount));
      if (r.status === "ACTIVE") remaining = remaining.plus(D(r.remaining));
    }
    return { amount: amount.toFixed(2), remaining: remaining.toFixed(2) };
  }, [filtered]);

  const refresh = () => utils.payroll.advancesList.invalidate();

  const cancelM = trpc.payroll.advanceCancel.useMutation({
    onSuccess: async (res) => {
      notify.ok(res.voucherNotice);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const cancelRequestM = trpc.hrEnterprise.loans.cancel.useMutation({
    onSuccess: async () => {
      notify.ok("تم إلغاء طلب السلفة غير المصروف دون أثر مالي");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  // أعمدة الجدول — تقرأ صلاحية المنح وحالة طفرة الإلغاء، فتُبنى في جسم المكوّن.
  const columns: ColumnDef<AdvanceRow, unknown>[] = [
    {
      id: "employee",
      header: "الموظف",
      accessorFn: (r) => r.employeeName,
      meta: { width: "wide", wrap: true },
      cell: ({ row }) => (
        <div className="flex items-center gap-2.5">
          <EmpAvatar name={row.original.employeeName} sizePx={30} />
          <div>
            <div className="font-medium text-[13px]">
              {row.original.employeeName}
            </div>
            {(row.original.position || row.original.note) && (
              <div className="text-[11px] text-muted-foreground">
                {[row.original.position, row.original.note]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "branch",
      header: "الفرع",
      accessorFn: (r) => r.branchName ?? "—",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.branchName ?? "—"}
        </span>
      ),
    },
    {
      id: "amount",
      header: "المبلغ",
      accessorFn: (r) => iqd(r.amount),
      meta: { kind: "money" },
      cell: ({ row }) => iqd(row.original.amount),
    },
    {
      id: "remaining",
      header: "المتبقّي",
      accessorFn: (r) => iqd(r.remaining),
      meta: { kind: "money" },
      cell: ({ row }) => (
        <span
          className={`font-bold ${D(row.original.remaining).gt(0) && row.original.status === "ACTIVE" ? "text-money-negative" : ""}`}
        >
          {row.original.financiallyDisbursed
            ? iqd(row.original.remaining)
            : "لم يُصرف"}
        </span>
      ),
    },
    {
      id: "monthlyDeduction",
      header: "التصنيف / شهر الخصم",
      accessorFn: advanceClassificationLabel,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {advanceClassificationLabel(row.original)}
        </span>
      ),
    },
    {
      id: "voucherNumber",
      header: "سند الصرف",
      accessorFn: (r) => r.voucherNumber ?? "—",
      meta: { kind: "code", align: "center" },
      cell: ({ row }) => (
        <span className="text-xs">{row.original.voucherNumber ?? "—"}</span>
      ),
    },
    {
      id: "grantedAt",
      header: "التاريخ",
      accessorFn: (r) => fmtDate(r.grantedAt),
      meta: { kind: "date" },
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {fmtDate(row.original.grantedAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (r) => STATUS_LABEL[r.status] ?? r.status,
      meta: { kind: "status" },
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const r = row.original;
        const cancellableRequest =
          r.requestId != null &&
          [
            "PENDING_APPROVAL",
            "APPROVED",
            "EXPIRED",
            "LEGACY_UNCLASSIFIED",
          ].includes(r.status);
        if (cancellableRequest) {
          return (
            <button
              className="text-xs text-destructive font-medium hover:underline inline-flex items-center gap-1"
              onClick={async () => {
                const ok = await confirm({
                  variant: "danger",
                  title: `إلغاء طلب سلفة ${r.employeeName}`,
                  description:
                    "سيُلغى الطلب غير المصروف دون حركة نقدية أو قيد محاسبي.",
                  confirmText: "إلغاء الطلب",
                });
                if (ok) {
                  cancelRequestM.mutate({
                    id: r.requestId!,
                    reason: "أُلغي من جدول السلف قبل الصرف",
                  });
                }
              }}
              disabled={
                !can("hrEnterprise.loans.cancel") || cancelRequestM.isPending
              }
            >
              <X className="size-3.5" aria-hidden /> إلغاء الطلب
            </button>
          );
        }
        const cancellable =
          can("payroll.advanceCancel", canGrant) &&
          r.status === "ACTIVE" &&
          D(r.remaining).eq(D(r.amount));
        // سلفةٌ نشطة بدأ الخصم فيها: نُظهر «—» بتوضيح — لا نتركها فارغة صامتاً.
        const partiallyDeducted =
          r.status === "ACTIVE" && !D(r.remaining).eq(D(r.amount));
        if (cancellable) {
          return (
            <button
              className="text-xs text-destructive font-medium hover:underline inline-flex items-center gap-1"
              onClick={async () => {
                /*
                 * النصّ يطابق ما يفعله الخادم فعلياً — لا العكس. cancelAdvance (advancesService.ts)
                 * ترفض حين يكون سند الصرف سارياً (الحالة المعتادة لسلفةٍ صُرفت نقداً بسند فعليّ)،
                 * وتنجح مباشرةً فقط حين لا سريان له (بلا سندٍ أصلاً، أو معكوس/مرفوض مسبقاً). كان
                 * النصّ السابق يَعِد بالعكس: «تُلغى السلفة الآن، ثمّ ألغِ السند بنفسك لاحقاً» — وعداً
                 * لا يتحقّق في الحالة الشائعة، ورسالة الرفض الفعلية تصل المستخدم متناقضةً معه.
                 */
                const ok = await confirm({
                  variant: "danger",
                  title: `إلغاء سلفة ${r.employeeName}`,
                  description: r.voucherNumber
                    ? `تُلغى السلفة (${iqd(r.amount)} د.ع) مباشرةً فقط إن كان سند صرفها ${r.voucherNumber} غير سارٍ (معكوس أو مرفوض مسبقاً). إن كان السند سارياً (الحالة المعتادة لسلفةٍ صُرفت نقداً)، تُرفض المحاولة وتُطالَب بإلغاء السند ${r.voucherNumber} أولاً من شاشة السندات — يعتمده مراجعٌ آخر، وعندها تُلغى هذه السلفة تلقائياً معه.`
                    : `تُلغى السلفة (${iqd(r.amount)} د.ع) قبل أي خصم — لا سند صرفٍ مرتبط بها.`,
                  confirmText: "إلغاء السلفة",
                });
                if (ok) cancelM.mutate({ advanceId: Number(r.id) });
              }}
              disabled={!can("payroll.advanceCancel") || cancelM.isPending}
            >
              <X className="size-3.5" aria-hidden /> إلغاء
            </button>
          );
        }
        if (partiallyDeducted) {
          return (
            <span
              className="text-xs text-muted-foreground"
              // Codex P1 (٢٤/٨): «سلفة معاكسة» نصيحةٌ ضارّة — grantAdvance يقبل موجباً فقط
              // ⇒ يُنشئ سنداً نقدياً OUT جديداً فيزيد الدين. المسار الصحيح: لوحةُ السداد
              // اليدويّ تحت الجدول (EmployeeAdvanceRepaymentPanel) أو الخصمُ المستمرّ.
              title="لا يُلغى بعد بدء الخصم — يُكمَل الاستيفاء بالخصم الشهريّ من الرواتب، أو بسداد يدويّ من لوحة السداد أسفل الجدول"
            >
              —
            </span>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <ListToolbar
            title={
              <span className="flex items-center gap-2 text-base font-semibold">
                <HandCoins className="size-4 text-primary" aria-hidden />
                سلف الموظفين
              </span>
            }
            pageTitle
            add={
              canGrant
                ? { onClick: () => setGrantOpen(true), label: "منح سلفة" }
                : undefined
            }
            count={filtered.length}
            loading={listQ.isLoading}
            // ٢٤/٨ (Codex P2 على PR #760): لا `autoFocus` — الصفحةُ تبويبٌ داخل HrHub.
            search={{
              value: q,
              onChange: setQ,
              placeholder: "بحث باسم الموظف أو رقم السند…",
            }}
            activeFilterCount={
              (status ? 1 : 0) +
              (empFilter ? 1 : 0) +
              (branchFilter ? 1 : 0) +
              (period ? 1 : 0)
            }
            onResetFilters={() => {
              setQ("");
              setStatus("");
              setEmpFilter("");
              setBranchFilter("");
              setPeriod(currentBaghdadMonth());
            }}
            onRefresh={() => void refresh()}
            refreshing={listQ.isFetching}
            exportSpec={{
              filename: `سلف-الموظفين-${period || "كل-الأشهر"}`,
              rows: filtered,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "employeeName", header: "الموظف" },
                {
                  key: "branchName",
                  header: "الفرع",
                  map: (r) => r.branchName ?? "",
                },
                {
                  key: "amount",
                  header: "المبلغ",
                  map: (r) => toExcelMoney(r.amount),
                },
                {
                  key: "remaining",
                  header: "المتبقّي",
                  map: (r) => toExcelMoney(r.remaining),
                },
                {
                  key: "payrollPeriod",
                  header: "التصنيف / شهر الخصم",
                  map: advanceClassificationLabel,
                },
                {
                  key: "voucherNumber",
                  header: "سند الصرف",
                  map: (r) => r.voucherNumber ?? "",
                },
                {
                  key: "grantedAt",
                  header: "التاريخ",
                  map: (r) => fmtDate(r.grantedAt),
                },
                {
                  key: "status",
                  header: "الحالة",
                  map: (r) => STATUS_LABEL[r.status] ?? r.status,
                },
              ],
            }}
            filters={
              <div className="flex items-end gap-2 flex-wrap">
                <FilterField label="الشهر">
                  <Input
                    type="month"
                    className="h-9 w-36"
                    value={period}
                    onChange={(event) => setPeriod(event.target.value)}
                    aria-label="شهر السلف"
                    disabled={status === "LEGACY_UNCLASSIFIED"}
                  />
                </FilterField>
                <FilterField label="الحالة">
                  <AppSelect
                    className="h-9"
                    value={status}
                    onValueChange={(next) => setStatus(next as typeof status)}
                    aria-label="حالة السلفة"
                  >
                    <option value="">كل الحالات</option>
                    <option value="ACTIVE">نشطة</option>
                    <option value="PENDING_APPROVAL">بانتظار الاعتماد</option>
                    <option value="APPROVED">معتمدة ولم تُصرف</option>
                    <option value="REJECTED">مرفوضة</option>
                    <option value="EXPIRED">منتهية الشهر</option>
                    <option value="LEGACY_UNCLASSIFIED">
                      تاريخية غير مصنفة
                    </option>
                    <option value="SETTLED">مسوّاة</option>
                    <option value="CANCELLED">ملغاة</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="الموظف">
                  <AppSelect
                    className="h-9"
                    value={empFilter}
                    onValueChange={(next) => setEmpFilter(next)}
                    aria-label="الموظف"
                  >
                    <option value="">كل الموظفين</option>
                    {allEmployees.map((m) => (
                      <option key={m.id} value={String(m.id)}>
                        {m.name}
                      </option>
                    ))}
                  </AppSelect>
                </FilterField>
                <FilterField label="الفرع">
                  <AppSelect
                    className="h-9"
                    value={branchFilter}
                    onValueChange={(next) => setBranchFilter(next)}
                    aria-label="الفرع"
                  >
                    <option value="">كل الفروع</option>
                    {(branchesQ.data ?? []).map((b) => (
                      <option key={b.id} value={String(b.id)}>
                        {b.name}
                      </option>
                    ))}
                  </AppSelect>
                </FilterField>
              </div>
            }
          />
          {status === "LEGACY_UNCLASSIFIED" && (
            <p className="mt-2 text-xs text-muted-foreground">
              سجلات تاريخية غير مصنفة من جميع الأشهر؛ تبقى منفصلة عن خصم الراتب حتى المطابقة.
            </p>
          )}
          <div className="text-xs text-muted-foreground mt-1">
            {listQ.isLoading
              ? ""
              : `إجمالي ${iqd(totals.amount)} د.ع، المتبقّي النشط ${iqd(totals.remaining)} د.ع`}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* البحث في ListToolbar أعلاه (يغذّي `filtered`) ⇒ `searchable={false}` وإلّا ظهر حقلا بحث.
              و`externalFiltersActive` = «للقائمة الأصل صفوفٌ لكن المعروض فارغ» ⇒ الفراغُ سببه
              البحث لا خلوّ السجلّ — نفس تمييز الرسالتين في الجدول الخامّ. */}
          <DataTable<AdvanceRow>
            columns={columns}
            data={filtered}
            searchable={false}
            externalFiltersActive={rows.length > 0}
            /* ٢/٩ — استعادةُ سلوك الجدول الخامّ: كان يعرض **كلّ** صفوف `filtered` داخل
               `ScrollTableShell` (تمريرٌ داخليّ بترويسةٍ لاصقة) بلا ترقيمٍ إطلاقاً. وبالتحويل
               وَرِث افتراضَ `DataTable` (٥٠ صفّاً/صفحة) فصارت السلفُ بعد الخمسين خلف صفحةٍ
               ثانية — ترقيمٌ لم تطلبه الشاشة ويُربك قارئها: العدُّ والمجاميع في الترويسة
               محسوبان على `filtered` كاملةً، فصفحةٌ جزئيّة تحت مجموعٍ كلّيّ تُوحي أنّ المعروض
               هو المحسوب. و`bounded` الافتراضيّة تُبقي التمرير الداخليّ نفسه، فلا تنمو الصفحة.
               نفس اختيار أشقّائها في هذه الموجة (`Leaves` و`Payroll`). */
            pageSize={Infinity}
            loading={listQ.isLoading}
            errorState={{
              isError: listQ.isError,
              message: listQ.error?.message,
              onRetry: () => void listQ.refetch(),
            }}
            emptyState={
              period
                ? "لا توجد سلف في هذا الشهر. يمكنك اختيار شهر سابق لعرض السجل المحفوظ."
                : "لا سلف بعد. سجّل طلب سلفة للبدء."
            }
            emptyFilteredState="لا نتائج مطابقة للبحث."
          />
        </CardContent>
      </Card>

      <EmployeeAdvanceRepaymentPanel />

      <GrantDialog
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        onDone={() => {
          setPeriod(currentBaghdadMonth());
          void refresh();
        }}
      />
    </div>
  );
}

function GrantDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { can } = useCatalogPeopleOperationAccess();
  const [employeeId, setEmployeeId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const empsQ = trpc.employees.list.useQuery(
    { status: "active", limit: 200 },
    { enabled: can("employees.list") && open },
  );
  const emps = empsQ.data?.rows ?? [];
  const selected = emps.find((e) => String(e.id) === employeeId);

  const balQ = trpc.payroll.advanceBalance.useQuery(
    { employeeId: Number(employeeId) },
    {
      enabled: can("payroll.advanceBalance") && open && !!employeeId,
      staleTime: 0,
    },
  );

  const capacity = balQ.data?.capacity;
  const maxAvailable = D(capacity?.maxAvailable ?? 0);
  const amountValue = moneyInput(amount);
  const amountValid = amount.trim() !== "" && amountValue.gt(0);
  const overAvailable = amountValid && amountValue.gt(maxAvailable);

  // مفتاح ثابت لكل محاولة طلب؛ إعادة الإرسال تعيد الطلب نفسه بلا تكرار.
  const reqIdRef = useRef<string>(crypto.randomUUID());
  const grantM = trpc.payroll.advanceGrant.useMutation({
    onSuccess: (res) => {
      reqIdRef.current = crypto.randomUUID();
      notify.ok(
        `سُجّل طلب السلفة #${res.id} بلا أثر نقدي؛ ينتظر الاعتماد ثم الصرف من درج الوردية`,
      );
      setEmployeeId("");
      setAmount("");
      setNote("");
      onClose();
      onDone();
    },
    onError: (e) => notify.err(e),
  });

  const canSave =
    !!employeeId &&
    !!selected?.branchId &&
    amountValid &&
    !overAvailable &&
    maxAvailable.gt(0) &&
    !capacity?.blocked &&
    !balQ.isFetching &&
    !balQ.isError &&
    !grantM.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>منح سلفة موظف</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label htmlFor="adv-emp">الموظف</Label>
            <AppSelect
              id="adv-emp"
              className={`${selectClsSm} w-full h-9`}
              value={employeeId}
              onValueChange={(next) => {
                if (next !== employeeId) {
                  setAmount("");
                  setNote("");
                  reqIdRef.current = crypto.randomUUID();
                }
                setEmployeeId(next);
              }}
            >
              <option value="">اختر موظفاً…</option>
              {emps.map((e) => (
                <option key={e.id} value={String(e.id)}>
                  {e.fullName}
                  {e.branchName ? ` — ${e.branchName}` : ""}
                </option>
              ))}
            </AppSelect>
            {!!employeeId && balQ.data && D(balQ.data.balance).gt(0) && (
              <p className="text-xs text-money-negative mt-1">
                عليه ذمم سلف نشطة متبقّيها {iqd(balQ.data.balance)} د.ع (
                {balQ.data.activeCount} سجل).
              </p>
            )}
            {!!employeeId && capacity && (
              <div className="mt-2 rounded border bg-muted/30 p-2 text-xs space-y-1">
                <div className="flex justify-between gap-3">
                  <span>الحد المتاح حتى {capacity.asOf}</span>
                  <strong dir="ltr">{fmtAr(capacity.maxAvailable)}</strong>
                </div>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t pt-2 text-muted-foreground">
                  <dt>الأجر المؤكد حتى اليوم</dt>
                  <dd dir="ltr">{fmtAr(capacity.earnedCompensation)}</dd>
                  <dt>إضافات معتمدة</dt>
                  <dd dir="ltr">+ {fmtAr(capacity.approvedAdditions)}</dd>
                  <dt>استقطاعات إلزامية</dt>
                  <dd dir="ltr">− {fmtAr(capacity.mandatoryDeductions)}</dd>
                  <dt>سلف راتبية مصروفة لهذا الشهر</dt>
                  <dd dir="ltr">− {fmtAr(capacity.existingSalaryAdvances)}</dd>
                  <dt>ذمم أخرى وتاريخية محجوزة لحين المطابقة</dt>
                  <dd dir="ltr">− {fmtAr(capacity.otherEmployeeDeductions)}</dd>
                  <dt>طلبات هذا الشهر المحجوزة</dt>
                  <dd dir="ltr">− {fmtAr(capacity.reservedRequests)}</dd>
                </dl>
                {capacity.excludedAttendanceDates.length > 0 && (
                  <p className="text-[var(--sem-warn)]" role="status">
                    استُبعدت مؤقتاً مساهمة الحضور للأيام المفتوحة أو غير المحسومة (
                    {capacity.excludedAttendanceDates.join("، ")})؛ وتبقى مصادر
                    الأجر المؤكدة الأخرى محسوبة أعلاه.
                  </p>
                )}
                {capacity.warnings.map((warning) => (
                  <p key={warning} className="text-[var(--sem-warn)]" role="status">
                    {warning}
                  </p>
                ))}
                {capacity.blockers.map((blocker) => (
                  <p key={blocker} className="text-money-negative" role="alert">
                    {blocker}
                  </p>
                ))}
              </div>
            )}
            {!!employeeId && selected && !selected.branchId && (
              <p className="text-xs text-money-negative mt-1" role="alert">
                الموظف غير مسند إلى فرع — يلزم إسناد الموظف إلى فرع من شاشة
                الموظفين قبل صرف السلفة.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="adv-amount">المبلغ (د.ع)</Label>
            <MoneyInput
              id="adv-amount"
              value={amount}
              onChange={setAmount}
              decimals={0}
              placeholder="0"
              ariaLabel="مبلغ السلفة"
              max={capacity?.maxAvailable}
              expectedRange={{ min: 1, max: maxAvailable.toNumber() }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              هذا يسجل طلباً فقط. لا يخرج النقد إلا بعد الاعتماد وعند تنفيذ
              الصرف من درج وردية المنفّذ، ثم يُخصم كاملاً من راتب{" "}
              {capacity?.period ?? "الشهر الجاري"}.
            </p>
            {overAvailable && (
              <p className="text-xs text-money-negative mt-1" role="alert">
                المبلغ يتجاوز الحد المتاح ({fmtAr(capacity?.maxAvailable ?? 0)}{" "}
                د.ع).
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="adv-note">ملاحظة (اختياري)</Label>
            <Input
              id="adv-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            onClick={() => {
              if (!selected || !selected.branchId) {
                notify.err(
                  "الموظف غير مسند إلى فرع — يلزم إسناد الموظف إلى فرع أولاً.",
                );
                return;
              }
              if (
                !amountValid ||
                overAvailable ||
                !capacity ||
                capacity.blocked ||
                balQ.isFetching ||
                balQ.isError ||
                !maxAvailable.gt(0)
              ) {
                return;
              }
              grantM.mutate({
                employeeId: Number(selected.id),
                branchId: Number(selected.branchId),
                amount: amountValue.toFixed(2),
                note: note.trim() || null,
                clientRequestId: reqIdRef.current,
              });
            }}
            disabled={!can("payroll.advanceGrant") || !canSave}
          >
            {grantM.isPending ? "جارٍ التسجيل…" : "تسجيل طلب السلفة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
