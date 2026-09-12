import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const router = readFileSync(resolve(__dirname, "..", "crmRouter.ts"), "utf8");

describe("كوبون الطلب الأول في إدارة CRM", () => {
  it("يمنع الإصدار الإداري اليدوي للبرنامج الذاتي", () => {
    expect(router).toContain("if (program.isFirstOrderSelfService)");
    expect(router).toContain("لا يمكن إصدار دفعة يدوية لكوبون الطلب الأول");
    expect(router).toContain("دع العميل يطلب الكوبون من صفحة الولاء");
  });
});
