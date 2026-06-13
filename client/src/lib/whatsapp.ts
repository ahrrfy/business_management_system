/**
 * WhatsApp wa.me click-to-chat integration — صفري التكلفة، بدون API.
 * المستخدم يضغط الزر فيفتح واتساب بالرسالة جاهزة، ثم يضغط "إرسال" مرة واحدة.
 */

const COMPANY_NAME = "المكتبة العربية للطباعة والقرطاسية";

/** تحويل رقم عراقي (07XX-XXX-XXXX أو 07XXXXXXXXX) إلى صيغة دولية +964 */
export function toIraqiIntl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("9647")) return `+${digits}`;
  if (digits.startsWith("07") && digits.length === 11) return `+964${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 10) return `+964${digits}`;
  // رقم دولي موجود
  if (digits.startsWith("964")) return `+${digits}`;
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

/** فتح واتساب مع رسالة جاهزة. إذا لم يكن هناك رقم، يفتح wa.me بدون رقم (المستخدم يختار المحادثة) */
export function openWhatsApp(phone: string | null | undefined, message: string): void {
  const intl = toIraqiIntl(phone);
  const encoded = encodeURIComponent(sanitizeForWhatsApp(message).trim());
  const url = intl
    ? `https://wa.me/${intl.replace("+", "")}?text=${encoded}`
    : `https://wa.me/?text=${encoded}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

// ─────────────────────────────────────────────
// بناء الرسائل العربية المنسّقة
// ─────────────────────────────────────────────

function fmtMoney(n: string | number | null | undefined): string {
  const num = Number(n ?? 0);
  return num.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 2 });
}

function today(): string {
  return new Date().toLocaleDateString("ar-IQ-u-nu-latn");
}

export interface InvoiceMessageData {
  invoiceNumber: string;
  invoiceDate?: string | null;
  customerName?: string | null;
  items?: Array<{ productName: string; quantity: string | number; unitName?: string | null; total: string | number }>;
  subtotal?: string | number;
  total: string | number;
  paidAmount?: string | number;
  remaining?: string | number;
  status?: string;
}

export function buildInvoiceMessage(data: InvoiceMessageData): string {
  const remaining = data.remaining ?? (Number(data.total) - Number(data.paidAmount ?? 0));
  const remainingNum = Number(remaining);

  const lines: string[] = [
    `*فاتورة بيع #${data.invoiceNumber}*`,
    `التاريخ: ${data.invoiceDate ? new Date(data.invoiceDate).toLocaleDateString("ar-IQ-u-nu-latn") : today()}`,
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
  if (data.paidAmount && Number(data.paidAmount) > 0) {
    lines.push(`*المدفوع:* ${fmtMoney(data.paidAmount)} د.ع.`);
  }
  if (remainingNum > 0) {
    lines.push(`*المتبقّي:* ${fmtMoney(remainingNum)} د.ع.`);
  } else if (remainingNum === 0 && Number(data.paidAmount ?? 0) > 0) {
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
