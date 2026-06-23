// شاشة إدارة المنتجات — قائمة خادمية كاملة (بحث ذكي + تقسيم صفحات + إظهار المعطّل)
// على نمط Customers.tsx. تستبدل posList (INNER JOIN يخفي الناقص + حدّ 500) بـadminList
// التي تعرض كل منتجات المالك (~9413) حتى الناقصة بلا متغيّرات/وحدات.
import { CopyInline } from "@/components/CopyButton";
import { ImportDialog } from "@/components/import/ImportDialog";
import { ListToolbar, RowActions } from "@/components/list";
import { SelectionBar, useRowSelection } from "@/components/list/SelectionBar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { confirm } from "@/lib/confirm";
import { formatTableAsTSV } from "@/lib/copy/formatters";
import { PRODUCT_FIELDS } from "@/lib/importFields";
import type { ProductImportRow } from "@/lib/importTypes";
import { notify } from "@/lib/notify";
import { fmtAr } from "@/lib/money";
import { printLabel } from "@/lib/printing/print";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useState } from "react";

type Row = RouterOutputs["catalog"]["adminList"]["rows"][number];

const limit = 50;

/** مِفتاح فَريد لِكُل صَفّ (مُنتَج × مُتَغَيِّر × وَحدة). */
function rowKey(r: Row): string {
  return `${r.productId}-${r.variantId ?? 0}-${r.productUnitId ?? 0}`;
}

export default function Products() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;

  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const importMut = trpc.imports.products.useMutation();
  const dq = useDebouncedValue(q, 200);
  const sel = useRowSelection<string>();

  const list = trpc.catalog.adminList.useQuery({
    branchId,
    q: dq.trim() || undefined,
    includeInactive,
    limit,
    offset: page * limit,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  const setActive = trpc.catalog.setProductActive.useMutation({
    onSuccess: (res) => {
      utils.catalog.adminList.invalidate();
      utils.catalog.posList.invalidate();
      notify.ok(res.isActive ? "تم تفعيل المنتج" : "تم تعطيل المنتج");
    },
    onError: (e) => notify.err(e),
  });

  /** نَسخ المُحَدَّد كَ‍TSV (باركود/سِعر/مَخزون) — جاهِز لِلَصق في Excel. */
  async function copySelectedAsTSV() {
    const picked = rows.filter((r) => sel.isSelected(rowKey(r)));
    if (picked.length === 0) return;
    const tsv = formatTableAsTSV(
      ["المنتج", "المتغيّر", "الوحدة", "الباركود", "السعر", "المخزون"],
      picked.map((r) => ({
        "المنتج": r.productName,
        "المتغيّر": r.variantName ?? r.color ?? r.sku ?? "",
        "الوحدة": r.unitName ?? "",
        "الباركود": r.barcode ?? "",
        "السعر": r.price != null ? String(r.price) : "",
        "المخزون": r.stockBase ?? 0,
      })),
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
      <h1 className="text-2xl font-bold">المنتجات</h1>

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
      <p className="text-sm text-muted-foreground">عرض المنتجات بوحداتها وأسعارها ومخزونها — مع بحث فوري وتصدير.</p>

      <Card>
        <CardHeader>
          <ListToolbar
            title="القائمة"
            count={total}
            loading={list.isLoading}
            search={{
              value: q,
              onChange: (v) => { setQ(v); setPage(0); },
              placeholder: "بحث (اسم/SKU/باركود)",
            }}
            filters={
              <label className="flex items-center gap-2 h-8 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={includeInactive}
                  onChange={(e) => { setIncludeInactive(e.target.checked); setPage(0); }}
                />
                <span className="text-muted-foreground">إظهار المعطّل</span>
              </label>
            }
            exportSpec={{
              filename: "المنتجات",
              rows,
              columns: [
                { key: "productName", header: "المنتج" },
                { key: "variantName", header: "المتغيّر", map: (r) => r.variantName ?? r.color ?? r.sku ?? "" },
                { key: "unitName", header: "الوحدة" },
                { key: "barcode", header: "الباركود" },
                { key: "price", header: "السعر مفرد", map: (r) => (r.price != null ? Number(r.price) : "") },
                { key: "stockBase", header: "المخزون", map: (r) => Number(r.stockBase ?? 0) },
                { key: "productIsActive", header: "نشط", map: (r) => (r.productIsActive ? "نعم" : "لا") },
              ],
            }}
            onImport={() => setImportOpen(true)}
            importLabel="استيراد Excel"
            add={{ href: "/products/new", label: "إضافة منتج" }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
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
                <th className="p-2">المتغيّر</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2">الباركود</th>
                <th className="p-2 text-left">السعر (مفرد)</th>
                <th className="p-2 text-left">المخزون</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: Row) => {
                const dimmed = !r.productIsActive || r.variantIsActive === false || r.unitIsActive === false;
                const key = rowKey(r);
                return (
                  <tr
                    key={key}
                    className={`border-t ${dimmed ? "opacity-60" : ""}`}
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
                    <td className="p-2 text-muted-foreground">{r.variantName ?? r.color ?? r.sku ?? "—"}</td>
                    <td className="p-2">{r.unitName ?? "—"}</td>
                    <td className="p-2">
                      <CopyInline value={r.barcode ?? ""} />
                    </td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">
                      {fmtAr(r.price)}
                    </td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{r.stockBase}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.productIsActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                        {r.productIsActive ? "مفعّل" : "معطّل"}
                      </span>
                    </td>
                    <td className="p-2 text-center">
                      {/* ٤ إجراءات ⇒ auto يحوّلها لقائمة ⋯ تلقائياً */}
                      <RowActions
                        actions={[
                          { key: "edit", label: "تعديل", href: `/products/${r.productId}/edit` },
                          {
                            key: "label",
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
                          },
                          {
                            key: "moves",
                            label: "حركات المنتج",
                            hidden: !r.sku,
                            // شاشة الحركات تقرأ ?q= من URL (نمط CustomerStatement) فتفتح مفلترة على SKU.
                            href: `/inventory-movements?q=${encodeURIComponent(r.sku ?? "")}`,
                          },
                          {
                            key: "toggle",
                            label: r.productIsActive ? "تعطيل" : "تفعيل",
                            variant: r.productIsActive ? "destructive" : "default",
                            disabled: setActive.isPending,
                            onSelect: () => void toggle(r.productId, r.productIsActive, r.productName),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">لا منتجات مطابقة. غيّر البحث أو أضف منتجاً.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <SelectionBar
        count={sel.count}
        onClear={sel.clear}
        onExport={() => void copySelectedAsTSV()}
        onPrint={printSelectedLabels}
        exportLabel="نَسخ TSV"
        printLabel="طِباعة مُلصَقات"
      />

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
    </div>
  );
}
