import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { generateStorefrontSitemapXml } from "../services/storefrontSitemapService";

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

sitemapRouter.get("/sitemap.xml", async (req, res) => {
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
});
