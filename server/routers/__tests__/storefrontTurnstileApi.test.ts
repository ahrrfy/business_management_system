import { describe, expect, it } from "vitest";
import { storefrontRouter } from "../storefrontRouter";

const caller = storefrontRouter.createCaller({
  req: { headers: {} },
  res: {},
  user: null,
  sessionId: null,
} as never);

const validOrder = {
  customerName: "زبون",
  customerPhone: "07700000000",
  governorate: "baghdad",
  addressText: "بغداد",
  lines: [{ productUnitId: 1, quantity: 1, expectedUnitPrice: "1000.00" }],
  expectedGrandTotal: "1000.00",
  clientRequestId: "sf-request-123",
};

describe("storefront Turnstile API boundary", () => {
  it("requires a Turnstile token for every new createOrder call", async () => {
    await expect(caller.createOrder(validOrder as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects tokens over 2048 characters before service or network work", async () => {
    await expect(caller.createOrder({
      ...validOrder,
      turnstileToken: "x".repeat(2049),
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
