// gstack B12 (٧/٧/٢٦): تبويب/قسم تعديل وصفة البكج داخل ProductEdit — كان endpoints
// `bundles.setComponents/getComponents/previewImpact/searchComponents` موجودة بلا مستهلك.
// يعرض المكوّنات الحاليّة + زر حذف + منتقي بحث لإضافة مكوّن + تنبيه أثر التعديل.
import { AlertTriangle, Plus, Save, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { trpc } from "@/lib/trpc";

type Component = {
  componentVariantId: number;
  componentBaseQuantity: number;
  productName?: string;
  sku?: string;
};

export default function BundleRecipeCard({ bundleVariantId }: { bundleVariantId: number }) {
  const utils = trpc.useUtils();
  const compQ = trpc.bundles.getComponents.useQuery({ bundleVariantId });
  const impactQ = trpc.bundles.previewImpact.useQuery({ bundleVariantId });

  const [editing, setEditing] = useState<Component[] | null>(null);
  const [picker, setPicker] = useState("");
  const [error, setError] = useState("");

  const rows = useMemo<Component[]>(() => {
    if (editing) return editing;
    return (compQ.data?.components ?? []).map((c) => ({
      componentVariantId: c.componentVariantId,
      componentBaseQuantity: c.componentBaseQuantity,
      productName: c.componentProductName,
      sku: c.componentSku,
    }));
  }, [editing, compQ.data]);

  const pickerDeb = useDebouncedValue(picker, 300);
  const searchQ = trpc.bundles.searchComponents.useQuery(
    { q: pickerDeb, limit: 20 },
    { enabled: !!editing && pickerDeb.trim().length >= 2, staleTime: 5_000 },
  );

  const setMut = trpc.bundles.setComponents.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.bundles.getComponents.invalidate(), utils.bundles.previewImpact.invalidate()]);
      setEditing(null);
      setPicker("");
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  function startEdit() {
    setEditing(rows.map((r) => ({ ...r })));
    setError("");
  }
  function cancelEdit() {
    setEditing(null);
    setPicker("");
    setError("");
  }
  function updateQty(vid: number, qty: number) {
    setEditing((prev) => (prev ?? []).map((r) => (r.componentVariantId === vid ? { ...r, componentBaseQuantity: Math.max(1, Math.trunc(qty)) } : r)));
  }
  function removeRow(vid: number) {
    setEditing((prev) => (prev ?? []).filter((r) => r.componentVariantId !== vid));
  }
  function addRow(vid: number, name: string, sku: string) {
    if ((editing ?? []).some((r) => r.componentVariantId === vid)) return;
    setEditing((prev) => [...(prev ?? []), { componentVariantId: vid, componentBaseQuantity: 1, productName: name, sku }]);
    setPicker("");
  }
  function save() {
    if (!editing || !editing.length) {
      setError("البكج يحتاج مكوّناً واحداً على الأقلّ.");
      return;
    }
    setMut.mutate({
      bundleVariantId,
      components: editing.map((r) => ({ componentVariantId: r.componentVariantId, componentBaseQuantity: r.componentBaseQuantity })),
    });
  }

  const affected = impactQ.data?.affectedInvoiceLineCount ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">وصفة البكج ({rows.length} مكوّن)</CardTitle>
        {!editing ? (
          <Button size="sm" variant="outline" onClick={startEdit}>تعديل الوصفة</Button>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={cancelEdit}>إلغاء</Button>
            <Button size="sm" onClick={save} disabled={setMut.isPending}>
              <Save aria-hidden className="size-4" />
              {setMut.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {editing && affected > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm flex items-start gap-2">
            <AlertTriangle aria-hidden className="size-4 mt-0.5 shrink-0 text-amber-600" />
            <div>
              <strong>تنبيه:</strong> يوجد <Badge variant="secondary">{affected}</Badge> بند فاتورة قابل للإرجاع يستعمل هذا البكج.
              الفواتير التي بيعت قبل ٧/٧/٢٦ (بلا لقطة) لن تُرجَع آلياً بعد التعديل — أرجع مكوّناتها فرادى.
            </div>
          </div>
        )}
        {rows.length === 0 && !editing && (
          <div className="text-sm text-muted-foreground py-4 text-center">لا مكوّنات — اضغط «تعديل الوصفة» لإضافة.</div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">المكوّن</th>
                  <th className="px-3 py-2 text-right font-medium">SKU</th>
                  <th className="px-3 py-2 text-right font-medium">الكميّة (بالوحدة الأساس)</th>
                  {editing && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.componentVariantId} className="border-t">
                    <td className="px-3 py-2">{r.productName ?? `#${r.componentVariantId}`}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.sku ?? "—"}</td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={r.componentBaseQuantity}
                          onChange={(e) => updateQty(r.componentVariantId, parseInt(e.target.value || "1", 10))}
                          className="w-24"
                        />
                      ) : (
                        <span>{r.componentBaseQuantity}</span>
                      )}
                    </td>
                    {editing && (
                      <td className="px-3 py-2 text-left">
                        <Button variant="ghost" size="icon" onClick={() => removeRow(r.componentVariantId)} aria-label="حذف">
                          <X aria-hidden className="size-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editing && (
          <div className="pt-2 border-t space-y-2">
            <div className="text-sm font-medium">إضافة مكوّن جديد</div>
            <div className="relative">
              <Input value={picker} onChange={(e) => setPicker(e.target.value)} placeholder="ابحث عن منتج بضاعة مفرد (≥ حرفَين)" />
              {picker.trim().length >= 2 && (searchQ.data?.items ?? []).length > 0 && (
                <div className="absolute z-10 mt-1 w-full max-h-64 overflow-auto rounded-md border bg-popover shadow-md">
                  {(searchQ.data?.items ?? []).map((r) => (
                    <button
                      key={r.variantId}
                      type="button"
                      onClick={() => addRow(r.variantId, r.productName, r.sku ?? "")}
                      className="w-full text-right px-3 py-2 hover:bg-accent focus:bg-accent text-sm flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{r.productName}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{r.sku}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setPicker("")}>
              <Plus aria-hidden className="size-4" />
              زر إغلاق البحث
            </Button>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-50 dark:bg-red-950/40 p-2 text-sm">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
