/**
 * WhatsApp wa.me click-to-chat integration — صفري التكلفة، بدون API.
 * المستخدم يضغط الزر فيفتح واتساب بالرسالة جاهزة، ثم يضغط "إرسال" مرة واحدة.
 */

import { fmtDate } from "./date";
import { D } from "./money";
import { invoiceStatusLabel, isDeadInvoiceStatus } from "@shared/invoiceStatus";

const COMPANY_NAME = "المكتبة العربية للطباعة والقرطاسية";

/** تحويل رقم عراقي (07XX-XXX-XXXX أو 07XXXXXXXXX) إلى صيغة دولية +964 */
export function toIraqiIntl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = phone.replace(/\D/g, "");
  // E.164 صريح لدعم العملاء/المورّدين خارج العراق (+966، +971…)، حتى 15 رقماً.
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  // بادئة الاتصال الدولي 00.
  if (digits.startsWith("00") && digits.length >= 10 && digits.length <= 17) return `+${digits.slice(2)}`;
  if (digits.startsWith("9647")) return `+${digits}`;
  if (digits.startsWith("07") && digits.length === 11) return `+964${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 10) return `+964${digits}`;
  // رقم دولي موجود
  if (digits.startsWith("964")) return `+${digits}`;
  return null;
}

/**
 * يختار أول رقم واتساب صالح من المرشّحات بالترتيب الممرّر.
 * الاستعمال المقصود: whatsapp الصريح، ثم هاتف العملية/المستلم، ثم الهاتف الرئيسي والبدائل.
 */
export function preferredWhatsAppPhone(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (toIraqiIntl(candidate)) return candidate?.trim() || null;
  }
  return null;
}

/**
 * تنظيف نصّ رسالة واتساب من الإيموجي/الرموز التصويرية ومحدّدات العرض.
 *
 * سببها: تظهر «�» (أو مربّعات فارغة) على كثير من الأجهزة/إصدارات واتساب، بينما العربية
 * والنقطة • والشرطة — والتظليل *النجمي* تظهر سليمة (محارف BMP عادية). الحلّ المركزي:
 * تُنزَع الإيموجي من **كل** رسائل الواتساب (إرسالاً عبر openWhatsApp/whatsappLink، ونسخاً)
 * فلا تصل رسالةٌ بإيموجي إلى واتساب أبداً — ولو أضاف أحدٌ إيموجي لبانٍ مستقبلاً.
 */
export function sanitizeForWhatsApp(text: string): string {
  // بلا راية /u ولا \p{} عمداً: هدف tsc الافتراضي قديم (ES3) فيرفض هذه الرايات (TS1501).
  // نعتمد أزواج البدائل لكل ما فوق BMP + نطاقات BMP التصويرية الشائعة. نُزيل أيضاً مسافةً تابعةً
  // واحدةً إن وُجدت حتى لا تبقى فجوة بادئة بعد الإزالة (مثل «🧾 *فاتورة*» ← «*فاتورة*»).
  return text
    // كل ما فوق BMP (أزواج البدائل) = الإيموجي رباعية البايت (🧾 👤 📅 💰 …)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF] ?/g, "")
    // رموز BMP تصويرية بنطاقات \u (تفادياً للمحارف الحرفية): تقنية 2300–23FF (⌛⏰⏳)،
    // متنوّعة ودينغبات 2600–27BF (⚠✅✂)، أشكال/أسهم زخرفية 2B00–2BFF، وعلامات مفردة (™©® …).
    .replace(/[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\u2122\u2139\u24C2\u203C\u2049\u00A9\u00AE\u3030\u303D\u3297\u3299] ?/g, "")
    .replace(/[\uFE00-\uFE0F\u200D\u20E3] ?/g, "")
    .replace(/[ \t]+$/gm, "")    // إزالة أي مسافة ذيلية على الأسطر
    .replace(/\n{3,}/g, "\n\n");  // منع تراكم الأسطر الفارغة بعد إزالة سطرٍ كان إيموجي فقط
}

export type WhatsAppLinks = { appUrl: string; webUrl: string };

/**
 * يبني رابط التطبيق الأصلي + رابط ويب احتياطي. `whatsapp://` يفتح WhatsApp/Business
 * مباشرةً حسب التطبيق المسجّل في الهاتف، و`wa.me` يغطي المتصفح أو غياب التطبيق.
 */
export function buildWhatsAppLinks(phone: string | null | undefined, message: string): WhatsAppLinks {
  const intl = toIraqiIntl(phone);
  const encoded = encodeURIComponent(sanitizeForWhatsApp(message).trim());
  const digits = intl?.replace("+", "") ?? "";
  return {
    appUrl: digits
      ? `whatsapp://send?phone=${digits}&text=${encoded}`
      : `whatsapp://send?text=${encoded}`,
    webUrl: digits
      ? `https://wa.me/${digits}?text=${encoded}`
      : `https://wa.me/?text=${encoded}`,
  };
}

/** فتح محادثة واتساب مباشرة على الهاتف، مع رجوع آمن إلى wa.me إن لم يكن التطبيق مثبتاً. */
export function openWhatsApp(phone: string | null | undefined, message: string): void {
  const { appUrl, webUrl } = buildWhatsAppLinks(phone, message);
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (!mobile) {
    window.open(webUrl, "_blank", "noopener,noreferrer");
    return;
  }

  let leftPage = false;
  const markLeft = () => { leftPage = true; };
  window.addEventListener("pagehide", markLeft, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leftPage = true;
  }, { once: true });
  window.location.assign(appUrl);
  window.setTimeout(() => {
    if (!leftPage && document.visibilityState === "visible") window.location.assign(webUrl);
  }, 900);
}

// ─────────────────────────────────────────────
// بناء الرسائل العربية المنسّقة
// ─────────────────────────────────────────────

function fmtMoney(n: string | number | null | undefined): string {
  const num = Number(n ?? 0);
  return num.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
}

function today(): string {
  return fmtDate(new Date());
}

export interface InvoiceMessageData {
  invoiceNumber: string;
  invoiceDate?: string | null;
  customerName?: string | null;
  items?: Array<{ productName: string; quantity: string | number; unitName?: string | null; total: string | number }>;
  subtotal?: string | number;
  total: string | number;
  paidAmount?: string | number;
  /** المرتجَع على الفاتورة — يُطرح في حساب المتبقّي الاحتياطيّ (كان مُهمَلاً ⇒ مطالبةٌ بمالٍ أُرجِع). */
  returnedTotal?: string | number | null;
  remaining?: string | number;
  status?: string;
}

/**
 * رسالة فاتورة للعميل عبر واتساب.
 *
 * **مطالبةٌ بمالٍ لا يُستحقّ — علّتان أُغلِقتا معاً:**
 *  ١) `status` كان معرَّفاً في النوع و**لا يُقرأ إطلاقاً** ⇒ فاتورةٌ ملغاة/مرتجعة/مستبدلة تُرسِل
 *     «المتبقّي: كذا» وهي مستندٌ ميت لا التزام عليه (`SUPERSEDED` أخطرها: `correct.ts` يترك
 *     `total` كاملاً و`returnedTotal` مُصفَّراً ⇒ تبدو مستحقّةً بالكامل).
 *  ٢) مسار الاحتياط كان `total − paid` بلا طرح المرتجَع ⇒ بعد مرتجعٍ جزئيّ تُطالَب بفارقٍ رُدَّ فعلاً.
 *
 * الأموال بـ`decimal.js` عبر `D` — لا `Number`/`parseFloat` على مبلغ (انجراف float + حارس CI).
 */
export function buildInvoiceMessage(data: InvoiceMessageData): string {
  // المتبقّي الحقيقي = الإجمالي − المرتجَع − المدفوع (نفس معادلة InvoiceDetail/listSummary).
  const remainingAmount =
    data.remaining != null
      ? D(data.remaining)
      : D(data.total).minus(D(data.returnedTotal ?? 0)).minus(D(data.paidAmount ?? 0));
  // مستندٌ ميت (ملغاة/مرتجعة/مستبدلة) ⇒ لا سطرَ مطالبةٍ ولا «مدفوعة بالكامل» — الحالة وحدها تُذكر.
  const dead = isDeadInvoiceStatus(data.status);

  const lines: string[] = [
    `*فاتورة بيع #${data.invoiceNumber}*`,
    `التاريخ: ${data.invoiceDate ? fmtDate(data.invoiceDate) : today()}`,
    COMPANY_NAME,
    "",
  ];

  if (data.items && data.items.length > 0) {
    lines.push("*التفاصيل:*");
    for (const it of data.items.slice(0, 6)) {
      lines.push(`  • ${it.productName} × ${it.quantity} ${it.unitName ?? ""} = ${fmtMoney(it.total)} د.ع.`);
    }
    if (data.items.length > 6) lines.push(`  ... و${data.items.length - 6} بنود أخرى`);
    lines.push("");
  }

  lines.push(`*الإجمالي:* ${fmtMoney(data.total)} د.ع.`);
  const paid = D(data.paidAmount ?? 0);
  if (paid.gt(0)) {
    lines.push(`*المدفوع:* ${fmtMoney(data.paidAmount)} د.ع.`);
  }
  if (dead) {
    // بدل المطالبة: بيانُ حالة المستند صراحةً كي لا يبقى العميل أمام مبالغ بلا تفسير.
    lines.push(`*حالة الفاتورة:* ${invoiceStatusLabel(data.status)} — لا مبلغ مستحقّاً عليها.`);
  } else if (remainingAmount.gt(0)) {
    lines.push(`*المتبقّي:* ${fmtMoney(remainingAmount.toString())} د.ع.`);
  } else if (remainingAmount.isZero() && paid.gt(0)) {
    lines.push(`*مدفوعة بالكامل*`);
  }

  lines.push("", `للاستفسار تواصلوا معنا — ${COMPANY_NAME}`);
  return lines.join("\n");
}

export interface QuotationMessageData {
  quoteNumber: string;
  quoteDate?: string | null;
  validUntil?: string | null;
  customerName?: string | null;
  items?: Array<{ productName: string; quantity: string | number; unitName?: string | null; total: string | number }>;
  total: string | number;
  notes?: string | null;
}

export function buildQuotationMessage(data: QuotationMessageData): string {
  const lines: string[] = [
    `*عرض سعر #${data.quoteNumber}*`,
    `التاريخ: ${data.quoteDate ? String(data.quoteDate).slice(0, 10) : today()}`,
    data.validUntil ? `صالح حتى: ${String(data.validUntil).slice(0, 10)}` : "",
    COMPANY_NAME,
    "",
  ].filter((l) => l !== "");

  lines.push("");

  if (data.items && data.items.length > 0) {
    lines.push("*البنود:*");
    for (const it of data.items.slice(0, 8)) {
      lines.push(`  • ${it.productName} × ${it.quantity} ${it.unitName ?? ""} = ${fmtMoney(it.total)} د.ع.`);
    }
    lines.push("");
  }

  lines.push(`*الإجمالي: ${fmtMoney(data.total)} د.ع.*`);

  if (data.notes) {
    lines.push("", `ملاحظة: ${data.notes}`);
  }

  lines.push("", "للتأكيد أو الاستفسار تواصلوا معنا.", COMPANY_NAME);
  return lines.join("\n");
}

export interface StatementMessageData {
  entityName: string;
  entityType: "customer" | "supplier";
  currentBalance: string | number;
  totalSales?: string | number;
  totalPaid?: string | number;
  unpaid?: string | number;
}

export function buildStatementMessage(data: StatementMessageData): string {
  const balance = Number(data.currentBalance);
  const isCustomer = data.entityType === "customer";

  const direction =
    balance === 0
      ? "لا توجد ذمم مستحقّة"
      : isCustomer
      ? balance > 0
        ? `لنا عليكم: ${fmtMoney(balance)} د.ع.`
        : `لكم علينا: ${fmtMoney(Math.abs(balance))} د.ع.`
      : balance > 0
      ? `لكم علينا: ${fmtMoney(balance)} د.ع.`
      : `لنا عليكم: ${fmtMoney(Math.abs(balance))} د.ع.`;

  const lines: string[] = [
    `*كشف حساب — ${data.entityName}*`,
    today(),
    COMPANY_NAME,
    "",
  ];

  if (data.totalSales) lines.push(`إجمالي ${isCustomer ? "المبيعات" : "المشتريات"}: ${fmtMoney(data.totalSales)} د.ع.`);
  if (data.totalPaid) lines.push(`إجمالي المدفوع: ${fmtMoney(data.totalPaid)} د.ع.`);
  if (data.unpaid) lines.push(`غير مدفوع: ${fmtMoney(data.unpaid)} د.ع.`);

  lines.push("", `*${direction}*`);
  lines.push("", "للمراجعة والتسوية تواصلوا معنا.", COMPANY_NAME);
  return lines.join("\n");
}

export interface ReconcileMessageData {
  entityName: string;
  entityType: "customer" | "supplier";
  currentBalance: string | number;
  /** تاريخ المطابقة (افتراضي اليوم). */
  asOfDate?: string;
  /** هل سيُرفِق المرسِل كشف PDF تفصيلياً؟ يضبط جملة المرفق. */
  attachedPdf?: boolean;
}

/**
 * رسالة «طلب مطابقة» واضحة وبسيطة للعميل/المورد: ترحيب + الرصيد الحالي المستحق (من منظور
 * المُستلِم: «بذمّتكم لنا» / «لكم بذمّتنا») + طلب صريح بتأكيد المطابقة أو إبلاغ أي فرق،
 * وجملة إرفاق كشف PDF إن وُجد. بلا إيموجي (تظهر «�» على واتساب) — انظر [[whatsapp]].
 */
export function buildReconciliationMessage(d: ReconcileMessageData): string {
  const bal = Number(d.currentBalance);
  const abs = fmtMoney(Math.abs(bal));
  const isCustomer = d.entityType === "customer";

  // السطر من منظور المُستلِم. العميل: موجب = بذمّته لنا. المورد: موجب = مستحق له علينا.
  let line: string;
  if (bal === 0) {
    line = "*لا يوجد رصيد مستحق — الحساب مُطابَق ومُسوّى.*";
  } else if (isCustomer) {
    line = bal > 0
      ? `*المبلغ المستحق بذمّتكم لنا: ${abs} د.ع.*`
      : `*المبلغ المستحق لكم لدينا: ${abs} د.ع.*`;
  } else {
    line = bal > 0
      ? `*المبلغ المستحق لكم بذمّتنا: ${abs} د.ع.*`
      : `*المبلغ المستحق بذمّتكم لنا: ${abs} د.ع.*`;
  }

  const L: string[] = [];
  L.push(`السلام عليكم ${d.entityName}،`);
  L.push(`طلب مطابقة حساب من ${COMPANY_NAME}.`);
  L.push("");
  L.push(`حسب سجلّاتنا حتى ${d.asOfDate || today()}:`);
  L.push(line);
  L.push("");
  L.push("يرجى مراجعة الرصيد أعلاه وتأكيد المطابقة، أو إبلاغنا بأيّ فرق لتصحيحه.");
  if (d.attachedPdf) L.push("كشف الحساب التفصيلي مرفق بهذه الرسالة (ملف PDF).");
  L.push("");
  L.push("شكراً لتعاونكم.");
  L.push(COMPANY_NAME);
  return L.join("\n");
}

// ─────────────────────────────────────────────
// بضاعة الأمانة: إشعار المودِع بالسحب/الاستبدال (ضابط SOD تعويضيّ — إعلام لا مطالبة)
// ─────────────────────────────────────────────

export interface ConsignmentWithdrawMessageData {
  noteNumber: string;
  noteType: "WITHDRAW" | "EXCHANGE";
  consignorName?: string | null;
  lines: Array<{ direction: "IN" | "OUT"; label: string; quantity: string | number }>;
}

/**
 * إشعار المودِع بسحب/استبدال بضاعته الأمانة لحظة تسجيل السند — أحد ضوابط SOD الثلاثة التعويضية
 * لسحبٍ أحاديّ الفاعل (design §5-أ): يفتح المودِعُ الرسالة فيعلم بما خرج من بضاعته فيتحقّق التقاطع.
 * رسالة إعلامٍ لا مطالبة (لا مبالغ) — بلا إيموجي (تظهر «�» على واتساب، انظر [[whatsapp]]).
 */
export function buildConsignmentWithdrawMessage(data: ConsignmentWithdrawMessageData): string {
  const title = data.noteType === "EXCHANGE" ? "إشعار استبدال بضاعة أمانة" : "إشعار سحب بضاعة أمانة";
  const out = data.lines.filter((l) => l.direction === "OUT");
  const inn = data.lines.filter((l) => l.direction === "IN");
  const L: string[] = [`*${title}*`, COMPANY_NAME, `سند رقم: ${data.noteNumber}`, `التاريخ: ${today()}`, ""];
  if (data.consignorName) L.push(`عزيزنا ${data.consignorName}،`);
  if (out.length > 0) {
    L.push("تمّ سحب الأصناف التالية من بضاعتكم المودَعة لدينا:");
    for (const l of out.slice(0, 15)) L.push(`  • ${l.label} × ${fmtMoney(l.quantity)}`);
  }
  if (inn.length > 0) {
    L.push("وأُودِعت لديكم الأصناف التالية:");
    for (const l of inn.slice(0, 15)) L.push(`  • ${l.label} × ${fmtMoney(l.quantity)}`);
  }
  L.push("", "للتأكيد أو الاستفسار عن أيّ فرق يُرجى التواصل معنا.", COMPANY_NAME);
  return L.join("\n");
}

export interface GiftMessageData {
  direction: "IN" | "OUT";
  giftNumber: string;
  partyName?: string | null;
  lines: { productName: string; unit: string; quantity: number }[];
}

/**
 * رسالة إشعار هدية عبر wa.me (يدويّة، بلا API): للصادر إشعار العميل بهديته، وللوارد شكرُ المورّد.
 * مجاملة لا مطالبة (بلا مبالغ/تكلفة). بلا إيموجي (تظهر «�» على واتساب، انظر [[whatsapp]]).
 */
export function buildGiftMessage(data: GiftMessageData): string {
  const isIn = data.direction === "IN";
  const L: string[] = [`*${isIn ? "إشعار استلام هدية" : "إشعار هدية"}*`, COMPANY_NAME, `سند رقم: ${data.giftNumber}`, `التاريخ: ${today()}`, ""];
  if (data.partyName) L.push(isIn ? `شكراً ${data.partyName}،` : `عزيزنا ${data.partyName}،`);
  L.push(isIn ? "تسلّمنا منكم الأصناف التالية هديةً مجّانية:" : "يسرّنا إهداؤكم الأصناف التالية مجّاناً:");
  for (const l of data.lines.slice(0, 15)) L.push(`  • ${l.productName} × ${l.quantity} ${l.unit}`);
  L.push("", isIn ? "نقدّر تعاونكم الكريم." : "نتمنّى لكم يوماً سعيداً — ولا يترتّب على هذه الهدية أيّ دفع.", COMPANY_NAME);
  return L.join("\n");
}

// ─────────────────────────────────────────────
// متجر الجوال (B2C): استرداد السلة + متابعة الطلب
// ─────────────────────────────────────────────

export interface StorefrontCartLine {
  name: string;
  quantity: number;
  total: number;
}

/**
 * رسالة يرسلها الزبون من سلّته إلى **واتساب المتجر** (استرداد السلة المهجورة): بديل سريع
 * لإتمام الطلب عبر واتساب لمن لا يكمل نموذج الدفع. الدفع عند الاستلام.
 */
export function buildStorefrontCartMessage(items: StorefrontCartLine[], subtotal: number): string {
  const L: string[] = [`*طلب جديد من المتجر*`, COMPANY_NAME, "", "*المطلوب:*"];
  for (const it of items.slice(0, 20)) L.push(`  • ${it.name} × ${it.quantity} = ${fmtMoney(it.total)} د.ع.`);
  if (items.length > 20) L.push(`  ... و${items.length - 20} صنفاً آخر`);
  L.push("", `*المجموع:* ${fmtMoney(subtotal)} د.ع.`, "", "أودّ إتمام هذا الطلب — الدفع عند الاستلام.");
  return L.join("\n");
}

export interface OnlineOrderFollowupData {
  orderNumber: string;
  customerName?: string | null;
  total: string | number;
  status?: string;
}

/**
 * رسالة يرسلها الموظف للزبون لمتابعة/استرداد طلب المتجر (تأكيد الطلب المعلّق، أو إشعار «مع المندوب»).
 */
export function buildOnlineOrderFollowupMessage(d: OnlineOrderFollowupData): string {
  const line =
    d.status === "CANCELLED"
      ? "نأسف، تمّ *إلغاء* طلبك. لمزيد من التفاصيل تواصل معنا."
      : d.status === "SHIPPED"
      ? "طلبك الآن *مع المندوب* في طريقه إليك."
      : d.status === "DELIVERED"
      ? "تمّ *تسليم* طلبك بنجاح. شكراً لتعاملك معنا."
      : "لتأكيد طلبك وإتمام التوصيل، يرجى الردّ على هذه الرسالة.";
  const L: string[] = [`*بخصوص طلبك #${d.orderNumber}*`, COMPANY_NAME, ""];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push(line, "", `الإجمالي (الدفع عند الاستلام): ${fmtMoney(d.total)} د.ع.`, "", "للاستفسار تواصلوا معنا.");
  return L.join("\n");
}

export interface PrintPricingMessageData {
  /** "صغير المقاس (٤ألف×٦ …) · ملوّن · وجهان · ١٠٠ نسخة × ٢ صفحة" أو "عريض ١×٢ م × ٣ قطعة (٦ م²)". */
  jobDescription: string;
  lines: Array<{ label: string; detail?: string | null; amount: string | number }>;
  totalCost: string | number;
  suggestedPrice: string | number;
  unitPrice: string | number;
}

/**
 * رسالة عرض سعر طباعة سريع من حاسبة التسعير — مخرج عملي يُرسَل مباشرةً للعميل عبر wa.me بلا
 * إنشاء عرض سعر رسمي (لا ربط كتالوجيّ لأصنافٍ حرّة التسعير هنا). بلا إيموجي، نمط buildQuotationMessage.
 */
export function buildPrintPricingMessage(d: PrintPricingMessageData): string {
  const L: string[] = [`*تسعير طباعة رقمية*`, COMPANY_NAME, `التاريخ: ${today()}`, "", d.jobDescription, ""];
  for (const l of d.lines) L.push(`  • ${l.label}${l.detail ? ` (${l.detail})` : ""}: ${fmtMoney(l.amount)} د.ع.`);
  L.push("", `إجمالي الكلفة: ${fmtMoney(d.totalCost)} د.ع.`);
  L.push(`*السعر المقترح: ${fmtMoney(d.suggestedPrice)} د.ع.*`);
  L.push(`سعر الوحدة الواحدة: ${fmtMoney(d.unitPrice)} د.ع.`);
  L.push("", "هذا تقديرٌ أوّليّ — للتأكيد والحجز تواصلوا معنا.", COMPANY_NAME);
  return L.join("\n");
}

export interface WorkOrderStatusMessageData {
  orderNumber: string;
  title: string;
  status: "RECEIVED" | "IN_PROGRESS" | "READY" | "DELIVERED" | "CANCELLED" | string;
  customerName?: string | null;
  quantity?: number | null;
  /** الموعد المتوقّع (YYYY-MM-DD) — يُذكَر للحالات ما قبل التسليم فقط. */
  dueDate?: string | null;
  /** الرصيد المستحق عند الاستلام (اختياري) — تذكير لطيف بالمبلغ في حالة READY فقط.
   *  عند التوصيل: هو مبلغ COD (سعر البيع − العربون) بلا الأجرة. */
  amountDue?: string | number | null;
  /** Slice E (٢٩/٨/٢٦): إن كان الطلب توصيلاً، الرسالة تُغيَّر نبرتَها وتُظهر الإجمالي شاملاً الأجرة. */
  hasDelivery?: boolean | null;
  /** أجرة التوصيل — تُظهَر مفصولةً عن COD (شفافيّةٌ للعميل: يعرف كم للطلب وكم للتوصيل). */
  deliveryFee?: string | number | null;
  /** مَن يقبض الأجرة (COURIER يجمعها مع COD، COUNTER/SHOP لا يزيد على العميل). */
  deliveryFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}

/**
 * رسالة تحديث حالة أمر الشغل للعميل — نبرة `buildInvoiceMessage`. تُخبر بالحالة الحالية + الموعد
 * المتوقّع، وتُذكّر بالرصيد المستحق عند الجهوزية. يدوية عبر wa.me (لا cron، لا سجلّ إرسال —
 * أمر الشغل يحفظ تاريخ التحديث أصلاً). بلا إيموجي — تُنظَّف عبر sanitizeForWhatsApp في openWhatsApp.
 *
 * Slice E (٢٩/٨/٢٦): بلاغ المالك «يجب أن يعلم الزبون بالمبلغ الكلي شاملاً التوصيل» — الرسالة تتكيّف:
 * - استلام مباشر: النبرة الحاليّة («جاهز للاستلام»)، ورصيدُ الجهوزيّة سطرٌ واحد.
 * - توصيل: النبرة تصير «سيصلكم قريباً»، وتُذكر أجرةُ التوصيل صراحةً + إجماليّ ما يدفعه العميل للمندوب.
 */
export function buildWorkOrderStatusMessage(d: WorkOrderStatusMessageData): string {
  const isDelivery = !!d.hasDelivery;
  const readyLine = isDelivery
    ? "طلبكم *جاهز* — سيتواصل معكم المندوب قريباً لتحديد موعد التسليم."
    : "طلبكم *جاهز للاستلام*! يسعدنا استقبالكم لاستلامه.";
  const statusLine: Record<string, string> = {
    RECEIVED: "تمّ *استلام* طلبكم وهو في قائمة الانتظار.",
    IN_PROGRESS: "طلبكم الآن *قيد التنفيذ*.",
    READY: readyLine,
    DELIVERED: isDelivery
      ? "تمّ *توصيل* طلبكم بنجاح. شكراً لتعاملكم معنا."
      : "تمّ *تسليم* طلبكم بنجاح. شكراً لتعاملكم معنا.",
    CANCELLED: "نأسف، تمّ *إلغاء* طلبكم. لمزيد من التفاصيل تواصلوا معنا.",
  };
  const line = statusLine[d.status] ?? `حالة طلبكم الحالية: ${d.status}`;

  const L: string[] = [
    `*تحديث طلب الخدمة #${d.orderNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push(line);
  L.push("");
  L.push(`الطلب: ${d.title}${d.quantity ? ` (${d.quantity} نسخة)` : ""}`);
  if (d.dueDate && d.status !== "DELIVERED" && d.status !== "CANCELLED") {
    L.push(`الموعد المتوقّع: ${String(d.dueDate).slice(0, 10)}`);
  }
  if (d.status === "READY" && d.amountDue != null && Number(d.amountDue) > 0) {
    const codD = Number(d.amountDue);
    const feeD = Number(d.deliveryFee ?? 0);
    const feeCollection = d.deliveryFeeCollection ?? "COURIER";
    // للتوصيل + أجرةٍ موجبة + يجمعها المندوب: أظهِر الأجرة سطراً ثمّ الإجماليّ صراحةً.
    if (isDelivery && feeD > 0 && feeCollection === "COURIER") {
      L.push(`قيمة الطلب: ${fmtMoney(codD)} د.ع`);
      L.push(`أجرة التوصيل: ${fmtMoney(feeD)} د.ع`);
      L.push(`*الإجماليّ للمندوب: ${fmtMoney(codD + feeD)} د.ع*`);
    } else if (isDelivery) {
      L.push(`المبلغ المستحق للمندوب عند الاستلام: ${fmtMoney(codD)} د.ع.`);
    } else {
      L.push(`الرصيد المستحق عند الاستلام: ${fmtMoney(codD)} د.ع.`);
    }
  }
  L.push("", `للاستفسار تواصلوا معنا — ${COMPANY_NAME}`);
  return L.join("\n");
}

/**
 * Slice N (٣٠/٨/٢٦) — إعلام العميل عند إسناد طلبه لمندوب.
 * تكميلٌ لـSlice M: نفس لحظة الإسناد، لكن الرسالة موجَّهةٌ للعميل بمَن يُوصِل طلبه.
 * العميل يعرف اسم المندوب ورقم هاتفه فيتوقّع الاتصال (بدل «مَن هذا الرقم الغريب؟»).
 */
export interface CustomerDispatchMessageData {
  orderNumber: string;
  title: string;
  customerName?: string | null;
  courierName: string;
  courierPhone?: string | null;
  codAmount: string | number;
  deliveryFee?: string | number | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}

export function buildCustomerDispatchMessage(d: CustomerDispatchMessageData): string {
  const cod = Number(d.codAmount);
  const feeD = Number(d.deliveryFee ?? 0);
  const feeCollection = d.feeCollection ?? "COURIER";
  const L: string[] = [
    `*تحديث طلبكم #${d.orderNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push(`طلبكم *${d.title}* في طريقه إليكم عبر المندوب.`);
  L.push("");
  L.push(`المندوب: ${d.courierName}`);
  if (d.courierPhone) L.push(`رقم المندوب: ${d.courierPhone}`);
  L.push("");
  if (feeCollection === "COURIER" && feeD > 0) {
    L.push(`قيمة الطلب: ${fmtMoney(cod)} د.ع`);
    L.push(`أجرة التوصيل: ${fmtMoney(feeD)} د.ع`);
    L.push(`*الإجماليّ للمندوب: ${fmtMoney(cod + feeD)} د.ع*`);
  } else {
    L.push(`المبلغ المستحق للمندوب: ${fmtMoney(cod)} د.ع`);
  }
  L.push("", `للاستفسار تواصلوا معنا — ${COMPANY_NAME}`);
  return L.join("\n");
}

/**
 * Slice M (٣٠/٨/٢٦) — رسالة إسناد إرسالية لجهة توصيل.
 * تُرسَل من DispatchDialog بعد نجاح الإسناد: كلّ ما يحتاجه المندوب لتنفيذ التوصيل في رسالةٍ واحدة.
 *
 * الحقول القصوى (كلّها اختيارية ما عدا `consignmentNumber` و`codAmount`):
 *  - رقم الإرسالية، الجهة، اسم المستلم، هاتفه، العنوان
 *  - COD المطلوب تحصيله (إلزاميّ — بلا حجم صحيح لا معنى للإسناد)
 *  - أجرة التوصيل الاقتراحيّة (يعرف المندوب ما سيقبضه فوق COD في نمط COURIER)
 */
export interface CourierAssignmentMessageData {
  consignmentNumber: string;
  orderNumber?: string | null;
  title?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
  codAmount: string | number;
  deliveryFee?: string | number | null;
  /** COURIER يجمع الأجرة مع COD ⇒ نعرض الإجماليّ صراحةً. غيرها ⇒ COD فقط. */
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}

export function buildCourierAssignmentMessage(d: CourierAssignmentMessageData): string {
  const cod = Number(d.codAmount);
  const feeD = Number(d.deliveryFee ?? 0);
  const feeCollection = d.feeCollection ?? "COURIER";
  const L: string[] = [
    `*إرساليّة توصيل جديدة #${d.consignmentNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.orderNumber) L.push(`رقم الطلب: ${d.orderNumber}`);
  if (d.title) L.push(`الطلب: ${d.title}`);
  if (d.customerName) L.push(`المستلم: ${d.customerName}`);
  if (d.customerPhone) L.push(`الهاتف: ${d.customerPhone}`);
  if (d.deliveryAddress) L.push(`العنوان: ${d.deliveryAddress}`);
  L.push("");
  L.push(`مبلغ التحصيل (COD): ${fmtMoney(cod)} د.ع`);
  if (feeD > 0) {
    L.push(`أجرة التوصيل: ${fmtMoney(feeD)} د.ع`);
    if (feeCollection === "COURIER") {
      L.push(`*الإجماليّ من العميل: ${fmtMoney(cod + feeD)} د.ع*`);
    }
  }
  L.push("", "برجاء التواصل مع العميل لتحديد موعد التسليم.", COMPANY_NAME);
  return L.join("\n");
}

export interface OperationalContactMessageData {
  partyName?: string | null;
  entityLabel: string;
  reference?: string | null;
  title?: string | null;
  status?: string | null;
  dueAt?: string | Date | null;
  nextAction?: string | null;
}

/** رسالة تشغيلية عامة للكيانات التي لا تحتاج قالب مستند كامل (حجز/مهمة/جهة/متابعة). */
export function buildOperationalContactMessage(d: OperationalContactMessageData): string {
  const L: string[] = [
    `*متابعة ${d.entityLabel}${d.reference ? ` #${d.reference}` : ""}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.partyName) L.push(`مرحباً ${d.partyName}،`);
  if (d.title) L.push(d.title);
  if (d.status) L.push(`الحالة الحالية: ${d.status}`);
  if (d.dueAt) L.push(`الموعد: ${fmtDate(d.dueAt)}`);
  if (d.nextAction) L.push("", d.nextAction);
  L.push("", `للاستفسار تواصلوا معنا — ${COMPANY_NAME}`);
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// قوالب الرسائل المرحلية الجاهزة (مراحل الطلب والتوصيل — العميل والمندوب)
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomerOrderConfirmedData {
  orderNumber: string;
  title: string;
  customerName?: string | null;
  salePrice?: string | number | null;
  deposit?: string | number | null;
  dueDate?: string | null;
  isDelivery?: boolean | null;
}

/** رسالة تأكيد استلام الطلب وتثبيته في النظام للعميل. */
export function buildCustomerOrderConfirmedMessage(d: CustomerOrderConfirmedData): string {
  const price = Number(d.salePrice ?? 0);
  const dep = Number(d.deposit ?? 0);
  const rem = Math.max(0, price - dep);

  const L: string[] = [
    `*تأكيد استلام طلبكم #${d.orderNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push(`تمّ استلام وتأكيد طلبكم *${d.title}* بنجاح وهو الآن مدرج في جدول التنفيذ.`);
  L.push("");
  if (price > 0) L.push(`قيمة الطلب: ${fmtMoney(price)} د.ع`);
  if (dep > 0) L.push(`العربون المدفوع: ${fmtMoney(dep)} د.ع`);
  if (rem > 0) L.push(`المتبقي عند الاستلام: ${fmtMoney(rem)} د.ع`);
  if (d.dueDate) L.push(`الموعد المتوقع: ${String(d.dueDate).slice(0, 10)}`);
  L.push(`طريقة الاستلام: ${d.isDelivery ? "توصيل إلى موقعكم" : "استلام مباشر من الفرع"}`);
  L.push("", `شكراً لثقتكم بنا — ${COMPANY_NAME}`);
  return L.join("\n");
}

export interface CustomerLocationRequestData {
  orderNumber: string;
  title?: string | null;
  customerName?: string | null;
}

/** رسالة طلب الموقع الجغرافي (Location) والعنوان التفصيلي من العميل. */
export function buildCustomerLocationRequestMessage(d: CustomerLocationRequestData): string {
  const L: string[] = [
    `*تأكيد موقع التوصيل — طلب #${d.orderNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push("نرجو منكم التكرم بإرسال موقعكم الحالي (Location) والعنوان التفصيلي عبر هذه المحادثة، لترتيب توجيه المندوب إليكم فور جاهزية الطلب.");
  if (d.title) L.push(`بخصوص: ${d.title}`);
  L.push("", `شكراً لتعاونكم معنا — ${COMPANY_NAME}`);
  return L.join("\n");
}

export interface CustomerDeliveredData {
  orderNumber: string;
  title?: string | null;
  customerName?: string | null;
  courierName?: string | null;
}

/** رسالة تهنئة وشكر بعد إتمام تسليم الطلب للعميل. */
export function buildCustomerDeliveredMessage(d: CustomerDeliveredData): string {
  const L: string[] = [
    `*تم تسليم طلبكم بنجاح #${d.orderNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push(`تمّ تسليم طلبكم *${d.title ?? ""}* بنجاح${d.courierName ? ` عبر المندوب ${d.courierName}` : ""}.`);
  L.push("سعدنا جداً بخدمتكم ونتطلع دائماً للتعاون معكم.");
  L.push("", `لأي ملاحظات أو طلبات جديدة نحن في خدمتكم دائماً — ${COMPANY_NAME}`);
  return L.join("\n");
}

export interface CustomerDeliveryFailedData {
  orderNumber: string;
  title?: string | null;
  customerName?: string | null;
  courierName?: string | null;
  courierPhone?: string | null;
}

/** رسالة إشعار بتعذر التواصل أو التسليم لتحديد موعد بديل مع العميل. */
export function buildCustomerDeliveryFailedMessage(d: CustomerDeliveryFailedData): string {
  const L: string[] = [
    `*تنبيه بخصوص توصيل طلبكم #${d.orderNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`مرحباً ${d.customerName}،`);
  L.push(`حاول المندوب${d.courierName ? ` ${d.courierName}` : ""} التواصل معكم لتسليم طلبكم *${d.title ?? ""}* ولكن تعذّر الوصول.`);
  if (d.courierPhone) L.push(`رقم هاتف المندوب: ${d.courierPhone}`);
  L.push("يرجى التفضل بالرد أو الاتصال بنا لتحديد موعد تسليم مناسب يناسبكم. طلبكم محفوظ وجاهز.");
  L.push("", `مع تحيات إدارة ${COMPANY_NAME}`);
  return L.join("\n");
}

export interface CourierUrgentDispatchData {
  consignmentNumber: string;
  orderNumber?: string | null;
  title?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
  codAmount: string | number;
  deliveryFee?: string | number | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
}

/** رسالة شحنة عاجلة للمندوب بأولوية قصوى. */
export function buildCourierUrgentDispatchMessage(d: CourierUrgentDispatchData): string {
  const cod = Number(d.codAmount);
  const feeD = Number(d.deliveryFee ?? 0);
  const feeCollection = d.feeCollection ?? "COURIER";
  const L: string[] = [
    `*تنبيه: شحنة عاجلة ذات أولوية #${d.consignmentNumber}*`,
    COMPANY_NAME,
    "",
    "يرجى إعطاء الأولوية في التوصيل للشحنة التالية:",
  ];
  if (d.orderNumber) L.push(`رقم الطلب: ${d.orderNumber}`);
  if (d.title) L.push(`الطلب: ${d.title}`);
  if (d.customerName) L.push(`المستلم: ${d.customerName}`);
  if (d.customerPhone) L.push(`الهاتف: ${d.customerPhone}`);
  if (d.deliveryAddress) L.push(`العنوان: ${d.deliveryAddress}`);
  L.push("");
  L.push(`مبلغ التحصيل (COD): ${fmtMoney(cod)} د.ع`);
  if (feeD > 0) {
    L.push(`أجرة التوصيل: ${fmtMoney(feeD)} د.ع`);
    if (feeCollection === "COURIER") {
      L.push(`*الإجماليّ المطلوب من العميل: ${fmtMoney(cod + feeD)} د.ع*`);
    }
  }
  L.push("", "يرجى الإسراع بالتسليم وتحديث الحالة فور الإنجاز.", COMPANY_NAME);
  return L.join("\n");
}

export interface CourierAddressUpdateData {
  consignmentNumber: string;
  orderNumber?: string | null;
  customerName?: string | null;
  newAddress: string;
  notes?: string | null;
}

/** رسالة إبلاغ المندوب بعنوان محدث للعميل. */
export function buildCourierAddressUpdateMessage(d: CourierAddressUpdateData): string {
  const L: string[] = [
    `*تحديث عنوان التوصيل للإرسالية #${d.consignmentNumber}*`,
    COMPANY_NAME,
    "",
  ];
  if (d.customerName) L.push(`العميل: ${d.customerName}`);
  if (d.orderNumber) L.push(`رقم الطلب: ${d.orderNumber}`);
  L.push("");
  L.push(`*العنوان الجديد المعتمد*: ${d.newAddress}`);
  if (d.notes) L.push(`ملاحظات: ${d.notes}`);
  L.push("", "يرجى اعتماد هذا العنوان المحدّث للتسليم.", COMPANY_NAME);
  return L.join("\n");
}

export interface CourierSettlementReminderData {
  courierName: string;
  openConsignmentsCount: number;
  totalCodAmount: string | number;
}

/** رسالة تذكير للمندوب بتوريد وتسوية المبالغ والعهد المحصلة. */
export function buildCourierSettlementReminderMessage(d: CourierSettlementReminderData): string {
  const L: string[] = [
    `*تذكير بتوريد عهد التوصيل — قسم الحسابات*`,
    COMPANY_NAME,
    "",
    `مرحباً ${d.courierName}،`,
    "نرجو التكرم بمراجعة قسم الحسابات/الكاشير لتوريد مبالغ الشحنات التي تم تسليمها وإغلاق عهدتها:",
    "",
    `عدد الشحنات قيد التوريد: ${d.openConsignmentsCount}`,
    `*إجمالي مبالغ التحصيل (COD) المستحقة: ${fmtMoney(d.totalCodAmount)} د.ع*`,
    "",
    `شكراً لحرصكم والتزامكم الدائم — ${COMPANY_NAME}`,
  ];
  return L.join("\n");
}

export interface CourierCancellationData {
  consignmentNumber: string;
  orderNumber?: string | null;
  customerName?: string | null;
  reason?: string | null;
}

/** رسالة تنبيه للمندوب بإلغاء الإرسالية وعدم تسليمها للعميل وإعادتها. */
export function buildCourierCancellationMessage(d: CourierCancellationData): string {
  const L: string[] = [
    `*تنبيه: إلغاء إرسالية توصيل #${d.consignmentNumber}*`,
    COMPANY_NAME,
    "",
    "يرجى العلم بأنه تمّ *إلغاء* الإرسالية المذكورة رسمياً في النظام:",
  ];
  if (d.orderNumber) L.push(`رقم الطلب: ${d.orderNumber}`);
  if (d.customerName) L.push(`العميل: ${d.customerName}`);
  if (d.reason) L.push(`السبب: ${d.reason}`);
  L.push("");
  L.push("*توجيه هام*: يرجى عدم تسليم الطرد للعميل وإعادته لمقر المكتبة.");
  L.push("", COMPANY_NAME);
  return L.join("\n");
}

