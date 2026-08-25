import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { D, fmt, round2 } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { exportSheets } from "@/lib/export";
import {
  EXCHANGE_CONTROL_SCOPE_DISCLOSURE,
  EXCHANGE_DOUBLE_ENTRY_ROLE_LABELS,
} from "@/lib/doubleEntryRoleLabels";
import {
  AlertTriangle,
  Check,
  CircleCheck,
  ClipboardList,
  Clock3,
  FileDown,
  Power,
  ShieldCheck,
} from "lucide-react";
import { Link } from "wouter";
import { RowActions } from "@/components/list";
import { useMemo, useState } from "react";

/* ═══════════ شاشة تدقيق التوافق المالي (admin فقط) ═══════════
   تستهلك reports.reconcile (adminProcedure) لكشف الانجراف الصامت بين
   الأرصدة المُشتقّة والمسجَّلة في الذمم والعهد والمخزون والدفتر.
═══════════════════════════════════════════════════════════════ */

type Row = {
  entity: string;
  id: number;
  expected: string;
  actual: string;
  drift: string;
  note?: string;
};
type ReconcileData = RouterOutputs["reports"]["reconcile"];
type DoubleEntryData = ReconcileData["doubleEntry"];
type ActivationData = ReconcileData["activation"];
type OpeningPreparation = RouterOutputs["reports"]["prepareDoubleEntryShadow"];
type OpeningAllocation = NonNullable<
  RouterInputs["reports"]["prepareDoubleEntryShadow"]["allocations"]
>[number];
type OpeningAllocationRole = OpeningAllocation["role"];

const OPENING_ALLOCATION_ROLES: OpeningAllocationRole[] = [
  "CAPITAL",
  "RETAINED_EARNINGS",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
];

function allocationKey(
  branchId: number | null,
  role: OpeningAllocationRole,
): string {
  return `${branchId == null ? "GLOBAL" : branchId}:${role}`;
}

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function Reconcile() {
  const [month, setMonth] = useState(thisMonth());
  const [branchId, setBranchId] = useState<number | "">("");
  const [policyReference, setPolicyReference] = useState("");
  const [policyAccountantName, setPolicyAccountantName] = useState("");
  const [openingAllocationAmounts, setOpeningAllocationAmounts] = useState<
    Record<string, string>
  >({});
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });
  // الفحص ثقيل نسبياً — لا يُطلَق إلا للمدير، وبلا إعادة جلب تلقائية.
  const recon = trpc.reports.reconcile.useQuery(
    {
      month,
      branchId: branchId ? Number(branchId) : undefined,
    },
    {
      enabled: isAdmin,
      refetchOnWindowFocus: false,
    },
  );
  const openingPreparation =
    trpc.reports.prepareDoubleEntryShadow.useMutation({
      onError: (error) => notify.err(error),
    });

  const setMode = trpc.reports.setDoubleEntryMode.useMutation({
    onSuccess: (result) => {
      notify.ok(
        result.mode === "SHADOW"
          ? "بدأ وضع الظل وسُجّل القرار في التدقيق."
          : result.mode === "ACTIVE"
            ? "اعتمد الدفتر المزدوج بوضع ACTIVE."
            : "أُوقف الدفتر المزدوج مع حفظ اليوميات التاريخية.",
      );
      void recon.refetch();
    },
    onError: (error) => notify.err(error),
  });
  const setPolicyApproval =
    trpc.reports.setDoubleEntryPolicyApproval.useMutation({
      onSuccess: (result) => {
        notify.ok(
          "cleared" in result
            ? "مُسحت مصادقة السياسة وسُجّل السبب في التدقيق."
            : "سُجل مرجع مصادقة السياسة واسم المحاسب في التدقيق.",
        );
        setPolicyReference("");
        setPolicyAccountantName("");
        void recon.refetch();
      },
      onError: (error) => notify.err(error),
    });

  const data = recon.data;

  // أسماء الأطراف لعرضها بجانب المعرّفات الرقمية — تُجلَب فقط عند وجود انحرافات فعلية لهذا
  // المحور (لا داعٍ لجلب القوائم الكاملة عند عدم وجود صفوف تحتاجها). هذه الاستعلامات (وما
  // تحتها من useMemo) يجب أن تُستدعى في كل تصيير بلا شرط (قاعدة الخطاطيف) — لذا هي **قبل**
  // حاجز «غير المدير» أدناه لا بعده، رغم أنها لا تُفعَّل (enabled) إلا للمدير أصلاً.
  const customersQ = trpc.customers.list.useQuery(undefined, {
    enabled: isAdmin && !!data?.customers.length,
  });
  const suppliersQ = trpc.suppliers.list.useQuery(undefined, {
    enabled: isAdmin && !!data?.suppliers.length,
  });
  const partiesQ = trpc.delivery.listParties.useQuery(
    {},
    { enabled: isAdmin && !!data?.delivery.length },
  );
  const customerNames = useMemo(
    () => new Map((customersQ.data ?? []).map((c) => [c.id, c.name])),
    [customersQ.data],
  );
  const supplierNames = useMemo(
    () => new Map((suppliersQ.data ?? []).map((s) => [s.id, s.name])),
    [suppliersQ.data],
  );
  const partyNames = useMemo(
    () => new Map((partiesQ.data ?? []).map((p) => [p.id, p.name])),
    [partiesQ.data],
  );

  // غير المدير: حاجز واضح (الخادم يرفضها أصلاً بـadminProcedure — هذا دفاع طبقي + رسالة لطيفة).
  if (me.data && !isAdmin) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        هذه الشاشة مخصّصة لمسؤول النظام فقط.
      </div>
    );
  }

  const doubleEntryIssues = data
    ? data.doubleEntry.roles.filter((row) => row.drift !== "0.00").length +
      data.doubleEntry.gapCount +
      data.doubleEntry.missingCount +
      data.doubleEntry.extraCount +
      data.doubleEntry.scopeMismatchCount +
      data.doubleEntry.unreconstructableCount +
      data.doubleEntry.sourceMismatchCount +
      data.doubleEntry.imbalancedJournalCount
    : 0;
  const total = data
    ? data.customers.length +
      data.suppliers.length +
      data.delivery.length +
      data.inventory.length +
      data.ledger.length +
      // Codex P1 #2 (٢٦/٨): محور طلبات المتجر — لو نُسي هنا لَعرض الملخصُ «صفر انحراف»
      // بينما الليل يُصدر WARN، ولحُرم المدير من الصفوف اللازمة للتصحيح اليدويّ.
      (data.onlineOrders?.length ?? 0) +
      doubleEntryIssues
    : 0;
  const loading = me.isLoading || (isAdmin && recon.isLoading);

  // تصدير Excel — ورقة مستقلّة لكل محور بنفس بيانات الجدول المعروض (تشمل الأسماء حيث توفّرت).
  function exportAll() {
    if (!data) return;
    const sheet = (
      title: string,
      rows: Row[],
      names?: Map<number, string>,
    ) => ({
      sheetName: title,
      title: `تدقيق التوافق المالي — ${title}`,
      meta: [{ label: "تاريخ الفحص", value: fmtDateTime(data.runAt) }],
      columns: [
        { key: "id", header: "المعرّف" },
        ...(names
          ? [
              {
                key: "name",
                header: "الاسم",
                map: (r: any) => names.get(r.id) ?? "—",
              },
            ]
          : []),
        {
          key: "expected",
          header: "المتوقّع",
          money: true,
          map: (r: any) => Number(r.expected),
        },
        {
          key: "actual",
          header: "الفعلي",
          money: true,
          map: (r: any) => Number(r.actual),
        },
        {
          key: "drift",
          header: "الانحراف",
          money: true,
          map: (r: any) => Number(r.drift),
        },
        { key: "note", header: "ملاحظة", map: (r: any) => r.note ?? "" },
      ],
      rows: rows as any[],
    });
    exportSheets("تدقيق-التوافق-المالي", [
      sheet("ذمم العملاء", data.customers, customerNames),
      sheet("ذمم الموردين", data.suppliers, supplierNames),
      sheet("عهدة التوصيل", data.delivery, partyNames),
      sheet("أرصدة المخزون", data.inventory),
      sheet("قيود الدفتر", data.ledger),
      // Tier-2 #4 (٢٦/٨): محور طلبات المتجر — الصفوف تحمل `note` عربياً مصنَّفاً بالمخالفة.
      sheet("طلبات المتجر × الإرساليات", data.onlineOrders ?? []),
      {
        sheetName: "الدفتر المزدوج",
        title: `مطابقة الدفتر المزدوج — ${data.doubleEntry.scope.month ?? "نافذة الظل"}`,
        meta: [
          {
            label: "النطاق",
            value: `${data.doubleEntry.scope.from} — ${data.doubleEntry.scope.to}`,
          },
          {
            label: "الفرع",
            value: branchId
              ? (branches.data?.find((b) => b.id === branchId)?.name ??
                String(branchId))
              : "كل الفروع",
          },
          { label: "الفجوات", value: String(data.doubleEntry.gapCount) },
          {
            label: "القيود المفقودة",
            value: String(data.doubleEntry.missingCount),
          },
          {
            label: "اختلاف النطاق",
            value: String(data.doubleEntry.scopeMismatchCount),
          },
          { label: "إجمالي الانحراف", value: data.doubleEntry.drift },
        ],
        columns: [
          { key: "role", header: "الدور المحاسبي" },
          {
            key: "expected",
            header: "المتوقّع",
            money: true,
            map: (r: any) => Number(r.expected),
          },
          {
            key: "actual",
            header: "الفعلي",
            money: true,
            map: (r: any) => Number(r.actual),
          },
          {
            key: "drift",
            header: "الانحراف",
            money: true,
            map: (r: any) => Number(r.drift),
          },
        ],
        rows: data.doubleEntry.roles,
      },
      {
        sheetName: "بوابة ACTIVE",
        title: "تفاصيل بوابة اعتماد الدفتر المزدوج",
        meta: [
          { label: "الوضع", value: data.activation.mode },
          {
            label: "بداية الظل",
            value: data.activation.shadowStartedAt
              ? fmtDateTime(data.activation.shadowStartedAt)
              : "غير مسجلة",
          },
          {
            label: "معرّف الدورة",
            value: data.activation.cycleId ?? "غير مسجل",
          },
          {
            label: "بصمة الافتتاح",
            value: data.activation.openingHash ?? "غير مسجلة",
          },
          {
            label: "مرجع مصادقة السياسة",
            value: data.activation.policyApproval?.reference ?? "غير مسجل",
          },
          {
            label: "المطابقة التشغيلية",
            value: data.activation.operationalReconciliation
              ? `${data.activation.operationalReconciliation.driftCount} فرق / ${data.activation.operationalReconciliation.totalAbsoluteDifference}`
              : "غير متاحة",
          },
        ],
        columns: [
          { key: "key", header: "رمز المانع" },
          { key: "label", header: "المانع" },
          {
            key: "actual",
            header: "الفعلي",
            map: (row: any) =>
              typeof row.actual === "number" ? row.actual : (row.actual ?? ""),
          },
          {
            key: "required",
            header: "المطلوب",
            map: (row: any) =>
              typeof row.required === "number" ? row.required : row.required,
          },
          { key: "detail", header: "التفصيل" },
        ],
        rows: data.activation.blockers,
      },
      {
        sheetName: "فروق التشغيل",
        title: "الفروق التشخيصية بين المصادر التشغيلية واليومية",
        meta: [
          {
            label: "تاريخ المطابقة",
            value:
              data.activation.operationalReconciliation?.asOf ?? "غير متاحة",
          },
        ],
        columns: [
          {
            key: "scope",
            header: "النطاق",
            map: (row: any) =>
              row.scope === "GLOBAL" ? "الشركة" : "الفرع",
          },
          {
            key: "branchId",
            header: "معرف الفرع",
            map: (row: any) => row.branchId ?? "—",
          },
          {
            key: "role",
            header: "الدور المحاسبي",
            map: (row: any) => ROLE_LABELS[row.role] ?? row.role,
          },
          {
            key: "operationalNetDebit",
            header: "رصيد المصدر التشغيلي",
            money: true,
            map: (row: any) => Number(row.operationalNetDebit),
          },
          {
            key: "journalNetDebit",
            header: "رصيد اليومية",
            money: true,
            map: (row: any) => Number(row.journalNetDebit),
          },
          {
            key: "difference",
            header: "الفرق",
            money: true,
            map: (row: any) => Number(row.difference),
          },
        ],
        rows:
          data.activation.operationalReconciliation?.mismatches ?? [],
      },
      {
        sheetName: "موانع التشغيل",
        title: "موانع قراءة المصادر التشغيلية",
        columns: [
          { key: "code", header: "الرمز" },
          { key: "source", header: "المصدر" },
          { key: "message", header: "التفصيل" },
          { key: "count", header: "العدد" },
          {
            key: "amount",
            header: "المبلغ",
            money: true,
            map: (row: any) => Number(row.amount ?? 0),
          },
        ],
        rows: data.activation.operationalReconciliation?.blockers ?? [],
      },
      {
        sheetName: "مدة وتغطية",
        title: "مدة الظل وتغطية خرائط القيود",
        columns: [
          { key: "metric", header: "المؤشر" },
          { key: "actual", header: "الفعلي" },
          { key: "required", header: "المطلوب" },
        ],
        rows: [
          {
            metric: "أيام الظل",
            actual: data.activation.shadowDays,
            required: data.activation.requiredShadowDays,
          },
          {
            metric: "أنواع القيود المخططة",
            actual: data.activation.mappedTypes,
            required: data.activation.requiredMappedTypes,
          },
        ],
      },
      {
        sheetName: "نواقص المطابقة",
        title: "عدادات الأحداث غير المطابقة",
        meta: [
          {
            label: "النطاق",
            value: `${data.doubleEntry.scope.from} — ${data.doubleEntry.scope.to}`,
          },
        ],
        columns: [
          { key: "kind", header: "نوع المشكلة" },
          { key: "count", header: "العدد" },
        ],
        rows: [
          { kind: "UNMAPPED", count: data.doubleEntry.gapCount },
          { kind: "MISSING", count: data.doubleEntry.missingCount },
          { kind: "EXTRA", count: data.doubleEntry.extraCount },
          {
            kind: "SCOPE_MISMATCH",
            count: data.doubleEntry.scopeMismatchCount,
          },
          {
            kind: "UNRECONSTRUCTABLE",
            count: data.doubleEntry.unreconstructableCount,
          },
          {
            kind: "SOURCE_MAPPING",
            count: data.doubleEntry.sourceMismatchCount,
          },
          {
            kind: "IMBALANCED_OR_EMPTY_POSTED",
            count: data.doubleEntry.imbalancedJournalCount,
          },
        ],
      },
      {
        sheetName: "الخرائط المفقودة",
        title: "أنواع القيود الحالية التي لا تملك خريطة",
        columns: [{ key: "entryType", header: "EntryType المفقود" }],
        rows: data.activation.unmappedEntryTypes.map((entryType) => ({
          entryType,
        })),
      },
    ]);
  }

  function requestActivation() {
    if (
      !window.confirm(
        "تأكيد اعتماد ACTIVE: بعد التفعيل سيفشل أي حدث مالي لا يملك خريطة أو بيانات مكتملة، وستتراجع معاملة الأعمال كاملة. هل راجعت كل موانع البوابة وتريد المتابعة؟",
      )
    )
      return;
    setMode.mutate({ target: "ACTIVE" });
  }

  function requestStartShadow() {
    const prepared = openingPreparation.data;
    if (!prepared) {
      notify.warn("أعدّ معاينة الافتتاح أولاً.");
      return;
    }
    if (!prepared.preview.canApprove) {
      notify.warn("لا يمكن بدء الظل قبل معالجة موانع لقطة الافتتاح.");
      return;
    }
    if (
      !window.confirm(
        "تأكيد لقطة القطع وبدء SHADOW؟ ستُعاد مطابقة البصمة داخل معاملة ذرية. اللقطة تنقل أرصدة الميزانية عند القطع ولا تعيد بناء أرباح وخسائر ما قبل تاريخ القطع.",
      )
    )
      return;
    setMode.mutate({
      target: "SHADOW",
      preparationToken: prepared.preparationToken,
      expectedOpeningHash: prepared.preview.openingHash,
      allocations: prepared.preview.manualAllocations,
    });
  }

  function prepareInitialOpening() {
    setOpeningAllocationAmounts({});
    openingPreparation.mutate({ allocations: [] });
  }

  function prepareAllocatedOpening() {
    const prepared = openingPreparation.data;
    if (!prepared) return;
    const allocations: OpeningAllocation[] = [];
    try {
      for (const scope of prepared.preview.unallocatedOpeningBalance.scopes) {
        let allocated = D(0);
        for (const role of OPENING_ALLOCATION_ROLES) {
          const raw = (openingAllocationAmounts[allocationKey(scope.branchId, role)] ?? "").trim();
          if (!raw) continue;
          if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !D(raw).isPositive()) {
            notify.warn("كل مبلغ تخصيص يجب أن يكون موجباً وبدقة منزلتين كحد أقصى.");
            return;
          }
          const amount = round2(D(raw)).toFixed(2);
          allocated = allocated.plus(amount);
          allocations.push({
            role,
            branchId: scope.branchId,
            debit: scope.debit !== "0.00" ? amount : "0.00",
            credit: scope.credit !== "0.00" ? amount : "0.00",
          });
        }
        const required = D(scope.debit).plus(scope.credit);
        if (!round2(allocated).eq(round2(required))) {
          notify.warn(
            `تخصيص النطاق ${scope.branchId == null ? "العام" : `فرع ${scope.branchId}`} يجب أن يساوي ${fmt(required.toFixed(2))}.`,
          );
          return;
        }
      }
    } catch {
      notify.warn("تعذّر قراءة مبالغ التخصيص؛ راجع القيم المدخلة.");
      return;
    }
    openingPreparation.mutate({ allocations });
  }

  function requestStop() {
    const reason = window.prompt(
      "أدخل سبب إيقاف الدفتر المزدوج. سيُحفظ السبب في سجل التدقيق ولن تُحذف اليوميات التاريخية:",
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      notify.warn("سبب الإيقاف يجب ألا يقل عن 10 أحرف.");
      return;
    }
    if (
      !window.confirm(
        "تأكيد الإيقاف إلى OFF؟ ستتوقف كتابة القيود المزدوجة الجديدة، وتبقى اليوميات السابقة محفوظة.",
      )
    )
      return;
    setMode.mutate({ target: "OFF", reason: trimmed });
  }

  function approvePolicy() {
    const reference = policyReference.trim();
    const accountantName = policyAccountantName.trim();
    if (reference.length < 10) {
      notify.warn("مرجع المصادقة يجب ألا يقل عن 10 أحرف.");
      return;
    }
    if (accountantName.length < 3) {
      notify.warn("اسم المحاسب يجب ألا يقل عن 3 أحرف.");
      return;
    }
    setPolicyApproval.mutate({
      action: "APPROVE",
      reference,
      accountantName,
    });
  }

  function clearPolicyApproval() {
    const reason = window.prompt(
      "أدخل سبب مسح مصادقة السياسة. سيُحفظ السبب في سجل التدقيق:",
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      notify.warn("سبب المسح يجب ألا يقل عن 10 أحرف.");
      return;
    }
    setPolicyApproval.mutate({ action: "CLEAR", reason: trimmed });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تدقيق التوافق المالي"
        description="يكشف الانجراف الصامت في ذمم العملاء والموردين، عهدة تحصيلات التوصيل، المخزون والدفتر. الأخضر = متوازن، الأحمر = انحراف يستوجب المراجعة. لا يصحّح النظام أي فرق بصمت."
        actions={
          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs text-muted-foreground" dir="ltr">
                آخر فحص:{" "}
                <span dir="ltr" className="tabular-nums">
                  {fmtDateTime(data.runAt)}
                </span>
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!data}
              onClick={exportAll}
              className="inline-flex items-center gap-1.5"
            >
              <FileDown aria-hidden className="size-4" />
              تصدير Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!isAdmin || recon.isFetching}
              onClick={() => recon.refetch()}
            >
              {recon.isFetching ? "جارٍ الفحص…" : "إعادة الفحص"}
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">
              شهر المطابقة
            </label>
            <MonthPicker
              value={month}
              onChange={setMonth}
              ariaLabel="شهر مطابقة الدفتر المزدوج"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(event) =>
                setBranchId(
                  event.target.value ? Number(event.target.value) : "",
                )
              }
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">
            نطاق التقرير يتبع تاريخ القيد داخل الشهر والفرع المختارين. بوابة
            ACTIVE مستقلة وتفحص كل الأحداث منذ بدء الظل على جميع الفروع.
          </p>
        </CardContent>
      </Card>

      {loading && <LoadingState />}

      {recon.error && (
        <ErrorState
          message={`تعذّر التدقيق: ${recon.error.message}`}
          onRetry={() => recon.refetch()}
        />
      )}

      {data && !recon.error && (
        <>
          <DoubleEntryStatus
            reconciliation={data.doubleEntry}
            activation={data.activation}
            openingPreparation={openingPreparation.data ?? null}
            openingPreparationError={openingPreparation.error?.message ?? null}
            preparingOpening={openingPreparation.isPending}
            busy={
              setMode.isPending ||
              setPolicyApproval.isPending ||
              openingPreparation.isPending
            }
            openingAllocationAmounts={openingAllocationAmounts}
            onOpeningAllocationAmountChange={(key, value) =>
              setOpeningAllocationAmounts((current) => ({
                ...current,
                [key]: value,
              }))
            }
            policyReference={policyReference}
            policyAccountantName={policyAccountantName}
            onPolicyReferenceChange={setPolicyReference}
            onPolicyAccountantNameChange={setPolicyAccountantName}
            onApprovePolicy={approvePolicy}
            onClearPolicy={clearPolicyApproval}
            onPrepareShadow={prepareInitialOpening}
            onPrepareAllocatedShadow={prepareAllocatedOpening}
            onStartShadow={requestStartShadow}
            onActivate={requestActivation}
            onStop={requestStop}
          />

          <Card>
            <CardContent
              className={`p-6 text-center text-lg font-bold inline-flex items-center justify-center gap-2 w-full ${
                total === 0 ? "badge-status-active" : "badge-stock-out"
              }`}
            >
              {total === 0 ? (
                <>
                  <Check aria-hidden className="size-5" />
                  كل المحاور متوازنة — لا انحراف
                </>
              ) : (
                <>
                  <AlertTriangle aria-hidden className="size-5" />
                  {`${total} انحراف يستوجب المراجعة`}
                </>
              )}
            </CardContent>
          </Card>

          <DriftSection
            title="ذمم العملاء"
            desc="الفرق بين الرصيد المُشتقّ من الفواتير (إجمالي − مدفوع − مُرتجَع) والمسجَّل في currentBalance."
            idLabel="رقم العميل"
            money
            rows={data.customers}
            names={customerNames}
            link={(id) => `/customers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="ذمم الموردين"
            desc="الفرق بين الرصيد المُشتقّ من المشتريات والتسديدات والمسجَّل على المورد."
            idLabel="رقم المورد"
            money
            rows={data.suppliers}
            names={supplierNames}
            link={(id) => `/suppliers-statement?id=${id}`}
            linkLabel="كشف الحساب"
          />

          <DriftSection
            title="عهدة تحصيلات التوصيل"
            desc="الفرق بين مبالغ COD المسلّمة للمندوب والمبالغ المورّدة أو المشطوبة وبين رصيده المسجّل."
            idLabel="رقم جهة التوصيل"
            money
            rows={data.delivery}
            names={partyNames}
            link={() => "/delivery?tab=parties"}
            linkLabel="جهات التوصيل"
          />

          <DriftSection
            title="أرصدة المخزون"
            desc="رصيد سالب لمتغيّر في فرع — يجب ألّا يقلّ عن صفر."
            idLabel="رقم المتغيّر"
            rows={data.inventory}
            link={() => `/inventory`}
            linkLabel="المخزون"
            action={
              data.inventory.length > 0 ? (
                <Link
                  href={`/stocktakes/new?variants=${Array.from(new Set(data.inventory.map((r) => r.id))).join(",")}&name=${encodeURIComponent("جرد تحقّق — انحرافات التدقيق المالي")}`}
                >
                  <Button
                    size="sm"
                    className="inline-flex items-center gap-1.5"
                  >
                    <ClipboardList aria-hidden className="size-4" />
                    أنشئ جلسة جرد لهذه المنتجات
                  </Button>
                </Link>
              ) : null
            }
          />

          <DriftSection
            title="قيود الدفتر"
            desc="قيود لا يتطابق فيها الربح مع (الإيراد − التكلفة)."
            idLabel="رقم القيد"
            money
            rows={data.ledger}
          />

          {/*
            Tier-2 #4 (٢٦/٨): سلامة الربط بين طلب المتجر والإرسالية — أربع حالاتٍ حاكمة
            (يحسبها `reconcileOnlineOrderConsignmentSync`). العمود «الانحراف» رقمٌ رمزيّ
            (١ لكل صفّ)، والمحتوى الحاكم في `note` الذي يسمّي الطلب والإرسالية والحالة.
          */}
          <DriftSection
            title="طلبات المتجر × الإرساليات"
            desc="فروق حالة/إسناد بين onlineOrders وdeliveryConsignments — الإصلاح يدويّ بفتح الطلب."
            idLabel="رقم الطلب"
            rows={data.onlineOrders ?? []}
            link={(id) => `/store-admin/orders/${id}`}
            linkLabel="فتح الطلب"
          />
        </>
      )}
    </div>
  );
}

export const ROLE_LABELS: Record<string, string> = {
  ...EXCHANGE_DOUBLE_ENTRY_ROLE_LABELS,
  AR: "ذمم العملاء",
  AP: "ذمم الموردين",
  CASH: "النقد",
  TREASURY_CASH: "نقد الخزينة",
  CARD_BANK: "البطاقة / البنك",
  INVENTORY: "المخزون",
  FIXED_ASSETS: "الأصول الثابتة",
  ACCUMULATED_DEPRECIATION: "مجمع الإهلاك",
  CONSIGNMENT_PAYABLE: "مستحقات مودعي الأمانة",
  DELIVERY_FLOAT: "عهدة التوصيل",
  EXCHANGE_WALLET_IQD: "محفظة الصيرفة بالدينار",
  EXCHANGE_WALLET_USD: "محفظة الصيرفة بالدولار",
  DIGITAL_WALLET: "المحافظ الرقمية",
  CAPITAL: "رأس المال",
  RETAINED_EARNINGS: "الأرباح المحتجزة",
  OWNER_CURRENT: "جاري المالك",
  LOAN_PAYABLE: "قروض مستحقة",
  SALES_STATIONERY: "إيراد القرطاسية",
  SALES_PRINT: "إيراد الطباعة",
  SALES_FLEX: "إيراد الفلكس",
  DELIVERY_REVENUE: "إيراد التوصيل",
  COGS: "تكلفة البضاعة المباعة",
  OPENING_EQUITY: "حقوق الرصيد الافتتاحي",
};

export function doubleEntryRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function DoubleEntryStatus({
  reconciliation,
  activation,
  openingPreparation,
  openingPreparationError,
  preparingOpening,
  openingAllocationAmounts,
  onOpeningAllocationAmountChange,
  busy,
  policyReference,
  policyAccountantName,
  onPolicyReferenceChange,
  onPolicyAccountantNameChange,
  onApprovePolicy,
  onClearPolicy,
  onPrepareShadow,
  onPrepareAllocatedShadow,
  onStartShadow,
  onActivate,
  onStop,
}: {
  reconciliation: DoubleEntryData;
  activation: ActivationData;
  openingPreparation: OpeningPreparation | null;
  openingPreparationError: string | null;
  preparingOpening: boolean;
  openingAllocationAmounts: Record<string, string>;
  onOpeningAllocationAmountChange: (key: string, value: string) => void;
  busy: boolean;
  policyReference: string;
  policyAccountantName: string;
  onPolicyReferenceChange: (value: string) => void;
  onPolicyAccountantNameChange: (value: string) => void;
  onApprovePolicy: () => void;
  onClearPolicy: () => void;
  onPrepareShadow: () => void;
  onPrepareAllocatedShadow: () => void;
  onStartShadow: () => void;
  onActivate: () => void;
  onStop: () => void;
}) {
  const modeLabel =
    activation.mode === "OFF"
      ? "متوقف"
      : activation.mode === "SHADOW"
        ? "ظل"
        : "فعّال";
  const modeClass =
    activation.mode === "ACTIVE"
      ? activation.blockers.length === 0
        ? "badge-status-active"
        : "badge-stock-out"
      : activation.mode === "SHADOW"
        ? "badge-status-pending"
        : "badge-status-cancelled";
  const monthlyIssueCount =
    reconciliation.roles.filter((row) => row.drift !== "0.00").length +
    reconciliation.gapCount +
    reconciliation.missingCount +
    reconciliation.extraCount +
    reconciliation.scopeMismatchCount +
    reconciliation.unreconstructableCount +
    reconciliation.sourceMismatchCount +
    reconciliation.imbalancedJournalCount;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
          <span className="inline-flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4" />
            حالة الدفتر المزدوج وبوابة ACTIVE
          </span>
          <span className={`rounded-full px-3 py-1 text-xs ${modeClass}`}>
            الوضع: {modeLabel}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <GateMetric
            label="مدة الظل"
            value={`${activation.shadowDays}/${activation.requiredShadowDays} يوم`}
            ok={activation.shadowDays >= activation.requiredShadowDays}
          />
          <GateMetric
            label="خرائط القيود"
            value={`${activation.mappedTypes}/${activation.requiredMappedTypes}`}
            ok={
              activation.mappedTypes === activation.requiredMappedTypes &&
              activation.unmappedEntryTypes.length === 0
            }
          />
          <GateMetric
            label="فجوات نافذة الظل"
            value={String(
              activation.gapCount +
                activation.missingCount +
                activation.extraCount +
                activation.scopeMismatchCount +
                activation.unreconstructableCount +
                activation.sourceMismatchCount,
            )}
            ok={
              activation.gapCount +
                activation.missingCount +
                activation.extraCount +
                activation.scopeMismatchCount +
                activation.unreconstructableCount ===
              0
            }
          />
          <GateMetric
            label="انحراف نافذة الظل"
            value={fmt(activation.drift)}
            ok={
              activation.drift === "0.00" &&
              activation.journalImbalance === "0.00" &&
              activation.imbalancedJournalCount === 0
            }
          />
          <GateMetric
            label="سلامة لقطة الافتتاح"
            value={
              activation.openingVerification
                ? `${activation.openingVerification.entryCount} قيد / ${activation.openingVerification.lineCount} سطر`
                : "غير متاحة"
            }
            ok={activation.openingVerification?.hashMatches === true}
          />
          <GateMetric
            label="المطابقة التشغيلية"
            value={
              activation.operationalReconciliation
                ? `${activation.operationalReconciliation.driftCount} فرق / ${fmt(activation.operationalReconciliation.totalAbsoluteDifference)}`
                : "غير متاحة"
            }
            ok={activation.operationalReconciliation?.ok === true}
          />
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          {EXCHANGE_CONTROL_SCOPE_DISCLOSURE}
        </div>

        {activation.operationalReconciliation &&
          (activation.operationalReconciliation.mismatches.length > 0 ||
            activation.operationalReconciliation.blockers.length > 0) && (
            <div className="space-y-3 rounded-md border p-3">
              <div>
                <div className="font-semibold">تفاصيل فروق المطابقة التشغيلية</div>
                <p className="text-xs text-muted-foreground">
                  تعرض الصفوف المختلفة فقط لتحديد المصدر والدور والفرع الذي يحتاج
                  إلى معالجة قبل اعتماد الدفتر.
                </p>
              </div>
              {activation.operationalReconciliation.mismatches.length > 0 && (
                <ScrollTableShell bordered={false}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="px-3 py-2 text-start">النطاق</th>
                        <th className="px-3 py-2 text-start">الدور المحاسبي</th>
                        <th className="px-3 py-2 text-end">المصدر التشغيلي</th>
                        <th className="px-3 py-2 text-end">اليومية</th>
                        <th className="px-3 py-2 text-end">الفرق</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activation.operationalReconciliation.mismatches.map(
                        (row) => (
                          <tr
                            key={`${row.scope}:${row.branchId ?? "GLOBAL"}:${row.role}`}
                            className="border-t"
                          >
                            <td className="px-3 py-2">
                              {row.scope === "GLOBAL"
                                ? "الشركة"
                                : `الفرع ${row.branchId}`}
                            </td>
                            <td className="px-3 py-2">
                              {ROLE_LABELS[row.role] ?? row.role}
                            </td>
                            <td className="px-3 py-2 text-end tabular-nums">
                              {fmt(row.operationalNetDebit)}
                            </td>
                            <td className="px-3 py-2 text-end tabular-nums">
                              {fmt(row.journalNetDebit)}
                            </td>
                            <td className="px-3 py-2 text-end tabular-nums text-destructive">
                              {fmt(row.difference)}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </ScrollTableShell>
              )}
              {activation.operationalReconciliation.blockers.map((item) => (
                <div
                  key={`${item.code}:${item.source}`}
                  className="rounded-md border border-destructive/30 p-2 text-sm"
                >
                  <div className="font-medium">{item.code}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.message} ({item.source})
                  </div>
                </div>
              ))}
            </div>
          )}

        {activation.cycleId && (
          <div className="text-xs text-muted-foreground">
            معرّف الدورة: {" "}
            <span className="font-mono" dir="ltr">
              {activation.cycleId}
            </span>
          </div>
        )}

        {activation.mode === "ACTIVE" && activation.blockers.length === 0 ? (
          <div className="badge-status-active flex items-center gap-2 rounded-md p-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-4" />
            تم اعتماد ACTIVE بعد اجتياز البوابة. يستمر التقرير في عرض أي فجوات
            أو انحرافات لاحقة.
          </div>
        ) : activation.blockers.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="inline-flex items-center gap-2 font-semibold">
              <AlertTriangle aria-hidden className="size-4 text-destructive" />
              {activation.mode === "ACTIVE"
                ? "مشكلات صحة الدفتر الفعّال"
                : "موانع التفعيل"}
            </div>
            {activation.blockers.map((item) => (
              <div key={item.key} className="flex items-start gap-2 text-sm">
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div>
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="badge-status-active flex items-center gap-2 rounded-md p-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-4" />
            اجتازت البوابة كل الشروط: {activation.requiredShadowDays} يوماً، صفر
            فجوات، انحراف صفر، و{activation.requiredMappedTypes}/
            {activation.requiredMappedTypes} خريطة.
          </div>
        )}

        <div className="space-y-3 rounded-md border p-3">
          <div>
            <div className="font-semibold">مصادقة السياسة المحاسبية</div>
            <p className="text-xs text-muted-foreground">
              يسجل النظام مرجع مراجعة محاسب بشري واسم المراجع كحوكمة داخلية،
              من دون ادعاء اعتماد معياري أو حكومي. تُسجل المصادقة بعد بدء
              SHADOW كي ترتبط بلقطة الدورة الفعلية.
            </p>
          </div>
          {activation.policyApproval ? (
            <div className="flex flex-wrap items-end justify-between gap-3">
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">المرجع</dt>
                  <dd className="font-medium">{activation.policyApproval.reference}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">المحاسب</dt>
                  <dd className="font-medium">
                    {activation.policyApproval.accountantName}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">سُجلت في</dt>
                  <dd className="tabular-nums" dir="ltr">
                    {fmtDateTime(activation.policyApproval.approvedAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">الدورة المعتمدة</dt>
                  <dd className="font-mono text-xs" dir="ltr">
                    {activation.policyApproval.cycleId}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">بصمة الافتتاح</dt>
                  <dd className="font-mono text-xs" dir="ltr">
                    {activation.policyApproval.openingHash}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">إصدار سياسة الترحيل</dt>
                  <dd className="font-mono text-xs" dir="ltr">
                    {activation.policyApproval.policyHash}
                  </dd>
                </div>
              </dl>
              {activation.mode !== "ACTIVE" && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={onClearPolicy}
                >
                  مسح المصادقة
                </Button>
              )}
            </div>
          ) : (
            <div className="grid items-end gap-3 lg:grid-cols-[1fr_1fr_auto]">
              <label className="space-y-1 text-xs font-medium">
                مرجع المصادقة
                <Input
                  value={policyReference}
                  maxLength={255}
                  disabled={busy || activation.mode !== "SHADOW"}
                  onChange={(event) =>
                    onPolicyReferenceChange(event.target.value)
                  }
                  placeholder="رقم/عنوان محضر المراجعة (10 أحرف على الأقل)"
                />
              </label>
              <label className="space-y-1 text-xs font-medium">
                اسم المحاسب المراجع
                <Input
                  value={policyAccountantName}
                  maxLength={150}
                  disabled={busy || activation.mode !== "SHADOW"}
                  onChange={(event) =>
                    onPolicyAccountantNameChange(event.target.value)
                  }
                  placeholder="الاسم الصريح للمحاسب"
                />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  activation.mode !== "SHADOW" ||
                  policyReference.trim().length < 10 ||
                  policyAccountantName.trim().length < 3
                }
                onClick={onApprovePolicy}
              >
                تسجيل المصادقة
              </Button>
            </div>
          )}
        </div>

        {activation.mode === "OFF" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-semibold">معاينة لقطة القطع الافتتاحية</div>
                <p className="max-w-3xl text-xs text-muted-foreground">
                  اللقطة الآلية تنقل أرصدة الميزانية الفعلية عند تاريخ القطع إلى
                  الدورة الجديدة. لا تعيد بناء قائمة الأرباح والخسائر التاريخية،
                  ولا يجوز عرض أرقام ما قبل القطع على أنها YTD من الدفتر المزدوج.
                  أول إقفال سنوي رسمي يتطلب أن تغطي الدورة السنة كاملة من 1 كانون
                  الثاني.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onPrepareShadow}
              >
                <Clock3 aria-hidden className="size-4" />
                {preparingOpening ? "جارٍ إعداد المعاينة…" : "إعداد معاينة"}
              </Button>
            </div>

            {openingPreparationError && (
              <div className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">
                تعذّر إعداد المعاينة: {openingPreparationError}
              </div>
            )}

            {openingPreparation && (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <GateMetric
                    label="تاريخ القطع"
                    value={openingPreparation.preview.asOf}
                    ok={openingPreparation.preview.canApprove}
                  />
                  <GateMetric
                    label="إجمالي المدين"
                    value={fmt(openingPreparation.preview.totals.debit)}
                    ok={openingPreparation.preview.totals.isBalanced}
                  />
                  <GateMetric
                    label="إجمالي الدائن"
                    value={fmt(openingPreparation.preview.totals.credit)}
                    ok={openingPreparation.preview.totals.isBalanced}
                  />
                  <GateMetric
                    label="مجموعات/أسطر الافتتاح"
                    value={`${openingPreparation.preview.journalGroups.length}/${openingPreparation.preview.lines.length}`}
                    ok={
                      openingPreparation.preview.canApprove &&
                      openingPreparation.preview.lines.length > 0
                    }
                  />
                </div>

                <ScrollTableShell bordered={false}>
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2">الدور المحاسبي</th>
                        <th className="p-2 text-right">مدين</th>
                        <th className="p-2 text-right">دائن</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openingPreparation.preview.roleTotals.map((row) => (
                        <tr key={row.role} className="border-t">
                          <td className="p-2 font-medium">
                            {ROLE_LABELS[row.role] ?? row.role}
                          </td>
                          <td className="p-2 text-right tabular-nums" dir="ltr">
                            {fmt(row.debit)}
                          </td>
                          <td className="p-2 text-right tabular-nums" dir="ltr">
                            {fmt(row.credit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollTableShell>

                {openingPreparation.preview.unallocatedOpeningBalance.scopes
                  .length > 0 && (
                  <div className="space-y-3 rounded-md border p-3">
                    <div>
                      <div className="font-semibold">
                        تخصيص الرصيد الافتتاحي غير المنسوب
                      </div>
                      <p className="text-xs text-muted-foreground">
                        هذا ليس موازنة آلية. يوزع المحاسب الطرف المقابل لكل
                        نطاق على حسابات حقوق الملكية أو القرض الصحيحة، ويُعاد
                        بناء البصمة بعد اكتمال المبلغ بالفلس.
                      </p>
                    </div>
                    {openingPreparation.preview.unallocatedOpeningBalance.scopes.map(
                      (scope) => (
                        <div
                          key={scope.branchId ?? "GLOBAL"}
                          className="space-y-2 border-t pt-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span className="font-medium">
                              {scope.branchId == null
                                ? "نطاق الشركة العام"
                                : `الفرع رقم ${scope.branchId}`}
                            </span>
                            <span>
                              المطلوب {scope.debit !== "0.00" ? "مدين" : "دائن"}: {" "}
                              <span className="font-semibold tabular-nums" dir="ltr">
                                {fmt(
                                  scope.debit !== "0.00"
                                    ? scope.debit
                                    : scope.credit,
                                )}
                              </span>
                            </span>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            {OPENING_ALLOCATION_ROLES.map((role) => {
                              const key = allocationKey(scope.branchId, role);
                              return (
                                <label key={role} className="space-y-1 text-xs font-medium">
                                  {ROLE_LABELS[role] ?? role}
                                  <Input
                                    value={openingAllocationAmounts[key] ?? ""}
                                    inputMode="decimal"
                                    dir="ltr"
                                    placeholder="0.00"
                                    disabled={busy}
                                    onChange={(event) =>
                                      onOpeningAllocationAmountChange(
                                        key,
                                        event.target.value,
                                      )
                                    }
                                  />
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ),
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={onPrepareAllocatedShadow}
                    >
                      إعادة المعاينة بالتخصيص
                    </Button>
                  </div>
                )}

                {openingPreparation.preview.blockers.length > 0 && (
                  <div className="space-y-1 rounded-md border border-destructive/40 p-2">
                    {openingPreparation.preview.blockers.map((item) => (
                      <div key={`${item.code}-${item.source}`} className="text-sm">
                        <span className="font-medium">{item.source}:</span>{" "}
                        {item.message}
                      </div>
                    ))}
                  </div>
                )}

                <div className="rounded-md bg-muted/40 p-2 text-xs">
                  <span className="font-medium">بصمة اللقطة:</span>{" "}
                  <span className="break-all font-mono" dir="ltr">
                    {openingPreparation.preview.openingHash}
                  </span>
                  <div className="mt-1 text-muted-foreground">
                    تنتهي صلاحية التأكيد في {fmtDateTime(openingPreparation.expiresAt)}؛
                    وأي تغير في الأرصدة يفرض معاينة جديدة.
                  </div>
                </div>

                <Button
                  type="button"
                  disabled={busy || !openingPreparation.preview.canApprove}
                  onClick={onStartShadow}
                >
                  <ShieldCheck aria-hidden className="size-4" />
                  تأكيد اللقطة وبدء وضع الظل
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {activation.mode === "OFF" && (
            <span className="text-xs text-muted-foreground">
              يبدأ وضع الظل من زر تأكيد لقطة القطع أعلاه.
            </span>
          )}
          {activation.mode === "SHADOW" && (
            <>
              <Button
                disabled={busy || !activation.ok}
                onClick={onActivate}
                title={
                  !activation.ok
                    ? activation.blockers.map((item) => item.label).join("، ")
                    : undefined
                }
              >
                <ShieldCheck aria-hidden className="size-4" />
                اعتماد ACTIVE عبر البوابة
              </Button>
              <Button variant="destructive" disabled={busy} onClick={onStop}>
                <Power aria-hidden className="size-4" />
                إيقاف إلى OFF
              </Button>
            </>
          )}
          {activation.mode === "ACTIVE" && (
            <>
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <Check aria-hidden className="size-4" />
                الدفتر المزدوج مُعتمد.
              </span>
              <Button variant="destructive" disabled={busy} onClick={onStop}>
                <Power aria-hidden className="size-4" />
                إيقاف إلى OFF
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            التحكم محصور بمالك النظام/المدير العام، وكل انتقال يُكتب في سجل
            التدقيق داخل المعاملة نفسها.
          </span>
        </div>

        <div className="border-t pt-4">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold">مطابقة الشهر المختار</h3>
              <p className="text-xs text-muted-foreground">
                {reconciliation.scope.from} — {reconciliation.scope.to} ·{" "}
                {reconciliation.sourceEntryCount} حدثاً مصدرياً ·{" "}
                {reconciliation.journalEntryCount} رأس يومية
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${monthlyIssueCount === 0 ? "badge-status-active" : "badge-stock-out"}`}
            >
              {monthlyIssueCount === 0
                ? "مطابق"
                : `${monthlyIssueCount} مانعاً/انحرافاً`}
            </span>
          </div>

          {reconciliation.roles.length > 0 ? (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2">الدور المحاسبي</th>
                    <th className="p-2 text-right">المتوقّع</th>
                    <th className="p-2 text-right">الفعلي</th>
                    <th className="p-2 text-right">الانحراف</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliation.roles.map((row) => (
                    <tr key={row.role} className="border-t">
                      <td className="p-2 font-medium">
                        {ROLE_LABELS[row.role] ?? row.role}
                        <div
                          className="text-[11px] font-normal text-muted-foreground"
                          dir="ltr"
                        >
                          {row.role}
                        </div>
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {fmt(row.expected)}
                      </td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {fmt(row.actual)}
                      </td>
                      <td
                        className={
                          row.drift === "0.00"
                            ? "p-2 text-right tabular-nums"
                            : "p-2 text-right tabular-nums font-semibold text-money-negative"
                        }
                        dir="ltr"
                      >
                        {fmt(row.drift)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          ) : (
            <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
              لا أحداث مالية في هذا النطاق.
            </p>
          )}

          {(reconciliation.gapCount > 0 ||
            reconciliation.missingCount > 0 ||
            reconciliation.extraCount > 0 ||
            reconciliation.scopeMismatchCount > 0 ||
            reconciliation.unreconstructableCount > 0 ||
            reconciliation.sourceMismatchCount > 0) && (
            <div className="mt-2 text-xs text-muted-foreground">
              الفجوات: {reconciliation.gapCount} · المفقودة:{" "}
              {reconciliation.missingCount} · الزائدة:{" "}
              {reconciliation.extraCount} · اختلاف النطاق:{" "}
              {reconciliation.scopeMismatchCount} · غير القابلة لإعادة المطابقة:{" "}
              {reconciliation.unreconstructableCount} · اختلاف دليل المصدر:{" "}
              {reconciliation.sourceMismatchCount}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function GateMetric({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2 font-semibold tabular-nums">
        {ok ? (
          <Check aria-hidden className="size-4" />
        ) : (
          <AlertTriangle aria-hidden className="size-4 text-destructive" />
        )}
        <span dir="ltr">{value}</span>
      </div>
    </div>
  );
}

function DriftSection({
  title,
  desc,
  idLabel,
  rows,
  money,
  link,
  linkLabel,
  action,
  names,
}: {
  title: string;
  desc: string;
  idLabel: string;
  rows: Row[];
  money?: boolean;
  link?: (id: number) => string;
  linkLabel?: string;
  action?: React.ReactNode;
  /** اسم الطرف (عميل/مورّد/جهة توصيل) بحسب المعرّف — يُعرض تحت الرقم إن تُوفِّر. */
  names?: Map<number, string>;
}) {
  const val = (s: string) => (money ? fmt(s) : s);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold inline-flex items-center gap-1 ${
                rows.length === 0 ? "badge-status-active" : "badge-stock-out"
              }`}
            >
              {rows.length === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" />
                  لا انحراف
                </>
              ) : (
                `${rows.length} انحراف`
              )}
            </span>
          </div>
        </div>
        {rows.length > 0 && (
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">{idLabel}</th>
                  <th className="p-2 text-right">المتوقّع</th>
                  <th className="p-2 text-right">الفعلي</th>
                  <th className="p-2 text-right">الانحراف</th>
                  {link && <th className="p-2 text-center">إجراء</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  // المخزون: متغيّر سالب في فرعين يُنتج id مكرّراً (reconcileInventory يُسقط branchId) ⇒ مفتاح مركّب بالـindex.
                  <tr key={`${title}-${r.id}-${i}`} className="border-t">
                    <td className="p-2 font-medium">
                      <div className="tabular-nums" dir="ltr">
                        {r.id}
                      </div>
                      {names && (
                        <div className="text-xs font-normal text-muted-foreground">
                          {names.get(r.id) ?? "—"}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {val(r.expected)}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {val(r.actual)}
                    </td>
                    <td
                      className="p-2 text-right font-semibold tabular-nums text-money-negative"
                      dir="ltr"
                    >
                      {val(r.drift)}
                      {r.note && (
                        <span
                          dir="rtl"
                          className="mr-2 inline-block rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-bold text-amber-800"
                        >
                          {r.note}
                        </span>
                      )}
                    </td>
                    {link && (
                      <td className="p-2 text-center">
                        <RowActions
                          mode="inline"
                          actions={[
                            {
                              key: "open",
                              kind: "view",
                              label: linkLabel,
                              href: link(r.id),
                              gate: { adminOnly: true },
                            },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTableShell>
        )}
      </CardContent>
    </Card>
  );
}
