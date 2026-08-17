import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyNginxConfiguration } from "./verify-nginx-abuse-controls.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

for (const relative of [
  "deploy/nginx-public.conf",
  "deploy/nginx-proxy-secret.conf.example",
  "deploy/nginx-proxy-common.conf",
  "deploy/nginx-app-locations.conf",
]) {
  assert.equal(fs.existsSync(path.join(root, relative)), true, `missing ${relative}`);
}

const internal = read("deploy/nginx-erp.conf");
const publicSite = read("deploy/nginx-public.conf");
const appLocations = read("deploy/nginx-app-locations.conf");
const baseInput = {
  zones: read("deploy/nginx-ratelimit.conf"),
  internalSite: internal,
  publicSite,
  realIp: read("deploy/nginx-cloudflare-realip.conf"),
  proxyCommon: read("deploy/nginx-proxy-common.conf"),
  proxySecretExample: read("deploy/nginx-proxy-secret.conf.example"),
  appLocations,
  configFiles: { "nginx-app-locations.conf": appLocations },
};

for (const [name, site] of [["internal", internal], ["public", publicSite]]) {
  assert.match(site, /include\s+snippets\/alroya-proxy-secret\.conf;/, `${name} vhost must use the shared live secret`);
}
assert.match(internal, /include\s+snippets\/alroya-app-locations\.conf;/, "internal vhost must use the full application locations");
assert.match(appLocations, /include\s+snippets\/alroya-spa-location\.conf;/, "full application locations must include the shared SPA location");
assert.match(publicSite, /include\s+snippets\/alroya-spa-location\.conf;/, "public vhost must include only the shared SPA location after its API allowlist");
assert.doesNotMatch(publicSite, /include\s+snippets\/alroya-app-locations\.conf;/, "public vhost must not re-import the generic /api/ location");

const proxyPasses = appLocations.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/g) ?? [];
const protectedLocations = appLocations.match(/include\s+snippets\/alroya-proxy-common\.conf;/g) ?? [];
assert.ok(proxyPasses.length > 0, "shared application locations must proxy to Node");
assert.equal(protectedLocations.length, proxyPasses.length, "every proxy_pass must include the shared proxy contract");

const unprotectedLocations = appLocations.replace(/\s*include\s+snippets\/alroya-proxy-common\.conf;/, "");
const unprotectedErrors = verifyNginxConfiguration({
  ...baseInput,
  appLocations: unprotectedLocations,
  configFiles: { "nginx-app-locations.conf": unprotectedLocations },
});
assert.ok(
  unprotectedErrors.some((error) => error.includes("every proxy_pass block must locally include")),
  "verifier must fail when a future proxy location omits the hop-secret contract",
);

const missingPublicSecretErrors = verifyNginxConfiguration({
  ...baseInput,
  publicSite: publicSite.replace(/\s*include\s+snippets\/alroya-proxy-secret\.conf;/, ""),
});
assert.ok(
  missingPublicSecretErrors.some((error) => error.includes("public vhost is missing the shared live secret")),
  "verifier must fail when the public vhost loses the shared secret",
);

const duplicatePublicApiErrors = verifyNginxConfiguration({
  ...baseInput,
  publicSite: `${publicSite}\ninclude snippets/alroya-app-locations.conf;`,
});
assert.ok(
  duplicatePublicApiErrors.some((error) => error.includes("must not include full application locations")),
  "verifier must fail before nginx -t when the public vhost re-imports generic /api/",
);

const duplicateTimeoutErrors = verifyNginxConfiguration({
  ...baseInput,
  proxyCommon: `${baseInput.proxyCommon}\nproxy_read_timeout 60s;`,
});
assert.ok(
  duplicateTimeoutErrors.some((error) => error.includes("must not duplicate per-location timeout directives")),
  "verifier must fail when a shared directive conflicts with a location override",
);

const result = spawnSync(process.execPath, ["scripts/verify-nginx-abuse-controls.mjs"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

console.log("nginx abuse-control contract test: OK");
