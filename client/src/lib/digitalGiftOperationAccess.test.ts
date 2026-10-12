import { describe, expect, it } from "vitest";
import type { OperationUser } from "@shared/operationPermissions";
import {
  digitalGiftCostVisible,
  digitalGiftOperationAllowed,
  digitalGiftQueryView,
} from "./digitalGiftOperationAccess";

const canonical = (
  role: string,
  grants: Record<string, boolean>,
  cost = false,
): OperationUser => ({
  role,
  roleOperationPolicy: {
    version: 1,
    grants,
    dataVisibility: { purchaseCost: cost, profitMargin: cost },
  },
});

describe("digital and gift UI operation choices", () => {
  it("enables a delegated approval independently of the role name", () => {
    const user = canonical("cashier", { "operation.gifts.approveGift": true });
    expect(digitalGiftOperationAllowed(user, "gifts.approveGift", false)).toBe(
      true,
    );
    expect(user.role).toBe("cashier");
  });
  it("does not infer rejection or execution from a request grant", () => {
    const user = canonical("manager", {
      "operation.digitalCards.reversal.requestLossRefund": true,
    });
    expect(
      digitalGiftOperationAllowed(
        user,
        "digitalCards.reversal.requestLossRefund",
      ),
    ).toBe(true);
    expect(
      digitalGiftOperationAllowed(user, "digitalCards.reversal.lossRefund"),
    ).toBe(false);
    expect(
      digitalGiftOperationAllowed(
        user,
        "digitalCards.reversal.rejectLossRefund",
      ),
    ).toBe(false);
  });
  it("honors an explicit user denial over a role approval", () => {
    const user: OperationUser = {
      role: "admin",
      roleOperationPolicy: {
        version: 1,
        grants: { "operation.gifts.approveGift": true },
      },
      operationPolicy: {
        version: 1,
        grants: { "operation.gifts.approveGift": false },
      },
    };
    expect(digitalGiftOperationAllowed(user, "gifts.approveGift", true)).toBe(
      false,
    );
  });
  it("requires the separate cost visibility choice for sensitive reads", () => {
    const user = canonical("admin", {
      "operation.digitalCards.pricing.getMorningSheet": true,
    });
    expect(
      digitalGiftOperationAllowed(user, "digitalCards.pricing.getMorningSheet"),
    ).toBe(false);
    expect(digitalGiftCostVisible(user, true)).toBe(false);
    expect(
      digitalGiftOperationAllowed(
        canonical("cashier", user.roleOperationPolicy!.grants, true),
        "digitalCards.pricing.getMorningSheet",
      ),
    ).toBe(true);
  });
  it("preserves legacy decisions and owner authority", () => {
    expect(
      digitalGiftOperationAllowed(
        { role: "manager" },
        "gifts.approveGift",
        true,
      ),
    ).toBe(true);
    expect(
      digitalGiftOperationAllowed(
        { role: "cashier" },
        "gifts.approveGift",
        false,
      ),
    ).toBe(false);
    expect(
      digitalGiftOperationAllowed(
        { role: "cashier", isOwner: true },
        "gifts.approveGift",
        false,
      ),
    ).toBe(true);
    expect(
      digitalGiftCostVisible({ role: "cashier", isOwner: true }, false),
    ).toBe(true);
  });
  it("fails closed while the account is loading and for unknown operations", () => {
    expect(digitalGiftOperationAllowed(undefined, "gifts.approveGift")).toBe(
      false,
    );
    expect(
      digitalGiftOperationAllowed(
        canonical("admin", {}),
        "digitalCards.fake.action",
      ),
    ).toBe(false);
  });
  it("hides cached query data after a permission revocation", () => {
    const cached = { data: { providerShare: "2500" }, isLoading: false };
    const denied = digitalGiftQueryView(
      canonical("admin", {}),
      "digitalCards.pricing.getMorningSheet",
      cached,
    );
    expect(denied.data).toBeUndefined();
    expect(denied.isLoading).toBe(false);
    expect(cached.data.providerShare).toBe("2500");
  });
});
