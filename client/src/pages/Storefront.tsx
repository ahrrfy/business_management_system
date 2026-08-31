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
import * as DialogPrimitive from "@radix-ui/react-dialog";
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
  Heart,
  Loader2,
  LogIn,
  MessageCircle,
  Minus,
  Layers,
  LayoutGrid,
  Package,
  Pause,
  Play,
  Store,
  TrendingUp,
  Phone,
  Plus,
  Search,
  Share2,
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
import { orderStatusChipClass, orderStatusLabelForCustomer } from "@shared/onlineOrderStatus";

export function formatStorefrontReservationDeadline(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "وقت غير متاح";
  return new Intl.DateTimeFormat("ar-IQ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Baghdad",
  }).format(date);
}
type TrackData = NonNullable<RouterOutputs["storefront"]["trackOrderByToken"]>;
import { fmtInt } from "@/lib/money";
import { isPublicHost } from "@/lib/siteHosts";
import { GOVERNORATES, deliveryFeeFor } from "@shared/governorates";
import { normalizeArabicSearch } from "@shared/storefrontSearchNormalize";
import { buildStorefrontCartMessage, openWhatsApp } from "@/lib/whatsapp";
import { BannerFrame, type StoreBannerCreative } from "@/components/store/BannerFrame";
import { TurnstileWidget } from "@/components/storefront/TurnstileWidget";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { ConsentChoice, ConsentProvider } from "@/components/storefront/ConsentChoice";

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
  controlId,
  labelId,
  describedBy,
  invalid = false,
}: {
  field: StorefrontCustomizationField;
  value: string;
  onChange: (value: string) => void;
  controlId: string;
  labelId: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const common = "mt-1.5 w-full rounded-xl border border-[#ead8c8] bg-white px-3 py-2 text-xs font-bold text-[#30383e] outline-none transition focus:border-[#e65f4a]";
  if (field.fieldType === "SELECT") {
    return (
      <select id={controlId} value={value} onChange={(event) => onChange(event.target.value)} required={field.isRequired} aria-invalid={invalid || undefined} aria-describedby={describedBy} className={common}>
        <option value="">اختر {field.label}</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}{option.priceDelta !== "0" ? ` (+${option.priceDelta} د.ع)` : ""}</option>)}
      </select>
    );
  }
  if (field.fieldType === "SWATCH") {
    return (
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={labelId} aria-required={field.isRequired} aria-invalid={invalid || undefined} aria-describedby={describedBy}>
        {field.options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)} className={`min-h-11 rounded-full border px-3 py-1.5 text-xs font-bold transition ${value === option.value ? "border-[#25406f] bg-[#25406f] text-white" : "border-[#ead8c8] bg-white text-[#5b5147] hover:border-[#e65f4a]"}`}>
            {option.label}{option.priceDelta !== "0" ? ` · +${option.priceDelta}` : ""}
          </button>
        ))}
      </div>
    );
  }
  if (field.fieldType === "TEXTAREA") {
    return <textarea id={controlId} value={value} onChange={(event) => onChange(event.target.value)} required={field.isRequired} aria-invalid={invalid || undefined} aria-describedby={describedBy} maxLength={field.maxLength ?? undefined} rows={3} placeholder={field.label} className={`${common} resize-none placeholder:text-[#6c747b]`} />;
  }
  return <input id={controlId} type={field.fieldType === "NUMBER" ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} required={field.isRequired} aria-invalid={invalid || undefined} aria-describedby={describedBy} maxLength={field.maxLength ?? undefined} inputMode={field.fieldType === "NUMBER" ? "numeric" : undefined} placeholder={field.fieldType === "FILE" ? "اسم الملف أو مرجع التصميم" : field.label} className={`${common} placeholder:text-[#6c747b]`} />;
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
  isCustomizable?: boolean;
  customization?: StorefrontCustomization;
  /** حدّ معروف من رد المخزون؛ null يعني أن الكمية الدقيقة غير معلنة للعميل. */
  stockLimit?: number | null;
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
export type CheckoutFieldErrors = Partial<Record<"name" | "phone" | "governorate" | "address", string>>;

export function validateStorefrontCheckout(form: CheckoutForm): CheckoutFieldErrors {
  const errors: CheckoutFieldErrors = {};
  if (!form.name.trim()) errors.name = "اكتب الاسم الكامل لاستلام الطلب.";
  if (form.phone.replace(/\D/g, "").length < 8) errors.phone = "اكتب رقم هاتف صالحاً للتواصل معك.";
  if (!form.governorate.trim()) errors.governorate = "اختر المحافظة.";
  if (form.address.trim().length < 3) errors.address = "اكتب عنواناً واضحاً من 3 أحرف على الأقل.";
  return errors;
}
const DEFAULT_FORM: CheckoutForm = { name: "", phone: "+964 ", governorate: "baghdad", address: "", notes: "" };
const CART_STORAGE_KEY = "alroya-store-cart-v1";
const CHECKOUT_STORAGE_KEY = "alroya-store-checkout-v1";
const CHECKOUT_ATTEMPT_STORAGE_KEY = "alroya-store-checkout-attempt-v1";
const GUEST_TRACKING_STORAGE_KEY = "alroya-store-guest-tracking-v1";
const STOREFRONT_PERSIST_REQUEST_EVENT = "alroya:storefront-persist-request";
const STOREFRONT_WISHLIST_KEY = "alroya-store-wishlist-v1";

export type GuestTrackingOrder = {
  orderNumber: string;
  trackingToken: string;
  expiresAt: string;
  savedAt: number;
};

type GuestTrackingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validGuestTrackingOrder(value: unknown, now: number): value is GuestTrackingOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as Partial<GuestTrackingOrder>;
  const expiry = typeof order.expiresAt === "string" ? Date.parse(order.expiresAt) : Number.NaN;
  return typeof order.orderNumber === "string" && order.orderNumber.trim().length > 0 && order.orderNumber.length <= 50 &&
    typeof order.trackingToken === "string" && order.trackingToken.trim().length >= 60 && order.trackingToken.length <= 160 &&
    Number.isFinite(expiry) && expiry > now && typeof order.savedAt === "number" && Number.isFinite(order.savedAt);
}

/** لا تُحفظ أيّ هوية عميل: فقط ملكية الطلب قصيرة العمر الصادرة من الخادم. */
export function loadGuestTrackingOrders(
  storage: GuestTrackingStorage = localStorage,
  now = Date.now(),
): GuestTrackingOrder[] {
  try {
    const parsed = JSON.parse(storage.getItem(GUEST_TRACKING_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((order): order is GuestTrackingOrder => validGuestTrackingOrder(order, now))
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, 5)
      .map(({ orderNumber, trackingToken, expiresAt, savedAt }) => ({ orderNumber, trackingToken, expiresAt, savedAt }));
  } catch {
    return [];
  }
}

export function rememberGuestTrackingOrder(
  input: Pick<GuestTrackingOrder, "orderNumber" | "trackingToken" | "expiresAt">,
  storage: GuestTrackingStorage = localStorage,
  now = Date.now(),
): GuestTrackingOrder[] {
  const candidate: GuestTrackingOrder = {
    orderNumber: input.orderNumber.trim(),
    trackingToken: input.trackingToken.trim(),
    expiresAt: input.expiresAt,
    savedAt: now,
  };
  if (!validGuestTrackingOrder(candidate, now)) return loadGuestTrackingOrders(storage, now);
  const next = [candidate, ...loadGuestTrackingOrders(storage, now)
    .filter((order) => order.orderNumber !== candidate.orderNumber && order.trackingToken !== candidate.trackingToken)]
    .slice(0, 5);
  try {
    storage.setItem(GUEST_TRACKING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* التتبّع يظل متاحاً بلصق الرمز حتى لو حُظر التخزين المحلي. */
  }
  return next;
}

function loadStorefrontWishlist(): Set<number> {
  try {
    const raw = localStorage.getItem(STOREFRONT_WISHLIST_KEY);
    const values = JSON.parse(raw ?? "[]") as unknown;
    return new Set(Array.isArray(values) ? values.filter((id): id is number => Number.isInteger(id) && id > 0).slice(0, 200) : []);
  } catch {
    return new Set();
  }
}

function saveStorefrontWishlist(ids: Set<number>): void {
  try {
    localStorage.setItem(STOREFRONT_WISHLIST_KEY, JSON.stringify(Array.from(ids).slice(0, 200)));
  } catch {
    /* التخزين المحلي اختياري؛ التصفح والشراء لا يتوقفان عند حجبه. */
  }
}

function storefrontShareUrl(params: Record<string, string>): string {
  if (typeof window === "undefined") return "https://alarabiya.online/store";
  const url = new URL("/store", window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

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
        const stockLimit = typeof rawLine.stockLimit === "number" && Number.isFinite(rawLine.stockLimit)
          ? Math.max(1, Math.min(Math.floor(rawLine.stockLimit), 999))
          : null;
        const line = {
          ...rawLine,
          stockLimit,
          qty: Math.min(Math.max(1, Math.floor(rawLine.qty)), stockLimit ?? 999),
          cartKey: typeof rawLine.cartKey === "string" && rawLine.cartKey ? rawLine.cartKey : customizationCartKey(rawLine.productUnitId, rawLine.customization),
        } as CartLine;
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

export function storefrontCheckoutFingerprint(cart: Map<string, CartLine>, form: CheckoutForm, couponCode: string | null = null): string {
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
    couponCode: couponCode?.trim().toUpperCase() || null,
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
  isCustomizable?: boolean;
  customization?: StorefrontCustomization;
  stockLimit?: number | null;
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
  if (!storefrontProductCanBeOrdered(product) || product.customization) return new Map(current);
  const next = new Map(current);
  const cartKey = customizationCartKey(product.productUnitId, product.customization);
  const existing = next.get(cartKey);
  const customizationLabel = summarizeStorefrontCustomization(product.customization);
  const stockLimit = product.stockLimit == null
    ? existing?.stockLimit ?? null
    : Math.max(1, Math.min(Math.floor(product.stockLimit), 999));
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
    isCustomizable: product.isCustomizable,
    customization: product.customization,
    stockLimit,
    qty: Math.min((existing?.qty ?? 0) + 1, stockLimit ?? 999),
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
    if (!storefrontProductCanBeOrdered(selection) || selection.customization || !Number.isInteger(selection.quantity) || selection.quantity <= 0) continue;
    const line = addStorefrontCartLine(next, selection, selection.effectivePrice);
    const cartKey = customizationCartKey(selection.productUnitId, selection.customization);
    const added = line.get(cartKey)!;
    line.set(cartKey, {
      ...added,
      qty: Math.min((next.get(cartKey)?.qty ?? 0) + selection.quantity, added.stockLimit ?? 999),
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
  else next.set(cartKey, { ...line, qty: Math.min(Math.floor(quantity), line.stockLimit ?? 999) });
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

// موحَّد مع الخادم عبر [`@shared/storefrontSearchNormalize`](../../../shared/storefrontSearchNormalize.ts).
// كان تعريفاً محلياً منسوخاً؛ فرضُ الاستيراد يمنع انحرافاً صامتاً بين تصفية العميل وLIKE الخادميّ
// (كان يجعل الاقتراح يظهر لحظياً ثمّ يختفي حين يستبدل الخادم الصفحات — Codex P2 على #904).
const normalizeStorefrontArabic = normalizeArabicSearch;

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

/** يجمع صور العرض الحقيقية ويمنع تكرارها مع سقف يحافظ على خفة البطاقة. */
export function storefrontMediaUrls(urls: string[] | undefined, fallbackUrl: string | null, limit = 8): string[] {
  return Array.from(new Set([...(urls ?? []), fallbackUrl].filter((url): url is string => Boolean(url)))).slice(0, limit);
}

type StorefrontVariantMediaSource = {
  imageUrl: string | null;
  imageUrls?: string[];
  variants?: Array<{
    variantId: number;
    imageUrl: string | null;
    imageUrls?: string[];
  }>;
};

/** يختار معرض البديل النشط، ويرجع لمعرض المنتج العام إن لم يوجد البديل في العقد. */
export function storefrontVariantMedia(
  product: StorefrontVariantMediaSource,
  selectedVariantId: number | null | undefined,
): { urls: string[] | undefined; fallbackUrl: string | null } {
  const variant = product.variants?.find((candidate) => candidate.variantId === selectedVariantId);
  return {
    urls: variant?.imageUrls?.length ? variant.imageUrls : product.imageUrls,
    fallbackUrl: variant?.imageUrl ?? product.imageUrl,
  };
}

export function clampStorefrontZoomPoint(
  point: { x: number; y: number },
  width: number,
  height: number,
  lensSize = 256,
): { x: number; y: number } {
  const edgeX = Math.min(50, (lensSize / Math.max(1, width)) * 50);
  const edgeY = Math.min(50, (lensSize / Math.max(1, height)) * 50);
  return {
    x: Math.max(edgeX, Math.min(100 - edgeX, point.x)),
    y: Math.max(edgeY, Math.min(100 - edgeY, point.y)),
  };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/** تقليب صور البطاقة عند المؤشر/اللمس — يتوقف خارج البطاقة ويحترم reduced-motion. */
function CardMediaCarousel({
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
  const sources = useMemo(() => storefrontMediaUrls(urls, fallbackUrl), [urls, fallbackUrl]);
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState(false);
  // عند تبدّل المصادر نبدأ من الصورة الرئيسية، لا من فهرسٍ يعود لمعرض سابق.
  useEffect(() => setIndex(0), [sources.join("|")]);
  useEffect(() => {
    if (sources.length < 2 || !active || reducedMotion) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % sources.length), 1500);
    return () => window.clearInterval(timer);
  }, [active, reducedMotion, sources.length]);
  const activate = () => {
    if (!reducedMotion) setActive(true);
  };
  const current = sources[index] ?? null;
  return (
    <div
      className={`group relative overflow-hidden bg-white ${className ?? ""}`}
      role="img"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") activate(); }}
      onPointerLeave={() => setActive(false)}
      onFocus={activate}
      onBlur={() => setActive(false)}
      onTouchStart={activate}
      onTouchEnd={() => setActive(false)}
      aria-label={sources.length > 1 ? `${alt} — صورة ${index + 1} من ${sources.length}` : alt}
    >
      <ProductImage key={`${current ?? "empty"}-${index}`} url={current} alt="" className="size-full bg-white animate__animated animate__fadeIn animate__faster" showFallbackLabel={showFallbackLabel} />
      {sources.length > 1 && <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#183d36]/75 px-2 py-0.5 text-[9px] font-black text-white opacity-0 transition-opacity group-hover:opacity-100">{index + 1} / {sources.length}</span>}
    </div>
  );
}

/** معرض تفاصيل المنتج مع تقليب تلقائي، عدسة تكبير تتبع المؤشر، وفتح كامل على الهاتف. */
function ProductGallery({
  urls,
  fallbackUrl,
  alt,
}: {
  urls?: string[];
  fallbackUrl: string | null;
  alt: string;
}) {
  const sources = useMemo(() => storefrontMediaUrls(urls, fallbackUrl, 12), [urls, fallbackUrl]);
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [zoomPoint, setZoomPoint] = useState<{ x: number; y: number } | null>(null);
  const zoomPendingRef = useRef<{ x: number; y: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenCloseRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => {
    if (zoomFrameRef.current != null) window.cancelAnimationFrame(zoomFrameRef.current);
  }, []);
  // تبديل البديل يعيد المعرض إلى صورته الرئيسية ولا يُبقي فهرساً من معرضٍ سابق.
  useEffect(() => setIndex(0), [sources.join("|")]);
  useEffect(() => {
    if (sources.length < 2 || !hovered || reducedMotion) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % sources.length), 2600);
    return () => window.clearInterval(timer);
  }, [hovered, reducedMotion, sources.length]);
  const move = (delta: -1 | 1) => setIndex((current) => (current + delta + sources.length) % sources.length);
  const currentUrl = sources[index] ?? null;
  const handleZoomMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!currentUrl || window.matchMedia("(pointer: coarse)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    zoomPendingRef.current = clampStorefrontZoomPoint({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    }, rect.width, rect.height);
    if (zoomFrameRef.current == null) {
      zoomFrameRef.current = window.requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        if (zoomPendingRef.current) setZoomPoint(zoomPendingRef.current);
      });
    }
  };
  return (
    <div className="space-y-2" onMouseEnter={() => setHovered(true)} onMouseLeave={() => { setHovered(false); setZoomPoint(null); zoomPendingRef.current = null; if (zoomFrameRef.current != null) { window.cancelAnimationFrame(zoomFrameRef.current); zoomFrameRef.current = null; } }}>
      <div
        className="group relative aspect-square overflow-hidden rounded-2xl bg-white ring-1 ring-[#ead8c8]"
        onMouseMove={handleZoomMove}
      >
        <button type="button" disabled={!currentUrl} aria-label={currentUrl ? `تكبير صورة ${alt}` : `لا توجد صورة متاحة لـ${alt}`} onClick={() => currentUrl && setFullScreen(true)} className="block size-full disabled:cursor-default">
          <ProductImage url={currentUrl} alt={alt} className="size-full bg-white" showFallbackLabel />
        </button>
        {zoomPoint && currentUrl && (
          <div
            className="pointer-events-none absolute hidden size-64 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white bg-no-repeat shadow-[0_10px_30px_rgba(24,61,54,0.28)] lg:block"
            style={{ left: `${zoomPoint.x}%`, top: `${zoomPoint.y}%`, backgroundImage: `url(${JSON.stringify(currentUrl)})`, backgroundSize: "300% 300%", backgroundPosition: `${zoomPoint.x}% ${zoomPoint.y}%` }}
            aria-hidden="true"
          />
        )}
        {currentUrl && <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-black text-[#1e4a63] opacity-0 shadow-sm transition-opacity group-hover:opacity-100">مرّر للتكبير</span>}
        {sources.length > 1 && (
          <>
            <button type="button" onClick={() => move(-1)} aria-label="الصورة السابقة" className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#1e4a63] shadow-md transition hover:bg-white active:scale-95"><ArrowRight aria-hidden className="size-4" /></button>
            <button type="button" onClick={() => move(1)} aria-label="الصورة التالية" className="absolute left-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[#1e4a63] shadow-md transition hover:bg-white active:scale-95"><ArrowRight aria-hidden className="size-4 rotate-180" /></button>
            <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#183d36]/85 px-2.5 py-1 text-[10px] font-black text-white">{index + 1} / {sources.length}</span>
          </>
        )}
      </div>
      {sources.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="صور المنتج المصغرة">
          {sources.map((source, thumbnailIndex) => (
            <button type="button" key={source} onClick={() => setIndex(thumbnailIndex)} aria-label={`عرض الصورة ${thumbnailIndex + 1}`} aria-pressed={thumbnailIndex === index} className={`size-14 shrink-0 overflow-hidden rounded-lg bg-white ring-1 transition ${thumbnailIndex === index ? "ring-[var(--store-accent)] ring-2" : "ring-[#ead8c8]"}`}>
              <img src={source} alt="" loading="lazy" className="size-full object-contain" />
            </button>
          ))}
        </div>
      )}
      <DialogPrimitive.Root open={fullScreen} onOpenChange={setFullScreen}>
        {currentUrl && (
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-slate-950/90" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => { event.preventDefault(); fullScreenCloseRef.current?.focus(); }}
              className="fixed inset-0 z-[81] flex items-center justify-center p-4 outline-none"
            >
              <DialogPrimitive.Title className="sr-only">صورة {alt} بالحجم الكامل</DialogPrimitive.Title>
              <img src={currentUrl} alt={alt} className="max-h-[90dvh] max-w-[96vw] object-contain" />
              <DialogPrimitive.Close asChild>
                <button ref={fullScreenCloseRef} type="button" aria-label="إغلاق التكبير" className="absolute right-4 flex size-11 items-center justify-center rounded-full bg-white/95 text-slate-700 shadow-lg" style={{ top: "calc(1rem + env(safe-area-inset-top))" }}><X aria-hidden className="size-5" /></button>
              </DialogPrimitive.Close>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </DialogPrimitive.Root>
    </div>
  );
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
  const sources = storefrontMediaUrls(urls, fallbackUrl, 4);
  return (
    <CardMediaCarousel
      urls={sources}
      fallbackUrl={null}
      alt={alt}
      className={`store-product-media overflow-hidden bg-white ${className ?? ""}`}
      showFallbackLabel={showFallbackLabel}
    />
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
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label="أقسام المنتجات — اسحب لاكتشاف المزيد"
      >
        <button type="button" onClick={() => onPick(null)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-black transition hover:-translate-y-0.5 active:scale-95 ${selectedId == null ? "border-[#25406f] bg-[#25406f] text-white shadow-sm" : "border-[#ead8c8] bg-white text-[#667078] hover:border-[#e65f4a] hover:text-[#25406f]"}`}>كل الأقسام</button>
        {cats.map((c, index) => (
          <button type="button" key={c.id} onClick={() => onPick(c.id)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold transition hover:-translate-y-0.5 active:scale-95 ${selectedId === c.id ? "border-[var(--store-accent)] bg-[var(--store-accent)] text-white shadow-sm" : index % 3 === 0 ? "border-[#f0d991] bg-[#fff8df] text-[#6d5524] hover:border-[var(--store-accent)]" : index % 3 === 1 ? "border-[#c5e8dc] bg-[#e9f7f2] text-[#276c5d] hover:border-[#25406f]" : "border-[#dfcdea] bg-[#f3ebf8] text-[#684c78] hover:border-[#25406f]"}`}>{c.name}</button>
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
  isCustomizable?: boolean;
  /** للمنتج بدائلُ حقيقية (ماركات مختلفة تحت اسمٍ واحد) — تُوسَم البطاقة لتدعو لفتح التفاصيل. */
  hasAlternatives?: boolean;
};
function ProductRowCard({ p, onSelect, onAdd, recentlyAdded = false }: { p: RowProduct; onSelect: () => void; onAdd: (event: React.MouseEvent<HTMLButtonElement>) => void; recentlyAdded?: boolean }) {
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
          {p.hasAlternatives && (
            <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Layers aria-hidden className="size-3" /> ماركات متعددة
            </span>
          )}
        </button>
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">{priceLabel(p.salePrice ?? p.price)}</span>
          {onSale && <span className="text-[11px] text-slate-400 line-through">{money(p.price)}</span>}
        </div>
        <button
          onClick={onAdd}
          disabled={!storefrontProductCanBeOrdered(p)}
          className={`store-primary-action store-action-button store-mobile-action mt-auto flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-bold text-white transition motion-safe:active:scale-95 ${recentlyAdded ? "store-action-button--active animate__animated animate__tada animate__faster bg-emerald-600 hover:bg-emerald-700" : "bg-amber-500 hover:bg-amber-600"} disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800`}
        >
          {recentlyAdded ? <Check aria-hidden className="size-3.5 animate__animated animate__bounceIn animate__faster" /> : p.isCustomizable ? <AlertTriangle aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />} {recentlyAdded ? "تمت الإضافة" : recommendationActionLabel(p)}
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
  onAdd: (p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) => void;
  recentlyAddedId?: number | null;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || products.length < 4) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      if (interactionPaused || autoPlayPaused || document.hidden) return;
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
  }, [autoPlayPaused, interactionPaused, products.length]);

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
    setInteractionPaused(true);
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
    setInteractionPaused(false);
  };
  return (
    <section className="mb-5 min-w-0">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-200">{icon} {title}</h3>
        <div className="flex items-center gap-1" aria-label={`تنقل ${title}`}>
          <button type="button" onClick={() => setAutoPlayPaused((value) => !value)} className="flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700" aria-label={autoPlayPaused ? `تشغيل الحركة التلقائية في ${title}` : `إيقاف الحركة التلقائية في ${title}`} aria-pressed={autoPlayPaused}>{autoPlayPaused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}</button>
          <button type="button" onClick={() => moveRow(1)} onFocus={() => setInteractionPaused(true)} onBlur={() => setInteractionPaused(false)} className="flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700" aria-label={`مرر ${title} إلى اليسار`}><ArrowRight aria-hidden className="size-4 rotate-180" /></button>
          <button type="button" onClick={() => moveRow(-1)} onFocus={() => setInteractionPaused(true)} onBlur={() => setInteractionPaused(false)} className="flex size-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700" aria-label={`مرر ${title} إلى اليمين`}><ArrowRight aria-hidden className="size-4" /></button>
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
        onPointerEnter={() => setInteractionPaused(true)}
        onPointerLeave={() => { if (!dragRef.current.active) setInteractionPaused(false); }}
        onFocusCapture={() => setInteractionPaused(true)}
        onBlurCapture={() => setInteractionPaused(false)}
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label={`${title} — اسحب لاكتشاف المزيد`}
      >
        {products.map((p) => (
          <ProductRowCard key={p.productId} p={p} onSelect={() => onSelect(p.productId)} onAdd={(event) => onAdd(p, event)} recentlyAdded={recentlyAddedId === p.productId} />
        ))}
      </div>
    </section>
  );
}

type StorefrontUnitForCartAction = {
  productUnitId: number;
  price: string | null;
  salePrice?: string | null;
  unitName: string;
  inStock: boolean;
  stockLeft?: number | null;
};

type StorefrontProductForCartAction = {
  productId: number;
  productName: string;
  imageUrl: string | null;
  price: string | null;
  salePrice?: string | null;
  productUnitId: number;
  unitName: string;
  inStock?: boolean;
  stockLeft?: number | null;
  isCustomizable?: boolean;
  storeUnits?: StorefrontUnitForCartAction[];
  variants?: Array<{ label: string; units: StorefrontUnitForCartAction[] }>;
  bundleImageUrls?: string[];
  hasAlternatives?: boolean;
};

type RelatedProduct = StorefrontProductForCartAction;

export const STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE = "غير متاح للطلب الإلكتروني مؤقتاً";

export function storefrontProductCanBeOrdered(product: { inStock?: boolean; isCustomizable?: boolean }): boolean {
  return product.inStock !== false && product.isCustomizable !== true;
}

export function recommendationNeedsSelection(product: RelatedProduct): boolean {
  const selectableUnitIds = new Set([
    ...(product.storeUnits ?? []).filter((unit) => unit.inStock).map((unit) => unit.productUnitId),
    ...(product.variants ?? []).flatMap((variant) => variant.units.filter((unit) => unit.inStock).map((unit) => unit.productUnitId)),
  ]);
  return Boolean(product.isCustomizable)
    || Boolean(product.hasAlternatives)
    || (product.variants?.length ?? 0) > 1
    || selectableUnitIds.size > 1;
}

export function recommendationActionLabel(product: RelatedProduct): string {
  if (product.isCustomizable) return STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE;
  return recommendationNeedsSelection(product) ? "اختر الخيارات" : product.inStock === false ? "غير متوفر" : "أضف إلى السلة";
}

function RelatedProductStrip({
  products,
  onSelect,
  onAdd,
  onRecommendationClick,
}: {
  products: RelatedProduct[];
  onSelect: (id: number) => void;
  onAdd: (product: RelatedProduct, event: React.MouseEvent<HTMLButtonElement>) => void;
  onRecommendationClick: (recommendedProductId: number) => void;
}) {
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("ALL");
  const filteredProducts = products.filter((product) => matchesPriceFilter(Number(product.salePrice ?? product.price ?? 0), priceFilter));
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const move = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(240, Math.floor(scroller.clientWidth * 0.86)), behavior: "smooth" });
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
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
    if (dragRef.current.moved) event.preventDefault();
    scroller.scrollLeft = dragRef.current.startScroll - delta;
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    dragRef.current.active = false;
    if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
    window.setTimeout(() => { dragRef.current.moved = false; }, 0);
  };

  return (
    <div className="animate__animated animate__fadeIn mt-5 min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-200">قد يعجبك أيضاً</h3>
          <span className="text-[10px] font-bold text-slate-400">{filteredProducts.length} اقتراح</span>
        </div>
        <div className="flex items-center gap-1">
          <label className="relative shrink-0">
            <span className="sr-only">تصفية التوصيات حسب السعر</span>
            <select value={priceFilter} onChange={(event) => setPriceFilter(event.target.value as PriceFilter)} className="appearance-none rounded-full border border-slate-200 bg-white py-1.5 pr-2.5 pl-6 text-[10px] font-bold text-slate-600 outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              <option value="ALL">كل الأسعار</option>
              <option value="UNDER_5000">أقل من 5,000 د.ع</option>
              <option value="FROM_5000_TO_15000">5,000–15,000 د.ع</option>
              <option value="OVER_15000">أكثر من 15,000 د.ع</option>
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-slate-400" />
          </label>
          <div className="flex items-center gap-1" aria-label="تنقل المنتجات المقترحة">
          <button type="button" onClick={() => move(1)} className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 active:scale-95" aria-label="مرر المنتجات المقترحة إلى اليسار"><ArrowRight aria-hidden className="size-3.5 rotate-180" /></button>
          <button type="button" onClick={() => move(-1)} className="flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700 active:scale-95" aria-label="مرر المنتجات المقترحة إلى اليمين"><ArrowRight aria-hidden className="size-3.5" /></button>
          </div>
        </div>
      </div>
      <div
        ref={scrollerRef}
        dir="rtl"
        className="flex min-w-0 cursor-grab touch-pan-x select-none snap-x snap-mandatory scroll-smooth gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(event) => { if (dragRef.current.moved) { event.preventDefault(); event.stopPropagation(); } }}
        aria-label="منتجات مقترحة — اسحب لاكتشاف المزيد"
      >
        {filteredProducts.length === 0 ? <p className="w-full py-4 text-center text-xs font-bold text-slate-400">لا توجد اقتراحات ضمن هذا النطاق السعري.</p> : filteredProducts.map((rp) => (
          <article key={rp.productId} className="store-product-card flex min-w-[120px] max-w-[130px] shrink-0 snap-start flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
            <button type="button" onClick={() => { onRecommendationClick(rp.productId); onSelect(rp.productId); }} aria-label={`فتح تفاصيل ${rp.productName}`} className="text-right">
              <ProductImage url={rp.imageUrl} alt={rp.productName} className="store-product-media aspect-square w-full" />
            </button>
            <div className="flex flex-1 flex-col gap-1 p-2">
              <button type="button" onClick={() => { onRecommendationClick(rp.productId); onSelect(rp.productId); }} className="line-clamp-2 min-h-[2.2em] text-right text-[11px] font-bold leading-tight" aria-label={`فتح تفاصيل ${rp.productName}`}>{rp.productName}</button>
              <span className="text-xs font-extrabold text-emerald-600 dark:text-emerald-400">{priceLabel(rp.salePrice ?? rp.price)}</span>
              <button type="button" onClick={(event) => { onRecommendationClick(rp.productId); onAdd(rp, event); }} disabled={!storefrontProductCanBeOrdered(rp)} className="store-primary-action store-mobile-action mt-0.5 flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-bold transition motion-safe:active:scale-95 disabled:cursor-not-allowed disabled:opacity-50">{rp.isCustomizable ? <AlertTriangle aria-hidden className="size-3" /> : <Plus aria-hidden className="size-3" />} {recommendationActionLabel(rp)}</button>
            </div>
          </article>
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
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [autoPlayPaused, setAutoPlayPaused] = useState(false);
  useEffect(() => {
    if (banners.length <= 1 || interactionPaused || autoPlayPaused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setCur((i) => (i + 1) % banners.length), 4500);
    return () => clearInterval(t);
  }, [autoPlayPaused, banners.length, interactionPaused]);
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
      onMouseEnter={() => setInteractionPaused(true)}
      onMouseLeave={() => setInteractionPaused(false)}
      onFocusCapture={() => setInteractionPaused(true)}
      onBlurCapture={() => setInteractionPaused(false)}
      onPointerDown={() => setInteractionPaused(true)}
    >
      <div className={`relative overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5 ${aspect}`}>
        {banners.map((b, i) => (
          <div key={`${b.id}-${b.imageIndex ?? 0}`} aria-hidden={i !== active} inert={i !== active} className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${i === active ? "opacity-100" : "pointer-events-none opacity-0"}`}>
            <BannerFrame banner={b} slot={slot} active={i === active} />
          </div>
        ))}
        {banners.length > 1 && <span className="absolute right-3 top-3 rounded-full bg-[#183d36]/85 px-2.5 py-1 text-[10px] font-black text-white shadow-sm">{active + 1} / {banners.length}</span>}
      </div>
      {banners.length > 1 && (
        <div className="mt-2.5 flex items-center justify-center gap-1.5" aria-label="اختيار البنر">
          <button type="button" onClick={() => setAutoPlayPaused((value) => !value)} aria-label={autoPlayPaused ? "تشغيل تبديل البنرات تلقائياً" : "إيقاف تبديل البنرات تلقائياً"} aria-pressed={autoPlayPaused} className="flex size-11 items-center justify-center rounded-full border border-[#d7d2ca] bg-white text-[#1e4a63]">{autoPlayPaused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}</button>
          {banners.map((b, i) => (
            <button
              type="button"
              key={`${b.id}-${b.imageIndex ?? 0}`}
              onClick={() => { setCur(i); setAutoPlayPaused(true); }}
              aria-current={i === active ? "true" : undefined}
              aria-label={`الانتقال للبنر ${i + 1}`}
              className={`flex size-6 items-center justify-center rounded-full transition-colors motion-reduce:transition-none ${i === active ? "bg-[var(--store-accent)]" : "bg-[#f3b85a]/60 hover:bg-[var(--store-accent)]"}`}
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

// اقتراحات البحث: مُصفَّرة من `filteredItems` (لا `items`) — لتحترم الفلاتر النشطة (قائمة أعجبتني،
// الماركة، السعر، التوفّر). كان الاقتراح من `items` يعرض منتجاً يختفي فور اختياره لأنّ
// فلترَ العميل يرفضه (Codex P2 على #761). العتبة حرفان ≥ لضبط الضوضاء.
export function getStorefrontSearchSuggestions<T extends { productName: string; brand?: string | null }>(products: T[], rawSearch: string): T[] {
  const term = normalizeStorefrontArabic(rawSearch.trim());
  if (term.length < 2) return [];
  return products
    .filter((product) => normalizeStorefrontArabic(`${product.productName} ${product.brand ?? ""}`).includes(term))
    .slice(0, 6);
}

function hasStorefrontAnalyticsConsent(): boolean {
  try {
    const raw = window.localStorage.getItem("arabia_store_consent_v1");
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { analytics?: unknown };
    return parsed.analytics === true;
  } catch {
    return false;
  }
}

function StorefrontContent() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchSuggestionIndex, setSearchSuggestionIndex] = useState(0);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  // البدء بالمتوفر يحمي نية الشراء: لا نُغرق العميل ببطاقات لا يمكن إضافتها للسلة.
  const [availability, setAvailability] = useState<AvailabilityFilter>("IN_STOCK");
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("ALL");
  const [brand, setBrand] = useState("");
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recentlyAddedProductId, setRecentlyAddedProductId] = useState<number | null>(null);
  const [heartPulseTarget, setHeartPulseTarget] = useState<string | null>(null);
  const [heartPulseNonce, setHeartPulseNonce] = useState(0);
  const [sharePulseTarget, setSharePulseTarget] = useState<string | null>(null);
  const [sharePulseNonce, setSharePulseNonce] = useState(0);
  const [cartFlight, setCartFlight] = useState<{ id: number; imageUrl: string | null; left: number; top: number; deltaX: number; deltaY: number } | null>(null);
  const cartButtonRef = useRef<HTMLButtonElement | null>(null);
  const cartFlightIdRef = useRef(0);
  const [selectedStoreUnitId, setSelectedStoreUnitId] = useState<number | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  // اختيار متعدد للمتغيرات في ورقة المنتج. المفتاح هو وحدة البيع، لا معرّف المتغير،
  // كي لا تختلط وحدات مختلفة للون نفسه داخل السلة أو عند التسعير الخادمي.
  const [variantQuantities, setVariantQuantities] = useState<Map<number, number>>(new Map());
  const [customizationDraft, setCustomizationDraft] = useState<StorefrontCustomization>({ kind: "PRINT" });
  const [panel, setPanel] = useState<Panel>(null);
  const [wishlistIds, setWishlistIds] = useState<Set<number>>(loadStorefrontWishlist);
  const [showWishlist, setShowWishlist] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [couponDraft, setCouponDraft] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState<string | null>(null);
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);
  const [cart, setCart] = useState<Map<string, CartLine>>(loadCart);
  const [cartStatus, setCartStatus] = useState("");
  const cartRecommendationProductIds = useMemo(
    () => Array.from(cart.values()).map((line) => line.productId).slice(0, 24),
    [cart],
  );

  const [form, setForm] = useState<CheckoutForm>(loadForm);
  const [checkoutErrors, setCheckoutErrors] = useState<CheckoutFieldErrors>({});
  const productDialogCloseRef = useRef<HTMLButtonElement | null>(null);
  const productDialogTriggerRef = useRef<HTMLElement | null>(null);
  function openProduct(productId: number) {
    const activeElement = typeof document === "undefined" ? null : document.activeElement;
    productDialogTriggerRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
    setSelectedId(productId);
  }
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

  // تتبّع الضيف بملكيةٍ opaque قصيرة العمر؛ لا رقم هاتف ولا بيانات عميل في الطلب أو التخزين.
  const utils = trpc.useUtils();
  const trackOrderByToken = trpc.storefront.trackOrderByToken.useMutation();
  const [trustedTrackingOrders, setTrustedTrackingOrders] = useState<GuestTrackingOrder[]>(loadGuestTrackingOrders);
  const [trackToken, setTrackToken] = useState("");
  const [trackResult, setTrackResult] = useState<TrackData | null>(null);
  const [trackState, setTrackState] = useState<"idle" | "loading" | "notfound" | "error">("idle");
  const [trackError, setTrackError] = useState<string | null>(null);
  const labelParams = useMemo(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const orderNumber = q.get("order");
    const token = q.get("token");
    return orderNumber && token ? { orderNumber, token } : null;
  }, []);
  const openTrack = (orderNumber = "") => {
    const saved = loadGuestTrackingOrders();
    setTrustedTrackingOrders(saved);
    setTrackToken(saved.find((order) => order.orderNumber === orderNumber)?.trackingToken ?? "");
    setTrackResult(null);
    setTrackState("idle");
    setTrackError(null);
    setPanel("track");
  };
  const doTrack = async (savedToken?: string) => {
    const trackingToken = (savedToken ?? trackToken).trim();
    setTrackToken(trackingToken);
    if (trackingToken.length < 60 || trackingToken.length > 160) {
      setTrackError("ألصق رمز التتبّع الكامل الصادر بعد إنشاء الطلب.");
      window.requestAnimationFrame(() => document.getElementById("storefront-track-token")?.focus());
      return;
    }
    setTrackError(null);
    setTrackState("loading");
    setTrackResult(null);
    try {
      const result = await trackOrderByToken.mutateAsync({ trackingToken });
      setTrackResult(result);
      setTrackState("idle");
    } catch (error) {
      const code = typeof error === "object" && error && "data" in error
        ? (error as { data?: { code?: string } }).data?.code
        : undefined;
      setTrackState(code === "NOT_FOUND" ? "notfound" : "error");
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [rawSearch]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${STORE_NAME} | التسوق والتوصيل في العراق`;
    return () => { document.title = previousTitle; };
  }, []);

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
  const recommendationClickM = trpc.storefront.trackRecommendationClick.useMutation();
  const createCartShareM = trpc.storefront.createCartShare.useMutation();
  const cartRecommendationsQ = trpc.storefront.cartRecommendations.useQuery(
    { productIds: cartRecommendationProductIds },
    {
      enabled: panel === "cart" && cartRecommendationProductIds.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const trackRecommendationClick = (recommendedProductId: number) => {
    if (selectedId == null || !hasStorefrontAnalyticsConsent()) return;
    recommendationClickM.mutate({ sourceProductId: selectedId, recommendedProductId });
  };
  const storefrontQuoteLines = useMemo(
    () => Array.from(cart.values()).map((line) => ({ productUnitId: line.productUnitId, quantity: line.qty })),
    [cart],
  );
  const storefrontQuoteInput = useMemo(() => ({
    governorate: form.governorate,
    lines: storefrontQuoteLines,
  }), [form.governorate, storefrontQuoteLines]);
  const publicQuoteQ = trpc.storefront.quoteOrder.useQuery(storefrontQuoteInput, {
    enabled: panel === "checkout" && cart.size > 0 && !appliedCouponCode,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const privateQuoteM = trpc.storefront.quoteOrderPrivate.useMutation();
  const privateQuoteInput = useMemo(() => appliedCouponCode ? ({
    couponCode: appliedCouponCode,
    governorate: form.governorate,
    lines: storefrontQuoteLines,
  }) : null, [appliedCouponCode, form.governorate, storefrontQuoteLines]);
  useEffect(() => {
    if (panel !== "checkout" || cart.size === 0 || !privateQuoteInput) {
      privateQuoteM.reset();
      return;
    }
    privateQuoteM.reset();
    privateQuoteM.mutate(privateQuoteInput);
  // mutation functions are stable; request identity is the intentional trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.size, panel, privateQuoteInput]);
  const quoteQ = {
    data: appliedCouponCode ? privateQuoteM.data : publicQuoteQ.data,
    isFetching: appliedCouponCode ? privateQuoteM.isPending : publicQuoteQ.isFetching,
    isError: appliedCouponCode ? privateQuoteM.isError : publicQuoteQ.isError,
    error: appliedCouponCode ? privateQuoteM.error : publicQuoteQ.error,
  };
  const trackConversion = trpc.storefront.trackConversion.useMutation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedProductId = Number(params.get("product"));
    if (Number.isInteger(sharedProductId) && sharedProductId > 0) setSelectedId(sharedProductId);
    const token = params.get("cartToken")?.trim();
    if (!token || !/^[A-Za-z0-9_-]{20,32}$/.test(token)) return;
    let cancelled = false;
    void utils.storefront.getCartShare.fetch({ token }).then((shared) => {
      if (cancelled) return;
      const incoming = new Map<string, CartLine>();
      for (const item of shared.items) {
        const line: CartLine = {
          cartKey: customizationCartKey(item.productUnitId),
          productUnitId: item.productUnitId,
          productId: item.productId,
          name: item.name,
          price: Number(item.price).toFixed(2),
          imageUrl: item.imageUrl,
          unitName: item.unitName,
          variantLabel: item.variantLabel,
          qty: Math.min(Math.max(Math.floor(item.quantity), 1), 999),
        };
        incoming.set(line.cartKey, line);
      }
      if (incoming.size > 0) {
        setCart((current) => {
          const next = new Map(current);
          incoming.forEach((line) => next.set(line.cartKey, line));
          saveCart(next);
          return next;
        });
        setShareFeedback(shared.skippedCount > 0
          ? `تم تحميل ${incoming.size} من المنتجات؛ أزيل ${shared.skippedCount} لم يعد متاحاً. راجع الأسعار قبل التأكيد`
          : "تم تحميل السلة المشتركة؛ راجع الأسعار قبل التأكيد");
      }
    }).catch(() => {
      if (!cancelled) setShareFeedback("تعذّر فتح رابط السلة أو انتهت صلاحيته؛ يمكنك متابعة التصفح بشكل طبيعي");
    });
    return () => { cancelled = true; };
  }, [utils]);

  // كل فتح متعمد لتفاصيل منتج = مشاهدة؛ لا نرسل اسم المنتج أو هويّة/جلسة الزائر.
  useEffect(() => {
    if (selectedId != null && !viewedProductIds.current.has(selectedId)) {
      viewedProductIds.current.add(selectedId);
      if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "PRODUCT_VIEW" });
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
      if (res.guestTrackingToken && res.guestTrackingExpiresAt) {
        const expiresAt = res.guestTrackingExpiresAt instanceof Date
          ? res.guestTrackingExpiresAt.toISOString()
          : new Date(res.guestTrackingExpiresAt).toISOString();
        setTrustedTrackingOrders(rememberGuestTrackingOrder({
          orderNumber: res.orderNumber,
          trackingToken: res.guestTrackingToken,
          expiresAt,
        }));
      }
      setCart(new Map());
      setCouponDraft("");
      setAppliedCouponCode(null);
      setCouponFeedback(null);
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
          const currentQuoteInput = {
            governorate: formRef.current.governorate,
            lines: Array.from(cartRef.current.values()).map((line) => ({
              productUnitId: line.productUnitId,
              quantity: line.qty,
            })),
          };
          const quoted = appliedCouponCode
            ? await privateQuoteM.mutateAsync({ ...currentQuoteInput, couponCode: appliedCouponCode })
            : await utils.storefront.quoteOrder.fetch(currentQuoteInput);
          const refreshedQuote = reconcileStorefrontCartQuote(cartRef.current, quoted.lines);
          const totalChanged = failedAttempt == null ||
            Number(quoted.total).toFixed(2) !== Number(failedAttempt.expectedGrandTotal).toFixed(2);
          if (refreshedQuote.unresolved === 0 && (refreshedQuote.priceChanged > 0 || totalChanged)) {
            cartRef.current = refreshedQuote.cart;
            setCart(refreshedQuote.cart);
            acceptedQuoteRef.current = {
              fingerprint: storefrontCheckoutFingerprint(refreshedQuote.cart, formRef.current, appliedCouponCode),
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
  const detailMedia = useMemo(
    () => detailQ.data ? storefrontVariantMedia(detailQ.data, detailVariant?.variantId) : { urls: undefined, fallbackUrl: null },
    [detailQ.data, detailVariant],
  );
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
      if (showWishlist && !wishlistIds.has(p.productId)) return false;
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
  }, [availability, brand, items, priceFilter, showWishlist, sort, wishlistIds]);
  const hasRefinements = availability !== "IN_STOCK" || priceFilter !== "ALL" || brand !== "" || sort !== "RECOMMENDED" || showWishlist;
  // اقتراحات البحث: مُصفَّرة من `filteredItems` (Codex #4) — لا يظهر اقتراحٌ ينتفي فور اختياره.
  const searchSuggestions = useMemo(() => getStorefrontSearchSuggestions(filteredItems, rawSearch), [filteredItems, rawSearch]);
  useEffect(() => { setSearchSuggestionIndex(0); }, [rawSearch]);
  // اختيار اقتراحٍ يفتح مودال المنتج بمعرّفه (Codex #1) — لا نملأ حقل البحث بـ`productName`
  // فقد يكون `storeTitle` مخصَّصاً للقناة يعجز `storefrontCatalog` عن إيجاده (يبحث في `products.name`
  // والماركة والباركود فقط) فيرجع نتيجةً فارغة رغم أنّ المنتج موجود. الفتح بالـID جوابٌ مقاومٌ للانحراف
  // بين حقل العرض وحقل البحث الخادميّ.
  const chooseSearchSuggestion = (product: (typeof filteredItems)[number]) => {
    setSearchFocused(false);
    setSelectedId(product.productId);
  };
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
  function pulseHeart(target: string) {
    setHeartPulseTarget(target);
    setHeartPulseNonce((value) => value + 1);
    window.setTimeout(() => setHeartPulseTarget((current) => current === target ? null : current), 620);
  }
  function pulseShare(target: string) {
    setSharePulseTarget(target);
    setSharePulseNonce((value) => value + 1);
    window.setTimeout(() => setSharePulseTarget((current) => current === target ? null : current), 620);
  }
  function triggerCartFlight(sourceElement: HTMLElement | null | undefined, imageUrl: string | null) {
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const source = sourceElement?.getBoundingClientRect();
    const target = cartButtonRef.current?.getBoundingClientRect();
    if (!source || !target || source.width === 0 || target.width === 0) return;
    const startX = source.left + source.width / 2 - 22;
    const startY = source.top + Math.min(source.height / 2, 28) - 22;
    const targetX = target.left + target.width / 2 - 22;
    const targetY = target.top + target.height / 2 - 22;
    const id = cartFlightIdRef.current + 1;
    cartFlightIdRef.current = id;
    setCartFlight({ id, imageUrl, left: startX, top: startY, deltaX: targetX - startX, deltaY: targetY - startY });
    window.setTimeout(() => setCartFlight((current) => current?.id === id ? null : current), 700);
  }
  function toggleWishlist(productId: number, target = `product-${productId}`) {
    pulseHeart(target);
    setWishlistIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      saveStorefrontWishlist(next);
      return next;
    });
  }
  async function shareStorefrontContent(input: { title: string; text: string; url: string }) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share(input);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(`${input.text}\\n${input.url}`);
        setShareFeedback("تم نسخ رابط المشاركة — أرسله لمن تحب");
      } else {
        setShareFeedback("انسخ الرابط من شريط العنوان لمشاركته");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareFeedback("تعذّرت المشاركة حالياً؛ يمكنك نسخ الرابط من شريط العنوان");
    }
    window.setTimeout(() => setShareFeedback(null), 3600);
  }
  function shareProduct(productId: number, productName: string) {
    pulseShare(`product-${productId}`);
    void shareStorefrontContent({
      title: productName,
      text: `شاهد هذا المنتج من ${STORE_NAME}`,
      url: storefrontShareUrl({ product: String(productId) }),
    });
  }
  async function shareCart() {
    if (cartLines.length === 0 || createCartShareM.isPending) return;
    pulseShare("cart");
    try {
      const shared = await createCartShareM.mutateAsync({
        lines: cartLines.slice(0, 100).map((line) => ({
          productId: line.productId,
          productUnitId: line.productUnitId,
          quantity: Math.min(Math.max(Math.floor(line.qty), 1), 999),
        })),
      });
      await shareStorefrontContent({
        title: `سلة من ${STORE_NAME}`,
        text: `هذه سلة منتجات من ${STORE_NAME} — راجع الأسعار قبل تثبيت الطلب`,
        url: storefrontShareUrl({ cartToken: shared.token }),
      });
    } catch {
      setShareFeedback("تعذّر إنشاء رابط السلة حالياً؛ يمكنك متابعة التصفح بشكل طبيعي");
    }
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
  const cartHasUnsupportedCustomization = cartLines.some((line) => line.isCustomizable || Boolean(line.customization));
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0);
  const cartSubtotal = cartLines.reduce((s, l) => s + Number(l.price) * l.qty, 0);
  const deliveryFee = deliveryFeeFor(form.governorate);
  const freeThreshold = settingsQ.data?.freeShippingThreshold ? Number(settingsQ.data.freeShippingThreshold) : 0;
  const qualifiesFree = freeThreshold > 0 && cartSubtotal >= freeThreshold;
  const effectiveDeliveryFee = qualifiesFree ? 0 : deliveryFee;
  const remainingForFree = freeThreshold > 0 ? Math.max(freeThreshold - cartSubtotal, 0) : 0;
  const cartTotal = cartSubtotal + effectiveDeliveryFee;
  const quotedSubtotal = quoteQ.data?.subtotal ?? cartSubtotal.toFixed(2);
  const quotedDeliveryFee = quoteQ.data?.deliveryFee ?? effectiveDeliveryFee.toFixed(2);
  const quotedTotal = quoteQ.data?.total ?? cartTotal.toFixed(2);
  const quotedCouponDiscount = quoteQ.data?.couponDiscount ?? "0.00";
  const quoteReady = !!quoteQ.data && !quoteQ.isFetching && !quoteQ.isError;

  function applyCoupon() {
    const normalized = couponDraft.trim().toUpperCase().replace(/\s+/g, "");
    if (!normalized) {
      setCouponFeedback("اكتب رمز الكوبون أولاً");
      return;
    }
    setAppliedCouponCode(normalized);
    setCouponFeedback("جارٍ التحقق من الكوبون…");
    acceptedQuoteRef.current = null;
    setCheckoutSafetyError(null);
  }
  function removeCoupon() {
    setAppliedCouponCode(null);
    setCouponDraft("");
    setCouponFeedback(null);
    acceptedQuoteRef.current = null;
    setCheckoutSafetyError(null);
  }

  function addToCart(p: {
    productUnitId: number; productId: number; productName: string; price: string | null;
    salePrice?: string | null; imageUrl: string | null; unitName: string; variantLabel?: string; inStock?: boolean; isCustomizable?: boolean; customization?: StorefrontCustomization; stockLimit?: number | null;
  }, sourceElement?: HTMLElement | null) {
    const eff = p.salePrice ?? p.price;
    if (eff == null || !storefrontProductCanBeOrdered(p) || p.customization) return;
    const cartKey = customizationCartKey(p.productUnitId, p.customization);
    const currentLine = cartRef.current.get(cartKey);
    if (p.stockLimit != null && (currentLine?.qty ?? 0) >= p.stockLimit) {
      setCartStatus(`بلغت الكمية المتوفرة من ${p.productName}: ${p.stockLimit}.`);
      return;
    }
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    setCart((prev) => addStorefrontCartLine(prev, p, eff));
    setCartStatus(`تمت إضافة ${p.productName} إلى السلة.`);
    triggerCartFlight(sourceElement, p.imageUrl);
  }
  function addFeaturedToCart(p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) {
    if (!storefrontProductCanBeOrdered(p) || (p.salePrice == null && p.price == null)) return;
    addCatalogProduct(p, event);
    if (recommendationNeedsSelection(p)) return;
    setRecentlyAddedProductId(p.productId);
    window.setTimeout(() => setRecentlyAddedProductId((current) => current === p.productId ? null : current), 1600);
  }
  function addCatalogProduct(p: StorefrontProductForCartAction, event: React.MouseEvent<HTMLButtonElement>) {
    if (!storefrontProductCanBeOrdered(p)) {
      openProduct(p.productId);
      return;
    }
    const availableUnits = [
      ...(p.storeUnits ?? []),
      ...(p.variants ?? []).flatMap((variant) => variant.units),
    ].filter((unit) => unit.inStock);
    const needsDetails = recommendationNeedsSelection(p);
    if (needsDetails || (availableUnits.length !== 1 && availableUnits.length !== 0)) {
      openProduct(p.productId);
      return;
    }
    const unit = availableUnits[0];
    if (unit) {
      addToCart({
        productUnitId: unit.productUnitId,
        productId: p.productId,
        productName: p.productName,
        price: unit.price,
        salePrice: unit.salePrice,
        imageUrl: p.imageUrl,
        unitName: unit.unitName,
        variantLabel: p.variants?.find((variant) => variant.units.some((candidate) => candidate.productUnitId === unit.productUnitId))?.label,
        inStock: unit.inStock,
        stockLimit: unit.stockLeft,
      }, event.currentTarget);
      return;
    }
    if (p.productUnitId > 0 && p.price != null && p.inStock !== false) {
      addToCart({
        productUnitId: p.productUnitId,
        productId: p.productId,
        productName: p.productName,
        price: p.price,
        salePrice: p.salePrice,
        imageUrl: p.imageUrl,
        unitName: p.unitName,
        inStock: p.inStock,
        stockLimit: p.stockLeft,
      }, event.currentTarget);
      return;
    }
    openProduct(p.productId);
  }

  function setVariantQuantity(productUnitId: number, quantity: number) {
    const unit = (detailQ.data?.variants ?? []).flatMap((variant) => variant.units).find((candidate) => candidate.productUnitId === productUnitId)
      ?? detailQ.data?.storeUnits?.find((candidate) => candidate.productUnitId === productUnitId);
    const stockLimit = unit?.stockLeft == null ? 999 : Math.max(1, Math.min(Math.floor(unit.stockLeft), 999));
    setVariantQuantities((previous) => {
      const next = new Map(previous);
      if (quantity <= 0) next.delete(productUnitId);
      else next.set(productUnitId, Math.min(Math.trunc(quantity), stockLimit));
      return next;
    });
  }
  function addSelectedVariants(sourceElement?: HTMLElement | null) {
    if (!detailQ.data || !storefrontProductCanBeOrdered(detailQ.data) || customizationValidation) return;
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
          imageUrl: variant.imageUrl ?? detailQ.data.imageUrl,
          unitName: unit.unitName,
          variantLabel: variant.label,
          customization,
          effectivePrice,
          quantity,
          stockLimit: unit.stockLeft,
        });
      }
    }
    if (selections.length === 0) return;
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    setCart((previous) => addStorefrontCartLines(previous, selections));
    setCartStatus(`تمت إضافة ${selections.length} من اختيارات ${detailQ.data.productName} إلى السلة.`);
    triggerCartFlight(sourceElement, detailMedia.fallbackUrl);
    setSelectedId(null);
  }
  function addSelectedUnit(sourceElement?: HTMLElement | null) {
    if (!detailQ.data || !storefrontProductCanBeOrdered(detailQ.data) || !detailUnit || !detailUnit.inStock || customizationValidation) return;
    const effectivePrice = detailUnit.salePrice ?? detailUnit.price;
    if (!effectivePrice) return;
    const quantity = Math.max(1, variantQuantities.get(detailUnit.productUnitId) ?? 1);
    const selection: StorefrontCartSelection = {
      productUnitId: detailUnit.productUnitId,
      productId: detailQ.data.productId,
      productName: detailQ.data.productName,
      imageUrl: detailVariant?.imageUrl ?? detailQ.data.imageUrl,
      unitName: detailUnit.unitName,
      variantLabel: detailVariant?.label,
      customization: selectedCustomization(),
      effectivePrice,
      quantity,
      stockLimit: detailUnit.stockLeft,
    };
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    setCart((previous) => addStorefrontCartLines(previous, [selection]));
    setCartStatus(`تمت إضافة ${detailQ.data.productName} إلى السلة.`);
    triggerCartFlight(sourceElement, detailMedia.fallbackUrl);
    setSelectedId(null);
  }
  function setQty(cartKey: string, qty: number) {
    const line = cartRef.current.get(cartKey);
    if (line?.stockLimit != null && qty > line.stockLimit) {
      setCartStatus(`المتوفر من ${line.name} هو ${line.stockLimit} فقط.`);
    } else if (line) {
      setCartStatus(qty <= 0 ? `تمت إزالة ${line.name} من السلة.` : `أصبحت كمية ${line.name}: ${Math.max(1, qty)}.`);
    }
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
    if (cartHasUnsupportedCustomization) {
      setCartStatus(STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE);
      return;
    }
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "BEGIN_CHECKOUT" });
    setTurnstileToken(null);
    setTurnstileResetKey((key) => key + 1);
    setPanel("checkout");
  }
  function updateCheckoutField(field: keyof CheckoutForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    const errorField: keyof CheckoutFieldErrors | null = field === "notes" ? null : field;
    if (errorField) {
      setCheckoutErrors((current) => {
        if (!current[errorField]) return current;
        const next = { ...current };
        delete next[errorField];
        return next;
      });
    }
  }
  function submitOrder() {
    setCheckoutSafetyError(null);
    const validationErrors = validateStorefrontCheckout(form);
    setCheckoutErrors(validationErrors);
    const firstError = (["name", "phone", "governorate", "address"] as const).find((field) => validationErrors[field]);
    if (firstError) {
      window.requestAnimationFrame(() => document.getElementById(`storefront-checkout-${firstError}`)?.focus());
      return;
    }
    const name = form.name.trim();
    const phone = form.phone.replace(/\s+/g, " ").trim();
    const address = form.address.trim();
    if (cartLines.length === 0) {
      setCheckoutSafetyError("السلة فارغة؛ أضف منتجاً قبل تأكيد الطلب.");
      return;
    }
    if (cartHasUnsupportedCustomization) {
      setCheckoutSafetyError(`${STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE}؛ احذف المنتج المخصص من السلة للمتابعة.`);
      return;
    }
    if (!quoteReady) {
      setCheckoutSafetyError("نحدّث السعر النهائي الآن؛ انتظر لحظة ثم أعد التأكيد.");
      return;
    }
    if (!orderingEnabled) {
      setCheckoutSafetyError("استقبال الطلبات متوقف مؤقتاً؛ يمكنك التواصل عبر واتساب.");
      return;
    }
    if (!settingsQ.data?.turnstileSiteKey || !turnstileToken) {
      setCheckoutSafetyError("أكمل التحقق الأمني قبل تأكيد الطلب.");
      return;
    }
    const fingerprint = storefrontCheckoutFingerprint(cart, form, appliedCouponCode);
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
          expectedGrandTotal: acceptedQuote?.total ?? (quoteQ.data?.total ?? cartTotal.toFixed(2)),
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
      couponCode: appliedCouponCode || undefined,
      customerName: name,
      customerPhone: phone,
      governorate: form.governorate,
      addressText: address,
      notes: orderNotes || undefined,
      lines: cartLines.map((l) => ({
        productUnitId: l.productUnitId,
        quantity: l.qty,
        expectedUnitPrice: quoteQ.data?.lines.find((quoted) => quoted.productUnitId === l.productUnitId)?.unitPrice ?? Number(l.price).toFixed(2),
      })),
      expectedGrandTotal: attempt.expectedGrandTotal,
      clientRequestId: attempt.clientRequestId,
      turnstileToken: turnstileToken!,
    });
  }
  const chip = (active: boolean) =>
    `whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-bold transition ${
      active
        ? "bg-emerald-700 text-white shadow-sm shadow-[#1e4a63]/25"
        : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-emerald-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700"
    }`;

  const featuredHero = heroBanners[0] ?? null;
  const buyingPaths = [
    { title: "المدرسة والجامعة", description: "أساسيات الدراسة في مكان واحد", keywords: ["مدرسة", "جامعة", "دراسة", "قرطاسية", "دفاتر", "اقلام"], icon: <Briefcase aria-hidden className="size-5" />, tone: "bg-[#e9eef2] text-[#1e4a63]" },
    { title: "مكتب يومي", description: "أدوات ترفع جودة يومك", keywords: ["مكتب", "مستلزمات", "قرطاسية", "طباعة"], icon: <LayoutGrid aria-hidden className="size-5" />, tone: "bg-[#f3e5da] text-[#a4513f]" },
    { title: "هدايا وطباعة", description: "حلول جاهزة للمناسبات والعمل", keywords: ["هدايا", "هدية", "مناسبات", "طباعة", "تغليف"], icon: <Package aria-hidden className="size-5" />, tone: "bg-[#ece8df] text-[#6b5d4f]" },
  ];
  const selectBuyingPath = (keywords: string[]) => {
    const normalizedKeywords = keywords.map(normalizeStorefrontArabic);
    const match = cats.find((category) => {
      const name = normalizeStorefrontArabic(category.name);
      return normalizedKeywords.some((keyword) => keyword && name.includes(keyword));
    });
    if (match) {
      selectCategory(match.id);
      return;
    }
    // لا نخترع نتيجة بحث عند اختلاف تسمية التصنيف؛ نعرض المتاح بترتيب تجاري حقيقي.
    setAvailability("IN_STOCK");
    setSort("BEST_SELLERS");
    scrollToResults();
  };

  return (
    <div className="storefront min-h-dvh overflow-x-clip bg-[#f4f1ec] text-[#20252a] dark:bg-slate-950 dark:text-slate-100" dir="rtl">
      <a href="#store-main" className="fixed right-4 z-[100] -translate-y-[160%] rounded-lg bg-[#1e4a63] px-4 py-3 text-sm font-black text-white shadow-lg transition-transform focus:translate-y-0" style={{ top: "calc(.5rem + env(safe-area-inset-top))" }}>تجاوز إلى محتوى المتجر</a>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{cartStatus}</div>
      <header className="sticky top-0 z-30 border-b border-[#ded8d0] bg-[#fbfaf8] dark:border-slate-800 dark:bg-slate-900" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="hidden border-b border-[#ebe6df] bg-[#f4f1ec] sm:block dark:border-slate-800 dark:bg-slate-950">
          <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-2 text-[11px] font-bold text-[#6c747b] lg:px-8">
            <span>توصيل موثوق إلى جميع المحافظات</span>
            <span>الدفع عند الاستلام متاح على كل الطلبات</span>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-2 px-4 py-3 sm:flex-nowrap sm:gap-4 lg:px-8">
          <a href="/store" className="order-1 flex min-w-0 flex-1 items-center gap-3 text-right sm:order-none sm:min-w-[168px] sm:flex-none">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#1e4a63] text-white">
              <ShoppingBag aria-hidden className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-black tracking-tight text-[#1e4a63]">{STORE_NAME}</span>
              <span className="block truncate text-xs font-bold text-[#59636a]">{STORE_TAGLINE}</span>
            </span>
          </a>
          <nav className="hidden items-center gap-5 text-xs font-extrabold text-[#46515a] lg:flex" aria-label="التنقل الرئيسي">
            <a href="#store-start" className="transition hover:text-[#1e4a63]">اكتشف</a>
            <a href="#store-picks" className="transition hover:text-[#1e4a63]">مختاراتنا</a>
            <a href="#store-results" className="transition hover:text-[#1e4a63]">المنتجات</a>
            <a href="#store-deals" className="transition hover:text-[#a4513f]">العروض</a>
          </nav>
          <div className="relative order-4 w-full flex-none sm:order-none sm:min-w-0 sm:flex-1">
            <Search aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-[#7d8589]" />
            <input
              type="search"
              value={rawSearch}
              onChange={(e) => {
                setRawSearch(e.target.value);
                setSearchFocused(true); // Codex #3: يُعيد فتح القائمة بعد Escape/Enter حين يغيّر الاستعلام
              }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { setSearchFocused(false); return; }
                if (event.key === "ArrowDown" && searchSuggestions.length > 0) {
                  event.preventDefault();
                  setSearchSuggestionIndex((index) => Math.min(index + 1, searchSuggestions.length - 1));
                  return;
                }
                if (event.key === "ArrowUp" && searchSuggestions.length > 0) {
                  event.preventDefault();
                  setSearchSuggestionIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const suggestion = searchSuggestions[searchSuggestionIndex];
                  if (suggestion) chooseSearchSuggestion(suggestion);
                  else { setSearch(rawSearch.trim()); setSearchFocused(false); scrollToResults(); }
                }
              }}
              aria-label="البحث في منتجات مكتبة العربية"
              placeholder="ما الذي تبحث عنه اليوم؟"
              className="w-full rounded-lg border border-[#d7d2ca] bg-white py-3 pr-10 pl-11 text-sm font-semibold text-[#20252a] outline-none transition placeholder:text-[#6c747b] focus:border-[#1e4a63] focus:ring-2 focus:ring-[#1e4a63]/10 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={searchFocused && searchSuggestions.length > 0}
              aria-controls="store-search-suggestions"
              aria-activedescendant={searchFocused && searchSuggestions[searchSuggestionIndex] ? `store-search-suggestion-${searchSuggestions[searchSuggestionIndex].productId}` : undefined}
            />
            {rawSearch && (
              <button type="button" onClick={() => { setRawSearch(""); setSearch(""); }} aria-label="مسح البحث" className="absolute left-2.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-[#7d8589] transition hover:bg-[#f0ece7] hover:text-[#20252a]">
                <X aria-hidden className="size-4" />
              </button>
            )}
            {searchFocused && searchSuggestions.length > 0 && (
              <div
                id="store-search-suggestions"
                role="listbox"
                aria-label="اقتراحات البحث"
                className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-xl border border-[#ded8d0] bg-white p-1.5 shadow-xl dark:border-slate-700 dark:bg-slate-800"
              >
                {searchSuggestions.map((product, index) => (
                  <button
                    key={product.productId}
                    id={`store-search-suggestion-${product.productId}`}
                    type="button"
                    role="option"
                    aria-selected={index === searchSuggestionIndex}
                    tabIndex={-1} // Codex #2: خارج تسلسل Tab — aria-activedescendant يُدير التركيز افتراضياً
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSearchSuggestionIndex(index)}
                    onClick={() => chooseSearchSuggestion(product)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-right focus:outline-none ${index === searchSuggestionIndex ? "bg-[#f6f1eb] dark:bg-slate-700" : "hover:bg-[#f6f1eb] dark:hover:bg-slate-700"}`}
                  >
                    <span className="line-clamp-1 text-xs font-bold text-[#20252a] dark:text-slate-100">{product.productName}</span>
                    {product.brand && <span className="shrink-0 text-[10px] font-black text-[#a4513f]">{product.brand}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => { pulseHeart("wishlist-header"); setShowWishlist((current) => !current); }} aria-label="قائمة أعجبتني" aria-pressed={showWishlist} className={`store-action-button order-2 relative flex size-11 shrink-0 items-center justify-center rounded-lg border bg-white transition hover:border-[#e65f4a] sm:order-none dark:bg-slate-800 ${showWishlist ? "border-[#e65f4a] text-[#e65f4a]" : "border-[#d7d2ca] text-[#1e4a63] dark:border-slate-700 dark:text-slate-100"} ${heartPulseTarget === "wishlist-header" ? "store-action-button--active" : ""}`}>
            <Heart key={`wishlist-header-${heartPulseNonce}`} aria-hidden className={`size-5 ${showWishlist ? "fill-current" : ""} ${heartPulseTarget === "wishlist-header" ? "animate__animated animate__heartBeat animate__faster" : ""}`} />
            {wishlistIds.size > 0 && <span className="absolute -right-2 -top-2 flex min-w-5 items-center justify-center rounded-full bg-[#e65f4a] px-1 text-[10px] font-black text-white">{wishlistIds.size}</span>}
          </button>
          <button ref={cartButtonRef} onClick={() => setPanel("cart")} aria-label="السلة" className="order-3 relative flex size-11 shrink-0 items-center justify-center rounded-lg border border-[#d7d2ca] bg-white text-[#1e4a63] transition hover:border-[#1e4a63] sm:order-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
            <ShoppingCart aria-hidden className={`size-5 ${cartFlight ? "animate__animated animate__tada animate__faster" : ""}`} />
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

      {cartFlight && (
        <div
          key={cartFlight.id}
          aria-hidden="true"
          className="store-cart-flight"
          style={{ left: cartFlight.left, top: cartFlight.top, "--store-cart-flight-x": `${cartFlight.deltaX}px`, "--store-cart-flight-y": `${cartFlight.deltaY}px` } as React.CSSProperties}
        >
          {cartFlight.imageUrl ? <img src={cartFlight.imageUrl} alt="" className="size-full rounded-[.65rem] object-contain" /> : <span className="store-cart-flight-fallback size-full"><Package aria-hidden className="size-5" /></span>}
        </div>
      )}

      <main id="store-main" tabIndex={-1} className="mx-auto w-full max-w-[1500px] overflow-x-clip px-4 py-6 pb-28 outline-none lg:px-8">
        <h1 className="sr-only">مكتبة العربية للتسوق والتوصيل في العراق</h1>
        {supportingFailures.length > 0 && (
          <section role="alert" aria-live="polite" className="mb-5 flex items-start gap-3 border-r-4 border-[#b87835] bg-[#fbf3e5] p-4 text-[#754f2c]">
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1"><p className="text-sm font-black">بعض بيانات المتجر تحتاج إلى إعادة المحاولة</p><p className="mt-1 text-xs leading-6">تعذّر تحميل {supportingFailures.map((source) => STOREFRONT_SOURCE_LABELS[source]).join("، ")}. يمكنك متابعة المنتجات المتاحة أو إعادة المحاولة.</p></div>
            <button type="button" onClick={retrySupportingSources} className="shrink-0 border border-[#b87835]/50 bg-white px-3 py-2 text-xs font-black text-[#754f2c] hover:bg-[#f8e8d0]">إعادة المحاولة</button>
          </section>
        )}
        {announcement && <div className="mb-5 flex items-center gap-2 border border-[#ead8c8] bg-[#fff8f2] px-4 py-3 text-sm font-bold text-[#754f2c]"><BadgePercent aria-hidden className="size-4 shrink-0" /><span>{announcement}</span></div>}
        {shareFeedback && <div role="status" className="animate__animated animate__fadeIn mb-5 border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-xs font-bold text-emerald-800">{shareFeedback}</div>}
        {settingsQ.isSuccess && !storeOpen && <div className="mb-5 border border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm font-bold text-rose-700">المتجر مغلق مؤقتاً — يمكنك تصفح المنتجات والعودة لاحقاً لإتمام الطلب.</div>}

        {!search && categoryId == null && !showWishlist && (
          <>
            <section id="store-start" className="grid overflow-hidden rounded-[28px] border border-[#d5d9da] bg-[#183d36] shadow-[0_22px_55px_-34px_rgba(24,61,54,0.9)] lg:grid-cols-[1.02fr_0.98fr]">
              <div className="flex flex-col justify-center p-6 text-white sm:p-10 lg:p-14">
                <p className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-[#d9e6ea]">قرطاسية • طباعة • هدايا</p>
                <h2 className="max-w-xl text-3xl font-black leading-[1.25] tracking-tight sm:text-5xl">كل ما تحتاجه ليومك،<br /><span className="text-[#f1b0a4]">بترتيب أسهل.</span></h2>
                <p className="mt-5 max-w-lg text-sm font-semibold leading-7 text-[#d7e4e7] sm:text-base">منتجات عملية، خيارات واضحة، وتوصيل يصل إليك في العراق. ابدأ من القسم المناسب أو ابحث عن منتجك مباشرة.</p>
                <div className="mt-7 flex flex-wrap gap-3">
                  <button type="button" onClick={() => scrollToResults()} className="bg-[var(--store-accent)] px-5 py-3 text-sm font-black text-white transition hover:bg-[var(--store-accent-strong)]">تصفح المنتجات</button>
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
              <div className="grid gap-3 md:grid-cols-3">{buyingPaths.map((path) => <button key={path.title} onClick={() => selectBuyingPath(path.keywords)} aria-label={`تصفح ${path.title}`} className={`flex min-h-36 flex-col justify-between p-5 text-right transition hover:-translate-y-0.5 hover:shadow-md ${path.tone}`}><span className="flex size-10 items-center justify-center rounded-lg bg-white/70">{path.icon}</span><span><span className="block text-lg font-black">{path.title}</span><span className="mt-1 block text-xs font-bold opacity-75">{path.description}</span><span className="mt-2 block text-[11px] font-black underline decoration-current/30 underline-offset-4">تصفح الاختيارات ←</span></span></button>)}</div>
            </section>

            <section className="mt-10 rounded-[28px] bg-[#eef8f4] px-4 py-5 sm:px-6 sm:py-7" aria-labelledby="store-category-title">
              <div className="mb-4 flex items-end justify-between"><div><p className="text-[11px] font-black uppercase tracking-[0.15em] text-[#a4513f]">تصفح حسب الحاجة</p><h2 id="store-category-title" className="mt-1 text-2xl font-black tracking-tight text-[#1e4a63]">الأقسام الرئيسية</h2></div><span className="text-xs font-bold text-[#7a817f]">{cats.length} أقسام متاحة</span></div>
              <div className="store-category-grid grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{cats.slice(0, 12).map((c, index) => <button key={c.id} onClick={() => selectCategory(c.id)} className="group border border-[#ddd8d1] bg-white p-4 text-right transition hover:border-[#1e4a63] hover:shadow-sm"><span className="mb-8 flex size-9 items-center justify-center rounded-lg bg-[#f0ece7] text-[#1e4a63] group-hover:bg-[#1e4a63] group-hover:text-white"><Store aria-hidden className="size-4" /></span><span className="block text-sm font-black text-[#30383e]">{c.name}</span><span className="mt-1 block text-[11px] font-bold text-[#8a918f]">{storefrontCategoryCount(c, availability)} منتج</span></button>)}</div>
            </section>

            {feedStrips.length > 0 && <div className="mt-8 rounded-[28px] bg-[#183d36] p-3 shadow-[0_18px_45px_-30px_rgba(24,61,54,0.85)] sm:p-4"><BannerCarousel banners={feedStrips} slot="INLINE" /></div>}

            {offers.length > 0 && <section id="store-deals" className="mt-10 rounded-[28px] border border-[#f0dfc7] bg-[#fff5e7] px-4 py-6 shadow-sm sm:px-6"><div className="mb-4 flex items-end justify-between"><div><p className="text-[11px] font-black uppercase tracking-[0.15em] text-[#f05d53]">عرض محدود</p><h2 className="mt-1 text-2xl font-black text-[#754f2c]">صفقات تستحق الإضافة</h2></div><BadgePercent aria-hidden className="size-6 text-[#f05d53]" /></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{offers.slice(0, 3).map((o) => <div key={o.id} className="flex items-center justify-between gap-4 rounded-2xl border border-[#ead8c8] bg-white p-4 transition hover:-translate-y-0.5 hover:shadow-md"><div><p className="text-sm font-black text-[#30383e]">{o.name}</p><p className="mt-1 text-xs font-bold text-[#8b6b50]">{offerLabel(o)} · {offerScopeLabel(o.scope)}</p></div><Tag aria-hidden className="size-5 shrink-0 text-[#f05d53]" /></div>)}</div></section>}

            <div id="store-picks" className="mt-10 grid min-w-0 grid-cols-1 gap-10 rounded-[28px] bg-[#f7f0fa] px-4 py-5 sm:px-6 sm:py-7">
              <ProductRow title="اكتشف الجديد" icon={<Tag aria-hidden className="size-4 text-[#e65f4a]" />} products={dealProducts} onSelect={setSelectedId} onAdd={addFeaturedToCart} recentlyAddedId={recentlyAddedProductId} />
              <ProductRow title="الأكثر طلباً" icon={<TrendingUp aria-hidden className="size-4 text-[#1e4a63]" />} products={bestSellers} onSelect={setSelectedId} onAdd={addFeaturedToCart} recentlyAddedId={recentlyAddedProductId} />
            </div>
          </>
        )}

        <section id="store-results" className="mt-12 scroll-mt-36 rounded-[28px] bg-white/80 px-4 py-5 shadow-sm ring-1 ring-[#e7e0d8] sm:px-6 sm:py-7">
          <div className="mb-5 flex flex-col gap-3 border-b border-[#d9d3ca] pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="text-xs font-black uppercase tracking-[0.15em] text-[#a4513f]">المنتجات</p><h2 className="mt-1 text-3xl font-black tracking-tight text-[#1e4a63]">{showWishlist ? "قائمة أعجبتني" : "كل المنتجات"}</h2><p className="mt-2 text-xs font-bold text-[#59636a]">{search ? `نتائج البحث عن «${search}»` : activeCatName ? `منتجات فئة «${activeCatName}»` : "تصفح المجموعة الكاملة واختر ما يناسبك"}</p></div><span role="status" aria-live="polite" aria-atomic="true" className="text-sm font-black text-[#1e4a63]">{filteredItems.length} منتج</span>
          </div>
          <div className="mb-6 flex flex-col gap-3 border border-[#d9d3ca] bg-white p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"><button type="button" onClick={() => { setAvailability((value) => value === "IN_STOCK" ? "ALL" : "IN_STOCK"); scrollToResults(); }} aria-pressed={availability === "IN_STOCK"} className={`shrink-0 border px-3 py-2 text-xs font-black ${availability === "IN_STOCK" ? "border-[#1e4a63] bg-[#1e4a63] text-white" : "border-[#d7d2ca] text-[#59636a]"}`}>{availability === "IN_STOCK" ? "متوفر الآن" : "كل المنتجات"}</button><label className="relative shrink-0"><span className="sr-only">نطاق السعر</span><select value={priceFilter} onChange={(e) => { setPriceFilter(e.target.value as PriceFilter); scrollToResults(); }} className="appearance-none border border-[#d7d2ca] bg-white py-2 pr-3 pl-8 text-xs font-bold text-[#59636a] outline-none focus:border-[#1e4a63]"><option value="ALL">كل الأسعار</option><option value="UNDER_5000">أقل من 5,000 د.ع</option><option value="FROM_5000_TO_15000">5,000 – 15,000 د.ع</option><option value="OVER_15000">أكثر من 15,000 د.ع</option></select><ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#8b9395]" /></label>{brands.length > 0 && <label className="relative shrink-0"><span className="sr-only">الماركة</span><select value={brand} onChange={(e) => { setBrand(e.target.value); scrollToResults(); }} className="appearance-none border border-[#d7d2ca] bg-white py-2 pr-3 pl-8 text-xs font-bold text-[#59636a] outline-none focus:border-[#1e4a63]"><option value="">كل الماركات</option>{brands.map((name) => <option key={name} value={name}>{name}</option>)}</select><ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#8b9395]" /></label>}</div><div className="flex items-center justify-between gap-3"><label className="relative shrink-0"><span className="sr-only">ترتيب النتائج</span><select value={sort} onChange={(e) => { setSort(e.target.value as CatalogSort); scrollToResults(); }} className="appearance-none border border-[#d7d2ca] bg-white py-2 pr-3 pl-8 text-xs font-bold text-[#59636a] outline-none focus:border-[#1e4a63]"><option value="RECOMMENDED">الترتيب المقترح</option><option value="BEST_SELLERS">الأكثر مبيعاً</option><option value="PRICE_ASC">السعر: الأقل أولاً</option><option value="PRICE_DESC">السعر: الأعلى أولاً</option></select><ChevronDown aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[#8b9395]" /></label>{(hasRefinements || categoryId != null || search) && <button type="button" onClick={clearCatalogFilters} className="text-xs font-black text-[#a4513f] hover:underline">مسح الفلاتر</button>}</div>
          </div>
          {catalogQ.isLoading ? <div className="flex flex-col items-center justify-center py-24 text-[#7a817f]"><Loader2 aria-hidden className="size-8 animate-spin text-[#1e4a63]" /><p className="mt-3 text-sm font-bold">جارٍ تحميل المنتجات…</p></div> : catalogInitialError ? <div className="flex flex-col items-center justify-center border border-[#ddd8d1] bg-white py-24 text-center" role="alert"><AlertTriangle aria-hidden className="size-10 text-[#b87835]" /><p className="mt-3 text-sm font-black text-[#30383e]">تعذّر تحميل المنتجات</p><p className="mt-1 max-w-sm text-xs font-semibold text-[#7a817f]">تحقق من الاتصال ثم أعد المحاولة. لم نعرض هذه الحالة كمنتجات فارغة.</p><button type="button" onClick={() => void catalogQ.refetch()} className="store-primary-action mt-4 bg-[#e65f4a] px-5 py-2.5 text-xs font-black text-white">إعادة المحاولة</button></div> : filteredItems.length === 0 ? <div className="flex flex-col items-center justify-center border border-[#ddd8d1] bg-white py-24 text-center"><Package aria-hidden className="size-10 text-[#7a817f]" /><p className="mt-3 text-sm font-black text-[#30383e]">{isEmptyCatalog ? "لا توجد منتجات معروضة حالياً" : "لا توجد نتائج مطابقة للبحث أو الفلاتر"}</p><p className="mt-1 max-w-sm text-xs font-semibold text-[#7a817f]">{isEmptyCatalog ? "ستظهر المنتجات هنا عند إضافتها إلى المتجر." : "جرّب مسح البحث والفلاتر لعرض المنتجات المتاحة."}</p>{!isEmptyCatalog && <button type="button" onClick={clearCatalogFilters} className="mt-4 bg-[#1e4a63] px-5 py-2.5 text-xs font-black text-white">مسح البحث والفلاتر</button>}</div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{filteredItems.flatMap((p, idx) => { const onSale = p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price); const pct = onSale ? Math.round((1 - Number(p.salePrice) / Number(p.price)) * 100) : 0; const card = <article key={p.productId} className={`store-product-card group relative flex h-full flex-col overflow-hidden border border-[#ddd8d1] bg-white transition ${p.inStock ? "hover:-translate-y-0.5 hover:border-[#1e4a63] hover:shadow-md" : "opacity-70"}`}><button type="button" onClick={() => openProduct(p.productId)} aria-label={`فتح تفاصيل ${p.productName}`} className="relative block text-right"><BundleMedia urls={p.bundleImageUrls ?? p.imageUrls} fallbackUrl={p.imageUrl} alt={p.productName} showFallbackLabel className="aspect-[4/3] w-full" />{onSale && pct > 0 && <span className="absolute right-3 top-3 bg-[#e65f4a] px-2 py-1 text-[10px] font-black text-white">خصم {pct}٪</span>}{p.isBundle && <span className="absolute left-3 top-3 bg-[#1e4a63] px-2 py-1 text-[10px] font-black text-white">بكج</span>}{!p.inStock && <span className="absolute inset-x-0 bottom-0 bg-[#20252a]/80 py-2 text-center text-[11px] font-black text-white">غير متوفر حالياً</span>}</button><div className="absolute left-3 top-12 z-10 flex gap-1.5"><button type="button" onClick={() => toggleWishlist(p.productId)} aria-label={wishlistIds.has(p.productId) ? `إزالة ${p.productName} من أعجبتني` : `إضافة ${p.productName} إلى أعجبتني`} aria-pressed={wishlistIds.has(p.productId)} className={`store-action-button flex size-9 items-center justify-center rounded-full bg-white/95 shadow-sm ring-1 ring-black/5 transition hover:text-[#e65f4a] ${wishlistIds.has(p.productId) ? "text-[#e65f4a]" : "text-[#5c6870]"} ${heartPulseTarget === `product-${p.productId}` ? "store-action-button--active" : ""}`}><Heart key={`wishlist-${p.productId}-${heartPulseNonce}`} aria-hidden className={`size-4 ${wishlistIds.has(p.productId) ? "fill-current" : ""} ${heartPulseTarget === `product-${p.productId}` ? "animate__animated animate__heartBeat animate__faster" : ""}`} /></button><button type="button" onClick={() => shareProduct(p.productId, p.productName)} aria-label={`مشاركة ${p.productName}`} className={`store-action-button flex size-9 items-center justify-center rounded-full bg-white/95 text-[#1e4a63] shadow-sm ring-1 ring-black/5 transition hover:text-[#e65f4a] ${sharePulseTarget === `product-${p.productId}` ? "store-action-button--active" : ""}`}><Share2 key={`share-${p.productId}-${sharePulseNonce}`} aria-hidden className={`size-4 ${sharePulseTarget === `product-${p.productId}` ? "animate__animated animate__pulse animate__faster" : ""}`} /></button></div><div className="flex flex-1 flex-col p-4"><span className="min-h-4 text-[10px] font-black uppercase tracking-wide text-[#a4513f]">{p.brand ?? "مكتبة العربية"}</span><button onClick={() => openProduct(p.productId)} className="mt-2 text-right"><span className="line-clamp-2 min-h-[2.8em] text-sm font-black leading-6 text-[#30383e]">{p.productName}</span></button><div className="mt-3 flex items-baseline gap-2"><span className="text-lg font-black text-[#1e4a63]">{priceLabel(p.salePrice ?? p.price)}</span>{onSale && <span className="text-xs font-bold text-[#9aa09f] line-through">{money(p.price)}</span>}{onSale && <span className="basis-full text-[10px] font-bold text-[#a4513f]">وفّر {money(Number(p.price) - Number(p.salePrice))} د.ع</span>}</div><div className="mt-2 flex min-h-4 items-center justify-between gap-2 text-[10px] font-bold text-[#8b9395]">{p.stockLeft != null ? <span className="text-[#a4513f]">بقي {p.stockLeft} فقط</span> : <span>{p.unitName}</span>}{p.soldCount >= 3 && <span>الأكثر طلباً</span>}</div><button onClick={(event) => addCatalogProduct(p, event)} disabled={!storefrontProductCanBeOrdered(p)} className="store-primary-action mt-5 flex w-full items-center justify-center gap-2 bg-[#e65f4a] py-3 text-xs font-black text-white transition hover:bg-[#c94736] disabled:cursor-not-allowed disabled:bg-[#e4e2df] disabled:text-[#969c9c]">{p.isCustomizable ? <AlertTriangle aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}{recommendationActionLabel(p)}</button></div></article>; const nodes: ReactNode[] = [card]; if (!search && feedStrips.length > 0 && (idx + 1) % 10 === 0 && idx + 1 < filteredItems.length) { const k = ((idx + 1) / 10 - 1) % feedStrips.length; nodes.push(<InlineStrip key={`strip-${idx}`} banner={feedStrips[k]} tone={inlineBanners.length ? "emerald" : "amber"} />); } return nodes; })}</div>}
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
          <nav className="flex flex-wrap items-center gap-2" aria-label="خدمات المتجر والدعم">
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
              className="flex w-full items-center justify-between rounded-xl bg-emerald-700 px-4 py-3.5 text-white shadow-sm shadow-emerald-700/25 transition motion-safe:active:scale-[0.98] hover:bg-emerald-800"
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

      {/* شارة «الخصوصية» ثابتة أسفل اليسار؛ نرفع واتساب 4rem حتى لا يتراكبا على الهاتف. */}
      {panel == null && cartCount === 0 && settingsQ.data?.whatsappNumber && (
        <a
          href={`https://wa.me/${settingsQ.data.whatsappNumber.replace(/[^\d]/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed left-4 z-20 flex min-h-11 items-center gap-2 rounded-full bg-[#168457] px-4 py-3 text-xs font-black text-white shadow-lg shadow-emerald-900/20 transition hover:-translate-y-0.5 hover:bg-[#116c49]"
          style={{ bottom: "calc(4rem + env(safe-area-inset-bottom))" }}
          aria-label="تواصل مع فريق المتجر عبر واتساب"
        >
          <MessageCircle aria-hidden className="size-4" /> اسألنا عبر واتساب
        </a>
      )}

      {/* تفاصيل المنتج (ورقة سفلية) */}
      <DialogPrimitive.Root open={selectedId != null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        {selectedId != null && (
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => { event.preventDefault(); productDialogCloseRef.current?.focus(); }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const trigger = productDialogTriggerRef.current;
                productDialogTriggerRef.current = null;
                window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
              }}
              className="storefront animate__animated animate__fadeInUp animate__faster fixed bottom-0 left-1/2 z-50 flex max-h-[min(780px,calc(100dvh-1rem-env(safe-area-inset-top)))] w-[calc(100%-1rem)] max-w-4xl -translate-x-1/2 flex-col overflow-hidden overscroll-contain rounded-t-2xl bg-white p-3 shadow-2xl outline-none dark:bg-slate-900 sm:bottom-auto sm:top-1/2 sm:w-[calc(100%-2rem)] sm:-translate-y-1/2 sm:rounded-2xl"
              style={{ paddingBottom: "calc(.75rem + env(safe-area-inset-bottom))" }}
            >
            <div className="mb-3 flex items-center justify-between">
              <DialogPrimitive.Title className="text-sm font-extrabold text-slate-500 dark:text-slate-400">تفاصيل المنتج</DialogPrimitive.Title>
              <div className="flex items-center gap-1.5">
                {detailQ.data && <button type="button" onClick={() => toggleWishlist(detailQ.data!.productId)} aria-label={wishlistIds.has(detailQ.data.productId) ? "إزالة المنتج من أعجبتني" : "إضافة المنتج إلى أعجبتني"} aria-pressed={wishlistIds.has(detailQ.data.productId)} className={`store-action-button flex size-8 items-center justify-center rounded-full transition hover:bg-rose-50 ${wishlistIds.has(detailQ.data.productId) ? "text-[#e65f4a]" : "text-slate-500"} ${heartPulseTarget === `product-${detailQ.data.productId}` ? "store-action-button--active" : ""}`}><Heart key={`wishlist-detail-${detailQ.data.productId}-${heartPulseNonce}`} aria-hidden className={`size-4 ${wishlistIds.has(detailQ.data.productId) ? "fill-current" : ""} ${heartPulseTarget === `product-${detailQ.data.productId}` ? "animate__animated animate__heartBeat animate__faster" : ""}`} /></button>}
                {detailQ.data && <button type="button" onClick={() => shareProduct(detailQ.data!.productId, detailQ.data!.productName)} aria-label="مشاركة المنتج" className={`store-action-button flex size-8 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-[#1e4a63] ${sharePulseTarget === `product-${detailQ.data.productId}` ? "store-action-button--active" : ""}`}><Share2 key={`share-detail-${detailQ.data.productId}-${sharePulseNonce}`} aria-hidden className={`size-4 ${sharePulseTarget === `product-${detailQ.data.productId}` ? "animate__animated animate__pulse animate__faster" : ""}`} /></button>}
                <DialogPrimitive.Close asChild>
                  <button ref={productDialogCloseRef} type="button" aria-label="إغلاق تفاصيل المنتج" className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400">
                    <X aria-hidden className="size-4" />
                  </button>
                </DialogPrimitive.Close>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-0.5 pb-1">
            {detailQ.isLoading ? (
              <div className="flex justify-center py-12 text-emerald-500">
                <Loader2 aria-hidden className="size-6 animate-spin" />
              </div>
            ) : detailQ.data ? (
              <div>
                <div className="space-y-4 sm:grid sm:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] sm:items-start sm:gap-5 sm:space-y-0">
                  <ProductGallery urls={detailMedia.urls} fallbackUrl={detailMedia.fallbackUrl} alt={detailQ.data.productName} />
                  <div className="min-w-0">
                    {detailQ.data.brand && <p className="text-xs font-medium text-slate-400">{detailQ.data.brand}</p>}
                    <h3 className="text-base font-extrabold leading-snug text-slate-900 dark:text-white">{detailQ.data.productName}</h3>
                    {detailQ.data.description && <p className="mt-2 whitespace-pre-line text-xs leading-6 text-slate-600 dark:text-slate-300">{detailQ.data.description}</p>}
                    {detailQ.data.category && <p className="mt-1 text-xs text-slate-500">الفئة: {detailQ.data.category}</p>}
                    {detailQ.data.categoryId != null && detailQ.data.category && <button type="button" onClick={() => { setSelectedId(null); selectCategory(detailQ.data!.categoryId!); }} className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#c5e8dc] bg-[#e9f7f2] px-3 py-1.5 text-[11px] font-black text-[#276c5d] transition hover:border-[#1e4a63] hover:bg-[#d9f1e8]" aria-label={`تصفح منتجات فئة ${detailQ.data.category}`}><Store aria-hidden className="size-3.5" /> تصفح منتجات «{detailQ.data.category}» <ArrowRight aria-hidden className="size-3.5 rotate-180" /></button>}
                    <p className="mt-0.5 text-xs text-slate-500">الوحدة: {detailUnit?.unitName ?? detailQ.data.unitName}</p>
                    {!detailQ.data.isCustomizable && (detailQ.data.variants?.length ?? 0) > 1 && (
                      <div className="mt-3" role="group" aria-labelledby="storefront-variant-options-title">
                        <p id="storefront-variant-options-title" className="mb-1 text-xs font-extrabold text-slate-700 dark:text-slate-200">{detailQ.data.hasAlternatives ? "اختر الماركة أو النوع والكمية" : "اختر اللون أو القياس والكمية"}</p>
                        <p className="mb-2 text-[11px] text-slate-500">{detailQ.data.hasAlternatives ? "تُباع تحت اسمٍ واحد ماركاتٌ/أنواعٌ مختلفة، لكلٍّ مخزونه وسعره — اختر ما يناسبك." : "يمكنك اختيار أكثر من لون أو قياس، ولكل اختيار كمية مستقلة."}</p>
                        <div className="space-y-2">
                          <div className="grid gap-1.5 sm:grid-cols-2">
                          {detailQ.data.variants!.map((variant) => (
                            <div key={variant.variantId} className={`rounded-lg border p-1.5 ${variant.inStock ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800" : "border-slate-100 bg-slate-50 opacity-60 dark:border-slate-800 dark:bg-slate-900"}`}>
                              <div className="flex items-center justify-between gap-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  {variant.colorHex && <span className="size-4 shrink-0 rounded-full ring-1 ring-black/20" style={{ backgroundColor: variant.colorHex }} aria-hidden />}
                                  <span className="truncate">{variant.color || variant.label}</span>
                                  {variant.variantKind === "ALTERNATIVE" && <span className="shrink-0 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-600 dark:text-slate-100">ماركة مختلفة</span>}
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
                                        <span className="mt-0.5 block text-xs font-extrabold text-[var(--sem-pos)]">{priceLabel(unit.salePrice ?? unit.price)}{!unit.inStock ? " · نفد" : unit.stockLeft != null ? ` · المتوفر ${unit.stockLeft}` : " · متوفر"}</span>
                                      </button>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <button type="button" aria-label={`إنقاص ${variant.label} ${unit.unitName}`} disabled={!unit.inStock || quantity === 0} onClick={() => { setSelectedVariantId(variant.variantId); setSelectedStoreUnitId(unit.productUnitId); setVariantQuantity(unit.productUnitId, quantity - 1); }} className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200"><Minus aria-hidden className="size-3" /></button>
                                        <span className="w-5 text-center text-sm font-extrabold tabular-nums">{quantity}</span>
                                        <button type="button" aria-label={`زيادة ${variant.label} ${unit.unitName}`} disabled={!unit.inStock || quantity >= stockLimit} onClick={() => { setSelectedVariantId(variant.variantId); setSelectedStoreUnitId(unit.productUnitId); setVariantQuantity(unit.productUnitId, quantity + 1); }} className="flex size-6 items-center justify-center rounded-full bg-[var(--sem-pos)] text-background disabled:cursor-not-allowed disabled:opacity-40"><Plus aria-hidden className="size-3" /></button>
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
                    {!detailQ.data.isCustomizable && (detailQ.data.variants?.length ?? 0) <= 1 && (detailVariant?.units.length ?? detailQ.data.storeUnits?.length ?? 0) > 0 && (
                      <div className="mt-3" role="group" aria-label="اختر القياس أو وحدة البيع والكمية">
                        {(detailVariant?.variantName || detailVariant?.color || detailVariant?.size) && (
                          <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs font-extrabold text-slate-700 dark:text-slate-200">
                            <span>الاختيار: {[detailVariant.variantName, detailVariant.color, detailVariant.size].filter(Boolean).join(" · ")}</span>
                            {detailVariant.variantKind === "ALTERNATIVE" && <span className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-600 dark:text-slate-100">ماركة مختلفة</span>}
                          </p>
                        )}
                        <div className="space-y-1.5">
                          {(detailVariant?.units ?? detailQ.data.storeUnits ?? []).map((unit) => {
                            const selected = (detailUnit?.productUnitId ?? detailQ.data!.productUnitId) === unit.productUnitId;
                            const quantity = variantQuantities.get(unit.productUnitId) ?? (selected ? 1 : 0);
                            const stockLimit = unit.stockLeft == null ? 999 : Math.min(Math.floor(unit.stockLeft), 999);
                            return (
                              <div key={unit.productUnitId} className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 ${selected ? "border-[var(--sem-pos)] bg-emerald-50/60 dark:bg-emerald-500/10" : "border-slate-200 dark:border-slate-700"}`}>
                                <button type="button" disabled={!unit.inStock} onClick={() => { setSelectedStoreUnitId(unit.productUnitId); if (!variantQuantities.has(unit.productUnitId)) setVariantQuantity(unit.productUnitId, 1); }} className="min-w-0 flex-1 text-right text-xs font-bold text-slate-700 disabled:opacity-50 dark:text-slate-200">
                                  <span className="block truncate">{unit.unitName}</span>
                                  <span className="mt-0.5 block text-xs font-extrabold text-[var(--sem-pos)]">{priceLabel(unit.salePrice ?? unit.price)}{!unit.inStock ? " · نفد" : unit.stockLeft != null ? ` · المتوفر ${unit.stockLeft}` : " · متوفر"}</span>
                                </button>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button type="button" aria-label={`إنقاص ${unit.unitName}`} disabled={!unit.inStock || quantity === 0} onClick={() => setVariantQuantity(unit.productUnitId, quantity - 1)} className="flex size-7 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200"><Minus aria-hidden className="size-3.5" /></button>
                                  <span className="w-5 text-center text-sm font-extrabold tabular-nums">{quantity}</span>
                                  <button type="button" aria-label={`زيادة ${unit.unitName}`} disabled={!unit.inStock || quantity >= stockLimit} onClick={() => { setSelectedStoreUnitId(unit.productUnitId); setVariantQuantity(unit.productUnitId, quantity + 1); }} className="flex size-7 items-center justify-center rounded-full bg-[var(--sem-pos)] text-background disabled:opacity-40"><Plus aria-hidden className="size-3.5" /></button>
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
                    {detailQ.data.isCustomizable ? (
                      <div role="status" className="mt-3 rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm font-bold text-[var(--sem-warn)]">
                        {STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE}
                      </div>
                    ) : customizationConfig ? (
                      <section className="mt-3 rounded-2xl border border-[#f0d991] bg-[#fff8df] p-3" aria-label="خيارات تخصيص المنتج">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-black text-[#25406f]">{customizationConfig.title}</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-[#806b3a]">{customizationConfig.description ?? "أكمل الحقول المطلوبة قبل إضافة المنتج للسلة."}</p>
                          </div>
                          <Tag aria-hidden className="size-4 shrink-0 text-[#d39c27]" />
                        </div>
                        <div className="mt-3 space-y-2.5">
                          {visibleCustomizationFields.map((field) => {
                            const controlId = `storefront-customization-${field.id}`;
                            const labelId = `${controlId}-label`;
                            const hintId = field.fieldType === "FILE" ? `${controlId}-hint` : undefined;
                            const invalid = field.isRequired && !(customizationValues[field.fieldKey] ?? "").trim() && Boolean(customizationValidation);
                            const describedBy = [hintId, invalid ? "storefront-customization-error" : undefined].filter(Boolean).join(" ") || undefined;
                            return (
                              <div key={field.id} className="block text-xs font-black text-[#25406f]">
                                <label id={labelId} htmlFor={field.fieldType === "SWATCH" ? undefined : controlId}>
                                  {field.label}{field.isRequired && <span aria-hidden="true" className="text-[var(--store-accent)]"> *</span>}
                                  {field.isRequired && <span className="sr-only"> — مطلوب</span>}
                                </label>
                                <CustomizationFieldControl field={field} value={customizationValues[field.fieldKey] ?? ""} onChange={(value) => updateCustomizationField(field, value)} controlId={controlId} labelId={labelId} describedBy={describedBy} invalid={invalid} />
                                {field.fieldType === "FILE" && <span id={hintId} className="mt-1 block text-xs font-medium text-[#6c5a3f]">أدخل اسم الملف أو مرجع التصميم؛ يرفق الملف عبر الفريق أو واتساب.</span>}
                              </div>
                            );
                          })}
                        </div>
                        {customizationValidation && <p id="storefront-customization-error" role="alert" className="mt-2 rounded-xl bg-[var(--store-accent)]/10 px-2.5 py-2 text-xs font-bold text-[var(--store-accent-strong)]">{customizationValidation}</p>}
                      </section>
                    ) : null}
                    <div className="mt-3 flex items-baseline gap-2">
                      <p className="text-xl font-extrabold text-money-positive">{priceLabel(detailUnit?.salePrice ?? detailUnit?.price ?? null)}</p>
                      {detailUnit?.salePrice != null && detailUnit.price != null && Number(detailUnit.salePrice) < Number(detailUnit.price) && (
                        <span className="text-sm text-slate-400 line-through">{money(detailUnit.price)}</span>
                      )}
                    </div>
                    {!detailQ.data.isCustomizable && detailUnit?.promotionName && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                        <Tag aria-hidden className="size-3" /> {detailUnit.promotionName}
                      </span>
                    )}
                    {!detailQ.data.isCustomizable && (
                      <p className={`mt-2 text-xs font-bold ${detailUnit?.inStock ? "text-[var(--stock-ok)]" : "text-stock-out"}`}>
                        {detailUnit?.inStock
                          ? detailUnit.stockLeft != null
                            ? `متوفّر — بقي ${detailUnit.stockLeft} فقط، سارع بالطلب`
                            : "متوفّر"
                          : "غير متوفّر حالياً"}
                      </p>
                    )}
                    {!detailQ.data.isCustomizable && detailQ.data.soldCount >= 3 && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-bold text-orange-500">
                        <Flame aria-hidden className="size-3.5" /> {detailQ.data.soldCount >= 10 ? "من الأكثر مبيعاً" : `بيع ${detailQ.data.soldCount} مرة`}
                      </p>
                    )}
                  </div>
                </div>
                <div className="sticky bottom-0 mt-2 border-t border-slate-100 bg-white/95 pt-2 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/95">
                <button
                  onClick={(event) => {
                    if ((detailQ.data?.variants?.length ?? 0) > 1) addSelectedVariants(event.currentTarget);
                    else {
                      addSelectedUnit(event.currentTarget);
                    }
                  }}
                  disabled={detailQ.data.isCustomizable || !!customizationValidation || ((detailQ.data?.variants?.length ?? 0) > 1
                    ? !Array.from(variantQuantities.values()).some((quantity) => quantity > 0)
                    : !detailUnit?.inStock || detailUnit.price == null)}
                  className="store-primary-action store-mobile-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-3.5 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-800"
                >
                  {detailQ.data.isCustomizable ? <AlertTriangle aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
                  {detailQ.data.isCustomizable
                    ? STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE
                    : (detailQ.data?.variants?.length ?? 0) > 1
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
                  <RelatedProductStrip
                    products={relatedQ.data!}
                    onSelect={setSelectedId}
                    onAdd={(product, event) => addCatalogProduct(product, event)}
                    onRecommendationClick={trackRecommendationClick}
                  />
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-slate-400">تعذّر تحميل تفاصيل المنتج</p>
            )}
            </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </DialogPrimitive.Root>

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
              {cartHasUnsupportedCustomization && (
                <div role="alert" className="mb-3 rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm font-bold text-[var(--sem-warn)]">
                  {STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE}؛ احذف المنتج المخصص من السلة للمتابعة إلى الدفع.
                </div>
              )}
              <div className="flex flex-col gap-3">
                {cartLines.map((l) => (
                  <div key={l.cartKey} className="flex items-center gap-3 rounded-xl bg-white p-2.5 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                    <ProductImage url={l.imageUrl} alt={l.name} className="size-16 shrink-0 rounded-xl" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-xs font-bold leading-tight text-slate-800 dark:text-slate-100">{l.name}</p>
                      {summarizeStorefrontCustomization(l.customization) && <p className="mt-1 line-clamp-2 text-[10px] font-bold leading-relaxed text-[#a16b2a]">تخصيص: {summarizeStorefrontCustomization(l.customization)}</p>}
                      <p className="mt-1 text-sm font-extrabold text-emerald-600 dark:text-emerald-400">{money(l.price)} د.ع</p>
                      <p className="mt-1 text-xs font-bold text-[#59636a]">{l.stockLimit != null ? `المتوفر: ${l.stockLimit}` : "متوفر للطلب"}</p>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setQty(l.cartKey, l.qty - 1)} aria-label={`إنقاص كمية ${l.name}`} className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300">
                          <Minus aria-hidden className="size-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-extrabold tabular-nums">{l.qty}</span>
                        <button type="button" onClick={() => setQty(l.cartKey, l.qty + 1)} disabled={l.stockLimit != null && l.qty >= l.stockLimit} aria-label={`زيادة كمية ${l.name}`} className="flex size-11 items-center justify-center rounded-full bg-emerald-700 text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">
                          <Plus aria-hidden className="size-3.5" />
                        </button>
                      </div>
                      <button type="button" onClick={() => setQty(l.cartKey, 0)} aria-label={`حذف ${l.name} من السلة`} className="flex min-h-11 items-center gap-1 text-xs font-medium text-rose-700 hover:underline">
                        <Trash2 aria-hidden className="size-3" />
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {cartRecommendationsQ.data && cartRecommendationsQ.data.length > 0 && (
                <div className="mt-5 rounded-2xl bg-[#fff8df] px-3 py-3 ring-1 ring-[#f0d991]">
                  <ProductRow
                    title="أكمل تجهيزك"
                    icon={<Tag aria-hidden className="size-4 text-[#c58d22]" />}
                    products={cartRecommendationsQ.data}
                    onSelect={setSelectedId}
                    onAdd={addFeaturedToCart}
                    recentlyAddedId={recentlyAddedProductId}
                  />
                </div>
              )}
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
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setPanel(null); setShowWishlist(false); scrollToResults(); }} className="flex items-center justify-center gap-1.5 rounded-xl border border-[#1e4a63]/30 bg-[#f5f8fa] py-3 text-xs font-black text-[#1e4a63] transition hover:bg-[#eaf1f4]"><Plus aria-hidden className="size-4" /> أضف المزيد</button>
                <button type="button" onClick={shareCart} disabled={cartHasUnsupportedCustomization} className={`store-action-button flex items-center justify-center gap-1.5 rounded-xl border border-[#e65f4a]/30 bg-[#fff6f2] py-3 text-xs font-black text-[#a4513f] transition hover:bg-[#ffede7] disabled:cursor-not-allowed disabled:opacity-50 ${sharePulseTarget === "cart" ? "store-action-button--active" : ""}`}><Share2 key={`share-cart-${sharePulseNonce}`} aria-hidden className={`size-4 ${sharePulseTarget === "cart" ? "animate__animated animate__pulse animate__faster" : ""}`} /> مشاركة السلة</button>
              </div>
              <button
                onClick={openCheckout}
                disabled={!storeOpen || !orderingEnabled || cartHasUnsupportedCustomization}
                className="store-primary-action store-mobile-action mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-sm shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
              >
                {cartHasUnsupportedCustomization ? (
                  STOREFRONT_CUSTOMIZABLE_UNAVAILABLE_MESSAGE
                ) : storeOpen && orderingEnabled ? (
                  <>
                    متابعة إلى الدفع عند الاستلام
                    <ArrowRight aria-hidden className="size-4 rotate-180" />
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
              {settingsQ.data?.whatsappNumber && !cartHasUnsupportedCustomization && (
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
          setCheckoutErrors({});
          setPanel("cart");
        }}>
          <form noValidate onSubmit={(event) => { event.preventDefault(); submitOrder(); }} className="flex flex-col gap-3">
            <div className="rounded-2xl border border-[#f0d991] bg-[#fff8df] p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#9a7427]">الخطوة الأخيرة</p><p className="mt-1 text-sm font-black text-[#25406f]">أكمل بياناتك وسنؤكد الطلب قبل التوصيل</p></div>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f4c84d] text-sm font-black text-[#25406f]">{cartCount}</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[10px] font-black"><span className="rounded-lg bg-[#25406f] px-2 py-1.5 text-white">بياناتك</span><span className="rounded-lg bg-white/80 px-2 py-1.5 text-[#6d5524]">التوصيل</span><span className="rounded-lg bg-white/80 px-2 py-1.5 text-[#6d5524]">التأكيد</span></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
            <Field icon={<User aria-hidden className="size-4" />} label="الاسم الكامل" htmlFor="storefront-checkout-name" required error={checkoutErrors.name}>
              <input id="storefront-checkout-name" value={form.name} onChange={(e) => updateCheckoutField("name", e.target.value)} required aria-invalid={Boolean(checkoutErrors.name)} aria-describedby={checkoutErrors.name ? "storefront-checkout-name-error" : undefined} placeholder="اسمك" autoComplete="name" className="w-full bg-transparent text-sm outline-none placeholder:text-[#6c747b]" />
            </Field>
            <Field icon={<Phone aria-hidden className="size-4" />} label="رقم الهاتف" htmlFor="storefront-checkout-phone" required error={checkoutErrors.phone}>
              <IntlPhoneInput
                id="storefront-checkout-phone"
                value={form.phone}
                onChange={(phone) => updateCheckoutField("phone", phone)}
                ariaLabel="رقم الهاتف"
                placeholder="770 123 4567"
                className="border-0 shadow-none"
              />
            </Field>
            </div>
            <Field icon={<Store aria-hidden className="size-4" />} label="المحافظة" htmlFor="storefront-checkout-governorate" required error={checkoutErrors.governorate}>
              <select id="storefront-checkout-governorate" value={form.governorate} onChange={(e) => updateCheckoutField("governorate", e.target.value)} required aria-invalid={Boolean(checkoutErrors.governorate)} aria-describedby={checkoutErrors.governorate ? "storefront-checkout-governorate-error" : undefined} className="w-full bg-transparent text-sm outline-none">
                <option value="">اختر المحافظة</option>
                {GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field icon={<Package aria-hidden className="size-4" />} label="العنوان بالتفصيل" htmlFor="storefront-checkout-address" required error={checkoutErrors.address} tone="mint">
              <textarea id="storefront-checkout-address" value={form.address} onChange={(e) => updateCheckoutField("address", e.target.value)} required aria-invalid={Boolean(checkoutErrors.address)} aria-describedby={checkoutErrors.address ? "storefront-checkout-address-error" : undefined} rows={2} placeholder="المنطقة، الشارع، أقرب نقطة دالة…" className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-[#6c747b]" />
            </Field>
            <Field icon={<MessageCircle aria-hidden className="size-4" />} label="ملاحظة (اختياري)" htmlFor="storefront-checkout-notes" tone="lilac">
              <input id="storefront-checkout-notes" value={form.notes} onChange={(e) => updateCheckoutField("notes", e.target.value)} placeholder="مثال: الاتصال قبل التوصيل" className="w-full bg-transparent text-sm outline-none placeholder:text-[#6c747b]" />
            </Field>

            <div className="rounded-2xl border border-[#c9dced] bg-[#f7fbff] p-3 ring-1 ring-[#e7f0f7] dark:bg-slate-900 dark:ring-slate-700">
              <label htmlFor="storefront-checkout-coupon" className="mb-1 block text-xs font-bold text-slate-600">لديك كوبون؟</label>
              <div className="flex gap-2" dir="ltr">
                <input id="storefront-checkout-coupon" value={couponDraft} onChange={(e) => setCouponDraft(e.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyCoupon(); } }} placeholder="مثال: WELCOME10" className="min-w-0 flex-1 rounded-lg border-0 bg-white px-3 py-2 text-sm font-bold tracking-wide outline-none placeholder:font-normal placeholder:tracking-normal dark:bg-slate-800" aria-describedby="storefront-coupon-feedback" />
                <button type="button" onClick={appliedCouponCode ? removeCoupon : applyCoupon} disabled={!appliedCouponCode && !couponDraft.trim()} className="shrink-0 rounded-lg bg-[#1e4a63] px-3 py-2 text-xs font-black text-white transition hover:bg-[#17394c] disabled:cursor-not-allowed disabled:opacity-50">
                  {appliedCouponCode ? "إزالة" : "تطبيق"}
                </button>
              </div>
              <p id="storefront-coupon-feedback" className="mt-2 text-xs font-bold text-slate-600" role="status" aria-live="polite">
                {quoteQ.isFetching && appliedCouponCode ? "جارٍ التحقق من الكوبون…" : quoteQ.isError && appliedCouponCode ? (quoteQ.error?.message ?? "تعذّر التحقق من الكوبون") : appliedCouponCode && quoteQ.data ? `تم تطبيق ${quoteQ.data.couponProgramName ?? "الكوبون"} — التوفير ${money(quotedCouponDiscount)} د.ع` : couponFeedback ?? "يمكنك إدخال رمز العرض قبل تأكيد الطلب"}
              </p>
            </div>

            <div className="rounded-2xl border border-[#ead8c8] bg-[#fffdf9] p-3.5 text-sm ring-1 ring-[#f3e5da] dark:bg-slate-900 dark:ring-slate-800">
              <div className="flex justify-between text-slate-500">
                <span>المجموع الفرعي</span>
                <span className="tabular-nums text-slate-800 dark:text-slate-100">{money(quotedSubtotal)} د.ع</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-slate-500">
                <span className="flex items-center gap-1"><Truck aria-hidden className="size-3.5" /> أجرة التوصيل (تقديري)</span>
                {qualifiesFree ? (
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">مجاني</span>
                ) : (
                  <span className="tabular-nums text-slate-800 dark:text-slate-100">{money(quotedDeliveryFee)} د.ع</span>
                )}
              </div>
              {Number(quotedCouponDiscount) > 0 && (
                <div className="mt-1.5 flex justify-between text-emerald-700 dark:text-emerald-400">
                  <span>خصم الكوبون</span>
                  <span className="tabular-nums">− {money(quotedCouponDiscount)} د.ع</span>
                </div>
              )}
              <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-base font-extrabold dark:border-slate-800">
                <span>الإجمالي</span>
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">{money(quotedTotal)} د.ع</span>
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
              type="submit"
              disabled={createOrder.isPending}
              className="store-primary-action store-mobile-action flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-4 text-sm font-extrabold text-white shadow-sm shadow-amber-500/25 transition motion-safe:active:scale-[0.98] hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-800"
            >
              {createOrder.isPending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />}
              تأكيد الطلب — الدفع عند الاستلام
            </button>
            <p className="flex items-center justify-center gap-1 text-center text-xs text-slate-600">
              <Banknote aria-hidden className="size-3.5" /> تدفع نقداً عند استلام الطلب من المندوب.
            </p>
          </form>
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
            <p className="mt-3 rounded-xl bg-[var(--sem-warn)]/5 px-3 py-2 text-xs font-bold text-[var(--sem-warn)] ring-1 ring-[var(--sem-warn)]/40">
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
              className="mt-6 w-full rounded-xl bg-emerald-700 py-4 text-sm font-extrabold text-white transition motion-safe:active:scale-[0.98] hover:bg-emerald-800"
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
                <div className="flex items-center justify-between"><span className="font-extrabold" dir="ltr">{labelQ.data.orderNumber}</span><span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${orderStatusChipClass(labelQ.data.status)}`}>{orderStatusLabelForCustomer(labelQ.data.status)}</span></div>
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
            <p className="text-sm text-slate-600 dark:text-slate-300">استخدم طلباً محفوظاً بأمان على هذا الجهاز، أو ألصق رمز التتبّع من تأكيد الطلب.</p>
            {trustedTrackingOrders.length > 0 && (
              <section aria-labelledby="storefront-trusted-orders-title" className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                <h3 id="storefront-trusted-orders-title" className="text-sm font-extrabold text-slate-900 dark:text-white">طلبات موثوقة على هذا الجهاز</h3>
                <div className="space-y-2">
                  {trustedTrackingOrders.map((order) => (
                    <button
                      key={order.trackingToken}
                      type="button"
                      onClick={() => { void doTrack(order.trackingToken); }}
                      disabled={trackState === "loading"}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-start transition hover:border-emerald-500 hover:bg-emerald-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-emerald-950/20"
                    >
                      <span dir="ltr" className="font-extrabold text-slate-900 dark:text-white">{order.orderNumber}</span>
                      <span className="text-xs text-slate-600 dark:text-slate-300">صالح حتى {formatStorefrontReservationDeadline(order.expiresAt)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <form noValidate onSubmit={(event) => { event.preventDefault(); void doTrack(); }} className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
              <div className="space-y-1">
                <label htmlFor="storefront-track-token" className="text-xs font-bold text-slate-600 dark:text-slate-300">رمز التتبّع <span aria-hidden="true" className="text-rose-700">*</span><span className="sr-only"> — مطلوب</span></label>
                <input
                  id="storefront-track-token"
                  dir="ltr"
                  value={trackToken}
                  onChange={(event) => { setTrackToken(event.target.value); setTrackError(null); setTrackState("idle"); }}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(trackError)}
                  aria-describedby={trackError ? "storefront-track-token-error" : "storefront-track-token-help"}
                  placeholder="ألصق الرمز الكامل هنا"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
                {trackError
                  ? <p id="storefront-track-token-error" role="alert" className="text-xs font-bold text-rose-700">{trackError}</p>
                  : <p id="storefront-track-token-help" className="text-xs text-slate-600 dark:text-slate-300">لا نطلب رقم الهاتف ولا نخزّن بياناتك الشخصية للتتبّع.</p>}
              </div>
              <button
                type="submit"
                disabled={trackState === "loading"}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 py-3 text-sm font-extrabold text-white transition hover:bg-emerald-800 disabled:opacity-50"
              >
                {trackState === "loading" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Search aria-hidden className="size-4" />}
                تتبّع الطلب
              </button>
              {settingsQ.data?.whatsappNumber && (
                <a
                  href={`https://wa.me/${settingsQ.data.whatsappNumber.replace(/[^\d]/g, "")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 hover:border-emerald-500 hover:text-emerald-800 dark:border-slate-700 dark:text-slate-200"
                >
                  <MessageCircle aria-hidden className="size-4" /> تواصل مع الدعم إذا فقدت الرمز
                </a>
              )}
            </form>

            {trackState === "notfound" && (
              <div role="alert" className="rounded-xl bg-amber-50 p-4 text-center text-sm font-bold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
                رمز التتبّع غير صالح أو انتهت صلاحيته. استخدم الرمز من تأكيد الطلب أو تواصل مع الدعم.
              </div>
            )}
            {trackState === "error" && (
              <div role="alert" className="rounded-xl bg-rose-50 p-4 text-center text-sm font-bold text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20">
                تعذّر جلب الحالة الآن — حاول مرّةً أخرى.
              </div>
            )}

            {trackResult && (
              <div role="status" aria-live="polite" aria-atomic="true" className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-100 dark:bg-slate-900 dark:ring-slate-800">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold tracking-wider text-slate-900 dark:text-white" dir="ltr">{trackResult.orderNumber}</span>
                  <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${orderStatusChipClass(trackResult.status)}`}>
                    {orderStatusLabelForCustomer(trackResult.status)}
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
export default function Storefront() {
  return (
    <ConsentProvider>
      <StorefrontContent />
      <ConsentChoice />
    </ConsentProvider>
  );
}

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
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-extrabold text-white transition hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
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
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[55] bg-slate-950/45" />
        <DialogPrimitive.Content dir="rtl" aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); closeRef.current?.focus(); }} onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = restoreFocusRef.current;
          restoreFocusRef.current = null;
          window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
        }} className="storefront fixed inset-0 z-[56] flex flex-col overflow-hidden bg-[#fff8ef] outline-none dark:bg-slate-950">
          <header className="flex shrink-0 items-center gap-3 border-b border-[#f0e2d5] bg-white/95 px-4 py-3 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900" style={{ paddingTop: "calc(.75rem + env(safe-area-inset-top))" }}>
            <DialogPrimitive.Close asChild>
              <button ref={closeRef} type="button" aria-label="رجوع" className="flex size-11 items-center justify-center rounded-full transition hover:bg-slate-100 dark:hover:bg-slate-800">
                <ArrowRight aria-hidden className="size-5 text-slate-600 dark:text-slate-300" />
              </button>
            </DialogPrimitive.Close>
            <DialogPrimitive.Title className="text-base font-extrabold text-slate-900 dark:text-white">{title}</DialogPrimitive.Title>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-2xl px-4 py-4 sm:px-6" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>{children}</div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Field({ icon, label, htmlFor, required = false, error, tone = "plain", children }: { icon: React.ReactNode; label: string; htmlFor: string; required?: boolean; error?: string; tone?: "plain" | "mint" | "lilac"; children: React.ReactNode }) {
  const errorId = `${htmlFor}-error`;
  const toneClass = tone === "mint"
    ? "border-[#c5e8dc] bg-[#f7fffc] ring-[#e9f7f2]"
    : tone === "lilac"
      ? "border-[#dfcdea] bg-[#fcf8ff] ring-[#f3ebf8]"
      : "border-[#ead8c8] bg-white ring-[#f3e5da]";
  return (
    <div role="group" aria-labelledby={`${htmlFor}-label`} aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)} className={`rounded-2xl border p-3 ring-1 dark:bg-slate-900 dark:ring-slate-700 ${toneClass}`}>
      <label id={`${htmlFor}-label`} htmlFor={htmlFor} className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-600">
        <span className="text-emerald-500">{icon}</span>
        {label}
        {required && <><span aria-hidden="true" className="text-[var(--store-accent)]">*</span><span className="sr-only"> — مطلوب</span></>}
      </label>
      {children}
      {error && <p id={errorId} role="alert" className="mt-1.5 text-xs font-bold text-rose-700">{error}</p>}
    </div>
  );
}
