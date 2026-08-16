import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assetSettlementPresentation } from "../../lib/assetAccrualStatus";

const source = readFileSync(new URL("../AssetDetail.tsx", import.meta.url), "utf8");

describe("AssetDetail acquisition settlement disclosure", () => {
  it("separates the operational status from the pending liability settlement", () => {
    expect(source).toContain("const isPaymentPending = a.paymentPending === true;");
    expect(source).toContain("const isLive = a.isActive !== false && (a.status === \"active\" || a.status === \"maintenance\");");
    expect(source).toContain("الأصل مُثبت تشغيلياً، وتسوية الالتزام معلّقة");
    expect(assetSettlementPresentation("PAYMENT_PENDING")).toMatchObject({
      label: "طلب دفع معلّق",
      liabilityOutstanding: true,
      cashMoved: false,
    });
    expect(assetSettlementPresentation("PAYABLE_UNSETTLED")).toMatchObject({
      label: "ذمة مورد غير مسوّاة",
      liabilityOutstanding: true,
      cashMoved: false,
    });
  });

  it("keeps lifecycle and document actions available for a recognized asset", () => {
    expect(source).not.toContain("!isPaymentPending && a.status !== \"disposed\"");
    expect(source).not.toContain("رفع المستند غير متاح قبل اعتماد الدفع");
    expect(source).toContain("{isLive && <Button variant=\"outline\" size=\"sm\" onClick={() => setOpenMaint(true)}>");
    expect(source).toContain("onClick={() => addDoc.mutate");
    expect(source).toContain("aria-label={`حذف المستند");
  });
});
