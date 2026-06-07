import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { exportRows } from "@/lib/export";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
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
      return <span className="tabular-nums" dir="ltr">{v != null ? Number(v).toLocaleString("ar-IQ") : "—"}</span>;
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
    cell: (c) => (
      <Link href={`/products/${c.row.original.productId}/edit`}>
        <Button variant="outline" size="sm">تعديل</Button>
      </Link>
    ),
  },
];

export default function Products() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const rows = trpc.catalog.posList.useQuery({ branchId, tier: "RETAIL", limit: 500 });
  const data = rows.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">المنتجات</h1>
        <Link href="/products/new"><Button>+ إضافة منتج</Button></Link>
      </div>
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
