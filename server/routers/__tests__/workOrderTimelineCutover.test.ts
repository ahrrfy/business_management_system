import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router = readFileSync(new URL("../workOrderRouter.ts", import.meta.url), "utf8");
const detail = readFileSync(
  new URL("../../../client/src/pages/WorkOrderDetail.tsx", import.meta.url),
  "utf8",
);
const reverseDialog = readFileSync(
  new URL("../../../client/src/components/workorder/ReverseDeliveryRequestDialog.tsx", import.meta.url),
  "utf8",
);
const orphanBaseline = readFileSync(
  new URL("../../../scripts/orphan-endpoints-baseline.json", import.meta.url),
  "utf8",
);

describe("work-order event timeline contract", () => {
  it("يبقي القارئ المنمّط ومستهلكيه خارج خط أساس الأيتام", () => {
    expect(router).toContain("eventTimeline:");
    expect(orphanBaseline).not.toContain("workOrders.eventTimeline");
    expect(detail).toContain("workOrders.eventTimeline.invalidate");
    expect(reverseDialog).toContain("workOrders.eventTimeline.invalidate");
  });
});
