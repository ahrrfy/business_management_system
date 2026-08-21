/**
 * /store — واجهة المتجر التسويقي للزبون (B2C) على الجوال.
 *
 * صفحة **علنية** بملء الشاشة (بلا AppLayout وبلا جلسة دخول) — نقطة دخول التطبيق للزبون.
 * تصفّح كتالوجك الحقيقي (storefront.*، بيانات آمنة) + سلة + **الدفع عند الاستلام**.
 * زرّ «دخول الفريق» منفصلٌ في الترويسة يفتح دخول الموظف/المندوب بعيداً عن المتجر.
 *
 * نظام عرض تجاري مستقل للمتجر: تنقل واضح، اكتشاف بالفئات، عروض مختارة، كتالوج قابل للتصفية، وسلة ودفع عند الاستلام.
 * الأولوية للوضوح والمقارنة وسرعة الوصول إلى قرار الشراء، مع الحفاظ على منطق البيانات الحقيقي في النظام.
 */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  BadgePercent,
  Briefcase,
  Check,
  ChevronDown,
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
  Tag,
  Trash2,
  Truck,
  User,
  X,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { noteInteraction } from "@/lib/interactionDraft";

/** حالات الطلب بالعربية + لونها — لعرض تتبّع الطلب العلنيّ. */
const TRACK_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "قيد المراجعة", cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  CONFIRMED: { label: "تمّ التأكيد", cls: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  PROCESSING: { label: "قيد التجهيز", cls: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
  SHIPPED: { label: "مع المندوب", cls: "bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300" },
  DELIVERED: { label: "تمّ التسليم", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  CANCELLED: { label: "ملغى", cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400" },
};

export function formatStorefrontReservationDeadline(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "وقت غير متاح";
  return new Intl.DateTimeFormat("ar-IQ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Baghdad",
  }).format(date);
}
type TrackData = NonNullable<RouterOutputs["storefront"]["trackOrder"]>;
import { fmtInt } from "@/lib/money";
import { isPublicHost } from "@/lib/siteHosts";
import { GOVERNORATES, deliveryFeeFor } from "@shared/governorates";
import { buildStorefrontCartMessage, openWhatsApp } from "@/lib/whatsapp";
import { BannerFrame, type StoreBannerCreative } from "@/components/store/BannerFrame";
import { TurnstileWidget } from "@/components/storefront/TurnstileWidget";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";

const STORE_NAME = "المكتبة العربية";
const STORE_TAGLINE = "قرطاسية • طباعة • هدايا — يصلك أينما كنت في العراق";

export function storefrontTurnstileSubmissionReady(
  orderingEnabled: boolean,
  siteKey: string | null | undefined,
  token: string | null | undefined,
): boolean {
  return orderingEnabled && !!siteKey?.trim() && !!token?.trim();
}

export type StorefrontCustomizationKind = "PRINT" | "GIFT";

export type StorefrontCustomizationField = {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: "TEXT" | "TEXTAREA" | "SELECT" | "FILE" | "NUMBER" | "SWATCH";
  isRequired: boolean;
  sortOrder: number;
  maxLength: number | null;
  options: { value: string; label: string; priceDelta: string }[];
  dependency: { fieldKey: string; operator: "equals" | "notEquals"; value: string | string[] } | null;
  priceDelta: string;
  isActive?: boolean;
};

export type StorefrontCustomizationTemplate = {
  id: number;
  kind: StorefrontCustomizationKind | "GENERAL";
  title: string;
  description: string | null;
  fields: StorefrontCustomizationField[];
};

export type StorefrontCustomization = {
  kind: StorefrontCustomizationKind;
  values?: Record<string, string>;
  service?: string;
  serviceLabel?: string;
  packaging?: "standard" | "gift";
  recipient?: string;
  message?: string;
  uploadName?: string;
};

export type StorefrontCustomizationConfig = {
  kind: StorefrontCustomizationKind;
  title: string;
  description: string | null;
  fields: StorefrontCustomizationField[];
};

export function getStorefrontCustomizationConfig(
  isCustomizable: boolean,
  customizationKind: "PRINT" | "GIFT" | null | undefined,
  template?: StorefrontCustomizationTemplate | null,
): StorefrontCustomizationConfig | null {
  if (!isCustomizable || !customizationKind || !template) return null;
  if (template.kind !== customizationKind && template.kind !== "GENERAL") return null;
  return {
    kind: customizationKind,
    title: template.title,
    description: template.description,
    fields: template.fields.filter((field) => field.isActive !== false).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function dependencyMatches(
  dependency: StorefrontCustomizationField["dependency"],
  values: Record<string, string>,
): boolean {
  if (!dependency) return true;
  const current = values[dependency.fieldKey] ?? "";
  const expected = Array.isArray(dependency.value) ? dependency.value : [dependency.value];
  const matches = expected.includes(current);
  return dependency.operator === "notEquals" ? !matches : matches;
}

function CustomizationFieldControl({
  field,
  value,
  onChange,
}: {
  field: StorefrontCustomizationField;
  value: string;
  onChange: (value: string) => void;
}) {
  const common = "mt-1.5 w-full rounded-xl border border-[#ead8c8] bg-white px-3 py-2 text-xs font-bold text-[#30383e] outline-none transition focus:border-[#e65f4a]";
  if (field.fieldType === "SELECT") {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} className={common}>
        <option value="">اختر {field.label}</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}{option.priceDelta !== "0" ? ` (+${option.priceDelta} د.ع)` : ""}</option>)}
      </select>
    );
  }
  if (field.fieldType === "SWATCH") {
    return (
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {field.options.map((option) => (
          <button key={option.value} type="button" onClick={() => onChange(option.value)} className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${value === option.value ? "border-[#25406f] bg-[#25406f] text-white" : "border-[#ead8c8] bg-white text-[#5b5147] hover:border-[#e65f4a]"}`}>
            {option.label}{option.priceDelta !== "0" ? ` · +${option.priceDelta}` : ""}
          </button>
        ))}
      </div>
    );
  }
  if (field.fieldType === "TEXTAREA") {
    return <textarea value={value} onChange={(event) => onChange(event.target.value)} maxLength={field.maxLength ?? undefined} rows={3} placeholder={field.label} className={`${common} resize-none placeholder:text-[#a49a8e]`} />;
  }
  return <input type={field.fieldType === "NUMBER" ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} maxLength={field.maxLength ?? undefined} inputMode={field.fieldType === "NUMBER" ? "numeric" : undefined} placeholder={field.fieldType === "FILE" ? "اسم الملف أو مرجع التصميم" : field.label} className={`${common} placeholder:text-[#a49a8e]`} />;
}

function serializeCustomization(customization?: StorefrontCustomization): string {
  return customization ? JSON.stringify(customization) : "";
}

function customizationCartKey(productUnitId: number, customization?: StorefrontCustomization): string {
  return `${productUnitId}:${serializeCustomization(customization)}`;
}

export function summarizeStorefrontCustomization(customization?: StorefrontCustomization): string | null {
  if (!customization) return null;
  return [customization.service, customization.packaging === "gift" ? "تغليف هدية" : null, customization.recipient ? `إلى: ${customization.recipient}` : null, customization.message ? `رسالة: ${customization.message}` : null, customization.uploadName ? `ملف: ${customization.uploadName}` : null].filter(Boolean).join(" • ") || null;
}

export interface CartLine {
  cartKey: string;
  productUnitId: number;
  productId: number;
  name: string;
  price: string; // سعر العرض المؤثّر (للعرض — الخادم يُعيد التسعير)
  imageUrl: string | null;
  unitName: string;
  variantLabel?: string;
  customization?: StorefrontCustomization;
  qty: number;
}

export interface StorefrontPricingSnapshot {
  productId: number;
  storeUnits?: Array<{
    productUnitId: number;
    price: string | null;
    salePrice: string | null;
  }>;
  variants?: Array<{
    units: Array<{
      productUnitId: number;
      price: string | null;
      salePrice: string | null;
    }>;
  }>;
}

export function reconcileStorefrontCartPricing(
  current: Map<string, CartLine>,
  latestByProduct: Map<number, StorefrontPricingSnapshot | null | undefined>,
): { cart: Map<string, CartLine>; priceChanged: number; unavailable: number; unresolved: number } {
  const cart = new Map(current);
  let priceChanged = 0;
  let unavailable = 0;
  let unresolved = 0;
  for (const line of Array.from(current.values())) {
    const snapshot = latestByProduct.get(line.productId);
    // undefined = فشل شبكة عابر؛ لا نحذف سطر الزبون بسببه. null = المنتج لم يعد منشوراً.
    if (snapshot === undefined) {
      unresolved += 1;
      continue;
    }
    const units = snapshot == null
      ? []
      : [...(snapshot.storeUnits ?? []), ...(snapshot.variants ?? []).flatMap((variant) => variant.units)];
    const unit = units.find((candidate) => candidate.productUnitId === line.productUnitId);
    const currentPrice = unit?.salePrice ?? unit?.price ?? null;
    if (currentPrice == null) {
      cart.delete(line.cartKey);
      unavailable += 1;
      continue;
    }
    if (Number(currentPrice).toFixed(2) !== Number(line.price).toFixed(2)) {
      cart.set(line.cartKey, { ...line, price: Number(currentPrice).toFixed(2) });
      priceChanged += 1;
    }
  }
  return { cart, priceChanged, unavailable, unresolved };
}

export function reconcileStorefrontCartQuote(
  current: Map<string, CartLine>,
  quotedLines: Array<{ productUnitId: number; quantity: number; unitPrice: string }>,
): { cart: Map<string, CartLine>; priceChanged: number; unresolved: number } {
  const cart = new Map(current);
  const quotedByUnit = new Map(quotedLines.map((line) => [line.productUnitId, line]));
  let priceChanged = 0;
  let unresolved = 0;
  for (const line of Array.from(current.values())) {
    const quoted = quotedByUnit.get(line.productUnitId);
    if (!quoted || quoted.quantity !== line.qty) {
      unresolved += 1;
      continue;
    }
    const price = Number(quoted.unitPrice).toFixed(2);
    if (price !== Number(line.price).toFixed(2)) {
      cart.set(line.cartKey, { ...line, price });
      priceChanged += 1;
    }
  }
  return { cart, priceChanged, unresolved };
}

// حفظ السلة + بيانات التوصيل محلياً (مراجعة عدائية ١٢/٧): كان تحديث الصفحة/العودة للتطبيق يفرّغ
// السلة والنموذج فيهجر الزبون الطلب. نُبقيهما في localStorage فيستأنف الزبون من حيث توقّف.
export type CheckoutForm = { name: string; phone: string; governorate: string; address: string; notes: string };
const DEFAULT_FORM: CheckoutForm = { name: "", phone: "+964 ", governorate: "baghdad", address: "", notes: "" };
const CART_STORAGE_KEY = "alroya-store-cart-v1";
const CHECKOUT_STORAGE_KEY = "alroya-store-checkout-v1";
const CHECKOUT_ATTEMPT_STORAGE_KEY = "alroya-store-checkout-attempt-v1";
const STOREFRONT_PERSIST_REQUEST_EVENT = "alroya:storefront-persist-request";

export type StorefrontCheckoutAttempt = {
  clientRequestId: string;
  fingerprint: string;
  expectedGrandTotal: string;
  createdAt: number;
};

function loadCart(): Map<string, CartLine> {
  const m = new Map<string, CartLine>();
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return m;
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return m;
    for (const rawLine of arr as Partial<CartLine>[]) {
      if (rawLine && typeof rawLine.productUnitId === "number" && typeof rawLine.qty === "number" && rawLine.qty > 0) {
        const line = { ...rawLine, cartKey: typeof rawLine.cartKey === "string" && rawLine.cartKey ? rawLine.cartKey : customizationCartKey(rawLine.productUnitId, rawLine.customization) } as CartLine;
        m.set(line.cartKey, line);
      }
    }
  } catch {
    /* تالف/محظور (وضع خاص) — سلّة فارغة */
  }
  return m;
}
type StorefrontStorage = Pick<Storage, "setItem" | "removeItem">;
type StorefrontReadStorage = Pick<Storage, "getItem" | "removeItem">;

export function saveCart(
  cart: Map<string, CartLine>,
  storage: StorefrontStorage = localStorage,
): boolean {
  try {
    const arr = Array.from(cart.values());
    if (arr.length === 0) storage.removeItem(CART_STORAGE_KEY);
    else storage.setItem(CART_STORAGE_KEY, JSON.stringify(arr));
    return true;
  } catch {
    return false;
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
export function saveForm(
  form: CheckoutForm,
  storage: StorefrontStorage = localStorage,
): boolean {
  try {
    storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(form));
    return true;
  } catch {
    return false;
  }
}

export function loadCheckoutAttempt(
  storage: StorefrontReadStorage = localStorage,
): StorefrontCheckoutAttempt | null {
  try {
    const raw = storage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StorefrontCheckoutAttempt>;
    if (
      typeof value.clientRequestId !== "string" || !value.clientRequestId ||
      typeof value.fingerprint !== "string" || !value.fingerprint ||
      typeof value.expectedGrandTotal !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      storage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      return null;
    }
    return value as StorefrontCheckoutAttempt;
  } catch {
    return null;
  }
}

export function saveCheckoutAttempt(
  attempt: StorefrontCheckoutAttempt | null,
  storage: StorefrontStorage = localStorage,
): boolean {
  try {
    if (attempt) storage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
    else storage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function storefrontCheckoutFingerprint(cart: Map<string, CartLine>, form: CheckoutForm): string {
  const lines = Array.from(cart.values())
    .sort((a, b) => a.cartKey.localeCompare(b.cartKey))
    .map((line) => [line.cartKey, line.productUnitId, line.qty, Number(line.price).toFixed(2), serializeCustomization(line.customization)]);
  return JSON.stringify({
    lines,
    name: form.name.trim(),
    phone: form.phone.replace(/\s+/g, " ").trim(),
    governorate: form.governorate,
    address: form.address.trim(),
    notes: form.notes.trim(),
  });
}

export function saveStorefrontSnapshot(
  cart: Map<string, CartLine>,
  form: CheckoutForm,
  storage: StorefrontStorage = localStorage,
  attempt: StorefrontCheckoutAttempt | null = null,
): boolean {
  // لا تستخدم short-circuit: يجب محاولة حفظ الجزأين كي يحصل الزبون على أفضل فرصة للاسترداد.
  const cartSaved = saveCart(cart, storage);
  const formSaved = saveForm(form, storage);
  const attemptSaved = saveCheckoutAttempt(attempt, storage);
  return cartSaved && formSaved && attemptSaved;
}

export type StorefrontCartProduct = {
  productUnitId: number;
  productId: number;
  productName: string;
  imageUrl: string | null;
  unitName: string;
  variantLabel?: string;
  customization?: StorefrontCustomization;
};

/** اختيارٌ واحد من نافذة المنتج. تبقى الأسعار معلومات عرض فقط؛ الخادم يعيد التسعير عند إنشاء الطلب. */
export type StorefrontCartSelection = StorefrontCartProduct & {
  effectivePrice: string;
  quantity: number;
};

export function addStorefrontCartLine(
  current: Map<string, CartLine>,
  product: StorefrontCartProduct,
  effectivePrice: string,
): Map<string, CartLine> {
  const next = new Map(current);
  const cartKey = customizationCartKey(product.productUnitId, product.customization);
  const existing = next.get(cartKey);
  const customizationLabel = summarizeStorefrontCustomization(product.customization);
  next.set(cartKey, {
    cartKey,
    productUnitId: product.productUnitId,
    productId: product.productId,
    name: product.variantLabel
      ? `${product.productName} — ${product.variantLabel}`
      : product.productName,
    price: effectivePrice,
    imageUrl: product.imageUrl,
    unitName: product.unitName,
    variantLabel: product.variantLabel,
    customization: product.customization,
    qty: (existing?.qty ?? 0) + 1,
    ...(customizationLabel ? { customization: product.customization } : {}),
  });
  return next;
}

/**
 * إضافة عدة ألوان/متغيرات بضغطة واحدة مع دمج كل وحدة بيع في سطر سلتها القائم.
 * لا نثق بالكمية أو السعر هنا عند الدفع: createOrder يعيد التحقق من المخزون والتسعير خادمياً.
 */
export function addStorefrontCartLines(
  current: Map<string, CartLine>,
  selections: StorefrontCartSelection[],
): Map<string, CartLine> {
  let next = new Map(current);
  for (const selection of selections) {
    if (!Number.isInteger(selection.quantity) || selection.quantity <= 0) continue;
    const line = addStorefrontCartLine(next, selection, selection.effectivePrice);
    const cartKey = customizationCartKey(selection.productUnitId, selection.customization);
    const added = line.get(cartKey)!;
    line.set(cartKey, {
      ...added,
      qty: Math.min((next.get(cartKey)?.qty ?? 0) + selection.quantity, 999),
    });
    next = line;
  }
  return next;
}

export function setStorefrontCartQuantity(
  current: Map<string, CartLine>,
  cartKey: string,
  quantity: number,
): Map<string, CartLine> {
  const line = current.get(cartKey);
  if (!line) return current;
  const next = new Map(current);
  if (quantity <= 0) next.delete(cartKey);
  else next.set(cartKey, { ...line, qty: Math.min(quantity, 999) });
  return next;
}

export function recordStorefrontCartChange(
  markChanged: () => void = noteInteraction,
): void {
  markChanged();
}

function money(v: string | number | null): string {
  if (v == null || v === "") return "0";
  return fmtInt(v);
}
function priceLabel(price: string | null): string {
  if (price == null || price === "") return "اسأل الموظّف";
  return `${money(price)} د.ع`;
}

function ProductImage({
  url,
  alt,
  className,
  showFallbackLabel = false,
}: {
  url: string | null;
  alt: string;
  className?: string;
  /** The catalogue grid has room to explain an absent image; compact rows do not. */
  showFallbackLabel?: boolean;
}) {
  if (!url) {
    return (
      <div
        className={`store-product-image-placeholder flex flex-col items-center justify-center gap-2 bg-emerald-50 text-emerald-700 dark:bg-slate-800 dark:text-emerald-300 ${className ?? ""}`}
        role="img"
        aria-label={`لا توجد صورة متاحة حالياً للمنتج: ${alt}`}
      >
        <ImageOff aria-hidden className="size-8" />
        {showFallbackLabel && <span className="text-center text-[11px] font-bold">صورة المنتج قريباً</span>}
      </div>
    );
  }
  return <img src={url} alt={alt} loading="lazy" decoding="async" className={`store-product-image object-contain ${className ?? ""}`} />;
}

/**
 * يعرض صور مكوّنات البكج بالمرجع من دون إنشاء نسخ جديدة منها.
 * الصورة التسويقية الخاصة بالبكج تبقى صاحبة الأولوية لأن الخادم لا يعيد
 * bundleImageUrls عند وجودها.
 */
export function BundleMedia({
  urls,
  fallbackUrl,
  alt,
  className,
  showFallbackLabel = false,
}: {
  urls?: string[];
  fallbackUrl: string | null;
  alt: string;
  className?: string;
  showFallbackLabel?: boolean;
}) {
  const componentImages = (urls ?? []).filter(Boolean).slice(0, 4);
  if (componentImages.length <= 1) {
    return (
      <ProductImage
        url={fallbackUrl ?? componentImages[0] ?? null}
        alt={alt}
        className={className}
        showFallbackLabel={showFallbackLabel}
      />
    );
  }

  return (
    <div
      className={`store-product-media grid grid-cols-2 grid-rows-2 overflow-hidden bg-slate-100 dark:bg-slate-800 ${className ?? ""}`}
      role="img"
      aria-label={`صور مكوّنات البكج: ${alt}`}
    >
      {componentImages.map((url, index) => (
        <img
          key={`${url}-${index}`}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full min-h-0 min-w-0 object-cover"
        />
      ))}
    </div>
  );
}

/** «تسوّق حسب القسم» — بطاقات فئات بصرية تقود التصفّح (نمط تجاريّ عالميّ). */
function CategoryTiles({ cats, onPick }: { cats: { id: number; name: string }[]; onPick: (id: number) => void }) {
  if (cats.length === 0) return null;
  return (
    <section className="mb-6">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">
        <LayoutGrid aria-hidden className="size-4 text-emerald-600" /> تسوّق حسب القسم
      </h3>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:gap-2.5">
        {cats.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className="group flex min-h-[92px] flex-col items-center gap-1.5 rounded-xl bg-white p-2.5 text-center ring-1 ring-slate-100 transition motion-safe:hover:-translate-y-0.5 hover:ring-emerald-300 dark:bg-slate-900 dark:ring-slate-800 dark:hover:ring-emerald-500/40"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 transition group-hover:bg-emerald-600 group-hover:text-white dark:bg-emerald-500/10 dark:text-emerald-400">
              <Store aria-hidden className="size-6" />
            </span>
            <span className="line-clamp-2 text-[11px] font-bold leading-tight text-slate-700 dark:text-slate-200">{c.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CategoryChipStrip({
  cats,
  selectedId,
  onPick,
}: {
  cats: { id: number; name: string }[];
  selectedId: number | null;
  onPick: (id: number | null) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const move = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(220, Math.floor(scroller.clientWidth * 0.65)), behavior: "smooth" });
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    dragRef.current = { active: true, startX: event.clientX, startScroll: scroller.scrollLeft, moved: false };
    scroller.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || !dragRef.current.active) return;
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 6) dragRef.current.moved = true;
    scroller.scrollLeft = dragRef.current.startScroll - delta;
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    dragRef.current.active = false;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { dragRef.current.moved = false; }, 0);
  };

  return (
    <div className="mx-auto flex max-w-[1500px] items-center gap-1.5 px-2 lg:px-6">
      <button type="button" onClick={() => move(1)} aria-label="مرر الأقسام إلى اليسار" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#ead8c8] bg-white text-[#25406f] shadow-sm transition hover:-translate-y-0.5 hover:border-[#e65f4a] active:scale-95">
        <ArrowRight aria-hidden className="size-4 rotate-180" />
      </button>
      <div
        ref={scrollerRef}
        dir="rtl"
        className="flex min-w-0 flex-1 cursor-grab touch-pan-x scroll-smooth gap-2 overflow-x-auto py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => { if (!dragRef.current.active) setPaused(false); }}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label="أقسام المنتجات — اسحب لاكتشاف المزيد"
      >
        <button type="button" onClick={() => onPick(null)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-black transition hover:-translate-y-0.5 active:scale-95 ${selectedId == null ? "border-[#25406f] bg-[#25406f] text-white shadow-sm" : "border-[#ead8c8] bg-white text-[#667078] hover:border-[#e65f4a] hover:text-[#25406f]"}`}>كل الأقسام</button>
        {cats.map((c, index) => (
          <button type="button" key={c.id} onClick={() => onPick(c.id)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold transition hover:-translate-y-0.5 active:scale-95 ${selectedId === c.id ? "border-[#e65f4a] bg-[#e65f4a] text-white shadow-sm" : index % 3 === 0 ? "border-[#f0d991] bg-[#fff8df] text-[#6d5524] hover:border-[#e65f4a]" : index % 3 === 1 ? "border-[#c5e8dc] bg-[#e9f7f2] text-[#276c5d] hover:border-[#25406f]" : "border-[#dfcdea] bg-[#f3ebf8] text-[#684c78] hover:border-[#25406f]"}`}>{c.name}</button>
        ))}
      </div>
      <button type="button" onClick={() => move(-1)} aria-label="مرر الأقسام إلى اليمين" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#ead8c8] bg-white text-[#25406f] shadow-sm transition hover:-translate-y-0.5 hover:border-[#e65f4a] active:scale-95">
        <ArrowRight aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/**
 * سواتش ألوان المنتج (اسم + لون حقيقي «#RRGGBB» + توفّر) — صفّ نقاط صغيرة على البطاقة/التفاصيل.
 * تُعرَض ألوان المنتج **كاملةً** بما فيها النافدة، لكنّ النافد يظهر **باهتاً بلا تشبّع** مع وسم «نافد»
 * في التلميح/قارئ الشاشة — فيرى الزبون نطاق الألوان كاملاً دون أن يُضلَّل عن توفّرها.
 */
function ColorSwatches({ colors, max = 6, size = 12 }: { colors?: { name: string; hex: string; inStock: boolean }[]; max?: number; size?: number }) {
  if (!colors || colors.length === 0) return null;
  const shown = colors.slice(0, max);
  const extra = colors.length - shown.length;
  return (
    <div className="flex items-center gap-1" title={`ألوان المنتج: ${colors.map((c) => (c.inStock ? c.name : `${c.name} (نافد)`)).join("، ")}`}>
      {shown.map((c) => {
        const label = c.inStock ? c.name : `${c.name} — نافد`;
        return (
          <span
            key={`${c.hex}-${c.name}`}
            role="img"
            className={`inline-block shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/25${c.inStock ? "" : " opacity-30 grayscale"}`}
            style={{ width: size, height: size, background: c.hex }}
            title={label}
            aria-label={label}
          />
        );
      })}
      {extra > 0 && <span className="text-[9px] font-bold text-slate-400">+{extra}</span>}
    </div>
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
  bundleImageUrls?: string[];
  unitName: string;
  inStock?: boolean;
};
function ProductRowCard({ p, onSelect, onAdd, recentlyAdded = false }: { p: RowProduct; onSelect: () => void; onAdd: () => void; recentlyAdded?: boolean }) {
  const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price);
  const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0;
  return (
    <div className="store-product-card flex w-[150px] shrink-0 flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-100 sm:w-[168px] lg:w-[184px] dark:bg-slate-900 dark:ring-slate-800">
      <button onClick={onSelect} className="relative block text-right">
        <BundleMedia urls={p.bundleImageUrls} fallbackUrl={p.imageUrl} alt={p.productName} className="aspect-[1.12/1] w-full" />
        {onSale && pct > 0 && (
          <span className="absolute right-2 top-2 rounded-full bg-[#c94736] px-2 py-0.5 text-[11px] font-extrabold text-white shadow">−{pct}٪</span>
        )}
        {p.inStock === false && (
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-[11px] font-bold text-white">غير متوفّر</span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-2">
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
          className={`store-primary-action store-mobile-action mt-auto flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-bold text-white transition motion-safe:active:scale-95 ${recentlyAdded ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-500 hover:bg-amber-600"} disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800`}
        >
          {recentlyAdded ? <Check aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />} {p.inStock === false ? "غير متوفّر" : recentlyAdded ? "تمت الإضافة" : "أضف للسلة"}
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
  recentlyAddedId,
}: {
  title: string;
  icon: React.ReactNode;
  products: RowProduct[];
  onSelect: (id: number) => void;
  onAdd: (p: RowProduct) => void;
  recentlyAddedId?: number | null;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || products.length < 4) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      if (paused || document.hidden) return;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      if (maxScroll <= 4) return;
      const atEnd = Math.abs(scroller.scrollLeft) >= maxScroll - 4;
      if (atEnd) {
        scroller.scrollTo({ left: 0, behavior: "smooth" });
        return;
      }
      scroller.scrollBy({ left: -Math.max(220, Math.floor(scroller.clientWidth * 0.72)), behavior: "smooth" });
    }, 4200);
    return () => window.clearInterval(timer);
  }, [paused, products.length]);

  if (products.length === 0) return null;
  const moveRow = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(220, Math.floor(scroller.clientWidth * 0.72)), behavior: "smooth" });
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    dragRef.current = { active: true, startX: event.clientX, startScroll: scroller.scrollLeft, moved: false };
    scroller.setPointerCapture(event.pointerId);
    setPaused(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || !dragRef.current.active) return;
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 6) dragRef.current.moved = true;
    scroller.scrollLeft = dragRef.current.startScroll - delta;
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    dragRef.current.active = false;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { dragRef.current.moved = false; }, 0);
    setPaused(false);
  };
  return (
    <section className="mb-5 min-w-0">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">{icon} {title}</h3>
        <div className="flex items-center gap-1" aria-label={`تنقل ${title}`}>
          <button type="button" onClick={() => moveRow(1)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} className="flex size-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700" aria-label={`مرر ${title} إلى اليسار`}><ArrowRight aria-hidden className="size-4 rotate-180" /></button>
          <button type="button" onClick={() => moveRow(-1)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} className="flex size-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700" aria-label={`مرر ${title} إلى اليمين`}><ArrowRight aria-hidden className="size-4" /></button>
        </div>
      </div>
      <div
        ref={scrollerRef}
        dir="rtl"
        className="flex min-w-0 cursor-grab touch-pan-y scroll-smooth gap-2.5 overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => { if (!dragRef.current.active) setPaused(false); }}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label={`${title} — اسحب لاكتشاف المزيد`}
      >
        {products.map((p) => (
          <ProductRowCard key={p.productId} p={p} onSelect={() => onSelect(p.productId)} onAdd={() => onAdd(p)} recentlyAdded={recentlyAddedId === p.productId} />
        ))}
      </div>
    </section>
  );
}

type RelatedProduct = {
  productId: number;
  productName: string;
  imageUrl: string | null;
  price: string | null;
  salePrice?: string | null;
};

function RelatedProductStrip({ products, onSelect }: { products: RelatedProduct[]; onSelect: (id: number) => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const move = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(180, Math.floor(scroller.clientWidth * 0.72)), behavior: "smooth" });
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    dragRef.current = { active: true, startX: event.clientX, startScroll: scroller.scrollLeft, moved: false };
    scroller.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || !dragRef.current.active) return;
    const delta = event.clientX - dragRef.current.startX;
    if (Math.abs(delta) > 6) dragRef.current.moved = true;
    scroller.scrollLeft = dragRef.current.startScroll - delta;
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    dragRef.current.active = false;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { dragRef.current.moved = false; }, 0);
  };

  return (
    <div className="mt-5 min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-200">قد يعجبك أيضاً</h3>
        <div className="flex items-center gap-1" aria-label="تنقل المنتجات المقترحة">
          <button type="button" onClick={() => move(1)} className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 active:scale-95" aria-label="مرر المنتجات المقترحة إلى اليسار"><ArrowRight aria-hidden className="size-3.5 rotate-180" /></button>
          <button type="button" onClick={() => move(-1)} className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 active:scale-95" aria-label="مرر المنتجات المقترحة إلى اليمين"><ArrowRight aria-hidden className="size-3.5" /></button>
        </div>
      </div>
      <div
        ref={scrollerRef}
        dir="rtl"
        className="flex min-w-0 cursor-grab touch-pan-y scroll-smooth gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label="منتجات مقترحة — اسحب لاكتشاف المزيد"
      >
        {products.map((rp) => (
          <div key={rp.productId} className="store-product-card flex min-w-[120px] max-w-[130px] shrink-0 flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
            <button type="button" onClick={() => onSelect(rp.productId)} className="text-right">
              <ProductImage url={rp.imageUrl} alt={rp.productName} className="store-product-media aspect-square w-full" />
            </button>
            <div className="flex flex-1 flex-col gap-1 p-2">
              <span className="line-clamp-2 min-h-[2.2em] text-[11px] font-bold leading-tight">{rp.productName}</span>
              <span className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">{priceLabel(rp.salePrice ?? rp.price)}</span>
              <button type="button" onClick={() => onSelect(rp.productId)} className="store-primary-action store-mobile-action mt-0.5 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-bold transition motion-safe:active:scale-95"><Plus aria-hidden className="size-3" /> اختر</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** بنر إعلانيّ ديناميكيّ: كاروسيل يتبدّل تلقائياً كل ٥ث (crossfade آمنٌ لـRTL) + نقاط تنقّل +
 *  ارتفاعٌ متجاوب (auto-scale). يُشتقّ من بنرات لوحة hPanel؛ بنرٌ واحد ⇒ يُعرَض ثابتاً بلا نقاط. */
type BannerItem = StoreBannerCreative;

/**
 * فاصل تسويقي عرضي داخل شبكة المنتجات (placement=INLINE) — يقطع سيل المنتجات كل عشرة أصناف
 * بشريط ترويجي (نمط in-feed banner العالمي: أمازون/علي إكسبرس). `col-span-full` يمتدّ على كامل
 * أعمدة الشبكة أياً كان عددها المتجاوب.
 */
function InlineStrip({ banner }: { banner: BannerItem; tone?: "emerald" | "amber" }) {
  return (
    <div className="relative col-span-full aspect-[3/1] overflow-hidden rounded-xl shadow-sm">
      <BannerFrame banner={banner} slot="INLINE" />
    </div>
  );
}
function BannerCarousel({ banners, slot = "HERO", className = "" }: { banners: BannerItem[]; slot?: "HERO" | "INLINE"; className?: string }) {
  const [cur, setCur] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (banners.length <= 1 || paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setCur((i) => (i + 1) % banners.length), 4500);
    return () => clearInterval(t);
  }, [banners.length, paused]);
  useEffect(() => {
    setCur((current) => Math.min(current, Math.max(0, banners.length - 1)));
  }, [banners.length]);
  if (banners.length === 0) return null;
  const active = cur % banners.length;
  const aspect = slot === "HERO" ? "aspect-[2/1]" : "aspect-[3.2/1]";
  return (
    <section
      className={`mb-4 ${className}`}
      aria-roledescription="carousel"
      aria-label={slot === "HERO" ? "العروض الرئيسية" : "العروض الترويجية بين المنتجات"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onPointerDown={() => setPaused(true)}
    >
      <div className={`relative overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5 ${aspect}`}>
        {banners.map((b, i) => (
          <div key={`${b.id}-${b.imageIndex ?? 0}`} className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${i === active ? "opacity-100" : "pointer-events-none opacity-0"}`}>
            <BannerFrame banner={b} slot={slot} active={i === active} />
          </div>
        ))}
        {banners.length > 1 && <span className="absolute right-3 top-3 rounded-full bg-[#183d36]/85 px-2.5 py-1 text-[10px] font-black text-white shadow-sm">{active + 1} / {banners.length}</span>}
      </div>
      {banners.length > 1 && (
        <div className="mt-2.5 flex justify-center gap-1.5" role="tablist" aria-label="اختيار البنر">
          {banners.map((b, i) => (
            <button
              type="button"
              key={`${b.id}-${b.imageIndex ?? 0}`}
              onClick={() => { setCur(i); setPaused(true); }}
              role="tab"
              aria-selected={i === active}
              aria-label={`الانتقال للبنر ${i + 1}`}
              className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${i === active ? "w-5 bg-[#f05d53]" : "w-1.5 bg-[#f3b85a]/60 hover:bg-[#f05d53]"}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type Panel = null | "cart" | "checkout" | "confirmation" | "track" | "label";
export type AvailabilityFilter = "IN_STOCK" | "ALL";
type PriceFilter = "ALL" | "UNDER_5000" | "FROM_5000_TO_15000" | "OVER_15000";
type CatalogSort = "RECOMMENDED" | "PRICE_ASC" | "PRICE_DESC" | "BEST_SELLERS";
export type StorefrontSource = "settings" | "categories" | "offers" | "catalog";

const STOREFRONT_SOURCE_LABELS: Record<StorefrontSource, string> = {
  settings: "إعدادات المتجر",
  categories: "الفئات والأقسام",
  offers: "العروض",
  catalog: "المنتجات",
};

/**
 * يبقي فشل كل مصدرٍ علنيّ حالةً مستقلة وصريحة. لا يجوز تحويل خطأ API إلى [] ثم وصفه
 * للزبون بأنه «لا توجد فئات/عروض/منتجات»؛ الفراغ التجاري الصحيح لا يأتي إلا بعد نجاح الطلب.
 */
export function collectStorefrontFailures(
  failed: Record<StorefrontSource, boolean>,
): StorefrontSource[] {
  return (Object.keys(STOREFRONT_SOURCE_LABELS) as StorefrontSource[]).filter(
    (source) => failed[source],
  );
}

export function storefrontCategoryCount(
  category: { productCount: number; availableCount?: number },
  availability: AvailabilityFilter,
): number {
  return availability === "IN_STOCK"
    ? (category.availableCount ?? category.productCount)
    : category.productCount;
}

export function shouldAutoLoadStorefrontNextPage(input: {
  isIntersecting: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
}): boolean {
  return input.isIntersecting && input.hasNextPage && !input.isFetchingNextPage && !input.isError;
}

function matchesPriceFilter(price: number, filter: PriceFilter): boolean {
  switch (filter) {
    case "UNDER_5000": return price < 5_000;
    case "FROM_5000_TO_15000": return price >= 5_000 && price <= 15_000;
    case "OVER_15000": return price > 15_000;
    default: return true;
  }
}

export default function Storefront() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  // البدء بالمتوفر يحمي نية الشراء: لا نُغرق العميل ببطاقات لا يمكن إضافتها للسلة.
  const [availability, setAvailability] = useState<AvailabilityFilter>("IN_STOCK");
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("ALL");
  const [brand, setBrand] = useState("");
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recentlyAddedProductId, setRecentlyAddedProductId] = useState<number | null>(null);
  const [selectedStoreUnitId, setSelectedStoreUnitId] = useState<number | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  // اختيار متعدد للمتغيرات في ورقة المنتج. المفتاح هو وحدة البيع، لا معرّف المتغير،
  // كي لا تختلط وحدات مختلفة للون نفسه داخل السلة أو عند التسعير الخادمي.
  const [variantQuantities, setVariantQuantities] = useState<Map<number, number>>(new Map());
  const [customizationDraft, setCustomizationDraft] = useState<StorefrontCustomization>({ kind: "PRINT" });
  const [panel, setPanel] = useState<Panel>(null);
  const [cart, setCart] = useState<Map<string, CartLine>>(loadCart);

  const [form, setForm] = useState<CheckoutForm>(loadForm);
  const cartRef = useRef(cart);
  const formRef = useRef(form);
  cartRef.current = cart;
  formRef.current = form;
  const [checkoutAttempt, setCheckoutAttempt] = useState<StorefrontCheckoutAttempt | null>(loadCheckoutAttempt);
  const checkoutAttemptRef = useRef(checkoutAttempt);
  const orderInFlightRef = useRef(false);
  const acceptedQuoteRef = useRef<{ fingerprint: string; total: string } | null>(null);
  checkoutAttemptRef.current = checkoutAttempt;
  const [checkoutSafetyError, setCheckoutSafetyError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [confirmation, setConfirmation] = useState<{
    orderNumber: string;
    total: string;
    reservationExpiresAt: Date | string;
  } | null>(null);
  const viewedProductIds = useRef(new Set<number>());
  const catalogLoadMoreRef = useRef<HTMLDivElement | null>(null);

  // تتبّع الطلب العلنيّ — نموذجٌ برقم الطلب + الهاتف يستدعي storefront.trackOrder عند الطلب.
  const utils = trpc.useUtils();
  const [trackForm, setTrackForm] = useState<{ orderNumber: string; phone: string }>({ orderNumber: "", phone: "+964" });
  const [trackResult, setTrackResult] = useState<TrackData | null>(null);
  const [trackState, setTrackState] = useState<"idle" | "loading" | "notfound" | "error">("idle");
  const labelParams = useMemo(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const orderNumber = q.get("order");
    const token = q.get("token");
    return orderNumber && token ? { orderNumber, token } : null;
  }, []);
  const openTrack = (orderNumber = "") => {
    setTrackForm({ orderNumber, phone: "+964" });
    setTrackResult(null);
    setTrackState("idle");
    setPanel("track");
  };
  const doTrack = async () => {
    const orderNumber = trackForm.orderNumber.trim();
    const phone = trackForm.phone.trim();
    if (!orderNumber || phone.replace(/\D/g, "").length <= 3) return;
    setTrackState("loading");
    setTrackResult(null);
    try {
      const r = await utils.storefront.trackOrder.fetch({ orderNumber, phone });
      if (r) { setTrackResult(r); setTrackState("idle"); }
      else { setTrackState("notfound"); }
    } catch {
      setTrackState("error");
    }
  };

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

  // استمرار السلة + بيانات التوصيل عبر تحديث الصفحة/إغلاق التطبيق (localStorage). طلب التحديث
  // الآمن يستدعي الحافظ المتزامن أدناه ويأخذ نتيجة صريحة؛ امتلاء التخزين لا يعود فشلاً صامتاً.
  useEffect(() => {
    saveStorefrontSnapshot(cart, form, localStorage, checkoutAttempt);
  }, [cart, form, checkoutAttempt]);
  useEffect(() => {
    const persist = (event: Event) => {
      const detail = (event as CustomEvent<{ report: (saved: boolean, state?: { inFlight: boolean }) => void }>).detail;
      detail?.report(
        saveStorefrontSnapshot(cartRef.current, formRef.current, localStorage, checkoutAttemptRef.current),
        { inFlight: orderInFlightRef.current },
      );
    };
    window.addEventListener(STOREFRONT_PERSIST_REQUEST_EVENT, persist);
    return () => window.removeEventListener(STOREFRONT_PERSIST_REQUEST_EVENT, persist);
  }, []);

  const categoriesQ = trpc.storefront.categories.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const offersQ = trpc.storefront.offers.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const bannersQ = trpc.storefront.banners.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const settingsQ = trpc.storefront.settings.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  // يطبّق الخادم مرشح التوفر قبل حدّ الصفحة. useInfiniteQuery يمرّر nextCursor فقط عند
  // «تحميل المزيد»، فتصل كل المنتجات المنشورة بلا سقف 120 صامت ولا تكرار بطاقات.
  const catalogInput = {
    categoryId,
    search: search || undefined,
    limit: 48,
    availability,
  } as const;
  const catalogQ = trpc.storefront.catalog.useInfiniteQuery(
    catalogInput,
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      placeholderData: (prev) => prev,
    },
  );
  const detailQ = trpc.storefront.product.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });
  const labelQ = trpc.storefront.labelSummary.useQuery(labelParams ?? { orderNumber: "-", token: "-" }, { enabled: labelParams != null, retry: false });
  const relatedQ = trpc.storefront.related.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });
  const trackConversion = trpc.storefront.trackConversion.useMutation();

  // كل فتح متعمد لتفاصيل منتج = مشاهدة؛ لا نرسل اسم المنتج أو هويّة/جلسة الزائر.
  useEffect(() => {
    if (selectedId != null && !viewedProductIds.current.has(selectedId)) {
      viewedProductIds.current.add(selectedId);
      trackConversion.mutate({ event: "PRODUCT_VIEW" });
    }
  // useMutation يعيد مرجعاً مستقراً؛ ربط الحدث بالمُنتج فقط يمنع إعادة عدّه عند كل render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const createOrder = trpc.storefront.createOrder.useMutation({
    onMutate: () => {
      orderInFlightRef.current = true;
      setCheckoutSafetyError(null);
    },
    onSuccess: (res) => {
      orderInFlightRef.current = false;
      setTurnstileToken(null);
      checkoutAttemptRef.current = null;
      acceptedQuoteRef.current = null;
      setCheckoutAttempt(null);
      saveCheckoutAttempt(null);
      setConfirmation({
        orderNumber: res.orderNumber,
        total: res.total,
        reservationExpiresAt: res.reservationExpiresAt,
      });
      setCart(new Map());
      // امسح بيانات التوصيل (اسم/هاتف/عنوان) من الحالة و localStorage بعد نجاح الطلب (مراجعة عدائية
      // ١٢/٧): المتجر علنيّ بلا جلسة ⇒ إبقاؤها يسرّبها للزبون التالي على جهازٍ مشترك/كشك. الاستعادة
      // عبر التحديث تخصّ طلباً قيد الإنشاء فقط، لا بعد إتمامه.
      setForm({ ...DEFAULT_FORM });
      setPanel("confirmation");
    },
    onError: async (error) => {
      orderInFlightRef.current = false;
      // token أحادي الاستعمال: أي رد خطأ/ضائع يحتاج challenge جديداً. إن كان الطلب قد
      // التزم فعلاً فـowned replay الخادمي يسبق استهلاك token الجديد.
      setTurnstileToken(null);
      setTurnstileResetKey((key) => key + 1);
      if (error.data?.code === "CONFLICT") {
        const failedAttempt = checkoutAttemptRef.current;
        checkoutAttemptRef.current = null;
        acceptedQuoteRef.current = null;
        setCheckoutAttempt(null);
        saveCheckoutAttempt(null);
        await Promise.all([
          utils.storefront.catalog.invalidate(),
          utils.storefront.offers.invalidate(),
          utils.storefront.settings.invalidate(),
          utils.storefront.product.invalidate(),
          utils.storefront.quoteOrder.invalidate(),
        ]);
        try {
          const quoted = await utils.storefront.quoteOrder.fetch({
            governorate: formRef.current.governorate,
            lines: Array.from(cartRef.current.values()).map((line) => ({
              productUnitId: line.productUnitId,
              quantity: line.qty,
            })),
          });
          const refreshedQuote = reconcileStorefrontCartQuote(cartRef.current, quoted.lines);
          const totalChanged = failedAttempt == null ||
            Number(quoted.total).toFixed(2) !== Number(failedAttempt.expectedGrandTotal).toFixed(2);
          if (refreshedQuote.unresolved === 0 && (refreshedQuote.priceChanged > 0 || totalChanged)) {
            cartRef.current = refreshedQuote.cart;
            setCart(refreshedQuote.cart);
            acceptedQuoteRef.current = {
              fingerprint: storefrontCheckoutFingerprint(refreshedQuote.cart, formRef.current),
              total: quoted.total,
            };
            setCheckoutSafetyError(
              refreshedQuote.priceChanged > 0
                ? `تحديث سعر ${refreshedQuote.priceChanged} من أصناف السلة. راجع الإجمالي الجديد ثم اضغط «تأكيد الطلب» للموافقة عليه.`
                : "تغيّر إجمالي الطلب أو التوصيل. راجع الإجمالي الجديد ثم اضغط «تأكيد الطلب» للموافقة عليه.",
            );
            return;
          }
        } catch {
          // إذا لم يعد الصنف منشوراً، يسقط المسار إلى reconciliation التفاصيل أدناه لحذفه صراحةً.
        }
        const productIds = Array.from(new Set(Array.from(cartRef.current.values()).map((line) => line.productId)));
        const latestEntries = await Promise.all(productIds.map(async (productId) => {
          try {
            return [productId, await utils.storefront.product.fetch({ productId })] as const;
          } catch {
            return [productId, undefined] as const;
          }
        }));
        const refreshed = reconcileStorefrontCartPricing(
          cartRef.current,
          new Map(latestEntries),
        );
        if (refreshed.priceChanged > 0 || refreshed.unavailable > 0) {
          cartRef.current = refreshed.cart;
          setCart(refreshed.cart);
          const changes = [
            refreshed.priceChanged > 0 ? `تحديث سعر ${refreshed.priceChanged} من أصناف السلة` : null,
            refreshed.unavailable > 0 ? `إزالة ${refreshed.unavailable} لم يعد متاحاً` : null,
          ].filter(Boolean).join("، ");
          setCheckoutSafetyError(`${changes}. راجع الإجمالي الجديد ثم اضغط «تأكيد الطلب» للموافقة عليه.`);
        } else if (refreshed.unresolved > 0) {
          setCheckoutSafetyError("تغيّرت بيانات الطلب وتعذّر جلب بعض الأسعار الجديدة. تحقق من الاتصال ثم أعد المحاولة.");
        } else {
          setCheckoutSafetyError(error.message);
        }
      }
    },
    onSettled: () => {
      orderInFlightRef.current = false;
    },
  });

  const detailVariant = useMemo(() => {
    const variants = detailQ.data?.variants ?? [];
    return variants.find((v) => v.variantId === selectedVariantId) ?? variants.find((v) => v.inStock) ?? variants[0] ?? null;
  }, [detailQ.data, selectedVariantId]);
  const detailUnit = useMemo(() => {
    const product = detailQ.data;
    if (!product) return null;
    const options = detailVariant?.units ?? product.storeUnits ?? [];
    return options.find((u) => u.productUnitId === selectedStoreUnitId) ?? options[0] ?? {
      productUnitId: product.productUnitId,
      unitName: product.unitName,
      conversionFactor: "1",
      price: product.price,
      salePrice: product.salePrice,
      promotionName: product.promotionName,
      inStock: product.inStock,
      stockLeft: product.stockLeft,
    };
  }, [detailQ.data, detailVariant, selectedStoreUnitId]);
  const customizationPreviewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "customization";
  const previewCustomizationTemplate = customizationPreviewMode && detailQ.data?.category === "المطبوعات التجارية"
    ? {
        id: 0,
        kind: "PRINT" as const,
        title: "خصّص طلبك قبل الإضافة",
        description: "وضع معاينة تطويري فقط — القالب الحقيقي يأتي من الخادم بعد تطبيق الهجرة.",
        fields: [
          { id: 0, fieldKey: "service", label: "نوع التنفيذ", fieldType: "SELECT" as const, isRequired: true, sortOrder: 10, maxLength: null, priceDelta: "0", dependency: null, options: [{ value: "text", label: "اسم أو عبارة", priceDelta: "0" }, { value: "file", label: "صورة أو تصميم", priceDelta: "0" }, { value: "full", label: "طباعة كاملة", priceDelta: "0" }] },
          { id: 1, fieldKey: "packaging", label: "التغليف", fieldType: "SELECT" as const, isRequired: false, sortOrder: 20, maxLength: null, priceDelta: "0", dependency: null, options: [{ value: "standard", label: "تغليف عادي", priceDelta: "0" }, { value: "gift", label: "تغليف هدية", priceDelta: "0" }] },
          { id: 2, fieldKey: "message", label: "رسالة أو تفاصيل إضافية", fieldType: "TEXTAREA" as const, isRequired: false, sortOrder: 30, maxLength: 300, priceDelta: "0", dependency: { fieldKey: "service", operator: "equals" as const, value: ["text", "full"] }, options: [] },
          { id: 3, fieldKey: "designFile", label: "مرجع ملف التصميم", fieldType: "FILE" as const, isRequired: true, sortOrder: 40, maxLength: null, priceDelta: "0", dependency: { fieldKey: "service", operator: "equals" as const, value: ["file", "full"] }, options: [] },
        ],
      }
    : null;
  const customizationConfig = useMemo(
    () => detailQ.data
      ? getStorefrontCustomizationConfig(
          detailQ.data.isCustomizable === true || previewCustomizationTemplate != null,
          detailQ.data.customizationKind ?? (previewCustomizationTemplate ? "PRINT" : null),
          detailQ.data.customizationTemplate ?? previewCustomizationTemplate,
        )
      : null,
    [detailQ.data, previewCustomizationTemplate],
  );
  const customizationValues = customizationDraft.values ?? {};
  const visibleCustomizationFields = useMemo(
    () => (customizationConfig?.fields ?? []).filter((field) => dependencyMatches(field.dependency, customizationValues)),
    [customizationConfig, customizationValues],
  );
  const customizationValidation = useMemo(() => {
    if (!customizationConfig) return null;
    for (const field of visibleCustomizationFields) {
      const value = customizationValues[field.fieldKey]?.trim() ?? "";
      if (field.isRequired && !value) return `أكمل الحقل «${field.label}» قبل الإضافة`;
      if (["SELECT", "SWATCH"].includes(field.fieldType) && value && !field.options.some((option) => option.value === value)) {
        return `اختر قيمة صحيحة للحقل «${field.label}»`;
      }
      if (field.maxLength && value.length > field.maxLength) return `الحقل «${field.label}» يتجاوز الحد المسموح`;
    }
    return null;
  }, [customizationConfig, visibleCustomizationFields, customizationValues]);
  function updateCustomizationField(field: StorefrontCustomizationField, value: string) {
    setCustomizationDraft((previous) => {
      const values = { ...(previous.values ?? {}), [field.fieldKey]: value };
      for (const candidate of customizationConfig?.fields ?? []) {
        if (candidate.fieldKey !== field.fieldKey && !dependencyMatches(candidate.dependency, values)) delete values[candidate.fieldKey];
      }
      const next: StorefrontCustomization = { ...previous, kind: customizationConfig?.kind ?? previous.kind, values };
      if (field.fieldKey === "service") {
        next.service = value;
        next.serviceLabel = field.options.find((option) => option.value === value)?.label;
      }
      if (field.fieldKey === "packaging") next.packaging = value as "standard" | "gift";
      if (field.fieldKey === "recipient") next.recipient = value;
      if (field.fieldKey === "message") next.message = value;
      if (field.fieldKey === "designFile") next.uploadName = value;
      return next;
    });
  }
  function selectedCustomization(): StorefrontCustomization | undefined {
    if (!customizationConfig) return undefined;
    const value = { ...customizationDraft, kind: customizationConfig.kind, values: { ...(customizationDraft.values ?? {}) } };
    const hasDetail = Object.values(value.values ?? {}).some((item) => Boolean(item?.trim()));
    return hasDetail ? value : undefined;
  }

  useEffect(() => {
    setSelectedStoreUnitId(null);
    setSelectedVariantId(null);
    setVariantQuantities(new Map());
    setCustomizationDraft({ kind: "PRINT", values: {} });
  }, [selectedId]);

  useEffect(() => {
    if (labelQ.data) setPanel("label");
  }, [labelQ.data]);

  const items = useMemo(() => (catalogQ.data?.pages ?? []).flatMap((page) => page.items), [catalogQ.data]);
  useEffect(() => {
    const sentinel = catalogLoadMoreRef.current;
    if (!sentinel || !catalogQ.hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (shouldAutoLoadStorefrontNextPage({
          isIntersecting: entries.some((entry) => entry.isIntersecting),
          hasNextPage: catalogQ.hasNextPage,
          isFetchingNextPage: catalogQ.isFetchingNextPage,
          isError: catalogQ.isError,
        })) {
          void catalogQ.fetchNextPage();
        }
      },
      { rootMargin: "520px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [catalogQ.fetchNextPage, catalogQ.hasNextPage, catalogQ.isError, catalogQ.isFetchingNextPage]);
  // فشل صفحة لاحقة لا يمحو ما رآه الزائر بالفعل؛ حالة الخطأ الكاملة تخص الصفحة الأولى فقط.
  const catalogInitialError = catalogQ.isError && items.length === 0;
  const cats = categoriesQ.data ?? [];
  const offers = offersQ.data ?? [];
  const banners = bannersQ.data ?? [];
  const sourceFailures = collectStorefrontFailures({
    settings: settingsQ.isError,
    categories: categoriesQ.isError,
    offers: offersQ.isError,
    catalog: catalogInitialError,
  });
  const supportingFailures = sourceFailures.filter(
    (source) => source !== "catalog",
  );
  // توزيع البنرات على مواضعها الثلاثة (الصفوف القديمة بلا placement = رئيسي).
  const heroBanners = useMemo(() => banners.filter((b) => (b.placement ?? "HERO") === "HERO"), [banners]);
  const inlineBanners = useMemo(() => banners.filter((b) => b.placement === "INLINE"), [banners]);
  const announcement = settingsQ.data?.announcement ?? null;
  // الفشل المغلق: لا نسمح بإرسال طلب قبل معرفة حالة المتجر فعلياً. خطأ الإعدادات له
  // تنبيه مستقل أدناه، فلا يتنكر في هيئة «مفتوح» ولا «مغلق».
  const storeOpen = settingsQ.isSuccess && settingsQ.data.isOpen;
  const orderingEnabled =
    settingsQ.isSuccess && settingsQ.data.orderingEnabled === true;
  const activeCatName = useMemo(
    () => (categoryId == null ? null : cats.find((c) => c.id === categoryId)?.name ?? null),
    [categoryId, cats]
  );
  const brands = useMemo(
    () => Array.from(new Set(items.map((p) => p.brand?.trim()).filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b, "ar")),
    [items]
  );
  const filteredItems = useMemo(() => {
    const filtered = items.filter((p) => {
      if (availability === "IN_STOCK" && !p.inStock) return false;
      if (brand && p.brand !== brand) return false;
      return matchesPriceFilter(Number(p.salePrice ?? p.price ?? 0), priceFilter);
    });
    if (sort === "RECOMMENDED") return filtered;
    return [...filtered].sort((a, b) => {
      if (sort === "BEST_SELLERS") return (b.soldCount ?? 0) - (a.soldCount ?? 0);
      const aPrice = Number(a.salePrice ?? a.price ?? 0);
      const bPrice = Number(b.salePrice ?? b.price ?? 0);
      return sort === "PRICE_ASC" ? aPrice - bPrice : bPrice - aPrice;
    });
  }, [availability, brand, items, priceFilter, sort]);
  const hasRefinements = availability !== "IN_STOCK" || priceFilter !== "ALL" || brand !== "" || sort !== "RECOMMENDED";
  // catalog يُرشّح البحث والفئة خادمياً، بينما السعر/الماركة عميلان. غياب العناصر من الصفحة الأولى
  // يعني كتالوجاً فارغاً حقاً؛ وأي غياب مع بحث/فئة/تنقيح يعني صفراً بسبب التصفية.
  const isEmptyCatalog = items.length === 0 && !search && categoryId == null;

  function scrollToResults() {
    window.setTimeout(() => document.getElementById("store-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
  function selectCategory(id: number | null) {
    setCategoryId(id);
    scrollToResults();
  }
  function clearRefinements() {
    setAvailability("IN_STOCK");
    setPriceFilter("ALL");
    setBrand("");
    setSort("RECOMMENDED");
  }
  function clearCatalogFilters() {
    setRawSearch("");
    setSearch("");
    setCategoryId(null);
    clearRefinements();
  }
  function retrySupportingSources() {
    const retries: Promise<unknown>[] = [];
    if (settingsQ.isError) retries.push(settingsQ.refetch());
    if (categoriesQ.isError) retries.push(categoriesQ.refetch());
    if (offersQ.isError) retries.push(offersQ.refetch());
    void Promise.allSettled(retries);
  }
  // فواصل السيل التسويقية: بنرات INLINE المُدارة أولاً، وعند غيابها تُشتقّ من عروض اليوم الفعّالة
  // (فلسفة in-feed العالمية: لا يمرّ الزبون بأكثر من ~عشرة منتجات دون محفّز شراء).
  const feedStrips = useMemo<BannerItem[]>(() => {
    if (inlineBanners.length) return inlineBanners;
    if (offers.length) {
      return offers.slice(0, 4).map((o) => ({
        id: -o.id,
        title: o.name,
        subtitle: o.type === "PERCENT" ? `خصم ${Number(o.discountPercent)}٪` : `خصم ${money(o.discountAmount)} د.ع`,
        ctaLabel: "عرض اليوم",
      }));
    }
    // إذا لم تُعرّف لوحة الإدارة مواضع INLINE بعد، نعيد استخدام حملات HERO الحقيقية
    // في الفواصل البينية حتى لا يبقى مسار الشراء بلا محفّز ترويجي.
    return heroBanners.slice(1, 4);
  }, [heroBanners, inlineBanners, offers]);

  // أقسام البيع الموجّه تُشتق من المنتجات الحية فقط. لا نعرض في صفٍّ تسويقي منتجاً لا يمكن شراؤه؛
  // فلا تتحول حملة «الأكثر مبيعاً» أو «الباقات» إلى طريق مسدود للزبون.
  const dealProducts = useMemo(
    () => items.filter((p) => p.inStock && p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price)).slice(0, 12),
    [items]
  );
  const dealProductIds = useMemo(() => new Set(dealProducts.map((p) => p.productId)), [dealProducts]);
  const bestSellers = useMemo(
    () => [...items]
      .filter((p) => p.inStock && !dealProductIds.has(p.productId) && (p.soldCount ?? 0) > 0)
      .sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0))
      .slice(0, 12),
    [dealProductIds, items]
  );
  const bundleProducts = useMemo(
    () => [...items]
      .filter((p) => p.inStock && p.isBundle && !dealProductIds.has(p.productId))
      .sort((a, b) => (b.soldCount ?? 0) - (a.soldCount ?? 0))
      .slice(0, 12),
    [dealProductIds, items]
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
    salePrice?: string | null; imageUrl: string | null; unitName: string; variantLabel?: string; inStock?: boolean; customization?: StorefrontCustomization;
  }) {
    const eff = p.salePrice ?? p.price;
    if (eff == null || p.inStock === false) return;
    trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    setCart((prev) => addStorefrontCartLine(prev, p, eff));
  }
  function addFeaturedToCart(p: RowProduct) {
    if (p.inStock === false || (p.salePrice == null && p.price == null)) return;
    addToCart(p);
    setRecentlyAddedProductId(p.productId);
    window.setTimeout(() => setRecentlyAddedProductId((current) => current === p.productId ? null : current), 1600);
  }

  function setVariantQuantity(productUnitId: number, quantity: number) {
    setVariantQuantities((previous) => {
      const next = new Map(previous);
      if (quantity <= 0) next.delete(productUnitId);
      else next.set(productUnitId, Math.min(Math.trunc(quantity), 999));
      return next;
    });
  }
  function addSelectedVariants() {
    if (!detailQ.data || customizationValidation) return;
    const selections: StorefrontCartSelection[] = [];
    const customization = selectedCustomization();
    for (const variant of detailQ.data.variants ?? []) {
      // كل وحدة بيع لها مخزون وسعر مستقلان: نضيف كل لون/قياس/تعبئة اختار الزبون كخط مستقل.
      for (const unit of variant.units) {
        const quantity = variantQuantities.get(unit.productUnitId) ?? 0;
        const effectivePrice = unit.salePrice ?? unit.price;
        if (!unit.inStock || !effectivePrice || quantity <= 0) continue;
        selections.push({
          productUnitId: unit.productUnitId,
          productId: detailQ.data.productId,
          productName: detailQ.data.productName,
          imageUrl: detailQ.data.imageUrl,
          unitName: unit.unitName,
          variantLabel: variant.label,
          customization,
          effectivePrice,
          quantity,
        });
      }
    }
    if (selections.length === 0) return;
    trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    setCart((previous) => addStorefrontCartLines(previous, selections));
    setSelectedId(null);
  }
  function addSelectedUnit() {
    if (!detailQ.data || !detailUnit || !detailUnit.inStock || customizationValidation) return;
    const effectivePrice = detailUnit.salePrice ?? detailUnit.price;
    if (!effectivePrice) return;
    const quantity = Math.max(1, variantQuantities.get(detailUnit.productUnitId) ?? 1);
    const selection: StorefrontCartSelection = {
      productUnitId: detailUnit.productUnitId,
      productId: detailQ.data.productId,
      productName: detailQ.data.productName,
      imageUrl: detailQ.data.imageUrl,
      unitName: detailUnit.unitName,
      variantLabel: detailVariant?.label,
      customization: selectedCustomization(),
      effectivePrice,
      quantity,
    };
    trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    setCart((previous) => addStorefrontCartLines(previous, [selection]));
    setSelectedId(null);
  }
  function setQty(cartKey: string, qty: number) {
    recordStorefrontCartChange();
    setCart((prev) => setStorefrontCartQuantity(prev, cartKey, qty));
  }
  function offerLabel(o: { type: "PERCENT" | "AMOUNT"; discountPercent: string; discountAmount: string }): string {
    return o.type === "PERCENT" ? `خصم ${Number(o.discountPercent)}٪` : `خصم ${money(o.discountAmount)} د.ع`;
  }
  function offerScopeLabel(scope: "ALL" | "CATEGORIES" | "PRODUCTS"): string {
    return scope === "ALL" ? "على كل المنتجات" : scope === "CATEGORIES" ? "على فئات مختارة" : "على منتجات مختارة";
  }

  function openCheckout() {
    if (!storeOpen || !orderingEnabled) return; // بوابتا المتجر والطلب ظاهرتان للزبون.
    trackConversion.mutate({ event: "BEGIN_CHECKOUT" });
    setTurnstileToken(null);
    setTurnstileResetKey((key) => key + 1);
    setPanel("checkout");
  }
  function submitOrder() {
    const name = form.name.trim();
    const phone = form.phone.replace(/\s+/g, " ").trim();
    const address = form.address.trim();
    if (
      !name || phone.replace(/\D/g, "").length < 8 || address.length < 3 ||
      cartLines.length === 0 ||
      !storefrontTurnstileSubmissionReady(
        orderingEnabled,
        settingsQ.data?.turnstileSiteKey,
        turnstileToken,
      )
    ) return;
    const fingerprint = storefrontCheckoutFingerprint(cart, form);
    const previous = checkoutAttemptRef.current;
    const acceptedQuote = acceptedQuoteRef.current?.fingerprint === fingerprint
      ? acceptedQuoteRef.current
      : null;
    const attempt: StorefrontCheckoutAttempt = previous?.fingerprint === fingerprint
      ? previous
      : {
          clientRequestId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? `sf-${crypto.randomUUID()}`
            : `sf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
          fingerprint,
          expectedGrandTotal: acceptedQuote?.total ?? cartTotal.toFixed(2),
          createdAt: Date.now(),
        };
    // fail-closed قبل الشبكة: الرد الضائع آمن فقط إذا بقي نفس المفتاح بعد reload/PWA.
    if (!saveStorefrontSnapshot(cart, form, localStorage, attempt)) {
      setCheckoutSafetyError("تعذّر تأمين رقم محاولة الطلب على هذا الجهاز — حرّر مساحة التخزين ثم أعد المحاولة.");
      return;
    }
    checkoutAttemptRef.current = attempt;
    setCheckoutAttempt(attempt);
    orderInFlightRef.current = true;
    const customizationNotes = cartLines
      .filter((line) => line.customization)
      .map((line) => `تخصيص ${line.name}: ${summarizeStorefrontCustomization(line.customization)}`)
      .join("\n");
    const orderNotes = [form.notes.trim(), customizationNotes].filter(Boolean).join("\n");
    createOrder.mutate({
      customerName: name,
      customerPhone: phone,
      governorate: form.governorate,
      addressText: address,
      notes: orderNotes || undefined,
      lines: cartLines.map((l) => ({
        productUnitId: l.productUnitId,
        quantity: l.qty,
        expectedUnitPrice: Number(l.price).toFixed(2),
      })),
      expectedGrandTotal: attempt.expectedGrandTotal,
      clientRequestId: attempt.clientRequestId,
      turnstileToken: turnstileToken!,
    });
  }
  const canSubmit =
    form.name.trim().length > 0 &&
    form.phone.replace(/\D/g, "").length >= 8 &&
    form.address.trim().length >= 3 &&
    cartLines.length > 0 &&
    storefrontTurnstileSubmissionReady(
      orderingEnabled,
      settingsQ.data?.turnstileSiteKey,
      turnstileToken,
    );

  const chip = (active: boolean) =>
    `whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-bold transition ${
      active
        ? "bg-emerald-600 text-white shadow-sm shadow-[#1e4a63]/25"
        : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
    }`;

  const featuredHero = heroBanners[0] ?? null;
  const buyingPaths = [
    { title: "المدرسة والجامعة", description: "أساسيات الدراسة في مكان واحد", icon: <Briefcase aria-hidden className="size-5" />, tone: "bg-[#e9eef2] text-[#1e4a63]" },
    { title: "مكتب يومي", description: "أدوات ترفع جودة يومك", icon: <LayoutGrid aria-hidden className="size-5" />, tone: "bg-[#f3e5da] text-[#a4513f]" },
    { title: "هدايا وطباعة", description: "حلول جاهزة للمناسبات والعمل", icon: <Package aria-hidden className="size-5" />, tone: "bg-[#ece8df] text-[#6b5d4f]" },
  ];

  return (
    <div className="storefront min-h-dvh overflow-x-clip bg-[#f4f1ec] text-[#20252a] dark:bg-slate-950 dark:text-slate-100" dir="rtl">
      <header className="sticky top-0 z-30 border-b border-[#ded8d0] bg-[#fbfaf8] dark:border-slate-800 dark:bg-slate-900">
        <div className="hidden border-b border-[#ebe6df] bg-[#f4f1ec] sm:block dark:border-slate-800 dark:bg-slate-950">
          <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-2 text-[11px] font-bold text-[#6c747b] lg:px-8">
            <span>توصيل موثوق إلى جميع المحافظات</span>
            <span>الدفع عند الاستلام متاح على كل الطلبات</span>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-4 py-3 lg:px-8">
          <a href="/store" className="flex min-w-[168px] items-center gap-3 text-right">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#1e4a63] text-white">
              <ShoppingBag aria-hidden className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-black tracking-tight text-[#1e4a63]">{STORE_NAME}</span>
              <span className="block truncate text-[10px] font-bold text-[#7a817f]">{STORE_TAGLINE}</span>
            </span>
          </a>
          <nav className="hidden items-center gap-5 text-xs font-extrabold text-[#46515a] lg:flex" aria-label="التنقل الرئيسي">
            <a href="#store-start" className="transition hover:text-[#1e4a63]">اكتشف</a>
            <a href="#store-picks" className="transition hover:text-[#1e4a63]">مختاراتنا</a>
            <a href="#store-results" className="transition hover:text-[#1e4a63]">المنتجات</a>
            <a href="#store-deals" className="transition hover:text-[#a4513f]">العروض</a>
          </nav>
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-[#7d8589]" />
            <input
              type="search"
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              placeholder="ما الذي تبحث عنه اليوم؟"
              className="w-full rounded-lg border border-[#d7d2ca] bg-white py-3 pr-10 pl-11 text-sm font-semibold text-[#20252a] outline-none transition placeholder:text-[#92999c] focus:border-[#1e4a63] focus:ring-2 focus:ring-[#1e4a63]/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            {rawSearch && (
              <button type="button" onClick={() => { setRawSearch(""); setSearch(""); }} aria-label="مسح البحث" className="absolute left-2.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-[#7d8589] transition hover:bg-[#f0ece7] hover:text-[#20252a]">
                <X aria-hidden className="size-4" />
              </button>
            )}
          </div>
          <button onClick={() => setPanel("cart")} aria-label="السلة" className="relative flex size-11 shrink-0 items-center justify-center rounded-lg border border-[#d7d2ca] bg-white text-[#1e4a63] transition hover:border-[#1e4a63] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
            <ShoppingCart aria-hidden className="size-5" />
            {cartCount > 0 && <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-[#e65f4a] px-1 text-[10px] font-black text-white">{cartCount}</span>}
          </button>
          {!isPublicHost(typeof window !== "undefined" ? window.location.hostname : "") && (
            <Link href="/login" className="hidden shrink-0 items-center gap-1.5 text-[11px] font-bold text-[#7a817f] hover:text-[#1e4a63] sm:flex"><User aria-hidden className="size-4" /> دخول الفريق</Link>
          )}
        </div>
        {cats.length > 0 && (
          <div className="border-t border-[#f0e2d5] bg-[#fffaf5] dark:border-slate-800 dark:bg-slate-900">
            <CategoryChipStrip cats={cats} selectedId={categoryId} onPick={selectCategory} />
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-[1500px] overflow-x-clip px-4 py-6 pb-28 lg:px-8">
        {supportingFailures.length > 0 && (
          <section role="alert" aria-live="polite" className="mb-5 flex items-start gap-3 border-r-4 border-[#b87835] bg-[#fbf3e5] p-4 text-[#754f2c]">
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1"><p className="text-sm font-black">بعض بيانات المتجر تحتاج إلى إعادة المحاولة</p><p className="mt-1 text-xs leading-6">تعذّر تحميل {supportingFailures.map((source) => STOREFRONT_SOURCE_LABELS[source]).join("، ")}. يمكنك متابعة المنتجات المتاحة أو إعادة المحاولة.</p></div>
            <button type="button" onClick={retrySupportingSources} className="shrink-0 border border-[#b87835]/50 bg-white px-3 py-2 text-xs font-black text-[#754f2c] hover:bg-[#f8e8d0]">إعادة المحاولة</button>
          </section>
        )}
        {announcement && <div className="mb-5 flex items-center gap-2 border border-[#ead8c8] bg-[#fff8f2] px-4 py-3 text-sm font-bold text-[#754f2c]"><BadgePercent aria-hidden className="size-4 shrink-0" /><span>{announcement}</span></div>}
        {settingsQ.isSuccess && !storeOpen && <div className="mb-5 border border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm font-bold text-rose-700">المتجر مغلق مؤقتاً — يمكنك تصفح المنتجات والعودة لاحقاً لإتمام الطلب.</div>}

        {!search && categoryId == null && (
          <>
            <section id="store-start" className="grid overflow-hidden rounded-[28px] border border-[#d5d9da] bg-[#183d36] shadow-[0_22px_55px_-34px_rgba(24,61,54,0.9)] lg:grid-cols-[1.02fr_0.98fr]">
              <div className="flex flex-col justify-center p-6 text-white sm:p-10 lg:p-14">
                <p className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-[#d9e6ea]">قرطاسية • طباعة • هدايا</p>
                <h1 className="max-w-xl text-3xl font-black leading-[1.25] tracking-tight sm:text-5xl">كل ما تحتاجه ليومك،<br /><span className="text-[#f1b0a4]">بترتيب أسهل.</span></h1>
                <p className="mt-5 max-w-lg text-sm font-semibold leading-7 text-[#d7e4e7] sm:text-base">منتجات عملية، خيارات واضحة، وتوصيل يصل إليك في العراق. ابدأ من القسم المناسب أو ابحث عن منتجك مباشرة.</p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <button type="button" onClick={() => scrollToResults()} className="bg-[#e65f4a] px-5 py-3 text-sm font-black text-white transition hover:bg-[#c94736]">تصفح المنتجات</button>
                  <a href="#store-picks" className="border border-white/40 px-5 py-3 text-sm font-black text-white transition hover:bg-white/10">شاهد المختارات</a>
                </div>
                <div className="mt-8 grid max-w-md grid-cols-3 gap-4 border-t border-white/20 pt-4 text-[11px] font-bold text-[#d7e4e7]"><span>دفع عند الاستلام</span><span>توصيل للمحافظات</span><span>تأكيد قبل الإرسال</span></div>
              </div>
              <div className="min-h-[280px] bg-[#f3eadf] p-2 sm:p-3 lg:min-h-[410px]">
                {heroBanners.length > 0 ? <BannerCarousel banners={heroBanners} slot="HERO" className="mb-0 h-full" /> : featuredHero ? <BannerFrame banner={featuredHero} slot="HERO" active /> : <div className="flex h-full items-end rounded-2xl bg-[#e8ddcf] p-8"><div className="max-w-sm border-r-4 border-[#f05d53] pr-4 text-[#183d36]"><p className="text-xs font-black uppercase tracking-[0.14em]">اختيار الأسبوع</p><p className="mt-2 text-3xl font-black">أدوات تجعل العمل أخف.</p></div></div>}
              </div>
            </section>

            <section className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl border border-[#e6ded4] bg-white shadow-sm sm:grid-cols-4">
              {[{icon: <Banknote aria-hidden className="size-5" />, title: "دفع عند الاستلام", text: "ادفع بعد تأكيد الطلب"}, {icon: <Truck aria-hidden className="size-5" />, title: "توصيل واضح", text: "أجرة التوصيل قبل التأكيد"}, {icon: <ShieldCheck aria-hidden className="size-5" />, title: "اختيار موثوق", text: "منتجات أصلية ومراجعة"}, {icon: <MessageCircle aria-hidden className="size-5" />, title: "نساعدك مباشرة", text: "استفسار سريع عبر واتساب"}].map((item) => <div key={item.title} className="flex items-center gap-3 border-l border-[#eee9e2] px-4 py-4 last:border-l-0"><span className="text-[#1e4a63]">{item.icon}</span><span><span className="block text-xs font-black text-[#30383e]">{item.title}</span><span className="mt-0.5 block text-[10px] font-semibold text-[#7a817f]">{item.text}</span></span></div>)}
            </section>

            <section className="mt-10 rounded-[28px] bg-[#fff7ed] px-4 py-5 sm:px-6 sm:py-7">
              <div className="mb-4 flex items-end justify-between"><div><p className="text-[11px] font-black uppercase tracking-[0.15em] text-[#f05d53]">ابدأ من هنا</p><h2 className="mt-1 text-2xl font-black tracking-tight text-[#183d36]">اختَر طريق الشراء المناسب</h2></div><button onClick={() => scrollToResults()} className="hidden text-xs font-black text-[#183d36] hover:underline sm:block">عرض كل المنتجات ←</button></div>
              <div className="grid gap-3 md:grid-cols-3">{buyingPaths.map((path) => <button key={path.title} onClick={() => scrollToResults()} className={`flex min-h-36 flex-col justify-between p-5 text-right transition hover:-translate-y-0.5 hover:shadow-md ${path.tone}`}><span className="flex size-10 items-center justify-center rounded-lg bg-white/70">{path.icon}</span><span><span className="block text-lg font-black">{path.title}</span><span className="mt-1 block text-xs font-bold opacity-75">{path.description}</span></span></button>)}</div>
            </section>

            <section className="mt-10 rounded-[28px] bg-[#eef8f4] px-4 py-5 sm:px-6 sm:py-7" aria-labelledby="store-category-title">
              <div className="mb-4 flex items-end justify-between"><div><p className="text-[11px] font-black uppercase tracking-[0.15em] text-[#a4513f]">تصفح حسب الحاجة</p><h2 id="store-category-title" className="mt-1 text-2xl font-black tracking-tight text-[#1e4a63]">الأقسام الرئيسية</h2></div><span className="text-xs font-bold text-[#7a817f]">{cats.length} أقسام متاحة</span></div>
              <div className="store-category-grid grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{cats.slice(0, 12).map((c, index) => <button key={c.id} onClick={() => selectCategory(c.id)} className="group border border-[#ddd8d1] bg-white p-4 text-right transition hover:border-[#1e4a63] hover:shadow-sm"><span className="mb-8 flex size-9 items-center justify-center rounded-lg bg-[#f0ece7] text-[#1e4a63] group-hover:bg-[#1e4a63] group-hover:text-white"><Store aria-hidden className="size-4" /></span><span className="block text-sm font-black text-[#30383e]">{c.name}</span><span className="mt-1 block text-[11px] font-bold text-[#8a918f]">{storefrontCategoryCount(c, availability)} منتج</span></button>)}</div>
            </section>

            {feedStrips.length > 0 && <div className="mt-8 rounded-[28px] bg-[#183d36] p-3 shadow-[0_18px_45px_-30px_rgba(24,61,54,0.85)] sm:p-4"><BannerCarousel banners={feedStrips} slot="INLINE" /></div>}

            {offers.length > 0 && <section id="store-deals" className="mt-10 rounded-[28px] border border-[#f0dfc7] bg-[#fff5e7] px-4 py-6 shadow-sm sm:px-6"><div className="mb-4 flex items-end justify-between"><div><p className="text-[11px] font-black uppercase tracking-[0.15em] text-[#f05d53]">عرض محدود</p><h2 className="mt-1 text-2xl font-black text-[#754f2c]">صفقات تستحق الإضافة</h2></div><BadgePercent aria-hidden className="size-6 text-[#f05d53]" /></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{offers.slice(0, 3).map((o) => <div key={o.id} className="flex items-center justify-between gap-4 rounded-2xl border border-[#ead8c8] bg-white p-4 transition hover:-translate-y-0.5 hover:shadow-md"><div><p className="text-sm font-black text-[#30383e]">{o.name}</p><p className="mt-1 text-xs font-bold text-[#8b6b50]">{offerLabel(o)} · {offerScopeLabel(o.scope)}</p></div><Tag aria-hidden className="size-5 shrink-0 text-[#f05d53]" /></div>)}</div></section>}

            <div id="store-picks" className="mt-10 grid min-w-0 grid-cols-1 gap-10 rounded-[28px] bg-[#f7f0fa] px-4 py-5 sm:px-6 sm:py-7">
              <ProductRow title="مختارات هذا الأسبوع" icon={<Tag aria-hidden className="size-4 text-[#e65f4a]" />} products={dealProducts} onSelect={setSelectedId} onAdd={addFeaturedToCart} recentlyAddedId={recentlyAddedProductId} />
              <ProductRow title="الأكثر طلباً" icon={<TrendingUp aria-hidden className="size-4 text-[#1e4a63]" />} products={bestSellers} onSelect={setSelectedId} onAdd={addFeaturedToCart} recentlyAddedId={recentlyAddedProductId} />
            </div>
          </>
        )}

        <section id="store-results" className="mt-12 scroll-mt-36 rounded-[28px] bg-white/80 px-4 py-5 shadow-sm ring-1 ring-[#e7e0d8] sm:px-6 sm:py-7">
          <div className="mb-5 flex flex-col gap-3 border-b border-[#d9d3ca] pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="text-[11px] font-black uppercase tracking-[0.15em] text-[#a4513f]">المنتجات</p><h2 className="mt-1 text-3xl font-black tracking-tight text-[#1e4a63]">كل المنتجات</h2><p className="mt-2 text-xs font-bold text-[#7a817f]">{search ? `نتائج البحث عن «${search}»` : activeCatName ? `منتجات فئة «${activeCatName}»` : "تصفح المجموعة الكاملة واختر ما يناسبك"}</p></div><span className="text-sm font-black text-[#1e4a63]">{filteredItems.length} منتج</span>
          </div>
          <div className="mb-6 flex flex-col gap-3 border border-[#d9d3ca] bg-white p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"><button type="button" onClick={() => { setAvailability((value) => value === "IN_STOCK" ? "ALL" : "IN_STOCK"); scrollToResults(); }} aria-pressed={availability === "IN_STOCK"} className={`shrink-0 border px-3 py-2 text-xs font-black ${availability === "IN_STOCK" ? "border-[#1e4a63] bg-[#1e4a63] text-white" : "border-[#d7d2ca] text-[#59636a]"}`}>{availability === "IN_STOCK" ? "متوفر الآن" : "كل المنتجات"}</button><label className="relative shrink-0"><span className="sr-only">نطاق السعر</span><select value={priceFilter} onChange={(e) => { setPriceFilter(e.target.value as PriceFilter); scrollToResults(); }} className="appearance-none border border-[#d7d2ca] bg-white py-2 pr-3 pl-8 text-xs font-bold text-[#59636a] outline-none focus:border-[#1e4a63]"><option value="ALL">كل الأسعار</option><option value="UNDER_5000">أقل من 5,000 د.ع</option><option value="FROM_5000_TO_15000">5,000 – 15,000 د.ع</option><option value="OVER_15000">أكثر من 15,000 د.ع</option></select><ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#8b9395]" /></label>{brands.length > 0 && <label className="relative shrink-0"><span className="sr-only">الماركة</span><select value={brand} onChange={(e) => { setBrand(e.target.value); scrollToResults(); }} className="appearance-none border border-[#d7d2ca] bg-white py-2 pr-3 pl-8 text-xs font-bold text-[#59636a] outline-none focus:border-[#1e4a63]"><option value="">كل الماركات</option>{brands.map((name) => <option key={name} value={name}>{name}</option>)}</select><ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#8b9395]" /></label>}</div><div className="flex items-center justify-between gap-3"><label className="relative shrink-0"><span className="sr-only">ترتيب النتائج</span><select value={sort} onChange={(e) => { setSort(e.target.value as CatalogSort); scrollToResults(); }} className="appearance-none border border-[#d7d2ca] bg-white py-2 pr-3 pl-8 text-xs font-bold text-[#59636a] outline-none focus:border-[#1e4a63]"><option value="RECOMMENDED">الترتيب المقترح</option><option value="BEST_SELLERS">الأكثر مبيعاً</option><option value="PRICE_ASC">السعر: الأقل أولاً</option><option value="PRICE_DESC">السعر: الأعلى أولاً</option></select><ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#8b9395]" /></label>{(hasRefinements || categoryId != null || search) && <button type="button" onClick={clearCatalogFilters} className="text-xs font-black text-[#a4513f] hover:underline">مسح الفلاتر</button>}</div>
          </div>
          {catalogQ.isLoading ? <div className="flex flex-col items-center justify-center py-24 text-[#7a817f]"><Loader2 aria-hidden className="size-8 animate-spin text-[#1e4a63]" /><p className="mt-3 text-sm font-bold">جارٍ تحميل المنتجات…</p></div> : catalogInitialError ? <div className="flex flex-col items-center justify-center border border-[#ddd8d1] bg-white py-24 text-center" role="alert"><AlertTriangle aria-hidden className="size-10 text-[#b87835]" /><p className="mt-3 text-sm font-black text-[#30383e]">تعذّر تحميل المنتجات</p><p className="mt-1 max-w-sm text-xs font-semibold text-[#7a817f]">تحقق من الاتصال ثم أعد المحاولة. لم نعرض هذه الحالة كمنتجات فارغة.</p><button type="button" onClick={() => void catalogQ.refetch()} className="store-primary-action mt-4 bg-[#e65f4a] px-5 py-2.5 text-xs font-black text-white">إعادة المحاولة</button></div> : filteredItems.length === 0 ? <div className="flex flex-col items-center justify-center border border-[#ddd8d1] bg-white py-24 text-center"><Package aria-hidden className="size-10 text-[#7a817f]" /><p className="mt-3 text-sm font-black text-[#30383e]">{isEmptyCatalog ? "لا توجد منتجات معروضة حالياً" : "لا توجد نتائج مطابقة للبحث أو الفلاتر"}</p><p className="mt-1 max-w-sm text-xs font-semibold text-[#7a817f]">{isEmptyCatalog ? "ستظهر المنتجات هنا عند إضافتها إلى المتجر." : "جرّب مسح البحث والفلاتر لعرض المنتجات المتاحة."}</p>{!isEmptyCatalog && <button type="button" onClick={clearCatalogFilters} className="mt-4 bg-[#1e4a63] px-5 py-2.5 text-xs font-black text-white">مسح البحث والفلاتر</button>}</div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{filteredItems.flatMap((p, idx) => { const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price); const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0; const card = <article key={p.productId} className={`store-product-card group flex h-full flex-col overflow-hidden border border-[#ddd8d1] bg-white transition ${p.inStock ? "hover:-translate-y-0.5 hover:border-[#1e4a63] hover:shadow-md" : "opacity-70"}`}><button onClick={() => setSelectedId(p.productId)} className="relative block text-right"><BundleMedia urls={p.bundleImageUrls} fallbackUrl={p.imageUrl} alt={p.productName} showFallbackLabel className="aspect-[4/3] w-full" />{onSale && pct > 0 && <span className="absolute right-3 top-3 bg-[#e65f4a] px-2 py-1 text-[10px] font-black text-white">خصم {pct}٪</span>}{p.isBundle && <span className="absolute left-3 top-3 bg-[#1e4a63] px-2 py-1 text-[10px] font-black text-white">بكج</span>}{!p.inStock && <span className="absolute inset-x-0 bottom-0 bg-[#20252a]/80 py-2 text-center text-[11px] font-black text-white">غير متوفر حالياً</span>}</button><div className="flex flex-1 flex-col p-4"><span className="min-h-4 text-[10px] font-black uppercase tracking-wide text-[#a4513f]">{p.brand ?? "مكتبة العربية"}</span><button onClick={() => setSelectedId(p.productId)} className="mt-2 text-right"><span className="line-clamp-2 min-h-[2.8em] text-sm font-black leading-6 text-[#30383e]">{p.productName}</span></button><div className="mt-3 flex items-baseline gap-2"><span className="text-lg font-black text-[#1e4a63]">{priceLabel(p.salePrice ?? p.price)}</span>{onSale && <span className="text-xs font-bold text-[#9aa09f] line-through">{money(p.price)}</span>}</div><div className="mt-2 flex min-h-4 items-center justify-between gap-2 text-[10px] font-bold text-[#8b9395]">{p.stockLeft != null ? <span className="text-[#a4513f]">بقي {p.stockLeft} فقط</span> : <span>{p.unitName}</span>}{p.soldCount >= 3 && <span>الأكثر طلباً</span>}</div><button onClick={() => setSelectedId(p.productId)} disabled={!p.inStock} className="store-primary-action mt-5 flex w-full items-center justify-center gap-2 bg-[#e65f4a] py-3 text-xs font-black text-white transition hover:bg-[#c94736] disabled:cursor-not-allowed disabled:bg-[#e4e2df] disabled:text-[#969c9c]"><Plus aria-hidden className="size-4" />{p.inStock ? "اختر المنتج" : "غير متوفر"}</button></div></article>; const nodes: ReactNode[] = [card]; if (!search && feedStrips.length > 0 && (idx + 1) % 10 === 0 && idx + 1 < filteredItems.length) { const k = ((idx + 1) / 10 - 1) % feedStrips.length; nodes.push(<InlineStrip key={`strip-${idx}`} banner={feedStrips[k]} tone={inlineBanners.length ? "emerald" : "amber"} />); } return nodes; })}</div>}
          {catalogQ.hasNextPage && <div ref={catalogLoadMoreRef} className="mt-8 flex min-h-12 items-center justify-center" aria-live="polite">{catalogQ.isFetchingNextPage ? <span className="flex items-center gap-2 text-xs font-bold text-[#1e4a63]"><Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ تحميل منتجات إضافية…</span> : <span className="text-[11px] font-bold text-[#8b9395]">نحمّل المزيد تلقائياً عند الاقتراب</span>}</div>}
          {catalogQ.isError && <div className="mt-3 flex flex-col items-center gap-2 text-center" role="alert"><p className="text-xs font-bold text-rose-700">تعذّر تحميل المنتجات الإضافية تلقائياً.</p><button type="button" onClick={() => void catalogQ.fetchNextPage()} disabled={catalogQ.isFetchingNextPage} className="text-xs font-black text-[#1e4a63] underline disabled:opacity-50">إعادة المحاولة</button></div>}
        </section>
      </main>


      <div className="mx-auto max-w-6xl px-4">
        <StoreTrustAndHelp
          whatsappNumber={settingsQ.data?.whatsappNumber}
          freeShippingThreshold={freeThreshold}
        />
      </div>

      {/* تذييل الموقع العام: كل ما يخدم الناس يعيش على هذا الدومين — المتجر والوظائف.
          هامش سفلي إضافي كي لا يحجبه شريط السلة العائم. */}
      <footer className="mt-10 border-t border-emerald-100 bg-white/70 pb-24 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6">
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-slate-700 dark:text-slate-200">{STORE_NAME}</p>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{STORE_TAGLINE}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openTrack()}
              className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:text-emerald-700 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
            >
              <Package aria-hidden className="size-3.5" />
              تتبّع طلبي
            </button>
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
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-emerald-100 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
          <div className="mx-auto max-w-6xl px-4 py-3">
            <button
              onClick={() => setPanel("cart")}
              className="flex w-full items-center justify-between rounded-xl bg-emerald-600 px-4 py-3.5 text-white shadow-sm shadow-emerald-600/25 transition motion-safe:active:scale-[0.98] hover:bg-emerald-700"
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
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/50 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setSelectedId(null)}>
          <div className="flex max-h-[min(780px,calc(100dvh-2rem))] w-[calc(100%-1rem)] max-w-xl flex-col overflow-hidden overscroll-contain rounded-2xl bg-white p-3 shadow-2xl dark:bg-slate-900 sm:w-full sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-slate-500 dark:text-slate-400">تفاصيل المنتج</h2>
              <button onClick={() => setSelectedId(null)} aria-label="إغلاق" className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400">
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1">
            {detailQ.isLoading ? (
              <div className="flex justify-center py-12 text-emerald-500">
                <Loader2 aria-hidden className="size-6 animate-spin" />
              </div>
            ) : detailQ.data ? (
              <div>
                <div className="flex gap-3">
                  <BundleMedia
                    urls={detailQ.data.bundleImageUrls}
                    fallbackUrl={detailQ.data.imageUrl}
                    alt={detailQ.data.productName}
                    className="size-24 shrink-0 rounded-xl"
                  />
                  <div className="min-w-0 flex-1">
                    {detailQ.data.brand && <p className="text-xs font-medium text-slate-400">{detailQ.data.brand}</p>}
                    <h3 className="text-base font-extrabold leading-snug text-slate-900 dark:text-white">{detailQ.data.productName}</h3>
                    {detailQ.data.category && <p className="mt-1 text-xs text-slate-500">الفئة: {detailQ.data.category}</p>}
                    <p className="mt-0.5 text-xs text-slate-500">الوحدة: {detailUnit?.unitName ?? detailQ.data.unitName}</p>
                    {(detailQ.data.variants?.length ?? 0) > 1 && (
                      <div className="mt-3" aria-label="اختر الألوان والمقاسات والكميات المطلوبة">
                        <p className="mb-1 text-xs font-extrabold text-slate-700 dark:text-slate-200">اختر اللون أو القياس والكمية</p>
                        <p className="mb-2 text-[11px] text-slate-500">يمكنك اختيار أكثر من لون أو قياس، ولكل اختيار كمية مستقلة.</p>
                        <div className="space-y-2">
                          <div className="grid gap-1.5 sm:grid-cols-2">
                          {detailQ.data.variants!.map((variant) => (
                            <div key={variant.variantId} className={`rounded-lg border p-1.5 ${variant.inStock ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800" : "border-slate-100 bg-slate-50 opacity-60 dark:border-slate-800 dark:bg-slate-900"}`}>
                              <div className="flex items-center justify-between gap-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  {variant.colorHex && <span className="size-4 shrink-0 rounded-full ring-1 ring-black/20" style={{ backgroundColor: variant.colorHex }} aria-hidden />}
                                  <span className="truncate">{variant.color || variant.label}</span>
                                  {variant.size && <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">المقاس {variant.size}</span>}
                                </div>
                                <span className="shrink-0 text-[10px] text-slate-400">{variant.inStock ? `${variant.units.filter((unit) => unit.inStock).length} خيارات` : "نفد"}</span>
                              </div>
                              <div className="mt-1.5 space-y-1">
                                {variant.units.map((unit) => {
                                  const quantity = variantQuantities.get(unit.productUnitId) ?? 0;
                                  const stockLimit = unit.stockLeft == null ? 999 : Math.min(Math.floor(unit.stockLeft), 999);
                                  return (
                                    <div key={unit.productUnitId} className={`flex items-center justify-between gap-1 rounded-md border px-1.5 py-0.5 ${unit.inStock ? "border-slate-100 bg-slate-50 dark:border-slate-700 dark:bg-slate-900" : "border-slate-100 bg-white opacity-50 dark:border-slate-800 dark:bg-slate-800"}`}>
                                      <button type="button" disabled={!unit.inStock} onClick={() => { setSelectedVariantId(variant.variantId); setSelectedStoreUnitId(unit.productUnitId); if (quantity === 0) setVariantQuantity(unit.productUnitId, 1); }} className="min-w-0 flex-1 text-right text-[11px] font-bold text-slate-700 disabled:cursor-not-allowed dark:text-slate-200">
                                        <span className="block truncate">{unit.unitName}{variant.size ? ` · ${variant.size}` : ""}</span>
                                        <span className="mt-0.5 block text-[10px] font-extrabold text-[var(--sem-pos)]">{priceLabel(unit.salePrice ?? unit.price)}{!unit.inStock && " · نفد"}</span>
                                      </button>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <button type="button" aria-label={`إنقاص ${variant.label} ${unit.unitName}`} disabled={!unit.inStock || quantity === 0} onClick={() => setVariantQuantity(unit.productUnitId, quantity - 1)} className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200"><Minus aria-hidden className="size-3" /></button>
                                        <span className="w-5 text-center text-sm font-extrabold tabular-nums">{quantity}</span>
                                        <button type="button" aria-label={`زيادة ${variant.label} ${unit.unitName}`} disabled={!unit.inStock || quantity >= stockLimit} onClick={() => setVariantQuantity(unit.productUnitId, quantity + 1)} className="flex size-6 items-center justify-center rounded-full bg-[var(--sem-pos)] text-white disabled:cursor-not-allowed disabled:opacity-40"><Plus aria-hidden className="size-3" /></button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                          </div>
                        </div>
                      </div>
                    )}
                    {(detailQ.data.variants?.length ?? 0) <= 1 && (detailVariant?.units.length ?? detailQ.data.storeUnits?.length ?? 0) > 0 && (
                      <div className="mt-3" aria-label="اختر القياس أو وحدة البيع والكمية">
                        {(detailVariant?.color || detailVariant?.size) && <p className="mb-1.5 text-xs font-extrabold text-slate-700 dark:text-slate-200">الاختيار: {[detailVariant.color, detailVariant.size].filter(Boolean).join(" · ")}</p>}
                        <div className="space-y-1.5">
                          {(detailVariant?.units ?? detailQ.data.storeUnits ?? []).map((unit) => {
                            const selected = (detailUnit?.productUnitId ?? detailQ.data!.productUnitId) === unit.productUnitId;
                            const quantity = variantQuantities.get(unit.productUnitId) ?? (selected ? 1 : 0);
                            const stockLimit = unit.stockLeft == null ? 999 : Math.min(Math.floor(unit.stockLeft), 999);
                            return (
                              <div key={unit.productUnitId} className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 ${selected ? "border-[var(--sem-pos)] bg-emerald-50/60 dark:bg-emerald-500/10" : "border-slate-200 dark:border-slate-700"}`}>
                                <button type="button" disabled={!unit.inStock} onClick={() => { setSelectedStoreUnitId(unit.productUnitId); if (!variantQuantities.has(unit.productUnitId)) setVariantQuantity(unit.productUnitId, 1); }} className="min-w-0 flex-1 text-right text-xs font-bold text-slate-700 disabled:opacity-50 dark:text-slate-200">
                                  <span className="block truncate">{unit.unitName}</span>
                                  <span className="mt-0.5 block text-[10px] font-extrabold text-[var(--sem-pos)]">{priceLabel(unit.salePrice ?? unit.price)}{!unit.inStock && " · نفد"}</span>
                                </button>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button type="button" aria-label={`إنقاص ${unit.unitName}`} disabled={!unit.inStock || quantity === 0} onClick={() => setVariantQuantity(unit.productUnitId, quantity - 1)} className="flex size-7 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200"><Minus aria-hidden className="size-3.5" /></button>
                                  <span className="w-5 text-center text-sm font-extrabold tabular-nums">{quantity}</span>
                                  <button type="button" aria-label={`زيادة ${unit.unitName}`} disabled={!unit.inStock || quantity >= stockLimit} onClick={() => { setSelectedStoreUnitId(unit.productUnitId); setVariantQuantity(unit.productUnitId, quantity + 1); }} className="flex size-7 items-center justify-center rounded-full bg-[var(--sem-pos)] text-white disabled:opacity-40"><Plus aria-hidden className="size-3.5" /></button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {detailQ.data.colors && detailQ.data.colors.length > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <span>ألوان المنتج:</span>
                        <ColorSwatches colors={detailQ.data.colors} max={12} size={16} />
                      </div>
                    )}
                    {customizationConfig && (
                      <section className="mt-3 rounded-2xl border border-[#f0d991] bg-[#fff8df] p-3" aria-label="خيارات تخصيص المنتج">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-black text-[#25406f]">{customizationConfig.title}</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-[#806b3a]">{customizationConfig.description ?? "أكمل الحقول المطلوبة قبل إضافة المنتج للسلة."}</p>
                          </div>
                          <Tag aria-hidden className="size-4 shrink-0 text-[#d39c27]" />
                        </div>
                        <div className="mt-3 space-y-2.5">
                          {visibleCustomizationFields.map((field) => (
                            <label key={field.id} className="block text-[11px] font-black text-[#25406f]">
                              {field.label}{field.isRequired && <span className="text-[#e65f4a]"> *</span>}
                              <CustomizationFieldControl field={field} value={customizationValues[field.fieldKey] ?? ""} onChange={(value) => updateCustomizationField(field, value)} />
                              {field.fieldType === "FILE" && <span className="mt-1 block text-[10px] font-medium text-[#8f7b58]">أدخل اسم الملف أو مرجع التصميم؛ يرفق الملف عبر الفريق أو واتساب.</span>}
                            </label>
                          ))}
                        </div>
                        {customizationValidation && <p role="alert" className="mt-2 rounded-xl bg-[#e65f4a]/10 px-2.5 py-2 text-[11px] font-bold text-[#b74435]">{customizationValidation}</p>}
                      </section>
                    )}
                    <div className="mt-3 flex items-baseline gap-2">
                      <p className="text-xl font-extrabold text-money-positive">{priceLabel(detailUnit?.salePrice ?? detailUnit?.price ?? null)}</p>
                      {detailUnit?.salePrice != null && detailUnit.price != null && Number(detailUnit.salePrice) < Number(detailUnit.price) && (
                        <span className="text-sm text-slate-400 line-through">{money(detailUnit.price)}</span>
                      )}
                    </div>
                    {detailUnit?.promotionName && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                        <Tag aria-hidden className="size-3" /> {detailUnit.promotionName}
                      </span>
                    )}
                    <p className={`mt-2 text-xs font-bold ${detailUnit?.inStock ? "text-[var(--stock-ok)]" : "text-stock-out"}`}>
                      {detailUnit?.inStock
                        ? detailUnit.stockLeft != null
                          ? `متوفّر — بقي ${detailUnit.stockLeft} فقط، سارع بالطلب`
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
                <div className="sticky bottom-0 mt-2 border-t border-slate-100 bg-white/95 pt-2 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/95">
                <button
                  onClick={() => {
                    if ((detailQ.data?.variants?.length ?? 0) > 1) addSelectedVariants();
                    else {
                      addSelectedUnit();
                    }
                  }}
                  disabled={!!customizationValidation || ((detailQ.data?.variants?.length ?? 0) > 1
                    ? !Array.from(variantQuantities.values()).some((quantity) => quantity > 0)
                    : !detailUnit?.inStock || detailUnit.price == null)}
                  className="store-primary-action store-mobile-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-3.5 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800"
                >
                  <Plus aria-hidden className="size-4" />
                  {(detailQ.data?.variants?.length ?? 0) > 1
                    ? "أضف الاختيارات إلى السلة"
                    : detailUnit?.inStock ? "أضف إلى السلة" : "غير متوفّر"}
                </button>
                </div>

                {/* محتويات البكج */}
                {detailQ.data.isBundle && detailQ.data.bundleItems && detailQ.data.bundleItems.length > 0 && (
                  <div className="mt-4 rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
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
                  <RelatedProductStrip products={relatedQ.data!} onSelect={setSelectedId} />
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">تعذّر تحميل تفاصيل المنتج</p>
            )}
            </div>
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
                  <div key={l.cartKey} className="flex items-center gap-3 rounded-xl bg-white p-2.5 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                    <ProductImage url={l.imageUrl} alt={l.name} className="size-16 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">{l.name}</p>
                      {summarizeStorefrontCustomization(l.customization) && <p className="mt-1 line-clamp-2 text-[10px] font-bold leading-relaxed text-[#a16b2a]">تخصيص: {summarizeStorefrontCustomization(l.customization)}</p>}
                      <p className="mt-1 text-sm font-extrabold text-emerald-600 dark:text-emerald-400">{money(l.price)} د.ع</p>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setQty(l.cartKey, l.qty - 1)} aria-label="إنقاص" className="flex size-7 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">
                          <Minus aria-hidden className="size-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-extrabold tabular-nums">{l.qty}</span>
                        <button onClick={() => setQty(l.cartKey, l.qty + 1)} aria-label="زيادة" className="flex size-7 items-center justify-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-700">
                          <Plus aria-hidden className="size-3.5" />
                        </button>
                      </div>
                      <button onClick={() => setQty(l.cartKey, 0)} aria-label="حذف" className="flex items-center gap-1 text-[11px] font-medium text-rose-500 hover:underline">
                        <Trash2 aria-hidden className="size-3" />
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl bg-white p-3.5 text-sm ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
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
                disabled={!storeOpen || !orderingEnabled}
                className="store-primary-action store-mobile-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-sm shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
              >
                {storeOpen && orderingEnabled ? (
                  <>
                    متابعة إلى الدفع عند الاستلام
                    <ArrowRight aria-hidden className="size-4" />
                  </>
                ) : settingsQ.isLoading || settingsQ.isFetching ? (
                  "جارٍ التحقق من حالة المتجر"
                ) : settingsQ.isError ? (
                  "تعذّر التحقق من استقبال الطلبات — أعد المحاولة"
                ) : storeOpen && !orderingEnabled ? (
                  "استقبال الطلبات متوقف مؤقتاً — التصفح متاح"
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
                        cartLines.map((l) => ({ name: summarizeStorefrontCustomization(l.customization) ? `${l.name} — تخصيص: ${summarizeStorefrontCustomization(l.customization)}` : l.name, quantity: l.qty, total: Number(l.price) * l.qty })),
                        cartSubtotal
                      )
                    )
                  }
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-50 py-3 text-sm font-bold text-emerald-700 transition motion-safe:active:scale-[0.98] hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400"
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
        <PanelShell title="إتمام الطلب" onClose={() => {
          setTurnstileToken(null);
          setPanel("cart");
        }}>
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-[#f0d991] bg-[#fff8df] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#9a7427]">الخطوة الأخيرة</p><p className="mt-1 text-sm font-black text-[#25406f]">أكمل بياناتك وسنؤكد الطلب قبل التوصيل</p></div>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f4c84d] text-sm font-black text-[#25406f]">{cartCount}</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[10px] font-black"><span className="rounded-lg bg-[#25406f] px-2 py-1.5 text-white">بياناتك</span><span className="rounded-lg bg-white/80 px-2 py-1.5 text-[#6d5524]">التوصيل</span><span className="rounded-lg bg-white/80 px-2 py-1.5 text-[#6d5524]">التأكيد</span></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
            <Field icon={<User aria-hidden className="size-4" />} label="الاسم الكامل">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="اسمك" autoComplete="name" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </Field>
            <Field icon={<Phone aria-hidden className="size-4" />} label="رقم الهاتف">
              <IntlPhoneInput
                value={form.phone}
                onChange={(phone) => setForm({ ...form, phone })}
                ariaLabel="رقم الهاتف"
                placeholder="770 123 4567"
                className="border-0 shadow-none"
              />
            </Field>
            </div>
            <div className="rounded-2xl border border-[#ead8c8] bg-white p-3 ring-1 ring-[#f3e5da] dark:bg-slate-900 dark:ring-slate-700">
              <label className="mb-1 block text-xs font-bold text-slate-500">المحافظة</label>
              <select value={form.governorate} onChange={(e) => setForm({ ...form, governorate: e.target.value })} className="w-full bg-transparent text-sm outline-none">
                {GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-2xl border border-[#c5e8dc] bg-[#f7fffc] p-3 ring-1 ring-[#e9f7f2] dark:bg-slate-900 dark:ring-slate-700">
              <label className="mb-1 block text-xs font-bold text-slate-500">العنوان بالتفصيل</label>
              <textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} placeholder="المنطقة، الشارع، أقرب نقطة دالة…" className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </div>
            <div className="rounded-2xl border border-[#dfcdea] bg-[#fcf8ff] p-3 ring-1 ring-[#f3ebf8] dark:bg-slate-900 dark:ring-slate-700">
              <label className="mb-1 block text-xs font-bold text-slate-500">ملاحظة (اختياري)</label>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="مثال: الاتصال قبل التوصيل" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400" />
            </div>

            <div className="rounded-2xl border border-[#ead8c8] bg-[#fffdf9] p-3.5 text-sm ring-1 ring-[#f3e5da] dark:bg-slate-900 dark:ring-slate-800">
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

            {orderingEnabled && settingsQ.data?.turnstileSiteKey ? (
              <TurnstileWidget
                siteKey={settingsQ.data.turnstileSiteKey}
                resetKey={turnstileResetKey}
                onTokenChange={setTurnstileToken}
              />
            ) : (
              <p role="alert" className="rounded-xl bg-[var(--sem-danger)]/5 px-3 py-2 text-xs font-medium text-[var(--sem-danger)]">
                استقبال الطلبات متوقف مؤقتاً؛ يمكنك متابعة التصفح والتواصل عبر واتساب.
              </p>
            )}

            {(createOrder.isError || checkoutSafetyError) && (
              <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600 dark:bg-rose-500/10">
                {checkoutSafetyError ?? createOrder.error?.message ?? "تعذّر إرسال الطلب — أعد المحاولة"}
              </p>
            )}

            <button
              onClick={submitOrder}
              disabled={!canSubmit || createOrder.isPending}
              className="store-primary-action store-mobile-action flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-sm shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
            >
              {createOrder.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />}
              تأكيد الطلب — الدفع عند الاستلام
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
            <p className="mt-3 rounded-xl bg-[var(--sem-warning)]/5 px-3 py-2 text-xs font-bold text-[var(--sem-warning)] ring-1 ring-[var(--sem-warning)]/40">
              الكمية محجوزة حتى {formatStorefrontReservationDeadline(confirmation.reservationExpiresAt)}؛ بعد ذلك يلزم إعادة الطلب حسب التوفر.
            </p>
            <div className="mt-5 w-full rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
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
              className="mt-6 w-full rounded-xl bg-emerald-600 py-4 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-emerald-700"
            >
              متابعة التسوّق
            </button>
            <button
              onClick={() => openTrack(confirmation.orderNumber)}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-white py-3.5 text-sm font-extrabold text-emerald-700 ring-1 ring-emerald-200 transition hover:bg-emerald-50 dark:bg-slate-900 dark:text-emerald-400 dark:ring-slate-700"
            >
              <Package aria-hidden className="size-4" /> تتبّع هذا الطلب
            </button>
          </div>
        </PanelShell>
      )}

      {panel === "label" && (
        <PanelShell title="معلومات طلب الشحن" onClose={() => setPanel(null)}>
          {labelQ.isLoading ? (
            <div className="flex justify-center py-12 text-[var(--sem-info)]"><Loader2 aria-hidden className="size-7 animate-spin" /></div>
          ) : labelQ.data ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                <div className="flex items-center justify-between"><span className="font-extrabold" dir="ltr">{labelQ.data.orderNumber}</span><span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TRACK_STATUS[labelQ.data.status]?.cls ?? "bg-slate-100 text-slate-600"}`}>{TRACK_STATUS[labelQ.data.status]?.label ?? labelQ.data.status}</span></div>
                <p className="mt-3 text-base font-extrabold text-slate-900 dark:text-white">{labelQ.data.customerName ?? "العميل"}</p>
                {labelQ.data.customerPhone && <p dir="ltr" className="mt-1 font-extrabold text-[var(--sem-info)]">{labelQ.data.customerPhone}</p>}
                <p className="mt-2 leading-relaxed text-slate-600 dark:text-slate-300">{labelQ.data.addressText ?? labelQ.data.governorate ?? "—"}</p>
              </div>
              <div className="rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                <p className="mb-2 text-xs font-extrabold text-slate-500">منتجات الطلب</p>
                <div className="space-y-2">{labelQ.data.items.map((it, index) => <div key={index} className="flex justify-between gap-3 border-b border-slate-100 pb-2 last:border-0 last:pb-0 dark:border-slate-800"><span>{it.productName}{it.unitName ? ` — ${it.unitName}` : ""}</span><b className="shrink-0 tabular-nums">×{it.quantity}</b></div>)}</div>
                <div className="mt-3 flex justify-between border-t border-slate-200 pt-3 text-base font-extrabold dark:border-slate-700"><span>المبلغ عند الاستلام</span><span dir="ltr" className="text-money-positive">{money(labelQ.data.total)} د.ع</span></div>
              </div>
            </div>
          ) : <p className="py-10 text-center text-sm font-bold text-destructive">تعذر فتح معلومات هذا الملصق.</p>}
        </PanelShell>
      )}

      {panel === "track" && (
        <PanelShell title="تتبّع طلبك" onClose={() => setPanel(null)}>
          <div className="space-y-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">أدخل رقم طلبك ورقم هاتفك لعرض حالته.</p>
            <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-300">رقم الطلب</label>
                <input
                  dir="ltr"
                  value={trackForm.orderNumber}
                  onChange={(e) => setTrackForm((f) => ({ ...f, orderNumber: e.target.value }))}
                  placeholder="ORD-…"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-300">رقم الهاتف</label>
                <input
                  dir="ltr"
                  inputMode="tel"
                  value={trackForm.phone}
                  onChange={(e) => setTrackForm((f) => ({ ...f, phone: `+964${e.target.value.replace(/\D/g, "").replace(/^964/, "").replace(/^0+/, "")}` }))}
                  placeholder="+9647XXXXXXXXX"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
              <button
                onClick={doTrack}
                disabled={!trackForm.orderNumber.trim() || trackForm.phone.replace(/\D/g, "").length <= 3 || trackState === "loading"}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-extrabold text-white transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {trackState === "loading" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Search aria-hidden className="size-4" />}
                تتبّع الطلب
              </button>
            </div>

            {trackState === "notfound" && (
              <div className="rounded-xl bg-amber-50 p-4 text-center text-sm font-bold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
                لا يوجد طلبٌ بهذا الرقم والهاتف. تأكّد من رقم الطلب والهاتف المُستخدَم عند الطلب.
              </div>
            )}
            {trackState === "error" && (
              <div className="rounded-xl bg-rose-50 p-4 text-center text-sm font-bold text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20">
                تعذّر جلب الحالة الآن — حاول مرّةً أخرى.
              </div>
            )}

            {trackResult && (
              <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold tracking-wider text-slate-900 dark:text-white" dir="ltr">{trackResult.orderNumber}</span>
                  <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${TRACK_STATUS[trackResult.status]?.cls ?? "bg-slate-100 text-slate-600"}`}>
                    {TRACK_STATUS[trackResult.status]?.label ?? trackResult.status}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {trackResult.items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{it.productName} <span className="text-slate-400">×{it.quantity}</span></span>
                      <span className="tabular-nums text-slate-500" dir="ltr">{money(it.total)} د.ع</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
                  <span className="text-slate-500">أجرة التوصيل</span>
                  <span className="tabular-nums text-slate-700 dark:text-slate-200" dir="ltr">{money(trackResult.deliveryFee)} د.ع</span>
                </div>
                <div className="flex justify-between text-base font-extrabold">
                  <span className="text-slate-900 dark:text-white">الإجمالي</span>
                  <span className="tabular-nums text-emerald-600 dark:text-emerald-400" dir="ltr">{money(trackResult.total)} د.ع</span>
                </div>
              </div>
            )}
          </div>
        </PanelShell>
      )}
    </div>
  );
}

/**
 * طبقة الثقة والمساعدة في واجهة المتجر.
 *
 * لا تَعِد هذه البطاقة بمدة تسليم أو استبدال غير مُعتمدين في إعدادات المتجر؛
 * بل تشرح فقط ما يطبّقه مسار الطلب فعلياً: الدفع عند الاستلام، احتساب التوصيل
 * قبل التأكيد، واتصال الفريق لتأكيد الطلب. هذا يمنع «الثقة التسويقية» الوهمية.
 */
function StoreTrustAndHelp({
  whatsappNumber,
  freeShippingThreshold,
}: {
  whatsappNumber?: string | null;
  freeShippingThreshold: number;
}) {
  const whatsappHref = whatsappNumber ? `https://wa.me/${whatsappNumber.replace(/[^\d]/g, "")}` : null;

  return (
    <section aria-labelledby="store-help-title" className="mt-8 rounded-xl border border-emerald-100 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400">تسوّق بوضوح</p>
          <h2 id="store-help-title" className="mt-0.5 text-base font-extrabold text-slate-900 dark:text-white">معلومات تساعدك قبل الطلب</h2>
        </div>
        {whatsappHref && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-extrabold text-white transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
          >
            <MessageCircle aria-hidden className="size-3.5" /> اسألنا عبر واتساب
          </a>
        )}
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
          <Banknote aria-hidden className="size-4 text-emerald-700 dark:text-emerald-400" />
          <p className="mt-1.5 text-xs font-extrabold text-slate-800 dark:text-slate-100">الدفع عند الاستلام</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">ادفع نقداً للمندوب بعد تأكيد طلبك.</p>
        </div>
        <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
          <Truck aria-hidden className="size-4 text-emerald-700 dark:text-emerald-400" />
          <p className="mt-1.5 text-xs font-extrabold text-slate-800 dark:text-slate-100">التوصيل محسوب بوضوح</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">اختر محافظتك لترى الأجرة قبل تأكيد الطلب.</p>
        </div>
        <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-500/10">
          <ShieldCheck aria-hidden className="size-4 text-emerald-700 dark:text-emerald-400" />
          <p className="mt-1.5 text-xs font-extrabold text-slate-800 dark:text-slate-100">تأكيد قبل الإرسال</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">نتواصل معك لتأكيد بيانات الطلب والتوصيل.</p>
        </div>
      </div>

      <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100 px-3 dark:divide-slate-800 dark:border-slate-800">
        <details className="group py-3" open>
          <summary className="cursor-pointer list-none text-sm font-bold text-slate-800 marker:content-none dark:text-slate-100">
            <span className="flex items-center justify-between gap-3">كيف أعرف السعر النهائي؟<span className="text-emerald-600 transition group-open:rotate-45">＋</span></span>
          </summary>
          <p className="pt-2 text-xs leading-6 text-slate-600 dark:text-slate-300">يعرض المتجر سعر المنتجات وأجرة التوصيل والإجمالي في شاشة الدفع قبل زر تأكيد الطلب.</p>
        </details>
        <details className="group py-3">
          <summary className="cursor-pointer list-none text-sm font-bold text-slate-800 marker:content-none dark:text-slate-100">
            <span className="flex items-center justify-between gap-3">هل يوجد توصيل مجاني؟<span className="text-emerald-600 transition group-open:rotate-45">＋</span></span>
          </summary>
          <p className="pt-2 text-xs leading-6 text-slate-600 dark:text-slate-300">
            {freeShippingThreshold > 0
              ? `يصبح التوصيل مجانياً تلقائياً عندما تبلغ قيمة المنتجات ${money(freeShippingThreshold)} د.ع، ويظهر لك مقدار المتبقي في السلة.`
              : "تظهر أجرة التوصيل حسب المحافظة التي تختارها قبل تأكيد الطلب."}
          </p>
        </details>
        <details className="group py-3">
          <summary className="cursor-pointer list-none text-sm font-bold text-slate-800 marker:content-none dark:text-slate-100">
            <span className="flex items-center justify-between gap-3">كيف أعدّل الطلب أو أستفسر عن الاستبدال؟<span className="text-emerald-600 transition group-open:rotate-45">＋</span></span>
          </summary>
          <p className="pt-2 text-xs leading-6 text-slate-600 dark:text-slate-300">
            {whatsappHref ? "راسلنا عبر واتساب مع رقم الطلب، وسيراجع الفريق الحالة معك قبل اتخاذ الإجراء المناسب." : "تواصل مع فريق المتجر وأرسل رقم الطلب ليتمكن من مراجعة الحالة معك."}
          </p>
        </details>
      </div>
    </section>
  );
}

/** غلاف لوح بملء الشاشة (سلة/دفع/تأكيد) — ترويسة ثابتة + محتوى قابل للتمرير. */
function PanelShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#fff8ef] dark:bg-slate-950" dir="rtl">
      <header className="sticky top-0 flex items-center gap-3 border-b border-[#f0e2d5] bg-white/95 px-4 py-3 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900">
        <button onClick={onClose} aria-label="رجوع" className="flex size-9 items-center justify-center rounded-full transition hover:bg-slate-100 dark:hover:bg-slate-800">
          <ArrowRight aria-hidden className="size-5 rotate-180 text-slate-600 dark:text-slate-300" />
        </button>
        <h2 className="text-base font-extrabold text-slate-900 dark:text-white">{title}</h2>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-4 sm:px-6" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>{children}</div>
    </div>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#ead8c8] bg-white p-3 ring-1 ring-[#f3e5da] dark:bg-slate-900 dark:ring-slate-700">
      <label className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-500">
        <span className="text-emerald-500">{icon}</span>
        {label}
      </label>
      {children}
    </div>
  );
}
