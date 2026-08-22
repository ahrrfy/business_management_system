import { describe, expect, it } from "vitest";
import {
  buildInvoiceMessage,
  buildWhatsAppLinks,
  buildOperationalContactMessage,
  buildQuotationMessage,
  buildReconciliationMessage,
  buildStatementMessage,
  buildWorkOrderStatusMessage,
  preferredWhatsAppPhone,
  sanitizeForWhatsApp,
  toIraqiIntl,
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

describe("اختيار رقم التواصل", () => {
  it("يقبل الرقم العراقي وصيغة E.164 الدولية وبادئة 00", () => {
    expect(toIraqiIntl("0770 123 4567")).toBe("+9647701234567");
    expect(toIraqiIntl("+966 50 123 4567")).toBe("+966501234567");
    expect(toIraqiIntl("00971 50 123 4567")).toBe("+971501234567");
  });

  it("يفضّل رقم واتساب الصريح ثم أول بديل صالح", () => {
    expect(preferredWhatsAppPhone("+966501234567", "07701234567")).toBe("+966501234567");
    expect(preferredWhatsAppPhone("123", null, "07701234567")).toBe("07701234567");
    expect(preferredWhatsAppPhone("123", null)).toBeNull();
  });

  it("يبني رابط التطبيق الأصلي ورابط wa.me الاحتياطي للمحادثة نفسها", () => {
    const links = buildWhatsAppLinks("0770 123 4567", "مرحباً أحمد");
    expect(links.appUrl).toBe(`whatsapp://send?phone=9647701234567&text=${encodeURIComponent("مرحباً أحمد")}`);
    expect(links.webUrl).toBe(`https://wa.me/9647701234567?text=${encodeURIComponent("مرحباً أحمد")}`);
  });
});

describe("بناة رسائل الواتساب خالية من الإيموجي", () => {
  it("buildOperationalContactMessage", () => {
    const m = buildOperationalContactMessage({
      entityLabel: "مهمة",
      reference: "T-12",
      partyName: "أحمد",
      title: "تأكيد موعد التسليم",
      status: "قيد التنفيذ",
      dueAt: "2026-08-06",
      nextAction: "يرجى تأكيد الموعد.",
    });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("*متابعة مهمة #T-12*");
    expect(m).toContain("مرحباً أحمد");
    expect(m).toContain("يرجى تأكيد الموعد.");
  });

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

  /**
   * لا تُطالِب رسالةٌ بمالٍ لا يُستحقّ — علّتان أُغلِقتا معاً في `buildInvoiceMessage`:
   * `status` كان مُعرَّفاً ولا يُقرأ، ومسار الاحتياط كان يتجاهل المرتجَع.
   */
  describe("buildInvoiceMessage — المتبقّي لا يُطالِب بما لا يُستحقّ", () => {
    it("يطرح المرتجَع في مسار الاحتياط (بلا remaining صريح)", () => {
      const m = buildInvoiceMessage({
        invoiceNumber: "INV-2",
        total: 12000,
        paidAmount: 2000,
        returnedTotal: 10000,
      });
      // 12000 − 10000 − 2000 = 0 ⇒ لا مطالبة، بل «مدفوعة بالكامل».
      expect(m).not.toContain("*المتبقّي:*");
      expect(m).toContain("*مدفوعة بالكامل*");
    });

    it("يحجب سطر المتبقّي على المستند الميت (ملغاة/مرتجعة/مستبدلة)", () => {
      for (const status of ["CANCELLED", "RETURNED", "SUPERSEDED"]) {
        const m = buildInvoiceMessage({
          invoiceNumber: "INV-3",
          total: 50000,
          paidAmount: 0,
          status,
        });
        expect(m, status).not.toContain("*المتبقّي:*");
        expect(m, status).toContain("لا مبلغ مستحقّاً عليها");
      }
    });

    it("`SUPERSEDED` تحديداً: `returnedTotal` مُصفَّر و`total` كامل ⇒ تبدو مستحقّةً بالكامل", () => {
      const m = buildInvoiceMessage({
        invoiceNumber: "INV-4",
        total: 75000,
        paidAmount: 0,
        returnedTotal: 0,
        status: "SUPERSEDED",
      });
      // الإجمالي يبقى مذكوراً (واقعة المستند)؛ الممنوع هو **سطر المطالبة** بكامل القيمة.
      expect(m).not.toContain("*المتبقّي:*");
      expect(m).toContain("مستبدلة بفاتورة مصححة");
    });

    it("الفاتورة الحيّة تُبقي المطالبة كما هي", () => {
      const m = buildInvoiceMessage({
        invoiceNumber: "INV-5",
        total: 12000,
        paidAmount: 5000,
        status: "PARTIALLY_PAID",
      });
      expect(m).toContain("*المتبقّي:*");
      expect(m).toContain("7,000");
    });
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

  it("buildWorkOrderStatusMessage — READY يذكر الجهوزية + الموعد + الرصيد بلا إيموجي", () => {
    const m = buildWorkOrderStatusMessage({
      orderNumber: "WO-7",
      title: "بطاقات دعوة",
      status: "READY",
      customerName: "أحمد",
      quantity: 100,
      dueDate: "2026-07-10",
      amountDue: 45000,
    });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("*تحديث طلب الخدمة #WO-7*");
    expect(m).toContain("جاهز للاستلام");
    expect(m).toContain("مرحباً أحمد");
    expect(m).toContain("بطاقات دعوة (100 نسخة)");
    expect(m).toContain("الموعد المتوقّع: 2026-07-10");
    expect(m).toContain("45,000");
  });

  it("buildWorkOrderStatusMessage — DELIVERED يشكر بلا موعد ولا رصيد", () => {
    const m = buildWorkOrderStatusMessage({ orderNumber: "WO-8", title: "لافتة", status: "DELIVERED", dueDate: "2026-07-10", amountDue: 20000 });
    expect(noEmoji(m)).toBe(true);
    expect(m).toContain("تمّ *تسليم*");
    expect(m).not.toContain("الموعد المتوقّع");
    expect(m).not.toContain("الرصيد المستحق");
  });
});
