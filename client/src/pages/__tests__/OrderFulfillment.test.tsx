import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../OrderFulfillment.tsx", import.meta.url), "utf8");

describe("Order fulfillment staff workflow", () => {
  it("keeps preparation behind confirmation", () => {
    expect(page).toContain('const canPrintPreparation = st === "CONFIRMED" || st === "PROCESSING";');
    expect(page).toContain("disabled: isBusy || !canPrintPreparation");
    expect(page).toContain("ثبّت الطلب أولاً قبل طباعة ورقة التجهيز");
  });

  it("guides staff to communicate the existing confirmation and handoff statuses", () => {
    expect(page).toContain('orderStatusLabelForCustomer("CONFIRMED")');
    expect(page).toContain('orderStatusLabelForCustomer("SHIPPED")');
    expect(page).toContain("يؤكّد المندوب التسليم والتحصيل من «توصيلاتي»");
  });
});
