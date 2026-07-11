/**
 * /store — واجهة المتجر التسويقي للزبون (B2C) على الجوال.
 *
 * صفحة **علنية** بملء الشاشة (بلا AppLayout وبلا جلسة دخول) — نقطة دخول التطبيق للزبون.
 * تصفّح كتالوجك الحقيقي (storefront.*، بيانات آمنة) + سلة + **الدفع عند الاستلام**.
 * زرّ «دخول الفريق» منفصلٌ في الترويسة يفتح دخول الموظف/المندوب بعيداً عن المتجر.
 *
 * 🎨 نظام تصميم تسويقي (UI/UX Pro Max — نمط Vibrant & Block-based لكتالوج البيع):
 *   • أخضر زمرّدي منعش (ثقة + انتعاش) للعلامة، و**كهرمانيّ دافئ للأزرار الشرائية** (يرفع التحويل).
 *   • بطاقات بيضاء، خلفية نعناعية فاتحة، حوافّ 2xl، ظلال ناعمة، حركات ضغط ٢٠٠م.
 *   • هيرو + شريط ثقة + شارات خصم — سمات المتجر الناجح. مقصور على المتجر (لا يمسّ نظام الموظفين).
 *   • متجاوب أولوية-الجوال، ثيم فاتح/داكن، خطّ Cairo (ودود كـNunito الموصى به).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Banknote,
  BadgePercent,
  Check,
  ImageOff,
  Loader2,
  LogIn,
  Minus,
  Package,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Tag,
  Trash2,
  Truck,
  User,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtInt } from "@/lib/money";
import { GOVERNORATES, deliveryFeeFor } from "@shared/governorates";

const STORE_NAME = "المكتبة العربية";
const STORE_TAGLINE = "قرطاسية • طباعة • هدايا — يصلك أينما كنت في العراق";

interface CartLine {
  productUnitId: number;
  productId: number;
  name: string;
  price: string; // سعر العرض المؤثّر (للعرض — الخادم يُعيد التسعير)
  imageUrl: string | null;
  unitName: string;
  qty: number;
}

function money(v: string | number | null): string {
  if (v == null || v === "") return "0";
  return fmtInt(v);
}
function priceLabel(price: string | null): string {
  if (price == null || price === "") return "اسأل الموظّف";
  return `${money(price)} د.ع`;
}

function ProductImage({ url, alt, className }: { url: string | null; alt: string; className?: string }) {
  if (!url) {
    return (
      <div className={`flex items-center justify-center bg-emerald-50 text-emerald-300 dark:bg-slate-800 dark:text-slate-600 ${className ?? ""}`}>
        <ImageOff aria-hidden className="size-8" />
      </div>
    );
  }
  return <img src={url} alt={alt} loading="lazy" className={`object-cover ${className ?? ""}`} />;
}

type Panel = null | "cart" | "checkout" | "confirmation";

export default function Storefront() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cart, setCart] = useState<Map<number, CartLine>>(new Map());

  const [form, setForm] = useState({ name: "", phone: "+964 ", governorate: "baghdad", address: "", notes: "" });
  const [clientRequestId, setClientRequestId] = useState<string>("");
  const [confirmation, setConfirmation] = useState<{ orderNumber: string; total: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const categoriesQ = trpc.storefront.categories.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const offersQ = trpc.storefront.offers.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const catalogQ = trpc.storefront.catalog.useQuery(
    { categoryId, search: search || undefined, limit: 120 },
    { placeholderData: (prev) => prev }
  );
  const detailQ = trpc.storefront.product.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });

  const createOrder = trpc.storefront.createOrder.useMutation({
    onSuccess: (res) => {
      setConfirmation({ orderNumber: res.orderNumber, total: res.total });
      setCart(new Map());
      setPanel("confirmation");
    },
  });

  const items = catalogQ.data?.items ?? [];
  const cats = categoriesQ.data ?? [];
  const offers = offersQ.data ?? [];
  const activeCatName = useMemo(
    () => (categoryId == null ? null : cats.find((c) => c.id === categoryId)?.name ?? null),
    [categoryId, cats]
  );

  const cartLines = useMemo(() => Array.from(cart.values()), [cart]);
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0);
  const cartSubtotal = cartLines.reduce((s, l) => s + Number(l.price) * l.qty, 0);
  const deliveryFee = deliveryFeeFor(form.governorate);
  const cartTotal = cartSubtotal + deliveryFee;

  function addToCart(p: {
    productUnitId: number; productId: number; productName: string; price: string | null;
    salePrice?: string | null; imageUrl: string | null; unitName: string; inStock?: boolean;
  }) {
    const eff = p.salePrice ?? p.price;
    if (eff == null || p.inStock === false) return;
    setCart((prev) => {
      const next = new Map(prev);
      const existing = next.get(p.productUnitId);
      next.set(p.productUnitId, {
        productUnitId: p.productUnitId,
        productId: p.productId,
        name: p.productName,
        price: eff,
        imageUrl: p.imageUrl,
        unitName: p.unitName,
        qty: (existing?.qty ?? 0) + 1,
      });
      return next;
    });
  }
  function setQty(productUnitId: number, qty: number) {
    setCart((prev) => {
      const next = new Map(prev);
      const line = next.get(productUnitId);
      if (!line) return prev;
      if (qty <= 0) next.delete(productUnitId);
      else next.set(productUnitId, { ...line, qty: Math.min(qty, 999) });
      return next;
    });
  }
  function offerLabel(o: { type: "PERCENT" | "AMOUNT"; discountPercent: string; discountAmount: string }): string {
    return o.type === "PERCENT" ? `خصم ${Number(o.discountPercent)}٪` : `خصم ${money(o.discountAmount)} د.ع`;
  }

  function openCheckout() {
    setClientRequestId(`sf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    setPanel("checkout");
  }
  function submitOrder() {
    const name = form.name.trim();
    const phone = form.phone.replace(/\s+/g, " ").trim();
    const address = form.address.trim();
    if (!name || phone.replace(/\D/g, "").length < 8 || address.length < 3 || cartLines.length === 0) return;
    createOrder.mutate({
      customerName: name,
      customerPhone: phone,
      governorate: form.governorate,
      addressText: address,
      notes: form.notes.trim() || undefined,
      lines: cartLines.map((l) => ({ productUnitId: l.productUnitId, quantity: l.qty })),
      clientRequestId,
    });
  }
  const canSubmit =
    form.name.trim().length > 0 &&
    form.phone.replace(/\D/g, "").length >= 8 &&
    form.address.trim().length >= 3 &&
    cartLines.length > 0;

  const chip = (active: boolean) =>
    `whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-bold transition ${
      active
        ? "bg-emerald-600 text-white shadow-sm shadow-emerald-600/30"
        : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
    }`;

  return (
    <div className="min-h-dvh bg-emerald-50/50 text-slate-900 dark:bg-slate-950 dark:text-slate-100" dir="rtl">
      {/* الترويسة */}
      <header className="sticky top-0 z-20 border-b border-emerald-100/70 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/85">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm shadow-emerald-600/30">
            <ShoppingBag aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-extrabold leading-tight">{STORE_NAME}</h1>
            <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{STORE_TAGLINE}</p>
          </div>
          <button
            onClick={() => setPanel("cart")}
            aria-label="السلة"
            className="relative flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white text-slate-700 ring-1 ring-slate-200 transition motion-safe:active:scale-95 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
          >
            <ShoppingCart aria-hidden className="size-5" />
            {cartCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-extrabold text-white shadow">
                {cartCount}
              </span>
            )}
          </button>
          <Link
            href="/login"
            className="flex shrink-0 items-center gap-1 rounded-xl px-2.5 py-2 text-[11px] font-bold text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800"
          >
            <LogIn aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">دخول الفريق</span>
          </Link>
        </div>

        <div className="mx-auto max-w-2xl px-4 pb-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              placeholder="ابحث عن منتج أو ماركة…"
              className="w-full rounded-2xl border-0 bg-white py-3 pr-11 pl-3 text-sm text-slate-900 shadow-sm ring-1 ring-slate-200 outline-none transition placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-400 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
            />
          </div>
        </div>

        {cats.length > 0 && (
          <div className="mx-auto max-w-2xl overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex w-max gap-2">
              <button onClick={() => setCategoryId(null)} className={chip(categoryId == null)}>
                الكل
              </button>
              {cats.map((c) => (
                <button key={c.id} onClick={() => setCategoryId(c.id)} className={chip(categoryId === c.id)}>
                  {c.name}
                  <span className="mr-1 opacity-60">{c.productCount}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* المحتوى */}
      <main className="mx-auto max-w-2xl px-4 py-4 pb-28">
        {!search && categoryId == null && (
          <>
            {/* الهيرو */}
            <section className="relative mb-4 overflow-hidden rounded-3xl bg-gradient-to-l from-emerald-600 via-emerald-500 to-teal-500 p-5 text-white shadow-lg shadow-emerald-600/20">
              <Sparkles aria-hidden className="absolute -left-3 -top-3 size-24 opacity-15" />
              <p className="text-xs font-bold text-emerald-50/90">أهلاً بك في</p>
              <h2 className="mt-0.5 text-2xl font-extrabold leading-tight">{STORE_NAME}</h2>
              <p className="mt-1.5 max-w-[85%] text-sm text-emerald-50/90">
                كل ما تحتاجه من القرطاسية والطباعة والهدايا — اطلب الآن وادفع عند الاستلام.
              </p>
              {offers.length > 0 && (
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-3 py-1 text-xs font-extrabold text-amber-950 shadow">
                  <BadgePercent aria-hidden className="size-4" />
                  عروض اليوم متاحة الآن
                </span>
              )}
            </section>

            {/* شريط الثقة */}
            <section className="mb-4 grid grid-cols-3 gap-2">
              {[
                { icon: <Banknote aria-hidden className="size-5" />, label: "الدفع عند الاستلام" },
                { icon: <Truck aria-hidden className="size-5" />, label: "توصيل لكل المحافظات" },
                { icon: <ShieldCheck aria-hidden className="size-5" />, label: "منتجات أصلية" },
              ].map((t, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5 rounded-2xl bg-white p-3 text-center ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                  <span className="flex size-9 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                    {t.icon}
                  </span>
                  <span className="text-[11px] font-bold leading-tight text-slate-600 dark:text-slate-300">{t.label}</span>
                </div>
              ))}
            </section>

            {/* عروض اليوم */}
            {offers.length > 0 && (
              <section className="mb-5">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">
                  <BadgePercent aria-hidden className="size-4 text-amber-500" /> عروض اليوم
                </h3>
                <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {offers.map((o) => (
                    <div
                      key={o.id}
                      className="flex min-w-[230px] max-w-[270px] shrink-0 items-center gap-3 rounded-2xl bg-gradient-to-l from-amber-500 to-orange-500 p-4 text-white shadow-md shadow-amber-500/20"
                    >
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/25">
                        <Tag aria-hidden className="size-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-extrabold leading-tight">{o.name}</p>
                        <p className="mt-0.5 text-xs font-bold text-amber-50">{offerLabel(o)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <h3 className="mb-3 text-sm font-extrabold text-slate-800 dark:text-slate-200">تصفّح المنتجات</h3>
          </>
        )}

        {(activeCatName || search) && (
          <p className="mb-3 text-sm font-medium text-slate-500 dark:text-slate-400">
            {search ? <>نتائج «{search}»</> : <>فئة «{activeCatName}»</>}
            {catalogQ.isFetching && <Loader2 aria-hidden className="mr-2 inline size-3.5 animate-spin align-middle" />}
          </p>
        )}

        {catalogQ.isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 text-slate-400">
            <Loader2 aria-hidden className="size-8 animate-spin text-emerald-500" />
            <p className="mt-3 text-sm">جارٍ تحميل المنتجات…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center text-slate-400">
            <Package aria-hidden className="size-10 opacity-50" />
            <p className="mt-3 text-sm">لا توجد منتجات مطابقة</p>
            {(search || categoryId != null) && (
              <button
                onClick={() => {
                  setRawSearch("");
                  setSearch("");
                  setCategoryId(null);
                }}
                className="mt-3 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition motion-safe:active:scale-95"
              >
                عرض كل المنتجات
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((p) => {
              const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
              const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
              return (
                <div
                  key={p.productId}
                  className={`flex flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-slate-100 transition dark:bg-slate-900 dark:ring-slate-800 ${
                    p.inStock ? "hover:shadow-md hover:ring-emerald-200 dark:hover:ring-emerald-500/30" : "opacity-70"
                  }`}
                >
                  <button onClick={() => setSelectedId(p.productId)} className="relative block text-right">
                    <ProductImage url={p.imageUrl} alt={p.productName} className="aspect-square w-full" />
                    {onSale && pct > 0 && (
                      <span className="absolute right-2 top-2 rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-extrabold text-white shadow">
                        −{pct}٪
                      </span>
                    )}
                    {!p.inStock && (
                      <span className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-[11px] font-bold text-white">
                        غير متوفّر
                      </span>
                    )}
                  </button>
                  <div className="flex flex-1 flex-col gap-1 p-2.5">
                    {p.brand && <span className="truncate text-[10px] font-medium text-slate-400">{p.brand}</span>}
                    <button onClick={() => setSelectedId(p.productId)} className="text-right">
                      <span className="line-clamp-2 min-h-[2.4em] text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">
                        {p.productName}
                      </span>
                    </button>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">
                        {priceLabel(p.salePrice ?? p.price)}
                      </span>
                      {onSale && <span className="text-[11px] text-slate-400 line-through">{money(p.price)}</span>}
                    </div>
                    <button
                      onClick={() => addToCart(p)}
                      disabled={!p.inStock}
                      className="mt-1 flex items-center justify-center gap-1 rounded-xl bg-amber-500 py-2 text-xs font-bold text-white transition motion-safe:active:scale-95 hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800"
                    >
                      <Plus aria-hidden className="size-3.5" />
                      {p.inStock ? "أضف للسلة" : "غير متوفّر"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* شريط السلة العائم */}
      {cartCount > 0 && panel == null && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-emerald-100 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
          <div className="mx-auto max-w-2xl px-4 py-3">
            <button
              onClick={() => setPanel("cart")}
              className="flex w-full items-center justify-between rounded-2xl bg-emerald-600 px-4 py-3.5 text-white shadow-lg shadow-emerald-600/25 transition motion-safe:active:scale-[0.98] hover:bg-emerald-700"
            >
              <span className="flex items-center gap-2 text-sm font-extrabold">
                <span className="flex size-6 items-center justify-center rounded-full bg-white/20 text-xs">{cartCount}</span>
                عرض السلة
              </span>
              <span className="text-sm font-extrabold">{money(cartSubtotal)} د.ع</span>
            </button>
          </div>
        </div>
      )}

      {/* تفاصيل المنتج (ورقة سفلية) */}
      {selectedId != null && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/50 backdrop-blur-sm" onClick={() => setSelectedId(null)}>
          <div className="w-full max-w-2xl rounded-t-3xl bg-white p-4 pb-8 shadow-2xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-slate-500 dark:text-slate-400">تفاصيل المنتج</h2>
              <button onClick={() => setSelectedId(null)} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400">
                <X aria-hidden className="size-4" />
              </button>
            </div>
            {detailQ.isLoading ? (
              <div className="flex justify-center py-12 text-emerald-500">
                <Loader2 aria-hidden className="size-6 animate-spin" />
              </div>
            ) : detailQ.data ? (
              <div>
                <div className="flex gap-4">
                  <ProductImage url={detailQ.data.imageUrl} alt={detailQ.data.productName} className="size-28 shrink-0 rounded-2xl" />
                  <div className="min-w-0 flex-1">
                    {detailQ.data.brand && <p className="text-xs font-medium text-slate-400">{detailQ.data.brand}</p>}
                    <h3 className="text-base font-extrabold leading-snug text-slate-900 dark:text-white">{detailQ.data.productName}</h3>
                    {detailQ.data.category && <p className="mt-1 text-xs text-slate-500">الفئة: {detailQ.data.category}</p>}
                    <p className="mt-0.5 text-xs text-slate-500">الوحدة: {detailQ.data.unitName}</p>
                    <div className="mt-3 flex items-baseline gap-2">
                      <p className="text-xl font-extrabold text-emerald-600 dark:text-emerald-400">{priceLabel(detailQ.data.salePrice ?? detailQ.data.price)}</p>
                      {detailQ.data.salePrice != null && detailQ.data.price != null && Number(detailQ.data.salePrice) < Number(detailQ.data.price) && (
                        <span className="text-sm text-slate-400 line-through">{money(detailQ.data.price)}</span>
                      )}
                    </div>
                    {detailQ.data.promotionName && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                        <Tag aria-hidden className="size-3" /> {detailQ.data.promotionName}
                      </span>
                    )}
                    <p className={`mt-2 text-xs font-bold ${detailQ.data.inStock ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}`}>
                      {detailQ.data.inStock ? "متوفّر" : "غير متوفّر حالياً"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (detailQ.data) addToCart(detailQ.data);
                    setSelectedId(null);
                  }}
                  disabled={!detailQ.data.inStock || detailQ.data.price == null}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 py-3.5 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800"
                >
                  <Plus aria-hidden className="size-4" />
                  {detailQ.data.inStock ? "أضف إلى السلة" : "غير متوفّر"}
                </button>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">تعذّر تحميل تفاصيل المنتج</p>
            )}
          </div>
        </div>
      )}

      {/* ═══ السلة ═══ */}
      {panel === "cart" && (
        <PanelShell title="سلة المشتريات" onClose={() => setPanel(null)}>
          {cartLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <ShoppingCart aria-hidden className="size-10 opacity-50" />
              <p className="mt-3 text-sm">سلتك فارغة</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {cartLines.map((l) => (
                  <div key={l.productUnitId} className="flex items-center gap-3 rounded-2xl bg-white p-2.5 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                    <ProductImage url={l.imageUrl} alt={l.name} className="size-16 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">{l.name}</p>
                      <p className="mt-1 text-sm font-extrabold text-emerald-600 dark:text-emerald-400">{money(l.price)} د.ع</p>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setQty(l.productUnitId, l.qty - 1)} aria-label="إنقاص" className="flex size-7 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">
                          <Minus aria-hidden className="size-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-extrabold tabular-nums">{l.qty}</span>
                        <button onClick={() => setQty(l.productUnitId, l.qty + 1)} aria-label="زيادة" className="flex size-7 items-center justify-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-700">
                          <Plus aria-hidden className="size-3.5" />
                        </button>
                      </div>
                      <button onClick={() => setQty(l.productUnitId, 0)} aria-label="حذف" className="flex items-center gap-1 text-[11px] font-medium text-rose-500 hover:underline">
                        <Trash2 aria-hidden className="size-3" />
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-2xl bg-white p-3.5 text-sm ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                <div className="flex justify-between text-slate-500">
                  <span>المجموع الفرعي</span>
                  <span className="font-extrabold text-slate-800 tabular-nums dark:text-slate-100">{money(cartSubtotal)} د.ع</span>
                </div>
              </div>
              <button onClick={openCheckout} className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-lg shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600">
                متابعة إلى الدفع عند الاستلام
                <ArrowRight aria-hidden className="size-4" />
              </button>
            </>
          )}
        </PanelShell>
      )}

      {/* ═══ الدفع عند الاستلام ═══ */}
      {panel === "checkout" && (
        <PanelShell title="الدفع عند الاستلام" onClose={() => setPanel("cart")}>
          <div className="flex flex-col gap-3">
            <Field icon={<User aria-hidden className="size-4" />} label="الاسم الكامل">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="اسمك" autoComplete="name" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </Field>
            <Field icon={<Phone aria-hidden className="size-4" />} label="رقم الهاتف">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" autoComplete="tel" placeholder="+964 7XX XXX XXXX" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </Field>
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
              <label className="mb-1 block text-xs font-bold text-slate-500">المحافظة</label>
              <select value={form.governorate} onChange={(e) => setForm({ ...form, governorate: e.target.value })} className="w-full bg-transparent text-sm outline-none">
                {GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
              <label className="mb-1 block text-xs font-bold text-slate-500">العنوان بالتفصيل</label>
              <textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} placeholder="المنطقة، الشارع، أقرب نقطة دالة…" className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </div>
            <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
              <label className="mb-1 block text-xs font-bold text-slate-500">ملاحظة (اختياري)</label>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="مثال: الاتصال قبل التوصيل" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </div>

            <div className="rounded-2xl bg-white p-3.5 text-sm ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
              <div className="flex justify-between text-slate-500">
                <span>المجموع الفرعي</span>
                <span className="tabular-nums text-slate-800 dark:text-slate-100">{money(cartSubtotal)} د.ع</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-slate-500">
                <span className="flex items-center gap-1"><Truck aria-hidden className="size-3.5" /> أجرة التوصيل (تقديري)</span>
                <span className="tabular-nums text-slate-800 dark:text-slate-100">{money(deliveryFee)} د.ع</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-base font-extrabold dark:border-slate-800">
                <span>الإجمالي</span>
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">{money(cartTotal)} د.ع</span>
              </div>
            </div>

            {createOrder.isError && (
              <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600 dark:bg-rose-500/10">
                {createOrder.error?.message ?? "تعذّر إرسال الطلب — أعد المحاولة"}
              </p>
            )}

            <button
              onClick={submitOrder}
              disabled={!canSubmit || createOrder.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-lg shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
            >
              {createOrder.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />}
              تأكيد الطلب (الدفع عند الاستلام)
            </button>
            <p className="flex items-center justify-center gap-1 text-center text-[11px] text-slate-400">
              <Banknote aria-hidden className="size-3.5" /> تدفع نقداً عند استلام الطلب من المندوب.
            </p>
          </div>
        </PanelShell>
      )}

      {/* ═══ تأكيد الطلب ═══ */}
      {panel === "confirmation" && confirmation && (
        <PanelShell title="تمّ استلام طلبك" onClose={() => setPanel(null)}>
          <div className="flex flex-col items-center py-6 text-center">
            <div className="flex size-20 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
              <Check aria-hidden className="size-10" />
            </div>
            <h3 className="mt-4 text-lg font-extrabold text-slate-900 dark:text-white">شكراً لك — تمّ استلام طلبك</h3>
            <p className="mt-1 text-sm text-slate-500">سنتواصل معك لتأكيد التوصيل.</p>
            <div className="mt-5 w-full rounded-2xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">رقم الطلب</span>
                <span className="font-extrabold tracking-wider text-slate-900 dark:text-white">{confirmation.orderNumber}</span>
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <span className="text-slate-500">الإجمالي (يُدفع للمندوب)</span>
                <span className="font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">{money(confirmation.total)} د.ع</span>
              </div>
            </div>
            <button
              onClick={() => {
                setPanel(null);
                setConfirmation(null);
                setForm((f) => ({ ...f, notes: "" }));
              }}
              className="mt-6 w-full rounded-2xl bg-emerald-600 py-4 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-emerald-700"
            >
              متابعة التسوّق
            </button>
          </div>
        </PanelShell>
      )}
    </div>
  );
}

/** غلاف لوح بملء الشاشة (سلة/دفع/تأكيد) — ترويسة ثابتة + محتوى قابل للتمرير. */
function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-emerald-50/50 dark:bg-slate-950" dir="rtl">
      <header className="sticky top-0 flex items-center gap-3 border-b border-emerald-100 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <button onClick={onClose} aria-label="رجوع" className="flex size-9 items-center justify-center rounded-full transition hover:bg-slate-100 dark:hover:bg-slate-800">
          <ArrowRight aria-hidden className="size-5 rotate-180 text-slate-600 dark:text-slate-300" />
        </button>
        <h2 className="text-base font-extrabold text-slate-900 dark:text-white">{title}</h2>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </div>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
      <label className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-500">
        <span className="text-emerald-500">{icon}</span>
        {label}
      </label>
      {children}
    </div>
  );
}
