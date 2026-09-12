import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const requestQuoteScreen = readFileSync(
  resolve(process.cwd(), "app/request-quote.tsx"),
  "utf8",
);

describe("B2B quote-request guidance", () => {
  it("explains the inquiry, staff-review, and acceptance recheck sequence", () => {
    expect(requestQuoteScreen).toContain("مراحل طلب الشركات والمكاتب");
    expect(requestQuoteScreen).toContain("طلب العرض استفسار وليس طلب شراء أو حجز مخزون.");
    expect(requestQuoteScreen).toContain("هذا استفسار وليس طلب شراء ولا يحجز مخزوناً أو يثبت سعراً.");
    expect(requestQuoteScreen).toContain("يراجع موظف المبيعات التفاصيل ثم يصدر العرض الرسمي قبل موافقتك.");
    expect(requestQuoteScreen).toContain("عند الموافقة على العرض، يُعاد التحقق من السعر والتوفر قبل تسجيلها.");
  });
});
