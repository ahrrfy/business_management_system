import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../Returns.tsx", import.meta.url), "utf8");
const hub = readFileSync(new URL("../ReturnsHub.tsx", import.meta.url), "utf8");

describe("بوابة المرتجعات الموحدة", () => {
  it("يبقي مدخل المسار على البوابة الموحدة بدلاً من نسخة مرتجعات قديمة", () => {
    expect(page).toContain('export { default } from "./ReturnsHub"');
    expect(hub).toContain("بوابة المرتجعات الموحدة");
    expect(hub).toContain("مرتجعات المبيعات");
    expect(hub).toContain("مرتجعات الشراء");
  });

  it("يحافظ على منفذي المبيعات والموردين وعلى روابط البدء العميقة", () => {
    expect(hub).toContain("<SalesReturnPortal");
    expect(hub).toContain("<PurchaseReturnPortal");
    expect(hub).toContain('urlParams.get("invoice")');
    expect(hub).toContain('urlParams.get("po")');
  });
});
