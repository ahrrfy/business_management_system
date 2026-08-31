import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const page = readFileSync(new URL("../CostWaves.tsx", import.meta.url), "utf8");
const detail = readFileSync(
  new URL("../../components/costWave/CostWaveDetailDialog.tsx", import.meta.url),
  "utf8",
);
const hub = readFileSync(new URL("../InventoryHub.tsx", import.meta.url), "utf8");

describe("عقد واجهة موجات التكلفة", () => {
  it("تظهر كوحدة مستقلة بجوار موجات الأسعار مع الأقسام الأربعة", () => {
    expect(hub).toContain('value: "price-waves"');
    expect(hub).toContain('value: "cost-waves"');
    expect(page).toContain("إنشاء موجة");
    expect(page).toContain("بانتظار اعتمادي");
    expect(page).toContain("طلباتي");
    expect(page).toContain("التاريخ الكامل");
  });

  it("يعرض تفاصيل المنتج والفئة والفاعل والتاريخ واللقطات في DataTable", () => {
    for (const text of [
      "المنتج / المتغيّر",
      "الفئة",
      "التكلفة السابقة",
      "التكلفة الجديدة",
      "الكمية",
      "صاحب القرار",
      "التاريخ والوقت",
      "لقطة كل مرحلة",
    ]) {
      expect(page + detail).toContain(text);
    }
    expect(page).toContain("<DataTable");
    expect(detail).toContain("<DataTable");
    expect(page + detail).not.toMatch(/<table\b/i);
  });

  it("يشرح الاعتمادين والتطبيق الذري قبل الإرسال والاعتماد النهائي", () => {
    expect(page).toContain("يلزم شخصان مختلفان");
    expect(page).toContain("الكل أو لا شيء");
    expect(detail).toContain("الاعتماد الثاني والتطبيق");
    expect(detail).toContain("أي تعارض يوقف الكل");
  });
});
