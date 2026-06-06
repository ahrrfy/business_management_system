import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

export default function Products() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const rows = trpc.catalog.posList.useQuery({ branchId, tier: "RETAIL", limit: 500 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">المنتجات</h1>
      <p className="text-sm text-muted-foreground">عرض الأصناف بوحداتها وأسعارها ومخزونها. (إضافة/تعديل المنتجات وحدةٌ قادمة.)</p>
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
                </tr>
              ))}
              {rows.data && rows.data.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">لا منتجات.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
