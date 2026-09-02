import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithStorefrontDeadline,
  shouldRetryStorefrontCreateOrder,
  STOREFRONT_CREATE_ORDER_DEADLINE_MS,
  STOREFRONT_READ_DEADLINE_MS,
  storefrontRequestDeadlineMs,
  storefrontProceduresFromRequest,
} from "./storefrontRequestPolicy";

afterEach(() => vi.useRealTimers());

describe("storefront request deadlines", () => {
  it("recognizes individual and batched storefront procedures", () => {
    expect(storefrontProceduresFromRequest("/api/trpc/storefront.catalog?batch=1")).toEqual([
      "storefront.catalog",
    ]);
    expect(
      storefrontProceduresFromRequest(
        "https://alarabiya.online/api/trpc/storefront.settings,storefront.createOrder?batch=1",
      ),
    ).toEqual(["storefront.settings", "storefront.createOrder"]);
  });

  it("uses the longer create-order deadline for a mixed batch", () => {
    expect(storefrontRequestDeadlineMs("/api/trpc/storefront.catalog")).toBe(
      STOREFRONT_READ_DEADLINE_MS,
    );
    expect(
      storefrontRequestDeadlineMs(
        "/api/trpc/storefront.settings,storefront.createOrder?batch=1",
      ),
    ).toBe(STOREFRONT_CREATE_ORDER_DEADLINE_MS);
    expect(storefrontRequestDeadlineMs("/api/trpc/sales.list")).toBeNull();
  });

  it("aborts a stalled storefront read with a stable timeout reason", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
    ) as typeof fetch;

    const request = fetchWithStorefrontDeadline(
      fetchImpl,
      "/api/trpc/storefront.catalog",
    );
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(STOREFRONT_READ_DEADLINE_MS);
    await rejection;
  });
});

describe("storefront create-order retry", () => {
  it("retries exactly once for transport, timeout, or server failures", () => {
    expect(
      shouldRetryStorefrontCreateOrder({
        path: "storefront.createOrder",
        attempts: 1,
      }),
    ).toBe(true);
    expect(
      shouldRetryStorefrontCreateOrder({
        path: "storefront.createOrder",
        attempts: 1,
        httpStatus: 503,
      }),
    ).toBe(true);
    expect(
      shouldRetryStorefrontCreateOrder({
        path: "storefront.createOrder",
        attempts: 2,
        httpStatus: 503,
      }),
    ).toBe(false);
  });

  it("does not retry validation, conflict, abuse, or unrelated operations", () => {
    for (const httpStatus of [400, 409, 422, 429]) {
      expect(
        shouldRetryStorefrontCreateOrder({
          path: "storefront.createOrder",
          attempts: 1,
          httpStatus,
        }),
      ).toBe(false);
    }
    expect(
      shouldRetryStorefrontCreateOrder({
        path: "storefront.quoteOrder",
        attempts: 1,
        httpStatus: 503,
      }),
    ).toBe(false);
  });
});
