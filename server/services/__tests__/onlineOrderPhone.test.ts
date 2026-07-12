/**
 * توحيد هاتف المتجر (مراجعة عدائية ١٢/٧): بدون تطبيع، «07701234567» و«+9647701234567» لنفس المشترك
 * يعطيان مفتاحَي قفل وتطابقَين مختلفَين ⇒ عميلان متكرّران. هذا الاختبار يحرس تلاقي الصيغ على E.164 واحدة.
 */
import { describe, expect, it } from "vitest";
import { normalizeStorePhone } from "../onlineOrderService";

describe("normalizeStorePhone — توحيد الهاتف العراقي إلى E.164", () => {
  it("كل صيغ نفس الرقم تتلاقى على +9647701234567", () => {
    const canonical = "+9647701234567";
    expect(normalizeStorePhone("07701234567")).toBe(canonical);
    expect(normalizeStorePhone("+964 770 123 4567")).toBe(canonical);
    expect(normalizeStorePhone("+9647701234567")).toBe(canonical);
    expect(normalizeStorePhone("9647701234567")).toBe(canonical);
    expect(normalizeStorePhone("00964 7701234567")).toBe(canonical);
    expect(normalizeStorePhone("0770-123-4567")).toBe(canonical);
    expect(normalizeStorePhone("  07701234567  ")).toBe(canonical);
    expect(normalizeStorePhone("7701234567")).toBe(canonical); // وطنيّ بلا صفر بادئ
  });
  it("مدخل بلا أرقام يُعاد مُشذَّباً بلا انهيار", () => {
    expect(normalizeStorePhone("   ")).toBe("");
    expect(normalizeStorePhone("+")).toBe("+");
  });
});
