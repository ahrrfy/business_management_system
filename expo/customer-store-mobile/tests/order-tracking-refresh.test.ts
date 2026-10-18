import { afterEach, describe, expect, it, vi } from "vitest";
import {
  orderTrackingGuidance,
  orderTrackingRefreshInterval,
  orderTrackingUnavailable,
} from "@/lib/order-tracking-refresh";
import {
  secureTrackingRequest,
  trackStorefrontOrder,
} from "@/lib/storefront-api";

afterEach(() => vi.unstubAllGlobals());

describe("customer tracking refresh policy", () => {
  it("keeps incomplete delivered orders active and periodically rechecks completed and cancelled orders", () => {
    expect(
      orderTrackingRefreshInterval({
        status: "DELIVERED",
        deliveryProgress: { complete: false },
      }),
    ).toBe(30_000);
    expect(orderTrackingRefreshInterval({ status: "SHIPPED" })).toBe(30_000);
    expect(
      orderTrackingRefreshInterval({
        status: "DELIVERED",
        deliveryProgress: { complete: true },
      }),
    ).toBe(300_000);
    expect(orderTrackingRefreshInterval({ status: "CANCELLED" })).toBe(300_000);
  });

  it.each(["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"])(
    "clears an unavailable order for structured %s failures",
    (code) => {
      expect(
        orderTrackingUnavailable(
          Object.assign(new Error("generic response"), { code }),
        ),
      ).toBe(true);
    },
  );

  it("clears a missing response but retains last-known data during connectivity, server and rate failures", () => {
    expect(orderTrackingUnavailable(null)).toBe(true);
    for (const error of [
      new TypeError("Network request failed"),
      Object.assign(new Error("server"), {
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
      }),
      Object.assign(new Error("rate"), {
        code: "TOO_MANY_REQUESTS",
        httpStatus: 429,
      }),
      new Error("NOT_FOUND is only message text"),
    ]) {
      expect(orderTrackingUnavailable(error)).toBe(false);
    }
  });

  it("describes physical returns separately from cancelled orders", () => {
    const guidance = orderTrackingGuidance({
      status: "CANCELLED",
      deliveryProgress: { phase: "RETURNED" },
    });
    expect(guidance.description).toContain("أعيد الطلب إلى المكتبة");
    expect(guidance.step).toBe(-1);
    expect(guidance.delivered).toBe(false);
  });

  it("does not tell a waiting-reassignment customer that preparation restarted", () => {
    const guidance = orderTrackingGuidance({
      status: "PROCESSING",
      deliveryProgress: { phase: "AWAITING_REASSIGNMENT" },
    });
    expect(guidance.description).toContain("بانتظار إسناده");
    expect(guidance.description).not.toContain("يجري تجهيز");
    expect(guidance.step).toBe(-1);
  });

  it("never marks a declared return as completed delivery", () => {
    const guidance = orderTrackingGuidance({
      status: "DELIVERED",
      deliveryProgress: { phase: "RETURN_REQUESTED" },
    });
    expect(guidance.description).toContain("لم تكتمل إعادة الطلب");
    expect(guidance.delivered).toBe(false);
    expect(guidance.step).toBe(-1);
  });

  it("keeps normal delivery guidance when no exceptional phase exists", () => {
    expect(orderTrackingGuidance({ status: "DELIVERED" })).toMatchObject({
      step: 3,
      delivered: true,
    });
    expect(orderTrackingGuidance({ status: "UNKNOWN" })).toMatchObject({
      step: -1,
      delivered: false,
    });
  });

  it("classifies a missing local ownership proof without sending a request", () => {
    try {
      secureTrackingRequest({ orderNumber: "ORD-1" });
      throw new Error("expected ownership failure");
    } catch (error) {
      expect(orderTrackingUnavailable(error)).toBe(true);
    }
  });

  it("preserves the private error code without surfacing server payload or secret tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({
          error: {
            json: {
              message: "private details",
              data: { code: "NOT_FOUND", httpStatus: 404 },
            },
          },
        }),
      })),
    );
    const error = await trackStorefrontOrder({
      orderNumber: "ORD-1",
      guestTrackingToken: "secret-guest-token",
    }).catch((error) => error);
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
      message: "تعذر إرسال الطلب (404)",
    });
    expect(orderTrackingUnavailable(error)).toBe(true);
    expect(String(error)).not.toMatch(/private details|secret-guest-token/);
  });

  it("preserves structured ownership failure even in an HTTP 200 tRPC error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          error: { json: { data: { code: "UNAUTHORIZED" } } },
        }),
      })),
    );
    const error = await trackStorefrontOrder({
      orderNumber: "ORD-1",
      customerSessionToken: "secret-session-token",
    }).catch((error) => error);
    expect(error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "استجابة الطلب غير صالحة",
    });
    expect(orderTrackingUnavailable(error)).toBe(true);
  });

  it("retains transient HTTP failures when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error("HTML response");
        },
      })),
    );
    const error = await trackStorefrontOrder({
      orderNumber: "ORD-1",
      guestTrackingToken: "secret",
    }).catch((error) => error);
    expect(error).toMatchObject({
      httpStatus: 503,
      message: "تعذر إرسال الطلب (503)",
    });
    expect(orderTrackingUnavailable(error)).toBe(false);
  });
});
