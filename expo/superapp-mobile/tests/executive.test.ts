import { describe, expect, it } from "vitest";

import { ownerDecisionCenterPreview, visibleDecisions } from "../lib/executive";

describe("owner decision preview", () => {
  it("limits the initial queue to three decisions", () => {
    expect(visibleDecisions(ownerDecisionCenterPreview.decisions, false)).toHaveLength(3);
  });

  it("does not make an expanded queue shorter", () => {
    expect(visibleDecisions(ownerDecisionCenterPreview.decisions, true)).toEqual(ownerDecisionCenterPreview.decisions);
  });
});
