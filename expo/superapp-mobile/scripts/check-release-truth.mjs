import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeRoots = ["app", "components", "lib"];
const banned = [
  [/\bPreviewBanner\b/, "PreviewBanner"],
  [/ownerDecisionCenterPreview/, "ownerDecisionCenterPreview"],
  [/\bmode\s*===\s*["']preview["']/, "preview workspace mode"],
  [/\bmode:\s*["']preview["']/, "preview workspace state"],
  [/(?:مصطفى كريم|سارة كريم|علي حسن)/, "sample person identity"],
  [/بيانات تجريبية محلية/, "sample local data label"],
];
const failures = [];

function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) {
      const content = readFileSync(child, "utf8");
      for (const [pattern, label] of banned) {
        if (pattern.test(content)) failures.push(`${child.slice(root.length + 1)} contains ${label}`);
      }
    }
  }
}

for (const directory of runtimeRoots) visit(resolve(root, directory));

if (failures.length) {
  console.error(`[release truth] ${failures.join("\n[release truth] ")}`);
  process.exit(1);
}

console.log("[release truth] Runtime screens contain no preview workspace, sample identity, or sample operational data.");
