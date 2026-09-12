import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../StoreProductReviewManager.tsx", import.meta.url),
  "utf8",
);

describe("إدارة مراجعات منتجات المتجر", () => {
  it("توضح أن القرار النهائي يتطلب تأكيداً ولا تسمح بحسم السجل مرة ثانية من الواجهة", () => {
    expect(source).toContain('import { confirm } from "@/lib/confirm"');
    expect(source).toContain("const accepted = await confirm({");
    expect(source).toContain("القرار نهائي ولا يمكن تغييره");
    expect(source).toContain('review.status === "PENDING"');
    expect(source).toContain(
      "حُسم القرار نهائياً ولا يمكن تعديل حالة هذه المراجعة.",
    );
    expect(source).not.toContain("window.confirm");
  });

  it("يبقي هوية العميل داخلية ويعرض ملخصاً مفيداً وحالات تحميل وخطأ صريحة", () => {
    expect(source).toContain("دون اسم العميل أو أي بيانات تعريفية");
    expect(source).toContain("للاستخدام الداخلي فقط");
    expect(source).toContain("ملخص المراجعات المعروضة");
    expect(source).toContain("تقييمات تحتاج انتباهاً");
    expect(source).toContain("<LoadingState");
    expect(source).toContain("<ErrorState");
  });
});
