import { afterEach, describe, expect, it, vi } from "vitest";
import { hasOverfilledPublicSensitiveBatch } from "../../../../server/middleware/publicSensitiveBatch";
import {
  createErpTrpcClient,
  isNonBatchedStorefrontProcedure,
} from "../trpcClient";

afterEach(() => vi.unstubAllGlobals());

const ALL_PUBLIC_SENSITIVE_STOREFRONT_PROCEDURES = [
  "storefront.createOrder",
  "storefront.createQuoteRequest",
  "storefront.quoteOrder",
  "storefront.quoteOrderPrivate",
  "storefront.trackBanner",
  "storefront.trackConversion",
  "storefront.trackOrder",
  "storefront.trackOrderPrivate",
  "storefront.trackOrderByToken",
  "storefront.trackQuoteRequestPrivate",
  "storefront.trackQuoteRequestByToken",
  "storefront.acceptQuoteRequestPrivate",
  "storefront.acceptQuoteRequestByToken",
  "storefront.requestFirstOrderCoupon",
  "storefront.cancelOrderPrivate",
  "storefront.cancelOrderByToken",
  "storefront.shelfLookup",
  "storefront.claimFirebaseCustomer",
  "storefront.submitPublicProductReview",
  "storefront.createWishlistShare",
  "storefront.createCartShare",
  "storefront.registerPushDevice",
  "storefront.deleteMe",
  "storefront.requestAccountDeletion",
  "storefront.uploadCustomizationAsset",
  "storefront.redeemLoyaltyPoints",
] as const;

describe("tRPC splitLink non-batched sensitive storefront transport", () => {
  it("marks every sensitive storefront procedure as non-batched while keeping read queries batched", () => {
    for (const proc of ALL_PUBLIC_SENSITIVE_STOREFRONT_PROCEDURES) {
      expect(isNonBatchedStorefrontProcedure(proc)).toBe(true);
      expect(
        hasOverfilledPublicSensitiveBatch(`/${proc},storefront.createOrder`),
      ).toBe(true);
    }
    expect(isNonBatchedStorefrontProcedure("storefront.settings")).toBe(false);
    expect(isNonBatchedStorefrontProcedure("storefront.catalog")).toBe(false);
    expect(isNonBatchedStorefrontProcedure("sales.list")).toBe(false);
  });

  it("sends concurrent uploadCustomizationAsset, requestAccountDeletion, and createQuoteRequest over isolated httpLink calls while batching public reads", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        const parsed = new URL(url, "https://alarabiya.online");
        const isBatch = parsed.searchParams.get("batch") === "1";

        if (isBatch) {
          const count = parsed.pathname
            .replace(/^\/api\/trpc\//, "")
            .split(",").length;
          return new Response(
            JSON.stringify(
              Array.from({ length: count }, () => ({
                result: { data: { json: { ok: true } } },
              })),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            result: {
              data: {
                json: {
                  ok: true,
                  assetKey: "2026/10/test-logo.png",
                  requestNumber: "ADR-100001",
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const client = createErpTrpcClient();

    await Promise.all([
      client.storefront.uploadCustomizationAsset.mutate({
        kind: "LOGO",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }),
      client.storefront.requestAccountDeletion.mutate({
        phone: "07701234567",
        reason: "اختبار",
      }),
      client.storefront.createQuoteRequest.mutate({
        customerName: "شركة الرؤية",
        customerPhone: "07701234567",
        contactPreference: "WHATSAPP",
        requestType: "BUSINESS",
        note: "طلب تسعير دفاتر مطبوعة",
        clientRequestId: "qr-test-12345678",
        turnstileToken: "ts-token",
        lines: [{ productUnitId: 10, quantity: 50 }],
      }),
      client.storefront.redeemLoyaltyPoints.mutate({
        customerSessionToken: "s".repeat(48),
        points: 100,
        clientRequestId: "redeem-test-12345678",
      }),
      client.storefront.settings.query(),
      client.storefront.categories.query(),
    ]);

    const urls = requests.map((r) => r.url);
    expect(urls).toContain("/api/trpc/storefront.uploadCustomizationAsset");
    expect(urls).toContain("/api/trpc/storefront.requestAccountDeletion");
    expect(urls).toContain("/api/trpc/storefront.createQuoteRequest");
    expect(urls).toContain("/api/trpc/storefront.redeemLoyaltyPoints");

    const batchedRead = urls.find((u) => u.includes("batch=1"));
    expect(batchedRead).toBe(
      "/api/trpc/storefront.settings,storefront.categories?batch=1",
    );

    for (const req of requests) {
      expect(req.init?.method).toBe("POST");
      expect(req.init?.credentials).toBe("include");
      const trpcSubPath = new URL(
        req.url,
        "https://alarabiya.online",
      ).pathname.replace(/^\/api\/trpc/, "");
      expect(hasOverfilledPublicSensitiveBatch(trpcSubPath)).toBe(false);
    }
  });
});
