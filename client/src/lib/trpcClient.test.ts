import { afterEach, describe, expect, it, vi } from "vitest";
import { createErpTrpcClient } from "./trpcClient";

afterEach(() => vi.unstubAllGlobals());

describe("tRPC browser transport", () => {
  it("يرسل معاينة 115 بطاقة في جسم POST ولا يتجاوز حد سطر طلب Nginx", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if ((init?.method ?? "GET") === "GET" && url.length > 8_192) {
          throw new TypeError("Failed to fetch");
        }
        return new Response(
          JSON.stringify([{ result: { data: { json: [] } } }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = createErpTrpcClient();
    const lines = Array.from({ length: 115 }, (_, index) => ({
      offeringId: index + 1,
      providerShare: "435000.00",
      sellPrice: "450000.00",
    }));

    await expect(
      client.digitalCards.pricing.preview.query({
        branchId: 1,
        providerId: 1,
        lines,
      }),
    ).resolves.toEqual([]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.url.length).toBeLessThan(1_000);
    expect(String(requests[0]?.init?.body)).toContain('"offeringId":115');
  });
});
