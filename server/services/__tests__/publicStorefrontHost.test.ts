import { describe, expect, it, vi } from "vitest";
import { isAllowedOnPublicStorefrontHost, isPublicStorefrontHost, isPublicStorefrontProcedure, publicStorefrontHostBoundary } from "../../middleware/publicStorefrontHost";

describe("public storefront host boundary", () => {
  it("يسمح فقط بإجراءات المتجر والتوظيف العام والدخول/الحساب الذاتي", () => {
    for (const procedure of ["storefront.catalog", "storefront.createOrder", "recruitment.submit", "recruitment.openVacancies", "auth.login", "auth.changePassword"]) {
      expect(isPublicStorefrontProcedure(procedure)).toBe(true);
    }
  });

  it("لا يفتح إجراءات المندوب (courier.*) ولا إشعارات الموظفين (push.*) على الدومين العام", () => {
    // تطبيق المناديب (TWA) حُذف؛ وتأكّد المالك أن لا جهاز ميداني يستعمله عبر alarabiya.online.
    // push.* يستعمله ERP الداخلي وحده؛ إشعارات العملاء عبر storefront.registerPushDevice.
    for (const procedure of ["courier.myDeliveries", "courier.confirmDelivery", "push.subscribe", "push.publicKey", "push.myStatus", "push.unsubscribe"]) {
      expect(isPublicStorefrontProcedure(procedure), procedure).toBe(false);
    }
    // ولا تُهرَّب داخل دفعة مع إجراء متجر مسموح.
    expect(["storefront.catalog", "courier.myDeliveries"].every(isPublicStorefrontProcedure)).toBe(false);
    expect(isAllowedOnPublicStorefrontHost("POST", "/api/trpc/courier.myDeliveries")).toBe(false);
    expect(isAllowedOnPublicStorefrontHost("POST", "/api/trpc/storefront.catalog,push.subscribe")).toBe(false);
    expect(isAllowedOnPublicStorefrontHost("POST", "/api/trpc/storefront.catalog,storefront.settings")).toBe(true);
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

  it("يرفض مسار tRPC المرمّز قبل أن يفكّه المهايئ إلى دفعة", () => {
    const status = vi.fn().mockReturnThis();
    const end = vi.fn();
    const next = vi.fn();
    publicStorefrontHostBoundary(
      {
        hostname: "alarabiya.online",
        method: "POST",
        path: "/api/trpc/storefront.createOrder%2Cstorefront%2EcreateOrder",
      } as any,
      { status, end } as any,
      next,
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("يرفض API مختلط الحالة على المضيف العام قبل وصوله إلى راوتر داخلي", () => {
    for (const path of ["/API/TRPC/inventory.list", "/Api/Trpc/storefront.catalog"]) {
      const status = vi.fn().mockReturnThis();
      const end = vi.fn();
      const next = vi.fn();
      publicStorefrontHostBoundary(
        { hostname: "alarabiya.online", method: "GET", path } as any,
        { status, end } as any,
        next,
      );
      expect(status).toHaveBeenCalledWith(404);
      expect(end).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
    }
  });
});
