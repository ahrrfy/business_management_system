import { describe, expect, it } from "vitest";
import { deliveryPhoneDigits, matchesDeliverySearch, scoreDeliverySearch } from "./deliverySearch";

const target = { names: ["أحمد علي"], phones: ["+9647719086236"], addresses: ["بغداد - الكرادة"], references: ["CN-1-20261011-00040", "INV-29258", "404221"] };

describe("delivery search", () => {
  it.each(["07719086236", "+9647719086236", "009647719086236", "+964 771 908 6236", "00964 7719086236", "0771 (908) 6236", "6236", "٦٢٣٦", "۶۲۳۶", "077"])("finds phone form %s", (q) => {
    expect(matchesDeliverySearch(target, q)).toBe(true);
  });
  it.each(["احمد الكراده ٦٢٣٦", "الكرادة احمد", "077 29258", "292", "٢٩٢٥٨", "٤٠٤٢", "CN12026101100040", "أَحْمَد"])("finds cross-field query %s", (q) => {
    expect(matchesDeliverySearch(target, q)).toBe(true);
  });
  it("requires every term and preserves ambiguous partial matches", () => {
    expect(matchesDeliverySearch(target, "احمد الموصل")).toBe(false);
    expect(matchesDeliverySearch({ phones: ["+9647800006236"] }, "6236")).toBe(true);
    expect(matchesDeliverySearch(target, "")).toBe(true);
  });
  it("ranks an exact reference above newer partial references", () => {
    expect(scoreDeliverySearch({ references: ["29258"] }, "29258")).toBeGreaterThan(scoreDeliverySearch({ references: ["1292580"] }, "29258"));
  });
  it("requires terms beyond the eighth and favors an exact full name", () => {
    expect(matchesDeliverySearch({ references: ["012", "4042"] }, "012 4042")).toBe(true);
    expect(matchesDeliverySearch({ names: ["a b c d e f g h"] }, "a b c d e f g h absent")).toBe(false);
    expect(scoreDeliverySearch({ names: ["احمد علي"] }, "احمد علي")).toBeGreaterThan(scoreDeliverySearch({ names: ["احمد علي كريم"] }, "احمد علي"));
  });
  it("normalizes search without altering supplied values", () => {
    expect(deliveryPhoneDigits("٠٠٩٦٤ ٧٧١٩٠٨٦٢٣٦")).toBe("7719086236");
    expect(target.phones[0]).toBe("+9647719086236");
  });
});
