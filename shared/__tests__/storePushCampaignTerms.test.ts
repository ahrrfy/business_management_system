import { expect, it } from "vitest";
import { STORE_PUSH_CAMPAIGN_STATUS_LABELS } from "../storePushCampaignTerms";
it("covers each persisted campaign lifecycle state with a distinct label", () => {
  expect(Object.keys(STORE_PUSH_CAMPAIGN_STATUS_LABELS).sort()).toEqual(["DRAFT", "APPROVED", "SCHEDULED", "RUNNING", "COMPLETED", "CANCELLED"].sort());
  expect(new Set(Object.values(STORE_PUSH_CAMPAIGN_STATUS_LABELS)).size).toBe(6);
});
