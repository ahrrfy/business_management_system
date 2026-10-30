import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { getDb } from "../../db";
import { serializeJsonForHtml } from "../../lib/jsonForHtml";
import { injectStorefrontSeoMeta, resolveStorefrontSeoMeta } from "../storefrontSeoMetaService";
import { storefrontProduct, type StorefrontProduct } from "../storefrontService";
import { listStorefrontProductReviews } from "../storefrontProductReviewService";
import type { Request } from "express";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../storefrontService", () => ({ storefrontProduct: vi.fn() }));
vi.mock("../storefrontProductReviewService", () => ({ listStorefrontProductReviews: vi.fn() }));

const { JSDOM } = createRequire(import.meta.url)("jsdom");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDb).mockImplementation(() => {
    throw new Error("Unexpected database access in SEO unit test");
  });
});

afterEach(() => {
  // The renderer catches IO errors, so fail even if it swallowed an unexpected DB call.
  expect(vi.mocked(getDb).mock.results.filter((result) => result.type === "throw")).toEqual([]);
});

const sampleHtml = `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Default Description" />
    <meta property="og:title" content="Default OG Title" />
    <meta property="og:description" content="Default OG Desc" />
    <meta property="og:url" content="https://alarabiya.online/store" />
    <meta property="og:image" content="https://alarabiya.online/icon-512.png" />
    <meta property="og:type" content="website" />
    <link rel="canonical" href="https://alarabiya.online/store" />
    <title>Default Title</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

const sampleProduct: StorefrontProduct = {
  productId: 42,
  productUnitId: 43,
  variantId: 44,
  productName: 'دفتر "عربي" & <ورق>',
  description: 'دفتر عربي "ممتاز" & مناسب للكتابة اليومية',
  brand: 'ماركة "العربية" & <أقلام>',
  category: 'قرطاسية & <مستلزمات>',
  categoryId: 7,
  unitName: "قطعة",
  price: "2500.00",
  salePrice: null,
  promotionName: null,
  inStock: true,
  imageUrl: "/product-42.png",
  isCustomizable: false,
  customizationKind: null,
  customizationTemplate: null,
  isBundle: false,
  stockLeft: null,
  soldCount: 0,
  hasAlternatives: false,
};

describe("serializeJsonForHtml", () => {
  it("preserves two-space JSON, Arabic, quotes and ampersands while encoding less-than", () => {
    const value = { name: 'دفتر "عربي" & <ورق>' };
    const serialized = serializeJsonForHtml(value);
    expect(serialized).toBe('{\n  "name": "دفتر \\"عربي\\" & \\u003cورق>"\n}');
    expect(JSON.parse(serialized)).toEqual(value);
  });

  it("encodes every less-than in nested values and keys without changing literal escape text", () => {
    const value = { "<key>": ["</script>", "</ScRiPt>", "<!--", "a < b < c", "\\u003c"] };
    const serialized = serializeJsonForHtml(value);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(value);
  });

  it.each([null, true, 42, "نص عربي"])("round-trips a JSON primitive: %s", (value) => {
    expect(JSON.parse(serializeJsonForHtml(value))).toEqual(value);
  });

  it.each([undefined, () => undefined, Symbol("value"), { toJSON: () => undefined }])("rejects non-JSON result %#", (value) => {
    expect(() => serializeJsonForHtml(value)).toThrowError(new TypeError("JSON_VALUE_REQUIRED"));
  });

  it("propagates native serialization errors for circular objects and bigint", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => serializeJsonForHtml(circular)).toThrow(TypeError);
    expect(() => serializeJsonForHtml(BigInt(1))).toThrow(TypeError);
  });

  it("propagates an error thrown by toJSON unchanged", () => {
    const error = new Error("custom serialization failure");
    expect(() => serializeJsonForHtml({ toJSON: () => { throw error; } })).toThrow(error);
  });
});

describe("storefrontSeoMetaService", () => {
  it("resolves store homepage metadata with schemas", async () => {
    const meta = await resolveStorefrontSeoMeta("/store", "", "https://alarabiya.online");
    expect(meta).not.toBeNull();
    expect(meta!.title).toContain("المكتبة العربية");
    expect(meta!.canonicalUrl).toBe("https://alarabiya.online/store");
    expect(meta!.ogType).toBe("website");
    expect(meta!.jsonLd).toHaveLength(3); // WebSite, Store, and FAQPage
    const storeObj = meta!.jsonLd[1] as Record<string, unknown>;
    expect(storeObj["telephone"]).toBe("+9647838666999");
    const faqObj = meta!.jsonLd[2] as Record<string, unknown>;
    expect(faqObj["@type"]).toBe("FAQPage");
  });

  it("injects SEO meta and structured data into HTML for store homepage", async () => {
    const mockReq = {
      path: "/store",
      url: "/store",
      get: (h: string) => (h === "host" ? "alarabiya.online" : undefined),
      protocol: "https",
    } as unknown as Request;

    const result = await injectStorefrontSeoMeta(sampleHtml, mockReq);
    expect(result).toContain("<title>المكتبة العربية | قرطاسية وطباعة وتجهيزات في العراق</title>");
    expect(result).toContain("application/ld+json");
    expect(result).toContain('"@type": "WebSite"');
    expect(result).toContain('"@type": "Store"');
    expect(result).toContain('"@type": "FAQPage"');
    expect(result).toContain("+9647838666999");
    expect(result).toContain('rel="canonical" href="https://alarabiya.online/store"');
  });

  it("injects Google Site Verification if configured", async () => {
    process.env.GOOGLE_SITE_VERIFICATION = "test-google-code-123";
    const mockReq = {
      path: "/store",
      url: "/store",
      get: () => "alarabiya.online",
      protocol: "https",
    } as unknown as Request;

    const result = await injectStorefrontSeoMeta(sampleHtml, mockReq);
    expect(result).toContain('<meta name="google-site-verification" content="test-google-code-123" />');
    delete process.env.GOOGLE_SITE_VERIFICATION;
  });

  it("handles Express wildcard routing where req.path is '/' and req.originalUrl holds the route", async () => {
    const mockReq = {
      path: "/",
      baseUrl: "/store",
      originalUrl: "/store",
      url: "/",
      get: (h: string) => (h === "host" ? "alarabiya.online" : undefined),
      protocol: "https",
    } as unknown as Request;

    const result = await injectStorefrontSeoMeta(sampleHtml, mockReq);
    expect(result).toContain("<title>المكتبة العربية | قرطاسية وطباعة وتجهيزات في العراق</title>");
    expect(result).toContain('rel="canonical" href="https://alarabiya.online/store"');
  });

  it.each(["</script>", "</ScRiPt>", "$&", "$$", "$`", "$'"])("keeps %s inside approved review JSON without creating HTML", async (content) => {
    const comment = `تقييم عربي "ممتاز" & <نص> ${content}<div id=jsonld-review-injected>اختبار خامل</div>`;
    vi.mocked(storefrontProduct).mockResolvedValue(sampleProduct);
    vi.mocked(listStorefrontProductReviews).mockResolvedValue({
      summary: { count: 1, average: 5 },
      items: [{
        id: 1,
        rating: 5,
        comment,
        reviewerName: "عميل موثق",
        isVerifiedPurchase: true,
        createdAt: new Date("2026-10-29T00:00:00.000Z"),
      }],
    });
    const req = {
      path: "/store/product/42",
      url: "/store/product/42",
      get: () => "alarabiya.online",
      protocol: "https",
    } as unknown as Request;
    const expected = await resolveStorefrontSeoMeta(req.path, "", "https://alarabiya.online");
    const template = sampleHtml.replace("<head>", '<head><script type="application/json" id="template-data">{"safe":true}</script>');
    const html = await injectStorefrontSeoMeta(template, req);
    // Default JSDOM parsing: no runScripts or resources options, no executable fixture.
    const dom = new JSDOM(html);
    const document: Document = dom.window.document;
    try {
      expect(document.querySelectorAll("#jsonld-review-injected").length).toBe(0);
      expect(document.querySelectorAll("#template-data").length).toBe(1);
      expect(document.querySelectorAll("#root").length).toBe(1);
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      expect(scripts).toHaveLength(2);
      const schemas = scripts.map((script) => {
        expect(script.textContent).not.toContain("<");
        return JSON.parse(script.textContent!);
      });
      expect(schemas).toEqual(expected!.jsonLd);
      expect(schemas[0]).toMatchObject({
        "@type": "Product",
        name: sampleProduct.productName,
        description: sampleProduct.description,
        brand: { name: sampleProduct.brand },
        aggregateRating: { reviewCount: 1, ratingValue: "5.0" },
        review: [{ reviewBody: comment, datePublished: "2026-10-29" }],
      });
      expect(schemas[1]).toMatchObject({ "@type": "BreadcrumbList" });
      expect(document.title).toBe(`${sampleProduct.productName} | المكتبة العربية`);
      expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(sampleProduct.description);
      expect(storefrontProduct).toHaveBeenCalledWith(42);
      expect(listStorefrontProductReviews).toHaveBeenCalledWith(42);
      expect(getDb).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
});

describe("public review approval query contract", () => {
  it("restricts both public items and aggregate queries to APPROVED, excluding PENDING and REJECTED", async () => {
    const conditions: SQL[] = [];
    const approvedReview = {
      id: 1,
      rating: 5,
      comment: "مراجعة عربية معتمدة",
      reviewerName: "عمار السلامي",
      onlineOrderId: 9,
      createdAt: new Date("2026-10-29T00:00:00.000Z"),
    };
    const itemsQuery = {
      from: () => itemsQuery,
      where: (condition: SQL) => { conditions.push(condition); return itemsQuery; },
      orderBy: () => itemsQuery,
      limit: async () => [approvedReview],
    };
    const aggregateQuery = {
      from: () => aggregateQuery,
      where: async (condition: SQL) => { conditions.push(condition); return [{ count: 1, average: "5.0" }]; },
    };
    const select = vi.fn().mockReturnValueOnce(itemsQuery).mockReturnValueOnce(aggregateQuery);
    vi.mocked(getDb).mockReturnValue({ select } as unknown as NonNullable<ReturnType<typeof getDb>>);
    const actual = await vi.importActual<typeof import("../storefrontProductReviewService")>("../storefrontProductReviewService");
    const result = await actual.listStorefrontProductReviews(42);

    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      const query = new MySqlDialect().sqlToQuery(condition);
      expect(query.sql).toBe("(`storefrontProductReviews`.`productId` = ? and `storefrontProductReviews`.`status` = ?)");
      expect(query.params).toEqual([42, "APPROVED"]);
    }
    expect(result).toEqual({
      summary: { count: 1, average: 5 },
      items: [{ id: 1, rating: 5, comment: approvedReview.comment, reviewerName: "عمار ا.", isVerifiedPurchase: true, createdAt: approvedReview.createdAt }],
    });
  });
});
