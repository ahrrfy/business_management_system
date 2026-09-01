import { describe, expect, it } from "vitest";
import {
  LEAD_ALLOWED_TRANSITIONS,
  OPPORTUNITY_ALLOWED_TRANSITIONS,
  SALES_LEAD_STATUSES,
  SALES_OPPORTUNITY_STAGES,
  canTransitionLead,
  canTransitionOpportunity,
} from "./salesPipeline";

describe("sales pipeline state machines", () => {
  it("covers every lead and opportunity state exactly once", () => {
    expect(Object.keys(LEAD_ALLOWED_TRANSITIONS).sort()).toEqual(
      [...SALES_LEAD_STATUSES].sort(),
    );
    expect(Object.keys(OPPORTUNITY_ALLOWED_TRANSITIONS).sort()).toEqual(
      [...SALES_OPPORTUNITY_STAGES].sort(),
    );
  });

  it("keeps conversion atomic and terminal", () => {
    expect(canTransitionLead("QUALIFIED", "CONVERTED")).toBe(false);
    expect(LEAD_ALLOWED_TRANSITIONS.CONVERTED).toEqual([]);
  });

  it("requires negotiation before winning and keeps won terminal", () => {
    expect(canTransitionOpportunity("DISCOVERY", "WON")).toBe(false);
    expect(canTransitionOpportunity("NEGOTIATION", "WON")).toBe(true);
    expect(OPPORTUNITY_ALLOWED_TRANSITIONS.WON).toEqual([]);
  });

  it("allows an explicitly recorded reopening path", () => {
    expect(canTransitionLead("DISQUALIFIED", "CONTACTED")).toBe(true);
    expect(canTransitionOpportunity("LOST", "DISCOVERY")).toBe(true);
  });
});
