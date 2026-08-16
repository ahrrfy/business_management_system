import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AssetEdit.tsx", import.meta.url), "utf8");

describe("AssetEdit financial fact lock", () => {
  it("shows acquisition facts as locked and explains the document workflow", () => {
    expect(source).toContain("حقائق الاقتناء والكفالة");
    expect(source).toContain("حقائق مالية مُرحّلة لا تُعدَّل من هذه الشاشة");
    expect(source).toContain("يتطلب مستنداً مالياً مستقلاً");
    expect(source).toMatch(/id="br"[\s\S]*?disabled aria-describedby="asset-financial-lock"/);
    expect(source).toMatch(/id="sup"[\s\S]*?disabled aria-describedby="asset-financial-lock"/);
    expect(source).toMatch(/id="pdate"[\s\S]*?readOnly aria-describedby="asset-financial-lock"/);
    expect(source).toMatch(/id="pval"[\s\S]*?disabled aria-describedby="asset-financial-lock"/);
  });

  it("does not advertise the removed financing-conversion workflow", () => {
    expect(source).not.toContain("طلب تحويل تمويل الأصل");
    expect(source).not.toContain("ينفّذ مالكٌ آخر الدفع والتعديل معاً");
  });
});
