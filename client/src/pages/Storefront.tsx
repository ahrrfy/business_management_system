/**
 * /store — واجهة المتجر التسويقي للزبون (B2C) على الجوال.
 *
 * صفحة **علنية** بملء الشاشة (بلا AppLayout وبلا جلسة دخول) — نقطة دخول التطبيق للزبون.
 * تصفّح كتالوجك الحقيقي (storefront.*، بيانات آمنة) + سلة + **الدفع عند الاستلام**.
 * زرّ «دخول الفريق» منفصلٌ في الترويسة يفتح دخول الموظف/المندوب بعيداً عن المتجر.
 *
 * الطلب يُنشئ «طلباً» بحالة PENDING عبر storefront.createOrder — الأسعار خادمية، لا انتحال مدير.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Check,
  ImageOff,
  Loader2,
  LogIn,
  Minus,
  Package,
  Phone,
  Plus,
  Search,
  ShoppingCart,
  Store,
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
const STORE_TAGLINE = "الرؤية العربية للتجارة العامة — قرطاسية وطباعة";

interface CartLine {
  productUnitId: number;
  productId: number;
  name: string;
  price: string; // سعر المفرد (للعرض فقط — الخادم يُعيد التسعير)
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
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}>
        <ImageOff aria-hidden className="size-8 opacity-50" />
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

  // نموذج الطلب
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
    const eff = p.salePrice ?? p.price; // نستعمل سعر العرض إن وُجد
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

  function offerLabel(o: { type: "PERCENT" | "AMOUNT"; discountPercent: string; discountAmount: string }): string {
    return o.type === "PERCENT" ? `خصم ${Number(o.discountPercent)}٪` : `خصم ${money(o.discountAmount)} د.ع`;
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

  function openCheckout() {
    // مفتاح idempotency جديد لكل محاولة طلب.
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
          <button
            onClick={() => setPanel("cart")}
            aria-label="السلة"
            className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-border text-foreground transition hover:bg-accent"
          >
            <ShoppingCart aria-hidden className="size-5" />
            {cartCount > 0 && (
              <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
                {cartCount}
              </span>
            )}
          </button>
          <Link
            href="/login"
            className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LogIn aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">دخول الفريق</span>
          </Link>
        </div>

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
      <main className="mx-auto max-w-2xl px-4 py-4 pb-24">
        {/* بنرات العروض الترويجية (من عروض النظام الفعّالة اليوم) */}
        {offers.length > 0 && !search && categoryId == null && (
          <div className="mb-4 flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {offers.map((o) => (
              <div
                key={o.id}
                className="flex min-w-[240px] max-w-[280px] shrink-0 items-center gap-3 rounded-2xl bg-gradient-to-l from-primary to-primary/70 p-4 text-primary-foreground shadow-md"
              >
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/20">
                  <Tag aria-hidden className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold leading-tight">{o.name}</p>
                  <p className="mt-0.5 text-xs font-extrabold">{offerLabel(o)}</p>
                </div>
              </div>
            ))}
          </div>
        )}

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
            {items.map((p) => {
              const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
              const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
              return (
                <div key={p.productId} className={`flex flex-col overflow-hidden rounded-2xl border border-border bg-card ${!p.inStock ? "opacity-70" : ""}`}>
                  <button onClick={() => setSelectedId(p.productId)} className="relative block text-right">
                    <ProductImage url={p.imageUrl} alt={p.productName} className="aspect-square w-full" />
                    {onSale && pct > 0 && (
                      <span className="absolute right-2 top-2 rounded-full bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground">
                        −{pct}٪
                      </span>
                    )}
                    {!p.inStock && (
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-center text-[11px] font-bold text-white">
                        غير متوفّر
                      </span>
                    )}
                  </button>
                  <div className="flex flex-1 flex-col gap-1 p-2.5">
                    {p.brand && <span className="truncate text-[10px] text-muted-foreground">{p.brand}</span>}
                    <button onClick={() => setSelectedId(p.productId)} className="text-right">
                      <span className="line-clamp-2 min-h-[2.4em] text-xs font-semibold leading-tight">{p.productName}</span>
                    </button>
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-primary">{priceLabel(p.salePrice ?? p.price)}</span>
                      {onSale && <span className="text-[11px] text-muted-foreground line-through">{money(p.price)}</span>}
                    </div>
                    <button
                      onClick={() => addToCart(p)}
                      disabled={!p.inStock}
                      className="mt-1 flex items-center justify-center gap-1 rounded-lg bg-primary py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur">
          <div className="mx-auto max-w-2xl px-4 py-3">
            <button
              onClick={() => setPanel("cart")}
              className="flex w-full items-center justify-between rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lg transition hover:opacity-95"
            >
              <span className="flex items-center gap-2 text-sm font-bold">
                <ShoppingCart aria-hidden className="size-4" />
                عرض السلة ({cartCount})
              </span>
              <span className="text-sm font-extrabold">{money(cartSubtotal)} د.ع</span>
            </button>
          </div>
        </div>
      )}

      {/* تفاصيل المنتج (ورقة سفلية) */}
      {selectedId != null && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={() => setSelectedId(null)}>
          <div className="w-full max-w-2xl rounded-t-3xl border-t border-border bg-card p-4 pb-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-muted-foreground">تفاصيل المنتج</h2>
              <button onClick={() => setSelectedId(null)} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent">
                <X aria-hidden className="size-4" />
              </button>
            </div>
            {detailQ.isLoading ? (
              <div className="flex justify-center py-12 text-muted-foreground">
                <Loader2 aria-hidden className="size-6 animate-spin" />
              </div>
            ) : detailQ.data ? (
              <div>
                <div className="flex gap-4">
                  <ProductImage url={detailQ.data.imageUrl} alt={detailQ.data.productName} className="size-28 shrink-0 rounded-2xl" />
                  <div className="min-w-0 flex-1">
                    {detailQ.data.brand && <p className="text-xs text-muted-foreground">{detailQ.data.brand}</p>}
                    <h3 className="text-base font-bold leading-snug">{detailQ.data.productName}</h3>
                    {detailQ.data.category && <p className="mt-1 text-xs text-muted-foreground">الفئة: {detailQ.data.category}</p>}
                    <p className="mt-0.5 text-xs text-muted-foreground">الوحدة: {detailQ.data.unitName}</p>
                    <div className="mt-3 flex items-baseline gap-2">
                      <p className="text-xl font-extrabold text-primary">{priceLabel(detailQ.data.salePrice ?? detailQ.data.price)}</p>
                      {detailQ.data.salePrice != null && detailQ.data.price != null && Number(detailQ.data.salePrice) < Number(detailQ.data.price) && (
                        <span className="text-sm text-muted-foreground line-through">{money(detailQ.data.price)}</span>
                      )}
                    </div>
                    {detailQ.data.promotionName && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        <Tag aria-hidden className="size-3" /> {detailQ.data.promotionName}
                      </span>
                    )}
                    <p className={`mt-2 text-xs font-semibold ${detailQ.data.inStock ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
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
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  <Plus aria-hidden className="size-4" />
                  {detailQ.data.inStock ? "أضف إلى السلة" : "غير متوفّر"}
                </button>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">تعذّر تحميل تفاصيل المنتج</p>
            )}
          </div>
        </div>
      )}

      {/* ═══ السلة ═══ */}
      {panel === "cart" && (
        <PanelShell title="سلة المشتريات" onClose={() => setPanel(null)}>
          {cartLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <ShoppingCart aria-hidden className="size-10 opacity-40" />
              <p className="mt-3 text-sm">سلتك فارغة</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {cartLines.map((l) => (
                  <div key={l.productUnitId} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-2.5">
                    <ProductImage url={l.imageUrl} alt={l.name} className="size-16 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-semibold leading-tight">{l.name}</p>
                      <p className="mt-1 text-sm font-bold text-primary">{money(l.price)} د.ع</p>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setQty(l.productUnitId, l.qty - 1)} aria-label="إنقاص" className="flex size-7 items-center justify-center rounded-full border border-border hover:bg-accent">
                          <Minus aria-hidden className="size-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-bold">{l.qty}</span>
                        <button onClick={() => setQty(l.productUnitId, l.qty + 1)} aria-label="زيادة" className="flex size-7 items-center justify-center rounded-full border border-border hover:bg-accent">
                          <Plus aria-hidden className="size-3.5" />
                        </button>
                      </div>
                      <button onClick={() => setQty(l.productUnitId, 0)} aria-label="حذف" className="flex items-center gap-1 text-[11px] text-destructive hover:underline">
                        <Trash2 aria-hidden className="size-3" />
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-2xl border border-border bg-card p-3 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>المجموع الفرعي</span>
                  <span className="font-semibold text-foreground">{money(cartSubtotal)} د.ع</span>
                </div>
              </div>
              <button onClick={openCheckout} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground transition hover:opacity-90">
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
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="اسمك" className="w-full bg-transparent text-sm outline-none" />
            </Field>
            <Field icon={<Phone aria-hidden className="size-4" />} label="رقم الهاتف">
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" placeholder="+964 7XX XXX XXXX" className="w-full bg-transparent text-sm outline-none" />
            </Field>
            <div className="rounded-xl border border-border bg-card p-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">المحافظة</label>
              <select value={form.governorate} onChange={(e) => setForm({ ...form, governorate: e.target.value })} className="w-full bg-transparent text-sm outline-none">
                {GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id} className="bg-card text-foreground">
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">العنوان بالتفصيل</label>
              <textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} placeholder="المنطقة، الشارع، أقرب نقطة دالة…" className="w-full resize-none bg-transparent text-sm outline-none" />
            </div>
            <div className="rounded-xl border border-border bg-card p-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">ملاحظة (اختياري)</label>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="مثال: الاتصال قبل التوصيل" className="w-full bg-transparent text-sm outline-none" />
            </div>

            {/* ملخّص */}
            <div className="rounded-2xl border border-border bg-card p-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>المجموع الفرعي</span>
                <span className="text-foreground">{money(cartSubtotal)} د.ع</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-1"><Truck aria-hidden className="size-3.5" /> أجرة التوصيل (تقديري)</span>
                <span className="text-foreground">{money(deliveryFee)} د.ع</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-extrabold">
                <span>الإجمالي</span>
                <span className="text-primary">{money(cartTotal)} د.ع</span>
              </div>
            </div>

            {createOrder.isError && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {createOrder.error?.message ?? "تعذّر إرسال الطلب — أعد المحاولة"}
              </p>
            )}

            <button
              onClick={submitOrder}
              disabled={!canSubmit || createOrder.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {createOrder.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />}
              تأكيد الطلب (الدفع عند الاستلام)
            </button>
            <p className="text-center text-[11px] text-muted-foreground">تدفع نقداً عند استلام الطلب من المندوب.</p>
          </div>
        </PanelShell>
      )}

      {/* ═══ تأكيد الطلب ═══ */}
      {panel === "confirmation" && confirmation && (
        <PanelShell title="تمّ استلام طلبك" onClose={() => setPanel(null)}>
          <div className="flex flex-col items-center py-6 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Check aria-hidden className="size-8" />
            </div>
            <h3 className="mt-4 text-lg font-bold">شكراً لك — تمّ استلام طلبك</h3>
            <p className="mt-1 text-sm text-muted-foreground">سنتواصل معك لتأكيد التوصيل.</p>
            <div className="mt-5 w-full rounded-2xl border border-border bg-card p-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">رقم الطلب</span>
                <span className="font-extrabold tracking-wider">{confirmation.orderNumber}</span>
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <span className="text-muted-foreground">الإجمالي (يُدفع للمندوب)</span>
                <span className="font-extrabold text-primary">{money(confirmation.total)} د.ع</span>
              </div>
            </div>
            <button
              onClick={() => {
                setPanel(null);
                setConfirmation(null);
                setForm((f) => ({ ...f, notes: "" }));
              }}
              className="mt-6 w-full rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground transition hover:opacity-90"
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
    <div className="fixed inset-0 z-50 flex flex-col bg-background" dir="rtl">
      <header className="sticky top-0 flex items-center gap-3 border-b border-border bg-card px-4 py-3">
        <button onClick={onClose} aria-label="رجوع" className="flex size-9 items-center justify-center rounded-full hover:bg-accent">
          <ArrowRight aria-hidden className="size-5 rotate-180" />
        </button>
        <h2 className="text-base font-bold">{title}</h2>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </div>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </label>
      {children}
    </div>
  );
}
