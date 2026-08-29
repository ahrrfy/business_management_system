import { describe, it, expect } from "vitest";
import {
  INVOICE_EVENT_TYPES,
  INVOICE_EVENT_LABEL,
  invoiceEventLabel,
  buildInvoiceEventKey,
} from "./invoiceEventType";

describe("قاموس أحداث الفاتورة", () => {
  it("كلّ قيمة enum لها تعريب عربيّ", () => {
    for (const t of INVOICE_EVENT_TYPES) {
      const label = INVOICE_EVENT_LABEL[t];
      expect(label, `${t} بلا تعريب`).toBeTruthy();
      expect(label).toMatch(/[؀-ۿ]/);
    }
  });

  it("invoiceEventLabel: null/فارغ ⇒ «—»", () => {
    expect(invoiceEventLabel(null)).toBe("—");
    expect(invoiceEventLabel("")).toBe("—");
  });

  it("invoiceEventLabel: قيمة مجهولة ⇒ تعود كما هي", () => {
    expect(invoiceEventLabel("MYSTERY")).toBe("MYSTERY");
  });
});

describe("buildInvoiceEventKey", () => {
  it("بلا seq ⇒ `inv:<id>:<type>`", () => {
    expect(buildInvoiceEventKey(42, "PAID")).toBe("inv:42:PAID");
  });

  it("مع seq رقميّ ⇒ `inv:<id>:<type>:<seq>`", () => {
    expect(buildInvoiceEventKey(42, "PAYMENT_APPLIED", 3)).toBe("inv:42:PAYMENT_APPLIED:3");
  });

  it("seq=0 يُقبل صراحةً", () => {
    expect(buildInvoiceEventKey(42, "PAYMENT_APPLIED", 0)).toBe("inv:42:PAYMENT_APPLIED:0");
  });
});

describe("عقد الثبات", () => {
  it("الأحداث الأساسيّة كلّها معرَّفة", () => {
    for (const t of ["CREATED", "PAID", "CANCELLED", "SUPERSEDED"] as const) {
      expect(INVOICE_EVENT_TYPES).toContain(t);
    }
  });

  it("كلّ قيمة enum تظهر في LABEL (منع سهو المُضيف)", () => {
    for (const t of INVOICE_EVENT_TYPES) {
      expect(Object.keys(INVOICE_EVENT_LABEL)).toContain(t);
    }
  });
});
