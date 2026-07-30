import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = process.cwd();
const assetsDir = path.join(root, "dist", "public", "assets");

if (!fs.existsSync(assetsDir)) {
  console.error("لا يوجد بناء إنتاج في dist/public/assets — شغّل pnpm build أولاً.");
  process.exit(1);
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

const largestEntry = assets
  .filter((asset) => /^index-[\w-]+\.js$/.test(asset.name))
  .sort((a, b) => b.bytes - a.bytes)[0];

const limits = [
  {
    label: "الحزمة الأساسية",
    matches: (asset) => asset === largestEntry,
    raw: 700_000,
    gzip: 230_000,
  },
  {
    label: "صفحة تشغيلية",
    matches: (asset) =>
      /\.(?:js|mjs)$/.test(asset.name) &&
      !/^(?:index-|exceljs-|framework-|data-client-|ui-vendor-|observability-|offline-store-|ort\.)/.test(asset.name),
    raw: 600_000,
  },
  {
    label: "مكتبة Excel المعزولة",
    matches: (asset) => asset.name.startsWith("exceljs-"),
    raw: 1_000_000,
  },
  {
    label: "حزمة نمط",
    matches: (asset) => asset.name.endsWith(".css"),
    raw: 300_000,
  },
  {
    label: "محرك إزالة الخلفية",
    matches: (asset) => asset.name.endsWith(".wasm"),
    raw: 25_000_000,
  },
];

const violations = [];
for (const limit of limits) {
  for (const asset of assets.filter(limit.matches)) {
    if (asset.bytes > limit.raw || (limit.gzip && (asset.gzipBytes ?? 0) > limit.gzip)) {
      violations.push({ ...asset, label: limit.label, rawLimit: limit.raw, gzipLimit: limit.gzip });
    }
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
console.log("ميزانية بناء واجهة الإنتاج");
if (largestEntry) {
  console.log(
    `- الحزمة الأساسية: ${largestEntry.name} = ${kb(largestEntry.bytes)} / gzip ${kb(largestEntry.gzipBytes)}`,
  );
}
for (const asset of assets.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
  console.log(`- ${asset.name}: ${kb(asset.bytes)}${asset.gzipBytes ? ` / gzip ${kb(asset.gzipBytes)}` : ""}`);
}

if (violations.length) {
  console.error("\nتجاوزات ميزانية الأداء:");
  for (const item of violations) {
    console.error(
      `- ${item.label}: ${item.name} = ${kb(item.bytes)} (الحد ${kb(item.rawLimit)})` +
        (item.gzipLimit ? `، gzip ${kb(item.gzipBytes)} (الحد ${kb(item.gzipLimit)})` : ""),
    );
  }
  process.exitCode = 1;
} else {
  console.log("- النتيجة: ضمن الميزانية.");
}
