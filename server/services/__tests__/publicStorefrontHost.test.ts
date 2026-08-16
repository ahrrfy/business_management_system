import { describe, expect, it, vi } from "vitest";
import { isPublicStorefrontHost, isPublicStorefrontProcedure, publicStorefrontHostBoundary } from "../../middleware/publicStorefrontHost";

describe("public storefront host boundary", () => {
  it("يسمح فقط بإجراءات المتجر والتوظيف العام والمندوب/الحساب الذاتي", () => {
    for (const procedure of ["storefront.catalog", "storefront.createOrder", "recruitment.submit", "recruitment.openVacancies", "auth.login", "auth.changePassword", "courier.myDeliveries", "push.subscribe"]) {
      expect(isPublicStorefrontProcedure(procedure)).toBe(true);
    }
  });

  it("يرفض كل إجراء داخلي واسم إجراء مركب أو دفعة مختلطة", () => {
    expect(isPublicStorefrontProcedure("inventory.list")).toBe(false);
    expect(isPublicStorefrontProcedure("storefront.catalog.extra")).toBe(false);
    expect(["storefront.catalog", "inventory.list"].every(isPublicStorefrontProcedure)).toBe(false);
  });

  it("يتعرف على نطاق المتجر فقط، بما فيه www", () => {
    expect(isPublicStorefrontHost("alarabiya.online")).toBe(true);
    expect(isPublicStorefrontHost("www.alarabiya.online:443")).toBe(true);
    expect(isPublicStorefrontHost("srv1548487.hstgr.cloud")).toBe(false);
  });

  it("يرد 404 لواجهة API الداخلية على المضيف العام ويترك المسار المسموح يمر", () => {
    const status = vi.fn().mockReturnThis();
    const end = vi.fn();
    const next = vi.fn();
    publicStorefrontHostBoundary(
      { hostname: "alarabiya.online", method: "GET", path: "/api/trpc/inventory.list" } as any,
      { status, end } as any,
      next,
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
    publicStorefrontHostBoundary(
      { hostname: "alarabiya.online", method: "GET", path: "/api/trpc/storefront.catalog" } as any,
      { status, end } as any,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
