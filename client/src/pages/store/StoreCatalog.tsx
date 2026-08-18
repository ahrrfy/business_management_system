/**
 * StoreCatalog — «الكتالوج والعرض» في لوحة hPanel (تبويب مديري).
 * مركز تحكّم واحد بعرض منتجات المتجر: تمييز منتج (يتصدّر)، إظهار/إخفاء من واجهة العميل،
 * ضبط المخزون (ذرّي عبر قيد ADJUST)، وعرض/إزالة الصورة الرئيسية؛ النشر الجديد عبر Product Studio. المخزون/الصورة/الأعلام
 * كلّها تنعكس فوراً في المتجر العلني `/store`.
 */
import { useState } from "react";
import { AlertTriangle, Boxes, Eye, EyeOff, ImagePlus, Images, Loader2, PackageSearch, Save, Search, Star, Trash2, X } from "lucide-react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmt, fmtInt } from "@/lib/money";

type Filter = "all" | "featured" | "hidden" | "noImage";
const PAGE = 40;

const READINESS_LABELS: Record<string, string> = {
  PRODUCT_INACTIVE: "المنتج معطّل",
  SERVICE_PRODUCT: "منتج خدمي",
  PRODUCT_HIDDEN: "مخفي من المتجر",
  CATEGORY_HIDDEN: "الفئة معطّلة أو مخفية من المتجر",
  NO_ACTIVE_VARIANT: "لا متغيّر نشط",
  NO_STORE_SALE_UNIT: "لا وحدة بيع للمتجر",
  NO_RETAIL_PRICE: "لا سعر مفرد",
  INVALID_CONVERSION_FACTOR: "معامل الوحدة غير صالح",
  NO_STOCK_ROW: "لا رصيد مسجّل للفرع",
  NEGATIVE_STOCK: "رصيد سالب",
  OUT_OF_STOCK: "نافد",
  BELOW_SALE_UNIT_FACTOR: "الرصيد أقل من معامل وحدة البيع",
};

export default function StoreCatalog() {
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [stockFor, setStockFor] = useState<{ variantId: number; name: string; stockBase: number } | null>(null);
  const [imageFor, setImageFor] = useState<{ productId: number; name: string; imageUrl: string | null } | null>(null);

  const utils = trpc.useUtils();
  const meQ = trpc.auth.me.useQuery();
  const isAdmin = meQ.data?.role === "admin";
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
          {fmtInt(total)} بالكتالوج · <span className="font-bold text-foreground">{fmtInt(listQ.data?.publishableTotal ?? 0)}</span> منشور · <span className="font-bold text-[var(--sem-pos)]">{fmtInt(listQ.data?.sellableTotal ?? 0)}</span> قابل للشراء الآن
        </span>
      </div>

      {!meQ.isLoading && !isAdmin && (
        <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>يمكنك مراجعة مخزون فرع التنفيذ ورفع طلب تسوية. النشر والإخفاء والصور والتمييز صلاحيات مركزية لمالك النظام.</span>
        </div>
      )}

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
      ) : listQ.isError ? (
        <div className="rounded-2xl border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] px-4 py-8 text-center text-sm text-[var(--sem-neg)]">{listQ.error.message}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          <PackageSearch aria-hidden className="mx-auto mb-2 size-8 opacity-40" />
          لا منتجات مطابقة. جرّب تغيير الفلتر أو البحث.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => {
            return (
              <div key={p.productId} className="rounded-2xl border border-border bg-card p-3">
                <div className="flex items-center gap-3">
                  {/* صورة */}
                  <button onClick={() => { if (isAdmin) setImageFor({ productId: p.productId, name: p.name, imageUrl: p.imageUrl }); }} disabled={!isAdmin} title={isAdmin ? "عرض الصورة أو إزالتها" : "إدارة الصورة لمالك النظام فقط"} className="group relative size-16 shrink-0 overflow-hidden rounded-xl bg-muted disabled:cursor-default">
                    {p.imageUrl
                      ? <img src={p.imageUrl} alt={p.name} className="size-full object-cover" />
                      : <span className="flex size-full items-center justify-center text-muted-foreground"><ImagePlus aria-hidden className="size-6 opacity-40" /></span>}
                    {isAdmin && <span className="absolute inset-0 hidden items-center justify-center bg-black/40 text-white group-hover:flex"><Images aria-hidden className="size-5" /></span>}
                  </button>

                  {/* تفاصيل */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-sm font-bold">{p.name}</p>
                      {p.isFeatured && <span className="flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"><Star aria-hidden className="size-2.5" /> مميّز</span>}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${p.inStock ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : p.publishable ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"}`}>
                        {p.inStock ? "قابل للشراء" : p.publishable ? "منشور — غير متاح" : "غير جاهز للنشر"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {p.categoryName ?? "بلا قسم"}
                      {p.retailPrice != null && <> · <span className="font-medium tabular-nums text-foreground">{fmt(p.retailPrice)}</span> د.ع{p.saleUnitName ? ` / ${p.saleUnitName}` : ""}</>}
                    </p>
                    {p.readinessReasons.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.readinessReasons.map((reason) => <span key={reason} className="inline-flex items-center gap-1 rounded-md bg-[var(--sem-neg-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--sem-neg)]"><AlertTriangle aria-hidden className="size-2.5" />{READINESS_LABELS[reason] ?? reason}</span>)}
                      </div>
                    )}
                  </div>

                  {/* أزرار */}
                  {isAdmin && <div className="flex shrink-0 items-center gap-1.5">
                    <button onClick={() => featM.mutate({ productId: p.productId, isFeatured: !p.isFeatured })} disabled={featM.isPending} title={p.isFeatured ? "إلغاء التمييز" : "تمييز (يتصدّر العرض)"} aria-label="تمييز" className={`flex size-9 items-center justify-center rounded-lg border border-border transition hover:bg-accent disabled:opacity-50 ${p.isFeatured ? "text-amber-500" : "text-muted-foreground"}`}>
                      <Star aria-hidden className={`size-4 ${p.isFeatured ? "fill-amber-400" : ""}`} />
                    </button>
                    <button onClick={() => visM.mutate({ productId: p.productId, showInStore: !p.showInStore })} disabled={visM.isPending} title={p.showInStore ? "إخفاء من المتجر" : "إظهار في المتجر"} aria-label="إظهار/إخفاء" className={`flex size-9 items-center justify-center rounded-lg border border-border transition hover:bg-accent disabled:opacity-50 ${p.showInStore ? "text-emerald-600" : "text-muted-foreground"}`}>
                      {p.showInStore ? <Eye aria-hidden className="size-4" /> : <EyeOff aria-hidden className="size-4" />}
                    </button>
                  </div>}
                </div>

                {/* الرصيد يُعرض ويُعدّل لكل متغيّر صريح؛ لا مجموع منتجات ولا MIN variant. */}
                <div className="mt-3 grid gap-2 border-t border-border pt-3 md:grid-cols-2">
                  {p.variants.length === 0 ? (
                    <p className="text-xs text-[var(--sem-neg)]">لا يوجد متغيّر يمكن ربط المخزون به.</p>
                  ) : p.variants.map((variant) => {
                    const saleUnits = variant.units.filter((unit) => unit.isActive && unit.isStoreSaleUnit);
                    return (
                      <div key={variant.variantId} className="rounded-xl border border-border bg-background p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold">{variant.label}</p>
                            <p className="text-[10px] text-muted-foreground">SKU: {variant.sku}</p>
                          </div>
                          <button onClick={() => setStockFor({ variantId: variant.variantId, name: `${p.name} — ${variant.label}`, stockBase: variant.stockBase })} disabled={!variant.isActive} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-bold hover:bg-accent disabled:opacity-50" title="إنشاء طلب تسوية لهذا المتغيّر تحديداً">
                            <Boxes aria-hidden className="size-3" /> {fmtInt(variant.stockBase)} أساس
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {saleUnits.length === 0 ? <span className="text-[10px] text-[var(--sem-neg)]">لا وحدة بيع متجر نشطة</span> : saleUnits.map((unit) => (
                            <span key={unit.productUnitId} className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${unit.inStock && variant.isActive ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-muted text-muted-foreground"}`} title={`المعامل: ${unit.conversionFactor} من الوحدة الأساس`}>
                              {unit.unitName}: {!variant.isActive ? "المتغيّر معطّل" : unit.inStock ? `${fmtInt(unit.availableUnits)} متاح` : READINESS_LABELS[unit.readinessReasons[0] ?? "OUT_OF_STOCK"]}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
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
      {isAdmin && imageFor && <ImageDialog target={imageFor} onClose={() => setImageFor(null)} onDone={invalidate} />}
    </div>
  );
}

/** حوار ضبط مخزون المنتج إلى كميةٍ مستهدفة (ذرّي — قيد ADJUST على الخادم). */
function StockDialog({ target, onClose, onDone }: { target: { variantId: number; name: string; stockBase: number }; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState(String(target.stockBase));
  const setM = trpc.storeAdmin.catalog.setStock.useMutation({
    onSuccess: () => { notify.ok("أُرسل طلب تسوية المخزون للاعتماد"); onDone(); onClose(); },
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

/** عرض/إزالة الصورة الرئيسية فقط؛ الإضافة والاستبدال عبر Product Studio. */
function ImageDialog({ target, onClose, onDone }: { target: { productId: number; name: string; imageUrl: string | null }; onClose: () => void; onDone: () => void }) {
  const setM = trpc.storeAdmin.catalog.setImage.useMutation({
    onSuccess: () => { notify.ok("أُزيلت الصورة الرئيسية"); onDone(); onClose(); },
    onError: (e) => notify.err(e),
  });

  return (
    <Modal title={`صورة: ${target.name}`} onClose={onClose}>
      <div className="space-y-3">
        {target.imageUrl ? (
          <img src={target.imageUrl} alt={target.name} className="mx-auto aspect-square w-full max-w-52 rounded-lg border object-cover" />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground">لا توجد صورة منشورة</div>
        )}
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="font-medium">إضافة الصورة أو استبدالها تحتاج مهمة مراجعة.</p>
          <p className="mt-1 text-xs text-muted-foreground">استخدم استوديو صور المنتجات؛ لا تُنشَر بايتات مباشرة من كتالوج المتجر.</p>
          <Link href="/catalog/image-studio" className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
            <Images aria-hidden className="size-4" /> فتح استوديو الصور
          </Link>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-border px-4 py-2 text-sm font-medium hover:bg-accent">إلغاء</button>
        {target.imageUrl && (
          <button onClick={() => setM.mutate({ productId: target.productId, url: null })} disabled={setM.isPending} className="flex items-center gap-2 rounded-xl bg-destructive px-4 py-2 text-sm font-bold text-destructive-foreground transition hover:opacity-90 disabled:opacity-50">
            {setM.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Trash2 aria-hidden className="size-4" />} إزالة الصورة
          </button>
        )}
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
