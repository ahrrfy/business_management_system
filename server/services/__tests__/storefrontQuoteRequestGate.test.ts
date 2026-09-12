import { describe, expect, it, vi } from "vitest";

import { createVerifiedStorefrontQuoteRequest } from "../storefrontQuoteRequestGate";

const input = {
  customerName: "شركة الرافدين",
  customerPhone: "07700000000",
  contactPreference: "WHATSAPP" as const,
  requestType: "BUSINESS" as const,
  note: "نحتاج تجهيز قرطاسية وطباعة لمكتب جديد.",
  clientRequestId: "sf-owned-quote-request",
  lines: [{ productUnitId: 1, quantity: 12 }],
};

const result = {
  requestId: 7,
  requestNumber: "SRQ-100007",
  guestTrackingToken: null,
  guestTrackingExpiresAt: null,
  idempotentReplay: true,
};

describe("verified storefront quote request sequencing", () => {
  it("returns an owned lost-response replay before consuming a fresh Turnstile token", async () => {
    const events: string[] = [];
    const verifyTurnstile = vi.fn(async () => {
      events.push("verify");
    });
    const createQuoteRequest = vi.fn(async () => {
      events.push("create");
      return result;
    });

    await expect(
      createVerifiedStorefrontQuoteRequest(input, "same-old-token", {
        findOwnedReplay: async () => {
          events.push("replay");
          return result;
        },
        verifyTurnstile,
        createQuoteRequest,
      }),
    ).resolves.toEqual(result);

    expect(events).toEqual(["replay"]);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(createQuoteRequest).not.toHaveBeenCalled();
  });

  it("verifies a new request before any quote or customer write", async () => {
    const events: string[] = [];
    await createVerifiedStorefrontQuoteRequest(input, "fresh-token", {
      findOwnedReplay: async () => {
        events.push("replay");
        return null;
      },
      verifyTurnstile: async () => {
        events.push("verify");
      },
      createQuoteRequest: async () => {
        events.push("create");
        return { ...result, idempotentReplay: false };
      },
    });
    expect(events).toEqual(["replay", "verify", "create"]);
  });

  it("fails closed without writing when verification rejects", async () => {
    const createQuoteRequest = vi.fn();
    await expect(
      createVerifiedStorefrontQuoteRequest(input, "bad-token", {
        findOwnedReplay: async () => null,
        verifyTurnstile: async () => {
          throw new Error("verification rejected");
        },
        createQuoteRequest,
      }),
    ).rejects.toThrow("verification rejected");
    expect(createQuoteRequest).not.toHaveBeenCalled();
  });
});
