import { describe, expect, it } from "vitest";
import { redactSentryEvent } from "./sentry";

describe("Sentry server-event redaction", () => {
  it("removes hop secrets and credentials regardless of header casing", () => {
    const event = redactSentryEvent({
      request: {
        cookies: { session: "private" },
        data: { customerPhone: "private" },
        headers: {
          Cookie: "private",
          AUTHORIZATION: "private",
          "X-Internal-Proxy-Secret": "private",
          "x-INTERNAL-proxy-SECRET": "private-again",
          Accept: "application/json",
        },
      },
    });

    expect(event.request).not.toHaveProperty("cookies");
    expect(event.request).not.toHaveProperty("data");
    expect(event.request?.headers).toEqual({ Accept: "application/json" });
    expect(JSON.stringify(event)).not.toContain("private");
  });
});
