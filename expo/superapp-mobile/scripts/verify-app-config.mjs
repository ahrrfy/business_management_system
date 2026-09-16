import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];

function fail(message) {
  failures.push(message);
}

const windows = process.platform === "win32";
const configResult = spawnSync(
  windows ? process.env.ComSpec ?? "cmd.exe" : "pnpm",
  windows ? ["/d", "/s", "/c", "pnpm exec expo config --type public --json"] : ["exec", "expo", "config", "--type", "public", "--json"],
  {
  cwd: root,
  encoding: "utf8",
  shell: false,
  },
);
if (configResult.status !== 0) {
  fail(`Expo config could not be read: ${configResult.stderr || configResult.stdout || configResult.error?.message || "unknown error"}`);
} else {
  const config = JSON.parse(configResult.stdout);
  if (!config.android?.package?.startsWith("online.alarabiya.store")) fail("Android package is outside the Super Arabia namespace.");
  if (!config.ios?.bundleIdentifier?.startsWith("online.alarabiya.superapp")) fail("iOS bundle identifier is outside the Super Arabia namespace.");
  if (!["super-arabia", "super-arabia-preview"].includes(config.scheme)) fail("The native deep-link scheme is outside the reviewed identities.");
  if (config.android?.usesCleartextTraffic === true) fail("Cleartext traffic must remain disabled.");
  if (config.extra?.apiBaseUrl) fail("The API endpoint must stay in the native transport configuration, not Expo public extras.");
  if (!Array.isArray(config.plugins) || !config.plugins.some((plugin) => plugin === "expo-notifications")) {
    fail("expo-notifications must remain a reviewed native plugin, not an ad-hoc JavaScript integration.");
  }
  if (config.extra?.expoProjectId !== "" && !/^[0-9a-f-]{36}$/i.test(config.extra?.expoProjectId ?? "")) {
    fail("The Expo project id must be an empty preview value or a reviewed UUID.");
  }
  if (config.extra?.eas?.projectId !== config.extra?.expoProjectId) fail("EAS and notification project ids must remain identical.");
  if (config.web?.output !== "single") fail("Web must remain a single-page preview; native development builds must not enable the web server renderer.");
}

for (const filename of [".env", ".env.local", ".env.development", ".env.production"]) {
  const path = resolve(root, filename);
  if (!existsSync(path)) continue;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const key = line.match(/^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=/)?.[1];
    if (key && /(SECRET|TOKEN|PASSWORD|PRIVATE|KEY)/.test(key) && key !== "EXPO_PUBLIC_EAS_PROJECT_ID") {
      fail(`${filename} exposes a sensitive-looking public variable: ${key}.`);
    }
  }
}

if (failures.length) {
  console.error(`[app config] ${failures.join("\n[app config] ")}`);
  process.exit(1);
}
console.log("[app config] Expo identity, HTTPS, and public environment checks passed.");
