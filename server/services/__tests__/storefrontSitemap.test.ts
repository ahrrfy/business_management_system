import { describe, expect, it } from "vitest";
import { generateStorefrontSitemapXml, invalidateSitemapCache } from "../storefrontSitemapService";

describe("generateStorefrontSitemapXml", () => {
  it("generates valid XML sitemap with store links", async () => {
    invalidateSitemapCache();
    const xml = await generateStorefrontSitemapXml("https://alarabiya.online");

    expect(xml).toContain("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(xml).toContain("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"");
    expect(xml).toContain("xmlns:image=\"http://www.google.com/schemas/sitemap-image/1.1\"");
    expect(xml).toContain("<loc>https://alarabiya.online/store</loc>");
    expect(xml).toContain("<image:image>");
    expect(xml).toContain("<loc>https://alarabiya.online/apply</loc>");
    expect(xml).toContain("<priority>1.0</priority>");
    expect(xml).toContain("</urlset>");
  });

  it("respects custom origin and caches result per origin", async () => {
    invalidateSitemapCache();
    const xml1 = await generateStorefrontSitemapXml("https://example.com");
    expect(xml1).toContain("<loc>https://example.com/store</loc>");

    // Same origin: served from cache
    const xml1b = await generateStorefrontSitemapXml("https://example.com");
    expect(xml1b).toBe(xml1);

    // Different origin: never served another origin's cached sitemap
    const xml2 = await generateStorefrontSitemapXml("https://another.com");
    expect(xml2).toContain("<loc>https://another.com/store</loc>");
    expect(xml2).not.toContain("example.com");
  });
});
