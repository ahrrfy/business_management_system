import { describe, expect, it } from "vitest";
import {
  buildInvoiceMessage,
  buildQuotationMessage,
  buildReconciliationMessage,
  buildStatementMessage,
  sanitizeForWhatsApp,
} from "../whatsapp";

/** صحيح إن خلا النصّ من أي إيموجي/رمز تصويري. */
const noEmoji = (s: string) => !/\p{Extended_Pictographic}/u.test(s);

describe("sanitizeForWhatsApp", () => {
  it("يُزيل الإيموجي (BMP والـastral) ومحدّد العرض FE0F", () => {
    expect(sanitizeForWhatsApp("🧾 *فاتورة*")).toBe("*فاتورة*");
    expect(sanitizeForWhatsApp("⚠️ تنبيه")).toBe("تنبيه");
    expect(sanitizeForWhatsApp("أهلاً 👋")).toBe("أهلاً");
    expect(sanitizeForWhatsApp("✅ مدفوع · ⏳ متبقٍّ")).toBe("مدفوع · متبقٍّ");
    expect(noEmoji(sanitizeForWhatsApp("👤🔐🔗📧🔑📝 نصّ"))).toBe(true);
  });

  it("يُبقي العربية والأرقام و• و— و*التظليل* (محارف BMP تظهر سليمة)", () => {
    const s = "*عرض سعر #123*\n• بند ١ — ٥٠٠ د.ع.\nالتاريخ: 2026-06-13";
    expect(sanitizeForWhatsApp(s)).toBe(s);
  });

  it("لا يدمج الأسطر ولا يترك مسافات ذيلية", () => {
    const out = sanitizeForWhatsApp("سطر١ 🧾\nسطر٢ ✅");
    expect(out).toBe("سطر١\nسطر٢");
  });

  it("يطوي الأسطر الفارغة المتراكمة بعد إزالة سطر إيموجي", () => {
    expect(sanitizeForWhatsApp("أ\n\n\n\nب")).toBe("أ\n\nب");
  });
});

describe("بناة رسائل الواتساب خالية من الإيموجي", () => {
  it("buildInvoiceMessage", () => {
    const m = buildInvoiceMessage({
      invoiceNumber: "INV-1",
      total: 12000,
      paidAmount: 5000,
      items: [{ productName: "دفتر", quantity: 2, unitName: "قطعة", total: 4000 }],
    });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("*فاتورة بيع #INV-1*");
    expect(m).toContain("• دفتر");
  });

  it("buildQuotationMessage", () => {
    const m = buildQuotationMessage({ quoteNumber: "Q-1", total: 9000, validUntil: "2026-07-01" });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("*عرض سعر #Q-1*");
    expect(m).toContain("صالح حتى: 2026-07-01");
  });

  it("buildStatementMessage", () => {
    const m = buildStatementMessage({ entityName: "متجر النور", entityType: "customer", currentBalance: 25000 });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("*كشف حساب — متجر النور*");
    expect(m).toContain("لنا عليكم");
  });

  it("buildReconciliationMessage — طلب مطابقة واضح بلا إيموجي", () => {
    // عميل برصيد موجب ⇒ المبلغ بذمّته لنا، مع طلب تأكيد المطابقة وإشارة مرفق PDF.
    const m = buildReconciliationMessage({ entityName: "متجر النور", entityType: "customer", currentBalance: 25000, asOfDate: "2026-06-13", attachedPdf: true });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("طلب مطابقة حساب");
    expect(m).toContain("بذمّتكم لنا");
    expect(m).toContain("25,000");
    expect(m).toContain("تأكيد المطابقة");
    expect(m).toContain("PDF");
  });

  it("buildReconciliationMessage — مورد برصيد موجب = مستحق له علينا، وبلا PDF لا تُذكر", () => {
    const m = buildReconciliationMessage({ entityName: "مورّد القرطاسية", entityType: "supplier", currentBalance: 80000 });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("لكم بذمّتنا");
    expect(m).not.toContain("PDF");
  });

  it("buildReconciliationMessage — رصيد صفر = الحساب مُطابَق ومُسوّى", () => {
    const m = buildReconciliationMessage({ entityName: "زبون", entityType: "customer", currentBalance: 0 });
    expect(m).toContain("مُطابَق ومُسوّى");
  });
});
