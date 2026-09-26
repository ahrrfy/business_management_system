import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { generateStorefrontSitemapXml } from "../services/storefrontSitemapService";
import { generateGoogleMerchantFeedXml } from "../services/storefrontMerchantFeedService";

export const sitemapRouter = Router();

sitemapRouter.get("/robots.txt", (_req, res) => {
  const robotsPath = path.resolve(process.cwd(), "client", "public", "robots.txt");
  if (fs.existsSync(robotsPath)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(robotsPath);
  }
  const fallback = `User-agent: *\nAllow: /\nAllow: /store\nAllow: /store/*\nAllow: /apply\nAllow: /api/img/\nDisallow: /api/\nDisallow: /pos\nDisallow: /inventory\nDisallow: /reports\nDisallow: /store-admin\nSitemap: https://alarabiya.online/sitemap.xml\n`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.status(200).send(fallback);
});

const handleSitemap = async (req: import("express").Request, res: import("express").Response) => {
  try {
    const host = req.get("host") || "";
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const customOrigin = host ? `${protocol}://${host}` : undefined;
    const xml = await generateStorefrontSitemapXml(customOrigin);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).send("Error generating sitemap");
  }
};

sitemapRouter.get("/sitemap.xml", handleSitemap);
sitemapRouter.get("/store/sitemap.xml", handleSitemap);

const handleMerchantFeed = async (req: import("express").Request, res: import("express").Response) => {
  try {
    const host = req.get("host") || "";
    const protocol = req.protocol === "https" || req.get("x-forwarded-proto") === "https" ? "https" : "http";
    const customOrigin = host ? `${protocol}://${host}` : undefined;
    const xml = await generateGoogleMerchantFeedXml(customOrigin);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).send("Error generating Google Merchant feed");
  }
};

sitemapRouter.get("/feeds/google-merchant.xml", handleMerchantFeed);
sitemapRouter.get("/api/feeds/google-merchant.xml", handleMerchantFeed);
sitemapRouter.get("/store/feeds/google-merchant.xml", handleMerchantFeed);

// معالج التحقق من ملكية الموقع لمحرك بحث جوجل (Google Search Console)
const handleGoogleVerification = (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  const fileName = req.params.filename || "google46a4537ddb358508.html";
  if (!/^google[a-zA-Z0-9_-]+\.html$/.test(fileName)) {
    return next();
  }
  const possiblePaths = [
    path.resolve(process.cwd(), "client", "public", fileName),
    path.resolve(process.cwd(), "dist", "public", fileName),
  ];
  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.sendFile(filePath);
    }
  }
  if (fileName === "google46a4537ddb358508.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).send("google-site-verification: google46a4537ddb358508.html\n");
  }
  return next();
};

sitemapRouter.get("/:filename(google[a-zA-Z0-9_-]+\\.html)", handleGoogleVerification);
sitemapRouter.get("/store/:filename(google[a-zA-Z0-9_-]+\\.html)", handleGoogleVerification);

