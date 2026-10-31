import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isStandalonePublicRoute,
  shouldBootStandalonePublicShell,
} from "./StorefrontBootstrap";
import { isSharedPath, resolveHostRedirect } from "./lib/siteHosts";

describe("standalone storefront release", () => {
  it("keeps the current public and shared host policy", () => {
    for (const route of [
      "/store",
      "/store/product/42",
      "/store/mobile-turnstile",
      "/apply",
      "/legal/privacy",
      "/shelf-lookup",
      "/price-check",
      "/s/w/token",
    ]) {
      expect(isStandalonePublicRoute(route)).toBe(true);
      expect(shouldBootStandalonePublicShell(route, "alarabiya.online")).toBe(
        true,
      );
      expect(resolveHostRedirect("srv1548487.hstgr.cloud", route)).toBe(
        "public",
      );
    }
    for (const route of ["/login", "/account"]) {
      expect(isSharedPath(route)).toBe(true);
      expect(resolveHostRedirect("alarabiya.online", route)).toBe(null);
    }
    expect(resolveHostRedirect("alarabiya.online", "/pos")).toBe("internal");
  });
  it("has no ERP shell, studio overlay or ERP realtime boot in its entry modules", () => {
    for (const file of ["storefront-main.tsx", "StorefrontBootstrap.tsx"]) {
      const source = fs.readFileSync(
        path.join(import.meta.dirname, file),
        "utf8",
      );
      expect(source).not.toMatch(
        /(?:import\(["']\.\/App|CommandPalette|ErpRealtimeBoot|financialQueries|productStudio)/,
      );
    }
  });
  it("keeps the old registration URL and scope while namespacing caches", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../vite.config.ts"),
      "utf8",
    );
    expect(source).toContain(
      'cacheId: storefront ? "alarabiya-storefront" : "alarabiya-erp"',
    );
    expect(source).toContain("skipWaiting: false");
    expect(source).toContain("clientsClaim: false");
    expect(source).toContain("cleanupOutdatedCaches: false");
    const update = fs.readFileSync(
      path.join(import.meta.dirname, "components/PwaUpdateManager.tsx"),
      "utf8",
    );
    expect(update).not.toMatch(/caches\.delete|registration\.unregister/);
  });
});
