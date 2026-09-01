import { describe, expect, it } from "vitest";
import { hasUncoveredGrniQuantity } from "../purchase/monthCloseBlockers";

describe("purchase GRNI partial coverage close blocker P0", () => {
  it("blocks partial posted-invoice coverage rather than accepting mere existence", () => {
    expect(hasUncoveredGrniQuantity(10, 0, 0, 1)).toBe(true);
    expect(hasUncoveredGrniQuantity(10, 2, 1, 7)).toBe(false);
    expect(hasUncoveredGrniQuantity(10, 2, 1, 6)).toBe(true);
  });
});
