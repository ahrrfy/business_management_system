/**
 * StoreCatalog — «الكتالوج والعرض» في لوحة hPanel (تبويب مديري).
 * مركز تحكّم واحد بعرض منتجات المتجر: تمييز منتج (يتصدّر)، إظهار/إخفاء من واجهة الزبون،
 * ضبط المخزون (ذرّي عبر قيد ADJUST)، وتعيين صورة المنتج الرئيسية. المخزون/الصورة/الأعلام
 * كلّها تنعكس فوراً في المتجر العلني `/store`.
 */
import { useState } from "react";
import { Boxes, Check, Eye, EyeOff, ImagePlus, Loader2, PackageSearch, Save, Search, Star, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt, fmtInt } from "@/lib/money";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";

type Filter = "all" | "featured" | "hidden" | "noImage";
const PAGE = 40;

export default function StoreCatalog() {
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [stockFor, setStockFor] = useState<{ productId: number; variantId: number; name: string; stockBase: number } | null>(null);
  const [imageFor, setImageFor] = useState<{ productId: number; name: string; imageUrl: string | null } | null>(null);

  const utils = trpc.useUtils();
  const catsQ = trpc.storeAdmin.categories.list.useQuery();
  const listQ = trpc.storeAdmin.catalog.list.useQuery({
    q: q.trim() || undefined,
    categoryId: categoryId === "" ? undefined : Number(categoryId),
    featuredOnly: filter === "featured" || undefined,
    hiddenOnly: filter === "hidden" || undefined,
    missingImageOnly: filter === "noImage" || undefined,
    limit,
  });

  const invalidate = () => void utils.storeAdmin.catalog.list.invalidate();
  const featM = trpc.storeAdmin.catalog.setFeatured.useMutation({ onSuccess: invalidate, onError: (e) => notify.err(e) });
  const visM = trpc.storeAdmin.catalog.setVisible.useMutation({ onSuccess: invalidate, onError: (e) => notify.err(e) });

  const rows = listQ.data?.rows ?? [];
  const total = listQ.data?.total ?? 0;
  const cats = catsQ.data ?? [];

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "الكل" },
    { key: "featured", label: "المميّزة" },
    { key: "hidden", label: "المخفيّة" },
    { key: "noImage", label: "بلا صورة" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Boxes aria-hidden className="size-5 text-primary" /> الكتالوج والعرض</h2>
        <span className="text-xs text-muted-foreground">
          {fmtInt(total)} منتج بالكتالوج (يشمل المعطّل/المخفيّ) · <span className="font-bold text-foreground">{fmtInt(listQ.data?.sellableTotal ?? 0)}</span> ظاهر فعلياً للزبون في المتجر
        </span>
      </div>

      {/* شريط الفلترة */}
      <div className="space-y-2 rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="ابحث عن منتج بالاسم…" className="w-full rounded-lg border border-border bg-background py-2 pr-10 pl-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value === "" ? "" : Number(e.target.value)); setLimit(PAGE); }} className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 sm:w-52">
            <option value="">كل الأقسام</option>
            <option value="0">بلا قسم</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((ch) => (
            <button key={ch.key} onClick={() => { setFilter(ch.key); setLimit(PAGE); }} className={`rounded-full px-3 py-1 text-xs font-bold transition ${filter === ch.key ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-accent"}`}>
              {ch.label}
            </button>
          ))}
        </div>
      </div>

      {/* القائمة */}
      {listQ.isLoading ? (
        <div className="flex justify-center py-16 text-muted-foreground"><Loader2 aria-hidden className="size-6 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <PackageSearch aria-hidden className="mx-auto mb-2 size-8 opacity-40" />
          لا منتجات مطابقة. جرّب تغيير الفلتر أو البحث.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => {
            const stockLow = p.stockBase <= 0;
            return (
              <div key={p.productId} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                {/* صورة */}
                <button onClick={() => setImageFor({ productId: p.productId, name: p.name, imageUrl: p.imageUrl })} title="تعيين الصورة" className="group relative size-16 shrink-0 overflow-hidden rounded-xl bg-muted">
                  {p.imageUrl
                    ? <img src={p.imageUrl} alt={p.name} className="size-full object-cover" />
                    : <span className="flex size-full items-center justify-center text-muted-foreground"><ImagePlus aria-hidden className="size-6 opacity-40" /></span>}
                  <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-white group-hover:flex"><ImagePlus aria-hidden className="size-5" /></span>
                </button>

                {/* تفاصيل */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-bold">{p.name}</p>
                    {p.isFeatured && <span className="flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"><Star aria-hidden className="size-2.5" /> مميّز</span>}
                    {!p.showInStore && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">مخفيّ</span>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {p.categoryName ?? "بلا قسم"}
                    {p.retailPrice != null && <> · <span className="font-medium tabular-nums text-foreground">{fmt(p.retailPrice)}</span> د.ع</>}
                  </p>
                  <button onClick={() => p.variantId && setStockFor({ productId: p.productId, variantId: p.variantId, name: p.name, stockBase: p.stockBase })} disabled={!p.variantId} className={`mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${stockLow ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                    <Boxes aria-hidden className="size-3" /> المخزون: {fmtInt(p.stockBase)}{stockLow && " — نافد"}
                  </button>
                </div>

                {/* أزرار */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <button onClick={() => featM.mutate({ productId: p.productId, isFeatured: !p.isFeatured })} disabled={featM.isPending} title={p.isFeatured ? "إلغاء التمييز" : "تمييز (يتصدّر العرض)"} aria-label="تمييز" className={`flex size-9 items-center justify-center rounded-lg border border-border transition hover:bg-accent disabled:opacity-50 ${p.isFeatured ? "text-amber-500" : "text-muted-foreground"}`}>
                    <Star aria-hidden className={`size-4 ${p.isFeatured ? "fill-amber-400" : ""}`} />
                  </button>
                  <button onClick={() => visM.mutate({ productId: p.productId, showInStore: !p.showInStore })} disabled={visM.isPending} title={p.showInStore ? "إخفاء من المتجر" : "إظهار في المتجر"} aria-label="إظهار/إخفاء" className={`flex size-9 items-center justify-center rounded-lg border border-border transition hover:bg-accent disabled:opacity-50 ${p.showInStore ? "text-emerald-600" : "text-muted-foreground"}`}>
                    {p.showInStore ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
                  </button>
                </div>
              </div>
            );
          })}

          {rows.length < total && (
            <button onClick={() => setLimit((n) => n + PAGE)} disabled={listQ.isFetching} className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card py-3 text-sm font-bold text-muted-foreground transition hover:bg-accent disabled:opacity-50">
              {listQ.isFetching ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null} عرض المزيد ({total - rows.length} متبقٍّ)
            </button>
          )}
        </div>
      )}

      {stockFor && <StockDialog target={stockFor} onClose={() => setStockFor(null)} onDone={invalidate} />}
      {imageFor && <ImageDialog target={imageFor} onClose={() => setImageFor(null)} onDone={invalidate} />}
    </div>
  );
}

/** حوار ضبط مخزون المنتج إلى كميةٍ مستهدفة (ذرّي — قيد ADJUST على الخادم). */
function StockDialog({ target, onClose, onDone }: { target: { variantId: number; name: string; stockBase: number }; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState(String(target.stockBase));
  const setM = trpc.storeAdmin.catalog.setStock.useMutation({
    onSuccess: () => { notify.ok("حُدّث المخزون"); onDone(); onClose(); },
    onError: (e) => notify.err(e),
  });
  const n = Number(qty);
  const invalid = !Number.isInteger(n) || n < 0;

  return (
    <Modal title={`مخزون: ${target.name}`} onClose={onClose}>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-muted-foreground">الكمية المستهدفة (بالوحدة الأساس)</span>
        <input type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus className="w-full rounded-lg border border-border bg-background px-3 py-2 text-lg font-bold tabular-nums outline-none focus:ring-2 focus:ring-primary/30" />
      </label>
      <p className="mt-1 text-[11px] text-muted-foreground">الحالي: {fmtInt(target.stockBase)} — يُسجَّل الفرق كتسوية مخزون (قيد محاسبي ذرّي).</p>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-accent">إلغاء</button>
        <button onClick={() => setM.mutate({ variantId: target.variantId, targetQuantity: n })} disabled={invalid || setM.isPending} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
          {setM.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />} حفظ
        </button>
      </div>
    </Modal>
  );
}

/** حوار تعيين/إزالة صورة المنتج الرئيسية (تُضغط في العميل، تظهر في المتجر). */
function ImageDialog({ target, onClose, onDone }: { target: { productId: number; name: string; imageUrl: string | null }; onClose: () => void; onDone: () => void }) {
  const [images, setImages] = useState<ImageItem[]>(target.imageUrl ? [{ id: "cur", dataUrl: target.imageUrl, isPrimary: true }] : []);
  const setM = trpc.storeAdmin.catalog.setImage.useMutation({
    onSuccess: () => { notify.ok("حُفظت الصورة"); onDone(); onClose(); },
    onError: (e) => notify.err(e),
  });
  const url = images[0]?.dataUrl ?? images[0]?.url ?? null;

  return (
    <Modal title={`صورة: ${target.name}`} onClose={onClose}>
      <ImageUploader value={images} onChange={setImages} maxItems={1} singlePrimary={false} hint="صورة مربّعة واضحة (تُضغط تلقائياً)" />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-accent">إلغاء</button>
        <button onClick={() => setM.mutate({ productId: target.productId, url })} disabled={setM.isPending} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
          {setM.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} حفظ
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl border border-border bg-card p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="truncate text-sm font-bold">{title}</h3>
          <button onClick={onClose} aria-label="إغلاق" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent"><X aria-hidden className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
