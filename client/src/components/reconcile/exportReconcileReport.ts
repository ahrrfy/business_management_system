import { fmtDateTime } from "@/lib/date";
import { exportSheets } from "@/lib/export";
import { ROLE_LABELS } from "@/lib/doubleEntryRoleLabels";
import type { ReconcileData, Row } from "./types";

interface BranchOption {
  id: number;
  name: string;
}

export function exportReconcileReport({
  data,
  branchId,
  branches,
  customerNames,
  supplierNames,
  partyNames,
}: {
  data: ReconcileData;
  branchId: number | "";
  branches?: BranchOption[];
  customerNames: Map<number, string>;
  supplierNames: Map<number, string>;
  partyNames: Map<number, string>;
}) {
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
            ? (branches?.find((b) => b.id === branchId)?.name ?? String(branchId))
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
