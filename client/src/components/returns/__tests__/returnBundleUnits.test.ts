import { describe, expect, it } from "vitest";
import { returnQuantityLabel } from "../ReturnComposer";

describe("مرتجع البكج — دلالة الكمية التشغيلية", () => {
  it("يعرض الكمية كبكجات لا كقطع", () => {
    expect(returnQuantityLabel(1, 1, "بكج", "بكج")).toBe("1 بكج");
    expect(returnQuantityLabel(2, 1, "بكج", "بكج")).toBe("2 بكج");
  });

  it("يحافظ على وحدة تعبئة أعلى مع بيان عدد البكجات داخلها", () => {
    expect(returnQuantityLabel(12, 6, "كرتون", "بكج")).toBe("2 كرتون (12 بكج)");
  });
});
