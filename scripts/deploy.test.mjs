import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploySource = fs.readFileSync(path.join(root, "scripts/deploy.mjs"), "utf8");

const reloadIndex = deploySource.indexOf('step("9/11 إعادة تحميل خادم الويب"');
const smokeIndex = deploySource.indexOf("verify-nginx-storefront-readiness.mjs");
assert.ok(reloadIndex >= 0, "deployment must reload the web process");
assert.ok(smokeIndex > reloadIndex, "external storefront smoke must run after the web reload");
assert.ok(
  deploySource.indexOf('step("11/11 تفعيل إصدار الجسر والتحقق والحفظ الذري"') > smokeIndex,
  "external storefront smoke must finish before the deployment is committed",
);
assert.match(deploySource, /verify-nginx-abuse-controls\.mjs/, "deployment must run the static nginx contract before mutable steps");

const selftest = spawnSync(process.execPath, ["scripts/verify-nginx-storefront-readiness.mjs", "--selftest"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(selftest.status, 0, `${selftest.stdout}\n${selftest.stderr}`);

console.log("deployment storefront-readiness contract test: OK");
