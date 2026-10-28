import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = (name: string) => readFileSync(new URL(`../${name}.tsx`, import.meta.url), "utf8");
describe("commerce recovery and pricing UI contracts", () => {
  it("does not infer delivered gifts from pending=false", () => {
    const source = page("GiftsHub");
    const callback = source.slice(source.indexOf("const outbound ="), source.indexOf("const [approvingId"));
    expect(callback).toContain('res.status === "DELIVERED"');
    expect(callback).toContain('res.status === "CANCELLED"');
    expect(callback).toContain("أُلغي طلب الهدية");
    expect(callback).not.toContain("notify.ok(res.pending ?");
  });
  it("requires explicit current-price confirmation before converting a reservation", () => {
    const source = page("ReservationsHub");
    expect(source).toContain("previewConversion");
    expect(source).toContain("pricingConfirmation:");
    expect(source).toContain("fingerprint:");
    expect(source).toContain("إجمالي التنفيذ الحالي");
    expect(source).toMatch(/await confirm\(/);
    expect(source).toContain("fulfilledInvoiceId");
  });
});
