import { describe, expect, it } from "vitest";
import { fulfillmentRequestsRouter } from "../../routers/fulfillmentRequestsRouter";

describe("fulfillment credit choice wire contract", () => {
  it.each([true, false])("retains the explicit %s choice on the actual release parser", (collectCreditOnDelivery) => {
    // Exercise the real tRPC input parser: service-only tests cannot detect Zod stripping.
    const parser = fulfillmentRequestsRouter._def.procedures.release._def.inputs[0] as {
      parse(input: unknown): unknown;
    };
    expect(parser.parse({ id: 1, expectedVersion: 1, assignedUserId: 3,
      clientRequestId: "credit-release-wire-contract", collectCreditOnDelivery,
    })).toMatchObject({ collectCreditOnDelivery });
  });
});
