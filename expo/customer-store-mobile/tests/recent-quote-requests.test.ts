import { describe, expect, it } from "vitest";

import {
  mergeRecentQuoteRequest,
  sanitizeRecentQuoteRequests,
} from "../lib/recent-quote-requests";

const valid = {
  requestNumber: "SRQ-100001",
  placedAt: "2026-09-10T12:00:00.000Z",
  guestTrackingToken: `${"a".repeat(32)}.t8l4ps.${"b".repeat(43)}`,
  guestTrackingExpiresAt: "2026-10-10T12:00:00.000Z",
};

describe("recent quote requests", () => {
  it("يحفظ فقط مراجع SRQ ورمز التتبع السليم في التخزين الآمن", () => {
    expect(sanitizeRecentQuoteRequests([
      valid,
      { ...valid, requestNumber: "ORD-100001" },
      { ...valid, requestNumber: "SRQ-100002", guestTrackingToken: "not-a-token" },
    ])).toEqual([valid]);
  });

  it("يستبدل المرجع المكرر بآخر حالة من دون تجاوز الحد", () => {
    const merged = mergeRecentQuoteRequest([valid], {
      ...valid,
      placedAt: "2026-09-11T12:00:00.000Z",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.placedAt).toBe("2026-09-11T12:00:00.000Z");
  });
});
