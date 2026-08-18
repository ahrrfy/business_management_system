import { describe, expect, it, vi } from "vitest";
import { createVerifiedStorefrontOrder } from "../storefrontOrderGate";

const input = {
  customerName: "زبون",
  customerPhone: "07700000000",
  governorate: "baghdad",
  addressText: "بغداد",
  clientRequestId: "sf-owned-request",
  lines: [{ productUnitId: 1, quantity: 1, expectedUnitPrice: "1000.00" }],
  expectedGrandTotal: "1000.00",
};

const result = {
  orderId: 7,
  orderNumber: "ORD-100007",
  reservationExpiresAt: new Date("2026-08-20T00:00:00.000Z"),
  branchId: 1,
  subtotal: "1000.00",
  deliveryFee: "0.00",
  total: "1000.00",
  itemCount: 1,
  idempotentReplay: true,
};

describe("verified storefront order sequencing", () => {
  it("returns an owned lost-response replay before consuming a fresh Turnstile token", async () => {
    const events: string[] = [];
    const findOwnedReplay = vi.fn(async () => {
      events.push("replay");
      return result;
    });
    const verifyTurnstile = vi.fn(async () => { events.push("verify"); });
    const createOrder = vi.fn(async () => { events.push("create"); return result; });

    await expect(createVerifiedStorefrontOrder(input, "same-old-token", {
      findOwnedReplay,
      verifyTurnstile,
      createOrder,
    })).resolves.toEqual(result);

    expect(events).toEqual(["replay"]);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("verifies a new request before any order write", async () => {
    const events: string[] = [];
    const findOwnedReplay = vi.fn(async () => { events.push("replay"); return null; });
    const verifyTurnstile = vi.fn(async () => { events.push("verify"); });
    const createOrder = vi.fn(async () => { events.push("create"); return { ...result, idempotentReplay: undefined }; });

    await createVerifiedStorefrontOrder(input, "fresh-token", {
      findOwnedReplay,
      verifyTurnstile,
      createOrder,
    });

    expect(events).toEqual(["replay", "verify", "create"]);
    expect(verifyTurnstile).toHaveBeenCalledWith("fresh-token");
  });

  it("fails closed without writing when verification rejects", async () => {
    const createOrder = vi.fn();
    await expect(createVerifiedStorefrontOrder(input, "bad-token", {
      findOwnedReplay: async () => null,
      verifyTurnstile: async () => { throw new Error("verification rejected"); },
      createOrder,
    })).rejects.toThrow("verification rejected");
    expect(createOrder).not.toHaveBeenCalled();
  });
});
