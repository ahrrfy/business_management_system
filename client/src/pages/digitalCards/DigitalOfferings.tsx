// تعريف البطاقات والاشتراكات المعروضة للبيع. كل بطاقة تُنشئ منتجاً خدمياً تلقائياً (بلا مخزون)
// وتُربط بفرع أو أكثر. قواعد الهامش هنا تُستعمل لاحقاً لاشتقاق سعر اليوم — البطاقة لا تظهر
// في الكاشير قبل نشر سعر لها في شاشة أسعار اليوم.
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ListToolbar, RowActions } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Columns3, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type OfferingRow = RouterOutputs["digitalCards"]["offerings"]["list"][number];
type OfferingType = OfferingRow["offeringType"];
type PricingMode = OfferingRow["pricingMode"];
type OfferingAssignment = OfferingRow["assignments"][number];
type AssignmentField = "deviceCode" | "walletName";

const OFFERING_TYPE: Record<string, string> = {
  TELECOM_CARD: "كارت اتصالات",
  GLOBAL_CARD: "بطاقة عالمية",
  EDUCATIONAL_SUBSCRIPTION: "اشتراك تعليمي",
  OTHER: "أخرى",
};
const PRICING_MODE: Record<string, string> = {
  FIXED_MARGIN: "ربح ثابت",
  PERCENT_MARGIN: "نسبة من حصة المزوّد",
  FIXED_PLUS_PERCENT: "ثابت + نسبة",
  FIXED_SELL_PRICE: "سعر بيع محدّد إدارياً",
};

const OFFERING_COLUMNS = [
  { key: "product", label: "البطاقة", locked: true },
  { key: "provider", label: "المزوّد", locked: false },
  { key: "device", label: "الجهاز المسند", locked: false },
  { key: "wallet", label: "المحفظة المسندة", locked: false },
  { key: "type", label: "النوع", locked: false },
  { key: "faceValue", label: "القيمة الاسمية", locked: false },
  { key: "pricingMode", label: "طريقة حساب السعر", locked: false },
  { key: "minimumMargin", label: "أقل ربح مسموح", locked: false },
  { key: "studentData", label: "بيانات الطالب مطلوبة", locked: false },
  { key: "status", label: "الحالة", locked: false },
  { key: "actions", label: "إجراء", locked: true },
] as const;
type OfferingColumnKey = (typeof OFFERING_COLUMNS)[number]["key"];
type OfferingColumnVisibility = Record<OfferingColumnKey, boolean>;
const COLUMN_VISIBILITY_KEY = "digital-offerings:columns:v1";

function defaultColumnVisibility(): OfferingColumnVisibility {
  return Object.fromEntries(OFFERING_COLUMNS.map((column) => [column.key, true])) as OfferingColumnVisibility;
}

function loadColumnVisibility(): OfferingColumnVisibility {
  const defaults = defaultColumnVisibility();
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? "{}") as Record<string, unknown>;
    for (const column of OFFERING_COLUMNS) {
      if (!column.locked && typeof stored[column.key] === "boolean") {
        defaults[column.key] = stored[column.key] as boolean;
      }
    }
  } catch {
    // التفضيل بصري فقط؛ فشل التخزين لا يمنع عرض الجدول كاملاً.
  }
  return defaults;
}

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm";

function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function assignmentFallback(
  settlementMode: OfferingRow["settlementMode"],
  field: AssignmentField,
) {
  return settlementMode === "POSTPAID" && field === "walletName"
    ? "تسوية آجلة — بلا محفظة"
    : "غير مسند";
}

function assignmentExport(
  assignments: OfferingAssignment[],
  settlementMode: OfferingRow["settlementMode"],
  field: AssignmentField,
) {
  if (assignments.length === 0) return "غير مسند";
  return assignments
    .map((assignment) =>
      `${assignment[field] ?? assignmentFallback(settlementMode, field)} — ${assignment.branchName}`,
    )
    .join("، ");
}

function OfferingAssignmentsCell({
  assignments,
  settlementMode,
  field,
}: {
  assignments: OfferingAssignment[];
  settlementMode: OfferingRow["settlementMode"];
  field: AssignmentField;
}) {
  if (assignments.length === 0) {
    return (
      <span className="inline-flex rounded-full px-2 py-0.5 text-xs badge-stock-out">
        غير مسند
      </span>
    );
  }

  return (
    <div className="min-w-36 space-y-1.5">
      {assignments.map((assignment) => {
        const value = assignment[field];
        const postpaidWithoutWallet =
          settlementMode === "POSTPAID" && field === "walletName" && value == null;
        return (
          <div key={assignment.branchId} className="space-y-0.5">
            {value ? (
              <div
                className={field === "deviceCode" ? "font-mono text-xs font-medium" : "font-medium"}
                dir={field === "deviceCode" ? "ltr" : "auto"}
              >
                {value}
              </div>
            ) : (
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs ${postpaidWithoutWallet ? "badge-status-neutral" : "badge-stock-out"}`}
              >
                {assignmentFallback(settlementMode, field)}
              </span>
            )}
            <div className="text-xs text-muted-foreground">{assignment.branchName}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function DigitalOfferings() {
  const utils = trpc.useUtils();
  const list = trpc.digitalCards.offerings.list.useQuery();
  const providers = trpc.digitalCards.providers.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const wallets = trpc.digitalCards.wallets.list.useQuery({ isActive: true });
  const rows = list.data ?? [];
  const [query, setQuery] = useState("");
  const [visibleColumns, setVisibleColumns] = useState<OfferingColumnVisibility>(loadColumnVisibility);
  const visibleColumnCount = OFFERING_COLUMNS.filter((column) => visibleColumns[column.key]).length;
  const columnVisible = (key: OfferingColumnKey) => visibleColumns[key];

  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(visibleColumns));
    } catch {
      // وضع الخصوصية أو امتلاء التخزين لا يمنع اختيار الأعمدة في الجلسة الحالية.
    }
  }, [visibleColumns]);

  function setColumnVisible(key: OfferingColumnKey, visible: boolean) {
    if (OFFERING_COLUMNS.find((column) => column.key === key)?.locked) return;
    setVisibleColumns((current) => ({ ...current, [key]: visible }));
  }

  const visibleRows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q
      ? rows.filter((o) =>
          [
            o.productName,
            o.supplierName,
            OFFERING_TYPE[o.offeringType],
            PRICING_MODE[o.pricingMode],
            ...o.assignments.flatMap((assignment) => [
              assignment.deviceCode,
              assignment.walletName,
              assignment.branchName,
            ]),
          ].some((v) =>
            String(v ?? "")
              .toLocaleLowerCase("ar")
              .includes(q),
          ),
        )
      : rows;
  }, [rows, query]);

  const activeProviders = (providers.data ?? []).filter((p) => p.isActive);

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [fProviderId, setFProviderId] = useState("");
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState<OfferingType>("TELECOM_CARD");
  const [fRequiresStudent, setFRequiresStudent] = useState(false);
  const [fFaceValue, setFFaceValue] = useState("");
  const [fPricingMode, setFPricingMode] = useState<PricingMode>("FIXED_MARGIN");
  const [fFixedMargin, setFFixedMargin] = useState("0");
  const [fMarginPercent, setFMarginPercent] = useState("0");
  const [fMinimumMargin, setFMinimumMargin] = useState("0");
  const [fRoundingStep, setFRoundingStep] = useState("250");
  const [fBranchIds, setFBranchIds] = useState<number[]>([]);
  const [fWalletByBranch, setFWalletByBranch] = useState<Record<number, string>>({});
  const [fInitialCost, setFInitialCost] = useState("");
  const [fInitialSellPrice, setFInitialSellPrice] = useState("");

  function invalidate() {
    void utils.digitalCards.offerings.list.invalidate();
  }

  const createMut = trpc.digitalCards.offerings.create.useMutation({
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      notify.ok("أُضيفت البطاقة", "لن تظهر في الكاشير قبل نشر سعر لها.");
    },
    onError: (e) => notify.err(e),
  });
  const updateMut = trpc.digitalCards.offerings.update.useMutation({
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      notify.ok("حُفظت التعديلات");
    },
    onError: (e) => notify.err(e),
  });
  const toggleMut = trpc.digitalCards.offerings.toggle.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => notify.err(e),
  });
  const initialPriceMut = trpc.digitalCards.pricing.saveDraft.useMutation({
    onError: (e) => notify.err(e),
  });

  const detail = trpc.digitalCards.offerings.get.useQuery(
    { id: editId ?? 0 },
    { enabled: formOpen && editId != null },
  );

  function openAdd() {
    setEditId(null);
    setFProviderId("");
    setFName("");
    setFType("TELECOM_CARD");
    setFRequiresStudent(false);
    setFFaceValue("");
    setFPricingMode("FIXED_MARGIN");
    setFFixedMargin("0");
    setFMarginPercent("0");
    setFMinimumMargin("0");
    setFRoundingStep("250");
    setFBranchIds([]);
    setFWalletByBranch({});
    setFInitialCost("");
    setFInitialSellPrice("");
    setFormOpen(true);
  }

  function openEdit(o: OfferingRow) {
    setEditId(o.id);
    setFProviderId(String(o.providerId));
    setFName(o.productName);
    setFType(o.offeringType);
    setFRequiresStudent(o.requiresStudentData);
    setFFaceValue(o.faceValue ?? "");
    setFPricingMode(o.pricingMode);
    setFFixedMargin(o.fixedMargin);
    setFMarginPercent(o.marginPercent);
    setFMinimumMargin(o.minimumMargin);
    setFRoundingStep(o.roundingStep);
    // الفروع تصل من استعلام التفاصيل (get) لأن قائمة العرض لا تحملها.
    setFBranchIds([]);
    setFWalletByBranch({});
    setFormOpen(true);
  }

  // فروع البطاقة تصل من استعلام التفاصيل (قائمة العرض لا تحملها) ⇒ تُزامَن عند وصولها.
  const detailForId = detail.data?.id;
  useEffect(() => {
    if (editId != null && detailForId === editId) {
      setFBranchIds(detail.data?.branches.map((b) => b.branchId) ?? []);
      setFWalletByBranch(Object.fromEntries(
        (detail.data?.branches ?? []).map((b) => [b.branchId, b.walletId != null ? String(b.walletId) : ""]),
      ));
    }
  }, [editId, detailForId, detail.data]);

  function toggleBranch(id: number) {
    setFBranchIds((prev) => {
      if (!prev.includes(id)) return [...prev, id];
      setFWalletByBranch((walletsByBranch) => {
        const next = { ...walletsByBranch };
        delete next[id];
        return next;
      });
      return prev.filter((x) => x !== id);
    });
  }

  function submitForm() {
    const name = fName.trim();
    if (!name) return notify.err("اسم البطاقة مطلوب");
    if (fBranchIds.length === 0)
      return notify.err("اختر فرعاً واحداً على الأقل");

    const selectedProvider = (providers.data ?? []).find((p) => p.id === Number(fProviderId));
    if (selectedProvider?.settlementMode === "PREPAID") {
      const missingWalletBranch = fBranchIds.find((branchId) => !Number(fWalletByBranch[branchId]));
      if (missingWalletBranch != null) {
        const branchName = (branches.data ?? []).find((b) => b.id === missingWalletBranch)?.name;
        return notify.err(`اختر محفظة المزوّد لفرع ${branchName ?? missingWalletBranch}`);
      }
    }

    const shared = {
      name,
      offeringType: fType,
      requiresStudentData: fRequiresStudent,
      faceValue: fFaceValue.trim() || null,
      pricingMode: fPricingMode,
      fixedMargin: fFixedMargin || "0",
      marginPercent: fMarginPercent || "0",
      minimumMargin: fMinimumMargin || "0",
      roundingStep: fRoundingStep || "250",
      branches: fBranchIds.map((branchId) => ({
        branchId,
        walletId: selectedProvider?.settlementMode === "PREPAID"
          ? Number(fWalletByBranch[branchId])
          : null,
      })),
    };

    if (editId != null) {
      updateMut.mutate({ id: editId, ...shared });
      return;
    }
    const providerId = Number(fProviderId);
    if (!providerId) return notify.err("اختر المزوّد");
    if (!fInitialCost.trim() || !fInitialSellPrice.trim()) {
      return notify.err("أدخل تكلفة الشراء وسعر البيع الأول للبطاقة");
    }
    createMut.mutate(
      { providerId, ...shared },
      {
        onSuccess: async (created) => {
          try {
            await Promise.all(
              fBranchIds.map((branchId) =>
                initialPriceMut.mutateAsync({
                  branchId,
                  providerId,
                  businessDate: todayYmd(),
                  lines: [
                    {
                      offeringId: created.offeringId,
                      providerShare: fInitialCost,
                      sellPrice: fInitialSellPrice,
                    },
                  ],
                }),
              ),
            );
            void utils.digitalCards.pricing.getMorningSheet.invalidate();
            notify.ok(
              "حُفظت البطاقة وأسعارها كمسوّدة",
              "راجعها ثم ثبّتها وانشرها من شاشة أسعار اليوم.",
            );
          } catch {
            // يظهر خطأ الحفظ من mutation؛ تبقى البطاقة صالحة للتسعير لاحقاً.
          }
        },
      },
    );
  }

  async function toggle(o: OfferingRow) {
    if (
      o.isActive &&
      !(await confirm({
        variant: "danger",
        title: "تعطيل البطاقة",
        description: `لن تظهر «${o.productName}» في شبكة بطاقات الكاشير. المبيعات السابقة وأسعارها التاريخية تبقى كما هي. متابعة؟`,
        confirmText: "تعطيل",
      }))
    )
      return;
    toggleMut.mutate({ id: o.id, isActive: !o.isActive });
  }

  const saving =
    createMut.isPending || updateMut.isPending || initialPriceMut.isPending;
  const editing = editId != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="البطاقات والاشتراكات"
        description="أضف البطاقة أو الاشتراك، وحدد المزوّد والجهاز والرصيد المستخدم للبيع. لا تظهر للكاشير حتى يكتمل الربط ويُنشر سعر صالح."
        actions={
          <Button
            size="sm"
            onClick={openAdd}
            disabled={activeProviders.length === 0}
          >
            <Plus className="size-4" /> بطاقة جديدة
          </Button>
        }
      />

      {activeProviders.length === 0 && !providers.isLoading && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            لا مزوّدين مفعّلين — عرّف مزوّداً من تبويب المزوّدين قبل إضافة
            بطاقات.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="قائمة البطاقات"
            count={visibleRows.length}
            loading={list.isLoading}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "البطاقة، المزوّد، النوع أو قاعدة التسعير…",
            }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "البطاقات-والاشتراكات",
              rows: visibleRows,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "productName", header: "البطاقة" },
                { key: "supplierName", header: "المزوّد" },
                {
                  key: "assignments",
                  header: "الجهاز المسند",
                  map: (o) => assignmentExport(o.assignments, o.settlementMode, "deviceCode"),
                },
                {
                  key: "assignments",
                  header: "المحفظة المسندة",
                  map: (o) => assignmentExport(o.assignments, o.settlementMode, "walletName"),
                },
                {
                  key: "offeringType",
                  header: "النوع",
                  map: (o) => OFFERING_TYPE[o.offeringType] ?? o.offeringType,
                },
                { key: "faceValue", header: "القيمة الاسمية", money: true },
                {
                  key: "pricingMode",
                  header: "قاعدة التسعير",
                  map: (o) => PRICING_MODE[o.pricingMode] ?? o.pricingMode,
                },
                { key: "minimumMargin", header: "أقل هامش", money: true },
                {
                  key: "isActive",
                  header: "الحالة",
                  map: (o) => (o.isActive ? "مفعّلة" : "معطّلة"),
                },
              ],
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <Columns3 aria-hidden className="size-4" />
                  الأعمدة {visibleColumnCount}/{OFFERING_COLUMNS.length}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto text-right">
                <DropdownMenuLabel>اختيار معلومات الجدول</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {OFFERING_COLUMNS.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.key}
                    checked={visibleColumns[column.key]}
                    disabled={column.locked}
                    onCheckedChange={(value) => setColumnVisible(column.key, Boolean(value))}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {column.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setVisibleColumns(defaultColumnVisibility())}>
                  <RotateCcw aria-hidden className="size-4" />
                  إظهار كل الأعمدة
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ListToolbar>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false} showColumnVisibility={false}>
            <table
              className="w-full text-sm"
              style={{ minWidth: `${Math.max(980, visibleColumnCount * 130)}px` }}
            >
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">البطاقة</th>
                  {columnVisible("provider") && <th className="p-2 text-start">المزوّد</th>}
                  {columnVisible("device") && <th className="p-2 text-start">الجهاز المسند</th>}
                  {columnVisible("wallet") && <th className="p-2 text-start">المحفظة المسندة</th>}
                  {columnVisible("type") && <th className="p-2 text-start">النوع</th>}
                  {columnVisible("faceValue") && <th className="p-2 text-start">القيمة الاسمية</th>}
                  {columnVisible("pricingMode") && <th className="p-2 text-start">طريقة حساب السعر</th>}
                  {columnVisible("minimumMargin") && <th className="p-2 text-start">أقل ربح مسموح</th>}
                  {columnVisible("studentData") && <th className="p-2 text-center">بيانات الطالب مطلوبة</th>}
                  {columnVisible("status") && <th className="p-2 text-center">الحالة</th>}
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((o) => (
                  <tr
                    key={o.id}
                    className={`border-t ${o.isActive ? "" : "opacity-60"}`}
                  >
                    <td className="p-2 font-medium">{o.productName}</td>
                    {columnVisible("provider") && <td className="p-2">{o.supplierName}</td>}
                    {columnVisible("device") && (
                      <td className="p-2 align-top">
                        <OfferingAssignmentsCell
                          assignments={o.assignments}
                          settlementMode={o.settlementMode}
                          field="deviceCode"
                        />
                      </td>
                    )}
                    {columnVisible("wallet") && (
                      <td className="p-2 align-top">
                        <OfferingAssignmentsCell
                          assignments={o.assignments}
                          settlementMode={o.settlementMode}
                          field="walletName"
                        />
                      </td>
                    )}
                    {columnVisible("type") && (
                      <td className="p-2 text-muted-foreground">
                        {OFFERING_TYPE[o.offeringType] ?? o.offeringType}
                      </td>
                    )}
                    {columnVisible("faceValue") && (
                      <td className="p-2 tabular-nums">
                        {o.faceValue ? fmtAr(o.faceValue) : "—"}
                      </td>
                    )}
                    {columnVisible("pricingMode") && (
                      <td className="p-2 text-muted-foreground">
                        {PRICING_MODE[o.pricingMode] ?? o.pricingMode}
                      </td>
                    )}
                    {columnVisible("minimumMargin") && (
                      <td className="p-2 tabular-nums">
                        {fmtAr(o.minimumMargin)}
                      </td>
                    )}
                    {columnVisible("studentData") && (
                      <td className="p-2 text-center">
                        {o.requiresStudentData ? "نعم" : "لا"}
                      </td>
                    )}
                    {columnVisible("status") && (
                      <td className="p-2 text-center">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs ${o.isActive ? "badge-status-active" : "badge-stock-out"}`}
                        >
                          {o.isActive ? "مفعّلة" : "معطّلة"}
                        </span>
                      </td>
                    )}
                    <td className="p-2 text-center">
                      <RowActions
                        actions={[
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل",
                            onSelect: () => openEdit(o),
                            gate: {
                              roles: ["manager"],
                              module: "digital_cards",
                              level: "FULL",
                            },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: o.isActive ? "تعطيل" : "تفعيل",
                            variant: o.isActive ? "destructive" : "default",
                            disabled: toggleMut.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            onSelect: () => void toggle(o),
                            gate: {
                              roles: ["manager"],
                              module: "digital_cards",
                              level: "FULL",
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr>
                    <td colSpan={visibleColumnCount}>
                      <LoadingState />
                    </td>
                  </tr>
                )}
                {!list.isLoading && visibleRows.length === 0 && (
                  <TableEmptyRow
                    colSpan={visibleColumnCount}
                    message="لا بطاقات بعد — عرّف أوّل بطاقة لمزوّد مفعّل."
                  />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "تعديل بطاقة" : "إضافة بطاقة"}</DialogTitle>
            <DialogDescription>
              أدخِل بيانات البطاقة الأساسية ثم تكلفة الشراء وسعر البيع الأول
              بعبارات واضحة. الربح والقيود والمحفظة تُرحّل تلقائياً في الخلفية.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-provider">
                  المزوّد
                </label>
                <select
                  id="do-provider"
                  className={selectCls}
                  value={fProviderId}
                  disabled={editing}
                  onChange={(e) => { setFProviderId(e.target.value); setFWalletByBranch({}); }}
                >
                  <option value="">— اختر المزوّد —</option>
                  {activeProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.supplierName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="do-type">
                  النوع
                </label>
                <select
                  id="do-type"
                  className={selectCls}
                  value={fType}
                  onChange={(e) => {
                    const type = e.target.value as OfferingType;
                    setFType(type);
                    if (type === "EDUCATIONAL_SUBSCRIPTION") {
                      setFRequiresStudent(true);
                    }
                  }}
                >
                  {Object.entries(OFFERING_TYPE).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">اسم البطاقة</label>
              <Input
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="كارت آسياسيل ١٠ آلاف"
                dir="auto"
                autoFocus
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  القيمة الاسمية (اختياري)
                </label>
                <MoneyInput
                  value={fFaceValue}
                  onChange={setFFaceValue}
                  ariaLabel="القيمة الاسمية"
                />
                <p className="text-xs text-muted-foreground">
                  القيمة المطبوعة على الكرت — للعرض والتمييز فقط، لا تُسعّر بها.
                </p>
              </div>
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                الأسعار تُحدّد مباشرةً من حقلي التكلفة وسعر البيع أدناه، دون
                قواعد تسعير أو تقريب معقّدة.
              </div>
            </div>

            {!editing && (
              <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                <div>
                  <p className="font-medium">سعر اليوم الأول</p>
                  <p className="text-xs text-muted-foreground">
                    يُحفظ كمسوّدة لكل فرع محدد أدناه، ثم تثبّته وتنشره من «أسعار
                    اليوم».
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">
                      تكلفة الشراء علينا
                    </label>
                    <MoneyInput
                      value={fInitialCost}
                      onChange={setFInitialCost}
                      ariaLabel="تكلفة الشراء علينا"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium">
                      سعر البيع للعميل
                    </label>
                    <MoneyInput
                      value={fInitialSellPrice}
                      onChange={setFInitialSellPrice}
                      ariaLabel="سعر البيع للعميل"
                    />
                  </div>
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={fRequiresStudent}
                disabled={fType === "EDUCATIONAL_SUBSCRIPTION"}
                onChange={(e) => setFRequiresStudent(e.target.checked)}
              />
              تتطلّب اسم الطالب ورقم هاتفه عند البيع
            </label>

            {fType === "EDUCATIONAL_SUBSCRIPTION" && (
              <div className="rounded-lg border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  النظام يسجّل البيع ورقم الاشتراك وبيانات الطالب فقط. انتهاء الاشتراك وحدوده تديرها المنصة التعليمية.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <span className="text-sm font-medium">
                الفروع التي تُعرض فيها
              </span>
              <div className="space-y-2 rounded-md border p-3">
                {(branches.data ?? []).map((b) => (
                  <div key={b.id} className="grid items-center gap-2 sm:grid-cols-[minmax(10rem,1fr)_minmax(14rem,2fr)]">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={fBranchIds.includes(b.id)}
                        onChange={() => toggleBranch(b.id)}
                      />
                      {b.name}
                    </label>
                    {fBranchIds.includes(b.id) && (providers.data ?? []).find((p) => p.id === Number(fProviderId))?.settlementMode === "PREPAID" && (
                      <select
                        className={selectCls}
                        aria-label={`محفظة ${b.name}`}
                        value={fWalletByBranch[b.id] ?? ""}
                        onChange={(e) => setFWalletByBranch((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      >
                        <option value="">— اختر محفظة هذا الفرع —</option>
                        {(wallets.data ?? [])
                          .filter((w) => w.providerId === Number(fProviderId) && w.branchId === b.id && w.isActive)
                          .map((w) => <option key={w.id} value={w.id}>{w.name} — المتاح {fmtAr(String(Number(w.currentBalance) - Number(w.reservedBalance)))}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>
              {(providers.data ?? []).find((p) => p.id === Number(fProviderId))?.settlementMode === "PREPAID" && (
                <p className="text-xs text-muted-foreground">اختر محفظة المزوّد في كل فرع؛ منها يُحجز ويُخصم رصيد البيع تلقائياً.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFormOpen(false)}
            >
              إلغاء
            </Button>
            <Button size="sm" onClick={submitForm} disabled={saving}>
              {saving ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
