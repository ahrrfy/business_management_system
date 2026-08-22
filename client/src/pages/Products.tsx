// شاشة إدارة المنتجات — قائمة خادمية كاملة (بحث ذكي + تقسيم صفحات + إظهار المعطّل)
// على نمط Customers.tsx. تستبدل posList (INNER JOIN يخفي الناقص + حدّ 500) بـadminList
// التي تعرض كل منتجات المالك (~9413) حتى الناقصة بلا متغيّرات/وحدات.
import { CopyInline } from "@/components/CopyButton";
import { ImportDialog } from "@/components/import/ImportDialog";
import { FilterField, ListToolbar, RowActions } from "@/components/list";
import { SelectionBar, useRowSelection } from "@/components/list/SelectionBar";
import { useFocusHighlight } from "@/components/search/useFocusHighlight";
import { UsagePanel } from "@/components/UsagePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { confirm } from "@/lib/confirm";
import { formatTableAsTSV } from "@/lib/copy/formatters";
import { fmtDateTime } from "@/lib/date";
import { PRODUCT_FIELDS } from "@/lib/importFields";
import type { ProductImportRow } from "@/lib/importTypes";
import { notify } from "@/lib/notify";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmtAr } from "@/lib/money";
import { printLabel } from "@/lib/printing/print";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { CategoryOptionList } from "@/lib/categoryTree";
import { useEffect, useState } from "react";

type Row = RouterOutputs["catalog"]["adminList"]["rows"][number];

const limit = 50;
const yesNo = (v: boolean | null | undefined) => (v == null ? "" : v ? "نعم" : "لا");

/** مِفتاح فَريد لِكُل صَفّ (مُنتَج × مُتَغَيِّر × وَحدة). */
function rowKey(r: Row): string {
  return `${r.productId}-${r.variantId ?? 0}-${r.productUnitId ?? 0}`;
}

export default function Products() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  // imports.products = managerProcedure خادمياً — زرّ الاستيراد للمدير/الأدمن فقط (مرآة requireRole).
  const isElevated = me.data?.role === "admin" || me.data?.role === "manager";
  // سياسة العزل الحديثة: الأدمن وحده يعبر الفروع؛ المدير مثبت على فرعه كالكاشير.
  const canPickBranch = me.data?.role === "admin";

  // الفلاتر تعيش في querystring (تُشارَك رابطاً وتنجو من التنقّل). "" = افتراضي كل حقل.
  const [f, setF] = useUrlFilters({ q: "", category: "", inactive: "", page: "0", branch: "" });
  const q = f.q;
  const includeInactive = f.inactive === "1";
  const categoryFilter = f.category;
  const page = Number(f.page) || 0;
  const setQ = (v: string) => setF({ q: v, page: "0" });
  const setIncludeInactive = (v: boolean) => setF({ inactive: v ? "1" : "", page: "0" });
  const setCategoryFilter = (v: string) => setF({ category: v, page: "0" });
  const setPage = (updater: number | ((p: number) => number)) =>
    setF({ page: String(typeof updater === "function" ? updater(page) : updater) });

  // اتساق ListToolbar: شارة الفلاتر النشطة + زرّ المسح.
  // الفرع مُستثنى (منتقي منفصل هو مصدر بيانات الشاشة، ليس فلتراً ثانوياً — إعادة ضبطه تكسر الاستعلام).
  const activeFilterCount = [categoryFilter, includeInactive ? "1" : ""].filter(Boolean).length;
  const resetFilters = () => setF({ q: "", category: "", inactive: "", page: "0" });

  // منتقي فرع صريح (نمط PR #288): افتراضي فرع المستخدم إن مُسنَد؛ وإلا يلزم اختياراً صريحاً
  // (لا `?? 1` صامت) — أثره هنا على عمود «المخزون» المعروض فقط (المنتجات/الأسعار عابرة للفروع).
  const branchesQ = trpc.branches.list.useQuery();
  const pickedBranch = canPickBranch && f.branch !== "" ? Number(f.branch) : null;
  const branchId = pickedBranch ?? (me.data?.branchId != null ? Number(me.data.branchId) : null);
  const setPickedBranch = (v: number | "") => setF({ branch: v === "" ? "" : String(v) });

  const [importOpen, setImportOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTo, setMoveTo] = useState<number | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ productId: number; name: string } | null>(null);
  const importMut = trpc.imports.products.useMutation();
  const categoriesQ = trpc.catalog.categories.useQuery();
  const dq = useDebouncedValue(q, 200);
  const sel = useRowSelection<string>();

  // الميل الأخير للبحث الشامل: عند الوصول بـ?q=&focus= نبذر البحث (يُحمِّل الصنف) ثمّ نُبرز صفّه.
  const { seedQuery, rowProps } = useFocusHighlight();
  useEffect(() => {
    if (seedQuery) setQ(seedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery]);

  const list = trpc.catalog.adminList.useQuery(
    {
      branchId: branchId ?? 0,
      q: dq.trim() || undefined,
      includeInactive,
      categoryId: categoryFilter === "" ? undefined : Number(categoryFilter),
      limit,
      offset: page * limit,
    },
    { enabled: branchId != null },
  );
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const effectiveBranchId = list.data?.branchId ?? branchId;
  const pages = Math.max(1, Math.ceil(total / limit));

  const setActive = trpc.catalog.setProductActive.useMutation({
    onSuccess: (res) => {
      utils.catalog.adminList.invalidate();
      utils.catalog.posList.invalidate();
      notify.ok(res.isActive ? "تم تفعيل المنتج" : "تم تعطيل المنتج");
    },
    onError: (e) => notify.err(e),
  });

  /** نَسخ المُحَدَّد كَ‍TSV — يضيف التكلفة والجملة للمالك/المدير فقط. */
  async function copySelectedAsTSV() {
    const picked = rows.filter((r) => sel.isSelected(rowKey(r)));
    if (picked.length === 0) return;
    const headers = ["المنتج", "المتغيّر", "الوحدة", "الباركود", "بدائل الباركود", "السعر"];
    if (isElevated) headers.push("التكلفة", "سعر الجملة");
    headers.push("الرصيد الفعلي", "المحجوز والمخصص", "المتاح للبيع");
    const tsv = formatTableAsTSV(
      headers,
      picked.map((r) => {
        const row: Record<string, string | number> = {
          "المنتج": r.productName,
          "المتغيّر": r.variantName ?? r.color ?? r.sku ?? "",
          "الوحدة": r.unitName ?? "",
          "الباركود": r.barcode ?? "",
          "بدائل الباركود": (r.barcodeAliases ?? []).join("، "),
          "السعر": r.price != null ? String(r.price) : "",
        };
        if (isElevated) {
          row["التكلفة"] = r.costPrice ?? "";
          row["سعر الجملة"] = r.wholesalePrice ?? "";
        }
        row["الرصيد الفعلي"] = r.stockBase ?? 0;
        row["المحجوز والمخصص"] = r.reservedBase ?? 0;
        row["المتاح للبيع"] = r.availableBase ?? 0;
        return row;
      }),
    );
    try {
      await navigator.clipboard.writeText(tsv);
      notify.ok(`نُسِخت ${picked.length} صفّاً إلى الحافظة (TSV)`);
    } catch {
      notify.err("تَعَذَّر النَسخ — استَعمِل زِرّ التَصدير");
    }
  }

  /** طِباعة مُلصَقات الباركود لِلمُحَدَّد (دَفعة واحِدة). */
  function printSelectedLabels() {
    const picked = rows.filter((r) => sel.isSelected(rowKey(r)) && r.barcode);
    if (picked.length === 0) {
      notify.err("لا يوجَد باركود في المُحَدَّد");
      return;
    }
    void printLabel(
      picked.map((r) => ({
        name: r.variantName ? `${r.productName} — ${r.variantName}` : r.productName,
        sku: r.sku ?? "",
        price: r.price,
        barcode: r.barcode ?? "",
      })),
    );
  }

  const reassignMut = trpc.catalog.reassignProducts.useMutation({
    onSuccess: (res) => {
      utils.catalog.adminList.invalidate();
      utils.catalog.categoriesAdmin.invalidate();
      sel.clear();
      setMoveOpen(false);
      notify.ok(`نُقل ${res.moved.toLocaleString("ar-IQ-u-nu-latn")} منتجاً`);
    },
    onError: (e) => notify.err(e),
  });

  /** معرّفات المنتجات الفريدة من الصفوف المحدَّدة في الصفحة الحالية. */
  function selectedProductIds(): number[] {
    return Array.from(new Set(rows.filter((r) => sel.isSelected(rowKey(r))).map((r) => r.productId)));
  }
  function openMove() {
    if (!selectedProductIds().length) { notify.err("حدّد منتجات أولاً"); return; }
    setMoveTo(null);
    setMoveOpen(true);
  }
  function confirmMove() {
    const ids = selectedProductIds();
    if (!ids.length) return;
    reassignMut.mutate({ productIds: ids, categoryId: moveTo });
  }

  async function toggle(productId: number, isActive: boolean, name: string) {
    if (isActive) {
      if (!(await confirm({
        variant: "danger",
        title: "تعطيل المنتج",
        description: `سيختفي «${name}» من شاشة البيع والبحث. تستطيع تفعيله لاحقاً. هل تتابع؟`,
        confirmText: "تعطيل",
      }))) return;
      setActive.mutate({ productId, isActive: false });
    } else {
      setActive.mutate({ productId, isActive: true });
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="المنتجات"
        description="عرض المنتجات بوحداتها وأسعارها ومخزونها — مع بحث فوري وتصدير."
      />

      <ImportDialog<ProductImportRow>
        open={importOpen}
        onOpenChange={setImportOpen}
        title="استيراد منتجات من Excel/CSV"
        entityName="منتج"
        fields={PRODUCT_FIELDS}
        onImport={async (importRows) => {
          const res = await importMut.mutateAsync({
            rows: importRows.map((r) => ({ ...r, rowNumber: r.rowNumber })),
            options: { onExisting: "skip" },
          });
          return res;
        }}
        onDone={(s) => {
          if (s.committed && s.created > 0) {
            notify.ok(`تم: ${s.created} منتج جديد، ${s.skipped} متخطّى`);
          }
          utils.catalog.adminList.invalidate();
          utils.catalog.posList.invalidate();
        }}
      />

      {branchId == null && (
        <div role="alert" className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-2 text-sm text-[var(--sem-warn)]">
          {canPickBranch
            ? "اختر الفرع من فلتر «الفرع» أدناه لعرض المنتجات ومخزونها — لا فرع مُسنَد لحسابك افتراضياً."
            : "لا فرع مُسنَد لحسابك — تواصل مع الإدارة لعرض هذه الشاشة."}
        </div>
      )}

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => setQ(v),
              placeholder: "بحث (اسم/SKU/باركود)",
              barcode: true,
            }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetFilters}
            filters={
              <>
                {/* FilterField يُظهر التسمية دائماً أعلى الحقل — تسميات مُوحَّدة على النمط
                    المعتمد (Purchases/Customers، PR #559). checkbox يبقى inline بتسمية جانبية. */}
                {canPickBranch && (
                  <FilterField label="الفرع (للمخزون)">
                    <select
                      value={branchId ?? ""}
                      onChange={(e) => setPickedBranch(e.target.value === "" ? "" : Number(e.target.value))}
                      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="">— اختر الفرع —</option>
                      {(branchesQ.data ?? []).map((b) => (
                        <option key={Number(b.id)} value={Number(b.id)}>{b.name}</option>
                      ))}
                    </select>
                  </FilterField>
                )}
                {!canPickBranch && branchId != null && (
                  <FilterField label="الفرع (للمخزون)">
                    <span className="inline-flex h-8 items-center rounded-md border border-input px-2 text-sm font-bold">
                      {branchesQ.data?.find((b) => Number(b.id) === effectiveBranchId)?.name ?? `فرع #${effectiveBranchId}`}
                    </span>
                  </FilterField>
                )}
                <FilterField label="الفئة">
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">كل الفئات</option>
                    <option value="0">— بلا فئة —</option>
                    <CategoryOptionList categories={categoriesQ.data ?? []} />
                  </select>
                </FilterField>
                <label className="flex items-center gap-2 h-8 text-sm self-end">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={includeInactive}
                    onChange={(e) => setIncludeInactive(e.target.checked)}
                  />
                  <span className="text-muted-foreground">إظهار المعطّل</span>
                </label>
              </>
            }
            exportSpec={branchId == null ? undefined : {
              filename: "المنتجات-الشامل",
              sheetName: "دليل المنتجات الشامل",
              rows,
              // تصدير شامل لكل النتائج المطابقة للفلاتر (لا الصفحة المعروضة فقط).
              // adminList يُعيد {rows,total} مع offset؛ سقف الخادم 500 ⇒ ~١٩ صفحة لـ٩٤١٣ صنفاً.
              fetchAll: () =>
                fetchAllPaged<Row>(
                  (offset, fetchLimit) =>
                    utils.catalog.adminList
                      .fetch({
                        branchId: branchId ?? 0,
                        q: dq.trim() || undefined,
                        includeInactive,
                        categoryId: categoryFilter === "" ? undefined : Number(categoryFilter),
                        limit: fetchLimit,
                        offset,
                      })
                      .then((r) => ({ rows: r.rows, total: r.total })),
                  { pageSize: 500 },
                ),
              // ملف مسطّح شامل: كل صف = منتج × متغيّر × وحدة. يتضمن حقول الإدارة غير الظاهرة
              // في الجدول، ويبقى متوافقاً مع حقول إعادة الاستيراد الأساسية.
              columns: [
                { key: "productId", header: "معرّف المنتج" },
                { key: "productName", header: "المنتج" },
                { key: "productType", header: "نوع المنتج" },
                { key: "brand", header: "الماركة" },
                { key: "modelName", header: "الموديل" },
                { key: "description", header: "الوصف" },
                { key: "categoryId", header: "معرّف الفئة", map: (r) => r.categoryId ?? "" },
                { key: "categoryName", header: "الفئة" },
                { key: "parentProductId", header: "معرّف المنتج الأب", map: (r) => r.parentProductId ?? "" },
                { key: "parentProductName", header: "المنتج الأب" },
                { key: "isCustomizable", header: "قابل للتخصيص", map: (r) => yesNo(r.isCustomizable) },
                { key: "isService", header: "بلا مخزون", map: (r) => yesNo(r.isService) },
                { key: "showInReception", header: "يظهر في الاستقبال", map: (r) => yesNo(r.showInReception) },
                { key: "isBundle", header: "بكج/حزمة", map: (r) => yesNo(r.isBundle) },
                { key: "isConsignment", header: "بضاعة أمانة", map: (r) => yesNo(r.isConsignment) },
                ...(isElevated
                  ? [
                      { key: "consignorId" as const, header: "معرّف المودِع", map: (r: Row) => r.consignorId ?? "" },
                      { key: "consignorName" as const, header: "المودِع" },
                    ]
                  : []),
                { key: "isFeatured", header: "مميّز في المتجر", map: (r) => yesNo(r.isFeatured) },
                { key: "showInStore", header: "ظاهر في المتجر", map: (r) => yesNo(r.showInStore) },
                { key: "productIsActive", header: "حالة المنتج", map: (r) => (r.productIsActive ? "مفعّل" : "معطّل") },
                { key: "productCreatedAt", header: "إنشاء المنتج", map: (r) => fmtDateTime(r.productCreatedAt) },
                { key: "productUpdatedAt", header: "آخر تحديث للمنتج", map: (r) => fmtDateTime(r.productUpdatedAt) },
                { key: "variantId", header: "معرّف المتغيّر", map: (r) => r.variantId ?? "" },
                { key: "sku", header: "SKU" },
                { key: "variantName", header: "المتغيّر", map: (r) => r.variantName ?? r.color ?? r.sku ?? "" },
                { key: "color", header: "اللون" },
                { key: "colorHex", header: "رمز اللون" },
                { key: "size", header: "القياس" },
                { key: "minStock", header: "الحد الأدنى للمخزون", map: (r) => r.minStock ?? "" },
                { key: "reorderPoint", header: "نقطة إعادة الطلب", map: (r) => r.reorderPoint ?? "" },
                { key: "seasonTarget", header: "الهدف الموسمي", map: (r) => r.seasonTarget ?? "" },
                { key: "variantIsActive", header: "حالة المتغيّر", map: (r) => r.variantIsActive == null ? "" : r.variantIsActive ? "مفعّل" : "معطّل" },
                { key: "variantCreatedAt", header: "إنشاء المتغيّر", map: (r) => fmtDateTime(r.variantCreatedAt) },
                { key: "variantUpdatedAt", header: "آخر تحديث للمتغيّر", map: (r) => fmtDateTime(r.variantUpdatedAt) },
                { key: "productUnitId", header: "معرّف الوحدة", map: (r) => r.productUnitId ?? "" },
                { key: "unitName", header: "الوحدة" },
                { key: "conversionFactor", header: "معامل التحويل", map: (r) => r.conversionFactor ?? "" },
                { key: "isBaseUnit", header: "وحدة الأساس", map: (r) => yesNo(r.isBaseUnit) },
                { key: "isStoreSaleUnit", header: "وحدة بيع المتجر", map: (r) => yesNo(r.isStoreSaleUnit) },
                { key: "unitIsActive", header: "حالة الوحدة", map: (r) => r.unitIsActive == null ? "" : r.unitIsActive ? "مفعّلة" : "معطّلة" },
                { key: "unitCreatedAt", header: "إنشاء الوحدة", map: (r) => fmtDateTime(r.unitCreatedAt) },
                { key: "barcode", header: "الباركود" },
                { key: "barcodeAliases", header: "بدائل الباركود", map: (r) => (r.barcodeAliases ?? []).join("، ") },
                { key: "price", header: "سعر المفرد", money: true, map: (r) => (r.price != null ? Number(r.price) : "") },
                ...(isElevated
                  ? [
                      { key: "baseCostPrice" as const, header: "كلفة الوحدة", money: true, map: (r: Row) => r.baseCostPrice != null ? Number(r.baseCostPrice) : "" },
                      { key: "costPrice" as const, header: "تكلفة وحدة الصف", money: true, map: (r: Row) => r.costPrice != null ? Number(r.costPrice) : "" },
                      { key: "wholesalePrice" as const, header: "سعر الجملة", money: true, map: (r: Row) => r.wholesalePrice != null ? Number(r.wholesalePrice) : "" },
                      { key: "governmentPrice" as const, header: "السعر الحكومي", money: true, map: (r: Row) => r.governmentPrice != null ? Number(r.governmentPrice) : "" },
                    ]
                  : []),
                { key: "branchId", header: "معرّف فرع المخزون", map: (r) => r.branchId },
                { key: "stockBase", header: "الرصيد الفعلي بوحدة الأساس", map: (r) => Number(r.stockBase ?? 0) },
                { key: "reservedBase", header: "المحجوز والمخصص بوحدة الأساس", map: (r) => Number(r.reservedBase ?? 0) },
                { key: "availableBase", header: "المتاح للبيع بوحدة الأساس", map: (r) => Number(r.availableBase ?? 0) },
              ],
            }}
            onImport={isElevated ? () => setImportOpen(true) : undefined}
            importLabel="استيراد Excel"
            add={{ href: "/products/new", label: "إضافة منتج" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 w-8">
                  <input
                    type="checkbox"
                    className="size-4"
                    aria-label="تحديد كل الصفوف"
                    checked={rows.length > 0 && rows.every((r) => sel.isSelected(rowKey(r)))}
                    onChange={(e) => sel.setMany(rows.map(rowKey), e.target.checked)}
                  />
                </th>
                <th className="p-2">المنتج</th>
                <th className="p-2">الفئة</th>
                <th className="p-2">المتغيّر</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2">الباركود</th>
                <th className="p-2 text-right">السعر (مفرد)</th>
                {isElevated && <th className="p-2 text-right">التكلفة</th>}
                {isElevated && <th className="p-2 text-right">سعر الجملة</th>}
                <th className="p-2 text-right">الرصيد الفعلي</th>
                <th className="p-2 text-right">المحجوز والمخصص</th>
                <th className="p-2 text-right">المتاح للبيع</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: Row) => {
                const dimmed = !r.productIsActive || r.variantIsActive === false || r.unitIsActive === false;
                const key = rowKey(r);
                const fr = rowProps(r.productId);
                return (
                  <tr
                    key={key}
                    ref={fr.ref}
                    className={`border-t ${dimmed ? "opacity-60" : ""} ${fr.className}`}
                  >
                    <td className="p-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`تحديد ${r.productName}`}
                        checked={sel.isSelected(key)}
                        onChange={() => sel.toggle(key)}
                      />
                    </td>
                    <td className="p-2 font-medium">{r.productName}</td>
                    <td className="p-2 text-muted-foreground">{r.categoryName ?? "—"}</td>
                    <td className="p-2 text-muted-foreground">{r.variantName ?? r.color ?? r.sku ?? "—"}</td>
                    <td className="p-2">{r.unitName ?? "—"}</td>
                    <td className="p-2">
                      <CopyInline value={r.barcode ?? ""} />
                      {(r.barcodeAliases?.length ?? 0) > 0 && (
                        <span
                          className="ms-1 text-xs text-muted-foreground whitespace-nowrap"
                          title={`بدائل: ${r.barcodeAliases.join("، ")}`}
                        >
                          +{r.barcodeAliases.length} بديل
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {fmtAr(r.price)}
                    </td>
                    {isElevated && (
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {fmtAr(r.costPrice)}
                      </td>
                    )}
                    {isElevated && (
                      <td className="p-2 text-right tabular-nums" dir="ltr">
                        {fmtAr(r.wholesalePrice)}
                      </td>
                    )}
                    <td className="p-2 text-right tabular-nums" dir="ltr">{r.stockBase}</td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">{r.reservedBase}</td>
                    <td className="p-2 text-right tabular-nums font-medium" dir="ltr">{r.availableBase}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.productIsActive ? "badge-status-active" : "badge-stock-out"}`}>
                        {r.productIsActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٤ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً */}
                      <RowActions
                        actions={[
                          {
                            key: "edit",
                            kind: "edit",
                            label: "تعديل",
                            href: `/products/${r.productId}/edit`,
                            gate: { roles: ["manager"], module: "products", level: "FULL" },
                          },
                          {
                            key: "label",
                            kind: "print",
                            label: "طباعة ملصق باركود",
                            hidden: !r.barcode, // بلا باركود = لا ملصق (Code128 يحتاج قيمة)
                            onSelect: () =>
                              void printLabel([
                                {
                                  name: r.variantName ? `${r.productName} — ${r.variantName}` : r.productName,
                                  sku: r.sku ?? "",
                                  price: r.price,
                                  barcode: r.barcode ?? "",
                                },
                              ]),
                            gate: { module: "products", level: "READ" },
                          },
                          {
                            key: "moves",
                            kind: "view",
                            label: "حركات المنتج",
                            hidden: !r.sku,
                            // شاشة الحركات تقرأ ?q= من URL (نمط CustomerStatement) فتفتح مفلترة على SKU.
                            href: `/inventory-movements?q=${encodeURIComponent(r.sku ?? "")}`,
                            gate: { module: "inventory", level: "READ" },
                          },
                          {
                            key: "toggle",
                            kind: "approve",
                            label: r.productIsActive ? "تعطيل" : "تفعيل",
                            variant: r.productIsActive ? "destructive" : "default",
                            disabled: setActive.isPending,
                            disabledReason: "توجد عملية تحديث قيد التنفيذ",
                            onSelect: () => void toggle(r.productId, r.productIsActive, r.productName),
                            gate: { roles: ["manager"], module: "products", level: "FULL" },
                          },
                          {
                            key: "delete",
                            kind: "delete",
                            label: "حذف نهائي",
                            variant: "destructive",
                            onSelect: () => setDeleteFor({ productId: r.productId, name: r.productName }),
                            gate: { roles: ["manager"], module: "products", level: "FULL" },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && (
                <TableEmptyRow colSpan={isElevated ? 12 : 10} message="لا منتجات مطابقة. غيّر البحث أو أضف منتجاً." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={() => void copySelectedAsTSV()}
        onPrint={printSelectedLabels}
        exportLabel="نَسخ TSV"
        printLabel="طِباعة مُلصَقات"
        actions={
          <Button variant="outline" size="sm" onClick={openMove}>
            نقل إلى فئة
          </Button>
        }
      />

      {/* نقل المنتجات المحدَّدة إلى فئة */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>نقل المنتجات إلى فئة</DialogTitle>
            <DialogDescription>
              ستُنقل {selectedProductIds().length.toLocaleString("ar-IQ-u-nu-latn")} منتجاً (من الصفحة الحالية) إلى الفئة المختارة.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label className="text-sm font-medium">الفئة الهدف</label>
            <select
              value={moveTo == null ? "" : String(moveTo)}
              onChange={(e) => setMoveTo(e.target.value === "" ? null : Number(e.target.value))}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            >
              <option value="">— بلا فئة —</option>
              <CategoryOptionList categories={categoriesQ.data ?? []} />
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMoveOpen(false)}>إلغاء</Button>
            <Button size="sm" onClick={confirmMove} disabled={reassignMut.isPending}>
              {reassignMut.isPending ? "جارٍ النقل…" : "نقل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ← السابق
          </Button>
          <div className="text-muted-foreground">صفحة {page + 1} من {pages}</div>
          <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            التالي →
          </Button>
        </div>
      )}

      <DeleteProductDialog
        target={deleteFor}
        onClose={() => setDeleteFor(null)}
        onDone={() => { utils.catalog.adminList.invalidate(); utils.catalog.posList.invalidate(); }}
      />
    </div>
  );
}

/**
 * حوار الحذف النهائي — يقرأ ملخّص ارتباطات المنتج (`catalog.usage`) عند الفتح ويعرضه عبر
 * UsagePanel؛ زرّ الحذف معطَّل حتى «نظيف». البديل الآمن القابل للتراجع: «تعطيل» من قائمة الإجراءات.
 */
function DeleteProductDialog({
  target,
  onClose,
  onDone,
}: {
  target: { productId: number; name: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const usage = trpc.catalog.usage.useQuery({ productId: target?.productId ?? 0 }, { enabled: !!target });
  const del = trpc.catalog.delete.useMutation({
    onSuccess: () => {
      notify.ok("حُذف المنتج نهائياً");
      void utils.catalog.usage.invalidate();
      onDone();
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">حذف نهائي: {target?.name}</DialogTitle>
          <DialogDescription>
            حذفٌ لا يمكن التراجع عنه — متاح فقط لمنتج «نظيف» بلا أيّ حركة مخزون أو فاتورة أو أمر شراء/شغل
            أو جرد أو ارتباط آخر. البديل الآمن القابل للتراجع: «تعطيل» من قائمة الإجراءات.
          </DialogDescription>
        </DialogHeader>
        <UsagePanel usage={usage.data} cleanText="لا نشاط مسجّل — نظيف، يمكن حذفه نهائياً." />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>إلغاء</Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={usage.isLoading || !usage.data?.clean || del.isPending}
            onClick={() => target && del.mutate({ productId: target.productId })}
          >
            {del.isPending ? "جارٍ الحذف…" : "حذف نهائياً"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
