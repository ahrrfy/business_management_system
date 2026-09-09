import { spawnSync } from "node:child_process";

const repoRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
});

if (repoRootResult.status !== 0) {
  console.error("[firebase config security] تعذر تحديد جذر مستودع Git.");
  process.exit(1);
}

const repoRoot = repoRootResult.stdout.trim();
const trackedResult = spawnSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (trackedResult.status !== 0) {
  console.error("[firebase config security] تعذر فحص الملفات المتتبعة.");
  process.exit(1);
}

const forbiddenConfigNames = new Set([
  "google-services.json",
  "GoogleService-Info.plist",
]);
const trackedConfigFiles = trackedResult.stdout
  .split("\0")
  .filter(Boolean)
  .filter((file) => forbiddenConfigNames.has(file.split("/").at(-1)));

const keyPattern = "AIza[0-9A-Za-z_-]{35}";
const keyScanResult = spawnSync(
  "git",
  ["grep", "--cached", "-I", "-l", "-E", keyPattern, "--", "."],
  { cwd: repoRoot, encoding: "utf8" },
);
const trackedKeyFiles = keyScanResult.status === 0
  ? keyScanResult.stdout.split(/\r?\n/).filter(Boolean)
  : [];

if (keyScanResult.status !== 0 && keyScanResult.status !== 1) {
  console.error("[firebase config security] تعذر مسح أنماط مفاتيح Google.");
  process.exit(1);
}

if (trackedConfigFiles.length || trackedKeyFiles.length) {
  console.error("[firebase config security] رُفضت ملفات إعداد Firebase أو مفاتيح Google المتتبعة:");
  for (const file of new Set([...trackedConfigFiles, ...trackedKeyFiles])) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log("[firebase config security] OK");
