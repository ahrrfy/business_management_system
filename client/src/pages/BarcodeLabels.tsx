import { CopyInline } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { code128Svg, internalBarcode } from "@/lib/printing/barcode";
import { printBarcodeSheet } from "@/lib/printing/printTemplates";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useState } from "react";
import { Link } from "wouter";

type PosRow = RouterOutputs["catalog"]["posList"][number];
type QueueItem = {
  key: number;
  productUnitId: number;
  productName: string;
  unitName: string;
  sku: string;
  barcode: string; // قد يكون مولّداً داخلياً
  price: string | null;
  saved: boolean; // هل الباركود محفوظ في القاعدة؟
  count: number;
};

const money = (s: string | number) => Number(s).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });

export default function BarcodeLabels() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId ?? 1;
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [seq, setSeq] = useState(1);
  const [showName, setShowName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [error, setError] = useState("");

  const results = trpc.catalog.posList.useQuery(
    { branchId, tier: "RETAIL", query: search, limit: 12 },
    { enabled: search.trim().length > 0 }
  );

  const assign = trpc.catalog.assignBarcode.useMutation({
    onError: (e) => setError(e.message),
  });

  function addRow(row: PosRow) {
    setError("");
    setQueue((prev) => {
      if (prev.some((q) => q.productUnitId === row.productUnitId)) return prev;
      const hasBarcode = !!row.barcode;
      return [
        ...prev,
        {
          key: seq,
          productUnitId: row.productUnitId,
          productName: row.productName,
          unitName: row.unitName,
          sku: row.sku,
          barcode: row.barcode ?? internalBarcode(row.productUnitId),
          price: row.price,
          saved: hasBarcode,
          count: 1,
        },
      ];
    });
    setSeq((s) => s + 1);
    setSearch("");
  }

  const patch = (key: number, p: Partial<QueueItem>) =>
    setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, ...p } : q)));
  const remove = (key: number) => setQueue((prev) => prev.filter((q) => q.key !== key));

  async function saveBarcode(item: QueueItem) {
    setError("");
    try {
      await assign.mutateAsync({ productUnitId: item.productUnitId, barcode: item.barcode });
      patch(item.key, { saved: true });
      await Promise.all([utils.catalog.posList.invalidate(), utils.catalog.byBarcode.invalidate()]);
    } catch {
      /* الخطأ يُعرض عبر onError */
    }
  }

  function printLabels() {
    setError("");
    if (!queue.length) { setError("أضِف صنفاً واحداً على الأقل."); return; }
    const expanded = queue.flatMap(item =>
      Array.from({ length: item.count }, () => ({
        name: `${item.productName}${showName ? ` — ${item.unitName}` : ""}`,
        sku: item.sku,
        price: showPrice && item.price != null ? item.price : "",
        barcode: item.barcode,
      }))
    );
    printBarcodeSheet(expanded);
  }

  const totalLabels = queue.reduce((s, q) => s + q.count, 0);

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">طباعة ملصقات الباركود</h1>
        <Link href="/products" className="text-sm text-muted-foreground">المنتجات ←</Link>
      </div>
      <p className="text-sm text-muted-foreground">
        ابحث عن صنف وأضفه. للأصناف بلا باركود مصنّعي يُولَّد باركود داخلي (ALR…) — احفظه ليصبح قابلاً للمسح في الكاشير، ثم اطبع الملصقات.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">إضافة أصناف</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث بالاسم/SKU/الباركود…" />
            {search.trim() && (results.data?.length ?? 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-popover border rounded-md shadow max-h-72 overflow-auto">
                {results.data!.map((row) => (
                  <button
                    key={row.productUnitId}
                    className="block w-full text-right px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => addRow(row)}
                  >
                    {row.productName} <span className="text-muted-foreground">({row.unitName})</span>
                    <span className="text-xs text-muted-foreground font-mono" dir="ltr"> — {row.sku}{row.barcode ? ` · ${row.barcode}` : " · بلا باركود"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> اسم الصنف</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> السعر</label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">قائمة الطباعة ({totalLabels} ملصق)</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-right">
                <th className="p-2">الصنف</th>
                <th className="p-2">الباركود</th>
                <th className="p-2 text-left">السعر</th>
                <th className="p-2 w-24 text-center">عدد الملصقات</th>
                <th className="p-2 text-center">معاينة</th>
                <th className="p-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((q) => {
                let preview = "";
                try {
                  preview = code128Svg(q.barcode, { moduleWidth: 1.4, height: 34, showText: false }).svg;
                } catch {
                  preview = "";
                }
                return (
                  <tr key={q.key} className="border-t align-middle">
                    <td className="p-2">{q.productName}<span className="text-muted-foreground"> — {q.unitName}</span></td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <CopyInline value={q.barcode} />
                        {!q.saved && (
                          <Button variant="outline" size="sm" disabled={assign.isPending} onClick={() => saveBarcode(q)}>
                            حفظ الباركود
                          </Button>
                        )}
                        {q.saved && <span className="text-xs text-emerald-600">محفوظ ✓</span>}
                      </div>
                    </td>
                    <td className="p-2 text-left tabular-nums" dir="ltr">{q.price != null ? money(q.price) : "—"}</td>
                    <td className="p-2">
                      <Input dir="ltr" className="h-8 text-center" value={String(q.count)}
                        onChange={(e) => patch(q.key, { count: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })} />
                    </td>
                    <td className="p-2 text-center" dangerouslySetInnerHTML={{ __html: preview }} />
                    <td className="p-2 text-center"><Button variant="ghost" size="sm" onClick={() => remove(q.key)}>✕</Button></td>
                  </tr>
                );
              })}
              {queue.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">ابحث أعلاه لإضافة أصناف للطباعة.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={printLabels} disabled={queue.length === 0}>طباعة {totalLabels} ملصق</Button>
        <Button variant="outline" onClick={() => setQueue([])} disabled={queue.length === 0}>تفريغ القائمة</Button>
      </div>
    </div>
  );
}

