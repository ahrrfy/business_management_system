// اختبارات سياسة الدومينَين — دوال نقيّة بلا window (العام: alarabiya.online، الشركة: srv…hstgr.cloud).
import { describe, expect, it } from "vitest";
import {
  INTERNAL_ORIGIN,
  PUBLIC_ORIGIN,
  careersUrl,
  internalUrl,
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
  it("مسارات تطبيق المناديب (TWA على الدومين العام) مشتركة — لا تُحوَّل في أي اتجاه", () => {
    expect(resolveHostRedirect(PUB, "/login")).toBeNull();
    expect(resolveHostRedirect(PUB, "/my-deliveries")).toBeNull();
    expect(resolveHostRedirect(PUB_WWW, "/my-deliveries")).toBeNull();
    // «حسابي» مشترك: أول دخولٍ لأي مستخدم جديد يقوده إلى /account?mustChange=1 — تحويله
    // كان يقذف المندوب لمضيفٍ بلا جلسة (الكوكي مقصور بالمضيف) فينتهي بنموذج دخول فارغ.
    expect(resolveHostRedirect(PUB, "/account")).toBeNull();
    expect(resolveHostRedirect(INT, "/login")).toBeNull();
    expect(resolveHostRedirect(INT, "/my-deliveries")).toBeNull();
    expect(resolveHostRedirect(INT, "/account")).toBeNull();
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

describe("حارس سوء الضبط", () => {
  it("لا شرطة مائلة مزدوجة في وجهة التحويل (الأصل يُقلَّم)", () => {
    expect(redirectTargetUrl("internal", { pathname: "/pos", search: "", hash: "" })).not.toContain("//pos");
    expect(PUBLIC_ORIGIN.endsWith("/")).toBe(false);
    expect(INTERNAL_ORIGIN.endsWith("/")).toBe(false);
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

describe("الروابط المُشارَكة — لا تتبع المضيف الذي يتصفّحه الموظف", () => {
  it("الروابط العامة (متجر/وظائف) ⇒ الدومين العام مطلقاً، حتى وأنت داخل نظام الشركة", () => {
    // العلّة التي أمسكها المالك: «نسخ رابط التقديم» كان ينسخ srv…/apply لأنه بُني من المضيف الحالي.
    expect(careersUrl(INT)).toBe(`${PUBLIC_ORIGIN}/apply`);
    expect(careersUrl(PUB)).toBe(`${PUBLIC_ORIGIN}/apply`);
    expect(storefrontUrl(INT)).toBe(`${PUBLIC_ORIGIN}/store`);
    expect(storefrontUrl(PUB)).toBe(`${PUBLIC_ORIGIN}/store`);
  });
  it("الروابط الداخلية (بوّابة العدّ/الكشك) ⇒ دومين الشركة مطلقاً، حتى وأنت على الدومين العام", () => {
    expect(internalUrl("/count/AB12", PUB)).toBe(`${INTERNAL_ORIGIN}/count/AB12`);
    expect(internalUrl("/count/AB12", INT)).toBe(`${INTERNAL_ORIGIN}/count/AB12`);
    expect(internalUrl("", INT)).toBe(INTERNAL_ORIGIN);
  });
  it("على مضيف تطوير ⇒ الأصل الحالي (لا يُسرَّب دومين إنتاجي في التطوير)", () => {
    // window غير معرَّف في بيئة الاختبار ⇒ الأصل فارغ والمسار نسبيّ (يعمل محلياً).
    expect(storefrontUrl("localhost")).toBe("/store");
    expect(careersUrl("localhost")).toBe("/apply");
    expect(internalUrl("/count/AB12", "localhost")).toBe("/count/AB12");
  });
});
