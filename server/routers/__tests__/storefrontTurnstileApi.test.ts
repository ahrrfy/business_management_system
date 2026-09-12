import { describe, expect, it } from "vitest";
import { appRouter } from "../../routers";

const caller = appRouter.createCaller({
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

const validQuoteRequest = {
  customerName: "شركة الرافدين",
  customerPhone: "07700000000",
  contactPreference: "WHATSAPP" as const,
  requestType: "BUSINESS" as const,
  note: "نحتاج تجهيز قرطاسية وطباعة لمكتب جديد.",
  clientRequestId: "sf-quote-request-123",
  lines: [{ productUnitId: 1, quantity: 12 }],
};

describe("storefront Turnstile API boundary", () => {
  it("requires a Turnstile token for every new createOrder call", async () => {
    await expect(caller.storefront.createOrder(validOrder as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects tokens over 2048 characters before service or network work", async () => {
    await expect(caller.storefront.createOrder({
      ...validOrder,
      turnstileToken: "x".repeat(2049),
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires the same Turnstile boundary for every new createQuoteRequest call", async () => {
    await expect(caller.storefront.createQuoteRequest(validQuoteRequest as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.storefront.createQuoteRequest({
      ...validQuoteRequest,
      turnstileToken: "x".repeat(2049),
    } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
