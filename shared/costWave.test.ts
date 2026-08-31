import { describe, expect, it } from "vitest";
import {
  COST_WAVE_REQUIRED_APPROVALS,
  applyCostWaveRule,
} from "./costWave";

describe("applyCostWaveRule", () => {
  it("يحسب التعيين والرفع والخفض بدقة نقدية واحدة", () => {
    expect(
      applyCostWaveRule("100.00", { ruleType: "SET_COST", changeValue: "87.125" }),
    ).toEqual({ newCost: "87.13", skipReason: null });
    expect(
      applyCostWaveRule("100.00", { ruleType: "INCREASE_PERCENT", changeValue: "12.5" }),
    ).toEqual({ newCost: "112.50", skipReason: null });
    expect(
      applyCostWaveRule("80.00", { ruleType: "DECREASE_PERCENT", changeValue: "12.5" }),
    ).toEqual({ newCost: "70.00", skipReason: null });
  });

  it("يسقط الصف إذا ابتلع التقريب التغيير", () => {
    expect(
      applyCostWaveRule("100.00", { ruleType: "INCREASE_PERCENT", changeValue: "0.001" }),
    ).toEqual({ newCost: null, skipReason: "UNCHANGED" });
  });

  it("يثبت أن السياسة تتطلب اعتمادين مستقلين", () => {
    expect(COST_WAVE_REQUIRED_APPROVALS).toBe(2);
  });
});
