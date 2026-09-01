import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../WorkOrderDetail.tsx", import.meta.url), "utf8");

describe("واجهة عكس التسليم من تفاصيل أمر الشغل", () => {
  it("تستعمل طلب التحكم الموحد ولا تستدعي الكاتب الفوري", () => {
    expect(page).toContain("<ReverseDeliveryRequestDialog");
    expect(page).toContain('data.status === "DELIVERED"');
    expect(page).toContain("canRequestControl");
    expect(page).not.toContain("trpc.workOrders.reverseDelivery.useMutation");
    expect(page).not.toContain("trpc.workOrders.reverseServiceInvoice.useMutation");
  });

  it("يعرض ملف التصميم حتى لنسخة تصميم بلا صور", () => {
    expect(page).toContain("<DesignFileCard images={(data.images ?? []) as never}");
    expect(page).not.toContain("data.images && data.images.length > 0");
  });
});
