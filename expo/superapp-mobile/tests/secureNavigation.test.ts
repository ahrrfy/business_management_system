import { describe, expect, it } from "vitest";

import {
  isClosedSuperAppNotificationDestination,
  routeForSuperAppNotification,
} from "../lib/secureNavigation";

describe("closed Super Arabia notification navigation", () => {
  it("maps only the reviewed internal destinations", () => {
    expect(routeForSuperAppNotification({ version: "1", destination: "center" })).toBe("/(tabs)");
    expect(routeForSuperAppNotification({ version: "1", destination: "my-day" })).toBe("/(tabs)/my-day");
    expect(routeForSuperAppNotification({ version: "1", destination: "account" })).toBe("/(tabs)/account");
  });

  it("rejects URLs, record IDs, query data, and unknown destinations", () => {
    for (const value of [
      { version: "1", destination: "https://example.test" },
      { version: "1", destination: "my-day", taskId: 9 },
      { version: "1", destination: "my-day?taskId=9" },
      { version: "2", destination: "my-day" },
      null,
    ]) {
      expect(isClosedSuperAppNotificationDestination(value)).toBe(false);
    }
  });
});
