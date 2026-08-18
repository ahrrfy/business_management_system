import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function requireMatch(errors, text, pattern, message) {
  if (!pattern.test(text)) errors.push(message);
}

/** Returns the immediate nginx block for each proxy_pass, ignoring comments and quoted braces. */
export function proxiedBlocks(text) {
  const blocks = [];
  const stack = [];
  let quote = null;
  let escaped = false;
  let comment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "#") {
      comment = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      stack.push({ start: i, hasProxy: false });
      continue;
    }
    if (char === "}") {
      const block = stack.pop();
      if (block?.hasProxy) blocks.push(text.slice(block.start, i + 1));
      continue;
    }
    if (
      text.startsWith("proxy_pass", i) &&
      !/[\w-]/.test(text[i - 1] ?? "") &&
      !/[\w-]/.test(text[i + "proxy_pass".length] ?? "")
    ) {
      if (stack.length === 0) blocks.push("__PROXY_PASS_OUTSIDE_BLOCK__");
      else stack.at(-1).hasProxy = true;
      i += "proxy_pass".length - 1;
    }
  }
  return blocks;
}

export function verifyNginxConfiguration(input) {
  const {
    zones,
    internalSite,
    publicSite,
    realIp,
    proxyCommon,
    proxySecretExample,
    configFiles,
  } = input;
  const errors = [];

  for (const zone of [
    "alroya_general",
    "alroya_api",
    "alroya_auth",
    "alroya_password_recovery",
    "alroya_restore",
    "alroya_webhooks",
  ]) {
    requireMatch(
      errors,
      zones,
      new RegExp(`limit_req_zone\\s+\\$binary_remote_addr\\s+zone=${zone}:`),
      `missing IP-keyed shared zone: ${zone}`,
    );
  }

  const sites = [
    ["internal", internalSite, /server_name\s+srv1548487\.hstgr\.cloud;/],
    ["public", publicSite, /server_name\s+alarabiya\.online\s+www\.alarabiya\.online;/],
  ];
  const appLocations = input.appLocations;
  for (const [name, site, serverName] of sites) {
    requireMatch(errors, site, serverName, `${name} vhost has the wrong server_name`);
    requireMatch(errors, site, /include\s+snippets\/alroya-cloudflare-realip\.conf;/, `${name} vhost is missing Cloudflare real-IP`);
    requireMatch(errors, site, /include\s+snippets\/alroya-proxy-secret\.conf;/, `${name} vhost is missing the shared live secret`);
    if (/CHANGE_ME_INTERNAL_PROXY_SECRET/.test(site)) {
      errors.push(`${name} vhost embeds the placeholder secret instead of the protected snippet`);
    }
  }

  requireMatch(errors, internalSite, /include\s+snippets\/alroya-app-locations\.conf;/, "internal vhost is missing full application locations");
  requireMatch(errors, appLocations, /include\s+snippets\/alroya-spa-location\.conf;/, "full application locations are missing the shared SPA location");
  requireMatch(errors, publicSite, /include\s+snippets\/alroya-spa-location\.conf;/, "public vhost is missing the shared SPA location");
  if (/include\s+snippets\/alroya-app-locations\.conf;/.test(publicSite)) {
    errors.push("public vhost must not include full application locations because they contain generic /api/");
  }

  requireMatch(errors, proxySecretExample, /set\s+\$alroya_proxy_secret\s+"CHANGE_ME_INTERNAL_PROXY_SECRET";/, "missing documented live-secret file shape");
  requireMatch(errors, internalSite, /-m\s+600\s+\/dev\/null\s+\/etc\/nginx\/snippets\/alroya-proxy-secret\.conf/, "install notes must protect the shared live-secret file");
  requireMatch(errors, internalSite, /\/usr\/local\/libexec\/erp\/nginx\/install-nginx-contract\.mjs\s+install/, "nginx repair must use the installed root-owned helper");
  for (const [name, site] of sites) {
    if (/sudo[^\n]*scripts\/install-nginx-contract\.mjs/u.test(site)) {
      errors.push(`${name} vhost suggests executing deploy-writable JavaScript as root`);
    }
  }
  requireMatch(errors, realIp, /real_ip_header\s+CF-Connecting-IP;/, "real-IP must come from Cloudflare's canonical header");
  requireMatch(errors, realIp, /set_real_ip_from\s+173\.245\.48\.0\/20;/, "missing trusted Cloudflare source ranges");

  for (const [pattern, message] of [
    [/proxy_set_header\s+Host\s+\$host;/, "shared proxy contract must preserve Host"],
    [/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/, "shared proxy contract must preserve HTTPS scheme"],
    [/proxy_set_header\s+X-Internal-Proxy-Secret\s+\$alroya_proxy_secret;/, "shared proxy contract must attach the internal hop secret"],
    [/proxy_set_header\s+X-Alroya-Worker-Probe\s+"";/, "shared proxy contract must strip the internal worker probe header"],
    [/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/, "shared proxy contract must canonicalize X-Forwarded-For"],
    [/proxy_set_header\s+X-Real-IP\s+\$remote_addr;/, "shared proxy contract must canonicalize X-Real-IP"],
  ]) {
    requireMatch(errors, proxyCommon, pattern, message);
  }
  if (/proxy_add_x_forwarded_for/.test(proxyCommon)) {
    errors.push("proxy_add_x_forwarded_for reintroduces an attacker-controlled XFF prefix");
  }
  if (/proxy_(?:read|send)_timeout/.test(proxyCommon)) {
    errors.push("shared proxy contract must not duplicate per-location timeout directives");
  }

  const proxied = [];
  for (const [file, text] of Object.entries(configFiles)) {
    for (const block of proxiedBlocks(text)) proxied.push({ file, block });
  }
  if (proxied.length === 0) errors.push("nginx templates contain no proxied application locations");
  for (const { file, block } of proxied) {
    if (block === "__PROXY_PASS_OUTSIDE_BLOCK__") {
      errors.push(`${file}: proxy_pass is outside an nginx block`);
    } else if (!/include\s+snippets\/alroya-proxy-common\.conf;/.test(block)) {
      errors.push(`${file}: every proxy_pass block must locally include alroya-proxy-common.conf`);
    }
  }

  requireMatch(errors, appLocations, /location\s+~\s+"\^\/api\/trpc\/.*auth\\\.login.*auth\\\.twoFactorVerify.*platformAdmin\\\.login/, "missing shared auth route limiter");
  requireMatch(errors, appLocations, /limit_req\s+zone=alroya_auth\s+burst=30\s+nodelay;/, "auth limiter must use alroya_auth");
  requireMatch(errors, appLocations, /auth\\\.resetPasswordWithToken/, "missing exact password-recovery route limiter");
  requireMatch(errors, appLocations, /limit_req\s+zone=alroya_password_recovery\s+burst=3\s+nodelay;/, "password recovery limiter must use its own zone");
  requireMatch(errors, appLocations, /location\s+~\s+\^\/api\/backups\/restore-upload\/\?\$/, "restore location must include optional trailing slash");
  requireMatch(errors, appLocations, /limit_req\s+zone=alroya_restore\s+burst=2\s+nodelay;/, "restore limiter must use alroya_restore");
  requireMatch(errors, appLocations, /location\s+~\s+"\^\/api\/webhooks/, "missing webhook route location");
  requireMatch(errors, appLocations, /limit_req\s+zone=alroya_webhooks\s+burst=60\s+nodelay;/, "webhooks must use shared zone");

  const authLocation = /^\/api\/trpc\/(?:[^/?]+,)*(?:auth\.login|auth\.twoFactorVerify|platformAdmin\.login)(?:,|$)/;
  const passwordRecoveryLocation = /^\/api\/trpc\/(?:[^/?]+,)*auth\.resetPasswordWithToken(?:,|$)/;
  for (const uri of ["/API/TRPC/auth.login", "/Api/Trpc/auth.resetPasswordWithToken", "/API/BACKUPS/RESTORE-UPLOAD"]) {
    if (authLocation.test(uri) || passwordRecoveryLocation.test(uri)) errors.push(`sensitive nginx matcher unexpectedly accepts mixed-case ${uri}`);
  }
  for (const uri of [
    "/api/trpc/auth.login",
    "/api/trpc/auth.twoFactorVerify?batch=1",
    "/api/trpc/storefront.list,auth.login",
    "/api/trpc/platformAdmin.login,storefront.list",
  ]) {
    if (!authLocation.test(uri.split("?", 1)[0])) errors.push(`auth location does not cover ${uri}`);
  }
  for (const uri of ["/api/trpc/auth.me", "/api/trpc/storefront.list", "/api/trpc/notauth.login"]) {
    if (authLocation.test(uri.split("?", 1)[0])) errors.push(`auth location over-matches ${uri}`);
  }
  for (const uri of [
    "/api/trpc/auth.resetPasswordWithToken",
    "/api/trpc/storefront.list,auth.resetPasswordWithToken?batch=1",
  ]) {
    if (!passwordRecoveryLocation.test(uri.split("?", 1)[0])) errors.push(`password recovery location does not cover ${uri}`);
  }
  for (const uri of ["/api/trpc/auth.login", "/api/trpc/auth.resetPassword", "/api/trpc/notauth.resetPasswordWithToken"]) {
    if (passwordRecoveryLocation.test(uri)) errors.push(`password recovery location over-matches ${uri}`);
  }

  return errors;
}

function loadRepositoryConfiguration() {
  const deployDir = path.join(root, "deploy");
  const configFiles = Object.fromEntries(
    fs.readdirSync(deployDir)
      .filter((name) => /^nginx-.*\.conf$/.test(name))
      .map((name) => [name, fs.readFileSync(path.join(deployDir, name), "utf8")]),
  );
  return {
    zones: read("deploy/nginx-ratelimit.conf"),
    internalSite: read("deploy/nginx-erp.conf"),
    publicSite: read("deploy/nginx-public.conf"),
    realIp: read("deploy/nginx-cloudflare-realip.conf"),
    proxyCommon: read("deploy/nginx-proxy-common.conf"),
    proxySecretExample: read("deploy/nginx-proxy-secret.conf.example"),
    appLocations: read("deploy/nginx-app-locations.conf"),
    configFiles,
  };
}

export function verifyNginxReleaseManifest(projectRoot = root) {
  const resolvedRoot = path.resolve(projectRoot);
  const deployDirectory = path.join(resolvedRoot, "deploy");
  const expected = [
    ...fs.readdirSync(deployDirectory)
      .filter((name) => /^nginx-.*\.conf$/u.test(name))
      .map((name) => `deploy/${name}`),
    "deploy/nginx-proxy-secret.conf.example",
  ].sort();
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(deployDirectory, "nginx-release-manifest.json"), "utf8"));
  } catch {
    return ["nginx release manifest is missing or invalid JSON"];
  }
  if (
    manifest?.version !== 2 ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)
  ) {
    return ["nginx release manifest keys do not match managed inputs"];
  }
  const errors = [];
  for (const relative of expected) {
    const chunks = manifest.files[relative];
    const recorded =
      Array.isArray(chunks) &&
      chunks.length === 4 &&
      chunks.every((chunk) => /^[a-f0-9]{16}$/u.test(chunk))
        ? chunks.join("")
        : null;
    const actual = createHash("sha256").update(fs.readFileSync(path.join(resolvedRoot, relative))).digest("hex");
    if (recorded !== actual) {
      errors.push(`nginx release manifest hash drift: ${relative}`);
    }
  }
  return errors;
}

function main() {
  const errors = [
    ...verifyNginxConfiguration(loadRepositoryConfiguration()),
    ...verifyNginxReleaseManifest(),
  ];
  if (errors.length) {
    for (const error of errors) console.error(`nginx abuse-control check: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("nginx abuse-control check: OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
