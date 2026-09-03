import { describe, expect, it } from "vitest";
import { scrubClientSentryEvent } from "./sentry";

describe("client Sentry privacy", () => {
  it("removes request bodies, headers, cookies, query strings, and user identity", () => {
    const event = scrubClientSentryEvent({
      user: { id: "customer-1", ip_address: "127.0.0.1" },
      request: {
        url: "https://alarabiya.online/api/trpc/storefront.trackOrder?input=PHONE_TOKEN",
        cookies: { session: "secret" },
        data: { phone: "07700000000" },
        headers: { authorization: "Bearer secret" },
        query_string: "input=PHONE_TOKEN",
      },
    });

    expect(event.user).toBeUndefined();
    expect(event.request).toMatchObject({
      url: "https://alarabiya.online/api/trpc/storefront.trackOrder",
      cookies: undefined,
      data: undefined,
      headers: undefined,
      query_string: undefined,
    });
    expect(JSON.stringify(event)).not.toContain("07700000000");
    expect(JSON.stringify(event)).not.toContain("PHONE_TOKEN");
    expect(JSON.stringify(event)).not.toContain("Bearer secret");
  });

  it("keeps only method, status, and a query-free URL in network breadcrumbs", () => {
    const event = scrubClientSentryEvent({
      breadcrumbs: [
        {
          category: "fetch",
          data: {
            method: "GET",
            status_code: 404,
            url: "/api/trpc/storefront.trackOrder?input=PRIVATE",
            request_body_size: 123,
          },
        },
      ],
    });

    expect(event.breadcrumbs?.[0]?.data).toEqual({
      method: "GET",
      status_code: 404,
      url: "/api/trpc/storefront.trackOrder",
    });
  });

  it("redacts credentials and Iraqi phone numbers from error text", () => {
    const event = scrubClientSentryEvent({
      message: "request failed token=private-token phone=07701234567",
      exception: { values: [{ value: "Bearer abc.def? input=ORDER_SECRET" }] },
      breadcrumbs: [{ message: "https://example.test/?trackingToken=GUEST_SECRET" }],
    });

    const serialized = JSON.stringify(event);
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[redacted-phone]");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("07701234567");
    expect(serialized).not.toContain("abc.def");
    expect(serialized).not.toContain("GUEST_SECRET");
  });
});
