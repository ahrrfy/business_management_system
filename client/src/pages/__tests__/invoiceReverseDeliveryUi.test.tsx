import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../InvoiceDetail.tsx", import.meta.url), "utf8");

describe("واجهة عكس تسليم فاتورة أمر الشغل", () => {
  it("توحّد الفاتورة الخدمية وذات البنود في طلب تحكم واحد", () => {
    expect(page).toContain("<ReverseDeliveryRequestDialog");
    expect(page).toContain('"workorders"');
    expect(page).toContain('["cashier", "manager"]');
    expect(page).toContain("(?::R\\d+)?");
    expect(page).not.toContain("isZeroItemServiceInvoice");
    expect(page).not.toContain("/returns?invoiceId=");
  });

  it("لا يملك مسار عكس فوري أو نافذة prompt", () => {
    expect(page).not.toContain("trpc.workOrders.reverseServiceInvoice.useMutation");
    expect(page).not.toContain("trpc.workOrders.reverseDelivery.useMutation");
    expect(page).not.toContain("window.prompt");
  });
});
