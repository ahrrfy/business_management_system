import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import {
  CSS_ASSET_BUDGET_BYTES,
  cssAssetBudgetViolation,
  splitCompiledErpUtilitiesCss,
} from "../../../vite.config";
import {
  BootstrapApp,
  isStandalonePublicRoute,
  shouldBootStandalonePublicShell,
} from "../BootstrapApp";

(globalThis as { React?: typeof React }).React = React;

const PUBLIC_HOST = "alarabiya.online";
const INTERNAL_HOST = "srv1548487.hstgr.cloud";
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

function withMockHostname<T>(hostname: string, pathname: string, fn: () => T): T {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        hostname,
        pathname,
        search: "",
        hash: "",
        replace: () => {},
      },
    },
  });
  return fn();
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      results.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name)
    ) {
      results.push(full);
    }
  }
  return results;
}

describe("BootstrapApp public/ERP shell isolation", () => {
  it("classifies standalone public paths accurately including boundaries", () => {
    expect(isStandalonePublicRoute("/store")).toBe(true);
    expect(isStandalonePublicRoute("/store/product/123?coupon=EID")).toBe(true);
    expect(isStandalonePublicRoute("/store/category/7#top")).toBe(true);
    expect(isStandalonePublicRoute("/store/mobile-turnstile")).toBe(true);
    expect(isStandalonePublicRoute("/apply")).toBe(true);
    expect(isStandalonePublicRoute("/legal/privacy")).toBe(true);
    expect(isStandalonePublicRoute("/legal/delete-account")).toBe(true);
    expect(isStandalonePublicRoute("/shelf-lookup?branch=1")).toBe(true);
    expect(isStandalonePublicRoute("/price-check")).toBe(true);

    expect(isStandalonePublicRoute("")).toBe(false);
    expect(isStandalonePublicRoute("/")).toBe(false);
    expect(isStandalonePublicRoute("/login")).toBe(false);
    expect(isStandalonePublicRoute("/my-deliveries")).toBe(false);
    expect(isStandalonePublicRoute("/pos")).toBe(false);
    expect(isStandalonePublicRoute("/store-admin")).toBe(false);
    expect(isStandalonePublicRoute("/inventory")).toBe(false);
    expect(isStandalonePublicRoute("/reports")).toBe(false);
  });

  it("keeps public host root and host-redirected paths off the ERP App tree", () => {
    expect(shouldBootStandalonePublicShell("/", PUBLIC_HOST)).toBe(true);
    expect(shouldBootStandalonePublicShell("/", `www.${PUBLIC_HOST}`)).toBe(true);
    expect(shouldBootStandalonePublicShell("/store", PUBLIC_HOST)).toBe(true);
    expect(shouldBootStandalonePublicShell("/pos", PUBLIC_HOST)).toBe(true);
    expect(shouldBootStandalonePublicShell("/my-deliveries", PUBLIC_HOST)).toBe(
      true,
    );

    expect(shouldBootStandalonePublicShell("/", INTERNAL_HOST)).toBe(false);
    expect(shouldBootStandalonePublicShell("/pos", INTERNAL_HOST)).toBe(false);
    expect(shouldBootStandalonePublicShell("/inventory", INTERNAL_HOST)).toBe(
      false,
    );

    expect(shouldBootStandalonePublicShell("/store", "localhost")).toBe(true);
    expect(shouldBootStandalonePublicShell("/", "localhost")).toBe(false);
    expect(shouldBootStandalonePublicShell("/pos", "localhost")).toBe(false);
  });

  it("redirects `/` to `/store` immediately on the public host without mounting trpc or calling auth.me", () => {
    const ssrContext: { redirectTo?: string } = {};

    withMockHostname(PUBLIC_HOST, "/", () => {
      renderToStaticMarkup(
        createElement(Router, {
          ssrPath: "/",
          ssrContext,
          children: createElement(BootstrapApp),
        }),
      );
    });

    expect(ssrContext.redirectTo).toBe("/store");
  });

  it("redirects `/price-check` to `/shelf-lookup` and renders 404 on unknown `/legal/*` paths", () => {
    const ssrContext: { redirectTo?: string } = {};
    withMockHostname(PUBLIC_HOST, "/price-check", () => {
      renderToStaticMarkup(
        createElement(Router, {
          ssrPath: "/price-check",
          ssrContext,
          children: createElement(BootstrapApp),
        }),
      );
    });
    expect(ssrContext.redirectTo).toBe("/shelf-lookup");

    const html404 = withMockHostname(PUBLIC_HOST, "/legal/unknown-doc", () =>
      renderToStaticMarkup(
        createElement(Router, {
          ssrPath: "/legal/unknown-doc",
          children: createElement(BootstrapApp),
        }),
      ),
    );
    expect(html404).toContain("404");
  });

  it("enforces zero static imports of ERP App/CSS/CommandPalette/Realtime/trpc in main.tsx and BootstrapApp.tsx", () => {
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
    expect(mainSrc).not.toMatch(/animate\.css/);
    expect(mainSrc).toMatch(/import\s+["']\.\/styles\/animate-subset\.css["']/);
    expect(mainSrc).toMatch(
      /import\s+["']\.\/lib\/theme\/semantic-utilities\.css["']/,
    );
    expect(mainSrc).not.toMatch(/erp(?:-variants)?\.css/);
    expect(mainSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@\/components\/CommandPalette["']/m,
    );
    expect(mainSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@\/lib\/realtime(?:\/financialQueries)?["']/m,
    );

    expect(bootstrapSrc).not.toMatch(/^\s*import\s+.*from\s+["']\.\/App["']/m);
    expect(bootstrapSrc).not.toMatch(/^\s*import\s+.*erp(?:-variants)?\.css["']/m);
    expect(bootstrapSrc).not.toMatch(/@\/lib\/trpc/);
    expect(bootstrapSrc).not.toMatch(/auth\.me/);
    expect(bootstrapSrc).not.toMatch(/resolvePublicRootTarget/);
    expect(bootstrapSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@\/components\/(?:AppLayout|RequireRole)["']/m,
    );
    expect(bootstrapSrc).not.toMatch(
      /^\s*import\s+.*from\s+["']@shared\/operationPermissions["']/m,
    );

    const erpCssIdx = bootstrapSrc.indexOf('import("./erp.css")');
    const erpVariantsIdx = bootstrapSrc.indexOf(
      'import("./styles/erp-variants.css")',
    );
    const appIdx = bootstrapSrc.indexOf('import("./App")');
    expect(erpCssIdx).toBeGreaterThan(-1);
    expect(erpVariantsIdx).toBeGreaterThan(erpCssIdx);
    expect(appIdx).toBeGreaterThan(erpVariantsIdx);
  });

  it("covers 100% of the transitive public runtime TS/TSX closure in index.css @source directives and keeps universal @media print rules", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const clientSrc = path.join(repoRoot, "client/src");
    const indexCss = fs.readFileSync(path.join(clientSrc, "index.css"), "utf8");
    const erpCss = fs.readFileSync(path.join(clientSrc, "erp.css"), "utf8");

    expect(indexCss).toMatch(/@media\s+print\s*\{/);
    expect(indexCss).toContain("[data-sonner-toaster]");
    expect(erpCss).toContain('@import "./lib/theme/semantic-utilities.css";');

    const resolveRuntimeImport = (fromFile: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith("@/")) base = path.join(clientSrc, spec.slice(2));
      else if (spec.startsWith("@shared/")) {
        base = path.join(repoRoot, "shared", spec.slice("@shared/".length));
      } else if (spec.startsWith(".")) {
        base = path.resolve(path.dirname(fromFile), spec);
      } else {
        return null;
      }
      for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
        const candidate = base + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
      return null;
    };

    const excludedLazyErpSpecs = new Set([
      "./App",
      "./erp.css",
      "./styles/erp-variants.css",
      "@/components/CommandPalette",
      "@/lib/realtime",
      "@/lib/realtime/financialQueries",
    ]);

    const visitedPublic = new Set<string>();
    const queue = [
      path.join(clientSrc, "main.tsx"),
      path.join(clientSrc, "BootstrapApp.tsx"),
    ];
    const importRe =
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || visitedPublic.has(file)) continue;
      visitedPublic.add(file);
      if (!/\.(?:ts|tsx|js|jsx)$/.test(file)) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const m of Array.from(src.matchAll(importRe))) {
        const spec = m[1] || m[2];
        if (!spec || excludedLazyErpSpecs.has(spec)) continue;
        const resolved = resolveRuntimeImport(file, spec);
        if (resolved && !visitedPublic.has(resolved)) queue.push(resolved);
      }
    }

    expect(visitedPublic.has(path.join(clientSrc, "pages/Storefront.tsx"))).toBe(true);
    expect(visitedPublic.has(path.join(clientSrc, "pages/ShelfPriceLookup.tsx"))).toBe(true);

    const declaredSources: string[] = [];
    for (const line of indexCss.split(/\r?\n/)) {
      const match = line.trim().match(/^@source\s+"([^"]+)";$/);
      if (match?.[1]) {
        declaredSources.push(path.resolve(clientSrc, match[1]));
      }
    }

    const uncoveredTsFiles = Array.from(visitedPublic)
      .filter((f) => /\.(?:ts|tsx|js|jsx)$/.test(f))
      .filter((f) => {
        const normF = path.resolve(f);
        return !declaredSources.some((srcPath) => {
          if (normF === srcPath) return true;
          if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
            const rel = path.relative(srcPath, normF);
            return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
          }
          return false;
        });
      })
      .map((f) => path.relative(repoRoot, f).replace(/\\/g, "/"));

    expect(uncoveredTsFiles).toEqual([]);
  });

  it("defines 100% of animate__* classes used across client/src/** in animate-subset.css without global @keyframes pulse collision", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const clientSrc = path.join(repoRoot, "client/src");
    const subsetCss = fs.readFileSync(
      path.join(clientSrc, "styles/animate-subset.css"),
      "utf8",
    );

    const usedClasses = new Set<string>();
    for (const file of collectTsFiles(clientSrc)) {
      const content = fs.readFileSync(file, "utf8");
      for (const match of Array.from(content.matchAll(/\banimate__[A-Za-z0-9_-]+\b/g))) {
        usedClasses.add(match[0]);
      }
    }

    expect(usedClasses.size).toBeGreaterThan(0);
    for (const cls of Array.from(usedClasses)) {
      expect(subsetCss).toContain(`.${cls}`);
    }
    const subsetNoComments = subsetCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(subsetNoComments).toContain("--animate-duration");
    expect(subsetNoComments).toContain("prefers-reduced-motion: reduce");
    expect(subsetNoComments).not.toMatch(/@keyframes\s+pulse\b/);
    expect(subsetNoComments).toMatch(/@keyframes\s+animate-pulse\b/);
  });

  it("splits canonical @layer utilities cleanly, keeps post-Tailwind semantic utilities at the end of part2, and enforces the 300 KB CSS asset ceiling", () => {
    const sample = [
      "/*! header */",
      "@layer properties;",
      '@layer utilities{.bg-primary{background-color:var(--primary)}.text-primary-foreground{color:var(--primary-foreground)}.border-border{border-color:var(--border)}.content-brace{content:"{;}"}.escaped\\:\\{x\\}{color:red}/* } comment */@media (width>=40rem){.sm\\:px-6{padding-inline:1.5rem}}}',
      "@layer utilities{.text-money-positive{color:var(--money-positive)}.badge-stock-out{color:var(--stock-out);background:color-mix(in oklch,var(--stock-out) 18%,transparent)}.badge-status-active{color:var(--status-active);background:color-mix(in oklch,var(--status-active) 15%,transparent)}}",
      "@property --tw-shadow{syntax:\"*+\";inherits:false}",
      ".app-sidebar{background:var(--sidebar-solid)}",
    ].join("");

    const { part1, part2 } = splitCompiledErpUtilitiesCss(sample);
    const combined = `${part1}\n${part2}`;
    expect(part1).toContain("@layer properties;");
    expect(part2).toContain("@layer properties;");
    expect(part1).toContain(".bg-primary{background-color:var(--primary)}");
    expect(combined).toContain("@media (width>=40rem){.sm\\:px-6{padding-inline:1.5rem}}");
    expect(part2).toContain(".badge-stock-out{color:var(--stock-out)");
    expect(part2).toContain(".badge-status-active{color:var(--status-active)");
    expect(part2).toContain(".app-sidebar{background:var(--sidebar-solid)}");
    expect(combined.indexOf(".bg-primary{background-color:var(--primary)}")).toBeLessThan(
      combined.indexOf('.content-brace{content:"{;}"}'),
    );
    expect(combined.indexOf('.content-brace{content:"{;}"}')).toBeLessThan(
      combined.indexOf(".escaped\\:\\{x\\}{color:red}"),
    );
    expect(combined.indexOf(".escaped\\:\\{x\\}{color:red}")).toBeLessThan(
      combined.indexOf(".sm\\:px-6{padding-inline:1.5rem}"),
    );
    expect(combined.indexOf(".sm\\:px-6{padding-inline:1.5rem}")).toBeLessThan(
      combined.indexOf(".badge-status-active{color:var(--status-active)"),
    );
    expect(part2.indexOf(".badge-status-active{color:var(--status-active)")).toBeLessThan(
      part2.indexOf(".app-sidebar{background:var(--sidebar-solid)}"),
    );

    const singleRule = "@layer properties;@layer utilities{.flex{display:flex}}";
    const fallback = splitCompiledErpUtilitiesCss(singleRule);
    expect(fallback.part1).toBe(singleRule);
    expect(fallback.part2).toBe("@layer properties;");

    expect(CSS_ASSET_BUDGET_BYTES).toBe(300_000);
    expect(
      cssAssetBudgetViolation({
        type: "asset",
        fileName: "assets/index-abc.css",
        source: "a".repeat(CSS_ASSET_BUDGET_BYTES),
      }),
    ).toBeNull();
    expect(
      cssAssetBudgetViolation({
        type: "asset",
        fileName: "assets/erp-abc.css",
        source: new Uint8Array(CSS_ASSET_BUDGET_BYTES + 1),
      }),
    ).toContain("CSS_BUDGET_EXCEEDED assets/erp-abc.css: 300001 > 300000");
    expect(
      cssAssetBudgetViolation({
        type: "asset",
        fileName: "assets/logo.png",
        source: new Uint8Array(CSS_ASSET_BUDGET_BYTES + 500),
      }),
    ).toBeNull();
  });
});
