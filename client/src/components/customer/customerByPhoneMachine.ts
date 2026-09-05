/**
 * آلة حالات «العميل بالهاتف» — نقيّة بلا React ولا شبكة (برنامج v2 م١ PR-B، ٥/٩/٢٦).
 *
 * الأصل: كانت هذه الآلة مضمَّنةً داخل `Reception.tsx` (٤٢٨-٥٠١) ومستهلكُها الوحيد شاشة الاستقبال.
 * كاشير التجزئة يحتاجها الآن في وضع «توصيل» (بيعٌ لعميلٍ جديد عبر واتساب في شاشةٍ واحدة) ⇒
 * نُخرجها مصدراً واحداً: الهاتف العراقيّ (١١ خانة) هو مفتاح الهوية؛ رقمٌ موجود يُربط فوراً،
 * ورقمٌ جديد يفتح حقل الاسم وحده، **والإنشاء تلقائيّ** بلا خطوةٍ منفصلة (الخطّة ⑤).
 *
 * الانتقالات:
 *   EMPTY ──(أرقام)──▶ INCOMPLETE ──(١١ خانة صحيحة)──▶ CHECKING ──▶ RESOLVED | NEEDS_NAME | ERROR
 *   NEEDS_NAME ──(اسم ≥ حرفين + حفظ)──▶ CHECKING ──▶ RESOLVED (created=true)
 *
 * كلّ دالّةٍ هنا تأخذ الحالة السابقة وتُعيد الجديدة — لا أثر جانبيّ — فتُختبَر بلا DOM.
 * الجزء الذي يلمس الشبكة (`receptionResolveByPhone`) في الخطّاف `useCustomerByPhone`.
 */
import { isValidIqMobile } from "@/components/form/PhoneDigitsInput";

export type PhoneResolution = "EMPTY" | "INCOMPLETE" | "CHECKING" | "NEEDS_NAME" | "RESOLVED" | "ERROR";
export type PhoneCustomerTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";

/** نفس شكل `SmartCustomerValue` (الاستقبال) كي يبقى مستهلكوه بلا تغيير. */
export interface PhoneCustomer {
  customerId: number | null;
  name: string;
  phone: string | null;
  isNew: boolean;
}

export interface CustomerByPhoneState {
  /** أرقامٌ محلّية فقط (07xxxxxxxxx). */
  phone: string;
  resolution: PhoneResolution;
  error: string | null;
  customer: PhoneCustomer;
  /** فئة سعر العميل المربوط من الخادم — تُسقَط عند تغيّر الهاتف. */
  tier: PhoneCustomerTier | null;
  /** أهليّة الآجل من الخادم لا استنتاج الشاشة (١٩/٨). */
  deferredEligible: boolean;
}

/** ما يعيده `customers.receptionResolveByPhone` (العقد الخادميّ). */
export interface PhoneResolveResult {
  status: "RESOLVED" | "NEEDS_NAME";
  customerId: number | null;
  name: string | null;
  phone: string;
  defaultPriceTier: string;
  created: boolean;
  deferredEligible: boolean;
}

/** مهلة البحث بعد اكتمال الخانات — مطابقة للاستقبال. */
export const PHONE_LOOKUP_DEBOUNCE_MS = 180;

export const EMPTY_PHONE_CUSTOMER: PhoneCustomer = { customerId: null, name: "", phone: null, isNew: false };

export const RESOLUTION_MESSAGE_AR: Readonly<Record<Exclude<PhoneResolution, "ERROR">, string>> = Object.freeze({
  EMPTY: "اكتب ١١ رقماً؛ سنبحث عن العميل تلقائياً.",
  INCOMPLETE: "أكمل الرقم العراقي الذي يبدأ بـ07.",
  CHECKING: "جارٍ التحقق",
  NEEDS_NAME: "الرقم جديد — بقي اسم العميل فقط.",
  RESOLVED: "تم العثور على العميل وربطه بالطلب.",
});

export const LINK_ANNOUNCE_AR = Object.freeze({
  created: "تم إنشاء العميل وربطه بالطلب",
  linked: "تم ربط العميل الموجود بالطلب",
  failed: "تعذّر التحقق من رقم العميل",
});

export function phaseForPhone(phone: string): "EMPTY" | "INCOMPLETE" | "READY" {
  if (!phone) return "EMPTY";
  return isValidIqMobile(phone) ? "READY" : "INCOMPLETE";
}

export function initialCustomerByPhoneState(phone = ""): CustomerByPhoneState {
  return onPhoneChanged(
    { phone: "", resolution: "EMPTY", error: null, customer: EMPTY_PHONE_CUSTOMER, tier: null, deferredEligible: false },
    phone,
  );
}

/**
 * تغيّر الهاتف: يُسقِط الفئة والأهليّة دائماً (تعلّقتا بعميلٍ آخر)، ويضبط الحالة بحسب الاكتمال.
 * الرقم المكتمل يدخل CHECKING فوراً (الخطّاف يطلق البحث بعد المهلة) — كي لا تبقى شارة
 * «مرتبط» لرقمٍ سابق ١٨٠ مث كما كان في الاستقبال.
 */
export function onPhoneChanged(prev: CustomerByPhoneState, phone: string): CustomerByPhoneState {
  const phase = phaseForPhone(phone);
  if (phase === "EMPTY") {
    return { ...prev, phone, resolution: "EMPTY", error: null, customer: EMPTY_PHONE_CUSTOMER, tier: null, deferredEligible: false };
  }
  if (phase === "INCOMPLETE") {
    return { ...prev, phone, resolution: "INCOMPLETE", error: null, customer: { customerId: null, name: "", phone, isNew: false }, tier: null, deferredEligible: false };
  }
  return { ...prev, phone, resolution: "CHECKING", error: null, customer: { customerId: null, name: "", phone, isNew: true }, tier: null, deferredEligible: false };
}

/** بدء نداء الخادم (بحثٌ أو إنشاء بالاسم). */
export function onResolveStart(prev: CustomerByPhoneState): CustomerByPhoneState {
  return { ...prev, resolution: "CHECKING", error: null };
}

/** الردّ الخادميّ: رقمٌ جديد بلا اسم ⇒ NEEDS_NAME (يُبقي الاسم المكتوب)، وإلّا عميلٌ مربوط. */
export function onResolveResult(prev: CustomerByPhoneState, result: PhoneResolveResult, typedName?: string): CustomerByPhoneState {
  if (result.status === "NEEDS_NAME") {
    return {
      ...prev,
      resolution: "NEEDS_NAME",
      error: null,
      customer: { customerId: null, name: prev.customer.name, phone: prev.phone, isNew: true },
      tier: null,
      deferredEligible: false,
    };
  }
  return {
    ...prev,
    resolution: "RESOLVED",
    error: null,
    customer: {
      customerId: Number(result.customerId),
      name: result.name ?? typedName?.trim() ?? "",
      phone: prev.phone,
      isNew: false,
    },
    tier: result.defaultPriceTier as PhoneCustomerTier,
    deferredEligible: !!result.deferredEligible,
  };
}

export function onResolveError(prev: CustomerByPhoneState, message: string | null | undefined): CustomerByPhoneState {
  return { ...prev, resolution: "ERROR", error: message || LINK_ANNOUNCE_AR.failed };
}

/** كتابة اسم العميل الجديد (قبل الحفظ). */
export function onNameTyped(prev: CustomerByPhoneState, name: string): CustomerByPhoneState {
  return { ...prev, customer: { ...prev.customer, name, phone: prev.phone, isNew: true } };
}

/** هل يُقبل «حفظ وربط» الآن؟ */
export function canSubmitNewCustomer(state: CustomerByPhoneState, opts: { canCreate: boolean; pending: boolean }): boolean {
  return state.resolution === "NEEDS_NAME" && state.customer.name.trim().length >= 2 && !opts.pending && opts.canCreate;
}

/**
 * حدّ الائتمان للعميل الجديد: "" أو "unlimited" ⇒ لا يُرسَل (افتراض الخادم "0" = نقديٌّ فقط)؛
 * رقمٌ ⇒ يُرسَل نصّاً كما هو (الخادم يميّز "" عن "0").
 */
export function creditLimitPayload(raw: string): string | undefined {
  const v = raw.trim();
  if (!v || v === "unlimited") return undefined;
  return v;
}

/** تعقيم مدخل حدّ الائتمان: أرقامٌ ونقطةٌ فقط (مرآة الاستقبال). */
export function sanitizeCreditLimitInput(raw: string): string {
  return raw.replace(/[^\d.]/g, "");
}

/** نصّ الحالة تحت حقل الهاتف ولونه الدلاليّ. */
export function resolutionNotice(state: CustomerByPhoneState): { tone: "muted" | "warn" | "info" | "positive" | "destructive"; text: string } {
  switch (state.resolution) {
    case "EMPTY": return { tone: "muted", text: RESOLUTION_MESSAGE_AR.EMPTY };
    case "INCOMPLETE": return { tone: "warn", text: RESOLUTION_MESSAGE_AR.INCOMPLETE };
    case "CHECKING": return { tone: "muted", text: RESOLUTION_MESSAGE_AR.CHECKING };
    case "NEEDS_NAME": return { tone: "info", text: RESOLUTION_MESSAGE_AR.NEEDS_NAME };
    case "RESOLVED": return { tone: "positive", text: RESOLUTION_MESSAGE_AR.RESOLVED };
    case "ERROR": return { tone: "destructive", text: state.error ?? LINK_ANNOUNCE_AR.failed };
  }
}
