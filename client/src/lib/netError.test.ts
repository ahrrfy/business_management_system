/**
 * حارس قرار «احفظ محلياً» ⇄ «اعرض الرفض»: خطأ شبكيّ يُحفظ ويُعاد إرساله، ورفضٌ خادميّ
 * لا يُحفظ أبداً (وإلا أعدنا إرسال عدّة مرفوضة إلى الأبد). خطأ التمييز يعني إمّا ضياع عدّ
 * الجرد عند انقطاع الشبكة، أو طابوراً لا يفرغ.
 */
import { TRPCClientError } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import { isNetworkError } from "./netError";

/** node لا يعرّف navigator.onLine (المتصفّح يعرّفه) — نثبّته لكل حالة. */
function setOnLine(value: boolean) {
  Object.defineProperty(globalThis.navigator, "onLine", { value, configurable: true });
}

afterEach(() => setOnLine(true));

describe("isNetworkError", () => {
  it("يعتبر خطأ tRPC بلا data انقطاعاً (لم يصل الطلب للخادم)", () => {
    setOnLine(true);
    expect(isNetworkError(new TRPCClientError("Failed to fetch"))).toBe(true);
  });

  it("يعتبر خطأ tRPC الحامل data رفضاً خادمياً لا انقطاعاً", () => {
    setOnLine(true);
    const rejected = new TRPCClientError("أُقفل العدّ");
    Object.assign(rejected, { data: { code: "PRECONDITION_FAILED" } });
    expect(isNetworkError(rejected)).toBe(false);
  });

  it("يعتبر TypeError (فشل fetch الخام) انقطاعاً", () => {
    setOnLine(true);
    expect(isNetworkError(new TypeError("NetworkError when attempting to fetch"))).toBe(true);
  });

  it("لا يعتبر خطأً عادياً انقطاعاً", () => {
    setOnLine(true);
    expect(isNetworkError(new Error("boom"))).toBe(false);
    expect(isNetworkError("نصّ")).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });

  it("المتصفّح غير متصل ⇒ كل خطأ انقطاع (حتى لو حمل data)", () => {
    setOnLine(false);
    const rejected = new TRPCClientError("رفض");
    Object.assign(rejected, { data: { code: "BAD_REQUEST" } });
    expect(isNetworkError(rejected)).toBe(true);
    expect(isNetworkError(new Error("boom"))).toBe(true);
  });
});
