import { describe, expect, it } from "vitest";
import { dashboardActionBranchId } from "./dashboardActionScope";

describe("dashboard actionable scope", () => {
  it("uses the account branch so an actionable count opens the same branch queue", () => {
    expect(dashboardActionBranchId(7)).toBe(7);
    expect(dashboardActionBranchId("7")).toBe(7);
  });

  it("does not invent branch 1 when the account has no valid branch", () => {
    expect(dashboardActionBranchId(null)).toBeUndefined();
    expect(dashboardActionBranchId(undefined)).toBeUndefined();
    expect(dashboardActionBranchId(0)).toBeUndefined();
    expect(dashboardActionBranchId("not-a-branch")).toBeUndefined();
  });
});
