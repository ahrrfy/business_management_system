import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  COST_WAVE_MAX_REASON_LENGTH,
  COST_WAVE_MAX_SELECTED_ITEMS,
  COST_WAVE_MIN_REASON_LENGTH,
  COST_WAVE_PURPOSE_LABELS,
  COST_WAVE_RULE_LABELS,
  COST_WAVE_SCOPE_LABELS,
  COST_WAVE_SKIP_LABELS,
  COST_WAVE_STATUS_LABELS,
  type CostWavePurpose,
  type CostWaveRuleType,
  type CostWaveScope,
  type CostWaveStatus,
} from "@shared/costWave";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileClock,
  History,
  PlusCircle,
  Search,
  Send,
  ShieldCheck,
  UserRoundCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";
import { CostWaveDetailDialog } from "@/components/costWave/CostWaveDetailDialog";
import { DataTable } from "@/components/data-table/DataTable";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { Field } from "@/components/product/variantBits";
import { AppSelect } from "@/components/ui/AppSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { CategoryOptionList } from "@/lib/categoryTree";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type InnerView = "create" | "approvals" | "mine" | "history";
type Preview = RouterOutputs["inventory"]["previewCostWave"];
type PreviewRow = Preview["rows"][number];
type SkippedRow = Preview["skipped"][number];
type WaveRow = RouterOutputs["inventory"]["costWaves"]["rows"][number];
type CatalogRow = RouterOutputs["catalog"]["adminList"]["rows"][number];

const STATUS_VARIANT: Record<
  CostWaveStatus,
  "warning" | "success" | "danger" | "neutral"
> = {
  PENDING_APPROVAL: "warning",
  APPLIED: "success",
  REJECTED: "danger",
  CONFLICTED: "neutral",
};

function normalizeView(value: string | null): InnerView {
  return value === "approvals" || value === "mine" || value === "history"
    ? value
    : "create";
}

export default function CostWaves() {
  const [path, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const activeView = normalizeView(params.get("costView"));
  const waveIdParam = params.get("wave");
  const waveId =
    waveIdParam && /^\d+$/.test(waveIdParam) ? Number(waveIdParam) : null;
  const utils = trpc.useUtils();

  function updateUrl(next: { view?: InnerView; waveId?: number | null }) {
    const nextParams = new URLSearchParams(search);
    nextParams.set("tab", "cost-waves");
    if (next.view) {
      if (next.view === "create") nextParams.delete("costView");
      else nextParams.set("costView", next.view);
    }
    if (next.waveId === null) nextParams.delete("wave");
    else if (next.waveId != null) nextParams.set("wave", String(next.waveId));
    navigate(`${path}?${nextParams.toString()}`);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-8">
      <PageHeader
        title="موجات التكلفة"
        icon={<ShieldCheck aria-hidden className="size-5" />}
        description="تغيير جماعي محكوم لتكلفة المخزون: معاينة موقعة، اعتمادان من شخصين مختلفين عن المنشئ، ثم تطبيق ذري مع قيد محاسبي ولقطة لكل مرحلة."
      />

      <div className="flex gap-2 rounded-md border border-[var(--sem-warn)]/35 bg-[var(--sem-warn-bg)] p-3 text-sm">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
        />
        <p>
          هذه الوحدة لتصحيح تكلفة مخزون قائمة أو إثبات هبوط قيمتها. تكلفة
          الاستلام الجديدة تُحدَّث من سند الشراء عبر المتوسط المرجّح، وليس من
          هنا.
        </p>
      </div>

      <Tabs
        value={activeView}
        onValueChange={(value) =>
          updateUrl({ view: value as InnerView, waveId: null })
        }
        dir="rtl"
      >
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 p-1 sm:w-fit">
          <TabsTrigger value="create">
            <PlusCircle aria-hidden /> إنشاء موجة
          </TabsTrigger>
          <TabsTrigger value="approvals">
            <UserRoundCheck aria-hidden /> بانتظار اعتمادي
          </TabsTrigger>
          <TabsTrigger value="mine">
            <FileClock aria-hidden /> طلباتي
          </TabsTrigger>
          <TabsTrigger value="history">
            <History aria-hidden /> التاريخ الكامل
          </TabsTrigger>
        </TabsList>
        <TabsContent value="create">
          <CreateCostWave
            onCreated={(id) => updateUrl({ view: "mine", waveId: id })}
          />
        </TabsContent>
        <TabsContent value="approvals">
          <WaveList
            view="AWAITING_MINE"
            onOpen={(id) => updateUrl({ waveId: id })}
          />
        </TabsContent>
        <TabsContent value="mine">
          <WaveList
            view="MY_REQUESTS"
            onOpen={(id) => updateUrl({ waveId: id })}
          />
        </TabsContent>
        <TabsContent value="history">
          <WaveList view="HISTORY" onOpen={(id) => updateUrl({ waveId: id })} />
        </TabsContent>
      </Tabs>

      <CostWaveDetailDialog
        waveId={waveId}
        onClose={() => updateUrl({ waveId: null })}
        onChanged={() => void utils.inventory.costWaves.invalidate()}
      />
    </div>
  );
}

function CreateCostWave({
  onCreated,
}: {
  onCreated: (waveId: number) => void;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const categories = trpc.catalog.categories.useQuery();
  const branches = trpc.branches.list.useQuery();

  const [scope, setScope] = useState<CostWaveScope>("FILTERED");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [productSearch, setProductSearch] = useState("");
  const [variantIds, setVariantIds] = useState<number[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<Record<number, string>>(
    {},
  );
  const [pickerSearch, setPickerSearch] = useState("");
  const [purpose, setPurpose] = useState<CostWavePurpose>("CORRECTION");
  const [ruleType, setRuleType] =
    useState<CostWaveRuleType>("DECREASE_PERCENT");
  const [changeValue, setChangeValue] = useState("5");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [confirmationCount, setConfirmationCount] = useState("");
  const [error, setError] = useState("");
  const [selectedBranchId, setSelectedBranchId] = useState<number | "">("");

  const canPickBranch =
    me.data?.role === "admin" || me.data?.isOwner === true;
  const branchId = canPickBranch
    ? selectedBranchId === ""
      ? null
      : Number(selectedBranchId)
    : me.data?.branchId != null
      ? Number(me.data.branchId)
      : null;
  const debouncedPicker = useDebouncedValue(pickerSearch, 220);
  const picker = trpc.catalog.adminList.useQuery(
    { branchId: branchId ?? 0, q: debouncedPicker.trim(), limit: 30 },
    {
      enabled:
        scope === "SELECTED" &&
        branchId != null &&
        debouncedPicker.trim().length > 0,
    },
  );

  const filters = useMemo(
    () => ({
      scope,
      categoryId:
        scope === "FILTERED" && categoryId !== "" ? Number(categoryId) : null,
      productSearch: scope === "FILTERED" ? productSearch.trim() || null : null,
      variantIds: scope === "SELECTED" ? variantIds : null,
    }),
    [scope, categoryId, productSearch, variantIds],
  );
  const input = useMemo(
    () => ({
      branchId: branchId ?? undefined,
      purpose,
      ruleType,
      changeValue,
      filters,
    }),
    [branchId, purpose, ruleType, changeValue, filters],
  );

  useEffect(() => {
    setPreview(null);
    setConfirmationCount("");
  }, [input]);

  const previewMutation = trpc.inventory.previewCostWave.useMutation({
    onSuccess: (data) => {
      setPreview(data);
      setError("");
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const submitMutation = trpc.inventory.submitCostWave.useMutation({
    onSuccess: async (result) => {
      await utils.inventory.costWaves.invalidate();
      toast.success("أُرسلت الموجة للاعتماد دون تغيير أي تكلفة");
      onCreated(result.waveId);
    },
    onError: (mutationError) => setError(mutationError.message),
  });

  const scopeError = useMemo(() => {
    if (branchId == null) return "اختر فرع المستند قبل إنشاء المعاينة.";
    if (scope === "FILTERED" && !filters.categoryId && !filters.productSearch) {
      return "اختر فئة أو اكتب بحثاً، أو اختر «كل الأصناف المؤهلة» صراحةً.";
    }
    if (scope === "SELECTED" && variantIds.length === 0)
      return "اختر صنفاً واحداً على الأقل.";
    return null;
  }, [branchId, scope, filters, variantIds.length]);

  const pickerRows = useMemo(() => {
    const map = new Map<number, CatalogRow>();
    for (const row of picker.data?.rows ?? [])
      map.set(Number(row.variantId), row);
    return Array.from(map.values());
  }, [picker.data?.rows]);

  function toggleVariant(row: CatalogRow) {
    const id = Number(row.variantId);
    if (
      !variantIds.includes(id) &&
      variantIds.length >= COST_WAVE_MAX_SELECTED_ITEMS
    ) {
      setError(
        `بلغ الاختيار الحد الأقصى (${COST_WAVE_MAX_SELECTED_ITEMS} صنف). قسم العمل إلى موجة أخرى.`,
      );
      return;
    }
    setVariantIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
    setSelectedLabels((current) => ({
      ...current,
      [id]: `${row.productName} · ${row.sku}`,
    }));
  }

  function runPreview() {
    if (scopeError) {
      setError(scopeError);
      return;
    }
    setError("");
    previewMutation.mutate(input);
  }

  async function submit() {
    if (!preview) return;
    if (
      name.trim().length < 3 ||
      reason.trim().length < COST_WAVE_MIN_REASON_LENGTH
    ) {
      setError("أدخل اسماً واضحاً وسبباً موثقاً من 10 محارف على الأقل.");
      return;
    }
    if (confirmationCount.trim() !== String(preview.totals.itemCount)) {
      setError("اكتب عدد الأصناف الظاهر في المعاينة حرفياً قبل الإرسال.");
      return;
    }
    const ok = await confirm({
      variant: "warning",
      title: "إرسال موجة التكلفة للاعتماد",
      description: `سيُجمّد المستند ${preview.totals.itemCount} صنفاً بأثر متوقع ${formatIqd(preview.totals.expectedValueDelta)}. لا تتغير التكلفة الآن، ويلزم اعتماد شخصين آخرين.`,
      confirmText: "إرسال للاعتماد",
      requireText: String(preview.totals.itemCount),
      requireTextLabel: `اكتب عدد الأصناف (${preview.totals.itemCount}) للتأكيد`,
    });
    if (!ok) return;
    submitMutation.mutate({
      ...input,
      name: name.trim(),
      reason: reason.trim(),
      description: description.trim() || null,
      previewFingerprint: preview.fingerprint,
    });
  }

  const previewColumns = useMemo<ColumnDef<PreviewRow, unknown>[]>(
    () => [
      {
        accessorKey: "productName",
        header: "المنتج / المتغيّر",
        cell: ({ row }) => (
          <div>
            <div className="font-semibold">{row.original.productName}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.variantLabel} · {row.original.sku}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "categoryName",
        header: "الفئة",
        cell: ({ row }) => row.original.categoryName || "—",
      },
      {
        accessorKey: "oldCost",
        header: "التكلفة السابقة",
        cell: ({ row }) => formatIqd(row.original.oldCost),
        meta: { kind: "money" },
      },
      {
        accessorKey: "newCost",
        header: "التكلفة الجديدة",
        cell: ({ row }) => <b>{formatIqd(row.original.newCost)}</b>,
        meta: { kind: "money" },
      },
      {
        accessorKey: "expectedQuantity",
        header: "الكمية",
        cell: ({ row }) =>
          row.original.expectedQuantity.toLocaleString("ar-IQ-u-nu-latn"),
        meta: { kind: "number" },
      },
      {
        accessorKey: "inventoryValueBefore",
        header: "قيمة قبل",
        cell: ({ row }) => formatIqd(row.original.inventoryValueBefore),
        meta: { kind: "money" },
      },
      {
        accessorKey: "inventoryValueAfter",
        header: "قيمة بعد",
        cell: ({ row }) => formatIqd(row.original.inventoryValueAfter),
        meta: { kind: "money" },
      },
      {
        accessorKey: "expectedValueDelta",
        header: "فرق القيمة",
        cell: ({ row }) => (
          <bdi dir="ltr">{formatIqd(row.original.expectedValueDelta)}</bdi>
        ),
        meta: { kind: "money" },
      },
    ],
    [],
  );
  const skippedColumns = useMemo<ColumnDef<SkippedRow, unknown>[]>(
    () => [
      { accessorKey: "productName", header: "المنتج" },
      { accessorKey: "variantLabel", header: "المتغيّر" },
      { accessorKey: "sku", header: "SKU" },
      {
        accessorKey: "oldCost",
        header: "التكلفة الحالية",
        cell: ({ row }) => formatIqd(row.original.oldCost),
        meta: { kind: "money" },
      },
      {
        accessorKey: "reason",
        header: "سبب الاستبعاد",
        cell: ({ row }) => COST_WAVE_SKIP_LABELS[row.original.reason],
      },
    ],
    [],
  );

  return (
    <div className="space-y-4 pt-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            1. تحديد النطاق والقاعدة المحاسبية
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            {canPickBranch && (
              <Field
                label="فرع المستند"
                required
                hint="يحدد ملكية الطلب ومسار تنبيهات الاعتماد"
              >
                <AppSelect
                  value={
                    selectedBranchId === "" ? "" : String(selectedBranchId)
                  }
                  onValueChange={(value) =>
                    setSelectedBranchId(value ? Number(value) : "")
                  }
                >
                  <option value="">اختر الفرع…</option>
                  {(branches.data ?? []).map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </AppSelect>
              </Field>
            )}
            <Field
              label="نطاق الموجة"
              required
              hint="اختيار صريح يمنع تحول الفلتر الفارغ إلى كل المخزون"
            >
              <AppSelect
                value={scope}
                onValueChange={(value) => setScope(value as CostWaveScope)}
              >
                {(Object.keys(COST_WAVE_SCOPE_LABELS) as CostWaveScope[]).map(
                  (value) => (
                    <option key={value} value={value}>
                      {COST_WAVE_SCOPE_LABELS[value]}
                    </option>
                  ),
                )}
              </AppSelect>
            </Field>
            {scope === "FILTERED" && (
              <>
                <Field label="الفئة" hint="تشمل الفئات الفرعية المباشرة">
                  <AppSelect
                    value={categoryId === "" ? "" : String(categoryId)}
                    onValueChange={(value) =>
                      setCategoryId(value ? Number(value) : "")
                    }
                  >
                    <option value="">كل الفئات</option>
                    <CategoryOptionList categories={categories.data ?? []} />
                  </AppSelect>
                </Field>
                <Field label="بحث المنتج / SKU / الباركود">
                  <div className="relative">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 right-2 my-auto size-4 text-muted-foreground"
                    />
                    <Input
                      value={productSearch}
                      onChange={(event) => setProductSearch(event.target.value)}
                      className="pr-8"
                      placeholder="مثال: أقلام أزرق أو SKU"
                    />
                  </div>
                </Field>
              </>
            )}
            <Field label="الغرض المحاسبي" required>
              <AppSelect
                value={purpose}
                onValueChange={(value) => setPurpose(value as CostWavePurpose)}
              >
                {(
                  Object.keys(COST_WAVE_PURPOSE_LABELS) as CostWavePurpose[]
                ).map((value) => (
                  <option key={value} value={value}>
                    {COST_WAVE_PURPOSE_LABELS[value]}
                  </option>
                ))}
              </AppSelect>
            </Field>
            <Field label="قاعدة التغيير" required>
              <AppSelect
                value={ruleType}
                onValueChange={(value) =>
                  setRuleType(value as CostWaveRuleType)
                }
              >
                {(Object.keys(COST_WAVE_RULE_LABELS) as CostWaveRuleType[]).map(
                  (value) => (
                    <option key={value} value={value}>
                      {COST_WAVE_RULE_LABELS[value]}
                    </option>
                  ),
                )}
              </AppSelect>
            </Field>
            <Field
              label={
                ruleType === "SET_COST"
                  ? "التكلفة المستهدفة"
                  : ruleType.endsWith("_AMOUNT")
                    ? "المبلغ"
                    : "النسبة (%)"
              }
              required
            >
              <MoneyInput
                value={changeValue}
                onChange={setChangeValue}
                decimals={4}
                ariaLabel="قيمة تغيير التكلفة"
              />
            </Field>
          </div>

          {scope === "ALL" && (
            <div className="rounded-md border border-[var(--sem-danger)]/35 bg-[var(--sem-danger-bg)] p-3 text-sm">
              اخترت كل الأصناف المؤهلة. افحص عدد الأصناف والأثر في المعاينة قبل
              الإرسال.
            </div>
          )}
          {scope === "SELECTED" && (
            <div className="space-y-3 rounded-md border p-3">
              <Field
                label="ابحث عن صنف وأضفه"
                hint={`الاختيار على مستوى المتغيّر/SKU، حتى ${COST_WAVE_MAX_SELECTED_ITEMS} صنف`}
              >
                <Input
                  value={pickerSearch}
                  onChange={(event) => setPickerSearch(event.target.value)}
                  placeholder="اسم المنتج أو SKU أو الباركود"
                />
              </Field>
              {pickerRows.length > 0 && (
                <div className="max-h-52 overflow-y-auto rounded-md border">
                  {pickerRows.map((row) => {
                    const id = Number(row.variantId);
                    const selected = variantIds.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleVariant(row)}
                        aria-pressed={selected}
                        className={cn(
                          "flex w-full items-center justify-between border-b px-3 py-2 text-right text-sm last:border-0 hover:bg-accent",
                          selected && "bg-accent",
                        )}
                      >
                        <span>
                          {row.productName} · <bdi dir="ltr">{row.sku}</bdi>
                        </span>
                        {selected && (
                          <CheckCircle2
                            aria-hidden
                            className="size-4 text-[var(--sem-pos)]"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {variantIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {variantIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={`إزالة ${selectedLabels[id] || `الصنف ${id}`} من الموجة`}
                      onClick={() =>
                        setVariantIds((current) =>
                          current.filter((value) => value !== id),
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs"
                    >
                      {selectedLabels[id] || `#${id}`}{" "}
                      <XCircle aria-hidden className="size-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {scopeError && (
            <p role="status" className="text-sm text-[var(--sem-warn)]">
              {scopeError}
            </p>
          )}
          {error && (
            <p
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-[var(--sem-danger)]/35 bg-[var(--sem-danger-bg)] p-3 text-sm text-[var(--sem-danger)]"
            >
              {error}
            </p>
          )}
          <Button
            onClick={runPreview}
            disabled={previewMutation.isPending || !!scopeError || !changeValue}
          >
            <Eye aria-hidden />{" "}
            {previewMutation.isPending
              ? ACTION_LABELS.processing
              : "إنشاء معاينة موقعة"}
          </Button>
        </CardContent>
      </Card>

      {preview && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                2. المعاينة التفصيلية قبل الاعتماد
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Metric
                  label="الأصناف المشمولة"
                  value={String(preview.totals.itemCount)}
                />
                <Metric
                  label="الكمية"
                  value={preview.totals.expectedQuantity.toLocaleString(
                    "ar-IQ-u-nu-latn",
                  )}
                />
                <Metric
                  label="قيمة المخزون قبل"
                  value={formatIqd(preview.totals.inventoryValueBefore)}
                />
                <Metric
                  label="قيمة المخزون بعد"
                  value={formatIqd(preview.totals.inventoryValueAfter)}
                />
                <Metric
                  label="فرق القيمة"
                  value={formatIqd(preview.totals.expectedValueDelta)}
                  strong
                />
              </div>
              <DataTable
                columns={previewColumns}
                data={preview.rows}
                searchable
                searchPlaceholder="ابحث في الأصناف المشمولة"
                bounded={false}
                viewKey="cost-wave-preview"
              />
              {preview.skipped.length > 0 && (
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer font-semibold">
                    الأصناف المستبعدة مع الأسباب ({preview.skipped.length})
                  </summary>
                  <div className="mt-3">
                    <DataTable
                      columns={skippedColumns}
                      data={preview.skipped}
                      searchable
                      bounded={false}
                      viewKey="cost-wave-skipped"
                    />
                  </div>
                </details>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                3. توثيق وإرسال الموجة للاعتماد
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="اسم الموجة" required>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={255}
                    placeholder="مثال: تصحيح تكلفة دفعة المورد — آب"
                  />
                </Field>
                <Field
                  label="اكتب عدد الأصناف للتأكيد"
                  required
                  hint={`العدد في المعاينة: ${preview.totals.itemCount}`}
                >
                  <Input
                    value={confirmationCount}
                    onChange={(event) =>
                      setConfirmationCount(
                        event.target.value.replace(/\D/g, ""),
                      )
                    }
                    inputMode="numeric"
                    placeholder={String(preview.totals.itemCount)}
                  />
                </Field>
              </div>
              <Field
                label="السبب المحاسبي والمستند المرجعي"
                required
                hint="10 محارف على الأقل؛ يظهر للمعتمد وفي سجل التدقيق"
              >
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={COST_WAVE_MAX_REASON_LENGTH}
                  placeholder="رقم فاتورة المورد/محضر الجرد، وما الخطأ الذي يُصحح"
                />
              </Field>
              <Field label="وصف إضافي">
                <Textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={2000}
                  placeholder="ملاحظات اختيارية للمراجعين"
                />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                <div className="text-sm">
                  <b>السياسة:</b> المنشئ لا يعتمد، ويلزم شخصان مختلفان. الاعتماد
                  الثاني يعيد فحص كل اللقطات ثم يطبّق الكل أو لا شيء.
                </div>
                <Button
                  onClick={submit}
                  disabled={
                    submitMutation.isPending ||
                    name.trim().length < 3 ||
                    reason.trim().length < COST_WAVE_MIN_REASON_LENGTH ||
                    confirmationCount !== String(preview.totals.itemCount)
                  }
                >
                  <Send aria-hidden />{" "}
                  {submitMutation.isPending
                    ? ACTION_LABELS.submitting
                    : "إرسال لاعتمادين"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function WaveList({
  view,
  onOpen,
}: {
  view: "AWAITING_MINE" | "MY_REQUESTS" | "HISTORY";
  onOpen: (id: number) => void;
}) {
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  useEffect(() => {
    setPage(0);
    setCursors([null]);
  }, [view, debouncedSearch]);
  const query = trpc.inventory.costWaves.useQuery({
    view,
    limit: PAGE_SIZE,
    cursor: cursors[page] ?? undefined,
    search: debouncedSearch || undefined,
  });

  function changePage(nextPage: number) {
    if (nextPage > page) {
      const nextCursor = query.data?.nextCursor;
      if (nextCursor == null) return;
      setCursors((current) => {
        const next = current.slice(0, nextPage + 1);
        next[nextPage] = nextCursor;
        return next;
      });
    }
    setPage(nextPage);
  }
  const columns = useMemo<ColumnDef<WaveRow, unknown>[]>(
    () => [
      {
        accessorKey: "id",
        header: "رقم",
        cell: ({ row }) => `#${row.original.id}`,
        meta: { kind: "number", width: "id" },
      },
      {
        accessorKey: "name",
        header: "الموجة",
        cell: ({ row }) => (
          <div>
            <button
              type="button"
              onClick={() => onOpen(row.original.id)}
              className="font-semibold text-primary hover:underline"
            >
              {row.original.name}
            </button>
            <div className="text-xs text-muted-foreground">
              {COST_WAVE_PURPOSE_LABELS[row.original.purpose]}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "الحالة",
        cell: ({ row }) => (
          <Badge
            variant={STATUS_VARIANT[row.original.status as CostWaveStatus]}
          >
            {COST_WAVE_STATUS_LABELS[row.original.status as CostWaveStatus]}
          </Badge>
        ),
      },
      {
        accessorKey: "itemCount",
        header: "الأصناف",
        cell: ({ row }) =>
          row.original.itemCount.toLocaleString("ar-IQ-u-nu-latn"),
        meta: { kind: "number" },
      },
      {
        accessorKey: "expectedQuantity",
        header: "الكمية",
        cell: ({ row }) =>
          row.original.expectedQuantity.toLocaleString("ar-IQ-u-nu-latn"),
        meta: { kind: "number" },
      },
      {
        accessorKey: "expectedValueDelta",
        header: "فرق القيمة",
        cell: ({ row }) => (
          <bdi dir="ltr">{formatIqd(row.original.expectedValueDelta)}</bdi>
        ),
        meta: { kind: "money" },
      },
      {
        id: "approvals",
        header: "الاعتمادات",
        accessorFn: (row) => `${row.approvalCount}/${row.requiredApprovals}`,
        cell: ({ row }) =>
          `${row.original.approvalCount} من ${row.original.requiredApprovals}`,
        meta: { kind: "number" },
      },
      {
        accessorKey: "createdByName",
        header: "أنشأها",
        cell: ({ row }) =>
          row.original.createdByName || `مستخدم #${row.original.createdBy}`,
      },
      {
        accessorKey: "createdAt",
        header: "التاريخ",
        cell: ({ row }) => fmtDateTime(row.original.createdAt),
        meta: { kind: "datetime" },
      },
      {
        id: "actions",
        header: "الإجراء",
        cell: ({ row }) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpen(row.original.id)}
          >
            <Eye aria-hidden /> تفاصيل
          </Button>
        ),
        meta: { kind: "actions" },
      },
    ],
    [onOpen],
  );
  return (
    <Card className="mt-2">
      <CardContent className="pt-5">
        <DataTable
          columns={columns}
          data={query.data?.rows ?? []}
          searchable
          searchPlaceholder="بحث باسم الموجة أو المنشئ أو الحالة"
          serverSearch={{ value: search, onChange: setSearch }}
          serverPagination={{
            page,
            onPageChange: changePage,
            pageSize: PAGE_SIZE,
            hasMore: query.data?.hasMore ?? false,
            isFetching: query.isFetching,
          }}
          loading={query.isLoading}
          errorState={{
            isError: query.isError,
            message: query.error?.message,
            onRetry: () => void query.refetch(),
          }}
          emptyText={
            view === "AWAITING_MINE"
              ? "لا توجد موجات تنتظر قرارك"
              : "لا توجد موجات في هذا القسم"
          }
          bounded={false}
          viewKey={`cost-waves-${view.toLowerCase()}`}
        />
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-lg font-bold", strong && "text-primary")}>
        {value}
      </div>
    </div>
  );
}
