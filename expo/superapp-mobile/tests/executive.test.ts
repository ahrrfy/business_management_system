import { describe, expect, it } from "vitest";

import { visibleDecisions, type ExecutiveDecision } from "../lib/executive";

const decisions: ExecutiveDecision[] = Array.from({ length: 4 }, (_, index) => ({
  id: `decision-${index}`,
  severity: "info",
  title: `قرار ${index}`,
  context: "سياق مصدره الخادم",
  actionLabel: "عرض التفاصيل",
}));

describe("owner decision projection", () => {
  it("limits the compact view to three server decisions", () => {
    expect(visibleDecisions(decisions, false)).toHaveLength(3);
  });

  it("keeps all decisions when expanded", () => {
    expect(visibleDecisions(decisions, true)).toEqual(decisions);
  });
});
