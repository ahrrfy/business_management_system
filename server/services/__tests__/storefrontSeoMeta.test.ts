import { describe, expect, it } from "vitest";
import { injectStorefrontSeoMeta, resolveStorefrontSeoMeta } from "../storefrontSeoMetaService";
import type { Request } from "express";

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

describe("storefrontSeoMetaService", () => {
  it("resolves store homepage metadata with schemas", async () => {
    const meta = await resolveStorefrontSeoMeta("/store", "", "https://alarabiya.online");
    expect(meta).not.toBeNull();
    expect(meta!.title).toContain("المكتبة العربية");
    expect(meta!.canonicalUrl).toBe("https://alarabiya.online/store");
    expect(meta!.ogType).toBe("website");
    expect(meta!.jsonLd).toHaveLength(2); // WebSite and Store
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
});
