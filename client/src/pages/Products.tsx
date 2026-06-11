import { DataTable } from "@/components/data-table/DataTable";
import { ImportDialog } from "@/components/import/ImportDialog";
import { RowActions } from "@/components/list";
import { Button } from "@/components/ui/button";
import { exportRows } from "@/lib/export";
import { PRODUCT_FIELDS } from "@/lib/importFields";
import type { ProductImportRow } from "@/lib/importTypes";
import { notify } from "@/lib/notify";
import { printBarcodeSheet } from "@/lib/printing/printTemplates";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Link } from "wouter";

type Row = RouterOutputs["catalog"]["posList"][number];

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "productName", header: "المنتج" },
  {
    id: "variant",
    header: "المتغيّر",
    accessorFn: (r) => r.variantName ?? r.color ?? r.sku ?? "",
    cell: (c) => <span className="text-muted-foreground">{String(c.getValue() ?? "—")}</span>,
  },
  { accessorKey: "unitName", header: "الوحدة" },
  {
    accessorKey: "barcode",
    header: "الباركود",
    cell: (c) => <span className="font-mono text-xs" dir="ltr">{(c.getValue() as string) ?? "—"}</span>,
  },
  {
    accessorKey: "price",
    header: "السعر (مفرد)",
    cell: (c) => {
      const v = c.getValue() as number | null;
      return <span className="tabular-nums" dir="ltr">{v != null ? Number(v).toLocaleString("ar-IQ-u-nu-latn") : "—"}</span>;
    },
  },
  {
    accessorKey: "stockBase",
    header: "المخزون",
    cell: (c) => <span className="tabular-nums" dir="ltr">{Number(c.getValue() ?? 0)}</span>,
  },
  {
    id: "action",
    header: "إجراء",
    enableSorting: false,
    cell: (c) => {
      const r = c.row.original;
      return (
        <RowActions
          actions={[
            { key: "edit", label: "تعديل", href: `/products/${r.productId}/edit` },
            {
              key: "label",
              label: "طباعة ملصق باركود",
              hidden: !r.barcode, // بلا باركود = لا ملصق (Code128 يحتاج قيمة)
              onSelect: () =>
                printBarcodeSheet([
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
              label: "حركات الصنف",
              hidden: !r.sku,
              // شاشة الحركات تقرأ ?q= من URL (نمط CustomerStatement) فتفتح مفلترة على SKU.
              href: `/inventory-movements?q=${encodeURIComponent(r.sku ?? "")}`,
            },
          ]}
        />
      );
    },
  },
];

export default function Products() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const rows = trpc.catalog.posList.useQuery({ branchId, tier: "RETAIL", limit: 500 });
  const data = rows.data ?? [];
  const [importOpen, setImportOpen] = useState(false);
  const importMut = trpc.imports.products.useMutation();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">المنتجات</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>استيراد Excel</Button>
          <Link href="/products/new"><Button>+ إضافة منتج</Button></Link>
        </div>
      </div>

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
            utils.catalog.posList.invalidate();
          }
        }}
      />
      <p className="text-sm text-muted-foreground">عرض الأصناف بوحداتها وأسعارها ومخزونها — مع فرز بنقرة وبحث فوري وتصدير.</p>
      <DataTable
        columns={columns}
        data={data}
        searchPlaceholder="بحث في المنتجات…"
        emptyText={rows.isLoading ? "جارٍ التحميل…" : "لا منتجات."}
        toolbar={
          <Button variant="outline" size="sm" disabled={!data.length}
            onClick={() =>
              exportRows(data, {
                filename: "المنتجات",
                columns: [
                  { key: "productName", header: "المنتج" },
                  { key: "variantName", header: "المتغيّر", map: (r) => r.variantName ?? r.color ?? r.sku },
                  { key: "unitName", header: "الوحدة" },
                  { key: "barcode", header: "الباركود" },
                  { key: "price", header: "السعر (مفرد)", map: (r) => (r.price != null ? Number(r.price) : "") },
                  { key: "stockBase", header: "المخزون", map: (r) => Number(r.stockBase ?? 0) },
                ],
              })
            }>
            تصدير Excel
          </Button>
        }
      />
    </div>
  );
}
