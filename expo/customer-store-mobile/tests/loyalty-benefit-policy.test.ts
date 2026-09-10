import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const loyalty = readFileSync(resolve(root, "app/loyalty.tsx"), "utf8");

describe("loyalty benefit policy", () => {
  it("explains that one product-pricing benefit is selected independently from delivery", () => {
    expect(loyalty).toContain("سياسة التوفير في الطلب");
    expect(loyalty).toContain("منفعة سعرية واحدة فقط على المنتجات في كل طلب");
    expect(loyalty).toContain("سعر الجملة أو العرض أو الكوبون");
    expect(loyalty).toContain("يُعتمد الأعلى توفيراً تلقائياً");
    expect(loyalty).toContain("عرض التوصيل مستقل عن هذه المنفعة");
  });

  it("keeps the first-order coupon as a self-request before the first order", () => {
    expect(loyalty).toContain("اطلبه بنفسك قبل إنشاء أول طلب");
  });
});
