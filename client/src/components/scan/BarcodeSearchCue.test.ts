import { describe, expect, it } from "vitest";
import {
  barcodeSearchCueClass,
  barcodeSearchInputClass,
  barcodeSearchVisualClass,
} from "./BarcodeSearchCue";

describe("BarcodeSearchCue", () => {
  it("يثبت الشارة يمين الحقل ويحجز لها حشواً لا تلغيه فئات px", () => {
    expect(barcodeSearchCueClass).toContain("right-2");
    expect(barcodeSearchCueClass).not.toContain("start-2");
    expect(barcodeSearchInputClass).toContain("pr-[5.75rem]!");
    expect(barcodeSearchInputClass).toContain(barcodeSearchVisualClass);
  });
});
