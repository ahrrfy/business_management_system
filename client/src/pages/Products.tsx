import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { exportRows } from "@/lib/export";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

export default function Products() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const rows = trpc.catalog.posList.useQuery({ branchId, tier: "RETAIL", limit: 500 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">المنتجات</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!rows.data?.length}
            onClick={() =>
              exportRows(rows.data ?? [], {
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
            }
          >
            تصدير Excel
          </Button>
          <Link href="/products/new"><Button>+ إضافة منتج</Button></Link>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">عرض الأصناف بوحداتها وأسعارها ومخزونها، وإضافة منتجات جديدة.</p>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">المنتج</th>
                <th className="p-2">المتغيّر</th>
                <th className="p-2">الوحدة</th>
                <th className="p-2">الباركود</th>
                <th className="p-2 text-left">السعر (مفرد)</th>
                <th className="p-2 text-center">المخزون</th>
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((r) => (
                <tr key={r.productUnitId} className="border-t">
                  <td className="p-2">{r.productName}</td>
                  <td className="p-2 text-muted-foreground">{r.variantName ?? r.color ?? r.sku}</td>
                  <td className="p-2">{r.unitName}</td>
                  <td className="p-2 font-mono text-xs" dir="ltr">{r.barcode ?? "—"}</td>
                  <td className="p-2 text-left">{r.price ?? "—"}</td>
                  <td className="p-2 text-center">{r.stockBase}</td>
                  <td className="p-2 text-center">
                    <Link href={`/products/${r.productId}/edit`}>
                      <Button variant="outline" size="sm">تعديل</Button>
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">لا منتجات.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
