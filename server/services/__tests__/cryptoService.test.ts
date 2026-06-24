import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetKeyCacheForTests, decryptSecret, encryptSecret, isCryptoReady, maskSecret } from "../cryptoService";

/**
 * شَريحة #6 — cryptoService AES-256-GCM.
 * المحاور: مُفتاح مَطلوب، round-trip، tamper detection، scheme version، masking.
 */

const ORIGINAL_KEY = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = TEST_KEY_HEX;
  __resetKeyCacheForTests();
});

describe("cryptoService — AES-256-GCM", () => {
  it("isCryptoReady: true عند ضَبط المُفتاح", () => {
    expect(isCryptoReady()).toBe(true);
  });

  it("isCryptoReady: false عند غياب المُفتاح", () => {
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    expect(isCryptoReady()).toBe(false);
  });

  it("isCryptoReady: false عند طول مُفتاح خَطأ", () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "shortkey";
    __resetKeyCacheForTests();
    expect(isCryptoReady()).toBe(false);
  });

  it("round-trip: encrypt → decrypt يُعيد النَصّ الأَصلي", () => {
    const plain = "EAAFsX...token_with_special_chars!@#$%^&*()";
    const enc = encryptSecret(plain)!;
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("encrypt(null/empty) ⇒ null (لا نُخَزّن قِيَم فارِغة)", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(encryptSecret("")).toBeNull();
  });

  it("decrypt(null) ⇒ null", () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeNull();
  });

  it("IV عَشوائي: تَشفيرَين لِنَفس النَصّ يُنتجان ciphertexts مُختلفَين", () => {
    const plain = "same-token";
    const a = encryptSecret(plain)!;
    const b = encryptSecret(plain)!;
    expect(a).not.toBe(b); // semantic security.
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it("tamper detection: تَعديل ciphertext ⇒ throws", () => {
    const enc = encryptSecret("secret-data")!;
    const parts = enc.split(":");
    // اِعكس بايتاً في الـciphertext.
    const tampered = Buffer.from(parts[3], "base64");
    tampered[0] ^= 0xff;
    parts[3] = tampered.toString("base64");
    const broken = parts.join(":");
    expect(() => decryptSecret(broken)).toThrow();
  });

  it("tamper detection: مُفتاح مُختلف ⇒ throws", () => {
    const enc = encryptSecret("secret")!;
    process.env.INTEGRATIONS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    __resetKeyCacheForTests();
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("scheme version: غَير v1 ⇒ throws", () => {
    expect(() => decryptSecret("v2:aaa:bbb:ccc")).toThrow(/scheme version/);
  });

  it("malformed: parts !== 4 ⇒ throws", () => {
    expect(() => decryptSecret("v1:only-two-parts")).toThrow(/4 parts/);
  });

  it("base64 key مَقبول أَيضاً (32-byte)", () => {
    const key32 = crypto.randomBytes(32);
    process.env.INTEGRATIONS_ENCRYPTION_KEY = key32.toString("base64");
    __resetKeyCacheForTests();
    const enc = encryptSecret("test")!;
    expect(decryptSecret(enc)).toBe("test");
  });

  it("maskSecret: عَرض آمن (آخر 4 أحرف فَقط)", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret("abc")).toBe("•••"); // ≤ 4 chars = كاملاً.
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("abcdef")).toBe("••cdef");
    expect(maskSecret("EAAFsX_long_token_here")).toMatch(/^•+here$/);
  });

  it("maskSecret: لا يَكشف أَكثر مِن 8 dots (طول ثابت لِلواجهة)", () => {
    const long = "x".repeat(50);
    expect(maskSecret(long)).toBe("•".repeat(8) + long.slice(-4));
  });
});

// إعادة المُفتاح الأَصلي بَعد كل الاختبارات.
afterAll(() => {
  if (ORIGINAL_KEY) process.env.INTEGRATIONS_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
});

function afterAll(fn: () => void) {
  // vitest provides afterAll globally — fallback لِبيئات بَلا globals.
  if (typeof globalThis !== "undefined" && (globalThis as any).afterAll) {
    (globalThis as any).afterAll(fn);
  }
}
