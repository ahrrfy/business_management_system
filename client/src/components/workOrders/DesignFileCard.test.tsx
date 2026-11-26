import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDesignSaveInput } from "./DesignFileCard";

describe("ملف تصميم أمر الشغل", () => {
  it("يحفظ الصور والسبب دون مسح نص التخصيص غير المرسل", () => {
    const input = buildDesignSaveInput(
      5079,
      [{ id: "a", dataUrl: "data:image/png;base64,AAAA", name: "الواجهة", isPrimary: true }],
      "تصحيح لون الشعار",
    );

    expect(input).toEqual({
      workOrderId: 5079,
      images: [{
        url: "data:image/png;base64,AAAA",
        caption: "الواجهة",
        sortOrder: 0,
      }],
      note: "تصحيح لون الشعار",
    });
    expect(input).not.toHaveProperty("customizationText");
  });

  it("لا يدّعي فتح طلب اعتماد تلقائياً بعد إنشاء النسخة", () => {
    const source = readFileSync(new URL("./DesignFileCard.tsx", import.meta.url), "utf8");
    expect(source).toContain("اطلب اعتمادها من بطاقة الحوكمة");
    expect(source).not.toContain("فُتح طلب موافقة");
  });
});
