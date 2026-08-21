#!/usr/bin/env node
// ═══ حارس: اسم العمود في schema.ts ≠ اسم العمود الذي أنشأته الهجرة ═══
//
// **العطل الذي أوجده (٢١/٨/٢٦، بلاغ المالك «تعذّر إتمام مرتجع الشراء»):**
// `mysqlEnum` في drizzle أوّلُ معاملِه هو **اسم العمود في القاعدة**، لا اسم نوع الـenum
// (وهْمٌ مستورَد من Postgres). فمن كتب `settlement: mysqlEnum("purchaseReturnSettlement", …)`
// ظنّ أنّه يُسمّي النوع، بينما ألزم الـORM بكتابة عمودٍ اسمه `purchaseReturnSettlement`.
// وهجرة `0239` — المكتوبة يدوياً — أنشأت العمود باسمه الحقيقيّ `settlement`.
//
// **لماذا مرّ عبر CI أخضرَ بالكامل:** قاعدةُ الاختبار تُبنى بـ`db:push` **من schema.ts**
// (CLAUDE.md §٤-ج) ⇒ العمود يُخلَق هناك بالاسم الخاطئ نفسه فيتطابق الطرفان وتنجح كلّ
// الاختبارات. أمّا الإنتاج فيُبنى بملفّات SQL ⇒ `Unknown column 'purchaseReturnSettlement'`
// على **كل** مرتجع شراء. سبعةُ أعمدةٍ في أربعة جداول كانت مكسورةً هكذا حين كُتب هذا الحارس.
//
// **المطابقة ضيّقةٌ عمداً — لا إنذار كاذب:** لا يشتكي إلّا حين يجتمع الشرطان معاً على
// جدولٍ تُنشئه هجرةٌ فعلاً: (١) اسم العمود الذي يكتبه الـORM **غائبٌ** عن SQL الهجرات،
// و(٢) اسم **الخاصيّة** موجودٌ فيها. أي أنّ الطرفين يأتيان من التحليل نفسه، فتحليلٌ ناقص
// يُسكِت الحارس ولا يجعله يكذب. واختلافُ الاسمَين مشروعٌ ما دامت الهجرة توافقه
// (١١٣ عموداً كذلك في المستودع اليوم — كلّها تمرّ).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "drizzle/migrations";
const SCHEMA_FILE = "drizzle/schema.ts";

/** أعمدة schema.ts: [{ table, prop, dbCol }] — `prop: type("dbCol"` هو شكل كل عمود في drizzle. */
export function parseSchemaColumns(source) {
  const out = [];
  let table = null;
  let pendingTableConst = false;
  for (const line of source.split("\n")) {
    const inline = line.match(/^export const \w+ = mysqlTable\(\s*"([^"]+)"/);
    if (inline) { table = inline[1]; pendingTableConst = false; continue; }
    if (/^export const \w+ = mysqlTable\(\s*$/.test(line)) { pendingTableConst = true; continue; }
    if (pendingTableConst) {
      const named = line.match(/^\s*"([^"]+)",\s*$/);
      if (named) { table = named[1]; pendingTableConst = false; }
      continue;
    }
    if (!table) continue;
    const col = line.match(/^\s{4}(\w+):\s*(\w+)\(\s*"([^"]+)"/);
    if (col) out.push({ table, prop: col[1], dbCol: col[3] });
  }
  return out;
}

/** أسماء الأعمدة التي تذكرها ملفّات SQL لكلّ جدول (CREATE TABLE + ALTER … ADD COLUMN). */
export function parseMigrationColumns(sqlByFile) {
  const byTable = new Map();
  const add = (t, c) => {
    if (!byTable.has(t)) byTable.set(t, new Set());
    byTable.get(t).add(c);
  };
  for (const sql of sqlByFile) {
    const stripped = sql.replace(/^\s*--.*$/gm, "");
    for (const m of stripped.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`\s*\(([\s\S]*?)\n\s*\)\s*(?:ENGINE|;)/gi)) {
      const [, tableName, body] = m;
      for (const line of body.split("\n")) {
        const col = line.match(/^\s*`([^`]+)`\s+[A-Za-z]/);
        if (col) add(tableName, col[1]);
      }
    }
    for (const m of stripped.matchAll(/ALTER\s+TABLE\s+`([^`]+)`([\s\S]*?);/gi)) {
      const [, tableName, body] = m;
      for (const c of body.matchAll(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`\s+[A-Za-z]/gi)) {
        add(tableName, c[1]);
      }
    }
  }
  return byTable;
}

/** الانحراف: الـORM يكتب اسماً لا وجود له في SQL، بينما اسم الخاصيّة موجودٌ فيها. */
export function findDrift(schemaColumns, migrationColumns) {
  const drift = [];
  for (const c of schemaColumns) {
    if (c.dbCol === c.prop) continue;
    const cols = migrationColumns.get(c.table);
    if (!cols) continue;                       // جدولٌ لا تُنشئه هجرة ⇒ لا حكم
    if (cols.has(c.dbCol)) continue;           // الهجرة توافق الـORM ⇒ سليم
    if (cols.has(c.prop)) drift.push(c);
  }
  return drift;
}

function readMigrationSql() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sql")) files.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(MIGRATIONS_DIR);
  return files;
}

function selftest() {
  const schema = parseSchemaColumns([
    'export const widgets = mysqlTable(',
    '  "widgets",',
    '  {',
    '    id: bigint("id", { mode: "number" }).primaryKey(),',
    '    status: mysqlEnum("widgetStatus", ["A", "B"]).notNull(),',
    '    kind: mysqlEnum("widgetKind", ["X"]).notNull(),',
    '  },',
    ');',
  ].join("\n"));
  const sql = parseMigrationColumns([
    "CREATE TABLE `widgets` (\n  `id` bigint NOT NULL,\n  `status` enum('A','B') NOT NULL,\n  `widgetKind` enum('X') NOT NULL\n);",
  ]);
  const drift = findDrift(schema, sql);
  const ok = drift.length === 1 && drift[0].prop === "status" && drift[0].dbCol === "widgetStatus";
  if (!ok) {
    console.error("⛔ فشل الاختبار الذاتي للحارس:", JSON.stringify(drift));
    process.exit(1);
  }
  console.log("✓ الاختبار الذاتي: يُمسك اسم العمود المنحرف ويتجاهل الموافق.");
}

function main() {
  if (process.argv.includes("--selftest")) { selftest(); return; }
  const schemaColumns = parseSchemaColumns(fs.readFileSync(SCHEMA_FILE, "utf8"));
  const migrationColumns = parseMigrationColumns(readMigrationSql());
  const drift = findDrift(schemaColumns, migrationColumns);
  if (drift.length) {
    console.error("⛔ انحراف اسم العمود بين schema.ts وملفّات الهجرة (يسقط على الإنتاج وحده):\n");
    for (const d of drift) {
      console.error(
        `  ${d.table}.${d.prop}: الـORM يكتب \`${d.dbCol}\` بينما الهجرة أنشأت \`${d.prop}\``,
      );
    }
    console.error(
      "\nأوّل معامل لـ`mysqlEnum` هو **اسم العمود** لا اسم النوع. صحّح schema.ts ليطابق SQL الهجرة" +
      "\n(لا العكس: عمود الإنتاج قائمٌ بالفعل بالاسم الذي أنشأته الهجرة)، ثم أعد `pnpm test:db:init`.",
    );
    process.exit(1);
  }
  console.log(`✓ لا انحراف في أسماء الأعمدة (${schemaColumns.length} عموداً مفحوصاً).`);
}

// لا يُشغَّل عند الاستيراد (اختبارٌ يستورد الدوالّ الثلاث أعلاه).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
