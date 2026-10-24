import { PRICE_TIER_LABELS as TIER_LABEL } from "@shared/terms";
// بند 12ب (٧/٧): التسعير التعاقدي الخاص بعميل (عقود الدوائر الحكومية) — شاشة إدارة بمدير.
// منتقي عميل → جدول أسعاره التعاقدية (نشطة/معطَّلة) → إضافة سطر: بحث منتج (وحدة قياس محدَّدة
// من نتيجة البحث نفسها — كل صف نتيجة = متغيّر×وحدة) ثم سعر MoneyInput. السعر التعاقدي النشط
// يتقدّم على سعر الفئة في POS وفي فرض الخادم معاً (resolveContractPrices واحدة للنقطتين).
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Download, FileSignature, FileSpreadsheet, Phone, Plus, Printer, User, X } from "lucide-react";
import CustomerPicker from "@/components/CustomerPicker";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/PageState";
import { RowActions } from "@/components/list";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { MoneyInput } from "@/components/form/MoneyInput";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine, PriceTier } from "@/components/invoice/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime, toDate, type DateInput } from "@/lib/date";
import { notify } from "@/lib/notify";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { normalizeSearchText } from "@shared/searchNormalize";
import { ACTION_LABELS } from "@shared/actionLabels";

type ContractRow = RouterOutputs["customers"]["contractPricesList"][number];


const fmtMoney = (v: string) =>
  Number(v).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });

/**
 * فرزُ عمود «آخر تحديث» يلزمه مقارِنٌ صريح: `accessorFn` يُرجع **نصّ العرض**
 * (`fmtDateTime` ⇒ «21/06/2026، 14:30») وهو ما يُنسَخ، لكنّ `Date.parse` لا يقرأه
 * فيسقط مقارِنُ `meta.kind: "datetime"` إلى مقارنةٍ نصّية ⇒ **فرزٌ باليوم لا بالتاريخ**
 * («01/12/2025» قبل «05/01/2026»). المقارنة هنا على القيمة الخام. نفس علاج InvoiceDetail.
 */
const cmpTime = (a: DateInput, b: DateInput) => {
  const ta = toDate(a)?.getTime() ?? -Infinity;
  const tb = toDate(b)?.getTime() ?? -Infinity;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
};

function variantLabel(r: ContractRow): string {
  const extras = [r.variantName, r.color, r.size].filter(Boolean).join(" / ");
  return extras ? `${r.productName} — ${extras}` : r.productName;
}

export default function ContractPrices() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  // منتقي فرع صريح (نمط PR #288 في Reception.tsx): سياق البحث عن المنتج (مخزون/معاينة سعر) فقط
  // — الجدول التعاقدي نفسه بلا فرع في المخطّط (customerContractPrices عميلٌ واحد لكل الفروع).
  // فرع المستخدم المُسنَد يُستعمَل صامتاً؛ الأدمن/المدير بلا فرع يختار صراحةً قبل تفعيل البحث
  // (بدل فرعٍ ١ صامت يُبنى عليه معاينة سعر/مخزون من فرعٍ قد لا يقصده).
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const isElevatedRole = me.data?.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
  const noAssignedBranch = me.data != null && me.data.branchId == null;
  const needsBranchChoice = noAssignedBranch && isElevatedRole && pickedBranch == null;
  const branchId = Number(me.data?.branchId ?? pickedBranch ?? 1);

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);
  const customer = trpc.customers.get.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null, staleTime: 60_000 },
  );
  const tier = (customer.data?.defaultPriceTier ?? "RETAIL") as PriceTier;

  const list = trpc.customers.contractPricesList.useQuery(
    { customerId: customerId ?? 0 },
    { enabled: customerId != null },
  );
  const rows = list.data ?? [];

  // بحث/فلتر محلي بجدول الأسعار التعاقدية (منتج/SKU/ملاحظة) — القائمة كاملة لعميل واحد فمعالجتها
  // محلية بلا حاجة لجولة خادم إضافية.
  const [q, setQ] = useState("");
  const filteredRows = useMemo(() => {
    const nq = normalizeSearchText(q.trim());
    if (!nq) return rows;
    return rows.filter((r) =>
      normalizeSearchText(`${variantLabel(r)} ${r.sku} ${r.unitName} ${r.note ?? ""}`).includes(nq),
    );
  }, [rows, q]);

  // ── سطر الإضافة: وحدة مختارة من البحث + سعر تعاقدي + ملاحظة ──────────────────
  const [picked, setPicked] = useState<InvoiceLine | null>(null);
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");

  function resetForm() {
    setPicked(null);
    setPrice("");
    setNote("");
  }

  const invalidate = () => utils.customers.contractPricesList.invalidate();

  const upsert = trpc.customers.contractPriceUpsert.useMutation({
    onSuccess: (r) => {
      void invalidate();
      resetForm();
      notify.ok(r.updated ? "حُدّث السعر التعاقدي" : "أُضيف السعر التعاقدي");
    },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.customers.contractPriceSetActive.useMutation({
    onSuccess: () => void invalidate(),
    onError: (e) => notify.err(e),
  });
  const remove = trpc.customers.contractPriceRemove.useMutation({
    onSuccess: () => {
      void invalidate();
      notify.ok("حُذف السعر التعاقدي");
    },
    onError: (e) => notify.err(e),
  });

  function submit() {
    if (customerId == null) return notify.err("اختر عميلاً أولاً");
    if (!picked) return notify.err("اختر منتجاً (وحدة قياس) من البحث");
    if (!price || Number(price) <= 0) return notify.err("أدخل سعراً تعاقدياً أكبر من صفر");
    upsert.mutate({
      customerId,
      productUnitId: picked.productUnitId,
      price,
      note: note.trim() || null,
    });
  }

  // أعمدة الجدول التعاقديّ — تُعرَّف داخل المكوّن لأنّها تلتقط setActive/onRemove.
  // useMemo لتفادي إعادة البناء مع كل رسم (يُبطئ تحديد الأعمدة الظاهرة في DataTable).
  // ⚠️ `accessorFn` على كل عمودٍ ذي قيمة: هو مصدر «نسخ القيمة/الصفّ/العمود» ومصدرُ الفرز معاً —
  // وعمودُ العرض بلا accessor يُعيد `undefined` فتخرج خليّتُه فارغةً في TSV ويصير فرزُه بلا أثر.
  // و`meta.kind` يتكفّل بالمحاذاة و`tabular-nums` وعزل اتّجاه الأرقام بدل `dir`/`text-*` يدويّة.
  const columns = useMemo<ColumnDef<ContractRow>[]>(() => [
    { id: "product", header: "المنتج", accessorFn: (r) => variantLabel(r), meta: { width: "wide" }, cell: ({ row }) => variantLabel(row.original) },
    { id: "sku", header: "SKU", accessorFn: (r) => r.sku, meta: { kind: "code" }, cell: ({ row }) => <span className="text-muted-foreground">{row.original.sku}</span> },
    { id: "unit", header: "الوحدة", accessorFn: (r) => r.unitName, cell: ({ row }) => row.original.unitName },
    { id: "price", header: "السعر التعاقدي", accessorFn: (r) => fmtMoney(r.price), meta: { kind: "money" }, cell: ({ row }) => <span className="font-bold">{fmtMoney(row.original.price)}</span> },
    {
      id: "status",
      header: "الحالة",
      // التسمية العربية لا العَلَم المنطقيّ: «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
      accessorFn: (r) => (r.isActive ? "نشط" : "معطَّل"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${
            row.original.isActive
              ? "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
              : "border-border bg-muted/40 text-muted-foreground"
          }`}
        >
          {row.original.isActive ? "نشط" : "معطَّل"}
        </span>
      ),
    },
    { id: "note", header: "ملاحظة", accessorFn: (r) => r.note ?? "—", meta: { wrap: true }, cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.note ?? "—"}</span> },
    { id: "updatedAt", header: "آخر تحديث", accessorFn: (r) => fmtDateTime(r.updatedAt), meta: { kind: "datetime" }, sortingFn: (a, b) => cmpTime(a.original.updatedAt, b.original.updatedAt), cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDateTime(row.original.updatedAt)}</span> },
    {
      id: "actions",
      header: "إجراءات",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => (
        <RowActions
          actions={[
            {
              key: "dossier360",
              kind: "view",
              icon: User,
              label: "الملف الشامل 360° للعميل",
              onSelect: () => {
                if (customerId != null) setDossierCustomerId(customerId);
              },
              gate: { module: "crm", level: "READ" },
            },
            {
              key: "toggle",
              kind: "approve",
              label: row.original.isActive ? "تعطيل" : "تفعيل",
              onSelect: () => setActive.mutate({ id: row.original.id, isActive: !row.original.isActive }),
              gate: { roles: ["manager"], module: "crm", level: "FULL" },
            },
            {
              key: "remove",
              kind: "delete",
              label: "حذف",
              variant: "destructive",
              onSelect: () => void onRemove(row.original),
              gate: { roles: ["manager"], module: "crm", level: "FULL" },
            },
          ]}
        />
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [setActive, customerId]);

  async function onRemove(r: ContractRow) {
    if (
      !(await confirm({
        variant: "danger",
        title: "حذف السعر التعاقدي",
        description: `سيُحذف السعر التعاقدي لـ«${variantLabel(r)} (${r.unitName})» نهائياً ويعود العميل لسعر الفئة. متابعة؟`,
        confirmText: "حذف",
      }))
    )
      return;
    remove.mutate({ id: r.id });
  }

  /** طباعة ملحق الأسعار التعاقدية عبر طابعة ReportDoc الرسمية الموحدة */
  function printAddendum() {
    const active = rows.filter((r) => r.isActive);
    if (customerId == null || !customer.data || active.length === 0) {
      notify.err("لا أسعار تعاقدية نشطة لطباعتها");
      return;
    }

    printReportDoc({
      title: "ملحق الأسعار الخاصة والتعاقدية",
      docNum: `CTR-${customerId}-${fmtDate(new Date()).replace(/\//g, "")}`,
      docDate: fmtDate(new Date()),
      headerExtra: [
        { label: "الجهة / العميل", value: customer.data.name },
        { label: "رقم الهاتف", value: customer.data.phone || "—" },
        { label: "فئة السعر الأصلية", value: TIER_LABEL[tier] },
      ],
      note: "الأسعار الواردة في هذا الملحق خاصة ومعتمدة رسميّاً وتتقدّم على أسعار الفئات الافتراضية.",
      columns: [
        { key: "product", label: "المنتج والصنف" },
        { key: "sku", label: "الرمز SKU", align: "center" },
        { key: "unit", label: "الوحدة", align: "center" },
        { key: "price", label: "السعر التعاقدي (د.ع)", align: "left" },
        { key: "note", label: "ملاحظات" },
      ],
      rows: active.map((r) => ({
        product: variantLabel(r),
        sku: r.sku,
        unit: r.unitName,
        price: `${fmtMoney(r.price)} د.ع`,
        note: r.note || "—",
      })),
      summary: [
        {
          label: "عدد المواد المشمولة بالاتفاق",
          value: `${active.length.toLocaleString("ar-IQ-u-nu-latn")} مادة`,
          bold: true,
        },
      ],
      signatures: [
        { label: "توقيع العميل / الجهة المتعاقدة", subtext: "الاسم والتوقيع والختم" },
        { label: "توقيع المخوَّل بالمكتبة", subtext: "الاعتماد والختم الرسمي" },
      ],
    });
  }

  const handleExport = (format: "xlsx" | "csv") => {
    if (!customer.data || filteredRows.length === 0) {
      notify.err("لا توجد أسعار تعاقدية لتصديرها");
      return;
    }
    void exportRows<ContractRow>(filteredRows, {
      filename: `أسعار-خاصة-${customer.data.name}-${fmtDate(new Date())}`,
      title: `ملحق الأسعار الخاصة والتعاقدية — ${customer.data.name}`,
      format,
      columns: [
        { key: "product", header: "المنتج", map: (r) => variantLabel(r) },
        { key: "sku", header: "SKU", text: true, map: (r) => r.sku },
        { key: "unitName", header: "الوحدة", map: (r) => r.unitName },
        { key: "price", header: "السعر التعاقدي (د.ع)", money: true, map: (r) => Number(r.price) },
        { key: "isActive", header: "الحالة", map: (r) => (r.isActive ? "نشط" : "معطَّل") },
        { key: "note", header: "ملاحظة", map: (r) => r.note ?? "—" },
        { key: "updatedAt", header: "آخر تحديث", map: (r) => fmtDateTime(r.updatedAt) },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أسعار خاصة وعقود الشركات"
        description="أسعار خاصة بعميل (عقود الدوائر والشركات) تتقدّم على فئات التسعير في الكاشير والفواتير."
        icon={<FileSignature aria-hidden className="size-6" />}
        actions={
          customerId != null ? (
            <div className="flex flex-wrap items-center gap-2">
              {filteredRows.length > 0 && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport("xlsx")}
                    title="تصدير إلى Excel"
                  >
                    <Download aria-hidden className="size-4 text-muted-foreground" />
                    Excel
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport("csv")}
                    title="تصدير إلى CSV"
                  >
                    <FileSpreadsheet aria-hidden className="size-4 text-muted-foreground" />
                    CSV
                  </Button>
                </>
              )}
              {rows.some((r) => r.isActive) && (
                <Button variant="outline" size="sm" onClick={printAddendum}>
                  <Printer aria-hidden className="size-4" /> طباعة ملحق الأسعار
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {needsBranchChoice && (
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <Label htmlFor="cp-branch">الفرع <span className="text-destructive">*</span></Label>
            <AppSelect
              id="cp-branch"
              className="h-9 max-w-xs border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={pickedBranch ?? ""}
              onValueChange={(next) => setPickedBranch(next ? Number(next) : null)}
            >
              <option value="">— اختر الفرع —</option>
              {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </AppSelect>
            <p className="text-[11px] text-muted-foreground">يحدّد سياق معاينة السعر/المخزون أثناء البحث عن المنتج — الأسعار التعاقدية نفسها ليست مرتبطة بفرع.</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-xl flex-1">
              <CustomerPicker
                customerId={customerId}
                onCustomerChange={(id) => {
                  setCustomerId(id);
                  resetForm();
                }}
                balance={customer.data?.currentBalance ?? null}
              />
            </div>
            {customerId != null && customer.data && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDossierCustomerId(customerId)}
                  className="gap-1.5"
                  title="الملف الشامل 360° للعميل"
                >
                  <User className="size-4 text-primary" aria-hidden />
                  الملف الشامل 360°
                </Button>
                {customer.data.phone && (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-[var(--sem-pos)] hover:bg-accent"
                    title={`اتصال: ${customer.data.phone}`}
                  >
                    <a href={`tel:${customer.data.phone}`}>
                      <Phone className="size-4" aria-hidden />
                      اتصال
                    </a>
                  </Button>
                )}
                {customer.data.phone && (
                  <WhatsAppShare
                    phone={customer.data.phone}
                    message={`السلام عليكم ${customer.data.name}، نود إعلامكم بتحديث قائمة الأسعار التعاقدية المعتمدة لحسابكم الموقر.`}
                    size="sm"
                    appearance="outline"
                    label="واتساب"
                  />
                )}
              </div>
            )}
          </div>
          {customerId != null && customer.data && (
            <p className="mt-1 text-xs text-muted-foreground">
              فئة العميل الافتراضية: <span className="font-semibold">{TIER_LABEL[tier]}</span> — السعر
              التعاقدي النشط يتقدّم عليها لوحدة المنتج المحدَّدة.
            </p>
          )}
        </CardHeader>

        {customerId == null ? (
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            اختر عميلاً لعرض أسعاره التعاقدية وإدارتها.
          </CardContent>
        ) : (
          <CardContent className="space-y-4">
            {/* ── إضافة/تحديث سطر تعاقدي ── */}
            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <div className="text-sm font-bold">إضافة سعر تعاقدي</div>
              {needsBranchChoice ? (
                <p className="text-xs text-[var(--sem-warn)]">اختر الفرع أعلاه أولاً لتفعيل البحث عن المنتج.</p>
              ) : picked == null ? (
                <ProductSearchBar
                  invoiceType="SALE"
                  branchId={branchId}
                  tier={tier}
                  onAddProduct={(line) => setPicked(line)}
                  onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.ok(msg))}
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_12rem_1fr_auto] md:items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">المنتج (وحدة القياس)</Label>
                    <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 text-sm">
                      <span className="truncate">
                        {picked.name} <span className="text-muted-foreground">({picked.unit})</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setPicked(null)}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label="إلغاء اختيار المنتج"
                      >
                        <X aria-hidden className="size-4" />
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground" dir="ltr">
                      {fmtMoney(picked.price || "0")} د.ع — سعر فئة {TIER_LABEL[tier]} الحالي
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cp-price" className="text-xs">السعر التعاقدي (د.ع) *</Label>
                    <MoneyInput id="cp-price" value={price} onChange={setPrice} placeholder="0" ariaLabel="السعر التعاقدي" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="cp-note" className="text-xs">ملاحظة (رقم العقد مثلاً)</Label>
                    <Input id="cp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
                  </div>
                  <Button type="button" onClick={submit} disabled={upsert.isPending}>
                    <Plus aria-hidden className="size-4" />
                    {upsert.isPending ? ACTION_LABELS.saving : "حفظ السعر"}
                  </Button>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                إدخال سعر لوحدة لها سعر تعاقدي سابق يحدّثه (لا يُنشئ سطراً ثانياً) ويعيد تفعيله إن كان معطَّلاً.
              </p>
            </div>

            {/* ── جدول الأسعار التعاقدية ── */}
            {rows.length > 0 && (
              <UnifiedSearchInput barcode={false} dir="auto" debounceMs={0} wrapperClassName="max-w-xs" value={q} onChange={setQ} placeholder="ابحث بالمنتج/SKU/ملاحظة…" />
            )}
            <DataTable
              columns={columns}
              data={filteredRows}
              searchable={false}
              loading={list.isLoading}
              errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => void list.refetch() }}
              resourceKey="contractPrices"
              // ⚠️ البحث الخارجيّ في `q` هو الفلتر الوحيد هنا، والجدول لا يراه — بلا هذا العَلَم
              // يقيس DataTable نشاطَ الفلترة ببحثه الداخليّ (المعطَّل) فيسقط دائماً على فرع
              // «لا صفوف بعد» ويتجاهل `emptyFilteredState` أدناه كلّياً.
              externalFiltersActive={q.trim() !== ""}
              // البحث الخارجيّ في `q` نشط ⇒ نمرّر emptyFilteredState صراحةً حتى يعرف DataTable
              // أنّ الفراغ سببه الفلتر لا القائمة الأصلية (لا سبيل له معرفة ذلك من `q` الخارجيّ).
              emptyFilteredState={q.trim() !== "" ? (
                <EmptyState
                  resourceKey="contractPrices"
                  reason="NO_MATCH_FILTER"
                  action={<Button size="sm" variant="outline" onClick={() => setQ("")}>مسح البحث</Button>}
                />
              ) : undefined}
              getRowClassName={(r) => (r.isActive ? undefined : "opacity-60")}
              pageSize={100}
              bounded
            />
          </CardContent>
        )}
      </Card>

      <CustomerDossierDrawer
        customerId={dossierCustomerId}
        open={dossierCustomerId != null}
        onClose={() => setDossierCustomerId(null)}
      />
    </div>
  );
}
