import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Check, GripVertical, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type RelationType = "COMPLETE_KIT" | "COMPATIBLE" | "SAME_THEME" | "UPSELL";
type RelationDraft = { relatedProductId: number; productName: string; relationType: RelationType; sortOrder: number };

const RELATION_LABELS: Record<RelationType, string> = {
  COMPLETE_KIT: "أكمل التجهيز",
  COMPATIBLE: "مستلزم متوافق",
  SAME_THEME: "نفس المناسبة",
  UPSELL: "اختيار أعلى",
};

export function ProductRelatedProductsEditor({ productId }: { productId: number }) {
  const [query, setQuery] = useState("");
  const [relations, setRelations] = useState<RelationDraft[]>([]);
  const relationsQ = trpc.bundles.getRelatedProducts.useQuery({ sourceProductId: productId });
  const searchQ = trpc.bundles.searchComponents.useQuery(
    { q: query.trim(), limit: 20 },
    { enabled: query.trim().length >= 1, staleTime: 30_000 },
  );
  const save = trpc.bundles.setRelatedProducts.useMutation({
    onSuccess: (result) => {
      notify.ok(`تم حفظ ${result.count} علاقة ترويجية.`);
      void relationsQ.refetch();
    },
    onError: (error) => notify.err(error),
  });

  useEffect(() => {
    if (!relationsQ.data) return;
    setRelations(relationsQ.data.items.map((item) => ({
      relatedProductId: item.relatedProductId,
      productName: item.productName,
      relationType: item.relationType as RelationType,
      sortOrder: item.sortOrder,
    })));
  }, [relationsQ.data]);

  const currentIds = useMemo(() => new Set(relations.map((item) => item.relatedProductId)), [relations]);
  const results = (searchQ.data?.items ?? []).filter((item) => item.productId !== productId && !currentIds.has(item.productId));
  const addRelation = (product: { productId: number; productName: string }) => {
    if (product.productId === productId || currentIds.has(product.productId)) return;
    setRelations((previous) => [...previous, {
      relatedProductId: product.productId,
      productName: product.productName,
      relationType: "COMPLETE_KIT",
      sortOrder: previous.length,
    }]);
    setQuery("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><GripVertical className="size-4 text-primary" aria-hidden /> «أكمل تجهيزك» في السلة</CardTitle>
        <p className="text-xs text-muted-foreground">اربط المنتجات المكملة يدوياً. سيعرض المتجر المتاح منها فقط، ولن يغيّر السعر أو المخزون تلقائياً.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="ps-9" placeholder="ابحث باسم المنتج أو SKU لإضافته…" aria-label="بحث عن منتج مكمل" />
        </div>
        {query.trim() && (
          <div className="max-h-48 overflow-y-auto rounded-md border bg-card">
            {searchQ.isLoading ? <p className="p-3 text-xs text-muted-foreground">جارٍ البحث…</p> : results.length ? results.map((item) => (
              <button key={`${item.productId}-${item.variantId}`} type="button" onClick={() => addRelation(item)} className="flex w-full items-center justify-between border-b px-3 py-2 text-start text-xs last:border-0 hover:bg-muted">
                <span><b>{item.productName}</b><span className="ms-2 text-muted-foreground">{item.sku}</span></span>
                <Plus className="size-4 text-primary" aria-hidden />
              </button>
            )) : <p className="p-3 text-xs text-muted-foreground">لا توجد منتجات مؤهلة جديدة.</p>}
          </div>
        )}
        {relations.length ? <div className="space-y-2">
          {relations.map((relation, index) => (
            <div key={relation.relatedProductId} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_10rem_4rem_auto] sm:items-center">
              <div className="flex min-w-0 items-center gap-2 text-sm"><span className="text-muted-foreground">{index + 1}</span><span className="truncate font-medium">{relation.productName}</span></div>
              <select value={relation.relationType} onChange={(event) => setRelations((previous) => previous.map((item) => item.relatedProductId === relation.relatedProductId ? { ...item, relationType: event.target.value as RelationType } : item))} className="h-9 rounded-md border bg-transparent px-2 text-xs" aria-label={`نوع العلاقة ${relation.productName}`}>
                {Object.entries(RELATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <Input type="number" min={0} max={999} value={relation.sortOrder} onChange={(event) => setRelations((previous) => previous.map((item) => item.relatedProductId === relation.relatedProductId ? { ...item, sortOrder: Number(event.target.value) || 0 } : item))} className="h-9 text-xs" aria-label={`ترتيب ${relation.productName}`} />
              <Button type="button" variant="ghost" size="icon" onClick={() => setRelations((previous) => previous.filter((item) => item.relatedProductId !== relation.relatedProductId))} aria-label={`حذف علاقة ${relation.productName}`}><Trash2 className="size-4 text-destructive" aria-hidden /></Button>
            </div>
          ))}
        </div> : <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">لم تتم إضافة علاقات يدوية بعد. سيستخدم المتجر fallback محدوداً من نفس الفئة.</div>}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">تظهر التوصيات في السلة بعنوان «أكمل تجهيزك» وبحد أقصى 4 منتجات متاحة.</p>
          <Button type="button" size="sm" onClick={() => save.mutate({ sourceProductId: productId, items: relations.map(({ relatedProductId, relationType, sortOrder }) => ({ relatedProductId, relationType, sortOrder })) })} disabled={save.isPending || relationsQ.isLoading}>
            {save.isPending ? "جارٍ الحفظ…" : <><Check className="size-4" aria-hidden /> حفظ العلاقات</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
