/**
 * وضع «توصيل» في كاشير التجزئة — المنطق النقيّ (برنامج v2 م١ PR-B، ٥/٩/٢٦).
 *
 * الشاشة الواحدة: الهاتف ⇒ العميل يُنشأ تلقائياً ⇒ المحافظة ⇒ الجهة تُقترَح ⇒ الأجرة تُملأ
 * ⇒ حفظ ⇒ فاتورة + طرد. هذا الملفّ يبني الحمولة ويتحقّق منها بلا React ولا شبكة كي يُختبَر
 * وحده؛ والحقول في `DeliveryModeFields.tsx`.
 *
 * ⛔ صفر فحص ائتمانٍ هنا: `sales.create` يمرّر `paymentMode:"COD"` فيتخطّى الخادم حاجز
 * الائتمان — الشاشة لا تُعطّل حارساً ولا تُقلّده.
 */
import { GOVERNORATES, deliveryFeeFor } from "@shared/governorates";
import { type DeliveryFeeCollection } from "@shared/deliveryFeeCollection";
import Decimal from "decimal.js";

export interface DeliveryDraft {
  /** معرّف المحافظة من `shared/governorates` ("baghdad" …) أو "" قبل الاختيار. */
  governorate: string;
  address: string;
  partyId: number | null;
  /** اسم الجهة المختارة — للإيصال والتوست (يُملأ مع `partyId`). */
  partyName: string;
  /** نصّ مالٍ (MoneyInput) — يُطبَّع عند البناء. */
  fee: string;
  /** هل حرّر الكاشير الأجرة بيده؟ الأجرةُ المشتقّة تلقائياً (افتراضُ الجهة أو تقديرُ المحافظة) تتبع
   *  تغيّر الجهة/المحافظة؛ أمّا ما كتبه الكاشير فلا يُطمَس (تدقيق Codex P1، ٥/٩/٢٦). */
  feeManual: boolean;
  feeCollection: DeliveryFeeCollection;
  recipientName: string;
  recipientPhone: string;
  /** هاتف العميل (١١ خانة) الذي رُبط به التبويب — لاستئناف البحث عند العودة إلى التبويب؛ لا يُرسَل. */
  customerPhone: string;
}

/** عقد `sales.create` ⇒ `input.delivery` (PR-1 م١-خادم): يُسنِد داخل نفس المعاملة. */
export interface DeliveryPayload {
  partyId: number;
  fee: string;
  feeCollection: DeliveryFeeCollection;
  recipientName?: string;
  recipientPhone?: string;
  address?: string;
  governorate?: string;
}

export interface DeliveryPartyOption {
  id: number;
  name: string;
  defaultFee: string;
}

export type DeliveryDraftIssue = "NO_PARTY" | "NO_ADDRESS" | "COUNTER_FEE_REQUIRED" | "BAD_FEE";

export const DELIVERY_ISSUE_AR: Readonly<Record<DeliveryDraftIssue, string>> = Object.freeze({
  NO_PARTY: "اختر جهة التوصيل",
  NO_ADDRESS: "اكتب عنوان التوصيل — المندوب لا يصل بلا عنوان",
  COUNTER_FEE_REQUIRED: "«مقبوضة في الاستقبال» تتطلّب مبلغ أجرةٍ أكبر من صفر",
  BAD_FEE: "أجرة التوصيل ليست مبلغاً صالحاً",
});

/** سبب تعطيل وضع التوصيل — الإسناد يحتاج حرّاس الخادم الحيّة (SLA · الفرع · الجهة). */
export const DELIVERY_OFFLINE_REASON = "التوصيل يحتاج اتصالاً بالخادم — لا إسناد بلا حرّاس حيّة";

export function deliveryModeUnavailableReason(offline: boolean): string | null {
  return offline ? DELIVERY_OFFLINE_REASON : null;
}

export function emptyDeliveryDraft(): DeliveryDraft {
  return { governorate: "", address: "", partyId: null, partyName: "", fee: "", feeManual: false, feeCollection: "COURIER", recipientName: "", recipientPhone: "", customerPhone: "" };
}

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/** تطبيع نصّ الأجرة إلى `d.dd` (فارغ ⇒ "0.00")؛ null إن لم يكن مبلغاً صالحاً. */
export function normalizeFee(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "0.00";
  if (!MONEY_RE.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

export function validateDeliveryDraft(d: DeliveryDraft): DeliveryDraftIssue[] {
  const issues: DeliveryDraftIssue[] = [];
  if (d.partyId == null || d.partyId <= 0) issues.push("NO_PARTY");
  if (!d.address.trim()) issues.push("NO_ADDRESS");
  const fee = normalizeFee(d.fee);
  if (fee == null) issues.push("BAD_FEE");
  else if (d.feeCollection === "COUNTER" && Number(fee) <= 0) issues.push("COUNTER_FEE_REQUIRED");
  return issues;
}

/** الحمولة الخادميّة أو null إن كانت المسوّدة ناقصة (استعمل `validateDeliveryDraft` للسبب). */
export function buildDeliveryPayload(d: DeliveryDraft): DeliveryPayload | null {
  if (validateDeliveryDraft(d).length > 0) return null;
  const fee = normalizeFee(d.fee)!;
  return {
    partyId: d.partyId!,
    fee,
    feeCollection: d.feeCollection,
    ...(d.recipientName.trim() ? { recipientName: d.recipientName.trim() } : {}),
    ...(d.recipientPhone.trim() ? { recipientPhone: d.recipientPhone.trim() } : {}),
    address: d.address.trim(),
    ...(d.governorate ? { governorate: d.governorate } : {}),
  };
}

/**
 * وضع التوصيل — قرارُ إرسال `payment` (تدقيق Codex P1، ٥/٩/٢٦): يُحجَب الدفعُ فقط لبيعٍ نقديٍّ بلا
 * قبضٍ الآن (COD كامل يقبضه المندوب). غيرُ النقد مؤكَّدٌ سلفاً (محاولةٌ خارجيّة ناجحة) ⇒ يُرسَل
 * دائماً؛ حجبُه كان يُهمِل قبضاً خارجياً وقع فعلاً ويُسنِد الطلبَ COD خطأً.
 */
export function deliverySendsPayment(method: string, paidNow: Decimal): boolean {
  return !(method === "CASH" && paidNow.lte(0));
}

/**
 * وضع التوصيل — مبالغُ الإيصال (تدقيق Codex P1/P2، ٥/٩/٢٦): «المقبوض الآن» = ما يُسجَّل على الفاتورة
 * (صفرٌ لِـCOD الكامل · المدفوعُ لقبضٍ جزئيّ · الإجماليُّ لدفعٍ كامل/بطاقة)، والفكّةُ تبقى صفراً لتحصيل
 * COD الجزئيّ وتُحسب كبيعٍ عاديّ حين قُبض نقدٌ ≥ الإجماليّ (فائضٌ يُردّ للزبون).
 */
export function deliveryReceiptAmounts(args: {
  method: string;
  paidNow: Decimal;
  total: Decimal;
  isCredit: boolean;
}): { received: Decimal; change: Decimal } {
  const { method, paidNow, total, isCredit } = args;
  const received = deliverySendsPayment(method, paidNow) ? (isCredit ? paidNow : total) : new Decimal(0);
  const change = method === "CASH" && paidNow.gte(total) ? paidNow.minus(total) : new Decimal(0);
  return { received, change };
}

/**
 * مبالغُ إيصال بيع الكاشير (تدقيق Codex P1/P2، ٥/٩/٢٦) — مصدرٌ واحدٌ للوضعين: في التوصيل تُشتقّ من
 * `deliveryReceiptAmounts` (وعهدةُ COD ليست ذمّةً على العميل ⇒ credit=0)؛ وفي البيع العاديّ الآجلُ
 * الجزئيُّ يُظهر المدفوعَ، الفكّةَ صفراً، وذمّةً بالباقي (السلوكُ القائم بلا تغيير).
 */
export function saleReceiptAmounts(args: {
  codMode: boolean;
  method: string;
  paidNow: Decimal;
  total: Decimal;
  isCredit: boolean;
}): { received: Decimal; change: Decimal; credit: Decimal } {
  const { codMode, method, paidNow, total, isCredit } = args;
  if (codMode) {
    const { received, change } = deliveryReceiptAmounts({ method, paidNow, total, isCredit });
    return { received, change, credit: new Decimal(0) };
  }
  return {
    received: isCredit ? paidNow : total,
    change: isCredit ? new Decimal(0) : paidNow.minus(total),
    credit: isCredit ? total.minus(paidNow) : new Decimal(0),
  };
}

/**
 * اختيار الجهة: الأجرةُ المشتقّة تلقائياً تتبع الجهةَ المختارة، وأجرةٌ كتبها الكاشير بيده (feeManual)
 * لا تُطمَس. قبل تدقيق Codex P1 كانت أوّلُ جهةٍ تُثبّت الأجرة فيبقى مبلغُ الجهة السابقة عند تبديلها.
 */
export function applyPartySelection(d: DeliveryDraft, party: DeliveryPartyOption | null): DeliveryDraft {
  if (!party) return { ...d, partyId: null, partyName: "" };
  const fee = d.feeManual ? d.fee : party.defaultFee ?? "0";
  return { ...d, partyId: party.id, partyName: party.name, fee };
}

/**
 * اختيار المحافظة (أتمتة ٤): إن اقترح الخادم جهةً للمنطقة ولم يختر الكاشير جهةً بعد ⇒ تُختار
 * وتُملأ أجرتها؛ وإن لم يكن ثمّة اقتراحٌ ولا أجرة ⇒ تقدير `shared/governorates` كنقطة انطلاق.
 */
export function applyGovernorateSelection(
  d: DeliveryDraft,
  governorate: string,
  opts: { suggestedPartyId: number | null | undefined; parties: DeliveryPartyOption[] },
): DeliveryDraft {
  let next: DeliveryDraft = { ...d, governorate };
  const suggested = opts.suggestedPartyId != null ? opts.parties.find((p) => p.id === opts.suggestedPartyId) ?? null : null;
  if (next.partyId == null && suggested) next = applyPartySelection(next, suggested);
  // التقديرُ التلقائيّ نقطةُ انطلاقٍ حين لا جهةَ تُملي الأجرة ولم يحرّرها الكاشير (تدقيق Codex P1):
  // يُستبدَل عند تغيّر المحافظة بدل التجمّد على تقديرٍ قديم، ويُترَك لأجرةٍ يدويّةٍ أو جهةٍ مختارة.
  if (!next.feeManual && next.partyId == null && governorate) {
    const estimate = deliveryFeeFor(governorate);
    next = { ...next, fee: estimate > 0 ? String(estimate) : "" };
  }
  return next;
}

/** خيارات المحافظات للقائمة — من المصدر المشترك وحده (⛔ لا قاموس محلّيّ). */
export function governorateOptions(): Array<{ value: string; label: string }> {
  return GOVERNORATES.map((g) => ({ value: g.id, label: g.name }));
}

/**
 * هاتفٌ عراقيّ محلّي (07xxxxxxxxx) ⇒ E.164 (+9647xxxxxxxx) — صيغة `IntlPhoneInput` والخادم.
 * ما ليس محلّياً يُعاد كما هو (رقمٌ دوليّ مكتوبٌ سلفاً).
 */
export function toE164Iraq(phone: string): string {
  const v = phone.trim();
  if (!v) return "";
  if (v.startsWith("+")) return v;
  const digits = v.replace(/\D/g, "");
  if (/^07\d{9}$/.test(digits)) return `+964${digits.slice(1)}`;
  if (/^9647\d{9}$/.test(digits)) return `+${digits}`;
  return v;
}

/** المستلم يُملأ افتراضياً من العميل المربوط (يعدّله الكاشير عند الحاجة). */
export function withRecipientDefaults(d: DeliveryDraft, customer: { name: string; phone: string | null }): DeliveryDraft {
  return {
    ...d,
    recipientName: d.recipientName.trim() ? d.recipientName : customer.name,
    recipientPhone: d.recipientPhone.trim() ? d.recipientPhone : toE164Iraq(customer.phone ?? ""),
  };
}

export interface DeliveryCustomerIdentityInput {
  customerId: number | null;
  name: string;
  /** أرقامٌ محلّية (07xxxxxxxxx) أو جزءٌ منها أثناء الكتابة. */
  phone: string;
}

/**
 * هويّة العميل من آلة «العميل بالهاتف» ⇒ المسوّدة: يُحفظ الهاتف لاستئناف التبويب، وعند **تبدّل**
 * العميل المربوط يُستبدل المستلم بالعميل الجديد (المستلم السابق كان لعميلٍ آخر)، وإلّا يُملأ
 * الفارغ فقط (ما كتبه الكاشير لا يُطمس).
 */
export function applyCustomerIdentity(
  d: DeliveryDraft,
  identity: DeliveryCustomerIdentityInput,
  previousCustomerId: number | null,
): DeliveryDraft {
  const base: DeliveryDraft = { ...d, customerPhone: identity.phone };
  if (identity.customerId == null) return base;
  if (previousCustomerId != null && previousCustomerId !== identity.customerId) {
    return { ...base, recipientName: identity.name, recipientPhone: toE164Iraq(identity.phone) };
  }
  return withRecipientDefaults(base, { name: identity.name, phone: identity.phone });
}
