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
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Banknote,
  BadgePercent,
  Briefcase,
  Check,
  Flame,
  ImageOff,
  Loader2,
  LogIn,
  MessageCircle,
  Minus,
  LayoutGrid,
  Package,
  Store,
  TrendingUp,
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
import { isPublicHost } from "@/lib/siteHosts";
import { GOVERNORATES, deliveryFeeFor } from "@shared/governorates";
import { buildStorefrontCartMessage, openWhatsApp } from "@/lib/whatsapp";
import { BannerFrame, type StoreBannerCreative } from "@/components/store/BannerFrame";

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

// حفظ السلة + بيانات التوصيل محلياً (مراجعة عدائية ١٢/٧): كان تحديث الصفحة/العودة للتطبيق يفرّغ
// السلة والنموذج فيهجر الزبون الطلب. نُبقيهما في localStorage فيستأنف الزبون من حيث توقّف.
type CheckoutForm = { name: string; phone: string; governorate: string; address: string; notes: string };
const DEFAULT_FORM: CheckoutForm = { name: "", phone: "+964 ", governorate: "baghdad", address: "", notes: "" };
const CART_STORAGE_KEY = "alroya-store-cart-v1";
const CHECKOUT_STORAGE_KEY = "alroya-store-checkout-v1";

function loadCart(): Map<number, CartLine> {
  const m = new Map<number, CartLine>();
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return m;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return m;
    for (const l of arr as CartLine[]) {
      if (l && typeof l.productUnitId === "number" && typeof l.qty === "number" && l.qty > 0) m.set(l.productUnitId, l);
    }
  } catch {
    /* تالف/محظور (وضع خاص) — سلّة فارغة */
  }
  return m;
}
function saveCart(cart: Map<number, CartLine>) {
  try {
    const arr = Array.from(cart.values());
    if (arr.length === 0) localStorage.removeItem(CART_STORAGE_KEY);
    else localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(arr));
  } catch {
    /* تخزين ممتلئ/محظور — تجاهل */
  }
}
function loadForm(): CheckoutForm {
  try {
    const raw = localStorage.getItem(CHECKOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FORM };
    const f = JSON.parse(raw) as Partial<CheckoutForm>;
    return {
      name: typeof f.name === "string" ? f.name : DEFAULT_FORM.name,
      phone: typeof f.phone === "string" && f.phone ? f.phone : DEFAULT_FORM.phone,
      governorate: typeof f.governorate === "string" ? f.governorate : DEFAULT_FORM.governorate,
      address: typeof f.address === "string" ? f.address : DEFAULT_FORM.address,
      notes: typeof f.notes === "string" ? f.notes : DEFAULT_FORM.notes,
    };
  } catch {
    return { ...DEFAULT_FORM };
  }
}
function saveForm(form: CheckoutForm) {
  try {
    localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(form));
  } catch {
    /* تجاهل */
  }
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

/** «تسوّق حسب القسم» — بطاقات فئات بصرية تقود التصفّح (نمط تجاريّ عالميّ). */
function CategoryTiles({ cats, onPick }: { cats: { id: number; name: string }[]; onPick: (id: number) => void }) {
  if (cats.length === 0) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">
        <LayoutGrid aria-hidden className="size-4 text-emerald-600" /> تسوّق حسب القسم
      </h3>
      <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6">
        {cats.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className="group flex flex-col items-center gap-2 rounded-2xl bg-white p-3 text-center ring-1 ring-slate-100 transition motion-safe:hover:-translate-y-0.5 hover:ring-emerald-300 dark:bg-slate-900 dark:ring-slate-800 dark:hover:ring-emerald-500/40"
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 transition group-hover:bg-emerald-600 group-hover:text-white dark:bg-emerald-500/10 dark:text-emerald-400">
              <Store aria-hidden className="size-6" />
            </span>
            <span className="line-clamp-2 text-[11px] font-bold leading-tight text-slate-700 dark:text-slate-200">{c.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** بطاقة منتج مُصغَّرة لصفوف العرض الأفقية («عروض حصرية»، «الأكثر مبيعاً»). */
type RowProduct = {
  productUnitId: number;
  productId: number;
  productName: string;
  price: string | null;
  salePrice?: string | null;
  imageUrl: string | null;
  unitName: string;
  inStock?: boolean;
};
function ProductRowCard({ p, onSelect, onAdd }: { p: RowProduct; onSelect: () => void; onAdd: () => void }) {
  const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
  const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
  return (
    <div className="flex w-40 shrink-0 flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
      <button onClick={onSelect} className="relative block text-right">
        <ProductImage url={p.imageUrl} alt={p.productName} className="aspect-square w-full" />
        {onSale && pct > 0 && (
          <span className="absolute right-2 top-2 rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-extrabold text-white shadow">−{pct}٪</span>
        )}
        {p.inStock === false && (
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-[11px] font-bold text-white">غير متوفّر</span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <button onClick={onSelect} className="text-right">
          <span className="line-clamp-2 min-h-[2.4em] text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">{p.productName}</span>
        </button>
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">{priceLabel(p.salePrice ?? p.price)}</span>
          {onSale && <span className="text-[11px] text-slate-400 line-through">{money(p.price)}</span>}
        </div>
        <button
          onClick={onAdd}
          disabled={p.inStock === false}
          className="mt-auto flex items-center justify-center gap-1 rounded-xl bg-amber-500 py-1.5 text-xs font-bold text-white transition motion-safe:active:scale-95 hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800"
        >
          <Plus aria-hidden className="size-3.5" /> {p.inStock === false ? "غير متوفّر" : "أضف"}
        </button>
      </div>
    </div>
  );
}

/** صفّ منتجات أفقيّ بعنوان وأيقونة (يُخفى إن فرغ). */
function ProductRow({
  title,
  icon,
  products,
  onSelect,
  onAdd,
}: {
  title: string;
  icon: React.ReactNode;
  products: RowProduct[];
  onSelect: (id: number) => void;
  onAdd: (p: RowProduct) => void;
}) {
  if (products.length === 0) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">{icon} {title}</h3>
      <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {products.map((p) => (
          <ProductRowCard key={p.productId} p={p} onSelect={() => onSelect(p.productId)} onAdd={() => onAdd(p)} />
        ))}
      </div>
    </section>
  );
}

/** بنر إعلانيّ ديناميكيّ: كاروسيل يتبدّل تلقائياً كل ٥ث (crossfade آمنٌ لـRTL) + نقاط تنقّل +
 *  ارتفاعٌ متجاوب (auto-scale). يُشتقّ من بنرات لوحة hPanel؛ بنرٌ واحد ⇒ يُعرَض ثابتاً بلا نقاط. */
type BannerItem = StoreBannerCreative;

/**
 * بنرات جانبية طولية (placement=SIDE): تملأ فراغَي جانبَي عمود المحتوى (max-w-6xl=1152px) على
 * الشاشات العريضة فقط (≥1600px حيث تتوفّر ≥224px لكل جانب). مثبّتة أثناء التمرير (نمط
 * skyscraper/half-page العالمي)، تتوزّع بالتناوب: الأول يمين (بداية RTL) والثاني يسار، بحدّ
 * بنرَين لكل جانب. لا تُزاحم المحتوى أبداً — موضعها محسوب من مركز الشاشة + نصف عرض العمود.
 */
function SideRails({ banners }: { banners: BannerItem[] }) {
  if (banners.length === 0) return null;
  const right = banners.filter((_, i) => i % 2 === 0).slice(0, 1);
  const left = banners.filter((_, i) => i % 2 === 1).slice(0, 1);
  const rail = (list: BannerItem[], sideStyle: CSSProperties) =>
    list.length > 0 && (
      <div className="fixed top-1/2 z-10 hidden min-w-[208px] max-w-56 w-[13vw] -translate-y-1/2 flex-col gap-3 min-[1600px]:flex" style={sideStyle} aria-hidden={false}>
        {list.map((b) => {
          return (
            <div key={b.id} className="relative aspect-[2/5] w-full overflow-hidden rounded-2xl shadow-md ring-1 ring-slate-200/60">
              <BannerFrame banner={b} slot="SIDE" />
            </div>
          );
        })}
      </div>
    );
  return (
    <>
      {/* CSS left/right فيزيائيتان لا منطقيتان: جهة البداية في RTL = يمين الشاشة = `left: 50%+592px`. */}
      {rail(right, { left: "calc(50% + 592px)" })}
      {rail(left, { right: "calc(50% + 592px)" })}
    </>
  );
}

/**
 * فاصل تسويقي عرضي داخل شبكة المنتجات (placement=INLINE) — يقطع سيل المنتجات كل عشرة أصناف
 * بشريط ترويجي (نمط in-feed banner العالمي: أمازون/علي إكسبرس). `col-span-full` يمتدّ على كامل
 * أعمدة الشبكة أياً كان عددها المتجاوب.
 */
function InlineStrip({ banner }: { banner: BannerItem; tone?: "emerald" | "amber" }) {
  return (
    <div className="relative col-span-full aspect-[3/1] overflow-hidden rounded-2xl shadow-sm sm:aspect-[6/1]">
      <BannerFrame banner={banner} slot="INLINE" />
    </div>
  );
}
function BannerCarousel({ banners }: { banners: BannerItem[] }) {
  const [cur, setCur] = useState(0);
  useEffect(() => {
    if (banners.length <= 1) return;
    const t = setInterval(() => setCur((i) => (i + 1) % banners.length), 5000);
    return () => clearInterval(t);
  }, [banners.length]);
  if (banners.length === 0) return null;
  const active = cur % banners.length;
  return (
    <section className="mb-4">
      <div className="relative aspect-[2/1] overflow-hidden rounded-3xl shadow-md sm:aspect-[16/5]">
        {banners.map((b, i) => {
          const inner = <BannerFrame banner={b} slot="HERO" active={i === active} />;
          return (
            <div key={b.id} className={`absolute inset-0 transition-opacity duration-700 ${i === active ? "opacity-100" : "pointer-events-none opacity-0"}`}>
              {inner}
            </div>
          );
        })}
      </div>
      {banners.length > 1 && (
        <div className="mt-2.5 flex justify-center gap-1.5">
          {banners.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setCur(i)}
              aria-label={`الانتقال للبنر ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${i === active ? "w-5 bg-emerald-600" : "w-1.5 bg-emerald-200 dark:bg-slate-700"}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type Panel = null | "cart" | "checkout" | "confirmation";

export default function Storefront() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [cart, setCart] = useState<Map<number, CartLine>>(loadCart);

  const [form, setForm] = useState<CheckoutForm>(loadForm);
  const [clientRequestId, setClientRequestId] = useState<string>("");
  const [confirmation, setConfirmation] = useState<{ orderNumber: string; total: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [rawSearch]);

  // ثيم تسويقيّ فاتح دائماً للمتجر (ملاحظة المالك ١٢/٧): الوضع الداكن يُتحكَّم به عبر class="dark" على
  // <html>؛ لكن واجهة الزبون يجب أن تبقى مضيئةً جذّابة تُشجّع الشراء بصرف النظر عن إعداد جهازه. نُزيل
  // الوضع الداكن ما دام المتجر معروضاً، ونُعيده عند المغادرة (لئلّا نؤثّر على واجهة الموظّف/الدخول).
  useEffect(() => {
    const html = document.documentElement;
    const hadDark = html.classList.contains("dark");
    html.classList.remove("dark");
    return () => {
      if (hadDark) html.classList.add("dark");
    };
  }, []);

  // استمرار السلة + بيانات التوصيل عبر تحديث الصفحة/إغلاق التطبيق (localStorage).
  useEffect(() => {
    saveCart(cart);
  }, [cart]);
  useEffect(() => {
    saveForm(form);
  }, [form]);

  const categoriesQ = trpc.storefront.categories.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const offersQ = trpc.storefront.offers.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const bannersQ = trpc.storefront.banners.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const settingsQ = trpc.storefront.settings.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const catalogQ = trpc.storefront.catalog.useQuery(
    { categoryId, search: search || undefined, limit: 120 },
    { placeholderData: (prev) => prev }
  );
  const detailQ = trpc.storefront.product.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });
  const relatedQ = trpc.storefront.related.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });

  const createOrder = trpc.storefront.createOrder.useMutation({
    onSuccess: (res) => {
      setConfirmation({ orderNumber: res.orderNumber, total: res.total });
      setCart(new Map());
      // امسح بيانات التوصيل (اسم/هاتف/عنوان) من الحالة و localStorage بعد نجاح الطلب (مراجعة عدائية
      // ١٢/٧): المتجر علنيّ بلا جلسة ⇒ إبقاؤها يسرّبها للزبون التالي على جهازٍ مشترك/كشك. الاستعادة
      // عبر التحديث تخصّ طلباً قيد الإنشاء فقط، لا بعد إتمامه.
      setForm({ ...DEFAULT_FORM });
      setPanel("confirmation");
    },
  });

  const items = catalogQ.data?.items ?? [];
  const cats = categoriesQ.data ?? [];
  const offers = offersQ.data ?? [];
  const banners = bannersQ.data ?? [];
  // توزيع البنرات على مواضعها الثلاثة (الصفوف القديمة بلا placement = رئيسي).
  const heroBanners = useMemo(() => banners.filter((b) => (b.placement ?? "HERO") === "HERO"), [banners]);
  const sideBanners = useMemo(() => banners.filter((b) => b.placement === "SIDE"), [banners]);
  const inlineBanners = useMemo(() => banners.filter((b) => b.placement === "INLINE"), [banners]);
  const announcement = settingsQ.data?.announcement ?? null;
  const storeOpen = settingsQ.data?.isOpen ?? true;
  const activeCatName = useMemo(
    () => (categoryId == null ? null : cats.find((c) => c.id === categoryId)?.name ?? null),
    [categoryId, cats]
  );
  // فواصل السيل التسويقية: بنرات INLINE المُدارة أولاً، وعند غيابها تُشتقّ من عروض اليوم الفعّالة
  // (فلسفة in-feed العالمية: لا يمرّ الزبون بأكثر من ~عشرة منتجات دون محفّز شراء).
  const feedStrips = useMemo<BannerItem[]>(() => {
    if (inlineBanners.length) return inlineBanners;
    return offers.slice(0, 4).map((o) => ({
      id: -o.id,
      title: o.name,
      subtitle: o.type === "PERCENT" ? `خصم ${Number(o.discountPercent)}٪` : `خصم ${money(o.discountAmount)} د.ع`,
      ctaLabel: "عرض اليوم",
    }));
  }, [inlineBanners, offers]);

  // تنظيم تسويقيّ عالميّ: عروض حصرية (منتجات مخصومة فعلاً) + الأكثر مبيعاً (بحسب soldCount) — يُشتقّان
  // من الكتالوج نفسه، فيظهران على الواجهة الأولى فقط (بلا بحث/فئة) ويُخفَيان تلقائياً إن لم يوجد محتوى.
  const dealProducts = useMemo(
    () => items.filter((p) => p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price)).slice(0, 12),
    [items]
  );
  const bestSellers = useMemo(
    () => [...items].filter((p) => (p.soldCount ?? 0) > 0).sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0)).slice(0, 12),
    [items]
  );

  const cartLines = useMemo(() => Array.from(cart.values()), [cart]);
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0);
  const cartSubtotal = cartLines.reduce((s, l) => s + Number(l.price) * l.qty, 0);
  const deliveryFee = deliveryFeeFor(form.governorate);
  const freeThreshold = settingsQ.data?.freeShippingThreshold ? Number(settingsQ.data.freeShippingThreshold) : 0;
  const qualifiesFree = freeThreshold > 0 && cartSubtotal >= freeThreshold;
  const effectiveDeliveryFee = qualifiesFree ? 0 : deliveryFee;
  const remainingForFree = freeThreshold > 0 ? Math.max(freeThreshold - cartSubtotal, 0) : 0;
  const cartTotal = cartSubtotal + effectiveDeliveryFee;

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
    if (!storeOpen) return; // المتجر مغلق — الإشعار ظاهر أعلى الصفحة
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
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
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
          {/* دخول الفريق داخليّ ⇒ يظهر فقط على دومين الشركة (سياسة الدومينَين). على alarabiya.online
              — وداخل تطبيق الجوال — لا يُعرض إطلاقاً: الزبون لا يحتاجه، ولا نقفز به خارج دومين المتجر. */}
          {!isPublicHost(typeof window !== "undefined" ? window.location.hostname : "") && (
            <Link
              href="/login"
              className="flex shrink-0 items-center gap-1 rounded-xl px-2.5 py-2 text-[11px] font-bold text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800"
            >
              <LogIn aria-hidden className="size-3.5" />
              <span className="hidden sm:inline">دخول الفريق</span>
            </Link>
          )}
        </div>

        <div className="mx-auto max-w-6xl px-4 pb-3">
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
          <div className="mx-auto max-w-6xl overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
      <main className="mx-auto max-w-6xl px-4 py-4 pb-28">
        {/* شريط إعلان الموظف */}
        {announcement && (
          <div className="mb-3 flex items-center gap-2 rounded-2xl bg-amber-100 px-4 py-2.5 text-sm font-bold text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
            <BadgePercent aria-hidden className="size-4 shrink-0" />
            <span>{announcement}</span>
          </div>
        )}
        {/* المتجر مغلق مؤقتاً */}
        {!storeOpen && (
          <div className="mb-4 rounded-2xl bg-rose-100 px-4 py-3 text-center text-sm font-bold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
            المتجر مغلق مؤقتاً — لا يمكن استلام الطلبات حالياً. تصفّح المنتجات وعُد لاحقاً.
          </div>
        )}

        {!search && categoryId == null && (
          <>
            {/* البنرات المُدارة (لوحة hPanel) — أو الهيرو الافتراضي إن لم توجد */}
            {heroBanners.length > 0 ? (
              <BannerCarousel banners={heroBanners} />
            ) : (
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
            )}

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

            {/* تسوّق حسب القسم */}
            <CategoryTiles cats={cats} onPick={(id) => setCategoryId(id)} />

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

            {/* عروض حصرية — منتجات مخصومة فعلاً (إلحاحٌ يرفع التحويل) */}
            <ProductRow
              title="عروض حصرية"
              icon={<Flame aria-hidden className="size-4 text-rose-500" />}
              products={dealProducts}
              onSelect={setSelectedId}
              onAdd={addToCart}
            />

            {/* الأكثر مبيعاً — دليلٌ اجتماعيّ يبني الثقة */}
            <ProductRow
              title="الأكثر مبيعاً"
              icon={<TrendingUp aria-hidden className="size-4 text-emerald-600" />}
              products={bestSellers}
              onSelect={setSelectedId}
              onAdd={addToCart}
            />

            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">
              <ShoppingBag aria-hidden className="size-4 text-emerald-600" /> كل المنتجات
            </h3>
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {items.flatMap((p, idx) => {
              const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
              const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
              const card = (
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
                    {p.isBundle && (
                      <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-extrabold text-white shadow">
                        <Package aria-hidden className="size-3" /> بكج
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
                    <div className="flex min-h-[0.9rem] flex-wrap items-center gap-x-2 text-[10px] leading-none">
                      {p.stockLeft != null && <span className="font-bold text-amber-600 dark:text-amber-400">بقي {p.stockLeft} فقط</span>}
                      {p.soldCount >= 10 ? (
                        <span className="flex items-center gap-0.5 font-bold text-orange-500"><Flame aria-hidden className="size-3" /> الأكثر مبيعاً</span>
                      ) : p.soldCount >= 3 ? (
                        <span className="text-slate-400">بيع {p.soldCount} مرة</span>
                      ) : null}
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
              // فاصل تسويقي كل عشرة منتجات (لا وسط نتائج البحث — الزبون الباحث يريد نتائجه صافية).
              const nodes: ReactNode[] = [card];
              if (!search && feedStrips.length > 0 && (idx + 1) % 10 === 0 && idx + 1 < items.length) {
                const k = ((idx + 1) / 10 - 1) % feedStrips.length;
                nodes.push(
                  <InlineStrip key={`strip-${idx}`} banner={feedStrips[k]} tone={inlineBanners.length ? "emerald" : "amber"} />
                );
              }
              return nodes;
            })}
          </div>
        )}
      </main>

      {/* بنرات جانبية طولية (شاشات عريضة فقط) — خارج عمود المحتوى، لا تُزاحمه */}
      <SideRails banners={sideBanners} />

      {/* تذييل الموقع العام: كل ما يخدم الناس يعيش على هذا الدومين — المتجر والوظائف.
          هامش سفلي إضافي كي لا يحجبه شريط السلة العائم. */}
      <footer className="mt-10 border-t border-emerald-100 bg-white/70 pb-24 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6">
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-slate-700 dark:text-slate-200">{STORE_NAME}</p>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{STORE_TAGLINE}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            <Link
              href="/apply"
              className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:text-emerald-700 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
            >
              <Briefcase aria-hidden className="size-3.5" />
              الوظائف — انضمّ إلى فريقنا
            </Link>
            {settingsQ.data?.whatsappNumber && (
              <a
                href={`https://wa.me/${settingsQ.data.whatsappNumber.replace(/[^\d]/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:text-emerald-700 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
              >
                <MessageCircle aria-hidden className="size-3.5" />
                تواصل معنا
              </a>
            )}
          </nav>
        </div>
      </footer>

      {/* شريط السلة العائم */}
      {cartCount > 0 && panel == null && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-emerald-100 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
          <div className="mx-auto max-w-6xl px-4 py-3">
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
                      {detailQ.data.inStock
                        ? detailQ.data.stockLeft != null
                          ? `متوفّر — بقي ${detailQ.data.stockLeft} فقط، سارع بالطلب`
                          : "متوفّر"
                        : "غير متوفّر حالياً"}
                    </p>
                    {detailQ.data.soldCount >= 3 && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-bold text-orange-500">
                        <Flame aria-hidden className="size-3.5" /> {detailQ.data.soldCount >= 10 ? "من الأكثر مبيعاً" : `بيع ${detailQ.data.soldCount} مرة`}
                      </p>
                    )}
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

                {/* محتويات البكج */}
                {detailQ.data.isBundle && detailQ.data.bundleItems && detailQ.data.bundleItems.length > 0 && (
                  <div className="mt-4 rounded-2xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                      <Package aria-hidden className="size-3.5" /> يحتوي البكج على:
                    </p>
                    <ul className="space-y-0.5 text-xs text-slate-700 dark:text-slate-300">
                      {detailQ.data.bundleItems.map((bi, i) => (
                        <li key={i} className="flex justify-between">
                          <span>{bi.name}</span>
                          <span className="tabular-nums text-slate-500">×{bi.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* قد يعجبك أيضاً (cross-sell) */}
                {(relatedQ.data?.length ?? 0) > 0 && (
                  <div className="mt-5">
                    <h3 className="mb-2 text-sm font-extrabold text-slate-800 dark:text-slate-200">قد يعجبك أيضاً</h3>
                    <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {relatedQ.data!.map((rp) => (
                        <div key={rp.productId} className="flex min-w-[120px] max-w-[130px] shrink-0 flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                          <button onClick={() => setSelectedId(rp.productId)} className="text-right">
                            <ProductImage url={rp.imageUrl} alt={rp.productName} className="aspect-square w-full" />
                          </button>
                          <div className="flex flex-1 flex-col gap-1 p-2">
                            <span className="line-clamp-2 min-h-[2.2em] text-[11px] font-bold leading-tight">{rp.productName}</span>
                            <span className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">{priceLabel(rp.salePrice ?? rp.price)}</span>
                            <button onClick={() => addToCart(rp)} className="mt-0.5 flex items-center justify-center gap-1 rounded-lg bg-amber-500 py-1.5 text-[11px] font-bold text-white transition motion-safe:active:scale-95 hover:bg-amber-600">
                              <Plus aria-hidden className="size-3" /> أضف
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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
              {freeThreshold > 0 &&
                (qualifiesFree ? (
                  <div className="mt-3 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2.5 text-xs font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                    <Truck aria-hidden className="size-4" /> رائع! حصلت على توصيل مجاني
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-center text-xs font-bold text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                    أضِف <span className="tabular-nums">{money(remainingForFree)}</span> د.ع لتحصل على <span className="font-extrabold">توصيل مجاني</span>
                  </div>
                ))}
              <button
                onClick={openCheckout}
                disabled={!storeOpen}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-lg shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
              >
                {storeOpen ? (
                  <>
                    متابعة إلى الدفع عند الاستلام
                    <ArrowRight aria-hidden className="size-4" />
                  </>
                ) : (
                  "المتجر مغلق مؤقتاً — تعذّر إتمام الطلب"
                )}
              </button>
              {settingsQ.data?.whatsappNumber && (
                <button
                  onClick={() =>
                    openWhatsApp(
                      settingsQ.data!.whatsappNumber,
                      buildStorefrontCartMessage(
                        cartLines.map((l) => ({ name: l.name, quantity: l.qty, total: Number(l.price) * l.qty })),
                        cartSubtotal
                      )
                    )
                  }
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-500 bg-emerald-50 py-3 text-sm font-bold text-emerald-700 transition motion-safe:active:scale-[0.98] hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400"
                >
                  <MessageCircle aria-hidden className="size-4" /> أو أرسل سلّتك عبر واتساب
                </button>
              )}
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
                {qualifiesFree ? (
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">مجاني</span>
                ) : (
                  <span className="tabular-nums text-slate-800 dark:text-slate-100">{money(deliveryFee)} د.ع</span>
                )}
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
    <div className="fixed inset-0 z-50 flex flex-col bg-emerald-50 dark:bg-slate-950" dir="rtl">
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
