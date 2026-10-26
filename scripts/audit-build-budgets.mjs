import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const CSS_BUDGET_BYTES = 300_000;
export const ENTRY_RAW_BUDGET_BYTES = 700_000;
export const ENTRY_GZIP_BUDGET_BYTES = 230_000;
export const OPERATIONAL_CHUNK_BUDGET_BYTES = 600_000;
export const EXCEL_CHUNK_BUDGET_BYTES = 1_000_000;
export const WASM_BUDGET_BYTES = 25_000_000;

function resolveEntryAssetName(buildDir, assets) {
  const manifestPath = path.join(buildDir, ".vite", "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const indexEntry =
        manifest["index.html"] ??
        Object.values(manifest).find((entry) => entry?.isEntry === true);
      if (typeof indexEntry?.file === "string") {
        const baseName = path.posix.basename(indexEntry.file.replace(/\\/g, "/"));
        if (assets.some((asset) => asset.name === baseName)) {
          return baseName;
        }
      }
    } catch {
      // Fall back to deterministic filename matching below if manifest is unreadable.
    }
  }

  const appEntry = assets
    .filter((asset) => /^app-[\w-]+\.js$/.test(asset.name))
    .sort((a, b) => b.bytes - a.bytes)[0];
  if (appEntry) return appEntry.name;

  const legacyIndexEntry = assets
    .filter((asset) => /^index-[\w-]+\.js$/.test(asset.name))
    .sort((a, b) => b.bytes - a.bytes)[0];
  return legacyIndexEntry?.name ?? null;
}

export function auditBuildBudgets(buildDir = path.join(process.cwd(), "dist", "public")) {
  const assetsDir = path.join(buildDir, "assets");
  if (!fs.existsSync(assetsDir)) {
    return {
      ok: false,
      missingAssetsDir: true,
      entryAsset: null,
      assets: [],
      violations: [],
    };
  }

  const assets = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".map"))
    .map((entry) => {
      const file = path.join(assetsDir, entry.name);
      const bytes = fs.statSync(file).size;
      const gzipBytes = /\.(?:js|mjs|css)$/.test(entry.name)
        ? gzipSync(fs.readFileSync(file)).byteLength
        : null;
      return { name: entry.name, bytes, gzipBytes };
    });

  const entryAssetName = resolveEntryAssetName(buildDir, assets);
  const entryAsset = assets.find((asset) => asset.name === entryAssetName) ?? null;

  const limits = [
    {
      label: "الحزمة الأساسية",
      matches: (asset) => asset === entryAsset,
      raw: ENTRY_RAW_BUDGET_BYTES,
      gzip: ENTRY_GZIP_BUDGET_BYTES,
    },
    {
      label: "صفحة تشغيلية",
      matches: (asset) =>
        /\.(?:js|mjs)$/.test(asset.name) &&
        asset !== entryAsset &&
        !/^(?:exceljs-|framework-|data-client-|ui-vendor-|observability-|offline-store-|motion-|ort\.)/.test(
          asset.name,
        ),
      raw: OPERATIONAL_CHUNK_BUDGET_BYTES,
    },
    {
      label: "مكتبة Excel المعزولة",
      matches: (asset) => asset.name.startsWith("exceljs-"),
      raw: EXCEL_CHUNK_BUDGET_BYTES,
    },
    {
      label: "حزمة نمط",
      matches: (asset) => asset.name.endsWith(".css"),
      raw: CSS_BUDGET_BYTES,
    },
    {
      label: "محرك إزالة الخلفية",
      matches: (asset) => asset.name.endsWith(".wasm"),
      raw: WASM_BUDGET_BYTES,
    },
  ];

  const violations = [];
  if (!entryAsset && assets.some((asset) => /\.(?:js|mjs)$/.test(asset.name))) {
    violations.push({
      name: "app-*.js",
      bytes: 0,
      gzipBytes: 0,
      label: "الحزمة الأساسية مفقودة",
      rawLimit: ENTRY_RAW_BUDGET_BYTES,
    });
  }

  for (const limit of limits) {
    for (const asset of assets.filter(limit.matches)) {
      if (asset.bytes > limit.raw || (limit.gzip && (asset.gzipBytes ?? 0) > limit.gzip)) {
        violations.push({
          ...asset,
          label: limit.label,
          rawLimit: limit.raw,
          gzipLimit: limit.gzip,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    missingAssetsDir: false,
    entryAsset,
    assets,
    violations,
  };
}

function runCli() {
  const result = auditBuildBudgets();
  if (result.missingAssetsDir) {
    console.error("لا يوجد بناء إنتاج في dist/public/assets — شغّل pnpm build أولاً.");
    process.exit(1);
  }

  const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
  console.log("ميزانية بناء واجهة الإنتاج");
  if (result.entryAsset) {
    console.log(
      `- الحزمة الأساسية: ${result.entryAsset.name} = ${kb(result.entryAsset.bytes)} / gzip ${kb(result.entryAsset.gzipBytes)}`,
    );
  }
  for (const asset of [...result.assets].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    console.log(
      `- ${asset.name}: ${kb(asset.bytes)}${asset.gzipBytes ? ` / gzip ${kb(asset.gzipBytes)}` : ""}`,
    );
  }

  if (result.violations.length) {
    console.error("\nتجاوزات ميزانية الأداء:");
    for (const item of result.violations) {
      console.error(
        `- ${item.label}: ${item.name} = ${kb(item.bytes)} (الحد ${kb(item.rawLimit)})` +
          (item.gzipLimit ? `، gzip ${kb(item.gzipBytes)} (الحد ${kb(item.gzipLimit)})` : ""),
      );
    }
    process.exitCode = 1;
  } else {
    console.log("- النتيجة: ضمن الميزانية.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
