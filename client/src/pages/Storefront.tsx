/**
 * /store — واجهة المتجر التسويقي للزبون (B2C) على الجوال.
 *
 * صفحة **علنية** بملء الشاشة (بلا AppLayout وبلا جلسة دخول) — نقطة دخول التطبيق للزبون.
 * تعرض كتالوجك الحقيقي عبر `storefront.*` (بيانات آمنة: بلا تكلفة/مخزون). زرّ «دخول الفريق»
 * منفصلٌ في الزاوية يفتح دخول الموظف/المندوب بعيداً عن المتجر (رؤية المالك).
 *
 * شريحة ١ (هذه): تصفّح + بحث + فئات + تفاصيل منتج. السلة + الدفع عند الاستلام في الشريحة التالية
 * (فلا زرّ بلا وظيفة — قاعدة المالك «لا زر لا يُلزم»).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ImageOff, Loader2, LogIn, Package, Search, Store, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";

const STORE_NAME = "المكتبة العربية";
const STORE_TAGLINE = "الرؤية العربية للتجارة العامة — قرطاسية وطباعة";

function priceLabel(price: string | null): string {
  if (price == null || price === "") return "اسأل الموظّف";
  return `${fmtInt(price)} د.ع`;
}

/** خانة صورة المنتج (أو بديل عند غيابها). */
function ProductImage({ url, alt, className }: { url: string | null; alt: string; className?: string }) {
  if (!url) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}>
        <ImageOff aria-hidden className="size-8 opacity-50" />
      </div>
    );
  }
  return <img src={url} alt={alt} loading="lazy" className={`object-cover ${className ?? ""}`} />;
}

export default function Storefront() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // تهدئة البحث (٣٥٠م) — تجنّب إغراق النقطة العلنية واحترام حدّ المعدّل.
  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const categoriesQ = trpc.storefront.categories.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const catalogQ = trpc.storefront.catalog.useQuery(
    { categoryId, search: search || undefined, limit: 120 },
    { placeholderData: (prev) => prev }
  );
  const detailQ = trpc.storefront.product.useQuery(
    { productId: selectedId ?? 0 },
    { enabled: selectedId != null }
  );

  const items = catalogQ.data?.items ?? [];
  const cats = categoriesQ.data ?? [];
  const activeCatName = useMemo(
    () => (categoryId == null ? null : cats.find((c) => c.id === categoryId)?.name ?? null),
    [categoryId, cats]
  );

  return (
    <div className="min-h-screen bg-background text-foreground" dir="rtl">
      {/* الترويسة */}
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Store aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold leading-tight">{STORE_NAME}</h1>
            <p className="truncate text-xs text-muted-foreground">{STORE_TAGLINE}</p>
          </div>
          <Link
            href="/login"
            className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LogIn aria-hidden className="size-3.5" />
            <span>دخول الفريق</span>
          </Link>
        </div>

        {/* البحث */}
        <div className="mx-auto max-w-2xl px-4 pb-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              placeholder="ابحث عن منتج أو ماركة…"
              className="w-full rounded-xl border border-border bg-background py-2.5 pr-10 pl-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
            />
          </div>
        </div>

        {/* أشرطة الفئات */}
        {cats.length > 0 && (
          <div className="mx-auto max-w-2xl overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex w-max gap-2">
              <button
                onClick={() => setCategoryId(null)}
                className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                  categoryId == null ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                الكل
              </button>
              {cats.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCategoryId(c.id)}
                  className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                    categoryId === c.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {c.name}
                  <span className="mr-1 opacity-60">{c.productCount}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* المحتوى */}
      <main className="mx-auto max-w-2xl px-4 py-4">
        {(activeCatName || search) && (
          <p className="mb-3 text-sm text-muted-foreground">
            {search ? <>نتائج «{search}»</> : <>فئة «{activeCatName}»</>}
            {catalogQ.isFetching && <Loader2 aria-hidden className="mr-2 inline size-3.5 animate-spin align-middle" />}
          </p>
        )}

        {catalogQ.isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Loader2 aria-hidden className="size-8 animate-spin" />
            <p className="mt-3 text-sm">جارٍ تحميل المنتجات…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
            <Package aria-hidden className="size-10 opacity-40" />
            <p className="mt-3 text-sm">لا توجد منتجات مطابقة</p>
            {(search || categoryId != null) && (
              <button
                onClick={() => {
                  setRawSearch("");
                  setSearch("");
                  setCategoryId(null);
                }}
                className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
              >
                عرض كل المنتجات
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((p) => (
              <button
                key={p.productId}
                onClick={() => setSelectedId(p.productId)}
                className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-right transition hover:shadow-md"
              >
                <ProductImage url={p.imageUrl} alt={p.productName} className="aspect-square w-full" />
                <div className="flex flex-1 flex-col gap-1 p-2.5">
                  {p.brand && <span className="truncate text-[10px] text-muted-foreground">{p.brand}</span>}
                  <span className="line-clamp-2 min-h-[2.4em] text-xs font-semibold leading-tight">{p.productName}</span>
                  <span className="mt-auto text-sm font-bold text-primary">{priceLabel(p.price)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>

      {/* تفاصيل المنتج (ورقة سفلية) */}
      {selectedId != null && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={() => setSelectedId(null)}>
          <div
            className="w-full max-w-2xl animate-in slide-in-from-bottom rounded-t-3xl border-t border-border bg-card p-4 pb-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-muted-foreground">تفاصيل المنتج</h2>
              <button
                onClick={() => setSelectedId(null)}
                aria-label="إغلاق"
                className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            {detailQ.isLoading ? (
              <div className="flex justify-center py-12 text-muted-foreground">
                <Loader2 aria-hidden className="size-6 animate-spin" />
              </div>
            ) : detailQ.data ? (
              <div className="flex gap-4">
                <ProductImage url={detailQ.data.imageUrl} alt={detailQ.data.productName} className="size-28 shrink-0 rounded-2xl" />
                <div className="min-w-0 flex-1">
                  {detailQ.data.brand && <p className="text-xs text-muted-foreground">{detailQ.data.brand}</p>}
                  <h3 className="text-base font-bold leading-snug">{detailQ.data.productName}</h3>
                  {detailQ.data.category && (
                    <p className="mt-1 text-xs text-muted-foreground">الفئة: {detailQ.data.category}</p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">الوحدة: {detailQ.data.unitName}</p>
                  <p className="mt-3 text-xl font-extrabold text-primary">{priceLabel(detailQ.data.price)}</p>
                </div>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">تعذّر تحميل تفاصيل المنتج</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
