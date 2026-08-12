import { describe, expect, it } from "vitest";
import {
  authorizeDeviceIdentity,
  bridgeNetworkPolicyFailure,
  constantTimeSecretEquals,
  enabledDeviceIdentityFailure,
  isStrongBridgeSecret,
  isRemoteAllowed,
  normalizeRemoteAddress,
  PerIpRateLimiter,
  productionSecurityFailure,
  resolveBridgeSecurityConfig,
} from "../bridgeSecurity";

describe("حماية جسر أجهزة الحضور", () => {
  it("يطبع عنوان IPv4 المغلف داخل IPv6", () => {
    expect(normalizeRemoteAddress("::ffff:192.168.10.7")).toBe("192.168.10.7");
  });

  it("يفرض عنواناً أو شبكة IPv4 من القائمة البيضاء", () => {
    const allowlist = ["192.168.10.0/24", "10.2.3.4", "2001:db8::/32", "::1"];
    expect(isRemoteAllowed("::ffff:192.168.10.44", allowlist)).toBe(true);
    expect(isRemoteAllowed("10.2.3.4", allowlist)).toBe(true);
    expect(isRemoteAllowed("::1", allowlist)).toBe(true);
    expect(isRemoteAllowed("2001:db8::44", allowlist)).toBe(true);
    expect(isRemoteAllowed("192.168.11.44", allowlist)).toBe(false);
  });

  it("يقارن سر البوابة بقيمة ثابتة الزمن ويقبل غيابه للتوافق", () => {
    expect(constantTimeSecretEquals("correct", "correct")).toBe(true);
    expect(constantTimeSecretEquals("wrong", "correct")).toBe(false);
    expect(constantTimeSecretEquals("", "")).toBe(true);
  });

  it("يحد الطلبات لكل عنوان داخل النافذة", () => {
    const limiter = new PerIpRateLimiter(2, 1_000);
    expect(limiter.allow("10.0.0.1", 0)).toBe(true);
    expect(limiter.allow("10.0.0.1", 1)).toBe(true);
    expect(limiter.allow("10.0.0.1", 2)).toBe(false);
    expect(limiter.allow("10.0.0.2", 2)).toBe(true);
    expect(limiter.allow("10.0.0.1", 1_001)).toBe(true);
  });

  it("يضبط القيم الشاذة إلى حدود آمنة", () => {
    const config = resolveBridgeSecurityConfig({
      HR_DEVICE_HOST: "192.168.10.5",
      HR_DEVICE_IP_ALLOWLIST: "192.168.10.0/24, 127.0.0.1",
      HR_DEVICE_MAX_WS_PER_IP: "0",
      HR_DEVICE_RATE_LIMIT_PER_MINUTE: "not-a-number",
    });
    expect(config.host).toBe("192.168.10.5");
    expect(config.allowlist).toEqual(["192.168.10.0/24", "127.0.0.1"]);
    expect(config.maxWsConnectionsPerIp).toBe(4);
    expect(config.maxRequestsPerMinute).toBe(240);
  });

  it("يرفض الإنتاج بلا allowlist أو سر قوي ويقبل أحدهما", () => {
    const open = resolveBridgeSecurityConfig({});
    expect(productionSecurityFailure(open, { NODE_ENV: "production" })).toContain("رفض تشغيل");

    const weak = resolveBridgeSecurityConfig({ HR_DEVICE_SHARED_SECRET: "too-short" });
    expect(productionSecurityFailure(weak, { NODE_ENV: "production" })).toContain("32 بايت");

    const allowlisted = resolveBridgeSecurityConfig({ HR_DEVICE_IP_ALLOWLIST: "203.0.113.7" });
    expect(productionSecurityFailure(allowlisted, { NODE_ENV: "production" })).toBeNull();

    const secret = resolveBridgeSecurityConfig({
      HR_DEVICE_SHARED_SECRET: "df49baf8c17a49ec8ad4a67e62ed4079c8c72bc04b6b39b0d9f1ee623d632eaf",
    });
    expect(productionSecurityFailure(secret, { NODE_ENV: "production" })).toBeNull();
    expect(productionSecurityFailure(open, { NODE_ENV: "development" })).toBeNull();
  });

  it("يرفض الشبكات الشاملة والقيم غير الصالحة حتى مع وجود عامل آخر صالح", () => {
    expect(bridgeNetworkPolicyFailure(["0.0.0.0/0"])).toContain("0.0.0.0/0");
    expect(bridgeNetworkPolicyFailure(["::/0"])).toContain("::/0");
    expect(bridgeNetworkPolicyFailure(["192.168.10.0/24", "0.0.0.0/0"])).toContain("0.0.0.0/0");
    expect(bridgeNetworkPolicyFailure(["192.168.10.0/99"])).toContain("غير صالح");

    const broad = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "0.0.0.0/0",
      HR_DEVICE_SHARED_SECRET: "df49baf8c17a49ec8ad4a67e62ed4079c8c72bc04b6b39b0d9f1ee623d632eaf",
    });
    expect(productionSecurityFailure(broad, { NODE_ENV: "production" })).toContain("0.0.0.0/0");
  });

  it("يرفض الأسرار الدورية والافتراضية ويقبل مفتاحاً عشوائياً", () => {
    expect(isStrongBridgeSecret("x".repeat(32))).toBe(false);
    expect(isStrongBridgeSecret("abcd".repeat(8))).toBe(false);
    expect(isStrongBridgeSecret(`${"x".repeat(31)}y`)).toBe(false);
    expect(isStrongBridgeSecret("change-me-test-secret-value-1234567890")).toBe(false);
    expect(isStrongBridgeSecret("df49baf8c17a49ec8ad4a67e62ed4079c8c72bc04b6b39b0d9f1ee623d632eaf")).toBe(true);

    const repeated = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "192.168.10.0/24",
      HR_DEVICE_SHARED_SECRET: "abcd".repeat(8),
    });
    expect(productionSecurityFailure(repeated, { NODE_ENV: "production" })).toContain("عشوائياً");
  });

  it("يربط كل SN بعنوانه ومفتاحه ولا يسمح لعميل البوابة بانتحال جهاز آخر", () => {
    const config = resolveBridgeSecurityConfig({
      HR_DEVICE_IDENTITY_BINDINGS: JSON.stringify({
        "SN-100": {
          allowlist: ["192.168.20.10"],
          sharedSecret: "a23f0e9bd7c34491b8176ea706f12c44cbe18bc7fd63a9001b09ad2ac3a8fe71",
        },
      }),
    });
    const device = { serialNumber: "SN-100", ip: null };
    expect(
      authorizeDeviceIdentity(device, "SN-100", {
        remoteAddress: "192.168.20.10",
        credential: "a23f0e9bd7c34491b8176ea706f12c44cbe18bc7fd63a9001b09ad2ac3a8fe71",
      }, config),
    ).toEqual({ authorized: true, decision: "BOUND" });
    expect(
      authorizeDeviceIdentity(device, "SN-100", {
        remoteAddress: "192.168.20.11",
        credential: "a23f0e9bd7c34491b8176ea706f12c44cbe18bc7fd63a9001b09ad2ac3a8fe71",
      }, config).decision,
    ).toBe("IP_MISMATCH");
    expect(
      authorizeDeviceIdentity(device, "SN-100", {
        remoteAddress: "192.168.20.10",
        credential: "wrong",
      }, config).decision,
    ).toBe("CREDENTIAL_MISMATCH");
    expect(
      authorizeDeviceIdentity(device, "SN-OTHER", {
        remoteAddress: "192.168.20.10",
        credential: "a23f0e9bd7c34491b8176ea706f12c44cbe18bc7fd63a9001b09ad2ac3a8fe71",
      }, config).decision,
    ).toBe("SERIAL_MISMATCH");
  });

  it("يرفض الجهاز القديم غير المربوط إلا بعلم هجرة صريح", () => {
    const strict = resolveBridgeSecurityConfig({});
    const device = { serialNumber: "LEGACY-1", ip: null };
    expect(authorizeDeviceIdentity(device, "LEGACY-1", { remoteAddress: "10.0.0.5", credential: "" }, strict))
      .toEqual({ authorized: false, decision: "UNBOUND" });

    const migration = resolveBridgeSecurityConfig({ HR_DEVICE_LEGACY_IDENTITY_MIGRATION: "1" });
    expect(authorizeDeviceIdentity(device, "LEGACY-1", { remoteAddress: "10.0.0.5", credential: "" }, migration))
      .toEqual({ authorized: true, decision: "LEGACY_MIGRATION" });
    const productionMigration = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "10.0.0.0/24",
      HR_DEVICE_LEGACY_IDENTITY_MIGRATION: "1",
    });
    expect(productionSecurityFailure(productionMigration, { NODE_ENV: "production" })).toContain("يساوي 0");
  });

  it("يجعل الربط الصريح أضيق من IP قاعدة البيانات ولا يدمجه معه بمنطق OR", () => {
    const config = resolveBridgeSecurityConfig({
      HR_DEVICE_IDENTITY_BINDINGS: JSON.stringify({
        "SN-STRICT": { allowlist: ["192.168.20.10"] },
      }),
    });
    const device = { serialNumber: "SN-STRICT", ip: "192.168.0.0/16" };
    expect(
      authorizeDeviceIdentity(device, "SN-STRICT", {
        remoteAddress: "192.168.99.2",
        credential: "",
      }, config).decision,
    ).toBe("IP_MISMATCH");
  });

  it("يرفض CIDR مشتركاً بلا مفتاح جهاز ويرفض IP مكرراً بين جهازين", () => {
    const broad = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "10.0.0.0/24",
      HR_DEVICE_IDENTITY_BINDINGS: JSON.stringify({
        "SN-BROAD": { allowlist: ["10.0.0.0/24"] },
      }),
    });
    expect(productionSecurityFailure(broad, { NODE_ENV: "production" })).toContain("مفتاح جهاز");
    expect(
      enabledDeviceIdentityFailure(
        [
          { serialNumber: "SN-1", ip: "10.0.0.5" },
          { serialNumber: "SN-2", ip: "10.0.0.5/32" },
        ],
        resolveBridgeSecurityConfig({}),
      ),
    ).toContain("يشتركان");
  });

  it("يرفض إعادة استخدام سر البوابة أو سر جهاز آخر", () => {
    const reused = "df49baf8c17a49ec8ad4a67e62ed4079c8c72bc04b6b39b0d9f1ee623d632eaf";
    const sameAsGateway = resolveBridgeSecurityConfig({
      HR_DEVICE_SHARED_SECRET: reused,
      HR_DEVICE_IDENTITY_BINDINGS: JSON.stringify({
        "SN-1": { sharedSecret: reused },
      }),
    });
    expect(productionSecurityFailure(sameAsGateway, { NODE_ENV: "production" })).toContain("فريداً");

    const duplicateDevices = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "10.0.0.0/24",
      HR_DEVICE_IDENTITY_BINDINGS: JSON.stringify({
        "SN-1": { sharedSecret: reused },
        "SN-2": { sharedSecret: reused },
      }),
    });
    expect(productionSecurityFailure(duplicateDevices, { NODE_ENV: "production" })).toContain("فريداً");
  });

  it("يرفض ربط IP شامل مخزناً في سجل الجهاز حتى خارج بوابة البيئة", () => {
    const strict = resolveBridgeSecurityConfig({});
    expect(
      authorizeDeviceIdentity(
        { serialNumber: "BAD-IP-1", ip: "0.0.0.0/0" },
        "BAD-IP-1",
        { remoteAddress: "203.0.113.9", credential: "" },
        strict,
      ),
    ).toEqual({ authorized: false, decision: "BINDING_INVALID" });
  });

  it("يفشل مغلقاً عند JSON ربط غير صالح أو علم هجرة مبهم", () => {
    const malformed = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "192.168.10.0/24",
      HR_DEVICE_IDENTITY_BINDINGS: "{bad-json",
    });
    expect(productionSecurityFailure(malformed, { NODE_ENV: "production" })).toContain("ربط هوية");

    const ambiguous = resolveBridgeSecurityConfig({
      HR_DEVICE_IP_ALLOWLIST: "192.168.10.0/24",
      HR_DEVICE_LEGACY_IDENTITY_MIGRATION: "yes",
    });
    expect(productionSecurityFailure(ambiguous, { NODE_ENV: "production" })).toContain("ربط هوية");
  });
});
