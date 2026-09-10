import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../Returns.tsx", import.meta.url), "utf8");

describe("واجهة مرتجعات البيع", () => {
  it("توضح أهلية الفاتورة ودورة الإرجاع والاستبدال دون إنشاء منطق مرتجع موازٍ", () => {
    expect(page).toContain("دليل الإرجاع والاستبدال");
    expect(page).toContain("تحقق من الأهلية");
    expect(page).toContain("الاستبدال للعميل فله مسار مستقل");
    expect(page).toContain("الطلب المعلّق لا يحرّك المخزون أو المال");
    expect(page).toContain("ردّ المال لا يتجاوز المقبوض والسقف المتاح");
    expect(page).toContain("<ReturnComposer");
    expect(page).not.toContain("refundRails.preflight");
  });

  it("يربط الإرشاد بالحالة الموجودة: اختيار فاتورة أو مراجعة طلب", () => {
    expect(page).toContain("selectedInvoice={selectedId != null}");
    expect(page).toContain("approvingRequest={approvingRequestId != null}");
    expect(page).toContain("وضع مراجعة واعتماد");
    expect(page).toContain("وضع تسجيل المرتجع");
  });
});
