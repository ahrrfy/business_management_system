import { readFileSync, readdirSync } from "node:fs";

const migrationsDir = "drizzle/migrations";
const journalPath = `${migrationsDir}/meta/_journal.json`;
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries ?? [];

function fail(message) {
  console.error(`Migration journal check failed: ${message}`);
  process.exit(1);
}

if (!entries.length) fail("the journal has no entries");

const tags = entries.map((entry) => String(entry.tag));
const indexes = entries.map((entry) => Number(entry.idx));
if (new Set(tags).size !== tags.length) fail("duplicate journal tag");
if (new Set(indexes).size !== indexes.length) fail("duplicate journal idx");

const fileTags = new Set(migrationFiles.map((name) => name.replace(/\.sql$/, "")));
// Historical migrations include a small number of deliberately retained legacy
// journal entries/files that predate this guard. Enforce complete registration
// for the latest migration number and everything added after it, which catches
// the concurrent-branch collision that previously left 0122_document_* unapplied.
const latestPrefix = Math.max(...tags.map((tag) => Number(tag.slice(0, 4))));
for (const tag of tags.filter((tag) => Number(tag.slice(0, 4)) >= latestPrefix)) {
  if (!fileTags.has(tag)) fail(`journal entry ${tag} has no SQL file`);
}
const unregisteredCurrent = migrationFiles
  .map((name) => name.replace(/\.sql$/, ""))
  .filter((tag) => Number(tag.slice(0, 4)) >= latestPrefix && !tags.includes(tag));
if (unregisteredCurrent.length) {
  fail(`SQL file is not registered in _journal.json: ${unregisteredCurrent.join(", ")}`);
}

const latestFiles = migrationFiles.filter((name) => Number(name.slice(0, 4)) === latestPrefix);
if (latestFiles.length !== 1) {
  fail(`migration number ${String(latestPrefix).padStart(4, "0")} is used by ${latestFiles.length} files`);
}

console.log(`Migration journal check passed through ${tags.at(-1)}.`);
