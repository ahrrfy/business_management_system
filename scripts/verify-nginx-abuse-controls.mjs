import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const zones = read("deploy/nginx-ratelimit.conf");
const site = read("deploy/nginx-erp.conf");
const realIp = read("deploy/nginx-cloudflare-realip.conf");

const errors = [];
const requireMatch = (text, pattern, message) => {
  if (!pattern.test(text)) errors.push(message);
};

for (const zone of [
  "alroya_general",
  "alroya_api",
  "alroya_auth",
  "alroya_password_recovery",
  "alroya_restore",
  "alroya_webhooks",
]) {
  requireMatch(
    zones,
    new RegExp(`limit_req_zone\\s+\\$binary_remote_addr\\s+zone=${zone}:`),
    `missing IP-keyed shared zone: ${zone}`,
  );
}

requireMatch(site, /include\s+snippets\/alroya-cloudflare-realip\.conf;/, "missing Cloudflare real-IP include");
requireMatch(site, /set\s+\$alroya_proxy_secret\s+"[^"]+";/, "missing internal proxy hop secret");
requireMatch(site, /chmod\s+600\s+\/etc\/nginx\/sites-available\/alroya-erp/, "nginx install notes must protect the hop secret file");
requireMatch(realIp, /real_ip_header\s+CF-Connecting-IP;/, "real-IP must come from Cloudflare's canonical header");
requireMatch(realIp, /set_real_ip_from\s+173\.245\.48\.0\/20;/, "missing trusted Cloudflare source ranges");
requireMatch(site, /location\s+~\s+"\^\/api\/trpc\/.*auth\\\.login.*auth\\\.twoFactorVerify.*platformAdmin\\\.login/, "missing shared auth route limiter");
requireMatch(site, /limit_req\s+zone=alroya_auth\s+burst=30\s+nodelay;/, "auth limiter must use alroya_auth");
requireMatch(site, /auth\\\.resetPasswordWithToken/, "missing exact password-recovery route limiter");
requireMatch(site, /limit_req\s+zone=alroya_password_recovery\s+burst=3\s+nodelay;/, "password recovery limiter must use its own zone");
requireMatch(site, /location\s+~\s+\^\/api\/backups\/restore-upload\/\?\$/, "restore location must include optional trailing slash");
requireMatch(site, /limit_req\s+zone=alroya_restore\s+burst=2\s+nodelay;/, "restore limiter must use alroya_restore");
requireMatch(site, /location\s+~\s+"\^\/api\/webhooks/, "missing webhook route location");
requireMatch(site, /limit_req\s+zone=alroya_webhooks\s+burst=60\s+nodelay;/, "webhooks must use shared zone");

const authLocation = /^\/api\/trpc\/(?:[^/?]+,)*(?:auth\.login|auth\.twoFactorVerify|platformAdmin\.login)(?:,|$)/;
const passwordRecoveryLocation = /^\/api\/trpc\/(?:[^/?]+,)*auth\.resetPasswordWithToken(?:,|$)/;
for (const uri of ["/API/TRPC/auth.login", "/Api/Trpc/auth.resetPasswordWithToken", "/API/BACKUPS/RESTORE-UPLOAD"]) {
  if (authLocation.test(uri) || passwordRecoveryLocation.test(uri)) {
    errors.push(`sensitive nginx matcher unexpectedly accepts mixed-case ${uri}`);
  }
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

// Do not append an untrusted incoming XFF chain. nginx realip first converts the trusted
// Cloudflare header to $remote_addr; Node receives exactly that one canonical address.
if (/proxy_add_x_forwarded_for/.test(site)) {
  errors.push("proxy_add_x_forwarded_for reintroduces an attacker-controlled XFF prefix");
}
const forwarded = site.match(/proxy_set_header\s+X-Forwarded-For\s+([^;]+);/g) ?? [];
if (forwarded.length === 0 || forwarded.some((line) => !/\$remote_addr;/.test(line))) {
  errors.push("every proxied application location must canonicalize X-Forwarded-For to $remote_addr");
}
const proxied = site.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/g) ?? [];
const hopProof = site.match(/proxy_set_header\s+X-Internal-Proxy-Secret\s+\$alroya_proxy_secret;/g) ?? [];
if (proxied.length === 0 || hopProof.length !== proxied.length) {
  errors.push("every proxied application location must attach the internal hop secret");
}

if (errors.length) {
  for (const error of errors) console.error(`nginx abuse-control check: ${error}`);
  process.exit(1);
}

console.log("nginx abuse-control check: OK");
