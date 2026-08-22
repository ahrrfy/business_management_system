/**
 * حارس اشتقاق قناة الفاتورة (١٩/٨) — بلاغ المالك «لا تمييز بصريّ لقناة الفاتورة».
 *
 * الثابت: القناة تُشتقّ من (`sourceType`, `shiftType`) وحدهما، وأمرُ الشغل استقبالٌ **حتى
 * بلا وردية** (فخّ `shiftId=NULL` عند التسليم خارج وردية استقبال مفتوحة).
 */
import { describe, expect, it } from "vitest";
import {
  INVOICE_CHANNELS,
  deriveInvoiceChannel,
  invoiceChannelIcon,
  invoiceChannelLabel,
  invoiceChannelOptions,
  invoiceChannelTone,
} from "./invoiceChannel";

describe("قناة الفاتورة", () => {
  it("⭐ الكاشيرات الثلاثة تختم POS — الوردية وحدها تفرزها", () => {
    expect(deriveInvoiceChannel({ sourceType: "POS", shiftType: "RETAIL" })).toBe("RETAIL");
    expect(deriveInvoiceChannel({ sourceType: "POS", shiftType: "RECEPTION" })).toBe("RECEPTION");
    expect(deriveInvoiceChannel({ sourceType: "POS", shiftType: "PRINT_SERVICES" })).toBe("PRINT");
  });

  it("⭐ أمر الشغل استقبالٌ ولو بلا وردية (فخّ shiftId=NULL عند التسليم)", () => {
    expect(deriveInvoiceChannel({ sourceType: "WORKORDER", shiftType: null })).toBe("RECEPTION");
    expect(deriveInvoiceChannel({ sourceType: "ORDER", shiftType: undefined })).toBe("RECEPTION");
    // ولا تقلبه وردية طباعة: مصدرُه أقوى من ورديّة من سلّمه.
    expect(deriveInvoiceChannel({ sourceType: "WORKORDER", shiftType: "PRINT_SERVICES" })).toBe("RECEPTION");
  });

  it("المتجر الإلكتروني قناةٌ مستقلّة، والمجهول لا يُصنَّف تجزئةً كذباً", () => {
    expect(deriveInvoiceChannel({ sourceType: "ONLINE", shiftType: null })).toBe("STORE");
    expect(deriveInvoiceChannel({ sourceType: null, shiftType: null })).toBe("OTHER");
    expect(deriveInvoiceChannel({ sourceType: "WEIRD", shiftType: null })).toBe("OTHER");
  });

  it("POS بلا وردية معروفة ⇒ تجزئة (الغلبة)، لا «أخرى»", () => {
    expect(deriveInvoiceChannel({ sourceType: "POS", shiftType: null })).toBe("RETAIL");
  });

  it("لكل قناة اسمٌ وأيقونةٌ وتوكن، والأسماء فريدة", () => {
    const labels = INVOICE_CHANNELS.map(invoiceChannelLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const c of INVOICE_CHANNELS) {
      expect(invoiceChannelIcon(c)).toMatch(/^[A-Z][A-Za-z0-9]*$/); // lucide لا إيموجي
      expect(invoiceChannelTone(c)).toMatch(/^chan-/); // توكن لا لون خام
    }
    expect(invoiceChannelOptions().map((o) => o.value)).toEqual([...INVOICE_CHANNELS]);
  });
});
