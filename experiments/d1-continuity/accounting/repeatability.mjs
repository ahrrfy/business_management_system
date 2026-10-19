import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const root = new URL("./results/", import.meta.url);
const baseline = JSON.parse(
  await readFile(new URL("baseline-mysql-oracle.json", root), "utf8"),
);
const current = JSON.parse(
  await readFile(new URL("mysql-oracle.json", root), "utf8"),
);
// Only clock scalars are normalized; IDs, money, source/hash/account references,
// payloads, status and the complete row graph remain under exact comparison.
function normalize(value) {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value)
  )
    return "<clock>";
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalize(v)]),
    );
  return value;
}
let commands = 0;
for (const scenario of baseline.scenarios) {
  const repeated = current.scenarios.find((s) => s.name === scenario.name);
  assert.ok(repeated, scenario.name);
  assert.deepEqual(
    normalize(repeated.commands),
    normalize(scenario.commands),
    scenario.name,
  );
  commands += scenario.commands.length;
}
assert.deepEqual(current.sourceHashes, baseline.sourceHashes);
const result = {
  scenarios: baseline.scenarios.length,
  commands,
  identicalExceptClockScalars: true,
};
await writeFile(
  new URL("repeatability.json", root),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
