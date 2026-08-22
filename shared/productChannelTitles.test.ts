import { describe, expect, it } from "vitest";
import { titleForChannel } from "./productChannelTitles";

describe("titleForChannel", () => {
  const product = {
    name: "الاسم القديم",
    internalName: "اسم داخلي",
    storeTitle: "عنوان المتجر",
    seoTitle: "عنوان SEO",
    shortTitle: "اسم مختصر",
    posLabel: "اسم POS",
    invoiceLabel: "اسم الفاتورة",
  };

  it("uses the channel-specific title when available", () => {
    expect(titleForChannel(product, "store")).toBe("عنوان المتجر");
    expect(titleForChannel(product, "seo")).toBe("عنوان SEO");
    expect(titleForChannel(product, "card")).toBe("اسم مختصر");
    expect(titleForChannel(product, "pos")).toBe("اسم POS");
    expect(titleForChannel(product, "invoice")).toBe("اسم الفاتورة");
    expect(titleForChannel(product, "internal")).toBe("اسم داخلي");
  });

  it("falls back safely for products not yet migrated", () => {
    const legacy = { name: "اسم قديم" };
    expect(titleForChannel(legacy, "store")).toBe("اسم قديم");
    expect(titleForChannel(legacy, "pos")).toBe("اسم قديم");
    expect(titleForChannel(legacy, "invoice")).toBe("اسم قديم");
  });

  it("ignores blank channel values and trims valid values", () => {
    expect(
      titleForChannel(
        { name: "قديم", storeTitle: "   ", shortTitle: "  مختصر  " },
        "store",
      ),
    ).toBe("قديم");
    expect(
      titleForChannel(
        { name: "قديم", storeTitle: "   ", shortTitle: "  مختصر  " },
        "card",
      ),
    ).toBe("مختصر");
  });
});
