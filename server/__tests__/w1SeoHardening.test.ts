import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// بلا قاعدة بيانات: خريطة الموقع تسقط إلى النسخة الاحتياطية الثابتة، فيُختبر الأصل لا المحتوى.
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: () => null,
}));

import { sitemapRouter } from "../routes/sitemap";
import { serveStatic } from "../vite";
import { generateStorefrontSitemapXml, invalidateSitemapCache } from "../services/storefrontSitemapService";
import { resolveStorefrontSeoMeta } from "../services/storefrontSeoMetaService";

const PUBLIC_ORIGIN = "https://alarabiya.online";
const INTERNAL_HOST = "srv1548487.hstgr.cloud";

const sampleHtml = `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Default Description" />
    <link rel="canonical" href="https://alarabiya.online/store" />
    <title>Default Title</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

function get(server: http.Server, urlPath: string, host: string): Promise<{ status: number; body: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("W1-B: خريطة الموقع لا تثق بترويسة Host", () => {
  let server: http.Server;

  beforeAll(async () => {
    process.env.PUBLIC_SITE_ORIGIN = PUBLIC_ORIGIN;
    const app = express();
    app.use(sitemapRouter);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => invalidateSitemapCache());

  it("طلب عبر دومين الموظفين لا يسمّم روابط الخريطة العامة", async () => {
    const res = await get(server, "/sitemap.xml", INTERNAL_HOST);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(INTERNAL_HOST);
    expect(res.body).toContain(`<loc>${PUBLIC_ORIGIN}/store</loc>`);
  });

  it("الطلب اللاحق بدومين مختلف لا يرث نتيجة مخبّأة بأصل آخر", async () => {
    await get(server, "/sitemap.xml", INTERNAL_HOST);
    const res = await get(server, "/sitemap.xml", "alarabiya.online");
    expect(res.body).not.toContain(INTERNAL_HOST);
    expect(res.body).toContain(`<loc>${PUBLIC_ORIGIN}/store</loc>`);
  });

  it("كاش الخدمة مفتاحه الأصل: أصل مختلف لا يعيد خريطة أصلٍ سابق", async () => {
    const a = await generateStorefrontSitemapXml("https://a.example");
    const b = await generateStorefrontSitemapXml("https://b.example");
    expect(a).toContain("<loc>https://a.example/store</loc>");
    expect(b).toContain("<loc>https://b.example/store</loc>");
    expect(b).not.toContain("a.example");
  });
});

describe("W1-B: GET / على الدومين العام يمرّ بحقن SEO", () => {
  let server: http.Server;
  let dist: string;

  beforeAll(async () => {
    process.env.PUBLIC_SITE_ORIGIN = PUBLIC_ORIGIN;
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "w1-seo-dist-"));
    fs.writeFileSync(path.join(dist, "index.html"), sampleHtml, "utf8");
    const app = express();
    serveStatic(app, dist);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("الجذر على alarabiya.online يحمل عنوان المتجر لا العنوان الخام", async () => {
    const res = await get(server, "/", "alarabiya.online");
    expect(res.body).not.toContain("<title>Default Title</title>");
    expect(res.body).toContain("application/ld+json");
  });

  it("الجذر على دومين الـERP الداخلي لا يتلقى هوية المتجر", async () => {
    const res = await get(server, "/", INTERNAL_HOST);
    expect(res.body).toContain("<title>Default Title</title>");
    expect(res.body).not.toContain("application/ld+json");
  });
});

describe("W1-B: بيانات المتجر المنظّمة بلا تقييم مختلق", () => {
  it("كائن Store لا يحمل aggregateRating ثابتاً", async () => {
    const meta = await resolveStorefrontSeoMeta("/store", "", PUBLIC_ORIGIN);
    expect(meta).not.toBeNull();
    const serialized = JSON.stringify(meta!.jsonLd);
    expect(serialized).not.toContain("aggregateRating");
    expect(serialized).not.toContain('"4.9"');
  });
});

describe("W1-B: استوديو التخصيص لا يَعِد بما لا يحدث", () => {
  const studio = fs.readFileSync(
    path.resolve(__dirname, "../../client/src/components/storefront/StorefrontCustomizerStudio.tsx"),
    "utf8",
  );

  it("لا يدّعي «إرفاق» البروفة أو اعتمادها للطلب", () => {
    expect(studio).not.toContain("وإرفاقها");
    expect(studio).not.toContain("تم اعتماد بيانات البروفة للطلب");
  });

  it("يوضّح أن الشعار والمعاينة لا يُرسلان مع الطلب", () => {
    expect(studio).toContain("لا ترسل مع الطلب");
  });
});
