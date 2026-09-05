import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settings = readFileSync(
  new URL("../../components/purchases/PurchaseControlSettingsPanel.tsx", import.meta.url),
  "utf8",
);
const detail = readFileSync(new URL("../PurchaseOrderDetail.tsx", import.meta.url), "utf8");

describe("واجهة ضوابط الشراء ومسار تسوية الدولار", () => {
  it("تقرأ وتحدّث سياسة الفرع بقفل نسخة متفائل", () => {
    expect(settings).toContain("purchases.controlSettings.useQuery");
    expect(settings).toContain("purchases.updateControlSettings.useMutation");
    expect(settings).toContain("expectedVersion: Number(settings.data.version)");
    expect(settings).toContain("priceTolerancePercent");
    expect(settings).toContain("totalToleranceAmount");
    expect(settings).toContain("blockUninvoicedReceiptsAtClose");
  });

  it("يفشل مغلقاً بلا فرع ولا يختار أول فرع للأدمن", () => {
    expect(settings).toContain('me.data?.role === "admin"');
    expect(settings).toContain('option value="">اختر فرعاً</option>');
    expect(settings).toContain("branchId <= 0");
    expect(settings).not.toContain("branches.data?.[0]");
  });

  it("لا يعيد إحياء bypass تسديد الدولار القديم في تفاصيل الأمر", () => {
    expect(detail).not.toContain("settleUsdDirect");
    expect(detail).not.toContain("تسديد USD مباشر");
  });
});
