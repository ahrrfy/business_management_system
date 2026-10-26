import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditBuildBudgets,
  CSS_BUDGET_BYTES,
  ENTRY_RAW_BUDGET_BYTES,
  OPERATIONAL_CHUNK_BUDGET_BYTES,
} from "../audit-build-budgets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const clientSrc = path.join(repoRoot, "client/src");
const distPublic = path.join(repoRoot, "dist/public");

function scanTopLevelCssStatements(css, startIndex = 0, endIndex = css.length) {
  const statements = [];
  let i = startIndex;
  while (i < endIndex) {
    while (i < endIndex && /\s/.test(css[i])) i++;
    if (i >= endIndex) break;
    if (css[i] === "/" && css[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < endIndex && !(css[i] === "*" && css[i + 1] === "/")) i++;
      i = Math.min(endIndex, i + 2);
      statements.push(css.slice(start, i));
      continue;
    }
    const stmtStart = i;
    let depth = 0;
    while (i < endIndex) {
      const ch = css[i];
      if (ch === "/" && css[i + 1] === "*") {
        i += 2;
        while (i < endIndex && !(css[i] === "*" && css[i + 1] === "/")) i++;
        i = Math.min(endIndex, i + 2);
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < endIndex) {
          if (css[i] === "\\") {
            i += 2;
            continue;
          }
          if (css[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "{") {
        depth++;
        i++;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        i++;
        if (depth === 0) break;
        continue;
      }
      if (ch === ";" && depth === 0) {
        i++;
        break;
      }
      i++;
    }
    statements.push(css.slice(stmtStart, i));
  }
  return statements;
}

function splitTopLevelSelectors(selectorList) {
  const parts = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const ch = selectorList[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < selectorList.length && selectorList[i] !== quote) {
        if (selectorList[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "," && paren === 0 && bracket === 0) {
      parts.push(selectorList.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selectorList.slice(start).trim());
  return parts.filter(Boolean);
}

function flattenRules(css, atRulePrefix = "") {
  const flattened = [];
  for (const stmt of scanTopLevelCssStatements(css)) {
    const trimmed = stmt.trim();
    if (!trimmed || !trimmed.includes("{") || !trimmed.endsWith("}")) continue;
    const open = trimmed.indexOf("{");
    const head = trimmed.slice(0, open).trim();
    const inner = trimmed.slice(open + 1, -1);
    if (head.startsWith("@")) {
      flattened.push(
        ...flattenRules(
          inner,
          atRulePrefix ? `${atRulePrefix} -> ${head}` : head,
        ),
      );
    } else {
      for (const selector of splitTopLevelSelectors(head)) {
        flattened.push(
          `${atRulePrefix ? `${atRulePrefix} :: ` : ""}${selector}{${inner}}`,
        );
      }
    }
  }
  return flattened;
}

function extractLayerUtilitiesRules(css) {
  const rules = [];
  for (const stmt of scanTopLevelCssStatements(css)) {
    const trimmed = stmt.trim();
    if (/^@layer\s+utilities\b[\s{]/.test(trimmed) && trimmed.endsWith("}")) {
      const open = trimmed.indexOf("{");
      rules.push(...flattenRules(trimmed.slice(open + 1, -1)));
    }
  }
  return rules;
}

function withTempBuildDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-budget-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("auditBuildBudgets reports missingAssetsDir when dist/public/assets is absent", () => {
  withTempBuildDir((dir) => {
    const res = auditBuildBudgets(dir);
    assert.equal(res.ok, false);
    assert.equal(res.missingAssetsDir, true);
  });
});

test("auditBuildBudgets resolves app-*.js from manifest and audits non-entry index-*.js operational chunks", () => {
  withTempBuildDir((dir) => {
    const assetsDir = path.join(dir, "assets");
    const viteDir = path.join(dir, ".vite");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(viteDir, { recursive: true });

    fs.writeFileSync(
      path.join(viteDir, "manifest.json"),
      JSON.stringify({
        "index.html": { file: "assets/app-entry123.js", isEntry: true },
      }),
    );
    fs.writeFileSync(path.join(assetsDir, "app-entry123.js"), "a".repeat(95_000));
    // Non-entry index-*.js (e.g. @zxing/library) exceeding 600 KB MUST be caught!
    fs.writeFileSync(
      path.join(assetsDir, "index-zxing999.js"),
      "b".repeat(OPERATIONAL_CHUNK_BUDGET_BYTES + 1),
    );
    // Exact 300,000 byte boundary on CSS passes; 300,001 bytes fails.
    fs.writeFileSync(
      path.join(assetsDir, "index-exact.css"),
      "c".repeat(CSS_BUDGET_BYTES),
    );
    fs.writeFileSync(
      path.join(assetsDir, "erp-over.css"),
      "d".repeat(CSS_BUDGET_BYTES + 1),
    );

    const res = auditBuildBudgets(dir);
    assert.equal(res.entryAsset?.name, "app-entry123.js");
    assert.equal(res.ok, false);
    assert.deepEqual(
      res.violations.map((v) => `${v.label}:${v.name}`).sort(),
      ["حزمة نمط:erp-over.css", "صفحة تشغيلية:index-zxing999.js"],
    );
  });
});

test("auditBuildBudgets catches oversized app-*.js entry and missing entry chunk", () => {
  withTempBuildDir((dir) => {
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(assetsDir, "app-huge.js"),
      "x".repeat(ENTRY_RAW_BUDGET_BYTES + 10),
    );
    const res = auditBuildBudgets(dir);
    assert.equal(res.ok, false);
    assert.equal(res.violations[0]?.label, "الحزمة الأساسية");
  });

  withTempBuildDir((dir) => {
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "Storefront-abc.js"), "const x = 1;");
    const res = auditBuildBudgets(dir);
    assert.equal(res.ok, false);
    assert.equal(res.violations[0]?.label, "الحزمة الأساسية مفقودة");
  });
});

test("production dist/public CSS assets stay strictly under 300,000 bytes and preserve 100% of public + ERP Tailwind rules in canonical order", async () => {
  const assetsDir = path.join(distPublic, "assets");
  assert.ok(
    fs.existsSync(assetsDir),
    "dist/public/assets must exist (run pnpm build before running build integrity verification)",
  );

  const budgetRes = auditBuildBudgets(distPublic);
  assert.equal(
    budgetRes.ok,
    true,
    `Expected zero bundle budget violations, got: ${JSON.stringify(budgetRes.violations)}`,
  );
  assert.equal(CSS_BUDGET_BYTES, 300_000, "CSS budget ceiling must remain 300,000 bytes");

  const cssFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".css"));
  assert.ok(cssFiles.length >= 3, "Expected public index CSS and split ERP CSS assets");
  for (const file of cssFiles) {
    const size = fs.statSync(path.join(assetsDir, file)).size;
    assert.ok(
      size < CSS_BUDGET_BYTES,
      `${file} (${size} bytes) must be strictly under ${CSS_BUDGET_BYTES} bytes`,
    );
  }

  const indexCssName = cssFiles.find((f) => /^index-[\w-]+\.css$/.test(f));
  const erpCssName = cssFiles.find((f) => /^erp-[\w-]+\.css$/.test(f) && !f.startsWith("erp-variants-"));
  const erpVariantsCssName = cssFiles.find((f) => /^erp-variants-[\w-]+\.css$/.test(f));

  assert.ok(indexCssName, "index-*.css must be emitted");
  assert.ok(erpCssName, "erp-*.css must be emitted");
  assert.ok(erpVariantsCssName, "erp-variants-*.css must be emitted");

  const builtIndexCss = fs.readFileSync(path.join(assetsDir, indexCssName), "utf8");
  const builtErpCss = fs.readFileSync(path.join(assetsDir, erpCssName), "utf8");
  const builtErpVariantsCss = fs.readFileSync(
    path.join(assetsDir, erpVariantsCssName),
    "utf8",
  );

  // 1. Public shell critical CSS tokens, font-faces, and animations must be present in index-*.css
  for (const requiredToken of [
    "@font-face",
    "Cairo",
    "--background:",
    "--foreground:",
    "--store-accent:",
    "--store-accent-strong:",
    "--sem-pos:",
    "--sem-neg:",
    "--sem-warn:",
    "--sem-info:",
    "--stock-ok:",
    "--ui-control:",
    "--ui-radius-control:",
    "--animate-duration:",
    ".animate__fadeIn",
    ".animate__heartBeat",
    ".storefront",
  ]) {
    assert.ok(
      builtIndexCss.includes(requiredToken),
      `Public index-*.css is missing critical token/selector: ${requiredToken}`,
    );
  }
  assert.equal(
    builtIndexCss.includes(".sb-active"),
    false,
    "ERP-only .app-sidebar .sb-active skin rules must not bloat public index-*.css",
  );
  assert.ok(
    builtErpVariantsCss.includes(".sb-active"),
    "ERP .app-sidebar .sb-active skin rules must be present in erp-variants-*.css",
  );

  // 2. Verify 100% of public runtime closure Tailwind utilities exist in built index-*.css
  const twVitePkg = fs.realpathSync(
    path.join(repoRoot, "node_modules/@tailwindcss/vite/package.json"),
  );
  const vitePkg = fs.realpathSync(
    path.join(repoRoot, "node_modules/vite/package.json"),
  );
  const reqFromTwVite = createRequire(twVitePkg);
  const reqFromVite = createRequire(vitePkg);
  const { compile, optimize } = reqFromTwVite("@tailwindcss/node");
  const { Scanner } = reqFromTwVite("@tailwindcss/oxide");
  const esbuild = reqFromVite("esbuild");

  function resolveRuntimeImport(fromFile, spec) {
    let base;
    if (spec.startsWith("@/")) base = path.join(clientSrc, spec.slice(2));
    else if (spec.startsWith("@shared/"))
      base = path.join(repoRoot, "shared", spec.slice("@shared/".length));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
    else return null;
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
      const candidate = base + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  const publicRoots = [
    "main.tsx",
    "BootstrapApp.tsx",
    "pages/Storefront.tsx",
    "pages/MobileTurnstile.tsx",
    "pages/LegalDocument.tsx",
    "pages/JobApply.tsx",
    "pages/ShelfPriceLookup.tsx",
  ].map((p) => path.join(clientSrc, p));

  const excludedSpecs = new Set([
    "./App",
    "./erp.css",
    "./styles/erp-variants.css",
    "@/components/CommandPalette",
    "@/lib/realtime",
    "@/lib/realtime/financialQueries",
  ]);

  const visitedPublic = new Set();
  const queue = [...publicRoots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visitedPublic.has(file)) continue;
    visitedPublic.add(file);
    if (!/\.(?:ts|tsx|js|jsx)$/.test(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const importRe =
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] || m[2];
      if (excludedSpecs.has(spec)) continue;
      const resolved = resolveRuntimeImport(file, spec);
      if (resolved && !visitedPublic.has(resolved)) queue.push(resolved);
    }
  }

  const canonicalizeCss = async (css) => {
    const pass1 = optimize(css, { minify: true });
    const esRes = await esbuild.transform(
      typeof pass1 === "string" ? pass1 : pass1.code,
      {
        loader: "css",
        minify: true,
        target: ["chrome107", "edge107", "firefox104", "safari16"],
      },
    );
    const pass2 = optimize(esRes.code, { minify: true });
    return typeof pass2 === "string" ? pass2 : pass2.code;
  };

  const rawIndexCss = fs.readFileSync(path.join(clientSrc, "index.css"), "utf8");
  const indexCssWithoutSources = rawIndexCss
    .split("\n")
    .filter((line) => !line.trim().startsWith("@source "))
    .join("\n");

  const publicRefCompiler = await compile(indexCssWithoutSources, {
    base: clientSrc,
    onDependency: () => {},
  });
  const publicClosureCandidates = new Scanner({
    sources: [
      { base: path.join(repoRoot, "client"), pattern: "index.html", negated: false },
      ...[...visitedPublic].map((f) => ({
        base: path.dirname(f),
        pattern: path.basename(f),
        negated: false,
      })),
    ],
  }).scan();
  const publicRefCode = await canonicalizeCss(
    publicRefCompiler.build(publicClosureCandidates),
  );
  const expectedPublicRules = extractLayerUtilitiesRules(publicRefCode);
  const actualPublicRulesSet = new Set(
    extractLayerUtilitiesRules(await canonicalizeCss(builtIndexCss)),
  );
  const missingPublicRules = expectedPublicRules.filter(
    (rule) => !actualPublicRulesSet.has(rule),
  );
  assert.deepEqual(
    missingPublicRules,
    [],
    `Public index-*.css is missing ${missingPublicRules.length} utility rules reachable from public routes`,
  );

  // 3. Verify 100% of ALL repo Tailwind utilities across client/src/** + shared/** exist in
  //    [erp-*.css + erp-variants-*.css] in IDENTICAL canonical order to a monolithic build!
  const rawErpCss = fs.readFileSync(path.join(clientSrc, "erp.css"), "utf8");
  const fullRefCompiler = await compile(rawErpCss, {
    base: clientSrc,
    onDependency: () => {},
  });
  const fullRefSources = (
    fullRefCompiler.root === "none"
      ? []
      : fullRefCompiler.root === null
        ? [{ base: path.join(repoRoot, "client"), pattern: "**/*", negated: false }]
        : [{ ...fullRefCompiler.root, negated: false }]
  ).concat(fullRefCompiler.sources);
  const fullCandidates = new Scanner({ sources: fullRefSources }).scan();
  const fullRefCode = await canonicalizeCss(fullRefCompiler.build(fullCandidates));

  const expectedCanonicalErpRules = extractLayerUtilitiesRules(fullRefCode);
  const actualErpCombinedRules = [
    ...extractLayerUtilitiesRules(await canonicalizeCss(builtErpCss)),
    ...extractLayerUtilitiesRules(await canonicalizeCss(builtErpVariantsCss)),
  ];

  assert.ok(
    expectedCanonicalErpRules.length > 4000,
    `Expected > 4000 canonical ERP utility rules, got ${expectedCanonicalErpRules.length}`,
  );
  assert.deepEqual(
    actualErpCombinedRules,
    expectedCanonicalErpRules,
    "Split ERP CSS chunks must match monolithic Tailwind canonical rule sequence 100% rule-for-rule and in exact order",
  );
});
