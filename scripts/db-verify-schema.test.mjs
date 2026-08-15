// اختبار عقد بوابة المخطط بلا قاعدة: node scripts/db-verify-schema.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  ["scripts/db-verify-schema.mjs", "--selftest"],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  },
);

assert.equal(
  result.status,
  0,
  `يجب أن يعمل selftest مستقلاً عن DATABASE_URL وsnapshot:\n${result.stdout}\n${result.stderr}`,
);
assert.match(result.stdout, /db schema operational contracts selftest: OK/);

console.log("db schema verifier contract test: OK");
