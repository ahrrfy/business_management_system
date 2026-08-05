// ش٢ (§١٠) — حارس قالب الإيصال: يرفض حمولةً بلا رقم مستندٍ حقيقيّ أو برقم مسوّدة DRF-.
// «الاعتماد على انضباط المطوّر القادم هو ما يُنتج هذه الثغرات» — الحارس بنيويٌّ لا اتفاقيّ.
import { describe, expect, it } from "vitest";
import { printReceipt } from "./print";
import type { ReceiptBrowserData } from "./printTemplates";

const base: ReceiptBrowserData = {
  receiptNumber: "",
  date: "2026-08-05",
  time: "12:00",
  cashierName: "موظف",
  customerName: null,
  items: [{ name: "دفتر", quantity: 1, price: "1000.00", total: "1000.00" }],
  subtotal: "1000.00",
  total: "1000.00",
  paid: "1000.00",
  change: null,
  paymentMethod: "نقدي",
} as ReceiptBrowserData;

describe("printReceipt guard — لا إيصال بلا رقم مستند حقيقي", () => {
  it("حمولة بلا رقم ⇒ رفض قبل أي ناقل", async () => {
    await expect(printReceipt({ ...base, receiptNumber: "" })).rejects.toThrow(/بلا رقم مستند/);
  });
  it("رقم مسوّدة DRF- ⇒ رفض (تُطبَع بقالب المسوّدة لا الإيصال)", async () => {
    await expect(printReceipt({ ...base, receiptNumber: "DRF-1-20260805-00001" })).rejects.toThrow(/قالب المسوّدة/);
  });
});
