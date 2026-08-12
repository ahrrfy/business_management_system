import { describe, expect, it } from "vitest";
import { isLoopbackHost, resolveListenHost } from "./listenHost";

describe("resolveListenHost", () => {
  it("يفشل مغلقاً في الإنتاج عند غياب HOST", () => {
    expect(() => resolveListenHost({ nodeEnv: "production", host: undefined, allowPublicBind: undefined }))
      .toThrow(/HOST/);
  });

  it("يقبل عنوان IPv4 المطابق لـ upstream المرفق", () => {
    expect(resolveListenHost({ nodeEnv: "production", host: "127.0.0.1", allowPublicBind: undefined })).toBe("127.0.0.1");
  });

  it.each(["::1", "localhost"])("يرفض loopback غير المطابق لـ upstream بلا opt-in: %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
    expect(() => resolveListenHost({ nodeEnv: "production", host, allowPublicBind: undefined }))
      .toThrow(/ALLOW_PUBLIC_BIND/);
  });

  it("يرفض الربط العام ما لم يوجد opt-in صريح", () => {
    expect(() => resolveListenHost({ nodeEnv: "production", host: "0.0.0.0", allowPublicBind: undefined }))
      .toThrow(/ALLOW_PUBLIC_BIND/);
    expect(resolveListenHost({ nodeEnv: "production", host: "0.0.0.0", allowPublicBind: "1" }))
      .toBe("0.0.0.0");
  });

  it("يحافظ على مرونة التطوير", () => {
    expect(resolveListenHost({ nodeEnv: "development", host: undefined, allowPublicBind: undefined })).toBeUndefined();
    expect(resolveListenHost({ nodeEnv: "test", host: "0.0.0.0", allowPublicBind: undefined })).toBe("0.0.0.0");
  });
});
