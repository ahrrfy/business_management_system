import { describe, it, expect } from "vitest";
import {
  INVOICE_STATUSES,
  DEAD_INVOICE_STATUSES,
  VOIDED_INVOICE_STATUSES,
  isDeadInvoiceStatus,
  isVoidedInvoiceStatus,
  invoiceStatusLabel,
  invoiceStatusBadgeVariant,
} from "./invoiceStatus";

describe("قاموس حالة الفاتورة — مصدر الحقيقة", () => {
  it("PENDING = «غير مدفوعة» لا «معلّقة» (تصحيح مسرد ١٧/٨/٢٦)", () => {
    // بلاغ المالك: «معلّقة» أوحت للموظفين بحالة «قيد المعالجة/غير مؤكَّدة» فتُهمَل.
    // «غير مدفوعة» صادقة وتحرّض على المتابعة.
    expect(invoiceStatusLabel("PENDING")).toBe("غير مدفوعة");
  });

  it("كلّ حالةٍ في INVOICE_STATUSES لها تعريب — لا رمز إنجليزي يتسرّب", () => {
    for (const s of INVOICE_STATUSES) {
      const label = invoiceStatusLabel(s);
      expect(label, `الحالة ${s} بلا تعريب`).not.toBe(s);
      expect(label, `الحالة ${s} تعريبها فارغ`).not.toBe("");
    }
  });

  it("فارغ/null/undefined ⇒ «—»", () => {
    expect(invoiceStatusLabel(null)).toBe("—");
    expect(invoiceStatusLabel(undefined)).toBe("—");
    expect(invoiceStatusLabel("")).toBe("—");
  });

  it("رمز مجهول يعود كما هو (لا throw، لا رسم مكسور)", () => {
    expect(invoiceStatusLabel("UNKNOWN_STATUS")).toBe("UNKNOWN_STATUS");
  });
});

describe("المستند الميّت vs المُبطَل — تمييز حاكم", () => {
  it("DEAD يشمل RETURNED؛ VOIDED لا يشمله (RETURNED بيعٌ وقع ثمّ أُرجع)", () => {
    expect(DEAD_INVOICE_STATUSES).toContain("RETURNED");
    expect(VOIDED_INVOICE_STATUSES).not.toContain("RETURNED");
    expect(isDeadInvoiceStatus("RETURNED")).toBe(true);
    expect(isVoidedInvoiceStatus("RETURNED")).toBe(false);
  });

  it("SUPERSEDED في كليهما (البديلة تحمل الالتزام والحساب)", () => {
    expect(isDeadInvoiceStatus("SUPERSEDED")).toBe(true);
    expect(isVoidedInvoiceStatus("SUPERSEDED")).toBe(true);
  });

  it("CANCELLED في كليهما (عُكِست بالكامل، ليست بيعاً)", () => {
    expect(isDeadInvoiceStatus("CANCELLED")).toBe(true);
    expect(isVoidedInvoiceStatus("CANCELLED")).toBe(true);
  });

  it("PAID/PARTIALLY_PAID/PENDING ليست ميتة ولا مبطَلة", () => {
    for (const s of ["PAID", "PARTIALLY_PAID", "PENDING", "CONFIRMED"]) {
      expect(isDeadInvoiceStatus(s), `${s} ليست ميتة`).toBe(false);
      expect(isVoidedInvoiceStatus(s), `${s} ليست مبطَلة`).toBe(false);
    }
  });

  it("null/undefined ⇒ false في كلا الحارسَين", () => {
    for (const v of [null, undefined, ""]) {
      expect(isDeadInvoiceStatus(v)).toBe(false);
      expect(isVoidedInvoiceStatus(v)).toBe(false);
    }
  });
});

describe("variant الشارة — منع الخرائط المنجرفة", () => {
  it("كلّ حالةٍ في INVOICE_STATUSES لها variant محدَّد (لا fallback صامت)", () => {
    for (const s of INVOICE_STATUSES) {
      const v = invoiceStatusBadgeVariant(s);
      expect(["success", "warning", "secondary", "outline"], `الحالة ${s} فيها variant غير معتمد`).toContain(v);
    }
  });

  it("PAID → success (أخضر دلاليّ)", () => {
    expect(invoiceStatusBadgeVariant("PAID")).toBe("success");
  });

  it("PARTIALLY_PAID → warning (كهرمانيّ دلاليّ — قسم مدفوع فقط)", () => {
    expect(invoiceStatusBadgeVariant("PARTIALLY_PAID")).toBe("warning");
  });

  it("PENDING → secondary (محايد — لا «خطأ»، مبلغ آجل نافذ ليس مشكلة)", () => {
    // مبلغٌ لم يُدفَع بعد ≠ خطأ. destructive/warning يوحيان بمشكلة. secondary يقول «حالة قائمة».
    // اخترنا `secondary` لا `info` لأنّ MobileDataCard لا يدعم `info` — الاتّساق العالميّ أهمّ.
    expect(invoiceStatusBadgeVariant("PENDING")).toBe("secondary");
  });

  it("المستندات الميّتة (CANCELLED/RETURNED/SUPERSEDED) → outline (تُخفَّض بصرياً)", () => {
    for (const s of DEAD_INVOICE_STATUSES) {
      expect(invoiceStatusBadgeVariant(s), `${s} يجب أن يكون outline`).toBe("outline");
    }
  });

  it("فارغ/مجهول ⇒ outline (لا rendering مكسور)", () => {
    expect(invoiceStatusBadgeVariant(null)).toBe("outline");
    expect(invoiceStatusBadgeVariant(undefined)).toBe("outline");
    expect(invoiceStatusBadgeVariant("UNKNOWN")).toBe("outline");
  });
});
