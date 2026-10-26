import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithStorefrontDeadline,
  STOREFRONT_CREATE_ORDER_DEADLINE_MS,
  STOREFRONT_READ_DEADLINE_MS,
  storefrontRequestDeadlineMs,
} from "../storefrontRequestPolicy";

afterEach(() => vi.useRealTimers());

describe("storefront heavy write deadlines", () => {
  it("grants 30_000 ms to uploadCustomizationAsset and createQuoteRequest", () => {
    expect(STOREFRONT_CREATE_ORDER_DEADLINE_MS).toBe(30_000);
    expect(
      storefrontRequestDeadlineMs(
        "/api/trpc/storefront.uploadCustomizationAsset",
      ),
    ).toBe(STOREFRONT_CREATE_ORDER_DEADLINE_MS);
    expect(
      storefrontRequestDeadlineMs("/api/trpc/storefront.createQuoteRequest"),
    ).toBe(STOREFRONT_CREATE_ORDER_DEADLINE_MS);
    expect(
      storefrontRequestDeadlineMs(
        "/api/trpc/storefront.requestAccountDeletion",
      ),
    ).toBe(STOREFRONT_READ_DEADLINE_MS);
  });

  it("keeps uploadCustomizationAsset alive past 12s and aborts at 30s", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    ) as typeof fetch;

    const outcome = fetchWithStorefrontDeadline(
      fetchImpl,
      "/api/trpc/storefront.uploadCustomizationAsset",
    ).then(
      () => null,
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(STOREFRONT_READ_DEADLINE_MS + 1_000);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(
      STOREFRONT_CREATE_ORDER_DEADLINE_MS - STOREFRONT_READ_DEADLINE_MS,
    );
    const err = await outcome;
    expect(aborted).toBe(true);
    expect(err).toMatchObject({ name: "TimeoutError" });
  });
});
