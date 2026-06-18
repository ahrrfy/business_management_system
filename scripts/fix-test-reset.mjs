import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "server", "services", "__tests__");

const IMPORT_LINE = 'import { truncateTables } from "./__testUtils__";';

// Regex: matches the 3-line FK_CHECKS + TRUNCATE pattern using pool `d`
// Captures the table source variable (TABLES or tables)
// Uses [\r\n]+ to handle both Unix (\n) and Windows (\r\n) line endings
const PATTERN = /  await d\.execute\(sql`SET FOREIGN_KEY_CHECKS = 0`\);[\r\n]+  for \(const t of (TABLES|tables)\) await d\.execute\(sql\.raw\(`TRUNCATE TABLE \\\`\${t}\\\``\)\);[\r\n]+  await d\.execute\(sql`SET FOREIGN_KEY_CHECKS = 1`\);/g;

// Orphaned `const d = db();` — remove when d is no longer used after substitution
// Strategy: after replacing, if `const d = db();` appears and `d.` doesn't appear anywhere else in the file, remove it
const D_DECL = /^  const d = db\(\);\n/m;

let changed = 0;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts") && f !== "__testUtils__.ts");

for (const filename of files) {
  const file = path.join(dir, filename);
  let content = fs.readFileSync(file, "utf8");
  const original = content;

  // Replace the 3-line pattern
  content = content.replace(PATTERN, (_match, tableVar) => `  await truncateTables(${tableVar});`);

  if (content === original) continue; // pattern not found in this file

  // Remove `const d = db();` if `d` is no longer referenced (heuristic: no `d.` left)
  if (D_DECL.test(content) && !content.match(/\bd\.\w/)) {
    content = content.replace(D_DECL, "");
  }

  // Add import if not already present
  if (!content.includes("__testUtils__")) {
    // Insert after the last `import` statement
    const lastImport = content.lastIndexOf("\nimport ");
    if (lastImport !== -1) {
      const lineEnd = content.indexOf("\n", lastImport + 1);
      content = content.slice(0, lineEnd + 1) + IMPORT_LINE + "\n" + content.slice(lineEnd + 1);
    }
  }

  fs.writeFileSync(file, content, "utf8");
  changed++;
  console.log("Updated:", filename);
}
console.log(`\nDone — ${changed} files updated.`);
