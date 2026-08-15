import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AssetDetail.tsx", import.meta.url), "utf8");

describe("AssetDetail pending-acquisition lifecycle guard", () => {
  it("treats isActive=false as a pending acquisition even when status is active", () => {
    expect(source).toContain("const isPaymentPending = a.isActive === false;");
    expect(source).toContain("const isLive = !isPaymentPending && (a.status === \"active\" || a.status === \"maintenance\");");
    expect(source).toContain("بانتظار اعتماد دفع الاقتناء");
  });

  it("does not expose edit, document upload, or document deletion while payment is pending", () => {
    expect(source).toContain("!isPaymentPending && a.status !== \"disposed\"");
    expect(source).toContain("isPaymentPending ? (");
    expect(source).toContain("رفع المستند غير متاح قبل اعتماد الدفع");
    expect(source).toMatch(/\{!isPaymentPending && \(\s*<button[\s\S]*?aria-label=\{`حذف المستند/);
  });
});
