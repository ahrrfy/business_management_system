// اختبارات أمان الأوفلاين المحلي (الشريحة ٥): تشفير AES-GCM + اشتقاق PIN.
// بيئة node تملك WebCrypto (globalThis.crypto.subtle) — الجوهر النقي يُختبر بلا IndexedDB.
import { describe, expect, it } from "vitest";
import { decryptJsonWithKey, encryptJsonWithKey, isEncryptedEnvelope } from "./crypto";
import { __testables } from "./pinLock";

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

describe("crypto — مغلّف AES-GCM لحمولات الطابور", () => {
  it("ذهاب-إياب: التشفير ثم الفكّ يعيد الحمولة حرفياً (عربي + أرقام decimal)", async () => {
    const key = await makeKey();
    const payload = {
      branchId: 1,
      lines: [{ variantId: 7, quantity: "2.500", unitPriceOverride: "1250.00" }],
      notes: "زبون نقدي — قلم أزرق",
    };
    const env = await encryptJsonWithKey(payload, key);
    expect(isEncryptedEnvelope(env)).toBe(true);
    expect(env.data.length).toBeGreaterThan(0);
    const back = await decryptJsonWithKey<typeof payload>(env, key);
    expect(back).toEqual(payload);
  });

  it("iv عشوائي لكل تغليف: نفس الحمولة تعطي نصّين مشفَّرين مختلفين", async () => {
    const key = await makeKey();
    const a = await encryptJsonWithKey({ x: 1 }, key);
    const b = await encryptJsonWithKey({ x: 1 }, key);
    expect(Buffer.from(a.data).toString("hex")).not.toBe(Buffer.from(b.data).toString("hex"));
  });

  it("مفتاح مختلف لا يفكّ (AES-GCM authenticated ⇒ يرمي)", async () => {
    const k1 = await makeKey();
    const k2 = await makeKey();
    const env = await encryptJsonWithKey({ secret: "بيع" }, k1);
    await expect(decryptJsonWithKey(env, k2)).rejects.toBeTruthy();
  });

  it("isEncryptedEnvelope يميّز المغلّف عن حمولة قديمة صريحة (توافق رجعي)", () => {
    expect(isEncryptedEnvelope({ enc: true, iv: new Uint8Array(12), data: new Uint8Array(3) })).toBe(true);
    expect(isEncryptedEnvelope({ branchId: 1, lines: [] })).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
  });
});

describe("pinLock — اشتقاق PIN بـPBKDF2 ومقارنة ثابتة الزمن", () => {
  const { derivePinHash, constantTimeEqual } = __testables;

  it("نفس الرمز ونفس الملح ⇒ نفس الهاش؛ ملح مختلف ⇒ هاش مختلف", async () => {
    const salt1 = new Uint8Array(16).fill(7);
    const salt2 = new Uint8Array(16).fill(9);
    const a = await derivePinHash("1234", salt1);
    const b = await derivePinHash("1234", salt1);
    const c = await derivePinHash("1234", salt2);
    expect(constantTimeEqual(a, b)).toBe(true);
    expect(constantTimeEqual(a, c)).toBe(false);
    expect(a.length).toBe(32); // 256-bit
  });

  it("رمز مختلف ⇒ هاش مختلف (لا تصادم تافه)", async () => {
    const salt = new Uint8Array(16).fill(3);
    const a = await derivePinHash("1234", salt);
    const b = await derivePinHash("1235", salt);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("constantTimeEqual: أطوال مختلفة ⇒ false مباشرة", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });
});
