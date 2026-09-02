import { PageHeader } from "@/components/PageHeader";
import { AppSelect } from "@/components/ui/AppSelect";
import { LoadingState, ErrorState } from "@/components/PageState";
import { MonthPicker, thisMonth } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { D, fmt, round2 } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACTION_LABELS } from "@shared/actionLabels";
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

/** صفوفٌ مشتقّة من عقد الخادم فلا تنجرف عنه. */
type OperationalMismatchRow = NonNullable<
  ActivationData["operationalReconciliation"]
>["mismatches"][number];
type OpeningRoleTotalRow = OpeningPreparation["preview"]["roleTotals"][number];
type DoubleEntryRoleRow = DoubleEntryData["roles"][number];

/** جداول هذه الشاشة كلّها مُضمَّنة في بطاقاتٍ/أقسامٍ تحمل عناوينها وعدَّها ⇒ بلا شريط حالة. */
const PANEL_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

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
  /** حوار السبب الموحَّد (بديل window.prompt): إيقاف الدفتر أو مسح مصادقة السياسة.
      يُعلَن هنا مع بقيّة الحالة — أي قبل حاجز «غير المدير» أدناه — التزاماً بقاعدة الخطّافات.
      النوع منفصلٌ عن راية الفتح عمداً: تصفيرُه عند الإغلاق يقلب عناوين الحوار أثناء
      حركة الخروج فيقرأ المستعمل عنواناً غير الذي أكّده. */
  const [reasonKind, setReasonKind] = useState<"STOP" | "CLEAR_POLICY">("STOP");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");
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
      setReasonOpen(false);
      setReasonText("");
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
        setReasonOpen(false);
        setReasonText("");
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
      // Tier-3 #5 (٢٧/٨): محور أيتام journalLines — نفس السبب: لو نُسي هنا لصار WARN
      // الليلة صامتاً عن المدير.
      (data.journalOrphans?.length ?? 0) +
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
      // Tier-3 #5 (٢٧/٨): محور أيتام journalLines — role/accountId + note شارحٌ للخيار المُقترَح.
      sheet("أيتام قيود الدفتر", data.journalOrphans ?? []),
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

  async function requestActivation() {
    if (
      !(await confirm({
        variant: "danger",
        title: "اعتماد الدفتر المزدوج بوضع ACTIVE؟",
        description:
          "بعد التفعيل سيفشل أي حدث مالي لا يملك خريطة أو بيانات مكتملة، وستتراجع معاملة الأعمال كاملة. هل راجعت كل موانع البوابة وتريد المتابعة؟",
        confirmText: "اعتماد ACTIVE",
      }))
    )
      return;
    setMode.mutate({ target: "ACTIVE" });
  }

  async function requestStartShadow() {
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
      !(await confirm({
        variant: "warning",
        title: "تأكيد لقطة القطع وبدء وضع الظل؟",
        description:
          "ستُعاد مطابقة البصمة داخل معاملة ذرية. اللقطة تنقل أرصدة الميزانية عند القطع ولا تعيد بناء أرباح وخسائر ما قبل تاريخ القطع.",
        confirmText: "بدء وضع الظل",
      }))
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

  /** إيقاف الدفتر المزدوج — السبب إلزاميّ (10 أحرف فأكثر) والتأكيد صريحٌ في الحوار نفسه. */
  function requestStop() {
    setReasonText("");
    setReasonKind("STOP");
    setReasonOpen(true);
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

  /** مسح مصادقة السياسة — السبب إلزاميّ (10 أحرف فأكثر) ويُحفظ في سجل التدقيق. */
  function clearPolicyApproval() {
    setReasonText("");
    setReasonKind("CLEAR_POLICY");
    setReasonOpen(true);
  }

  /** إرسال حوار السبب — يحفظ نفس الحدّ الأدنى ونفس رسائل التحذير لكلا المسارين.
      الزرّ مُعطَّل تحت 10 أحرف، والفحص هنا يبقى دفاعاً ثانياً لا يُسقَط. */
  function submitReasonDialog() {
    const trimmed = reasonText.trim();
    if (reasonKind === "STOP") {
      if (trimmed.length < 10) {
        notify.warn("سبب الإيقاف يجب ألا يقل عن 10 أحرف.");
        return;
      }
      setMode.mutate({ target: "OFF", reason: trimmed });
      return;
    }
    if (reasonKind === "CLEAR_POLICY") {
      if (trimmed.length < 10) {
        notify.warn("سبب المسح يجب ألا يقل عن 10 أحرف.");
        return;
      }
      setPolicyApproval.mutate({ action: "CLEAR", reason: trimmed });
    }
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
            <AppSelect
              className="h-9"
              value={String(branchId)}
              onValueChange={(next) =>
                setBranchId(
                  next ? Number(next) : "",
                )
              }
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </AppSelect>
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

          {/* لونُ الانحراف دلاليّ لا مخزنيّ: كان `badge-stock-out` — توكن «نفد المخزون» —
              في شاشة مطابقةٍ نقديّة لا مخزون فيها. الدلالة هنا خطرٌ يستوجب المراجعة، فصار
              `--sem-neg` (نفس الأحمر الطوبيّ قيمةً، والصنف صار يصف ما يعنيه). */}
          <Card>
            <CardContent
              className={`p-6 text-center text-lg font-bold inline-flex items-center justify-center gap-2 w-full ${
                total === 0 ? "badge-status-active" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
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

          {/*
            Tier-3 #5 (٢٧/٨): أيتام journalLines بلا accountId. الحالة الطبيعية «صفر»: كل
            سطرٍ POSTED جديد يحمل accountId بعد Tier-3 #2/#4. أيّ صفٍّ هنا يعني إمّا خرقاً
            من backfill أو drift في `accounts.systemRole` — الإصلاح في السجلاّت التاريخيّة.
          */}
          <DriftSection
            title="أيتام قيود الدفتر"
            desc="أسطرٌ في journalLines بلا accountId — خرقُ عقد الكاتب بعد أن أصبح الحقل يُملأ تلقائياً من الرأس."
            idLabel="رقم السطر"
            rows={data.journalOrphans ?? []}
          />
        </>
      )}

      {/* حوار السبب الموحَّد — بديل window.prompt + window.confirm المتتاليَين.
          يجمع في خطوةٍ واحدة: السبب الإلزاميّ (10 أحرف فأكثر، مطابقاً لعقد الخادم 10..500)
          ونصّ التحذير الذي كان في window.confirm، فلا يسقط حارسٌ ولا معلومة. */}
      <Dialog
        open={reasonOpen}
        onOpenChange={(open) => {
          if (!open) {
            setReasonOpen(false);
            setReasonText("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reasonKind === "STOP"
                ? "إيقاف الدفتر المزدوج إلى OFF؟"
                : "مسح مصادقة السياسة؟"}
            </DialogTitle>
            <DialogDescription>
              {reasonKind === "STOP"
                ? "ستتوقف كتابة القيود المزدوجة الجديدة، وتبقى اليوميات السابقة محفوظة ولن تُحذف. يُحفظ السبب في سجل التدقيق."
                : "تُمسح مصادقة المحاسب على سياسة الترحيل، ويُحفظ السبب في سجل التدقيق."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="reconcile-reason">
              {reasonKind === "STOP" ? "سبب الإيقاف" : "سبب المسح"}
            </label>
            <Textarea
              id="reconcile-reason"
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="اكتب سبباً واضحاً يفهمه من يراجع سجل التدقيق لاحقاً"
            />
            <p className="text-[11px] text-muted-foreground">
              10 أحرف على الأقل.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setReasonOpen(false);
                setReasonText("");
              }}
            >
              تراجع
            </Button>
            <SubmitButton
              type="button"
              variant="destructive"
              pending={setMode.isPending || setPolicyApproval.isPending}
              pendingText={ACTION_LABELS.processing}
              disabled={reasonText.trim().length < 10}
              onClick={submitReasonDialog}
            >
              {reasonKind === "STOP" ? "تأكيد الإيقاف إلى OFF" : "تأكيد المسح"}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  // موانعُ التفعيل والانحرافُ خطرٌ لا نفادُ مخزون: `--sem-neg` بدل توكن المخزون `badge-stock-out`.
  const modeClass =
    activation.mode === "ACTIVE"
      ? activation.blockers.length === 0
        ? "badge-status-active"
        : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
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
                <DataTable<OperationalMismatchRow>
                  {...PANEL_TABLE}
                  data={activation.operationalReconciliation.mismatches}
                  emptyText="لا فروق مطابقة تشغيلية."
                  columns={[
                    {
                      id: "scope",
                      header: "النطاق",
                      accessorFn: (row) => (row.scope === "GLOBAL" ? "الشركة" : `الفرع ${row.branchId}`),
                      cell: ({ row }) => (row.original.scope === "GLOBAL" ? "الشركة" : `الفرع ${row.original.branchId}`),
                    },
                    {
                      id: "role",
                      header: "الدور المحاسبي",
                      // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
                      accessorFn: (row) => ROLE_LABELS[row.role] ?? row.role,
                      cell: ({ row }) => ROLE_LABELS[row.original.role] ?? row.original.role,
                    },
                    {
                      id: "operationalNetDebit",
                      header: "المصدر التشغيلي",
                      accessorFn: (row) => fmt(row.operationalNetDebit),
                      meta: { kind: "money" },
                      cell: ({ row }) => fmt(row.original.operationalNetDebit),
                    },
                    {
                      id: "journalNetDebit",
                      header: "اليومية",
                      accessorFn: (row) => fmt(row.journalNetDebit),
                      meta: { kind: "money" },
                      cell: ({ row }) => fmt(row.original.journalNetDebit),
                    },
                    {
                      id: "difference",
                      header: "الفرق",
                      accessorFn: (row) => fmt(row.difference),
                      meta: { kind: "money" },
                      cell: ({ row }) => <span className="text-destructive">{fmt(row.original.difference)}</span>,
                    },
                  ]}
                />
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

                <DataTable<OpeningRoleTotalRow>
                  {...PANEL_TABLE}
                  data={openingPreparation.preview.roleTotals}
                  emptyText="لا مجاميع أدوار في المعاينة."
                  columns={[
                    {
                      id: "role",
                      header: "الدور المحاسبي",
                      accessorFn: (row) => ROLE_LABELS[row.role] ?? row.role,
                      cell: ({ row }) => <span className="font-medium">{ROLE_LABELS[row.original.role] ?? row.original.role}</span>,
                    },
                    // kind: "money" يتكفّل بالمحاذاة وtabular-nums وعزل الاتّجاه ⇒ لا dir="ltr" يدويّ.
                    { id: "debit", header: "مدين", accessorFn: (row) => fmt(row.debit), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.debit) },
                    { id: "credit", header: "دائن", accessorFn: (row) => fmt(row.credit), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.credit) },
                  ]}
                />

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
              className={`rounded-full px-3 py-1 text-xs font-semibold ${monthlyIssueCount === 0 ? "badge-status-active" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"}`}
            >
              {monthlyIssueCount === 0
                ? "مطابق"
                : `${monthlyIssueCount} مانعاً/انحرافاً`}
            </span>
          </div>

          {reconciliation.roles.length > 0 ? (
            <DataTable<DoubleEntryRoleRow>
              {...PANEL_TABLE}
              data={reconciliation.roles}
              emptyText="لا أحداث مالية في هذا النطاق."
              columns={[
                {
                  id: "role",
                  header: "الدور المحاسبي",
                  accessorFn: (row) => ROLE_LABELS[row.role] ?? row.role,
                  meta: { width: "wide" },
                  cell: ({ row }) => (
                    <span className="font-medium">
                      {ROLE_LABELS[row.original.role] ?? row.original.role}
                      <div className="text-[11px] font-normal text-muted-foreground" dir="ltr">
                        {row.original.role}
                      </div>
                    </span>
                  ),
                },
                { id: "expected", header: "المتوقّع", accessorFn: (row) => fmt(row.expected), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.expected) },
                { id: "actual", header: "الفعلي", accessorFn: (row) => fmt(row.actual), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.actual) },
                {
                  id: "drift",
                  header: "الانحراف",
                  accessorFn: (row) => fmt(row.drift),
                  meta: { kind: "money" },
                  cell: ({ row }) => (
                    <span className={row.original.drift === "0.00" ? undefined : "font-semibold text-[var(--sem-neg)]"}>
                      {fmt(row.original.drift)}
                    </span>
                  ),
                },
              ]}
            />
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
                rows.length === 0 ? "badge-status-active" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
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
          <DataTable<Row>
            {...PANEL_TABLE}
            data={rows}
            emptyText="لا انحراف."
            columns={[
              {
                id: "id",
                header: idLabel,
                accessorFn: (r) => (names ? `${r.id} — ${names.get(r.id) ?? "—"}` : String(r.id)),
                /* ⛔ لا `kind: "code"` هنا: الخليّة تحمل **اسم الطرف بالعربية** تحت الرقم،
                   وkind الرمز يفرض `font-mono` + `whitespace-nowrap` + عزلَ اتّجاهٍ LTR على
                   الخليّة كلّها ⇒ اسمٌ عربيّ بخطٍّ أحاديّ لا يلتفّ. الرقم وحده يُعزَل بـdir. */
                meta: { width: "wide", wrap: true },
                cell: ({ row }) => (
                  <span className="font-medium">
                    <div className="tabular-nums" dir="ltr">
                      {row.original.id}
                    </div>
                    {names && (
                      <div className="text-xs font-normal text-muted-foreground">
                        {names.get(row.original.id) ?? "—"}
                      </div>
                    )}
                  </span>
                ),
              },
              { id: "expected", header: "المتوقّع", accessorFn: (r) => val(r.expected), meta: { kind: "money" }, cell: ({ row }) => val(row.original.expected) },
              { id: "actual", header: "الفعلي", accessorFn: (r) => val(r.actual), meta: { kind: "money" }, cell: ({ row }) => val(row.original.actual) },
              {
                id: "drift",
                header: "الانحراف",
                accessorFn: (r) => `${val(r.drift)}${r.note ? ` — ${r.note}` : ""}`,
                meta: { kind: "money" },
                /* الانحراف هنا **ليس مالاً دائماً**: ثلاثة من مستدعي هذا المكوّن تمرّر بلا `money`
                   (أرصدة المخزون كمّية، وطلبات المتجر «رقمٌ رمزيّ ١ لكل صفّ»، والأيتام عدّة أسطر) ⇒
                   `money-negative` كان يصبغ قيمةً غير ماليّة بتوكن إشارة المبلغ. الدلالة خطرٌ/انحراف
                   ⇒ `--sem-neg` مثل شارة الرأس في المكوّن نفسه. */
                cell: ({ row }) => (
                  <span className="font-semibold text-[var(--sem-neg)]">
                    {val(row.original.drift)}
                    {row.original.note && (
                      <span
                        dir="rtl"
                        className="mr-2 inline-block rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]"
                      >
                        {row.original.note}
                      </span>
                    )}
                  </span>
                ),
              },
              // عمود الإجراء يظهر فقط حين يوجد رابطٌ للسجل — كما كان بالضبط.
              ...(link
                ? ([
                    {
                      id: "actions",
                      header: "إجراء",
                      enableSorting: false,
                      meta: { kind: "actions" },
                      cell: ({ row }) => (
                        <RowActions
                          mode="inline"
                          actions={[
                            {
                              key: "open",
                              kind: "view",
                              label: linkLabel,
                              href: link(row.original.id),
                              gate: { adminOnly: true },
                            },
                          ]}
                        />
                      ),
                    },
                  ] as ColumnDef<Row, unknown>[])
                : []),
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}
