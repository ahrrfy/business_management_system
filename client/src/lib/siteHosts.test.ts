// اختبارات سياسة الدومينَين — دوال نقيّة بلا window (العام: alarabiya.online، الشركة: srv…hstgr.cloud).
import { describe, expect, it } from "vitest";
import {
  INTERNAL_ORIGIN,
  PUBLIC_ORIGIN,
  careersUrl,
  isPublicPath,
  redirectTargetUrl,
  resolveHostRedirect,
  storefrontUrl,
} from "./siteHosts";

const PUB = "alarabiya.online";
const PUB_WWW = "www.alarabiya.online";
const INT = "srv1548487.hstgr.cloud";

describe("isPublicPath", () => {
  it("المتجر والوظائف ومسارتهما الفرعية عامة", () => {
    expect(isPublicPath("/store")).toBe(true);
    expect(isPublicPath("/store/abc")).toBe(true);
    expect(isPublicPath("/apply")).toBe(true);
  });
  it("كل ما عداها داخليّ — بما فيه المسارات المتشابهة بالاسم", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/store-admin")).toBe(false); // ليست بادئة مسار (لا شرطة مائلة)
    expect(isPublicPath("/pos")).toBe(false);
    expect(isPublicPath("/reports/anomaly-watch")).toBe(false);
    expect(isPublicPath("/login")).toBe(false);
    expect(isPublicPath("/kiosk")).toBe(false);
    expect(isPublicPath("/count/AB12")).toBe(false);
  });
});

describe("resolveHostRedirect", () => {
  it("مسار داخليّ على الدومين العام ⇒ يُحوَّل لدومين الشركة", () => {
    expect(resolveHostRedirect(PUB, "/pos")).toBe("internal");
    expect(resolveHostRedirect(PUB, "/store-admin")).toBe("internal");
    expect(resolveHostRedirect(PUB_WWW, "/reports")).toBe("internal");
  });
  it("مسارا تطبيق المناديب (TWA على الدومين العام) مشتركان — لا يُحوَّلان في أي اتجاه", () => {
    expect(resolveHostRedirect(PUB, "/login")).toBeNull();
    expect(resolveHostRedirect(PUB, "/my-deliveries")).toBeNull();
    expect(resolveHostRedirect(PUB_WWW, "/my-deliveries")).toBeNull();
    expect(resolveHostRedirect(INT, "/login")).toBeNull();
    expect(resolveHostRedirect(INT, "/my-deliveries")).toBeNull();
  });
  it("صفحة عامة على دومين الشركة ⇒ تُحوَّل للدومين العام", () => {
    expect(resolveHostRedirect(INT, "/apply")).toBe("public");
    expect(resolveHostRedirect(INT, "/store")).toBe("public");
  });
  it("الصفحة في مكانها الصحيح ⇒ بلا تحويل", () => {
    expect(resolveHostRedirect(PUB, "/store")).toBeNull();
    expect(resolveHostRedirect(PUB, "/apply")).toBeNull();
    expect(resolveHostRedirect(INT, "/pos")).toBeNull();
    expect(resolveHostRedirect(INT, "/reports")).toBeNull();
  });
  it("الجذر لا يُحوَّل أبداً (معناه يختلف بالمضيف)", () => {
    expect(resolveHostRedirect(PUB, "/")).toBeNull();
    expect(resolveHostRedirect(INT, "/")).toBeNull();
  });
  it("مضيف تطوير/غير معروف ⇒ لا سياسة إطلاقاً", () => {
    expect(resolveHostRedirect("localhost", "/pos")).toBeNull();
    expect(resolveHostRedirect("localhost", "/store")).toBeNull();
    expect(resolveHostRedirect("127.0.0.1", "/apply")).toBeNull();
  });
  it("لا حلقة تحويل: وجهةُ كلِّ تحويلٍ مستقرّةٌ على المضيف الهدف", () => {
    expect(resolveHostRedirect(PUB, "/pos")).toBe("internal");
    expect(resolveHostRedirect(INT, "/pos")).toBeNull(); // وصل ⇒ يستقرّ
    expect(resolveHostRedirect(INT, "/apply")).toBe("public");
    expect(resolveHostRedirect(PUB, "/apply")).toBeNull(); // وصل ⇒ يستقرّ
  });
});

describe("redirectTargetUrl", () => {
  it("يحفظ المسار والاستعلام والمرساة", () => {
    expect(
      redirectTargetUrl("internal", { pathname: "/store-admin", search: "?tab=settings", hash: "#x" }),
    ).toBe(`${INTERNAL_ORIGIN}/store-admin?tab=settings#x`);
    expect(redirectTargetUrl("public", { pathname: "/apply", search: "", hash: "" })).toBe(`${PUBLIC_ORIGIN}/apply`);
  });
});

describe("روابط الوجهة العامة", () => {
  it("من مضيف إنتاجي ⇒ الدومين العام مطلقاً (هو ما يُشارَك مع الزبائن)", () => {
    expect(storefrontUrl(INT)).toBe(`${PUBLIC_ORIGIN}/store`);
    expect(storefrontUrl(PUB)).toBe(`${PUBLIC_ORIGIN}/store`);
    expect(careersUrl(INT)).toBe(`${PUBLIC_ORIGIN}/apply`);
  });
  it("من مضيف تطوير ⇒ رابط نسبي يعمل محلياً", () => {
    expect(storefrontUrl("localhost")).toBe("/store");
    expect(careersUrl("localhost")).toBe("/apply");
  });
});
