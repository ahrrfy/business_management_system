import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isStandalonePublicRoute,
  shouldBootStandalonePublicShell,
} from "../BootstrapApp";

const PUBLIC_HOST = "alarabiya.online";
const INTERNAL_HOST = "srv1548487.hstgr.cloud";

describe("BootstrapApp public/ERP shell isolation", () => {
  it("classifies standalone public paths accurately", () => {
    expect(isStandalonePublicRoute("/store")).toBe(true);
    expect(isStandalonePublicRoute("/store/product/123?coupon=EID")).toBe(true);
    expect(isStandalonePublicRoute("/store/category/7")).toBe(true);
    expect(isStandalonePublicRoute("/store/mobile-turnstile")).toBe(true);
    expect(isStandalonePublicRoute("/apply")).toBe(true);
    expect(isStandalonePublicRoute("/legal/privacy")).toBe(true);
    expect(isStandalonePublicRoute("/legal/delete-account")).toBe(true);
    expect(isStandalonePublicRoute("/shelf-lookup?branch=1")).toBe(true);
    expect(isStandalonePublicRoute("/price-check")).toBe(true);

    expect(isStandalonePublicRoute("/")).toBe(false);
    expect(isStandalonePublicRoute("/login")).toBe(false);
    expect(isStandalonePublicRoute("/pos")).toBe(false);
    expect(isStandalonePublicRoute("/store-admin")).toBe(false);
    expect(isStandalonePublicRoute("/inventory")).toBe(false);
    expect(isStandalonePublicRoute("/reports")).toBe(false);
  });

  it("keeps public host root and host-redirected paths off the ERP App tree", () => {
    expect(shouldBootStandalonePublicShell("/", PUBLIC_HOST)).toBe(true);
    expect(shouldBootStandalonePublicShell("/store", PUBLIC_HOST)).toBe(true);
    expect(shouldBootStandalonePublicShell("/pos", PUBLIC_HOST)).toBe(true);

    expect(shouldBootStandalonePublicShell("/", INTERNAL_HOST)).toBe(false);
    expect(shouldBootStandalonePublicShell("/pos", INTERNAL_HOST)).toBe(false);
    expect(shouldBootStandalonePublicShell("/inventory", INTERNAL_HOST)).toBe(false);

    expect(shouldBootStandalonePublicShell("/store", "localhost")).toBe(true);
    expect(shouldBootStandalonePublicShell("/", "localhost")).toBe(false);
    expect(shouldBootStandalonePublicShell("/pos", "localhost")).toBe(false);
  });

  it("enforces zero static imports of ERP App/CommandPalette/Realtime in main.tsx and BootstrapApp.tsx", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const mainSrc = fs.readFileSync(
      path.join(repoRoot, "client/src/main.tsx"),
      "utf8",
    );
    const bootstrapSrc = fs.readFileSync(
      path.join(repoRoot, "client/src/BootstrapApp.tsx"),
      "utf8",
    );

    expect(mainSrc).not.toMatch(/^\s*import\s+App\s+from\s+["']\.\/App["']/m);
    expect(mainSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@\/components\/CommandPalette["']/m,
    );
    expect(mainSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@\/lib\/realtime(?:\/financialQueries)?["']/m,
    );

    expect(bootstrapSrc).not.toMatch(/^\s*import\s+.*from\s+["']\.\/App["']/m);
    expect(bootstrapSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@\/components\/(?:AppLayout|RequireRole)["']/m,
    );
    expect(bootstrapSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@shared\/operationPermissions["']/m,
    );
  });
});
